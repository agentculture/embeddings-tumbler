# Side-by-side page (development only)

A reference page and what was built, next to each other (stacked on a narrow
screen), with the list of intended differences beside them to check off. It is
for the owner's comparison before a release. It is not shipped in the wheel or
the npm package.

Three comparisons, chosen with the first row of buttons:

| Button | Reference (left) | Build (right) | Data on both sides |
|--------|------------------|---------------|--------------------|
| The first demo | `embedding-tumbler-demo.html` | the standalone page, `?sample=synthetic` | the synthetic sample set (the build's vectors are bit-identical to the reference's) |
| Search in the views | `tumbler-sky-search.html` | the standalone page, `?sample=synthetic` | the same sample set, and the same searches typed into both |
| Focus | `tumbler-focus-view.html` | `focus-build.html`: the built viewer in Focus | the reference's own 124 texts and their vectors, read out of the reference page |

It is plain HTML, stylesheets and scripts, with no inline script or style,
under a policy that allows only the page's own origin. Nothing is fetched from
anywhere but the repository being served.

## Run

From the repository root:

```bash
uv run embeddings-tumbler viewer serve . --port 8791
```

Then open `/js/dev/side-by-side/`, for example
<http://127.0.0.1:8791/js/dev/side-by-side/>. The frames point at
`/docs/specs/reference/` and `/embeddings_tumbler/static/`, so the repository
root must be what is served. Run `python3 scripts/assemble.py` and
`python3 scripts/sync_static.py` first if you changed anything under `js/`.

Serve without `--embed`: the comparison is of the build with no embedder, so
that typed words are matched among the loaded points on both sides.

## What the buttons do

- **The first demo, Search in the views, Focus** load a reference and the
  build's counterpart. `?pair=sky` or `?pair=focus` in the address opens on
  that comparison.
- **Tumble, Lattice, Wander** switch both pages (not shown for Focus, which is
  one view). The first demo and the sky reference can be driven from outside:
  the mode lives in the URL fragment and the page listens for changes, so this
  page sets the fragment inside the frame (both are on one origin). The build
  reads `?mode=` once at load, so its frame is reloaded with the new query. If
  the reference's frame cannot be reached (for example the page was opened from
  another origin), it is reloaded instead and the status line says so.
- **Restart both** reloads both frames, so the two start from the same moment.
- **Search both** (the two search comparisons) types the text in the box into
  each page's own search box and fires its input event, so each side runs its
  own search code. The box starts with the reference's own starting searches
  (`tide harbor`, `reef kelp`, `comet nebula`; `water` for Focus), and the
  build is given them when its page has loaded, because the build's box starts
  empty. You can also type into either page directly.

## The Focus comparison's data

The Focus reference holds 124 words and phrases and 18 extra query phrases,
with vectors from a real model at 8-bit precision, inside its own script.
`focus-build.js` fetches the reference page from the same origin, reads that
data out of it, and gives the 124 texts to the viewer through `mount` and
`update`, so nothing is copied into the repository a second time and both sides
show the same vectors.

No model runs on either side. The reference places a typed query from the
stored vector of the whole phrase, or else from the mean of the stored vectors
of the words it knows. `focus-build.js` gives the viewer an `embed` callback
that answers the same way from the same stored vectors, standing in for a
host's embedder. It gives no `rerank` callback: the reference's reranker is a
toy, the build has none of its own, and so the build offers no Reranker here.

## Notes

- Each reference loads Google Fonts from another origin. Online, you see its
  real fonts; offline, it falls back, as the build does. The build loads nothing
  from another origin. In the headless check those requests were refused, which
  each reference logs as a failed resource.
- The references' motion is unseeded, so the two sides never show the same
  frame. Compare look, layout, results and wording, not frames.
- Each frame is about half the page wide, so the layout inside it is the
  responsive one for that width, not the 1280 px one. Open each page on its own
  for a full-width look.
- The list is `checklist.json`, one entry per `###` heading of
  `docs/reference-differences.md`. A test keeps the two in step. Ticks are kept
  in this browser only. Ticking is not the sign-off; the sign-offs are recorded
  in the document.
