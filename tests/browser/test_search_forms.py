"""Search on the three delivery forms, in a real browser (task t12 of the search plan).

One small set (``search_site.py``: 960 points, 48 dimensions, 120 of them named) is shown by
each form, and the same steps are run through the public handle on each:

* **script**: ``fixtures/search-script-host.html`` mounts the core file with an ``embed``
  mount option; served with no policy, so nothing in the browser would block a request.
* **component**: ``fixtures/search-component-host.html`` uses only the element and assigns
  ``el.embed``; served under ``Content-Security-Policy: default-src 'self'``.
* **standalone**: the shipped ``index.html``, served by the real helper, ``embeddings-tumbler
  viewer serve --embed`` started as a process over a fake gateway on loopback, with a
  sentinel key and a sentinel address only in that process's environment.

On the first two the embed callback itself asks the test server (``fixtures/search-embed.js``
fetches ``search-queries.json``); on the third the page's own callback posts to the helper
route on its own origin.

What is proven, per form unless said:

* The lit points equal an exact ranking worked out here in Python from the same data file
  and block the page was served (``search_site.rank``): the results ``info()`` reports, in
  order, the radius, how many points are inside and lit, and the lit points themselves
  (the lit values the viewer handed the renderer, read through the handle's test hook).
  Again after an accepted append, which also shows the comparison below can come out
  different.
* A refused append (another model, another dimension) and a refused query vector (too
  short, another model, all zeros; given by the host or answered by the embedder; and an
  embedder that fails) each leave what is lit exactly as it was.
* No request leaves the page's origin while all that happens, and the log is shown to hold
  the callback's own requests. Negative control: a callback that asks another origin is
  caught by the same assertion, and that origin's own counter confirms the request arrived.
* Standalone only: no response the browser received (status line, headers, body), no
  response the helper gave to requests made here directly (good ones, refused ones, and
  with the gateway failing and echoing its own address and key), nothing the helper
  process printed, and nothing on the page holds the planted key or the gateway's address.
  That the key was really in play is shown by the gateway having received it.
"""

from __future__ import annotations

import http.client
import json

import pytest

from tests.browser import harness
from tests.browser import search_site as site_

FORMS = {
    # name: (page, policy header)
    "script": ("search-script-host.html", None),
    "component": ("search-component-host.html", "default-src 'self'"),
    "standalone": (f"index.html?data={site_.SET_FILE}", None),
}
STANDALONE = "standalone"
K = 8  # results per search with no reranker (the default)
RERANK_CANDIDATES = 50  # the defaults with the reranker on
RERANK_TOP = 20
APPENDED = 5
JSON_TYPE = "application/json"

UPDATE = f"""([model, dimension, ids, flat]) => {{
  const r = {site_.H}.update({{ schema_version: 1, kind: 'embeddings-tumbler/data',
    op: 'append', model: model, dimension: dimension, count: ids.length, text_included: true,
    points: ids.map((id) => ({{ id: id, label: '' }})), vectors: new Float32Array(flat) }});
  return {{ ok: r.ok, code: r.code || null }};
}}"""

RERANK_ON = f"async () => await {site_.H}.setSearchSettings({{ rerank: true }})"

PAGE_TEXT = f"""() => document.documentElement.outerHTML + JSON.stringify({site_.H}.info())"""

FOREIGN_CALLBACK = f"""(foreign) => {site_.H}.setSearchCallbacks({{ embed: async (text) => {{
  try {{
    await fetch(foreign + '/probe-search', {{ mode: 'no-cors' }});
  }} catch (err) {{
    window.__foreignFailed = String(err); // the other server answers nothing useful
  }}
  return window.__searchEmbed(text);
}} }})"""


@pytest.fixture(scope="module")
def folder(tmp_path_factory):
    path = tmp_path_factory.mktemp("search-forms")
    table = site_.build_site(path)
    return path, table


@pytest.fixture(scope="module")
def data(folder):
    """The set as the page is served it, and the two good query vectors."""
    path, table = folder
    meta, rows = site_.read_set(path)
    queries = [table["queries"][text]["vector"] for text in (site_.ALPHA, site_.BETA)]
    return {"points": meta["points"], "rows": rows, "queries": queries}


