# `EmbeddingsTumbler`: the viewer API (`js/src/50-viewer.js`)

This is the public API of the core file `embeddings-tumbler.js`. Hosts, the web
component (t10), the standalone page (t11), the guides (t18) and the browser
harness (t14) build against this page.

Load the core file with a classic script tag from your own origin. It defines one
global, `window.EmbeddingsTumbler` (under node, `module.exports`). It needs no
build step, has no dependency, runs under `script-src 'self'` and
`style-src 'self'`, and makes **no network request of any kind**. The host
fetches its own data and hands it over.

```html
<div id="space"></div>
<script src="embeddings-tumbler.js"></script>
<script src="host.js"></script>
```

```js
// host.js
const el = document.getElementById("space");
const viewer = EmbeddingsTumbler.mount(el, { mode: "tumble", seed: 7 });
const meta = await (await fetch("data/atlas.json")).json();
const block = await (await fetch("data/" + meta.vectors.file)).arrayBuffer();
const result = viewer.update({ ...meta, vectors: { ...meta.vectors, data: block } }); // the block beside its descriptor
if (!result.ok) console.warn(result.code, result.message); // also shown inside el
// later, live points:
viewer.update({ ...appendMeta, op: "append", vectors: newVectors });
// when the host removes the element:
EmbeddingsTumbler.destroy(el);
```

(`update` takes the contract's **in-memory form**: the same fields as the JSON
file, with `vectors` a `Float32Array` or a little-endian `ArrayBuffer`; or a
fetched data file as it is, with the block put beside its descriptor in
`vectors.data`, as above, in which case the descriptor's `file`, `dtype`,
`byte_order` and `byte_length` are checked too, with the contract's own codes
and messages (a descriptor declaring `"dtype": "float64"` is refused, not drawn).
See `docs/data-contract.md`, "The in-memory form". The contract module's
`loadFile(jsonUrl, fetchFn)` does the two fetches for you if you hand it your own
fetch-like function; the viewer itself never calls one.)

## Module functions

| Function | Returns | Notes |
|----------|---------|-------|
| `mount(el, options?)` | a **handle** | Builds the viewer inside `el` and starts it. `el` must be a DOM element; anything else throws `TypeError` (a programming error, not data). **Mounting an element that already has a viewer returns the existing handle unchanged; the new options are ignored.** To change options, `destroy(el)` then `mount(el, options)`. |
| `update(el, data)` | a **result** | Same as `handle.update(data)`. On an element with no viewer: `{ ok: false, code: "not-mounted", message }`. Never throws. |
| `destroy(el)` | `boolean` | `true` if a viewer was destroyed; `false` (no-op) for an element that was never mounted or is already destroyed, or for `null`. Never throws. |
| `get(el)` | handle or `null` | The handle of the viewer on `el`. |
| `registerMode(definition)` | — | `ET.modes.register` (see `js/api/40-modes.md`): add a fourth mode. Viewers mounted afterwards show a button for it. |
| `version` | string | The core file's version (also in the file's first line). |

Several viewers can live on one page; they share nothing but the mode registry
and a registry of live viewers keyed by element.

## Options (`mount(el, options)`)

All optional.

