# Search in the embedding viewer

> The embedding viewer can be searched: type a word, a sentence or a paragraph, or several at once, and the points nearest to each search stay lit while the view keeps moving.

## Audience

- People who look at their own embedding data in the viewer and want to see what a piece of text links to; hosts that embed the viewer and supply the query embedding; agents that drive the viewer.

## Before → After

- Before: The viewer shows a space but cannot be asked anything. To see what a text links to, a person has to find its point by eye.
- After: A search panel under the stage takes one search per line, up to four. Each search becomes a marked point in its own colour; its nearest points stay bright and are joined to it, and the rest of the space dims. A point found by more than one search is shown white. Each pair of searches reports how many points both found and their closest pair of different results.
  - instruction: Compare with docs/specs/reference/tumbler-sky-search.html.

## Why it matters

- It makes retrieval visible: you see what a query retrieves, how far each result truly is, and whether the neighbourhoods of two queries touch.

## Requirements

- Results are the nearest points in the full space, by the stated distance measure, never by position on screen. The view says which measure is used.
  - instruction: Unit-test the ranking against an independent brute-force computation at 768 and 1024 dimensions.
  - honesty: The ranking equals an independent brute-force ranking on the same vectors; on-screen distance is never used for ranking and the page says a projection is a shadow.
- Search never stops or holds the view. A new search swings the view for about six seconds toward the linear view whose first axes join the centres of the searches, while it keeps drifting; then the current mode's own motion carries on with the filter kept. A Face the searches button repeats the swing.
  - instruction: Measure in a browser that lit pixels keep changing every second during and after a search, in each mode.
  - honesty: After any search the frame is still changing every second in every mode; the swing ends by itself and never leaves the view held; reduced-motion and Pause still stop motion as before.
- The filter holds in Tumble, Lattice and Wander, and each keeps its own motion.
  - honesty: Switching mode with searches active keeps the lit set and the query markers, and Lattice still swaps axes and Wander still flies between points.
- The search panel takes room only when needed: collapsed by default to one line that names the current searches and how many points are lit; each search's result list is collapsed until opened. The filter stays on while the panel is closed.
  - honesty: Collapsed, the panel is one line; closing it never clears or pauses the searches; it works by keyboard and states its expanded state to assistive technology.
- A Distance difference toggle writes each result's true distance on its link and in the list, and how much farther each result is than the nearest one.
  - honesty: The numbers shown are full-space distances by the stated measure, the same ones used for ranking, not lengths in the picture.
- A Reranker toggle re-orders the nearest results with a second scorer and says how far each result moved from its embedding order. The toggle appears only when the host supplied a reranker, and the view names the reranker in use.
  - honesty: With no reranker supplied there is no toggle and no claim of reranking; with one, every result shows its move from embedding order and the reranker is named.
- A fourth view named Focus: the view is fitted to the results of the search, a ranked list with each result's text sits beside the stage, and clicking a point searches from that point.
  - instruction: Compare with docs/specs/reference/tumbler-focus-view.html.
  - honesty: Focus is a separable mode like the other three: adding it changes no existing mode and no part of the data contract; with no search it still shows the whole set.
- A query vector whose dimension or model differs from the data shown is refused with a plain message and the view is left unchanged.
  - instruction: Same rule as appends in docs/data-contract.md.
  - honesty: A wrong-dimension or wrong-model vector from the callback never reaches the renderer, and the message names both dimensions or both models.
- The view states, beside the provenance, what a search used: the model that embedded the query, the distance measure, the number of results asked for and the reranker, if any.
  - honesty: The search line is always visible while a search is active and matches what was actually used; it never names a model the callback did not report.
