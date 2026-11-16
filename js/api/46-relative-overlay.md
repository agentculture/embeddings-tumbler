# `ET.relativeOverlay`: the ruler and what hangs on it (`js/src/46-relative-overlay.js`)

Part of relative search (task t7 of
`docs/plans/2026-11-16-relative-search-in-the-embedding-viewer.md`; the binding
interface is `docs/relative-interface.md`, "Overlay (t7)"). The viewer calls
this module on every frame in Tumble while the relative view is shown or Show
the origin is on, and in no other case. A host never has to: the viewer draws
it. Pure JavaScript. It makes no request and reads no CSS.

It works in two steps because the viewer draws no text on a canvas:

1. `build` turns numbers into a **draw list**: shapes and texts, all in device
   pixels of the overlay canvas.
2. `paint` draws the shapes of the list on the overlay's 2-D context.
   `placeLabels` puts its texts into the page as `span` elements.

Every position goes through `ET.renderer.placer` with the draw state the
renderer was given this frame, perspective included, so the overlay and the
points agree.

## Functions

| Function | Returns | Notes |
|----------|---------|-------|
| `build(input)` | list | The draw list for one frame. Never throws for an unusable input: it returns an empty list. |
| `paint(ctx, list)` | boolean | Draws `segments`, `rings` and `marks`. `false` when the list had nothing to draw. |
| `placeLabels(layer, list, doc)` | number | Puts `list.texts` into `layer` as spans; returns how many are shown. |

### `build(input) -> list`

`input` (positions are in device pixels):

| Key | Meaning |
|-----|---------|
| `width`, `height`, `dpr` | The overlay canvas in device pixels, and the pixel ratio. A `dpr` that is not above 0 reads as 1. |
| `view` | The draw state given to the renderer this frame (`zoom`, `yaw`, `pitch`, `radius`, `perspective`, ...). |
| `vectors`, `dimension` | The set's block and its dimension `D`. |
| `frame`, `centre` | The mode state's frame (`Float32Array(3 * D)`) and centre (`Float32Array(D)`) this frame. |
| `relative` | The mode state's `relative` (`js/api/40-modes.md`), or `null` for the plain view. |
| `searches` | `[{ letter, colour, query }]`: every search shown, in letter order, with its raw query vector (`D` numbers). |
| `named` | `[{ index, text, ranks }]`: the named results to label, each point once. `ranks` is `[{ letter, rank }]` from a reranker that answered, and `[]` otherwise. |
| `cut` | `null` or `{ height, sent }`: the reranker's cut-off for the vertical search. `height` is the height of the lowest candidate sent and `sent` how many were sent. |
| `showOrigin`, `labels` | The viewer's settings. |
| `ink`, `paper` | Optional CSS colour strings. `ink` is the colour of the origin cross, the unit circle, the cut-off line and the result labels (default `#ffffff`). `paper` is the colour of the outline round every label span (default `#04060b`). The viewer passes the theme's. |

The list is `{ segments, rings, marks, texts, results, ruler, dpr, paper }`:

| Member | Shape |
|--------|-------|
| `segments` | `[{ x0, y0, x1, y1, colour, alpha, width, dash, kind }]`: rulers, ticks, stems and the cut-off line. `kind` is `"ruler"`, `"ruler2"`, `"tick"`, `"stem"` or `"cut"`; `dash` is `null` or an array. |
| `rings` | `[{ points, colour, alpha, kind, dash }]`: `points` is a `Float32Array` of x, y pairs forming a polyline. `kind` is `"level"` (a ring of every point at one height) or `"unit"` (the circle of vectors of length one about the origin, with `radius`). |
| `marks` | `[{ x, y, r, colour, alpha, kind }]`. `kind` is `"search"` (a search's raw query), `"origin"` (a cross; it also carries `far` and `seen`, below) or `"dot"` (the second ruler's dots). |
| `texts` | `[{ x, y, text, align, colour, alpha, kind }]`. `kind` is `"tick"`, `"title"`, `"result"`, `"cut"`, `"origin"` or `"search"`; `align` is `"left"`, `"right"` or `"center"`. Tick and result entries also carry their `height`; result entries their point `index`. |
| `results` | `[{ index, x, y, rulerX, rulerY, height }]`, one for each stem: the result's drawn position, the point on the vertical ruler at its height, and the height. The viewer's test hook reads this. |
| `ruler` | `null`, or `{ x0, y0, x1, y1, from, to }`: the vertical ruler's ends in pixels and in height. |

