# What relative search sees on real vectors, two models

Measured on 2026-11-16 for the spec
`docs/specs/2026-11-16-relative-search-in-the-embedding-viewer.md` (its why-it-matters
claim c5 and honesty condition h4). Every figure below is printed by
`scripts/measure_relative.py`; the raw output is in `docs/evidence/data/`.

## The two sets

Both are the same 999 texts, the committed corpus `data/wikipedia-vital-3/corpus.jsonl`
(Wikipedia's Level 3 vital articles, first sentences of each introduction, CC BY-SA 4.0).
Only the model differs.

| | Demo set | Second model |
|---|---|---|
| Model | `google/embeddinggemma-2` | `Qwen/Qwen3-Embedding-0.6B` |
| Dimension | 768 | 1024 |
| Pair | `embeddings_tumbler/static/demo-wikipedia.json` (committed) | `.local/relative-evidence/wikipedia-qwen3.json` (not committed; made as below) |
| Raw measurements | `docs/evidence/data/2026-11-relative-gemma.json` | `docs/evidence/data/2026-11-relative-qwen3.json` |

## What was measured

| Figure | `embeddinggemma-2` | `Qwen3-Embedding-0.6B` |
|---|---|---|
| Vector lengths | 1.0000 to 1.0000 | 1.0000 to 1.0000 |
| Length of the mean vector | 0.793 | 0.491 |
| Share of the spread in the 8 strongest directions | 18.1% | 17.8% |
| Cosine to *Rice*: lowest, median, highest | 0.530, 0.633, 0.839 | 0.105, 0.241, 0.717 |
| Cosine to *Jazz*: lowest, median, highest | 0.546, 0.627, 0.778 | 0.075, 0.215, 0.655 |
| Cosine to *Volcano*: lowest, median, highest | 0.550, 0.656, 0.788 | 0.049, 0.232, 0.455 |
| Share of the remainder in its 8 strongest directions (each of the three searches) | 18.1% | 17.7% to 17.8% |

The nearest articles agree in kind across the two models. For *Rice*:
`embeddinggemma-2` gives Cereal 0.839, Wheat 0.816, Maize 0.757, Bean 0.754, Bread 0.738;
`Qwen3-Embedding-0.6B` gives Cereal 0.717, Wheat 0.696, Maize 0.553, Bread 0.510,
Bean 0.492.

## What it means for the view

- **Both models give unit-length vectors**, so on both, height along the search is
  cosine similarity.
- **How narrow the cone is depends on the model.** `embeddinggemma-2` keeps every
  article within cosine 0.53 to 0.84 of any other, with a mean vector 0.79 from the
  origin. `Qwen3-Embedding-0.6B` spreads them from about 0.05 to 0.72, with a mean
  vector 0.49 from the origin. The statement "real sets sit in a narrow cone" holds
  for `embeddinggemma-2` and is weaker for `Qwen3-Embedding-0.6B`. A guide may say that
  sets lean away from the origin (true for both); it may give the 0.52 to 0.84 band
  only as the demo model's.
- **The ruler's window must come from the data**, as requirement c31 says. A window
  fixed at 0.5 to 1.0 would fit the demo set and cut off most of the second model's
  points.
- **The tumbling axes show about 18% of what remains on both models**, the same share
  the plain tour's 8 directions hold of the whole set. Removing the search direction
  costs almost nothing.
- **Typed text behaves like an article used as a search** on `embeddinggemma-2`
  (probed through the gateway, plain query form): "rice", "a grain that feeds half the
  world" and "how do volcanoes form?" came back with length 1.0, highest cosines 0.80
  to 0.83 and lowest 0.53 to 0.57. This probe was not repeated on the second model.

## The free axes reuse the plain fit (deviation d4, 2026-11-17)

**Why it changed.** Turning Relative on, and every new search, used to fit the
strongest directions of the remainder (the centred set with the search directions
removed): a second fit as heavy as the one the page makes when it loads. On the
owner's iPhone the switch took more than 30 seconds with nothing shown. On a CPU
slowed eight times it took 10.8 s, about the page's own first fit (11.2 s). Since
task t18 the free axes tour the set's strongest directions, the ones the plain tour
already found, with the search directions removed; the full fit of the remainder is
kept only as a fallback. The owner approved the change on 2026-11-17.

**What it costs in share.** The share of the remainder's variance held by the 8
toured directions, full fit of the remainder against the plain directions with the
search removed.

Measured in node on the viewer's own code (`ET.math.relativeFit` without and with
`plain`, seed 7; the plain directions from `ET.math.principalDirections` on the
centred set, seed 7). The coordinating agent measured these before the change with
a throwaway script; t18 measured them again on the built code and got the same
figures to four places:

| Search | Demo set, full | Demo set, reused | Second model, full | Second model, reused |
|---|---|---|---|---|
| Rice | 0.1819 | 0.1819 | 0.1773 | 0.1772 |
| Jazz | 0.1817 | 0.1816 | 0.1779 | 0.1778 |
| Volcano | 0.1812 | 0.1812 | 0.1776 | 0.1775 |
| Rice and Wheat | 0.1800 | 0.1799 | 0.1742 | 0.1740 |

The reused directions hold 99.87 to 99.98 percent of the full fit's share in these
eight cases (t18's run).

Printed by `scripts/measure_relative.py` (t18's run; its own fit is a fixed 14
iterations from a seeded start, so its full-fit figures sit slightly below node's
converged ones and the reused share can come out above the full one):

| Search | Demo set, full | Demo set, reused | Second model, full | Second model, reused |
|---|---|---|---|---|
| Rice | 0.1812 | 0.1809 (99.85%) | 0.1771 | 0.1770 (99.93%) |
| Jazz | 0.1813 | 0.1807 (99.69%) | 0.1777 | 0.1776 (99.94%) |
| Volcano | 0.1806 | 0.1803 (99.82%) | 0.1773 | 0.1774 (100.02%) |
| Rice+Wheat | 0.1798 | 0.1790 (99.57%) | 0.1740 | 0.1738 (99.87%) |

All 8 plain directions survived the removal in every case.

**What it saves in work.** Multiply-adds counted by the stepper (`work`) for one
preparation, and wall time of `step()` to the end, node 24 on the development
machine (t18's run; times vary with the machine's other load):

| Set | Full fit | Reused | Ratio (work) | Time, full | Time, reused |
|---|---|---|---|---|---|
| Demo set, 999 x 768, one search | 444.8 to 470.0 million | 12.4 million | 36 to 38 | 230 to 231 ms | 12 to 16 ms |
| Demo set, Rice and Wheat | 450.9 million | 15.5 million | 29 | 224 ms | 15 ms |
| Second model, 999 x 1,024, one search | 826.5 to 843.3 million | 16.6 million | 50 to 51 | 696 to 715 ms | 15 ms |
| Second model, Rice and Wheat | 868.2 million | 20.7 million | 42 | 740 ms | 19 ms |
| Test fixture `wikipedia-subset`, 173 x 768, Rice | 28.4 million | 2.3 million | 12.4 | | |
| Test fixture, Rice and Wheat | 30.2 million | 2.8 million | 10.6 | | |

The coordinating agent's timing before the change, with its throwaway script: 220 to
230 ms against 7 to 14 ms on the demo set, 680 to 720 ms against 9 to 18 ms on the
second model. The slowed-CPU and iPhone figures above are the coordinating agent's
and the owner's, also from before the change; the switch was not timed again on a
slowed CPU or a phone after it. `js/test/math-relative.test.js` asserts that the
reused preparation on the test fixture counts more than 6 times fewer multiply-adds
than the full one.

**What stays exact.** The pinned rows are still exactly the search directions, the
free rows are orthogonal to them, and the share shown is still the exact share of
the remainder's variance held by the directions that tour (recomputed independently
to 1e-9 in the tests); only which directions tour changed.

## Not measured

No real set whose vectors are not of unit length was available. The fixture
`tests/fixtures/relative/mixed-length` (below) stands in for one in tests; it is not
evidence about any model.

## The test fixtures

`scripts/gen_relative_fixtures.py` writes two pairs to `tests/fixtures/relative/`,
173 items each (every "Everyday life" article and every eighth other one):

- `wikipedia-subset`: the demo set's vectors, unchanged.
- `mixed-length`: the same vectors, each multiplied by its text's length in characters
  divided by the longest text's. Lengths run from 0.354 to 1.000. For the search *Rice*
  the nearest item by cosine is not the item highest along the search direction, which
  is what the wording tests need. The directions are the model's; the lengths are not
  model output, and its provenance says so.

`tests/test_relative_fixtures.py` checks these properties.

## How to reproduce

```bash
# the demo model, from committed data
python3 scripts/measure_relative.py embeddings_tumbler/static/demo-wikipedia.json \
    --search Rice --search Jazz --search Volcano --search Rice+Wheat

# the second model: embed the committed corpus through the gateway, then measure
grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- \
    python3 scripts/build_demo_set.py --model Qwen/Qwen3-Embedding-0.6B \
    --out-dir .local/relative-evidence --name wikipedia-qwen3 --apply
python3 scripts/measure_relative.py .local/relative-evidence/wikipedia-qwen3.json \
    --search Rice --search Jazz --search Volcano --search Rice+Wheat
```

The measurement script uses a seeded start (seed 7) for its direction fit, reads local
files only and sends nothing anywhere.
