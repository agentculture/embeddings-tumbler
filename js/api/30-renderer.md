# `ET.renderer` — WebGL 2 drawing (`js/src/30-renderer.js`)

The renderer draws one embedding set on one canvas: glowing points, true-neighbour
wires, an HDR half-float target with a mip-chain bloom, depth of field, trails and
twinkle, ported from the reference page. It **draws only**: it computes no tour,
no neighbours and no data validation, reads no CSS, and touches no DOM beyond the
canvas it is given (it sets `canvas.width` / `canvas.height` in `resize`, and
listens for context loss on it).

All arrays are typed arrays. `D` is the dimension, `N` the number of points.

## Static functions

### `ET.renderer.create(canvas, options) -> result`

Makes a WebGL 2 context on `canvas` and builds the base GPU objects. **Never
throws.**

- Success: `{ ok: true, renderer }`.
- Failure: `{ ok: false, reason, message }`, with `reason` one of
  - `"webgl2-unavailable"`: no canvas, no `getContext`, `getContext` threw, or
    it returned `null` (no WebGL 2). Show `message` to the user.
  - `"shader-failed"`: a shader did not compile or link. `message` has the log.
    Anything created before the failure has already been deleted.
  - `"gpu-failed"`: another GL call threw while building. Also cleaned up.

`options` (all optional):

| Option | Meaning | Default |
|--------|---------|---------|
| `onContextChange(event)` | called with `{ type, message }`, `type` one of `"lost"`, `"restored"`, `"restore-failed"` | none |
| `hdr` | `false` forces the no-HDR fallback | `true` (used when float colour buffers exist) |
| `alpha` | context `alpha` attribute | `false` |
| `preserveDrawingBuffer` | context attribute (tests reading pixels later) | `false` |
| `powerPreference` | context attribute | `"high-performance"` |
| `releaseContext` | `true`: `dispose()` also calls `WEBGL_lose_context.loseContext()` so the browser frees the context at once (browsers cap live contexts). The canvas cannot make a new WebGL context afterwards, so set it only when the canvas is thrown away. | `false` |

### `ET.renderer.layout(dimension, count, maxTextureSize) -> layout`

Pure. How `count` points of `dimension` sit in one RGBA32F texture: four
dimensions per texel, `ceil(D / 4)` texels per point, `pointsPerRow` points per
texture row (rows are kept at most 4096 texels wide and widened up to
`maxTextureSize` only when the point count needs it).

Returns `{ ok: true, dimension, texelsPerPoint, floatsPerPoint, pointsPerRow,
width, maxTextureSize, maxPoints, rows(points) }` or `{ ok: false, reason,
message }` with `reason` `"bad-dimension"`, `"dimension-too-large"`
(`ceil(D / 4) > maxTextureSize`) or `"too-many-points"` (`count > maxPoints`).

### `ET.renderer.shaderSources(layout) -> { pointVertex, pointVertexLit, pointFragment, lineVertex, lineVertexLit, lineFragment, quadVertex, fadeFragment, toneFragment }`

Pure. The GLSL ES 3.00 sources. `pointVertexLit` is the point shader that also
reads the per-point lit value (see `renderer.setLit` below);
`pointVertex` is the one drawn without search, unchanged by it. The projection loop bound (`const int TEXELS`),
the row packing (`const int PER_ROW`) and the wire-brightness scale
(`sqrt(D / 3)`) are generated from the layout. Exposed for tests.

### `ET.renderer.wireDensity(src, view) -> number`

