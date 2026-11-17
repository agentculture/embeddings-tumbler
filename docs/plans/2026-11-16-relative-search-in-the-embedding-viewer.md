# Build Plan — Relative search in the embedding viewer

slug: `relative-search-in-the-embedding-viewer` · status: `exported` · from frame: `relative-search-in-the-embedding-viewer`

> The embedding viewer has relative search: with a search active, the view can be measured from the search, so that one axis on screen is the search direction, a point's position along it is its similarity to the search, and the remaining axes keep tumbling

## Tasks

### t1 — Relative interface, written down before any code (new docs/relative-interface.md): the maths functions, the Tumble mode hook, the renderer's flatness key, the overlay's input, the setting names on the handle, web component and page, the words on screen, and the messages for searches that give no axis

- instruction: Read js/api/10-math.md, 30-renderer.md, 40-modes.md, 50-viewer.md, docs/search-interface.md, js/src/45-search-panel.js, js/shells/web-component.js and js/page/ first. Settle and write down: (1) names and signatures for every function tasks t2, t3, t6, t7 add; (2) where the Relative and Show the origin controls live among Tumble's controls, and the setting names for the script API, the web component and the page; (3) the exact strings for cosine against length along the search, the length tolerance, the shadow statement, the point-of-view note and each degenerate-search message; (4) how the faint similarity gradient for points that are not results reaches the renderer; (5) whether a search from a point names the point itself today, and what the relative view does with it; (6) which obligation o1 to o15 each later task proves. The binding inputs are the spec, its obligations page and the reference page. Change no code.
- covers: c6
- acceptance:
  - docs/relative-interface.md exists, names every new function, setting, draw key and on-screen string, and maps each of obligations o1 to o15 to the task that proves it
  - A node test (js/test/relative-interface-docs.test.js) fails when a name in the page is missing from the assembled file's internal namespace once the later tasks land, in the manner of search-interface-docs.test.js
  - The page states, from reading the code, whether a point search names the point itself, and the decision taken for the relative view

### t2 — Maths for the relative frame (js/src/10-math.js, pure): unit search directions made orthonormal with repeats and zero vectors dropped and reported; the strongest directions of the centred set after those directions are removed, fitted in small units on at most the fit cap of rows; a tour of one, two or three rows; the ruler's window; the unit-length check

- instruction: Add to ET.math only; keep makeTour's three-row output bit-identical for existing callers (the golden test of t4 must stay green). The remainder fit must be a stepper like makeGuidedTour and give the same result however it is pumped. The share returned is of the remainder, on the rows fitted. The window is computed over all points.
- depends on: t1
- covers: c9, c10, h8, c30, c31, h25
- acceptance:
  - js/test/math-relative.test.js: on the Wikipedia fixture and a search, the pinned row dotted with each point equals a direct dot product within 1e-5, and every free row dotted with every pinned row is below 1e-6 at ten times
  - The remainder fit pumped in one step and in one-unit steps gives bit-identical directions and share; the share equals the variance held by those directions divided by the remainder's total on the same rows within 1e-9
  - A zero query, two identical queries, a 3-dimensional set with one, two and three searches, and a set of 2 points each return three orthonormal rows and a named reason, and none throws
  - The window for a fixture with vectors opposite to the search starts below zero, ends at the higher of the search's length and the highest point, and is computed from every point
  - The unit-length check is true for the Wikipedia fixture and false for the mixed-length fixture, with the tolerance taken from docs/relative-interface.md

### t3 — Renderer: a flatness draw key (js/src/30-renderer.js) so the relative view is drawn nearly flat, with a default that leaves every existing picture unchanged; and the faint similarity gradient for points that are not results, as the interface page defines it

