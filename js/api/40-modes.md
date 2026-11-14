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
- A preparation may be **abandoned midway**: stop pumping it and `leave()`,
  `enter` again, or let a `dataChanged` restart the mode. Tumble's steppers
  belong to the entry (and, for `refit()`, the refit call) that made them: a
  stepper left over from an earlier one does nothing if it is pumped later (it
  reports done and changes no state), so it can never make the instance ready
  on old data or put an old fit in place. A fresh `enter` and full `prepare`
  after an abandoned one give frames bit-identical to a run that was never
  interrupted (tested in `js/test/modes-refit-hardening.test.js`, including a
  caller that keeps pumping the old stepper, and an abandoned refit followed by
  another). Lattice and Wander do not guard their steppers this way; the viewer
  drops the queued work of an entry a restart replaced (see "How the viewer
  drives a mode"), which covers all three.

`ET.modes.stepper(tasks)` builds one from `{ run() -> done, required?, weight?,
progress?() }` tasks; a mode written elsewhere can use it.

What is ready when (measured below):

| Mode | Required before frames | Extra work (drawn when it arrives) |
|------|------------------------|------------------------------------|
| Tumble | mean and spread, centring (`ET.math.makeCentre`), principal directions and tour (`ET.math.makeGuidedTour`) | none |
| Lattice | mean and spread | true neighbours, query rows one at a time until about 1 ms has passed (at most `sliceRows`, 16, per unit); then the wire list |
| Wander | mean and spread, the visit list and the neighbour pool (one unit, `O(N)`), the first stop (its neighbour scan in pieces, then its local frame via `ET.math.makeLocalFrame`) | none at preparation; each later stop is computed ahead of need in the same small pieces, one piece per `stateAt`, during the hop before it |

Every unit is small: the mean and spread are added about 2^19 values per unit
(`ET.modes.statsJob`), and Tumble's fit runs one `ET.math` stepper unit per
unit (about 2^20 multiply-adds, or less once 1 ms has passed). No unit takes
more than a few milliseconds (measured below), so the viewer's per-frame
budget holds. The fit still uses at most `fitRows` (4,096) rows taken at an
even stride when the set is larger (the variance shares are exact over all
rows). The frames are bit-identical to a blocking preparation, whatever the
budgets (tested: `js/test/modes-refit.test.js` pumps Tumble's preparation in
budgets of 0 and 0.01 ms and compares 10 s of frames with a blocking instance).

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
  the new tour, aligned to the current axes (order and sign), turning onto it
  over `describe().refitTransition` seconds (see "Tumble" below), and from then
  on the share is fresh. The viewer decides when to refit (for example after a quiet period or
  when `pointsSinceFit` passes a share of the set). This is the cheapest honest
  behaviour: an append costs `O(k * D)` here, a refit costs a full fit.
- **Lattice** keeps its swap schedule and the directions fitted when it was
  entered (they are not fitted again on an append): no jump; the centre glides
  to the new mean. Whether an entry waits for that fit is decided once, at
  entry; a set entered with one point has nothing to fit, so the first append
  that gives it two or more points re-enters from the current view (as the
  first points onto an empty set do) and fits then. (Before, such an append
  left the mode waiting for a fit nobody scheduled: never ready again.) If the set had fewer than `neighbourLimit` points, new points fall
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
  The append records only the point count in force from the next hop on: a
  set's earlier points never change on append, so the stops and neighbours of
  any earlier hop can be computed again from the current set and that count.

These return `{ work, restart: false }`. Any other change re-enters the mode
from the current view and returns `{ work: prepare(), restart: true }`: the
first points arriving on an **empty** set, (Lattice) the points that give a
one-point set something to fit, `op: "replace"`, or another dimension.

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

**Refit turn.** At a refit's switch time T the frame shown is A and the new
tour (aligned in axis order and sign) starts at B. Tumble turns from A onto
the new tour with a fixed rotation Q of the whole space with Q B = A: a
rotation inside B's span and rotations in mutually orthogonal planes taking
B's principal vectors to A's (the shortest turn between the two spans). During
the turn the frame is Q(s) applied to the new tour's moving frame, s going from
1 to 0 with an even rate in the middle and smooth ends (speeding up over the
first quarter, slowing down over the last). A rotation does not change the
tour's own rate, and Q(s) is a rotation for every s, so the frame stays
orthonormal and never folds. With `refitTransition: "auto"` the turn's length
is chosen so that the turn adds at most half the tour's mean rate of change:
`max(refitTransitionMin, min(refitTransitionMax, 1.33 x turn rate / (0.5 x tour
rate)))`. The tour rate is the new tour's own rate of change (Frobenius norm per
second), averaged over 24 samples in the 12 s from T, read from that tour's
closed form (`coefficientsAt`), whether or not the tour is still the one shown
over those 12 s: a later refit switching inside the window does not change it.
The turn rate is measured on A and B. So the length is a pure function of the
frame shown at T, the new tour and T, all fixed once T is; nothing a later event
changes is read (tested: a second refit switching 1 s after the first, while
the first turn still runs, leaves every frame before it bit-identical). Frames
stay a pure function of data history, seed, entry view, event times and t. The
entry `transition` is not used for refits.

