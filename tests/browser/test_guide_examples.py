"""Headless-browser check of the example pages in the host guide (docs/guides/examples/).

For each example folder: copy it, run ``embeddings-tumbler viewer write <copy> --apply`` (the
step the guide tells a reader to take), serve the copy on loopback with the response header
``Content-Security-Policy: default-src 'self'`` and load the page in headless Chromium on
SwiftShader. Every form must draw a non-blank picture with zero console errors, zero CSP
violations and zero requests to another origin.

The web-component form needs ``web-component.js`` and the standalone form needs ``index.html``,
``page.css`` and ``page.js`` among the shipped files. While a shipped file is absent the test for
that form is skipped with a reason, and it runs as soon as the file is shipped.

Uses the shared harness (``tests/browser/harness.py``): one browser per session, SwiftShader
(software) unless ``TUMBLER_BROWSER_RENDERER=gpu``, the renderer in every test id. Skips when
Playwright, a matching Chromium build or WebGL 2 is not available, and fails instead under
``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.browser import harness

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "docs" / "guides" / "examples"
STATIC = ROOT / "embeddings_tumbler" / "static"
POLICY = "default-src 'self'"

NEEDS = {
    "script": ["embeddings-tumbler.js"],
    "web-component": ["embeddings-tumbler.js", "web-component.js"],
    "standalone": ["embeddings-tumbler.js", "index.html", "page.css", "page.js"],
}

# Violations are recorded by the harness (a binding, from the first script on); this init
# script only keeps the drawing buffer so the pixels can be read back.
INIT = """
const orig = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (type, opts) {
  if (type === "webgl2") opts = Object.assign({}, opts, { preserveDrawingBuffer: true });
  return orig.call(this, type, opts);
};
"""

LIT = """() => {
  const c = document.querySelector(".tumbler-canvas");
  const gl = c && c.getContext("webgl2");
  if (!gl) return -1;
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 40 || px[i + 1] > 40 || px[i + 2] > 40) n++;
  return n;
}"""


@pytest.fixture
def example_site(request, tmp_path):
    form = request.param
    missing = [n for n in NEEDS[form] if not (STATIC / n).is_file()]
    if missing:
        pytest.skip(f"the {form} form needs shipped file(s) not present yet: {', '.join(missing)}")
    folder = tmp_path / form
    shutil.copytree(EXAMPLES / form, folder)
    done = subprocess.run(
        [sys.executable, "-m", "embeddings_tumbler", "viewer", "write", str(folder), "--apply",
         "--force"],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 0, done.stderr
    with harness.Server(folder, csp=POLICY) as server:
        yield form, server.origin


@pytest.fixture
def opened(example_site, browser):
    form, base = example_site
    tab = harness.Tab(browser, viewport=(1100, 900))
    tab.context.add_init_script(INIT)
    try:
        yield form, base, tab.page, tab
    finally:
        tab.close()


def _wait(page, probe, ms=30000):
    """Poll a JS function until it returns something truthy (harness.wait_for)."""
    return harness.wait_for(page, probe, timeout=ms / 1000)


def _wait_text(page, selector, needle, ms=30000):
    """Wait until the element's text contains ``needle``; return the text (harness)."""
    return harness.wait_for_text(page, selector, needle, timeout=ms / 1000)


def _text(page, selector):
    return f"() => (document.querySelector('{selector}') || {{}}).textContent || ''"


def _lit(page) -> int:
    return harness.wait_for(page, LIT, lambda n: n > 50, timeout=20, what="lit pixels")


def _skip_without_webgl(page):
    if page.evaluate("() => !document.createElement('canvas').getContext('webgl2')"):
        harness.unavailable("WebGL 2 unavailable in headless Chromium")


def _clean(base, tab):
    assert tab.console_errors() == []
    assert tab.csp == []
    assert tab.foreign_requests(base) == []


def _open(page, base, path):
    page.goto(base + path)
    _skip_without_webgl(page)


@pytest.mark.parametrize("example_site", ["script"], indirect=True)
def test_script_form_page_draws_appends_and_destroys(opened):
    form, base, page, tab = opened
    _open(page, base, "/example.html")
    assert "Showing 320 points." in _wait_text(
        page, "#note", "Showing 320 points."
    ), "never showed the data"
    assert _lit(page) > 50, "the picture is blank"
    page.click("#add")
    assert "Showing 321 points." in _wait_text(
        page, "#note", "Showing 321 points."
    ), "append did not land"
    page.click("#toggle")
    assert page.evaluate("() => document.getElementById('space').children.length") == 0
    assert "removed" in page.evaluate(_text(page, "#note"))
    page.click("#toggle")
    assert "Showing 320 points." in _wait_text(
        page, "#note", "Showing 320 points."
    ), "remount failed"
    assert _lit(page) > 50
    _clean(base, tab)


@pytest.mark.parametrize("example_site", ["web-component"], indirect=True)
def test_web_component_form_page_draws_appends_and_releases(opened):
    form, base, page, tab = opened
    _open(page, base, "/example.html")
    assert "Showing 320 points." in _wait_text(
        page, "#note", "Showing 320 points."
    ), "never showed the data"
    assert _lit(page) > 50, "the picture is blank"
    page.click("#add")
    assert "Showing 321 points." in _wait_text(
        page, "#note", "Showing 321 points."
    ), "append did not land"
    # Removing the element releases the viewer (the guide says so).
    released = page.evaluate("""() => { const el = document.getElementById('space'); el.remove();
                   return new Promise((ok) => setTimeout(
                     () => ok(window.EmbeddingsTumbler.get(el) === null), 200)); }""")
    assert released is True
    _clean(base, tab)


@pytest.mark.parametrize("example_site", ["standalone"], indirect=True)
def test_standalone_form_page_shows_the_named_file(opened):
    form, base, page, tab = opened
    _open(page, base, "/index.html?data=space.json")
    probe = "() => (document.querySelector('.tumbler') || {innerText: ''}).innerText"
    text = _wait(page, "() => { const t = " + probe[6:] + "; return t.includes('320') && t; }")
    assert "synthetic/cold-test" in text
    assert "320" in text
    assert _lit(page) > 50, "the picture is blank"
    _clean(base, tab)
    # A data address on another origin is refused and never requested.
    other = "http://127.0.0.1:9/elsewhere.json"
    page.goto(base + "/index.html?data=" + other)
    page.wait_for_timeout(1500)
    assert not any(r["url"].startswith("http://127.0.0.1:9") for r in tab.requests)
