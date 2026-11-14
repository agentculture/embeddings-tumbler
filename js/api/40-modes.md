# `ET.modes`: the three modes and the mode interface

Sources: `js/src/39-modes.js` (the interface, the registry and shared helpers),
`js/src/40-mode-tumble.js`, `js/src/41-mode-lattice.js` and
`js/src/42-mode-wander.js` (one file per mode). Pure JavaScript over the data:
no DOM, no WebGL, safe in node. Reach it as `ET.modes` inside the wrapper, or
as `api._internal.modes` from tests.

A mode owns its **motion** and its **draw parameters** and nothing else. Given
the loaded set, a seed and the time in the mode, it answers a frame, a centre, a
plain draw-parameter object for `ET.renderer.draw`, optional wires as index
pairs, and a one-line plain-text status. The viewer (task t8) owns the renderer,
the clock, the data, the DOM, labels, controls and the provenance block.

## Shapes

Same conventions as `js/api/10-math.md`: `D` is the dimension, `N` the count.

| Thing | Representation |
|-------|----------------|
| Frame | `Float32Array(3 * D)`, three orthonormal rows (x, y, z axes), row-major |
| Centre | `Float32Array(D)`, where the camera sits; the renderer subtracts it |
| Time | seconds of mode time (a finite number; negative is read as 0) |
| Seed | a number or a string (as `ET.math.toSeed`) |
| Set | the loader's set (`js/api/20-contract.md`): `vectors`, `dimension`, `count`, `points[i] = {id, label, group}` |

## The registry

- `ET.modes.register({ id, title, summary, create })`: adds a mode. `id` is
  lower-case letters, digits and hyphens, starting with a letter (at most 32
  characters); `title` a non-empty string; `summary` a string; `create(options)`
  returns a new instance. Throws `TypeError` on a malformed definition and
  `Error` ("already registered") on a duplicate id.
- `ET.modes.get(id) -> definition | null` (a copy).
- `ET.modes.list() -> definition[]` in registration order (copies).
- `ET.modes.ids() -> string[]`: `["tumble", "lattice", "wander"]` with every
  module loaded, since files load in name order.
- `ET.modes.create(id, options?) -> instance`. `RangeError` for an unknown id;
  `TypeError` naming the missing members when the instance does not implement
  the interface.
- `ET.modes.check(instance) -> string[]`: interface members the instance lacks
  (`[]` when it conforms). `ET.modes.INTERFACE` lists them.

A fourth mode is one more file (for example `js/src/43-mode-still.js`) that
calls `ET.modes.register(...)`, or a host call to the same function. It does not
touch the three shipped modes or the data contract (`js/test/modes.test.js`
registers one from a test). The public API (`ET.api`) is t8's; it may expose
`register` to hosts.

## The interface a mode instance implements

