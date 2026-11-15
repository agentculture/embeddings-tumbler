"use strict";
// The swing toward the searches (task t6 of the search plan; interface: docs/search-interface.md,
// "Modes (t6)", and js/api/40-modes.md, "Facing the searches"). In Tumble, Lattice and Wander,
// inst.face(target, t) draws the view toward the facing frame for about six seconds while it
// keeps drifting; then the mode's own motion carries on from wherever the view is.
//
// Everything runs the committed assembled file (what ships, and what coverage is measured on).
// The determinism test loads it afresh from disk for each run.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled, ASSEMBLED } = require("./helpers/load.js");
const F = require("./helpers/modes-fixtures.js");

const ET = loadAssembled()._internal;
const MODES = ["tumble", "lattice", "wander"];
const VERB = { tumble: "tumbling", lattice: "swapping axes", wander: "wandering" };
const T0 = 7.3; // the swing's start in the tests
const HELD = 0.01; // a frame that changes less than this (Frobenius) in a second is held

// The assembled file loaded again from disk, not from require's cache.
function freshAssembled() {
  delete require.cache[ASSEMBLED];
  try {
    return require(ASSEMBLED)._internal;
  } finally {
    delete require.cache[ASSEMBLED];
  }
}

const SET = F.sampleSet(ET, { dimension: 48 });

// A facing target made the way the viewer makes it (ET.searchSets.makeFacingFrame).
function target(E, set, rows, seed) {
  const D = set.dimension;
  const searches = rows.map((i) => ({
    query: set.vectors.slice(i * D, (i + 1) * D),
    hits: [i, i + 1, i + 2].map((index) => ({ index })),
  }));
  const st = E.searchSets.makeFacingFrame(set, searches, { seed: seed || 1 });
  st.step();
  return st.result;
}

const TARGET = target(ET, SET, [5, 300]);

function fro(A, B) {
  let s = 0;
  for (let i = 0; i < A.length; i++) s += (A[i] - B[i]) ** 2;
  return Math.sqrt(s);
}

function copyState(s) {
  return {
    frame: new Float32Array(s.frame),
    centre: new Float32Array(s.centre),
    zoom: s.draw.zoom,
    status: s.status,
    focus: s.focus ? { ...s.focus } : null,
  };
}

// The largest change of the frame between consecutive frames at 60 per second over [a, b).
function largestStep(inst, a, b) {
  let worst = 0;
  let prev = new Float32Array(inst.stateAt(a).frame);
  for (let i = 1; a + i / 60 < b; i++) {
    const f = new Float32Array(inst.stateAt(a + i / 60).frame);
    worst = Math.max(worst, fro(prev, f));
    prev = f;
  }
  return worst;
}

// The pairs of consecutive whole seconds from `from` (to `from + seconds`) between which the
// frame changes by less than HELD, each as { t, change }.
function heldPairs(inst, from, seconds) {
  const held = [];
  let prev = new Float32Array(inst.stateAt(from).frame);
  for (let k = 1; k <= seconds; k++) {
    const f = new Float32Array(inst.stateAt(from + k).frame);
    const change = fro(prev, f);
    if (Number.isNaN(change) || change < HELD) held.push({ t: from + k - 1, change });
    prev = f;
  }
  return held;
}

// A mode instance that holds the target's frame once faced: the version the owner rejected.
function holdingStub(base) {
  let held = null;
  return {
    stateAt(t) {
      return held ? { ...base.stateAt(t), frame: held } : base.stateAt(t);
    },
    face(tg) {
      held = new Float32Array(tg.frame);
      return true;
    },
  };
}

// ---------- criterion 1: never held, and the swing ends by itself ----------

test("control: the held-view check fails on a mode that holds the facing frame", () => {
  const stub = holdingStub(F.ready(ET, "tumble", SET, { seed: 3 }));
  assert.strictEqual(stub.face(TARGET, T0), true);
  const held = heldPairs(stub, T0, 16);
  assert.strictEqual(held.length, 16, "every pair of seconds is held on the stub");
  assert.strictEqual(held[0].change, 0);
  // ...and the same check finds nothing held in a mode that moves with no swing
  assert.deepStrictEqual(heldPairs(F.ready(ET, "tumble", SET, { seed: 3 }), T0, 16), []);
});

