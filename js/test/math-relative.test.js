"use strict";
// ET.math, the relative frame (task t2 of the relative-search plan): search
// directions made orthonormal, the remainder fit (blocking and sliced), the tour
// of one, two or three rows, the relative tour, the ruler's window and the
// unit-length check. Binding names and constants: docs/relative-interface.md,
// "Maths (t2): additions to ET.math".
//
// Large arrays are never handed to an equality assertion: comparisons loop and
// report the first differing index.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { rngFrom } = require("./helpers/math-fixtures.js");

const math = () => loadSources(["10-math.js"])._internal.math;

const FIX = path.join(ROOT, "tests", "fixtures", "relative");
const TIMES = [0, 0.7, 3.1, 10, 25.5, 60, 123.4, 500, 1000, 3600];

function loadFixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".json"), "utf8"));
  const buf = fs.readFileSync(path.join(FIX, meta.vectors.file));
  const D = meta.dimension;
  const N = meta.count;
  assert.strictEqual(buf.length, N * D * 4, name + ": block length");
  const X = new Float32Array(N * D);
  for (let i = 0; i < N * D; i++) X[i] = buf.readFloatLE(i * 4);
  const byLabel = {};
  meta.points.forEach((p, i) => {
    byLabel[p.label] = i;
  });
  return { X, N, D, byLabel };
}

let wikiCache = null;
let mixedCache = null;
const wiki = () => (wikiCache ||= loadFixture("wikipedia-subset"));
const mixed = () => (mixedCache ||= loadFixture("mixed-length"));

function row(X, i, D) {
  return X.slice(i * D, (i + 1) * D);
}

function dotRows(A, ia, B, ib, D) {
  let s = 0;
  for (let d = 0; d < D; d++) s += A[ia * D + d] * B[ib * D + d];
  return s;
}

