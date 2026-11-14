# Modes demo (development only)

A live page for judging the three modes (`js/src/40-mode-tumble.js`,
`41-mode-lattice.js`, `42-mode-wander.js`) by eye against the reference
(`docs/specs/reference/embedding-tumbler-demo.html`). It is not shipped in the
wheel or the npm package, and it is not the viewer API: task t8 owns
`mount`/`update`/`destroy`, labels, controls and the provenance block. This page
is the minimum glue: it generates the built-in sample set, validates it with
`ET.contract.validate`, hands it to `ET.renderer`, and drives one mode at a
time.

It loads the assembled core file and `embeddings_tumbler/static/sample-data.js`,
so run `python3 scripts/assemble.py` first if you changed anything under
`js/src/`.

## Run

From the repository root (port 8765 is taken on the development machine):

```bash
uv run embeddings-tumbler viewer serve . --port 8791
```

Then open `/js/dev/modes-demo/` on that port, for example
<http://127.0.0.1:8791/js/dev/modes-demo/>. If that port is in use too, pick
any free one with `--port`.

## Keys

`1` Tumble, `2` Lattice, `3` Wander. Space pauses the motion. Drag to turn the
cloud. Switching modes hands the last frame drawn to the next mode, so the view
continues from where it was.

## Query string

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `d` | dimension passed to the sample generator | the sample's (384) |
| `n` | point count passed to the sample generator | the sample's (12,288) |
| `seed` | the modes' seed | `1` |
| `mode` | the starting mode: `tumble`, `lattice` or `wander` | `tumble` |
| `check` | `1` keeps the drawing buffer and counts lit pixels once a second (used by `tests/browser/test_modes_render.py`) | off |

Examples:

- <http://127.0.0.1:8791/js/dev/modes-demo/?d=1024>
- <http://127.0.0.1:8791/js/dev/modes-demo/?seed=7&mode=wander>

The status line under the stage is the mode's own (`state.status`), inserted as
text. Frames per second are in the top-right corner. The page records what it
saw on `window.__modesDemo` (mode, frames and frames per second per mode,
preparation time per mode, the status line).