What it holds:

- **The relative view, settled.** The vertical ruler along the first pinned
  search's direction, from `max(0, bottom - 0.2)` (from 0 with Show the origin)
  to the top of the window. A tick and a level ring every 0.1, each tick
  labelled with the height to one decimal. A title `{measure} to {letter}` at
  the top. One stem for each named result, from the result to the point on the
  ruler at its height. A marker at each search's raw query. With a second
  pinned search, a second ruler along that search's own direction, with dots at
  0.1 to 0.9. With `cut`, a dashed line across the ruler at its height with the
  text `{sent} candidates above this line went to the reranker`. The origin
  cross with the text `origin (0, 0, … , 0)` whenever height 0 lies inside the
  window shown, whether or not Show the origin is on. With Show the origin, and
  only on a set whose vectors all have length one, the unit circle about the
  origin.
- **The relative view, not settled** (while the view turns onto the pinned
  frame): the vertical ruler's line only, faint. No ticks, no rings, no stems,
  no cut-off line, no result labels. The ruler is not drawn as exact while it is
  not.
- **The plain view with Show the origin:** the origin cross where the all-zero
  vector falls, with the text `origin · truly {far} from the centre, {seen} of it
  visible`. `far` is the length of the centre vector: the true distance. `seen`
  is the length of that distance's part that the three frame rows show. Both
  have two decimals, and both are also on the mark as `far` and `seen`.
- **Otherwise** the list is empty.
- **The search's own point.** A named result at cosine distance below `1e-7`
  from a search and of the same length (within `1e-6`) is that search's own
  point. It sits on the search's marker, so it gets no stem and no label.
- **Result labels** are in the list only when `labels` is true. A label is
  `[{ranks} ]{text}  {heights}`: the text cut to 28 characters (ending in `…`
  when cut), then the result's height along each pinned search with two
  decimals, joined by ` · `. Ranks come first when the reranker gave them (`1.`,
  or `A1.` with several searches, joined by a space). On a set that is not of
  unit length, two spaces and `cosine {c}` follow, with the cosine to each
  pinned search, so every label shows both numbers.
- **Search markers.** `marks` of kind `"search"` ring each search's raw query. The
  viewer drops them from the list when the search panel is mounted, because the
  panel already rings every query and letters it; without the panel they are the
  only mark at a query and are kept.
- Every text is data: `text` is whatever the set holds, and it is inserted as
  text, never as markup.

### `paint(ctx, list) -> boolean`

Draws the rings, segments and marks of the list on a 2-D context: dashed where
`dash` is set, a cross for the origin mark, a filled dot for `"dot"`, a ring for
the rest. It saves and restores the context's state when it can. It never calls
`fillText` or `strokeText`. Returns `false` when there was nothing to draw (or
no `ctx`), `true` otherwise.

### `placeLabels(layer, list, doc) -> number`

Puts each text of `list.texts` into `layer` (the viewer's
`div.tumbler-relative-labels`, `aria-hidden`, after the overlay canvas) as a
`span.tumbler-relative-label`. Text goes in with `textContent`, positions and
colours through `element.style`, an outline in the list's `paper` colour behind
every label so it reads on points. Spans are made once and reused, at most 160,
and the unused ones are hidden. `doc` is the document that makes the spans
(the layer's own when absent).

Labels that would collide are left out. Placing goes in this order: titles,
ticks, the cut-off and the origin first, then result
labels, the highest on the ruler first. A label whose box would overlap one
already placed is left out. The box is estimated from the text's length, not
measured. The panel's list carries every result, so nothing is lost. Returns the
number of spans shown (0 with no layer).

## Tested

`js/test/relative-overlay.test.js` (node), and the viewer's draw in
`js/test/viewer-relative-draw.test.js`. The strings are checked against the
source by `js/test/relative-interface-docs.test.js`.
