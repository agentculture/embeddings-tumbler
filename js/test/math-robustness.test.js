"use strict";
// ET.math: robustness. Out-of-order time, argument validation, degenerate inputs.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");
const { rngFrom, plantedSpectrum } = require("./helpers/math-fixtures.js");

const math = () => loadSources(["10-math.js"])._internal.math;

function block(N, D, seed) {
  const rng = rngFrom(seed);
  const X = new Float32Array(N * D);
  for (let i = 0; i < X.length; i++) X[i] = rng.gauss();
  return X;
}

function hasNaN(A) {
  for (let i = 0; i < A.length; i++) if (Number.isNaN(A[i])) return true;
  return false;
}

// Times forwards, backwards, repeated, and either side of the 3.4 s cycle boundaries.
const ODD_TIMES = [5, 1.2, 3.3999999, 3.4, 3.4000001, 0, 23.3, 6.8, 6.8, 6.7999999, 2, 100, 0.5, 3.4];

// ----- 1. out-of-order calls give what a fresh object gives -----

test("makeSwapTour.frameAt at out-of-order times equals a fresh tour at the same time", () => {
  const D = 384;
  const make = () => {
    const m = math();
    return m.makeSwapTour(m.randomFrame(D, m.makeRandom(5)), D, { seed: 6, period: 3.4 });
  };
  const used = make();
  for (const t of ODD_TIMES) {
    assert.deepStrictEqual(Array.from(used.frameAt(t)), Array.from(make().frameAt(t)), `t=${t}`);
    assert.deepStrictEqual({ ...used.stateAt(t) }, { ...make().stateAt(t) });
  }
});

test("guidedTour.frameAt at out-of-order times equals a fresh tour at the same time", () => {
  const D = 384;
  const N = 60;
  const { X } = plantedSpectrum(N, D, [6, 5, 4, 3, 2.5, 2, 1.5, 1.2], 0.3, 3);
  const make = () => {
    const m = math();
    return m.guidedTour(m.centre(X, N, D).data, N, D, { seed: 8 });
  };
  const used = make();
  for (const t of ODD_TIMES) {
    assert.deepStrictEqual(Array.from(used.frameAt(t)), Array.from(make().frameAt(t)), `t=${t}`);
  }
});

// ----- 2. principalDirections options -----

test("principalDirections refuses a bad oversample, maxIterations or tolerance", () => {
  const m = math();
  const N = 100;
  const D = 40; // N > D: the covariance path, which uses the options
  const { data } = m.centre(block(N, D, 1), N, D);
  for (const bad of [{ oversample: -3 }, { oversample: 1.5 }, { maxIterations: -1 }, { maxIterations: NaN }, { tolerance: -1 }, { tolerance: Infinity }]) {
    assert.throws(() => m.principalDirections(data, N, D, 4, bad), { name: "RangeError" }, JSON.stringify(bad));
  }
  // Zero is allowed for both and still returns orthonormal, finite directions.
  const r = m.principalDirections(data, N, D, 4, { oversample: 0, maxIterations: 0 });
  assert.strictEqual(r.iterations, 1);
  assert.ok(!hasNaN(r.directions));
  assert.ok(m.frameError(r.directions, 4, D) < 1e-5);
});

test("principalDirections clamps k into 1..D and completes beyond the data's rank", () => {
  const m = math();
  const D = 30;
  const N = 5; // centred rank is at most 4
  const { data } = m.centre(block(N, D, 2), N, D);
  assert.strictEqual(m.principalDirections(data, N, D, 0).count, 1);
  assert.strictEqual(m.principalDirections(data, N, D, -7).count, 1);
  assert.strictEqual(m.principalDirections(data, N, D, 99).count, D);
  const r = m.principalDirections(data, N, D, 8);
  assert.strictEqual(r.count, 8);
  assert.ok(m.frameError(r.directions, 8, D) < 1e-5);
  for (let j = 4; j < 8; j++) assert.ok(r.shares[j] < 1e-9, `share ${j} = ${r.shares[j]}`);
  assert.ok(Math.abs(r.share - 1) < 1e-6);
});

test("guidedTour passes maxIterations, tolerance and oversample through", () => {
  const m = math();
  const N = 100;
  const D = 40;
  const { data } = m.centre(block(N, D, 3), N, D);
  assert.throws(() => m.guidedTour(data, N, D, { oversample: -2 }), { name: "RangeError" });
  assert.throws(() => m.guidedTour(data, N, D, { tolerance: -1 }), { name: "RangeError" });
  const t = m.guidedTour(data, N, D, { maxIterations: 0 });
  assert.strictEqual(t.pca.iterations, 1);
});