function lengthOf(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

// The first index where two typed arrays differ in their bytes, or -1.
function firstDiff(A, B) {
  if (A === null || B === null) return A === B ? -1 : 0;
  if (A.length !== B.length) return Math.min(A.length, B.length);
  const a = Buffer.from(A.buffer, A.byteOffset, A.byteLength);
  const b = Buffer.from(B.buffer, B.byteOffset, B.byteLength);
  if (a.equals(b)) return -1;
  const per = A.BYTES_PER_ELEMENT;
  for (let i = 0; i < A.length; i++) {
    if (!a.subarray(i * per, (i + 1) * per).equals(b.subarray(i * per, (i + 1) * per))) return i;
  }
  return -1;
}

function assertSameArray(A, B, what) {
  const i = firstDiff(A, B);
  assert.ok(i === -1, what + ": first difference at index " + i);
}

function drive(st, budget) {
  let calls = 0;
  while (!st.done) {
    st.step(budget);
    calls++;
    assert.ok(calls < 1e7, "the stepper never finished");
  }
  return calls;
}

function assertSameFit(a, b, what) {
  assert.strictEqual(a.count, b.count, what + ": count");
  assertSameArray(a.directions, b.directions, what + ": directions");
  assertSameArray(a.basis, b.basis, what + ": basis");
  assertSameArray(a.variances, b.variances, what + ": variances");
  assert.ok(Object.is(a.share, b.share), what + ": share");
  assert.ok(Object.is(a.totalVariance, b.totalVariance), what + ": totalVariance");
  assert.strictEqual(a.subspace, b.subspace, what + ": subspace");
  assert.strictEqual(a.fittedRows, b.fittedRows, what + ": fittedRows");
  assert.strictEqual(a.rank, b.rank, what + ": rank");
  assert.strictEqual(a.fixed, b.fixed, what + ": fixed");
  assert.strictEqual(a.method, b.method, what + ": method");
  assert.deepStrictEqual(a.pinned, b.pinned, what + ": pinned");
  assert.deepStrictEqual(a.dropped, b.dropped, what + ": dropped");
  assert.deepStrictEqual(a.window, b.window, what + ": window");
  assert.deepStrictEqual(a.unit, b.unit, what + ": unit");
}

// Every frame of a relative tour at the ten times: three orthonormal rows, finite.
function assertThreeRows(m, tour, D, what) {
  for (const t of TIMES) {
    const F = tour.frameAt(t);
    assert.strictEqual(F.length, 3 * D, what + ": frame length");
    for (let i = 0; i < F.length; i++) assert.ok(Number.isFinite(F[i]), what + ": finite at " + i);
    const err = m.frameError(F, 3, D);
    assert.ok(err < 1e-5, what + ": frame error " + err + " at t " + t);
  }
}

function tourOf(m, fit, D, opts) {
  return m.makeRelativeTour(fit.directions, fit.count, fit.basis, fit.subspace, D, opts || { seed: 7 });
}

// ----- constants and the docs page --------------------------------------------

test("the constants are the values docs/relative-interface.md gives", () => {
  const m = math();
  const page = fs.readFileSync(path.join(ROOT, "docs", "relative-interface.md"), "utf8");
  for (const name of ["RELATIVE_UNIT_TOLERANCE", "RELATIVE_ZERO_LENGTH", "RELATIVE_SAME_DIRECTION"]) {
    const re = new RegExp("\\| `ET\\.math\\." + name + "` \\| `([^`]+)` \\|");
    const found = re.exec(page);
    assert.ok(found, name + " is in the constants table of the interface page");
    assert.strictEqual(m[name], Number(found[1]), name);
  }
  assert.strictEqual(m.RELATIVE_UNIT_TOLERANCE, 1e-3);
  assert.strictEqual(m.RELATIVE_ZERO_LENGTH, 1e-9);
  assert.strictEqual(m.RELATIVE_SAME_DIRECTION, 1e-6);
});

// ----- relativeDirections -----------------------------------------------------

test("relativeDirections: Rice and Wheat pin two orthonormal axes, the first exactly Rice's direction", () => {
  const m = math();
  const { X, D, byLabel } = wiki();
  const rice = row(X, byLabel.Rice, D);
  const wheat = row(X, byLabel.Wheat, D);
  const cos = dotRows(rice, 0, wheat, 0, D) / (lengthOf(rice) * lengthOf(wheat));
  assert.ok(cos > 0.75 && cos < 0.9, "Rice and Wheat have cosine about 0.82 (" + cos + ")");
  const r = m.relativeDirections([rice, wheat], D);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.directions.length, 2 * D);
  assert.ok(r.directions instanceof Float32Array);
  assert.deepStrictEqual(r.dropped, []);
  assert.deepStrictEqual(
    r.pinned.map((p) => p.index),
    [0, 1]
  );
  assert.ok(Math.abs(r.pinned[0].length - lengthOf(rice)) < 1e-12);
  assert.ok(Math.abs(r.pinned[1].length - lengthOf(wheat)) < 1e-12);
  assert.ok(m.frameError(r.directions, 2, D) < 1e-6);
  // Row 0 is Rice's unit direction, rounded to float32 once.
  const len = lengthOf(rice);
  for (let d = 0; d < D; d++) assert.strictEqual(r.directions[d], Math.fround(rice[d] / len), "row 0 at " + d);
  // Row 1 lies in the plane of Rice and Wheat: Wheat's unit direction is in the span.
  const wl = lengthOf(wheat);
  const a = dotRows(wheat, 0, r.directions, 0, D) / wl;
  const b = dotRows(wheat, 0, r.directions, 1, D) / wl;
  assert.ok(Math.abs(a * a + b * b - 1) < 1e-6, "Wheat is in the span of the two rows");
  assert.ok(b > 0, "row 1 points towards Wheat");
});

test("relativeDirections: the same query twice pins one axis, the second dropped as same-direction", () => {
  const m = math();
  const { X, D, byLabel } = wiki();
  const rice = row(X, byLabel.Rice, D);
  const r = m.relativeDirections([rice, new Float32Array(rice)], D);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.directions.length, D);
  assert.deepStrictEqual(r.pinned, [{ index: 0, length: r.pinned[0].length }]);
  assert.deepStrictEqual(r.dropped, [{ index: 1, reason: "same-direction", against: [0] }]);
  // A Float64 copy scaled by a half points the same way too.
  const half = Float64Array.from(rice, (x) => x * 0.5);
  const r2 = m.relativeDirections([rice, half], D);
  assert.deepStrictEqual(r2.dropped, [{ index: 1, reason: "same-direction", against: [0] }]);
  // A third search the same as the first, after a different second, is compared with both.
  const wheat = row(X, byLabel.Wheat, D);
  const r3 = m.relativeDirections([rice, wheat, rice], D);
  assert.strictEqual(r3.count, 2);
  assert.deepStrictEqual(r3.dropped, [{ index: 2, reason: "same-direction", against: [0, 1] }]);
});

