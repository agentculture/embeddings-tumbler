# Delivery Summary — Search in the embedding viewer

plan: `search-in-the-embedding-viewer` · run: `complete` · date: `2026-11-14`
baseline: `devague summary skeleton`

## Intent

> The embedding viewer can be searched: type a word, a sentence or a paragraph, or several at once, and the points nearest to each search stay lit while the view keeps moving.

After: A search panel under the stage takes one search per line, up to four. Each search becomes a marked point in its own colour; its nearest points stay bright and are joined to it, and the rest of the space dims. A point found by more than one search is shown white. Each pair of searches reports how many points both found and their closest pair of different results.

## Planned Work

- `t1` — Search interfaces, written down before any code: the search core's functions, the per-point lit value the renderer takes, the facing-view hook the modes take, the handle and info() additions, the embed and rerank callback contracts, and the helper route's request and response.
- `t2` — Search core, ranking (js/src/24-search.js, pure, no DOM): exact nearest points by cosine distance in the full space, run in slices; word search among loaded points; checks on a query vector; the same-space rule for reduced files.
- `t3` — Search core, several searches (js/src/26-search-sets.js, pure): up to four searches, what is lit and how strongly, points shared between searches, the report for each pair, the point-of-view scaling, and the seeded view that faces the searches.
- `t4` — Renderer: a per-point lit value and a shared mark (js/src/30-renderer.js), so results swell and brighten, the rest dim, and a point found by several searches is marked.
- `t5` — Local embed route for viewer serve (new module `embeddings_tumbler`/`_embed_route.py` and a flag on the serve verb): embeds a query, and optionally reranks, with the gateway key held only in the server process.
- `t6` — Modes: the swing to face the searches (js/src/39-modes.js and the three mode files). A new search, or the Face the searches control, draws the view toward the facing frame for about six seconds while it keeps drifting; then the mode's own motion carries on.
- `t7` — Focus, a fourth mode (new file js/src/43-mode-focus.js): the view is fitted to the results of the search and re-fitted when the search changes; with no search it shows the whole set.
- `t8` — Viewer API for search (js/src/50-viewer.js): the handle sets and clears searches by text, vector or point id; the host's embed and rerank callbacks; latest search wins; searches re-run after an append; info() reports search state.
- `t9` — Search panel (new file js/src/45-search-panel.js): the collapsed one-line bar, the text box (one search per line, up to four), result lists, the lit menu, the Distance difference, Reranker and point-of-view controls, the Face the searches control, and the query markers and links drawn over the stage.
- `t10` — Web component: the embed and rerank callbacks as properties (js/shells/web-component.js).
- `t11` — Standalone page: search without writing code (js/page/). The page uses the local embed route when viewer serve offers it, and search among loaded points otherwise.
- `t12` — Browser tests for search (tests/browser/`test_search_`\*.py) on the three delivery forms.
- `t13` — Guides: search for hosts and for people (docs/guides/host.md and a new docs/guides/search.md), with the API pages kept in step.
- `t14` — Real-data proof for search: on the 10,000-point real file and through the real gateway, measure and record what search does.
- `t15` — Reference comparison for search: the written list of every intended difference from the two reference pages, a side-by-side page, and the owner's sign-off.
- `t16` — Readout strip coloured by screen axis (js/src/50-viewer.js, the strip only): each cell mixes three colours by its dimension's share of the horizontal, vertical and depth axes; opacity unchanged.
- `t17` — Real-vector demo set: about 1,000 Wikipedia items embedded by a real model, shipped as the standalone page's default, with the synthetic set kept (scripts, a committed corpus, js/page/, packaging).
- `t18` — Candidates and top X: a search takes 3 to 100 candidates (50 by default) and the reranker keeps the top X (20 by default); with no reranker the results are 8 by default, up to 100 (search core, viewer, panel, embed route).

## Actual Delivery

