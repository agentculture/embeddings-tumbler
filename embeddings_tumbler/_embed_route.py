"""The local search route for ``viewer serve --embed``: embed a query, optionally rerank.

Standard library only. The gateway key is read from the server process's environment
(only when ``--embed`` is given) and lives in memory here; it is sent to the gateway in
one request header and nowhere else. No answer, header or log line written by this
module carries the key, the gateway address, the gateway's own text or the query text.

The contract (flags, environment, the one path, its operations, refusals and limits) is
the helper-route section of ``docs/search-interface.md``.

Who may call it: only a same-origin ``POST`` with a JSON body. A page on another site can
send a simple (preflight-free) POST to a loopback port, so the checks are made here and
not left to the browser: the ``Host`` header must name the bound address (which a DNS
rebinding attack cannot fake), the ``Origin`` header must be this server, the content
type must be JSON (which a form cannot send), and no cross-origin header is ever sent.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import math
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from urllib.parse import urlsplit, urlunsplit

from embeddings_tumbler._static_server import is_loopback

ROUTE = "/_tumbler/search"

DEFAULT_EMBED_URL = "http://localhost:8001/v1"
DEFAULT_EMBED_MODEL = "Qwen/Qwen3-Embedding-0.6B"
URL_VARIABLE = "EMBEDDINGS_EMBED_URL"
MODEL_VARIABLE = "EMBEDDINGS_EMBED_MODEL"
KEY_VARIABLES = ("EMBEDDINGS_API_KEY", "COLLEAGUE_API_KEY")

MAX_BODY_BYTES = 1_048_576
MAX_TEXT_CHARS = 8000
MAX_CANDIDATES = 60
MAX_CANDIDATE_CHARS = 4000
REQUESTS_PER_MINUTE = 120
WINDOW_SECONDS = 60.0
GATEWAY_TIMEOUT_SECONDS = 20.0
BODY_TIMEOUT_SECONDS = 10.0
# A 2,560-d vector as JSON is well under 100 KB; anything far larger is not an answer.
MAX_GATEWAY_BYTES = 16 * 1_048_576

LIMITS = {
    "maxTextChars": MAX_TEXT_CHARS,
    "maxCandidates": MAX_CANDIDATES,
    "maxCandidateChars": MAX_CANDIDATE_CHARS,
    "requestsPerMinute": REQUESTS_PER_MINUTE,
}

_EMBED_FAILED = "The embedding service did not answer."
_RERANK_FAILED = "The reranking service did not answer."
_TIMEOUT = "The service did not answer in time."

# Every refusal: status, code, fixed message. No message carries request or gateway text.
_REFUSALS: dict[str, tuple[HTTPStatus, str]] = {
    "wrong-method": (HTTPStatus.METHOD_NOT_ALLOWED, "Only POST is answered here."),
    "wrong-host": (HTTPStatus.FORBIDDEN, "The Host header does not name this server."),
    "wrong-origin": (HTTPStatus.FORBIDDEN, "Only this server's own pages may ask."),
    "wrong-content-type": (
        HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
        "The body must be sent as application/json.",
    ),
    "too-large": (HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "The body is missing a length or too big."),
    "bad-json": (HTTPStatus.BAD_REQUEST, "The body is not a JSON object."),
    "bad-request": (HTTPStatus.BAD_REQUEST, "Unknown operation, or a field is missing or wrong."),
    "text-too-long": (HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "A text is longer than the limit."),
    "too-many-candidates": (
        HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
        "There are more candidates than the limit.",
    ),
    "rate-limited": (HTTPStatus.TOO_MANY_REQUESTS, "Too many requests; wait and try again."),
    "rerank-unavailable": (HTTPStatus.NOT_FOUND, "Reranking is not offered by this server."),
    "gateway-failed": (HTTPStatus.BAD_GATEWAY, _EMBED_FAILED),
    "gateway-timeout": (HTTPStatus.GATEWAY_TIMEOUT, _TIMEOUT),
}

_OPS = ("describe", "embed", "rerank")
_LOGGED_METHODS = ("GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS")


class ConfigError(Exception):
    """The environment cannot give a usable gateway. The message names variables only."""

    def __init__(self, message: str, remediation: str) -> None:
        super().__init__(message)
        self.message = message
        self.remediation = remediation


class Refusal(Exception):
    """A request the route answers with one of the fixed refusals."""

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status, fixed = _REFUSALS[code]
        self.message = message or fixed


@dataclass(frozen=True)
class RouteConfig:
    """What the route needs. The address and key never appear in ``repr``."""

    base_url: str = field(repr=False)
    key: str = field(repr=False)
    embed_model: str
    rerank_model: str | None
    query_prefix: str | None

    @property
    def query_form(self) -> str:
        return "prefixed" if self.query_prefix else "plain"

    def public(self) -> dict[str, object]:
        """The serve result's ``embed`` block: never the address or the key."""
        return {
            "enabled": True,
            "route": ROUTE,
            "model": self.embed_model,
            "rerank_model": self.rerank_model,
            "query_form": self.query_form,
        }