| Option | Default | Meaning |
|--------|---------|---------|
| `mode` | `"tumble"` | Starting mode id (`"tumble"`, `"lattice"`, `"wander"`, or a registered one). Unknown ids fall back to `"tumble"`. |
| `seed` | `1` | The view's seed (a finite number or a non-empty string). Not the data's `provenance.seed`; both are shown. |
| `speed` | `1` | Motion speed multiplier (also a slider in the controls, 0.2 to 3). |
| `paused` | `null` | `true` / `false` to start paused or running. `null`: start paused when the user prefers reduced motion, otherwise running. |
| `labels` | `true` | Show labels (group names, Wander stops and neighbours, hover name). Also a checkbox. |
| `trails` | `true` | Motion trails. Also a checkbox. |
| `controls` | `true` | `false` hides the controls row (play, reset view, speed, labels, trails, hint). The mode switch, readout and provenance stay. |
| `readout` | `true` | `false` hides the readout strip. |
| `masthead` | `true` | `false` hides the masthead over the stage (the count line, and the title if given). |
| `title` | `""` | A title drawn over the stage in the masthead (text, never markup). Empty: no title line. |
| `provenanceOpen` | `true` | The provenance block is a `<details>`; `false` starts it collapsed (its summary line still names source, model, dimension, items, seed, synthetic and the shadow sentence). The block cannot be removed. |
| `modeOptions` | `null` | Per-mode options passed to `ET.modes.create`, for example `{ tumble: { refitTransition: 6 } }` (see `js/api/40-modes.md`). The viewer adds none of its own. |
| `maxPixelRatio` | `2` | Cap on `devicePixelRatio` for the drawing buffer (the reference's). |
| `adaptivePixelRatio` | `false` | When `true`: lower the drawing-buffer ratio in steps of 0.5 (never below 1, never raised again in this mount) after two measured seconds in a row under 25 frames per second while the view runs, draws and prepares nothing. Trades sharpness for smoothness on a slow GPU (see "Slow devices"). `false`: always the capped device ratio. |
| `preserveDrawingBuffer` | `false` | Keep the WebGL drawing buffer so the host (or a test) can read pixels or take a screenshot. Costs some speed. |
| `prepareBudgetMs` | `8` | The least milliseconds of mode preparation per animation frame. The budget is a third of the measured frame interval, between this and three times this (24 ms by default), and half of this for one frame after the work itself overran (see "Heavy work"). While the view is paused the budget is at least 40 ms, and frames keep running until the mode is ready even when paused or under reduced motion. |
| `spinWhilePreparing` | `true` | Keep the slow spin turning while a mode prepares, so the view never stands still (the mode clock still waits for ready; see "Time"). `false`: the picture holds still until ready. |
| `refitQuietSeconds` | `2` | Tumble refit policy after appends (see "Appends"). `Infinity` never refits. |
| `refitShare` | `0.01` | Tumble refits only when the points appended since the last fit are at least this share of the set (and at least one). |
| `onError(result)` | none | Called with every refusal `{ ok: false, code, message }` (the same object `update` returns). |
| `onModeChange(id)` | none | Called when the mode changes (button, key or `setMode`). |
| `onPauseChange(paused)` | none | Called when play/pause changes. |
| `embed` | none | Search: the host's `embed(text)` callback (see "Search"). |
| `rerank` | none | Search: the host's `rerank(query, candidates)` callback. |
| `searchTimeoutMs` | `15000` | Search: how long a callback may take before its answer is dropped. |
| `searchPanel` | `true` | Search: `false` mounts no search panel (the handle still does everything). |
| `searchK` | `8` | Search: results per search with no reranker (3 to 100). |
| `searchCandidates` | `50` | Search: candidates handed to the reranker (3 to 100). |
| `searchTop` | `20` | Search: reranked candidates kept (3 to `searchCandidates`). |
| `searchLit` | `"even"` | Search: the starting lit setting (`"even"`, `"close"`, `"named"`). |
| `onSearchChange(search)` | none | Search: called with `info().search` whenever it changes. |
| `relative` | `false` | Relative search: the Relative setting at mount (see "Relative search"). |
| `showOrigin` | `false` | Relative search: the Show the origin setting at mount. |

A callback that throws does not break the viewer. Its error is rethrown on a
later task with `setTimeout`, so it reaches the host's error handling, not
ours. Without `setTimeout` it goes to `queueMicrotask`, and without that to
`console.error`. It is never dropped.

## The handle

| Member | Returns | Meaning |
|--------|---------|---------|
| `element` | element | The host element. |
| `update(data)` | result | Replace or append (below). Never throws for bad data. |
| `destroy()` | boolean | As `destroy(el)`. |
| `pause()`, `resume()` | — | Stop / restart the motion (the mode clock and the slow spin). While paused the view still twinkles unless reduced motion is preferred. |
| `isPaused()` | boolean | |
| `setMode(id)` | boolean | Switch modes. The new mode starts exactly at the last frame drawn (no jump). `false` for an unknown id, or when the mode cannot show the data (a message is shown). |
| `mode()` | string | The current mode id. |
| `modes()` | string[] | Registered mode ids. |
| `time()` | number | Elapsed **view time** of the current mode, in seconds (see "Time"). |
| `seek(t)` | number | Set the current mode's time (and the spin) to `t` seconds; returns it. |
| `seed()` | number or string | The view seed. |
| `setSpeed(s)` | number | Set the speed (positive); returns it. |
| `zoom(z?)` | number | Read, or set, the user zoom factor (clamped 0.2 to 12). |
| `resetZoom()` | — | User zoom back to 1 and the user pan back to `[0, 0]` (since t17 it resets the pan too, as every reset of the zoom does). |
| `pan(p?)` | `[x, y]` | Read, or set with `[x, y]`, the user pan: the renderer's draw key `pan`, in units of the stage's `R = min(W, H) * radius`, `x` right and `y` up. Clamped so the picture's centre stays on the stage; anything that is not two finite numbers sets `[0, 0]`. Returns a copy. |
| `resetView()` | — | The same as `resetZoom()`: zoom 1 and no pan. The name the Reset view button goes by. |
| `refreshTheme()` | — | Re-read the `--tumbler-*` custom properties (also done on every `update`). The viewer never polls. |
| `info()` | object | A snapshot for hosts and tests (below). |
| `setSearches(list)` | Promise | Search: replace the searches (text, vector or point id); see "Search". |
| `clearSearches()` | boolean | Search: remove every search. |
| `setSearchSettings(patch)` | Promise | Search: `k`, `candidates`, `top`, `lit`, `distances`, `rerank`, `pointOfView`, `onlyResults`. |
| `searchSettings()` | object | Search: a copy of the settings. |
| `faceSearches()` | boolean | Search: swing toward the searches again (false in a mode with no `face`, Focus). |
| `setSearchCallbacks({ embed?, rerank? })` | object | Search: set or remove the callbacks after mount. |
| `setRelative(patch)` | `{ relative, showOrigin }` | Relative search: change the settings, at once (see "Relative search"). |
| `relativeSettings()` | `{ relative, showOrigin }` | Relative search: a copy of the settings. |

`info()` returns `{ mode, paused, broken, suspended, hidden, onScreen, destroyed,
reducedMotion, time, seed, speed, zoom, ready, preparing, count, dimension,
model, rendering, animating, frames, fps, pixelRatio, pixelRatioLowered, status,
message, timing, search }`.
`suspended` is true while the document is hidden or the element is off screen;
`animating` is true while an animation frame is requested; `frames` counts
frames that did work; `fps` is measured once a second (a window restarts after a pause, a resume or a
gap of more than 250 ms between frames); `pixelRatio` is the drawing-buffer ratio
in use and `pixelRatioLowered` is true once `adaptivePixelRatio` has lowered it;
`status` is the status
line; `message` is the message shown, if any; `timing` is `{ firstFrameMs,
firstReadyMs, longestFrameMs, lastAppendMs, refits, lastRefit, budgetMs, workMs,
scriptMs, drawMs, intervalMs }`, the first three in milliseconds since
`mount`; `budgetMs` is the heavy-work budget of the last frame (`null` before the first
frame with a view), `workMs` that frame's time in the work itself, `scriptMs` its whole
callback less the renderer's draw call, `drawMs` the draw call, and `intervalMs` the
smoothed time between animation frames (all in milliseconds); `lastRefit` is `null` or `{ atMs, durationMs, longestStepMs }`: when the
last Tumble refit finished (milliseconds since `mount`), the main-thread time its
work took in all, and its longest single step (`longestFrameMs` is the longest single animation-frame callback of
this viewer, which is where mode preparation runs).

`search` is the search state, always present (`docs/search-interface.md`,
"`info().search`"); with no search it is `active: false` with empty lists, and
every other field above is exactly as it was before search existed.

## Search

The full contract (entries, results, callbacks, codes, lifecycle) is
`docs/search-interface.md`, "Viewer (t8)" and "Callback contracts", including
its "Clarifications from the build (t8)". In short:

- `setSearches(list)` takes 0 to 4 entries: a string or `{ text, via? }`
  (embedded through `embed`, or matched among the loaded points), `{ vector,
  model, label? }` or `{ point }`. The promise never rejects: `{ ok: true,
  search }` or `{ ok: false, code, message }`, and a refusal changes nothing.
  Latest wins: a newer call (or a clear, a replace, `destroy`) resolves an older
  one with `superseded` (or `destroyed`) and drops its late callback answers.
- The viewer calls `embed(text)` with the text only, and `rerank(query,
  candidates)` only with `rerank` on, the set carrying text and the callback
  set. Every call is guarded and timed out after `searchTimeoutMs`. The core
  file still makes no request of its own.
- Ranking, word matching and the facing frame are steppers pumped after the
  mode's preparation inside `prepareBudgetMs`; the pair reports are one call per
  change of the searches. The lit values go to `renderer.setLit`; the draw key
  `filter` is eased toward 1 (time constant 0.35 s) while a search is shown and
  toward 0 when none is, then `setLit(null)`. With no search the key is left
  out and the draw state is exactly as before.
- Results are the nearest named points (`ET.search.isNamed`: readable text
  that is not just the id), and `insideCount` and the lit values count every
  point at least as near as the last result, named or not. A set with no named
  point ranks every point. A search from an unnamed point uses it as the query
  only; a named one is its own first result.
- A new search swings the current mode once (`inst.face(target, t, {
  searches })`) when the facing frame is ready; a mode with `searchChanged`
  (Focus) is told after every change and its returned stepper is pumped with
  its preparation. Settings changes and re-runs do not swing.
- After an append the results are stale (`stale`, `staleBy`) and are worked out
  again from the query vectors held, with no new `embed` call and no swing. A
  replace clears every search.
- In Focus a click on a point (press and release within 5 px, within 16 px of
  the point) searches from it (the clicked point is the query, and its first
  result when it is named); with Only results on, unlit points are skipped
  by the click, the hover name and the group names.
- New viewer codes: `no-embedder`, `embed-failed`, `embed-timeout`,
  `embed-malformed`, `too-many-searches`, `superseded`, `bad-search`, and the
  notes `rerank-failed`, `rerank-timeout`, `rerank-no-text`; `ET.search`'s codes
  pass through. Refusals other than `superseded` and `destroyed` go to
  `onError`; they are not shown as the stage notice.
- The search panel (`ET.searchPanel`, task t9, `js/api/45-search-panel.md`) is
  mounted when it is in the core file and `searchPanel` is not `false`; it
  drives the viewer only through the handle. In Focus it puts the ranked lists
  beside the stage (the root becomes a wrapping flex row while in Focus).

Tested in `js/test/viewer-search.test.js`.

## Relative search

Relative is a setting of Tumble, kept by the viewer in every mode and with no
search. With a search present it makes the first search's direction the vertical
axis, so a point's height is its vector measured along the search (cosine
similarity on a set of unit-length vectors), drawn with a ruler. The contract is
`docs/relative-interface.md`; the mode's side is in `js/api/40-modes.md`
("Relative"), the drawing in `js/api/46-relative-overlay.md`, the controls in
`js/api/45-search-panel.md`. The viewer's part:

- **Options.** `relative` and `showOrigin`, booleans, both `false` by default
  (any value that is not `true` reads as `false`). A viewer mounted without them
  is exactly as it was before the setting existed.
- **`handle.setRelative(patch) -> { relative, showOrigin }`.** `patch` is `{
  relative?, showOrigin? }`. A key that is not a boolean is ignored and a
  missing key keeps its value. It is synchronous: no ranking is redone, nothing
  is superseded, no callback of the host's is called, no request is made. It
  returns the settings now in force. `onSearchChange` is called when either
  value changed. The settings are kept in every mode and with no search; they
  act in Tumble. Turning Relative on replaces a swing in progress with the turn
  onto the pinned frame. After `destroy` it returns the last settings and does
  nothing. `handle.relativeSettings()` returns a copy.
- **Letters are kept while Relative is on.** `setSearches(list)` gives an entry
  that is the same as a search shown now (the same kind, and the same text and
  `via`, the same point id, or the same vector bytes and model) that search's
  letter, and the other entries the lowest free letters in list order. So
  `["rice", "wheat"]` and then `["wheat"]` leaves one search, lettered B, which
  is then the vertical axis. With Relative off letters are given by position, as
  before, and turning it off gives positional letters back (a search that was B
  becomes A if it is alone).