for (const id of MODES) {
  test(`criterion 1: ${id}: the frame differs between every pair of consecutive seconds during and after a swing, which ends by itself`, () => {
    const inst = F.ready(ET, id, SET, { seed: 3 });
    assert.strictEqual(inst.face(TARGET, T0, { searches: 2 }), true);
    const U = T0 + 6;
    // during the swing
    assert.deepStrictEqual(heldPairs(inst, T0, 6), [], `${id} is held during the swing`);
    // after it: 16 more seconds
    const after = heldPairs(inst, U, 16);
    if (id === "wander") {
      // Wander dwells 2 s at each stop with the frame still, with or without a search; a
      // held pair may only fall inside one dwell of the leg that starts at U.
      for (const p of after) {
        const a = (p.t - U) % 4.8;
        assert.ok(a >= 2.8 - 1e-9 && a + 1 <= 4.8 + 1e-9, `wander held outside a dwell at ${p.t}`);
        assert.strictEqual(inst.stateAt(p.t).focus.phase, "dwell");
      }
    } else {
      assert.deepStrictEqual(after, [], `${id} is held after the swing`);
    }
    // it ends by itself at U: the status and the description say so
    assert.match(inst.stateAt(U - 0.01).status, new RegExp("^swinging to face the 2 searches, then " + VERB[id] + " on$"));
    assert.doesNotMatch(inst.stateAt(U).status, /swinging/);
    assert.deepStrictEqual(inst.describe().facing, { at: T0, until: U });
    // during it the frame is drawn to the target (each axis within 0.1 of it, up to sign)
    const late = inst.stateAt(U - 0.01);
    for (let r = 0; r < 3; r++) {
      let dp = 0;
      for (let d = 0; d < 48; d++) dp += late.frame[r * 48 + d] * TARGET.frame[r * 48 + d];
      assert.ok(Math.abs(dp) > 0.9, `${id} axis ${r} faces the target (|dot| ${Math.abs(dp)})`);
    }
    // the centre and zoom are pulled toward the target's
    assert.ok(Math.abs(late.draw.zoom - TARGET.zoom) < 1e-3 * TARGET.zoom);
    assert.ok(F.maxAbsDiff(late.centre, TARGET.centre) < 1e-3);
    assert.ok(F.frameError(late.frame, 48) < 1e-5);
  });

  test(`${id}: the swing starts and ends with no jump, and the motion after it is no faster than normal running`, () => {
    const inst = F.ready(ET, id, SET, { seed: 3 });
    const before = copyState(inst.stateAt(T0));
    inst.face(TARGET, T0);
    const at = inst.stateAt(T0);
    assert.ok(F.maxAbsDiff(before.frame, at.frame) < 1e-6, `${id} frame at the swing's start`);
    assert.ok(F.maxAbsDiff(before.centre, at.centre) < 1e-6);
    assert.ok(Math.abs(before.zoom - at.draw.zoom) < 1e-9);
    const U = T0 + 6;
    // across U: one frame's change is no bigger than normal running's largest
    const normal = largestStep(F.ready(ET, id, SET, { seed: 3 }), 2, 32);
    const across = largestStep(inst, U - 2 / 60, U + 2 / 60);
    assert.ok(across <= normal * 1.05, `${id}: change across U ${across} against ${normal}`);
    // after U, for 20 s, within 1.25 times normal running (Tumble turns back onto its tour)
    const afterU = largestStep(inst, U, U + 20);
    assert.ok(afterU <= normal * 1.25, `${id}: largest step after U ${afterU} against ${normal}`);
    // centre and zoom come back with no jump
    const a = copyState(inst.stateAt(U - 1 / 600));
    const b = copyState(inst.stateAt(U + 1 / 600));
    assert.ok(F.maxAbsDiff(a.centre, b.centre) < 1e-3, `${id} centre across U`);
    assert.ok(Math.abs(a.zoom - b.zoom) < 1e-3 * a.zoom, `${id} zoom across U`);
  });
}

// ---------- criterion 2: Lattice and Wander carry on from the frame at the end ----------

