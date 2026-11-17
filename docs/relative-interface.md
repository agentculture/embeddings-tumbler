# Relative search interfaces

Status: **interface, written before any code** (task t1 of
`docs/plans/2026-11-16-relative-search-in-the-embedding-viewer.md`). Every later
task of that plan builds against this page. It gives the names and signatures
each task adds, where the controls live, the setting names on the handle, the
web component and the standalone page, every string shown on screen, how the
faint brightness gradient reaches the renderer, what a search from a point does,
and which task proves each obligation. A task that needs something this page
does not give stops and reports it; it does not work around it. Where the spec
left a choice open, this page decides it and says so ("Decided here"), with the
reason; the decisions are collected at the end.

The binding inputs are the spec
`docs/specs/2026-11-16-relative-search-in-the-embedding-viewer.md`, its
obligations page (the file of the same name ending `-obligations.md`) and the
reference page `docs/specs/reference/tumbler-relative-search.html`. Where this
page copies a number or a string from the reference page it says so; every
place where the build differs from the reference on purpose is listed under
"Differences from the reference page decided here", for task t15.

## How the names on this page are checked

`js/test/relative-interface-docs.test.js` reads three kinds of block from this
page and checks them against the source modules (`js/src/`, loaded afresh with
`loadSources()`, which is what the assembled file is made from; the assembled
file itself is rebuilt only at merge, so the sources are what a task can
change):

- `interface-names` blocks: function or constant names that a module publishes
  on an object (`ET.math`, `ET.renderer`, `ET.renderer.DEFAULTS`,
  `ET.relativeOverlay`, `ET.searchPanel`, a mounted viewer's `handle`, a
  `mode:tumble` instance). `match="present"` means each name is a function
  member; `match="constants"` means each name is a member that is not a
  function.
- `interface-strings` blocks: on-screen strings, one per line, with
  `{placeholders}`. The text between placeholders must appear, character for
  character, in at least one of the listed source files. **Keep each fixed
  piece of a string whole in the source** (write `"relative to " + letters`,
  not `"relative" + " to "`), and write the characters as they are (`·`, `…`,
  `×`), not as `\u` escapes.
- `interface-text` blocks: literal pieces of text that must appear in a file
  outside `js/src/` (the web component shell and the standalone page).

Every block carries `task` (the task that adds it) and `landed`:

- `landed="auto"` (every block on this page as t1 leaves it): the block is
  skipped while **none** of its names exists yet (for `interface-strings` and
  `interface-text`: while the **first** line is not found). As soon as one name
  (or the first line) exists, every name in the block must exist, so a task
  that lands half a block fails the test.
- `landed="yes"`: the block is always checked; a missing name fails.
- A block whose module file does not exist yet is skipped.

**What a later task does:** when your task lands the names of a block, change
that block's `landed="auto"` to `landed="yes"` in this page in the same commit,
so that removing a name later fails loudly instead of skipping. The test also
checks that every block names an owning task, that every listed function is
documented on this page under its prefix, and that every obligation o1 to o15
appears in the table under "Which task proves which obligation".

## Where this starts (read from the code, 2026-11-16)

- Tumble's frame is `tour.frameAt(t)` of a guided tour inside the 8 strongest
  principal directions of the centred set, its centre glides to the set's mean
  (`js/src/40-mode-tumble.js`, `centreTau`), and its zoom is `autoZoom`'s
  rule. Nothing in it is measured from a search or from the origin.
- `ET.math.makeTour(basis, m, D, opts)` always returns three rows and needs
  `m >= 3` (`js/src/10-math.js`).
- The renderer's perspective is the constant `3.0 / max(0.6, 3.0 + z2)` in the
  vertex shader's `place()` and `3 / Math.max(0.6, 3 + z2)` in its JavaScript
  twins `ET.renderer.place` and `ET.renderer.placer`
  (`js/src/30-renderer.js`). There is no draw key for it.
- The viewer's pitch is `0.16 + drag.pitch` (`drawState` in
  `js/src/50-viewer.js`), so the stage is always tilted a little unless the
  person drags it level.
- The viewer calls a mode's `searchChanged(search, t)` whenever the searches
  or their results change, **for any mode that has the member**
  (`notifyModeSearch`); today only Focus has it. It calls `face` on a new
  search for any mode that has it.
- Letters are given by position: `q.letter = ET.searchSets.letter(j)` for the
  `j`-th search kept (`js/src/50-viewer.js`, the run), so removing the first of
  two searches turns B into A. The panel colours a search by its position
  (`p.colours[j]` in `js/src/45-search-panel.js`).
- The viewer never draws text on a canvas: labels are DOM spans (its fake 2-D
  context throws on `fillText`), and the search panel puts its result labels
  in `div.tumbler-search-labels` over the stage.
- The search panel's controls row (`div.tumbler-search-controls`) already holds
  a mode-specific control: Only results is in the row but shown only in Focus.
  The panel learns the mode from `handle.mode()`.

## Answer: does a search from a point name the point itself?

**Yes, today it does, when the point is named.** Read from the code:

- `ET.search.pointQuery(set, id)` (`js/src/24-search.js`) returns a copy of the
  point's own row as the query and nothing else; it does not mark the point to
  be left out.
- `ET.search.makeRank` ranks every named point by cosine distance with no
  exclusion, so the point itself comes first at distance 0 (ties to the lower
  index never matter, as nothing else is at 0 unless it is a duplicate).
- This is documented (`js/api/24-search.md`, "A named picked point is its own
  first result at distance 0"; `js/api/50-viewer.md`, "a named one is its own
  first result") and tested (`js/test/search-named.test.js`, "a picked point:
  named, it is its own first result at distance 0; unnamed, it is only the
  query").
- A word search whose words match exactly one point (the whole title `Rice` on
  the Wikipedia set) uses that point's vector as the query, so it too names the
  point first at distance 0.

The reference page leaves the point out (`rank()` skips `q.members`), which is
why the spec's success signal lists eight results without Rice (Cereal, Wheat,
Maize, Bean, Bread, Vegetable, Cattle, Potato).

