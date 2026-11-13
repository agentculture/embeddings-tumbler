# Real-vector probe, 2026-11-13

A small probe run during the challenge pass, to check the reference demo's
assumptions against a real embedding model before any code was planned. The
demo's data is synthetic; this is the first look at real vectors.

## What was run

- **Model:** `Qwen/Qwen3-Embedding-0.6B`, embedded live through the lobes
  gateway. The key was injected with
  `grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- ...` and was
  never printed or written.
- **Corpus:** 311 texts. 152 passages from `embeddings-cli`'s own documents
  (`docs/evidence/corpus.jsonl`), 120 probe sentences
  (`docs/studies/probe-corpus.jsonl`), the 12 months, the 7 weekdays, and 20
  temperature words from "frozen" to "blazing".
- **Script:** `docs/evidence/real_vector_probe.py`. It imports
  `embeddings.backends.client`, so it runs from an `embeddings-cli` checkout:

  ```bash
  cd ../embeddings-cli
  grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- \
    uv run python ../embeddings-tumbler/docs/evidence/real_vector_probe.py "$PWD"
  ```

  It writes `vectors.npy` and `groups.json` beside itself; those outputs are
  not committed.

## Results

| Measure | Value |
|---------|-------|
| Points × dimension | 311 × 1024 |
| Time to embed | 3.6 s |
| Mean raw cosine between all pairs | 0.385 (min 0.019, max 0.996) |
| Variance held by top 1 / 3 / 10 / 50 principal directions | 8.8% / 19.1% / 37.9% / 73.9% |
| Participation ratio (effective dimensionality) | 43.7 |
| Raw float32 size | 1.27 MB (about 3.3 MB as JSON decimal text) |

**Group separation** (mean distance between groups divided by mean distance
within groups; 1.0 means no visible grouping; groups are the source document
or probe kind):

| View | Separation |
|------|------------|
| Full 1024-d space | 1.117 |
| Random 3-D frames, mean of 300 (5th–95th percentile 1.030–1.206) | 1.110 |
| Random 3-D frame inside the top 32 principal directions | 1.191 |
| Random 3-D frame inside the top 16 principal directions | 1.288 |
| Random 3-D frame inside the top 8 principal directions | 1.479 |
| PCA top 3 | 1.902 |

**Shapes:**

| Words | Finding |
|-------|---------|
| 12 months | In calendar order around a plane: 12 of 12 neighbours in order. That plane holds 44% of their variance (top 3 directions: 55%). Radius variation 0.21. |
| 7 weekdays | In calendar order around a plane: 7 of 7. That plane holds 56% (top 3: 72%). Radius variation 0.08. |
| 20 temperature words | Loosely ordered along their first principal axis: rank correlation 0.56 with the cold-to-hot order. |

**Neighbours:** of each point's three true nearest neighbours, 15% are also its
nearest in a random 3-D picture and 30% in PCA top 3.

## What it changed

- **Tumble must be a guided tour.** A uniformly random frame in 1024-d shows
  no more grouping than chance. The demo's random tour only works because its
  synthetic regions were generated tight. (Spec requirement on the guided
  tour; plan task `t4`.)
- **The dimension is not 384.** The demo hard-codes it. (Spec requirement on
  dimension; plan task `t6`.)
- **Vectors must be binary.** JSON numbers are about 2.6 times the raw size.
  (Spec requirement on the vector block; plan tasks `t2`, `t5`, `t15`.)
- **Lattice is justified.** Most true neighbours are not neighbours in any
  single 3-D picture, so drawing the true ones adds real information.
- **The ring is real.** The demo's month ring was invented, but this model
  does lay the months and the weekdays out as rings in calendar order. The
  temperature arc is much weaker than the demo suggests.

## Limits of this probe

- One model, 311 texts, one run. Nothing here is established for other models,
  larger corpora, or image embeddings.
- The grouping labels are source documents and probe kinds, not a ground truth
  of meaning; the separation numbers are comparative, not absolute.
- The month and weekday planes were fitted to those words alone. Whether the
  rings stay visible inside a large mixed corpus is untested.
- Live embedding on a GPU is not bit-deterministic; rerunning will reproduce
  the pattern, not every digit.
