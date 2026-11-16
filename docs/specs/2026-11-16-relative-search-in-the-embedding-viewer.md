# Relative search in the embedding viewer

> The embedding viewer has relative search: with a search active, the view can be measured from the search, so that one axis on screen is the search direction, a point's position along it is its similarity to the search, and the remaining axes keep tumbling

## Audience

- People who search an embedding set in the viewer and want to read how every point relates to the search, not only which few points were returned; and hosts who embed the viewer and already supply a search.
  - instruction: Check docs/guides/search.md names both readers in its relative-search section.

## Before → After

- Before: A search lights its results and swings or fits the view to them, but the middle of the screen is an average (of the set in Tumble, of the results in Focus) and no axis has a meaning. Position on screen cannot be read as similarity to the search, and the origin is not shown anywhere.
  - instruction: Verify against js/src/40-mode-tumble.js (centre is st.mean) and js/src/26-search-sets.js finish() (centre is the mean of the results' centres).
- After: With relative on and at least one search, the first search's direction is the vertical axis. A point's height is its vector measured along that direction, which is cosine similarity when the vectors have length one. A ruler with ticks is drawn along the axis from the origin, each named result is joined to the height it is read at, and the other axes tour the strongest directions of the set after the search direction is removed. Turning relative off, or removing the last search, returns to the plain view.
  - instruction: Compare side by side with docs/specs/reference/tumbler-relative-search.html on the Wikipedia demo set with the same search.

## Why it matters

- Real sets sit in a narrow cone (Wikipedia demo set: mean vector 0.79 from the origin, cosines to one article between 0.52 and 0.84). A view centred on the average hides that and gives position no meaning for a search. Pinning one axis to the search makes one coordinate on screen exact and readable for all points at once.
  - instruction: The numbers are in scope finding s4; restate them in docs/evidence when the build measures them again.

## Requirements

- The pinned axis is exact: for every point, its coordinate along the pinned frame row equals the dot product of its vector with the unit search direction, to float32 accuracy, at every moment of the tour.
  - instruction: Unit test in node: for the Wikipedia fixture and a search, project with the relative frame at several times and compare row 1 with a direct dot product; tolerance 1e-5.
  - honesty: The exactness test runs on the real Wikipedia fixture and on a fixture of non-unit vectors, during a blend between views as well as on a settled frame (during a blend the axis is not yet exact, and the view must not draw the ruler as exact until it is).
- The free axes are orthogonal to every pinned search direction and tour the strongest directions of the centred set after those directions are removed; the share of the remaining variance they hold is reported in the status line.
  - instruction: Unit test: dot products of free rows with pinned rows are below 1e-6 at several times; status text contains the share.
  - honesty: The reported share is computed from the same directions the frame is touring, on the same rows, and is the share of what remains after the search directions are removed, never of the whole set.
- The relative view is reproducible: the same data, seed, searches and elapsed time give the same frame.
  - instruction: Unit test: two fresh instances, same inputs, frames equal bit for bit at several times, however time was sliced.
  - honesty: Reproducibility is tested across a search added mid-tour: the frame after the change depends only on data, seed, searches and the times at which they changed.
- The view says what the axis means. The ruler and the status line name the measure: cosine when every vector's length is within a stated tolerance of one, otherwise length along the search direction. The view keeps stating that it is a shadow, and which axes are exact and which are not.
  - instruction: Test with a fixture of non-unit vectors that the label is not cosine; test with the Wikipedia fixture that it is.
  - honesty: No text on screen says cosine or similarity for a set whose vectors are not of length one, checked by a test that reads the rendered labels.
- The origin can be shown. In the relative view a control zooms out to include the all-zero vector at the foot of the ruler. In the plain view the same control marks where the origin falls and states its true distance from the centre and how much of that distance is visible.
  - instruction: Browser test on the Wikipedia demo set: the marker text contains the true distance 0.79 in the plain view.
  - honesty: The origin marker's stated true distance equals the length of the centre vector computed directly, and the unit circle is drawn only when every vector has length one.
- The relative view is drawn so that heights read true: flat enough that two points with the same similarity are drawn at the same height to within 2 percent of the ruler's visible length when the view is not tilted by the user.
  - instruction: Browser test: sample points with equal similarity (synthetic fixture) and compare their drawn heights.
  - honesty: The 2 percent bound is measured on the built viewer at the widths the browser tests use (desktop and phone), not assumed from the reference page.
- A second search is drawn as a second ruler from the origin. The plane holding both search directions is shown exactly: the horizontal axis is the part of the second direction that the first does not already contain, and only depth tours.
  - instruction: Unit test: both unit search directions lie in the span of frame rows 0 and 1 (residual below 1e-6).
  - honesty: When two searches point the same way (the second adds almost nothing beyond the first) the view falls back to one pinned axis and says so, and this is covered by a test.
- The relative view works with the reranker. (Owner, 2026-11-16, on seeing the reference page without one: 'We should a have it.')
  - instruction: With a rerank callback set and Reranker on, the relative view shows the reranked results; covered by a browser test with the test reranker.
  - honesty: The reference page shows reranking with real scores from the real reranker on the Wikipedia set, not a toy, and the built viewer is compared with it for the same search.
- Reranking never moves a point in the relative view. Height stays the embedding's measure along the search; the reranker changes only which points are named and their order. Each named result carries its reranker rank, and the ruler marks the lowest candidate that was sent to the reranker.
  - instruction: Unit test: frames with reranking on and off are bit-identical for the same data, seed, searches and time. Browser test: labels carry ranks 1 to top, and the cut-off mark sits at the lowest candidate's height.
  - honesty: When the reranker fails, times out, or the search has no text to send, the relative view keeps embedding order, draws no ranks and no cut-off mark, and shows the existing note; covered by tests for each case.

## Honesty conditions

- The reference page on the real Wikipedia set shows the behaviour the announcement describes, and the owner has opened it and agrees it is the intended behaviour.
- The search guide explains the relative view to both readers and a host can turn it on through the documented API without reading the source.
- The built viewer still passes every existing Tumble, Focus and search test with relative off, with no change to any existing frame (bit-identical to 0.12.1 for the same data, seed and time).
- The built viewer and the reference page agree, for the same search on the Wikipedia demo set, on which axis is pinned and on every named result's height to 2 decimal places.
- The cone figures (mean length 0.79, cosine range 0.52 to 0.84) are reproduced by a script in the repository and recorded in docs/evidence, and a second real set of a different model is measured before the claim is written as general.
- A network log in the browser tests shows no request made by turning relative on, and the data contract tests pass unchanged.
- The listed heights are recomputed from the shipped demo pair by the test itself, not copied from this spec, and the test fails if the demo pair changes.
- The owner's sign-off is recorded with its date in docs/reference-differences.md, and every intended difference from the reference page is listed there before the sign-off is asked for.

## Success signals

- On the Wikipedia demo set with the search Rice, the eight named results are drawn at heights 0.84, 0.82, 0.76, 0.75, 0.74, 0.73, 0.73, 0.72 on the ruler (Cereal, Wheat, Maize, Bean, Bread, Vegetable, Cattle, Potato), and those heights do not change by more than 1 pixel while the view tumbles for 30 seconds.
  - instruction: Browser test on the shipped demo pair; read the drawn positions from the viewer's test hook.
- The owner opens the built viewer beside the reference page with the same search and signs off the differences in docs/reference-differences.md, as for search (0 unexplained differences).
  - instruction: Add a relative-search section to docs/reference-differences.md and ask the owner for sign-off.

## Scope / boundaries

- Relative search changes only the frame, the centre, the zoom and what is drawn over the picture. It adds no new kind of projection, changes no vector, changes nothing in the data contract and sends nothing anywhere. It is a way of viewing existing searches (typed words, a host embed callback, or the helper route), not a new way of searching.
  - instruction: The diff must not touch docs/data-contract.md, js/src/20-contract.js or `embeddings_tumbler`/`_embed_route.py`.

## Non-goals

- No rescaling of vectors to unit length for display. When vectors are not of length one the axis is still exact and is labelled as length along the search direction, not as cosine.
- No UMAP, t-SNE or other non-linear layout, and no distance-preserving layout around the search.

## Assumptions

- Fitting the remaining directions on a new search takes under half a second for sets up to the fit cap of 4,096 rows (measured: about 0.3 s for 999 rows of 768 dimensions in node), and can run in the existing small-unit steppers so the view keeps moving.

## Scope exploration

- `s1` — `js/src/40-mode-tumble.js and js/src/10-math.js makeTour`: Tumble's frame is a closed-form tour inside the 8 strongest principal directions of the centred set; its centre is the set's mean (centreTau glide). Nothing in it is measured from the origin or from a search. The tour takes any orthonormal basis and any number of directions of at least three, so a tour restricted to directions orthogonal to a search needs a tour of two rows or one row, which makeTour does not offer today (it always returns three rows).
- `s2` — `js/src/30-renderer.js`: The renderer already accepts any centre vector and any three orthonormal frame rows, and has a fog setting that dims by true full-dimension distance from the centre. It draws with a fixed perspective; the reference draws the relative view almost flat so that heights read true. There is no ruler, tick, ring or origin marker in the renderer or the overlay today.
- `s3` — `js/src/39-modes.js swings, js/src/43-mode-focus.js, js/src/26-search-sets.js`: Search today changes the view in two ways: Tumble swings its frame toward the searched points and releases back to the tour; Focus fits a facing frame to queries and results and centres on the mean of the results. Neither pins an axis to a query direction and neither centres on the query or the origin. Up to four searches (letters A to D) are supported.
- `s4` — `embeddings_tumbler/static/demo-wikipedia.json and .f32 (measured 2026-11-16)`: All 999 vectors have length 1 (0.99999997 to 1.00000002). The mean vector has length 0.79, so the set sits in a narrow cone far from the origin. Cosine to a single article ranges about 0.52 to 0.84 over the whole set (median about 0.62). After removing a search direction, the 8 strongest remaining directions hold 18 percent of the remaining variance, and the cloud's centre sits up to about 0.18 off the search axis in those directions (per-direction spread about 0.07 to 0.14). The plain tour's 8 directions also hold 18 percent.
- `s5` — `docs/data-contract.md and CLAUDE.md rules`: The contract does not require unit-length vectors and the viewer does not assume them; the spec fixes linear projections only, reproducible views from a seed, and that every view states it is a shadow. Rescaling each vector to unit length before drawing would not be a linear projection of the data as supplied.
- `s6` — `docs/specs/reference/tumbler-relative-search.html (https://claude.ai/artifact/JtQQjRJ64tUmvTrktBhZu7)`: A working reference page on the real Wikipedia set was built first. It shows: search A pinned to the vertical axis with a ticked ruler from the origin; results joined by stems to the height they are read at; two free axes touring 8 directions orthogonal to the search; a second search B drawn as a second ruler in the plane it shares with A (horizontal axis is what B adds beyond A) with only depth touring; a Show the origin control; a Plain view for comparison in which the origin marker reports its true and its visible distance. A search there is an article in the set or the mean of matched titles, because the page has no embedding model.
- `s7` — `js/src/24-search.js rerankOrder, docs/search-interface.md Reranking, embeddings_tumbler/_embed_route.py`: The reranker is a host callback rerank(query, candidates) returning scores and a model id; the core file never fetches. The pool is the 50 nearest named points by default and the best 20 are kept; each hit records its embedding rank, new rank, places moved and score. viewer serve --embed --rerank-model offers Qwen/Qwen3-Reranker-0.6B through the gateway. An Artifact page cannot call it, so the reference page reads scores made ahead of time by scripts/`build_reference_rerank.py` (one search per article, the article's text against its 50 nearest others).
  - seeds: `c19`, `c20`

## Decisions

- Relative is a setting inside Tumble, not a fifth view. It is the same tour with one or more axes pinned. (Owner, 2026-11-16: approved.)
- A third search takes the depth axis, so all three axes are pinned, nothing tours and the view only spins; a fourth search is only lit and has no axis. The reference page shows one and two searches only. (Owner, 2026-11-16: approved.)
- No fog in the relative view. Brightness shows similarity to the nearest search, as on the reference page. (Owner, 2026-11-16: approved.)

## Open parks

- [unknown_nonblocking] Label collisions among named results near the ruler (visible in the reference with the search Rice): the placement rule is not decided
- [follow_up] Whether the relative view should also be offered in Lattice and Wander
