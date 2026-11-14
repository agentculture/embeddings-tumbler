"use strict";
// Hardening of Tumble's refit turn and of preparations left unfinished:
//   - the turn's length reads nothing a later event can change (tourRate is pure);
//   - a refit that changes nothing gives a well-defined turn (no NaN, orthonormal, no jump);
//   - the turn's frame is orthonormalised once, and that is enough;
//   - a preparation or refit abandoned midway leaves no error and no trace.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

function change(A, B) {
  let s = 0;
  for (let i = 0; i < A.length; i++) s += (A[i] - B[i]) ** 2;
  return Math.sqrt(s);
}

function allFinite(arr) {
  for (const x of arr) if (!Number.isFinite(x)) return false;
  return true;
}

// Points exactly at the set's mean (as float32): they move no principal direction.
function meanAppend(ET, set, k) {
  const D = set.dimension;
  const st = ET.modes.stats(set);
  const vectors = new Float32Array(k * D);
  const points = [];
  for (let a = 0; a < k; a++) {
    for (let d = 0; d < D; d++) vectors[a * D + d] = st.mean[d];
    points.push({ id: "mean" + a, label: "" });
  }
  const res = ET.contract.validate(
    { schema_version: 1, kind: "embeddings-tumbler/data", op: "append", model: set.model, dimension: D, count: k, text_included: false, vectors, points },
    set,
  );
  assert.ok(res.ok, res.message);
  return res.set;
}

// ----- 1. the turn's length is a pure function of (new tour, switch time) -----

test("tourRate reads only the tour and t0: unchanged by queries of the tour at other times", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { count: 900 });
  const tour = ET.math.guidedTour(ET.math.centre(set.vectors, set.count, set.dimension).data, set.count, set.dimension, { seed: 4 });
  const R = ET.modes.refitTurn;
  const first = R.tourRate(tour, 3);
  tour.frameAt(17.25);
  tour.coefficientsAt(-2);
  R.tourRate(tour, 40);
  assert.strictEqual(R.tourRate(tour, 3), first);
});

test("a second refit inside the first turn's 12 s window leaves every frame before it unchanged", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { count: 900 });
  const more = F.appendTo(ET, set, 150);
  const evenMore = F.appendTo(ET, more, 200);
  function made(second) {
    const inst = F.ready(ET, "tumble", set, { seed: 5 });
    inst.dataChanged(more, { op: "append", added: 150, t: 3 });
    inst.refit(4).step();
    const first = inst.describe().refitTransition;
    if (second) {
      inst.dataChanged(evenMore, { op: "append", added: 200, t: 4.5 });
      inst.refit(5).step();
    }
    return { inst, first };
  }
  const a = made(false);
  const b = made(true);
  assert.strictEqual(b.inst.describe().refitAt, 5);
  assert.ok(a.first > 1, `the first turn (${a.first} s) is still running at 5 s`);
  const times = F.ticks(5, 60).filter((t) => t < 5);
  // b first, so the later switch is already fixed when the earlier frames are asked for
  const fb = F.framesAt(b.inst, times);
  const fa = F.framesAt(a.inst, times);
  for (let i = 0; i < times.length; i++) assert.ok(F.bytesEqual(fa[i].frame, fb[i].frame), `t = ${times[i]}`);
  // the second switch, mid-turn, is continuous and orthonormal
  const before = new Float32Array(b.inst.stateAt(5 - 1e-4).frame);
  assert.ok(change(before, b.inst.stateAt(5).frame) < 1e-3);
  for (const t of F.ticks(14, 10).map((x) => x + 5)) assert.ok(F.frameError(b.inst.stateAt(t).frame, set.dimension) < 1e-5, `t = ${t}`);
});

// ----- 2. a refit that changes nothing -----

