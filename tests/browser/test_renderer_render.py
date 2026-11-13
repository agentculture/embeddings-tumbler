"""Headless-browser check that the WebGL 2 renderer really draws (task t6).

Serves the repository root on a loopback port, opens ``renderer_render.html`` in
headless Chromium driven by Playwright, and asserts that a 384-d and a 1024-d
contract fixture each render to a frame with lit pixels, with no console error.

Rendering runs on **SwiftShader** (Chromium's software GPU), forced with
``--use-angle=swiftshader``, so the result does not depend on the machine's GPU
and works on CI runners without one. The test skips, never fails, when
Playwright, a matching Chromium build, or WebGL 2 is not available.
"""

from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PAGE = "/tests/browser/renderer_render.html"
SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]


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


def _render_in_browser(base_url: str) -> dict:
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
            page = browser.new_page()
            console_errors: list[str] = []
            foreign: list[str] = []
            page.on(
                "console",
                lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
            )
            page.on("pageerror", lambda exc: console_errors.append(f"pageerror: {exc}"))
            page.on(
                "request",
                lambda req: (None if req.url.startswith(base_url) else foreign.append(req.url)),
            )
            page.goto(base_url + PAGE)
            # The page's CSP (script-src 'self') blocks wait_for_function's string
            # evaluation, so poll with evaluate(), which the policy does not cover.
            result = None
            for _ in range(600):
                result = page.evaluate("() => window.__rendererResult || null")
                if result is not None:
                    break
                page.wait_for_timeout(100)
            assert result is not None, "the page never reported a result"
        finally:
            browser.close()
    result["console_errors"] = console_errors
    result["foreign_requests"] = foreign
    return result


@pytest.fixture(scope="module")
def render_result(loopback_server):
    result = _render_in_browser(loopback_server)
    if result.get("unavailable"):
        pytest.skip(f"WebGL 2 unavailable in headless Chromium: {result['unavailable']}")
    return result


def test_page_ran_without_console_errors_or_foreign_requests_swiftshader(render_result):
    assert render_result["fatal"] is None, render_result["fatal"]
    assert render_result["console_errors"] == []
    assert render_result["foreign_requests"] == []


@pytest.mark.parametrize("case", ["d384", "d1024"])
def test_fixture_renders_non_blank_frame_swiftshader(render_result, case):
    res = render_result["cases"][case]
    assert res["made"]["ok"] is True, res
    assert res["set"] is True
    assert res["status"]["ok"] is True
    assert res["status"]["hdr"] is True, "SwiftShader offers float colour buffers"
    assert res["pixels"]["lit"] > 50, res["pixels"]
    assert res["pixels"]["max"] > 100, res["pixels"]


def test_dimension_reaches_the_renderer_swiftshader(render_result):
    assert render_result["cases"]["d384"]["status"]["dimension"] == 384
    assert render_result["cases"]["d1024"]["status"]["dimension"] == 1024
    assert render_result["cases"]["d1024"]["status"]["layout"]["texelsPerPoint"] == 256


def test_without_hdr_target_still_renders_swiftshader(render_result):
    res = render_result["cases"]["d1024_nohdr"]
    assert res["status"]["hdr"] is False
    assert res["pixels"]["lit"] > 50, res["pixels"]


def test_context_loss_is_survived_by_rebuilding_swiftshader(render_result):
    res = render_result["cases"]["restore"]
    if "skipped" in res:
        pytest.skip(res["skipped"])
    assert res["lost"] is True
    assert res["drewWhileLost"] is False
    assert res["restored"] is True, res["events"]
    assert res["drew"] is True
    assert res["pixels"]["lit"] > 50, res["pixels"]