How tightly the wires pile up on screen: the wire light per pixel where the
wires' light lands, before any gain. `src`: `{ vectors, stride, dimension,
pairs, lengths, count }` (vectors at `stride` floats per point, as the renderer
stores them; `count` wires); `view`: a draw state with `frame` (and `centre`,
`zoom`, `yaw`, `pitch`, `radius`, `focus`, `wireDepthOfField`) plus `width` and
`height` in pixels. An even sample of at most 192 wires is projected (`O(192 *
D)`); each wire's brightness as the wire shader computes it (`0.03 + 0.2 t^3`,
over its depth of field) times its length on screen is spread along it over a
grid of 64 cells across the stage's shorter side; the light-weighted mean of the
cells' light per pixel is returned, scaled from the sample to every wire. It
grows with the number of wires and with how tightly the frame packs them; 0 with
no wires or none on the stage. Used by `draw` when `wireLoad` is above 0.
Corrected after the owner's browser look (2026-11-14).

### `ET.renderer.place(p, state, width, height) -> { x, y, scale, depth }`

Pure JavaScript copy of the shader's screen mapping, for drawing labels and
hit-testing on top of the canvas. `p` is `[a, b, c]`, a point's coordinates along
the three frame rows after subtracting the centre (the same numbers the vertex
shader computes). `state` uses `zoom`, `yaw`, `pitch`, `radius`, `focus` (defaults
as below). Returns canvas pixels with `y` growing downward, the perspective
`scale`, and `depth` relative to the focus plane.

### `ET.renderer.DEFAULTS`

The frozen default draw state (the reference's values). See the table under
`draw`.

## A renderer

### `renderer.setData({ vectors, dimension, colours?, weights?, count? }) -> result`

Replaces all points and clears the wires.

- `vectors`: `Float32Array(N * D)`, row-major (point `i` is
  `vectors[i*D .. i*D+D)`). The renderer **copies** it into its own zero-padded
  store (needed for appends and for rebuilding after a context loss), so the
  caller may reuse its array. Memory: about `N * ceil(D/4) * 16` bytes on the CPU
  and the same on the GPU.
- `dimension`: `D`, a positive integer. Nothing else is assumed.
- `colours`: optional `Float32Array(N * 3)`, linear RGB 0..1 per point (default
  white). The caller maps groups to colours (from host CSS custom properties or
  defaults); the renderer has no palette.
- `weights`: optional `Float32Array(N)`, 0..1 per point (default 1). Weight sets
  size and brightness (`0.55 + 1.5 w` size, `0.16 + 0.84 w^2` brightness, as in the
  reference); points with weight below 0.99 are scaled by `state.dim`.
- `count`: optional check that it equals `vectors.length / D`.

Returns `{ ok: true, layout, uploaded }`, or `{ ok: false, reason, message }`
from `layout` (too many points for this GPU), `"shader-failed"` (a shader did
not compile or link) or `"gpu-failed"` (another GL call threw while
uploading). On either failure the CPU copy already holds the new data, every
GPU object is freed, `draw` returns `false` and `status().ok` is `false` until
`rebuild()` succeeds. `uploaded` is `false` when only the CPU copy changed
because the context is lost or an earlier build failed; see
[Data while the GPU is unavailable](#data-while-the-gpu-is-unavailable). Shape errors (wrong array
type or length) throw `TypeError`: they are programming errors, not data refusals
(the contract loader refuses bad data before it gets here).

### `renderer.appendData({ vectors, colours?, weights?, dimension?, count? }) -> { ok, reallocated, uploaded }`

Adds points after the existing ones (indices continue from the current count).
Wires are kept. Throws `TypeError` before any `setData` or on a dimension that
differs. `uploaded` is as for `setData`; a GL failure during the upload returns
`{ ok: false, reason: "gpu-failed" | "shader-failed", message }` with the same
consequences as a failed `setData`.

**Cost.** Capacity starts at the `setData` count and doubles when exceeded. When
the new points fit, the cost is a copy of the new vectors into the store, one
`texSubImage2D` of only the texture rows the new points touch, and one
`bufferSubData` of their colours: `O(k * D)` for `k` new points
(`reallocated: false`). When they do not fit, the store is reallocated at double
size and the whole point texture and colour buffer are re-uploaded:
`O((N + k) * D)` (`reallocated: true`); amortised over doubling this is still
`O(D)` per appended point. Shaders are rebuilt only if the row packing has to
widen (past `maxPoints` at the default width). The renderer never re-centres:
the caller decides what centre to pass to `draw`.

### `renderer.setWires(pairs, lengths?) -> { ok, uploaded }`

- `pairs`: `Uint32Array` (or `Int32Array`) of point indices, two per wire. Every
  index must be `< count` (else `RangeError`). The renderer never computes
  neighbours.
- `lengths`: optional `Float32Array`, one true full-dimension distance per wire.
  When absent they are measured from the stored vectors (`O(wires * D)`).

Returns `{ ok: true, uploaded }` (`uploaded` as for `setData`), or
`{ ok: false, reason, message }` on a GL failure (as for `setData`) or after
`dispose` (`"disposed"`). (Before this change it returned nothing.)

A wire is coloured by its endpoints' colours. Its brightness rises when its
projected length nears its true length (the reference's `0.03 + 0.2 t^3`, with
`t = projected / true * sqrt(D / 3)`).

### `renderer.setLit(lit, shared?) -> { ok, uploaded }`

The per-point lit value and shared mark of search (`docs/search-interface.md`,
"Renderer (t4)"). The renderer computes nothing about searches: it draws the
values it is given.

- `lit`: `Float32Array(N)`, one value per point, read as clamped to `[0, 1]`
  (`NaN` reads as 0). `null` clears the lit values: no search, and drawing is
  exactly as before search existed.
- `shared`: optional `Uint8Array(N)`, non-zero where the shared mark is drawn.
  `null` or absent: no point is marked.
- Throws `TypeError` before any `setData`, when `lit` is not a `Float32Array`
  or `shared` not a `Uint8Array`, or when a length differs from the current
  count.
- Returns `{ ok: true, uploaded }` (`uploaded: false` while the context is lost
  or after a failed build, as for `setData`), `{ ok: false, reason, message }`
  on a GL failure (`"gpu-failed"`, or `"shader-failed"` if the lit program does
  not compile; consequences as for `setData`), or `reason: "disposed"` after
  `dispose`.

**Storage and cost.** The renderer keeps a CPU copy, one float per point of
capacity: the lit value plus 2 where marked (the shader decodes it with
`step(1.5, v)`). The first call after `setData` (or after a reallocating append)
compiles the lit point program once and makes the lit buffer with one
`bufferData` of the capacity (`4 * capacity` bytes). Every later call is one
`bufferSubData` of `4 * N` bytes into that buffer, even with unchanged arrays.
**The point vectors and colours are never re-uploaded.** `setLit(null)` frees
the lit buffer and its vertex array (the lit program is kept until a relayout or
`dispose`).

**With other calls.** `setData` clears the lit values (a replace starts with no
search). `appendData` keeps them and gives every appended point lit value 0 and
no mark: in place, one more `bufferSubData` of `4 * k` bytes at offset
`4 * first`; when it reallocates, the lit buffer is made again at the new
capacity with the old values. `setWires` does not touch them. A context restore
and `rebuild()` re-upload the CPU copy; `dispose()` deletes the buffer, its
vertex array and the lit program, and drops the CPU copy. `status().lit` is true
while lit values are set.

**Drawing.** The draw keys `filter` and `unlitGain` (table under `draw`) decide
how the values apply. When lit values are set and `filter > 0`, the points are
drawn by the lit program, with `filter` clamped to at most 1 and `unlitGain` to
at least 0. Per point with lit value `l` and mark `m` (0 or 1):

- size is multiplied by `mix(1, mix(0.8, 1.5, l), filter)`;
- brightness is multiplied by `mix(1, mix(unlitGain, 2.2, l), filter)`;
- a marked point adds white `0.9 * a * gain * filter` (`a` being the point's
  brightness before colour), so it burns white on the dark stage.

Wires are not affected. The no-HDR fallback applies the same terms (with its
`fallbackGain`).

**No search, no change.** With no lit values set, or with `filter` 0 (or below,
or `NaN`), the points are drawn by the program and the GL calls used before
search existed: the same shader source byte for byte, the same uniforms, the same
vertex array. The frame is byte-identical to the frame without search; the
browser test compares frames byte for byte, and a one-time comparison against the
core file from before this change gave identical frames on SwiftShader and on a
GPU.

**Light stage.** No option is needed. On the viewer's light (soft ink) stage
(`js/api/50-viewer.md`, "Light backgrounds") the points are uploaded in
complementary colours and the canvas is inverted and multiplied, so the added
white comes back as dark, neutral ink. A lit result is coloured ink, and a marked
one is clearly darker and greyer. Measured in the browser test (SwiftShader,
viewer settings gain 0.55 and bloom 0.3, an orange group): the centre of a lit
result is `(153, 92, 76)` and the marked twin `(94, 76, 70)`. On the dark stage
they are `(255, 248, 199)` and `(255, 254, 251)`.

### `renderer.resize(width, height)`

Sets the drawing buffer to `width` x `height` device pixels (the caller multiplies
CSS size by `devicePixelRatio`). The HDR target follows on the next draw.

### `renderer.draw(state) -> boolean`

Draws one frame. Returns `false` (and draws nothing, never throwing for this)
when disposed, while the context is lost, or after a failed build or upload
until `rebuild()` succeeds; otherwise `true`. With no data it
still clears (and fades trails).

`state` is a plain object; any key left out takes its default:

| Key | Meaning | Default |
|-----|---------|---------|
| `frame` | `Float32Array(3 * D)`, three orthonormal rows (x, y, z axes), row-major. Required when there is data (`TypeError` on a wrong length). | — |
| `centre` | `Float32Array(D)`, subtracted from every point before projecting | zeros |
| `zoom` | scale of projected coordinates | `1` |
| `yaw`, `pitch` | extra 3-D turn of the projected cloud (radians) | `0`, `0` |
| `radius` | unit coordinate's extent as a share of `min(width, height)` | `0.46` |
| `pointSize` | base point size in device pixels | `6.5` |
| `minPointSize` | floor on point size in device pixels | `1.5` |
| `gain` | overall brightness | `1` |
| `fallbackGain` | brightness factor without HDR | `0.55` |
| `twinkle` | flicker amplitude, 0 = steady | `0.18` |
| `time` | seconds, drives twinkle | `0` |
| `dt` | seconds since the last draw, drives trail fading | `1/60` |
| `trails` | trail persistence in seconds; `0` clears every frame | `0.17` |
| `trailGain` | brightness compensation while trails accumulate | `1.6` |
| `clear` | `true` wipes the trails this frame | `false` |
| `wires` | wire opacity 0..1 (drawn when above 0.02) | `0` |
| `wireGain` | wire brightness at `wires = 1` | `1.5` |
| `dim` | brightness of points with weight below 0.99 | `1` |
| `fog` | 0..1, how much true distance from `centre` dims and shrinks points | `0` |
| `fogNear`, `fogWidth` | true distance where fog starts to clear, and its width (data units) | `1.2`, `0.8` |
| `focus` | depth of the in-focus plane | `0` |
| `depthOfField` | how fast points swell and dim away from focus (0 = off) | `1.1` |
| `wireDepthOfField` | the same for wires | `0.8` |
| `bloom` | glow strength | `0.55` |
| `exposure` | tone-mapping exposure | `1.35` |
| `gamma` | output curve | `0.92` |
| `vignette` | brightness at the corners (1 = none) | `0.72` |
| `background` | `[r, g, b]` linear 0..1, added under the image | `[0, 0, 0]` |
| `filter` | 0..1, how much the lit values (`setLit`) apply this frame; 0 draws exactly as without search. The viewer eases it toward 1 while a search is active and toward 0 when none is. | `0` |
| `unlitGain` | brightness factor of a point with lit value 0, at `filter` 1 (Focus's Only results uses `0`: unlit points are hidden); also of a wire with an unlit end | `0.07` |
| `wireLoad` | `0` = off. Above 0: the most wire light per pixel (`wireDensity` times `wires * wireGain * gain`) the wires may pile up to; above it the wires' gain is multiplied by `wireLoad / light`. The viewer sets `8` whenever wires are shown. | `0` |

Corrected after the owner's browser look (2026-11-14); see
`docs/search-interface.md`, "Corrected after the owner's browser look":

- **Wires follow the search.** With `filter` above 0 and lit values set, the
  wires are drawn by a second wire program (`lineVertexLit`) that reads each
  wire's lit value (the smaller of its two ends', mark removed; one float per
  wire end in a buffer of its own, made again by `setLit`, `setWires` and every
  rebuild, freed by `setLit(null)` and `dispose`): brightness times
  `mix(1, mix(unlitGain, 1, l), filter)`. With `filter` 0 or no lit values the
  original wire program and calls are used.
- **A lit point's fog is relieved.** In the lit point program the fog strength
  is `fog * (1 - l * filter)` for both the size and the brightness terms, so a
  result is not dimmed away by distance while unlit points keep the fog.
- **Crowded wires** are scaled down with `wireLoad` (above). `status().wireScale`
  is the factor of the last frame that drew wires (1 when off or not crowded).

Mode mapping from the reference: Tumble is the defaults; Lattice sets
`wires = 1`, `dim = 0.55`, `trails = 0.10`; Wander sets `fog = 1` and a fixed
`zoom`. Modes may blend these per frame.

Without an HDR target (no `EXT_color_buffer_float` / `EXT_color_buffer_half_float`,
an incomplete float framebuffer, or `hdr: false`) the renderer draws straight to
the canvas: no bloom, no tone mapping, no trails, `fallbackGain` applied, and
`background` used as the clear colour. This is the reference's fallback.

### `renderer.rebuild() -> { ok: true } | { ok: false, reason, message }`

Retries building every GPU object from the CPU copy (points, colours, weights,
wires, lit values, layout). Use it after a `"restore-failed"` context event or after a
`setData` / `appendData` / `setWires` that returned `"shader-failed"` or
`"gpu-failed"`. `reason` is `"disposed"`, `"context-lost"` (wait for the
`"restored"` event instead), `"shader-failed"` or `"gpu-failed"`. `draw` never
retries by itself, so a caller that wants automatic recovery calls `rebuild`
on its own schedule.

### `renderer.status() -> object`

`{ ok, available, disposed, lost, hdr, error, dimension, count, capacity, wires, wireScale,
lit, maxTextureSize, layout }`. `lit` is true while lit values are set
(`setLit`). `ok` is false after a failed build or upload
(`error` holds the message) or after dispose. `count`, `wires` and `layout`
describe the CPU copy, which is what the GPU will show once it is whole again.

### `renderer.dispose()`

Deletes every texture, buffer, program, framebuffer and vertex array the
renderer created (shaders are deleted as soon as their program links), removes
its canvas listeners and drops its CPU copy. Safe to call twice. Later calls to
`draw` return `false`.

## Context loss

The renderer listens for `webglcontextlost` (and cancels it so the browser may
restore) and `webglcontextrestored` on the canvas. While lost, `draw` returns
`false`. On restore it rebuilds every GPU object from its CPU copy (points,
colours, weights, wires, layout) and reports `"restored"`; if the rebuild fails it
reports `"restore-failed"` with a message and stays unusable until `rebuild()`
succeeds. The caller decides what to show and when to retry.

## Data while the GPU is unavailable

While the context is lost, or after a failed build or upload, `setData`,
`appendData`, `setWires` and `setLit` still update the CPU copy and return `ok: true`
with `uploaded: false`. Nothing reaches the GPU then; the next successful
restore or `rebuild()` uploads the whole CPU copy, so the view shows the
latest data. Callers can check `uploaded` on each call, or `status()` (`lost`,
`ok`) at any time.

## Limits measured on the build machine

The layout limit is `floor(maxTextureSize / ceil(D/4)) * maxTextureSize` points
(rows widened to the full texture width); at the default 4096-texel rows it is
`floor(4096 / ceil(D/4)) * maxTextureSize`.

| Backend | `MAX_TEXTURE_SIZE` | 384-d | 1024-d | 2560-d |
|---------|--------------------|-------|--------|--------|
| AMD Radeon 760M (ANGLE / Vulkan) | 16384 | 2,785,280 (688,128 at default rows) | 1,048,576 (262,144) | 409,600 (98,304) |
| SwiftShader (software) | 8192 | 696,320 (344,064) | 262,144 (131,072) | 98,304 (49,152) |

Memory, not the layout, is the practical limit: the point texture holds
`N * ceil(D/4) * 16` bytes (10,000 x 1024-d is 41 MB on the GPU and the same
again on the CPU).
