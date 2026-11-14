# `ET.modes` Focus: the fourth mode (`js/src/43-mode-focus.js`)

Status: **implemented** (task t7), from the interface in `docs/search-interface.md`
("Focus (t7)"). Pure JavaScript: no DOM, no WebGL, no network, no unseeded
randomness. It registers itself with `ET.modes.register({ id: "focus", title:
"Focus", summary, create })` and implements the interface of `js/api/40-modes.md`
without editing any existing file. Reach it as `ET.modes.create("focus")`.

Focus shows what is searched for. With searches active the frame is the fit of
every search's query and named results; with none it is the fit of the whole
set. When the searches change, the view turns smoothly onto the new fit. The
viewer's slow spin (yaw) goes on over the frame, so the view keeps turning.

## What the frame is

- **With searches:** the facing frame of `ET.searchSets.makeFacingFrame(set,
  searches, { seed, scale })` (`js/api/26-search-sets.md`): the query and named
  results of every search (up to four) are the rows; with two or more searches
  the first axes join their centres, otherwise the spread of the rows gives the
  axes. The point-of-view `scale`, when given, is passed through, so the frame is
  fitted in the scaled space and mapped back to an orthonormal frame on the
  loaded vectors. The centre is the facing frame's centre. `draw.zoom` is the
  Focus reference's zoom (corrected after the owner's browser look, 2026-11-14):
  the farthest named result at `0.36 / 0.46` units (the reference maps the
  results' reach to 0.36 of the stage's shorter side, the renderer maps one unit
  to 0.46 of it), pulled back only as far as needed to keep each query within
  1.3 reaches of the centre, so a query far from its results stays on the stage
  (the stage's shorter half-side is 1.39 reaches). Lengths are measured on the
  loaded vectors in the fitted frame, as the facing frame measures its reach.
- **With none:** the three strongest principal directions of the whole set
  (`ET.math.makePrincipalDirections`, `k = 3`, seeded, on at most `fitRows`
  rows at an even stride), about the set's mean, framed by `ET.modes.autoZoom`.
  This is made once per entry and reused when the searches are cleared.
- A search is used only when its query has the set's dimension; its indices
  outside `0 .. count - 1` are dropped; a `scale` of another length is ignored.
  If no search is usable the view is the whole-set fit. More than four searches:
  the first four.

## Turning

A fit is a **turn** recorded at a fixed mode time `T`: from the view shown at `T`
(frame, centre, zoom) onto the new fit, over `turn` seconds (1.6) with a
smoothstep, through `ET.math.blendFrames` (re-orthonormalised at every step, so
the frame never folds). The new fit's axes are first re-labelled in order and
sign (`ET.math.alignTo`) to the view shown, so the turn is the shortest. The
first turn of an entry is from the entry view (`from`) onto the first fit over
`transition` seconds (1.5), or no turn at all when there is no entry view. A
turn that starts while another runs starts from the view shown then.

`stateAt(t)` is a function of the recorded turns and `t` only, answered in any
query order. `T` is fixed like Tumble's refit: by `mark(t)`, or by the first
`stateAt` after the fit finished, never earlier than the time given to
`searchChanged` or than the previous turn. At most 64 turns are kept (a seek
before the oldest kept turn shows its starting view).

## Members

The members of `js/api/40-modes.md`, plus:

### `inst.spin` (0.13 while a usable search is shown, else undefined)

The yaw speed, in radians per second, at which the viewer turns the view while
Focus is shown with a usable search (a query of the set's dimension): the Focus
reference's 0.13. With none it is undefined, so Focus turns as before (the viewer's own, for modes that do
not ask, is 0.06). An optional mode member (`js/api/40-modes.md`). Corrected
after the owner's browser look (2026-11-14), when Focus at 0.06 looked paused.

### `inst.searchChanged(search, t) -> stepper | null`

`search` is `null` (no search) or the shape in `docs/search-interface.md`:
`{ searches: [{ letter, query, indices }], scale, onlyResults }`. The caller's
arrays are copied. `t` is the mode time of the change.

- **Returns a stepper** (`step(budgetMs?) -> done`, `done`, `ready`, `progress`)
  when a fit has to be made: **the caller pumps it** like any preparation or
  Tumble's `refit` work, within the frame budget (a unit is one
  `makeFacingFrame` unit, under 4 ms at 1,024-d), and calls `inst.mark(clock)`
  after pumping, as for every mode. Until the fit is done the view keeps its
  place and keeps moving as before; then it turns onto the fit.
- **Returns `null`** when nothing needs pumping: the search is the same fit as
  before (only `onlyResults` changed: the setting applies at once and the view
  does not move), the fit is already known (back to the whole set), or the mode
  is not ready yet, in which case the preparation reads the latest search when
  its fit runs (a search that arrives during the preparation is the first fit,
  with no turn from the whole set). Also `null` for an empty set.
- A newer call supersedes an older one: the older stepper finishes at once and
  changes nothing (tested).
- Frames are identical whatever the stepper's budgets and on every fresh run.

### Only results

With `onlyResults` true and at least one usable search, `stateAt(t).draw.unlitGain`
is `0`; the renderer then draws points whose lit value is 0 with no brightness
(`js/api/30-renderer.md`). With a usable search and `onlyResults` false it is
`0.05`, dimmer than the renderer's default 0.07 used by the other modes
(corrected after the owner's browser look, 2026-11-14: the reference draws unlit
points at 0.13 of a result's strength on a 124-point page, and on the sample
set's 12,288 points, which pile up under the bloom, 0.05 reads like it; picked
by comparing screenshots). With no usable search the key is **absent**, and the
other three modes never set it. The
viewer (t8) passes `state.draw` to the renderer as it does for every mode, so the
key reaches it with no further change; the viewer's hit test and labels must skip
points whose lit value is 0 while `describe().onlyResults` is true and the mode
is Focus (`docs/search-interface.md`).

### `describe()`

`{ id: "focus", projection, seed, fittedTo: "results" | "all", searches:
string[], onlyResults, empty, varianceShare: null }`. `fittedTo` and `searches`
describe the latest recorded fit (letters, in order); `onlyResults` is the
current setting.

### `status(t)`

`fitted to the results of A, B` or `fitted to every point` (the fit shown at
`t`); `fitting the view to the set in 384-d … 33%` while preparing; `no points
yet` for an empty set.

### No `face`

Focus has no `face` member (the Face the searches control is disabled in it).

### Data changes

Any change (`append`, `replace`, another dimension) re-enters the mode from the
view shown and returns `{ work: prepare(), restart: true }`, so the whole-set
fit and any search fit are made again on the new set. The active search is kept:
the viewer calls `searchChanged` again when its results change, as it does after
every data change.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `transition` | 1.5 | seconds to turn from the entry view onto the first fit, and to blend draw parameters in |
| `turn` | 1.6 | seconds to turn from the view shown onto a new fit |
| `fitRows` | 4096 | the whole-set fit uses at most this many rows |
| `zoomSample` | 512 | points used to frame the whole-set fit |

Draw parameters: `zoom` as above, `wires 0`, `dim 1`, `trails 0.17`, `fog 0`,
`fogNear 1.2`, `fogWidth 0.8`, `twinkle 0.18`, `depthOfField 1.1`, and
`unlitGain 0` only for Only results. Dimension needs `D >= 3`; a lower one
throws a `RangeError` naming it, like the other modes.
