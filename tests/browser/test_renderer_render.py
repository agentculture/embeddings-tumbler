"""Headless-browser check that the WebGL 2 renderer really draws (task t6).

Serves the repository root on a loopback port, opens ``renderer_render.html`` in
headless Chromium driven by Playwright, and asserts that a 384-d and a 1024-d
contract fixture each render to a frame with lit pixels, with no console error.

Uses the shared harness (``tests/browser/harness.py``, ``conftest.py``): one browser per
session, SwiftShader (software) unless ``TUMBLER_BROWSER_RENDERER=gpu``, the renderer in every
test id. Skips when Playwright, a matching Chromium build, or WebGL 2 is not available, and
fails instead under ``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

PAGE = "/tests/browser/renderer_render.html"


@pytest.fixture(scope="module")
def loopback_server():
    with harness.Server(harness.ROOT) as server:
        yield server.origin


def _render_in_browser(browser, base_url: str) -> dict:
    tab = harness.Tab(browser)
    try:
        tab.goto(base_url + PAGE)
        result = tab.wait_for(
            "() => window.__rendererResult || null",
            lambda r: r is not None,
            timeout=60,
            what="the page to report a result",
        )
    finally:
        tab.close()
    result["console_errors"] = tab.console_errors()
    result["foreign_requests"] = [r["url"] for r in tab.foreign_requests(base_url)]
    return result


@pytest.fixture(scope="module")
def render_result(browser, loopback_server):
    result = _render_in_browser(browser, loopback_server)
    if result.get("unavailable"):
        harness.unavailable(f"WebGL 2 unavailable in headless Chromium: {result['unavailable']}")
    return result


def test_page_ran_without_console_errors_or_foreign_requests(render_result):
    assert render_result["fatal"] is None, render_result["fatal"]
    assert render_result["console_errors"] == []
    assert render_result["foreign_requests"] == []


@pytest.mark.parametrize("case", ["d384", "d1024"])
def test_fixture_renders_non_blank_frame(render_result, case):
    res = render_result["cases"][case]
    assert res["made"]["ok"] is True, res
    assert res["set"] is True
    assert res["status"]["ok"] is True
    assert res["status"]["hdr"] is True, "SwiftShader offers float colour buffers"
    assert res["pixels"]["lit"] > 50, res["pixels"]
    assert res["pixels"]["max"] > 100, res["pixels"]


def test_dimension_reaches_the_renderer(render_result):
    assert render_result["cases"]["d384"]["status"]["dimension"] == 384
    assert render_result["cases"]["d1024"]["status"]["dimension"] == 1024
    assert render_result["cases"]["d1024"]["status"]["layout"]["texelsPerPoint"] == 256


def test_without_hdr_target_still_renders(render_result):
    res = render_result["cases"]["d1024_nohdr"]
    assert res["status"]["hdr"] is False
    assert res["pixels"]["lit"] > 50, res["pixels"]


def test_context_loss_is_survived_by_rebuilding(render_result):
    res = render_result["cases"]["restore"]
    if "skipped" in res:
        pytest.skip(res["skipped"])
    assert res["lost"] is True
    assert res["drewWhileLost"] is False
    assert res["restored"] is True, res["events"]
    assert res["drew"] is True
    assert res["pixels"]["lit"] > 50, res["pixels"]
