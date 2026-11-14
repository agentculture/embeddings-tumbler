#!/usr/bin/env node
"use strict";
// Real-Atlas proof (plan task t16): how well does Tumble's guided tour separate the
// groups of a real data file, compared with uniformly random 3-D frames?
//
//   node docs/evidence/real_atlas_separation.js <data.json> [options]
//
//   --group-key <key>   take each point's group from metadata[<key>] when the point has
//                       no `group` of its own (embeddings-cli's export writes none)
//   --seeds 1,2,3       tour seeds to average over (default 1,2,3,4,5)
//   --seconds 120       mode time covered per seed (default 120)
//   --step 0.5          seconds between measured frames (default 0.5)
//   --random 300        number of random frames in the baseline (default 300)
//   --sample 0          measure on a seeded subset of this many points (0 = all);
//                       the tour is always fitted on every point
//   --min-group 2       ignore groups with fewer points than this
//   --mode tumble       the mode whose frames are measured (tumble, lattice or wander)
//   --map-compare       also compare, pair of groups by pair, the 2-D map (the two
//                       leading principal components, what `embeddings map` draws)
//                       with the mode's frames; see pairGap below
//   --json              print one JSON object instead of text
//
// Separation is ET.math.groupSeparation: mean distance between points of different
// groups divided by mean distance between points of the same group. 1.0 means no
// visible grouping. The frames measured are the ones the shipped Tumble mode answers
// (ET.modes "tumble", stateAt(t)) from the assembled core file, not a reimplementation.
// Reads two local files, writes nothing, makes no network request.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const Lib = require(path.join(ROOT, "embeddings_tumbler", "static", "embeddings-tumbler.js"));
const ET = Lib._internal;

function parseArgs(argv) {
  const o = { seeds: [1, 2, 3, 4, 5], seconds: 120, step: 0.5, random: 300, sample: 0, minGroup: 2, mode: "tumble", json: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--map-compare") o.mapCompare = true;
    else if (a === "--group-key") o.groupKey = argv[++i];
    else if (a === "--seeds") o.seeds = argv[++i].split(",").map(Number);
    else if (a === "--seconds") o.seconds = Number(argv[++i]);
    else if (a === "--step") o.step = Number(argv[++i]);
    else if (a === "--random") o.random = Number(argv[++i]);
    else if (a === "--sample") o.sample = Number(argv[++i]);
    else if (a === "--min-group") o.minGroup = Number(argv[++i]);
    else if (a === "--mode") o.mode = argv[++i];
    else rest.push(a);
  }
  if (rest.length !== 1) {
    process.stderr.write("usage: node docs/evidence/real_atlas_separation.js <data.json> [options]\n");
    process.exit(1);
  }
  o.file = rest[0];
  return o;
}

function load(file) {
  const records = JSON.parse(fs.readFileSync(file, "utf8"));
  const name = records.vectors?.file;
  if (typeof name !== "string" || name !== path.basename(name)) throw new Error("vectors.file must be a plain file name");
  const buf = fs.readFileSync(path.join(path.dirname(file), name));
  const block = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const res = ET.contract.validate({ ...records, vectors: block }, null);
  if (!res.ok) throw new Error("the viewer's loader refused the file: " + res.code + ": " + res.message);
  return { set: res.set, records };
}

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}
function percentile(a, p) {
  const s = Array.from(a).sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

// Remove from v its components along the first r rows (Gram-Schmidt deflation).
function deflate(v, rows, r, D) {
  for (let q = 0; q < r; q++) {
    let dot = 0;
    for (let d = 0; d < D; d++) dot += v[d] * rows[q * D + d];
    for (let d = 0; d < D; d++) v[d] -= dot * rows[q * D + d];
  }
}

// One power-iteration step: v <- normalise(Y^T (Y v)), with p as scratch of length N.
function powerStep(Y, N, D, v, p) {
  for (let i = 0; i < N; i++) {
    let a = 0;
    for (let d = 0; d < D; d++) a += Y[i * D + d] * v[d];
    p[i] = a;
  }
  v.fill(0);
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) v[d] += p[i] * Y[i * D + d];
  let n = 0;
  for (let d = 0; d < D; d++) n += v[d] * v[d];
  n = Math.sqrt(n);
  for (let d = 0; d < D; d++) v[d] /= n;
}

