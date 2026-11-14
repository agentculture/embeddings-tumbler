# Search on real data, measured (2026-11-14)

This is the record for plan task `t14` of
`docs/plans/2026-11-14-search-in-the-embedding-viewer.md`. It says what search
did on real vectors, with typed text embedded by the file's own model through
the real gateway, and what was not measured.

The script is `docs/evidence/real_search_browser.py`. Its docstring gives the
command. The gateway address and key were read only by the helper process
(`viewer serve --embed`), which got them from its environment through
`grant run --inject`. They were never printed or written.

## Setup

- **Viewer:** the build branch at commit `a838790` (version 0.12.0), the
  standalone page served by the real `viewer serve --embed` on loopback.
- **Data:** 10,000 real texts, every one of them named. 152 passages from
  `embeddings-cli`'s documents, 39 probe words (12 months, 7 weekdays, 20
  temperature words) and 9,809 paragraphs of Python 3.12 standard-library
  docstrings (public text), in 172 groups.
- **Not the corpus of the earlier proof.** That corpus was lost when the
  machine was reset on 2026-11-14 and was rebuilt for this run. The 120 probe
  sentences of the earlier proof are not in it, so numbers here are not
  comparable point for point with `2026-11-14-real-atlas-proof.md`.
- **Models:** `Qwen/Qwen3-Embedding-0.6B` (1,024 dimensions) and
  `google/embeddinggemma-2` (768 dimensions), surveyed with `embeddings survey`
  and exported with `embeddings export` (`embeddings-cli` 0.9.1), text
  included, no reduction. Two more exports of the first model: `--rotate` and
  `--top-k 64`.
- **Machine:** AMD Ryzen 5 7640HS with Radeon 760M graphics, Linux. Headless
  Chromium (Playwright), 1,280 by 800 window.
- **Renderers:** the GPU (ANGLE on Vulkan, Radeon 760M) and SwiftShader
  (software).
- **Queries:** six typed texts: "a cold winter morning", "reading a file from
  disk", "parsing command line arguments", "the days of the week", "sending an
  email message", "threads and locks". No query prefix was set.

## 1. Typed text lights its true nearest neighbours

For each query the page's own embed callback sent the text to the helper, and
the viewer's eight results were compared with a ranking computed separately in
Python (numpy, cosine distance over the named points, from the same vector
block and the vector the helper returned for the same text).

| Model | Queries | Same ids in the same order | Largest distance difference |
|-------|---------|----------------------------|-----------------------------|
| Qwen3-Embedding-0.6B | 6 | 6 of 6 | 2.6e-15 |
| EmbeddingGemma 2 | 6 | 6 of 6 | 2.6e-9 |

First results, as examples: "a cold winter morning" gave frosty, cold,
January, November with the first model and cold, lukewarm, warm with the
second. "the days of the week" gave weekday docstrings, then Sunday and Monday.

The second model's larger difference was not investigated. It is far below
any difference that could change an order here.

## 2. Time to the first lit frame

With a query vector already in hand, the time from `setSearches([{ vector }])`
to the first animation frame in which `info().search` reports the lit set, five
times each. The target is 1 second.

| Model | Renderer | Milliseconds |
|-------|----------|--------------|
| Qwen3-Embedding-0.6B | GPU | 40.9, 24.7, 38.1, 38.6, 39.1 |
| EmbeddingGemma 2 | GPU | 37.2, 36.9, 35.8, 34.8, 36.3 |
| Qwen3-Embedding-0.6B | SwiftShader | 35.4, 22.6, 24.7, 24.3, 23.7 |

**Met:** every run is under 60 ms. This is the time `info()` reports the lit
set, checked once per frame. It was not confirmed from pixels that the same
frame was already drawn lit.

## 3. Frame rate with four searches active

Four point searches at once (one in Focus, which holds one search), frames
counted by the viewer over 10 seconds, after 2 seconds to settle. The target is
30 frames per second.

| Model | Renderer | Tumble | Lattice | Wander | Focus |
|-------|----------|--------|---------|--------|-------|
| Qwen3-Embedding-0.6B | GPU | 59.9 | 60.0 | 59.9 | 60.0 |
| EmbeddingGemma 2 | GPU | 60.1 | 60.1 | 59.9 | 60.1 |
| Qwen3-Embedding-0.6B | SwiftShader | 13.3 | 11.6 | 13.4 | 16.3 |

**Met on the GPU**, where the display's 60 frames per second is the ceiling.
**Missed on software rendering:** 11.6 to 16.3 frames per second. Software
rendering is what CI uses and is not a device a person would watch on, but it
is a miss and is recorded as one.

## 4. Reduced files

| File | Embedding search | Words search among loaded points |
|------|------------------|----------------------------------|
| Rotated (`--rotate`) | refused, `reduction-not-searchable` | works, 8 points lit |
| Top 64 (`--top-k 64`) | refused, `reduction-not-searchable` | works, 8 points lit |

The message begins: "Cannot search by embedding: the vectors in this data set
were changed after embedding (reduction "rotation"), and the file does not
carry what is needed to change a query the same way." A plain typed search on
these files falls back to words and carries that message as its note.

## 5. Requests and errors

In every run: no request to another origin, and no console error. That no
response carries the gateway key or address is proved with planted values in
`tests/browser/test_search_forms.py`, not here.

## A finding: the model's name must match exactly

The first attempt with the second model was refused for every query with
`query-model-mismatch`. The data file had been surveyed under the gateway's
lane name, `gemma2-embed`, and `embeddings-cli` recorded that name. The gateway
answers an embedding request with the model's own name,
`google/embeddinggemma-2`, and the helper reports the name the gateway answers
with. The two names differ, so the viewer refused, as its one-model rule says
it must.

The file was surveyed again under `google/embeddinggemma-2` and the search then
worked, as recorded above. Nothing in the viewer was changed. A producer that
records an alias makes a file that cannot be searched by embedding; the
producer guide should say to record the name the service answers with.

## What was not measured

- A phone, WebKit or Firefox. Only Chromium on one desktop machine.
- The reranker on real data in this run (it was verified by hand on a smaller
  file earlier in the build, with `Qwen/Qwen3-Reranker-0.6B`).
- A query prefix. Qwen3 embedding models are usually given an instruction for
  queries; none was set, so retrieval quality with one is unknown.
- Whether the results are good answers. The check is that the viewer shows the
  true nearest neighbours of the vector it was given, not that the model put
  the right texts nearby.
- The time the gateway takes to embed a query (it is outside the viewer). All
  six searches and their checks took about 2.5 seconds together.
- Search on a file larger than 10,000 points.
- Frame rate while a search is being computed, as opposed to after it is lit.
- The point of view, Lit choices other than the default, and Candidates above
  the defaults.