// ----- 3. kNN with k = 0 -----

test("makeKnn with k = 0 finishes at once with empty results", () => {
  const m = math();
  const D = 16;
  const s = m.makeKnn(block(50, D, 4), 50, D, 0);
  assert.strictEqual(s.k, 0);
  assert.strictEqual(s.done, true);
  assert.strictEqual(s.next, s.count);
  assert.strictEqual(s.indices.length, 0);
  assert.strictEqual(s.step(5), true);
});

// ----- 4. localFrame ids -----

test("localFrame refuses ids outside 0..N-1 and an empty neighbourhood", () => {
  const m = math();
  const D = 8;
  const X = block(10, D, 5);
  assert.throws(() => m.localFrame(X, 10, D, [0, 1, 10]), { name: "RangeError" });
  assert.throws(() => m.localFrame(X, 10, D, [0, -1]), { name: "RangeError" });
  assert.throws(() => m.localFrame(X, 10, D, [0, 1.5]), { name: "RangeError" });
  assert.throws(() => m.localFrame(X, 10, D, []), { name: "RangeError" });
  const F = m.localFrame(X, 10, D, [0, 1, 2, 3]);
  assert.ok(m.frameError(F, 3, D) < 1e-5);
});

// ----- 5. shape checks on projection and variance share -----

test("project and varianceShare refuse a frame of the wrong length or a bad row count", () => {
  const m = math();
  const D = 12;
  const N = 6;
  const Y = m.centre(block(N, D, 6), N, D).data;
  const F = m.randomFrame(D, m.makeRandom(1));
  assert.throws(() => m.project(Y, N, D, F.subarray(0, 2 * D), null), { name: "TypeError" });
  assert.throws(() => m.project(Y, N, D, F, null, null, 2), { name: "TypeError" });
  assert.throws(() => m.project(Y, N, D, F, new Float64Array(D - 1)), { name: "TypeError" });
  assert.throws(() => m.project(Y, N, D, F, null, new Float32Array(N * 3 - 1)), { name: "TypeError" });
  assert.throws(() => m.varianceShare(Y, N, D, F, 4), { name: "TypeError" });
  assert.throws(() => m.varianceShare(Y, N, D, F, 0), { name: "TypeError" });
  assert.throws(() => m.varianceShare(Y, N, D, F, 2.5), { name: "TypeError" });
  assert.throws(() => m.varianceShare(Y, N, D, new Float32Array(3 * (D + 1)), 3), { name: "TypeError" });
  assert.ok(Number.isFinite(m.varianceShare(Y, N, D, F, 3)));
});

// ----- 6. orthonormalize when rows is close to D -----

test("orthonormalize returns an orthonormal set for rank-deficient rows with rows close to D", () => {
  const m = math();
  for (const D of [3, 4, 6, 9]) {
    const cases = [];
    cases.push(new Float32Array(D * D)); // all zero, rows = D
    const same = new Float32Array(D * D);
    for (let i = 0; i < D; i++) for (let d = 0; d < D; d++) same[i * D + d] = 1 + d; // identical rows
    cases.push(same);
    const e0 = new Float32Array(D * D);
    for (let i = 0; i < D; i++) e0[i * D] = i + 1; // every row along the first axis
    cases.push(e0);
    const pair = new Float32Array((D - 1) * D);
    for (let i = 0; i < D - 1; i++) pair[i * D + (i % 2)] = 1; // duplicates of e0 and e1
    cases.push(pair);
    for (const M of cases) {
      const rows = M.length / D;
      const copy = new Float32Array(M);
      m.orthonormalize(M, rows, D);
      assert.ok(!hasNaN(M));
      assert.ok(m.frameError(M, rows, D) < 1e-5, `D=${D} rows=${rows}`);
      math().orthonormalize(copy, rows, D);
      assert.deepStrictEqual(Array.from(copy), Array.from(M));
    }
  }
});

// ----- 7. degenerate inputs -----

test("a single point: zero variance, an orthonormal tour, no neighbours, no separation", () => {
  const m = math();
  const D = 16;
  const X = block(1, D, 7);
  const { data } = m.centre(X, 1, D);
  assert.strictEqual(m.totalVariance(data, 1, D), 0);
  const tour = m.guidedTour(data, 1, D, { seed: 1 });
  assert.strictEqual(tour.varianceShare, 0);
  for (const t of [0, 2.5, 40]) assert.ok(m.frameError(tour.frameAt(t), 3, D) < 1e-5);
  assert.strictEqual(m.varianceShare(data, 1, D, tour.frameAt(1), 3), 0);
  assert.strictEqual(m.knn(X, 1, D, 5).k, 0);
  assert.ok(Number.isNaN(m.groupSeparation(data, 1, D, ["a"])));
});