for (const D of [3, 4, 48, 1024]) {
  test(`refit turn between identical or nearly identical frames at ${D}-d is the identity, finite and orthonormal`, () => {
    const ET = F.freshET();
    const R = ET.modes.refitTurn;
    const A = ET.math.randomFrame(D, ET.math.makeRandom(7));
    const near = new Float32Array(A);
    near[0] += 1e-7;
    near[D + 1] -= 1e-7;
    ET.math.orthonormalize(near, 3, D);
    for (const [name, B] of [["same", new Float32Array(A)], ["near", near]]) {
      const bl = R.make(A, B, D);
      assert.ok(allFinite(bl.Bp) && allFinite(bl.Tp) && allFinite(bl.theta) && Number.isFinite(bl.phi) && Number.isFinite(bl.rate), name);
      assert.deepStrictEqual(Array.from(bl.theta), [0, 0, 0], `${name}: no plane turns`);
      assert.strictEqual(bl.phi, 0, `${name}: no turn inside the span`);
      assert.strictEqual(bl.rate, 0, `${name}: the turn adds no motion`);
      for (const s of [0, 0.25, 0.5, 1]) {
        const out = new Float32Array(B);
        R.apply(bl, s, out, D);
        assert.ok(allFinite(out), `${name} s=${s}`);
        assert.ok(F.frameError(out, D) < 1e-6, `${name} s=${s}`);
        assert.ok(F.maxAbsDiff(out, B) < 1e-6, `${name} s=${s}: the frame shown simply continues`);
      }
    }
  });
}

test("refit turn: each plane's direction T_j is orthogonal to every principal vector B'_k", () => {
  const ET = F.freshET();
  const R = ET.modes.refitTurn;
  const D = 64;
  const A = ET.math.randomFrame(D, ET.math.makeRandom(7));
  // B shares A's first row and differs in the other two, so one plane does not turn
  const B = ET.math.randomFrame(D, ET.math.makeRandom(8));
  B.set(A.subarray(0, D), 0);
  ET.math.orthonormalize(B, 3, D);
  const bl = R.make(A, B, D);
  for (let j = 0; j < 3; j++) {
    for (let k = 0; k < 3; k++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += bl.Tp[j * D + d] * bl.Bp[k * D + d];
      assert.ok(Math.abs(s) < 1e-9, `T_${j} . B'_${k} = ${s}`);
    }
  }
  const out = new Float32Array(B);
  R.apply(bl, 1, out, D);
  assert.ok(F.maxAbsDiff(out, A) < 1e-6, "Q B = A");
});

for (const D of [3, 4, 48]) {
  test(`refit turn onto a frame with one row reversed at ${D}-d: a half turn where there is room, never NaN`, () => {
    const ET = F.freshET();
    const R = ET.modes.refitTurn;
    const A = ET.math.randomFrame(D, ET.math.makeRandom(7));
    const B = new Float32Array(A);
    for (let d = 0; d < D; d++) B[2 * D + d] = -A[2 * D + d];
    const bl = R.make(A, B, D);
    for (const s of [0, 0.3, 0.5, 0.8, 1]) {
      const out = new Float32Array(B);
      R.apply(bl, s, out, D);
      assert.ok(allFinite(out), `s=${s}`);
      assert.ok(F.frameError(out, D) < 1e-6, `s=${s}`);
    }
    const end = new Float32Array(B);
    R.apply(bl, 1, end, D);
    // At 3-d no rotation takes B to A (that would be a reflection); the turn is
    // still a rotation (finite, orthonormal, checked above), only not onto A.
    if (D > 3) assert.ok(F.maxAbsDiff(end, A) < 1e-6, `Q B = A: ${F.maxAbsDiff(end, A)}`);
  });
}