def _view(state: dict) -> dict:
    """What is lit and why, without what moves on its own (frames)."""
    keys = ("count", "active", "litCount", "sharedCount", "searches", "lit", "rendererLit")
    return {k: state[k] for k in keys}


def _refusals(table: dict) -> list[tuple[str, str, object, str]]:
    """(name, script, argument, the refusal code expected), in the order they are tried."""
    good = table["queries"][site_.ALPHA]["vector"]
    d = site_.DIMENSION
    search = site_.SET_SEARCHES
    return [
        (
            "append from another model",
            UPDATE,
            [site_.OTHER_MODEL, d, ["x-1", "x-2"], good + good],
            "model-mismatch",
        ),
        (
            "append of another dimension",
            UPDATE,
            [site_.MODEL, d - 1, ["y-1"], good[:-1]],
            "dimension-mismatch",
        ),
        (
            "a vector one dimension short",
            search,
            [{"vector": good[:-1], "model": site_.MODEL}],
            "query-dimension-mismatch",
        ),
        (
            "a vector from another model",
            search,
            [{"vector": good, "model": site_.OTHER_MODEL}],
            "query-model-mismatch",
        ),
        ("a vector of zeros", search, [{"vector": [0] * d, "model": site_.MODEL}], "query-zero"),
        ("the embedder answers one short", search, [site_.SHORT], "query-dimension-mismatch"),
        (
            "the embedder answers from another model",
            search,
            [site_.FOREIGN_MODEL],
            "query-model-mismatch",
        ),
        ("the embedder fails", search, [site_.UNKNOWN], "embed-failed"),
    ]


def _appended_rows(table: dict) -> list[list[float]]:
    """Unnamed points along the first query's own direction: all inside its radius."""
    good = table["queries"][site_.ALPHA]["vector"]
    return [site_.float32([x * (1.0 + 0.05 * j) for x in good]) for j in range(APPENDED)]


def _bodies(responses: list) -> list[dict]:
    out = []
    for response in responses:
        try:
            body = response.body()
        except Exception as exc:  # a response with no body to read (none is expected here)
            body = f"unreadable: {exc}".encode()
        headers = json.dumps(response.all_headers())
        out.append(
            {
                "url": response.url,
                "status": response.status,
                "line": response.status_text,
                "headers": headers,
                "body": body,
            }
        )
    return out


def _run(tab: harness.Tab, origin: str, name: str, table: dict) -> dict:
    responses: list = []
    tab.page.on("response", lambda response: responses.append(response))
    out: dict = {"name": name, "origin": origin, "tab": tab}
    out["ready"] = site_.open_form(tab, f"{origin}/{FORMS[name][0]}")
    out["first"] = tab.evaluate(site_.SET_SEARCHES, [site_.ALPHA, site_.BETA])
    out["shown"] = site_.settled(tab)
    out["refused"] = []
    for label, script, arg, code in _refusals(table):
        result = tab.evaluate(script, arg)
        state = site_.settled(tab, what=f"the view after {label}")
        out["refused"].append({"what": label, "result": result, "code": code, "state": state})
    rows = _appended_rows(table)
    ids = [f"new-{j}" for j in range(APPENDED)]
    flat = [x for row in rows for x in row]
    out["append"] = tab.evaluate(UPDATE, [site_.MODEL, site_.DIMENSION, ids, flat])
    tab.wait_for(
        site_.STATE,
        lambda s: s["count"] == site_.COUNT + APPENDED,
        timeout=site_.WAIT,
        what="the appended points",
    )
    out["appended"] = site_.settled(tab, what="the searches worked out again after the append")
    if name == STANDALONE:
        out["rerank"] = tab.evaluate(RERANK_ON)
        out["reranked"] = site_.settled(tab, what="the reranked searches")
    out["page_text"] = tab.evaluate(PAGE_TEXT)
    out["requests"] = list(tab.requests)
    out["bodies"] = _bodies(responses)
    return out


