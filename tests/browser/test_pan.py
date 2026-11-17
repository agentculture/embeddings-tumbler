"""Panning in the standalone page (task t17 of the relative-search build).

On the shipped Wikipedia pair, with the search Rice and Relative on and the view paused: a real
right-button drag of a known number of pixels on the stage moves the relative view's ruler and
every result by that many pixels (within 1.5), leaves the frame and the yaw as they were, and the
Reset view button puts everything back. The pan is the renderer's draw key ``pan``; what the GPU
draws under it is the CPU ``place`` that the hook reports, checked in the node tests.

The renderer is SwiftShader unless ``TUMBLER_BROWSER_RENDERER=gpu``; it is in every test id.
"""

from __future__ import annotations

import pytest

from tests.browser import harness
from tests.browser import relative_site as rs

DX, DY = 120, -45  # CSS pixels: right and up
MOVE_PX = 1.5

STATE = f"""() => {{
  const h = {rs.H}, v = h._viewer, d = v.relativeDrawn, k = d.dpr || 1;
  return {{
    time: h.time(),
    pan: h.pan(),
    zoom: h.zoom(),
    yaw: v.lastDraw.yaw,
    dragYaw: v.drag.yaw,
    frame: Array.from(v.last.frame.slice(0, 24)),
    ruler: [d.ruler.x0 / k, d.ruler.y0 / k, d.ruler.x1 / k, d.ruler.y1 / k],
    results: d.results.map((r) => [r.index, r.x / k, r.y / k, r.rulerY / k]),
    status: h.info().status,
    frames: h.info().frames,
  }};
}}"""

FRAMES = f"() => {rs.H}.info().frames"


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    folder = rs.build_folder(tmp_path_factory.mktemp("pan"))
    with harness.Server(folder) as srv:
        yield srv


@pytest.fixture(scope="module")
def panned(browser, webgl, server):
    tab = rs.open_page(browser, server.url("/index.html?seed=3&relative=1"))
    try:
        assert tab.evaluate(f"async () => (await {rs.H}.setSearches(['Rice'])).ok")
        rs.settled(tab, 1, "Rice relative")
        tab.evaluate(f"() => {rs.H}.pause()")
        out = {"before": _still(tab)}
        box = tab.evaluate(
            "() => { const r = document.querySelector('#space .tumbler-stage')"
            ".getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }"
        )
        x, y = box[0] + box[2] * 0.3, box[1] + box[3] * 0.6
        mouse = tab.page.mouse
        mouse.move(x, y)
        mouse.down(button="right")
        mouse.move(x + DX / 2, y + DY / 2, steps=4)
        mouse.move(x + DX, y + DY, steps=4)
        mouse.up(button="right")
        out["after"] = _still(tab)
        tab.page.click("#space .tumbler-zoom-reset")
        out["reset"] = _still(tab)
        out["errors"] = tab.console_errors()
    finally:
        tab.close()
    return out


def _still(tab: harness.Tab) -> dict:
    """The view's state once a few more frames have been drawn (paused, so it holds)."""
    n = tab.evaluate(FRAMES)
    tab.wait_for(f"(n) => {rs.H}.info().frames >= n + 3", arg=n, what="three more frames")
    tab.page.wait_for_timeout(300)
    return tab.evaluate(STATE)


def test_a_right_drag_moves_the_ruler_and_results_by_the_drag(panned):
    a, b = panned["before"], panned["after"]
    print(f"pan after a {DX} x {DY} px right-drag: {b['pan']}")
    assert a["pan"] == [0, 0]
    assert b["pan"][0] > 0, "right and up"
    assert b["pan"][1] > 0, "right and up"
    for i in (0, 2):
        assert abs(b["ruler"][i] - a["ruler"][i] - DX) <= MOVE_PX, (a["ruler"], b["ruler"])
        assert abs(b["ruler"][i + 1] - a["ruler"][i + 1] - DY) <= MOVE_PX, (a["ruler"], b["ruler"])
    assert [r[0] for r in b["results"]] == [r[0] for r in a["results"]]
    assert len(a["results"]) > 0
    for ra, rb in zip(a["results"], b["results"]):
        assert abs(rb[1] - ra[1] - DX) <= MOVE_PX, (ra, rb)
        assert abs(rb[2] - ra[2] - DY) <= MOVE_PX, (ra, rb)
        assert abs(rb[3] - rb[2]) <= 1.0, "the height on the ruler agrees with the drawn height"
    assert b["status"].endswith(" · moved · paused"), b["status"]


def test_the_drag_neither_turns_nor_moves_the_frame(panned):
    a, b = panned["before"], panned["after"]
    assert b["time"] == a["time"], "paused: the mode clock held"
    assert b["yaw"] == a["yaw"]
    assert b["dragYaw"] == a["dragYaw"]
    assert b["frame"] == a["frame"]
    assert b["zoom"] == a["zoom"] == 1


def test_reset_view_puts_everything_back(panned):
    a, c = panned["before"], panned["reset"]
    assert c["pan"] == [0, 0]
    for i in range(4):
        assert abs(c["ruler"][i] - a["ruler"][i]) <= 0.01
    for ra, rc in zip(a["results"], c["results"]):
        assert abs(rc[1] - ra[1]) <= 0.01
        assert abs(rc[2] - ra[2]) <= 0.01
    assert "moved" not in c["status"]
    assert panned["errors"] == []