test("relativeDirections: zero-length queries are dropped, a fourth search has no axis left", () => {
  const m = math();
  const { X, D, byLabel } = wiki();
  const zero = new Float32Array(D);
  const tiny = new Float64Array(D);
  tiny[3] = 1e-10;
  const qs = ["Rice", "Wheat", "Maize", "Bean", "Bread"].map((l) => row(X, byLabel[l], D));
  const r = m.relativeDirections([zero, qs[0], tiny, qs[1], qs[2], qs[3], qs[4]], D);
  assert.strictEqual(r.count, 3);
  assert.deepStrictEqual(
    r.pinned.map((p) => p.index),
    [1, 3, 4]
  );
  assert.deepStrictEqual(r.dropped, [
    { index: 0, reason: "zero-length", against: [] },
    { index: 2, reason: "zero-length", against: [] },
    { index: 5, reason: "no-axis-left", against: [] },
    { index: 6, reason: "no-axis-left", against: [] },
  ]);
  assert.ok(m.frameError(r.directions, 3, D) < 1e-6);
  // Nothing at all, or only a zero query: no axis, no throw.
  const none = m.relativeDirections([], D);
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.directions.length, 0);
  const z = m.relativeDirections([zero], D);
  assert.strictEqual(z.count, 0);
  assert.deepStrictEqual(z.dropped, [{ index: 0, reason: "zero-length", against: [] }]);
});

test("relativeDirections: malformed calls throw, D below 3 is a RangeError", () => {
  const m = math();
  assert.throws(() => m.relativeDirections([new Float32Array(2)], 2), RangeError);
  assert.throws(() => m.relativeDirections([], 2), RangeError);
  assert.throws(() => m.relativeDirections([new Float32Array(4)], 5), TypeError);
  assert.throws(() => m.relativeDirections(null, 5), TypeError);
});

// ----- criterion 1: the pinned row is the height, free rows are orthogonal ---------

for (const [label, fixture] of [
  ["Wikipedia", wiki],
  ["mixed-length", mixed],
]) {
  test(`criterion 1 (${label}): row 1 dotted with each point is its height, free rows orthogonal at ten times`, () => {
    const m = math();
    const { X, N, D, byLabel } = fixture();
    const rice = row(X, byLabel.Rice, D);
    const wheat = row(X, byLabel.Wheat, D);
    const avg = new Float32Array(D);
    for (let d = 0; d < D; d++) avg[d] = (rice[d] + wheat[d]) / 2;
    for (const queries of [[rice], [avg], [rice, wheat]]) {
      const fit = m.relativeFit(X, N, D, queries, { seed: 3 });
      assert.strictEqual(fit.count, queries.length);
      const tour = tourOf(m, fit, D);
      const q = queries[0];
      const ql = lengthOf(q);
      // The direct heights, in double precision from the raw query.
      const direct = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let s = 0;
        for (let d = 0; d < D; d++) s += X[i * D + d] * (q[d] / ql);
        direct[i] = s;
      }
      const pinnedRows = queries.length === 1 ? [1] : [1, 0];
      const freeRows = queries.length === 1 ? [0, 2] : [2];
      let worstHeight = 0;
      let worstOrth = 0;
      for (const t of TIMES) {
        const F = tour.frameAt(t);
        assert.ok(m.frameError(F, 3, D) < 1e-5, "orthonormal at t " + t);
        for (let i = 0; i < N; i++) {
          worstHeight = Math.max(worstHeight, Math.abs(dotRows(F, 1, X, i, D) - direct[i]));
        }
        for (const f of freeRows) {
          for (const p of pinnedRows) worstOrth = Math.max(worstOrth, Math.abs(dotRows(F, f, F, p, D)));
        }
      }
      assert.ok(worstHeight < 1e-5, "row 1 . x equals x . u within 1e-5 (worst " + worstHeight + ")");
      assert.ok(worstOrth < 1e-6, "free rows orthogonal to pinned rows below 1e-6 (worst " + worstOrth + ")");
      // The second pinned row is the second direction itself.
      if (queries.length === 2) {
        const F = tour.frameAt(42);
        for (let d = 0; d < D; d++) assert.strictEqual(F[d], fit.directions[D + d], "row 0 is direction 1 at " + d);
      }
    }
  });
}

