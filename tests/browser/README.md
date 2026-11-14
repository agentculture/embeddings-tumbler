# Browser test harness

Headless-browser tests for the viewer, on one shared foundation (task t14).
Everything here runs in Chromium driven by Playwright (a dev dependency pinned
to 1.65.x) against loopback servers the tests start themselves. Nothing ever
reaches a real external host: Chromium is launched with a host-resolver rule
under which no host name resolves (only `127.0.0.1` is left alone).

## Running it

```bash
uv sync
uv run playwright install chromium        # once; the build matching Playwright 1.65.x
uv run pytest tests/browser               # software rendering (SwiftShader), serial
uv run pytest tests/browser -n auto       # one browser per xdist worker
TUMBLER_BROWSER_RENDERER=gpu uv run pytest tests/browser   # the machine's real GPU
TUMBLER_REQUIRE_BROWSER=1 uv run pytest tests/browser      # a skip is a failure (CI)
```

| Variable | Values | Effect |
|----------|--------|--------|
| `TUMBLER_BROWSER_RENDERER` | `swiftshader` (default), `gpu` | Launch flags: SwiftShader (`--use-angle=swiftshader`), or ANGLE on Vulkan with the GPU blocklist ignored. The renderer is in every test id, for example `test_x[swiftshader]`, and `test_the_browser_runs_the_renderer_the_session_asked_for` checks that WebGL really answered with it (it fails if `gpu` fell back to software). |
| `TUMBLER_REQUIRE_BROWSER` | `1` | Every skip in `tests/browser` becomes a failure. Locally a missing Playwright, Chromium build or WebGL 2 skips; on a runner that is meant to run the suite it must not. `tests/test_browser_require.py` proves the switch works. |

CI: `.github/workflows/browser.yml` installs the pinned Chromium with
`uv run playwright install --with-deps chromium`, sets both variables
(`swiftshader`, `1`), runs the external-origin scan and then
`uv run pytest tests/browser`. Software rendering only: runners have no GPU.
The main Tests workflow also collects these files; there they skip (no
Chromium on that runner).

Under `pytest -n auto` each browser test module is one xdist group
(`--dist loadgroup` in `pyproject.toml`), so a module's shared page session
runs once rather than once per worker. Rendering on SwiftShader is CPU-bound,
so many workers compete for the same cores.

## The pieces

- `harness.py`: the foundation.
  - `Server(root, csp=None)`: a loopback static server, optionally sending a
    `Content-Security-Policy` header, counting every request in `hits`.
  - `launch(pw)`: the Chromium launch with the renderer flags.
  - `Tab(browser, viewport=..., reduced_motion=..., bypass_csp=...)`: a fresh
    context and page that records every request (`context.on("request")`
    covers documents, scripts, stylesheets, fetch/XHR, images, fonts, media,
    beacons, event sources, iframes and favicons if the browser asks for one;
    websockets and service-worker registrations are logged from their own
    events), every console message, every page error, and every
    `securitypolicyviolation` (reported to Python through a binding from the
    first script on, so it survives navigation and needs nothing from the
    page). Assertions: `assert_no_foreign_requests(origin)`,
    `assert_no_console_errors(allow=[regex, ...])`,
    `assert_no_csp_violations()`.
  - `wait_for(page, js, until=...)` and `wait_for_text(page, selector,
    expected)`: poll with `page.evaluate` until the condition holds, and fail
    with the last value seen. Do not use `page.wait_for_function` with a string:
    a strict policy (`script-src 'self'`) stops the page from compiling it.
    Do not wait for "any text": an element that already holds old text ends
    that wait at once.
  - `lit_pixels(png)`, `pixel_mask(png, test)`, `bbox(points)`: count bright
    or coloured pixels in a PNG screenshot (stdlib decoder). The measure is a
    screenshot of the canvas element, not `readPixels`: it is the composited
    picture the user sees, and it does not depend on `preserveDrawingBuffer`
    or on reading inside the right animation frame. With reduced motion
    emulated the viewer starts paused with no twinkle and goes idle after
    drawing, so two screenshots of the same view are byte-identical (the
    append test asserts this before it compares anything).
  - `build_host_site(folder)` and `write_twin_blobs(folder)`: the folder the
    canonical fixtures are served from (below) and the synthetic data set.
  - `leaks(baseline, now)`: the counters from `instrument.js` that moved.
- `conftest.py`: the session `browser` fixture (one launch per session or xdist
  worker), `webgl` (the renderer string; skips without WebGL 2), `host_site`,
  `site(csp)` (one server per policy over the host site), `foreign` (a second
  loopback server: "another origin"), `open_tab` (tabs closed after the test),
  and the hooks above.
- `fixtures/`: the canonical host pages, the negative controls, and two
  test-only scripts (`instrument.js`, `fixture-data.js`). None of them ships.

## The canonical host fixtures

All three are served from one folder built the way a host gets the files:
`embeddings-tumbler viewer write <folder> --apply` (the shipped set, flat), plus
the fixture pages, a few contract fixtures and `twin-blobs.json`/`.f32` (two
ungrouped blobs of 150 points at +3 and -3 along the first axis, 192
dimensions).

1. **Script form**, `fixtures/script-host.html` + `script-host.js`: a plain page
   that loads the core file and calls `mount`, fetches its data file and block,
   and calls `update`, exactly as `js/api/50-viewer.md` tells a host to. Served
   with no policy, so nothing in the browser would block a request to another
   origin. `?manual=1` mounts nothing (for the leak cycles).
