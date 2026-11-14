# `ET.searchPanel`: the search panel (`js/src/45-search-panel.js`)

The panel under the stage that a person uses to search: a one-line bar,
collapsed by default, and when opened the text box, suggestions, controls, note,
pair lines and one result list per search. It also draws the query rings and
links on the overlay, puts result labels over the stage as DOM text, and in
Focus lays the ranked lists beside the stage. Task t9 of
`docs/plans/2026-11-14-search-in-the-embedding-viewer.md`; the binding
interface is `docs/search-interface.md`, "Panel (t9)", with its
"Clarifications from the build (t9)".

The panel drives the viewer **only through the handle** (`setSearches`,
`clearSearches`, `setSearchSettings`, `faceSearches`, `info`, `mode`), so
everything it does can be done without it. It makes no request of any kind.
Every query, label, result text and message goes in with `textContent`; styles
are set through `element.style`; it never draws text on a canvas.

## Functions

| Function | Returns | Notes |
|----------|---------|-------|
| `mount(parts, handle, options)` | panel | Called by the viewer (below). |
| `summaryText(search)` | string | The collapsed bar's text from `info().search`. |
| `usedText(search)` | string | What the searches used, for the provenance row. |
| `suggest(entries, typed)` | string[] | Suggestions for one typed line (below). |
| `noteText(search, ctx?)` | string | The note under the controls; `ctx`: `{ extraLines, refusal, focus }`. |
| `pairText(search, pair, sharedWord)` | string | One pair line from `info().search.pairs[i]`. |
| `resultMeta(q, result, distances)` | string[] | The meta parts of one result line. |
| `thousands(n)` | string | `1234567` to `"1,234,567"` (fixed, not the host's locale). |
| `COLOURS` | object | `{ dark, light, sharedDark, sharedLight }`: the default search colours. |

### `mount(parts, handle, options) -> panel`

- `parts`: `{ panel, stage, overlay, provenanceList, provenanceSummary }`, the
  viewer's elements.
- `handle`: the viewer's handle.
- `options`: `{ document, light, theme(), data() }`. `theme()` returns the
  viewer's current theme object (its colours as `[r, g, b]` in 0..1, and
  `light`), read on every update so a theme change restyles the panel;
  `data()` returns the set shown (or `null`), used for suggestions and for
  where results sit on the stage. Either may be absent or throw: the panel then
  uses the built-in palette for `light`, and offers no suggestions.

The returned panel:

| Member | Meaning |
|--------|---------|
| `update(search)` | Redraw from `info().search` (the viewer calls it on every change). |
| `drawOverlay(ctx, project, frame)` | Called once per frame after the viewer's overlay. Returns `false` when it drew nothing (no search, or the filter at 0.05 or less), else `true`. |
| `destroy()` | Removes the section, the stage label layer, the Focus list and layout, the provenance row and clause, and every listener. Safe to call twice. |
| `setOpen(open)`, `isOpen()` | Open or close the panel from code (the bar does the same). |

`frame` is `{ queries, filter, dpr, light, labels, mode, hidden(i) }`: each
shown search's raw query vector (`Float32Array(D)`, in letter order), the
filter value (0..1), the device pixel ratio, whether the viewer's labels are on,
the current mode id, and whether point `i` is hidden this frame (Focus's Only
results). `project(vector)` maps a `Float32Array(D)` to `{ x, y, scale, depth }`
in overlay (device) pixels.

On each frame the panel also notices a new or appended set (the viewer tells it
about searches, not data) and a mode change, and re-renders then.

### What it draws on the stage

- Per search: a link from the query to each result (alpha `filter * (0.25 +
  0.4 * rel)`, nearer results stronger), a 10 px ring at the query, and in
  Focus a crosshair inside the ring. Colours: `--tumbler-search-1..4`,
  resolved by the 2-D context itself (a value containing `url(`-like text,
  `image-set`, backslashes or `; { } < >` is not used).
- Labels, as spans in `div.tumbler-search-labels` (aria-hidden, after the
  overlay canvas): each query's letter (`A`, or `A query` in Focus), then each
  result's rank in Focus (`1`, or `A1` with several searches) or its text cut to
  28 characters in the other views when labels are on, then with Distance
  difference on each link's distance (3 decimals) at 62% (72% in Focus) of the
  way from the query.
- **Overlap**: labels are placed letters first, then nearest results first; a
  label whose box would overlap one already placed is left out. The lists carry
  every result, and the note says so. This is the simple answer to a tight
  cluster; there is no layout engine. The viewer's own labels (group names,
  hover) are not part of this check.

### Suggestions

`suggest(entries, typed)`: `entries` are `{ text, lower, words }` for the named
points of the set (deduplicated, white space collapsed); `typed` is the line the
caret is on. A text is suggested when it is not the line itself and either
starts with the whole line, or (when the line's last word has 2 or more
characters) one of its words starts with that last word. Whole-line matches come
first, at most 8 in all. Shown in every view whenever something is typed; a
click puts the full text on the current line and searches at once.

