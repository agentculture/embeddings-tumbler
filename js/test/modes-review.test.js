"use strict";
// Review fixes for the modes (task t7, second round): empty sets, too few dimensions,
// events fixed at a time (refit switch, wire fade-in), Wander across an append, pure
// status queries, a clock that never goes below 0, and the stats precondition.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

const MODES = ["tumble", "lattice", "wander"];
const TIMES = F.ticks(10, 60);

function copyState(s) {
  return {
    frame: new Float32Array(s.frame),
    centre: new Float32Array(s.centre),
    draw: { ...s.draw },
    status: s.status,
    wires: s.wires ? s.wires.version : null,
  };
}

function sameState(a, b, what) {
  assert.ok(F.bytesEqual(a.frame, b.frame), what + ": frame");
  assert.ok(F.bytesEqual(a.centre, b.centre), what + ": centre");
  assert.deepStrictEqual(a.draw, b.draw, what + ": draw");
  assert.strictEqual(a.status, b.status, what + ": status");
  assert.strictEqual(a.wires, b.wires, what + ": wires");
}

// ---------------------------------------------------------------- 1. empty sets

for (const id of MODES) {
  test(`${id}: an empty set gives a valid hold state, and points arriving later start the mode`, () => {
    const ET = F.freshET();
    const empty = F.emptySet(ET, 48);
    const inst = ET.modes.create(id);
    inst.enter(empty, { seed: 4 });
    const prep = inst.prepare();
    prep.step();
    assert.strictEqual(prep.done, true);
    assert.strictEqual(inst.isReady(), true);
    let hold = null;
    for (const t of [0, 1, 5]) {
      const s = inst.stateAt(t);
      assert.ok(F.frameError(s.frame, 48) < 1e-5);
      assert.ok(Array.from(s.centre).every(Number.isFinite));
      assert.strictEqual(s.wires, null);
      assert.strictEqual(s.status, "no points yet");
      for (const v of Object.values(s.draw)) assert.ok(Number.isFinite(v));
      if (hold) assert.ok(F.bytesEqual(hold, s.frame), "the hold frame does not move");
      hold = new Float32Array(s.frame);
    }
    assert.strictEqual(inst.describe().id, id);

    const donor = F.sampleSet(ET, { dimension: 48 });
    const full = F.appendRows(ET, empty, donor, 0, donor.count);
    const r = inst.dataChanged(full, { op: "append", added: donor.count, t: 5 });
    assert.strictEqual(r.restart, true, "mode time restarts when points first arrive");
    assert.ok(r.work);
    r.work.step();
    assert.ok(inst.isReady());
    const s0 = inst.stateAt(0);
    assert.ok(F.maxAbsDiff(s0.frame, hold) < 1e-6, "starts from the frame that was shown");
    assert.notStrictEqual(s0.status, "no points yet");
    const s3 = new Float32Array(inst.stateAt(3).frame);
    assert.ok(F.maxAbsDiff(s3, hold) > 1e-3, "moves once it has points");
  });
}

test("an append that is not the first points does not restart the mode", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  for (const id of MODES) {
    const inst = F.ready(ET, id, set, { seed: 1 });
    const r = inst.dataChanged(F.appendTo(ET, set, 5), { op: "append", added: 5, t: 2 });
    assert.strictEqual(r.restart, false, id);
  }
});

test("sets of 1, 2 and 5 points give valid states in every mode", () => {
  const ET = F.freshET();
  const empty = F.emptySet(ET, 24);
  const donor = F.sampleSet(ET, { dimension: 24 });
  for (const n of [1, 2, 5]) {
    const set = F.appendRows(ET, empty, donor, 0, n);
    for (const id of MODES) {
      const inst = F.ready(ET, id, set, { seed: 1 });
      inst.mark(0);
      for (const t of [0, 3, 7.7, 20]) {
        const s = inst.stateAt(t);
        assert.ok(F.frameError(s.frame, 24) < 1e-5, `${id} n=${n} t=${t}`);
        assert.ok(Array.from(s.centre).every(Number.isFinite));
        for (const v of Object.values(s.draw)) assert.ok(Number.isFinite(v));
        assert.ok(s.status.length > 0);
      }
    }
  }
});

// ---------------------------------------------------------------- 2. too few dimensions

test("too few dimensions: enter throws a RangeError that names the set's dimension and the minimum", () => {
  const ET = F.freshET();
  const two = F.tinyDimensionSet(ET, 2);
  const MIN = { tumble: 3, lattice: 4, wander: 3 };
  for (const id of MODES) {
    const inst = ET.modes.create(id);
    assert.throws(
      () => inst.enter(two, { seed: 1 }),
      (e) => e.name === "RangeError" && /dimension 2/.test(e.message) && e.message.includes("at least " + MIN[id]),
      id,
    );
  }
  const three = F.tinyDimensionSet(ET, 3);
  assert.throws(
    () => ET.modes.create("lattice").enter(three, { seed: 1 }),
    (e) => e.name === "RangeError" && /dimension 3/.test(e.message) && /at least 4/.test(e.message),
  );
  for (const id of ["tumble", "wander"]) {
    const inst = F.ready(ET, id, three, { seed: 1 });
    assert.ok(F.frameError(inst.stateAt(6).frame, 3) < 1e-5, id + " works at 3-d");
  }
});

