"""Real-input check of the viewer's controls in headless Chromium (task t8 fixes).

The live test found that the notice's Dismiss button did nothing with a real mouse:
the stage's drag handler captured the pointer for presses that started on a control
inside it, so the button never got its click. A synthetic ``element.click()`` hides
that, so this test drives **real** input through Playwright's mouse and keyboard
(move, press, release; Tab focus, Enter, Space, Escape) on ``viewer_host.html`` in
its manual mode, under ``script-src 'self'; style-src 'self'``.

Rendering runs on **SwiftShader** (``--use-angle=swiftshader``). The test skips,
never fails, when Playwright, a matching Chromium build, or WebGL 2 is missing.
"""

from __future__ import annotations

import functools
import http.server
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PAGE = "/tests/browser/viewer_host.html?manual=1&n=1500"
SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]

NOTICE_SHOWN = (
    "() => getComputedStyle(document.querySelector('.tumbler-notice')).display !== 'none'"
)
SEND_INVALID = "() => EmbeddingsTumbler.update(document.getElementById('space'), {kind: 'x'}).code"


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
def results(loopback_server):
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
            page = browser.new_page(viewport={"width": 1000, "height": 900})
            errors: list[str] = []
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
            page.goto(loopback_server + PAGE)
            for _ in range(300):
                r = page.evaluate("() => window.__viewerResult")
                if r and r.get("done"):
                    break
                page.wait_for_timeout(100)
            if r.get("unavailable") and "WebGL" in r["unavailable"]:
                pytest.skip(f"WebGL 2 unavailable: {r['unavailable']}")
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
                page.evaluate("() => document.querySelector('.tumbler-provenance').open")
                != prov_open
            )
            slider = page.locator(".tumbler-speed input").bounding_box()
            page.mouse.click(slider["x"] + slider["width"] - 3, slider["y"] + slider["height"] / 2)
            out["speed_after_slider"] = page.evaluate(info)["speed"]
            out["errors"] = errors
        finally:
            browser.close()
    return out


def test_dismiss_works_with_a_real_mouse_swiftshader(results):
    assert results["invalid_code"] == "wrong-kind"
    assert results["notice_before"] is True
    assert results["notice_after_click"] is False


def test_a_drag_from_a_control_does_not_turn_the_camera_swiftshader(results):
    assert results["yaw_change_from_control"] == 0
    assert results["yaw_change_from_sky"] > 0.1


def test_escape_dismisses_while_focused_swiftshader(results):
    assert results["notice_before_escape"] is True
    assert results["notice_after_escape"] is False


def test_mode_button_and_pause_work_with_a_real_mouse_swiftshader(results):
    assert results["mode_after_click"] == "lattice"
    assert results["paused_after_click"] is True
    assert results["play_label"] == "Play"


def test_keyboard_enter_and_space_work_on_controls_swiftshader(results):
    assert results["mode_after_enter"] == "wander"
    assert results["paused_after_space"] is False


def test_checkbox_summary_and_slider_work_with_a_real_mouse_swiftshader(results):
    assert results["labels_checked"] is False
    assert results["provenance_toggled"] is True
    assert results["speed_after_slider"] > 2.5
    assert results["errors"] == []
