"use strict";
// ET.math: principal directions, the seeded guided tour, variance share, group separation.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");
const { rngFrom, plantedSpectrum, plantedGroups } = require("./helpers/math-fixtures.js");

const math = () => loadSources(["10-math.js"])._internal.math;
const DIMS = [384, 768, 1024, 2560];

function dot(A, ia, B, ib, D) {
  let s = 0;
  for (let d = 0; d < D; d++) s += A[ia * D + d] * B[ib * D + d];
  return s;
}

// Independent recomputation: share of total variance in the span of `rows`
// orthonormal directions, by explicit projection of centred data.
function recomputeShare(X, N, D, dirs, rows) {
  const mean = new Float64Array(D);
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) mean[d] += X[i * D + d] / N;
  let total = 0;
  let held = 0;
  const y = new Float64Array(D);
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) {
      y[d] = X[i * D + d] - mean[d];
      total += y[d] * y[d];
    }
    for (let r = 0; r < rows; r++) {
      let p = 0;
      for (let d = 0; d < D; d++) p += y[d] * dirs[r * D + d];
      held += p * p;
    }
  }
  return held / total;
}

test("symmetricEigen solves a known matrix", () => {
  const m = math();
  // [[2,1],[1,2]] has eigenvalues 3 and 1 with vectors (1,1)/sqrt2 and (1,-1)/sqrt2.
  const r = m.symmetricEigen(new Float64Array([2, 1, 1, 2]), 2);
  assert.ok(Math.abs(r.values[0] - 3) < 1e-12);
  assert.ok(Math.abs(r.values[1] - 1) < 1e-12);
  assert.ok(Math.abs(Math.abs(r.vectors[0]) - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs(r.vectors[0] - r.vectors[1]) < 1e-12);
});

// Each path of principalDirections recovers a planted spectrum.
for (const [label, N, D] of [
  ["gram-exact", 50, 384],
  ["gram-iterative", 200, 768],
  ["covariance-iterative", 600, 384],
]) {
  test(`principalDirections (${label}, ${N}x${D}) recovers planted directions`, () => {
    const m = math();
    const sds = [9, 7, 5.5, 4.5, 3.5];
    const { X, dirs } = plantedSpectrum(N, D, sds, 0.15, N + D);
    const { data } = m.centre(X, N, D);
    const pca = m.principalDirections(data, N, D, 5, { seed: 3 });
    assert.strictEqual(pca.method, label);
    assert.strictEqual(pca.directions.length, 5 * D);
    assert.ok(m.frameError(pca.directions, 5, D) < 1e-5);
    for (let j = 0; j < 5; j++) {
      assert.ok(Math.abs(dot(pca.directions, j, dirs, j, D)) > 0.98, `direction ${j}`);
      if (j > 0) assert.ok(pca.variances[j] <= pca.variances[j - 1]);
    }
    // Reported shares match an independent recomputation.
    for (let j = 0; j < 5; j++) {
      const one = recomputeShare(X, N, D, pca.directions.subarray(j * D, (j + 1) * D), 1);
      assert.ok(Math.abs(one - pca.shares[j]) < 1e-6);
    }
    assert.ok(Math.abs(recomputeShare(X, N, D, pca.directions, 5) - pca.share) < 1e-6);
  });
}

test("principalDirections matches exact eigenvalues of the covariance (small case)", () => {
  const m = math();
  const N = 300;
  const D = 12;
  const { X } = plantedSpectrum(N, D, [5, 4, 3, 2.5, 2], 0.7, 11);
  const { data } = m.centre(X, N, D);
  const C = new Float64Array(D * D);
  for (let i = 0; i < N; i++)
    for (let a = 0; a < D; a++)
      for (let b = 0; b < D; b++) C[a * D + b] += (data[i * D + a] * data[i * D + b]) / N;
  const exact = m.symmetricEigen(C, D).values;
  const pca = m.principalDirections(data, N, D, 4, { seed: 1 });
  assert.strictEqual(pca.method, "covariance-iterative");
  for (let j = 0; j < 4; j++) assert.ok(Math.abs(pca.variances[j] - exact[j]) < 1e-4 * exact[0]);
});

test("principalDirections is deterministic and survives degenerate data", () => {
  const m = math();
  const N = 100;
  const D = 384;
  const { X } = plantedSpectrum(N, D, [5, 3, 2], 0.2, 2);
  const { data } = m.centre(X, N, D);
  const a = m.principalDirections(data, N, D, 4, { seed: 9 });
  const b = math().principalDirections(data, N, D, 4, { seed: 9 });
  assert.deepStrictEqual(Array.from(a.directions), Array.from(b.directions));
  // All points identical: no variance, still an orthonormal answer.
  const flat = new Float32Array(10 * D).fill(0.5);
  const c = m.principalDirections(m.centre(flat, 10, D).data, 10, D, 3);
  assert.strictEqual(c.share, 0);
  assert.ok(m.frameError(c.directions, 3, D) < 1e-5);
});

test("sampleRows fits on a strided subset but reports exact shares over all rows", () => {
  const m = math();
  const N = 900;
  const D = 384;
  const { X, dirs } = plantedSpectrum(N, D, [9, 7, 5.5, 4.5], 0.2, 31);
  const { data } = m.centre(X, N, D);
  const pca = m.principalDirections(data, N, D, 4, { seed: 1, sampleRows: 300 });
  assert.strictEqual(pca.method, "gram-iterative-sampled");
  assert.strictEqual(pca.sampledRows, 300);
  for (let j = 0; j < 4; j++) assert.ok(Math.abs(dot(pca.directions, j, dirs, j, D)) > 0.95);
  assert.ok(Math.abs(recomputeShare(X, N, D, pca.directions, 4) - pca.share) < 1e-6);
  const tour = m.guidedTour(data, N, D, { seed: 1, subspace: 4, sampleRows: 300 });
  assert.ok(Math.abs(recomputeShare(X, N, D, tour.basis, 4) - tour.varianceShare) < 1e-6);
});

// ----- criterion 1: same data, seed and elapsed time give the identical frame -----

test("the tour returns the identical frame for the same seed and time across two runs", () => {
  const D = 1024;
  const N = 120;
  const { X } = plantedSpectrum(N, D, [6, 5, 4, 3, 2.5, 2, 1.5, 1.2], 0.3, 21);
  const run = () => {
    const m = math(); // a fresh load: nothing shared between the two runs
    const { data } = m.centre(X, N, D);
    const tour = m.guidedTour(data, N, D, { seed: 20261113 });
    return [0, 0.016, 3.7, 10, 1234.5].map((t) => Array.from(tour.frameAt(t)));
  };
  const first = run();
  const second = run();
  assert.deepStrictEqual(first, second);
  // A different seed gives a different motion.
  const m = math();
  const { data } = m.centre(X, N, D);
  const other = m.guidedTour(data, N, D, { seed: 1 });
  assert.notDeepStrictEqual(Array.from(other.frameAt(10)), first[3]);
});

test("the tour frame does not depend on how time was sliced", () => {
  const m = math();
  const D = 768;
  const N = 80;
  const { X } = plantedSpectrum(N, D, [6, 5, 4, 3, 2.5, 2, 1.5, 1.2], 0.3, 5);
  const tour = m.guidedTour(m.centre(X, N, D).data, N, D, { seed: 4 });
  const direct = Array.from(tour.frameAt(10));
  let last = null;
  let lastT = null;
  // (i / 625) * 10 is exactly 10 at i = 625 by construction (i / 625 === 1).
  for (let i = 1; i <= 625; i++) {
    lastT = (i / 625) * 10;
    last = tour.frameAt(lastT);
  }
  assert.strictEqual(lastT, 10, "the sliced walk ends exactly at t = 10");
  assert.deepStrictEqual(Array.from(last), direct);
  assert.deepStrictEqual(Array.from(tour.frameAt(10)), direct); // and again after going back
});

// ----- criterion 2: orthonormal frames, motion inside the toured subspace -----

for (const D of DIMS) {
  test(`at ${D}-d every tour frame is orthonormal to 1e-5 and lies in the toured subspace`, () => {
    const m = math();
    const N = D === 2560 ? 24 : 60;
    const { X } = plantedSpectrum(N, D, [6, 5, 4, 3, 2.5, 2, 1.5, 1.2], 0.3, D + 1);
    const tour = m.guidedTour(m.centre(X, N, D).data, N, D, { seed: 7 });
    assert.strictEqual(tour.dimension, D);
    assert.strictEqual(tour.subspace, 8);
    // At t = 0 the view is the top three principal directions.
    const f0 = tour.frameAt(0);
    for (let r = 0; r < 3; r++) assert.ok(Math.abs(dot(f0, r, tour.basis, r, D) - 1) < 1e-5);
    let prev = f0;
    for (let t = 0.25; t < 40; t += 2.75) {
      const F = tour.frameAt(t);
      assert.strictEqual(F.length, 3 * D);
      assert.ok(m.frameError(F, 3, D) < 1e-5, `t=${t}`);
      for (let r = 0; r < 3; r++) {
        let inSpan = 0;
        for (let j = 0; j < 8; j++) inSpan += dot(F, r, tour.basis, j, D) ** 2;
        assert.ok(Math.abs(inSpan - 1) < 1e-5);
      }
      prev = F;
    }
    assert.ok(prev);
  });
}

test("the tour moves smoothly", () => {
  const m = math();
  const D = 384;
  const { X } = plantedSpectrum(60, D, [6, 5, 4, 3, 2.5, 2, 1.5, 1.2], 0.3, 8);
  const tour = m.guidedTour(m.centre(X, 60, D).data, 60, D, { seed: 2 });
  let moved = 0;
  for (let t = 0; t < 20; t += 1) {
    const a = tour.frameAt(t);
    const b = tour.frameAt(t + 1 / 60);
    let s = 0;
    for (let i = 0; i < 3 * D; i++) s += (a[i] - b[i]) ** 2;
    assert.ok(Math.sqrt(s) < 0.1, "a 1/60 s step is a small turn");
    moved += Math.sqrt(s);
  }
  assert.ok(moved > 0.01, "and the frame does move");
});

test("makeTour refuses impossible shapes", () => {
  const m = math();
  assert.throws(() => m.makeTour(new Float32Array(2 * 10), 2, 10), { name: "RangeError" });
  assert.throws(() => m.makeTour(new Float32Array(9), 3, 3).frameAt(NaN), { name: "RangeError" });
});

// ----- criterion 4: the reported variance share, recomputed independently -----

for (const D of DIMS) {
  test(`at ${D}-d the tour's reported variance share matches an independent recomputation`, () => {
    const m = math();
    const N = D === 2560 ? 30 : 90;
    const { X } = plantedSpectrum(N, D, [6, 5, 4, 3, 2.5, 2, 1.5, 1.2, 1, 0.8], 0.25, D + 2);
    const tour = m.guidedTour(m.centre(X, N, D).data, N, D, { seed: 3 });
    const share = recomputeShare(X, N, D, tour.basis, tour.subspace);
    assert.ok(tour.varianceShare > 0 && tour.varianceShare <= 1);
    assert.ok(Math.abs(tour.varianceShare - share) < 1e-6, `${tour.varianceShare} vs ${share}`);
    // varianceShare() on a frame agrees with the same recomputation.
    const F = tour.frameAt(5);
    const frameShare = m.varianceShare(m.centre(X, N, D).data, N, D, F, 3);
    assert.ok(Math.abs(frameShare - recomputeShare(X, N, D, F, 3)) < 1e-6);
  });
}

// ----- criterion 3: guided beats a uniformly random tour on planted groups -----

test("on planted groups in 1024-d the guided tour separates groups better than a random tour", () => {
  const m = math();
  const f = plantedGroups(1024);
  const { data } = m.centre(f.X, f.N, f.D);
  const full = m.groupSeparation(data, f.N, f.D, f.groups);
  const tour = m.guidedTour(data, f.N, f.D, { seed: 11 });
  const rng = m.makeRandom(12);
  let guided = 0;
  let random = 0;
  let n = 0;
  for (let t = 0; t < 60; t += 0.5) {
    guided += m.frameSeparation(data, f.N, f.D, tour.frameAt(t), f.groups);
    random += m.frameSeparation(data, f.N, f.D, m.randomFrame(f.D, rng), f.groups);
    n++;
  }
  guided /= n;
  random /= n;
  // The fixture mirrors the probe: groups barely separate in the full space.
  assert.ok(full > 1.05 && full < 1.2, `full-space separation ${full}`);
  assert.ok(random < 1.2, `random tour ${random}`);
  // The asserted margin: at least 0.25 above the random tour, and at least 1.3 outright.
  assert.ok(guided - random >= 0.25, `guided ${guided} vs random ${random}`);
  assert.ok(guided >= 1.3, `guided ${guided}`);
});

// ----- group separation measure -----

test("groupSeparation matches a hand computation and skips ungrouped points", () => {
  const m = math();
  // 1-d points: a at 0 and 1, b at 10 and 11, one ungrouped point far away.
  const P = new Float32Array([0, 1, 10, 11, 500]);
  const g = ["a", "a", "b", "b", ""];
  // within: |0-1| = 1, |10-11| = 1 -> mean 1. between: 10, 11, 9, 10 -> mean 10.
  assert.ok(Math.abs(m.groupSeparation(P, 5, 1, g) - 10) < 1e-12);
  assert.ok(Number.isNaN(m.groupSeparation(P, 2, 1, ["a", "a"])));
  assert.ok(Number.isNaN(m.groupSeparation(P, 2, 1, ["a", "b"])));
  // Works with any dimension and numeric labels.
  const rng = rngFrom(1);
  const Q = new Float32Array(10 * 5).map(() => rng.gauss());
  const s = m.groupSeparation(Q, 10, 5, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert.ok(s > 0 && Number.isFinite(s));
});