// ----- criterion 2: the remainder fit, sliced, and its share ------------------

// The remainder share recomputed independently: the set's mean over all rows,
// the rows taken at the fit's even stride, the pinned directions removed from
// each, then held / total by the basis rows.
function recomputeRemainderShare(X, N, D, fit, S) {
  const mean = new Float64Array(D);
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) mean[d] += X[i * D + d];
  for (let d = 0; d < D; d++) mean[d] /= N;
  const v = new Float64Array(D);
  let total = 0;
  let held = 0;
  for (let s = 0; s < S; s++) {
    const src = Math.floor((s * N) / S);
    for (let d = 0; d < D; d++) v[d] = X[src * D + d] - mean[d];
    for (let pass = 0; pass < 2; pass++) {
      for (let p = 0; p < fit.count; p++) {
        let dp = 0;
        for (let d = 0; d < D; d++) dp += v[d] * fit.directions[p * D + d];
        for (let d = 0; d < D; d++) v[d] -= dp * fit.directions[p * D + d];
      }
    }
    for (let d = 0; d < D; d++) total += v[d] * v[d];
    for (let k = 0; k < fit.subspace; k++) {
      let p = 0;
      for (let d = 0; d < D; d++) p += v[d] * fit.basis[k * D + d];
      held += p * p;
    }
  }
  return { share: held / total, total: total / S };
}

test("criterion 2: the remainder fit pumped in one step and in one-unit steps is bit-identical", () => {
  const m = math();
  const { X, N, D, byLabel } = wiki();
  const queries = [row(X, byLabel.Rice, D), row(X, byLabel.Wheat, D)];
  for (const opts of [{ seed: 5 }, { seed: 5, sampleRows: 60 }]) {
    const blocking = m.relativeFit(X, N, D, queries, opts);
    const once = m.makeRelativeFit(X, N, D, queries, opts);
    assert.strictEqual(once.done, false);
    assert.strictEqual(once.result, null);
    assert.strictEqual(once.step(), true);
    const units = m.makeRelativeFit(X, N, D, queries, opts);
    const calls = drive(units, 0);
    assert.ok(calls > 3, "the work is divided into several units (" + calls + ")");
    assert.strictEqual(units.progress, 1);
    assertSameFit(once.result, units.result, "one step vs one-unit steps");
    assertSameFit(blocking, units.result, "blocking vs one-unit steps");
  }
});

test("criterion 2: the share is of the remainder on the rows fitted, held / total within 1e-9", () => {
  const m = math();
  const { X, N, D, byLabel } = wiki();
  const rice = row(X, byLabel.Rice, D);
  const wheat = row(X, byLabel.Wheat, D);
  for (const [queries, opts] of [
    [[rice], { seed: 1 }],
    [[rice, wheat], { seed: 2 }],
    [[rice], { seed: 3, sampleRows: 50 }],
    [[rice, wheat], { seed: 4, sampleRows: 37, subspace: 5 }],
  ]) {
    const fit = m.relativeFit(X, N, D, queries, opts);
    const S = opts.sampleRows && opts.sampleRows < N ? opts.sampleRows : N;
    assert.strictEqual(fit.fittedRows, S);
    const want = Math.min(opts.subspace || 8, D - fit.count);
    assert.strictEqual(fit.subspace, want);
    assert.strictEqual(fit.basis.length, want * D);
    assert.strictEqual(fit.variances.length, want);
    assert.strictEqual(fit.rank, Math.min(S - 1, D - fit.count));
    assert.strictEqual(fit.fixed, 0);
    assert.ok(typeof fit.method === "string" && fit.method.length > 0);
    if (S < N) assert.ok(fit.method.endsWith("-sampled"), "a sampled fit says so: " + fit.method);
    // The basis: orthonormal, orthogonal to every pinned direction.
    assert.ok(m.frameError(fit.basis, fit.subspace, D) < 1e-6);
    for (let k = 0; k < fit.subspace; k++) {
      for (let p = 0; p < fit.count; p++) {
        assert.ok(Math.abs(dotRows(fit.basis, k, fit.directions, p, D)) < 1e-6, "basis " + k + " against pinned " + p);
      }
    }
    const again = recomputeRemainderShare(X, N, D, fit, S);
    assert.ok(Math.abs(fit.share - again.share) < 1e-9, "share " + fit.share + " vs " + again.share);
    assert.ok(Math.abs(fit.totalVariance - again.total) < 1e-9 * again.total, "total variance of the remainder");
    let held = 0;
    for (const v of fit.variances) held += v;
    assert.ok(Math.abs(fit.share - held / fit.totalVariance) < 1e-12, "share = sum of variances / total");
    // It is not the share of the whole set: the whole set's total includes the pinned spread.
    const { data } = m.centre(X, N, D);
    assert.ok(fit.totalVariance < m.totalVariance(data, N, D), "the remainder holds less than the whole set");
  }
});

