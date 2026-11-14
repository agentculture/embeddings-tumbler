# The standalone page (`js/page/`)

A ready page around one viewer, after the reference demo: a full-bleed night
sky with the instrument panel beneath it and a note for each mode. Sources
`js/page/index.html`, `js/page/page.css` and `js/page/page.js`, shipped
byte-identical and flat in `embeddings_tumbler/static/` by
`python3 scripts/sync_static.py`. It needs the core file and, for the sample
set, `sample-data.js` in the same folder:

```text
index.html  page.css  page.js  embeddings-tumbler.js  sample-data.js
```

`embeddings-tumbler viewer write <folder> --apply` puts all five in a folder;
`embeddings-tumbler viewer serve <folder>` serves it on loopback.

## Query parameters

| Parameter | Meaning |
|-----------|---------|
| (none) | Show the built-in sample set (`EmbeddingsTumbler.sample.generate()`, its defaults). |
| `data` | Address of a data file (the contract's file form, a `.json` with its `.f32` block beside it), relative to the page or an absolute URL **on the page's own origin**. Anything else is refused with a plain message and nothing is requested. An empty `data=` means no data file. |
| `mode` | Starting mode: `tumble` (default), `lattice` or `wander`. An unknown id falls back to `tumble` (the viewer's rule). |
| `seed` | The view seed. Digits (optionally signed, with a decimal part) are read as a number, anything else as a string. Not the data's `provenance.seed`; the provenance block shows both. |

Examples: `index.html`, `index.html?data=sets/atlas.json`,
`index.html?data=atlas.json&mode=wander&seed=7`.

## Loading a data file

`page.js` fetches the JSON with the browser's `fetch` (same origin only; a
response redirected to another origin is refused), reads `vectors.file`,
fetches that block beside the JSON into an `ArrayBuffer`, and calls
`update` with the in-memory form (`Object.assign({}, records, { vectors:
block })`). The viewer validates it and shows any refusal itself, over the
stage.

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
  masthead (title and the counts line), the status line, the three mode tabs,
  the readout strip, the controls and the provenance block. The block starts
  collapsed; its summary line still names the source, model, dimension, item
  count, seeds, "synthetic" when it is, and that a projection is a shadow of
  the space. One click opens the full list.
- **The note for the current mode** below the viewer ("What is happening",
  "What to watch for"), switched by the viewer's `onModeChange`. The dimension
  and the Lattice wire count are filled in from the data after the set loads;
  nothing in the page hard-codes a dimension. A mode with no note (one a host
  registered) hides the notes.
- **A closing note**: for the sample set, the reference's "The data is
  synthetic: …"; for a data file, that the vectors came from that file and
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
These rules use the class names `js/api/50-viewer.md` documents as stable, with
`!important` because the viewer styles itself inline. They change spacing and
sizes only.

## Fonts

Nothing is downloaded. The reference loads Instrument Serif, IBM Plex Sans and
IBM Plex Mono from Google Fonts; the page names each first in a local stack, so
a machine with the face installed uses it, then falls back:

| Role | Stack |
|------|-------|
| Display (title, mode names, note headings) | `"Instrument Serif", "Iowan Old Style", "Palatino Linotype", Palatino, "URW Palladio L", P052, "Book Antiqua", Georgia, serif` |
| Body | `"IBM Plex Sans", "Segoe UI", Seravek, "Gill Sans Nova", Ubuntu, Calibri, "Source Sans 3", "Noto Sans", "DejaVu Sans", system-ui, sans-serif` |
| Data | `"IBM Plex Mono", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono", monospace` |

What differs from the reference, face by face: `docs/reference-differences-fonts.md`.

## Layout

Full-bleed stage; panel and notes centred, 1,120 px wide at most, with 20 px
gutters (or the safe-area inset, if larger). The notes go to one column under
720 px; the viewer hides the mode summaries under 600 px. Checked at 1280 px
and 390 px wide with no horizontal overflow.
