# Real-Atlas proof, 2026-11-14

The first run of the viewer on real vectors (plan task `t16`). Everything
before this was built and tested on the built-in synthetic sample set. This
document records what was measured, what was seen, what was not seen, and what
was changed because of it. A missed target is recorded as missed.

## Summary

| Target | Result | Verdict |
|--------|--------|---------|
| Tumble mean group separation at least 1.3, against a random baseline near 1.11 | 1.519 against 1.114 on the 311-text Atlas | met |
| The same on the 10,000-text Atlas (not a plan target; a different grouping) | 1.286 against 1.089 | below 1.3 |
| At least 30 frames per second with 10,000 real 1024-d points | 60.0 / 60.0 / 60.1 (Tumble / Lattice / Wander), capped by the display rate | met on a GPU; 13 without one |
| Zero requests to another origin, all three forms | 0 of 20 requests | met |
| The gateway key in no file, log or page | 0 of 10,586 files scanned | met |
| Structures visible in motion that the 2-D map hides | mixed, see "Against the 2-D map" | stated below |

Three things were found that the sample set had hidden:

1. **Lattice shows no grouping on real vectors** (1.126, the same as a random
   frame). Not changed. A decision for the owner; see "Findings".
2. **A large real set burned out to a white ball.** Fixed in this task.
3. **The first producer wrote no groups**, so a real view was one colour and
   carried no group names. Fixed in `embeddings-cli` (`--group-by`).

## What was run

- **Model:** `Qwen/Qwen3-Embedding-0.6B`, 1024-d, embedded live through the
  lobes gateway with `embeddings survey`. The key was injected with
  `grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- ...`; it was
  never printed or written.
- **Small Atlas, 311 texts.** The corpus of the
  [2026-11-13 probe](2026-11-13-real-vector-probe.md): 152 passages from
  `embeddings-cli`'s documents, 120 probe sentences, the 12 months, the 7
  weekdays and 20 temperature words. 15 groups (source document or probe
  kind). Embedded in 3.0 s.
- **Large Atlas, 10,000 texts.** The 311 plus 9,689 paragraphs of Python
  3.12 standard-library docstrings (public text), grouped by top-level
  module: 191 groups, 102 of them with at least 20 points. Embedded in 84 s
  (9,689 live, 311 from the embed cache).
- **Data files:** written by `embeddings export` (the verb built in task
  `t15`, `embeddings-cli` 0.9.0 at commit `1fb4516`, not yet merged there),
  with `--endpoint-name "lobes gateway"`, text included, no reduction. The
  large pair is 1.8 MB of JSON and 41.0 MB of float32.
- **Viewer:** the assembled core file, version 0.10.1 plus the brightness
  change described below.
- **Machine:** AMD Ryzen 5 7640HS with Radeon 760M graphics, Linux. Headless
  Chromium 158 (Playwright), 1280 x 800 window.

The Atlases and data files are not committed (41 MB, and reproducible).

### Reproducing

```bash
# 1. Survey and export, from an embeddings-cli checkout that has `embeddings export`
grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- \
  uv run embeddings survey corpus.jsonl --atlas atlas --apply
uv run embeddings export --atlas atlas --out site/atlas.json \
  --endpoint-name "lobes gateway" --apply

# 2. Group separation, from this repository (no browser, no network)
node docs/evidence/real_atlas_separation.js site/atlas.json --group-key group --map-compare
node docs/evidence/real_atlas_separation.js site/atlas.json --group-key group --mode lattice

# 3. The three forms and the frame rate
TUMBLER_BROWSER_RENDERER=gpu uv run python docs/evidence/real_atlas_browser.py \
  site/atlas.json --large site/atlas-10000.json
```

Each corpus line carried a `group` key. `embeddings survey` keeps it as record
metadata and `embeddings export` copies metadata but writes no `group` field,
so the separation script reads groups with `--group-key group`.

## Group separation

Separation is the mean distance between points of different groups divided by
the mean distance between points of the same group (`ET.math.groupSeparation`).
1.0 means no visible grouping. The script measures the frames the shipped mode
answers (`stateAt(t)` of the assembled core file), every 0.5 s over 120 s of
mode time, for seeds 1 to 5.

Small Atlas, 311 points, 15 groups:

| View | Separation |
|------|------------|
| Full 1024-d space | 1.117 |
| Random 3-D frames, mean of 300 (5th to 95th percentile 1.032 to 1.205) | 1.114 |
| **Tumble, mean of 1,205 frames** (5th to 95th percentile 1.260 to 1.813) | **1.519** |
| Tumble per seed (1 to 5) | 1.577, 1.456, 1.436, 1.496, 1.628 |
| Tumble frames at or above 1.3 | 91% |
| Lattice, mean of 1,205 frames (5th to 95th percentile 1.052 to 1.222) | 1.126 |
| 2-D map (two leading principal components) | 1.948 |

The full-space and random-frame numbers reproduce the probe (1.117 and 1.110).
**Tumble meets the 1.3 target** on the set the target was defined on.

Large Atlas, 10,000 points; measured on a seeded subset of 1,500 points (1,385
of them in the 102 groups of at least 20), tour fitted on all 10,000, seeds 1
to 3, every 1 s over 120 s:

| View | Separation |
|------|------------|
| Full 1024-d space | 1.089 |
| Random 3-D frames, mean of 300 (5th to 95th percentile 1.060 to 1.120) | 1.089 |
| **Tumble, mean of 363 frames** (5th to 95th percentile 1.228 to 1.352) | **1.286** |
| Tumble frames at or above 1.3 | 35% |

On this set Tumble is **below 1.3**. It is well clear of the random baseline
(every measured frame is above the baseline's 95th percentile), but 102 groups
of library documentation are weaker groups than 15 source documents, and eight
directions hold 18.9% of the variance here against 34.0% on the small set. The
1.3 target was set against the small set's baseline; this row is recorded so
nobody reads 1.3 as a property of the mode.

## Frame rate

The standalone page on the large file (`index.html?data=atlas-10000.json`),
frames counted by the viewer (`info().frames`) over 10 s per mode, after the
mode reported ready and 2 s to settle:

| Renderer | Tumble | Lattice | Wander | Page open to first ready | Longest frame of script work |
|----------|--------|---------|--------|--------------------------|------------------------------|
| AMD Radeon 760M (ANGLE, Vulkan) | 60.0 | 60.0 | 60.1 | 2.7 s | 12.3 ms |
| SwiftShader (software, no GPU; 6 s per mode) | 13.1 | 12.7 | 13.0 | 20.8 s | 23.6 ms |

**The 30 frames-per-second target is met on the GPU.** 60 is the display rate,
so the headroom above it is not measured. Without a GPU the page runs at 13
frames per second and takes 21 s to be ready; that is below the target and is
the cost of 10,000 x 1024 numbers per frame on a CPU.

This was measured in headless Chromium on the development machine. **Not
measured:** the real file on screen on the owner's devices. The owner's own
observations so far are of the sample set (12,288 synthetic points, 384-d), in
their words: desktop Chrome "near 60 framerate (55-59?)" on an ARM board,
iPhone 13 "around 35-40 fps on safari, 60 on chrome". They are the owner's, not
measurements of this run.

## Network

Each of the three forms was served from loopback with
`Content-Security-Policy: default-src 'self'`, on the guide's own example hosts
(`docs/guides/examples/`), showing the small Atlas, visiting all three modes:

| Form | Requests | To another origin | Console errors | Policy violations |
|------|----------|-------------------|----------------|-------------------|
| Script | 6 | 0 | 0 | 0 |
| Web component | 7 | 0 | 0 | 0 |
| Standalone page | 7 | 0 | 0 | 0 |

The requests are the page, its own script and style files, the core file and
the data pair, nothing else. The large-file run also made no request to
another origin. The same result under SwiftShader.

## The key and the address

- A scan for the key's value (read from the environment under `grant run`,
  counts printed, never the value) over every file this run produced, both
  repositories' working trees and the embed cache: **10,586 files, none
  containing the key.**
- The served folder contains neither the gateway's address nor its host name.
  The Atlas manifest (`atlas.json`, not served) does record the endpoint
  address, as `embeddings survey` always has; `embeddings export` did not copy
  it, and wrote `provenance.endpoint: "lobes gateway"`.
- One thing the export does carry: `provenance.params.corpus` is the absolute
  local path of the corpus file. It is not a secret here, but a path from the
  producer's machine reached every page that loaded the file. Fixed in
  `embeddings-cli` after this run: only the file's name is written.

## Against the 2-D map

`embeddings map` draws the two leading principal components. For every pair of
the 15 groups (105 pairs) the script computes a gap: the distance between the
two group centres divided by the mean of their spreads, in the picture. Below
1 the two overlap; at 2 or more they stand clearly apart.