// ---------------------------------------------------------------- 3. events at a fixed time

function tumbleWithAppend(ET, set) {
  const inst = F.ready(ET, "tumble", set, { seed: 3 });
  const bigger = F.appendTo(ET, set, 40);
  inst.dataChanged(bigger, { op: "append", added: 40, t: 5 });
  return inst;
}

test("Tumble refit, fixed by the first query: later queries are pure, earlier times keep the old tour", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const inst = tumbleWithAppend(ET, set);
  const noRefit = tumbleWithAppend(ET, set);
  inst.refit().step();
  assert.strictEqual(inst.describe().refitPending, true);
  const at8 = copyState(inst.stateAt(8)); // fixes the switch at t = 8
  assert.strictEqual(inst.describe().refitAt, 8);
  assert.strictEqual(inst.describe().refitPending, false);
  sameState(copyState(inst.stateAt(7)), copyState(noRefit.stateAt(7)), "t < T is the pre-refit state");
  sameState(copyState(inst.stateAt(8)), at8, "t = T again");
  const a9 = copyState(inst.stateAt(9));
  sameState(copyState(inst.stateAt(9)), a9, "t > T twice");
  inst.stateAt(2);
  sameState(copyState(inst.stateAt(9)), a9, "after a backwards query");
  assert.ok(/before 40 new points/.test(inst.stateAt(7).status), "the stale share before T");
  assert.ok(!/before/.test(inst.stateAt(9).status), "the fresh share after T");
});

test("Tumble refit(t): two instances given the same time agree whatever order they are queried in", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const a = tumbleWithAppend(ET, set);
  const b = tumbleWithAppend(ET, set);
  a.refit(8).step();
  b.refit(8).step();
  const order = [12, 9, 8.5, 8, 7.99, 3];
  const ra = {};
  for (const t of order) ra[t] = copyState(a.stateAt(t));
  for (const t of order.slice().reverse()) sameState(copyState(b.stateAt(t)), ra[t], "t = " + t);
  assert.strictEqual(a.describe().refitAt, 8);
  assert.strictEqual(b.describe().refitAt, 8);
});

test("Tumble mark(t) fixes a finished refit's switch time", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const a = tumbleWithAppend(ET, set);
  const b = tumbleWithAppend(ET, set);
  a.refit().step();
  b.refit().step();
  a.mark(6.5);
  b.stateAt(6.5);
  for (const t of [9, 6.6, 6.4, 20]) sameState(copyState(a.stateAt(t)), copyState(b.stateAt(t)), "t = " + t);
  assert.strictEqual(a.describe().refitAt, 6.5);
});

function latticeMeasuredLate(ET, set) {
  const inst = ET.modes.create("lattice");
  inst.enter(set, { seed: 2 });
  const prep = inst.prepare();
  prep.step(0); // statistics only
  inst.stateAt(1);
  inst.stateAt(2);
  prep.step(); // neighbours measured now
  return inst;
}

test("Lattice wire fade-in, fixed by mark(t): pure in t, and wires absent before T", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const a = latticeMeasuredLate(ET, set);
  const b = latticeMeasuredLate(ET, set);
  a.mark(3);
  b.mark(3);
  assert.strictEqual(a.describe().wiresShownAt, 3);
  const before = a.stateAt(2.5);
  assert.strictEqual(before.wires, null);
  assert.strictEqual(before.draw.wires, 0);
  const order = [4, 3.6, 2.5, 3, 10, 3.6];
  const ra = {};
  for (const t of order) ra[t] = copyState(a.stateAt(t));
  for (const t of order.slice().reverse()) sameState(copyState(b.stateAt(t)), ra[t], "t = " + t);
  assert.ok(ra[3.6].draw.wires > 0 && ra[3.6].draw.wires < 1);
  assert.strictEqual(ra[10].draw.wires, 1);
});

test("Lattice wire fade-in without mark: fixed by the first query, then pure", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const inst = latticeMeasuredLate(ET, set);
  const s5 = copyState(inst.stateAt(5));
  assert.strictEqual(inst.describe().wiresShownAt, 5);
  assert.strictEqual(inst.stateAt(4).wires, null);
  assert.strictEqual(inst.stateAt(4).draw.wires, 0);
  sameState(copyState(inst.stateAt(5)), s5, "t = T again");
  const s7 = copyState(inst.stateAt(7));
  inst.stateAt(1);
  sameState(copyState(inst.stateAt(7)), s7, "after a backwards query");
});

// ---------------------------------------------------------------- 4. Wander across an append