- instruction: Today place() uses the constant 3.0 / max(0.6, 3.0 + z2) in the shader and in the CPU twin used for labels; make both read one draw key and keep them in step. Default must reproduce today's value exactly. Run every browser or renderer command under the memory cap and timeout wrapper.
- depends on: t1
- covers: c27, c14
- acceptance:
  - js/test/renderer.test.js: with the key absent or at its default the vertex shader source and the CPU place() results are identical to those before this task
  - With the key at the relative value, two points of equal frame height and depths at the two ends of the cloud are placed within 2 percent of the ruler's visible length of each other by the CPU place()
  - The gradient value is ignored (pixels unchanged) when no search is active or relative is off

### t4 — Regression gate for everything that exists: golden frames from release 0.12.1 for Tumble, Lattice, Wander and Focus, and a check that the data contract, its loader and the helper route are byte-for-byte unchanged

- instruction: Do this before any source change lands: generate the goldens from the 0.12.1 assembled file on main (several seeds, times and a search), commit them as a compact fixture under js/test/fixtures/, and add a node test comparing bit for bit. Add a pytest that fails if docs/data-contract.md, js/src/20-contract.js or `embeddings_tumbler`/`_embed_route.py` differ from their 0.12.1 content hashes. Every later task must keep both green with relative off.
- covers: c3, h2
- acceptance:
  - js/test/relative-off-golden.test.js compares frames of all four views at fixed seeds and times, with and without a search, bit for bit against goldens made from the 0.12.1 file, and passes on main before any other task
  - tests/`test_relative_untouched.py` fails when any of the three contract files changes
  - The whole existing suite (node --test, pytest) passes unchanged with relative off at the end of every wave

### t5 — Fixtures and evidence for relative search: a Wikipedia fixture for node tests, a realistic mixed-length fixture, a script that reproduces the cone figures, and the same figures measured on a second real model

- instruction: Write scripts/`measure_relative.py` (standard library, preview by default, --apply to write) that prints the mean vector's length, the cosine band to a search and the remainder's share for a data pair. Embed the committed corpus data/wikipedia-vital-3/corpus.jsonl with a second model through the gateway (Qwen/Qwen3-Embedding-0.6B, 1024 dimensions) under grant run, measure it, and record both models in docs/evidence/. Make the mixed-length fixture from real vectors scaled by real document lengths so lengths spread at least 20 percent, and say how it was made. Never print or write the key.
- covers: c5, h4, h19
- acceptance:
  - docs/evidence/2026-11-relative-search.md records, for google/embeddinggemma-2 and for a second real model, the mean length, the cosine band to three searches and the remainder's share, each reproduced by scripts/`measure_relative.py` from committed or regenerable data
  - tests/fixtures/relative/ holds a Wikipedia subset pair and a mixed-length pair whose lengths spread at least 20 percent and in which the nearest point by cosine is not the highest along the search; a pytest checks both properties
  - The why-it-matters wording in the guide is general only if the second model shows the same cone; otherwise the evidence page says for which models it holds

### t6 — Tumble's relative setting (js/src/40-mode-tumble.js, js/src/39-modes.js): with the setting on and searches present the frame is pinned (first search vertical, second in the horizontal plane, third on depth, a fourth has no axis), the centre and zoom follow the ruler's window, a change switches at a recorded time, and no swing is started