| Member | What it does |
|--------|--------------|
| `enter(set, { seed, from })` | Start the mode on `set`. Throws a `RangeError` naming the set's dimension when it is below the mode's minimum (see "Limits"). Cheap: no heavy work. Mode time restarts at 0. `from` is optional: `{ frame, centre, draw }`, the last state the viewer drew (any mode's). With it the mode starts exactly there and blends into its own motion; without it, it starts from its own deterministic start. |
| `prepare() -> stepper` | The mode's preparation, in bounded units. See below. |
| `isReady() -> boolean` | Whether frames are defined (the required part of the preparation is done). |
| `stateAt(t) -> state` | **The source of truth.** The state at mode time `t`. |
| `step(dt) -> state` | A thin wrapper: `time = max(0, time + dt)`, then `stateAt(time)`. Keeps `inst.time`; a negative `dt` never takes it below 0. |
| `status(t?) -> string` | The status line at `t` (default `inst.time`); the same text as `stateAt(t).status`. A pure query: calling it at any times changes no later answer (tested). Kept short (about 70 characters at most); detail is in `describe()`. |
| `dataChanged(newSet, { op, added, t }) -> { work, restart }` | The set changed at mode time `t` (see "Data changes"). `work` is a stepper to pump, or `null`. `restart: true` means the mode re-entered and its time restarted at 0: the viewer resets its mode clock to 0 and waits for `isReady()`. |
| `mark(t)` (optional) | Fix the time of a finished event at mode time `t` (see "Events"). All three shipped modes have it; it does nothing when no event is waiting. |
| `describe() -> object` | What the provenance block needs: `{ id, projection, seed, varianceShare, ... }` (per mode below). `projection` always says it is linear. |
| `leave()` | Drop the instance's references; it is not used again. |

The state:

```js
{
  t,                              // the time asked for (clamped at 0)
  frame: Float32Array(3 * D),     // orthonormal (frameError < 1e-5)
  centre: Float32Array(D),
  draw: { zoom, wires, dim, trails, fog, fogNear, fogWidth, twinkle, depthOfField },
                                  // finite numbers, every key a renderer draw() key
  wires: null | { pairs: Uint32Array, lengths: Float32Array, version },
                                  // index pairs and true full-space lengths; version
                                  // changes when the list does
  status: string,                 // plain text; may contain labels from the data
  focus: null | { phase, from, to, e, neighbours },   // Wander only, for labels and spokes
}
```

The state object and its arrays are **owned by the instance and reused** on the
next `stateAt`/`step`/`status` call. Copy what you keep (the viewer keeps the
last state as the next mode's `from`, so it copies it).

### Preparation: `prepare()` and steppers

`prepare()` returns a stepper `{ step(budgetMs?) -> done, done, ready, progress }`:

- `step(budgetMs)` runs bounded units until `budgetMs` milliseconds have passed
  (always at least one unit); `step()` with no budget runs everything. The clock
  only decides how much work runs per call, never what it computes.
- `ready` turns true when the required part is done (then `isReady()` is true);
  `done` when everything is. `progress` is 0..1.
- Before `isReady()`, `stateAt` answers a hold state (the `from` frame, or the
  mode's start frame) with a "preparing" status. **The viewer should not advance
  mode time until `isReady()`**: start the mode clock at 0 when it turns true.
  That way the frame sequence is fixed by data, seed, entry view and time, never
  by how fast the preparation ran.

`ET.modes.stepper(tasks)` builds one from `{ run() -> done, required?, weight?,
progress?() }` tasks; a mode written elsewhere can use it.

What is ready when (measured below):

| Mode | Required before frames | Extra work (drawn when it arrives) |
|------|------------------------|------------------------------------|
| Tumble | mean and spread (one unit), centring (one unit), principal directions and tour (one unit) | none |
| Lattice | mean and spread (one unit) | true neighbours, `sliceRows` (16) query rows per unit; then the wire list |
| Wander | mean, spread, the visit list and the neighbour pool (one unit) | none: each stop's neighbours and local frame are computed when the route reaches it (one pool scan, `O(pool * D)`, about once per 4.8 s) |

Tumble's principal-directions unit is one indivisible call into
`ET.math.guidedTour`. It is bounded by fitting on at most `fitRows` (4,096)
rows taken at an even stride when the set is larger (the variance shares are
still exact over all rows). It is the one unit that can take hundreds of
milliseconds (table below); a host that cannot block that long should run it
off the main thread (not built).

### Reproducibility

For a fixed set, seed and entry view (`from`, or none), `stateAt(t).frame` and
`.centre` are functions of `t` alone: bit-identical across fresh runs, however
time was sliced, and in any query order (forwards, backwards, repeated). Tested
over 10 simulated seconds at 60 frames per second at 48-d and 1024-d
(`js/test/modes-determinism.test.js`). `step(dt)` accumulates time in a float,
so after 600 steps of 1/60 s its clock is 10 s give or take about 1e-14 s; its
frames match `stateAt(10)` to well under 1e-6 and match `stateAt(inst.time)`
bit for bit. Lattice's frames do not depend on how far the neighbour work has
got (tested). As in `ET.math`, `Math.sin`/`Math.cos` may differ in the last bit
between JavaScript engines.

What may depend on progress or on events: the wires and their fade-in
(Lattice), a refit (Tumble, when the viewer asks), anything after an append,
and the progress figure in a "measuring" or "finding" status.

### Events

Two things happen at a time the work's progress decides: a Tumble refit
switching in, and a Lattice wire list being shown (the first list fades in; a
re-measured list replaces it). Each is an **event at a fixed time T**:

- T is fixed by the caller: `refit(t)` (Tumble) gives it up front; `mark(t)`
  fixes it for an event whose work has finished. Only when the caller gave no
  time does the first `stateAt` after the work finished fix T at the time it
  asks for. T is never earlier than the previous event of the same kind, so a
  fixed past is never rewritten.
- Once T is fixed, `stateAt(t)` is a pure function of (data, seed, entry view,
  t, T): the same `t` gives the identical state however often and in whatever
  order it is asked, and `t < T` gives the state from before the event (the old
  tour and its share; no wires, or the previous wire list).
- T is reported: Tumble `describe().refitAt` (and `refitPending` while a refit
  runs or waits), Lattice `describe().wiresShownAt` (first list),
  `wiresReplacedAt` (latest re-measured list) and `wiresPending`.
- Recommended for the viewer: after pumping a stepper in a frame, call
  `inst.mark(clock)` before `stateAt(clock)`; that makes T the frame's time
  explicitly. Work finished before the clock started is then shown from 0.

Tested: repeated and backwards queries across a refit and across the wire
fade-in are bit-identical, and two instances given the same T agree whatever
order they are queried in (`js/test/modes-review.test.js`).

### Data changes (`dataChanged`)

`op: "append"` with the same dimension: the instance switches to the new set
without resetting anything; the state at `t` is unchanged at the moment of the
append (tested for all three: frame bit-identical, centre within 1e-7).

- **Tumble** keeps its tour (basis and seed): no jump. The camera centre glides
  (time constant 0.7 s) from where it is to the new mean. The reported
  `varianceShare` is **stale**: `describe().varianceShareStale` is true,
  `pointsSinceFit` counts the appended points, and the status line says
  "before N new points". `refit(t?)` returns a stepper that fits the directions
  again on the current set; at the switch time T (see "Events") it switches to
  the new tour, aligned to the current axes (order and sign) and blended in over
  `transition` (1.5 s), and from then on the share is fresh. The viewer decides when to refit (for example after a quiet period or
  when `pointsSinceFit` passes a share of the set). This is the cheapest honest
  behaviour: an append costs `O(k * D)` here, a refit costs a full fit.
- **Lattice** keeps its swap schedule: no jump; the centre glides to the new
  mean. If the set had fewer than `neighbourLimit` points, new points fall
  inside the limit, so neighbours are measured again (returned stepper); the
  old wires stay drawn until the new list is ready (a new `version`), which is
  then shown at full strength. Otherwise nothing is re-measured.
- **Wander** keeps every hop up to the one in progress at `t` (the stop and its
  frame), so the flight in progress is unchanged; later stops are chosen again
  with the new points, which may become stops (when labelled) and neighbours.
  The next hop starts from the frame and point actually shown at the end of
  the kept hop. Tested: sampled every 1/60 s from before an append to the end
  of the second hop after it, the largest frame change per step stays within
  1.5 times the largest seen in 60 s without an append (measured: 0.0022 to
  0.0061 against 0.0077), and the change at the next hop's start is 0 to five
  decimals. The route is fixed by the data history (the same sets appended at
  the same times) and the seed, not by how the instance was queried (tested).

These return `{ work, restart: false }`. Any other change re-enters the mode
from the current view and returns `{ work: prepare(), restart: true }`: the
first points arriving on an **empty** set, `op: "replace"`, or another
dimension.

The mean and spread are kept as running sums (`ET.modes.stats(set, previous)`),
so an append updates them in `O(k * D)`.

### Empty sets

A set with `count` 0 is valid (the data contract allows a replace with no
points). Every mode accepts it: `prepare()` finishes at once, `isReady()` is
true, and `stateAt` returns a hold state that does not move: the entry frame
(or the mode's start frame), the entry centre (or zeros), the entry's draw
parameters, no wires, status `no points yet`. The first append with points
re-enters the mode from that view (`restart: true`).

## Tumble (`"tumble"`)

The frame turns inside the span of the data's `subspace` strongest principal
directions: `ET.math.guidedTour(Y, N, D, { seed, subspace, speed, sampleRows })`
on the centred vectors, and the frame at `t` is that tour's `frameAt(t)`. With
no `from`, it is exactly `tour.frameAt(t)` (tested bit for bit). With `from`,
the tour's axes are relabelled once (order and sign, `ET.modes.alignment`) to
match the entry frame, and the frame blends from the entry frame into the tour
over `transition` seconds.

| Option | Default | Meaning |
|--------|---------|---------|
| `subspace` | 8 | directions the tour moves through (at least 3) |
| `speed` | 0.42 | rad/s, the reference's rate |
| `transition` | 1.5 | seconds to blend in from the entry view |
| `fitRows` | 4096 | fit on at most this many rows (`sampleRows`); shares stay exact |
| `centreTau` | 0.7 | seconds, the centre's glide to the mean (the reference's) |
| `zoomSample` | 512 | points used for auto-framing |

- `inst.varianceShare` and `describe().varianceShare`: the share of the total
  variance held by the directions the tour moves through (`tour.varianceShare`).
  It is **not** the share of the three directions on screen at one instant (that
  is never more than this; `ET.math.varianceShare(Y, N, D, frame, 3)`).
- Status: `tour of 8 strongest directions · 64.6% of variance`, plus
  `· before 40 new points` while the share is stale (at times before a refit's
  switch, the share of the tour then shown). Before it is ready: `finding the
  strongest directions in 384-d … 33%`.
- `describe()`: `{ id, projection, seed, subspace, speed, varianceShare,
  varianceShareStale, pointsSinceFit, fittedRows, method, refitAt,
  refitPending, empty }`.
- `refit(t?) -> stepper` (Tumble only); `mark(t)`.
- Draw: `zoom` auto (below), `wires 0`, `dim 1`, `trails 0.17`, `fog 0`,
  `twinkle 0.18`, `depthOfField 1.1` (the reference's defaults).

## Lattice (`"lattice"`)

One visible axis at a time turns a quarter turn into a hidden direction, using
the reference's eased angle: `ET.math.makeSwapTour(frame0, D, { seed, period })`
where `frame0` is the entry frame (so there is no jump) or a seeded random frame.
The axis swapping in cycle `c` is `c mod 3`. Hidden directions come from the
full space, as in the reference.

Wires: each of the first `neighbourLimit` points is wired to its
`wireNeighbours` true nearest neighbours **in the full space** among those
points (`ET.math.makeKnn`, exact, run `sliceRows` rows per unit), deduplicated,
with their true lengths. As in the reference, points with no group get no wires
of their own when any point in the limit has a group (the unstructured halo
stays unwired); they can still be another point's neighbour. When the set has
no groups at all, every point gets wires.

| Option | Default | Meaning |
|--------|---------|---------|
| `period` | 3.4 | seconds per swap (the reference's) |
| `neighbourLimit` | 1000 | only the first this-many points get neighbours (the reference's) |
| `wireNeighbours` | 3 | wires per point (the reference's) |
| `sliceRows` | 16 | query rows per unit of neighbour work (the reference's) |
| `transition` | 1.2 | seconds to blend draw parameters in |
| `wireFade` | 1.2 | seconds for the wires to fade in once measured |
| `centreTau` | 0.7 | seconds, the centre's glide to the mean |
| `zoomSample` | 512 | points used for auto-framing |

- Status: `swap 2 · axis Y trading for a hidden direction ·  47% · 1,870 wires`
  (swap number from 1, the axis, the swap's progress padded to three
  characters, the wire count of the list shown at that time). Before a list
  is shown: `… · measuring 37%`.
- `describe()`: `{ id, projection, seed, period, neighbourLimit,
  wireNeighbours, wires, neighboursMeasured, wiresShownAt, wiresReplacedAt,
  wiresPending, empty, varianceShare: null }`.
- Wires are an event (see "Events"): `state.wires` is `null` before the first
  list's time, and `draw.wires` fades from 0 to 1 over `wireFade` from it.
- Draw: `wires` 0..1 (the fade-in), `dim 0.55`, `trails 0.10` (the reference's
  `0.17 - 0.07`), `fog 0`, `zoom` auto.
- The viewer calls `renderer.setWires(state.wires.pairs, state.wires.lengths)`
  whenever `state.wires.version` differs from the last it set.

## Wander (`"wander"`)

The camera flies from stop to stop. Hop `h` (from 0) starts at `h * (travel +
dwell)`: it travels for `travel` seconds (smoothstep) from the previous stop (or
the entry centre) to the stop, blending the frame from the previous stop's
frame (or the entry frame) into the new one (`ET.math.blendFrames`), then dwells
at the stop for `dwell` seconds with the centre exactly on the point.

- **Stops** are labelled points. A point is labelled when its label is a
  non-empty string that is not just its id (a labels-only set repeats the id
  as the label). With fewer than two labelled points, any point in the
  neighbour pool can be a stop, so Wander never stalls.
- **The route** follows the reference's rules, from the seed and the data only:
  hop `h` draws from its own stream `makeRandom(mixSeed(seed ^ salt, h))`. A
  near hop picks among the first `nearChoices` labelled points among the
  current stop's `neighbours` nearest, skipping the last `recent` stops; every
  `leapEvery`-th hop (and whenever no near stop is left) leaps to a random
  stop in another group (40 tries, then any stop).
- **The local frame** of a stop is `ET.math.localFrame` of the point and its
  `neighbours` (24) true nearest neighbours, measured in the full space among
  the neighbour pool (the first `neighbourLimit` points plus every labelled
  point), aligned to the previous frame with `ET.math.alignTo`.

| Option | Default | Meaning |
|--------|---------|---------|
| `neighbours` | 24 | neighbours a local frame is fitted to (the reference's K) |
| `neighbourLimit` | 1000 | the pool: the first this-many points, plus every labelled point |
| `travel` | 2.8 | seconds of flight per hop (the reference's) |
| `dwell` | 2.0 | seconds at each stop (the reference's) |
| `leapEvery` | 5 | every n-th hop leaps to another group (the reference's) |
| `nearChoices` | 6 | a near hop picks among this many (the reference's) |
| `recent` | 16 | stops not revisited within this many hops (the reference's) |
| `transition` | 1.0 | seconds to blend draw parameters in |
| `zoom` | 2.7 | the reference's fixed zoom, at the reference's scale |
| `spokes` | 6 | labelled neighbours listed in `focus.neighbours` |

- `state.focus`: `{ phase: "travel" | "dwell", from, to, e, neighbours }`:
  indices of the previous and next stop (`from` is -1 on the first hop), the
  flight's eased progress `e` (1 while dwelling), and up to `spokes` labelled
  neighbours of the stop. The viewer draws labels and spokes from it (the
  reference fades the previous stop's spokes out as `1 - 1.6 e` and the next
  stop's in as `e^2`).
- Status: dwelling `at "estuary" · ocean · stop 7`; travelling `"whale" →
  "estuary"`, or `heading to "estuary"` on the first hop, plus `· long leap to
  ocean` when the hop changes group. Names longer than 24 characters are cut
  to 23 and `…`. Labels are untrusted text: the viewer must insert the status
  with `textContent`.
- `inst.route(n) -> Int32Array`: the first `n` stops. `inst.neighboursOf(j) ->
  Int32Array`: the neighbours a stop's frame is fitted to.
- `describe()`: `{ id, projection, seed, neighbours, neighbourLimit, travel,
  dwell, labelled, visiting, empty, varianceShare: null }`.
- `mark(t)` does nothing: Wander has no events.
- Draw: `fog 1`, `fogNear 1.2 * s`, `fogWidth 0.8 * s`, `zoom 2.7 / s`,
  `trails 0.17`, `wires 0`, where `s` is the set's radius over the sample's
  (below).

## Limits

**Dimension.** Tumble and Wander need `D >= 3` (three orthonormal axes);
Lattice needs `D >= 4` (a hidden direction must exist). Below that, `enter`
throws a `RangeError` that names the data, for example `the set has dimension
2; Lattice needs at least 4 dimensions`. The viewer turns it into a plain
message for the host. Real sets are hundreds of dimensions.

**Tiny sets.** Sets of 1, 2 or a few points work in every mode. With a single
point, or a Wander neighbour pool of one, a stop has no neighbours: its local
frame comes from `ET.math.localFrame` of that one point, which has no spread,
so it falls back to standard basis directions (deterministic, orthonormal, but
not fitted to anything). With fewer than four points a neighbourhood has rank
below three and the missing axes are filled the same way. Tumble's tour on a
set with one point (no variance) reports a share of 0.

**Empty sets.** See "Empty sets" above.

## Shared helpers on `ET.modes`

- `stats(set, previous?) -> { count, dimension, mean: Float32Array(D),
  totalVariance, radius }`, cached per set; `radius` is the root mean squared
  distance from the mean. Precondition for `previous`: `set` is `previous` with
  points appended. A cheap guard (`isPrefix`: same dimension, no fewer points,
  the first and last rows of `previous` equal in both) is checked; when it
  fails, `previous` is ignored and the stats are recomputed in full (tested).
- `requireDimension(set, min, title)`, `holdState(...)`, `changed(work,
  restart)`, `EMPTY_STATUS`: shared by the three modes for the rules above.
- `REFERENCE_RADIUS = 0.963`: the sample set's radius (measured: 0.963 at
  384-d, 0.968 at 1024-d). Distances the reference tuned by eye (fog, Wander's
  zoom) are scaled by `radius / REFERENCE_RADIUS` measured when the mode is
  prepared, so they fit other data; appends do not change the scale.
- `autoZoom(X, N, D, frame, centre, sample?)`: the reference's auto-framing,
  `0.78 / rms` of the projected coordinates of the first `sample` (512)
  points. A fixed sample, so appends past it do not move the framing.
- `makeGlide`, `alignment`, `applyAlignment`, `entryFrom`, `blendDraw`,
  `startFrame`, `thousands`, `isLabelled`, `checkTime`, `stepper`: the pieces
  the three modes share, documented in the source.

## How the viewer (t8) drives a mode

```js
var inst = ET.modes.create(id);
inst.enter(set, { seed: seed, from: last ? copyOf(last) : null });
var prep = inst.prepare();
var clock = 0;
function frame(dt) {                       // once per animation frame
  if (!prep.done) prep.step(8);            // about 8 ms of preparation per frame
  if (inst.isReady() && running) clock += dt * speed;
  inst.mark(clock);                        // finished events happen at this frame's time
  var s = inst.stateAt(inst.isReady() ? clock : 0);
  if (s.wires && s.wires.version !== lastWires) {
    renderer.setWires(s.wires.pairs, s.wires.lengths);
    lastWires = s.wires.version;
  }
  renderer.draw(Object.assign({}, s.draw, {
    frame: s.frame, centre: s.centre,
    yaw: yaw, pitch: pitch,                // the viewer's: drag, plus 0.06 rad/s spin
    pointSize: 6.5 * devicePixelRatio,     // modes give no pixel sizes
    time: now, dt: dt,
  }));
  status.textContent = s.status;           // text, never markup
  last = s;                                // copy it when switching modes
}
```

- **Speed** is the viewer's: it scales `dt` before adding it to the mode clock.
- **Pause** stops the mode clock; drawing may go on (twinkle, trails).
- **Yaw, pitch, labels, spokes, the readout strip** are the viewer's. The
  reference spins the cloud at 0.06 rad/s of yaw while running.
- **Mode switch:** create the new instance with `from` = a copy of the last
  state drawn; the new mode begins exactly there.
- **Appends:** call `r = dataChanged(newSet, { op: "append", added: k, t: clock })`
  on the active instance; pump `r.work` if it is not `null` (as `prep`), and
  when `r.restart` is true set the mode clock to 0 and wait for `isReady()`.
- **Refit (Tumble):** `inst.refit()` (or `refit(clock)`) and pump the stepper;
  with `mark(clock)` each frame the switch happens at the frame the fit
  finished.
- **Wires:** `renderer.setWires` returns a result; a caller that cares checks
  `ok` (see `js/api/30-renderer.md`).

## Measured

Node 24 on the development machine (AMD Ryzen with Radeon 760M, shared with
other jobs), built-in sample set, 12,288 points, each mode on a freshly
validated set (no cache), `prepare().step(8)` until done, two runs:

| Mode | 384-d ready | 384-d all | 1024-d ready | 1024-d all | `stateAt` mean (384 / 1024) |
|------|-------------|-----------|--------------|------------|-----------------------------|
| Tumble | 219 to 223 ms (longest unit 187 to 194 ms) | same | 535 to 598 ms (longest unit 456 to 525 ms) | same | 0.36 / 0.94 ms |
| Lattice | 13 to 14 ms | 146 to 149 ms in 16 slices of at most 14 ms | 33 to 35 ms | 338 to 341 ms in 32 slices of at most 35 ms | 0.34 / 0.87 ms |
| Wander | 13 to 16 ms | same | 33 to 34 ms | same | 0.04 / 0.08 ms; a frame that computes a new stop: up to 6.8 / 13.6 ms |

The first unit of each mode (mean and spread, `O(N * D)`) is the 13 to 35 ms;
switching modes on the same set reuses it (cached per set). Tumble's fit is on
4,096 rows at this size (shares exact over all 12,288).

Browser, the development demo (`js/dev/modes-demo/`), 960 x 600, six seconds per
mode, headless Chromium:

| Backend | Set | Tumble | Lattice | Wander |
|---------|-----|--------|---------|--------|
| AMD Radeon 760M (ANGLE, Vulkan) | 12,288 x 384 | 60 fps | 60 fps | 60 fps |
| AMD Radeon 760M (ANGLE, Vulkan) | 12,288 x 1024 | 60 fps | 60 fps | 60 fps |
| SwiftShader (software) | 12,288 x 384 | 20 fps | 15.5 fps | 17.4 fps |
| SwiftShader (software) | 12,288 x 1024 | 14.5 fps | 17.3 fps | 14.8 fps |

On the GPU every mode held the display's 60 fps (the frame rate is capped by
the display, so the headroom is not measured). SwiftShader numbers are
dominated by software rendering, not by the modes.

## Differences from the reference

Collected for the sign-off in task t17. Each one is forced by the determinism
rule, by the dimension coming from the data, or by the modes being separate
units; none is a change of look by choice.

1. **Tumble's motion is a closed-form guided tour**, not the reference's
   unseeded smoothed random walk through the full space. It turns inside the
   eight strongest principal directions (already decided in the plan) and its
   frame is a function of time. It starts from the top three principal
   directions instead of a random frame. The reference's "view turned N°"
   counter is replaced by the variance share the tour moves through.
2. **Lattice's hidden directions are seeded per swap** (`makeSwapTour`), not
   drawn from the reference's single running random stream, so the swap
   sequence is reproducible. A fresh Lattice (no previous view) starts from a
   seeded random frame, as the reference's starts from a random frame.
3. **Lattice's motion runs while neighbours are measured**, as in the
   reference, but the dimming, darker trails and wires no longer wait for the
   neighbours: dim and trails blend in at entry (1.2 s), and the wires fade in
   over 1.2 s once measured. The reference eased all three in together (time
   constant 0.4 s) only after measuring finished.
4. **Wander needs no global neighbour pass.** The reference measured 24
   neighbours for the first 1,000 points before Wander could start; here each
   stop's 24 neighbours are measured when the route reaches it, in the pool of
   the first 1,000 points plus every labelled point (in the sample set the
   labelled points are all inside the first 1,000, so the pool is the
   reference's). Wander starts at once.
5. **Wander's route is drawn per hop from the seed** (`mixSeed(seed, hop)`),
   not from the reference's shared random stream, so the route depends only on
   the seed and the data. The rules (near hop among the first six labelled
   neighbours, a leap to another group every fifth hop, no revisit within 16
   stops) are the reference's. A stop with no group may leap to any group.
6. **Wander's first flight starts from the entry view** (the previous mode's
   frame and centre), as in the reference, but a fresh Wander starts from a
   seeded frame and the data's mean.
7. **The centre glide and zoom are functions of time, not per-frame easing.**
   The reference eased the centre toward the mean (`exp(-dt / 0.7)`) and the
   zoom toward its target (`exp(-dt / 0.6)`) every frame, which depends on the
   frame rate. Here the centre glide is the same exponential in closed form,
   the auto-zoom is computed from the current frame each time (`0.78 / rms`
   over the first 512 points rather than the reference's 290 named points), and
   mode switches blend the frame and draw parameters with a smoothstep over
   1.0 to 1.5 s instead of the reference's exponential mixes.
8. **Distances tuned by eye are scaled to the data**: fog distances and
   Wander's zoom are the reference's values times the set's radius over the
   sample set's (0.963). On the sample set they are the reference's values.
9. **Points per mode are the renderer's**: the reference shrank points with
   fog in Wander through its own shader term; that is now the renderer's `fog`
   parameter (task t6).
