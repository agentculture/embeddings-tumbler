"use strict";
// A device that runs JavaScript without a compiler (the owner's iPhone, 2026-11-14: 6.7
// frames a second on 999 points in 1,024-d). There a multiply-add costs 40 to 90 ns, so
// three things that were fine on a desktop held every frame: a unit of preparation of up
// to 2^20 multiply-adds with no look at the clock inside it, a pass over the label sample
// in full dimension on every frame, and a pass over the zoom sample in full dimension on
// every frame. These tests load the assembled file and check each fix, and that no result
// depends on how the work was sliced.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { loadAssembled, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const ET = api._internal;
const math = ET.math;
const M = ET.modes;
const sample = require(path.join(ROOT, "js", "sample", "sample-data.js"));

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

// N clustered rows of D values, centred.
function centred(N, D, seed) {
  const r = rng(seed);
  const X = new Float32Array(N * D);
  for (let i = 0; i < N; i++) {
    const g = i % 5;
    for (let d = 0; d < D; d++) X[i * D + d] = r() + (d % 5 === g ? 0.7 : 0);
  }
  return math.centre(X, N, D).data;
}

function sampleSet(opts) {
  const res = ET.contract.validate(sample.generate({ dimension: 96, count: 700, seed: 20261113, ...opts }), null);
  assert.strictEqual(res.ok, true);
  return res.set;
}

// Run `fn` with a clock on which a millisecond passes at every look: every look at the
// clock then ends the unit, as on a device slow enough that each piece takes that long.
function withSlowClock(fn) {
  const real = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let t = 0;
  Object.defineProperty(globalThis, "performance", { configurable: true, writable: true, value: { now: () => t++ } });
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, "performance", real);
  }
}

function unitsOf(stepper) {
  let units = 1;
  while (!stepper.step(0)) units++;
  return units;
}