- instruction: Build on ET.math from t2. Treat a change of searches or of the setting like a refit: prepare the fit in small units while the view keeps moving, switch at a fixed time T, turn onto the new frame with the existing refit blend so the frame stays orthonormal, and discard abandoned fits by generation. Expose a flag saying whether the pinned axis is settled (exact) or still turning. Searches keep their letters when one is removed. Point of view and reranking must not reach the frame. Data replaced or appended refits at a recorded time and keeps the searches. Pause and reduced motion behave as in plain Tumble.
- depends on: t1, t2, t4, t5
- covers: c4, c11, h9, h7, c15, h13, c26, c28, h22, c29, h23, c32, h26
- acceptance:
  - js/test/modes-relative.test.js: two fresh instances given the same data, seed, sequence of search changes with their times and elapsed time give bit-identical frames at ten times, with the fit pumped in one step and in one-unit steps, including a search added mid-tour
  - The settled flag is false during the turn and true after it; while true the pinned row equals the unit search direction within 1e-6
  - Add A, add B, remove A: B keeps its letter and ends as the vertical row; every frame during each turn is orthonormal within 1e-5 and the turn ends within the existing transition time
  - With two searches both unit directions lie in the span of rows 0 and 1 (residual below 1e-6); with three, no row changes with time; a fourth changes no row; two searches pointing the same way pin one axis and report it
  - Frames with point of view on and off, and with reranking on and off, are bit-identical for the same data, seed, searches and time
  - mark() and a seek to a time before a switch reproduce the frame shown then; dataChanged with relative on matches a fresh instance given the final data, including when the point a search came from was removed
  - With relative on, face() starts no swing; with relative off every golden of t4 still passes

### t7 — Relative overlay (new file js/src/46-relative-overlay.js): from the frame, centre, window and searches it produces and draws the ruler with ticks, the level rings, the stems to named results, the second ruler, the origin marker and unit circle, the reranker's cut-off mark and the rank labels

- instruction: A pure function builds a draw list (segments, rings, texts with positions) from numbers; a second function paints it on a 2D context. Use the renderer's CPU place() with the flatness key so the overlay and the points agree. Draw the ruler as exact only when the mode's settled flag is true. All labels are drawn as text. Follow the reference page's look; where the built viewer must differ, note it for t15.
- depends on: t1, t2, t3
- covers: h11
- acceptance:
  - js/test/relative-overlay.test.js (fake 2D context): for the Wikipedia fixture and the search Rice the draw list holds ticks every 0.1 across the window, one stem per named result ending at that result's height on the ruler, and the search's marker at its own length
  - The origin marker's stated true distance equals the centre vector's length computed directly within 1e-6, in both the relative and the plain view; the unit circle is in the draw list only when the unit-length check is true
  - With reranked results the labels carry ranks 1 to top and the cut-off mark sits at the lowest candidate's height; with no reranking, or a failed one, there are no ranks and no mark
  - With the settled flag false the draw list holds no ticks and no stems

### t8 — Search panel and Tumble controls (js/src/45-search-panel.js): the Relative and Show the origin controls where the interface page puts them, the Face the searches control hidden while relative is on, named results showing rank, height and cosine as the set requires, and the notes for searches that give no axis

- instruction: Controls only; no projection or frame logic. Expanded and pressed states are exposed to assistive technology as the existing controls do. Strings come from docs/relative-interface.md.
- depends on: t1, t5
- covers: c25, h24
- acceptance:
  - js/test/search-panel-relative.test.js (fake DOM): the Relative control is offered in Tumble only, reports its state, and calls back on change; Show the origin likewise
  - With relative on the Face the searches control is not in the panel; turning relative off brings it back
  - On the mixed-length fixture each named result's row shows both length along the search and cosine and no text says cosine for the height; on the Wikipedia fixture the height is called cosine
  - A zero-length search, a repeated search and a fourth search each show their message from the interface page in the panel

### t9 — Viewer state and API for relative (js/src/50-viewer.js): the setting on mount and on the handle, searches handed to Tumble's relative setting, the status line and provenance naming the measure and which axes are exact, info() reporting the state, and Lit kept for results with the gradient for the rest

- instruction: Wire t6 and t8 through the existing search flow (latest wins, searches re-run after an append). The setting is kept when there is no search and the view is then plain Tumble. Reranker failure, timeout and a search without text keep embedding order and the existing note. No network request is made by anything here.
- depends on: t3, t6, t8
- covers: c12, c20, h17
- acceptance:
  - js/test/viewer-relative.test.js: setting relative on through mount options and through the handle pins the frame once a search exists; with no search the setting is reported on and frames equal plain Tumble's
  - The status line and provenance say cosine for the Wikipedia fixture and length along the search for the mixed-length fixture, name which axes are exact, keep the shadow statement, and with point of view on say that rank and height use different measures
  - info() reports relative, the pinned searches by letter, the measure name, the window and the remainder's share
  - With a fake reranker that fails, one that times out, and a vector search with no label, results stay in embedding order, no rank reaches the overlay input and the existing note is present
  - Results' lit values equal those with relative off for each Lit setting; other points receive the gradient value defined in the interface page

