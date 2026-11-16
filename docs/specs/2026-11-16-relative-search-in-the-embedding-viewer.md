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
- The reference page docs/specs/reference/tumbler-relative-search.html (published as <https://claude.ai/artifact/JtQQjRJ64tUmvTrktBhZu7>), with its data files beside it, is part of this spec: where the words and the page differ and the difference is not listed as intended, the page is what was agreed. (Owner, 2026-11-16: 'The artifact is part of the spec'.)
  - instruction: Keep the page, demo-wikipedia-rerank.json and scripts/`build_reference_rerank.py` in the repository; list every intended difference in docs/reference-differences.md.
  - honesty: The page and its two data files open from a plain local web server started in the repository with no network access apart from fonts, and the published copy and the committed copy are the same file.
- Named results are chosen by the viewer's existing measure, cosine distance, whatever the vectors' lengths. When the vectors are not all of length one, height (length along the search) and rank (cosine) can disagree: the view says so wherever it names the measure, and each named result shows its cosine as well as its height.
  - instruction: Test with a fixture of vectors of mixed lengths where the nearest by cosine is not the highest along the search; read both numbers from the label.
  - honesty: The mixed-length fixture is real or realistic (lengths spread at least 20 percent), and the label wording for it has been read by the owner on a page, not only asserted in a test.
- The point-of-view option does not change the relative view's axis. With point of view on for a search, its ranking uses the scaled measure as today, and height stays the plain vector measured along the plain search direction; the status line says that rank and height then use different measures.
  - instruction: Test: with pointOfView set, frames are bit-identical to pointOfView off for the same data, seed, searches and time; only the named results differ.
  - honesty: The guide's point-of-view section says in plain words that height is not the scaled measure, with an example where a result ranked first is not the highest.
- Drawing the relative view nearly flat is a renderer setting with a default that leaves every existing picture unchanged. Today the perspective constant is fixed in the shader (js/src/30-renderer.js place(): 3.0 / max(0.6, 3.0 + z2)).
  - instruction: Renderer test: with the setting at its default, the rendered pixels of the existing renderer fixtures are unchanged.
  - honesty: The unchanged-pixels check runs on both renderers the browser tests use (software and GPU) and covers Tumble, Lattice, Wander and Focus.
- A change of searches or of the relative setting takes effect at a recorded time, as a data refit does today. The fit of the remaining directions is prepared in small units while the view keeps moving, and how long the fit took never changes which frame is shown at a given time after the switch.
  - instruction: Unit test: run the same sequence of changes with the fit pumped in one step and in many small steps; frames after each switch time are bit-identical.
  - honesty: The recorded switch time is part of what mark() and a seek reproduce: seeking to a time before a switch shows the view as it was then.
- With relative on, a new search does not swing and release as plain Tumble does. The view turns onto the pinned frame within the existing transition time and stays pinned. When the first search is removed and another remains, that one becomes the vertical axis by the same turn, and every search keeps its letter.
  - instruction: Browser test: add A, add B, remove A; B keeps the letter B and ends on the vertical ruler; no frame jumps by more than the existing transition allows.
  - honesty: The turn onto the pinned frame keeps the frame orthonormal at every moment (no fold), measured the way the refit blend is measured today.
- Searches that cannot give an axis are handled and named: a search vector of zero length pins nothing and says so; a search pointing the same way as an earlier one adds no axis and says so; a set with fewer dimensions or points than the free axes need still gives three orthonormal rows.
  - instruction: Unit tests: a zero query; two identical queries; a 3-dimensional set with one, two and three searches; a set of 2 points.
  - honesty: Each degenerate case shows a message a person can read in the status line or the panel, checked by reading the rendered text, and none throws.
- The ruler covers whatever the data gives: from the lowest point's height to the higher of the search's own length and the highest point, including heights below zero, with the origin marked whenever zero is inside the window.
  - instruction: Unit test of the window with a fixture holding vectors opposite to the search.
  - honesty: The window is computed from all points, not from a sample, so no point is ever drawn off the ruler's range without the view having been zoomed by the person.
- When the data changes while relative is on (replace or append), the searches are kept as they are today and the remaining directions are fitted again at a recorded time.
  - instruction: Unit test through dataChanged with relative on, compared with a fresh instance given the final data.
  - honesty: A data change that removes the point a search was made from keeps that search's vector, as today, and the test covers it.

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
- A typed search embedded by the model behaves like an article used as a search. Probed on 2026-11-16 through the gateway with google/embeddinggemma-2, plain query form: 'rice', 'a grain that feeds half the world' and 'how do volcanoes form?' each came back with length 1.0, top cosines 0.80 to 0.83, medians 0.61 to 0.64 and minima 0.53 to 0.57, the same band as article searches.

## Scope exploration

- `s1` — `js/src/40-mode-tumble.js and js/src/10-math.js makeTour`: Tumble's frame is a closed-form tour inside the 8 strongest principal directions of the centred set; its centre is the set's mean (centreTau glide). Nothing in it is measured from the origin or from a search. The tour takes any orthonormal basis and any number of directions of at least three, so a tour restricted to directions orthogonal to a search needs a tour of two rows or one row, which makeTour does not offer today (it always returns three rows).
- `s2` — `js/src/30-renderer.js`: The renderer already accepts any centre vector and any three orthonormal frame rows, and has a fog setting that dims by true full-dimension distance from the centre. It draws with a fixed perspective; the reference draws the relative view almost flat so that heights read true. There is no ruler, tick, ring or origin marker in the renderer or the overlay today.
- `s3` — `js/src/39-modes.js swings, js/src/43-mode-focus.js, js/src/26-search-sets.js`: Search today changes the view in two ways: Tumble swings its frame toward the searched points and releases back to the tour; Focus fits a facing frame to queries and results and centres on the mean of the results. Neither pins an axis to a query direction and neither centres on the query or the origin. Up to four searches (letters A to D) are supported.
- `s4` — `embeddings_tumbler/static/demo-wikipedia.json and .f32 (measured 2026-11-16)`: All 999 vectors have length 1 (0.99999997 to 1.00000002). The mean vector has length 0.79, so the set sits in a narrow cone far from the origin. Cosine to a single article ranges about 0.52 to 0.84 over the whole set (median about 0.62). After removing a search direction, the 8 strongest remaining directions hold 18 percent of the remaining variance, and the cloud's centre sits up to about 0.18 off the search axis in those directions (per-direction spread about 0.07 to 0.14). The plain tour's 8 directions also hold 18 percent.
- `s5` — `docs/data-contract.md and CLAUDE.md rules`: The contract does not require unit-length vectors and the viewer does not assume them; the spec fixes linear projections only, reproducible views from a seed, and that every view states it is a shadow. Rescaling each vector to unit length before drawing would not be a linear projection of the data as supplied.
- `s6` — `docs/specs/reference/tumbler-relative-search.html (https://claude.ai/artifact/JtQQjRJ64tUmvTrktBhZu7)`: A working reference page on the real Wikipedia set was built first. It shows: search A pinned to the vertical axis with a ticked ruler from the origin; results joined by stems to the height they are read at; two free axes touring 8 directions orthogonal to the search; a second search B drawn as a second ruler in the plane it shares with A (horizontal axis is what B adds beyond A) with only depth touring; a Show the origin control; a Plain view for comparison in which the origin marker reports its true and its visible distance. A search there is an article in the set or the mean of matched titles, because the page has no embedding model.
- `s7` — `js/src/24-search.js rerankOrder, docs/search-interface.md Reranking, embeddings_tumbler/_embed_route.py`: The reranker is a host callback rerank(query, candidates) returning scores and a model id; the core file never fetches. The pool is the 50 nearest named points by default and the best 20 are kept; each hit records its embedding rank, new rank, places moved and score. viewer serve --embed --rerank-model offers Qwen/Qwen3-Reranker-0.6B through the gateway. An Artifact page cannot call it, so the reference page reads scores made ahead of time by scripts/`build_reference_rerank.py` (one search per article, the article's text against its 50 nearest others).
  - seeds: `c19`, `c20`
- `s8` — `challenge pass / adjacent-systems lens: docs/search-interface.md Distance and pointOfView, docs/guides/search.md`: Ranking is cosine distance whatever the lengths, so on a set that is not unit length rank and height can disagree; and the existing point-of-view option rescales dimensions for one search's ranking. Neither was in the frame. Seeded c25 and c26.
  - seeds: `c25`, `c26`
- `s9` — `challenge pass / hidden-dependencies lens: js/src/30-renderer.js place()`: Perspective is a constant in the shader, shared by all four views; the reference's flat drawing needs a renderer change that must leave existing pictures unchanged. Seeded c27.
  - seeds: `c27`
- `s10` — `challenge pass / concurrency and reproducibility lens: js/src/40-mode-tumble.js fit(), refit(), fixSwitch()`: Fits are pumped in small units and a refit switches at a fixed time T, so reproducibility survives slow fits today; a search change in relative needs the same treatment or the frame would depend on machine speed. The generation counters (gen, refitGen) already discard abandoned fits. Seeded c28 and c32.
  - seeds: `c28`, `c32`
- `s11` — `challenge pass / lifecycle and failure-modes lens: js/src/39-modes.js swings and requireDimension, js/src/24-search.js`: Plain Tumble swings and releases on a search; removal of a search, a zero or repeated search vector, tiny sets and heights below zero were not covered by any claim. Seeded c29, c30, c31 and questions q4 (Lit setting against brightness decision c23) and q5 (Face the searches control).
  - seeds: `c29`, `c30`, `c31`
- `s12` — `challenge pass / cheap-probe lens: typed queries through the gateway (google/embeddinggemma-2, 2026-11-16)`: Three typed searches embedded for real gave unit-length vectors and the same cosine band as article searches (top 0.80 to 0.83, minimum 0.53 to 0.57), so the ruler window found on the reference page holds for typed text on this model. One model only. Seeded c33.
  - seeds: `c33`
- `s13` — `challenge pass / security, privacy and operations lens: boundary c6, embeddings_tumbler/_embed_route.py, docs/guides/search.md privacy table`: Clean on what was read: relative adds no callback, no request and no new text leaving the page; reranking in relative sends exactly what reranking sends today. The reference page's reranker file was made by sending Wikipedia text (CC BY-SA) to the owner's local gateway, nothing private. Residual: the ruler draws the search's label on the canvas, which is text drawing, not markup.
- `s14` — `challenge pass / unexamined surfaces`: Not read or not measured in this pass: whether a search from a point names the point itself among its results (the reference leaves it out; success signal c16 lists eight results without Rice); js/shells/web-component.js, js/page/ and js/src/45-search-panel.js where the setting's control will live; Lattice, Wander and Focus code beyond their headers; frame rate of stems, rings and labels on the 12,288-point sample set and on a phone; any browser but Chromium; a second real model or a set that is not unit length (none is in the repository); legibility of ruler labels at phone width (only overflow was checked on the reference).

## Decisions

- Relative is a setting inside Tumble, not a fifth view. It is the same tour with one or more axes pinned. (Owner, 2026-11-16: approved.)
- A third search takes the depth axis, so all three axes are pinned, nothing tours and the view only spins; a fourth search is only lit and has no axis. The reference page shows one and two searches only. (Owner, 2026-11-16: approved.)
- No fog in the relative view. Brightness shows similarity to the nearest search, as on the reference page. (Owner, 2026-11-16: approved.)

## Open parks

- [unknown_nonblocking] Label collisions among named results near the ruler (visible in the reference with the search Rice): the placement rule is not decided
- [unknown_nonblocking] On sets larger than the fit cap (4,096 rows) the reported share of the remaining spread comes from a sample of rows; how far it can be from the true share is not measured
- [unknown_nonblocking] The reference page shows one and two searches; the agreed third-search behaviour (depth pinned, nothing tours) has no picture to compare a build against
- [unknown_nonblocking] Whether a second real model keeps its vectors in as narrow a cone as embeddinggemma-2 (mean length 0.79); the view's default window is taken from the data so it adapts, but the why-it-matters figures are from one model
- [follow_up] Whether the relative view should also be offered in Lattice and Wander
