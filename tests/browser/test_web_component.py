"""Headless-browser check of the <embeddings-tumbler> element in a plain host page (task t10).

Serves the repository root on a loopback port and opens ``web_component_host.html`` in
headless Chromium driven by Playwright. The page runs under
``default-src 'self'; script-src 'self'; style-src 'self'`` and uses only the element:
``<embeddings-tumbler src=...>`` in the markup, with the data file (a contract fixture and its
``.f32`` block) served by the same loopback server. The page script only watches (events,
policy violations, animation-frame requests).

The test asserts: the element mounts a viewer that draws lit pixels; removing it destroys the
viewer (no viewer DOM, ``EmbeddingsTumbler.get(el)`` is gone, no animation frame is requested
afterwards); adding it back mounts again; changing ``src`` loads the other file; a ``src`` on
another origin is refused with a plain message and no request reaches that origin (counted by
the other origin's own server, and by the page's request log; a positive control shows the
counter works); a missing file gives a plain message; ``tumbler-load`` and ``tumbler-error``
fire; there are zero console errors (besides the one 404 the missing-file step asks for) and
zero CSP violations.

Rendering runs on **SwiftShader** so the result does not depend on the machine's GPU. The test
skips, never fails, when Playwright, a matching Chromium build, or WebGL 2 is not available.
"""

from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PAGE = "/tests/browser/web_component_host.html"
OPEN_PAGE = "/tests/browser/web_component_open.html"
DATA = "/tests/fixtures/contract/"
SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
WAIT_STEPS = 300  # times 100 ms


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - signature fixed by the base class
        pass


class _Counting(_Quiet):
    """The 'other origin': counts every request it receives."""

    hits: list[str] = []

    def do_GET(self):
        type(self).hits.append(self.path)
        super().do_GET()