### t10 — Viewer drawing for relative (js/src/50-viewer.js, second pass): the overlay of t7 drawn each frame from the mode's state, the flatness key and centre and zoom applied, the origin control in both views, and the test hook that reports drawn positions

- instruction: Second task on the same file as the previous one, so it runs after it. Keep frame work inside the existing frame budget; the stems, rings and labels are drawn only for named results. Extend the viewer's existing test hook so a browser test can read each named result's drawn position and the ruler's ends.
- depends on: t7, t9
- covers: c13
- acceptance:
  - js/test/viewer-relative-draw.test.js: with relative on and a search the overlay is painted each frame with the mode's frame, centre and settled flag; with relative off or no search nothing of the overlay is painted and the flatness key is at its default
  - Show the origin in the relative view widens the window to include zero; in the plain view it paints the marker with the true and the visible distance
  - The test hook returns, for each named result, its drawn height and the height its cosine maps to on the ruler; they agree within 1 pixel on the Wikipedia fixture

### t11 — Web component: relative and show-origin as attributes and properties (js/shells/web-component.js), with no projection logic in the shell

- instruction: Follow the existing attribute table in docs/guides/host.md. The shell only forwards the setting to the handle.
- depends on: t10
- acceptance:
  - A node test with the fake DOM: setting and removing each attribute, and setting each property, reaches the handle's setting and is reflected back
  - The shell's source contains none of the maths or renderer function names (the existing no-logic check, extended)

### t12 — Standalone page: the Relative and Show the origin controls among Tumble's controls (js/page/), kept in the page's address so a view can be reopened

- instruction: Controls and address handling only. The page keeps working with no search and with search among loaded points. Sync the shipped copies with the existing sync script.
- depends on: t10
- acceptance:
  - js/test/page.test.js additions: the controls appear with Tumble selected and not with the other views, change the handle's setting, and round-trip through the address
  - tests/`test_standalone_page.py` and tests/`test_sync_static.py` pass with the new controls

### t13 — Browser tests for relative search (tests/browser/`test_relative_`\*.py) on the three delivery forms, on the shipped Wikipedia demo pair and the mixed-length fixture

- instruction: Every browser command runs under the memory cap and timeout wrapper; a killed or hung command is not run again until the cause is known. Use the test reranker of the existing search tests. Recompute expected heights from the data inside the test.
- depends on: t11, t12
- covers: c16, h14, h12, h10, h5, c19, h21
- acceptance:
  - With the search Rice on the shipped demo pair the eight named results are drawn at the heights their cosines map to (recomputed by the test from the pair, failing if the pair changes) and none moves by more than 1 pixel during 30 seconds of tumbling
  - On desktop and phone widths, untilted, sampled points of equal height are drawn within 2 percent of the ruler's visible length of each other, on the software and the GPU renderer
  - The network log shows no request from turning relative on or off, adding searches or showing the origin
  - With the test reranker on, labels carry ranks 1 to top and the cut-off mark is at the lowest candidate's height; the rendered text for the mixed-length fixture never says cosine for the height
  - The script, the web component and the standalone page each turn relative on and show the same pinned axis; Pause and reduced motion stop the tour
  - With relative off, screenshots of Tumble, Lattice, Wander and Focus on the fixed-seed fixtures are pixel-identical before and after the flatness key was added, on the software and the GPU renderer