test("criterion 2: after the swing Lattice resumes swapping axes from the frame at that moment", () => {
  const inst = F.ready(ET, "lattice", SET, { seed: 3 });
  inst.face(TARGET, T0);
  const U = T0 + 6;
  const end = new Float32Array(inst.stateAt(U - 1e-9).frame);
  const atU = new Float32Array(inst.stateAt(U).frame);
  assert.ok(F.maxAbsDiff(end, atU) < 1e-5, "no jump at U");
  // one axis at a time trades for a hidden direction: within a swap two rows stay, one turns
  const a = new Float32Array(inst.stateAt(U + 0.5).frame);
  const b = new Float32Array(inst.stateAt(U + 2.5).frame);
  const moved = [0, 1, 2].filter((r) => F.maxAbsDiff(a.subarray(r * 48, r * 48 + 48), b.subarray(r * 48, r * 48 + 48)) > 0);
  assert.deepStrictEqual(moved, [0]);
  assert.match(inst.stateAt(U + 0.5).status, /^swap 1 · axis X trading for a hidden direction · {2}15% · /);
  assert.match(inst.stateAt(U + 3.4 + 1).status, /^swap 2 · axis Y /);
  // and keeps swapping: after three swaps every axis has moved off the frame at U
  const later = inst.stateAt(U + 3 * 3.4 + 0.1).frame;
  for (let r = 0; r < 3; r++) {
    assert.ok(F.maxAbsDiff(later.subarray(r * 48, r * 48 + 48), atU.subarray(r * 48, r * 48 + 48)) > 0.05);
  }
  // the wires are still drawn during and after the swing
  assert.ok(inst.stateAt(T0 + 3).wires);
  assert.ok(inst.stateAt(U + 1).wires);
  assert.strictEqual(inst.describe().hidden, "strongest");
});