| Plan task | Status | What actually landed |
|-----------|--------|----------------------|
| `t1` | delivered | `docs/search-interface.md` and the module pages under `js/api/`, later extended with "Clarifications from the build" and corrections. |
| `t2` | delivered | `js/src/24-search.js`: exact cosine ranking in slices, word search, query checks, the same-space rule. Changed during the build so that results are the nearest named points. |
| `t3` | delivered | `js/src/26-search-sets.js`: up to four searches, lit values, shared points, pair reports (later run in slices), point-of-view scaling, the facing frame. |
| `t4` | delivered | Per-point lit value and shared mark in `js/src/30-renderer.js`. Its criterion that the no-search frame stays byte-identical no longer holds for Lattice (`d1`). |
| `t5` | delivered | `embeddings_tumbler/_embed_route.py` and `viewer serve --embed`; hardened after a security review (key in a traceback, header parsing). |
| `t6` | delivered | The swing in `39-modes.js` and the mode files. A held facing view was removed after the owner read it as paused; only the swing remains. |
| `t7` | delivered | `js/src/43-mode-focus.js`. Reworked after the owner said it did not look like its reference: spin, zoom, no group names, list beside the stage. |
| `t8` | delivered | Handle methods, callbacks, latest-wins and `info().search` in `js/src/50-viewer.js`. The view also keeps turning while a mode prepares (`d3`). |
| `t9` | delivered | `js/src/45-search-panel.js`, with Candidates and Keep top added (`d2`) and the Face button following the view on a mode switch. |
| `t10` | delivered | `embed` and `rerank` as properties of the web component, with a tested example page. |
| `t11` | delivered | The standalone page uses the helper route when offered and word search otherwise. |
| `t12` | delivered | `tests/browser/test_search_forms.py` and `test_search_motion.py` on the three delivery forms, with negative controls. Chromium only. |
| `t13` | delivered | Search section in `docs/guides/host.md`, new `docs/guides/search.md`, a tested script example. |
| `t14` | partial | `docs/evidence/2026-11-14-real-search-proof.md` and its script. The 30 frames per second target is met on the GPU and missed on software rendering; the reranker and a query prefix were not measured on the real files; the corpus is a rebuild. |
| `t15` | delivered | Search part of `docs/reference-differences.md` (32 differences), the side-by-side page, and the owner's sign-off on 2026-11-15. |
| `t16` | delivered | The readout strip coloured by screen axis, with a legend. |
| `t17` | delivered | 999 Wikipedia vital articles as the default data, with corpus and build scripts, `NOTICE` and packaging. Embedded with `google/embeddinggemma-2` at the owner's later request, not the model first used. |
| `t18` | delivered | Candidates 3 to 100 (50), Keep top (20), Results up to 100, across the search core, viewer, panel and route. |

## Mid-work Decisions