// ----- criterion 3: degenerate cases ------------------------------------------

test("criterion 3: a zero query names its reason and never throws; with another search the frame has three rows", () => {
  const m = math();
  const { X, N, D, byLabel } = wiki();
  const zero = new Float32Array(D);
  const alone = m.relativeFit(X, N, D, [zero], { seed: 1 });
  assert.strictEqual(alone.count, 0);
  assert.deepStrictEqual(alone.dropped, [{ index: 0, reason: "zero-length", against: [] }]);
  assert.strictEqual(alone.basis, null);
  assert.strictEqual(alone.subspace, 0);
  assert.strictEqual(alone.window, null);
  assert.strictEqual(alone.unit.unit, true);
  // A relative tour needs at least one pinned axis: with none, Tumble shows its plain tour.
  assert.throws(() => m.makeRelativeTour(alone.directions, 0, null, 0, D), RangeError);
  const withRice = m.relativeFit(X, N, D, [zero, row(X, byLabel.Rice, D)], { seed: 1 });
  assert.strictEqual(withRice.count, 1);
  assert.deepStrictEqual(withRice.dropped, [{ index: 0, reason: "zero-length", against: [] }]);
  assertThreeRows(m, tourOf(m, withRice, D), D, "zero then Rice");
  // Through the stepper as well.
  const st = m.makeRelativeFit(X, N, D, [zero], {});
  drive(st, 0);
  assert.strictEqual(st.result.count, 0);
});

test("criterion 3: two identical queries give three rows and the reason same-direction", () => {
  const m = math();
  const { X, N, D, byLabel } = wiki();
  const rice = row(X, byLabel.Rice, D);
  const fit = m.relativeFit(X, N, D, [rice, rice], { seed: 2 });
  assert.strictEqual(fit.count, 1);
  assert.deepStrictEqual(fit.dropped, [{ index: 1, reason: "same-direction", against: [0] }]);
  assertThreeRows(m, tourOf(m, fit, D), D, "identical queries");
});

test("criterion 3: a 3-dimensional set with one, two, three and four searches", () => {
  const m = math();
  const rng = rngFrom(11);
  const N = 40;
  const D = 3;
  const X = new Float32Array(N * D);
  for (let i = 0; i < X.length; i++) X[i] = rng.gauss() * (1 + (i % 3));
  const q = [
    new Float32Array([1, 0.2, 0]),
    new Float32Array([0.3, 1, 0.1]),
    new Float32Array([0, 0.4, 1]),
    new Float32Array([1, 1, 1]),
  ];
  for (let c = 1; c <= 4; c++) {
    const fit = m.relativeFit(X, N, D, q.slice(0, c), { seed: c });
    const pinned = Math.min(c, 3);
    assert.strictEqual(fit.count, pinned, c + " searches");
    assert.strictEqual(fit.subspace, 3 - pinned);
    assert.strictEqual(fit.fixed, 0);
    if (pinned === 3) {
      assert.strictEqual(fit.share, null);
      assert.strictEqual(fit.basis, null);
    } else {
      assert.ok(fit.share >= 0 && fit.share <= 1);
      // The free rows take all that is left of a 3-d space: the whole remainder (to the
      // accuracy of a float32 basis).
      assert.ok(Math.abs(fit.share - 1) < 1e-6, "the remainder share is 1 in 3-d (" + fit.share + ")");
    }
    if (c === 4) assert.deepStrictEqual(fit.dropped, [{ index: 3, reason: "no-axis-left", against: [] }]);
    else assert.deepStrictEqual(fit.dropped, []);
    const tour = tourOf(m, fit, D);
    assert.strictEqual(tour.pinned, pinned);
    assert.strictEqual(tour.free, 3 - pinned);
    assertThreeRows(m, tour, D, "3-d, " + c + " searches");
    if (pinned === 3) assertSameArray(tour.frameAt(0), tour.frameAt(77.7), "three pinned: the frame never moves");
  }
});