When A and B are equal or nearly so (a refit that changes nothing: the same
data, or points appended at the mean), the turn is the identity: a principal
angle, or the angle of the turn inside the span, below 1e-6 rad does not turn
(float32 frames carry noise near 1e-7, and dividing by it would only make a
direction out of noise). The frame shown simply continues, finite and
orthonormal, and with `"auto"` the turn takes `refitTransitionMin`. Each plane's direction
off B's span is made orthogonal to all three of B's principal vectors. A
principal vector that comes out reversed (`A'_j = -B'_j`) turns half a turn
through a direction off B's span; at 3-d there is no such direction (no
rotation takes B to A), and the turn is a rotation that does not reach A.
During the turn the turned rows are orthonormalised once, in double precision,
before they are stored as float32; a second pass on the stored rows changes no
entry by more than 1e-6 (tested at 8-d to 1024-d). Tested in
`js/test/modes-refit-hardening.test.js`.

Measured, the largest per-frame change of the frame (Frobenius norm) during
the turn against the largest in the same length of normal running just before
T, sampled at mode-time steps of `speed / 60` (the viewer's speed 1 and 3 give
the same ratios), refit at T = 6 after appending 400 points from the same
distribution or 1,500 points forming a new cluster three radii from the mean:

| Set | Same distribution | New cluster |
|-----|-------------------|-------------|
| 12,288 x 384 | 1.15 (turn 9.1 s) | 1.33 (10.1 s) |
| 12,288 x 1024 | 1.14 (7.2 s) | 1.00 (10.6 s) |
| 4,000 x 1024 | 1.15 (1.5 s) | 1.25 (9.9 s) |

The largest change of any single frame entry, the other measure, was at most
1.48 in the same runs. Tested at 48-d and 128-d for both kinds and both speeds
(`js/test/modes-refit.test.js`, bound 1.4): with the test's seed 3 the ratio
is 1.03 to 1.25, and over seeds 1 to 8 as well it is at most 1.31 (measured
2026-11-14; speed 1 and 3 agree to 0.001).

