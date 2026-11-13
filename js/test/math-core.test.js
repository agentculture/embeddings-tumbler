"use strict";
// ET.math: seeded random source, centring, orthonormal frames, linear projection.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, SRC_DIR } = require("./helpers/load.js");
const { rngFrom } = require("./helpers/math-fixtures.js");

const math = () => loadSources(["10-math.js"])._internal.math;
const DIMS = [384, 768, 1024, 2560];

// The reference's generator, copied verbatim, to prove the port draws the same stream.
function referenceMulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBlock(N, D, seed) {
  const rng = rngFrom(seed);
  const X = new Float32Array(N * D);
  for (let i = 0; i < X.length; i++) X[i] = rng.gauss() + 0.3;
  return X;
}

test("mulberry32 draws the reference's stream", () => {
  const m = math();
  const a = m.mulberry32(20261113);
  const b = referenceMulberry32(20261113);
  for (let i = 0; i < 1000; i++) assert.strictEqual(a(), b());
});

test("makeRandom: same seed same stream, different seed different stream", () => {
  const m = math();
  const a = m.makeRandom(42);
  const b = math().makeRandom(42);
  const c = m.makeRandom(43);
  const sa = [];
  const sb = [];
  const sc = [];
  for (let i = 0; i < 200; i++) {
    sa.push(a.gauss(), a.next());
    sb.push(b.gauss(), b.next());
    sc.push(c.gauss(), c.next());
  }
  assert.deepStrictEqual(sa, sb);
  assert.notDeepStrictEqual(sa, sc);
});

test("gauss has mean about 0 and variance about 1", () => {
  const r = math().makeRandom(5);
  let s = 0;
  let s2 = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const g = r.gauss();
    s += g;
    s2 += g * g;
  }
  assert.ok(Math.abs(s / n) < 0.03);
  assert.ok(Math.abs(s2 / n - 1) < 0.05);
});

test("seeds: strings hash stably, mixSeed separates streams, bad seeds are refused", () => {
  const m = math();
  assert.strictEqual(m.toSeed("tumble"), math().toSeed("tumble"));
  assert.notStrictEqual(m.toSeed("tumble"), m.toSeed("tumblf"));
  assert.strictEqual(m.toSeed(7.9), 7);
  assert.notStrictEqual(m.mixSeed(1, 0), m.mixSeed(1, 1));
  assert.notStrictEqual(m.mixSeed(1, 0), m.mixSeed(2, 0));
  assert.throws(() => m.toSeed({}), { name: "TypeError" });
  assert.throws(() => m.toSeed(NaN), { name: "TypeError" });
});

for (const D of DIMS) {
  test(`centre at ${D}-d: zero mean, pairwise distances unchanged`, () => {
    const m = math();
    const N = D === 2560 ? 12 : 40;
    const X = randomBlock(N, D, D);
    const { mean, data } = m.centre(X, N, D);
    assert.strictEqual(mean.length, D);
    assert.strictEqual(data.length, N * D);
    for (let d = 0; d < D; d++) {
      let s = 0;
      for (let i = 0; i < N; i++) s += data[i * D + d];
      assert.ok(Math.abs(s / N) < 1e-5);
    }
    const dist = (A, i, j) => {
      let s = 0;
      for (let d = 0; d < D; d++) s += (A[i * D + d] - A[j * D + d]) ** 2;
      return Math.sqrt(s);
    };
    for (const [i, j] of [
      [0, 1],
      [2, N - 1],
    ]) {
      assert.ok(Math.abs(dist(X, i, j) - dist(data, i, j)) < 1e-4 * dist(X, i, j));
    }
  });

  test(`orthonormalize at ${D}-d gives rows orthonormal to 1e-5`, () => {
    const m = math();
    const F = m.randomFrame(D, m.makeRandom(D));
    assert.strictEqual(F.length, 3 * D);
    assert.strictEqual(Object.prototype.toString.call(F), "[object Float32Array]");
    assert.ok(m.frameError(F, 3, D) < 1e-5);
  });
}

test("orthonormalize repairs degenerate rows deterministically", () => {
  const m = math();
  const D = 384;
  const F = new Float32Array(3 * D);
  for (let d = 0; d < D; d++) {
    F[d] = Math.sin(d);
    F[D + d] = 2 * Math.sin(d); // parallel to row 0
    F[2 * D + d] = 0; // zero row
  }
  const G = new Float32Array(F);
  m.orthonormalize(F, 3, D);
  math().orthonormalize(G, 3, D);
  assert.ok(m.frameError(F, 3, D) < 1e-5);
  assert.deepStrictEqual(Array.from(F), Array.from(G));
  assert.throws(() => m.orthonormalize(new Float32Array(8), 4, 2), { name: "RangeError" });
});

test("project is a linear map of the centred data", () => {
  const m = math();
  const D = 1024;
  const N = 20;
  const X = randomBlock(N, D, 3);
  const Z = randomBlock(N, D, 4);
  const F = m.randomFrame(D, m.makeRandom(1));
  const a = 1.7;
  const b = -0.4;
  const C = new Float32Array(N * D);
  for (let i = 0; i < C.length; i++) C[i] = a * X[i] + b * Z[i];
  const pX = m.project(X, N, D, F, null);
  const pZ = m.project(Z, N, D, F, null);
  const pC = m.project(C, N, D, F, null);
  for (let i = 0; i < N * 3; i++) {
    assert.ok(Math.abs(pC[i] - (a * pX[i] + b * pZ[i])) < 1e-3 * (1 + Math.abs(pC[i])));
  }
  // Projecting centred data equals the frame applied to x - mean, computed here by hand.
  const { mean, data } = m.centre(X, N, D);
  const p1 = m.project(data, N, D, F, null);
  const p2 = m.project(X, N, D, F, mean);
  for (let i = 0; i < N; i++) {
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += (X[i * D + d] - mean[d]) * F[r * D + d];
      assert.ok(Math.abs(p1[i * 3 + r] - s) < 1e-4);
      assert.ok(Math.abs(p2[i * 3 + r] - s) < 1e-4);
    }
  }
});

test("the module exports exactly the linear tool set and contains no non-linear layout", () => {
  const m = math();
  assert.deepStrictEqual(Object.keys(m).sort(), [
    "alignTo",
    "blendFrames",
    "centre",
    "frameError",
    "frameSeparation",
    "groupSeparation",
    "guidedTour",
    "hiddenDirection",
    "knn",
    "localFrame",
    "makeKnn",
    "makeRandom",
    "makeSwapTour",
    "makeTour",
    "meanOf",
    "mixSeed",
    "mulberry32",
    "orthonormalize",
    "principalDirections",
    "project",
    "randomFrame",
    "smoothstep",
    "swapAngle",
    "swapStep",
    "symmetricEigen",
    "toSeed",
    "totalVariance",
    "varianceShare",
  ]);
  const src = fs.readFileSync(path.join(SRC_DIR, "10-math.js"), "utf8");
  assert.doesNotMatch(src, /umap|t-?sne|isomap|\bmds\b|laplacian|embedding layout/i);
});

test("dimension is taken from the input, never assumed", () => {
  const src = fs.readFileSync(path.join(SRC_DIR, "10-math.js"), "utf8");
  for (const n of ["384", "768", "1024", "2560"]) assert.ok(!src.includes(n), `literal ${n} in module`);
  const m = math();
  assert.throws(() => m.centre(new Float32Array(10), 3, 4), { name: "RangeError" });
  assert.throws(() => m.centre(new Float32Array(10), 2, 0), { name: "RangeError" });
});
