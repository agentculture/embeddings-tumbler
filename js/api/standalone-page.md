# The standalone page (`js/page/`)

A ready page around one viewer, after the reference demo: a full-bleed night
sky with the instrument panel beneath it and a note for each mode. Sources
`js/page/index.html`, `js/page/page.css` and `js/page/page.js`, shipped
byte-identical and flat in `embeddings_tumbler/static/` by
`python3 scripts/sync_static.py`. It needs the core file and, in the same
folder, the Wikipedia pair for its default data and `sample-data.js` for the
synthetic sample set:

```text
index.html  page.css  page.js  embeddings-tumbler.js
demo-wikipedia.json  demo-wikipedia.f32  sample-data.js
```

`embeddings-tumbler viewer write <folder> --apply` puts them all in a folder
(with `web-component.js`, which the page does not use);
`embeddings-tumbler viewer serve <folder>` serves it on loopback.

## Query parameters

| Parameter | Meaning |
|-----------|---------|
| (none) | Show the Wikipedia pair shipped beside the page (`demo-wikipedia.json` and its `.f32` block): 999 of English Wikipedia's vital articles (Level 3), text under CC BY-SA 4.0 (see `NOTICE`). When the pair cannot be read (a `file:` page, a folder without it) or the viewer refuses it, the page shows the synthetic sample set instead, with a line saying why. |
| `sample` | `sample=synthetic` shows the built-in synthetic sample set (`EmbeddingsTumbler.sample.generate()`, its defaults). Any other value is ignored. A link under the notes switches between the two sets. |
| `data` | Address of a data file (the contract's file form, a `.json` with its `.f32` block beside it), relative to the page or an absolute URL **on the page's own origin**. Anything else is refused with a plain message and nothing is requested. An empty `data=`, or one of only spaces, means no data file: the default set. |
| `mode` | Starting mode: `tumble` (default), `lattice`, `wander` or `focus`. An unknown id falls back to `tumble` (the viewer's rule). |
| `seed` | The view seed. Digits (optionally signed, with a decimal part) are read as a number, anything else as a string. Not the data's `provenance.seed`; the provenance block shows both. |

Examples: `index.html`, `index.html?sample=synthetic`,
`index.html?data=sets/atlas.json`,
`index.html?data=atlas.json&mode=wander&seed=7`.

## Search

The viewer's search panel is on the page as on any mount. Before mounting, the
page asks its own origin whether the helper route of `viewer serve --embed` is
there: `POST /_tumbler/search` with `{ "op": "describe" }`. The address is fixed
in `page.js`; no query parameter and no data file field can change it.

- A `200` JSON answer with `"ok": true` and an embed model: the viewer is
  mounted with an `embed` callback that posts `{ "op": "embed", "text" }` to the
  same route and returns `{ vector, model, queryForm }`, and, when the answer
  offers `rerank`, a `rerank` callback that posts `{ "op": "rerank", "query",
  "candidates" }` and returns `{ scores, model }`. Each candidate is cut to the
  route's `maxCandidateChars`, and a call with more candidates than its
  `maxCandidates` is not sent.
- Anything else (a 404 or 501 from a static server, a network error, an answer
  that is not JSON): no callbacks, and search matches the loaded points.

The page makes requests only to its own origin. The gateway address and key
stay in the helper's server process (`docs/search-interface.md`, "Helper route
(t5)"); the host guide (`docs/guides/host.md`, "Search") and the search guide
(`docs/guides/search.md`) describe both sides for readers.

## Loading a data file

`page.js` fetches the JSON with the browser's `fetch` (same origin only; a
response redirected to another origin is refused), reads `vectors.file`,
fetches that block beside the JSON into an `ArrayBuffer`, and calls
`update` with the records and the block beside the descriptor
(`vectors: { file, dtype, byte_order, byte_length, data: block }`). The viewer
validates it as the file form, the descriptor's fields included, and shows any
refusal itself, over the stage.

The records file (the `.json`) may be at most **64 MB**: a response whose
`Content-Length` is larger is refused before its body is read, and one sent
without a `Content-Length` is refused after reading if its text is longer. The
binary `.f32` block is not limited by this.

Leaving the page (`pagehide`) abandons a load still in flight: both requests
are aborted with an `AbortController`, and anything that arrives afterwards
changes nothing (no message, no viewer). If the browser restores the page from
its back-forward cache (`pageshow` with `persisted`), the load starts again.

The page reports these cases itself, before any viewer is mounted, as plain
text in the loading panel (`role="alert"`):

| Case | Message (start) |
|------|-----------------|
| Page opened from `file:` | `This page reads data files over HTTP from its own folder. …` |
| `data` is not a valid address | `The data address "…" is not a valid address.` |
| `data` on another origin | `Refused: the data address "…" points at another origin. …` |
| HTTP error | `The data file "x.json" could not be loaded: the server answered 404.` |
| Network failure | `The data file "x.json" could not be loaded.` |
| Not JSON | `The data file "x.json" is not valid JSON.` |
| Records file over 64 MB | `The data file "x.json" is too large: this page reads records files of up to 64 MB.` |
| `vectors.file` not a plain name | the contract's `vector-file-path` message |
| Block missing or unreadable | the contract's `block-unreadable` message |
| `embeddings-tumbler.js` missing | `The viewer is not available: …` |
| `sample-data.js` missing (no `data`) | `The sample set is not available: sample-data.js is missing from this folder. …` |

A JSON value that is not a file-form set of kind `embeddings-tumbler/data` at
schema version 1 (wrong kind, newer schema, no `vectors.file`, not an object)
is handed to `update` unchanged, so the viewer refuses it with the contract's
own code and message (`wrong-kind`, `schema-version`, `invalid-field`). An
appended file given alone is refused by the viewer with `append-without-base`.

One ordering difference from the core's own loader: the page checks
`vectors.file` and fetches the block before `update` validates the rest of the
fields, so a file with both an invalid earlier field and a bad block reports
the block problem. The core's `loadFile` reports the field first. Both refuse.

## What the page shows

- **The viewer** (mounted once, by `EmbeddingsTumbler.mount`) with
  `title: "Embedding Tumbler"` and `provenanceOpen: false`: the stage with the
  masthead (title and the counts line), the status line, the four mode tabs,
  the readout strip, the controls and the provenance block. The block starts
  collapsed; its summary line still names the source, model, dimension, item
  count, seeds, "synthetic" when it is, and that a projection is a shadow of
  the space. One click opens the full list.
- **The note for the current mode** below the viewer ("What is happening",
  "What to watch for"), switched by the viewer's `onModeChange`. The dimension
  and the Lattice wire count are filled in from the data after the set loads;
  nothing in the page hard-codes a dimension. A mode with no note (one a host
  registered) hides the notes.
- **A closing note**: for the Wikipedia set, what the vectors are, how many
  articles, the model and the text's licence; for the sample set, the
  reference's "The data is synthetic: …"; for a data file, that the vectors came from that file and
  that the provenance block says where they came from.

All text the page writes is set with `textContent`. Everything shown from the
data file is the viewer's (text only).

### State for tests and hosts

`<body data-page-state="…">`: `loading`, then `ready` (the set is showing),
`refused` (the viewer refused the set and shows why) or `error` (the page's own
message). Performance marks `tumbler-page-data-ready` and `tumbler-page-mount`
are set for measuring. The viewer's handle is `EmbeddingsTumbler.get(
document.getElementById("space"))`.

## Policy

`index.html` carries

```text
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self'; base-uri 'none'; form-action 'none'
```

(tighter than `default-src 'self'`; `img-src 'self'` only lets the browser's
own favicon request through without a violation). No inline script, no inline
handler, no `style` attribute, no `<style>` element; one stylesheet and three
scripts by plain same-folder names. Checked with a `securitypolicyviolation`
listener: zero violations (`tests/browser/test_standalone_page.py`). A host
that serves the folder can send the same policy as a header; `frame-ancestors`
works only as a header.

## Theming

`page.css` sets the page colours as `--page-*` properties on `:root` and passes
them to the viewer through its `--tumbler-*` properties on `#space` (see
`js/api/50-viewer.md`). To retheme, change the `--page-*` values; to change the
stage height, `--tumbler-stage-height` on `.space` (the reference's
`clamp(420px, 72vh, 900px)`; `clamp(260px, 70vh, 420px)` on screens under
560 px tall). The look is dark only, as in the reference; there is no
`prefers-color-scheme` switch.