| Option | Default | Meaning |
|--------|---------|---------|
| `subspace` | 8 | directions the tour moves through (at least 3) |
| `speed` | 0.42 | rad/s, the reference's rate |
| `transition` | 1.5 | seconds to blend in from the entry view (mode entry only) |
| `refitTransition` | `"auto"` | seconds to turn onto a refitted tour; `"auto"` chooses it from the size of the turn (above); a positive number fixes it |
| `refitTransitionMin` | 1.5 | `"auto"` never turns in less than this many seconds |
| `refitTransitionMax` | 12 | nor in more than this many |
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
  refitTransition, refitPending, empty }`. `refitTransition` is the length in
  seconds of the latest refit's turn (from `refitAt`), or `null` before any
  refit.
- `refit(t?) -> stepper` (Tumble only); `mark(t)`.
- Draw: `zoom` auto (below), `wires 0`, `dim 1`, `trails 0.17`, `fog 0`,
  `twinkle 0.18`, `depthOfField 1.1` (the reference's defaults).

## Lattice (`"lattice"`)

One visible axis at a time turns a quarter turn into a hidden direction, using
the reference's eased angle: `ET.math.makeSwapTour(frame0, D, { seed, period })`
where `frame0` is the entry frame (so there is no jump) or a seeded random frame.
The axis swapping in cycle `c` is `c mod 3`.

**Hidden directions come from the strongest directions.** By default
(`hidden: "strongest"`) each hidden direction is drawn inside the span of the
data's `subspace` (8) strongest principal directions, orthogonal to the axes
still shown: the tour is made with `basis` set to the basis of
`ET.math.makeGuidedTour` on the centred vectors (fitted on at most `fitRows`
rows, as Tumble does). The fit is a required part of the preparation, so no
frame is answered before it and the frames depend on data, seed and time only.
`describe()` reports `hidden`, `subspace` and the span's `varianceShare`. With
`hidden: "full"`, with fewer than 4 usable directions, or with a single point,
hidden directions come from the full space, as in the reference, and
`varianceShare` is `null`. Why: in real vectors a direction drawn from the full
space holds almost no variance, and after three swaps the picture was a random
frame (group separation 1.126 against a random baseline of 1.114 on a real
1024-d set, 1.472 with this rule; `docs/evidence/2026-11-14-real-atlas-proof.md`).
The first few hidden directions can carry a small part from outside the span
when the entry frame lies outside it (they are made orthogonal to the axes
still shown); it is gone once those axes have been traded away.

Wires: each of the first `neighbourLimit` points is wired to its
`wireNeighbours` true nearest neighbours **in the full space** among those
points (`ET.math.makeKnn`, exact, run one row at a time until about 1 ms has
passed, at most `sliceRows` rows per unit), deduplicated,
with their true lengths. As in the reference, points with no group get no wires
of their own when any point in the limit has a group (the unstructured halo
stays unwired); they can still be another point's neighbour. When the set has
no groups at all, every point gets wires.

| Option | Default | Meaning |
|--------|---------|---------|
| `period` | 3.4 | seconds per swap (the reference's) |
| `neighbourLimit` | 1000 | only the first this-many points get neighbours (the reference's) |
| `wireNeighbours` | 3 | wires per point (the reference's) |
| `sliceRows` | 16 | at most this many query rows per unit of neighbour work (the reference's); a unit also stops after its first row once 1 ms has passed |
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
- **Long sessions and far seeks.** Hop `h` depends on hop `h - 1` (its stop,
  its frame, the recent stops), so a time far from the hops computed must be
  replayed hop by hop. What is kept is bounded: the last 64 hops computed (stop
  and frame), plus at most 33 checkpoints (a hop's frame and its recent stops),
  one every 16 hops at first, the spacing doubling whenever more than 32 would
  be kept, plus one record (two numbers) per append. A backward seek replays
  from the newest checkpoint before it, so it costs at most one spacing of hops;
  a seek forward costs the hops in between, once, and is not capped: measured
  in node on a 3,000-point set, one hour ahead (750 hops) took 1.1 s at 384-d
  and 2.2 s at 2560-d, and the seek back to hop 400 afterwards 21 ms and 39 ms.
  Normal running computes each hop ahead of need in small pieces, as before.
  Answers equal a fresh instance's whatever the order of queries (tested over
  1,500 hops). `inst.retained() -> { hops, checkpoints, floats, segments,
  hopsComputed }` reports what is kept (for tests). Before, every hop's stop and
  frame were kept for the life of the instance (`3 * D` floats per hop: about
  23 MB per hour at 2560-d).
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
- `statsJob(set) -> { run() -> done, progress(), result }`: the same
  statistics as `stats(set)` (the same object, cached, bit-identical values),
  added about 2^19 values per `run()`, for a stepper task. A set already cached
  finishes in one call. `now()`: the clock the steppers use.
- `requireDimension(set, min, title)`, `holdState(...)`, `changed(work,
  restart)`, `EMPTY_STATUS`: shared by the three modes for the rules above.
- `REFERENCE_RADIUS = 0.963`: the sample set's radius (measured: 0.963 at
  384-d, 0.968 at 1024-d). Distances the reference tuned by eye (fog, Wander's
  zoom) are scaled by `radius / REFERENCE_RADIUS` measured when the mode is
  prepared, so they fit other data; appends do not change the scale.
- `autoZoom(X, N, D, frame, centre, sample?)`: auto-framing over the first
  `sample` (512) points' projected coordinates: `min(0.78 / rms, AUTO_FIT /
  p98)`, where `0.78 / rms` is the reference's rule and `p98` the
  98th-percentile 3-D radius. `AUTO_FIT = 0.88` units leaves room for the group
  names inside the stage's shorter side (the renderer puts its edge at 1.087
  units). An even cloud keeps the reference's framing; on the guided tour,
  where the regions are compact blobs far apart and carry the names, the cap
  holds (measured on the sample set over 120 s: the 98th-percentile screen
  extent fell from up to 1.38 of the half-stage to at most 0.85). A fixed
  sample, so appends past it do not move the framing. Zoom is a draw
  parameter; frames are unchanged. Wander's flight uses its own fixed zoom.
- `makeGlide`, `alignment`, `applyAlignment`, `entryFrom`, `blendDraw`,
  `startFrame`, `thousands`, `isLabelled`, `checkTime`, `stepper`: the pieces
  the three modes share, documented in the source.
- `refitTurn`: Tumble's refit turn, for tests and for a mode written elsewhere.
  `make(A, B, D) -> blend` (A the frame shown, B the new tour's aligned start;
  `blend.rate` is the turn's largest rate per unit of s, `blend.duration` is
  0 until the caller sets it), `apply(blend, s, F, D) -> F` (Q(s) applied to
  the rows of F in place; s = 1 takes B to A, s = 0 is the identity),
  `ease(u)` (the turn's progress curve) and `tourRate(tour, t0)` (the mean
  rate above).

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
  On a restart, drop any work still queued for the earlier entry (an unfinished
  preparation or refit) before queueing `r.work`; the viewer does
  (`js/test/viewer.test.js`: points appended before or in the middle of a
  preparation give the frames of the whole set sent at once, and the view is
  never ready on a fit of the first part).
- **Switching modes while one prepares** is allowed: the old instance is left
  and its stepper dropped (tested through the viewer).
- **Refit (Tumble):** `inst.refit()` (or `refit(clock)`) and pump the stepper;
  with `mark(clock)` each frame the switch happens at the frame the fit
  finished.
- **Wires:** `renderer.setWires` returns a result; a caller that cares checks
  `ok` (see `js/api/30-renderer.md`).

## Measured

Node 24 on the development machine (AMD Ryzen with Radeon 760M, shared with
other jobs), the assembled file, built-in sample set, 12,288 points, each mode
on a freshly validated set in a fresh load of the file (cold code, no cache),
`prepare().step(0)` until done (one unit per call), two runs. Before is the
code before the sliced fit (task "perf"):

| Mode | Set | Longest unit before | Longest unit now | Units now | Ready now |
|------|-----|---------------------|------------------|-----------|-----------|
| Tumble | 384-d | 196 to 199 ms | 3.9 to 5.7 ms | 321 to 325 | 224 to 234 ms |
| Tumble | 1024-d | 474 to 481 ms | 3.4 to 4.3 ms | 850 | 540 ms |
| Tumble refit | 1024-d | 999 to 1,007 ms | 2.0 to 5.1 ms | 811 to 815 | |
| Lattice | 384-d | 12.3 to 12.4 ms | 3.0 to 4.9 ms | 132 to 134 | 16 to 17 ms |
| Lattice | 1024-d | 33 to 36 ms | 2.6 to 4.0 ms | 259 to 260 | 37 ms |
| Wander | 384-d | 13.2 to 14.6 ms | 3.0 to 4.5 ms | 20 | 27 to 32 ms |
| Wander | 1024-d | 33 to 35 ms | 4.2 to 4.8 ms | 41 to 45 | 53 to 56 ms |

Most units take about 0.5 ms; the few of 3 to 6 ms are first runs of code the
engine has not optimised yet and garbage collections, which no slicing
removes. Wander's longest `stateAt` over 20 s (a frame that used to compute a
new stop) went from 13 to 20 ms to 2.0 to 2.4 ms. Total preparation time is
unchanged. Switching modes on the same set reuses the mean and spread (cached
per set).

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

Load of the same demo after the sliced fit, fresh page per mode, AMD Radeon 760M
(ANGLE, Vulkan), `prep.step(8)` per frame, read after the preparation plus 4 s:
the most script time in one frame, before (old code) and now: Tumble 198 / 9.7
ms (384-d) and 502 / 9.2 ms (1024-d); Lattice 13.6 / 10.4 and 22 / 11.3 ms;
Wander 19.8 / 8.8 and 30.8 / 9.8 ms. The longest gap between frames went from
200 and 500 ms (Tumble) to 16.8 ms (one 33 ms gap in one run), 60 fps
throughout. With 8 ms of preparation per frame Tumble is ready after 0.47 s
(384-d) and 1.1 s (1024-d) instead of blocking for 0.2 and 0.56 s; a viewer
that wants it sooner can give preparation more of the frame (about 10 ms still
leaves room for drawing at 60 fps on this machine), and a slow device less.

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
   over the first 512 points rather than the reference's 290 named points,
   capped by the 98th-percentile radius, see `autoZoom`), and
   mode switches blend the frame and draw parameters with a smoothstep over
   1.0 to 1.5 s instead of the reference's exponential mixes.
8. **Distances tuned by eye are scaled to the data**: fog distances and
   Wander's zoom are the reference's values times the set's radius over the
   sample set's (0.963). On the sample set they are the reference's values.
9. **Points per mode are the renderer's**: the reference shrank points with
   fog in Wander through its own shader term; that is now the renderer's `fog`
   parameter (task t6).