test("criterion 3: a set of 2 points gives three rows and names the filler rows", () => {
  const m = math();
  const { X, D, byLabel } = wiki();
  const two = new Float32Array(2 * D);
  two.set(row(X, byLabel.Rice, D), 0);
  two.set(row(X, byLabel.Maize, D), D);
  const one = m.relativeFit(two, 2, D, [row(X, byLabel.Wheat, D)], { seed: 1 });
  assert.strictEqual(one.count, 1);
  assert.strictEqual(one.fittedRows, 2);
  assert.strictEqual(one.rank, 1);
  assert.strictEqual(one.fixed, 1, "two free rows, one direction of spread: one is filler");
  assertThreeRows(m, tourOf(m, one, D), D, "2 points, one search");
  const both = m.relativeFit(two, 2, D, [row(X, byLabel.Wheat, D), row(X, byLabel.Bean, D)], { seed: 1 });
  assert.strictEqual(both.count, 2);
  assert.strictEqual(both.fixed, 0);
  assertThreeRows(m, tourOf(m, both, D), D, "2 points, two searches");
  // 2 points in 3-d, and a set of 1 and of 0 points: still no throw.
  const small = new Float32Array([1, 0, 0, 0, 1, 0]);
  const s3 = m.relativeFit(small, 2, 3, [new Float32Array([0, 0, 1])], {});
  assert.strictEqual(s3.fixed, 1);
  assertThreeRows(m, tourOf(m, s3, 3), 3, "2 points in 3-d");
  const s1 = m.relativeFit(small, 1, 3, [new Float32Array([0, 0, 1])], {});
  assert.strictEqual(s1.fixed, 2);
  assertThreeRows(m, tourOf(m, s1, 3), 3, "1 point in 3-d");
  const s0 = m.relativeFit(new Float32Array(0), 0, 3, [new Float32Array([0, 0, 1])], {});
  assert.strictEqual(s0.window.low, null);
  assert.strictEqual(s0.unit.unit, false);
  assertThreeRows(m, tourOf(m, s0, 3), 3, "no points in 3-d");
});

// ----- criterion 4: the window ------------------------------------------------

test("criterion 4: the window starts below zero for opposite vectors, ends at max(search length, highest point), over every point", () => {
  const m = math();
  const { X, N, D, byLabel } = wiki();
  const rice = row(X, byLabel.Rice, D);
  // The set with two rows opposite to the search appended at the end: -Rice and -0.5 Wheat.
  const N2 = N + 2;
  const X2 = new Float32Array(N2 * D);
  X2.set(X, 0);
  const wheat = row(X, byLabel.Wheat, D);
  for (let d = 0; d < D; d++) {
    X2[N * D + d] = -0.5 * wheat[d];
    X2[(N + 1) * D + d] = -rice[d];
  }
  const ul = lengthOf(rice);
  const u = Float64Array.from(rice, (x) => x / ul);
  // Direct heights over all rows.
  let low = Infinity;
  let high = -Infinity;
  let lowest = -1;
  let highest = -1;
  for (let i = 0; i < N2; i++) {
    let s = 0;
    for (let d = 0; d < D; d++) s += X2[i * D + d] * u[d];
    if (s < low) [low, lowest] = [s, i];
    if (s > high) [high, highest] = [s, i];
  }
  assert.strictEqual(lowest, N + 1, "the lowest point is -Rice, the last row");
  for (const scale of [0.6, 1.5]) {
    const q = Float64Array.from(rice, (x) => x * scale);
    const w = m.heightWindow(X2, N2, D, u, lengthOf(q));
    assert.ok(w.low < 0, "starts below zero");
    assert.ok(Math.abs(w.low - low) < 1e-9);
    assert.ok(Math.abs(w.pointHigh - high) < 1e-9);
    assert.strictEqual(w.lowest, lowest);
    assert.strictEqual(w.highest, highest);
    assert.strictEqual(w.high, Math.max(lengthOf(q), w.pointHigh));
    if (scale < 1) assert.strictEqual(w.high, w.pointHigh, "a short search: the highest point ends it");
    else assert.strictEqual(w.high, lengthOf(q), "a long search: its length ends it");
    // Through the fit, fitted on 10 rows at a stride that never visits the last row:
    // the window still comes from every point.
    const fit = m.relativeFit(X2, N2, D, [q], { seed: 1, sampleRows: 10 });
    assert.strictEqual(fit.fittedRows, 10);
    for (let s = 0; s < 10; s++) assert.notStrictEqual(Math.floor((s * N2) / 10), N + 1);
    assert.strictEqual(fit.window.lowest, N + 1);
    assert.ok(Math.abs(fit.window.low - low) < 1e-6);
    assert.ok(Math.abs(fit.window.high - Math.max(lengthOf(q), high)) < 1e-6);
  }
  // No points: the window is the search's length alone.
  const empty = m.heightWindow(new Float32Array(0), 0, D, u, 0.8);
  assert.deepStrictEqual(empty, { low: null, high: 0.8, pointHigh: null, lowest: null, highest: null });
  // Ties go to the lower index.
  const tie = m.heightWindow(new Float32Array([1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0]), 4, 3, new Float32Array([1, 0, 0]), 1);
  assert.strictEqual(tie.highest, 0);
  assert.strictEqual(tie.lowest, 2);
  assert.throws(() => m.heightWindow(X2, N2, D, new Float32Array(D - 1), 1), TypeError);
});

