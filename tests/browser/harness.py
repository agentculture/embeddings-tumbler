"""The shared browser test harness (task t14). See ``tests/browser/README.md``.

One foundation for every test under ``tests/browser/``:

* :class:`Server`: a loopback static server (``ThreadingHTTPServer`` on ``127.0.0.1``, a free
  port) that can send a ``Content-Security-Policy`` header and counts every request it gets.
* :func:`launch`: one Chromium launch with the renderer stated explicitly (SwiftShader by
  default, a real GPU with ``TUMBLER_BROWSER_RENDERER=gpu``). ``conftest.py`` calls it once per
  test session (once per xdist worker).
* :class:`Tab`: a fresh browser context and page that records **every** request (documents,
  scripts, stylesheets, fetch/XHR, images, fonts, media, beacons, websockets, service workers,
  favicons if the browser asks for one), every console message, every page error and every
  ``securitypolicyviolation``, and asserts on them.
* :func:`wait_for` / :func:`wait_for_text`: poll a condition from Python with ``evaluate``
  (never ``wait_for_function``'s string form, which a strict CSP blocks), and fail with the
  last value seen instead of returning the first truthy one.
* :func:`lit_pixels` and friends: decode a PNG screenshot of an element (stdlib only) and count
  bright pixels, optionally inside a box or by colour.
* :func:`unavailable`: the one way a browser test skips. ``conftest.py`` turns every skip in
  ``tests/browser`` into a failure when ``TUMBLER_REQUIRE_BROWSER=1`` (set in CI).

Why screenshots for "the canvas shows something": ``element.screenshot()`` captures the
composited picture the user sees (the WebGL canvas blended over the sky), so it does not depend
on ``preserveDrawingBuffer``, on reading pixels inside the right animation frame, or on frame
ordering. With reduced motion emulated the viewer starts paused with no twinkle and goes idle
after drawing, so the picture is a fixed function of the data, the seed and the viewport, and
two screenshots taken a few hundred milliseconds apart are identical.
"""

from __future__ import annotations

import functools
import http.server
import json
import os
import random
import re
import shutil
import struct
import threading
import time
import zlib
from pathlib import Path
from typing import Any, Callable, Iterable

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
CONTRACT = ROOT / "tests" / "fixtures" / "contract"

RENDERER_ENV = "TUMBLER_BROWSER_RENDERER"
REQUIRE_ENV = "TUMBLER_REQUIRE_BROWSER"

# Launch arguments per renderer. ``swiftshader`` is Chromium's software GPU, so the result does
# not depend on the machine and runs on CI runners without one. ``gpu`` asks ANGLE for Vulkan,
# which reached the real GPU (AMD Radeon 760M, RADV) on the machine this was written on; other
# machines may need other flags. test_the_browser_runs_the_renderer_the_session_asked_for checks
# which renderer really answered.
RENDERER_ARGS = {
    "swiftshader": ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    "gpu": ["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"],
}
# No host name resolves, so no test can ever reach a real external host, even by mistake. IP
# literal 127.0.0.1 (the test servers) is excluded. A request to a name is still logged
# (Playwright reports it before it fails), so the network log assertions still see it.
COMMON_ARGS = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"]

WAIT_TIMEOUT_S = 30.0


# --------------------------------------------------------------------------- skipping


def require_browser() -> bool:
    """True when a browser skip must be a failure (``TUMBLER_REQUIRE_BROWSER=1``)."""
    return os.environ.get(REQUIRE_ENV, "").strip() not in ("", "0", "false", "no")


def unavailable(reason: str):
    """Skip because the browser stack is missing. ``conftest.py`` fails it under REQUIRE_ENV."""
    pytest.skip(f"browser unavailable: {reason}")


def renderer() -> str:
    name = os.environ.get(RENDERER_ENV, "swiftshader").strip().lower() or "swiftshader"
    if name not in RENDERER_ARGS:
        raise pytest.UsageError(
            f"{RENDERER_ENV}={name!r} is not one of {', '.join(sorted(RENDERER_ARGS))}"
        )
    return name


# --------------------------------------------------------------------------- server


class _Handler(http.server.SimpleHTTPRequestHandler):
    csp: str | None = None
    hits: list[str]
    extra_types = {".f32": "application/octet-stream", ".mjs": "text/javascript"}

    def end_headers(self):
        if self.csp:
            self.send_header("Content-Security-Policy", self.csp)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):
        suffix = Path(str(path)).suffix
        return self.extra_types.get(suffix) or super().guess_type(path)

    def _record(self):
        type(self).hits.append(f"{self.command} {self.path}")

    def do_GET(self):
        self._record()
        super().do_GET()

    def do_HEAD(self):
        self._record()
        super().do_HEAD()

    def do_POST(self):  # beacons and the like: count them, answer 204
        self._record()
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):  # noqa: A002 - signature fixed by the base class
        pass