function maxStep(inst, from, to) {
  let worst = 0;
  let prev = null;
  for (let i = Math.round(from * 60); i <= Math.round(to * 60); i++) {
    const f = new Float32Array(inst.stateAt(i / 60).frame);
    if (prev) worst = Math.max(worst, F.maxAbsDiff(prev, f));
    prev = f;
  }
  return worst;
}

test("Wander: no jump across an append, through the end of the second hop after it", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const bound = maxStep(F.ready(ET, "wander", set, { seed: 5 }), 0, 60);
  for (const seed of [5, 6, 7]) {
    const inst = F.ready(ET, "wander", set, { seed });
    const cycle = inst.describe().travel + inst.describe().dwell;
    const ta = 6.1;
    let worst = maxStep(inst, 0, ta);
    let prev = new Float32Array(inst.stateAt(ta).frame);
    const bigger = F.appendTo(ET, set, 20, { labelled: true, group: "music" });
    const r = inst.dataChanged(bigger, { op: "append", added: 20, t: ta });
    if (r.work) r.work.step();
    const end = (Math.floor(ta / cycle) + 3) * cycle; // end of the second hop after
    for (let i = Math.round(ta * 60); i <= Math.round(end * 60); i++) {
      const f = new Float32Array(inst.stateAt(i / 60).frame);
      worst = Math.max(worst, F.maxAbsDiff(prev, f));
      prev = f;
    }
    assert.ok(worst <= bound * 1.5 + 1e-6, `seed ${seed}: step ${worst} against ${bound} without an append`);
  }
});

test("Wander route is fixed by the data history and the seed, not by how it was queried", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const a = F.ready(ET, "wander", set, { seed: 8 });
  const b = F.ready(ET, "wander", set, { seed: 8 });
  a.route(20);
  for (const t of [44, 3, 17.5]) a.status(t);
  a.stateAt(30);
  b.stateAt(1);
  const bigger = F.appendTo(ET, set, 20, { labelled: true, group: "music" });
  const bigger2 = F.appendTo(ET, bigger, 10, { labelled: true, group: "law" });
  for (const inst of [a, b]) {
    inst.dataChanged(bigger, { op: "append", added: 20, t: 6.1 });
    inst.dataChanged(bigger2, { op: "append", added: 10, t: 15.2 });
  }
  assert.deepStrictEqual(Array.from(a.route(12)), Array.from(b.route(12)));
  for (const t of [16, 25.3, 40, 7]) sameState(copyState(a.stateAt(t)), copyState(b.stateAt(t)), "t = " + t);
});

// ---------------------------------------------------------------- 5. status is a pure query

test("status(t) at arbitrary times changes no later answer", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  for (const id of MODES) {
    const a = F.ready(ET, id, set, { seed: 12 });
    const b = F.ready(ET, id, set, { seed: 12 });
    for (const t of [37.3, 2.1, 90.5, 15, 0.3, 61]) a.status(t);
    for (let i = 0; i < TIMES.length; i += 13) {
      sameState(copyState(a.stateAt(TIMES[i])), copyState(b.stateAt(TIMES[i])), id + " t = " + TIMES[i]);
    }
  }
});

// ---------------------------------------------------------------- 6. the clock stays at or above 0

test("step(dt) with a negative dt clamps the mode clock at 0", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  for (const id of MODES) {
    const inst = F.ready(ET, id, set, { seed: 1 });
    inst.step(-1);
    assert.strictEqual(inst.time, 0, id);
    inst.step(0.5);
    assert.strictEqual(inst.time, 0.5, id);
    const s = copyState(inst.step(-2));
    assert.strictEqual(inst.time, 0, id);
    sameState(s, copyState(inst.stateAt(0)), id);
    inst.step(0.25);
    assert.strictEqual(inst.time, 0.25, id + " moves forward at once");
  }
});

// ---------------------------------------------------------------- 7. stats precondition

test("stats(set, previous) extends a true append and recomputes when previous is not one", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const D = set.dimension;
  const bigger = F.appendTo(ET, set, 30);
  ET.modes.stats(set);
  const ext = ET.modes.stats(bigger, set);
  const want = ET.math.meanOf(bigger.vectors, bigger.count, D);
  assert.ok(F.maxAbsDiff(ext.mean, Float32Array.from(want)) < 1e-6);
  assert.strictEqual(ext.count, bigger.count);

  // an unrelated, smaller set of the same dimension is not a base: full recompute
  const ET2 = F.freshET();
  const other = F.sampleSet(ET2, { seed: 99, count: 500 });
  const target = F.sampleSet(ET2, { seed: 7 });
  ET2.modes.stats(other);
  const st = ET2.modes.stats(target, other);
  const want2 = ET2.math.meanOf(target.vectors, target.count, D);
  assert.ok(F.maxAbsDiff(st.mean, Float32Array.from(want2)) < 1e-6);
  assert.strictEqual(st.count, target.count);
});