for (const fromEntry of [false, true]) {
  test(`Tumble refit on unchanged data${fromEntry ? " (entered from a view)" : ""}: finite, orthonormal, no jump, the same frames`, () => {
    const ET = F.freshET();
    const D = 48;
    const set = F.sampleSet(ET, { dimension: D, count: 900 });
    const opts = { seed: 3 };
    if (fromEntry) opts.from = { frame: ET.math.randomFrame(D, ET.math.makeRandom(4)), centre: null, draw: null };
    const inst = F.ready(ET, "tumble", set, opts);
    const plain = F.ready(ET, "tumble", set, opts);
    const T = 0.75; // inside the entry blend when entered from a view
    inst.refit(T).step();
    const d = inst.describe();
    assert.strictEqual(d.refitAt, T);
    assert.strictEqual(d.refitTransition, 1.5, "nothing to turn: the shortest turn");
    for (const t of F.ticks(T + d.refitTransition + 1, 60)) {
      const f = new Float32Array(inst.stateAt(t).frame);
      assert.ok(allFinite(f), `t = ${t}`);
      assert.ok(F.frameError(f, D) < 1e-5, `t = ${t}`);
      assert.ok(F.maxAbsDiff(f, plain.stateAt(t).frame) < 1e-6, `t = ${t}: the frame shown continues`);
    }
  });
}

test("Tumble refit after appending points at the mean: finite, orthonormal, no jump", () => {
  const ET = F.freshET();
  const D = 48;
  const set = F.sampleSet(ET, { dimension: D, count: 900 });
  const inst = F.ready(ET, "tumble", set, { seed: 3 });
  const bigger = meanAppend(ET, set, 50);
  inst.dataChanged(bigger, { op: "append", added: 50, t: 4 });
  const T = 5;
  inst.refit(T).step();
  const dur = inst.describe().refitTransition;
  let normal = 0;
  let turn = 0;
  let prev = null;
  for (const t of F.ticks(T + dur + 1, 60)) {
    const f = new Float32Array(inst.stateAt(t).frame);
    assert.ok(allFinite(f), `t = ${t}`);
    assert.ok(F.frameError(f, D) < 1e-5, `t = ${t}`);
    if (prev) {
      const c = change(prev, f);
      if (t <= T) normal = Math.max(normal, c);
      else turn = Math.max(turn, c);
    }
    prev = f;
  }
  assert.ok(turn <= 1.4 * normal, `peak ${turn} against normal ${normal}`);
});

// ----- 3. one orthonormalisation per frame is enough -----

test("refit turn: a second orthonormalisation of the turned frame changes it by under 1e-6", () => {
  const ET = F.freshET();
  const R = ET.modes.refitTurn;
  for (const D of [8, 48, 384, 1024]) {
    const A = ET.math.randomFrame(D, ET.math.makeRandom(11));
    const tour = ET.math.randomFrame(D, ET.math.makeRandom(12));
    const bl = R.make(A, tour, D);
    let worstDiff = 0;
    let worstErr = 0;
    for (let k = 0; k <= 40; k++) {
      const s = k / 40;
      // a moving frame, as during the turn
      const Fm = ET.math.randomFrame(D, ET.math.makeRandom(100 + k));
      R.apply(bl, s, Fm, D);
      worstErr = Math.max(worstErr, F.frameError(Fm, D));
      const again = ET.math.orthonormalize(new Float32Array(Fm), 3, D);
      worstDiff = Math.max(worstDiff, F.maxAbsDiff(Fm, again));
    }
    assert.ok(worstErr < 1e-6, `${D}-d: frame error ${worstErr}`);
    assert.ok(worstDiff < 1e-6, `${D}-d: second pass moves an entry by ${worstDiff}`);
  }
});

// ----- 5. a preparation abandoned midway -----

function partial(stepper, units) {
  for (let i = 0; i < units && !stepper.done; i++) stepper.step(0);
}

const SET = { dimension: 96, count: 1500 };

test("Tumble: preparation abandoned midway, then leave(): no error, even if the old stepper is pumped", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, SET);
  for (const units of [0, 1, 3, 8]) {
    const inst = ET.modes.create("tumble");
    inst.enter(set, { seed: 4 });
    const prep = inst.prepare();
    partial(prep, units);
    inst.leave();
    assert.doesNotThrow(() => {
      while (!prep.done) prep.step(0);
    }, `after ${units} units`);
  }
});