function sameBytes(a, b) {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

// ---------- preparation: no long piece between two looks at the clock ----------

test("the fit of few points in many dimensions pauses inside a row of the Gram matrix", () => {
  const N = 160;
  const D = 512;
  const Y = centred(N, D, 3);
  const opts = { seed: 5, subspace: 8 };
  const whole = math.guidedTour(Y, N, D, opts);
  assert.strictEqual(whole.pca.method, "gram-iterative");
  let sliced = null;
  const units = withSlowClock(() => {
    const st = math.makeGuidedTour(Y, N, D, opts);
    const n = unitsOf(st);
    sliced = st.result;
    return n;
  });
  // The Gram matrix alone is N * N * D / 2 = 6.5 million multiply-adds. A pause is possible
  // every 4,096 or so, so on this clock there are over a thousand units in it. Before, a
  // pause was possible once per row: 160 units of up to 81,920 multiply-adds each (and of
  // 2^20 for 999 points in 1,024-d).
  assert.ok(units > 1500, "units: " + units);
  assert.strictEqual(sameBytes(sliced.basis, whole.basis), true, "the same directions, bit for bit");
  assert.strictEqual(sliced.varianceShare, whole.varianceShare);
});

test("the fit of many points pauses between directions inside a group of four rows", () => {
  const N = 700;
  const D = 640;
  const Y = centred(N, D, 4);
  const opts = { seed: 5, subspace: 8, maxIterations: 2 };
  const whole = math.guidedTour(Y, N, D, opts);
  assert.strictEqual(whole.pca.method, "covariance-iterative");
  let sliced = null;
  const units = withSlowClock(() => {
    const st = math.makeGuidedTour(Y, N, D, opts);
    const n = unitsOf(st);
    sliced = st.result;
    return n;
  });
  // One pass of the data against 16 directions is 2 * N * D * 16 = 14 million multiply-adds
  // in groups of four rows of 81,920 each; three passes were 525 units, one per group.
  assert.ok(units > 4000, "units: " + units);
  assert.strictEqual(sameBytes(sliced.basis, whole.basis), true, "the same directions, bit for bit");
  assert.strictEqual(sliced.varianceShare, whole.varianceShare);
});

test("the fit's result does not depend on the clock it was sliced by", () => {
  const N = 90;
  const D = 200;
  const Y = centred(N, D, 9);
  const opts = { seed: 11, subspace: 6 };
  const whole = math.guidedTour(Y, N, D, opts);
  const st = math.makeGuidedTour(Y, N, D, opts);
  while (!st.step(0)) {
    // one unit at a time on the real clock
  }
  assert.strictEqual(sameBytes(st.result.basis, whole.basis), true);
  const frameA = st.result.frameAt(12.5);
  const frameB = whole.frameAt(12.5);
  assert.strictEqual(sameBytes(frameA, frameB), true);
});

test("the set statistics are added a few rows at a time and come out the same", () => {
  const a = sampleSet({ dimension: 512, count: 400 });
  const b = sampleSet({ dimension: 512, count: 400 });
  const whole = M.stats(a);
  const job = M.statsJob(b);
  let runs = 1;
  while (!job.run()) runs++;
  // 400 rows of 512 values at about 8,192 values a run: 25 runs. Before: one run (2^19 values).
  assert.strictEqual(runs, 25);
  assert.strictEqual(job.result.radius, whole.radius);
  assert.strictEqual(job.result.totalVariance, whole.totalVariance);
  assert.strictEqual(sameBytes(job.result.mean, whole.mean), true);
  assert.strictEqual(M.stats(b), job.result, "cached for the set");
});

test("true neighbours can be measured a few candidates at a time with the same result", () => {
  const N = 120;
  const D = 70;
  const X = centred(N, D, 21);
  const whole = math.makeKnn(X, N, D, 3, {});
  whole.step();
  for (const part of [1, 7, 50, 1000]) {
    const st = math.makeKnn(X, N, D, 3, {});
    let calls = 1;
    while (!st.stepPart(part)) calls++;
    assert.strictEqual(calls, Math.ceil(N / part) * N, "calls at " + part + " candidates each");
    assert.strictEqual(sameBytes(st.indices, whole.indices), true, "indices at " + part);
    assert.strictEqual(sameBytes(st.distances, whole.distances), true, "distances at " + part);
  }
  // A row left half measured is finished by step(rows).
  const mixed = math.makeKnn(X, N, D, 3, {});
  mixed.stepPart(13);
  mixed.step(2);
  assert.strictEqual(mixed.next, 2);
  mixed.stepPart(5);
  mixed.step();
  assert.strictEqual(mixed.done, true);
  assert.strictEqual(sameBytes(mixed.indices, whole.indices), true);
  assert.strictEqual(mixed.stepPart(4), true, "a finished measurement stays finished");
});

test("Lattice measures its neighbours in pieces of a row and wires the same pairs", () => {
  const set = sampleSet({ dimension: 512, count: 300 });
  const wiresOf = (clock) => {
    const inst = M.create("lattice", {});
    inst.enter(set, { seed: 4 });
    const st = inst.prepare();
    let units = 0;
    const run = () => {
      while (!st.step(0)) units++;
    };
    if (clock) withSlowClock(run);
    else run();
    const w = inst.stateAt(5).wires;
    return { units, pairs: w.pairs, lengths: w.lengths };
  };
  const fast = wiresOf(false);
  const slow = wiresOf(true);
  // 300 rows of 300 candidates in 512-d, 8 candidates (4,096 multiply-adds) to a piece: on
  // the slow clock every piece is a unit, over 11,000 of them. Before, a unit was a row.
  assert.ok(slow.units > 11000, "units: " + slow.units);
  assert.strictEqual(sameBytes(slow.pairs, fast.pairs), true);
  assert.strictEqual(sameBytes(slow.lengths, fast.lengths), true);
});

// ---------- framing: the zoom without a pass over the sample in full dimension ----------

function builtBasis(X, N, D, rows, count) {
  const job = M.zoomBasisJob(X, N, D, rows, count, 512);
  let runs = 1;
  while (!job.run()) runs++;
  return { zb: job.result, runs };
}

test("a frame inside the basis is framed as autoZoom frames it, without the full pass", () => {
  const N = 600;
  const D = 300;
  const Y = centred(N, D, 31);
  const tour = math.guidedTour(Y, N, D, { seed: 2, subspace: 8 });
  const { zb, runs } = builtBasis(Y, N, D, tour.basis, 8);
  assert.ok(runs > 8 * Math.floor(512 / 13), "the basis is built in small pieces: " + runs);
  const centre = new Float32Array(D).fill(0.01);
  let worst = 0;
  for (let k = 0; k < 400; k++) {
    const frame = tour.frameAt(k * 0.37);
    const exact = M.autoZoom(Y, N, D, frame, centre, 512);
    const quick = M.zoomWith(zb, Y, N, D, frame, centre, 512);
    worst = Math.max(worst, Math.abs(quick / exact - 1));
  }
  assert.ok(worst < 1e-6, "largest relative difference: " + worst);
  assert.strictEqual(zb.exact, 0, "no frame of the tour needed the full pass");
  assert.strictEqual(zb.fast, 400);
});

test("a frame outside the basis, another sample size or no basis gets autoZoom's own answer", () => {
  const N = 600;
  const D = 300;
  const Y = centred(N, D, 32);
  const tour = math.guidedTour(Y, N, D, { seed: 2, subspace: 8 });
  const { zb } = builtBasis(Y, N, D, tour.basis, 8);
  const centre = new Float32Array(D);
  const outside = math.randomFrame(D, math.makeRandom(77));
  const exact = M.autoZoom(Y, N, D, outside, centre, 512);
  assert.strictEqual(M.zoomWith(zb, Y, N, D, outside, centre, 512), exact);
  assert.strictEqual(zb.exact, 1);
  const inside = tour.frameAt(3);
  assert.strictEqual(M.zoomWith(null, Y, N, D, inside, centre, 512), M.autoZoom(Y, N, D, inside, centre, 512));
  assert.strictEqual(M.zoomWith(zb, Y, N, D, inside, centre, 100), M.autoZoom(Y, N, D, inside, centre, 100));
  const broken = new Float32Array(inside);
  broken[5] = NaN;
  assert.strictEqual(Number.isNaN(M.zoomWith(zb, Y, N, D, broken, centre, 512)), Number.isNaN(M.autoZoom(Y, N, D, broken, centre, 512)));
});

test("a basis extended by a frame's rows covers that frame, and the base is unchanged", () => {
  const N = 520;
  const D = 200;
  const Y = centred(N, D, 33);
  const tour = math.guidedTour(Y, N, D, { seed: 2, subspace: 8 });
  const { zb } = builtBasis(Y, N, D, tour.basis, 8);
  const other = math.randomFrame(D, math.makeRandom(5));
  const wide = M.extendZoomBasis(zb, Y, other);
  assert.strictEqual(zb.B.length, 8);
  assert.strictEqual(wide.B.length, 11);
  assert.strictEqual(wide.Z[3], zb.Z[3], "what the two have in common is shared");
  // A blend of the tour's frame and the other frame lies in the wider span only.
  const mixed = math.blendFrames(other, tour.frameAt(1), 0.4, D);
  const centre = new Float32Array(D);
  const exact = M.autoZoom(Y, N, D, mixed, centre, 512);
  assert.ok(Math.abs(M.zoomWith(wide, Y, N, D, mixed, centre, 512) / exact - 1) < 1e-6);
  assert.strictEqual(wide.exact, 0);
  assert.strictEqual(M.zoomWith(zb, Y, N, D, mixed, centre, 512), exact);
  // The sliced job and the one-call form build the same basis.
  const job = M.zoomExtendJob(zb, Y, other, 3);
  while (!job.run()) {
    // one piece at a time
  }
  assert.strictEqual(sameBytes(job.result.B[10], wide.B[10]), true);
  assert.strictEqual(sameBytes(job.result.Z[10], wide.Z[10]), true);
  // A direction already inside the span adds nothing.
  const again = M.extendZoomBasis(wide, Y, other);
  assert.strictEqual(again.B[13].every((x) => x === 0), true);
});

for (const id of ["tumble", "lattice"]) {
  test(id + ": the zoom is autoZoom's to a millionth and the same whatever was asked before", () => {
    const set = sampleSet({ dimension: 128, count: 700 });
    const make = (from) => {
      const inst = M.create(id, {});
      inst.enter(set, { seed: 9, from });
      inst.prepare().step();
      return inst;
    };
    const entry = { frame: math.randomFrame(128, math.makeRandom(3)), centre: new Float32Array(128), draw: { zoom: 1 } };
    for (const from of [undefined, entry]) {
      const a = make(from);
      const b = make(from);
      const times = [0, 0.3, 0.9, 1.6, 4, 9.5, 31, 120.25];
      for (const t of times) a.stateAt(t); // a has a history; b is asked in reverse
      for (const t of times.slice().reverse()) {
        const sa = a.stateAt(t);
        const zoomA = sa.draw.zoom;
        const exact = M.autoZoom(set.vectors, set.count, 128, sa.frame, sa.centre, 512);
        const zoomB = b.stateAt(t).draw.zoom;
        assert.strictEqual(zoomA, zoomB, "t = " + t);
        // during the entry blend the draw parameters are blended, so compare after it
        if (t > 2) assert.ok(Math.abs(zoomA / exact - 1) < 1e-6, "t = " + t + ": " + zoomA + " against " + exact);
      }
    }
  });
}

test("Lattice's frames stay inside its zoom basis over many swaps", () => {
  const N = 600;
  const D = 160;
  const Y = centred(N, D, 41);
  const tour = math.guidedTour(Y, N, D, { seed: 2, subspace: 8 });
  const start = math.randomFrame(D, math.makeRandom(8));
  const swap = math.makeSwapTour(start, D, { seed: 6, period: 3.4, basis: tour.basis, basisRows: 8 });
  const { zb } = builtBasis(Y, N, D, tour.basis, 8);
  const wide = M.extendZoomBasis(zb, Y, start);
  const centre = new Float32Array(D);
  const frame = new Float32Array(3 * D);
  for (let k = 0; k < 600; k++) M.zoomWith(wide, Y, N, D, swap.frameAt(k * 2.9, frame), centre, 512);
  assert.strictEqual(wide.exact, 0, "after 500 swaps the frame is still inside the span");
});

test("a mode entered after another on the same set gets the fitted directions at once", () => {
  const fitUnits = (set, id) => {
    const inst = M.create(id, {});
    inst.enter(set, { seed: 12 });
    const st = inst.prepare();
    // On the slow clock a unit is one piece of work, so the units count the work.
    const units = withSlowClock(() => {
      let n = 1;
      while (!st.step(0) && !inst.isReady()) n++;
      return n;
    });
    return { inst, units };
  };
  const shared = sampleSet({ dimension: 512, count: 300 });
  const alone = sampleSet({ dimension: 512, count: 300 });
  assert.strictEqual(M.fittedDirections(shared, 12, 8, undefined), undefined);
  const first = fitUnits(shared, "tumble");
  assert.strictEqual(M.fittedDirections(shared, 12, 8, undefined).count, 8, "kept with the set");
  const second = fitUnits(shared, "lattice");
  const fresh = fitUnits(alone, "lattice");
  // The fit is most of the work; with it kept, Lattice is ready in a fraction of the units.
  assert.ok(second.units * 3 < fresh.units, second.units + " units against " + fresh.units);
  // And it shows exactly what a Lattice that fitted for itself shows.
  for (const t of [0, 2.5, 17, 80]) {
    const a = second.inst.stateAt(t);
    const b = fresh.inst.stateAt(t);
    assert.strictEqual(sameBytes(a.frame, b.frame), true, "frame at " + t);
    assert.strictEqual(a.draw.zoom, b.draw.zoom, "zoom at " + t);
  }
  // Another seed or another number of directions is another fit.
  assert.strictEqual(M.fittedDirections(shared, 13, 8, undefined), undefined);
  assert.strictEqual(M.fittedDirections(shared, 12, 6, undefined), undefined);
  // Tumble again on the same set shows the same frames as the first time.
  const again = fitUnits(shared, "tumble");
  assert.ok(again.units * 3 < first.units, again.units + " units against " + first.units);
  assert.strictEqual(sameBytes(again.inst.stateAt(9).frame, first.inst.stateAt(9).frame), true);
});

// ---------- labels: the sample along the frame without a pass in full dimension ----------

function direct(X, D, ids, i, F, C, r) {
  let s = 0;
  for (let d = 0; d < D; d++) s += (X[ids[i] * D + d] - C[d]) * F[r * D + d];
  return s;
}

function worstError(X, D, ids, n, F, C, out) {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) worst = Math.max(worst, Math.abs(out[3 * i + r] - direct(X, D, ids, i, F, C, r)));
  }
  return worst;
}