class Server:
    """A loopback static server over ``root``. ``hits`` lists ``"GET /path"`` per request."""

    def __init__(self, root: Path, csp: str | None = None):
        self.root = Path(root)
        self.csp = csp
        handler_cls = type("Handler", (_Handler,), {"csp": csp, "hits": []})
        self._handler_cls = handler_cls
        handler = functools.partial(handler_cls, directory=str(self.root))
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self.origin = f"http://127.0.0.1:{self._server.server_address[1]}"

    @property
    def hits(self) -> list[str]:
        return self._handler_cls.hits

    def url(self, path: str = "/") -> str:
        return self.origin + (path if path.startswith("/") else "/" + path)

    def close(self):
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# --------------------------------------------------------------------------- browser


def launch(pw, which: str | None = None):
    """Launch Chromium for ``which`` renderer, or skip (see :func:`unavailable`)."""
    which = which or renderer()
    exe = Path(pw.chromium.executable_path)
    if not exe.exists():
        unavailable(
            f"no Chromium build for this Playwright version at {exe}; "
            "run `uv run playwright install chromium`"
        )
    try:
        return pw.chromium.launch(args=RENDERER_ARGS[which] + COMMON_ARGS)
    except Exception as exc:  # any launch failure means no usable browser here
        unavailable(f"Chromium could not be launched: {exc}")


WEBGL_RENDERER = """() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return null;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const lose = gl.getExtension('WEBGL_lose_context');
  if (lose) lose.loseContext();
  return name;
}"""

# Reports every CSP violation to Python through a binding, from the first script on, in every
# frame, before the page's own scripts. Bindings and init scripts are injected by the DevTools
# protocol, so the page's own policy does not apply to them (it does apply to everything the
# page itself does).
_CSP_RECORDER = """
document.addEventListener('securitypolicyviolation', function (e) {
  try {
    window.__harnessCsp({ directive: e.violatedDirective, effective: e.effectiveDirective,
      blocked: e.blockedURI || '', sample: e.sample || '', source: e.sourceFile || '',
      line: e.lineNumber || 0, disposition: e.disposition });
  } catch (err) { /* binding gone while the page unloads */ }
}, true);
"""

HIDE_TEXT = """() => {
  for (const sel of ['.tumbler-masthead', '.tumbler-status', '.tumbler-labels',
                     '.tumbler-notice', '.tumbler-message', '.tumbler-empty',
                     '.tumbler-overlay']) {
    for (const n of document.querySelectorAll(sel)) n.style.visibility = 'hidden';
  }
}"""


class Tab:
    """A fresh context and page that records everything the page does on the network and in
    the console. Close it with :meth:`close` (the ``open_tab`` fixture does)."""

    def __init__(
        self,
        browser,
        *,
        viewport: tuple[int, int] = (1100, 900),
        reduced_motion: str | None = None,
        bypass_csp: bool = False,
    ):
        options: dict[str, Any] = {
            "viewport": {"width": viewport[0], "height": viewport[1]},
            "bypass_csp": bypass_csp,
        }
        if reduced_motion:
            options["reduced_motion"] = reduced_motion
        self.context = browser.new_context(**options)
        self.requests: list[dict] = []
        self.console: list[dict] = []
        self.page_errors: list[str] = []
        self.csp: list[dict] = []
        self.main_navigations: list[str] = []
        self.context.expose_binding("__harnessCsp", lambda _src, v: self.csp.append(v))
        self.context.add_init_script(_CSP_RECORDER)
        self.context.on("request", self._on_request)
        self.context.on("serviceworker", self._on_service_worker)
        self.page = self.context.new_page()
        self.page.on("websocket", lambda ws: self._log(ws.url, "websocket", "GET", False))
        self.page.on("console", self._on_console)
        self.page.on("pageerror", lambda exc: self.page_errors.append(str(exc)))
        self.page.on("framenavigated", self._on_navigated)

    # -- recording
    def _log(self, url, kind, method, navigation):
        self.requests.append({"url": url, "type": kind, "method": method, "navigation": navigation})

    def _on_request(self, req):
        try:
            navigation = req.is_navigation_request()
        except Exception:  # a request from a worker has no frame
            navigation = False
        self._log(req.url, req.resource_type, req.method, navigation)

    def _on_service_worker(self, worker):
        self._log(worker.url, "service-worker", "GET", False)

    def _on_console(self, msg):
        self.console.append({"type": msg.type, "text": msg.text})

    def _on_navigated(self, frame):
        if frame == self.page.main_frame:
            self.main_navigations.append(frame.url)

    # -- driving
    def goto(self, url: str):
        self.page.goto(url)
        return self

    def evaluate(self, js: str, arg: Any = None):
        return self.page.evaluate(js, arg)

    def wait_for(self, js: str, until: Callable[[Any], bool] = bool, **kw):
        return wait_for(self.page, js, until, **kw)

    def wait_for_text(self, selector: str, expected: str, **kw) -> str:
        return wait_for_text(self.page, selector, expected, **kw)

    def png(self, selector: str, hide_text: bool = True) -> bytes:
        """A screenshot of the element (the composited picture), viewer text hidden."""
        if hide_text:
            self.page.evaluate(HIDE_TEXT)
        return self.page.locator(selector).first.screenshot()

    def webgl_available(self) -> bool:
        return bool(self.page.evaluate(WEBGL_RENDERER))

    def close(self):
        try:
            self.context.close()
        except Exception:  # already closed with the browser
            pass

    # -- reading
    def foreign_requests(self, origin: str) -> list[dict]:
        """Every logged request whose URL is not on ``origin`` (``about:``/``data:``/``blob:``
        URLs are not network requests to anyone and are not counted)."""
        out = []
        for r in self.requests:
            url = r["url"]
            if url.startswith(("about:", "data:", "blob:")):
                continue
            if url == origin or url.startswith(origin + "/"):
                continue
            out.append(r)
        return out

    def console_errors(self, allow: Iterable[str] = ()) -> list[str]:
        patterns = [re.compile(p) for p in allow]
        errors = [m["text"] for m in self.console if m["type"] == "error"]
        errors += [f"pageerror: {e}" for e in self.page_errors]
        return [e for e in errors if not any(p.search(e) for p in patterns)]

    def document_requests(self) -> list[dict]:
        return [r for r in self.requests if r["type"] == "document"]

    # -- asserting
    def assert_no_foreign_requests(self, origin: str):
        bad = self.foreign_requests(origin)
        assert not bad, f"{len(bad)} request(s) to an origin other than {origin}: {bad}"

    def assert_no_console_errors(self, allow: Iterable[str] = ()):
        bad = self.console_errors(allow)
        assert not bad, f"console errors or page errors: {bad}"

    def assert_no_csp_violations(self):
        assert not self.csp, f"Content-Security-Policy violations: {self.csp}"


