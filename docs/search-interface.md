# Search interfaces

Status: **interface, written before any code** (task t1 of
`docs/plans/2026-11-14-search-in-the-embedding-viewer.md`). Every later task of
that plan builds against this page and the two module pages it points to:

- `js/api/24-search.md`: `ET.search`, one search's ranking (t2).
- `js/api/26-search-sets.md`: `ET.searchSets`, several searches, what is lit,
  pair reports, the point of view and the facing frame (t3).

This page gives everything else: the renderer's per-point lit value (t4), the
helper route (t5), the modes' facing hook (t6), Focus (t7), the viewer's
options, handle methods and `info()` additions (t8), the panel (t9), the web
component (t10) and the standalone page (t11), and the embed and rerank
callback contracts. A task that needs something these pages do not give stops
and reports it. Where the spec left a choice open, this page decides it and says
so ("Decided here"), with the reason in one line; the decisions are also
collected at the end.

The spec is `docs/specs/2026-11-14-search-in-the-embedding-viewer.md` with its
obligations page; the behaviour to match is
`docs/specs/reference/tumbler-sky-search.html` (search in Tumble, Lattice and
Wander) and `docs/specs/reference/tumbler-focus-view.html` (Focus).

Each block of names under an `interface-names` comment on these pages is
checked by `js/test/search-interface-docs.test.js` against the module it
documents, once that module (or, for a module that existed before search, the
first of the listed additions) exists.

## Where this starts