def _serve(handler_cls):
    handler = functools.partial(handler_cls, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture(scope="module")
def servers():
    _Counting.hits = []
    main, other = _serve(_Quiet), _serve(_Counting)
    try:
        yield (
            f"http://127.0.0.1:{main.server_address[1]}",
            f"http://127.0.0.1:{other.server_address[1]}",
        )
    finally:
        for s in (main, other):
            s.shutdown()
            s.server_close()


def _wait(page, js: str):
    for _ in range(WAIT_STEPS):
        value = page.evaluate(js)
        if value:
            return value
        page.wait_for_timeout(100)
    return page.evaluate(js)


def _info(page) -> dict:
    return page.evaluate("""() => {
            const el = document.getElementById('wc');
            const T = window.EmbeddingsTumbler;
            const i = el.handle ? el.handle.info() : null;
            return {
              mounted: !!T.get(el), handle: !!el.handle, children: el.children.length,
              display: getComputedStyle(el).display, count: i && i.count,
              dimension: i && i.dimension, message: (el.querySelector('.tumbler-shell-message')
                || {}).textContent || null,
              text: el.textContent,
            };
        }""")


def _session(base: str, other: str) -> dict:
    sync_api = pytest.importorskip(
        "playwright.sync_api", reason="Playwright is not installed; run `uv sync`"
    )
    out: dict = {}
    with sync_api.sync_playwright() as pw:
        exe = Path(pw.chromium.executable_path)
        if not exe.exists():
            pytest.skip(f"no Chromium build for this Playwright version at {exe}")
        try:
            browser = pw.chromium.launch(args=SWIFTSHADER_ARGS)
        except Exception as exc:  # any launch failure means no usable browser here
            pytest.skip(f"Chromium could not be launched: {exc}")
        try:
            page = browser.new_page(viewport={"width": 1100, "height": 900})
            errors: list[str] = []
            requests: list[str] = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
            page.on("request", lambda req: requests.append(req.url))
            page.goto(base + PAGE)

            def events():
                return page.evaluate("() => window.__wc.events")

            def wait_events(n):
                return _wait(page, f"() => window.__wc.events.length >= {n} && window.__wc.events")

            def lit():
                return page.evaluate("() => window.__litMax(document.getElementById('wc'), 12)")

            # 1. The element in the markup mounts and loads src.
            wait_events(1)
            out["first_events"] = events()
            out["loaded"] = _info(page)
            if lit() < 0:
                pytest.skip("WebGL 2 unavailable in headless Chromium")
            out["lit"] = lit()
            out["requests_after_load"] = [u for u in requests if DATA in u]

            # 2. Remove: the viewer is destroyed and no frame is requested afterwards.
            page.evaluate(
                "() => { window.__el = document.getElementById('wc'); window.__el.remove(); }"
            )
            frames0 = page.evaluate("() => window.__wc.frameRequests")
            page.wait_for_timeout(600)
            out["removed"] = page.evaluate("""() => ({
                    mounted: !!window.EmbeddingsTumbler.get(window.__el),
                    handle: !!window.__el.handle,
                    children: window.__el.children.length,
                    frames: window.__wc.frameRequests,
                })""")
            out["frames_while_removed"] = out["removed"]["frames"] - frames0

            # 3. Add it back: it mounts again and loads again.
            n_before = len(events())
            page.evaluate(
                "() => document.body.insertBefore(window.__el, document.querySelector('.after'))"
            )
            wait_events(n_before + 1)
            out["readded"] = _info(page)
            out["readded_lit"] = lit()
            out["readded_viewers"] = page.evaluate(
                "() => window.__el.querySelectorAll('.tumbler').length"
            )

            # 4. Change src: the other file replaces the first.
            n_before = len(events())
            page.evaluate(
                f"() => document.getElementById('wc').setAttribute('src', '{DATA}valid-1024.json')"
            )
            wait_events(n_before + 1)
            out["switched"] = _info(page)
            out["switched_events"] = events()[n_before:]
            out["switched_lit"] = lit()

            # 5. A src on another origin: refused, nothing requested from it.
            n_before = len(events())
            other_hits_before = len(_Counting.hits)
            target = f"{other}{DATA}valid-384.json"
            page.evaluate("(u) => document.getElementById('wc').setAttribute('src', u)", target)
            wait_events(n_before + 1)
            page.wait_for_timeout(300)
            out["foreign_events"] = events()[n_before:]
            out["foreign"] = _info(page)
            out["foreign_server_hits"] = _Counting.hits[other_hits_before:]
            out["foreign_page_requests"] = [u for u in requests if u.startswith(other)]

            # 6. A missing file: a plain message, an error event.
            n_before = len(events())
            page.evaluate(
                f"() => document.getElementById('wc').setAttribute('src', '{DATA}nope.json')"
            )
            wait_events(n_before + 1)
            out["missing_events"] = events()[n_before:]
            out["missing"] = _info(page)

            # 7. A valid file again clears the message.
            n_before = len(events())
            page.evaluate(
                f"() => document.getElementById('wc').setAttribute('src', '{DATA}valid-384.json')"
            )
            wait_events(n_before + 1)
            out["recovered"] = _info(page)

            out["violations"] = page.evaluate("() => window.__wc.violations")
            out["errors"] = errors

            # 8. Control: the same refusal on a page with no connect restriction, with a
            # positive control showing the other origin's counter does see a request.
            page2 = browser.new_page(viewport={"width": 1100, "height": 900})
            reqs2: list[str] = []
            page2.on("request", lambda req: reqs2.append(req.url))
            page2.goto(base + OPEN_PAGE)
            _wait(page2, "() => window.__wc.events.length >= 1 && window.__wc.events")
            before = len(_Counting.hits)
            page2.evaluate("(u) => document.getElementById('wc').setAttribute('src', u)", target)
            _wait(page2, "() => window.__wc.events.length >= 2 && window.__wc.events")
            page2.wait_for_timeout(300)
            out["open_refusal"] = page2.evaluate("() => window.__wc.events[1]")
            out["open_hits"] = _Counting.hits[before:]
            out["open_page_requests"] = [u for u in reqs2 if u.startswith(other)]
            page2.evaluate("(u) => fetch(u, { mode: 'no-cors' })", f"{other}{DATA}index.json")
            page2.wait_for_timeout(300)
            out["control_hits"] = _Counting.hits[before:]
        finally:
            browser.close()
    return out


@pytest.fixture(scope="module")
def run(servers):
    return _session(*servers)


def test_element_mounts_and_loads_src_swiftshader(run):
    ev = run["first_events"][0]
    assert ev["type"] == "tumbler-load" and ev["target"] == "wc"
    assert ev["detail"]["ok"] is True and ev["detail"]["count"] == 6
    info = run["loaded"]
    assert info["mounted"] and info["handle"] and info["children"] == 1
    assert info["display"] == "block"
    assert info["count"] == 6 and info["dimension"] == 384
    assert run["lit"] > 50, "the viewer drew nothing"
    assert sorted(u.rsplit("/", 1)[1] for u in run["requests_after_load"]) == [
        "valid-384.f32",
        "valid-384.json",
    ]


def test_removing_the_element_destroys_the_viewer_swiftshader(run):
    r = run["removed"]
    assert r["mounted"] is False and r["handle"] is False and r["children"] == 0
    assert run["frames_while_removed"] == 0, "animation frames were requested after removal"


def test_adding_the_element_again_mounts_again_swiftshader(run):
    info = run["readded"]
    assert info["mounted"] and info["children"] == 1 and info["count"] == 6
    assert run["readded_viewers"] == 1, "a moved element leaked a viewer"
    assert run["readded_lit"] > 50


def test_changing_src_loads_the_other_file_swiftshader(run):
    info = run["switched"]
    assert info["dimension"] == 1024 and info["count"] == 4  # valid-1024.json: 4 points
    assert run["switched_events"][0]["type"] == "tumbler-load"
    assert run["switched_events"][0]["detail"]["op"] == "replace"
    assert run["switched_lit"] > 50


def test_another_origin_is_refused_and_never_requested_swiftshader(run):
    ev = run["foreign_events"][0]
    assert ev["type"] == "tumbler-error" and ev["detail"]["code"] == "src-refused"
    assert "own origin" in run["foreign"]["message"]
    assert run["foreign_server_hits"] == []
    assert run["foreign_page_requests"] == []
    assert run["foreign"]["mounted"], "the viewer stays mounted and keeps its data"
    assert run["foreign"]["count"] == 4 and run["foreign"]["dimension"] == 1024


def test_the_refusal_holds_without_a_connect_restriction_swiftshader(run):
    # Same refusal on a page whose policy would allow the request: still nothing is sent.
    assert run["open_refusal"]["type"] == "tumbler-error"
    assert run["open_refusal"]["detail"]["code"] == "src-refused"
    assert run["open_hits"] == [] and run["open_page_requests"] == []
    # Positive control: a request to that origin would have been counted.
    assert len(run["control_hits"]) == 1


def test_a_missing_file_gives_a_plain_message_swiftshader(run):
    ev = run["missing_events"][0]
    assert ev["type"] == "tumbler-error" and ev["detail"]["code"] == "src-unreadable"
    assert "could not be read" in run["missing"]["message"]


def test_a_good_file_clears_the_message_swiftshader(run):
    assert run["recovered"]["message"] is None
    assert run["recovered"]["dimension"] == 384


def test_no_csp_violation_and_no_console_error_swiftshader(run):
    assert run["violations"] == []
    # The only error allowed is the browser's own line for the 404 the missing-file step asks for.
    unexpected = [e for e in run["errors"] if "404" not in e]
    assert unexpected == []
    assert len(run["errors"]) <= 1