# --------------------------------------------------------------------------- waiting


def wait_for(
    page,
    js: str,
    until: Callable[[Any], bool] = bool,
    *,
    arg: Any = None,
    timeout: float = WAIT_TIMEOUT_S,
    interval: float = 0.1,
    what: str | None = None,
):
    """Poll ``page.evaluate(js, arg)`` until ``until(value)`` holds and return that value.

    Fails (``AssertionError``) after ``timeout`` seconds with the last value seen. Never use
    ``page.wait_for_function`` with a string: under ``script-src 'self'`` the page may not
    compile strings, and that wait would hang or throw. ``evaluate`` runs through the DevTools
    protocol, which the page's policy does not cover.
    """
    deadline = time.monotonic() + timeout
    value = page.evaluate(js, arg)
    while not until(value):
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"timed out after {timeout:.0f}s waiting for {what or js!r}; last value {value!r}"
            )
        page.wait_for_timeout(interval * 1000)
        value = page.evaluate(js, arg)
    return value


TEXT_OF = "(s) => { const n = document.querySelector(s); return n ? n.textContent || '' : null; }"


def wait_for_text(page, selector: str, expected: str, **kw) -> str:
    """Wait until ``selector``'s text **contains** ``expected``; return the whole text.

    Waiting for "some text" is not enough: an element that already holds older text would end
    the wait at once (the bug in an earlier helper that failed 4 runs in 6).
    """
    kw.setdefault("what", f"{selector} to contain {expected!r}")
    return wait_for(page, TEXT_OF, lambda t: t is not None and expected in t, arg=selector, **kw)


# --------------------------------------------------------------------------- pixels


def decode_png(png: bytes) -> tuple[int, int, list[bytes]]:
    """Decode an 8-bit RGB or RGBA non-interlaced PNG (what Playwright writes) into
    ``(width, height, rows)`` where each row is ``bytes`` of R, G, B triples. Stdlib only."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, width, height, channels = 8, b"", 0, 0, 0
    while pos < len(png):
        length, kind = struct.unpack(">I4s", png[pos : pos + 8])
        chunk = png[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
            assert depth == 8, (depth, colour, interlace)
            assert interlace == 0, (depth, colour, interlace)
            assert colour in (2, 6), (depth, colour, interlace)
            channels = 3 if colour == 2 else 4
        elif kind == b"IDAT":
            idat += chunk
        pos += 12 + length
    raw = zlib.decompress(idat)
    stride = width * channels
    prev = bytearray(stride)
    rows: list[bytes] = []
    for y in range(height):
        base = y * (stride + 1)
        ftype, line = raw[base], bytearray(raw[base + 1 : base + 1 + stride])
        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif ftype == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + (a + prev[i]) // 2) & 255
        elif ftype == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 255
        prev = line
        if channels == 4:
            rgb = bytearray(width * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = line[0::4], line[1::4], line[2::4]
            rows.append(bytes(rgb))
        else:
            rows.append(bytes(line))
    return width, height, rows


def pixel_mask(
    png: bytes, test: Callable[[int, int, int], bool]
) -> tuple[int, int, set[tuple[int, int]]]:
    """``(width, height, {(x, y) where test(r, g, b)})``."""
    width, height, rows = decode_png(png)
    hits = set()
    for y, row in enumerate(rows):
        for x in range(width):
            i = 3 * x
            if test(row[i], row[i + 1], row[i + 2]):
                hits.add((x, y))
    return width, height, hits


def bright(threshold: int = 150) -> Callable[[int, int, int], bool]:
    """Sum of R, G, B above ``threshold``. The viewer's night sky peaks at 79 (``#0b1430``)."""
    return lambda r, g, b: r + g + b > threshold


