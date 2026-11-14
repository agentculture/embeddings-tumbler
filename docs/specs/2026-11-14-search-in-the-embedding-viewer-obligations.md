# Search in the embedding viewer: obligations

These are the behavioural obligations filed against the spec in
`2026-11-14-search-in-the-embedding-viewer.md`, confirmed by the owner on 2026-11-14.
Each names a seam and the behaviour owed there; delivery is checked against them one by one.
`devague export` does not write obligations into the spec file, so this page lists them.
It is generated from `.devague/frames/search-in-the-embedding-viewer.json`
(`devague oblige --list`); change them there, not here.

The two reference pages are part of the spec: `reference/tumbler-sky-search.html` (search in
Tumble, Lattice and Wander) and `reference/tumbler-focus-view.html` (the Focus view).
Obligation o12 is the one that binds the build to them.

## o1: search -> lit set

- **Owed:** The lit points and their order equal an exact full-space ranking by the stated measure on the same vectors; on-screen position is never an input.
- **Claim:** c6 (requirement)
- **Status:** approved

## o2: search -> motion

- **Owed:** With a search active the frame keeps changing in every mode; the swing to face the searches ends by itself within the stated time; Pause and reduced motion stop motion exactly as they do without a search.
- **Claim:** c7 (requirement)
- **Status:** approved

## o3: several searches -> person watching

- **Owed:** A point is marked as shared only when it lies within the result radius of two or more searches, and each pair's report (shared count, closest pair, distance) is computed from full-space distances.
- **Claim:** c4 (after_state)
- **Status:** approved

## o4: search panel -> page layout

- **Owed:** Collapsed, the panel is one line and the filter stays on; opening and closing never clears a search; expanded state is exposed to assistive technology.
- **Claim:** c9 (requirement)
- **Status:** approved

## o5: host callback -> viewer: embed(text)

- **Owed:** The viewer calls the callback with the query text and nothing else, accepts only a finite vector of the data's dimension with a matching model id, and makes no network request itself.
- **Claim:** c13 (decision)
- **Status:** approved

## o6: browser -> viewer serve embed route

- **Owed:** The route exists only when enabled; it answers only same-origin POSTs on a loopback bind unless explicitly widened; no response or log contains the gateway key, the gateway address or the query text.
- **Claim:** c35 (requirement)
- **Status:** approved

## o7: gateway key -> any page

- **Owed:** No file served to a browser and no response of the helper contains the gateway address or key; the key lives only in the helper's process environment.
- **Claim:** c16 (boundary)
- **Status:** approved

## o8: loaded points -> search without embedding

- **Owed:** With no embed callback, picking a point or typing words that match labels or texts produces a search; unmatched words are named; the panel says no text was sent anywhere.
- **Claim:** c28 (requirement)
- **Status:** approved

## o9: data file reduction -> query vector

- **Owed:** A query is compared only with vectors in the same space; a reduced or shifted file is searched by embedding only with the same change applied to the query, otherwise refused with a plain message.
- **Claim:** c30 (requirement)
- **Status:** approved

## o10: host callback -> viewer: rerank

- **Owed:** Without a reranker there is no toggle; with one, results show their move from embedding order and the reranker's name; a labels-only set offers no reranking.
- **Claim:** c11 (requirement)
- **Status:** approved

## o11: Focus mode -> core: the mode interface

- **Owed:** Focus registers as a fourth mode without editing an existing mode or the data contract, fits its view to the results, and lists each result's text or label as text.
- **Claim:** c12 (requirement)
- **Status:** approved

## o12: built search -> the two reference pages

- **Owed:** On comparable data the built views show what docs/specs/reference/tumbler-sky-search.html and tumbler-focus-view.html show (searches, lit and dimmed points, links, shared points, the swing, the collapsed panel, the toggles, the Focus list); every intended difference is listed in the repository and the user signs off the side-by-side comparison before release.
- **Claim:** c40 (requirement)
- **Status:** approved

## o13: query and result text -> page

- **Owed:** Query text, labels and result texts are inserted as text only; markup in any of them creates no element.
- **Claim:** c20 (requirement)
- **Status:** approved

## o14: search -> the space as that search sees it

- **Owed:** With the option on, ranking, shown distances and the fitted picture all use the same per-dimension scaling by that search's vector; with it off, nothing is scaled; the view states which is in effect.
- **Claim:** c44 (requirement)
- **Status:** approved

## o15: search -> what is lit

- **Owed:** The lit setting decides which points are lit and how strongly; with brightness by closeness, a nearer point is never dimmer than a farther one for the same search; the panel names the setting in use.
- **Claim:** c46 (requirement)
- **Status:** approved
