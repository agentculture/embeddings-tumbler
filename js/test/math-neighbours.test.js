"use strict";
// ET.math: true nearest neighbours, local frames, alignment, axis swaps.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");
const { rngFrom, orthoRows } = require("./helpers/math-fixtures.js");

const math = () => loadSources(["10-math.js"])._internal.math;
const DIMS = [384, 768, 1024, 2560];

function block(N, D, seed) {
  const rng = rngFrom(seed);
  const X = new Float32Array(N * D);
  for (let i = 0; i < X.length; i++) X[i] = rng.gauss();
  return X;
}

// Brute force: sort every other point by (squared distance, index).
function bruteKnn(X, N, D, k) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const c = [];
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      let s = 0;
      for (let d = 0; d < D; d++) s += (X[i * D + d] - X[j * D + d]) ** 2;
      c.push([s, j]);
    }
    c.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    out.push(c.slice(0, k).map((e) => e[1]));
  }
  return out;
}

function dot(A, ia, B, ib, D) {
  let s = 0;
  for (let d = 0; d < D; d++) s += A[ia * D + d] * B[ib * D + d];
  return s;
}

for (const D of DIMS) {
  test(`knn at ${D}-d equals brute force in the full space`, () => {
    const m = math();
    const N = D === 2560 ? 25 : 60;
    const k = 6;
    const X = block(N, D, D);
    const r = m.knn(X, N, D, k);
    assert.strictEqual(r.k, k);
    assert.strictEqual(r.count, N);
    assert.ok(r.done);
    const expect = bruteKnn(X, N, D, k);
    for (let i = 0; i < N; i++) {
      assert.deepStrictEqual(Array.from(r.indices.subarray(i * k, i * k + k)), expect[i]);
      for (let q = 0; q < k; q++) {
        const j = r.indices[i * k + q];
        let s = 0;
        for (let d = 0; d < D; d++) s += (X[i * D + d] - X[j * D + d]) ** 2;
        assert.ok(Math.abs(r.distances[i * k + q] - Math.sqrt(s)) < 1e-4 * Math.sqrt(s));
      }
    }
  });
}

test("knn computed in slices equals knn computed at once", () => {
  const m = math();
  const N = 150;
  const D = 384;
  const X = block(N, D, 1);
  const whole = m.knn(X, N, D, 10, { limit: 120 });
  const s = m.makeKnn(X, N, D, 10, { limit: 120 });
  let calls = 0;
  while (!s.step(7)) calls++;
  assert.ok(calls > 10);
  assert.strictEqual(s.next, 120);
  assert.deepStrictEqual(Array.from(s.indices), Array.from(whole.indices));
  assert.deepStrictEqual(Array.from(s.distances), Array.from(whole.distances));
  // limit: only the first 120 points take part, as neighbours and as queries.
  assert.strictEqual(whole.indices.length, 120 * 10);
  assert.ok(Array.from(whole.indices).every((j) => j < 120));
});

test("knn breaks ties by index and clamps k", () => {
  const m = math();
  const D = 4;
  // Point 0 at the origin; points 1..4 all at distance 1.
  const X = new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const r = m.knn(X, 5, D, 3);
  assert.deepStrictEqual(Array.from(r.indices.subarray(0, 3)), [1, 2, 3]);
  assert.strictEqual(m.knn(X, 5, D, 99).k, 4);
  assert.strictEqual(m.knn(X, 1, D, 3).k, 0);
});

for (const D of [384, 2560]) {
  test(`localFrame at ${D}-d fits the neighbourhood's own plane`, () => {
    const m = math();
    const rng = rngFrom(D);
    const plane = orthoRows(3, D, rng);
    const M = 25;
    const X = new Float32Array(M * D);
    // Points spread along three planted directions with distinct spreads, plus tiny noise.
    for (let i = 0; i < M; i++) {
      const c = [4 * rng.gauss(), 2 * rng.gauss(), 1 * rng.gauss()];
      for (let d = 0; d < D; d++) {
        X[i * D + d] = 0.001 * rng.gauss();
        for (let a = 0; a < 3; a++) X[i * D + d] += c[a] * plane[a * D + d];
      }
    }
    const ids = Array.from({ length: M }, (_, i) => i);
    const F = m.localFrame(X, D, ids);
    assert.ok(m.frameError(F, 3, D) < 1e-5);
    for (let r = 0; r < 3; r++) {
      let inSpan = 0;
      for (let a = 0; a < 3; a++) inSpan += dot(F, r, plane, a, D) ** 2;
      assert.ok(inSpan > 0.999);
    }
    assert.deepStrictEqual(Array.from(math().localFrame(X, D, ids)), Array.from(F));
  });
}