**Decided here, for the relative view:** the ranking is not changed. The spec's
boundary says relative search changes only the frame, the centre, the zoom and
what is drawn over the picture, and the ranking is shared by every view, the
lit values, the lists and `info().search`. So with relative on, a named point
searched from is still its own first result (rank 1, distance 0, lit, in the
panel's list). What the relative view does with it:

- **The overlay draws it as the search, not as a result.** A named result
  whose cosine distance to its search is below `1e-7` and whose length differs
  from the search's by less than `1e-6` is the search's own point: it sits on
  the search's marker at the top of the ruler, so the overlay draws no stem and
  no result label for it (the search's marker and its label already name it).
  Every other named result gets its stem and label.
- **Comparisons with the reference** (t13, t15) leave the search's own point
  out of the viewer's results and set the counts one higher for a point search,
  so that the same other points are compared: `k` 9 for the reference's 8
  results; with the reranker, `candidates` 51 and `top` 9 for the reference's
  50 candidates and 8 kept (the reference's reranker scores, from
  `scripts/build_reference_rerank.py`, were made for each article against its
  50 nearest *other* articles).
- t15 lists "the search's own point is the first result in the panel's list
  and is lit, where the reference leaves it out" as an intended difference.

## Who builds what

| Task | File(s) | What this page fixes for it |
|------|---------|-----------------------------|
| t2 | `js/src/10-math.js` | `ET.math` additions and constants (below) |
| t3 | `js/src/30-renderer.js` | the draw key `perspective`, `ET.renderer.RELATIVE_PERSPECTIVE`, the rule for the gradient (it arrives in the lit values) |
| t4 | `js/test/`, `tests/` | nothing new: goldens and contract hashes; every task keeps them green |
| t5 | `scripts/`, `tests/fixtures/relative/`, `docs/evidence/` | the unit-length tolerance its fixtures are checked against |
| t6 | `js/src/40-mode-tumble.js`, `js/src/39-modes.js` | Tumble's `searchChanged` and `setRelative`, `state.relative`, `describe().relative`, the framing rule, the status strings |
| t7 | `js/src/46-relative-overlay.js` (new) | `ET.relativeOverlay.build`, `paint`, `placeLabels`, the draw list, the overlay strings |
| t8 | `js/src/45-search-panel.js` | the Relative and Show the origin controls, Face hidden, list text, the notes for searches that give no axis, `ET.searchPanel.relativeNoteText`, colours by letter, `frame.relative` |
| t9 | `js/src/50-viewer.js` | mount options, `handle.setRelative`, `handle.relativeSettings`, `info().search.relative`, letters kept, the gradient, status and provenance strings |
| t10 | `js/src/50-viewer.js` | drawing the overlay, perspective and pitch, Show the origin in both views, the test hook |
| t11 | `js/shells/web-component.js` | attributes `relative` and `show-origin`, properties `relative` and `showOrigin` |
| t12 | `js/page/` | address parameters `relative` and `origin` |
| t13 | `tests/browser/` | the rules for comparing a point search with the reference (above) |
| t14 | `docs/guides/`, `js/api/` | the words on this page are the words the guides use |
| t15 | `docs/reference-differences.md` | the differences listed at the end of this page |

Data flow for one frame with relative on: `handle.setRelative` or the panel's
checkbox -> viewer settings -> Tumble's `setRelative(settings, t)` and
`searchChanged(search, t)` -> `ET.math.makeRelativeFit` (sliced, in the frame
budget) -> switch at a recorded time T (`mark`) -> `stateAt(t)` gives the
pinned frame, the centre, the zoom, `draw.perspective` and `state.relative` ->
the viewer draws the points with the lit values (results as the Lit setting
gives them, the gradient for the rest), then `ET.relativeOverlay.build` and
`paint` and `placeLabels`, then the panel's `drawOverlay` with
`frame.relative` -> `info().search.relative`, the status line, the provenance
row and the panel.

## Terms and units

| Term | Meaning |
|------|---------|
| Relative (the setting) | A Tumble setting, on or off, kept by the viewer in every mode and with no search. It has an effect only in Tumble with at least one search that gives an axis. |
| Relative view | Tumble with the setting on and at least one pinned axis. Otherwise Tumble is the plain view (today's Tumble, bit for bit while the setting is off). |
| Search direction | A search's raw query vector divided by its length (`u = q / len(q)`), in double precision. |
| Search length | `len(q)`, the length of the raw query vector (1 for a point search on a unit-length set; less than 1 for an average of several points). |
| Height | A point's vector dotted with a search direction, `x . u`: its length along the search. Cosine similarity exactly when the point's own length is 1. |
| Pinned axis | A frame row fixed to a search: row 1 (vertical) to the first search that gives an axis, row 0 (horizontal) to the part of the second that the first does not contain, row 2 (depth) to the part of the third that the first two do not contain. |
| Free rows | The frame rows not pinned (3 minus the number pinned). They tour the set's strongest directions (the plain fit's) with the search directions removed (since deviation d4, 2026-11-17; before it, the strongest directions of the remainder, found by a second fit). |
| Remainder | The centred set with the pinned directions removed from every row. |
| Remainder share | The variance held by the toured directions divided by the remainder's total variance, both over the rows fitted. Exact for whatever directions tour. |
| Window | Along the vertical search: from the lowest point's height (`low`) to the higher of the search length and the highest point's height (`high`), over **all** points. |
| Settled | The pinned rows are exact at this moment and are those of the searches in force: the turn onto the pinned frame has finished (or moved no pinned row), and no changed search is waiting for its fit. While not settled the ruler is not drawn as exact. |
| Mix | 0 to 1: how far the view is into the relative look (flatness and pitch). 0 in the plain view, 1 once settled. |
| Unit-length set | Every vector's length is within `ET.math.RELATIVE_UNIT_TOLERANCE` (0.001, the reference's) of 1. Then the measure is called `cosine`; otherwise `length along the search`. |
| Measure name | `"cosine"` or `"length along the search"`, chosen by the unit-length check on the set shown. |

## Maths (t2): additions to `ET.math`

Pure functions in `js/src/10-math.js`, added to the object `ET.math` returns.
`makeTour` and every existing function keep their exact output (the goldens of
t4 must stay green). Shapes and errors follow `js/api/10-math.md` (a malformed
call throws `RangeError` or `TypeError`; inputs are finite).

<!-- interface-names module="10-math.js" object="ET.math" match="present" task="t2" prefix="ET.math." landed="yes" -->
```text
relativeDirections
unitLength
heightWindow
makeTourRows
makeRelativeTour
relativeFit
makeRelativeFit
```

<!-- interface-names module="10-math.js" object="ET.math" match="constants" task="t2" prefix="ET.math." landed="yes" -->
```text
RELATIVE_UNIT_TOLERANCE
RELATIVE_ZERO_LENGTH
RELATIVE_SAME_DIRECTION
```

| Constant | Value | Meaning |
|----------|-------|---------|
| `ET.math.RELATIVE_UNIT_TOLERANCE` | `1e-3` | A set is unit-length when its shortest and longest vectors are both within this of 1 (the reference's test, `Math.abs(minLen - 1) < 1e-3 && Math.abs(maxLen - 1) < 1e-3`). |
| `ET.math.RELATIVE_ZERO_LENGTH` | `1e-9` | A query no longer than this has no direction (the reference's `len > 1e-9`). |
| `ET.math.RELATIVE_SAME_DIRECTION` | `1e-6` | A later search adds no axis when the part of its unit direction that the earlier pinned directions do not contain has squared length below this: it points the same way as an earlier search. Any other later search adds an axis, however close it is. The value: the query vectors are float32, so a repeated search (the same vector again) leaves a new part of squared length near 1e-14 and falls below it, while two different articles leave far more (an angle under 0.06 degrees would be needed to fall below it). The reference does the same thing in another form: it orthonormalises the rows first (a row whose remainder has norm at most 1e-12 is left as it is) and then `if (s < 0.5) ok = 1`, where `s` is 1 for any new direction and about 0 only for one pointing exactly the same way. |

### `ET.math.relativeDirections(queries, D) -> { directions, count, pinned, dropped }`

- `queries`: an array of 0 or more `Float32Array(D)` or `Float64Array(D)`, the
  raw query vectors in letter order.
- Taken in order. A query whose length is at most `RELATIVE_ZERO_LENGTH` is
  dropped with reason `"zero-length"`. Once three are pinned, every later one is
  dropped with `"no-axis-left"`. Otherwise its unit direction `u` has the
  pinned directions removed (twice, in double precision); if the squared length
  left is below `RELATIVE_SAME_DIRECTION` it is dropped with
  `"same-direction"`, otherwise what is left, made unit length, is pinned. The
  same rule applies to the third search against the first two.
- For Rice and Wheat on the Wikipedia fixture (cosine about 0.82) two axes are
  pinned, as on the reference page the owner approved; t2 must test that, and
  that the same query given twice pins one axis with `"same-direction"`.
- Returns `directions: Float32Array(count * D)` (orthonormal rows in pin order:
  `frameError < 1e-6`), `count` (0 to 3), `pinned: [{ index, length }]` (index
  into `queries`, the query's length), `dropped: [{ index, reason, against }]`
  (`against`: the indices of the pinned queries it was compared with, for
  `"same-direction"`; `[]` otherwise).
- Never throws for zero, repeated or parallel queries. `D < 3` throws
  `RangeError` (Tumble needs three axes).

The **first pinned direction is exactly the unit search direction**, so row 1
of a pinned frame dotted with a point is that point's height (o1).

### `ET.math.unitLength(X, N, D, tolerance?) -> { unit, min, max, tolerance }`

The shortest and longest row lengths over all `N` rows (double precision) and
whether both are within `tolerance` (default `RELATIVE_UNIT_TOLERANCE`) of 1.
`N` 0 gives `{ unit: false, min: null, max: null, tolerance }`.

### `ET.math.heightWindow(X, N, D, direction, length) -> { low, high, pointHigh, lowest, highest }`

Heights `x_i . direction` (double precision) over **every** row, never a
sample. `low` is the lowest height, `pointHigh` the highest, `high =
max(length, pointHigh)`, `lowest` and `highest` the row indices (ties to the
lower index). Heights below zero are kept as they are. `direction` must be unit
length (a `Float32Array(D)` or `Float64Array(D)`). `N` 0 gives `low` and
`pointHigh` `null` and `high = length`.

### `ET.math.makeTourRows(basis, m, D, rows, opts?) -> tour`

A tour of `rows` (1, 2 or 3) frame rows inside the span of `m >= rows`
orthonormal `basis` rows, as a closed-form function of `(basis, seed, speed,
t)` in the manner of `makeTour` (a seeded rotation of the `m`-dimensional span
turning `floor(m / 2)` planes at seeded rates). `opts`: `seed` (default 0),
`speed` (default 0.42). With `m` 1 the single row is constant. Returns `{ kind:
"tour-rows", seed, speed, dimension: D, subspace: m, rows, basis,
rowsAt(t, out?) -> Float32Array(rows * D) }`, rows orthonormal and inside the
span. It does not replace `makeTour`, whose output stays bit-identical.

### `ET.math.makeRelativeTour(directions, count, basis, m, D, opts?) -> tour`

The relative frame as a closed-form function of `t`. `directions` and `count`
as returned by `relativeDirections` (`count` 1 to 3); `basis`, `m` the toured
directions (from `relativeFit`, every row orthogonal to every direction).
`frameAt(t, out?) -> Float32Array(3 * D)`:

- row 1 is `directions` row 0 (vertical);
- with `count >= 2`, row 0 is `directions` row 1 (horizontal);
- with `count == 3`, row 2 is `directions` row 2 (depth);
- the rows not pinned are `makeTourRows(basis, m, D, 3 - count, opts)` in row
  order (count 1: rows 0 and 2; count 2: row 2); with `count == 3` nothing
  tours and the frame is the same at every `t`.

The pinned rows are copied, never re-orthonormalised against the free rows, so
row 1 dotted with a point equals the direct dot product to float32 accuracy.
Returns `{ kind: "relative-tour", pinned: count, free: 3 - count, subspace: m,
seed, speed, dimension: D, frameAt }`.

### `ET.math.relativeFit(X, N, D, queries, opts?) -> fit` and `ET.math.makeRelativeFit(...) -> stepper`

Everything the relative view needs from the data, in one computation;
`makeRelativeFit` is the same work as a stepper (`js/api/10-math.md`, "Sliced
work") whose `result` equals `relativeFit`'s bit for bit however it is pumped.
The stepper's `work` (multiply-adds counted, the same however it is pumped) is
added by t18.

- `opts`: `seed` (default 0), `subspace` (default 8), `sampleRows` (the fit
  cap; Tumble passes its `fitRows`, 4,096), `plain` (t18: the plain fit's
  directions, below), and `maxIterations`, `tolerance`, `oversample` passed to
  the principal-direction fit as for `guidedTour`.
- Steps: `relativeDirections(queries, D)`; when `count` is 0 the result has no
  tour. Otherwise `m = min(max(subspace, 3 - count), D - count)` directions are
  asked for (a subspace smaller than the free rows is raised to them; 0 when
  nothing tours); `unitLength` and `heightWindow` (along the first pinned
  direction, with that query's length) run over **all** rows, in units like the
  rest.
- **Reused (t18, deviation d4).** With `plain` (`{ directions, count,
  dimension? }`, the shape `principalDirections` returns: the set's strongest
  directions, strongest first; Tumble passes its plain tour's `pca` for the same
  set), the toured directions are **the set's strongest directions with the
  search directions removed**. Each plain row in turn has the pinned directions
  and the rows already kept removed (twice, in double precision, as
  Gram-Schmidt does) and is kept, made unit length, when at least `1e-3` of its
  squared length is left (an internal tolerance in `10-math.js`, not exported);
  at most `m` are kept, in the plain order, so the tour opens on the strongest.
  `subspace` is the number kept and `method` is `"plain-reused"` (with
  `-sampled` when `fittedRows < N`). A malformed `plain` (a `dimension` other
  than `D`, a `count` that is not a non-negative integer, fewer than `count *
  D` values) is a `TypeError`.
- **Full fit (the fallback).** Without `plain`, or when fewer plain rows
  survive than there are free rows, the remainder (centred rows with the pinned
  directions removed) is fitted on at most `sampleRows` rows taken at an even
  stride, to `m` directions, each made orthogonal to every pinned direction
  (`|dot| < 1e-6`), exactly as before t18. `method` is the fit's method,
  prefixed by `fallback-` when `plain` was given.
- Result:

```js
{
  directions, count, pinned, dropped,     // as relativeDirections
  basis: Float32Array(subspace * D) | null,   // the toured directions, orthonormal, orthogonal to directions
  subspace: number,                       // m for a full fit, the rows kept (at most m) when reused; 0 when count is 0 or 3
  share: number,                          // variance on the basis / remainder total, over the fitted rows; 0 with no variance
  variances: Float64Array(subspace), totalVariance: number,   // over the fitted rows; variances in basis order
                                          // (descending for a full fit, plain order when reused)
  fittedRows: number,                     // rows the fit used (at most sampleRows)
  rank: number,                           // min(fittedRows - 1, D - count): directions the remainder can spread in
  fixed: number,                          // free rows that cannot follow any spread: max(0, (3 - count) - rank)
  window: { low, high, pointHigh, lowest, highest } | null,   // heightWindow along the first pinned direction
  unit: { unit, min, max, tolerance },    // unitLength over all rows
  method: string,                         // "plain-reused[-sampled]", the fit's method (principalDirections'),
                                          // "fallback-" + it, or "none"
  plain: { given, kept } | null,          // t18: plain rows given and kept; null without plain or when nothing tours
}
```

- The share is of the remainder and on the rows fitted, never of the whole set
  (o2); with `count == 3` it is `null` and nothing tours.
- Zero queries, repeated queries, a 3-dimensional set with one, two and three
  searches, and a set of 2 points each give three orthonormal rows through
  `makeRelativeTour` and a named reason, and none throws (`fixed` counts the
  free rows that are filler, which the panel names).

## Renderer (t3): the perspective key

<!-- interface-names module="30-renderer.js" object="ET.renderer.DEFAULTS" match="constants" task="t3" prefix="draw." landed="yes" -->
```text
perspective
```

<!-- interface-names module="30-renderer.js" object="ET.renderer" match="constants" task="t3" prefix="ET.renderer." landed="yes" -->
```text
RELATIVE_PERSPECTIVE
```

| Key | Meaning | Default |
|-----|---------|---------|
| `draw.perspective` | The perspective constant `P` in `s = P / max(0.6, P + z2)` (shader `place()`, `ET.renderer.place`, `ET.renderer.placer`, kept in step). Larger is flatter. | `3` |

- `ET.renderer.RELATIVE_PERSPECTIVE = 60`: the value of the settled relative
  view (the reference's `persp = 3 + 57 * relMix`). Tumble sets
  `draw.perspective = 3 + (RELATIVE_PERSPECTIVE - 3) * mix` while `mix > 0`
  and leaves the key out when `mix` is 0. This holds for every state Tumble
  returns, a swing's included: a swing may start during the turn back to the
  plain view, and the perspective keeps easing through it (review of pull
  request 13, finding 9).
- **With the key absent or exactly 3 nothing changes**: the vertex shader
  sources (`ET.renderer.shaderSources(layout)`) are the same strings as before,
  and `place` and `placer` give the same numbers. How t3 does it (for example,
  today's programs at 3 and variant programs reading a uniform `uPersp` built
  when another value is first drawn) is t3's choice; the default-unchanged
  check is the judge.
- Measured requirement (o6): at `RELATIVE_PERSPECTIVE`, untilted (pitch 0), two
  points of equal height at the two depth ends of the cloud are placed within 2
  percent of the ruler's visible length of each other. A rough bound: the error
  is at most `(s_near - s_far) / 2` of the ruler, about `Δ / P` for a depth
  range of `±Δ` after zoom; on the Wikipedia set (`Δ` about 1.0) that is about
  1.7 percent at 60. If t3 measures more than 2 percent at 60 it reports it
  instead of changing the value.

**The gradient reaches the renderer in the lit values; the renderer adds
nothing for it** (Decided here: the lit channel already scales a point's size
and brightness by a number in `[0, 1]` and already draws exactly as without
search at `filter` 0 or with no lit values, so a second per-point buffer would
duplicate it). t3's third criterion is met by showing that a lit array holding
gradient values changes no pixel with `filter` 0 or with no lit values set.
How the viewer makes the values is under "Viewer (t9)".

No fog in the relative view: Tumble's `fog` is 0 and the relative view keeps it
0 (owner's decision).

## Tumble (t6): the relative setting

Two members are added to the Tumble instance. Both are optional members of the
mode interface (not in `ET.modes.INTERFACE`), as `face` is.

<!-- interface-names module="40-mode-tumble.js" object="mode:tumble" match="present" task="t6" prefix="inst." landed="yes" -->
```text
searchChanged
setRelative
```

A third optional member, `setStill`, is added by t19 (below, "Motion stopped
(t19)").

<!-- interface-names module="40-mode-tumble.js" object="mode:tumble" match="present" task="t19" prefix="inst." landed="yes" -->
```text
setStill
```

### `inst.searchChanged(search, t) -> stepper | null`

The same call and argument the viewer already makes for Focus
(`docs/search-interface.md`, "Focus (t7)"): `search` is `null` or `{
searches: [{ letter, query, indices }], scale, onlyResults }`. Tumble reads
**only `letter` and `query`**: `indices` (which changes with the reranker),
`scale` (the point of view) and `onlyResults` never reach the frame (o8, o15).

- With the setting off, it stores the queries and returns `null`; no frame,
  centre, zoom or status changes (o9).
- With the setting on, when the list of queries differs from the one in force
  (a query added, removed or changed, compared by letter and by the bytes of
  the query), it starts a relative fit and returns its stepper; the switch
  happens at a recorded time T (below). A call that changes only `indices`,
  `scale` or `onlyResults` returns `null` and changes nothing.
- **Between the change and the switch the view is not settled** (review of pull
  request 13, finding 8). When a relative view is shown and the new list needs
  a fit, the frame shown stays the earlier searches' until the fit switches in,
  and a letter may by then name another search (A was "rice", A is now
  "wheat"). From the call's time `t` (recorded with the event shown, so a
  time before it still shows the settled view) until the switch,
  `state.relative.settled` is `false`, the status says `turning until`, and
  `state.relative.searches` names the searches the frame was built from. A call
  that gives the searches of the frame shown again, before the new fit is in,
  drops that fit and the view is settled as before.
- Letters are not re-given: the search lettered B stays B when A is removed,
  and becomes the vertical axis because it is now the first.

### `inst.setRelative(settings, t) -> stepper | null`

`settings`: `{ relative?, showOrigin? }`, booleans; a missing key keeps the
current value. Called by the viewer with the viewer's settings right after the
instance is entered (before `prepare` finishes is allowed) and on every change.

- `relative` on with no search that gives an axis: nothing changes (the view is
  plain Tumble, bit for bit).
- `relative` on with such a search, or off while the relative view is shown:
  a switch at T.
- `showOrigin` changes the framing only: at `t` the centre and zoom glide over
  `relativeTransition` (smoothstep) to the new framing; no fit, no turn; in the
  plain view it changes nothing in the mode (the viewer draws the marker).

### Switch time, the turn and the settled flag

- **A switch is an event at a fixed time T** (`js/api/40-modes.md`, "Events"),
  like a refit: when the call needs a fit, T is fixed by `inst.mark(t)` after
  the stepper finishes (or by the first `stateAt` after it, when the caller
  gave no time); when it needs none (turning off, `showOrigin`, a fit reused
  for the same queries on the same set), T is the call's `t`. T is never
  earlier than the previous relative event. Once T is fixed, `stateAt(t)` is a
  pure function of data history, seed, entry view, event times and `t`, and a
  `t` before T gives the view as it was then (o3, o13). A stepper of an earlier
  call that is pumped later does nothing (generation counter, as for refits).
- **The turn.** At T the frame shown is A; the relative tour starts at B (no
  relabelling of pinned rows: row 1 is `+u`; free rows may be matched to A in
  order and sign). The frame turns from A onto the moving relative frame with
  the refit turn (`ET.modes.refitTurn`: a rotation Q(s) applied to the target's
  moving frame, so the frame is orthonormal at every moment and never folds),
  over `relativeTransition` seconds (option, default 1.5, Tumble's entry
  `transition`; not `"auto"`). Turning off turns back onto the plain tour the
  same way; adding or removing a search while pinned turns from the pinned
  frame shown onto the new one (o14).
- `mix` goes from 0 to 1 over the turn on (the turn's ease), stays 1 while
  pinned, and goes back to 0 over the turn off.
- **Settled** is true when the relative view is shown, its turn has ended and
  its searches are the ones in force; then row 1 equals the unit direction of
  the first pinned search within 1e-6 (o1). It is false during every turn that
  moves a pinned row, and from a change of the searches until the fit for them
  switches in (above). One turn moves no pinned row: the switch from a settled
  view onto a fit that pins the same directions (the same searches fitted again
  after points arrived, "Data" below). Its pinned rows are written from the
  fit's directions on every frame of the turn, bit for bit, so the view stays
  settled through it; only the free rows, the window and the centre move.
- **Centre and zoom** (framing): with `w` the fit's window, `top = w.high +
  0.04`, `bottom = w.low - 0.04` (the reference's margins); with Show the
  origin, `bottom = min(bottom, -0.06)` and `top = max(top, 0.06)`. The centre
  is `((top + bottom) / 2) * u` (u the vertical search's direction) and the
  zoom is `min(RELATIVE_FILL / (top - bottom), RELATIVE_ZOOM_CAP)` with
  `RELATIVE_FILL = 0.78 / 0.46` (the window fills 78 percent of the stage's
  shorter side, as in the reference) and `RELATIVE_ZOOM_CAP = 0.5 / (0.42 *
  0.46)` (the reference's cap for a narrow stage). They glide from the values
  shown at T over the turn.
- **No swing.** With the relative view shown, or a switch to it pending, `face`
  returns `false` and starts nothing. With the setting off, `face` is today's;
  that includes the turn back to the plain view, during which a swing may start
  (the perspective goes on easing by `mix` through the swing).
- **Data.** An append with the relative view shown, or with a relative fit
  under way, **starts no fit and cancels none** (review of pull request 13,
  finding 6; before it every append started the fit over, so under a stream of
  appends it never finished). The view shown is kept, as plain Tumble keeps its
  tour: the pinned rows are the searches' directions, which new points do not
  change, so they stay exact and the view stays settled; the free rows, the
  window (so the ruler's ends and the framing) and the unit figures are those
  of the rows fitted, and the status line ends `· before {n} new points`, as
  the plain one does. `inst.refit(t)` then makes the relative fit again, after
  the plain fit whose directions it reuses, when the fit shown or under way was
  made before points arrived; it switches in at a recorded T (`mark`), with the
  turn that keeps the pinned rows (above). The viewer calls `refit` by the same
  policy as for plain Tumble (appends quiet for `refitQuietSeconds`, at least
  `refitShare` of the set new). A search changed after an append is fitted on
  the data as it is then. A replace re-enters the mode (the viewer drops the
  searches, as today).
- **History.** Every relative event is kept for as long as the mode is entered,
  so any earlier time can be shown again: a seek back gives the frame, centre,
  zoom and perspective of that time, bit for bit. An event holds a few rows of
  D numbers (its tour, turn, searches and framing) and **no reference to the
  set**: the data a fit was made on is recorded as a count of appends and a row
  count (review of pull request 13, finding 7; before it each event kept the
  whole set it was made on alive). The status line's `· before {n} new points`
  is counted against the data as it is now, at any time shown.
- **The plain directions (t18).** The relative fit is given the plain fit's
  directions of the **same set** it is for: the kept fit
  (`M.fittedDirections(set, seed, subspace, rows)`, filled by the plain tour, a
  refit or Lattice) when there is one; otherwise the relative preparation fits
  them itself, as `makeGuidedTour` does (centring, then
  `ET.math.makePrincipalDirections` with the same seed, subspace and rows, in
  units), and keeps them with the set for the refit that follows. It looks for a
  kept fit again on every run. Both give the same bits, so the view does not
  depend on which happened (tested: a fit pumped before the preparation, or
  interleaved with it, shows what a fit after it shows, bit for bit). After an
  append the plain tour is fitted again only by a refit, so the relative fit
  fits the new set's directions itself; it never uses the old set's (tested).
- Pause and reduced motion stop everything as in plain Tumble: it all runs on
  mode time. A change made while the clock stands still has no turn (next
  section).

### Motion stopped (t19)

Decided by the owner on 2026-11-17 (deviation d5): when the viewer's clock is
not advancing, a change that would turn the view takes effect at once.

### `inst.setStill(still)`

`still`: `true` while the viewer's clock stands still (paused, which reduced
motion starts in), `false` while it runs; anything but `true` counts as
`false`. The viewer calls it right after the instance is entered (before
`setRelative`) and whenever Pause or Play changes the clock. It changes nothing
shown by itself and is kept across `enter()`. Default `false`, so a mode never
told is today's Tumble, bit for bit.

- While still, a switch (Relative on or off, a search added or removed, a fit
  kept for the same searches) and a Show the origin framing change are
  recorded with **no turn**: the event's turn and framing have duration 0 and
  no blend, so `stateAt(T)` is already the settled relative view (or the plain
  view when turning off): `settled` true, `mix` at its end, row 1 exact, the
  framing at its target. The event records `instant: true`;
  `describe().relative.instant` reports it for the newest event (absent when
  the setting is off and nothing is shown).
- **Decided at the switch, not the call.** A fit started while still and
  finished after Play turns as usual; one started while running and switched
  in while still has no turn. A switch that needs a fit is fixed by
  `inst.mark(clock)`, which the viewer calls on every ready frame, paused or
  not, and the viewer keeps pumping the preparation while paused (its frame
  loop runs while the mode has jobs), so a fit pumped while paused completes
  and applies on the frame it finishes.
- **Reproducible.** The event is fixed at a recorded time with its duration,
  so the same data, seed, searches, recorded times and the same still flag at
  each switch give the same frames, and a `t` before the event gives the view
  before it.
- With the clock running nothing changes: the turn takes `relativeTransition`
  as before (tested: frames bit-identical with `setStill(false)` and with no
  call at all).
- Decided here: the viewer tells the mode (`setStill`) rather than passing a
  duration with each call, because a switch that needs a fit is fixed later by
  `mark`, not by the call that started it; the mode must know the clock's state
  at the switch.
- `draw.fog` stays 0; `draw.perspective` as above; the other draw keys are
  Tumble's.

### `state.relative` and `describe().relative`

`stateAt(t)` gains one key on Tumble's state (other modes do not have it; the
viewer reads `s.relative || null`):

```js
relative: null | {          // null: setting off and no turn back in progress (the plain view)
  relative: boolean,        // the setting
  showOrigin: boolean,      // the setting
  active: boolean,          // at least one axis pinned at t (after its switch)
  settled: boolean,         // active and the turn has ended: the pinned rows are exact
  mix: number,              // 0..1
  pinned: [{ letter, axis, length }],   // axis "vertical" | "horizontal" | "depth"; length = len(query)
  dropped: [{ letter, reason, against }], // reason "zero-length" | "same-direction" | "no-axis-left";
                                          // against: letters it was compared with
  measure: "cosine" | "length along the search",
  unit: { unit, min, max, tolerance },
  window: null | { low, high, bottom, top },  // heights along the vertical search; bottom/top as framed
  share: number | null,     // the remainder share of the directions toured
  subspace: number,         // directions toured (0 when nothing tours)
  free: number,             // free rows: 3 - pinned.length
  fixed: number,            // free rows that are filler (a set too small to spread that far)
  searches: [{ letter, query }], // the searches the frame at t was built from, pinned and dropped, in
                            // letter order (the mode's own copies: read, never write); [] when not
                            // active. The viewer draws the ruler from these, not from the list it shows.
}
```

`describe()` gains `relative`: the same fields at `inst.time`, plus `switchAt`
(the latest relative event's T, or `null`), `pending` (a fit or a switch is
waiting), `transition` (`relativeTransition`) and `pointsSinceFit` (points
appended since the newest event's fit was made; 0 in the plain view). With the setting off and no
turn in progress `describe().relative` is `{ relative: false, showOrigin,
active: false, switchAt, pending: false }`.

### Status strings (t6)

The status line in the relative view is built from these pieces, in this order
(letters are the pinned searches' letters joined as `A`, `A and B`, `A, B and
C`; `{share}` is the remainder share as a whole percent, `18%`):

<!-- interface-strings module="40-mode-tumble.js,39-modes.js" task="t6" landed="yes" -->
```text
relative to {letters} · vertical = {measure} to {letter}, exact
relative to {letters} · turning until vertical = {measure} to {letter}
 · the plane of {a} and {b} is shown exactly
 · all three axes are pinned: the space of {letters} is shown exactly
 · the other two axes tumble through {m} directions holding {share} of the remaining spread
 · depth tumbles through {m} directions holding {share} of the remaining spread
 · nothing tumbles
 · {letter} pins no axis
 · before {n} new points
```

Examples: `relative to A · vertical = cosine to A, exact · the other two axes
tumble through 8 directions holding 18% of the remaining spread`; with B:
`relative to A and B · vertical = cosine to A, exact · the plane of A and B is
shown exactly · depth tumbles through 8 directions holding 17% of the remaining
spread`; with three: `... · all three axes are pinned: the space of A, B and C
is shown exactly · nothing tumbles`; a fourth search D adds `· D pins no axis` at the end.
The last piece, `· before {n} new points`, closes the line while points have
been appended since the fit shown was made (plain Tumble's words).
The relative status is longer than the plain status's 70 characters; this is
accepted (the reference's status line is as long).

## Overlay (t7): `ET.relativeOverlay`

A new module, `js/src/46-relative-overlay.js`. Pure numbers in, a draw list
out; then the canvas part and the text part are painted separately, because
the viewer draws no text on a canvas.

<!-- interface-names module="46-relative-overlay.js" object="ET.relativeOverlay" match="present" task="t7" prefix="ET.relativeOverlay." landed="yes" -->
```text
build
paint
placeLabels
```

### `ET.relativeOverlay.build(input) -> list`

```js
input = {
  width, height, dpr,          // the overlay canvas in device pixels, and the pixel ratio
  view,                        // the draw state given to the renderer this frame (zoom with the user's,
                               // yaw, pitch, radius, perspective): every position goes through
                               // ET.renderer.placer(view, width, height), so points and overlay agree
  vectors, dimension,          // the set's block and D
  frame, centre,               // the mode state's frame and centre this frame
  relative,                    // the mode state's relative (null: the plain view)
  searches: [{ letter, colour, query, name }], // every search shown, letter order, raw query vectors;
                                           // name: what the marker is called (t19), "" for none
  named: [{ index, text, title, ranks }],  // named results to label, each once; ranks: [{ letter, rank }];
                                           // title: the point's title, or null (t19)
                                           // (reranker ranks; [] with no reranking or a failed one)
  cut: null | { height, sent },            // the reranker's cut-off for the vertical search:
                                           // the height of the lowest candidate sent, and how many were sent
  showOrigin, labels,                      // the viewer's settings
}
```

`list = { segments, rings, marks, texts, results, ruler }`:

- `segments`: `[{ x0, y0, x1, y1, colour, alpha, width, dash }]` (rulers, ticks,
  stems, the cut-off line), `rings`: `[{ points: Float32Array, colour, alpha }]`
  (level rings as polylines, the unit circle), `marks`: `[{ x, y, r, colour,
  alpha, kind }]` (the search markers, the origin cross, the second ruler's
  dots); `kind` one of `"search"`, `"origin"`, `"dot"`.
- `texts`: `[{ x, y, text, align, colour, alpha, kind }]` with `kind` one of
  `"tick"`, `"title"`, `"result"`, `"cut"`, `"origin"`, `"search"`.
- `results`: `[{ index, x, y, rulerX, rulerY, height }]`, one per stem: the
  result's drawn position and the point on the vertical ruler at its height
  (for the viewer's test hook, t10).
- `ruler`: `null` or `{ x0, y0, x1, y1, from, to }`, the vertical ruler's ends
  in pixels and in height.

What it holds (the reference's look; `m` is `relative.mix`):

- **Relative view, settled:** ruler A along the vertical search from
  `max(0, bottom - 0.2)` (from 0 with Show the origin) to `top`; a tick and a
  level ring (radius 0.34 units, 48 segments, the reference's) every 0.1 from
  the first multiple of 0.1 at or above the ruler's foot to `top`, each tick
  labelled (on a ruler that 0.1 does not suit the step and the radius are
  others: see "The tick step" below); the title at `top`; one stem per named result from the result to
  the point on ruler A at its height, except the search's own point (see the
  answer above); the search markers at each search's raw query, each with
  its letter and name beside it (below); with two
  pinned, ruler B from the origin (or `max(0, bottom - 0.2)`) to `max(1,
  len(q_B)) + 0.04` along B's own direction with dots and labels at 0.1 to 0.9;
  with `cut`, a dashed line across ruler A at `cut.height`; the origin cross
  at height 0 and its text whenever height 0 lies inside the window shown
  (`bottom <= 0 <= top`), whether or not Show the origin is on (this follows
  the spec's requirement c31); with Show the origin (which widens the window to
  include 0), only on a unit-length set, the unit circle about it.
- **Relative view, not settled** (`relative.settled` false): ruler A's line
  only, faint; **no ticks, no rings, no tick labels, no stems, no cut-off
  line** (o1: the ruler is not drawn as exact while the view turns). The
  search markers and their names stay.
- **Plain view** (`relative` null) with Show the origin: the origin cross where
  the all-zero vector falls and its text with the true distance `len(centre)` and
  the visible part (the length of the centre's projection on the three rows).
- Otherwise the list is empty.
- Result labels (`kind: "result"`) only when `labels` is true; ranks in front
  when given (`1.`, or `A1.` with several searches; joined by a space).
- **The search's name on its marker (t19, deviation d5).** In the relative
  view, settled or turning, one text of `kind: "search"` per search: `{letter}
  · {name}` (the reference's "A · Rice"), `name` cut to 28 characters as a
  result's text is, or `{letter}` alone when `name` is empty; in the search's
  colour, left-aligned 15 px right of and 4 px below the marker's centre (the
  panel's letter place). It is always drawn (with `labels` off too, as the
  panel's letters were). Decided here: the overlay draws it, not the panel, so
  that it is placed with the other labels and before every result label; the
  panel then draws only the ring in the relative view (see "Search panel").
  The viewer leaves out the overlay's own ring when the panel is mounted, so
  ring and name are each drawn once with and without the panel.

### `ET.relativeOverlay.paint(ctx, list) -> boolean`

Draws `segments`, `rings` and `marks` on the 2-D overlay context; never calls
`fillText` or `strokeText`. Returns `false` when the list had nothing to draw.

### `ET.relativeOverlay.placeLabels(layer, list, doc) -> number`

Puts `list.texts` as `span` elements in `layer` (a `div.tumbler-relative-labels`
the viewer creates after the overlay canvas, `aria-hidden`), every text with
`textContent`, styles through `element.style`; reuses its spans (at most 160);
returns how many are shown. Labels that would overlap one already placed are
left out, in this order: the title, the ticks, the cut-off text, the origin
text, each search's letter and name, then results nearest the top of the
ruler (the spec's open park on label collisions; the panel's list carries
every result). So a marker's name is never left out for a result label.

### Overlay strings (t7)

<!-- interface-strings module="46-relative-overlay.js" task="t7" landed="yes" -->
```text
{measure} to {letter}
{sent} candidates above this line went to the reranker
origin (0, 0, … , 0)
origin · truly {far} from the centre, {seen} of it visible
```

<!-- interface-strings module="46-relative-overlay.js" task="t19" landed="yes" -->
```text
{letter} · {name}
```

- The title is `{measure} to {letter}` (the reference's `MEASURE + ' to A'`):
  `cosine to A`, or `length along the search to A`.
- Tick labels are the height with one decimal (`0.7`); a negative tick keeps
  its sign (`-0.1`). With a step other than 0.1 (below) a label has the
  step's decimals and no more: `15` at a step of 5, `0.6` at 0.2, `0.015` at
  0.005.
- A result label is `[{ranks} ]{text}  {heights}`: `text` is the point's
  title when the viewer gives one (`named[k].title`, t19), otherwise its text;
  cut to 28 characters as the panel does, `heights` the result's height along each pinned search
  with two decimals, joined by ` · `. On a set that is not unit-length,
  two spaces and `cosine {c}` follow (its cosine to each pinned search, two decimals, joined
  by ` · `), so every named result shows both (o4).
- `{far}` and `{seen}` have two decimals.

#### The tick step

The step between ticks, and between level rings, follows the length of ruler A,
`top` minus its foot:

- **0.1** while the ruler is 0.2 to 1.2 long (2 to 12 steps of 0.1). That is
  every ruler of a set whose vectors have length one searched with a vector of
  length one (such a ruler is 0.28 to 1.04 long), and there the ticks, the
  rings and the labels are bit for bit what they were with a fixed step. A
  level ring's radius is 0.34.
- **Otherwise** (vectors that are not of length one: a ruler 40 long, or 0.05
  long) the smallest step of 1, 2 or 5 times a power of ten of which the ruler
  is at most ten: more than four steps and at most ten, so 4 to 11 ticks. Tick
  `k` is at the number nearest to `k` times the step (0.6, not
  0.6000000000000001), from the first multiple of the step at or above the
  ruler's foot to `top`. A level ring's radius is 3.4 steps, which is 0.34 at
  a step of 0.1.

Ruler B's dots stay at 0.1 to 0.9 whatever the step of ruler A.

## Search panel (t8): the controls and the words

The Relative and Show the origin controls live **in the search panel's controls
row** (`div.tumbler-search-controls`), first in the row, before Face the
searches. Decided here: relative is a way of viewing searches, the row already
holds a mode-specific control (Only results, shown in Focus only), and the
panel is what t8 owns. Show the origin also works in the plain view with no
search; it sits beside Relative because both are Tumble's.

```text
div.tumbler-search-controls
  label.tumbler-search-relative     input[type=checkbox] "Relative"; in the row always, shown only in Tumble
  label.tumbler-search-origin       input[type=checkbox] "Show the origin"; in the row always, shown only in Tumble
  button.tumbler-search-face        hidden (display none) while Relative is checked in Tumble; shown again when off
  ...                               the existing controls, unchanged
```

- Tumble is `handle.mode() === "tumble"`, as the panel already tells Focus.
- A change calls `handle.setRelative({ relative })` or `handle.setRelative({
  showOrigin })`; the checkboxes follow `search.relative.relative` and
  `search.relative.showOrigin` from `panel.update(search)`. Native checkboxes,
  so their state reaches assistive technology as the existing ones do.
- Titles (tooltips) on the two labels: `One axis is the search itself; height
  is measured along it. The other axes tumble through what is left.` and `Zoom
  out to the all-zero vector, or, in the plain view, mark where it falls.`
  (Decided here: the reference's button text says "similarity", which is wrong
  for a set that is not unit-length.)
- **Colours follow the letter, not the position**: search B uses
  `--tumbler-search-2` whether or not A is shown (letters are kept, see t9).
- **No control for the rest (t22, deviation d9).** A select labelled `The
  rest` (faint, visible, bright) stood here after Show the origin from t19
  (deviation d6) and was never released. The owner merged it into Lit on
  2026-11-17: whether the points that are not results are faded or shown in
  full is the Lit setting's ("everything, results highlighted" shows them in
  full, `docs/search-interface.md`), and the fade has one strength (below,
  "The brightness gradient for points that are not results"). The row has no element `.tumbler-search-rest`, and the panel
  does not read a `rest` key in `search.relative`.

- **`frame.relative`**: `panel.drawOverlay(ctx, project, frame)` gets `frame.relative`
  (boolean, true while `search.relative.active` and the mode is Tumble). While
  it is true the panel draws its query rings but **no letters, no links and no
  result labels** (the relative overlay draws stems, result labels and each
  search's letter and name, t19).
- **Result lists** while the relative view is shown: each result row adds, after
  the existing parts, `cosine {c}` on a unit-length set, or `length along the
  search {h} · cosine {c}` otherwise (three decimals; `h` the result's height
  along its own search, `c` its plain cosine), from
  `search.relative.searches[j].results[r]`.
- **Notes** for searches that give no axis and for a set too small for the
  free axes, in the panel's note, one sentence each:

<!-- interface-names module="45-search-panel.js" object="ET.searchPanel" match="present" task="t8" prefix="ET.searchPanel." landed="yes" -->
```text
relativeNoteText
```

### `ET.searchPanel.relativeNoteText(search) -> string`

The relative part of the note from `info().search`: the sentences below for
every entry of `search.relative.dropped` (letter order) and for
`search.relative.fixed > 0`, joined by a space; `""` when the relative view is
not shown or nothing is to be said. `noteText` includes it.

<!-- interface-strings module="45-search-panel.js" task="t8" landed="yes" -->
```text
Show the origin
Relative
Search {letter} has no direction (its vector has length zero), so it pins no axis.
Search {letter} points the same way as {against}, so it adds no axis. It is still lit.
Search {letter} is lit but has no axis: the first three searches pin all three.
This set is too small for the free axes to follow its spread: {fixed} of {free} are fixed directions, not fitted ones.
length along the search {h} · cosine {c}
cosine {c}
One axis is the search itself; height is measured along it. The other axes tumble through what is left.
Zoom out to the all-zero vector, or, in the plain view, mark where it falls.
```

`{against}` is the pinned letters it was compared with (`A`, or `A and B`).
The first line is the block's marker: it must not appear in the panel before
t8 lands.

## Viewer (t9, t10): settings, handle, `info()`, drawing

### Mount options

| Option | Default | Meaning |
|--------|---------|---------|
| `relative` | `false` | The Relative setting at mount. |
| `showOrigin` | `false` | The Show the origin setting at mount. |

### Handle methods

<!-- interface-names module="50-viewer.js" object="handle" match="present" task="t9" prefix="handle." landed="yes" -->
```text
setRelative
relativeSettings
```

#### `handle.setRelative(patch) -> { relative, showOrigin }`

`patch`: `{ relative?, showOrigin? }`; `relative` or `showOrigin` that
is not a boolean is ignored, as is any other key (among them `rest`, which
was a setting from t19 until t22 removed it, deviation d9; the mount option
`relativeRest` is ignored the same way); a missing key keeps its value. Synchronous (no ranking is redone, nothing is
superseded, no callback is called, no request is made). The settings are kept
in every mode and with no search; in Tumble they are passed on with
`inst.setRelative(settings, clock)` and, when the mode is entered later, right
after it is entered (with `searchChanged` as for Focus).
`onSearchChange` fires when any value changes, and when the relative view appears or goes, its
pinned or dropped letters change, or a turn ends (`settled` flips). After `destroy` it returns the last settings and
does nothing.

#### `handle.relativeSettings() -> { relative, showOrigin }`

A copy of the settings.

### `info().search.relative`

`info().search` gains one key, always present:

```js
relative: {
  relative, showOrigin,      // the settings
  offered,                   // the current mode is Tumble (the controls are offered)
  active,                    // offered and the mode's state.relative.active
  settled,                   // active and state.relative.settled
  measure,                   // "cosine" | "length along the search" | null (no data)
  unit,                      // { unit, min, max, tolerance } | null
  pinned,                    // [{ letter, axis, length }] (from the mode; [] when not active)
  dropped,                   // [{ letter, reason, against }] (against: letters)
  free,                      // free rows: 3 - pinned.length (3 when not active)
  fixed,                     // free rows that are filler
  window,                    // { low, high, bottom, top } | null
  share, subspace,           // the remainder share and directions toured, or null
  searches: [{ letter, results: [{ index, id, height, cosine }] }],
                             // aligned with info().search.searches[j].results; height = x . u of that
                             // search, cosine = 1 - its plain distance; [] when not active
}
```

- **`settled`** is the mode's `settled` and, besides, false while the searches
  shown are not the ones the mode's frame was built from (compared by letter
  and by vector with `state.relative.searches`), so the answer to a
  `setSearches` that replaced a search is not settled even before the next
  frame is drawn.
- **`measure` and `unit` in the plain view are worked out when they are read**
  (review of pull request 13, finding 4). While the relative view is shown they
  are the fit's own (`state.relative.measure` and `unit`: of the rows that fit
  was made on). Otherwise (Relative off, another mode, no search that gives an
  axis) they are the viewer's own check of the set shown,
  `ET.math.unitLength`, a pass over every row: both keys are listed in their
  places and are accessors that run the check on first read, once per set, and
  answer for the set shown when they are read. So a report made on every change
  of the searches or the data costs nothing for them unless somebody reads
  them; the panel reads them only while the relative view is shown.
- **`searches[j].letter`** is the letter of `info().search.searches[j]` as it is
  now (review of pull request 13, finding 1): the heights are kept per commit,
  the letters are not.

### Letters are kept (Decided here)

While the Relative setting is on, `setSearches(list)` keeps letters: an entry
that is the same as a search shown now (same kind, and the same text and `via`,
the same point id, or the same vector bytes and model) keeps that search's
letter, and the other entries take the lowest free letters in list order. So
`["rice", "wheat"]` then `["wheat"]` leaves one search, lettered B, which is
the vertical axis. `info().search.searches` stays in letter order; pairs,
`pointOfView` and colours use each search's letter, not its position (t9 makes
`pairInfo` read letters from the searches). With the setting off letters are
given by position as today, so nothing changes with relative off (o9). Reason:
the spec requires that every search keeps its letter in the relative view
(o14), and limiting it to the setting keeps every existing test and frame as
it is. Keeping letters in every view is a follow-up: the owner accepted this as
built on 2026-11-17 (deviation d5).

### The brightness gradient for points that are not results

With the relative view shown (`info().search.relative.active`), the viewer
sends the renderer lit values in which:

- every point whose lit value from `ET.searchSets.litValues` is above 0 keeps
  it exactly (results and points inside the result radius follow the Lit
  setting as today, owner's decision);
- every other point gets `base + scale * g^2` at the one strength there is
  (below), where `g` is the largest over the shown searches of `clamp((c_i - mid) /
  (hi - mid), 0, 1)`, `c_i = 1 - plainDistance_i` (the plain cosine, never the
  point-of-view scaled one), `mid` the median `c` over all points (index
  `N >> 1` of the ascending sort, the reference's `q.mid`) and `hi` the largest
  `c` over all points other than the search's own point (the reference's
  `q.hi`). Worked out once per change of the searches or the data, not per
  frame.

**The fade has one strength (t22, deviation d9).**

<!-- interface-names module="50-viewer.js" object="ET.viewer" match="constants" task="t22" prefix="ET.viewer." landed="yes" -->
```text
RELATIVE_FADE_BASE
RELATIVE_FADE_SCALE
```

The lit value of a point that is not a result is `0.2 + 0.6 * g^2`
(`ET.viewer.RELATIVE_FADE_BASE` 0.2, `ET.viewer.RELATIVE_FADE_SCALE` 0.6): 0.2 at g = 0, 0.8 at
g = 1. At `filter` 1 a lit value `l` draws at brightness `unlitGain + (2.2 -
unlitGain) l` against 2.2 for a full result, so the brightest point that is not
a result reaches `0.07 + 2.13 x 0.8 = 1.77` and every one starts at
`0.07 + 2.13 x 0.2 = 0.50`. From t19 (deviation d6) to t22 the strength was a
setting, "The rest", with three levels: faint `0 + 0.2 g^2` (what was built
first), visible `0.08 + 0.45 g^2` and bright `0.2 + 0.6 g^2`, the default the
owner chose after seeing the three live (2026-11-17). It was never released.
On 2026-11-17 the owner merged it into Lit (deviation d9): the strength is the
former "bright", and the choice between a faded rest and a rest shown in full
is the Lit setting's. Sliders for the strength may be added later; they are
not built. With the relative view not shown the lit values are exactly
today's and no gradient is uploaded. `litCount` and `sharedCount` count only
the lit values from `litValues`. With Lit set to "by closeness" every point is
usually lit already, so the gradient changes nothing.

**Lit "all" has no gradient (t21, deviation d8).** Under the fourth Lit
setting, `"all"` ("everything, results highlighted"), `litValues` already
gives every point that is not a result the constant
`ET.searchSets.LIT_ALL_REST` (about 0.4366, the lit value at which the
renderer's brightness factor is 1), which is above 0. The relative view
uploads those values as they are: no gradient is worked out, and results are
at 1 exactly as under `"even"`. Choosing another Lit setting brings the
gradient back.

### Status line additions (t9)

The viewer adds to the mode's relative status, in this order, before its own `·
zoom` and `· paused`:

<!-- interface-strings module="50-viewer.js" task="t9" landed="yes" -->
```text
 · named results chosen and numbered by the reranker
 · with {letter}'s point of view, rank and height use different measures
 · ranked by cosine, so rank and height can disagree
The vertical axis is exact: height is {measure} to {letter}.
The horizontal axis is exact too: it is the part of {b} that {a} does not contain, so the plane of {a} and {b} is shown exactly.
The depth axis is exact too: all three axes are pinned, so the space of {letters} is shown exactly and nothing tumbles.
{axes} {tour} {m} directions holding {share} of the spread the pinned axes leave: sideways position is still a shadow, and points side by side on screen can be far apart.
Every vector has length one (within {tolerance}), which is why height is cosine similarity.
The vectors are not all of length one (lengths {min} to {max}), so height is length along the search, not cosine; results are still ranked by cosine, so rank and height can disagree.
With {letter}'s point of view on, its results are ranked in the scaled measure and height is not: rank and height use different measures.
```

- The first piece (`named results chosen and numbered by the reranker`) while
  any shown search was reranked (the reference's words); the second while the
  point of view is on (o15); the third on a set that is not unit-length (o4).
  Each starts with ` · ` as shown in the block (a space, a middle dot, a
  space).
- **Provenance**: while the relative view is shown, a row `Relative` (`dt`
  `Relative`, `dd` the sentences above that apply, in the order listed) is added
  after `View`; `{axes}` is `The other two axes` (with `{tour}` = `tour`) or
  `The depth axis` (with `{tour}` = `tours`), and the free-axes sentence is
  left out when nothing tours. The shadow
  sentence of the provenance block stays as it is. With the relative view not
  shown the row is absent. The summary line gains `relative to A` (the
  pinned letters, after the usual `·` separator) while shown.

### Drawing (t10)

- The overlay: in Tumble, every frame with the relative view shown or with Show
  the origin on, `ET.relativeOverlay.build` with the mode state and the draw
  state given to the renderer, then `paint` on the overlay canvas and
  `placeLabels` in `div.tumbler-relative-labels`; before the panel's
  `drawOverlay` (which gets `frame.relative`). Nothing of it is drawn in other
  modes or with the relative view not shown and Show the origin off; then the
  label layer is empty.
- `searches` is every search shown, in letter order. While the frame shown
  was built from other searches (from a changed search's commit until its fit
  switches in), the searches of the frame (`state.relative.searches`) come
  first, so the ruler's faint line follows the direction the frame is really
  pinned to; one that is no longer shown has no name. The searches shown now
  follow. `relative.settled` is false for all of that time, so nothing is drawn
  as exact (review of pull request 13, finding 8).
- `named` is every shown search's named results, each once (the reranked
  results when reranked); `ranks` only from searches whose reranker answered;
  `cut` only for the vertical search when it was reranked (`height` of the
  lowest of the `sent` candidates along it).
- Pitch: `pitch = clamp(0.16 * (1 - mix) + drag.pitch, -1.3, 1.3)`, so the
  settled relative view is level until the person tilts it (the reference
  eases its pitch to 0). `draw.perspective` comes from the mode's draw state
  and is passed to the renderer and to the overlay's placer unchanged.
- The test hook (the viewer's existing one) reports, for each named result, its
  drawn position and the height its cosine (unit-length set) or height maps to
  on the ruler (`list.results`), and the ruler's ends (`list.ruler`).

### The relative view is drawn sharp (t21, deviation d8)

The owner compared the build with the reference page on 2026-11-17: "The lit is
faint in that case for us, and sharp on the demo/reference." The build drew the
relative view with the renderer's depth blur and glow, in which a crowded cloud
melts together. So two draw keys follow the relative mix (`mix`: 0 in the plain
view, 1 once the relative view is settled, the value that eases the pitch):

<!-- interface-names module="50-viewer.js" object="ET.viewer" match="constants" task="t21" prefix="ET.viewer." landed="yes" -->
```text
RELATIVE_DEPTH_OF_FIELD
RELATIVE_BLOOM
```

| Draw key | At `mix` 0 | At `mix` 1 |
|----------|------------|------------|
| `depthOfField` | what the mode's draw state gives (Tumble: 1.1) | `ET.viewer.RELATIVE_DEPTH_OF_FIELD`, 0: no point is blurred or dimmed by its depth |
| `bloom` | the key is left out on a dark stage (the renderer's default, 0.55); 0.3 on a light stage | `ET.viewer.RELATIVE_BLOOM`, 0.2, or the value at `mix` 0 when that is already lower |

- Between the two, each key is `from * (1 - mix) + to * mix`, where `from` is
  the value the key would have had in the plain view (the mode's, the light
  theme's, else the renderer's default). Bloom is never raised: `to` is the
  smaller of `from` and 0.2. At `mix` 1 the values are exactly 0 and 0.2.
- At `mix` 0 nothing is touched: a key that was left out stays left out, so
  the plain view's draw state is bit for bit what it was (o9), with or without
  a search and with Relative on but no search.
- The theme's bloom is set first, so a light stage blends from 0.3, not from
  0.55.
- `wireDepthOfField` is left alone. Tumble draws no wires; the only wires seen
  in it are those fading out for about a second after a change of view from
  Lattice, and they keep their own depth blur for that second.
- Trails are not changed: 0.17 s as in every view, against the reference's
  about 0.03 s, and the Trails checkbox is as it was (the owner's decision).
- Other views are untouched: the mix is 0 outside Tumble.

## Web component (t11)

| Attribute | Property | Meaning |
|-----------|----------|---------|
| `relative` | `relative` (boolean) | The Relative setting. A boolean attribute: present (any value but `"false"`) is on, absent or `"false"` is off. |
| `show-origin` | `showOrigin` (boolean) | The Show the origin setting, the same way. |

Setting either before the viewer is mounted passes it as a mount option;
afterwards the shell calls `handle.setRelative`. A property set reflects to its
attribute and the reverse. The viewer's own setting is written back too: the
shell listens to the viewer's report (`onSearchChange`, as a mount option of its
own; the element has no such option for hosts) and, when a setting was changed
with the panel's checkbox or with `handle.setRelative`, sets or removes the
attribute, without calling the viewer again. So the attribute, the property and
`handle.relativeSettings()` always agree while a viewer is mounted. An attribute
whose value is `"false"` is left as it is while the setting is off. The shell holds no projection logic (the existing
no-logic check is extended to the relative names of t2, t3, t6 and t7).

<!-- interface-text file="js/shells/web-component.js" task="t11" landed="yes" -->
```text
"show-origin"
showOrigin
setRelative
```

The attribute `relative-rest` and the property `relativeRest` (t19, deviation
d6) were removed by t22 (deviation d9) before any release: the attribute is not
watched and is not passed on.

## Standalone page (t12)

| Address parameter | Meaning |
|-------------------|---------|
| `relative=1` | Mount with the Relative setting on (`0` or absent: off). |
| `origin=1` | Mount with Show the origin on (`0` or absent: off). |

The controls are the panel's (in the viewer the page mounts); the page reads
the parameters, passes them as mount options, and keeps them in the address
with `history.replaceState` when `onSearchChange` reports a change of a
setting, so a view can be reopened. The address is written only when
`relative` or `origin` does not already say what the viewer reports (read as at
load: the first value is `1`, or it is not), and then only that parameter
changes: every copy of it is taken out and, for on, `relative=1` or `origin=1`
is added at the end. The other parameters (`mode`, `seed`,
`data`, `sample`) are kept byte for byte as they were written (`%20`, `+`, a
repeated key), and so is any parameter the page does
not know: `rest=` (t19, deviation d6; removed by t22, deviation d9, before any
release) is neither read nor written, so an address that still carries it
loads as without it and keeps it.

<!-- interface-text file="js/page/page.js" task="t12" landed="yes" -->
```text
"relative"
"origin"
```

## Searches that give no axis

| Case | Reason code (t2) | Status (t6) | Panel note (t8) |
|------|------------------|-------------|-----------------|
| A query of length zero (a point search on an all-zero row, words whose mean cancels) | `zero-length` | `{letter} pins no axis` | `Search {letter} has no direction (its vector has length zero), so it pins no axis.` |
| A later search pointing the same way as an earlier pinned one (squared new part below `RELATIVE_SAME_DIRECTION`) | `same-direction` | `{letter} pins no axis` | `Search {letter} points the same way as {against}, so it adds no axis. It is still lit.` |
| A fourth search (or any search after three pinned) | `no-axis-left` | `{letter} pins no axis` | `Search {letter} is lit but has no axis: the first three searches pin all three.` |
| A set too small for the free axes (fewer directions of spread than free rows) | (`fixed > 0`) | (none) | `This set is too small for the free axes to follow its spread: {fixed} of {free} are fixed directions, not fitted ones.` |

A search that gives no axis is still ranked, lit and listed. When no search
gives an axis, the view is plain Tumble with the setting kept.

## Boundary (c6)

Relative search changes only the frame, the centre, the zoom, the perspective
and pitch of the drawing, and what is drawn over the picture. It adds no
callback and no request: turning it on or off, adding searches and showing the
origin send nothing anywhere (the core file still makes no request). It changes
no vector and nothing in the data contract: `docs/data-contract.md`,
`js/src/20-contract.js` and `embeddings_tumbler/_embed_route.py` are not
touched by any task of this plan (t4's hash test). Reranking in the relative
view sends exactly what reranking sends today. The ruler's title and the
result labels are text in spans, never markup.

## Which task proves which obligation

| Obligation | Proved by | How |
|------------|-----------|-----|
| o1 search vector -> vertical axis | t2, t6, t7, t13 | t2: row 1 dotted with each point equals the direct dot product within 1e-5 (Wikipedia and mixed-length fixtures); t6: settled flag false while turning, true after, row 1 equals `u` within 1e-6; t7: no ticks or stems while not settled; t13: heights hold within 1 px for 30 s |
| o2 set minus search directions -> free axes | t2, t6, t9 | t2: free rows orthogonal to pinned below 1e-6, share equals held / remainder total on the fitted rows within 1e-9; t6: frames; t9: the status line carries the share |
| o3 data, seed, searches, time -> frame | t6 | two fresh instances, same changes and times, fit pumped in one step and in one-unit steps, bit-identical frames, a search added mid-tour |
| o4 vector lengths -> words on screen | t2, t7, t8, t9, t13 | t2: the unit check on both fixtures; t7, t8, t9: labels, list rows, status and provenance on the mixed-length fixture never call the height cosine and show both numbers; t13: the rendered text in a browser |
| o5 origin control -> picture | t7, t10, t13 | t7: the marker's true distance equals `len(centre)` within 1e-6, the unit circle only on a unit-length set; t10: the window widens to 0, the plain marker; t13: the marker text holds 0.79 on the Wikipedia set |
| o6 renderer -> drawn height | t3, t13 | t3: the default leaves the shader sources and `place` unchanged, and at 60 equal heights are within 2 percent by the CPU place; t13: the same in a browser at desktop and phone widths, and unchanged pixels with relative off, on the software and the GPU renderer |
| o7 second, third and fourth search -> axes | t2, t6, t7, t8 | t2: directions and reasons; t6: both directions in the span of rows 0 and 1, three pinned means no row moves, a fourth changes no row, same-direction pins one; t7: the second ruler; t8: the notes |
| o8 reranker -> relative view | t6, t7, t9, t13 | t6: frames with reranking on and off bit-identical; t7: ranks 1 to top and the cut-off at the lowest candidate's height, none without reranking; t9: failure, timeout and no text keep embedding order, no ranks reach the overlay, the existing note; t13: in a browser with the test reranker |
| o9 relative off -> existing views | t4, all, t13 | t4: goldens of 0.12.1 for Tumble, Lattice, Wander and Focus; every task keeps them and the whole suite green; t13: screenshots pixel-identical with relative off |
| o10 Tumble setting -> host, web component, standalone page | t8, t9, t11, t12, t14 | t8: the controls in Tumble only; t9: mount option and handle, kept with no search; t11: attributes and properties; t12: controls and address; t14: documented |
| o11 reference page -> build | t13, t15 | t13: heights of the named results recomputed from the shipped pair; t15: heights to 2 decimals and the reranked order compared by a script, every difference listed, the owner's dated sign-off |
| o12 relative view -> network and data contract | t4, t13 | t4: the three contract files unchanged by hash; t13: the network log shows no request |
| o13 search change -> switch time | t2, t6 | t2: the fit gives the same result however pumped; t6: switch at a recorded T, `mark` and a seek before T reproduce the view then, abandoned fits change nothing |
| o14 search added or removed -> motion | t6, t9, t13 | t6: orthonormal within 1e-5 through every turn, the turn within `relativeTransition`, B keeps its letter and becomes vertical; t9: letters kept by `setSearches`; t13: pause and reduced motion stop the tour, no frame jumps |
| o15 point-of-view option -> relative view | t6, t9, t14 | t6: frames with the point of view on and off bit-identical; t9: the status line says rank and height use different measures; t14: the guide's example where the first by point of view is not the highest |

## Differences from the reference page decided here

For t15 to list in `docs/reference-differences.md` (with the ones the plan
already names: Relative as a Tumble setting rather than a switch; one and two
searches only on the page; Lit plus gradient against brightness by similarity;
no Face control on the page; reranking only for a single article on the page;
the page's 2-D canvas look):

1. The search's own point is the first result in the panel's list and is lit;
   the reference leaves it out (the overlay draws no stem or label for it).
2. The window's top is `max(search length, highest point) + 0.04` (the spec's
   words); the reference uses `max(1, search length) + 0.04`. They agree for a
   point search on a unit-length set and differ for an averaged search, whose
   length is below 1.
3. The window is along the vertical search only; the reference lowers the
   bottom to the lowest point along B as well when B is shown.
4. The zoom is capped at `0.5 / (0.42 x 0.46)` on every stage; the reference
   caps it by the stage's width, so a wide stage can be zoomed in further there.
5. The reference moves the stage's middle 3.5 percent down in the relative
   view; the build does not.
6. Result labels and ruler texts are DOM spans in the viewer's type, not canvas
   text in the reference's fonts (the viewer draws no text on a canvas and
   loads no web font).
7. The turn onto the pinned frame is the refit turn over 1.5 s of mode time; the
   reference blends with a smoothstep over 1.6 s of wall time and
   orthonormalises each blend.
8. A third search pins depth and a fourth has no axis (owner's decision); the
   reference shows two at most. Status strings for three searches are new.
9. The hover name keeps the viewer's format; the reference adds each search's
   height to it.
10. A search pointing the same way as an earlier one is found by the squared
    length of its new part (below 1e-6); the reference leaves a row whose
    remainder has norm at most 1e-12 unnormalised and then tests `s < 0.5`.
    The two agree for a repeated search and for any two different articles;
    they differ only for directions closer than about 0.06 degrees.

## Decisions made here

1. A named point searched from stays its own first result in the relative
   view; the overlay draws it as the search, and comparisons with the reference
   leave it out and use counts one higher. Reason: the spec's boundary keeps the
   ranking unchanged.
2. The unit-length tolerance is 0.001 on the shortest and longest lengths (the
   reference's). Reason: the reference is part of the spec.
3. A later search adds an axis unless it points the same way as an earlier
   pinned one: the squared length of its new part is below
   `RELATIVE_SAME_DIRECTION = 1e-6`. Reason: this is what the reference does
   (its 0.5 test runs after its rows are made unit length, so it separates a
   new direction, `s` = 1, from a repeated one, `s` about 0), and the owner
   approved Rice and Wheat (cosine 0.82) pinning two axes there (o11). 1e-6
   separates a repeated float32 query from any two different articles.
4. The gradient reaches the renderer in the lit values (no new buffer, no new
   key); non-results get `0.2 + 0.6 x g^2` by plain cosine (`0.2 x g^2` as first
   built; the strength was raised by deviation d6 and fixed by d9). Reason: the lit channel
   already does exactly this and is already proven unchanged at filter 0.
5. The perspective key is `draw.perspective`, default 3, relative value 60 (the
   reference's), set by Tumble from `mix`. Reason: the reference's number, and
   one key read by the shader and both JavaScript twins.
6. Relative and Show the origin are checkboxes in the search panel's controls
   row, shown only in Tumble; Face the searches is hidden while Relative is
   checked in Tumble. Reason: the row already holds a mode-specific control and
   t8 owns the panel.
7. The settings are `relative` and `showOrigin` everywhere (mount options,
   `handle.setRelative`, the mode's `setRelative`); the web component's
   attributes are `relative` and `show-origin`; the page's parameters are
   `relative` and `origin`. Reason: one name per setting across the layers.
8. `handle.setRelative` is its own synchronous method, not a key of
   `setSearchSettings`. Reason: that method re-ranks and supersedes, and a view
   setting should neither re-rank nor cancel a ranking in progress.
9. The relative state is reported inside `info().search` (`relative`), so the
   panel's `update(search)` and `onSearchChange` carry it with no new channel.
10. Tumble learns the searches through the existing `searchChanged` call (the
    viewer already makes it for any mode that has it) and the setting through
    `setRelative`; it reads only letters and queries. Reason: point of view and
    reranking then cannot reach the frame.
11. The turn takes `relativeTransition`, 1.5 s (Tumble's `transition`), not the
    refit's `"auto"` length (up to 12 s). Reason: the spec asks for the turn
    within the existing transition time, and the reference turns in 1.6 s.
12. Centre and zoom follow the window with the reference's margins (0.04, and
    -0.06 below the origin) and fill (0.78); the zoom is capped as the
    reference caps a narrow stage. Reason: the mode does not know the stage's
    shape.
13. The relative view's pitch is level (0.16 eased to 0 by `mix`) until the
    person tilts it. Reason: heights read true only untilted (o6).
14. Letters are kept by `setSearches` while the Relative setting is on.
    Reason: o14 requires it, and limiting it to the setting keeps everything
    with relative off as it is (o9).
15. The overlay is a draw list painted in two parts: shapes on the overlay
    canvas, texts as spans. Reason: the viewer never draws text on a canvas.
16. While not settled the overlay draws ruler A's line only. Reason: o1, the
    ruler must not look exact while the view turns.
17. The relative status line is longer than 70 characters. Reason: it must name
    the measure, which axes are exact and the remainder share, as the
    reference's does.
18. The free rows tour the set's strongest directions (the plain fit's, for the
    same set) with the search directions removed; the full fit of the remainder
    is kept only as the fallback, when no plain directions are given or fewer
    survive than there are free rows (deviation d4, approved by the owner on
    2026-11-17, task t18). Reason: the second fit cost as much as the page's
    first (more than 30 s on the owner's iPhone, 10.8 s on a CPU slowed eight
    times), while the reused directions hold 99.9 to 100 percent of its share on
    both real models for 29 to 51 times fewer multiply-adds
    (`docs/evidence/2026-11-relative-search.md`). A plain row is kept when at
    least `1e-3` of its squared length is left after the searches are removed;
    kept rows stay in the plain order. When the set's plain directions are not
    known yet, Tumble's relative preparation fits them itself (the same bits as
    the plain tour's fit) rather than falling back to the remainder fit, so the
    free rows always mean the same thing.
