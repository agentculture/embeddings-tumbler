"""Tests for the ``viewer serve --embed`` search route (``embeddings_tumbler._embed_route``).

Every test talks to a fake gateway on a loopback port; nothing leaves the machine. Each
refusal in the interface's table has its own test, and the "nothing leaks" claims are
shown by planting sentinel values for the key, the gateway address, the gateway's own
error text and the query text, then scanning every status line, header, body and log line.
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from embeddings_tumbler import _embed_route, _static_server
from embeddings_tumbler._embed_route import (
    ConfigError,
    EmbedRoute,
    RateWindow,
    Refusal,
    RouteConfig,
    load_config,
    parse_embedding,
    parse_rerank,
)

KEY = "SENTINEL-KEY-7f3a9c"
ADDRESS_PART = "SENTINEL-ADDRESS-d41e"
GATEWAY_TEXT = "SENTINEL-GATEWAY-TEXT-88b2"
QUERY = "SENTINEL-QUERY-TEXT-a1c5"
JSON = "application/json"


# --- the fake gateway ---------------------------------------------------------------


class _Gateway:
    """A loopback stand-in for the OpenAI-compatible gateway; behaviour set per test."""

    def __init__(self) -> None:
        self.mode = "ok"
        self.seen: list[dict] = []
        self.model_in_answer: str | None = "served-model"
        self.dimension = 4
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                gateway.seen.append(
                    {"path": self.path, "auth": self.headers.get("Authorization"), "body": body}
                )
                gateway.answer(self, body)

            def log_message(self, format, *args) -> None:  # noqa: A002
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True)
        self.thread.start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}/{ADDRESS_PART}/v1"

    def _write(self, handler, status: int, data: bytes, headers=()) -> None:
        handler.send_response(status, GATEWAY_TEXT if status != 200 else None)
        handler.send_header("Content-Type", JSON)
        handler.send_header("Content-Length", str(len(data)))
        for name, value in headers:
            handler.send_header(name, value)
        handler.end_headers()
        handler.wfile.write(data)

    def _ok(self, path: str, body: dict) -> dict:
        answer: dict = {}
        if path.endswith("/embeddings"):
            answer["data"] = [{"embedding": [0.5] * self.dimension, "index": 0}]
        else:
            count = len(body["documents"])
            answer["results"] = [
                {"index": i, "relevance_score": float(count - i)} for i in reversed(range(count))
            ]
        if self.model_in_answer:
            answer["model"] = self.model_in_answer
        return answer

    def answer(self, handler, body: dict) -> None:
        mode = self.mode
        if mode == "slow":
            time.sleep(1.5)
        if mode in ("ok", "slow"):
            self._write(handler, 200, json.dumps(self._ok(handler.path, body)).encode())
        elif mode == "error":
            text = json.dumps({"error": f"{GATEWAY_TEXT} at {self.base} key {KEY}"})
            self._write(handler, 500, text.encode())
        elif mode == "redirect":
            self._write(handler, 302, b"", [("Location", f"{self.base}/elsewhere")])
        elif mode == "bad-shape":
            self._write(handler, 200, json.dumps({"data": [], "note": GATEWAY_TEXT}).encode())
        else:  # "not-json"
            self._write(handler, 200, f"<html>{GATEWAY_TEXT}</html>".encode())

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


@pytest.fixture
def gateway():
    g = _Gateway()
    yield g
    g.close()


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _config(base: str, **kw) -> RouteConfig:
    values = {
        "base_url": base,
        "key": KEY,
        "embed_model": "embed-model",
        "rerank_model": "rerank-model",
        "query_prefix": None,
    }
    values.update(kw)
    return RouteConfig(**values)


class _Served:
    def __init__(self, server, route: EmbedRoute) -> None:
        self.server = server
        self.route = route
        self.port = server.server_address[1]
        self.host = f"127.0.0.1:{self.port}"
        self.origin = f"http://{self.host}"


def _start(tmp_path, route: EmbedRoute):
    root = tmp_path / "site"
    root.mkdir(exist_ok=True)
    (root / "index.html").write_text("<h1>page</h1>")
    server = _static_server.make_server(root, port=0, quiet=False, embed=route)
    thread = threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    return server, thread


@pytest.fixture
def served(tmp_path, gateway):
    clock = _Clock()
    route = EmbedRoute(
        _config(gateway.base),
        rate=RateWindow(limit=5, clock=clock),
        gateway_timeout=0.5,
        body_timeout=0.3,
    )
    route.clock = clock  # type: ignore[attr-defined]
    server, thread = _start(tmp_path, route)
    yield _Served(server, route)
    server.shutdown()
    server.server_close()
    thread.join(5)


def _request(served, method="POST", body=None, headers=None, path=_embed_route.ROUTE):
    """Send one request with exactly the headers given (Host included)."""
    connection = http.client.HTTPConnection("127.0.0.1", served.port, timeout=5)
    connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
    sent = {"Host": served.host, "Origin": served.origin, "Content-Type": JSON}
    data = b""
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        sent["Content-Length"] = str(len(data))
    sent.update(headers or {})
    for name, value in sent.items():
        if value is not None:
            connection.putheader(name, value)
    connection.endheaders(data or None)
    response = connection.getresponse()
    raw = response.read()
    status_line = f"{response.status} {response.reason}"
    result = (response.status, response.getheaders(), raw, status_line)
    connection.close()
    return result


def _post(served, body, **headers):
    status, hdrs, raw, _ = _request(served, body=body, headers=headers)
    return status, dict(hdrs), (json.loads(raw) if raw else None)


def _assert_refused(status, headers, payload, code, http_status):
    assert status == http_status
    assert payload["ok"] is False
    assert payload["code"] == code
    assert payload["message"] == _embed_route.Refusal(code).message or code == "gateway-failed"
    _assert_no_cors(headers)


def _assert_no_cors(headers):
    names = [n.lower() for n in (headers if isinstance(headers, dict) else dict(headers))]
    assert not [n for n in names if n.startswith("access-control")]


# --- operations ---------------------------------------------------------------------


def test_describe_names_models_query_form_and_limits(served):
    status, headers, payload = _post(served, {"op": "describe"})
    assert status == 200
    assert payload == {
        "ok": True,
        "embed": {"model": "embed-model", "query_form": "plain"},
        "rerank": {"model": "rerank-model"},
        "limits": {
            "maxTextChars": 8000,
            "maxCandidates": 100,
            "maxCandidateChars": 2000,
            "requestsPerMinute": 120,
        },
    }
    assert headers["Content-Type"] == JSON
    assert headers["Cache-Control"] == "no-store"
    _assert_no_cors(headers)


def test_embed_answers_vector_model_and_query_form(served, gateway):
    status, _, payload = _post(served, {"op": "embed", "text": "a cat"})
    assert status == 200
    assert payload == {
        "ok": True,
        "vector": [0.5, 0.5, 0.5, 0.5],
        "model": "served-model",
        "query_form": "plain",
    }
    sent = gateway.seen[-1]
    assert sent["path"] == f"/{ADDRESS_PART}/v1/embeddings"
    assert sent["auth"] == f"Bearer {KEY}"
    assert sent["body"] == {"model": "embed-model", "input": ["a cat"]}


def test_embed_reports_the_asked_model_when_the_gateway_names_none(served, gateway):
    gateway.model_in_answer = None
    assert _post(served, {"op": "embed", "text": "x"})[2]["model"] == "embed-model"


def test_query_prefix_is_put_before_the_text_and_named_prefixed(tmp_path, gateway):
    route = EmbedRoute(_config(gateway.base, query_prefix="query: "))
    server, thread = _start(tmp_path, route)
    try:
        served = _Served(server, route)
        payload = _post(served, {"op": "embed", "text": "dogs"})[2]
        assert payload["query_form"] == "prefixed"
        assert gateway.seen[-1]["body"]["input"] == ["query: dogs"]
        assert _post(served, {"op": "describe"})[2]["embed"]["query_form"] == "prefixed"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def test_rerank_answers_one_score_per_candidate_in_order(served, gateway):
    body = {"op": "rerank", "query": "q", "candidates": ["a", "b", "c"]}
    status, _, payload = _post(served, body)
    assert status == 200
    assert payload == {"ok": True, "scores": [3.0, 2.0, 1.0], "model": "served-model"}
    sent = gateway.seen[-1]
    assert sent["path"] == f"/{ADDRESS_PART}/v1/rerank"
    assert sent["body"] == {"model": "rerank-model", "query": "q", "documents": ["a", "b", "c"]}


def test_rerank_of_no_candidates_does_not_call_the_gateway(served, gateway):
    payload = _post(served, {"op": "rerank", "query": "q", "candidates": []})[2]
    assert payload == {"ok": True, "scores": [], "model": "rerank-model"}
    assert gateway.seen == []


def test_route_with_a_query_string_is_still_the_route(served):
    status, _, raw, _ = _request(served, body={"op": "describe"}, path=_embed_route.ROUTE + "?x=1")
    assert status == 200
    assert json.loads(raw)["ok"] is True


def test_static_files_are_served_as_without_the_route(served):
    status, _, raw, _ = _request(served, method="GET", path="/index.html")
    assert status == 200
    assert raw == b"<h1>page</h1>"
    status, headers, _, _ = _request(served, method="POST", path="/index.html", body={})
    assert status == 405
    assert dict(headers)["Allow"] == "GET, HEAD"


# --- each refusal -------------------------------------------------------------------


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"])
def test_wrong_method(served, method):
    status, headers, raw, _ = _request(served, method=method)
    headers = dict(headers)
    assert status == 405
    assert headers["Allow"] == "POST"
    _assert_no_cors(headers)
    if method == "HEAD":
        assert raw == b""
    else:
        assert json.loads(raw)["code"] == "wrong-method"


@pytest.mark.parametrize(
    "host",
    [
        "evil.example",  # DNS rebinding: the attacker's name resolves to 127.0.0.1
        "evil.example:{port}",
        "127.0.0.1:1",  # another port
        "127.0.0.1",  # no port on a non-80 server
        None,  # missing
    ],
)
def test_wrong_host(served, host):
    value = host.format(port=served.port) if host else None
    origin = f"http://{value}" if value else served.origin
    status, headers, payload = _post(served, {"op": "describe"}, Host=value, Origin=origin)
    _assert_refused(status, headers, payload, "wrong-host", 403)


@pytest.mark.parametrize("form", ["127.0.0.1:{port}", "localhost:{port}", "[::1]:{port}"])
def test_loopback_host_forms_are_accepted(served, form):
    host = form.format(port=served.port)
    status, _, payload = _post(served, {"op": "describe"}, Host=host, Origin=f"http://{host}")
    assert status == 200
    assert payload["ok"] is True


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",  # a page on another site
        None,  # missing
        "null",  # a sandboxed or file page
        "https://127.0.0.1:{port}",  # wrong scheme
        "http://localhost:{port}",  # same server, different Host spelling
        "http://127.0.0.1:{port}/path",
    ],
)
def test_wrong_origin(served, origin):
    value = origin.format(port=served.port) if origin else None
    status, headers, payload = _post(served, {"op": "describe"}, Origin=value)
    _assert_refused(status, headers, payload, "wrong-origin", 403)


@pytest.mark.parametrize(
    "ctype",
    [
        "text/plain",  # what a no-preflight fetch can send
        "application/x-www-form-urlencoded",  # what a form can send
        "multipart/form-data; boundary=x",
        None,
    ],
)
def test_wrong_content_type(served, ctype):
    status, headers, payload = _post(served, {"op": "describe"}, **{"Content-Type": ctype})
    _assert_refused(status, headers, payload, "wrong-content-type", 415)


def test_json_content_type_parameters_are_allowed(served):
    status, _, _ = _post(served, {"op": "describe"}, **{"Content-Type": "Application/JSON; utf-8"})
    assert status == 200


def test_too_large_body_is_refused_before_it_is_read(served):
    status, headers, raw, _ = _request(
        served, headers={"Content-Length": str(_embed_route.MAX_BODY_BYTES + 1)}
    )
    _assert_refused(status, dict(headers), json.loads(raw), "too-large", 413)


@pytest.mark.parametrize("length", [None, "-1", "abc", ""])
def test_missing_or_bad_length_is_too_large(served, length):
    status, headers, raw, _ = _request(served, headers={"Content-Length": length})
    _assert_refused(status, dict(headers), json.loads(raw), "too-large", 413)


@pytest.mark.parametrize("raw", [b"{not json", b"[1, 2]", b'"text"', b"\xff\xfe", b""])
def test_bad_json(served, raw):
    status, headers, payload = _post(served, raw)
    _assert_refused(status, headers, payload, "bad-json", 400)


@pytest.mark.parametrize(
    "body",
    [
        {"op": "search"},
        {},
        {"op": "embed"},
        {"op": "embed", "text": 5},
        {"op": "rerank", "query": "q"},
        {"op": "rerank", "query": "q", "candidates": "a"},
        {"op": "rerank", "query": "q", "candidates": ["a", 1]},
        {"op": "rerank", "candidates": ["a"]},
    ],
)
def test_bad_request(served, body):
    status, headers, payload = _post(served, body)
    _assert_refused(status, headers, payload, "bad-request", 400)


@pytest.mark.parametrize(
    "body",
    [
        {"op": "embed", "text": "x" * 8001},
        {"op": "rerank", "query": "x" * 8001, "candidates": ["a"]},
        {"op": "rerank", "query": "q", "candidates": ["a", "x" * 2001]},
    ],
)
def test_text_too_long(served, body):
    status, headers, payload = _post(served, body)
    _assert_refused(status, headers, payload, "text-too-long", 413)


def test_texts_at_the_limits_are_accepted(served):
    assert _post(served, {"op": "embed", "text": "x" * 8000})[0] == 200
    body = {"op": "rerank", "query": "x" * 8000, "candidates": ["y" * 2000] * 100}
    assert _post(served, body)[0] == 200


def test_hundred_candidates_of_four_byte_text_fit_the_body_limit(served):
    # The worst case a browser sends: every character 4 bytes in UTF-8 (JSON.stringify does not
    # escape non-ASCII), 100 candidates at the per-candidate limit and the longest query.
    body = {"op": "rerank", "query": "\U0001f30a" * 8000, "candidates": ["\U0001f41a" * 2000] * 100}
    raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
    assert len(raw) < 1_048_576
    assert _request(served, body=raw)[0] == 200


def test_too_many_candidates(served):
    body = {"op": "rerank", "query": "q", "candidates": ["a"] * 101}
    status, headers, payload = _post(served, body)
    _assert_refused(status, headers, payload, "too-many-candidates", 413)


def test_rate_limited(served):
    for _ in range(5):
        assert _post(served, {"op": "describe"})[0] == 200
    status, headers, payload = _post(served, {"op": "describe"})
    _assert_refused(status, headers, payload, "rate-limited", 429)
    served.route.clock.now += 60
    assert _post(served, {"op": "describe"})[0] == 200


def test_requests_refused_before_the_rate_check_do_not_use_up_the_window(served):
    for _ in range(10):
        assert _post(served, {"op": "describe"}, Origin="https://evil.example")[0] == 403
    assert _post(served, {"op": "describe"})[0] == 200


def test_the_default_window_is_120_a_minute():
    clock = _Clock()
    window = RateWindow(clock=clock)
    assert all(window.admit() for _ in range(120))
    assert not window.admit()
    clock.now += 59.9
    assert not window.admit()
    clock.now += 0.1
    assert window.admit()


def test_rerank_unavailable(tmp_path, gateway):
    route = EmbedRoute(_config(gateway.base, rerank_model=None))
    server, thread = _start(tmp_path, route)
    try:
        served = _Served(server, route)
        body = {"op": "rerank", "query": "q", "candidates": ["a"]}
        status, headers, payload = _post(served, body)
        _assert_refused(status, headers, payload, "rerank-unavailable", 404)
        assert _post(served, {"op": "describe"})[2]["rerank"] is None
        assert gateway.seen == []
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


@pytest.mark.parametrize("mode", ["error", "redirect", "bad-shape", "not-json"])
def test_gateway_failed_embed(served, gateway, mode):
    gateway.mode = mode
    status, headers, payload = _post(served, {"op": "embed", "text": QUERY})
    _assert_refused(status, headers, payload, "gateway-failed", 502)
    assert payload["message"] == "The embedding service did not answer."
    assert len([s for s in gateway.seen if s["path"].endswith("/embeddings")]) == 1  # no follow


@pytest.mark.parametrize("mode", ["error", "redirect", "bad-shape", "not-json"])
def test_gateway_failed_rerank(served, gateway, mode):
    gateway.mode = mode
    body = {"op": "rerank", "query": QUERY, "candidates": ["a", "b"]}
    status, headers, payload = _post(served, body)
    _assert_refused(status, headers, payload, "gateway-failed", 502)
    assert payload["message"] == "The reranking service did not answer."


def test_gateway_failed_when_nothing_listens(tmp_path):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    for scheme in ("http", "https"):
        route = EmbedRoute(_config(f"{scheme}://127.0.0.1:{closed_port}/v1"))
        server, thread = _start(tmp_path, route)
        try:
            status, headers, payload = _post(_Served(server, route), {"op": "embed", "text": "x"})
            _assert_refused(status, headers, payload, "gateway-failed", 502)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)


def test_gateway_failed_when_the_answer_is_too_big(served, gateway, monkeypatch):
    monkeypatch.setattr(_embed_route, "MAX_GATEWAY_BYTES", 10)
    status, headers, payload = _post(served, {"op": "embed", "text": "x"})
    _assert_refused(status, headers, payload, "gateway-failed", 502)


def test_gateway_timeout(served, gateway):
    gateway.mode = "slow"
    status, headers, payload = _post(served, {"op": "embed", "text": QUERY})
    _assert_refused(status, headers, payload, "gateway-timeout", 504)


def test_a_slow_body_is_dropped_without_an_answer(served, capsys):
    with socket.create_connection(("127.0.0.1", served.port), timeout=5) as sock:
        head = (
            f"POST {_embed_route.ROUTE} HTTP/1.1\r\nHost: {served.host}\r\n"
            f"Origin: {served.origin}\r\nContent-Type: {JSON}\r\nContent-Length: 100\r\n\r\n"
        )
        sock.sendall(head.encode() + b'{"op": "em')
        assert sock.recv(1024) == b""  # the server gave up and closed, answering nothing
    time.sleep(0.05)
    assert "dropped" in capsys.readouterr().err


def test_a_body_cut_short_is_dropped_without_an_answer(served):
    with socket.create_connection(("127.0.0.1", served.port), timeout=5) as sock:
        head = (
            f"POST {_embed_route.ROUTE} HTTP/1.1\r\nHost: {served.host}\r\n"
            f"Origin: {served.origin}\r\nContent-Type: {JSON}\r\nContent-Length: 100\r\n\r\n"
        )
        sock.sendall(head.encode() + b"{}")
        sock.shutdown(socket.SHUT_WR)
        assert sock.recv(1024) == b""


def test_every_refusal_has_a_fixed_message_and_status():
    assert len(_embed_route._REFUSALS) == 13
    for code, (status, message) in _embed_route._REFUSALS.items():
        refusal = Refusal(code)
        assert refusal.status == status
        assert refusal.message == message
        assert 400 <= int(status) < 600


# --- nothing leaks ------------------------------------------------------------------


def _sentinels(gateway) -> list[str]:
    return [KEY, ADDRESS_PART, GATEWAY_TEXT, QUERY, f"127.0.0.1:{gateway.port}"]


def _scan(texts, gateway):
    joined = "\n".join(texts)
    for sentinel in _sentinels(gateway):
        assert sentinel not in joined, sentinel


def test_nothing_leaks_in_any_answer_header_or_log_line(served, gateway, capsys):
    long_query = QUERY + "x" * 8000
    cases = [
        ("ok", {"op": "embed", "text": QUERY}),
        ("ok", {"op": "rerank", "query": QUERY, "candidates": [QUERY, "b"]}),
        ("error", {"op": "embed", "text": QUERY}),
        ("error", {"op": "rerank", "query": QUERY, "candidates": [QUERY]}),
        ("redirect", {"op": "embed", "text": QUERY}),
        ("bad-shape", {"op": "embed", "text": QUERY}),
        ("not-json", {"op": "rerank", "query": QUERY, "candidates": ["a"]}),
        ("slow", {"op": "embed", "text": QUERY}),
        ("ok", {"op": "embed", "text": long_query}),
        ("ok", {"op": QUERY, "text": QUERY}),
    ]
    texts = []
    for mode, body in cases:
        gateway.mode = mode
        served.route.clock.now += 60
        _, headers, raw, status_line = _request(served, body=body)
        texts += [status_line, json.dumps(headers), raw.decode("utf-8")]
    # A query in the path or a header is not echoed either.
    _, headers, raw, status_line = _request(
        served, body={"op": "describe"}, path=f"{_embed_route.ROUTE}?q={QUERY}"
    )
    texts += [status_line, json.dumps(headers), raw.decode("utf-8")]
    time.sleep(0.05)
    log = capsys.readouterr().err
    texts.append(log)
    # Positive control: the gateway did receive the key and the query, and the log ran.
    assert any(s["auth"] == f"Bearer {KEY}" for s in gateway.seen)
    assert any(QUERY in json.dumps(s["body"]) for s in gateway.seen)
    assert log.count(_embed_route.ROUTE) == len(cases) + 1
    _scan(texts, gateway)


def test_the_log_line_names_method_path_op_status_and_length(served, capsys):
    _post(served, {"op": "describe"})
    _request(served, method="GET")
    time.sleep(0.05)
    lines = [line for line in capsys.readouterr().err.splitlines() if line.strip()]
    assert lines[0].endswith(f"POST {_embed_route.ROUTE} op=describe 200 18")
    assert lines[1].endswith(f"GET {_embed_route.ROUTE} op=- 405 0")
    assert len(lines) == 2


def test_the_config_repr_hides_the_key_and_address():
    text = repr(_config("http://127.0.0.1:9/" + ADDRESS_PART))
    assert KEY not in text
    assert ADDRESS_PART not in text
    assert "embed-model" in text


def test_the_public_block_has_no_address_or_key():
    block = _config("http://127.0.0.1:9/" + ADDRESS_PART).public()
    assert block == {
        "enabled": True,
        "route": "/_tumbler/search",
        "model": "embed-model",
        "rerank_model": "rerank-model",
        "query_form": "plain",
    }


# --- configuration ------------------------------------------------------------------


def test_load_config_reads_key_url_and_model():
    env = {
        "EMBEDDINGS_API_KEY": KEY,
        "EMBEDDINGS_EMBED_URL": "https://gateway.invalid/v1/",
        "EMBEDDINGS_EMBED_MODEL": "env-model",
    }
    config = load_config(env)
    assert config.key == KEY
    assert config.base_url == "https://gateway.invalid/v1"
    assert config.embed_model == "env-model"
    assert config.rerank_model is None
    assert config.query_prefix is None
    flagged = load_config(env, embed_model="flag", rerank_model="rr", query_prefix="q: ")
    assert (flagged.embed_model, flagged.rerank_model, flagged.query_prefix) == (
        "flag",
        "rr",
        "q: ",
    )


def test_load_config_defaults_and_key_fallback():
    config = load_config({"COLLEAGUE_API_KEY": KEY})
    assert config.key == KEY
    assert config.base_url == _embed_route.DEFAULT_EMBED_URL
    assert config.embed_model == "google/embeddinggemma-2"
    preferred = load_config({"COLLEAGUE_API_KEY": "other", "EMBEDDINGS_API_KEY": KEY})
    assert preferred.key == KEY


def test_load_config_without_a_key_names_the_variables_only():
    with pytest.raises(ConfigError) as exc:
        load_config({"EMBEDDINGS_EMBED_URL": "http://127.0.0.1:9/" + ADDRESS_PART})
    assert "EMBEDDINGS_API_KEY" in exc.value.message
    assert "COLLEAGUE_API_KEY" in exc.value.message
    assert ADDRESS_PART not in exc.value.message + exc.value.remediation


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://localhost/v1",
        "http:///v1",
        f"http://user:{KEY}@localhost/v1",
        "http://localhost/v1?x=1",
        "http://localhost/v1#f",
        "http://localhost:0/v1",
        "http://localhost:notaport/v1",
        "http://[::1/v1",
    ],
)
def test_load_config_refuses_other_addresses_without_echoing_them(url):
    with pytest.raises(ConfigError) as exc:
        load_config({"EMBEDDINGS_API_KEY": KEY, "EMBEDDINGS_EMBED_URL": url})
    assert "EMBEDDINGS_EMBED_URL" in exc.value.message
    assert url not in exc.value.message
    assert KEY not in exc.value.message


# --- parsing and binding ------------------------------------------------------------


@pytest.mark.parametrize(
    "answer",
    [
        None,
        [],
        {},
        {"data": []},
        {"data": ["x"]},
        {"data": [{"embedding": []}]},
        {"data": [{"embedding": [1, "2"]}]},
        {"data": [{"embedding": [1, True]}]},
        {"data": [{"embedding": [1, float("nan")]}]},
        {"data": [{"embedding": [1, float("inf")]}]},
    ],
)
def test_parse_embedding_refuses_malformed(answer):
    assert parse_embedding(answer) is None


def test_parse_embedding_reads_the_first_vector():
    assert parse_embedding({"data": [{"embedding": [1, 2.5]}]}) == [1.0, 2.5]


@pytest.mark.parametrize(
    "answer",
    [
        None,
        {},
        {"results": "x"},
        {"results": [{"index": 0, "relevance_score": 1}]},  # too few
        {"results": [{"index": 0, "relevance_score": 1}, {"index": 0, "relevance_score": 2}]},
        {"results": [{"index": 0, "relevance_score": 1}, {"index": 2, "relevance_score": 2}]},
        {"results": [{"index": 0, "relevance_score": 1}, {"index": True, "relevance_score": 2}]},
        {"results": [{"index": 0, "relevance_score": 1}, {"index": 1, "relevance_score": "2"}]},
        {"results": [{"index": 0, "relevance_score": 1}, "row"]},
    ],
)
def test_parse_rerank_refuses_malformed(answer):
    assert parse_rerank(answer, 2) is None


def test_parse_rerank_puts_scores_back_in_candidate_order():
    answer = {"results": [{"index": 1, "relevance_score": 0.9}, {"index": 0, "relevance_score": 2}]}
    assert parse_rerank(answer, 2) == [2.0, 0.9]


def test_bind_accepts_only_the_bound_address_names():
    route = EmbedRoute(_config("http://127.0.0.1:9/v1"))
    route.bind("127.0.0.2", 80)
    for host in ("localhost", "127.0.0.2", "localhost:80", "[::1]:80", "[::1]"):
        route._check_caller(
            _message({"Host": host, "Origin": f"http://{host}", "Content-Type": JSON})
        )
    other_port = _message({"Host": "localhost:81", "Origin": "x", "Content-Type": JSON})
    with pytest.raises(Refusal):
        route._check_caller(other_port)
    remote = EmbedRoute(_config("http://127.0.0.1:9/v1"))
    remote.bind("192.0.2.7", 8000)
    bound = "192.0.2.7:8000"
    remote._check_caller(
        _message({"Host": bound, "Origin": f"http://{bound}", "Content-Type": JSON})
    )
    for host in ("localhost:8000", "127.0.0.1:8000"):
        loopback = _message({"Host": host, "Origin": f"http://{host}", "Content-Type": JSON})
        with pytest.raises(Refusal):
            remote._check_caller(loopback)


# --- review follow-ups: header-unsafe settings, unexpected errors, headers ----------

BAD_KEY = KEY + "\r\nX-Injected: " + KEY


def _all_output(capsys, texts):
    time.sleep(0.05)
    cap = capsys.readouterr()
    return [*texts, cap.out, cap.err]


@pytest.mark.parametrize("bad", [BAD_KEY, KEY + "\n", KEY + " tail", KEY + "\x00", KEY + "é", " "])
def test_load_config_refuses_a_key_a_header_cannot_carry(bad):
    with pytest.raises(ConfigError) as exc:
        load_config({"EMBEDDINGS_API_KEY": bad})
    text = exc.value.message + exc.value.remediation
    assert "EMBEDDINGS_API_KEY" in text
    assert KEY not in text


def test_load_config_names_the_fallback_variable_for_a_bad_key():
    with pytest.raises(ConfigError) as exc:
        load_config({"COLLEAGUE_API_KEY": BAD_KEY})
    assert "COLLEAGUE_API_KEY" in exc.value.message
    assert KEY not in exc.value.message


@pytest.mark.parametrize(
    "url",
    [
        f"http://127.0.0.1:9/{ADDRESS_PART}\r\nX: y/v1",
        f"http://127.0.0.1:9/{ADDRESS_PART} space/v1",
        f"http://127.0.0.1:9/{ADDRESS_PART}é/v1",
        f"http://127.0.0.1:9/{ADDRESS_PART}\x00/v1",
    ],
)
def test_load_config_refuses_an_address_a_request_line_cannot_carry(url):
    with pytest.raises(ConfigError) as exc:
        load_config({"EMBEDDINGS_API_KEY": KEY, "EMBEDDINGS_EMBED_URL": url})
    assert ADDRESS_PART not in exc.value.message + exc.value.remediation


def _start_with(tmp_path, config):
    route = EmbedRoute(config, gateway_timeout=0.5)
    server, thread = _start(tmp_path, route)
    return _Served(server, route), server, thread


def _stop(server, thread):
    server.shutdown()
    server.server_close()
    thread.join(5)


@pytest.mark.parametrize(
    "overrides",
    [
        {"key": BAD_KEY},  # http.client refuses the header, naming its value
        {"base_url": None},  # filled in below: a path http.client refuses, naming it
    ],
)
def test_settings_that_slipped_past_load_config_never_leak(tmp_path, gateway, capsys, overrides):
    if overrides.get("base_url", "") is None:
        # urlsplit drops CR and LF itself; a space reaches http.client, which refuses it.
        overrides = {"base_url": f"http://127.0.0.1:{gateway.port}/{ADDRESS_PART} x/v1"}
    served, server, thread = _start_with(tmp_path, _config(gateway.base, **overrides))
    try:
        texts = []
        for body in (
            {"op": "embed", "text": QUERY},
            {"op": "rerank", "query": QUERY, "candidates": ["a"]},
        ):
            status, headers, raw, status_line = _request(served, body=body)
            assert status == 502
            assert json.loads(raw)["code"] == "gateway-failed"
            texts += [status_line, json.dumps(headers), raw.decode()]
        texts = _all_output(capsys, texts)
        assert "Traceback" not in "\n".join(texts)
        _scan(texts, gateway)
    finally:
        _stop(server, thread)


def test_model_names_travel_in_the_body_only(tmp_path, gateway, capsys):
    odd = "model\r\nX-Injected: 1"
    served, server, thread = _start_with(
        tmp_path, _config(gateway.base, embed_model=odd, rerank_model=odd)
    )
    gateway.model_in_answer = None
    try:
        payload = _post(served, {"op": "embed", "text": "x"})[2]
        assert payload["model"] == odd
        assert gateway.seen[-1]["body"]["model"] == odd
        assert _post(served, {"op": "rerank", "query": "q", "candidates": ["a"]})[0] == 200
        assert "X-Injected" not in capsys.readouterr().err
    finally:
        _stop(server, thread)


def test_an_unexpected_error_is_a_fixed_refusal_and_a_fixed_log_line(served, capsys, monkeypatch):
    def explode(self, body):
        raise RuntimeError(f"{KEY} {GATEWAY_TEXT} {QUERY} {ADDRESS_PART}")

    monkeypatch.setattr(EmbedRoute, "answer", explode)
    status, headers, raw, status_line = _request(served, body={"op": "embed", "text": QUERY})
    payload = json.loads(raw)
    assert status == 502
    assert payload == {
        "ok": False,
        "code": "gateway-failed",
        "message": "The embedding service did not answer.",
    }
    texts = _all_output(capsys, [status_line, json.dumps(headers), raw.decode()])
    log = texts[-1]
    assert "Traceback" not in log
    assert "RuntimeError" not in log
    assert log.strip().endswith(f"POST {_embed_route.ROUTE} op=embed 502 51")
    for sentinel in (KEY, GATEWAY_TEXT, QUERY, ADDRESS_PART):
        assert sentinel not in "\n".join(texts)


def test_a_client_gone_before_the_answer_is_written_is_quiet(served, capsys, monkeypatch):
    def gone(*_a, **_k):
        raise BrokenPipeError(KEY)

    monkeypatch.setattr(_embed_route, "_send", gone)
    with pytest.raises((http.client.HTTPException, OSError)):
        _request(served, body={"op": "describe"})
    err = "\n".join(_all_output(capsys, []))
    assert "Traceback" not in err
    assert KEY not in err
    assert "gone" in err


@pytest.mark.parametrize("length", ["¹²", "1²", "+17", "1_7"])
def test_non_ascii_or_signed_digits_in_the_length_are_too_large(served, length):
    # Headers are read as Latin-1, where the superscript digits pass str.isdigit.
    lines = [*_good_lines(served)[:3], f"Content-Length: {length}"]
    got, _, payload = _raw_post(served, lines)
    assert got == 413
    assert payload["code"] == "too-large"


@pytest.mark.parametrize("length", ["١٧", "１７", "¹⁷", "²"])
def test_parse_length_accepts_ascii_digits_only(length):
    assert EmbedRoute._length(_message({"Content-Length": " 17 "})) == 17
    message = _message({"Content-Length": length})
    with pytest.raises(Refusal):
        EmbedRoute._length(message)


def test_a_long_model_name_from_the_gateway_falls_back_to_the_asked_model(served, gateway):
    gateway.model_in_answer = "m" * 201
    assert _post(served, {"op": "embed", "text": "x"})[2]["model"] == "embed-model"
    body = {"op": "rerank", "query": "q", "candidates": ["a"]}
    assert _post(served, body)[2]["model"] == "rerank-model"
    gateway.model_in_answer = "m" * 200
    assert _post(served, {"op": "embed", "text": "x"})[2]["model"] == "m" * 200


def _message(pairs):
    from email.message import Message

    message = Message()
    for name, value in pairs.items() if isinstance(pairs, dict) else pairs:
        message[name] = value
    return message


def _raw_post(served, header_lines, body=b'{"op": "describe"}'):
    head = f"POST {_embed_route.ROUTE} HTTP/1.1\r\n" + "".join(f"{h}\r\n" for h in header_lines)
    with socket.create_connection(("127.0.0.1", served.port), timeout=5) as sock:
        sock.sendall(head.encode("latin-1") + b"\r\n" + body)
        chunks = []
        while chunk := sock.recv(65536):
            chunks.append(chunk)
    data = b"".join(chunks)
    head_part, _, payload = data.partition(b"\r\n\r\n")
    return int(head_part.split()[1]), head_part.decode(), json.loads(payload)


def _good_lines(served, length=18):
    return [
        f"Host: {served.host}",
        f"Origin: {served.origin}",
        f"Content-Type: {JSON}",
        f"Content-Length: {length}",
    ]


def test_raw_post_baseline_is_answered(served):
    assert _raw_post(served, _good_lines(served))[0] == 200


@pytest.mark.parametrize(
    "extra,code,status",
    [
        ("Host: {host}", "wrong-host", 403),
        ("Host: evil.example", "wrong-host", 403),
        ("Origin: {origin}", "wrong-origin", 403),
        ("Origin: https://evil.example", "wrong-origin", 403),
        ("Content-Type: application/json", "wrong-content-type", 415),
        ("Content-Type: text/plain", "wrong-content-type", 415),
        ("Content-Length: 18", "too-large", 413),
        ("Content-Length: 5", "too-large", 413),
    ],
)
def test_a_repeated_header_is_refused(served, extra, code, status):
    line = extra.format(host=served.host, origin=served.origin)
    got, head, payload = _raw_post(served, [*_good_lines(served), line])
    assert got == status
    assert payload["code"] == code
    assert "access-control" not in head.lower()