test("the projector follows a tour with a handful of passes over the sample, not three a frame", () => {
  const N = 400;
  const D = 256;
  const Y = centred(N, D, 51);
  const tour = math.guidedTour(Y, N, D, { seed: 2, subspace: 8 });
  const ids = Array.from({ length: 150 }, (_, i) => i * 2);
  const p = ET.viewer.makeProjector(D, ids);
  p.bind(Y, ids.length);
  const out = new Float64Array(3 * ids.length);
  const centre = new Float32Array(D).fill(0.02);
  let worst = 0;
  for (let k = 0; k < 900; k++) {
    const F = tour.frameAt(k / 15);
    p.into(F, centre, out);
    worst = Math.max(worst, worstError(Y, D, ids, ids.length, F, centre, out));
  }
  assert.ok(worst < 1e-5, "largest difference from the direct projection: " + worst);
  // 900 frames done directly are 2,700 passes over the sample; the tour moves in 8 directions.
  assert.ok(p.added <= 24, "passes over the sample: " + p.added);
  assert.strictEqual(p.resets, 0);
});

test("the projector starts again when full and stays right on frames from anywhere", () => {
  const N = 60;
  const D = 64;
  const Y = centred(N, D, 52);
  const ids = Array.from({ length: N }, (_, i) => i);
  const p = ET.viewer.makeProjector(D, ids, 7);
  p.bind(Y, N);
  const out = new Float64Array(3 * N);
  const centre = new Float32Array(D);
  const random = math.makeRandom(1);
  for (let k = 0; k < 12; k++) {
    const F = math.randomFrame(D, random);
    p.into(F, centre, out);
    assert.ok(worstError(Y, D, ids, N, F, centre, out) < 1e-5, "frame " + k);
    assert.ok(p.size <= 7, "size " + p.size);
  }
  assert.ok(p.resets >= 3, "resets: " + p.resets);
  // The same frame again costs no pass.
  const F = math.randomFrame(D, random);
  p.into(F, centre, out);
  const added = p.added;
  p.into(F, centre, out);
  assert.strictEqual(p.added, added);
});