`page.css` also adjusts the viewer's spacing to the reference's (panel centred
at 1,120 px under the full-bleed sky, masthead and status offsets, mode title
and caption sizes, a 22 px readout strip, the sky fading into the panel).
It does so by setting the viewer's spacing custom properties
(`--tumbler-masthead-top`, `--tumbler-title-size`, `--tumbler-panel-gap` and
the others `js/api/50-viewer.md` lists) on `.space`, and the narrow mode-title
size in its own `max-width: 600px` media query, so it needs no `!important`
(a test keeps `page.css` free of it). The few things the viewer does not set
inline (the panel's width and centring, the title's letter spacing and
balanced wrapping, the sky's fade) are plain rules on the class names
`js/api/50-viewer.md` documents as stable. They change spacing and sizes only.

## Fonts

Nothing is downloaded. The reference loads Instrument Serif, IBM Plex Sans and
IBM Plex Mono from Google Fonts; the page names each first in a local stack, so
a machine with the face installed uses it, then falls back:

| Role | Stack |
|------|-------|
| Display (title, mode names, note headings) | `"Instrument Serif", "Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052, "Book Antiqua", Georgia, serif` |
| Body | `"IBM Plex Sans", "Segoe UI", Seravek, "Gill Sans Nova", Ubuntu, Calibri, "Source Sans 3", "Noto Sans", "DejaVu Sans", system-ui, sans-serif` |
| Data | `"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace` |

What differs from the reference, face by face: `docs/reference-differences.md` (section "Fonts").

## Layout

Full-bleed stage; panel and notes centred, 1,120 px wide at most, with 20 px
gutters (or the safe-area inset, if larger). The notes go to one column under
720 px; the viewer hides the mode summaries under 600 px. Checked at 1280 px
and 390 px wide with no horizontal overflow.
