"""Headless-browser check that the three modes drive the renderer (task t7).

Serves the repository root on a loopback port and opens the development modes demo
(``js/dev/modes-demo/``) in headless Chromium driven by Playwright, on a reduced
sample set (2,000 points). It switches through Tumble, Lattice and Wander with the
keys 1, 2 and 3 and asserts that each mode drew frames with lit pixels, that the
status line came from the mode, and that nothing logged a console error or asked
another origin for anything.

Uses the shared harness (``tests/browser/harness.py``): one browser per session, SwiftShader
(software) unless ``TUMBLER_BROWSER_RENDERER=gpu``, the renderer in every test id. Skips when
Playwright, a matching Chromium build, or WebGL 2 is not available, and fails instead under
``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

PAGE = "/js/dev/modes-demo/?n=2000&seed=3&check=1"
MODES = [("1", "tumble"), ("2", "lattice"), ("3", "wander")]


@pytest.fixture(scope="module")
def loopback_server():
    with harness.Server(harness.ROOT) as server:
        yield server.origin


def _run(browser, base_url: str) -> dict:
    tab = harness.Tab(browser, viewport=(480, 320))
    page = tab.page
    try:
        tab.goto(base_url + PAGE)
        tab.wait_for(
            "() => { const d = window.__modesDemo; return d && (d.ready || d.error); }",
            what="the modes demo to start",
        )
        demo = page.evaluate("() => window.__modesDemo")
        if demo.get("error") and "WebGL" in demo["error"]:
            harness.unavailable(f"WebGL 2 unavailable in headless Chromium: {demo['error']}")
        statuses = {}
        for key, mode in MODES:
            page.keyboard.press(key)
            tab.wait_for(
                "(m) => { const d = window.__modesDemo; return d.mode === m && "
                "(d.litByMode[m] || 0) > 0 && d.prepMs[m] !== undefined; }",
                arg=mode,
                what=f"{mode} to draw a lit frame",
            )
            page.wait_for_timeout(1200)
            statuses[mode] = page.evaluate("() => window.__modesDemo.status")
        demo = page.evaluate("() => window.__modesDemo")
    finally:
        tab.close()
    demo["console_errors"] = tab.console_errors()
    demo["foreign_requests"] = [r["url"] for r in tab.foreign_requests(base_url)]
    demo["statuses"] = statuses
    return demo


@pytest.fixture(scope="module")
def demo_result(browser, loopback_server):
    return _run(browser, loopback_server)


def test_modes_demo_ran_without_errors_or_foreign_requests(demo_result):
    assert demo_result["error"] is None, demo_result["error"]
    assert demo_result["console_errors"] == []
    assert demo_result["foreign_requests"] == []


@pytest.mark.parametrize("mode", [m for _, m in MODES])
def test_each_mode_draws_lit_frames(demo_result, mode):
    assert demo_result["framesByMode"][mode] > 5
    assert demo_result["litByMode"][mode] > 50, demo_result["litByMode"]


def test_status_lines_come_from_the_modes(demo_result):
    s = demo_result["statuses"]
    assert "strongest directions" in s["tumble"] and "variance" in s["tumble"]
    assert "trading for a hidden direction" in s["lattice"]
    assert s["wander"].startswith('"') or s["wander"].startswith("at ") or "heading" in s["wander"]
