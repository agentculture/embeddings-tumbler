# `ET.searchSets`: several searches at once (`js/src/26-search-sets.js`)

Status: **implemented** (task t3), from the interface written before the code
(task t1). The clarifications t3 added are listed under "Clarifications from
the build" at the end. One search's
ranking is `js/api/24-search.md`; the rest of the search interface is
`docs/search-interface.md`.

Pure JavaScript: no DOM, no WebGL, no network, and no unseeded randomness. The
only random numbers come from `ET.math.makeRandom` on a seed derived from the
view seed. Reach it as `ET.searchSets` inside the wrapper, or as
`api._internal.searchSets` from tests. It reads `ET.math` and `ET.search` at
call time.

## Terms

- **A search** here is what the viewer holds for one line of the panel or one
  entry of `setSearches`: a checked query vector and its ranking
  (`js/api/24-search.md`, "Shapes and units"). Up to `MAX_SEARCHES` (4) are
  active at once. Search `j` (0-based, in the order given) has the letter
  `letter(j)`: `A`, `B`, `C`, `D`.
- **Named results** of a search are its `hits` (after reranking, when a
  reranker ran). "Named" is the reference's word: they are listed by name in the
  panel and joined to the query by a link.
- **The result radius** of a search is its ranking's `radius`: the distance of
  its farthest named result. A point is **inside** a search when its distance
  to that search's query, in that search's measure, is at most the radius.
  (The sky reference: "every point as near as the last named result".)
- **The lit value** of a point is a number in `[0, 1]`: how strongly it is lit
  by the active searches. 0 is dimmed. The renderer takes it per point
  (`docs/search-interface.md`, "Renderer").
- **The shared mark** is on a point that is inside two or more searches and is
  lit. It is drawn white on a dark stage (and as dark ink on the light stage).