// The two leading principal directions of centred data, by power iteration with
// deflation (what a 2-D PCA map shows). Returns a Float32Array(2 * D), rows orthonormal.
function topTwo(Y, N, D) {
  const rows = new Float32Array(2 * D);
  const rng = ET.math.makeRandom(7);
  for (let r = 0; r < 2; r++) {
    const v = new Float64Array(D);
    for (let d = 0; d < D; d++) v[d] = rng.gauss();
    const p = new Float64Array(N);
    for (let it = 0; it < 300; it++) {
      deflate(v, rows, r, D);
      powerStep(Y, N, D, v, p);
    }
    for (let d = 0; d < D; d++) rows[r * D + d] = v[d];
  }
  return rows;
}

// How far apart two groups look in a picture: the distance between their centres
// divided by the mean of their spreads (root-mean-square distance of a group's points
// from its centre). Below 1 the two overlap; above 2 they stand clearly apart.
// `rows` is k orthonormal rows of length D; returns { "a|b": gap } for every pair.
function pairGaps(Y, N, D, rows, k, groups, names) {
  const { sums, P } = groupCentres(Y, N, D, rows, k, groups, names);
  addSpreads(sums, P, N, k, groups);
  return gapsBetween(sums, k, names);
}

// Project every point on the k rows (P, N x k) and sum each group's projections into
// its centre; the centres are then divided by the group's size.
function groupCentres(Y, N, D, rows, k, groups, names) {
  const sums = {};
  for (const g of names) sums[g] = { n: 0, c: new Float64Array(k), s: 0 };
  const P = new Float64Array(N * k);
  for (let i = 0; i < N; i++) {
    const g = groups[i];
    for (let r = 0; r < k; r++) {
      let a = 0;
      for (let d = 0; d < D; d++) a += Y[i * D + d] * rows[r * D + d];
      P[i * k + r] = a;
      if (g) sums[g].c[r] += a;
    }
    if (g) sums[g].n++;
  }
  for (const g of names) for (let r = 0; r < k; r++) sums[g].c[r] /= sums[g].n;
  return { sums, P };
}

// Each group's sum of squared distances of its points from its centre, into sums[g].s.
function addSpreads(sums, P, N, k, groups) {
  for (let i = 0; i < N; i++) {
    const g = groups[i];
    if (!g) continue;
    for (let r = 0; r < k; r++) sums[g].s += (P[i * k + r] - sums[g].c[r]) ** 2;
  }
}

// The gap of every pair of groups: centre distance over mean spread.
function gapsBetween(sums, k, names) {
  const out = {};
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      const A = sums[names[a]];
      const B = sums[names[b]];
      let d2 = 0;
      for (let r = 0; r < k; r++) d2 += (A.c[r] - B.c[r]) ** 2;
      const spread = (Math.sqrt(A.s / A.n) + Math.sqrt(B.s / B.n)) / 2;
      out[names[a] + "|" + names[b]] = Math.sqrt(d2) / spread;
    }
  }
  return out;
}

