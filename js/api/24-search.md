# `ET.search`: ranking one search (`js/src/24-search.js`)

Status: **interface, written before the code** (task t1). Task t2 implements it
exactly as written here. If something here cannot be built as written, t2 stops
and reports it; it does not quietly build something else. The rest of the
search interface (several searches, the renderer, the modes, the viewer, the
panel, the callbacks and the helper route) is in `docs/search-interface.md`;
several searches at once are in `js/api/26-search-sets.md`.

Pure JavaScript over the loader's set (`js/api/20-contract.md`, "The set"): no
DOM, no WebGL, no network, no clock except in steppers, where the clock decides
only how much work runs per call, never what is computed (the convention of
`js/api/10-math.md`, "Sliced work"). Reach it as `ET.search` inside the
wrapper, or as `api._internal.search` from tests.

## What this module answers

- **The distance measure** is cosine distance: `1 - cos(x, q)`, where
  `cos(x, q) = (x . q) / (|x| |q|)`, computed in double precision over every
  dimension of the data. It is called "cosine distance (1 minus cosine
  similarity)" wherever it is shown (`MEASURE_TEXT`). The cosine is clamped to
  `[-1, 1]`, so a distance lies in `[0, 2]`. The contract does not require
  unit-length vectors (`docs/data-contract.md`, "Vector block"), so this is not
  the straight-line distance for every file; the sky reference measures
  straight-line distance on its synthetic unit vectors, and this is an intended
  difference.
- **A zero row** (a loaded point whose vector, or whose scaled vector, is all
  zeros) has no direction. Its similarity is defined as 0 and its distance as 1.
  Decided here: it keeps the scan total and finite, and puts such a point at
  "unrelated" rather than nearest or farthest.
- **Results** are the `k` nearest points in the full space by that measure, `k`
  from 3 to 20, 8 by default. Ties are broken by the lower point index, so a
  ranking is a pure function of the set, the query vector, `k` and the scale.
  On-screen position is never an input to any function in this module.
- **Any loaded point can be a result**, labelled or not. Decided here: the sky
  reference lists only its named stars as results because its other points are
  stand-ins without text, but in a real Atlas every point carries text, and a
  labels-only set has no names at all.

## Shapes and units

`D` is `set.dimension`, `N` is `set.count`. Indices are row positions in
`set.vectors` (0-based). Ranks are 1-based. Distances are cosine distances
(numbers in `[0, 2]`), similarities cosines (`[-1, 1]`).

A **hit** (one result):

```js
{
  index,          // row in the set
  id,             // set.ids[index]
  distance,       // cosine distance to the query, in this search's measure (scaled when a scale is given)
  similarity,     // 1 - distance
  embeddingRank,  // 1-based rank by `distance` among all N points
  rank,           // 1-based final rank: equals embeddingRank until rerankOrder reorders
  moved,          // embeddingRank - rank: positive moved up, negative moved down, 0 same place
  score,          // the reranker's score, or null when not reranked
  plainDistance,  // cosine distance with no scale (equals distance when no scale is given)
  plainRank,      // 1-based rank by plainDistance among all N points (equals embeddingRank with no scale)
  gap,            // distance - the smallest distance among the final hits (0 for the nearest)
}
```

A **ranking** (the result of `rank` and of the stepper from `makeRank`):

```js
{
  measure: "cosine",
  k,                       // the clamped k asked for
  count,                   // N when the scan ran
  scaled,                  // true when a scale was given
  hits,                    // Hit[], min(k, N) of them, ordered by rank
  pool,                    // Hit[], the min(3k, N) nearest by distance, in embeddingRank order;
                           // hits are pool[0 .. k) (the same objects) until rerankOrder runs
  near,                    // the smallest distance among hits, or null when there are none
  radius,                  // the largest distance among hits (the result radius), or null
  distances,               // Float64Array(N): every point's distance in this search's measure
  plainDistances,          // Float64Array(N) with no scale when scaled, otherwise null
}
```

`distances` is what the several-search functions read for lit values and the
shared mark (`js/api/26-search-sets.md`), so it is in the same measure as
`radius`. A refusal is always `{ ok: false, code, message }` with `message` the
filled template from `MESSAGES` (plain text, never markup: insert it with
`textContent`).

## Constants