It is true today that the shipped viewer has **no way to select, highlight or
dim points**. In `js/api/50-viewer.md`, "The handle" lists every member a host
can call (`update`, `destroy`, `pause`, `resume`, `isPaused`, `setMode`,
`mode`, `modes`, `time`, `seek`, `seed`, `setSpeed`, `zoom`, `resetZoom`,
`refreshTheme`, `info`): none of them names a point, and none changes how a
point is drawn. The only per-point brightness is fixed when the points are
uploaded, from whether a point is labelled (`js/api/50-viewer.md`, "Crowded
sets"; the renderer's `weights` in `js/api/30-renderer.md`), and the modes'
`dim` applies to all unlabelled points alike. Nothing exposes projected
positions to the host, and the core file makes no network request
(`js/api/50-viewer.md`, "Security notes"). Search therefore needs new surface in
the renderer, the modes, the viewer and a new panel, all specified below.

## Terms and units

| Term | Meaning |
|------|---------|
| Distance | Cosine distance, `1 - cosine similarity`, over every dimension of the data, in double precision. Shown as "cosine distance (1 minus cosine similarity)" (`ET.search.MEASURE_TEXT`). Numbers in `[0, 2]`. It is the same number used for ranking, for what is lit, for the pair reports and for what the Distance difference control writes; never a length in the picture. |
| Search | One query (embedded text, a host's vector, words matched among loaded points, or a loaded point) and its ranking. Up to 4 at once, lettered A to D in the order given. |
| Kind | How a search's query was made: `"embedded"` (typed text through the host's `embed` callback), `"vector"` (a vector the host passed), `"words"` (words matched among loaded points, no embedding), `"point"` (a loaded point's own vector). |
| Named point | A point that carries something a person can read that is not just its id: its `metadata.text` or its `label` is a string with a character that is not white space and differs from its id (`ET.search.isNamed`). On a real file every point is named; in the built-in sample set 290 of 12,288 are; in a labels-only set none is. |
| Results, named results | The `k` nearest named points of a search (3 to 20, 8 by default), after reranking when a reranker ran. With no named point in the set every point is a candidate and results show ids; with fewer named points than `k`, the results are all of them. The query itself can come from any point. |
| Result radius | The distance of a search's farthest named result. A point is inside a search when it is at most that far, named or not. |
| Lit value | Per point, a number in `[0, 1]`: how strongly the searches light it. Set by the lit setting (`"even"`, `"close"`, `"named"`). |
| Shared mark | On a point that is lit and inside two or more searches. |
| Point of view | An option on one chosen search: every dimension scaled by the absolute value of that search's query in that dimension, for its ranking, its shown distances and the fitted picture. |
| Facing frame | The seeded linear view whose first axes join the centres of the searches (`ET.searchSets.makeFacingFrame`). |
| Swing | About 6 seconds of mode time during which a mode is drawn toward the facing frame while still drifting. |
| Waiting | A search is waiting while a callback has not answered or its ranking is still being worked out. |
| Stale | Results worked out before points were appended, shown as such until worked out again. |

## Who builds what

| Task | File(s) | Interface |
|------|---------|-----------|
| t2 | `js/src/24-search.js` | `ET.search` (`js/api/24-search.md`) |
| t3 | `js/src/26-search-sets.js` | `ET.searchSets` (`js/api/26-search-sets.md`) |
| t4 | `js/src/30-renderer.js` | `renderer.setLit`, draw keys `filter` and `unlitGain`, `status().lit` (below) |
| t5 | `embeddings_tumbler/_embed_route.py`, the `viewer serve` verb | the helper route (below) |
| t6 | `js/src/39-modes.js`, `40-`, `41-`, `42-` | the mode instance member `face` (below) |
| t7 | `js/src/43-mode-focus.js` | the mode `"focus"` and its member `searchChanged` (below) |
| t8 | `js/src/50-viewer.js` | mount options, handle methods, `info().search`, viewer refusal codes (below) |
| t9 | `js/src/45-search-panel.js` and its hook in the viewer | `ET.searchPanel`, the panel's DOM and custom properties (below) |
| t10 | `js/shells/web-component.js` | the `embed` and `rerank` properties (below) |
| t11 | `js/page/` | the standalone page's use of the helper route (below) |

Data flow for one embedded search: panel or host -> `handle.setSearches` ->
host `embed(text)` -> `ET.search.checkQuery` -> `ET.search.makeRank` (sliced,
in the frame budget) -> optional host `rerank(query, candidates)` ->
`ET.search.rerankOrder` -> `ET.searchSets.litValues`, `pairReports`,
`makeFacingFrame` (sliced) -> `renderer.setLit` and the mode's `face` ->
`info().search` and the panel.

## Renderer (t4): the per-point lit value and the shared mark

Additions to `js/api/30-renderer.md`. The renderer still computes nothing about
searches: it draws the lit values it is given.

<!-- interface-names module="30-renderer.js" object="renderer" match="present" existing="yes" task="t4" prefix="renderer." -->
```text
setLit
```

### `renderer.setLit(lit, shared?) -> { ok, uploaded }`

- `lit`: `Float32Array(count)`, one lit value per point, read as clamped to
  `[0, 1]`. `null` clears it: no search, and drawing is exactly today's.
- `shared`: optional `Uint8Array(count)`, 1 where the shared mark is drawn.
  `null` or absent: no point is marked.
- The renderer keeps a CPU copy and uploads it to its own per-point buffer with
  one `bufferSubData` (or `bufferData` when the size changes). **The point
  vectors are not re-uploaded.** A call with an unchanged array is allowed and
  costs one upload of `count` floats (plus `count` bytes).
- Throws `TypeError` when a length differs from the current count or a type is
  wrong (programming errors, like `setData`'s shape errors).
- Returns `{ ok: true, uploaded }` (`uploaded: false` while the context is lost
  or after a failed build, as for `setData`), `{ ok: false, reason, message }`
  on a GL failure, or `"disposed"` after `dispose`.
- `setData` clears the lit values (a replace starts with no search). `appendData`
  keeps them and gives each appended point lit value 0 and no mark, so new points
  are dimmed until the viewer re-runs the searches. `setWires` does not touch
  them.
- Context restore and `rebuild()` re-upload the CPU copy; `dispose()` deletes the
  buffer (the leak counters stay at baseline); `status()` gains `lit: boolean`,
  true while lit values are set.

### Draw keys

| Key | Meaning | Default |
|-----|---------|---------|
| `filter` | 0..1, how much the lit values apply this frame. The viewer eases it toward 1 while any search is active and toward 0 when none is (the reference's `filterMix`, time constant 0.35 s). | `0` |
| `unlitGain` | the brightness factor of a point whose lit value is 0, at `filter` 1 | `0.07` |

With `filter` above 0 and lit values set, per point with lit value `l` and mark
`m` (the reference's shader terms):

- size is multiplied by `mix(1, mix(0.8, 1.5, l), filter)`;
- brightness is multiplied by `mix(1, mix(unlitGain, 2.2, l), filter)`;
- a marked point adds white `0.9 * alpha * gain * filter` (it burns white on the
  dark stage). On the light (soft ink) stage the points are drawn in
  complementary colours and the canvas is inverted (`js/api/50-viewer.md`,
  "Light backgrounds"), so the white comes back as dark ink; t4 checks by pixel
  colour that the mark is visible on both stages.
- Focus's Only results setting draws with `unlitGain: 0`: a point with lit value
  0 adds nothing to the additive image, so it is hidden there. The other three
  modes never set it; they dim and never hide.

**With `filter` 0, or with no lit values set, the frame is byte-identical to
today's**: the existing frame-hash test passes unchanged. How that is achieved
(a separate program path, or terms that are exactly 1) is t4's choice; the hash
test is the judge, and it is never re-pinned. The no-HDR fallback applies the
same terms.

## Modes (t6): the swing toward the facing frame

Addition to `js/api/40-modes.md`. `face` is an **optional** member: it is not
added to `ET.modes.INTERFACE`, so a host's mode registered without it still
conforms, and the viewer calls it only when present.

<!-- interface-names module="40-mode-tumble.js" object="mode:tumble" match="present" existing="yes" task="t6" prefix="inst." -->
```text
face
```

<!-- interface-names module="41-mode-lattice.js" object="mode:lattice" match="present" existing="yes" task="t6" prefix="inst." -->
```text
face
```

<!-- interface-names module="42-mode-wander.js" object="mode:wander" match="present" existing="yes" task="t6" prefix="inst." -->
```text
face
```

### `inst.face(target, t, options?) -> boolean`

Starts a swing at mode time `t` toward `target = { frame, centre, zoom }` (the
result of `ET.searchSets.makeFacingFrame`; the instance copies it).
`options.duration` is the swing's length in seconds of mode time, default `6`;
`options.searches` is how many searches it faces (1 to 4), for the status line.
Returns `true` when the swing was taken, `false` when the instance is not ready,
the set is empty or the target's frame has the wrong length (nothing changes).

`inst.face(null, t)` ends a swing in progress at `t`: the mode carries on from
the frame shown at `t`, with no jump. It returns `true` if a swing was ended.

Rules (o2, c7, c8):

- **A swing is an event at a fixed time** (see "Events" in `js/api/40-modes.md`):
  once `face` has been called, `stateAt(t)` stays a pure function of the data,
  seed, entry view, event times (refits, wire lists, swings) and `t`. `t` before
  the swing's start gives the state as it was. Two fresh runs with the same
  data, searches, seed and calls give the same frames bit for bit.
- **It never holds the view.** From `T` to `T + duration` the frame is the
  mode's own motion carried on (at half its rate, as the reference does) and
  pulled toward `target.frame` with weight `1 - exp(-2 (t - T))`,
  orthonormalised; the centre and zoom are pulled toward `target.centre` and
  `target.zoom` with the same weight. The frame differs between every pair of
  consecutive seconds during and after the swing.
- **It ends by itself** at `T + duration`. From then on the mode's own motion
  carries on from the frame, centre and zoom shown at that moment, with no
  jump: Tumble blends back into its tour from that frame (as on entry with
  `from`); Lattice starts a new swap schedule from that frame and keeps
  swapping axes; Wander starts its next hop from that frame and centre and keeps
  flying between points. Mode time does not restart.
- **Pause and reduced motion** stop it as they stop everything: the swing runs
  on mode time, which does not advance while paused.
- A new `face` during a swing starts a new swing from the frame shown at its
  time. `dataChanged` (an append) keeps a swing in progress. Leaving the mode
  (a mode switch) ends it; the next mode enters from the last frame drawn, as
  today. Decided here: the swing belongs to the mode it started in, which keeps
  every mode switch jump-free without carrying swing state across modes.
- **Status** during a swing: `swinging to face the search, then <verb> on`, or
  `swinging to face the N searches, then <verb> on`, where `<verb>` is
  `tumbling`, `swapping axes` or `wandering` (the reference's wording).
  `describe().facing` is `null`, or `{ at, until }` in mode time.

As built (t6; details in `js/api/40-modes.md`, "Facing the searches"):

- The drift during a swing is a seeded drift at half the reference tumble's
  rate (0.21 rad/s per axis, its direction turning), the same in all three
  modes, as the reference tumbles during a swing in every mode; it is not each
  mode's own motion. With the pull written literally as `orth((1 - w) own + w
  target)` the drift dies with `1 - w`, so the view would be held near the
  target for the last seconds, and Wander's own motion is still while it
  dwells. The frame is the closed-form solution of the reference's pull with
  that drift, so it keeps moving about the target.
- Tumble comes back to its tour with the refit turn (a fixed rotation unwound
  at a bounded rate), not the entry blend, which turned about five times faster
  than the tour (measured).
- `face` also returns `false` when the centre does not have `D` values, a value
  is not finite, the zoom is not a positive finite number, or `duration` is not
  a positive finite number. A `t` before the last swing's start is moved up to
  it. `describe().facing` reports the newest swing, which may have ended.
- Wander dwells at each stop with the frame still, with or without a search;
  "differs between every pair of consecutive seconds" holds for it during the
  swing and outside those dwells.

Lattice and Wander still draw their own wires and spokes during a swing. Wander's
route is unchanged by search (the spec leaves open whether Wander should visit
the results; this plan does not).

## Focus (t7): the fourth mode

A new file that registers through the existing interface
(`ET.modes.register({ id: "focus", title: "Focus", summary, create })`), with
no change to any existing mode file or to the data contract. It is a mode like
the others, with the members of `js/api/40-modes.md` ("The interface a mode
instance implements"): `inst.enter`, `inst.prepare`, `inst.isReady`,
`inst.stateAt`, `inst.step`, `inst.status`, `inst.dataChanged`,
`inst.describe`, `inst.mark` and `inst.leave`, plus `inst.searchChanged`:

<!-- interface-names module="43-mode-focus.js" object="mode:focus" match="present" task="t7" prefix="inst." -->
```text
enter
prepare
isReady
stateAt
step
status
dataChanged
describe
mark
leave
searchChanged
```

### `inst.searchChanged(search, t) -> stepper | null`

Called by the viewer, with `t` the mode's clock, whenever the active searches or
their results change (a new search, a settings change, a re-run after an
append, a clear) and once right after the viewer switches into the mode while
searches are active. When it returns a stepper (or `{ work: stepper }`), the
viewer queues it with the mode's preparation jobs, pumps it within the frame
budget, drops it if the mode restarts (as for a refit), and calls
`inst.mark(clock)` after pumping as every frame. `null` (or nothing): nothing to
pump. `search` is `null` (no search) or:

```js
{
  searches: [{ letter, query: Float32Array(D), indices: Int32Array }],  // named results' indices
  scale: Float32Array(D) | null,    // the point-of-view scale, when the option is on for one search
  onlyResults: boolean,             // the Only results setting
}
```

- With searches, the frame is a seeded, deterministic fit of the union of every
  search's query and named results (the Focus reference fits the results and
  the query), in the point-of-view scaled space when `scale` is given and
  mapped back to an orthonormal frame on the loaded vectors as in
  `makeFacingFrame` step 7. With none, it is the fit of the whole set. Changing
  the search turns smoothly onto the new fit (a blend in mode time, like a
  mode entry), and the fit runs in slices within the frame budget like any
  preparation.
- `onlyResults` true sets the draw key `unlitGain` to 0, so unlit points are
  hidden in Focus only. The viewer also skips hidden points when it hit-tests
  and labels: while the mode id is `"focus"`, its `describe().onlyResults` is
  true, lit values are set and the filter is above 0, a point whose lit value is
  0 is skipped by the hover name, the group-name centres and the click test.
- Status: `fitted to the results of A, B` (letters) or `fitted to every point`
  with no search; `describe()` reports `{ id: "focus", projection, seed,
  fittedTo: "results" | "all", searches, onlyResults, varianceShare: null }`.
- Focus has **no `face` member**: its view is already fitted to the results, so
  the panel's Face the searches control is disabled in Focus. Decided here: a
  swing toward a second frame would fight the fit Focus exists to show.
- Frames are deterministic for the same data, searches, seed and time.
- Only in Focus, a click on a point (a press and release within 5 px, within 16
  px of the point) searches from that point: the viewer calls
  `setSearches([{ point: id }])`. Decided here: in the other three modes a click
  keeps today's meaning (it focuses the viewer), so their input is unchanged.

## Viewer (t8): options, handle and `info()`

Additions to `js/api/50-viewer.md`.

### Mount options

| Option | Default | Meaning |
|--------|---------|---------|
| `embed` | none | The host's embed callback (contract below). Without it, typed text is matched among loaded points. |
| `rerank` | none | The host's rerank callback (contract below). Without it there is no Reranker control and no reranking. |
| `searchTimeoutMs` | `15000` | How long a callback may take before its answer is dropped with `embed-timeout` or `rerank-timeout`. |
| `searchPanel` | `true` | `false`: no panel (the handle still does everything the panel does). |
| `searchK` | `8` | Results per search, through `ET.search.clampK`. |
| `searchLit` | `"even"` | The starting lit setting, through `ET.searchSets.litSetting`. |
| `onSearchChange(search)` | none | Called with `info().search` whenever it changes (a search set, answered, refused, cleared, stale, re-run). Guarded like the other callbacks. |

The callbacks can also be set after mount with `setSearchCallbacks`, which is
what the web component uses.

### Handle methods

<!-- interface-names module="50-viewer.js" object="handle" match="present" existing="yes" task="t8" prefix="handle." -->
```text
setSearches
clearSearches
setSearchSettings
searchSettings
faceSearches
setSearchCallbacks
```

#### `handle.setSearches(list) -> Promise<result>`

Replaces every active search with the searches in `list` (an array of 0 to 4
entries; `[]` is the same as `clearSearches()`). Each entry is one of:

| Entry | Kind | Meaning |
|-------|------|---------|
| a string, or `{ text, via? }` | `"embedded"` or `"words"` | Typed text. `via`: `"auto"` (default), `"embed"` or `"words"`. `"auto"` embeds when an `embed` callback is set and `ET.search.checkSameSpace(set)` passes, and otherwise matches words among loaded points; when it falls back because of the reduction, the search carries the `reduction-not-searchable` message as its note. `"embed"` with no callback is refused with `no-embedder`; on a reduced set with `reduction-not-searchable`. |
| `{ vector, model, label? }` | `"vector"` | A vector the host already has, checked with `ET.search.checkQuery`. `label` (text) names it in the panel; default `"vector"`. |
| `{ point }` | `"point"` | A loaded point's id (`ET.search.pointQuery`). |

The promise resolves (it never rejects) to:

```js
{ ok: true, search }                 // search = info().search after the searches took effect
{ ok: false, code, message }         // nothing changed: the earlier searches and the view are as they were
```

- **All or nothing.** If any entry is refused (a callback failed, timed out or
  answered wrongly, a vector was refused, a point is unknown), nothing changes
  and the promise gives that refusal; the earlier searches, the lit set and the
  view stay. Words that match nothing are not a refusal: a `"words"` entry whose
  words all match nothing is left out, its words are listed in
  `info().search.unmatched`, and the other entries go ahead (letters are given
  to the searches that remain, in order). If every entry is left out that way,
  the result is `words-none` and nothing changes.
- **Latest wins.** Each call supersedes the calls before it: an earlier call
  still waiting resolves with `superseded`, and any answer its callbacks give
  later is dropped.
- More than 4 entries is refused with `too-many-searches` (decided here: refuse
  rather than drop silently; the panel itself sends at most the first four lines
  and says so).
- The `embed` callback is called once per `"embedded"` entry, with the entry's
  text and nothing else. The core file still makes no network request.
- When the searches take effect: the lit values go to the renderer
  (`setLit`), the facing frame is worked out and the current mode's `face` is
  called (a new search swings the view, once), Focus's `searchChanged` is
  called, and `onSearchChange` fires. A swing is started only by
  `setSearches` and `faceSearches`, never by a re-run after an append or by a
  settings change. Decided here: a re-run answers no new question, and a swing
  per streamed append would hold the view toward a moving target.

#### `handle.clearSearches() -> boolean`

Removes every search at once (and supersedes any waiting call). The lit values
are cleared with `setLit(null)` once `filter` has eased to 0, a swing in
progress is ended with `face(null, t)`, and Focus gets `searchChanged(null)`.
Returns `false` when there was nothing to clear or after `destroy`.

#### `handle.setSearchSettings(patch) -> Promise<result>`

Changes settings and works the searches out again from the query vectors
already held (no new `embed` call). `patch` may hold:

| Setting | Values | Default | Effect |
|---------|--------|---------|--------|
| `k` | 3 to 20 (`clampK`) | `searchK` | re-rank every search |
| `lit` | `"even"`, `"close"`, `"named"` | `searchLit` | new lit values only |
| `distances` | boolean | `false` | the Distance difference control: distances on links and in lists (panel only) |
| `rerank` | boolean | `false` | rerank every search; ignored (stays `false`) with no `rerank` callback or on a labels-only set |
| `pointOfView` | `"A"` to `"D"` or `null` | `null` | the point-of-view option belongs to this search (re-rank it with its scale, and fit the picture with that scale) |
| `onlyResults` | boolean | `false` | Focus's Only results setting |

Unknown keys and invalid values are ignored. Resolves to `{ ok: true, search }`
or a refusal (a `rerank` callback that fails gives `{ ok: true }` with the
search in embedding order and the failure in its note, see "Reranking"). Latest
wins here too.

#### `handle.searchSettings() -> object`

A copy of the settings above.

#### `handle.faceSearches() -> boolean`

Repeats the swing toward the facing frame (the Face the searches control).
`false` with no search, in a mode with no `face` member (Focus), or while the
facing frame is still being worked out.

#### `handle.setSearchCallbacks({ embed?, rerank? }) -> { embedder, reranker }`

Sets or replaces the callbacks after mount; `null` removes one, an absent key
keeps it. A value that is not a function or `null` is ignored. Returns which
are now available. Searches already shown are kept; a call waiting on a
removed callback is superseded.

### Reranking

With `rerank` on and a `rerank` callback set, each search's `pool` (the
`3 x k` nearest named points, `ET.search.POOL_FACTOR`; every point is a
candidate when none is named) is sent as candidate texts
(`ET.search.pointText`) with the query text, and the answer goes through
`ET.search.rerankOrder`. The query text is the typed text (embedded and word
searches), the point's text (point searches) or the `label` given (vector
searches; a vector search with no label is not reranked and says so). A
labels-only set (`text_included: false`) offers no reranking at all (o10). If
the reranker fails, times out or answers wrongly, the search keeps its
embedding order, `reranker` is `null` and its note gives the message; this is
not a refusal of the search. Decided here: embedding results are valid on their
own, so a failed second scorer should not take them away.

### `info().search`

`info()` gains one key, `search`, always present:

```js
search: {
  active,              // boolean: at least one search shown
  waiting,             // boolean: a callback or a ranking is still working
  stale,               // boolean: results are from before the latest append
  staleBy,             // points appended since the results were worked out (0 when fresh)
  code, message,       // the latest refusal or note for the whole set, or null
  measure,             // ET.search.MEASURE_TEXT
  settings,            // as searchSettings()
  embedder: { available },
  reranker: { available, offered },   // offered: available and the set carries text
  sameSpace: { ok, kind },            // ET.search.checkSameSpace for the set shown
  litCount, sharedCount,              // from ET.searchSets.litValues
  unmatched,           // string[]: words that matched nothing, across every entry
  facing,              // boolean: a swing is in progress
  faceable,            // boolean: the current mode has a face member (false in Focus), so
                       // the Face the searches control can be disabled from this alone
  searches: [{
    letter,            // "A" .. "D"
    kind,              // "embedded" | "vector" | "words" | "point"
    text,              // the typed text, the label, or the point's id
    model,             // the model id the embed callback reported, or the data's model for
                       // "words" and "point" (made from the data's own vectors), or the
                       // vector entry's model
    queryForm,         // what the embed callback reported (for example "query"), or null
    sentTo,            // "embedder" when the text went to the host's embed callback, else "nowhere"
    reranker,          // the reranker's model id when this search was reranked, else null
    words,             // for "words": { used: [{ word, how, count }], unmatched: [...] }, else null
    point,             // for "point": the id, else null
    pointOfView,       // boolean: the option is on for this search
    k,
    note,              // a message about this search (fallback to words, rerank failure), or null
    radius,            // the result radius
    insideCount,       // points inside the result radius, named or not
    results: [{ id, index, rank, embeddingRank, plainRank, distance, plainDistance,
                gap, moved, score, text }],      // ET.search hits plus pointText: named points
  }],
  pairs: [{ a, b, shared, common, commonIds, closest }],
                       // a, b letters; commonIds ids; closest null or { a: id, b: id, distance }
}
```

With no search: `active: false`, empty `searches`, `pairs` and `unmatched`,
counts 0. This is enough for a test to assert results without reading pixels:
the lit ids are the ids whose distance is at most `radius`, and `results` are
the exact ranking.

### Viewer refusal codes

Added to the viewer's codes in `js/api/50-viewer.md`; `ET.search`'s codes
(`js/api/24-search.md`) are passed through as they are.

| Code | When | Message template |
|------|------|------------------|
| `no-embedder` | `via: "embed"` with no `embed` callback. | `Cannot embed the query: the host supplied no embed callback. Search among the loaded points still works.` |
| `embed-failed` | The `embed` callback threw or its promise rejected. | `The embedder failed to answer. The earlier results are kept.` |
| `embed-timeout` | No answer within `searchTimeoutMs`. | `The embedder did not answer within {seconds} seconds. The earlier results are kept.` |
| `embed-malformed` | The answer is not an object with `vector` and `model`. | `The embedder's answer was not a vector with a model id. The earlier results are kept.` |
| `rerank-failed` | The `rerank` callback threw or rejected (a note, not a refusal). | `The reranker failed to answer; the results stay in embedding order.` |
| `rerank-timeout` | No rerank answer within `searchTimeoutMs` (a note). | `The reranker did not answer within {seconds} seconds; the results stay in embedding order.` |
| `too-many-searches` | More than 4 entries. | `At most 4 searches at once; {found} were given.` |
| `superseded` | A newer call replaced this one before it finished. | `A newer search replaced this one.` |
| `bad-search` | `list` is not an array, or an entry is none of the forms above (added by t8). | `A search must be text, { text }, { vector, model } or { point }, given in an array.` |
| `rerank-no-text` | A note, not a refusal: a vector search with no `label` while reranking is on (added by t8). | `A vector search with no label has no text to send to the reranker; it stays in embedding order.` |
| `destroyed` | After `destroy` (existing code). | (existing message) |

Decided here: `embed-failed` does not show the error the callback threw, since
it could carry an address or key the host never meant to put on screen; the
host sees its own error in its own code. A malformed rerank answer is
`ET.search`'s `rerank-malformed`. `{seconds}` is `searchTimeoutMs / 1000`.

### Clarifications from the build (t8)

Task t8 added these while implementing the viewer section; the panel, the web
component and the standalone page build on them.

1. `bad-search` (above) is refused for a `list` that is not an array or an
   entry of no known form, rather than guessing what was meant.
2. With no set, or a set of 0 points, `setSearches` is refused with `no-data`
   before any callback is called. A text entry with no word (`ET.search.tokens`
   is empty) is refused with `empty-query` before any callback, whatever its
   `via`.
3. `embed-malformed` is an answer that is not an object or has no `vector`. An
   answer with a `vector` but no usable `model` goes to `ET.search.checkQuery`
   and is `query-model-missing`, as the callback contract says; a wrong length
   is `query-dimension-mismatch`, a non-finite value `query-non-finite`.
4. `superseded` and `destroyed` resolve the caller's promise but are not sent
   to `onError` (they are not refusals of data); every other refusal is.
5. `pointOfView` accepts only the letter of a search shown now (or `null`); when
   new searches are fewer than its letter, it goes back to `null`.
6. `setSearchSettings` while a `setSearches` call is still working stores the
   settings and resolves at once (`waiting: true`); the new searches are then
   worked out again with them as soon as they land (no swing). While a re-run
   or another settings change is working, a newer settings change supersedes
   it.
7. Appends that arrive while a run is working do not restart it: when it lands
   on an older set it is shown stale and worked out once more (so a stream of
   appends cannot starve the re-run).
8. `setSearchCallbacks({ rerank: null })` also turns the `rerank` setting off.
9. The filter eases on frame time, not mode time, so a search fades in and out
   while paused too.
10. A replace drops every search with no `searchChanged` call: the mode
    re-enters on the new set as a new instance with no search.
11. The panel hook calls `ET.searchPanel.mount(parts, handle, { document,
    light, theme, data })` (`light`: the soft-ink stage; `theme` and `data`
    added by t9), `panel.update(info().search)` on every change (before
    `onSearchChange`), `panel.drawOverlay(ctx, project, frame)` every frame
    after the viewer's own overlay (`frame` added by t9), and `panel.destroy()` in
    `destroy`. A panel that throws is reported like a host callback's error and
    never stops the viewer. With no `ET.searchPanel` in the core file nothing
    happens.

### Lifecycle

- **Budget.** Ranking, word matching and the facing frame are steppers pumped
  inside the existing per-frame budget (`prepareBudgetMs`, 8 ms, halved after a
  long frame; `js/api/50-viewer.md`, "Heavy work"), after the mode's own
  preparation. A search never causes a long frame. The view keeps moving while
  a search is worked out.
- **Appends.** After an append the results are stale (`stale: true`,
  `staleBy` counts the new points; the panel says the results are from before
  the new points). They are worked out again with no action from the caller:
  rankings re-run from the query vectors held (no new `embed` call), word
  searches match their words again over the new set, then lit values, pairs and
  the facing frame are recomputed (no swing). Until then the new points have
  lit value 0. A replace clears every search.
- **Destroy.** Waiting promises resolve with `destroyed`; later callback
  answers are ignored; no stepper is pumped and nothing runs after `destroy`.
- **Refusals** go to `onError` as other refusals do, and are shown in the
  panel; they are not shown as the stage notice.

## Callback contracts

The core file never fetches. Embedding and reranking happen only in a host
callback (or, for the standalone page, in the helper's server process through
its route).

### `embed(text) -> { vector, model, queryForm? } | Promise<same>`

- Called with exactly one argument: the query text, a string: the entry's
  `text` as given to `setSearches` (the panel gives one line, trimmed). Nothing
  else is passed.
- Answers with an object (or a promise of one):
  - `vector`: an `Array` of numbers, a `Float32Array` or a `Float64Array` of the
    data's dimension.
  - `model`: the id of the model that made the vector, a non-empty string,
    compared exactly with the data's `model`. **Required**: an answer with no
    model is refused (`query-model-missing`) rather than assumed to match.
  - `queryForm`: optional text saying which input form was used for models that
    embed queries and documents differently (for example `"query"`, or
    `"plain"`); shown in the search line when present.
- The answer is checked with `ET.search.checkQuery` (model, dimension, finite,
  not zero, same space) before anything reaches the renderer.

### `rerank(query, candidates) -> { scores, model } | Promise<same>`

- `query`: the query text (string). `candidates`: an array of strings, the
  candidate texts in embedding order (`ET.search.pointText` of the pool).
- Answers with `scores`: one finite number per candidate, in the order given,
  higher meaning more relevant; and `model`: the reranker's id, a non-empty
  string, shown as the reranker in use. Decided here: the reranker names itself
  in its answer, as the embedder does, so the view never names a reranker it was
  not told about. An answer without both is `rerank-malformed`.

Both callbacks may be plain functions or `async`. They run on the host's side;
the viewer guards every call (a throw is `embed-failed` or `rerank-failed`, and
the host's error goes nowhere on screen).

## Panel (t9)

A new module that builds the panel and drives the viewer only through the
handle (the public API), so everything the panel does can be done without it.

<!-- interface-names module="45-search-panel.js" object="ET.searchPanel" match="present" task="t9" prefix="ET.searchPanel." -->
```text
mount
summaryText
usedText
```

### `ET.searchPanel.mount(parts, handle, options) -> panel`

`parts`: `{ panel, stage, overlay, provenanceList, provenanceSummary }`, the
viewer's `div.tumbler-panel`, `div.tumbler-stage`, `canvas.tumbler-overlay`,
`dl.tumbler-provenance-list` and `summary.tumbler-provenance-summary`.
`options`: `{ document, light, theme(), data() }` (see "Clarifications from the
build (t9)", item 1; the search colours are read from the custom properties).
Returns:

- `panel.update(search)`: redraw from `info().search` (the viewer calls it on
  every change).
- `panel.drawOverlay(ctx, project, frame)`: draw the query markers and links on
  the overlay canvas, and the result labels and distances as DOM text over the
  stage (t9, items 1 and 2); the viewer calls it once per
  frame after its own overlay drawing. `project(vector)` maps a
  `Float32Array(D)` to `{ x, y, scale, depth }` in overlay pixels through the
  current frame, centre, zoom, yaw and pitch (the same mapping as
  `ET.renderer.place`). Query markers are drawn at the projection of the raw
  query vector.
- `panel.destroy()`: remove everything it added and every listener.

### `ET.searchPanel.summaryText(search) -> string`

The collapsed bar's text: `A tide harbor · B reef kelp · 1,204 points lit`, or
`nothing searched: every point is shown` with no search (the reference's
wording); `· waiting` while waiting and `· from before 40 new points` while
stale.

### `ET.searchPanel.usedText(search) -> string`

What the searches used, for the provenance block: the measure, results per
search, the lit setting, each search's query model and query form, the
reranker (or "no reranker"), the point of view when on, and where the text went
("text sent to the host's embedder", "query and candidate texts sent to the
reranker", or "matched among the loaded points: nothing sent").

### Layout and DOM

The panel is the first child of `div.tumbler-panel`, under the stage, and
takes room only when needed:

```text
section.tumbler-search
  button.tumbler-search-bar        aria-expanded, aria-controls; b "Search", span.tumbler-search-summary,
                                   i.tumbler-search-mark (+ / −, aria-hidden)
  div.tumbler-search-body          hidden while collapsed (the default)
    label + textarea.tumbler-search-input      one search per line, up to four
    div.tumbler-search-controls    button.tumbler-search-face, label.tumbler-search-lit (select),
                                   label.tumbler-search-rerank (checkbox; absent with no rerank
                                   callback or on a labels-only set), label.tumbler-search-distances,
                                   label.tumbler-search-k (range 3..20), label.tumbler-search-pov
                                   (select: off, A..D), label.tumbler-search-only (Focus only),
                                   button.tumbler-search-clear
    p.tumbler-search-note          lit count, where the text goes, unmatched words, refusals, stale
    div.tumbler-search-pairs       one line per pair: shared count, named results in common,
                                   closest pair of different results and its distance
    div.tumbler-search-results     details.tumbler-search-list per search (collapsed until opened):
                                   summary (letter, text, counts, kind), ol of results: rank, text,
                                   distance and gap when Distance difference is on, move when
                                   reranked, plain rank when the point of view moved it
```

- Collapsed, the panel is one line (at most 48 px at desktop and phone width)
  naming the searches and how many points are lit. Opening and closing never
  clears or pauses a search; the bar states `aria-expanded`; everything works
  by keyboard (native controls).
- Typing re-runs `setSearches` after a pause (the reference waits 140 ms).
  Lines past the fourth are not searched and the note says so.
- The search line: a `Search` row is added to the provenance list (`dt Search`,
  `dd` with `usedText`) and a short clause to the provenance summary, so what a
  search used and where the text went is on screen whenever a search is active,
  even with the panel and the provenance block collapsed. Decided here: beside
  the provenance (as the spec says) rather than as an extra panel line, which
  keeps the collapsed panel to one line.
- Every query, label, result text and message goes in with `textContent`;
  markup in any of them creates no element. Styles are set from script through
  `element.style` and `var(--tumbler-*)` as the viewer does; no style attribute,
  no style element, no `!important`.
- Each search has its letter wherever its colour is used, and the lists and pair
  lines carry as text everything the picture shows.

### Custom properties (search colours)

Added to the viewer's theming table, read like the others.

| Property | Default (dark) | Default when the background is light | Used for |
|----------|----------------|--------------------------------------|----------|
| `--tumbler-search-1` | `#ffc56b` | `#a35f00` | search A: marker, links, list numbers |
| `--tumbler-search-2` | `#6be0ff` | `#00708a` | search B |
| `--tumbler-search-3` | `#ff8fb3` | `#b0245a` | search C |
| `--tumbler-search-4` | `#b6ff8a` | `#3d7a00` | search D |
| `--tumbler-shared` | `#ffffff` | `#1b2130` | the shared mark in the panel and overlay |

The dark defaults are the sky reference's. Decided here: the light defaults are
darker hues of the same four, chosen to stay readable on a light stage, where the
reference's colours and white would vanish; t9 checks them on the light
treatment in a browser.

### Clarifications from the build (t9)

Task t9 found these while building the panel against the two reference pages.
Each changes or adds to the text above; `js/api/45-search-panel.md` has the
detail.

1. **What the panel needs from the viewer.** `info().search` carries no query
   vector and no point vector, and the viewer tells the panel about searches,
   not data. So the hook passes more: `mount` options are `{ document, light,
   theme(), data() }` (getters for the viewer's theme and the set shown), and
   `drawOverlay(ctx, project, frame)` gets a third argument `{ queries, filter,
   dpr, light, labels, mode, hidden(i) }` (each shown search's raw query vector
   in letter order, the filter, the pixel ratio, whether labels are on, the
   mode, Focus's hidden points). `drawOverlay` returns `false` when it drew
   nothing, and the viewer then leaves the overlay's dirty flag alone. The
   panel notices a new set and a mode change on the next frame.
2. **Labels are DOM text.** The viewer never draws text on a canvas (its own
   labels are spans; the fake 2-D context throws on `fillText`), so the panel's
   letters, ranks, result texts and distances on the stage are spans in a
   `div.tumbler-search-labels` layer after the overlay canvas, created with the
   first search drawn. Rings and links are on the overlay canvas.
3. **Overlap in a tight cluster** (the spec's parked follow-up): labels are
   placed letters first, then nearest results first, and a label that would
   overlap one already placed is left out; the lists carry every result and the
   note says so. In Focus a result carries its rank (`1`, or `A1` with several
   searches), as the Focus reference does; in the other views its text (cut to
   28 characters), as the sky reference does. Distances on links have three
   decimals (cosine distances of nearby results differ in the third).
4. **Suggestions** (the Focus reference; asked for in every view): under the
   box, up to 8 buttons with texts of named points that the line being typed
   can match (the whole line starts the text, or the line's last word starts
   one of its words). A click puts the text on that line and searches at once.
   New: `div.tumbler-search-suggest`.
5. **Focus lays the lists beside the stage** (the Focus reference): an
   `aside.tumbler-search-side` after the stage holds a title, a sub line and,
   per search, its letter and an ordered list of results. The viewer's root is
   made a wrapping flex row while the mode is Focus, so the list is to the
   right of the stage on a wide screen and below it on a narrow one. It is
   there in Focus with no search too (an empty-state line, as the reference),
   and is removed with the layout when another mode is chosen. The result lists
   under the stage are hidden in Focus, since the list beside it carries them.
6. **Other DOM added** to the layout above: `p.tumbler-search-live` (a visually
   hidden polite live region with the summary), `label.tumbler-search-input-label`,
   an `output` beside the Results range, `data-letter` on each list, a gap bar
   (`span.tumbler-search-gap`) on each result with Distance difference on, and
   the Search row's classes `tumbler-search-provenance-term` / `-value` and
   `span.tumbler-search-provenance-clause` in the summary. The Reranker label is
   absent from the row (not hidden) while no reranker is offered; Only results
   is in the row but shown only in Focus.
7. **Bar text while the first search is worked out**: `working out the search ·
   waiting` (nothing is shown yet, so there is no lit count to name).
8. **Spacing properties**: `--tumbler-search-bar-padding` (`10px 0`),
   `--tumbler-search-title-size` (`24px`) and `--tumbler-search-side-gap`
   (`16px`). With the defaults the closed panel measures 46 px.
9. **The box follows searches it did not send** only when they include a point
   or a vector search (a click in Focus, a host's call) or when the box is
   empty, and never while the person is typing; a point search shows the
   point's text. A host's text search never overwrites what the person typed.

## Web component (t10)

`<embeddings-tumbler>` gains two **properties** (not attributes; nothing is
read from markup):

- `element.embed`: the embed callback, or `null`.
- `element.rerank`: the rerank callback, or `null`.

Setting either before the viewer is mounted passes it as a mount option;
setting it afterwards calls `handle.setSearchCallbacks`. The shell still calls
only the public API. One property assignment and no build step adds search.

## Standalone page (t11)

The page asks its own origin for the helper route: `POST /_tumbler/search` with
`{ "op": "describe" }` (relative to the page's own origin; never a configurable
address). A `200` JSON answer with `"ok": true` means the route is there; then
the page mounts the viewer with an `embed` callback (and a `rerank` callback when
`rerank` is offered) that post to the same route. Anything else (a 404 or 501
from a plain static server, a network error, a non-JSON answer) means no route:
the page mounts with no callbacks and the panel says it is matching loaded
points. The page cuts each rerank candidate to the route's `maxCandidateChars`
before sending. The page makes requests only to its own origin, and still has no
inline script or style.

## Helper route (t5): `viewer serve --embed`

A local route on the page's own origin that embeds a query, and optionally
reranks, with the gateway key held only in the server process. Standard library
only (`pyproject.toml` dependencies stay `[]`).

The contract is the command line and the HTTP exchange below; the Python
functions inside `embeddings_tumbler/_embed_route.py` are t5's to name, since
no other task calls them (the page and the browser tests reach the route only
over HTTP). Decided here for that reason.

### Flags

| Flag | Meaning |
|------|---------|
| `--embed` | Turn the route on. Without it, `viewer serve` is exactly today's static-only server and reads no environment variable. |
| `--embed-model MODEL` | The embedding model to ask the gateway for. Default: the environment's `EMBEDDINGS_EMBED_MODEL`, else `Qwen/Qwen3-Embedding-0.6B` (embeddings-cli's default). |
| `--rerank-model MODEL` | Turn on the `rerank` operation with this model. Without it, rerank is not offered. |
| `--query-prefix TEXT` | Text put before every query before embedding (for models that embed queries and documents differently). Without it the query is sent as typed. |
| `--embed-allow-remote` | Allow `--embed` on a non-loopback `--host`. Without it, `--embed` with a non-loopback bind is a user error (exit 1) and nothing is served. |

With `--json`, the serve result gains `"embed": { "enabled": true, "route":
"/_tumbler/search", "model": ..., "rerank_model": ... or null, "query_form":
"plain" or "prefixed" }`; never the gateway address or key. The verb keeps the
rubric: `--json`, an `explain` entry, `learn` in step.

### Environment (read only with `--embed`)

The same variables as embeddings-cli's client, so one setup serves both:

- `EMBEDDINGS_EMBED_URL`: the gateway's OpenAI-compatible base address
  (including `/v1`); default `http://localhost:8001/v1`, embeddings-cli's
  default. The route posts to `<base>/embeddings` and, for rerank,
  `<base>/rerank`.
- `EMBEDDINGS_API_KEY`, else `COLLEAGUE_API_KEY`: the bearer key. Missing: an
  environment error (exit 2) whose message names the variables, never a value.
  Start the server under `grant run --inject EMBEDDINGS_API_KEY=... -- ...` so
  the key is only in its environment.

### Requests

One path, `POST /_tumbler/search`, JSON body, one operation per request:

| `op` | Body | Answer (`200`) |
|------|------|----------------|
| `describe` | `{ "op": "describe" }` | `{ "ok": true, "embed": { "model": "...", "query_form": "plain" or "prefixed" }, "rerank": { "model": "..." } or null, "limits": { "maxTextChars": 8000, "maxCandidates": 60, "maxCandidateChars": 4000, "requestsPerMinute": 120 } }` |
| `embed` | `{ "op": "embed", "text": "..." }` | `{ "ok": true, "vector": [numbers], "model": "...", "query_form": "plain" or "prefixed" }` |
| `rerank` | `{ "op": "rerank", "query": "...", "candidates": ["...", ...] }` | `{ "ok": true, "scores": [numbers], "model": "..." }` |

The page's `embed` callback returns `{ vector, model, queryForm: query_form }`;
its `rerank` callback returns `{ scores, model }`. One query vector travels as
JSON numbers (about 20 KB at 1,024-d); decided here, because the binary-block
rule is the data contract's rule for data files, and a single vector does not
need it. Gateway calls: OpenAI-compatible `POST <base>/embeddings` with
`{ "model", "input": [text] }`, reading `data[0].embedding`; rerank posts
`{ "model", "query", "documents" }` to `<base>/rerank` and reads
`results[].index` and `results[].relevance_score` into one score per
candidate. Both shapes were checked against the gateway on 2026-11-14: embed
returned a 1,024-dimension unit vector with its model id, and rerank returned
scores from `Qwen/Qwen3-Reranker-0.6B` with exactly this request and answer
shape.

### Checks and refusals

Every refusal is JSON `{ "ok": false, "code", "message" }` with a fixed message
and no cross-origin headers on any answer (no `Access-Control-*`). Each is shown
by its own test.

| Status | Code | When |
|--------|------|------|
| 405 | `wrong-method` | Any method but POST on the route (GET, HEAD, OPTIONS ...); `Allow: POST`. |
| 403 | `wrong-host` | `Host` is not the bound address and port (for a loopback bind, `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` are accepted). |
| 403 | `wrong-origin` | `Origin` is missing or is not `http://` plus the request's `Host`. Decided here: required, since every browser sends it on a POST fetch and nothing legitimate omits it. |
| 415 | `wrong-content-type` | `Content-Type` is not `application/json` (parameters such as `charset` allowed). |
| 413 | `too-large` | Body over 1 MiB (1,048,576 bytes), or no `Content-Length`. |
| 400 | `bad-json` | The body is not a JSON object. |
| 400 | `bad-request` | Unknown `op`, or a field missing or of the wrong type. |
| 413 | `text-too-long` | `text` or `query` over 8,000 characters, or a candidate over 4,000. |
| 413 | `too-many-candidates` | More than 60 candidates. |
| 429 | `rate-limited` | More than 120 requests in the last 60 seconds (one window for the whole server). |
| 404 | `rerank-unavailable` | `op: "rerank"` with no `--rerank-model`. |
| 502 | `gateway-failed` | The gateway refused, failed or answered in the wrong shape. Message: `The embedding service did not answer.` (or `The reranking service did not answer.`), never the gateway's own text. |
| 504 | `gateway-timeout` | No gateway answer within 20 seconds. |

No response body, header or log line contains the gateway key, the gateway
address, the gateway's own error text or the query text. The log has one line
per route request: method, path, `op`, status and body length. Tests plant
sentinel values for all four and look for them in bodies, headers and logs.
Other paths are served exactly as today (static files, GET and HEAD).

## Not part of these interfaces

- **The readout strip colours** are outside the search interfaces. Colouring
  each cell by its dimension's share of the horizontal, vertical and depth axes
  (opacity unchanged) is specified by claim c47 in the frame and built as its
  own task; nothing here depends on it.
- No index (search is an exact scan), no answer generation, no chat, and no
  change to the data contract (schema version 1 stays frozen).
- Wander does not visit results; facing a chosen pair of searches and
  decluttering labels in a tight cluster are parked follow-ups in the spec.

## Corrected after the first browser run

The first run of search in a real browser (Chromium, the shipped standalone
page, the built-in sample set of 12,288 points of which 290 carry a word)
found that the build ranked every loaded point, as decision 1 then said. The
query `tide harbor` returned eight unnamed points (`p03048`, `p03613`, ...)
whose result text was the point id, a radius of 0.0169 and 8 lit points: the
typed words were not among the results. The spec's assumptions, confirmed by
the owner, say otherwise: "Every loaded point at least as near as the last
named result is lit too, as the sky reference does". The sky reference ranks
only its named points, takes the radius from the farthest of them and lights
every point at least that near; for `tide harbor` it gives tide, harbor, surf,
kelp, reef, atoll, estuary, mooring and lights 422 points.

Corrected: results are the `k` nearest named points (`ET.search.isNamed`;
glossary above, `js/api/24-search.md`), the result radius is the farthest of
them, and every point at least that near, named or not, is inside and lit.
After the correction the same query on the same set gives tide, harbor, surf,
kelp, reef, atoll, estuary, mooring (the reference's list, in its order) at a
radius of 0.0431 (cosine distance), with 423 points inside (measured in node on
the assembled file, `js/test/search-named.test.js`; the reference's 422 is
straight-line distance). A set with no named point keeps the earlier
behaviour (every point a candidate, results showing ids); a set with fewer
named points than `k` gives all of them; a reranker's pool is drawn from the
named points. A real data file, where every point carries text, is unchanged.

## Decisions made here

Each choice the spec left open, with its reason:

1. Results are the nearest named points, and every point at least as near as
   the last of them is lit, named or not (the sky reference, confirmed by the
   owner in the spec's assumptions). A set with no named point ranks every
   point. Real files carry text on every point, so there nothing is restricted.
   This replaces "any loaded point can be a result"; see "Corrected after the
   first browser run".
2. A zero row has similarity 0 and distance 1: keeps the scan finite and puts a
   directionless point at "unrelated".
3. Ties in ranking go to the lower index: makes rankings a pure function of
   their inputs.
4. A point's text is `metadata.text` when readable, else its label when
   readable, else its id (readable as for a named point): the longer text is
   the better one to read and to rerank.
5. Word search places the query at the mean of per-word means, each matched
   word one share (the sky reference): a word naming a large group does not
   drown one naming a single point.
6. A word of 3 or more letters with no exact match may match word starts (the
   sky reference); a whole-text match wins first (the Focus reference).
7. Pair reports use plain distance: a pair compares two searches, and the point
   of view belongs to one.
8. The facing frame falls back to the standard basis when the data gives fewer
   than three axes: a frame always exists, deterministically.
9. With the point of view on, the fitted axes are mapped back to the loaded
   vectors and made orthonormal: the picture stays one linear frame on every
   point.
10. A swing belongs to the mode it started in and ends on a mode switch: every
    switch stays jump-free.
11. Re-runs after an append and settings changes do not swing: they answer no
    new question.
12. `setSearches` is all or nothing for refusals, and refuses more than four:
    a refusal leaves the view unchanged, and nothing is dropped silently.
13. A failed reranker keeps the embedding order as a note, not a refusal:
    embedding results are valid on their own.
14. The rerank callback returns its model id: the view never names a reranker
    it was not told about.
15. `embed-failed` shows no host error text: it could carry an address or key.
16. Focus has no `face` and is the only mode where a click searches: its view
    is already the fit, and the other modes' input stays as it is.
17. The search line sits in the provenance block: what a search used is always
    visible without adding a line to the collapsed panel.
18. Light-stage search colours are darker hues of the reference's four: the
    reference's colours vanish on a light stage.
19. The helper uses embeddings-cli's environment variables and defaults: one
    setup serves both tools.
20. The helper requires `Origin` and sends a query vector as JSON: browsers
    always send `Origin` on a POST, and one vector does not need the binary
    block.
21. The helper's Python function names are left to t5: no other task calls
    them; the command line and the HTTP exchange are the contract.