@pytest.fixture(scope="module")
def runs(browser, webgl, folder):
    """``runs(name)``: the steps above on one form, run once and kept for every test."""
    path, table = folder
    done: dict[str, dict] = {}
    closers: list = []

    def origin_for(name: str, out_extra: dict) -> str:
        if name != STANDALONE:
            server = harness.Server(path, csp=FORMS[name][1])
            closers.append(server.close)
            return server.origin
        gateway = site_.TableGateway(table)
        closers.append(gateway.close)
        helper = site_.HelperServer(path, gateway, path.parent / "helper-forms.log")
        closers.append(helper.close)
        out_extra.update(gateway=gateway, helper=helper)
        return helper.origin

    def get(name: str) -> dict:
        if name not in done:
            extra: dict = {}
            origin = origin_for(name, extra)
            tab = harness.Tab(browser, viewport=(1100, 900))
            try:
                done[name] = {**_run(tab, origin, name, table), **extra}
            finally:
                # closed at once: an open tab keeps rendering and slows every later page.
                # What the tab recorded (requests, console, violations) stays readable.
                tab.close()
        return done[name]

    yield get
    for close in reversed(closers):
        close()


@pytest.fixture(scope="module", params=list(FORMS))
def run(request, runs):
    return runs(request.param)


# --------------------------------------------------------------------------- the lit points


def _expected(data: dict, rows: list[list[float]], points: list[dict], k: int) -> list[dict]:
    return [site_.rank(points, rows, query, k) for query in data["queries"]]


def _assert_matches(state: dict, expected: list[dict], points: list[dict]):
    lit = set()
    for search, want in zip(state["searches"], expected, strict=True):
        assert want["margin"] > 1e-7, "the fixture has a point too near the radius to call"
        assert search["ids"] == want["ids"], search["letter"]
        assert search["distances"] == pytest.approx(want["distances"], abs=1e-9)
        assert search["radius"] == pytest.approx(want["radius"], abs=1e-9)
        assert search["insideCount"] == len(want["inside"]), search["letter"]
        lit |= want["inside"]
    assert state["litCount"] == len(lit)
    assert [points[i]["id"] for i in state["lit"]] == [points[i]["id"] for i in sorted(lit)]
    assert state["rendererLit"] is True


def test_the_searches_went_through_the_embedder(run):
    assert run["ready"]["embedder"] is True, run["ready"]
    assert run["first"]["ok"] is True, run["first"]
    shown = run["shown"]["searches"]
    assert [s["text"] for s in shown] == [site_.ALPHA, site_.BETA]
    assert [s["kind"] for s in shown] == ["embedded", "embedded"]
    assert [s["sentTo"] for s in shown] == ["embedder", "embedder"]
    assert [s["model"] for s in shown] == [site_.MODEL, site_.MODEL]


def test_lit_points_equal_an_exact_ranking_from_the_same_file(run, data):
    expected = _expected(data, data["rows"], data["points"], K)
    # the two searches light different points, and unnamed points too: the check is not
    # satisfied by an empty set or by the named results alone
    assert not expected[0]["inside"] & expected[1]["inside"]
    assert all(len(e["inside"]) > K for e in expected), [len(e["inside"]) for e in expected]
    _assert_matches(run["shown"], expected, data["points"])


def test_after_an_append_the_lit_points_equal_the_ranking_of_the_larger_set(run, folder, data):
    assert run["append"] == {"ok": True, "code": None}
    new_points = [{"id": f"new-{j}", "label": ""} for j in range(APPENDED)]
    points = data["points"] + new_points
    rows = data["rows"] + _appended_rows(folder[1])
    expected = _expected(data, rows, points, K)
    assert run["appended"]["count"] == site_.COUNT + APPENDED
    _assert_matches(run["appended"], expected, points)
    # every appended point is lit by the first search, so what is lit did change: the
    # comparison the refusal test makes can come out different
    assert set(range(site_.COUNT, site_.COUNT + APPENDED)) <= set(run["appended"]["lit"])
    assert _view(run["appended"]) != _view(run["shown"])