| | 2-D map | Tumble (any of 1,205 frames) |
|---|---|---|
| Overall separation | 1.948 | mean 1.519 |
| Pairs clearly apart (gap at least 2) | 64 | 81 |
| Pairs overlapping in the map (gap below 1) | 18 | 13 of the 18 reach a gap above 1 in some frame; 2 reach 2 |

Stated plainly:

- **The map is the better single picture.** Its overall separation (1.948) is
  higher than Tumble's average frame (1.519). It is the two strongest
  directions held still; a tour spends most of its time elsewhere.
- **Motion adds pairs the map never separates.** 17 more pairs of groups stand
  clearly apart in at least one Tumble frame than in the map (81 against 64).
- **For the pairs the map merges, the gain is small and brief.** Of the 18
  overlapping pairs, 2 become clearly apart, and only for a moment (under 1% of
  frames): `CHANGELOG.md` against the value probes, and `CLAUDE.md` against the
  measurement design note. Five pairs stay overlapping in every frame,
  including the value probes against the negation probes, which no linear
  picture measured here pulls apart.
- **Lattice adds what neither picture has:** wires between true nearest
  neighbours measured in the full space (666 wires on the small set). The
  probe found that only 15% to 30% of true neighbours are neighbours in a 3-D
  or 2-D picture.
- **Wander reads well on real text.** Each stop shows the passage and its
  nearest passages by their text; on the large set a stop on an `enum`
  docstring was surrounded by other `enum` docstrings.

**Not examined:** whether the month and weekday rings the probe found are
visible in motion inside the mixed corpus. No structure was identified by eye
that the numbers above do not already describe, and with no groups in the file
the picture is a single colour, which makes identifying one by eye unlikely.

## Findings

### 1. Lattice shows no grouping on real vectors (open)

Lattice swaps one visible axis at a time for a hidden direction drawn from the
full space, as the reference does. On real 1024-d vectors a direction drawn
from the full space holds about a thousandth of the variance, so after three
swaps (about 10 s) the picture is a random frame: separation 1.126 against the
random baseline of 1.114, and no frame of 1,205 reached 1.3. While an axis is
mid-swap the cloud also flattens to a disc. The wires stay correct throughout;
it is the points that stop showing structure.

This is the same thing the probe found for Tumble, which is why Tumble became
a guided tour. The mathematics module already supports the remedy
(`makeSwapTour` takes a `basis`, so hidden directions can be drawn from the
strongest directions). It was **not** applied here: the plan ports Lattice from
the reference, and changing what the mode shows is the owner's decision.

### 2. A large real set burned out to a white ball (fixed)

A point with a text label is drawn at full weight and brightened. The sample
set has 290 such points among 12,288. A real data file has a label on every
point, so 10,000 full-weight points piled into a featureless white ball in
Tumble and Lattice.

Changed in `js/src/50-viewer.js`: the overall brightness now falls as the
number of bright points rises above 600, by `600 / n`, so the total light
stays about constant. Sets with up
to 600 bright points, the sample set among them, are drawn exactly as before.
With the change the 10,000-point Tumble view shows density and texture. Lattice
on the large set is still too bright in the middle while an axis is mid-swap
(finding 1 makes the cloud flat and dense there). The constants were chosen by
eye on one set; they are a first setting, not a tuned one.

### 3. The first producer wrote no groups (fixed in `embeddings-cli`)

`embeddings export` wrote no `group`. The viewer colours and names by group,
so a real Atlas was drawn in one colour with no group names, in every mode.
Fixed at the producer after this run, with the owner's approval (deviation
`d4`): `embeddings export --group-by <key>` writes each point's group from a
metadata key. The contract and the viewer needed no change. With groups the
small set shows its 15 groups in colour with their names; on the large set
191 groups are too many hues to tell apart, and the group names drawn crowd
the centre. The measurements above were taken on the files without groups;
groups do not change a frame or a vector.

### 4. Smaller notes

- A whole passage as a label works: the viewer shortens it where it is shown
  (Wander's stops and status line).
- Lattice wires 2,151 pairs on the large set (its limit on wired points), not
  all 10,000 points.
- On software rendering Lattice was still measuring neighbours ("measuring
  62%") when its 8 s window ended; it draws meanwhile.

## Limits of this proof

- One model, two corpora, one machine, one browser engine (Chromium). Firefox
  and Safari were not run on the real file.
- The groups are source documents, probe kinds and library modules, not a
  ground truth of meaning. Separation numbers are comparative.
- The large set's separation is measured on a 1,500-point subset.
- Live embedding on a GPU is not bit-deterministic; a rerun reproduces the
  pattern, not every digit.
- The frame rate is from a headless browser; the display cap hides headroom.
