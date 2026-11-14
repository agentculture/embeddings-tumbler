# `ET.math`: the mathematics module

Source: `js/src/10-math.js`. Pure functions, no DOM, no WebGL, safe to call in
node. Reach it as `ET.math` inside the wrapper, or as
`api._internal.math` from tests.

## Shapes and units

| Thing | Representation |
|-------|----------------|
| Vector block | One flat `Float32Array` of length `N * D`, row-major: point `i` is `[i * D, i * D + D)`. This is the data contract's block layout. |
| Dimension `D`, count `N` | Always passed in by the caller. Nothing in the module assumes a dimension. |
| Frame | `Float32Array` of length `3 * D`, row-major. Rows 0, 1, 2 are the x, y and z viewing axes. The rows are orthonormal (every function that returns a frame guarantees `frameError < 1e-5`). |
| Centre | A vector of length `D` (`Float32Array` or `Float64Array`): where the camera sits. |
| Basis | `Float32Array` of length `m * D`, `m` orthonormal rows. |
| Projection | Screen coordinates of point `i` are `(x_i - centre) . F_r` for `r = 0, 1, 2`. Linear; nothing in the module computes a non-linear layout. |
| Time | Seconds (a finite number). |
| Angles, speed | Radians, radians per second. |
| Distances | Euclidean, in the units of the vectors. |
| Seed | A finite number (truncated to an unsigned 32-bit integer) or a string (hashed). |

Determinism: the same inputs and seed give bit-identical outputs in the same
JavaScript engine. (The tour uses `Math.sin` and `Math.cos`, whose last bit the
language standard leaves to the engine, so two different browsers may differ in
the last bits.)

Inputs must be finite. Vectors containing `NaN` or infinities are outside this
module's contract (the loader guarantees finiteness: the data contract refuses
non-finite values); the module makes no promise about what such input yields.

Errors: a malformed call (wrong lengths, ids out of range, bad options) throws.
`RangeError` for bad sizes, counts, ids and options; `TypeError` for a
direction block whose length does not match `rows * D`, and for seeds that are
neither numbers nor strings.

## Seeded random source

- `mulberry32(seed) -> () => number`: the reference's generator; uniform in
  `[0, 1)`.
- `makeRandom(seed) -> { next(), gauss(), fillGauss(arr, offset?, length?) }`:
  uniform and standard normal draws from one seeded stream.
- `toSeed(value) -> uint32`: normalises a number or string seed. Throws
  `TypeError` on anything else.
- `mixSeed(seed, salt) -> uint32`: an independent sub-seed, so that one part of
  a schedule (for example swap cycle `c`) draws from its own stream regardless
  of what was drawn before.

## Centring and variance

- `meanOf(X, N, D) -> Float64Array(D)`.
- `centre(X, N, D, { inPlace }?) -> { mean: Float64Array(D), data: Float32Array(N*D) }`.
  A translation: pairwise distances are unchanged. Cost `O(N * D)`; 31 to 55 ms
  at 10,000 x 1024 in node.
- `totalVariance(Y, N, D) -> number`: mean squared row length of centred data.
- `makeCentre(X, N, D, { inPlace }?) -> stepper` whose `result` is `centre()`'s
  result, bit for bit (see "Sliced work" below).
- `varianceShare(Y, N, D, dirs, rows) -> number in [0, 1]`: share of the total
  variance held by the span of `rows` orthonormal directions. Exact, then
  clamped to `[0, 1]` (rounding can otherwise give 1.00000001 on sets of a few
  points whose span holds all the variance). Use it with
  a frame (`rows = 3`) to report what the current view holds. `rows` must be an
  integer in `1..D` and `dirs.length` must equal `rows * D`, otherwise
  `TypeError`. Returns `0` (not `NaN`) when the data has no variance.

## Frames

- `orthonormalize(M, rows, D) -> M`: Gram-Schmidt in place, twice, in double
  precision. A collapsed row is replaced by a standard basis vector: candidates
  are tried in order of least coverage by the earlier rows (ties to the lower
  index) until one does not collapse, so for any `rows <= D` the result is
  orthonormal (to `1e-5` after rounding to `Float32Array`) and deterministic,
  whatever the input (zero, duplicate or rank-deficient rows). Throws
  `RangeError` when `rows > D`.
- `frameError(M, rows, D) -> number`: largest entry of `|M M^T - I|`.
- `randomFrame(D, rng, out?, rows = 3) -> Float32Array`: uniformly random
  orthonormal rows (Gaussian rows, orthonormalised). This is the baseline a
  uniformly random tour draws from.