### t14 — Guides and API pages for relative search (docs/guides/search.md, docs/guides/host.md, js/api/, CLAUDE.md current state): what the ruler means, what stays a shadow, the origin, the reranker and point of view in the relative view, and how a host turns it on

- instruction: Write for both readers named in the spec. Include a worked example where a result ranked first under point of view is not the highest on the ruler. Use the figures from the evidence page of t5 and say for which models they hold. Mark nothing as shipped that is not.
- depends on: t11, t12
- covers: c2, h6, h20
- acceptance:
  - docs/guides/search.md has a relative-search section for people and docs/guides/host.md documents the setting for hosts, with a working example page that tests/`test_guides.py` runs
  - The point-of-view section says in plain words that height is not the scaled measure, with the example
  - js/api/ pages and docs/relative-interface.md agree with the code (the interface-docs test passes); markdownlint passes on every changed page

### t15 — Reference comparison for relative search: every intended difference from the reference page listed in docs/reference-differences.md, a side-by-side check on the Wikipedia demo set with the real reranker scores, and the owner's dated sign-off

- instruction: The reference page, demo-wikipedia-rerank.json and scripts/`build_reference_rerank.py` stay in the repository. Known differences to list: the page's Relative and Plain switch against a Tumble setting; one and two searches only; brightness by similarity only against Lit plus gradient; no Face control; reranking only for a search from one article with the Results slider as the kept count; the page's 2D-canvas look; whether the search's own point is named. Compare heights and reranked order by a script, not by eye. Show the owner the mixed-length wording on a page. Ask for the sign-off only after the list is complete.
- depends on: t13
- covers: c24, h18, c17, h15, h3, h16, c1, h1
- acceptance:
  - tests/`test_reference_differences.py` covers the relative section; a script compares, for the search Rice, each named result's height to 2 decimal places and the reranked order between the built viewer and the reference page's data, and passes
  - The reference page and its two data files open from a plain local web server started in the repository; the committed page is the published one
  - docs/reference-differences.md records the owner's sign-off of the relative section with its date, and that the owner read the mixed-length wording on a page

### t16 — Release of relative search: assembled core and shipped copies rebuilt, both packages byte-identical, version bumped, changelog and CLAUDE.md updated

- instruction: Use the version-bump skill (minor). Run scripts/assemble.py, the static sync, scripts/`check_packages.py`, the full suites, the linters, scan-secrets and the doctor gate. Fix every SonarCloud finding unless provably wrong with proof. The PR goes through the cicd skill.
- depends on: t13, t14, t15
- acceptance:
  - scripts/assemble.py --check, scripts/`check_packages.py`, node --test, pytest, flake8, bandit, markdownlint, scan-secrets and teken doctor all pass
  - CLAUDE.md's current-state section describes relative search and points to its spec, plan, obligations, reference page and evidence
  - CHANGELOG.md has the entry and the version is bumped in every place the version check reads

## Risks

- [unknown_nonblocking] Frame rate of stems, rings and labels on the 12,288-point sample set and on a phone is not measured; the overlay is limited to named results to bound it (task t10)
- [unknown_nonblocking] The agreed third-search behaviour (depth pinned, nothing tours) has no picture on the reference page; the owner sees it first in the build (task t6)
- [unknown_nonblocking] Whether a search from a point names the point itself is not yet read from the code; t1 settles it and success signal c16 lists eight results without Rice (task t1)
- [unknown_nonblocking] The second real model (Qwen3-Embedding-0.6B) must be served by the gateway when t5 runs; if it is not, the evidence covers one model and the guide says so (task t5)
- [unknown_nonblocking] The shader change for flatness may render differently on the GPU renderer than on the software one; t13 runs both (task t3)
- [unknown_nonblocking] On sets above the fit cap of 4,096 rows the reported share comes from a sample; its accuracy is not measured (task t2)
- [out_of_scope] Only Chromium is tested automatically, as for the rest of the viewer
- [follow_up] Relative in Lattice and Wander