## DOM

```text
section.tumbler-search                  first child of div.tumbler-panel; aria-label "Search"
  button.tumbler-search-bar             aria-expanded, aria-controls -> the body's id
    b "Search", span.tumbler-search-summary, i.tumbler-search-mark (+ / −, aria-hidden)
  p.tumbler-search-live                 role=status, aria-live=polite, visually hidden: the summary
  div.tumbler-search-body               hidden (attribute and display) while collapsed
    label.tumbler-search-input-label + textarea.tumbler-search-input
    div.tumbler-search-suggest          role=group; span + button.tumbler-search-suggestion (data-index)
    div.tumbler-search-controls         button.tumbler-search-face, label.tumbler-search-lit (select),
                                        label.tumbler-search-rerank (only while offered),
                                        label.tumbler-search-candidates and
                                        label.tumbler-search-top (range + output, 3..100 and
                                        3..candidates; only while a reranker is offered),
                                        label.tumbler-search-distances, label.tumbler-search-k
                                        (range 3..100 + output; disabled with its reason as
                                        the title while reranking), label.tumbler-search-pov (select),
                                        label.tumbler-search-only (shown in Focus only),
                                        button.tumbler-search-clear
    p.tumbler-search-note
    div.tumbler-search-pairs            p.tumbler-search-pair: span.tumbler-search-shared-mark + text
    div.tumbler-search-results          details.tumbler-search-list (data-letter), closed until opened:
                                        summary + ol.tumbler-search-hits > li.tumbler-search-hit
                                        (span.tumbler-search-rank, span.tumbler-search-text,
                                        span.tumbler-search-meta, span.tumbler-search-gap)
div.tumbler-search-labels               in the stage, after canvas.tumbler-overlay, once a search is drawn
aside.tumbler-search-side               Focus only: after the stage; title, sub line, per search a
                                        letter line and an ol of results (same items as above)
dt.tumbler-search-provenance-term, dd.tumbler-search-provenance-value   the Search row (while active)
span.tumbler-search-provenance-clause   in the provenance summary (while active)
```

In Focus the viewer's root becomes a wrapping flex row (stage `flex: 999 1
600px`, the list `flex: 1 1 340px`, the panel a full row, a 16 px column gap),
so the list sits to the right of the stage when there is room (about 956 px)
and below it otherwise; its height is capped at the stage's and it scrolls.
Leaving Focus restores the root's display and removes the list. The results
under the stage are hidden in Focus (the list beside it carries them).

## Custom properties

| Property | Default | Sets |
|----------|---------|------|
| `--tumbler-search-1` .. `--tumbler-search-4` | `#ffc56b` `#6be0ff` `#ff8fb3` `#b6ff8a`; light stage `#a35f00` `#00708a` `#b0245a` `#3d7a00` | search A..D: ring, links, letters, ranks, list headings, gap bars |
| `--tumbler-shared` | `#ffffff`; light `#1b2130` | the shared mark in the pair lines |
| `--tumbler-search-bar-padding` | `10px 0` | `padding` of the bar |
| `--tumbler-search-title-size` | `24px` | size of the bar's "Search" |
| `--tumbler-search-side-gap` | `16px` | the gap between the stage and the list in Focus |

The bar measures 46 px with the defaults (Chromium, the standalone page, 1280
px and 390 px wide, two searches active).

## Tested

`js/test/search-panel.test.js` (node, the assembled file on the fake DOM) and
`tests/browser/test_search_panel.py` (Chromium).

## Candidates and top (the owner's request, 2026-11-14)

See `docs/search-interface.md`, "Candidates and top". In the panel:

- **Controls.** Results is a range from 3 to 100. Candidates (3 to 100) and
  Keep top (3 to the current candidates; its maximum follows) are ranges with
  their value beside them, placed right after the Reranker checkbox and, like
  it, absent from the row while no reranker is offered. Each drives
  `handle.setSearchSettings({ candidates })` / `({ top })`. While the reranker
  is on, Results is disabled and its title says "With the reranker on, Keep top
  sets how many results are kept."
- **What was used.** `usedText` states the counts the searches used: "the 50
  nearest as candidates, the reranker's top 20 kept" when a search was
  reranked, "the 8 nearest kept (8 results per search)" otherwise; a reranked
  search adds "(top 20 of 50 candidates)" from its own `results` and `sent`,
  and, when another search was reranked, a search that was not says "not
  reranked: the 8 nearest kept". The list heading and the Focus sub line say
  "then the reranker X (top 20 of 50 candidates)". A count cut to what there
  is (`counts` in `info().search`) is a sentence of the note, after the letter.
- **Long lists.** Each result list under the stage scrolls inside its own box:
  `max-height: var(--tumbler-search-list-height, 320px)` and `overflow-y:
  auto` (the Focus list beside the stage already scrolled). Stage labels keep
  the overlap rule; at most 160 label elements (`SP_LABEL_POOL`, was 96), and
  placing stops once they are used.