// ----- criterion 5: the unit-length check -------------------------------------

test("criterion 5: unitLength is true for the Wikipedia fixture and false for the mixed-length one", () => {
  const m = math();
  const page = fs.readFileSync(path.join(ROOT, "docs", "relative-interface.md"), "utf8");
  const tol = Number(/\| `ET\.math\.RELATIVE_UNIT_TOLERANCE` \| `([^`]+)` \|/.exec(page)[1]);
  const w = wiki();
  const a = m.unitLength(w.X, w.N, w.D);
  assert.strictEqual(a.unit, true);
  assert.strictEqual(a.tolerance, tol);
  assert.ok(Math.abs(a.min - 1) < tol && Math.abs(a.max - 1) < tol);
  const x = mixed();
  const b = m.unitLength(x.X, x.N, x.D);
  assert.strictEqual(b.unit, false);
  assert.strictEqual(b.tolerance, tol);
  assert.ok(b.min > 0.3 && b.min < 0.4, "shortest about 0.35 (" + b.min + ")");
  assert.ok(Math.abs(b.max - 1) < tol, "longest about 1 (" + b.max + ")");
  // The fit reports the same check over all rows.
  const fit = m.relativeFit(x.X, x.N, x.D, [row(x.X, x.byLabel.Rice, x.D)], { sampleRows: 20 });
  assert.deepStrictEqual(fit.unit, b);
  // A tolerance can be given; none of the rows gives null lengths.
  assert.strictEqual(m.unitLength(x.X, x.N, x.D, 0.7).unit, true);
  assert.deepStrictEqual(m.unitLength(new Float32Array(0), 0, 4), { unit: false, min: null, max: null, tolerance: tol });
});

// ----- makeTourRows and makeRelativeTour --------------------------------------

test("makeTourRows: one, two or three rows, orthonormal and inside the span; three rows match makeTour", () => {
  const m = math();
  const rng = rngFrom(21);
  const D = 64;
  const basisFor = (k) => {
    const B = new Float32Array(k * D);
    for (let i = 0; i < B.length; i++) B[i] = rng.gauss();
    return m.orthonormalize(B, k, D);
  };
  const B8 = basisFor(8);
  const three = m.makeTourRows(B8, 8, D, 3, { seed: 9 });
  const plain = m.makeTour(B8, 8, D, { seed: 9 });
  for (const t of TIMES) assertSameArray(three.rowsAt(t), plain.frameAt(t), "three rows vs makeTour at " + t);
  for (const [k, rows] of [
    [1, 1],
    [2, 1],
    [2, 2],
    [5, 2],
    [8, 1],
    [3, 3],
  ]) {
    const B = basisFor(k);
    const tour = m.makeTourRows(B, k, D, rows, { seed: k * 10 + rows });
    assert.strictEqual(tour.kind, "tour-rows");
    assert.strictEqual(tour.rows, rows);
    assert.strictEqual(tour.subspace, k);
    assert.strictEqual(tour.dimension, D);
    const twin = m.makeTourRows(B, k, D, rows, { seed: k * 10 + rows });
    for (const t of TIMES) {
      const R = tour.rowsAt(t);
      assert.strictEqual(R.length, rows * D);
      assert.ok(m.frameError(R, rows, D) < 1e-5);
      for (let r = 0; r < rows; r++) {
        let inSpan = 0;
        for (let j = 0; j < k; j++) inSpan += dotRows(R, r, B, j, D) ** 2;
        assert.ok(Math.abs(inSpan - 1) < 1e-5, "row " + r + " inside the span");
      }
      assertSameArray(R, twin.rowsAt(t), "same seed, same rows");
    }
    if (k === 1) assertSameArray(tour.rowsAt(0), tour.rowsAt(99), "one direction: the row is constant");
  }
  assert.throws(() => m.makeTourRows(B8, 8, D, 0), RangeError);
  assert.throws(() => m.makeTourRows(B8, 8, D, 4), RangeError);
  assert.throws(() => m.makeTourRows(B8, 1, D, 2), RangeError);
  assert.throws(() => m.makeTourRows(B8, 9, D, 2), TypeError);
  assert.throws(() => three.rowsAt(Number.NaN), RangeError);
});

test("makeRelativeTour: pinned rows copied into rows 1, 0, 2; free rows tour; malformed calls throw", () => {
  const m = math();
  const { X, N, D, byLabel } = wiki();
  const qs = ["Rice", "Wheat", "Maize"].map((l) => row(X, byLabel[l], D));
  for (let c = 1; c <= 3; c++) {
    const fit = m.relativeFit(X, N, D, qs.slice(0, c), { seed: 4 });
    const tour = tourOf(m, fit, D, { seed: 12, speed: 0.5 });
    assert.strictEqual(tour.kind, "relative-tour");
    assert.strictEqual(tour.pinned, c);
    assert.strictEqual(tour.free, 3 - c);
    assert.strictEqual(tour.subspace, fit.subspace);
    assert.strictEqual(tour.dimension, D);
    const slot = [1, 0, 2];
    const F0 = tour.frameAt(0);
    const F1 = tour.frameAt(31.4);
    const out = new Float32Array(3 * D);
    assert.strictEqual(tour.frameAt(31.4, out), out);
    assertSameArray(out, F1, "out is filled the same");
    for (let p = 0; p < c; p++) {
      for (let d = 0; d < D; d++) {
        assert.strictEqual(F1[slot[p] * D + d], fit.directions[p * D + d], "pinned row " + slot[p] + " at " + d);
      }
    }
    if (c < 3) {
      // The free rows move.
      const f = slot[c];
      let moved = 0;
      for (let d = 0; d < D; d++) moved = Math.max(moved, Math.abs(F0[f * D + d] - F1[f * D + d]));
      assert.ok(moved > 1e-3, "free row " + f + " tours");
    }
  }
  const fit1 = m.relativeFit(X, N, D, [qs[0]], {});
  assert.throws(() => m.makeRelativeTour(fit1.directions, 4, fit1.basis, fit1.subspace, D), RangeError);
  assert.throws(() => m.makeRelativeTour(fit1.directions, 1, null, 0, D), RangeError);
  assert.throws(() => m.makeRelativeTour(fit1.directions, 2, fit1.basis, fit1.subspace, D), TypeError);
  assert.throws(() => tourOf(m, fit1, D).frameAt(Infinity), RangeError);
});

test("relativeFit: malformed calls throw", () => {
  const m = math();
  const { X, N, D } = wiki();
  assert.throws(() => m.relativeFit(X, N, 2, [], {}), RangeError);
  assert.throws(() => m.relativeFit(X, N + 1, D, [], {}), RangeError);
  assert.throws(() => m.relativeFit(X, N, D, [new Float32Array(3)], {}), TypeError);
  assert.throws(() => m.makeRelativeFit(X, N, D, [], { maxIterations: -1 }), RangeError);
  // No search at all: no tour, nothing thrown.
  const none = m.relativeFit(X, N, D, [], {});
  assert.strictEqual(none.count, 0);
  assert.strictEqual(none.share, null);
});