| Constant | Value | Meaning |
|----------|-------|---------|
| `ET.search.DEFAULT_K` | `8` | results asked for when none is given |
| `ET.search.MIN_K` | `3` | fewest results that can be asked for |
| `ET.search.MAX_K` | `20` | most results that can be asked for |
| `ET.search.POOL_FACTOR` | `3` | the reranking pool holds `POOL_FACTOR * k` candidates (the reference's) |
| `ET.search.PREFIX_MIN` | `3` | a word of at least this many characters may match the start of a word (below) |
| `ET.search.MEASURE` | `"cosine"` | the measure's id, as in `ranking.measure` |
| `ET.search.MEASURE_TEXT` | `"cosine distance (1 minus cosine similarity)"` | the measure's name wherever it is shown |
| `ET.search.MESSAGES` | object | refusal code to message template (below); frozen |

<!-- interface-names module="24-search.js" object="ET.search" match="constants" task="t2" prefix="ET.search." -->
```text
DEFAULT_K
MIN_K
MAX_K
POOL_FACTOR
PREFIX_MIN
MEASURE
MEASURE_TEXT
MESSAGES
```

## Refusal codes

Messages are fixed text with `{placeholders}` replaced by the values described
(numbers in decimal, strings as they are, without added quotes). Hosts and tests
may match on the code.

| Code | When | Message template |
|------|------|------------------|
| `no-data` | There is no set, or it has no points. | `There is no data to search yet.` |
| `reduction-not-searchable` | The set's `reduction.kind` is not `"none"` and the query would be compared as an embedded vector. | `Cannot search by embedding: the vectors in this data set were changed after embedding (reduction "{kind}"), and the file does not carry what is needed to change a query the same way. Search among the loaded points still works.` |
| `query-model-missing` | The query has no model id, or it is not a non-empty string. | `Cannot search: the embedder did not say which model made the query vector, so it cannot be checked against the data's model "{expected}".` |
| `query-model-mismatch` | The query's model id differs from `set.model`. | `Cannot search: the query was embedded by model "{found}" but the data was embedded by model "{expected}". One view compares one model.` |
| `query-not-vector` | The vector is missing, is not an array or a numeric typed array, or holds an entry that is not a number. | `Cannot search: the query is not a list of numbers.` |
| `query-dimension-mismatch` | The vector's length differs from `set.dimension`. | `Cannot search: the query vector has dimension {found} but the data has dimension {expected}.` |
| `query-non-finite` | An entry is NaN or infinite, before or after conversion to float32. | `Cannot search: the query vector holds a value that is not a finite number (at position {index}).` |
| `query-zero` | Every entry is zero, so the query has no direction. | `Cannot search: the query vector is all zeros, so it has no direction to compare.` |
| `point-unknown` | No point has the id given. | `No point with id "{id}" is in the view.` |
| `empty-query` | The text holds no word (no letter or digit). | `Nothing to search for: the query has no words.` |
| `words-none` | Not one word of the text matches a label or text among the loaded points. | `None of these words matches a label or text among the loaded points: {words}.` |
| `rerank-malformed` | The scores given to `rerankOrder` are not one finite number per pool candidate. | `The reranker's answer was not one score per candidate; the results stay in embedding order.` |

Placeholders: `{kind}` is the reduction kind (`rotation`, `top-k`); `{expected}`
is the set's value, `{found}` the query's; `{index}` is the 0-based position of
the first bad entry; `{id}` is the id as given; `{words}` is the unmatched words
in the order they appear in the text, separated by a comma and a space.

The viewer's own codes (callbacks failing, timing out, superseded searches,
more than four searches) are listed in `docs/search-interface.md`.

## Functions

<!-- interface-names module="24-search.js" object="ET.search" match="exact" task="t2" prefix="ET.search." -->
```text
clampK
format
checkSameSpace
checkQuery
makeRank
rank
rerankOrder
pointQuery
pointText
tokens
makeWordQuery
wordQuery
```

`ET.search` publishes exactly these functions and the constants above, nothing
else (`js/test/search-interface-docs.test.js` checks the names once the module
exists). Private helpers stay local to the module.

### `ET.search.clampK(k) -> integer`

`k` rounded to the nearest integer and clamped into `MIN_K .. MAX_K`. A value
that is not a finite number gives `DEFAULT_K`. Never throws.

### `ET.search.format(code, values?) -> string`

`MESSAGES[code]` with each `{name}` replaced by `String(values[name])`. Throws
`RangeError` for a code not in `MESSAGES` (a programming error).

### `ET.search.checkSameSpace(set) -> { ok: true } | { ok: false, code, message, kind }`

Whether an embedded query vector can be compared with this set. Schema version
1 carries nothing that would let a query be rotated or cut the same way as the
data, so any `set.reduction.kind` other than `"none"` is refused with
`reduction-not-searchable` (and `kind` the kind found). A set with no points is
`no-data`. A rotated file has the same dimension as the model, so the dimension
check alone would let a wrong comparison through; this check is what stops it.
Search among the loaded points (`pointQuery`, `wordQuery`) does not call this:
those queries are made from the set's own vectors, so they are in its space
whatever the reduction.

