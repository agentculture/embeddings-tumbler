"use strict";
// ET.math: the sliced (stepper) forms of the principal-direction fit, the guided
// tour and centring. Whatever budgets drive them, they give the same bytes as
// the blocking calls, and the work is actually divided into many small units.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");
const { rngFrom, plantedSpectrum } = require("./helpers/math-fixtures.js");

const math = () => loadSources(["10-math.js"])._internal.math;

function bytes(A) {
  return Buffer.from(A.buffer, A.byteOffset, A.byteLength);
}

function same(A, B) {
  return A.length === B.length && bytes(A).equals(bytes(B));
}

function gaussData(N, D, seed) {
  const rng = rngFrom(seed);
  const X = new Float32Array(N * D);
  for (let i = 0; i < X.length; i++) X[i] = rng.gauss() * (1 + (i % D) / D);
  return X;
}

// Drive a stepper to completion with a fixed budget; returns the number of step calls.
function drive(st, budget) {
  let calls = 0;
  while (!st.done) {
    st.step(budget);
    calls++;
    assert.ok(calls < 1e6, "the stepper never finished");
  }
  return calls;
}

function assertSamePca(a, b, what) {
  assert.ok(same(a.directions, b.directions), what + ": directions");
  assert.ok(same(a.variances, b.variances), what + ": variances");
  assert.ok(same(a.shares, b.shares), what + ": shares");
  assert.strictEqual(a.share, b.share, what + ": share");
  assert.strictEqual(a.totalVariance, b.totalVariance, what + ": totalVariance");
  assert.strictEqual(a.method, b.method, what + ": method");
  assert.strictEqual(a.iterations, b.iterations, what + ": iterations");
  assert.strictEqual(a.converged, b.converged, what + ": converged");
  assert.strictEqual(a.sampledRows, b.sampledRows, what + ": sampledRows");
  assert.strictEqual(a.count, b.count);
  assert.strictEqual(a.dimension, b.dimension);
}

// Every path through the fit: covariance (N > D), sampled, Gram exact (N <= 64),
// Gram iterative (64 < N <= D), degenerate, k beyond the rank.
const CASES = [
  { label: "covariance-iterative", N: 600, D: 48, k: 8, opts: { seed: 3 } },
  { label: "covariance-iterative-sampled", N: 900, D: 40, k: 6, opts: { seed: 4, sampleRows: 250 } },
  { label: "gram-exact", N: 40, D: 100, k: 8, opts: { seed: 5 } },
  { label: "gram-iterative", N: 120, D: 200, k: 5, opts: { seed: 6 } },
  { label: "gram-iterative-sampled", N: 500, D: 300, k: 4, opts: { seed: 7, sampleRows: 100 } },
  { label: "degenerate", N: 1, D: 30, k: 3, opts: {} },
  { label: "beyond the rank", method: "gram-exact", N: 4, D: 20, k: 8, opts: { seed: 2 } },
  { label: "no refinement", method: "covariance-iterative", N: 300, D: 30, k: 3, opts: { seed: 1, maxIterations: 0 } },
];

for (const c of CASES) {
  test(`makePrincipalDirections (${c.label}) gives the blocking call's bytes at any budget`, () => {
    const m = math();
    const Y = m.centre(gaussData(c.N, c.D, c.N + c.D), c.N, c.D).data;
    const blocking = m.principalDirections(Y, c.N, c.D, c.k, c.opts);
    assert.strictEqual(blocking.method, c.method || c.label);
    for (const budget of [0, 0.1, 4, Infinity, undefined]) {
      const st = m.makePrincipalDirections(Y, c.N, c.D, c.k, c.opts);
      assert.strictEqual(st.done, false);
      assert.strictEqual(st.result, null);
      drive(st, budget);
      assert.strictEqual(st.progress, 1);
      assertSamePca(st.result, blocking, `${c.label} budget ${budget}`);
    }
  });
}

test("makeGuidedTour gives the blocking guidedTour's tour, frame for frame", () => {
  const m = math();
  const N = 700;
  const D = 64;
  const { X } = plantedSpectrum(N, D, [5, 4, 3, 2.5, 2, 1.5, 1.2, 1], 0.2, 11);
  const Y = m.centre(X, N, D).data;
  for (const opts of [{ seed: 9 }, { seed: "x", sampleRows: 200, subspace: 6, speed: 0.3 }]) {
    const a = m.guidedTour(Y, N, D, opts);
    for (const budget of [0.1, 4, Infinity]) {
      const st = m.makeGuidedTour(Y, N, D, opts);
      drive(st, budget);
      const b = st.result;
      assert.ok(same(a.basis, b.basis));
      assert.strictEqual(a.varianceShare, b.varianceShare);
      assert.ok(same(a.variances, b.variances));
      assert.strictEqual(a.subspace, b.subspace);
      assertSamePca(a.pca, b.pca, "tour pca");
      for (const t of [0, 0.5, 3.25, 17]) assert.ok(same(a.frameAt(t), b.frameAt(t)), `frame at ${t}`);
    }
  }
});