- Query text and results are inserted as text, never as markup, and are sent nowhere by the viewer; only the host's callback sees the query.
  - honesty: A query or result text containing markup creates no element, and the core file makes no request when a search runs (network log shows only the host's own callback traffic).
- Search among the loaded points is supported as well, with no embedding: by picking a point, or by words matched against the labels and texts already in the data file. It works when the host supplies no embed callback.
  - instruction: The sky reference does this: a query is placed from the named points its words match.
  - honesty: With no embed callback the panel still works and says plainly that it is matching loaded points, not embedding the text; words that match nothing are named, never silently dropped.

## Honesty conditions

- It holds for real model vectors, not only the synthetic reference: a typed text is embedded by the same model as the data and the lit points are its true nearest neighbours.
- A host can add search with one callback and no build step; a person at the standalone page can search without writing code, given the local helper.
- It is true today: the shipped viewer has no way to select, highlight or dim points (checked in js/api/50-viewer.md).
- Each pair's report is computed from true distances, and a point is white only when it is inside the result radius of two or more searches.
- What is lit is exactly what a retrieval over the same vectors with the same measure would return, so the picture can be trusted as a retrieval check.
- No file shipped to a browser and no response from the local helper contains the gateway address or key; the core file still passes the no-network scan; the helper's embed route answers only its own origin.
- The fitted view is an orthonormal 3-direction frame applied to every point alike; nothing non-linear is introduced, and the status line says the view is fitted to the searches.
- The time is measured from the vector arriving to the first frame with the lit set, on the 10,000-point real file, and the frame rate is read over at least 10 seconds with four searches active; the machine and renderer are stated.
- Measured in a browser at desktop and phone width with searches active and the panel closed.

## Success signals

- On a real data file of 10,000 points, a search lights its results within 1 second of the query vector arriving, and the frame rate with four searches active stays at 30 frames per second or more on the machine used for the earlier measurements.
  - instruction: Measure with the browser harness on the 10,000-point Atlas from the real-Atlas proof.
- With the panel collapsed, search adds at most one line (48 px or less) under the stage.

## Scope / boundaries

- The gateway address and key never reach a page. The core file makes no request; embedding and reranking happen in the host's callback or in the local helper's server process.
- Linear projections only. The view that faces the searches is a linear projection and the page says so.

## Non-goals

- No index: search is an exact scan of the loaded points.
- No answer generation and no chat. This shows retrieval; it does not write answers.

## Assumptions

- Clicking a point searches from that point's own vector, so it works without the embed callback.
- Every loaded point at least as near as the last named result is lit too, as the sky reference does; results can be asked for from 3 to 20, 8 by default.
- Result text is shown when the data file includes text; otherwise the label is shown.
- A word search among loaded points places the query at the mean of the matching points' vectors and then lights the nearest points, as the sky reference does; when both are available the panel says which of the two kinds of search ran.

## Scope exploration

- `s1` — `docs/specs/reference/tumbler-sky-search.html`: The original reference sky with the filter added: up to four searches, shared points white, a six-second swing to face the searches, collapsed panel. Its vectors are synthetic, so a query is placed from named words; a real build needs a real query vector. The user confirmed this page as the spec on 2026-11-14.
- `s2` — `docs/specs/reference/tumbler-focus-view.html`: A simpler page: 96 sentences, the view fitted to the results, a ranked list with texts beside the stage, click a point to search from it. The user asked to keep it as an additional view; it is named Focus.
- `s3` — `js/api/50-viewer.md and js/src/50-viewer.js`: The public API has mount, update, destroy and a handle; nothing selects, highlights or dims points and nothing exposes projected positions. The core file makes no network request of any kind. Search needs new API surface.
- `s4` — `embeddings_tumbler/_static_server.py`: viewer serve is static files only, GET and HEAD, and by design reads no environment variable. A local embed route changes that stated property.
- `s5` — `docs/data-contract.md`: Schema v1 has `text_included`: a file may carry no texts, only labels. Results can show text only when the file has it.

## Decisions

- Query embedding is a host callback, embed(text) -> vector. The core file still makes no network request. For local use and the standalone page, embeddings-tumbler viewer serve gains an embed route on its own origin that holds the gateway key in the server process (started under grant run).
- The reranker is an optional host callback, rerank(query, candidates) -> scores, offered by the same route as embedding.
- The two reference pages are the visual and behavioural reference: docs/specs/reference/tumbler-sky-search.html for search in the three existing views, docs/specs/reference/tumbler-focus-view.html for Focus.