test("all points identical: the tour is still orthonormal and every share is 0", () => {
  const m = math();
  const D = 64;
  const N = 90; // N > 64 so the iterative Gram path would be chosen if there were variance
  const X = new Float32Array(N * D).fill(0.25);
  const { data } = m.centre(X, N, D);
  const tour = m.guidedTour(data, N, D, { seed: 2 });
  assert.strictEqual(tour.varianceShare, 0);
  for (const t of [0, 1, 7.7, 300]) {
    const F = tour.frameAt(t);
    assert.ok(!hasNaN(F));
    assert.ok(m.frameError(F, 3, D) < 1e-5);
    assert.strictEqual(m.varianceShare(data, N, D, F, 3), 0);
  }
});

test("duplicate points are each other's nearest neighbours at distance 0, lower index first", () => {
  const m = math();
  const D = 32;
  const base = block(4, D, 8);
  const X = new Float32Array(8 * D);
  X.set(base, 0);
  X.set(base, 4 * D); // points 4..7 duplicate 0..3
  const r = m.knn(X, 8, D, 2);
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(r.indices[i * 2], i + 4);
    assert.strictEqual(r.distances[i * 2], 0);
    assert.strictEqual(r.indices[(i + 4) * 2], i);
    assert.strictEqual(r.distances[(i + 4) * 2], 0);
  }
});

for (const [label, N, D] of [
  ["gram-iterative", 100, 384],
  ["covariance-iterative", 600, 50],
]) {
  test(`rank-deficient data on the ${label} path gives finite orthonormal directions`, () => {
    const m = math();
    // Rank 2: every point is a combination of two directions.
    const { X } = plantedSpectrum(N, D, [5, 3], 0, 9);
    const { data } = m.centre(X, N, D);
    const r = m.principalDirections(data, N, D, 6, { seed: 1 });
    assert.strictEqual(r.method, label);
    assert.ok(!hasNaN(r.directions));
    assert.ok(m.frameError(r.directions, 6, D) < 1e-5);
    assert.ok(Math.abs(r.shares[0] + r.shares[1] - 1) < 1e-5);
    for (let j = 2; j < 6; j++) assert.ok(r.shares[j] < 1e-6, `share ${j} = ${r.shares[j]}`);
    const tour = m.guidedTour(data, N, D, { seed: 1, subspace: 6, pca: r });
    for (const t of [0, 3, 9]) assert.ok(m.frameError(tour.frameAt(t), 3, D) < 1e-5);
  });
}

test("hiddenDirection works at D = 4, the smallest dimension with room", () => {
  const m = math();
  const D = 4;
  const F = m.randomFrame(D, m.makeRandom(3));
  const h = m.hiddenDirection(F, D, m.makeRandom(4));
  let n = 0;
  for (let d = 0; d < D; d++) n += h[d] * h[d];
  assert.ok(Math.abs(n - 1) < 1e-6);
  for (let r = 0; r < 3; r++) {
    let s = 0;
    for (let d = 0; d < D; d++) s += h[d] * F[r * D + d];
    assert.ok(Math.abs(s) < 1e-6);
  }
  const tour = m.makeSwapTour(F, D, { seed: 1 });
  for (const t of [0, 2, 5, 11]) assert.ok(m.frameError(tour.frameAt(t), 3, D) < 1e-5);
});

test("groupSeparation is Infinity when groups are points, 1 when everything coincides", () => {
  const m = math();
  // Every same-group pair coincides, groups apart: perfect separation.
  const P = new Float32Array([0, 0, 5, 5]);
  assert.strictEqual(m.groupSeparation(P, 4, 1, ["a", "a", "b", "b"]), Infinity);
  // Everything at one place: nothing to see, ratio defined as 1.
  assert.strictEqual(m.groupSeparation(new Float32Array(4), 4, 1, ["a", "a", "b", "b"]), 1);
});

test("makeSwapTour refuses a basis without a matching basisRows", () => {
  const m = math();
  const D = 16;
  const F = m.randomFrame(D, m.makeRandom(1));
  const basis = m.randomFrame(D, m.makeRandom(2), null, 6);
  assert.throws(() => m.makeSwapTour(F, D, { basis }), { name: "RangeError" });
  assert.throws(() => m.makeSwapTour(F, D, { basis, basisRows: 7 }), { name: "RangeError" });
  assert.ok(m.makeSwapTour(F, D, { basis, basisRows: 6 }).frameAt(1));
});