test("localFrame stays orthonormal for a neighbourhood of rank below three", () => {
  const m = math();
  const D = 384;
  const X = new Float32Array(3 * D);
  for (let d = 0; d < D; d++) {
    X[D + d] = Math.cos(d);
    X[2 * D + d] = 2 * Math.cos(d);
  }
  const F = m.localFrame(X, D, [0, 1, 2]);
  assert.ok(m.frameError(F, 3, D) < 1e-5);
});

test("alignTo undoes a permutation and sign flips of the axes", () => {
  const m = math();
  const D = 1024;
  const ref = m.randomFrame(D, m.makeRandom(1));
  const target = new Float32Array(3 * D);
  // target rows = (-ref2, ref0, -ref1)
  for (let d = 0; d < D; d++) {
    target[d] = -ref[2 * D + d];
    target[D + d] = ref[d];
    target[2 * D + d] = -ref[D + d];
  }
  const out = m.alignTo(target, ref, D);
  assert.deepStrictEqual(Array.from(out), Array.from(ref));
  assert.deepStrictEqual(Array.from(math().alignTo(target, ref, D)), Array.from(out));
});

test("blendFrames goes from one frame to the other and stays orthonormal", () => {
  const m = math();
  const D = 768;
  const A = m.randomFrame(D, m.makeRandom(1));
  const B = m.alignTo(m.randomFrame(D, m.makeRandom(2)), A, D);
  const at0 = m.blendFrames(A, B, 0, D);
  const at1 = m.blendFrames(A, B, 1, D);
  for (let i = 0; i < 3 * D; i++) {
    assert.ok(Math.abs(at0[i] - A[i]) < 1e-5);
    assert.ok(Math.abs(at1[i] - B[i]) < 1e-5);
  }
  for (let u = 0; u <= 1; u += 0.125) {
    assert.ok(m.frameError(m.blendFrames(A, B, m.smoothstep(u), D), 3, D) < 1e-5);
  }
  assert.strictEqual(m.smoothstep(-1), 0);
  assert.strictEqual(m.smoothstep(2), 1);
  assert.strictEqual(m.smoothstep(0.5), 0.5);
});

test("swapStep turns one axis a quarter turn into a hidden direction", () => {
  const m = math();
  const D = 1024;
  const F = m.randomFrame(D, m.makeRandom(3));
  const h = m.hiddenDirection(F, D, m.makeRandom(4));
  for (let r = 0; r < 3; r++) assert.ok(Math.abs(dot(F, r, h, 0, D)) < 1e-5);
  const start = m.swapStep(F, 1, h, 0, D);
  assert.deepStrictEqual(Array.from(start), Array.from(F));
  const end = m.swapStep(F, 1, h, 1, D);
  assert.deepStrictEqual(Array.from(end.subarray(D, 2 * D)), Array.from(h));
  for (let u = 0; u <= 1; u += 0.1) assert.ok(m.frameError(m.swapStep(F, 1, h, u, D), 3, D) < 1e-5);
  assert.strictEqual(m.swapAngle(0), 0);
  assert.ok(Math.abs(m.swapAngle(1) - Math.PI / 2) < 1e-15);
});

for (const D of DIMS) {
  test(`swap tour at ${D}-d: deterministic, independent of slicing, orthonormal`, () => {
    const D0 = D;
    const run = () => {
      const m = math();
      const F0 = m.randomFrame(D0, m.makeRandom(5));
      return m.makeSwapTour(F0, D0, { seed: 6, period: 3.4 });
    };
    const a = run();
    const b = run();
    const direct = Array.from(b.frameAt(23.3));
    let last = null;
    for (let t = 0; t <= 23.3 + 1e-9; t += 23.3 / 233) last = a.frameAt(Math.min(t, 23.3));
    assert.deepStrictEqual(Array.from(last), direct);
    // backwards in time replays from the start and still agrees
    const early = Array.from(b.frameAt(1.2));
    assert.deepStrictEqual(Array.from(a.frameAt(1.2)), early);
    assert.deepStrictEqual(Array.from(a.frameAt(23.3)), direct);
    const m = math();
    for (const t of [0, 1.7, 3.4, 5, 10.2, 23.3]) assert.ok(m.frameError(a.frameAt(t), 3, D0) < 1e-5);
    const st = a.stateAt(23.3);
    assert.strictEqual(st.cycle, 6);
    assert.strictEqual(st.axis, 0);
  });
}

test("swap tour draws hidden directions inside a given basis", () => {
  const m = math();
  const D = 384;
  const basis = new Float32Array(orthoRows(8, D, rngFrom(9)));
  const F0 = new Float32Array(basis.subarray(0, 3 * D));
  const tour = m.makeSwapTour(F0, D, { seed: 1, basis, basisRows: 8 });
  for (const t of [0.5, 4, 8]) {
    const h = tour.hiddenAt(t);
    let inSpan = 0;
    for (let j = 0; j < 8; j++) inSpan += dot(h, 0, basis, j, D) ** 2;
    assert.ok(Math.abs(inSpan - 1) < 1e-5);
  }
});
