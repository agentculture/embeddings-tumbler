# Relative search in the embedding viewer: obligations

These are the behavioural obligations filed against the spec in
`2026-11-16-relative-search-in-the-embedding-viewer.md`, confirmed by the owner on 2026-11-16.
Each names a seam and the behaviour owed there; delivery is checked against them one by one.
`devague export` does not write obligations into the spec file, so this page lists them.
It is generated from `.devague/frames/relative-search-in-the-embedding-viewer.json`
(`devague oblige --list`); change them there, not here.

The reference page is part of the spec: `reference/tumbler-relative-search.html`, with its
reranker scores in `reference/demo-wikipedia-rerank.json` (made by
`scripts/build_reference_rerank.py`), on the shipped Wikipedia demo set. It shows one and two
searches; the third and fourth search of o7 have no picture. Obligation o11 is the one that
binds the build to it.

## o1: search vector -> vertical axis

- **Owed:** For every point, the coordinate along the pinned frame row equals the dot product of its vector with the unit search direction to float32 accuracy, at every settled moment; while the view is still turning onto the pinned frame the ruler is not drawn as exact.
- **Claim:** c9 (requirement)
- **Status:** approved

## o2: set minus search directions -> free axes

- **Owed:** The free rows are orthogonal to every pinned row and lie in the strongest directions of the centred remainder; the share shown is the share of that remainder held by exactly those directions on the rows fitted.
- **Claim:** c10 (requirement)
- **Status:** approved

## o3: data, seed, searches, time -> frame

- **Owed:** The same data, seed, sequence of search changes with their recorded times, and elapsed time give the same frame bit for bit, however time was sliced and however long any fit took.
- **Claim:** c11 (requirement)
- **Status:** approved

## o4: vector lengths -> words on screen

- **Owed:** The ruler, the status line and the labels say cosine only when every vector's length is within the stated tolerance of one; otherwise they say length along the search, and each named result also shows its cosine.
- **Claim:** c12 (requirement)
- **Status:** approved

## o5: origin control -> picture

- **Owed:** With the control on, the relative view includes the all-zero vector at the foot of the ruler and the plain view marks where it falls with its true distance from the centre and the visible part of it; the unit circle is drawn only for unit-length sets.
- **Claim:** c13 (requirement)
- **Status:** approved

## o6: renderer -> drawn height

- **Owed:** In the relative view, untilted, two points of equal height are drawn at the same screen height to within 2 percent of the ruler's visible length; with the flatness setting at its default every existing view renders the same pixels as before.
- **Claim:** c14 (requirement)
- **Status:** approved

## o7: second, third and fourth search -> axes

- **Owed:** The second search's direction lies exactly in the plane of the vertical and horizontal axes and is drawn as a ruler from the origin; a third pins depth so nothing tours; a fourth is lit and has no axis; a search that adds no new direction pins nothing and says so.
- **Claim:** c15 (requirement)
- **Status:** approved

## o8: reranker -> relative view

- **Owed:** Reranking changes no frame and no point's position. Named results carry reranker ranks 1 to top, the ruler marks the lowest candidate sent, and on a reranker failure, timeout or a search without text the view shows embedding order with no ranks, no mark and the existing note.
- **Claim:** c20 (requirement)
- **Status:** approved

## o9: relative off -> existing views

- **Owed:** With relative off, every frame of Tumble, Lattice, Wander and Focus is bit-identical to release 0.12.1 for the same data, seed and time, and every existing test passes unchanged.
- **Claim:** c3 (before_state)
- **Status:** approved

## o10: Tumble setting -> host, web component, standalone page

- **Owed:** Relative is turned on and off through a documented setting reachable from the script API, the web component and the standalone page's Tumble controls; the shells hold no projection logic; with no search the setting is kept and the view is plain Tumble.
- **Claim:** c21 (decision)
- **Status:** approved

## o11: reference page -> build

- **Owed:** For the same search on the Wikipedia demo set the built viewer and the reference page agree on which axis is pinned, on each named result's height to 2 decimal places, and on the reranked order; every other difference is listed as intended in docs/reference-differences.md before the owner is asked to sign.
- **Claim:** c24 (requirement)
- **Status:** approved

## o12: relative view -> network and data contract

- **Owed:** Turning relative on or off, adding searches and showing the origin make no network request, and no byte of the data contract, its loader or the helper route changes.
- **Claim:** c6 (boundary)
- **Status:** approved

## o13: search change -> switch time

- **Owed:** A change of searches or of the setting switches at a recorded time; the view keeps moving while the fit is prepared; an abandoned fit never changes what is shown.
- **Claim:** c28 (requirement)
- **Status:** approved

## o14: search added or removed -> motion

- **Owed:** The view turns onto the new pinned frame within the existing transition time and stays orthonormal throughout; searches keep their letters; Pause and reduced motion stop the tour exactly as they do in plain Tumble.
- **Claim:** c29 (requirement)
- **Status:** approved

## o15: point-of-view option -> relative view

- **Owed:** The point-of-view option changes only which results are named; the frame and every height are the same as with it off, and the status line says rank and height use different measures.
- **Claim:** c26 (requirement)
- **Status:** approved