test("Tumble: a fresh enter and full prepare after an abandoned one gives the uninterrupted frames, bit for bit", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, SET);
  const times = F.ticks(6, 30);
  const clean = F.framesAt(F.ready(ET, "tumble", set, { seed: 4 }), times);
  const other = F.sampleSet(ET, { seed: 777, ...SET });
  for (const units of [1, 3, 8]) {
    const inst = ET.modes.create("tumble");
    inst.enter(other, { seed: 9 }); // other data and seed, so leftovers would show
    const old = inst.prepare();
    partial(old, units);
    inst.enter(set, { seed: 4 });
    const prep = inst.prepare();
    // a careless caller pumps the abandoned stepper too, after the new one is done
    while (!prep.done) prep.step(0);
    while (!old.done) old.step(0);
    const got = F.framesAt(inst, times);
    for (let i = 0; i < times.length; i++) {
      assert.ok(F.bytesEqual(clean[i].frame, got[i].frame), `after ${units} units: frame at ${times[i]}`);
      assert.ok(F.bytesEqual(clean[i].centre, got[i].centre), `after ${units} units: centre at ${times[i]}`);
    }
  }
});

test("Tumble: data appended mid-preparation never shows the old data's tour", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, SET);
  const bigger = F.appendTo(ET, set, 200);
  const times = F.ticks(6, 30);
  const clean = F.framesAt(F.ready(ET, "tumble", bigger, { seed: 4 }), times);
  for (const units of [1, 3, 6, 8]) {
    const inst = ET.modes.create("tumble");
    inst.enter(set, { seed: 4 });
    const old = inst.prepare();
    partial(old, units);
    assert.ok(!inst.isReady(), `still preparing after ${units} units`);
    const r = inst.dataChanged(bigger, { op: "append", added: 200, t: 0 });
    assert.strictEqual(r.restart, true);
    // the viewer's order before the fix: the old stepper first, then the new work
    while (!old.done) {
      old.step(0);
      assert.ok(!inst.isReady(), `after ${units} units: the abandoned stepper made the instance ready`);
    }
    while (!inst.isReady()) r.work.step(0);
    assert.strictEqual(inst.describe().pointsSinceFit, 0, `after ${units} units: ready on a fit of the new set`);
    while (!r.work.done) r.work.step(0);
    const got = F.framesAt(inst, times);
    for (let i = 0; i < times.length; i++) assert.ok(F.bytesEqual(clean[i].frame, got[i].frame), `after ${units} units: frame at ${times[i]}`);
  }
});

test("Tumble: a refit abandoned midway leaves no trace on a later refit", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, SET);
  const more = F.appendTo(ET, set, 100);
  const evenMore = F.appendTo(ET, more, 100);
  const times = F.ticks(14, 30);
  const ref = F.ready(ET, "tumble", set, { seed: 4 });
  ref.dataChanged(more, { op: "append", added: 100, t: 1 });
  ref.dataChanged(evenMore, { op: "append", added: 100, t: 2 });
  ref.refit(3).step();
  const clean = F.framesAt(ref, times);

  const inst = F.ready(ET, "tumble", set, { seed: 4 });
  inst.dataChanged(more, { op: "append", added: 100, t: 1 });
  const old = inst.refit(2.5);
  partial(old, 3);
  assert.ok(!old.done, "the first refit is unfinished");
  inst.dataChanged(evenMore, { op: "append", added: 100, t: 2 });
  const now = inst.refit(3);
  while (!now.done) {
    if (!old.done) old.step(0);
    now.step(0);
  }
  while (!old.done) old.step(0);
  assert.strictEqual(inst.describe().refitAt, 3);
  assert.strictEqual(inst.describe().refitPending, false);
  const got = F.framesAt(inst, times);
  for (let i = 0; i < times.length; i++) assert.ok(F.bytesEqual(clean[i].frame, got[i].frame), `frame at ${times[i]}`);
});