// Plain code-unit order: exactly what Array.prototype.sort does without a compare
// function on strings (localeCompare would order differently).
function byCodeUnit(x, y) {
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

// True when `gap` should replace `current` as the best gap seen: exactly the negation of
// `gap <= current`, so an unset (non-number) or NaN entry is always replaced.
function replacesBest(gap, current) {
  if (typeof current !== "number" || Number.isNaN(current) || Number.isNaN(gap)) return true;
  return gap > current;
}

// Groups: the point's own, else metadata[groupKey]. Small groups count as ungrouped.
function groupsOf(set, records, o) {
  const raw = set.points.map((p, i) => {
    if (p.group) return p.group;
    const md = records.points[i].metadata;
    return o.groupKey && typeof md?.[o.groupKey] === "string" ? md[o.groupKey] : "";
  });
  const sizes = {};
  for (const g of raw) if (g) sizes[g] = (sizes[g] || 0) + 1;
  const groups = raw.map((g) => (g && sizes[g] >= o.minGroup ? g : ""));
  const kept = Object.keys(sizes).filter((g) => sizes[g] >= o.minGroup);
  if (kept.length < 2) throw new Error("fewer than two groups: nothing to separate (try --group-key)");
  return { groups, kept };
}

// Optional seeded subset for the measurement (the O(N^2) part), never for the tour.
function measuredSubset(m, set, groups, o) {
  const N = set.count;
  const D = set.dimension;
  const Y = m.centre(set.vectors, N, D).data;
  const subset = o.sample > 0 && o.sample < N;
  if (!subset) return { Y, YN: N, YG: groups };
  const rng = m.makeRandom(4242);
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  const pick = idx.slice(0, o.sample).sort((a, b) => a - b);
  const sub = new Float32Array(pick.length * D);
  pick.forEach((src, k) => sub.set(Y.subarray(src * D, src * D + D), k * D));
  return { Y: sub, YN: pick.length, YG: pick.map((i) => groups[i]) };
}

// Record one frame's pair gaps: the best gap per pair and how often a pair is clearly apart.
function recordPairGaps(gaps, best, apart) {
  for (const key in gaps) {
    if (replacesBest(gaps[key], best[key])) best[key] = gaps[key];
    if (gaps[key] >= 2) apart[key] = (apart[key] || 0) + 1;
  }
}

// Run the mode for every seed and measure each frame's separation (and, with
// --map-compare, every pair's gap).
function measureMode(set, sub, names, o) {
  const m = ET.math;
  const { Y, YN, YG } = sub;
  const D = set.dimension;
  const best = {};
  const apart = {};
  let pairFrames = 0;
  const perSeed = [];
  const all = [];
  for (const seed of o.seeds) {
    const inst = ET.modes.create(o.mode);
    inst.enter(set, { seed });
    const prep = inst.prepare();
    while (!prep.done) prep.step(1000);
    inst.mark?.(0);
    const vals = [];
    for (let t = 0; t <= o.seconds + 1e-9; t += o.step) {
      const frame = inst.stateAt(t).frame;
      vals.push(m.frameSeparation(Y, YN, D, frame, YG));
      if (o.mapCompare) {
        pairFrames++;
        recordPairGaps(pairGaps(Y, YN, D, frame, 3, YG, names), best, apart);
      }
    }
    perSeed.push({ seed, mean: mean(vals), min: Math.min(...vals), max: Math.max(...vals), frames: vals.length });
    for (const v of vals) all.push(v);
  }
  return { best, apart, pairFrames, perSeed, all };
}

// The 2-D map's points: each measured point projected on the two leading directions.
function mapPoints(Y, YN, D, two) {
  const P = new Float32Array(YN * 2);
  for (let i = 0; i < YN; i++) {
    for (let r = 0; r < 2; r++) {
      let a = 0;
      for (let d = 0; d < D; d++) a += Y[i * D + d] * two[r * D + d];
      P[i * 2 + r] = a;
    }
  }
  return P;
}

// Compare, pair of groups by pair, the 2-D map with the mode's frames.
function mapCompare(sub, D, names, measured) {
  const m = ET.math;
  const { Y, YN, YG } = sub;
  const { best, apart, pairFrames } = measured;
  const two = topTwo(Y, YN, D);
  const flat = pairGaps(Y, YN, D, two, 2, YG, names);
  const keys = Object.keys(flat);
  const merged = keys.filter((key) => flat[key] < 1);
  return {
    pairs: keys.length,
    map_separation: m.groupSeparation(mapPoints(Y, YN, D, two), YN, 2, YG),
    overlapping_in_map: merged.length,
    of_those_clearly_apart_in_some_frame: merged.filter((key) => best[key] >= 2).length,
    clearly_apart_in_map: keys.filter((key) => flat[key] >= 2).length,
    clearly_apart_in_some_frame: keys.filter((key) => best[key] >= 2).length,
    merged_pairs: merged
      .map((key) => ({
        pair: key,
        map_gap: flat[key],
        best_gap: best[key],
        share_of_frames_clearly_apart: (apart[key] || 0) / pairFrames,
      }))
      .sort((x, y) => y.best_gap - x.best_gap),
  };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { set, records } = load(o.file);
  const m = ET.math;
  const N = set.count;
  const D = set.dimension;

  const { groups, kept } = groupsOf(set, records, o);
  const sub = measuredSubset(m, set, groups, o);
  const { Y, YN, YG } = sub;

  const full = m.groupSeparation(Y, YN, D, YG);

  const rng = m.makeRandom(12);
  const rand = [];
  for (let i = 0; i < o.random; i++) rand.push(m.frameSeparation(Y, YN, D, m.randomFrame(D, rng), YG));

  const names = kept.slice().sort(byCodeUnit);
  const measured = measureMode(set, sub, names, o);
  const { perSeed, all } = measured;

  const out = {
    file: path.basename(o.file),
    model: set.model,
    points: N,
    dimension: D,
    measured_points: YN,
    groups: kept.length,
    grouped_points: YG.filter(Boolean).length,
    group_source: o.groupKey ? "point.group, else metadata." + o.groupKey : "point.group",
    full_space: full,
    random_frames: { n: rand.length, mean: mean(rand), p5: percentile(rand, 5), p95: percentile(rand, 95) },
    mode: o.mode,
    measured: {
      mean: mean(all),
      p5: percentile(all, 5),
      p95: percentile(all, 95),
      share_of_frames_at_or_above_1_3: all.filter((v) => v >= 1.3).length / all.length,
      seconds: o.seconds,
      step: o.step,
      per_seed: perSeed,
    },
    target: 1.3,
    meets_target: mean(all) >= 1.3,
    core_version: Lib.version,
  };

  if (o.mapCompare) out.map_compare = mapCompare(sub, D, names, measured);

  if (o.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }
  const f = (v) => v.toFixed(3);
  process.stdout.write(
    [
      `${out.file}: ${out.model}, ${N} points x ${D}-d, ${out.groups} groups (${out.grouped_points} of ${YN} measured points grouped; ${out.group_source})`,
      `full ${D}-d space:        ${f(full)}`,
      `random 3-D frames:        mean ${f(out.random_frames.mean)} (5th-95th percentile ${f(out.random_frames.p5)}-${f(out.random_frames.p95)}, ${rand.length} frames)`,
      `${(o.mode + " (shipped mode):").padEnd(25)} mean ${f(out.measured.mean)} (5th-95th percentile ${f(out.measured.p5)}-${f(out.measured.p95)}; ${(100 * out.measured.share_of_frames_at_or_above_1_3).toFixed(0)}% of frames at or above 1.3)`,
      ...perSeed.map((s) => `  seed ${s.seed}: mean ${f(s.mean)}, min ${f(s.min)}, max ${f(s.max)} over ${s.frames} frames`),
      `target 1.3: ${out.meets_target ? "met" : "MISSED"}`,
      "",
    ].join("\n")
  );
  if (out.map_compare) {
    const c = out.map_compare;
    process.stdout.write(
      [
        `2-D map (two leading principal components): separation ${f(c.map_separation)}`,
        `pairs of groups: ${c.pairs}; clearly apart (gap >= 2) in the map: ${c.clearly_apart_in_map}; in at least one ${o.mode} frame: ${c.clearly_apart_in_some_frame}`,
        `overlapping in the map (gap < 1): ${c.overlapping_in_map}; of those, clearly apart in at least one ${o.mode} frame: ${c.of_those_clearly_apart_in_some_frame}`,
        ...c.merged_pairs.map(
          (p) => `  ${p.pair}: map ${f(p.map_gap)}, best frame ${f(p.best_gap)}, clearly apart in ${(100 * p.share_of_frames_clearly_apart).toFixed(0)}% of frames`
        ),
        "",
      ].join("\n")
    );
  }
}

try {
  main();
} catch (e) {
  process.stderr.write("error: " + e.message + "\n");
  process.exit(1);
}