- `d1` — Lattice's neighbour wires are toned down when they pile up, with or without a search. This changes the released viewer's no-search picture in Lattice, which the build's rule and task t4's first criterion ('with no search the frame is byte-identical to today's') forbade. Tumble, Wander and Focus with no search stay identical. — The owner tried the build on 2026-11-14 and said 'Lattice appears very bright. and a bit pixelated'; measured with no search: 11,710 lit pixels of 57,600, 3,812 near white. Asked whether to tone the wires down when there is no search, the owner answered 'Please do'.
- `d2` — Two pieces of work are added to the search build at the owner's instruction, ahead of their plan tasks: a real-vector demo set from Wikipedia as the standalone page's default, and candidates (3 to 100, default 50) with the reranker keeping the top X (default 20). — Owner on 2026-11-14: 'Yes, replace the demo default with real vectors. Plus, we need more results, 50 or 100, and add reranker and top x out of that (top 20?)'. The plan cannot take new tasks until the new requirements' honesty conditions are confirmed, and the owner asked for the work now.
- `d3` — While a mode prepares (at start and on entering a view) the cloud keeps its slow turn and the status line shows progress; the picture no longer stands still until the mode is ready. This changes how the released viewer starts with no search. — On the owner's phone the still picture during preparation read as frozen ('possibly it takes time to start. And I can still move it manually'). Asked whether to keep the view turning while it prepares, the owner answered on 2026-11-14: 'Keep the view turning while it prepares, yes'.

- Results are the nearest named points, while every point within the radius is lit. The interface first ranked all points; the spec asked for named results. — corrected during the build, recorded in `docs/search-interface.md`.
- A held "Face the searches" view was removed; only the swing remains. — the owner read the held view as paused.
- Focus was reworked to match its reference. — the owner: "Focus looks like Tumble but stopped".
- The demo set and the helper's default model became `google/embeddinggemma-2`. — the owner on 2026-11-15: "I prefer to work with embeddinggemma2 and not qwen3 for the embeddings".
- The packages declare `Apache-2.0 AND CC-BY-SA-4.0`. — the owner's decision on 2026-11-15.
- `adaptivePixelRatio` was built by a task agent as on by default; the main agent switched it off as unapproved, and the owner left it off after the phone showed drawing was not the cost.
- Preparation was cut into much smaller pieces, labels and zoom made cheap per frame, and Lattice reuses Tumble's fit. — the owner's phone showed 144 ms of script per frame; after the change it showed 5 ms and 59.8 frames per second.
- The wait for preparation on slow devices is left to GitHub issue 11. — the owner: "Leave it and let issue #11 solve it properly".
- Every test and browser command run by an agent goes under a 3 GB memory cap and a time limit. — a failed assertion on two fake DOM nodes used 40 GB three times and the machine was reset (lapse `l13`).
- CI runs the browser tests one at a time in the coverage job, with job time limits. — parallel runs starved software rendering and one run stuck past 26 minutes.

## Drift From Plan

| Plan item | Reason for divergence | Classification |
|-----------|------------------------|-----------------|
| `t4` (`d1`) | The owner tried the build on 2026-11-14 and said 'Lattice appears very bright. and a bit pixelated'; measured with no search: 11,710 lit pixels of 57,600, 3,812 near white. Asked whether to tone the wires down when there is no search, the owner answered 'Please do'. | `acceptable` |
| `t9` (`d2`) | Owner on 2026-11-14: 'Yes, replace the demo default with real vectors. Plus, we need more results, 50 or 100, and add reranker and top x out of that (top 20?)'. The plan cannot take new tasks until the new requirements' honesty conditions are confirmed, and the owner asked for the work now. | `acceptable` |
| `t8` (`d3`) | On the owner's phone the still picture during preparation read as frozen ('possibly it takes time to start. And I can still move it manually'). Asked whether to keep the view turning while it prepares, the owner answered on 2026-11-14: 'Keep the view turning while it prepares, yes'. | `acceptable` |
| `t14` | The frame-rate target of 30 per second with four searches was missed on software rendering (11.6 to 16.3); the reranker and a query prefix were not measured on the real files; the first proof's corpus was lost in the machine reset and rebuilt. No deviation record covers this. | `needs-follow-up` |
| `t17` | The plan's "about 4 MB" pair was 4.47 MB with the first model; after the owner chose `google/embeddinggemma-2` it is 3.45 MB. The model named in the task's work changed after it merged. No deviation record covers this. | `acceptable` |
| `t7` | Focus as first built did not match its reference and was reworked after the owner's look. No deviation record covers this. | `acceptable` |
| `t8` | A task agent added an option that lowers drawing resolution, on by default, without approval; it shipped switched off. No deviation record covers this. | `acceptable` |

## Evidence

- tests: `node --test` at `978b3be` — 855 pass, 0 fail
- tests: `uv run pytest -n 6 -q` at `978b3be` — 1,045 passed, 10 skipped (8 are checks that apply only while the search sign-off is open)
- tests: each test named in the Delivery Claims table was confirmed as passed in those two runs (2026-11-15)
- CI: all checks passed on the PR's final commit `fba70be`; SonarCloud reported no open issue on the pull request
- lint: `black`, `isort`, `flake8`, `markdownlint-cli2`, `scripts/scan-secrets.py`, `scripts/check_packages.py` — clean in CI
- commits: `34be00c..978b3be` (squash merge of PR #10)
- PRs / issues: #9 (plan), #10 (the build), #11 (follow-up)
- release: 0.12.0 on PyPI and on npm, both with licence `Apache-2.0 AND CC-BY-SA-4.0` (read from the registries on 2026-11-15)
- real data: `docs/evidence/2026-11-14-real-search-proof.md`
- the owner's phone, 2026-11-15: 59.8 frames per second, 5.0 ms of script per frame, on the released build's code

## Delivery Claims

Each claim's evidence record (`e1` to `e18`) was filed by the agent and confirmed by the owner on 2026-11-15, together with the behaviour changes `b1` to `b8`. The confidence levels are the agent's, capped by the approved lapses below. Why a claim is at medium:

- `c7`: reduced motion with a search active is not tested.
- `c9`: no screen reader, keyboard-only use or focus order was checked in a real browser (`l12`).
- `c11`, `c49`: the reranker's effect was not measured on the real 10,000-text files; the 100-candidate timings cannot be re-run (`l14`); the new controls were tested at desktop width only (`l15`).
- `c30`: no reduced file carries what is needed to change a query the same way, so that branch is not exercised.
- `c40`: the owner signed off with one word and did not go through the build-decided differences one by one.
- `c44`: the point of view was not compared as a picture or measured on real data.
- `c47`: the strip's colours for a light background were approved without being seen (`l1`).
- `c48`: that neighbours reflect meaning was checked by eye, not by a test of quality.

| Claim | Confidence | Evidence |
|-------|------------|----------|
| `c4` — A search panel under the stage takes one search per line, up to four. Each search becomes a marked point in its own colour; its nearest points stay bright and are joined to it, and the rest of the space dims. A point found by more than one search is shown white. Each pair of searches reports how many points both found and their closest pair of different results. | high | `js/test/search-sets.test.js::a point is shared exactly when it is inside two or more radii and lit` (run 2026-11-15) |
| `c6` — Results are the nearest points in the full space, by the stated distance measure, never by position on screen. The view says which measure is used. | high | `tests/browser/test_search_forms.py::test_lit_points_equal_an_exact_ranking_from_the_same_file` (run 2026-11-15) |
| `c7` — Search never stops or holds the view. A new search swings the view for about six seconds toward the linear view whose first axes join the centres of the searches, while it keeps drifting; then the current mode's own motion carries on with the filter kept. A Face the searches button repeats the swing. | medium | `tests/browser/test_search_motion.py::test_lit_pixels_change_every_second_during_and_after_the_swing` (run 2026-11-15) |
| `c9` — The search panel takes room only when needed: collapsed by default to one line that names the current searches and how many points are lit; each search's result list is collapsed until opened. The filter stays on while the panel is closed. | medium | `tests/browser/test_search_panel.py::test_opening_and_closing_keeps_the_search` (run 2026-11-15) |
| `c11` — A Reranker toggle re-orders the nearest results with a second scorer and says how far each result moved from its embedding order. The toggle appears only when the host supplied a reranker, and the view names the reranker in use. | medium | `js/test/search-panel.test.js::Reranker: absent with no rerank callback and for a labels-only set; present, named and moving with one` (run 2026-11-15) |
| `c12` — A fourth view named Focus: the view is fitted to the results of the search, a ranked list with each result's text sits beside the stage, and clicking a point searches from that point. | high | `js/test/mode-focus.test.js::criterion 1: Focus registers through the existing interface and edits no existing file` (run 2026-11-15) |
| `c13` — Query embedding is a host callback, embed(text) -> vector. The core file still makes no network request. For local use and the standalone page, embeddings-tumbler viewer serve gains an embed route on its own origin that holds the gateway key in the server process (started under grant run). | high | `js/test/viewer-search.test.js::typed text goes to the embed callback with the text and nothing else` (run 2026-11-15) |
| `c16` — The gateway address and key never reach a page. The core file makes no request; embedding and reranking happen in the host's callback or in the local helper's server process. | high | `tests/browser/test_search_forms.py::test_nothing_the_browser_or_a_caller_gets_holds_the_planted_key_or_address` (run 2026-11-15) |
| `c20` — Query text and results are inserted as text, never as markup, and are sent nowhere by the viewer; only the host's callback sees the query. | high | `tests/browser/test_search_panel.py::test_markup_in_a_label_creates_no_element` (run 2026-11-15) |
| `c28` — Search among the loaded points is supported as well, with no embedding: by picking a point, or by words matched against the labels and texts already in the data file. It works when the host supplies no embed callback. | high | `js/test/viewer-search.test.js::words are matched among the loaded points with no embed callback; unmatched words are named` (run 2026-11-15) |
| `c30` — A query vector is only compared with data in the same space. A data file whose reduction is not 'none' (top-k or rotation), or whose producer shifted or scaled the vectors, is searched by embedding only if the file carries what is needed to apply the same change to the query; otherwise embedding search is refused with a plain message and search among loaded points still works. (challenge pass / adjacent systems: docs/data-contract.md reduction and the embeddings-cli export options --rotate and --top-k; a rotated file has the same dimension, so the dimension check alone would pass a wrong comparison.) | medium | `js/test/viewer-search.test.js::via: embed with no callback is no-embedder; on a reduced set auto falls back to words with a note` (run 2026-11-15) |
| `c35` — The embed route of viewer serve is off unless asked for with a flag, is refused on a non-loopback bind unless a second flag says so, accepts only POST with a JSON content type from its own origin (Host and Origin checked, no cross-origin headers sent), limits text length and request rate, never logs query text, and never returns the gateway address or the gateway's own error text. With the flag off, viewer serve stays the static-only server it is today and still reads no environment variable. (challenge pass / security: `embeddings_tumbler`/`_static_server.py` and cli/`_commands`/viewer.py; serve can bind non-loopback with a warning, and any web page can send a request to a loopback port.) | high | `tests/test_embed_route.py::test_nothing_leaks_in_any_answer_header_or_log_line` (run 2026-11-15) |
| `c40` — Each intended difference between the built search and the two reference pages is listed in the repository, and the user signs off a side-by-side comparison before release. Known ones today: the references place a query from named words and use toy rerankers; the Focus reference draws on a plain canvas, has no multi-search and has an Only results toggle. (challenge pass / the artifact as part of the spec: docs/reference-differences.md is the precedent.) | medium | `tests/browser/test_side_by_side.py::test_sky_reference_and_built_page_show_the_same_searches` (run 2026-11-15) |
| `c44` — A 'from this search's point of view' option on a search. Distances are measured with each dimension scaled by that search's vector, so lit points and their order reflect the search's context. The picture is fitted to that scaled space, and the view states that distances are measured in the search's context. | medium | `js/test/search-rank.test.js::a scale ranks in the scaled measure and reports the plain one` (run 2026-11-15) |
| `c46` — Search has a choice of what is lit, including a variable lit power option in which a closer point is lit more strongly. | high | `js/test/search-sets.test.js::by closeness: the interface's formula, 1 at the nearest result, 0 a little beyond the last` (run 2026-11-15) |
| `c47` — Each cell of the readout strip is coloured by which screen axis its dimension feeds: it mixes three colours according to how much that dimension contributes to the picture's horizontal, vertical and depth axes. Opacity keeps meaning what it means now, the size of the contribution. | medium | `js/test/viewer-strip.test.js::a cell fed by one axis shows that axis's colour exactly (dark stage)` (run 2026-11-15) |
| `c48` — The demo's default data is real: about 1,000 items taken from Wikipedia and embedded by a real model, small enough to ship (about 4 MB). The synthetic set from the reference stays available. | medium | `tests/browser/test_standalone_page.py::test_with_no_query_the_wikipedia_pair_is_shown_with_its_own_numbers` (run 2026-11-15) |
| `c49` — A search takes more candidates and can keep the best of them: the nearest N by embedding are the candidates (3 to 100, 50 by default), and with the reranker on the top X of them are kept (20 by default). With no reranker the results stay at 8 by default and can be raised to 100. | medium | `js/test/search-candidates.test.js::50 candidates, top 20, a reranker that reverses: the 20 last of the 50 nearest` (run 2026-11-15) |

Lapse ledger evidence:

| Lapse | Code | What |
|-------|------|------|
| `l1` | `assumption-for-measurement` | t16: the agent never saw the coloured strip rendered; every check ran on the fake canvas and DOM, and its contrast figures are its own calculation. The darker colours for a light background are the agent's choice; the owner approved only the dark three. Main agent then loaded the shipped standalone page in Chromium: 384 cells, about 31 distinct colours, cells led by each axis roughly in thirds, legend colours as specified on dark and on light, no errors. |
| `l2` | `assumption-for-measurement` | t1: the helper route's rerank request and answer shape is an assumption about the gateway, not checked; the limits and timeouts in the interface (text length, candidates, rate, body size, 15 s and 20 s) and the under-4-ms stepper rule are judgement, not measurement; the cost of the pair reports is estimated, not timed; the Focus reference page and the viewer and web component sources were read only in part. The plan names js/api/39-modes.md, which is js/api/40-modes.md. |
| `l3` | `assumption-for-measurement` | t2: line coverage was not measured by the agent (its loader hides the module from node's coverage); the under-4-ms unit was met in warm runs but a cold first unit under load took 4.1 ms plain and 13 ms scaled; nothing was run in a browser. Main agent measured coverage with the CI method after merge. |
| `l4` | `assumption-for-measurement` | t5: built and tested only against a fake gateway; SonarCloud has not scanned it; cognitive complexity was judged by reading; idle connections are not capped and one rate window covers all tabs. Main agent then ran the route against the real gateway: embed returned a 1,024-d unit vector with its model id, rerank returned scores from the gateway's reranker (so the assumed request shape is correct), a foreign Origin got 403 and text/plain got 415, no CORS header was sent, and the server log held neither the gateway address, a key nor the query text. |
| `l5` | `control-absent` | t4: tests were written after the implementation; the old-build-against-new frame comparison was a one-time check, not a permanent test; the relayout path with lit values set is untested (it needs about 16 million points); the light-stage check uses a page that copies the viewer's light treatment, not the viewer; thresholds were set after seeing the numbers, with the tightest margin on the light stage; the object leak count is the agent's own wrapper. |
| `l6` | `assumption-for-measurement` | t3: all timings were taken at load averages of 18 to 32 and are noisy; cold first calls of the pair reports exceeded 8 ms under that load, and it stays one blocking call; no test asserts a time, only that work is split into units; the committed tests use hand-built rankings, and the check against the real ranking module was a scratch script; one interface clarification (when the closest pair is null) rests on the agent's reading of the reference. |
| `l7` | `control-absent` | t7: the module was written before its tests; the stepper returned by searchChanged is the agent's own decision and the viewer task had not been checked against it; the view was not looked at in a browser; the cost of re-fitting on every append was not measured; the full suite was not re-run by the agent after its last fix (main agent ran it after merge: all pass). |
| `l8` | `n-below-claim` | t6: implementation before tests; coverage not re-measured after the last test; the swing's speed and jump figures come from one 48-d sample set and one seed, and the test bounds were chosen from those same measurements; lazily cached values after a swing could depend on query order in an untested edge case; nothing was run in a browser. Criterion 1 does not hold literally for Wander, which already holds its frame for 2 s at each stop with or without a search. |
| `l9` | `assumption-for-measurement` | t8: nothing in a browser exercised search; the cost of the pair reports inside the viewer was not measured; complexity under 15 is the agent's estimate; 24 added lines (defensive branches) are uncovered. Main agent then drove search through the handle in Chromium: it works in all four modes with no errors, but found that results on the sample set are unnamed points (the build ranks every point, where the spec and the reference rank named points and light everything as near), that Wander with a search is almost dark (2 lit pixels of 57,600), and that Focus changes only 12 to 15 percent of its lit pixels per second. |
| `l10` | `assumption-for-measurement` | t10: no coverage figure for the web component's new lines (the shell is run through a function evaluation that the coverage tool cannot attribute, as before this change); the example embeds point ids only because the sample data carries no text; the search panel was not part of what was tested; the full suite was not re-run by the agent after its last comment edit (main agent ran it after merge). |
| `l11` | `assumption-for-measurement` | t11: its browser tests import private helpers from another test file; the 'data file cannot redirect the route' case is tested only on a fake browser; only Chromium. Named-results fix: timings were taken at a load average near 58 and one single unit reached 12 ms; the sample-set result was measured in node, not a browser; the 4 ms unit limit is not proven because its test skips under load. Main agent then ran free-text search end to end on the real 311-point file through viewer serve --embed and the real gateway: two typed texts were embedded and lit their true neighbours, the reranker reordered them, every browser request stayed on the page's origin, and the server log held no key, gateway address or query text. |
| `l12` | `assumption-for-measurement` | t9: cognitive complexity not measured; a screen reader, keyboard-only use and focus order were not checked in a real browser; the light treatment was tested by changing the standalone page's properties at run time, not on a real light host; no browser test runs the panel against viewer serve --embed; the full Python suite was not re-run by the agent after its last fix (main agent ran it after merge: all pass). Differences from the two reference pages that it found were not written into the differences document (task t15 does that). |
| `l13` | `control-absent` | Task agents ran node tests with no memory limit. One failed assertion on two fake page elements made node print and diff the whole object graph; the process passed 40 GB, was killed by the kernel at 19:35 and 19:45, the agent ran it a third time, and the machine was reset at about 20:04. Scratchpad files (briefs, rules, test page, state file) were lost with it. |
| `l14` | `provenance-missing` | t18 timings (scan, pair reports, facing frame at 100 results) are single-machine medians of 20 on a machine under varying load; the 'before' figures for 100 results used hit lists built by hand because the old code capped k at 20; the bench scripts were lost in the reset so the table in docs/search-interface.md cannot be re-run as written. |
| `l15` | `n-below-claim` | t18's new browser test ran only in Chromium at desktop width; the Candidates and Keep top controls were not looked at on a phone-width page or by the owner. |
| `l16` | `assumption-for-measurement` | The phone fix was measured only in Chromium standing in for a phone (frame gate, CPU throttle, busy-wait in draw) on a loaded machine; ranges come from 2 to 4 runs, some of an earlier rule; no WebKit and no real phone. The Lattice target of about 5 s was met only in the best runs (5.9 to 20 s). |
| `l17` | `grader-unverified` | tests/browser/`test_search_look.py`::`test_lattice_wires_follow_the_search` failed once on the unmodified base branch under heavy machine load (the wiki agent's control run); it passes in my full runs. A timing-sensitive test is in the suite and its threshold was not re-examined. |
| `l18` | `n-below-claim` | t14: frame rate with four searches on software rendering is 11.6 to 16.3 frames per second against the 30 target (a miss, recorded); the corpus is a rebuild, not the earlier proof's; the reranker, a query prefix and the first-lit frame's pixels were not measured on real data. |
| `l19` | `assumption-for-measurement` | The slow-script fix was measured in Chromium with its compiler off standing in for the phone, one run per setting on a shared machine; nothing ran on WebKit or the phone. That the phone runs JavaScript without a compiler is inferred from its readings, not checked. The zoom now differs from the previous release by up to 3.9e-9 relative and label positions by under 0.01 px. |
| `l20` | `assumption-for-measurement` | I told the owner the phone was very likely running JavaScript without its compiler. The phone then loaded the fixed build in a few seconds at 59.8 frames per second, which does not fit that inference. The cause of the first reading's slowness is not settled; the record in js/api/50-viewer.md now says so. |

## Remaining Work / Follow-up

- `t14` (partial): frame rate with four searches on software rendering is under target — measure on a real slow device before treating it as a defect; software rendering is what CI uses.
- `t14` (partial): the reranker and EmbeddingGemma's task prefixes on queries and articles were not measured on real data — embed the set both ways and compare.
- Preparation still happens in the browser for every file — GitHub issue 11, the next spec (directions and neighbours computed when the data file is made).
- Only Chromium is tested automatically — WebKit and Firefox runs.
- The cause of the phone's first slow reading is not settled (`l20`).
- CI: three browser tests account for about six and a half minutes of setup — a small follow-up to shorten them.
- `info().search` reports the text of a words search as sent "nowhere" even when a reranker received it — the owner has not said whether to change it.
- Reduced motion with a search active, and the panel with a screen reader, are untested.
- The 50 and 20 defaults for candidates and kept results, and the 2 second dwell in Wander with a search, have no verdict from the owner.