def _usable_base_url(url: str) -> bool:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    return (
        parts.scheme in ("http", "https")
        and bool(parts.hostname)
        and port != 0
        and parts.username is None
        and not parts.query
        and not parts.fragment
    )


def _check_base_url(url: str) -> None:
    """Only a plain http or https address with a host: no credentials, query or fragment.

    The scheme is restricted here because the address is handed to ``http.client``,
    which is chosen over ``urllib`` so that no other scheme can be opened and no
    redirect is ever followed. The message names the variable, never its value.
    """
    if not _usable_base_url(url):
        raise ConfigError(
            f"{URL_VARIABLE} is not an http or https address",
            "set it to the gateway's base address, for example its /v1 address",
        )


def load_config(
    environ: Mapping[str, str],
    *,
    embed_model: str | None = None,
    rerank_model: str | None = None,
    query_prefix: str | None = None,
) -> RouteConfig:
    """Read the gateway settings. Called only when ``--embed`` is given."""
    key = next((environ[v] for v in KEY_VARIABLES if environ.get(v)), "")
    if not key:
        names = " or ".join(KEY_VARIABLES)
        raise ConfigError(
            f"no gateway key: set {names}",
            "start the server under grant run so the key is only in its environment",
        )
    base_url = environ.get(URL_VARIABLE) or DEFAULT_EMBED_URL
    _check_base_url(base_url)
    model = embed_model or environ.get(MODEL_VARIABLE) or DEFAULT_EMBED_MODEL
    return RouteConfig(
        base_url=base_url.rstrip("/"),
        key=key,
        embed_model=model,
        rerank_model=rerank_model or None,
        query_prefix=query_prefix or None,
    )


# --- the gateway -------------------------------------------------------------------


