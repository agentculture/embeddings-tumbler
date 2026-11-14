"""Real-input check of the viewer's controls in headless Chromium (task t8 fixes).

The live test found that the notice's Dismiss button did nothing with a real mouse:
the stage's drag handler captured the pointer for presses that started on a control
inside it, so the button never got its click. A synthetic ``element.click()`` hides
that, so this test drives **real** input through Playwright's mouse and keyboard
(move, press, release; Tab focus, Enter, Space, Escape) on ``viewer_host.html`` in
its manual mode, under ``script-src 'self'; style-src 'self'``.

Uses the shared harness (``tests/browser/harness.py``): one browser per session, SwiftShader
(software) unless ``TUMBLER_BROWSER_RENDERER=gpu``, the renderer in every test id. Skips when
Playwright, a matching Chromium build, or WebGL 2 is missing, and fails instead under
``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

PAGE = "/tests/browser/viewer_host.html?manual=1&n=1500"

NOTICE_SHOWN = (
    "() => getComputedStyle(document.querySelector('.tumbler-notice')).display !== 'none'"
)
SEND_INVALID = "() => EmbeddingsTumbler.update(document.getElementById('space'), {kind: 'x'}).code"


@pytest.fixture(scope="module")
def loopback_server():
    with harness.Server(harness.ROOT) as server:
        yield server.origin


def _press(page, selector):
    """A real mouse press and release at the centre of the element."""
    box = page.locator(selector).bounding_box()
    assert box, selector
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.up()
    return x, y


@pytest.fixture(scope="module")
def results(browser, loopback_server):
    out: dict = {}
    tab = harness.Tab(browser, viewport=(1000, 900))
    page = tab.page
    try:
        tab.goto(loopback_server + PAGE)
        r = tab.wait_for(
            "() => window.__viewerResult",
            lambda v: bool(v and v.get("done")),
            what="the page to finish",
        )
        if r.get("unavailable") and "WebGL" in r["unavailable"]:
            harness.unavailable(f"WebGL 2 unavailable: {r['unavailable']}")
        info = "() => window.__viewerHandle.info()"
        yaw = "() => window.__viewerHandle._viewer.drag.yaw"

        # 1. Dismiss with a real mouse.
        out["invalid_code"] = page.evaluate(SEND_INVALID)
        out["notice_before"] = page.evaluate(NOTICE_SHOWN)
        _press(page, ".tumbler-notice-dismiss")
        page.wait_for_timeout(200)
        out["notice_after_click"] = page.evaluate(NOTICE_SHOWN)

        # 2. A drag that starts on the Dismiss button does not turn the camera.
        page.evaluate(SEND_INVALID)
        box = page.locator(".tumbler-notice-dismiss").bounding_box()
        y0 = page.evaluate(yaw)
        page.mouse.move(box["x"] + 5, box["y"] + 5)
        page.mouse.down()
        page.mouse.move(box["x"] - 200, box["y"] + 60, steps=8)
        page.mouse.up()
        out["yaw_change_from_control"] = page.evaluate(yaw) - y0

        # 3. A drag on the sky does turn it.
        stage = page.locator(".tumbler-canvas").bounding_box()
        cx, cy = stage["x"] + stage["width"] / 2, stage["y"] + stage["height"] * 0.7
        y0 = page.evaluate(yaw)
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 120, cy, steps=8)
        page.mouse.up()
        out["yaw_change_from_sky"] = page.evaluate(yaw) - y0

        # 4. Escape dismisses while the viewer has focus (the sky press focused it).
        out["notice_before_escape"] = page.evaluate(NOTICE_SHOWN)
        page.keyboard.press("Escape")
        page.wait_for_timeout(100)
        out["notice_after_escape"] = page.evaluate(NOTICE_SHOWN)

        # 5. A mode button and Pause with a real mouse.
        _press(page, '[data-mode="lattice"]')
        page.wait_for_timeout(100)
        out["mode_after_click"] = page.evaluate(info)["mode"]
        _press(page, ".tumbler-play")
        page.wait_for_timeout(100)
        out["paused_after_click"] = page.evaluate(info)["paused"]
        out["play_label"] = page.locator(".tumbler-play").text_content()

        # 6. Keyboard: Enter on a focused mode button, Space on the focused Pause.
        page.locator('[data-mode="wander"]').focus()
        page.keyboard.press("Enter")
        out["mode_after_enter"] = page.evaluate(info)["mode"]
        page.locator(".tumbler-play").focus()
        page.keyboard.press("Space")
        out["paused_after_space"] = page.evaluate(info)["paused"]

        # 7. Checkboxes, the slider and the provenance summary with a real mouse.
        _press(page, ".tumbler-labels-toggle input")
        out["labels_checked"] = page.locator(".tumbler-labels-toggle input").is_checked()
        prov_open = page.evaluate("() => document.querySelector('.tumbler-provenance').open")
        _press(page, ".tumbler-provenance-summary")
        out["provenance_toggled"] = (
            page.evaluate("() => document.querySelector('.tumbler-provenance').open") != prov_open
        )
        slider = page.locator(".tumbler-speed input").bounding_box()
        page.mouse.click(slider["x"] + slider["width"] - 3, slider["y"] + slider["height"] / 2)
        out["speed_after_slider"] = page.evaluate(info)["speed"]
        out["errors"] = tab.console_errors()
    finally:
        tab.close()
    return out


def test_dismiss_works_with_a_real_mouse(results):
    assert results["invalid_code"] == "wrong-kind"
    assert results["notice_before"] is True
    assert results["notice_after_click"] is False


def test_a_drag_from_a_control_does_not_turn_the_camera(results):
    assert results["yaw_change_from_control"] == 0
    assert results["yaw_change_from_sky"] > 0.1


def test_escape_dismisses_while_focused(results):
    assert results["notice_before_escape"] is True
    assert results["notice_after_escape"] is False


def test_mode_button_and_pause_work_with_a_real_mouse(results):
    assert results["mode_after_click"] == "lattice"
    assert results["paused_after_click"] is True
    assert results["play_label"] == "Play"


def test_keyboard_enter_and_space_work_on_controls(results):
    assert results["mode_after_enter"] == "wander"
    assert results["paused_after_space"] is False


def test_checkbox_summary_and_slider_work_with_a_real_mouse(results):
    assert results["labels_checked"] is False
    assert results["provenance_toggled"] is True
    assert results["speed_after_slider"] > 2.5
    assert results["errors"] == []
