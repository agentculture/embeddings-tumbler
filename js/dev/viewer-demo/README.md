# Viewer demo (development only)

A plain host page for trying the viewer API (`js/src/50-viewer.js`) by hand on a
phone, a small board or a desktop. It is not shipped in the wheel or the npm
package. It mounts **two independent viewers side by side** using only the
public script API (`mount`, `update`, `destroy`, and the handle's `info()` and
`refreshTheme()`), under a `default-src 'self'; script-src 'self'; style-src 'self'`
policy with no inline script or style. The header counts Content-Security-Policy
violations (it should stay at 0).

It loads the assembled core file and `embeddings_tumbler/static/sample-data.js`,
so run `python3 scripts/assemble.py` first if you changed anything under
`js/src/`.

## Run

From the repository root:

```bash
uv run embeddings-tumbler viewer serve . --port 8791
```

Then open `/js/dev/viewer-demo/` on that port, for example
<http://127.0.0.1:8791/js/dev/viewer-demo/>. Use `--port 0` to let the system
pick a free port (the command prints it).

## Buttons (one row per viewer)

| Button | Does |
|--------|------|
| mount | `EmbeddingsTumbler.mount(el, ...)` (a second mount on a mounted element returns the same handle) |
| update: send the sample set | a full replace with the built-in sample set. A freshly mounted viewer holds no data and says so ("No data yet") until this is pressed |
| append 200 points | `update` with `op: "append"`: the camera stays, the count grows |
| send invalid data | a set with schema version 2: a message inside the viewer, the view keeps running |
| send a label with markup | a replace whose first label and the `ocean` group name contain markup; both must show as text |
| theme | cycles dark (the defaults), teal, and three light treatments ("light: dark stage panel", "light: coloured ink", "light: soft ink", set with `--tumbler-light-style`) by changing `--tumbler-*` custom properties on the host element, then calls `refreshTheme()` |
| destroy | `EmbeddingsTumbler.destroy(el)`: the element is emptied and the loop stops |

Under each viewer a box shows `info()`: mode, elapsed time, seed, user zoom,
frames per second, frame count, time to first frame and to the first ready
frame, the longest frame, the longest gap between animation frames in the
last 5 s (measured by the page), the last Tumble refit (when, how much work,
its longest step), and the time each `update()` call took.

## Query string

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `d` | dimension passed to the sample generator | `384` |
| `n` | point count of the set (the generator makes 2,000 more for appends) | `12288` |
| `seed` | the viewers' seed | `1` |
| `mode` | starting mode: `tumble`, `lattice` or `wander` | `tumble` |
| `one` | `1` mounts only the left viewer (for measuring) | off |
| `theme` | start with this theme: `teal`, `panel`, `ink` or `soft` | dark |

Examples:

- <http://127.0.0.1:8791/js/dev/viewer-demo/?d=1024>
- <http://127.0.0.1:8791/js/dev/viewer-demo/?d=1024&n=10000&one=1>
- <http://127.0.0.1:8791/js/dev/viewer-demo/?n=2000&mode=wander>

## Things to try

- Drag to turn (touch too). Pinch on a phone, or hold Ctrl and use the wheel,
  to zoom; double-click or double-tap resets. A plain wheel scrolls the page
  unless the viewer has focus (click it first).
- With a viewer focused, keys `1`, `2`, `3` switch views, space pauses,
  `+`/`-`/`0` zoom. Keys are never taken while the focus is elsewhere.
- Scroll a viewer off screen, or switch tabs: its `info()` shows
  `(suspended)` and its frame count stops.
- Turn on reduced motion in the operating system and reload: the viewers start
  paused with a Play button.