- `project(X, N, D, frame, centre | null, out?, rows = 3) -> Float32Array(N * rows)`.
  `frame.length` must equal `rows * D`, `centre` (if given) must have length
  `D`, and `out` (if given) at least `N * rows`; otherwise `TypeError`.

## Principal directions

`principalDirections(Y, N, D, k, opts?)` takes **centred** data and returns:

```js
{
  count: k, dimension: D,
  directions: Float32Array(k * D),  // orthonormal rows, by descending variance
  variances: Float64Array(k),       // exact variance along each returned direction
  shares: Float64Array(k),          // variances / totalVariance
  share: number,                    // sum of shares: the span's share of total variance
  totalVariance: number,
  method: "gram-exact" | "gram-iterative" | "covariance-iterative" | "degenerate",
                                    // plus "-sampled" when sampleRows applied
  iterations: number, converged: boolean, sampledRows: number,
}
```

- `N <= D`: through the `N x N` Gram matrix (exact Jacobi when `N <= 64`,
  otherwise block subspace iteration on it). Gram cost `O(N^2 * D)`.
- `N > D`: block subspace iteration with Rayleigh-Ritz on the covariance,
  applied as `Y^T (Y q)` without forming it. Cost `O(N * D * p)` per iteration,
  `p = k + max(4, k)`.
- `opts`: `seed` (start block), `tolerance` (default `1e-6`, relative change of
  the top-k Ritz values; finite and `>= 0`), `maxIterations` (default 60; an
  integer `>= 0`, where 0 means one application and no refinement),
  `oversample` (default `max(4, k)`; an integer `>= 0`), `sampleRows` (fit on
  that many rows taken at an even stride; variances and shares are still
  computed exactly over all `N` rows). Invalid values throw `RangeError`.
- `k` is clamped into `1..D`: `k < 1` (or not a number) gives one direction,
  `k > D` gives `D`. Centred data has rank at most `N - 1`; when `k` exceeds the
  rank, the extra directions are a deterministic orthonormal completion with
  variance (and share) 0. All points identical, or `N <= 1`, gives method
  `"degenerate"`: standard basis directions, every share 0.
- The variances and shares are always recomputed exactly along the returned
  directions, so the reported share is honest even if iteration stopped early.

- `shares` and `share` are clamped to `[0, 1]`.

Measured in node 24 on the development machine (shared with other jobs, so
the spread is wide), 10,000 x 1024 synthetic data with a decaying spectrum:
`k = 8` took 1.8 to 3.0 s (11 iterations), `k = 3` 0.65 to 1.1 s, and `k = 8`
with `sampleRows: 2000` 0.42 s (share 0.3521 against 0.3552 unsampled). 311 x
1024 (probe size) took 0.08 to 0.16 s. `principalDirections` runs in one call;
on a page use `makePrincipalDirections` (or `makeGuidedTour`) and pump it a few
milliseconds per frame.

`makePrincipalDirections(Y, N, D, k, opts?) -> stepper`: the same fit, sliced.
Its `result` is `principalDirections`'s result with identical bytes, whatever
budgets drove it (tested at budgets of 0, 0.1 ms, 4 ms and unlimited on every
path: covariance, sampled, Gram exact, Gram iterative, degenerate). Arguments
are checked when it is made, with the same errors.

## Sliced work

`makeCentre`, `makePrincipalDirections`, `makeGuidedTour` and `makeLocalFrame`
return a stepper:

```js
{
  step(budgetMs?) -> done,   // run units until budgetMs ms have passed (always at
                             // least one, so step(0) runs exactly one); step() runs to the end
  done: boolean,
  progress: number,          // 0..1, an estimate from the work done; 1 when done
  result: null | ...,        // the blocking call's return value once done
}
```

The computation is written once (generator functions that pause between small
pieces of work) and the blocking functions run the same code without pausing,
so a stepper's result equals the blocking call's bit for bit. A unit ends after
about 2^20 multiply-adds, or earlier once 1 ms has passed (memory-bound loops
and code the engine has not optimised yet are slower per multiply-add); the
clock decides only where a unit ends, never what is computed. After `done`,
`step` returns `true` and does nothing.

Largest single unit, node 24 on the development machine (AMD Ryzen with Radeon
760M, shared with other jobs), built-in sample set centred, `makeGuidedTour`
with `subspace: 8`, `step(0)` until done:

| Set | `sampleRows` | Blocking `guidedTour` | Units | Largest unit |
|-----|--------------|-----------------------|-------|--------------|
| 12,288 x 384 | 4,096 | 213 ms | 299 | 2.1 ms |
| 12,288 x 384 | none | 402 ms | 743 | 1.4 ms |
| 12,288 x 1024 | 4,096 | 428 ms | 770 | 1.5 ms |
| 12,288 x 1024 | none | 1,037 ms | 2,046 | 2.4 ms |
| 10,500 x 1024 | 4,096 | 412 ms | 753 | 1.6 ms |
| 10,500 x 1024 | none | 890 ms | 1,746 | 1.4 ms |

Total time is the blocking call's give or take noise (the pauses cost nothing
measurable). Note for tests: `loadSources` runs the modules through node's own
`require()` in node's ordinary global context, so `performance` is present and
the code runs at the assembled file's speed (a 3,000 x 384 `guidedTour` took
2.0 to 2.2 s either way, three runs each, 2026-11-14). Still measure with the
assembled file, which is what ships.

## The guided tour (Tumble)

- `guidedTour(Y, N, D, opts?) -> tour`. `Y` is centred data. Computes the top
  `subspace` principal directions (default 8) and tours inside their span.
  `opts`: `seed` (default 0), `subspace` (default 8, at least 3, at most `D`),
  `speed` (default 0.42 rad/s, the reference's rate), `pca` (a previous
  `principalDirections` result with at least `subspace` rows, to reuse), and
  `sampleRows`, `maxIterations`, `tolerance`, `oversample`, which are passed to
  `principalDirections` unchanged (and validated there).
- `makeGuidedTour(Y, N, D, opts?) -> stepper` whose `result` is the tour
  `guidedTour` returns, bit for bit (same frames at every time). With a usable
  `pca` given it finishes in one unit. The tour's `varianceShare` is clamped to
  `[0, 1]`.
- `makeTour(basis, m, D, opts?) -> tour`: the same tour over any orthonormal
  `basis` of `m >= 3` rows. `opts`: `seed`, `speed`.

A tour object:

```js
{
  kind: "guided-tour", seed, speed, dimension: D, subspace: m,
  basis: Float32Array(m * D),        // the directions the tour moves through
  frequencies: Float64Array(floor(m / 2)),
  frameAt(t, out?) -> Float32Array(3 * D),   // the frame at t seconds
  coefficientsAt(t, out?) -> Float64Array(3 * m), // the frame in basis coordinates
  // guidedTour only:
  varianceShare: number,             // share held by the whole m-direction subspace
  variances: Float64Array(m), totalVariance: number, pca: {...},
}
```

`frameAt(t)` is a closed-form function of `(basis, seed, speed, t)`: a seeded
rotation of the `m`-dimensional subspace turning `floor(m / 2)` planes at seeded
frequencies. It keeps no state, so the frame at a given time is the same however
time was sliced (one call at 10 s equals 625 calls of 16 ms each, bit for bit).
At `t = 0` the frame is the first three basis rows (for `guidedTour`, the top
three principal directions). About 0.1 ms per call at `D = 1024`, `m = 8`.

`varianceShare` is the share of the total variance held by the whole
`m`-direction subspace the tour moves through over time. It is what the
provenance block must state: "the directions this tour moves through hold X% of
the variance". It is not the share of the three directions on screen at one
instant; that is `varianceShare(Y, N, D, tour.frameAt(t), 3)`, which is never
more than `varianceShare` (the frame lies inside the subspace). With no
variance in the data it is `0` and the frames are still orthonormal.

## Axis swap (Lattice)

- `hiddenDirection(frame, D, rng, basis?, m?, out?) -> Float32Array(D)`: a unit
  vector orthogonal to the frame, drawn inside `basis` (`m` orthonormal rows)
  when it is given and leaves room, otherwise in the full space. `frame` must
  be orthonormal (any frame this module returns is). Needs `D >= 4`.
- `swapAngle(u)`: the reference's eased quarter turn,
  `(pi/2)(u - sin(2 pi u) / (2 pi))`, `u` clamped to `[0, 1]`.
- `swapStep(start, axis, hidden, u, D, out?) -> frame`: pure. Row `axis` becomes
  `cos(theta) start[axis] + sin(theta) hidden`; at `u >= 1` it is exactly
  `hidden`.