def test_a_refused_append_and_a_refused_query_vector_leave_the_lit_set_unchanged(run):
    before = _view(run["shown"])
    assert before["litCount"] > 0
    assert len(run["refused"]) == 8
    for step in run["refused"]:
        assert step["result"]["ok"] is False, step["what"]
        assert step["result"]["code"] == step["code"], step["what"]
        assert _view(step["state"]) == before, step["what"]


def test_the_standalone_page_reranks_through_the_helper(runs, folder, data):
    run_ = runs(STANDALONE)
    assert run_["rerank"]["ok"] is True, run_["rerank"]
    state = run_["reranked"]
    assert state["settings"]["rerank"] is True
    assert [s["reranker"] for s in state["searches"]] == [site_.RERANK_MODEL] * 2
    assert [s["sent"] for s in state["searches"]] == [RERANK_CANDIDATES] * 2
    # the fake gateway scores the candidates in the order given, so the kept results are
    # the nearest named points again, 20 of them
    new_points = [{"id": f"new-{j}", "label": ""} for j in range(APPENDED)]
    points = data["points"] + new_points
    rows = data["rows"] + _appended_rows(folder[1])
    _assert_matches(state, _expected(data, rows, points, RERANK_TOP), points)
    rerank_calls = [g for g in run_["gateway"].seen if g["path"].endswith("/rerank")]
    assert [len(g["body"]["documents"]) for g in rerank_calls] == [RERANK_CANDIDATES] * 2


# --------------------------------------------------------------------------- the network


def _paths(run_: dict, method: str) -> list[str]:
    origin = run_["origin"]
    return [
        r["url"].removeprefix(origin).split("?")[0]
        for r in run_["requests"]
        if r["method"] == method
    ]


def test_no_request_leaves_the_origin_while_searching(run):
    tab = run["tab"]
    tab.assert_no_foreign_requests(run["origin"])
    tab.assert_no_csp_violations()
    # the browser's own line for the helper's 502 (the embedder that fails) is expected
    tab.assert_no_console_errors(allow=[r"status of 502"] if run["name"] == STANDALONE else [])
    # the log is live and holds the callback's own requests to the test server: one per
    # text handed to the embedder (two good, three refused)
    if run["name"] == STANDALONE:
        posts = _paths(run, "POST")
        assert set(posts) == {site_.ROUTE}, posts
        assert len(posts) >= 6, posts  # describe, five embeds, then the reranks
    else:
        asked = [p for p in _paths(run, "GET") if p == "/" + site_.TABLE_FILE]
        assert len(asked) == 5, _paths(run, "GET")
    assert "/embeddings-tumbler.js" in _paths(run, "GET")
    assert "/" + site_.BLOCK_FILE in _paths(run, "GET")


def test_the_policy_each_form_was_served_under(run):
    document = next(b for b in run["bodies"] if b["url"].startswith(run["origin"] + "/"))
    header = json.loads(document["headers"]).get("content-security-policy")
    assert header == FORMS[run["name"]][1]
    if run["name"] == STANDALONE:
        assert b"connect-src 'self'" in document["body"], "the page's own meta policy"


def test_a_callback_that_asks_another_origin_is_caught(open_tab, webgl, folder, foreign):
    """Negative control for the network check: the same form, the same search, but the
    embed callback also asks a second loopback server."""
    path, _ = folder
    with harness.Server(path) as server:
        tab = open_tab()
        site_.open_form(tab, f"{server.origin}/{FORMS['script'][0]}")
        before = len(foreign.hits)
        assert tab.evaluate(FOREIGN_CALLBACK, foreign.origin)["embedder"] is True
        tab.assert_no_foreign_requests(server.origin)  # nothing yet: only a search asks
        result = tab.evaluate(site_.SET_SEARCHES, [site_.ALPHA])
        assert result["ok"] is True, result
        with pytest.raises(AssertionError, match="other than"):
            tab.assert_no_foreign_requests(server.origin)
        caught = tab.foreign_requests(server.origin)
        assert [r["url"] for r in caught] == [foreign.origin + "/probe-search"]
        assert "GET /probe-search" in foreign.hits[before:]


# --------------------------------------------------------------------------- the key


