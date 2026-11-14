"""Headless-browser check of the example pages in the host guide (docs/guides/examples/).

For each example folder: copy it, run ``embeddings-tumbler viewer write <copy> --apply`` (the
step the guide tells a reader to take), serve the copy on loopback with the response header
``Content-Security-Policy: default-src 'self'`` and load the page in headless Chromium on
SwiftShader. Every form must draw a non-blank picture with zero console errors, zero CSP
violations and zero requests to another origin.

The web-component form needs ``web-component.js`` and the standalone form needs ``index.html``,
``page.css`` and ``page.js`` among the shipped files. While a shipped file is absent the test for
that form is skipped with a reason, and it runs as soon as the file is shipped.

Skips, never fails, when Playwright, a matching Chromium build or WebGL 2 is not available.
"""

from __future__ import annotations

import functools
import http.server
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "docs" / "guides" / "examples"
STATIC = ROOT / "embeddings_tumbler" / "static"
SWIFTSHADER_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
POLICY = "default-src 'self'"

NEEDS = {
    "script": ["embeddings-tumbler.js"],
    "web-component": ["embeddings-tumbler.js", "web-component.js"],
    "standalone": ["embeddings-tumbler.js", "index.html", "page.css", "page.js"],
}

INIT = """
window.__violations = [];
document.addEventListener("securitypolicyviolation", (e) =>
  window.__violations.push(e.violatedDirective + " " + (e.blockedURI || "")));
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


class _PolicyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Content-Security-Policy", POLICY)
        super().end_headers()

    def log_message(self, format, *args):  # noqa: A002 - signature fixed by the base class
        pass


def _serve(folder: Path):
    handler = functools.partial(_PolicyHandler, directory=str(folder))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@pytest.fixture(params=["script", "web-component", "standalone"])
def site(request, tmp_path):
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
    server = _serve(folder)
    try:
        yield form, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


def _browser():
    sync_api = pytest.importorskip(
        "playwright.sync_api", reason="Playwright is not installed; run `uv sync`"
    )
    pw = sync_api.sync_playwright().start()
    exe = Path(pw.chromium.executable_path)
    if not exe.exists():
        pw.stop()
        pytest.skip(f"no Chromium build for this Playwright version at {exe}")
    try:
        browser = pw.chromium.launch(args=SWIFTSHADER_ARGS)
    except Exception as exc:  # any launch failure means no usable browser here
        pw.stop()
        pytest.skip(f"Chromium could not be launched: {exc}")
    return pw, browser


@pytest.fixture
def opened(site):
    form, base = site
    pw, browser = _browser()
    page = browser.new_page(viewport={"width": 1100, "height": 900})
    errors: list[str] = []
    requests: list[str] = []
    page.add_init_script(INIT)
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    page.on("request", lambda req: requests.append(req.url))
    try:
        yield form, base, page, errors, requests
    finally:
        browser.close()
        pw.stop()


def _wait(page, probe, ms=30000):
    """Poll a JS function (the page's CSP forbids wait_for_function's string form)."""
    for _ in range(ms // 100):
        value = page.evaluate(probe)
        if value:
            return value
        page.wait_for_timeout(100)
    return page.evaluate(probe)


def _wait_text(page, selector, needle, ms=30000):
    """Poll until the element's text contains ``needle``; return the last text seen.

    ``_wait`` returns the first truthy value, so it cannot wait for a note that
    already holds older text to change.
    """
    probe = _text(page, selector)
    text = page.evaluate(probe)
    for _ in range(ms // 100):
        if needle in text:
            break
        page.wait_for_timeout(100)
        text = page.evaluate(probe)
    return text


def _text(page, selector):
    return f"() => (document.querySelector('{selector}') || {{}}).textContent || ''"


def _lit(page) -> int:
    n = _wait(page, LIT.replace("return n;", "return n > 50 ? n : 0;"), 20000)
    return n


def _skip_without_webgl(page):
    if page.evaluate("() => !document.createElement('canvas').getContext('webgl2')"):
        pytest.skip("WebGL 2 unavailable in headless Chromium")


def _clean(base, errors, requests, page):
    assert errors == []
    assert page.evaluate("() => window.__violations") == []
    assert [u for u in requests if not u.startswith(base)] == []


def _open(page, base, path):
    page.goto(base + path)
    _skip_without_webgl(page)


def test_script_form_page_draws_appends_and_destroys_swiftshader(opened):
    form, base, page, errors, requests = opened
    if form != "script":
        pytest.skip("not this form")
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
    _clean(base, errors, requests, page)


def test_web_component_form_page_draws_appends_and_releases_swiftshader(opened):
    form, base, page, errors, requests = opened
    if form != "web-component":
        pytest.skip("not this form")
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
    _clean(base, errors, requests, page)


def test_standalone_form_page_shows_the_named_file_swiftshader(opened):
    form, base, page, errors, requests = opened
    if form != "standalone":
        pytest.skip("not this form")
    _open(page, base, "/index.html?data=space.json")
    probe = "() => (document.querySelector('.tumbler') || {innerText: ''}).innerText"
    text = _wait(page, "() => { const t = " + probe[6:] + "; return t.includes('320') && t; }")
    assert "synthetic/cold-test" in text and "320" in text
    assert _lit(page) > 50, "the picture is blank"
    _clean(base, errors, requests, page)
    # A data address on another origin is refused and never requested.
    other = "http://127.0.0.1:9/elsewhere.json"
    page.goto(base + "/index.html?data=" + other)
    page.wait_for_timeout(1500)
    assert not any(u.startswith("http://127.0.0.1:9") for u in requests)
