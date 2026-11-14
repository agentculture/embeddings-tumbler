"""Headless-browser check of the viewer API in a plain host page (task t8).

Serves the repository root on a loopback port and opens ``viewer_host.html`` in
headless Chromium driven by Playwright. The page runs under
``default-src 'self'; script-src 'self'; style-src 'self'`` (no inline script, no
inline style) and uses only the public API. Its script (``viewer_host_page.js``)
mounts the viewer, updates it with the built-in sample set, switches the three
modes with the mode buttons, appends 200 points while paused, shows labels and a
group name that contain markup, sends an invalid set and destroys the viewer.

The test asserts: zero CSP violations and zero console errors; no request to any
other origin and none for the markup's image; the viewer is laid out inside its
element (a wide desktop viewport and a 390 px phone viewport, with no horizontal
overflow); each mode draws lit pixels; the append keeps the frame and grows the
count; the markup is literal text; the invalid set shows a message and returns a
refusal; destroy empties the element and stops the loop.

Uses the shared harness (``tests/browser/harness.py``): one browser per session, SwiftShader
(software) unless ``TUMBLER_BROWSER_RENDERER=gpu``, the renderer in every test id. Skips when
Playwright, a matching Chromium build, or WebGL 2 is not available, and fails instead under
``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

PAGE = "/tests/browser/viewer_host.html"
VIEWPORTS = {"desktop": (1100, 900), "phone": (390, 844)}


@pytest.fixture(scope="module")
def loopback_server():
    with harness.Server(harness.ROOT) as server:
        yield server.origin


def _run(browser, base_url: str, viewport: tuple[int, int], query: str) -> dict:
    tab = harness.Tab(browser, viewport=viewport)
    try:
        tab.goto(base_url + PAGE + query)
        result = tab.wait_for(
            "() => window.__viewerResult",
            lambda r: bool(r and r.get("done")),
            timeout=90,
            what="the page to finish",
        )
    finally:
        tab.close()
    if result.get("unavailable") and "WebGL" in result["unavailable"]:
        harness.unavailable(f"WebGL 2 unavailable in headless Chromium: {result['unavailable']}")
    result["console_errors"] = tab.console_errors()
    result["requests"] = [r["url"] for r in tab.requests]
    result["foreign"] = [r["url"] for r in tab.foreign_requests(base_url)]
    return result


@pytest.fixture(scope="module", params=list(VIEWPORTS))
def run(request, browser, loopback_server):
    query = "?d=384&n=2000&hold=1500"
    return request.param, _run(browser, loopback_server, VIEWPORTS[request.param], query)


def test_no_csp_violation_console_error_or_foreign_request(run):
    _, r = run
    assert r["fatal"] is None, r["fatal"]
    assert r["violations"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []
    assert not any("evil-probe" in u for u in r["requests"]), "markup was parsed into an element"


def test_mount_stays_inside_the_element(run):
    s = run[1]["steps"]
    assert s["childrenAfterMount"] == 1
    assert s["headStyles"] == 0
    assert s["update"]["ok"] is True and s["update"]["count"] == 2000


def test_layout_holds_at_this_width(run):
    name, r = run
    lay = r["steps"]["layout"]
    el_w = lay["element"]["width"]
    assert lay["root"]["width"] == pytest.approx(el_w, abs=1)
    assert lay["stage"]["height"] == pytest.approx(360, abs=1), "--tumbler-stage-height honoured"
    assert lay["canvas"]["width"] == pytest.approx(lay["stage"]["width"], abs=1)
    assert lay["rootScrollWidth"] <= lay["rootClientWidth"] + 1, "no horizontal overflow"
    assert lay["bodyScrollWidth"] <= lay["viewportWidth"] + 1, f"page scrolls sideways ({name})"
    for part in ("controls", "modes", "provenance", "strip", "status"):
        box = lay[part]
        assert box["height"] > 0, part
        assert (
            box["left"] >= lay["root"]["left"] - 1 and box["right"] <= lay["root"]["right"] + 1
        ), part
    # The status line sits inside the stage, above its bottom edge.
    assert lay["status"]["bottom"] <= lay["stage"]["bottom"] + 1
    assert "radial-gradient" in lay["stageBackground"], "styles were applied under style-src 'self'"
    assert lay["blend"] == "screen"


def test_each_mode_draws_lit_frames(run):
    modes = run[1]["steps"]["modes"]
    for mode in ("tumble", "lattice", "wander"):
        assert modes[mode]["mode"] == mode
        assert modes[mode]["lit"] > 50, modes
    assert "variance" in modes["tumble"]["status"]
    assert "hidden direction" in modes["lattice"]["status"]


def test_provenance_is_shown(run):
    t = run[1]["steps"]["provenanceText"]
    for want in (
        "synthetic/reference-sample",
        "384",
        "2,000",
        "Seed (view)",
        "shadow of the space",
    ):
        assert want in t, want


def test_append_keeps_the_camera_and_adds_points(run):
    a = run[1]["steps"]["append"]
    assert a["result"]["ok"] is True and a["result"]["added"] == 200
    assert a["count"] == 2200
    assert a["frameChange"] == 0, "the frame moved on append"
    assert a["lit"] > 50


def test_markup_labels_are_literal_text(run):
    m = run[1]["steps"]["markup"]
    assert m["result"]["ok"] is True
    assert m["groupShownLiterally"] is True
    assert m["imgElements"] == 0 and m["bElements"] == 0


def test_invalid_data_shows_a_message(run):
    inv = run[1]["steps"]["invalid"]
    assert inv["result"]["ok"] is False and inv["result"]["code"] == "wrong-kind"
    assert inv["noticeVisible"] is True
    assert "embeddings-tumbler/data" in inv["noticeText"]


def test_destroy_empties_the_element_and_stops(run):
    s = run[1]["steps"]
    assert s["destroyed"] is True
    assert s["childrenAfterDestroy"] == 0
    assert s["animatingAfterDestroy"] is False
    assert s["destroyAgain"] is False