def lit_pixels(png: bytes, threshold: int = 150) -> int:
    return len(pixel_mask(png, bright(threshold))[2])


def bbox(points: set[tuple[int, int]]) -> tuple[int, int, int, int] | None:
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


# --------------------------------------------------------------------------- leaks


LEAK_KEYS = (
    "canvases",
    "glLive",
    "rafPending",
    "timeouts",
    "intervals",
    "intersectionObservers",
    "resizeObservers",
    "mutationObservers",
    "globalListeners",
)


def leaks(baseline: dict, now: dict) -> dict:
    """The live counters of ``instrument.js`` that differ from the baseline: ``{key: (b, n)}``."""
    return {k: (baseline[k], now[k]) for k in LEAK_KEYS if now[k] != baseline[k]}


# --------------------------------------------------------------------------- the host site

TWIN_BLOBS_DIMENSION = 192
TWIN_BLOBS_PER_BLOB = 150


def write_twin_blobs(folder: Path, dimension: int = TWIN_BLOBS_DIMENSION) -> dict:
    """Write ``twin-blobs.json`` and ``twin-blobs.f32``: two ungrouped blobs of
    ``TWIN_BLOBS_PER_BLOB`` points at +3 and -3 along the first axis (spread 0.35 in the first
    six dimensions, 0.02 in the rest). Their mean, the origin, is empty space between them in
    every linear view, which is where ``fixture-data.js`` puts the appended arrivals."""
    rnd = random.Random(14)
    rows = []
    points = []
    for blob, centre in enumerate((3.0, -3.0)):
        for i in range(TWIN_BLOBS_PER_BLOB):
            row = [rnd.gauss(0.0, 0.35 if j < 6 else 0.02) for j in range(dimension)]
            row[0] += centre
            rows.append(row)
            points.append({"id": f"b{blob}-{i:03d}", "label": ""})
    block = struct.pack(f"<{len(rows) * dimension}f", *[x for r in rows for x in r])
    meta = {
        "schema_version": 1,
        "kind": "embeddings-tumbler/data",
        "model": "synthetic/harness-twin-blobs",
        "dimension": dimension,
        "count": len(rows),
        "text_included": False,
        "provenance": {
            "source": "synthetic: browser harness twin blobs (tests/browser/harness.py)",
            "producer": "tests/browser/harness.py",
            "created": "2026-11-14T00:00:00Z",
            "synthetic": True,
            "seed": 14,
            "limitations": ["two planted blobs; not model output"],
            "uncertain": [],
        },
        "vectors": {
            "file": "twin-blobs.f32",
            "dtype": "float32",
            "byte_order": "little",
            "byte_length": len(block),
        },
        "points": points,
    }
    (folder / "twin-blobs.f32").write_bytes(block)
    (folder / "twin-blobs.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


CONTRACT_FILES = (
    "valid-384.json",
    "valid-384.f32",
    "valid-1024.json",
    "valid-1024.f32",
    "bumped-version.json",
)


def build_host_site(folder: Path) -> Path:
    """The folder every canonical fixture is served from, built the way a host gets the files:
    ``embeddings-tumbler viewer write <folder> --apply`` (the shipped set, flat), then the
    harness's fixture pages and test-only scripts, a few contract fixtures and the twin blobs."""
    from embeddings_tumbler.cli import main

    folder.mkdir(parents=True, exist_ok=True)
    assert main(["viewer", "write", str(folder), "--apply"]) == 0, "viewer write failed"
    shipped = sorted(p.name for p in folder.iterdir())
    for src in sorted(FIXTURES.iterdir()):
        if src.is_file():
            assert src.name not in shipped, f"fixture {src.name} would shadow a shipped file"
            shutil.copy(src, folder / src.name)
    for name in CONTRACT_FILES:
        shutil.copy(CONTRACT / name, folder / name)
    write_twin_blobs(folder)
    return folder
