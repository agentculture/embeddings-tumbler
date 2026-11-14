"use strict";
// Reproducible views (task t7, criterion 4): with a fixed seed, each mode's frames over
// 10 simulated seconds are identical across two fresh runs, and do not depend on how
// time was sliced, on the order of queries, or on how far background work has got.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

const MODES = ["tumble", "lattice", "wander"];
const TIMES = F.ticks(10, 60); // 601 frames, 0 .. 10 s

function run(id, D, seed) {
  const ET = F.freshET(); // a fresh engine context each run
  const set = F.sampleSet(ET, { dimension: D });
  const inst = F.ready(ET, id, set, { seed });
  return F.framesAt(inst, TIMES);
}

for (const id of MODES) {
  for (const D of [48, 1024]) {
    test(`criterion 4: ${id} at ${D}-d gives bit-identical frames over 10 s in two fresh runs`, () => {
      const a = run(id, D, 11);
      const b = run(id, D, 11);
      assert.strictEqual(a.length, 601);
      for (let i = 0; i < a.length; i++) {
        assert.ok(F.bytesEqual(a[i].frame, b[i].frame), `${id} frame differs at t=${TIMES[i]}`);
        assert.ok(F.bytesEqual(a[i].centre, b[i].centre), `${id} centre differs at t=${TIMES[i]}`);
        assert.strictEqual(a[i].status, b[i].status);
      }
      // ...and the view actually moves
      assert.ok(F.maxAbsDiff(a[0].frame, a[600].frame) > 1e-3, `${id} moves over 10 s`);
    });
  }

  test(`criterion 4: ${id} with a different seed gives a different sequence`, () => {
    const a = run(id, 48, 11);
    const b = run(id, 48, 12);
    let differs = false;
    for (let i = 0; i < a.length && !differs; i++) differs = !F.bytesEqual(a[i].frame, b[i].frame);
    assert.ok(differs);
  });

  test(`${id}: one call at t equals many small calls up to t, bit for bit`, () => {
    const ET = F.freshET();
    const set = F.sampleSet(ET);
    const one = F.ready(ET, id, set, { seed: 5 });
    const many = F.ready(ET, id, set, { seed: 5 });
    for (const t of TIMES) many.stateAt(t);
    for (const t of [10, 4.25, 7.5]) {
      const x = one.stateAt(t);
      const fx = new Float32Array(x.frame);
      const cx = new Float32Array(x.centre);
      const y = many.stateAt(t);
      assert.ok(F.bytesEqual(fx, y.frame), `${id} frame at ${t}`);
      assert.ok(F.bytesEqual(cx, y.centre), `${id} centre at ${t}`);
    }
  });

  test(`${id}: queries out of order (backwards, repeated) give the same answers`, () => {
    const ET = F.freshET();
    const set = F.sampleSet(ET);
    const fwd = F.framesAt(F.ready(ET, id, set, { seed: 9 }), TIMES);
    const back = F.ready(ET, id, set, { seed: 9 });
    const rev = F.framesAt(back, TIMES.slice().reverse()).reverse();
    for (let i = 0; i < TIMES.length; i += 7) {
      assert.ok(F.bytesEqual(fwd[i].frame, rev[i].frame), `${id} frame at ${TIMES[i]}`);
      assert.ok(F.bytesEqual(fwd[i].centre, rev[i].centre), `${id} centre at ${TIMES[i]}`);
    }
  });

  test(`${id}: step(dt) is a thin wrapper over stateAt (within 1e-6 after 600 steps)`, () => {
    // step() accumulates time in a float, so after 600 steps of 1/60 s its clock reads
    // 10 s give or take a few ulps (about 1e-14 s). The frame is a smooth function of
    // time, so it agrees with stateAt(10) to far better than 1e-6; bit equality is
    // promised only for stateAt with the same absolute time.
    const ET = F.freshET();
    const set = F.sampleSet(ET);
    const a = F.ready(ET, id, set, { seed: 2 });
    const b = F.ready(ET, id, set, { seed: 2 });
    let s;
    for (let i = 0; i < 600; i++) s = a.step(1 / 60);
    assert.ok(Math.abs(a.time - 10) < 1e-9);
    const exact = b.stateAt(a.time);
    assert.ok(F.bytesEqual(new Float32Array(s.frame), exact.frame), "step returns stateAt(time)");
    assert.ok(F.maxAbsDiff(s.frame, b.stateAt(10).frame) < 1e-6);
  });
}

test("lattice: frames do not depend on how far the true-neighbour work has got", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const pumped = F.ready(ET, "lattice", set, { seed: 4 });
  const lazy = ET.modes.create("lattice");
  lazy.enter(set, { seed: 4 });
  const prep = lazy.prepare();
  prep.step(0); // one unit only: the shared statistics; neighbours not started
  assert.ok(lazy.isReady());
  assert.strictEqual(prep.done, false);
  const a = F.framesAt(pumped, TIMES);
  const b = F.framesAt(lazy, TIMES);
  for (let i = 0; i < TIMES.length; i++) {
    assert.ok(F.bytesEqual(a[i].frame, b[i].frame));
    assert.ok(F.bytesEqual(a[i].centre, b[i].centre));
  }
  assert.ok(pumped.stateAt(10).wires !== null);
  assert.strictEqual(lazy.stateAt(10).wires, null);
});

test("entry from another mode is part of the input: same entry state, same frames", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const tumble = F.ready(ET, "tumble", set, { seed: 1 });
  const s = tumble.stateAt(4.2);
  const from = { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: Object.assign({}, s.draw) };
  for (const id of MODES) {
    const a = F.framesAt(F.ready(ET, id, set, { seed: 6, from }), TIMES);
    const b = F.framesAt(F.ready(ET, id, set, { seed: 6, from }), TIMES);
    for (let i = 0; i < TIMES.length; i += 5) assert.ok(F.bytesEqual(a[i].frame, b[i].frame), id);
  }
});