### `ET.search.checkQuery(set, query) -> { ok: true, vector } | { ok: false, code, message }`

Checks an embedded query `{ vector, model }` (what the host's `embed` callback
returned, or what a host passed to `setSearches`) against `set`, in this
order, stopping at the first failure:

1. `no-data`
2. `reduction-not-searchable` (`checkSameSpace`)
3. `query-model-missing`
4. `query-model-mismatch` (exact string comparison with `set.model`)
5. `query-not-vector` (accepted: an `Array` of numbers, a `Float32Array` or a
   `Float64Array`; not an `ArrayBuffer`, not a `BigInt` array)
6. `query-dimension-mismatch`
7. `query-non-finite`: checked on the float32 copy, so a finite double too large
   for float32 (it becomes infinite) is refused here
8. `query-zero`

On success `vector` is a new `Float32Array(D)` copy: later changes to the
caller's array change nothing. A refusal never reaches the renderer.

### `ET.search.makeRank(set, vector, options?) -> stepper`

The exact scan for the nearest points, sliced. `vector` is a checked query
(`Float32Array(D)`, from `checkQuery`, `pointQuery` or `wordQuery`). Options:

| Option | Default | Meaning |
|--------|---------|---------|
| `k` | `DEFAULT_K` | results asked for; passed through `clampK` |
| `scale` | `null` | `Float32Array(D)`: rank with every dimension of both the query and each point multiplied by `scale[d]` (the point-of-view option, `js/api/26-search-sets.md`). With a scale, `plainDistances` and each hit's `plainRank` and `plainDistance` are filled from the unscaled vectors in the same pass. |