- **`info().search.relative`** is always present:

  ```js
  relative: {
    relative, showOrigin,   // the settings
    offered,                // the current mode is Tumble (the controls are offered)
    active,                 // offered, and at least one axis is pinned
    settled,                // active, and the turn onto the pinned frame has ended
    measure,                // "cosine" | "length along the search" | null (no data)
    unit,                   // { unit, min, max, tolerance } | null: are all vectors of length one?
    pinned,                 // [{ letter, axis, length }] ([] when not active)
    dropped,                // [{ letter, reason, against }]: searches that give no axis
    free,                   // free axes: 3 minus pinned (3 when not active)
    fixed,                  // free axes that are filler, because the set is too small to spread
    window,                 // { low, high, bottom, top } | null: the heights shown
    share, subspace,        // the remainder share and directions toured, or null
    searches,               // [{ letter, results: [{ index, id, height, cosine }] }]
  }
  ```

  `searches` lines up with `info().search.searches[j].results`: `height` is the
  result's vector dotted with that search's direction, and `cosine` is 1 minus
  its plain distance (never the point-of-view distance). `[]` when not active.
  While the setting is on in Tumble but no search gives an axis, `dropped` still
  names the searches that give none.
- **What is drawn.** In Tumble, with the relative view shown or Show the origin
  on, the viewer builds the overlay's draw list every frame, paints its shapes on
  the overlay canvas and places its texts as spans in
  `div.tumbler-relative-labels` (after the overlay canvas, `aria-hidden`). It
  passes the draw state's `perspective` to the renderer and to the overlay's
  placer, so they agree. The pitch is `0.16 * (1 - mix) + drag.pitch`, so the
  settled view is level until the person tilts it. Nothing is drawn, and the
  layer is empty, in other modes or with neither shown.
- **Non-results are faintly brightened by closeness.** With the relative view
  shown, a point that the Lit setting leaves unlit gets the lit value `0.2 x g^2`,
  where `g` is, over the shown searches, the largest of `clamp((c - mid) / (hi -
  mid), 0, 1)`, with `c` the point's plain cosine to the search, `mid` the median
  cosine over all points and `hi` the highest over all points but the search's
  own. It uses the plain cosine, never the point-of-view one. Results and points
  inside the radius keep their lit values. `litCount` and `sharedCount` count
  only the lit values the Lit setting gave. With the relative view not shown the
  lit values are exactly as before.
- **Status and provenance.** The status line is the mode's relative status
  followed by the viewer's pieces, before its own zoom and paused parts: the words
  `named results chosen and numbered by the reranker` while a shown search was
  reranked, `with {letter}'s point of view, rank and height use different
  measures` while the point of view is on, and `ranked by cosine, so rank and
  height can disagree` on a set whose vectors are not all of length one. The
  provenance block gains a `Relative` row (after `View`) while the relative view
  is shown, with the sentences that apply: that the vertical axis is exact and
  what the height measures, and that the horizontal and depth axes are exact
  when pinned (these only once the turn onto the pinned frame has ended); the toured axes' share and that sideways position is still a shadow;
  that every vector has length one (which is why height is cosine similarity),
  or the range of lengths and that height is then length along the search; and
  that with the point of view on, rank is in the scaled measure and height is
  not. The summary line gains `relative to A`. The shadow sentence of the block
  stays as it was.
- **Test hook.** `handle._viewer.relativeDrawn` is `null` while no relative
  overlay is drawn, and otherwise the record of the last frame's overlay:
  `{ units: "device", dpr, width, height, settled, painted, labels, ruler,
  origin, results }`. **Its positions are in device pixels of the overlay
  canvas** (divide by `dpr` for CSS pixels). `ruler` is `{ x0, y0, x1, y1, from,
  to }` or `null`; `origin` is `{ x, y, far, seen }` or `null`; `results` has,
  for each named result with a stem, `{ index, height, x, y, rulerX, rulerY,
  mappedX, mappedY }`: its drawn position, the point on the ruler at its height
  as drawn, and where its height falls on the straight line between the ruler's
  two ends. A test can compare `rulerY` with `mappedY` to see that heights are
  drawn true. The hook is for tests; hosts use `info()`.
- **Nothing is sent.** Relative search adds no callback and no request.
  Turning it on or off, adding searches and showing the origin send nothing
  anywhere. Reranking in the relative view sends what it sends elsewhere.

Tested in `js/test/viewer-relative.test.js` and
`js/test/viewer-relative-draw.test.js`.

## Results of `update`

Success:

```js
{ ok: true, op: "replace" | "append", count, added }
```

`count` is the number of points now in the view, `added` how many this call
added (`count` for a replace).

Refusal (nothing changes in the view):

```js
{ ok: false, code, message }
```

- `code` is one of the contract's 15 codes (`docs/data-contract.md`,
  "Refusals"), with its plain message, for example `dimension-mismatch`,
  `model-mismatch`, `append-without-base`, `schema-version`.
- Viewer codes:
  - `not-mounted`: module `update` on an element with no viewer.
  - `destroyed`: after `destroy`.
  - `mode-failed`: a mode threw (in `create`, `enter`, `prepare` or
    `dataChanged`), or no mode can show the set. A mode registered with
    `registerMode` is host code, so the viewer guards every call into it. On a
    replace, the other modes are tried first; if none starts, the previous view
    keeps running. On an append, the old set is put back and the same view
    restarts from the frame last drawn.
  - `gpu-failed`: the renderer threw or failed while taking the points, for
    example a shape error. The previous view is restored, with the renderer's
    copy put back and rebuilt if needed, and the palette as it was.
  - `internal`: an unexpected error inside the viewer or the loader's
    validation. It is reported as a fault, never as bad data. A hostile getter
    in the data stays the contract's own `invalid-field` with
    `(unreadable data)`.
- From the GPU: `too-many-points`, `dimension-too-large`, `shader-failed`,
  `gpu-failed`, the renderer's reasons from `setData` or `appendData` (see
  `js/api/30-renderer.md`): this GPU cannot take the set. Like every other
  refusal it changes nothing: the previous set, its labels, provenance and mode
  stay, the renderer's copy is put back, and drawing goes on. (In 0.11.0 a
  replace refused here was kept as data under a message over the stage, while
  the renderer still held the previous points.)
- The message is also shown **inside the element** as text: as a notice at the
  top of the stage (with a Dismiss button) while a view is showing, which keeps
  running unchanged; or over the whole stage when there is nothing to show yet.
  The next successful `update` clears it. `onError` is called too.

### Replace (default, or `op: "replace"`)

The set becomes the whole view. The camera starts afresh: the current mode
re-enters on the new set with the same seed, its time back to 0, the drag and
spin reset. The user zoom is kept. A replace with `count` 0 is an empty view
(status `no points yet`). A different model or dimension is allowed on replace.

### Appends (`op: "append"`)

Points are added without resetting the camera or dropping points:

- The renderer's `appendData` uploads only the new rows (amortised `O(k * D)`).
- The active mode's `dataChanged` keeps its motion: the frame at the moment of
  the append is unchanged, and the camera centre **glides** to the new mean
  with a 0.7 s time constant (the modes' own glide). The zoom does not change:
  the auto-zoom is computed from a fixed sample of the first 512 points, and the
  user zoom is the user's.
- Lattice re-measures neighbours only while the set is within its 1,000-point
  limit; the old wires stay until the new list is ready. Wander keeps the hop in
  flight and may visit new labelled points afterwards.
- **Tumble refit policy (chosen here):** after an append the variance share the
  tour states is stale, and the status and provenance say so ("before N new
  points"). Once no append has arrived for `refitQuietSeconds` (2 s) and the
  points added since the last fit are at least `refitShare` (1%) of the set,
  Tumble fits its directions again; the new tour blends in from the current
  axes, and the share is fresh again. A stream of appends therefore never
  triggers a refit per append. A refit never starts while paused, or while
  hidden or off screen (frames do not run then). It starts after resume.
- **The refit turn** is Tumble's own `refitTransition` (`"auto"`: sized to how
  far the new tour lies from the old, between 1.5 s and 12 s of mode time;
  `describe().refitTransition` gives the latest). The fit itself runs in units
  of a few milliseconds inside the frame budget, so a refit causes no stall.
  Mode entry keeps the mode's 1.5 s blend.
- **After a long piece of the viewer's own work** the next frame advances the
  clock by one normal frame (1/60 s), not by the whole gap, so the picture does
  not leap. This applies after a frame of over 50 ms, and after an `update()`
  call of over 20 ms (a large upload, such as the renderer doubling its
  capacity on an append). The delayed frame's rAF timestamp is not used as the
  reference for the next one.
- Measured on Chromium with the AMD Radeon 760M GPU, demo page, sample set of
  12,288 points, Tumble, "append 200 points" pressed three times. The figure is
  the largest per-frame change of the frame, divided by the largest in 5 s of
  normal running at the same speed (0.0143 at speed 1, 0.0429 at speed 3):

  | Dimension | Speed | Around the appends | During the refit and its turn | Turn length |
  |-----------|-------|--------------------|-------------------------------|-------------|
  | 384 | 1 | 1.00 | 1.09 | 4.3 s |
  | 384 | 3 | 1.00 | 1.11 | 4.5 s |
  | 1024 | 1 | 1.00 | 1.14 | 7.2 s |
  | 1024 | 3 | 1.00 | 1.00 | 4.6 s |

  The refit's work came to 212 ms (384-d) and 543 to 556 ms (1024-d) of
  main-thread time in all, with the longest step 8.8 to 10.3 ms. No long task,
  and the largest frame gap was 16.8 ms across the refit window.
- Labels: new labelled points join the label sample while it has room (300).
- Provenance: the base set's provenance is kept; the item count updates.
  `text_included` is true if either side says so.

Measured (Chromium, AMD Radeon 760M, 10,000 x 1024-d sample set, Tumble): one
append of 100 points takes 2.2 to 5.9 ms on the main thread. The first takes
99 ms, because it doubles the renderer's capacity and re-uploads the point
texture. On "append 200 points" onto 12,288 points: 44 to 46 ms for the first
(384-d) and 114 to 119 ms (1024-d), then 2 to 8 ms each. The later refit
(522 ms of work at 10,500 x 1024) produced no long task; its longest step was
9.6 ms.

## Time, seed and reproducing a view

- **View time** drives the modes, not the wall clock: each frame adds the frame
  time (clamped to 1 ms to 50 ms) times the speed, and only while running, ready
  and not suspended. After the tab or the element comes back, motion continues
  from where it stopped; there is no jump.
- The slow spin of the cloud (0.06 rad/s of yaw, the reference's) runs on the
  same clock and stops while dragging. With `spinWhilePreparing` (default on) it
  also turns while a mode prepares, through the frame the mode holds, so the view
  never stands still; the **mode** clock still starts at 0 when the mode is ready,
  so the frames a ready mode draws for a mode time do not depend on how fast the
  preparation ran. When the mode becomes ready its motion starts from the spin
  reached, with no jump. `time()` is the mode time: 0 while preparing.
- `seek(t)` sets the mode time and the spin. A seek during preparation also holds
  the spin until the mode is ready, so the frame shown then is the frame at `t`
  (the reproduction rule below holds whether the seek came before or after ready).
- A frame is a function of: the data, the seed, the mode, its time, and the view
  it entered from. **A fresh `mount` with the same data, seed and mode, followed
  by `seek(t)`, shows the same frame** (with no drag and the same zoom and
  viewport size). Switching modes hands the last frame to the next mode, so a
  view reached through mode switches is reproduced only by the same sequence.

## Pausing, visibility and reduced motion

- While `document.hidden` is true or the element is off screen (an
  `IntersectionObserver` on the viewer's root) **no animation frame is
  requested**, so no frame work runs at all. A frame callback that still
  arrives in that state returns at once without drawing. The loop restarts on
  `visibilitychange` or when the element scrolls back in.
- When nothing moves (paused with reduced motion, or no data) the loop goes
  idle and wakes on input, resize, theme or data.
- `prefers-reduced-motion: reduce` (read once at mount): the viewer **starts
  paused**, the Play button is visible, and twinkle is off. Pressing Play
  starts the motion; the user's choice wins. `options.paused` overrides the
  starting state.

## Heavy work

Mode preparation (`prepare()` steppers, Lattice's neighbour search, Tumble's fit
and refit, Wander's first stop) runs in units of a few milliseconds. The viewer
pumps it every frame within a budget that follows where the time went:

- **A share of the frame interval.** The budget is a third of the measured
  (smoothed) time between animation frames, never below `prepareBudgetMs` (8 ms)
  and never above three times it (24 ms). On a 60 Hz screen that is 8 ms, as
  before. On a device whose frames are long because drawing is slow (the GPU or
  the compositor), the work still gets a third of the wall time, so preparation
  makes steady progress at any frame rate.
- **Cut only when the work overran.** When the work itself took more than 16 ms
  and more than 8 ms past its budget (a unit far longer than asked: cold code, a
  garbage collection), the next frame gets half of `prepareBudgetMs`. The rest of
  the frame's script and the draw call do not count: a smaller budget would not
  make them shorter, and cutting it for them only starved the work. In 0.11.6
  the budget was halved after any frame callback over 16 ms;
  on the owner's phone, where every frame took about 59 ms, that left about
  4 ms of work per frame, and Lattice's neighbours were at 22 percent after
  30 seconds.
- Paused: at least 40 ms. Hidden or off screen: no frames, so no work; a gap of
  more than 250 ms between frames is not taken as a frame interval.
- A unit ends once a millisecond has passed, and the clock is looked at every
  4,096 multiply-adds or so, with no piece of work between two looks much
  larger than that. So a frame's work runs past its budget by one such piece
  at most, also on a device that runs JavaScript without a compiler (see
  "Slow devices": up to 0.12.0 a piece could be 2^20 multiply-adds, 50 to
  90 ms there). The results are bit-identical however the work is sliced.
- The strongest directions of a set are fitted once per set, seed and number
  of directions and kept with the set (`ET.modes.fittedDirections`): Lattice
  entered after Tumble does not fit them again. It is the result the fit
  would give again, so nothing shown depends on it.

Outside the budget, a frame does a fixed amount of work of its own, and none
of it is a pass over points in full dimension:

- **Names and hover.** The label sample (300 named points at most) needs its
  screen positions on every frame. A projector (`ET.viewer.makeProjector`)
  keeps an orthonormal basis of the directions the frames shown lately lay in
  (32 at most) and each sample point's coordinate along each. A frame row
  inside that span costs its coefficients in the basis and a short sum per
  point; a row with a part outside it adds that part to the basis with one
  pass over the sample; a full basis starts again from the frame shown. A row
  counts as inside when less than a millionth of its length is outside, so a
  name sits within a hundredth of a pixel of where the direct projection puts
  it (tested), and it follows its points on every frame as before.
- **Framing.** Tumble and Lattice frame through a zoom basis built while they
  prepare (`ET.modes.zoomWith`, `js/api/40-modes.md`): `autoZoom`'s rule from
  the sample's coordinates in the directions their frames move in.
- The screen mapping of the sample merges the draw state once per frame
  (`ET.renderer.placer`), not once per point.

Until the mode is ready the mode clock waits and the status shows the mode's
preparing line (for Tumble, `finding the strongest directions in 1,024-d … 40%`);
the slow spin keeps turning (`spinWhilePreparing`). `aria-busy` is set on the
root while preparing.

Measured on Chromium with the AMD Radeon 760M GPU, the demo page with one
viewer, the built-in sample set of 12,288 points, two runs each:

| | 384-d | 1024-d |
|--|-------|--------|
| Most script time in one viewer frame while loading | 11.8 to 13.0 ms | 13.2 to 15.0 ms |
| Longest frame gap while loading | 100 to 150 ms | 317 to 350 ms |
| Longest main-thread task while loading | 147 to 167 ms | 308 to 338 ms |
| `update()` call (validation, colours, upload) | 52 to 54 ms | 116 to 122 ms |
| Time to first frame (from `mount`) | 83 to 104 ms | 146 to 158 ms |
| Time to first moving frame (Tumble ready) | 536 to 563 ms | 1,263 to 1,282 ms |
| JS heap after load (one viewer, sample pool included) | 90 to 93 MB | 231 to 284 MB |

The longest task while loading, and the frame gap it causes, is not frame work.
It is the demo page's own script: generating 14,288 sample points, then the
`update()` call (the loader's validation, the colours and the GPU upload).
Every frame after that stays within about 15 ms of script. The heap figures are
from before the performance pass and were not re-measured.

## DOM structure

`mount` appends **one** element to `el` and nothing anywhere else; `destroy`
removes it. The host element's own attributes and styles are not touched.
Class names are stable (for the harness and for host CSS). The viewer sets its
styles inline from script, so a plain host rule on a class name only reaches
what the viewer leaves unset; to change the spacing and sizes it does set, a host
sets the spacing custom properties listed under "Theming" below, which need no
`!important`:

```text
div.tumbler                       role="group", aria-label, tabindex="0" (keys work while focus is inside)
  div.tumbler-stage               the sky; touch-action: pan-y; height from --tumbler-stage-height
    canvas.tumbler-canvas         WebGL 2; role="img" with an aria-label naming model, dimension, count
    canvas.tumbler-overlay        2-D: Wander spokes and rings, hover ring (no text); aria-hidden
    div.tumbler-labels            aria-hidden; span.tumbler-label pool (at most 64), text via textContent
    div.tumbler-masthead          p.tumbler-title (option title), p.tumbler-subtitle (counts)
    p.tumbler-status              the mode's status line (aria-live="off"; readable, not announced)
    div.tumbler-notice            role="alert"; p.tumbler-notice-text + button.tumbler-notice-dismiss
    div.tumbler-message           role="alert"; p.tumbler-message-text (no WebGL, lost GPU, refusal with no view)
    p.tumbler-empty               "No data yet. Call update(data) to show a set of embeddings." (no data, no message)
  div.tumbler-panel
    section.tumbler-search        the search panel (js/api/45-search-panel.md): a one-line bar, collapsed
    div.tumbler-modes             role="group" aria-label="View"
      button.tumbler-mode         data-mode, aria-pressed; b.tumbler-mode-title + span.tumbler-mode-summary
    div.tumbler-readout           canvas.tumbler-strip + p.tumbler-readout-caption
    div.tumbler-controls          button.tumbler-play, button.tumbler-zoom-reset, label.tumbler-speed,
                                  label.tumbler-labels-toggle, label.tumbler-trails-toggle, span.tumbler-hint
    details.tumbler-provenance    summary.tumbler-provenance-summary, dl.tumbler-provenance-list
                                  (dt.tumbler-provenance-term / dd.tumbler-provenance-value),
                                  p.tumbler-shadow
```

Styling is done only through `element.style` from script: no `style`
attribute, no `<style>` element, no stylesheet, so a `style-src 'self'` policy
with no inline styles allows it (checked with zero CSP violations in
`tests/browser/test_viewer_render.py`). The layout reacts to the element's width
(a `ResizeObserver`), since there are no media queries: below 600 px the mode
summaries are hidden, and the mode titles and the panel padding take their
narrow defaults (see "Spacing custom properties") and the buttons their touch
height; below 520 px the provenance list stacks; the status line
and the controls wrap. The two breakpoints are evaluated on their own at every
size change (a resize from 560 px to 360 px stacks the list). Checked at 390 px
wide.

## Theming: CSS custom properties

Set them on the host element or any ancestor. Read with `getComputedStyle` on
the viewer's root at mount, on every `update`, and on `refreshTheme()`. Only a
theme that differs from the one applied is applied again: then the trails
(drawn in the old colours) are cleared and the labels re-styled. An `update`
(an append, a refusal) or a `refreshTheme()` with the theme unchanged leaves
the trails and the colours alone.

| Property | Default (dark) | Default when the background is light | Used for |
|----------|----------------|--------------------------------------|----------|
| `--tumbler-background` | `#04060b` | — | panel background, the sky's edge, text halos |
| `--tumbler-sky` | `#0b1430` | `#ffffff` | the sky's centre (radial gradient) |
| `--tumbler-foreground` | `#e9eef6` | `#1b2130` | text, labels |
| `--tumbler-muted` | `#8a96ab` | `#5b6578` | secondary text |
| `--tumbler-line` | `#1b2436` | `#d6dae2` | rules and button borders |
| `--tumbler-accent` | `#ffc56b` | `#a35f00` | status line, selected mode, checkboxes |
| `--tumbler-ungrouped` | `#8cadff` | `#8cadff` | points with no group |
| `--tumbler-group-1` .. `--tumbler-group-24` | the reference's hues `hsl(h 90% 62%)` for h = 28, 52, 96, 140, 170, 198, 226, 266, 328, 4, 298, then golden-angle steps | same | group colours, in order of first appearance in the data |
| `--tumbler-font` | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | same | body text |
| `--tumbler-font-data` | `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | same | status, labels, controls, provenance |
| `--tumbler-font-display` | `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif` | same | title, mode names, Wander's stop name |
| `--tumbler-search-1` .. `--tumbler-search-4` | `#ffc56b` `#6be0ff` `#ff8fb3` `#b6ff8a` | `#a35f00` `#00708a` `#b0245a` `#3d7a00` | search A..D: ring, links, letters (read live by the panel, `js/api/45-search-panel.md`) |
| `--tumbler-shared` | `#ffffff` | `#1b2130` | the shared mark in the panel |
| `--tumbler-stage-height` | `clamp(300px, 62vh, 860px)` | same | height of the stage (any CSS length) |

### Spacing custom properties

The spacing and sizes a host is most likely to adjust are set inline as
`var(--tumbler-<name>, <default>)`, so a host stylesheet sets the property on the
host element or an ancestor and needs no `!important`. With none set, the browser
uses the default, so a host that sets nothing sees exactly the viewer's own
layout. The browser resolves `var()` itself and live: these properties are not
read into the theme, a change to one needs no `refreshTheme()`, and it never
clears the trails. Values are any CSS the property accepts (a length,
`clamp()`, `var()` of the host's own properties).

Two have a different default below 600 px (the viewer's own breakpoint, on the
element's width). A host's value wins at every width; to have a narrow value of
its own, a host sets the property again inside its own media query, as the
standalone page does for the mode title.

| Property | Default | Below 600 px | Sets |
|----------|---------|--------------|------|
| `--tumbler-masthead-top` | `14px` | same | `top` of `div.tumbler-masthead` |
| `--tumbler-masthead-left` | `16px` | same | `left` of `div.tumbler-masthead` |
| `--tumbler-masthead-right` | `16px` | same | `right` of `div.tumbler-masthead` |
| `--tumbler-title-size` | `clamp(28px, 6vw, 56px)` | same | `font-size` of `p.tumbler-title` |
| `--tumbler-title-margin` | `0 0 6px` | same | `margin` of `p.tumbler-title` |
| `--tumbler-status-left` | `16px` | same | `left` of `p.tumbler-status` |
| `--tumbler-status-right` | `16px` | same | `right` of `p.tumbler-status` |
| `--tumbler-status-bottom` | `10px` | same | `bottom` of `p.tumbler-status` |
| `--tumbler-panel-padding` | `6px 16px 16px` | `6px 12px 14px` | `padding` of `div.tumbler-panel` |
| `--tumbler-panel-gap` | `14px` | same | `gap` of `div.tumbler-panel` (between the mode switch, readout, controls and provenance) |
| `--tumbler-mode-padding` | `10px 12px 8px 0` | same | `padding` of each `button.tumbler-mode` |
| `--tumbler-mode-title-size` | `24px` | `20px` | `font-size` of each `b.tumbler-mode-title` |
| `--tumbler-mode-summary-size` | `12.5px` | same (the summaries are hidden) | `font-size` of each `span.tumbler-mode-summary` |
| `--tumbler-readout-caption-size` | `11.5px` | same | `font-size` of `p.tumbler-readout-caption` |
| `--tumbler-controls-gap` | `10px 18px` | same | `gap` (rows, then columns) of `div.tumbler-controls` |

The viewer sets no width or margin on `div.tumbler-panel` and no letter spacing
on the title, so a host centres or narrows the panel with a plain rule on the
class name.

- Colours accept hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, and anything else the
  browser resolves (resolved through a hidden probe element inside the viewer).
- Fonts: nothing is loaded from anywhere. Name a font the host already has
  (its own `@font-face` from its own origin, or a system font); the defaults
  are local stacks. The reference's Instrument Serif and IBM Plex are **not**
  bundled here (t11 decides for the standalone page).
- Font and length values that could name a resource (anything with `url(`,
  `image-set`, backslashes or `; { } < >`) are ignored and the default is used.
- **Light backgrounds** (`--tumbler-background` with luminance above 0.5). The
  renderer draws light on black (glow, bloom), which would wash out on a light
  page, so a light background is drawn as soft coloured ink. The stage is light
  (the host's colours) and each group is drawn as ink of its own hue: the points
  are uploaded in **complementary** colours (the hue fully saturated and
  darkened, then `1 - c`) and the canvas is shown with `filter: invert(1)`,
  `mix-blend-mode: multiply` and 70% opacity, so the additive image comes back
  as coloured ink laid lightly on the light sky; gain 0.55 and bloom 0.3 keep
  dense cores coloured instead of burning to black. Group names are darkened.
  Defaults for unset colours switch to the light column above. On a dark
  background the canvas uses `mix-blend-mode: screen` over the sky, exactly as
  before. The renderer's own `background` stays black in every case. There is
  no option or property to choose another treatment: two others (a dark
  night-sky panel inside the light page, and saturated ink at full opacity)
  were tried during development, and at the sign-off of the reference
  comparison the owner accepted only this one; both were removed at the owner's
  decision on 2026-11-14.
- The stage gets `isolation: isolate`, so the blending never involves host
  content behind the element.

## The provenance block (present whenever the view holds a set)

Every value is inserted with `textContent`. Rows, in order:

| Row | Content |
|-----|---------|
| Source | `provenance.source` |
| Synthetic | only when `provenance.synthetic`: "yes: these vectors were generated, not produced by the named model" |
| Model | `model` |
| Dimension | `dimension`, plus "(reduced from S)" for a top-k reduction |
| Items | the current count |
| Seed (view) | the viewer's seed |
| Seed (source) | `provenance.seed`, or "none" |
| View | the mode's title and `describe().projection` (always says "linear"), and for Tumble the variance share its directions hold, marked "measured before N new points" while stale |
| Reduction | none / exact rotation (nothing lost) / top-k with directions kept, variance dropped and "this view is an approximation of the space" |
| Producer | `provenance.producer` |
| Embedded through | `provenance.endpoint` (a route name; the contract refuses addresses) |
| Created | `provenance.created`, as text |
| Labels | "point ids only: this data carries no corpus text" when `text_included` is false |
| Limitations, Uncertain | the producer's lists, or "none known (the producer states none)" |

Then the sentence: "A projection is a shadow of the space, not the space: each
view shows three linear directions out of all of them, so points that look close
may be far apart and points that look apart may be close." The `<summary>` line
repeats source, model, dimension, items, seed, "synthetic" and "a projection is
a shadow of the space", so the facts stay visible when the block is collapsed.

## The readout strip

One cell per dimension of the data (a canvas `D` pixels wide, stretched to the
panel width with `image-rendering: pixelated`, so 2,560 cells cost no DOM
nodes). Cell `d` is drawn from its squared components on the three screen axes,
`ax = f0[d]^2` (horizontal), `ay = f1[d]^2` (vertical) and `az = f2[d]^2`
(depth), where `f0`, `f1`, `f2` are the three rows of the frame.

- **Opacity** is the reference's contribution formula, unchanged:
  `e = (ax + ay + az) * D / 3`, and the cell's alpha is `min(255, 80 e)`, that
  is, opacity `min(1, e * 80 / 255)`.
- **Colour** mixes three fixed colours by each axis's share of the cell:
  `(H * ax + V * ay + Dp * az) / (ax + ay + az)`, channel by channel (a cell
  with no share at all gets black, and is fully clear anyway). A dimension that
  feeds only one axis shows that axis's colour exactly; one fed equally by all
  three shows their even mix.

| Axis | Dark stage | Light stage |
|------|------------|-------------|
| horizontal | `rgb(255, 150, 60)` | `rgb(176, 84, 0)` |
| vertical | `rgb(80, 220, 160)` | `rgb(0, 128, 82)` |
| depth | `rgb(130, 140, 255)` | `rgb(72, 82, 214)` |

The three colours are fixed: they are not themable, and there are no custom
properties for them (the strip no longer uses `--tumbler-accent`). The stage
counts as light by the rule that already picks the soft-ink treatment (the
resolved `--tumbler-background` is light). The light set is the dark set
darkened so cells and legend words keep a contrast of at least 4.5 to 1 on the
default light panel (`#f6f4ee`) and on white; the dark set has at least 6.9 to
1 on `#04060b`. The strip is drawn with transparency over the panel, so a
host's own panel colours are the host's to check.

The caption sits below the strip: "dimension 1" on the left, "how much each of the
D dimensions contributes to the view right now · colour: horizontal vertical
depth" in the middle, and "dimension D" on the right. The three axis words are
the legend; each is `<b class="tumbler-axis-horizontal">` (and `-vertical`,
`-depth`) coloured in its axis colour. At large D several cells share a screen
pixel and the browser resamples them. Sizes are the reference's: 22 px of cells
(`box-sizing: content-box`, so a host's border-box reset does not shrink it)
between a 1 px line above and below in `--tumbler-line`, and the caption 6 px
beneath. The GL frame is not affected.

## Labels

As in the reference: group names at the centre of their labelled points
(fading out as Wander's fog comes in), Wander's stop name (display font) with
spokes to its labelled neighbours and their names, and the name of the
labelled point nearest the mouse pointer (within 20 px). Positions come from
`ET.renderer.place`; the projection for labels is done on the CPU for at most
300 labelled points per frame. A point is labelled when its label is a
non-empty string other than its id. Labels longer than 40 characters are cut
with `…`. All label text goes in with `textContent`; group names are shown in
capitals by CSS (`text-transform`), so the text itself is unchanged.

The look is the reference's. Every name has a dark outline standing in for the
reference's 4 px canvas stroke at 0.85: a ring of 16 hard text shadows (8 at
1.5 px with 0.5 px blur at 0.85, 8 at 2 px at 0.5) in the stage's background
colour, so on a light stage the outline is light. Group names are 11 px, the
group colour with its lightness raised from the reference's 62% to 72% (the
same lift for a host's `--tumbler-group-*` colours; on a light stage they are
darkened instead). Wander's stop name is 26 px italic in the display font,
white on a dark stage (the stage foreground on a light one); its neighbours'
names are the foreground three-eighths of the way to `--tumbler-muted`
(`#c5cddb` with the defaults); the ring and spokes use the group colour at 72%
lightness on a dark stage, the plain group colour on a light one. The hover
name and its ring use the stop's colour.

## Controls and input

- Mode buttons (real `<button>`s with `aria-pressed`, at least 44 px tall),
  Pause/Play, Reset view (class `tumbler-zoom-reset`, kept from when it was
  labelled Reset zoom; it resets the zoom and the pan, and is always offered,
  so also when the picture is moved at zoom 1), a speed slider, Labels and
  Trails checkboxes, a hint: "Drag to turn; right-drag, Shift + drag or two
  fingers move. Pinch, or Ctrl + wheel, to zoom; double-click or double-tap
  resets. Keys 1-3 switch views and arrows move while the viewer has focus."
  (the `3` is the number of views, at most 9)
  Pause/Play and Reset view are the reference's button (12 px type, 6 by 16 px
  padding, at least 76 px wide and 28 px tall); under 600 px wide they are at
  least 32 px tall for touch. The speed slider is 130 px wide.
- **Keys** only while focus is inside the viewer (the root is focusable and a
  pointer press on the stage focuses it): `Escape` dismisses the notice,
  `1`..`9` modes in button order,
  space play/pause (when the root itself has focus), `+`/`=` zoom in, `-` zoom
  out, `0` reset zoom and pan, the arrow keys move the picture the way they
  point by 0.1 of a pan unit (`ET.viewer.PAN_STEP`; not with Ctrl, Cmd or Alt,
  as for every key). Keys typed into the viewer's inputs are ignored. No key
  listener is ever added to the document or window.
- **Drag** to turn (pointer events, so mouse, pen and touch). Only a press on
  the sky itself (the canvases or the label layer) starts a drag, captures the
  pointer and focuses the viewer; a press on a control inside the stage (the
  notice's Dismiss button) is left to that control, so it gets its click, and a
  drag that starts on it does not turn the camera. Double-click resets the zoom
  and the pan, only on the sky. Every control is a native element, so Enter and Space work. The stage has
  `touch-action: pan-y`: a vertical swipe on a phone scrolls the page, a
  horizontal drag turns the cloud, as in the reference.
- **User zoom** multiplies each mode's automatic zoom, so switching modes still
  frames the cloud. Pinch with two fingers; Ctrl or Cmd + wheel (a trackpad
  pinch arrives this way) over the stage; or a plain wheel over the stage
  **only while the viewer has focus**. Otherwise the wheel scrolls the page.
  Double-click (mouse) or double-tap (touch, pen) resets, as does the Reset
  view button or `0`.
- **User pan** (task t17) moves the drawn picture without turning it. It is
  the renderer's draw key `pan`, `[x, y]` in units of the stage's `R = min(W,
  H) * radius` (one unit of the picture after zoom and perspective, so it
  follows the stage when it is resized), `x` right and `y` up. It changes no
  frame, centre, zoom, ranking or measure, and like the user zoom and the drag
  angles it is view state held by the viewer: reproducibility is untouched. The
  key is left out of the draw state while the pan is `[0, 0]`, so the draw
  state and everything drawn are exactly as before. Gestures: **right-button
  drag** or **Shift + left drag** (for trackpads) pans by the pointer's
  movement; a left drag still turns, unchanged; with **two fingers** the
  movement of their midpoint pans while their distance still zooms; the
  **arrow keys** pan by `PAN_STEP` while the viewer has focus. The browser's
  context menu is suppressed over the sky (the canvases and the label layer) so
  a right-drag works; over the controls it is left alone. A pan drag pauses
  the idle spin as a turn drag does, and a pan press is never a Focus click.
  The pan is clamped so the picture's centre (the point the zoom scales about)
  stays on the stage: `|x|` at most half the stage's width and `|y|` half its
  height, in pan units; a stage that shrinks clamps the pan held. Every reset
  of the zoom (double-click, double-tap, `0`, the Reset view button,
  `resetZoom()`, `resetView()`) resets the pan too. While the picture is
  moved the status line says `· moved`, after the zoom part and before
  `· paused`. A new data set keeps the pan, as it keeps the zoom.

## Lifecycle rules

- `destroy` cancels the animation frame, clears its retry timer, disconnects
  the `IntersectionObserver` and `ResizeObserver`, removes every listener it
  added (stage, controls, root, `document` `visibilitychange`, and `window`
  `resize` when there is no `ResizeObserver`), leaves the mode, disposes the
  renderer with `releaseContext: true` (every texture, buffer, program,
  framebuffer and vertex array deleted, and the WebGL context released at
  once), and removes its root from `el`. Twenty mount/destroy cycles leave no
  canvas, frame request, observer or listener behind (unit test).
- **No data yet**: a freshly mounted viewer says "No data yet. Call
  update(data) to show a set of embeddings." in the middle of the stage; the
  provenance block and the readout strip are hidden until a set arrives (a
  replace with zero points counts as a set: it shows provenance and the status
  `no points yet`).
- **WebGL 2 unavailable**: a plain message over the stage; `update` still
  validates, the provenance block still shows, nothing throws.
- **Context lost**: a notice ("waiting for the browser to restore it"); on
  restore it is cleared and drawing resumes from the renderer's CPU copy. If the
  restore fails, a message is shown and one `rebuild()` is tried a second later.
- A JavaScript error inside a frame (for example from a mode's `stateAt`,
  `mark`, `describe` or a preparation step) stops that viewer's loop and shows
  the notice "The viewer stopped: …" over the last picture instead of throwing
  every frame (`info().broken` is true). The next successful replace or mode
  switch clears it and the loop starts again. `update`, `setMode`, `info`,
  `seek`, `refreshTheme` and `destroy` never throw into the host, even with a
  mode whose members all throw (unit tests per member).

## Security notes

- No `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`,
  workers, `new Image`, `src`/`href` assignment or CSS `url(` anywhere in the
  core file (static test `js/test/viewer-static.test.js`, which also bans
  `innerHTML`, `insertAdjacentHTML`, style attributes and style elements in this
  module).
- Data text (labels, groups, provenance, messages) is only ever set with
  `textContent`.
- Nothing the viewer shows can be an address: the contract refuses an
  `endpoint` that is not a route name.

## Crowded sets

A point with a label is drawn at full weight; a set with no labelled point at
all draws every point at weight 0.7. Many such bright points pile up into a
featureless ball, so the overall brightness (`gain` in the renderer's draw
state) is multiplied by `600 / n` when the light load `n` is above 600. `n` is
the sum of the weights of the bright points actually uploaded to the GPU
(weight 0.7 or more): the labelled count, or 0.7 times the point count when
nothing is labelled. Points uploaded at 0.7 before the first labelled point
arrived by append are still drawn at 0.7 and keep counting 0.7 each, so that
append does not brighten the view (5,000 unlabelled points then one labelled:
`n` goes from 3,500 to 3,501); the dim unlabelled points of a labelled set
count nothing. `n` is updated with every upload and rolled back with a failed
one. At 600 or fewer nothing changes; the built-in sample set has 290. Found on a real 10,000-point Atlas, where every point carries text:
`docs/evidence/2026-11-14-real-atlas-proof.md`.

## Crowded wires

Lattice's wires pile up where the frame packs them tightly (most of all when a
swap is nearly through and the lattice collapses to a thin shape) and burned out
to white. Whenever wires are shown, the viewer sets the renderer's draw key
`wireLoad` to 8: the renderer measures the wire light per pixel where the wires'
light lands (`ET.renderer.wireDensity`, from the number of wires and where the
current frame puts them on the stage) and scales the wires' brightness by
`8 / light` when the light is above 8. The factor is the same for every wire, so
a wire seen near its true length still flares against one that is not. The key
is left out when no wires are shown, so Tumble, Wander and Focus draw exactly as
before. Measured on the built-in sample set (GPU, 320 x 180 copy of the stage,
channel sum above 600): near-white pixels at a swap 90% through went from 3,435
to 693, of which about 360 are the cores of labelled points; at 10% from 3,130
to 686. Approved by the owner on 2026-11-14 as a change of Lattice's no-search
picture (`docs/reference-differences.md`).

## Spin and group names in Focus

The view turns at 0.06 rad/s on top of the mode's frame, or at the mode's own
`inst.spin` when it has one (Focus: 0.13; `js/api/40-modes.md`). `seek(t)` sets
the spin to what running for `t` seconds in the current mode gives. While a
search is shown (the filter above 0) Focus draws no group names; the results are
what matters there. Both added after the owner's browser look (2026-11-14).

## Measured frame rates

Chromium (Playwright), dev page `js/dev/viewer-demo/?one=1`, one viewer,
1280 x 800 window (stage about 1248 x 400 CSS px, pixel ratio 1), built-in
sample set of 12,288 points, 5 s per mode after 1.5 s to settle:

| Backend | Dimension | Tumble | Lattice | Wander |
|---------|-----------|--------|---------|--------|
| AMD Radeon 760M (ANGLE, Vulkan) | 384 | 60.0 | 60.0 | 60.0 |
| AMD Radeon 760M (ANGLE, Vulkan) | 1024 | 60.0 | 60.0 | 59.9 |
| SwiftShader (software) | 384 | 34.0 | 29.6 | 28.0 |
| SwiftShader (software) | 1024 | 26.2 | 21.8 | 23.8 |

On the GPU the display's 60 fps cap is reached, so the headroom is not measured. This table was measured before the performance pass and has not been re-measured since; the GPU still held 60 fps in every run of the measurements above.

## Slow devices

Two reports from the owner's iPhone, both 2026-11-14. The first was about
drawing and the budget rule; the second, further down ("A device that runs
JavaScript slowly"), about the viewer's own arithmetic.

Found on the owner's iPhone (Chrome on iOS, so WebKit), 2026-11-14: the standalone
page with the built-in sample set drew at 17 frames per second, stood still for
seconds at start, and Lattice's neighbours were at 22 percent after 30 seconds.
Three changes answer it: the heavy-work budget above, `spinWhilePreparing`, and
`adaptivePixelRatio`. Nothing here was run on WebKit or on a phone.

Measured in Chromium (Playwright, headless, ANGLE on the AMD Radeon 760M), 390 x 844
window at device scale 3 (so a drawing-buffer ratio of 2), the shipped standalone
page, CPU throttled 6x (`Emulation.setCPUThrottlingRate`), a page-level
`requestAnimationFrame` wrapper that passes every fourth callback (15 frames per
second at most), milliseconds from opening the page or from the switch. The
machine was shared with other jobs (load average 1 to 7), so runs vary widely:

| Setup | Build | First motion | Tumble ready | Lattice done | Wander done |
|-------|-------|--------------|--------------|--------------|-------------|
| 6x, 1 in 4 frames | 0.11.6 | 11,046 to 21,579 | 10,378 to 20,785 | 14,946 to 60,348 | 182 to 642 |
| 6x, 1 in 4 frames | this | 1,206 to 2,612 | 4,202 to 15,136 | 5,908 to 20,038 | 79 to 143 |
| 6x, 1 in 4, 30 ms in draw | 0.11.6 | 23,383 | 22,683 | 48,587 | 464 |
| 6x, 1 in 4, 30 ms in draw | this | 1,261 to 1,906 | 5,569 to 11,586 | 7,432 to 13,867 | 108 to 503 |

"30 ms in draw" busy-waits inside the renderer's draw call, standing in for WebGL
calls that block on a GPU-bound device. Lattice's preparation includes its own fit
of the strongest directions (588 of its 834 ms on the development machine without
throttling), the same fit Tumble has just made.

Drawing cost, SwiftShader (software rendering, the slow-GPU stand-in), same window,
`adaptivePixelRatio` off, frames per second over 4 s:

| Mode | Ratio 2 | Ratio 1.5 | Ratio 1 |
|------|---------|-----------|---------|
| Tumble | 10.7 | 16.7 | 29.1 |
| Lattice | 10.0 | 15.5 | 24.0 |
| Wander | 10.7 | 17.5 | (not measured cleanly) |

What ratio 1 costs: half the drawing-buffer pixels in each direction against
ratio 2. Points keep their CSS size, but their edges, the wires (one-pixel lines)
and the glow are coarser, and the bloom, which samples fixed mip levels of the
drawing buffer, spreads twice as far in CSS pixels and shows its coarse levels as
soft blocks. The ratio is lowered only after two seconds under 25 frames per
second (a 30 fps cap such as iOS Low Power Mode does not trigger it) and is never
raised again in that mount, so it cannot flicker.

### A device that runs JavaScript slowly

The second report, the same day (Safari on the same phone): the default page,
then 999 named points in 1,024-d, at 6.7 frames per second while Tumble
prepared, drawing-buffer ratio 2. `info().timing` read: 150.3 ms between
frames, 144.0 ms of script per frame, 90.0 ms of it preparation against a
budget of 4.0 ms, 0.0 ms in the draw call. The built-in sample set (12,288
points in 384-d, 290 named) had run at about 17. The smaller set was the
slower one: the cost followed the dimension, not the point count.

**On the phone after the fix (2026-11-15).** The owner opened the same page on
the fixed build with the 999-point, 768-dimension set: 59.8 frames per second,
5.0 ms of script per frame, 1.0 ms of drawing, 16.6 ms between frames, pixel
ratio 2, and loading in "a few seconds", which the owner called fair. That
loading time does not fit the inference below (a fit without a compiler would
take minutes), so either the first reading came from a different browser or
mode on the phone, or the inference is wrong. The faults found were real either
way; the cause of the first reading's slowness is not settled.

What the readings mean. One unit of the fit then was one row of the Gram
matrix, up to 999 x 1,024 multiply-adds. 90 ms for that is about 90 ns per
multiply-add, where compiled JavaScript takes about 1. That is the speed of a
JavaScript engine running without its compiler. This is an inference from the
numbers: nobody looked at the phone's settings (iOS Lockdown Mode turns the
compiler off; so do some in-app browsers), and nothing here was run on WebKit
on a phone. JavaScriptCore on the development machine (the system's
`libjavascriptcoregtk`, driven from Python) gives the same picture: with its
compiler, units of 1 ms and the whole fit in under a second; with
`JSC_useJIT=0`, 37 to 50 ns per multiply-add, the fit 45 s, units of 40 to
50 ms (99th percentile and longest) before the change and 1 ms and 10 ms
after, the directions the same bit for bit.

Three things did a million multiply-adds or more in one go, which nothing
notices at 1 ns each:

| What | Multiply-adds at 999 x 1,024 | How often | Now |
|------|------------------------------|-----------|-----|
| A unit of preparation (a row of the Gram matrix; a group of four rows against 16 directions; a query row of Lattice's neighbours; 2^19 values of the mean and spread) | up to 1,048,576, with the clock looked at once per row | every frame while preparing | pieces of about 4,096 between two looks at the clock |
| The label sample through the frame in full dimension (300 points), with the draw state merged once per point | 921,600 | every frame, in every mode, also while preparing | the projector: about 50,000 |
| The zoom sample through the frame in full dimension (512 points; Tumble and Lattice) | 1,572,864 | every frame once ready | the zoom basis: about 50,000 |

Lattice also fitted the strongest directions a second time (700 million
multiply-adds, the fit Tumble had just made); it now takes the kept ones.

Measured in Chromium (Playwright, headless, SwiftShader) started with
`--js-flags=--jitless` and the CPU throttled 3x, 390 x 844 window at device
scale 2, the shipped standalone page with the Wikipedia pair lifted to 1,024-d
(999 points, all named; the 768-d vectors plus 256 linear combinations of
them), `info().timing` read on every frame, median (90th percentile, largest)
in milliseconds. This setting gives the phone's readings almost exactly, which
is why it was chosen:

| While Tumble prepares (30 s) | Phone | Before | Now |
|------------------------------|-------|--------|-----|
| Frames per second | 6.7 | 6.1 | 12.7 |
| Between frames (`intervalMs`) | 150.3 | 165.3 | 78.0 |
| Script (`scriptMs`) | 144.0 | 164.5 (174.6, 329.8) | 29.6 (33.5, 94.6) |
| Work (`workMs`) | 90.0 | 100.0 (108.7, 247.2) | 24.4 (25.7, 34.8) |
| Budget (`budgetMs`) | 4.0 | 4.0 | 24.0 |
| Script less work | 54.0 | 64.7 | 5.9 |
| Progress shown after 30 s | | 37% | 25% |

| Once ready (8 s) | Before | Now |
|------------------|--------|-----|
| Tumble: script per frame | 205.9 (254.3, 299.8) | 24.8 (34.8, 88.0) |
| Tumble: frames per second | 4.7 | 14.0 |
| Lattice: script per frame | 193.5 (198.1, 204.0) | 19.4 (22.5, 29.3) |
| Lattice, 25 s after the switch | still fitting, neighbours at 0%; work 101.4 (110.5, 115.6) at a budget of 4 | ready at once, neighbours at 9%; work 24.3 (25.0, 27.2) at a budget of 24 |

Read with care:

- About 14 frames per second is all this stand-in draws: software rendering
  takes about 70 ms a frame whatever the script does (with the compiler on and
  no throttle the same page also ran at 14.5). So "frames per second" now
  shows the stand-in's drawing, not the script, and says nothing about what
  the phone will reach.
- **Preparation takes longer than before on such a device**, because it now
  keeps to its budget. Before, the work ran 100 ms in a 165 ms frame (about
  610 ms of work per second); now 24 ms in a 78 ms frame (about 310 ms per
  second). The fit itself is unchanged: about 700 million multiply-adds for
  999 points in 1,024-d (most of it the Gram matrix, N x N x D / 2), 33 s of
  arithmetic with node `--jitless` on the development machine against one
  second compiled. Lattice's neighbours are another thousand million. On a
  device without a compiler that is minutes of wall time whatever the slicing.
  Making it short needs something else: directions and neighbours worked out
  by the producer and carried in the data file (an idea, not specced), a cheaper fit, or a
  larger share of the frame for the work while a mode prepares. None of these
  was done here.
- With the compiler on, nothing got slower: the fit of 999 x 1,024 took
  1,083 ms before and 1,085 ms now in node (12,288 x 384: 1,500 and 1,536),
  and with the CPU throttled 6x the same page was ready after 19.3 s before
  and 18.5 s now, with 16.0 ms of script per ready frame before and 2.9 ms now.
- The facing frame of a search (`ET.searchSets`) still works in units of 2^17
  multiply-adds with no look at the clock (about 12 ms each at 90 ns), and a
  click in Focus still projects every point directly. Neither runs on every
  frame; neither was changed.

`tests/browser/test_slow_script.py` runs the stand-in (300 named points in
1,024-d, `--jitless`, CPU throttled 4x) and fails on the old code: 191 of 623
preparing frames ran more than 12 ms past their budget (now none of 2,149),
and a ready frame's script was 178 ms where one direct pass over the two
samples took 158 ms on the same page (now 30 ms against 178 ms).
`js/test/slow-device.test.js` checks each piece, and that no result depends on
the slicing.
