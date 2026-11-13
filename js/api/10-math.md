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
- `varianceShare(Y, N, D, dirs, rows) -> number in [0, 1]`: share of the total
  variance held by the span of `rows` orthonormal directions. Exact. Use it with
  a frame (`rows = 3`) to report what the current view holds.

## Frames

- `orthonormalize(M, rows, D) -> M`: Gram-Schmidt in place, twice, in double
  precision. A collapsed row is replaced by the least covered standard basis
  vector, so the result is always orthonormal and deterministic. Throws
  `RangeError` when `rows > D`.
- `frameError(M, rows, D) -> number`: largest entry of `|M M^T - I|`.
- `randomFrame(D, rng, out?, rows = 3) -> Float32Array`: uniformly random
  orthonormal rows (Gaussian rows, orthonormalised). This is the baseline a
  uniformly random tour draws from.
- `project(X, N, D, frame, centre | null, out?, rows = 3) -> Float32Array(N * rows)`.

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
  the top-k Ritz values), `maxIterations` (default 60), `oversample`,
  `sampleRows` (fit on that many rows taken at an even stride; variances and
  shares are still computed exactly over all `N` rows).
- The variances and shares are always recomputed exactly along the returned
  directions, so the reported share is honest even if iteration stopped early.

Measured in node 24 on the development machine (shared with other jobs, so
the spread is wide), 10,000 x 1024 synthetic data with a decaying spectrum:
`k = 8` took 1.8 to 3.0 s (11 iterations), `k = 3` 0.65 to 1.1 s, and `k = 8`
with `sampleRows: 2000` 0.42 s (share 0.3521 against 0.3552 unsampled). 311 x
1024 (probe size) took 0.08 to 0.16 s. It runs in one
call; a host that cannot block the page that long should pass `sampleRows` or
call it off the main thread.

## The guided tour (Tumble)

- `guidedTour(Y, N, D, opts?) -> tour`. `Y` is centred data. Computes the top
  `subspace` principal directions (default 8) and tours inside their span.
  `opts`: `seed` (default 0), `subspace` (default 8, at least 3, at most `D`),
  `speed` (default 0.42 rad/s, the reference's rate), `sampleRows`, `pca`
  (a previous `principalDirections` result with at least `subspace` rows, to
  reuse).
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
  varianceShare: number,             // share of total variance held by the basis span
  variances: Float64Array(m), totalVariance: number, pca: {...},
}
```

`frameAt(t)` is a closed-form function of `(basis, seed, speed, t)`: a seeded
rotation of the `m`-dimensional subspace turning `floor(m / 2)` planes at seeded
frequencies. It keeps no state, so the frame at a given time is the same however
time was sliced (one call at 10 s equals 625 calls of 16 ms each, bit for bit).
At `t = 0` the frame is the first three basis rows (for `guidedTour`, the top
three principal directions). About 0.1 ms per call at `D = 1024`, `m = 8`.

`varianceShare` is what the provenance block must state: "the directions this
tour moves through hold X% of the variance".

## Axis swap (Lattice)

- `hiddenDirection(frame, D, rng, basis?, m?, out?) -> Float32Array(D)`: a unit
  vector orthogonal to the frame, drawn inside `basis` when it is given and
  leaves room, otherwise in the full space.
- `swapAngle(u)`: the reference's eased quarter turn,
  `(pi/2)(u - sin(2 pi u) / (2 pi))`, `u` clamped to `[0, 1]`.
- `swapStep(start, axis, hidden, u, D, out?) -> frame`: pure. Row `axis` becomes
  `cos(theta) start[axis] + sin(theta) hidden`; at `u >= 1` it is exactly
  `hidden`.
- `makeSwapTour(frame0, D, opts?) -> { frameAt(t, out?), stateAt(t), hiddenAt(t), seed, period, dimension, kind: "axis-swap" }`.
  `opts`: `seed`, `period` (default 3.4 s, the reference's), `basis`,
  `basisRows`. Cycle `c = floor(t / period)` turns axis `c mod 3` into a hidden
  direction drawn from `mixSeed(seed, c)`. `stateAt(t)` returns
  `{ cycle, axis, u }`. Pure in `t`: going backwards in time replays from
  `frame0` (cheap: about `5 * D` operations per cycle). `D >= 4` required.

## True nearest neighbours

- `makeKnn(X, N, D, k, { limit }?) -> stepper` and `knn(...)` (the same, run to
  completion).

```js
{
  k, count, dimension,          // count = limit (default N); k clamped to count - 1
  indices: Int32Array(count * k),     // row i: neighbours of point i, nearest first
  distances: Float32Array(count * k), // Euclidean, in the full D-dimensional space
  next, done,
  step(rows?) -> done,          // process the next `rows` query points (all if omitted)
}
```

Exact, not approximate: every pair among the first `limit` points is measured
in all `D` dimensions. Ties go to the lower index. Cost `O(limit^2 * D)`
multiply-adds in total, `O(limit * D)` per query row, with an exact early exit
once a partial sum exceeds the current k-th best. Call `step(16)` once per
animation frame (or timer tick) to keep a page responsive, as the reference
does. Measured in node: `limit = 1000`, `D = 1024`, `k = 24` took 0.73 to 1.2 s
in total; one 16-row step 12 to 20 ms.

## Local frames and alignment (Wander)

- `localFrame(X, D, ids, out?) -> frame`: top three principal directions of
  the points `ids` (a point and its neighbours, for example from `knn`), from
  their Gram matrix by exact Jacobi. Deterministic; orthonormal even if the
  neighbourhood has rank below three. Cost `O(M^2 * D + M^3)` for `M` ids.
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
  no between-group pairs. Cost `O(N^2 * dim)`.
- `frameSeparation(Y, N, D, frame, groups) -> number`: the same, seen through a
  frame.