test("the projector takes appended points, a zero frame and a frame that is not finite", () => {
  const N = 50;
  const D = 40;
  const Y = centred(N, D, 53);
  const ids = [0, 3, 6];
  const p = ET.viewer.makeProjector(D, ids);
  p.bind(Y, 3);
  const out = new Float64Array(3 * 8);
  const centre = new Float32Array(D).fill(0.1);
  const F = math.randomFrame(D, math.makeRandom(2));
  p.into(F, centre, out);
  ids.push(9, 12, 15, 18, 21); // the sample grew (an append); the block may be a new one
  const grown = new Float32Array(Y);
  p.bind(grown, 8);
  p.into(F, centre, out);
  assert.ok(worstError(grown, D, ids, 8, F, centre, out) < 1e-5);
  assert.strictEqual(p.added, 3, "no new direction for the new points");
  p.into(new Float32Array(3 * D), centre, out);
  assert.strictEqual(out[0], 0);
  const bad = new Float32Array(F);
  bad[2] = NaN;
  p.into(bad, centre, out);
  assert.strictEqual(Number.isNaN(out[0]), true);
  p.into(F, centre, out);
  assert.ok(worstError(grown, D, ids, 8, F, centre, out) < 1e-5, "right again after a broken frame");
});

test("placer gives place's x and y for any state", () => {
  const R = ET.renderer;
  const state = { zoom: 1.7, yaw: 0.6, pitch: -0.3 };
  const put = R.placer(state, 800, 600);
  const out = { x: 0, y: 0 };
  for (const p of [[0, 0, 0], [0.3, -0.2, 0.9], [-1.5, 2, -4], [0.1, 0.1, -2.9]]) {
    const want = R.place(p, state, 800, 600);
    put(p[0], p[1], p[2], out);
    assert.strictEqual(out.x, want.x);
    assert.strictEqual(out.y, want.y);
  }
  const bare = R.placer(undefined, 300, 500)(0.2, 0.4, 0.1, { x: 0, y: 0 });
  assert.strictEqual(bare.x, R.place([0.2, 0.4, 0.1], undefined, 300, 500).x);
});

