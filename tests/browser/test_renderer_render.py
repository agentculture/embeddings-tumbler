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


# --------------------------------------------------------------------------- search (t4)
# The per-point lit value and the shared mark (docs/search-interface.md, "Renderer (t4)").
# The page draws a 5 x 5 grid whose screen positions are known; see searchCases in
# renderer_render_page.js. Grid points 11 and 13, and 16 and 18, are mirror images.


@pytest.fixture(scope="module")
def search(render_result) -> dict:
    assert render_result["fatal"] is None, render_result["fatal"]
    return render_result["search"]


@pytest.fixture(scope="module")
def stage_pngs(browser, loopback_server) -> dict:
    """Screenshots of the two stages (the composited picture a viewer shows), by name."""
    tab = harness.Tab(browser)
    try:
        tab.goto(loopback_server + PAGE)
        result = tab.wait_for(
            "() => window.__rendererResult || null",
            lambda r: r is not None,
            timeout=60,
            what="the page to report a result",
        )
        if result.get("unavailable"):
            harness.unavailable(
                f"WebGL 2 unavailable in headless Chromium: {result['unavailable']}"
            )
        assert result["fatal"] is None, result["fatal"]
        pngs = {n: tab.png("#stage-" + n, hide_text=False) for n in ("dark", "light")}
        pngs["positions"] = result["search"]["stages"]
        return pngs
    finally:
        tab.close()


def _window(png: bytes, at: dict, half: int = 2) -> tuple[float, float, float]:
    """Mean R, G, B over a (2 * half + 1)^2 window centred on ``at`` (CSS pixels, y down)."""
    _, _, rows = harness.decode_png(png)
    acc = [0, 0, 0]
    n = 0
    for y in range(at["y"] - half, at["y"] + half + 1):
        for x in range(at["x"] - half, at["x"] + half + 1):
            for c in range(3):
                acc[c] += rows[y][3 * x + c]
            n += 1
    return acc[0] / n, acc[1] / n, acc[2] / n


@pytest.mark.parametrize("case", ["identity", "identityNoHdr"])
def test_no_search_frame_is_byte_identical(search, case):
    """Lit values set but filter 0 (with trails, twinkle and unlitGain changed), then cleared:
    every frame equals, byte for byte, a renderer's that never had lit values."""
    res = search[case]
    assert res["lit"] > 500, res
    assert res["hdr"] is (case == "identity")
    assert res["diffs"] == [-1, -1, -1, -1], res


@pytest.mark.parametrize("case", ["dim", "dimNoHdr"])
def test_a_dimmed_set_has_fewer_lit_pixels_and_higher_lit_is_brighter(search, case):
    res = search[case]
    assert res["set"] == {"ok": True, "uploaded": True}
    assert res["status"]["lit"] is True
    assert res["status"]["hdr"] is (case == "dim")
    assert res["dimmedLit"] < 0.8 * res["plainLit"], res
    # mirror images with the same lit value read the same: the comparison below is fair
    left, right = res["controlLeft"], res["controlRight"]
    assert abs(left - right) < 0.02 * max(left, right), res
    assert res["high"] > 1.5 * res["low"], res
    assert res["low"] > 2 * res["unlit"], res


@pytest.mark.parametrize("case", ["appendThenLit", "litThenAppend"])
def test_lit_values_follow_the_points_through_appends(search, case):
    res = search[case]
    assert all(step["ok"] for step in res["log"]), res["log"]
    reallocated = [step.get("reallocated") for step in res["log"] if "reallocated" in step]
    assert False in reallocated and True in reallocated, "both append paths are taken"
    bright = {"appendThenLit": {"17"}, "litThenAppend": {"7", "10"}}[case]
    sums = res["sums"]
    assert len(sums) == res["count"]
    dimmest_bright = min(sums[k] for k in bright)
    brightest_other = max(v for k, v in sums.items() if k not in bright)
    assert dimmest_bright > 10 * brightest_other, sums


def test_the_shared_mark_is_visible_on_the_dark_stage(stage_pngs):
    at = stage_pngs["positions"]["dark"]
    assert at["lit"] is True
    plain = _window(stage_pngs["dark"], at["plain"])
    marked = _window(stage_pngs["dark"], at["marked"])
    # both results are bright; the marked one burns toward white (its weakest channel rises)
    assert min(plain) < 225, (plain, marked)
    assert min(marked) > min(plain) + 25, (plain, marked)
    assert max(marked) - min(marked) < max(plain) - min(plain), (plain, marked)


def test_the_shared_mark_is_visible_on_the_light_stage(stage_pngs):
    at = stage_pngs["positions"]["light"]
    assert at["lit"] is True
    plain = _window(stage_pngs["light"], at["plain"])
    marked = _window(stage_pngs["light"], at["marked"])
    # the result is coloured ink; the marked one comes back as darker, more neutral ink
    assert max(plain) - min(plain) > 40, (plain, marked)
    assert sum(marked) < sum(plain) - 60, (plain, marked)
    assert max(marked) - min(marked) < max(plain) - min(plain) - 20, (plain, marked)


def test_dispose_frees_the_lit_buffer_and_restore_brings_it_back(search):
    leak = search["leak"]
    assert leak["peak"] > leak["afterData"], "the lit program, buffer and vertex array were made"
    assert leak["afterDispose"] == 0, leak
    res = search["restore"]
    if "skipped" in res:
        pytest.skip(res["skipped"])
    assert res["restored"] is True
    assert res["drew"] is True
    assert res["lit"] is True
    assert res["litPixels"] > 200, res
    assert res["diff"] == -1, "the dimmed picture after restore equals the one before"
