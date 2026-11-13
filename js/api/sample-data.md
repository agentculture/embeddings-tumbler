# sample-data.js: the built-in sample set

An optional file, separate from the core so hosts that do not want a demo data
set do not carry it. Source: `js/sample/sample-data.js`. Shipped copy (kept
byte-identical by `tests/test_sample_data.py`; refresh it with
`python3 scripts/sync_sample.py`): `embeddings_tumbler/static/sample-data.js`.

Load it **after** the core file. In a browser it attaches
`EmbeddingsTumbler.sample`; under node it is the module's export. It is a
classic script with no dependencies and nothing from another origin.

## `sample.generate(options)`

Returns the in-memory form of the data contract (schema version 1), ready for
`update(data)` or `ET.contract.validate(data, null)`. Throws `RangeError` on a
bad option.

| Option | Default | Meaning |
|--------|---------|---------|
| `seed` | `20261113` (the reference's) | integer; also written to `provenance.seed` |
| `dimension` | `384` (the reference's) | integer, at least 8. This default is the one place 384 appears, as the documented default of the sample; the generator works at any dimension (tested at 384 and 1024) |
| `count` | `12288` (the reference's) | total points, at least 290 (the labelled ones) |

Also exported: `referenceSeed`, `referenceDimension`, `referenceCount`.

## The data

- `model`: `synthetic/reference-sample`, which cannot be mistaken for a real
  model. `text_included` is `true` (the labels are words).
- `provenance.synthetic` is `true`; `source`, `producer` and `limitations` say
  plainly that the vectors are generated, and that the month ring and the
  temperature arc are planted. `uncertain` is `[]`. No `endpoint`.
- `vectors`: one `Float32Array`, row-major, unit-length points centred on the
  cloud's mean (as the reference does).
- `points[i]`: `{id, label, group}`, ids `p00000`, `p00001`, ...
- Layout, in order: 9 regions of labelled words (216 points), 36 month points
  (group `months`, labels such as `January`, `mid-January`, `late January`),
  20 temperature words (group `temperature`): 290 labelled points in all.
  The rest, up to `count`, are unlabelled (`label` `""`): filaments and blobs in
  the nine regions, bridges between regions (grouped by the nearer end), more
  ring and arc points, and a faint unstructured halo, which has group `""`.
- Group names: `cooking`, `law`, `sport`, `code`, `money`, `ocean`,
  `astronomy`, `music`, `emotion`, `months`, `temperature`.

## Fidelity

The generator uses the reference's random source (mulberry32 plus a Gaussian
draw) and its draw order, so at the reference seed and 384 dimensions the
vectors are **bit-identical** to the reference's (`js/test/sample.test.js` cuts
the reference's generator out of the demo page, runs it in `node:vm` and
compares bytes). The reference's per-point colour weights are not part of the
contract and are not output, but their random draws are still made so the
stream stays aligned.

## Honesty note

The month ring in this sample is **invented**: the generator plants it. A real
one was measured: Qwen3-Embedding-0.6B lays the twelve months out in calendar
order around a plane (see `docs/evidence/2026-11-13-real-vector-probe.md`).
Real model output is noisier and less tidy than this set.