2. **Web-component form**, `fixtures/component-host.html` +
   `component-host.js`: only the `<embeddings-tumbler src=...>` element; the
   script only watches. Served with the header `script-src 'self'` exactly, and
   again with `default-src 'self'`, and once with the policy switched off in the
   browser (`bypass_csp`) so a request the policy would block shows in the log.
3. **Standalone form**: the shipped `index.html` from that same folder, under
   its own `default-src 'self'` meta policy, with the built-in sample and with
   `?data=twin-blobs.json`, and with `?data=` and the policy switched off.

## What is proven, and where

| Criterion | Test file | Measure |
|-----------|-----------|---------|
| 1. No request to another origin, each form | `test_harness_forms.py` | the full request log of each run (all three modes clicked, except on the 12,288-point sample) holds only the test server's origin; the log is shown to be live (it holds the document, the core file and the data block) |
| 2. Web component under `script-src 'self'` with no violation | `test_harness_forms.py` | header asserted to be exactly `script-src 'self'`; zero violations; lit pixels on the canvas |
| 3. External-origin scan on every shipped file | `../test_check_no_external_origin.py` | `scripts/check_no_external_origin.py` over the wheel's static files, the `viewer write` folder and the source folder |
| 4. Twenty mounts and destroys leave nothing | `test_harness_lifecycle.py` | `instrument.js` counts, against the baseline taken before the first mount |
| 5. Append adds visible points without a reload | `test_harness_append.py` | navigation marker, navigation entries, document requests; count 300 to 340; new orange pixels only where the cluster went |

The older tests (`test_renderer_render.py`, `test_modes_render.py`,
`test_viewer_render.py`, `test_viewer_controls.py`, `test_web_component.py`,
`test_standalone_page.py`, `test_guide_examples.py`) use the same server,
browser, tab and wait helpers, with their own host pages in this folder.

## Leak counting (`fixtures/instrument.js`)

Loaded with a plain `<script src>` before the core file, so the page's policy
allows it and it is in place before the viewer exists. It wraps
`requestAnimationFrame`/`cancelAnimationFrame`, `setTimeout`/`setInterval`,
`IntersectionObserver`, `ResizeObserver`, `MutationObserver`, `getContext` and
`addEventListener`/`removeEventListener` on `window` and `document`, and
`window.__harness.snapshot()` returns the live counts: canvases in the
document, WebGL contexts not lost, pending animation callbacks, pending
timeouts, live intervals, observers observing something, global listeners.
"Zero" means equal to the baseline taken on a `?manual=1` page after the core
has loaded and before the first mount.

## Negative controls

`test_harness_negative_controls.py` loads deliberately bad pages and asserts
that each harness check **fails** on them:

- `bad-foreign.html?kind=...`: one request of each kind (image, script,
  stylesheet, fetch, XHR, beacon, websocket, web font, iframe, event source) to
  the `foreign` server; the log catches it and that server's own counter
  confirms it arrived. Also a request to a name that does not resolve.
- `bad-inline.html` under `script-src 'self'`, and `bad-foreign.html` under
  `default-src 'self'`: the violation assertion fails.
- `bad-console.html`: the console assertion fails, and `allow=` lets through
  only what it names.
- `bad-leak.html`: every leak counter moves.
- A mounted viewer with no data: the lit-pixel count is near zero.
- A reload (in `test_harness_append.py`): the no-reload checks see it.

## Adding a test

1. Put the host page and its script under `fixtures/` (they are copied into
   the host site; a name may not clash with a shipped file) or, for a page that
   needs repository paths, serve `harness.ROOT` with `harness.Server`.
2. Take `open_tab`, `site` and `webgl` (if it needs rendering) as fixtures.
   Open `tab = open_tab()`, `tab.goto(site().url("my-page.html"))`.
3. Wait with `tab.wait_for(js, until=...)`, never with a fixed sleep alone.
4. End with `tab.assert_no_foreign_requests(...)`,
   `tab.assert_no_console_errors()` and `tab.assert_no_csp_violations()`.
5. Skip only through `harness.unavailable(reason)`, and only for a missing
   browser stack. If the test exposes a defect in shipped code, mark it
   `xfail(strict=True)` with the reason and report it; do not change the
   shipped code to make it pass.

## Known defect, marked as an expected failure

- **D1**, `test_tumble_finishes_preparing_under_reduced_motion_without_input`:
  with `prefers-reduced-motion: reduce` the viewer goes idle before Tumble has
  finished fitting its directions, so the status stays at "finding the
  strongest directions ... N% · paused" until input, a resize, a theme change
  or new data wakes it. The append test works around it with the public
  `handle.refreshTheme()`.

## Not covered

- Chromium only: no Firefox, no WebKit. The pages have been run by hand on an
  iPhone 13 in Safari and Chrome and on a small ARM board in Chrome; none of
  that is automated.
- No real touch input (Playwright's mouse and keyboard only).
- No real GPU in CI: CI renders on SwiftShader. The `gpu` mode is for local
  runs and has been checked on one machine (AMD Radeon 760M, RADV).
- The network log sees what Chromium reports. Service-worker fetches are
  reported only as far as Playwright's context events report them; the viewer
  registers none.
- The external-origin scan does not run JavaScript: a URL assembled at run
  time passes it. The network log is the runtime check.