test("makeGuidedTour reuses a given pca without refitting", () => {
  const m = math();
  const N = 300;
  const D = 32;
  const Y = m.centre(gaussData(N, D, 1), N, D).data;
  const pca = m.principalDirections(Y, N, D, 8, { seed: 1 });
  const st = m.makeGuidedTour(Y, N, D, { seed: 1, pca });
  st.step(0);
  assert.ok(st.done, "one unit is enough when the pca is given");
  assert.strictEqual(st.result.pca, pca);
});

test("makeCentre gives centre()'s bytes at any budget", () => {
  const m = math();
  const N = 2000;
  const D = 600;
  const X = gaussData(N, D, 2);
  const a = m.centre(X, N, D);
  for (const budget of [0, 0.1, Infinity]) {
    const st = m.makeCentre(X, N, D);
    const calls = drive(st, budget);
    if (budget === 0) assert.ok(calls > 1, "centring 2000 x 600 is sliced");
    assert.ok(same(a.mean, st.result.mean));
    assert.ok(same(a.data, st.result.data));
  }
});

test("the steppers divide a large fit into many small units", () => {
  const m = math();
  const N = 3000;
  const D = 256;
  const Y = m.centre(gaussData(N, D, 3), N, D).data;
  const st = m.makePrincipalDirections(Y, N, D, 8, { seed: 1 });
  const units = drive(st, 0); // step(0) runs exactly one unit
  // one covariance application alone is N * D * 16 multiply-adds, about 12 units
  assert.ok(units > 50, `only ${units} units`);
  const blocking = m.principalDirections(Y, N, D, 8, { seed: 1 });
  assertSamePca(st.result, blocking, "units");
});

test("progress rises from 0 to 1 and never falls", () => {
  const m = math();
  const N = 1500;
  const D = 128;
  const Y = m.centre(gaussData(N, D, 4), N, D).data;
  const st = m.makeGuidedTour(Y, N, D, { seed: 2 });
  assert.strictEqual(st.progress, 0);
  let last = 0;
  while (!st.done) {
    st.step(0);
    assert.ok(st.progress >= last && st.progress <= 1, `progress ${st.progress} after ${last}`);
    last = st.progress;
  }
  assert.strictEqual(st.progress, 1);
});

test("the steppers check their arguments when made, like the blocking calls", () => {
  const m = math();
  const Y = new Float32Array(40);
  assert.throws(() => m.makePrincipalDirections(Y, 10, 4, 2, { maxIterations: -1 }), { name: "RangeError" });
  assert.throws(() => m.makePrincipalDirections(Y, 11, 4, 2), { name: "RangeError" });
  assert.throws(() => m.makeGuidedTour(Y, 10, 4, { subspace: 2 }), { name: "RangeError" });
  assert.throws(() => m.makeCentre(Y, 3, 0), { name: "RangeError" });
});

test("step after done is a no-op that returns true", () => {
  const m = math();
  const Y = m.centre(gaussData(50, 10, 5), 50, 10).data;
  const st = m.makePrincipalDirections(Y, 50, 10, 3, { seed: 1 });
  assert.strictEqual(st.step(), true);
  const r = st.result;
  assert.strictEqual(st.step(0), true);
  assert.strictEqual(st.result, r);
});

test("reported shares are clamped to [0, 1] (no floating-point overshoot on tiny sets)", () => {
  const m = math();
  // Found by search: 2 to 5 Gaussian points whose fitted directions span them exactly
  // used to report shares like 1.0000000124.
  let checked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rng = m.makeRandom(seed);
    const N = 2 + (seed % 4);
    const D = 8 + (seed % 5) * 7;
    const X = new Float32Array(N * D);
    rng.fillGauss(X);
    const Y = m.centre(X, N, D).data;
    const p = m.principalDirections(Y, N, D, 3, { seed });
    const vs = m.varianceShare(Y, N, D, p.directions, 3);
    const t = m.guidedTour(Y, N, D, { seed, subspace: 3 });
    for (const s of [vs, p.share, t.varianceShare, ...p.shares]) {
      assert.ok(s >= 0 && s <= 1, `seed ${seed}: share ${s}`);
    }
    if (Math.abs(vs - 1) < 1e-6) checked++;
  }
  assert.ok(checked > 10, "the search covers sets whose span holds all the variance");
});