def _sentinels(gateway) -> list[bytes]:
    address = f"127.0.0.1:{gateway.port}"
    return [s.encode() for s in (site_.KEY, site_.ADDRESS_PART, address, gateway.base)]


def _found(blob: bytes | str, sentinels: list[bytes]) -> list[bytes]:
    raw = blob if isinstance(blob, bytes) else blob.encode()
    return [s for s in sentinels if s in raw]


def _ask(origin: str, body: bytes | None, *, method="POST", asker: str | None = None) -> bytes:
    """One request to the helper route; the whole answer (status line, headers, body)."""
    host = origin.split("//", 1)[1]
    headers = {"Origin": asker or origin}
    if body is not None:
        headers["Content-Type"] = JSON_TYPE
    connection = http.client.HTTPConnection(host, timeout=30)
    try:
        connection.request(method, site_.ROUTE, body=body, headers=headers)
        response = connection.getresponse()
        head = f"{response.status} {response.reason}\n{response.getheaders()}\n".encode()
        return head + response.read()
    finally:
        connection.close()


def _helper_answers(origin: str, gateway) -> dict[str, bytes]:
    def op(payload: dict) -> bytes:
        return json.dumps(payload).encode()

    embed = op({"op": "embed", "text": site_.ALPHA})
    answers = {
        "describe": _ask(origin, op({"op": "describe"})),
        "embed": _ask(origin, embed),
        "embed, no gateway answer": _ask(origin, op({"op": "embed", "text": site_.UNKNOWN})),
        "rerank": _ask(origin, op({"op": "rerank", "query": "q", "candidates": ["a", "b"]})),
        "wrong method": _ask(origin, None, method="GET"),
        "wrong origin": _ask(origin, embed, asker="http://127.0.0.1:1"),
        "bad json": _ask(origin, b"{"),
        "unknown op": _ask(origin, op({"op": "address"})),
    }
    gateway.mode = "error"  # the gateway now answers 500 with its own address and key
    try:
        answers["embed, gateway error"] = _ask(origin, embed)
        answers["rerank, gateway error"] = _ask(
            origin, op({"op": "rerank", "query": "q", "candidates": ["a"]})
        )
    finally:
        gateway.mode = "ok"
    return answers


def test_nothing_the_browser_or_a_caller_gets_holds_the_planted_key_or_address(runs):
    run_ = runs(STANDALONE)
    gateway, helper = run_["gateway"], run_["helper"]
    sentinels = _sentinels(gateway)
    # the sentinels were really in play: the gateway was reached at its address with the key
    assert {g["auth"] for g in gateway.seen} == {f"Bearer {site_.KEY}"}
    assert all(site_.ADDRESS_PART in g["path"] for g in gateway.seen)
    # and the scan finds each of them where they are
    assert _found(f"to {gateway.base} with {site_.KEY}", sentinels) == sentinels

    # every response the browser received while the page loaded and searched
    assert len(run_["bodies"]) >= 10, [b["url"] for b in run_["bodies"]]
    assert any(b["url"].endswith(site_.ROUTE) for b in run_["bodies"])
    for b in run_["bodies"]:
        whole = b["line"].encode() + b["headers"].encode() + b["body"]
        assert _found(whole, sentinels) == [], b["url"]
    # what the page shows and reports
    assert _found(run_["page_text"], sentinels) == []

    # every answer the helper gives a caller, good or refused
    answers = _helper_answers(helper.origin, gateway)
    statuses = {name: int(raw.split(b" ", 1)[0]) for name, raw in answers.items()}
    assert statuses == {
        "describe": 200,
        "embed": 200,
        "embed, no gateway answer": 502,
        "rerank": 200,
        "wrong method": 405,
        "wrong origin": 403,
        "bad json": 400,
        "unknown op": 400,
        "embed, gateway error": 502,
        "rerank, gateway error": 502,
    }
    for name, raw in answers.items():
        assert _found(raw, sentinels) == [], name
    # and what the process printed: its result line and its diagnostics
    assert helper.result["embed"]["enabled"] is True
    assert _found(helper.output(), sentinels) == []