def gateway_post(
    config: RouteConfig, path: str, payload: dict, *, timeout: float, failed: str
) -> object:
    """POST JSON to ``<base><path>`` and return the parsed answer.

    Raises :class:`Refusal` (``gateway-failed`` with ``failed`` as its message, or
    ``gateway-timeout``). The gateway's status text, body and address are never put in
    the refusal. A redirect is a failure: ``http.client`` does not follow redirects.
    """
    parts = urlsplit(config.base_url)
    connection_class = (
        http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parts.hostname, parts.port, timeout=timeout)
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {config.key}",
    }
    try:
        connection.request("POST", parts.path + path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read(MAX_GATEWAY_BYTES + 1)
        status = response.status
    except TimeoutError:
        raise Refusal("gateway-timeout") from None
    except (OSError, http.client.HTTPException):
        raise Refusal("gateway-failed", failed) from None
    finally:
        connection.close()
    if status != HTTPStatus.OK or len(raw) > MAX_GATEWAY_BYTES:
        raise Refusal("gateway-failed", failed)
    try:
        return json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Refusal("gateway-failed", failed) from None


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _answered_model(answer: object, asked: str) -> str:
    """The model the gateway says it used, else the one asked for."""
    model = answer.get("model") if isinstance(answer, dict) else None
    return model if isinstance(model, str) and model else asked


def parse_embedding(answer: object) -> list[float] | None:
    """``data[0].embedding`` of an OpenAI-compatible answer, or None if malformed."""
    if not isinstance(answer, dict):
        return None
    data = answer.get("data")
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        return None
    vector = data[0].get("embedding")
    if not isinstance(vector, list) or not vector:
        return None
    if not all(_finite_number(v) for v in vector):
        return None
    return [float(v) for v in vector]


def _score_row(row: object, count: int) -> tuple[int, float] | None:
    if not isinstance(row, dict):
        return None
    index, score = row.get("index"), row.get("relevance_score")
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < count:
        return None
    if not _finite_number(score):
        return None
    return index, float(score)


def parse_rerank(answer: object, count: int) -> list[float] | None:
    """One score per candidate from ``results[].index`` / ``relevance_score``, or None.

    The shape is the one vLLM's ``/v1/rerank`` documents; it is an assumption not yet
    checked against the real gateway (see ``docs/search-interface.md``). Every candidate
    must be scored exactly once.
    """
    results = answer.get("results") if isinstance(answer, dict) else None
    if not isinstance(results, list) or len(results) != count:
        return None
    scores: list[float | None] = [None] * count
    for row in results:
        parsed = _score_row(row, count)
        if parsed is None or scores[parsed[0]] is not None:
            return None
        scores[parsed[0]] = parsed[1]
    return [s for s in scores if s is not None]


# --- the rate window ----------------------------------------------------------------


class RateWindow:
    """At most ``limit`` admitted requests in any ``window`` seconds, for the whole server."""

    def __init__(
        self,
        limit: int = REQUESTS_PER_MINUTE,
        window: float = WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limit = limit
        self._window = window
        self._clock = clock
        self._times: deque[float] = deque()
        self._lock = threading.Lock()

    def admit(self) -> bool:
        with self._lock:
            now = self._clock()
            while self._times and now - self._times[0] >= self._window:
                self._times.popleft()
            if len(self._times) >= self._limit:
                return False
            self._times.append(now)
            return True


# --- the route ----------------------------------------------------------------------


def _bracketed(host: str) -> str:
    try:
        if ipaddress.ip_address(host).version == 6:
            return f"[{host}]"
    except ValueError:
        pass
    return host


def _text_field(body: dict, name: str, limit: int) -> str:
    value = body.get(name)
    if not isinstance(value, str):
        raise Refusal("bad-request")
    if len(value) > limit:
        raise Refusal("text-too-long")
    return value


def _candidates_field(body: dict) -> list[str]:
    value = body.get("candidates")
    if not isinstance(value, list) or not all(isinstance(c, str) for c in value):
        raise Refusal("bad-request")
    if len(value) > MAX_CANDIDATES:
        raise Refusal("too-many-candidates")
    if any(len(c) > MAX_CANDIDATE_CHARS for c in value):
        raise Refusal("text-too-long")
    return value


class EmbedRoute:
    """The route object a ``_static_server`` handler hands requests for ``ROUTE`` to."""

    def __init__(
        self,
        config: RouteConfig,
        *,
        rate: RateWindow | None = None,
        gateway_timeout: float = GATEWAY_TIMEOUT_SECONDS,
        body_timeout: float = BODY_TIMEOUT_SECONDS,
    ) -> None:
        self.config = config
        self._rate = rate or RateWindow()
        self._gateway_timeout = gateway_timeout
        self._body_timeout = body_timeout
        self._hosts: frozenset[str] = frozenset()

    def bind(self, host: str, port: int) -> None:
        """Record the bound address: the ``Host`` values this server accepts."""
        names = {host.lower()}
        if is_loopback(host):
            names |= {"127.0.0.1", "localhost", "::1"}
        hosts = {f"{_bracketed(n)}:{port}" for n in names}
        if port == 80:
            hosts |= {_bracketed(n) for n in names}
        self._hosts = frozenset(hosts)

    @staticmethod
    def owns(raw_path: str) -> bool:
        return urlsplit(raw_path).path == ROUTE

    def describe(self) -> dict[str, object]:
        rerank = {"model": self.config.rerank_model} if self.config.rerank_model else None
        return {
            "ok": True,
            "embed": {"model": self.config.embed_model, "query_form": self.config.query_form},
            "rerank": rerank,
            "limits": dict(LIMITS),
        }

    # -- checks, in order ---------------------------------------------------------

    def _check_caller(self, headers) -> None:
        host = (headers.get("Host") or "").strip().lower()
        if host not in self._hosts:
            raise Refusal("wrong-host")
        origin = (headers.get("Origin") or "").strip().lower()
        if origin != urlunsplit(("http", host, "", "", "")):
            raise Refusal("wrong-origin")
        ctype = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            raise Refusal("wrong-content-type")

    @staticmethod
    def _length(headers) -> int:
        raw = headers.get("Content-Length")
        if raw is None or not raw.strip().isdigit():
            raise Refusal("too-large")
        length = int(raw)
        if length > MAX_BODY_BYTES:
            raise Refusal("too-large")
        return length

    @staticmethod
    def _parse(raw: bytes) -> dict:
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise Refusal("bad-json") from None
        if not isinstance(body, dict):
            raise Refusal("bad-json")
        return body

    # -- operations ---------------------------------------------------------------

    def answer(self, body: dict) -> dict[str, object]:
        """The answer to one parsed request body (raises :class:`Refusal`)."""
        op = body.get("op")
        if op == "describe":
            return self.describe()
        if op == "embed":
            return self._embed(_text_field(body, "text", MAX_TEXT_CHARS))
        if op == "rerank":
            if not self.config.rerank_model:
                raise Refusal("rerank-unavailable")
            query = _text_field(body, "query", MAX_TEXT_CHARS)
            return self._rerank(query, _candidates_field(body))
        raise Refusal("bad-request")

    def _embed(self, text: str) -> dict[str, object]:
        config = self.config
        sent = (config.query_prefix or "") + text
        answer = gateway_post(
            config,
            "/embeddings",
            {"model": config.embed_model, "input": [sent]},
            timeout=self._gateway_timeout,
            failed=_EMBED_FAILED,
        )
        vector = parse_embedding(answer)
        if vector is None:
            raise Refusal("gateway-failed", _EMBED_FAILED)
        return {
            "ok": True,
            "vector": vector,
            "model": _answered_model(answer, config.embed_model),
            "query_form": config.query_form,
        }

    def _rerank(self, query: str, candidates: list[str]) -> dict[str, object]:
        model = self.config.rerank_model or ""
        if not candidates:
            return {"ok": True, "scores": [], "model": model}
        answer = gateway_post(
            self.config,
            "/rerank",
            {"model": model, "query": query, "documents": candidates},
            timeout=self._gateway_timeout,
            failed=_RERANK_FAILED,
        )
        scores = parse_rerank(answer, len(candidates))
        if scores is None:
            raise Refusal("gateway-failed", _RERANK_FAILED)
        return {"ok": True, "scores": scores, "model": _answered_model(answer, model)}

    # -- the HTTP exchange --------------------------------------------------------

    def handle(self, handler) -> None:
        """Answer one request on ``ROUTE``. ``handler`` is a ``BaseHTTPRequestHandler``."""
        handler.close_connection = True
        state = {"op": "-", "length": 0}
        try:
            payload = self._handle(handler, state)
            status = HTTPStatus.OK
        except Refusal as refusal:
            payload = {"ok": False, "code": refusal.code, "message": refusal.message}
            status = refusal.status
        except TimeoutError:
            # The body did not arrive in time: drop the connection without an answer.
            _log(handler, state, "dropped")
            return
        _send(handler, status, payload)
        _log(handler, state, str(int(status)))

    def _handle(self, handler, state: dict) -> dict[str, object]:
        if handler.command != "POST":
            raise Refusal("wrong-method")
        headers = handler.headers
        self._check_caller(headers)
        length = self._length(headers)
        state["length"] = length
        if not self._rate.admit():
            raise Refusal("rate-limited")
        handler.connection.settimeout(self._body_timeout)
        raw = handler.rfile.read(length)
        if len(raw) < length:
            raise TimeoutError
        body = self._parse(raw)
        op = body.get("op")
        if op in _OPS:
            state["op"] = op
        return self.answer(body)


def _send(handler, status: HTTPStatus, payload: dict) -> None:
    """Write the answer without ``send_response``, whose access log prints the raw path."""
    data = json.dumps(payload, allow_nan=False).encode("utf-8")
    handler.send_response_only(status)
    handler.send_header("Server", handler.version_string())
    handler.send_header("Date", handler.date_time_string())
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    if status == HTTPStatus.METHOD_NOT_ALLOWED:
        handler.send_header("Allow", "POST")
    handler.send_header("Connection", "close")
    handler.end_headers()
    if handler.command != "HEAD":
        handler.wfile.write(data)


def _log(handler, state: dict, status: str) -> None:
    """One line per request: method, the fixed path, op, status, body length. Never text."""
    method = handler.command if handler.command in _LOGGED_METHODS else "OTHER"
    handler.log_message("%s %s op=%s %s %d", method, ROUTE, state["op"], status, state["length"])
