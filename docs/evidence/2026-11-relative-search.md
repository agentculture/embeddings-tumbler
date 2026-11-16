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
    --search Rice --search Jazz --search Volcano

# the second model: embed the committed corpus through the gateway, then measure
grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- \
    python3 scripts/build_demo_set.py --model Qwen/Qwen3-Embedding-0.6B \
    --out-dir .local/relative-evidence --name wikipedia-qwen3 --apply
python3 scripts/measure_relative.py .local/relative-evidence/wikipedia-qwen3.json \
    --search Rice --search Jazz --search Volcano
```

The measurement script uses a seeded start (seed 7) for its direction fit, reads local
files only and sends nothing anywhere.