The stepper is `ET.math`'s: `{ step(budgetMs?) -> done, done, progress,
result }`. `step(budgetMs)` runs units until `budgetMs` milliseconds have passed
(always at least one); `step()` runs to the end. `result` is the ranking once
`done`, `null` before.

- **Units stay under 4 ms** on 10,000 points of 1,024 dimensions on the
  development machine (t2 measures and records the longest unit on its API
  page). A unit ends after a fixed number of rows or once 1 ms has passed,
  whichever comes first, as `ET.math`'s steppers do.
- **The result is identical** whatever budgets drove it, and identical to
  `rank(set, vector, options)`: same hits in the same order, same numbers bit
  for bit.
- Throws `TypeError` when `vector` is not a `Float32Array` of length `D`, or
  `scale` is given and is not a `Float32Array` of length `D` (programming
  errors; data errors are refused earlier by `checkQuery`).
- A set with no points gives a ranking with empty `hits` and `pool`, `near` and
  `radius` `null`, and empty distance arrays.
- The stepper reads `set.vectors` while it runs and keeps no other reference
  after `done`. A set is never mutated by an append (`js/api/20-contract.md`),
  so a scan that started before an append finishes on the set it started on;
  the viewer marks it stale (`docs/search-interface.md`).

### `ET.search.rank(set, vector, options?) -> ranking`

`makeRank(set, vector, options)` run to the end in one call. For tests and for
small sets; the viewer uses the stepper.

### `ET.search.rerankOrder(ranking, scores) -> { ok: true, hits, near, radius } | { ok: false, code, message }`

Reorders a ranking with a reranker's scores. `scores` holds one finite number
per entry of `ranking.pool`, in pool order (the order the candidates were sent
in); higher means more relevant. Anything else is refused with
`rerank-malformed`, and the caller keeps the embedding order.

On success the new `hits` are the `k` (`ranking.k`, at most the pool's length)
pool entries with the highest scores, ties broken by the lower `embeddingRank`.
Each new hit is a copy of its pool entry with `rank` (its position, from 1),
`moved = embeddingRank - rank`, `score` and `gap` (distance minus the smallest
distance among the new hits) filled in. `near` and `radius` are the smallest
and largest distance among the new hits: the result radius after reranking, so
"every point as near as the last named result" still holds. The ranking passed
in is not changed; the viewer keeps a copy of it with `hits`, `near` and
`radius` replaced by these, and that copy is what it passes to
`ET.searchSets.litValues` and `pairReports`.

### `ET.search.pointQuery(set, id) -> { ok: true, index, id, vector } | { ok: false, code, message }`

The query for a search from a loaded point: `vector` is a new `Float32Array(D)`
copy of the point's row. The point is its own nearest result, at distance 0
(as in the Focus reference). Refusals: `no-data`, `point-unknown`. Works for any
reduction kind and with no embed callback.

### `ET.search.pointText(set, index) -> string`

The text to show for a point in a result list and to send to a reranker:
`points[index].metadata.text` when it is a non-empty string, otherwise the
label when it is a non-empty string, otherwise the id. Decided here: a producer
following `docs/guides/producer.md` writes the record's text as the label, and
a richer text may sit in `metadata.text`; the longer text is the better one to
read and to rerank. It is untrusted text: insert it with `textContent`. Never
cut here; the panel decides what to cut on screen.

### `ET.search.tokens(text) -> string[]`

The words of a text as word search reads them: the text lower-cased with
`toLowerCase()`, split into maximal runs of Unicode letters and digits
(`/[\p{L}\p{N}]+/gu`), each word kept once, in order of first appearance. A
text that is not a string gives `[]`.

### `ET.search.makeWordQuery(set, text) -> stepper`

Search among the loaded points by words, with no embedding. The stepper's
`result`, once done:

```js
{ ok: true, vector, words, used, unmatched, whole }
{ ok: false, code, message, words, unmatched }
```

- `words` is `tokens(text)`; `unmatched` the words that matched nothing, in
  that order (never silently dropped: the panel names them).
- A point's searchable text is its label and, when it is a string,
  `metadata.text`; a point's words are `tokens` of each.
- **Whole text first.** When the query's words joined by single spaces equal
  the words of a point's label or text joined the same way, the query is the
  mean of the vectors of every such point; `whole` is `true`, `used` is
  `[{ word: <the joined words>, how: "whole", count }]` and `unmatched` is `[]`.
  (The Focus reference does this: a whole stored phrase is placed from its own
  vector.)
- **Otherwise word by word.** A word matches the points that have it as one of
  their words (`how: "exact"`). A word with no exact match anywhere and at least
  `PREFIX_MIN` characters matches the points with a word that starts with it
  (`how: "prefix"`). The query is the mean, over the matched words, of the mean
  vector of each word's points: each matched word has one equal share however
  many points it matches. Decided here, following the sky reference (one share
  per word), so a word that names a large group does not drown a word that
  names one point. `used` is `[{ word, how, count }]` in word order, `count`
  being the number of points the word matched.
- Means are accumulated in double precision and stored as float32.
- Refusals: `no-data`; `empty-query` when `words` is empty; `words-none` when
  every word is unmatched; `query-zero` when the mean comes out all zeros.
- Sliced like `makeRank` (units under 4 ms on 10,000 points), and the result is
  identical whatever the budgets. A cache of each set's words, keyed by the set
  object, is allowed if it changes no result.
- Works for any reduction kind and with no embed callback: the query is made
  from the set's own vectors.

### `ET.search.wordQuery(set, text) -> result`

`makeWordQuery(set, text)` run to the end in one call.

## How the viewer uses it

```js
// a search by embedded text (the host's callback answered { vector, model })
var c = ET.search.checkQuery(set, answer);
if (!c.ok) return showRefusal(c);                    // nothing changes in the view
var job = ET.search.makeRank(set, c.vector, { k: k });
// each frame, inside the viewer's budget:
if (!job.done) job.step(budgetLeft);
if (job.done) useRanking(job.result);
```

The point-of-view option passes `scale: ET.searchSets.scaleFor(c.vector)` for
the one search it belongs to. A reranker gets the texts of `ranking.pool`
(`pointText`) and its scores go through `rerankOrder`.

## Measured and implemented (task t2)

- **Longest unit**, 10,000 points of 1,024 dimensions, node on the development
  machine (12 cores, load average 3 to 8 from other agents' builds): 1.5 to 2.2
  ms plain and 1.0 to 1.7 ms with a scale; one run under load showed 4.1 ms plain
  and 13 ms scaled (a cold, first-run unit). A whole scan is about 20 to 40 ms in
  20 to 80 units. The unit test asserts under 20 ms and is skipped when the
  one-minute load average exceeds half the cores.
- A scan with a scale does two sums per dimension for each row (plain and
  scaled) and counts the plain rank of each pool entry in a final unit per entry.
- `tokens` keeps each word once, so the whole-phrase comparison in
  `makeWordQuery` compares de-duplicated words on both sides ("to be or not to
  be" is the phrase "to be or not").
- A word's prefix match is tried only when the word matches no point exactly;
  a word of at least `PREFIX_MIN` characters counts characters by code point.
- Refusals from `makeWordQuery` for `no-data` list every word as unmatched.
- The scale's values are not checked for finiteness (only type and length).
