"""Headless-browser check that the three modes drive the renderer (task t7).

Serves the repository root on a loopback port and opens the development modes demo
(``js/dev/modes-demo/``) in headless Chromium driven by Playwright, on a reduced
sample set (2,000 points). It switches through Tumble, Lattice and Wander with the
keys 1, 2 and 3 and asserts that each mode drew frames with lit pixels, that the
status line came from the mode, and that nothing logged a console error or asked
another origin for anything.

Rendering runs on **SwiftShader** (``--use-angle=swiftshader``) so the result does
not depend on the machine's GPU. The test skips, never fails, when Playwright, a
matching Chromium build, or WebGL 2 is not available.
"""

from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PAGE = "/js/dev/modes-demo/?n=2000&seed=3&check=1"
SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
MODES = [("1", "tumble"), ("2", "lattice"), ("3", "wander")]


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):  # noqa: A002 - signature fixed by the base class
        pass


@pytest.fixture(scope="module")
def loopback_server():
    handler = functools.partial(_QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _poll(page, expr, tries=300):
    # The page's CSP (script-src 'self') blocks wait_for_function's string
    # evaluation, so poll with evaluate(), which the policy does not cover.
    for _ in range(tries):
        value = page.evaluate(expr)
        if value:
            return value
        page.wait_for_timeout(100)
    return None


def _run(base_url: str) -> dict:
    sync_api = pytest.importorskip(
        "playwright.sync_api", reason="Playwright is not installed; run `uv sync`"
    )
    with sync_api.sync_playwright() as pw:
        exe = Path(pw.chromium.executable_path)
        if not exe.exists():
            pytest.skip(f"no Chromium build for this Playwright version at {exe}")
        try:
            browser = pw.chromium.launch(args=SWIFTSHADER_ARGS)
        except Exception as exc:  # any launch failure means no usable browser here
            pytest.skip(f"Chromium could not be launched: {exc}")
        try:
            page = browser.new_page(viewport={"width": 480, "height": 320})
            errors: list[str] = []
            foreign: list[str] = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
            page.on(
                "request",
                lambda req: (None if req.url.startswith(base_url) else foreign.append(req.url)),
            )
            page.goto(base_url + PAGE)
            first = _poll(
                page,
                "() => { const d = window.__modesDemo; return d && (d.ready || d.error); }",
            )
            if first is None:
                pytest.fail("the modes demo never started")
            demo = page.evaluate("() => window.__modesDemo")
            if demo.get("error") and "WebGL" in demo["error"]:
                pytest.skip(f"WebGL 2 unavailable in headless Chromium: {demo['error']}")
            statuses = {}
            for key, mode in MODES:
                page.keyboard.press(key)
                got = _poll(
                    page,
                    "() => { const d = window.__modesDemo; return d.mode === '%s' && "
                    "(d.litByMode['%s'] || 0) > 0 && d.prepMs['%s'] !== undefined; }"
                    % (mode, mode, mode),
                )
                assert got, f"{mode} never drew a lit frame"
                page.wait_for_timeout(1200)
                statuses[mode] = page.evaluate("() => window.__modesDemo.status")
            demo = page.evaluate("() => window.__modesDemo")
        finally:
            browser.close()
    demo["console_errors"] = errors
    demo["foreign_requests"] = foreign
    demo["statuses"] = statuses
    return demo


@pytest.fixture(scope="module")
def demo_result(loopback_server):
    return _run(loopback_server)


def test_modes_demo_ran_without_errors_or_foreign_requests_swiftshader(demo_result):
    assert demo_result["error"] is None, demo_result["error"]
    assert demo_result["console_errors"] == []
    assert demo_result["foreign_requests"] == []


@pytest.mark.parametrize("mode", [m for _, m in MODES])
def test_each_mode_draws_lit_frames_swiftshader(demo_result, mode):
    assert demo_result["framesByMode"][mode] > 5
    assert demo_result["litByMode"][mode] > 50, demo_result["litByMode"]


def test_status_lines_come_from_the_modes_swiftshader(demo_result):
    s = demo_result["statuses"]
    assert "strongest directions" in s["tumble"] and "variance" in s["tumble"]
    assert "trading for a hidden direction" in s["lattice"]
    assert s["wander"].startswith('"') or s["wander"].startswith("at ") or "heading" in s["wander"]