test("criterion 2: after the swing Wander resumes flying between points from the frame and centre at that moment", () => {
  const inst = F.ready(ET, "wander", SET, { seed: 3 });
  const hT = Math.floor(T0 / 4.8); // the hop the swing interrupts
  const route = inst.route(hT + 6);
  inst.face(TARGET, T0);
  const U = T0 + 6;
  // during the swing the spokes of the interrupted hop stay drawn
  const mid = inst.stateAt(T0 + 3);
  assert.strictEqual(mid.focus.to, route[hT]);
  const end = copyState(inst.stateAt(U - 1e-9));
  const atU = copyState(inst.stateAt(U));
  assert.ok(F.maxAbsDiff(end.frame, atU.frame) < 1e-5, "frame: no jump at U");
  assert.ok(F.maxAbsDiff(end.centre, atU.centre) < 1e-6, "centre: no jump at U");
  assert.strictEqual(atU.focus.phase, "travel");
  assert.strictEqual(atU.focus.from, -1);
  assert.strictEqual(atU.focus.to, route[hT + 1], "the next stop of the same route");
  assert.match(atU.status, /^heading to "/);
  // it arrives: dwelling with the centre exactly on the stop
  const dwell = inst.stateAt(U + 3.5);
  assert.strictEqual(dwell.focus.phase, "dwell");
  const j = route[hT + 1];
  assert.ok(F.bytesEqual(dwell.centre, SET.vectors.subarray(j * 48, j * 48 + 48)));
  // and keeps flying along the route, with no jump at the next hop's start
  for (let k = 1; k <= 3; k++) {
    const s = inst.stateAt(U + k * 4.8 + 1);
    assert.strictEqual(s.focus.to, route[hT + 1 + k]);
    assert.strictEqual(s.focus.from, route[hT + k]);
    assert.match(s.status, / → /);
    const x = new Float32Array(inst.stateAt(U + k * 4.8 - 1e-9).frame);
    const y = inst.stateAt(U + k * 4.8).frame;
    assert.ok(F.maxAbsDiff(x, y) < 1e-5, `no jump at hop ${k} after U`);
  }
  // a far query after the swing (past the hops kept) agrees with a fresh instance's
  const far = U + 400 * 4.8 + 1;
  const fresh = F.ready(ET, "wander", SET, { seed: 3 });
  fresh.face(TARGET, T0);
  const fa = new Float32Array(fresh.stateAt(far).frame);
  inst.stateAt(U + 100);
  assert.ok(F.bytesEqual(fa, inst.stateAt(far).frame));
  assert.ok(F.bytesEqual(new Float32Array(fresh.stateAt(U + 2).frame), inst.stateAt(U + 2).frame));
});

// ---------- criterion 3: pause and reduced motion ----------

for (const id of MODES) {
  test(`criterion 3: ${id}: with the clock stopped (pause, reduced motion) a swing does not move the view`, () => {
    const inst = F.ready(ET, id, SET, { seed: 3 });
    const shown = copyState(inst.stateAt(T0));
    // paused at T0: the search arrives, the clock does not advance
    assert.strictEqual(inst.face(TARGET, T0), true);
    const first = copyState(inst.stateAt(T0));
    assert.ok(F.maxAbsDiff(shown.frame, first.frame) < 1e-6);
    for (let i = 0; i < 120; i++) {
      const s = inst.stateAt(T0);
      assert.ok(F.bytesEqual(first.frame, s.frame) && F.bytesEqual(first.centre, s.centre));
      assert.strictEqual(s.draw.zoom, first.zoom);
    }
    // the swing runs on mode time: resumed later, it is where it would have been
    const resumed = copyState(inst.stateAt(T0 + 2));
    const unpaused = F.ready(ET, id, SET, { seed: 3 });
    unpaused.face(TARGET, T0);
    assert.ok(F.bytesEqual(resumed.frame, unpaused.stateAt(T0 + 2).frame));
    // step(0) (a paused viewer's frame) changes nothing
    const stepped = F.ready(ET, id, SET, { seed: 3 });
    stepped.step(T0);
    stepped.face(TARGET, stepped.time);
    const s0 = new Float32Array(stepped.step(0).frame);
    assert.ok(F.bytesEqual(s0, stepped.step(0).frame));
    assert.match(stepped.status(), /^swinging to face the search, then /);
  });
}

// ---------- criterion 4: the same calls give the same frames ----------

function swingRun(id, seed) {
  const E = freshAssembled();
  const set = F.sampleSet(E, { dimension: 48 });
  const inst = F.ready(E, id, set, { seed });
  const tA = target(E, set, [5, 300]);
  const tB = target(E, set, [40], 2);
  const frames = [];
  for (let i = 0; i <= 600; i++) {
    const t = i / 20; // 30 s
    if (i === 40) inst.face(tA, t, { searches: 2 }); // t = 2
    if (i === 100) inst.face(tB, t); // t = 5, during the first swing
    if (i === 300) inst.face(tA, t, { duration: 3 }); // t = 15
    if (i === 340) inst.face(null, t); // t = 17, ended early
    frames.push(copyState(inst.stateAt(t)));
  }
  return frames;
}

for (const id of MODES) {
  test(`criterion 4: ${id}: the same data, searches, seed and times give bit-identical frames in two fresh runs`, () => {
    const a = swingRun(id, 11);
    const b = swingRun(id, 11);
    assert.strictEqual(a.length, 601);
    for (let i = 0; i < a.length; i++) {
      assert.ok(F.bytesEqual(a[i].frame, b[i].frame), `${id} frame differs at frame ${i}`);
      assert.ok(F.bytesEqual(a[i].centre, b[i].centre), `${id} centre differs at frame ${i}`);
      assert.strictEqual(a[i].zoom, b[i].zoom);
      assert.strictEqual(a[i].status, b[i].status);
    }
    // the seed matters: another seed gives another sequence
    const c = swingRun(id, 12);
    assert.ok(a.some((s, i) => !F.bytesEqual(s.frame, c[i].frame)));
  });

  test(`${id}: times before a swing give the state as it was; queries in any order agree`, () => {
    const plain = F.ready(ET, id, SET, { seed: 5 });
    const faced = F.ready(ET, id, SET, { seed: 5 });
    plain.mark(0); // finished events (Lattice's wires) are shown from 0 in both
    faced.mark(0);
    faced.face(TARGET, T0);
    for (const t of [0, 1.5, 4.25, T0 - 1e-9]) {
      const x = new Float32Array(plain.stateAt(t).frame);
      const y = faced.stateAt(t);
      assert.ok(F.bytesEqual(x, y.frame), `${id} at ${t}`);
      assert.strictEqual(plain.stateAt(t).status, faced.stateAt(t).status);
    }
    const times = [T0 + 9, T0 + 2, T0 + 30, T0 + 6, T0 + 2, T0 + 0.5];
    const once = times.map((t) => new Float32Array(faced.stateAt(t).frame));
    const again = F.ready(ET, id, SET, { seed: 5 });
    again.face(TARGET, T0);
    for (let i = times.length - 1; i >= 0; i--) assert.ok(F.bytesEqual(once[i], again.stateAt(times[i]).frame));
  });
}

// ---------- the rest of the interface ----------

for (const id of MODES) {
  test(`${id}: face refuses what it cannot take, and face(null, t) ends a swing in progress`, () => {
    const notReady = ET.modes.create(id);
    notReady.enter(SET, { seed: 1 });
    assert.strictEqual(notReady.face(TARGET, 0), false);
    assert.strictEqual(notReady.face(null, 0), false);
    assert.strictEqual(ET.modes.create(id).face(TARGET, 0), false);
    const empty = F.ready(ET, id, F.emptySet(ET, 48), { seed: 1 });
    assert.strictEqual(empty.face(TARGET, 0), false);
    const inst = F.ready(ET, id, SET, { seed: 3 });
    const bad = [
      null,
      undefined,
      "frame",
      { ...TARGET, frame: TARGET.frame.subarray(1) },
      { ...TARGET, centre: new Float32Array(47) },
      { ...TARGET, zoom: 0 },
      { ...TARGET, zoom: Infinity },
      { ...TARGET, zoom: "1" },
      { ...TARGET, centre: new Float32Array(48).fill(Number.NaN) },
    ];
    for (const tg of bad.slice(1)) assert.strictEqual(inst.face(tg, 1), false);
    assert.strictEqual(inst.face(TARGET, 1, { duration: 0 }), false);
    assert.strictEqual(inst.face(TARGET, 1, { duration: Number.NaN }), false);
    assert.strictEqual(inst.describe().facing, null, "nothing changed");
    assert.strictEqual(inst.face(null, 1), false, "no swing to end");
    assert.throws(() => inst.face(TARGET, Number.NaN), RangeError);
    // a plain array target is copied
    assert.strictEqual(inst.face({ frame: Array.from(TARGET.frame), centre: Array.from(TARGET.centre), zoom: TARGET.zoom }, T0, { searches: 9 }), true);
    assert.match(inst.stateAt(T0 + 1).status, /the 4 searches/);
    // ended early at T0 + 2: the view carries on from the frame shown then, with no jump
    const shown = new Float32Array(inst.stateAt(T0 + 2).frame);
    assert.strictEqual(inst.face(null, T0 + 1), true, "an earlier time in the swing ends it there");
    assert.deepStrictEqual(inst.describe().facing, { at: T0, until: T0 + 1 });
    assert.strictEqual(inst.face(null, T0 + 2), false, "already ended");
    assert.strictEqual(inst.face(null, T0 - 1), false, "before it started");
    assert.doesNotMatch(inst.stateAt(T0 + 2).status, /swinging/);
    assert.ok(F.maxAbsDiff(inst.stateAt(T0 + 1 - 1e-9).frame, inst.stateAt(T0 + 1).frame) < 1e-5);
    assert.ok(F.maxAbsDiff(shown, inst.stateAt(T0 + 2).frame) > 0, "after the end the swing no longer applies");
  });

  test(`${id}: a new face during a swing starts a new one from the frame shown, and a time before the last swing is moved up to it`, () => {
    const inst = F.ready(ET, id, SET, { seed: 3 });
    const other = target(ET, SET, [40], 2);
    inst.face(TARGET, T0, { searches: 2 });
    const shown = new Float32Array(inst.stateAt(T0 + 2).frame);
    assert.strictEqual(inst.face(other, T0 + 2), true);
    assert.ok(F.maxAbsDiff(shown, inst.stateAt(T0 + 2).frame) < 1e-6);
    assert.deepStrictEqual(inst.describe().facing, { at: T0 + 2, until: T0 + 8 });
    assert.match(inst.stateAt(T0 + 3).status, /face the search,/);
    // a call at an earlier time than the last swing's start happens at that start
    assert.strictEqual(inst.face(TARGET, T0, { searches: 3 }), true);
    assert.deepStrictEqual(inst.describe().facing, { at: T0 + 2, until: T0 + 8 });
    assert.match(inst.stateAt(T0 + 3).status, /face the 3 searches,/);
    assert.ok(F.frameError(inst.stateAt(T0 + 7).frame, 48) < 1e-5);
  });

  test(`${id}: an append during a swing keeps it; leaving the mode ends it`, () => {
    const inst = F.ready(ET, id, SET, { seed: 3 });
    inst.face(TARGET, T0);
    const t = T0 + 2.5;
    const before = copyState(inst.stateAt(t));
    const bigger = F.appendTo(ET, SET, 40, { labelled: true, group: "new" });
    const r = inst.dataChanged(bigger, { op: "append", added: 40, t });
    assert.strictEqual(r.restart, false);
    if (r.work) r.work.step();
    inst.mark(t);
    const after = copyState(inst.stateAt(t));
    assert.ok(F.bytesEqual(before.frame, after.frame), `${id} frame unchanged at the append`);
    assert.ok(F.maxAbsDiff(before.centre, after.centre) < 1e-7);
    assert.match(inst.stateAt(t + 1).status, /^swinging/);
    assert.doesNotMatch(inst.stateAt(T0 + 6.5).status, /^swinging/);
    assert.ok(largestStep(inst, T0 + 5.5, T0 + 12) < 0.05, `${id} carries on after the append`);
    // a replace re-enters the mode from the view shown: no swing any more
    const replaced = inst.dataChanged(SET, { op: "replace", t: T0 + 3 });
    assert.strictEqual(replaced.restart, true);
    assert.strictEqual(inst.describe().facing, null);
    // a mode switch: the next mode enters from the last frame drawn, with no swing
    const last = copyState(inst.stateAt(0));
    inst.leave();
    assert.strictEqual(inst.face(TARGET, 1), false);
    const next = F.ready(ET, id === "tumble" ? "lattice" : "tumble", SET, { seed: 3, from: last });
    assert.strictEqual(next.describe().facing, null);
  });
}

test("lattice: with hidden directions from the full space the swap after a swing draws from it too", () => {
  const inst = F.ready(ET, "lattice", SET, { seed: 3 }, { hidden: "full" });
  assert.strictEqual(inst.face(TARGET, T0), true);
  assert.deepStrictEqual(heldPairs(inst, T0, 12), []);
  assert.strictEqual(inst.describe().hidden, "full");
});

test("tumble: a refit after a swing turns onto the new tour with no jump", () => {
  const inst = F.ready(ET, "tumble", SET, { seed: 3 });
  inst.face(TARGET, T0);
  const bigger = F.appendTo(ET, SET, 200);
  inst.dataChanged(bigger, { op: "append", added: 200, t: T0 + 1 });
  inst.refit(T0 + 8).step();
  assert.strictEqual(inst.describe().refitAt, T0 + 8);
  const x = new Float32Array(inst.stateAt(T0 + 8 - 1e-9).frame);
  assert.ok(F.maxAbsDiff(x, inst.stateAt(T0 + 8).frame) < 1e-5);
  assert.ok(largestStep(inst, T0 + 6, T0 + 30) < 0.03);
});

test("the facing hook is optional: it is not part of ET.modes.INTERFACE", () => {
  assert.ok(!ET.modes.INTERFACE.includes("face"));
  for (const id of MODES) assert.strictEqual(typeof ET.modes.create(id).face, "function");
  assert.strictEqual(ET.modes.SWING_DURATION, 6);
});

test("wander: an append in the leg after a swing keeps the hop in progress and the view", () => {
  const inst = F.ready(ET, "wander", SET, { seed: 3 });
  inst.face(TARGET, T0);
  const t = T0 + 6 + 5.5; // the second hop of the leg after the swing
  const before = copyState(inst.stateAt(t));
  const bigger = F.appendTo(ET, SET, 40, { labelled: true, group: "new" });
  assert.strictEqual(inst.dataChanged(bigger, { op: "append", added: 40, t }).restart, false);
  const after = copyState(inst.stateAt(t));
  assert.ok(F.bytesEqual(before.frame, after.frame));
  assert.strictEqual(before.focus.to, after.focus.to);
  assert.ok(largestStep(inst, t, t + 10) < 0.05);
});