test("the viewer's labels sit where the direct projection puts them, with few passes", () => {
  const dom = makeFakeDom();
  const h = api.mount(dom.host(), { seed: 3 });
  const D = 96;
  h.update(makeSet({ n: 400, d: D, labelEvery: 1 }));
  dom.frames(240);
  const v = h._viewer;
  assert.strictEqual(h.info().ready, true);
  const n = v.labelSample.length;
  assert.strictEqual(n, 300);
  const tmp = [0, 0, 0];
  let worst = 0;
  for (let j = 0; j < n; j++) {
    for (let r = 0; r < 3; r++) tmp[r] = direct(v.set.vectors, D, v.labelSample, j, v.last.frame, v.last.centre, r);
    const q = ET.renderer.place(tmp, v.lastDraw, v.W, v.H);
    worst = Math.max(worst, Math.abs(q.x - v.sx[j]), Math.abs(q.y - v.sy[j]));
  }
  assert.ok(worst < 0.01, "largest difference in pixels: " + worst);
  // 240 frames done directly are 720 passes over the sample.
  assert.ok(v.projector.added + 3 * v.projector.resets <= 60, "passes: " + v.projector.added);
  // An append keeps the projector; a replace starts a new one.
  const kept = v.projector;
  h.update(makeSet({ n: 10, d: D, op: "append", idPrefix: "q" }));
  dom.frames(2);
  assert.strictEqual(v.projector === kept, true);
  h.update(makeSet({ n: 50, d: D, labelEvery: 1, seed: 9 }));
  dom.frames(2);
  assert.strictEqual(v.projector === kept, false);
  h.destroy();
});