- **The point of view** of one chosen search: each dimension scaled by the
  absolute value of that search's query vector, `|q[d]|`. It is linear (a
  per-dimension scale), and it belongs to one search at a time.

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `ET.searchSets.MAX_SEARCHES` | `4` | most searches active at once |
| `ET.searchSets.LETTERS` | `["A", "B", "C", "D"]` | search letters, by position; frozen |
| `ET.searchSets.LIT_SETTINGS` | `["even", "close", "named"]` | the lit settings, in menu order; frozen |
| `ET.searchSets.DEFAULT_LIT` | `"even"` | the lit setting when none is chosen (the reference's first option) |
| `ET.searchSets.LIT_THRESHOLD` | `0.02` | a point counts as lit when its lit value is above this (the reference's) |
| `ET.searchSets.CLOSE_REACH` | `2.2` | "by closeness" fades out at `near + (radius - near) * CLOSE_REACH` (the reference's) |
| `ET.searchSets.CLOSE_POWER` | `1.6` | the exponent of the closeness fade (the reference's) |
| `ET.searchSets.FACE_SALT` | `0x46414345` | salt mixed into the view seed for the facing frame's random start (`ET.math.mixSeed`) |
| `ET.searchSets.FACE_ITERATIONS` | `25` | power iterations per spread axis of the facing frame (the reference's) |
| `ET.searchSets.FACE_ZOOM` | `0.7` | the facing frame's zoom is `FACE_ZOOM / reach` (the reference's) |

<!-- interface-names module="26-search-sets.js" object="ET.searchSets" match="constants" task="t3" prefix="ET.searchSets." -->
```text
MAX_SEARCHES
LETTERS
LIT_SETTINGS
DEFAULT_LIT
LIT_THRESHOLD
CLOSE_REACH
CLOSE_POWER
FACE_SALT
FACE_ITERATIONS
FACE_ZOOM
```

## Functions

<!-- interface-names module="26-search-sets.js" object="ET.searchSets" match="exact" task="t3" prefix="ET.searchSets." -->
```text
letter
litSetting
scaleFor
litValues
pairReports
makeFacingFrame
facingFrame
```

`ET.searchSets` publishes exactly these functions and the constants above
(`js/test/search-interface-docs.test.js` checks the names once the module
exists).

### `ET.searchSets.letter(j) -> string`

`LETTERS[j]`. Throws `RangeError` for `j` outside `0 .. 3` or not an integer.

### `ET.searchSets.litSetting(value) -> "even" | "close" | "named"`

`value` when it is one of `LIT_SETTINGS`, otherwise `DEFAULT_LIT`. Never throws.

### `ET.searchSets.scaleFor(vector) -> Float32Array(D)`

The point-of-view scale of a query: `|vector[d]|` for every `d`, as a new
array (any array or typed array is read; anything without a `length` throws
`TypeError`). Pass it as `scale` to `ET.search.makeRank` for the one search the option
belongs to, and to `makeFacingFrame`. With the scale, ranking and the shown
distances are cosine distances between `x * s` and `q * s` (element-wise), which
is "scale every dimension by the query's own size there, renormalise, then
rank" of the Focus reference, since cosine ignores length. Scaling is never
applied to another search's ranking: each search's ranking is made with its own
options, and only the search the option belongs to gets a scale.

### `ET.searchSets.litValues(searches, count, setting) -> object`

What is lit, for the active searches. `searches` is an array of 0 to 4
rankings (`js/api/24-search.md`), in letter order; `count` is the number of
points in the view now; `setting` passes through `litSetting`. Throws
`RangeError` for more than `MAX_SEARCHES` searches or a `count` that is not a
non-negative integer, and `TypeError` when `searches` is not an array.
Blocking: it is `O(count x searches)` with no per-dimension work. Measured
(node 24, development machine under load, 10,000 points, four searches of 20
results, 15 runs): median 0.21 ms evenly, 0.37 ms by closeness, 0.12 ms named
only; the slowest single run 1.3 ms (under a load average of about 32: medians
0.3, 0.7 and 0.3 ms, slowest 6.6 ms).

Returns:

```js
{
  lit: Float32Array(count),     // lit value per point, in [0, 1]
  shared: Uint8Array(count),    // 1 where the shared mark is drawn, else 0
  inside: Uint8Array(count),    // how many searches each point is inside (0 to 4)
  insideCounts: number[],       // per search, how many points are inside it
  litCount,                     // points with lit value above LIT_THRESHOLD
  sharedCount,                  // points with shared = 1
}
```

Per search `s` with distances `d`, nearest named distance `near` and result
radius `radius`, and per point `i`:

- **inside**: `d[i] <= radius`.
- **`"even"`** (the results, evenly): the value is 1 when inside, else 0.
- **`"close"`** (by closeness, nearer is brighter): with
  `reach = near + (radius - near) * CLOSE_REACH + 1e-6`, the value is
  `clamp(1 - (d[i] - near) / (reach - near), 0, 1) ^ CLOSE_POWER`. It never increases with distance, so for one
  search a nearer point is never dimmer than a farther one; it is 1 at the
  nearest named result and fades to 0 a little beyond the last one.
- **`"named"`** (named results only): the value is 1 for the search's hits and
  0 for every other point.

Then for every point: `lit[i]` is the largest value over the searches;
`inside[i]` counts the searches it is inside; `shared[i]` is 1 when
`inside[i] >= 2` and `lit[i] > 0`. So a point is marked shared only when it lies inside
the result radius of two or more searches, as the honesty condition requires;
under `"named"` that also means it is a named result of one of them.

A ranking made before an append covers fewer points than `count`: points past
the end of its `distances` count as not inside it and get 0 from it. With no
searches, every array is zeros and both counts are 0 (the viewer does not
upload that; it clears the renderer's lit buffer instead, see
`docs/search-interface.md`).

### `ET.searchSets.pairReports(set, searches) -> Pair[]`

The report for each pair of searches, in order (A and B, A and C, ..., C and D).
`searches` are rankings as for `litValues`. Each pair:

```js
{
  a, b,              // positions of the two searches (a < b); letter(a), letter(b) name them
  shared,            // points inside both searches' result radii
  common,            // named results the two searches have in common (same point index)
  commonIndices,     // those points' indices, in a's rank order
  closest,           // null, or { a: index, b: index, distance }
}
```

`closest` is the closest pair of **different** named results, one from each
search (a hit of `a` and a hit of `b` that are not the same point), by plain
cosine distance between the two loaded points in the full space; ties go to
the earlier hit of `a`, then the earlier hit of `b`. It is `null` when there is
no such pair: one side has no named results, or both sides have only one and
it is the same point. (Two searches with the same several results still have a
closest pair: two different results, one from each list, as in the sky
reference.) The distance is `1 - clamp(x . y / (|x| |y|), -1, 1)` in double
precision, and a zero row is at distance 1 from everything, as in
`js/api/24-search.md`. A hit whose `index` is not a row of `set` throws
`RangeError`. Decided here: the plain measure,
because a pair compares two searches and the point-of-view scaling belongs to
one search only. Cost: at most `k_a x k_b` dot products of `D` per pair (20 x
20 x 6 pairs at 1,024-d is about 2.5 million multiply-adds), plus one pass over
the two searches' `distances` per pair for `shared`. It is blocking. Measured
(node 24, development machine under a load average of about 18 on 12 cores,
10,000 points of 1,024 dimensions, four searches of 20 results, 15 runs):
median 2.5 ms, fastest 2.1 ms, slowest 7.7 ms (the first, cold run). Measured
again under a load average of about 32 (two runs of 15): medians 3.4 and 4.4 ms,
slowest 9.5 and 14.3 ms, again the cold first call each time. The typical call
is well inside one frame's 8 ms budget, and it runs once per change of the
searches, not every frame, so it stays a single call, not a stepper. If the
viewer finds the cold first call costs a long frame in practice, slicing it
the way the facing frame is sliced is the remedy.

### `ET.searchSets.makeFacingFrame(set, searches, options?) -> stepper`

The linear view that faces the searches: three orthonormal directions whose
first axes join the centres of the searches. `searches` is an array of 1 to 4
`{ query, hits }` (the checked query vector, `Float32Array(D)`, and its named
results as in a ranking). Options:

| Option | Default | Meaning |
|--------|---------|---------|
| `seed` | `1` | the view seed (`ET.math.toSeed` reads it) |
| `current` | `null` | `Float32Array(3 * D)`: the frame shown now; each axis is flipped to the shorter turn from it |
| `scale` | `null` | `Float32Array(D)`: the point-of-view scale of the one search the option belongs to; the picture is then fitted in that search's context |

The stepper follows the `ET.math` convention (`step(budgetMs?) -> done`,
`done`, `progress`, `result`), its units stay under 4 ms on 1,024-d, and its
result is identical bit for bit whatever the budgets and on every fresh run
with the same set, searches, seed, `current` and `scale`. Throws `RangeError`
when `D < 3` or there are more than 4 searches, or a hit's `index` is not a row
of `set`; throws `TypeError` when `searches` is not an array, a query does not
have `D` values, a search has no `hits` array, `scale` is given and is not a
`Float32Array(D)`, `current` is given and is not a `Float32Array(3 * D)`, or the
seed is neither a number nor a string. With no searches its result is `null` at
once (the stepper is made already done).

A unit of the stepper ends after 2^17 multiply-adds, counted, not timed, so the
pauses fall at the same places on every run and the clock decides only how many
units one `step` runs. Measured (node 24, same machine and load, 10,000 x 1,024,
searches of 20 results, `step(0)` until done, 5 runs each):

| Searches | Spread axes | Blocking call (median) | Units | Largest unit |
|----------|-------------|------------------------|-------|--------------|
| 1 | 3 | 5.0 ms | 26 | 1.8 ms |
| 1, scaled | 3 | 3.0 ms | 26 | 0.2 ms |
| 2 | 2 | 3.7 ms | 35 | 0.2 ms |
| 2, scaled | 2 | 3.6 ms | 35 | 0.9 ms |
| 4 | 0 | 1.3 ms | 2 | 0.6 ms |
| 4, scaled | 0 | 0.6 ms | 2 | 0.6 ms |

Measured again under a load average of about 32 (after a refactor that changes
no result): blocking medians 5.0 to 6.8 ms with spread axes and 1.4 to 1.9 ms
without, the largest unit 2.8 ms over every case.

The result:

```js
{
  frame: Float32Array(3 * D),   // three orthonormal rows (frameError < 1e-5), as the modes' frames
  centre: Float32Array(D),      // the middle of the searches' centres, unscaled
  zoom,                         // FACE_ZOOM / reach
  fromCentres,                  // how many axes came from the centres (0 to 3)
  fromSpread,                   // how many from the spread of the rows
  fromBasis,                    // how many from the fallback basis (degenerate cases)
}
```

The procedure, all sums in double precision:

1. Let `s` be `scale`, or all ones. Every vector `v` below is used as `v * s`
   (element-wise, not renormalised) while fitting.
2. For each search `j`, its rows are its query and its named results' vectors;
   its centre `c_j` is their mean. `mid` is the mean of the centres.
3. Axes are accepted one at a time by Gram-Schmidt against the axes so far
   (twice). A candidate is accepted when what is left has a norm above `1e-6`
   times its norm before, and is then normalised.
4. **From the centres:** for `j = 1, 2, ...` while fewer than 3 axes,
   candidate `c_j - c_0`. With two searches the first axis joins them; with
   three or four, the first two or three axes span their centres.
5. **From the spread:** while fewer than 3 axes, a power iteration on the
   spread of every row about its own search's centre: start from
   `ET.math.makeRandom(ET.math.mixSeed(ET.math.toSeed(seed), FACE_SALT +
   axesSoFar)).fillGauss(v)`, then `FACE_ITERATIONS` times: `w = sum over rows
   of ((r - c_r) . v) (r - c_r)`, remove the accepted axes from `w`, normalise
   (stop early if `w` is zero), `v = w`. Offer `v` as the candidate. "Zero"
   means what is left after removing the axes is no longer than `1e-6` times
   `w` before the removal (the acceptance rule of step 3); there is then no
   candidate, and step 6 applies.
6. **Fallback:** if a spread candidate is refused (or there is none), offer
   the standard basis vectors `e_0, e_1, ...` in order until one is accepted. So a frame always exists for
   `D >= 3` and the swing is always defined. Decided here: the reference gives
   up (no frame) in this case; a fixed basis keeps the result deterministic.
7. **Back to the loaded vectors:** with a scale, each fitted axis `a` becomes
   `a * s`, and the three are orthonormalised again in order (twice, double
   precision; a degenerate one is replaced by the fallback rule and counted in
   `fromBasis` instead of where it came from). Projecting a
   loaded point `x` on `a * s` is projecting `x * s` on `a`, so the picture is
   the fitted view of the scaled space, made orthonormal so that it is one
   linear frame applied to every point alike, as the renderer and the honesty
   condition require. Without a scale nothing changes in this step.
8. **Signs:** each row is negated when its dot product with the same row of
   `current` is negative (the shorter turn from the view shown).
9. **Centre and zoom:** `centre` is the mean of the unscaled centres (the
   renderer subtracts it from loaded, unscaled vectors). `reach` is the largest
   length of `frame (r - centre)` over every row `r`, at least `1e-3`; `zoom` is
   `FACE_ZOOM / reach`. The renderer's `radius` (0.46) is the reference's, so
   the framing matches it.

The facing frame is an input to the modes (`face`, `docs/search-interface.md`)
and to Focus; it is not computed in the modes.

### `ET.searchSets.facingFrame(set, searches, options?) -> result | null`

`makeFacingFrame(set, searches, options)` run to the end in one call.

## Clarifications from the build

Task t3 added these while implementing the page; none changes a formula above.

1. The closest pair is `null` only when no two different named results exist
   (one side has none, or both have the same single one). The interface first
   said "every named result in common", which is not the same: two searches
   with the same several results still pair two different ones, as the sky
   reference does.
2. In step 5, "`w` is zero" is read with the acceptance rule of step 3 (what is
   left after removing the axes is at most `1e-6` of `w`). Without it, rounding
   noise left after the removal would be normalised and accepted as an axis
   when the data gives none, which decision 8 of `docs/search-interface.md`
   rules out.
3. The basis fallback (step 6) applies to spread candidates only. A refused
   centre join (two searches with the same centre, or three whose centres lie
   on a line) is skipped, and the spread fills in, as in the reference.
4. In step 7, an axis replaced by the basis rule is counted in `fromBasis`, so
   `fromCentres + fromSpread + fromBasis` is always 3.
5. Errors for malformed arguments are listed under each function (`TypeError`
   for wrong shapes, `RangeError` for out-of-range values and indices).
6. `litValues` under `"named"` skips a hit whose index is not below `count`.
