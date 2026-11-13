# Renderer demo (development only)

A live page for judging `ET.renderer` (`js/src/30-renderer.js`) by eye against
the reference (`docs/specs/reference/embedding-tumbler-demo.html`): points,
glow, bloom, depth of field, trails, twinkle and wires. It is not shipped in
the wheel or the npm package.

It loads the assembled core file, so run `python3 scripts/assemble.py` first
if you changed anything under `js/src/`.

## Run

From the repository root:

```bash
python3 -m http.server --bind 127.0.0.1 8765
```

Then open <http://127.0.0.1:8765/js/dev/renderer-demo/>.

## Query string

| Parameter | Meaning | Default |
|-----------|---------|---------|
| `d` | dimension of the synthetic set | `1024` |
| `n` | number of synthetic points | `5000` |
| `seed` | seed of the synthetic set | `20261113` |
| `fixture` | load a contract fixture instead, e.g. `valid-384` or `valid-1024` | none |
| `wires` | `1` starts with wires shown | off |
| `hdr` | `0` forces the no-HDR fallback | on |
| `bench` | `1` also times each draw with a GPU sync, shown as ms/frame | off |

Examples:

- <http://127.0.0.1:8765/js/dev/renderer-demo/?d=384&n=12288>
- <http://127.0.0.1:8765/js/dev/renderer-demo/?d=1024&n=10000&bench=1>
- <http://127.0.0.1:8765/js/dev/renderer-demo/?fixture=valid-1024>

## Keys

Drag to turn. Space pauses, `w` toggles wires, `t` trails, `f` fog by true
distance, `d` depth of field, `c` clears the trails.

The frame turns slowly inside six fixed directions (the first six cluster
centres). That is a stand-in for the tour, which is another module's job, so
judge the drawing here, not the motion.