- `makeSwapTour(frame0, D, opts?) -> { frameAt(t, out?), stateAt(t), hiddenAt(t), seed, period, dimension, kind: "axis-swap" }`.
  `opts`: `seed`, `period` (default 3.4 s, the reference's), `basis` and
  `basisRows` (given together: `basisRows` an integer in `3..D` and
  `basis.length === basisRows * D`, otherwise `RangeError`; without `basis`
  hidden directions come from the full space). Cycle `c = floor(t / period)`
  turns axis `c mod 3` into a hidden direction drawn from
  `makeRandom(mixSeed(seed ^ SALT_SWAP, c))`, where `SALT_SWAP` is a fixed
  internal constant. Calls may come in any time order (forwards, backwards,
  repeated); each answer equals what a fresh tour gives. `stateAt(t)` returns
  `{ cycle, axis, u }`. Pure in `t`: going backwards in time replays from the
  nearest kept cycle start at or before the target (a replay gives the same
  bits as one from `frame0`). It keeps at most 33 cycle starts (`3 * D` floats
  each): one every 16 cycles at first, the spacing doubling whenever more than
  32 would be kept, so a backward seek costs at most one spacing of cycles
  (for a tour at hour ten, about 330 cycles) and memory stays bounded. A seek
  forward costs the cycles in between, once. Measured in node (seed 1, period
  3.4 s): ten hours ahead at 2560-d with hidden directions from the full space,
  12 s once (1.1 ms per cycle); with an 8-row basis (Lattice's default), one
  hour ahead at 2560-d took 0.16 s. `steps()` (swap steps computed in all) and
  `checkpoints()` (cycle starts kept) are for tests. `D >= 4` required.

## True nearest neighbours

- `makeKnn(X, N, D, k, { limit }?) -> stepper` and `knn(...)` (the same, run to
  completion).

```js
{
  k, count, dimension,          // count = limit (default N); k clamped to 0..count - 1
  indices: Int32Array(count * k),     // row i: neighbours of point i, nearest first
  distances: Float32Array(count * k), // Euclidean, in the full D-dimensional space
  next, done,
  step(rows?) -> done,          // process the next `rows` query points (all if omitted)
}
```

Exact, not approximate: every pair among the first `limit` points is measured
in all `D` dimensions. Ties go to the lower index. Cost `O(limit^2 * D)`
multiply-adds in total, `O(limit * D)` per query row, with an exact early exit
once a partial sum exceeds the current k-th best. Duplicate points are
neighbours at distance 0. With `k = 0` (asked for, or `count <= 1`) the stepper
starts with `done: true` and does no work. Call `step(16)` once per
animation frame (or timer tick) to keep a page responsive, as the reference
does. Measured in node: `limit = 1000`, `D = 1024`, `k = 24` took 0.73 to 1.2 s
in total; one 16-row step 12 to 20 ms.

## Local frames and alignment (Wander)

- `localFrame(X, N, D, ids, out?) -> frame`: top three principal directions of
  the points `ids` (a point and its neighbours, for example from `knn`). Every
  id must be an integer in `0..N-1` and there must be at least one, otherwise
  `RangeError`. Computed from
  their Gram matrix by exact Jacobi. Deterministic; orthonormal even if the
  neighbourhood has rank below three. Cost `O(M^2 * D + M^3)` for `M` ids.
  `makeLocalFrame(X, N, D, ids, out?) -> stepper` gives the same frame in
  small units (a first call on a page runs in code the engine has not
  optimised yet: about 15 ms in one piece at `M = 25`, `D = 1024`).
- `alignTo(target, ref, D) -> frame`: reorder and flip target's axes so that the
  flight from `ref` twists as little as possible (ported; ties go to a fixed
  permutation order).
- `smoothstep(u)`: `u^2 (3 - 2u)`, clamped.
- `blendFrames(from, to, e, D, out?) -> frame`: the reference's flight. Blend
  row by row with weight `e`, then re-orthonormalise. Pure.

## Group separation

- `groupSeparation(P, N, dim, groups) -> number`: the mean distance over pairs
  in different groups divided by the mean distance over pairs in the same group
  (the probe's measure; 1.0 means no visible grouping). `P` is `N` points of
  `dim` coordinates (full space or projected). Labels `""`, `null` and
  `undefined` are ungrouped and left out. `NaN` when there are no within- or
  no between-group pairs. When every same-group pair coincides (mean within
  distance 0): `Infinity` if the groups are apart, `1` if every grouped point
  coincides. Cost `O(N^2 * dim)`.
- `frameSeparation(Y, N, D, frame, groups) -> number`: the same, seen through a
  frame.
