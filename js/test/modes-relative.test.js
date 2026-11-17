"use strict";
// Tumble's relative setting (task t6 of the relative-search plan): searchChanged and
// setRelative, the switch at a recorded time, the turn, the settled flag, the framing,
// state.relative and the status line. Binding names: docs/relative-interface.md,
// "Tumble (t6): the relative setting".
//
// The modes are loaded from the source modules (loadSources), so this file sees the
// change without the assembled file being rebuilt. Large arrays are never handed to an
// equality assertion: comparisons loop and report the first differing index.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");

const FIX = path.join(ROOT, "tests", "fixtures", "relative");
const TURN = 1.5; // relativeTransition's default, Tumble's entry transition

function loadFixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".json"), "utf8"));
  const buf = fs.readFileSync(path.join(FIX, meta.vectors.file));
  const D = meta.dimension;
  const N = meta.count;
  const X = new Float32Array(N * D);
  for (let i = 0; i < N * D; i++) X[i] = buf.readFloatLE(i * 4);
  const byLabel = {};
  meta.points.forEach((p, i) => {
    byLabel[p.label] = i;
  });
  return { X, N, D, byLabel };
}

let ETcache = null;
let wikiCache = null;
const ET = () => (ETcache ||= loadSources()._internal);
const wiki = () => (wikiCache ||= loadFixture("wikipedia-subset"));

// A set as Tumble reads it: rows [from, to) of the fixture.
function setOf(fx, from, to) {
  const D = fx.D;
  const a = from === undefined ? 0 : from;
  const b = to === undefined ? fx.N : to;
  return { dimension: D, count: b - a, vectors: fx.X.slice(a * D, b * D) };
}

// The full set with row `drop` left out.
function setWithout(fx, drop) {
  const D = fx.D;
  const v = new Float32Array((fx.N - 1) * D);
  let k = 0;
  for (let i = 0; i < fx.N; i++) {
    if (i === drop) continue;
    v.set(fx.X.subarray(i * D, (i + 1) * D), k * D);
    k++;
  }
  return { dimension: D, count: fx.N - 1, vectors: v };
}

function rowOf(fx, label) {
  const i = fx.byLabel[label];
  assert.ok(i !== undefined, "fixture holds " + label);
  return fx.X.slice(i * fx.D, (i + 1) * fx.D);
}

// The viewer's search object for Tumble: [[letter, label], ...]. `extra` sets scale,
// onlyResults and the indices (which Tumble must ignore).
function searchOf(fx, pairs, extra) {
  const e = extra || {};
  return {
    searches: pairs.map(([letter, label], j) => ({
      letter,
      query: rowOf(fx, label),
      indices: e.indices ? Int32Array.from(e.indices[j] || []) : new Int32Array([fx.byLabel[label]]),
    })),
    scale: e.scale === undefined ? null : e.scale,
    onlyResults: !!e.onlyResults,
  };
}

function ready(set, seed, createOpts) {
  const inst = ET().modes.create("tumble", createOpts);
  inst.enter(set, { seed: seed === undefined ? 7 : seed });
  inst.prepare().step();
  return inst;
}

// Pump a stepper to the end in one call, or one unit at a time while the view keeps
// being asked for frames (at times from `t0`, never reaching `mark`); then mark.
function pumpAndMark(inst, work, mode, t0, markAt) {
  if (work) {
    if (mode === "one") {
      work.step();
    } else {
      let k = 0;
      while (!work.step(0)) {
        k++;
        inst.stateAt(Math.min(t0 + k * 1e-4, markAt - 1e-3));
      }
    }
  }
  inst.mark(markAt);
}

function snap(inst, t) {
  const s = inst.stateAt(t);
  return {
    frame: new Float32Array(s.frame),
    centre: new Float32Array(s.centre),
    zoom: s.draw.zoom,
    perspective: s.draw.perspective,
    status: s.status,
    relative: s.relative ? { ...s.relative } : null,
  };
}

// The first index where two float32 arrays differ in their bits, or -1.
function firstDiff(A, B) {
  if (A.length !== B.length) return 0;
  const a = new Uint32Array(A.buffer, A.byteOffset, A.length);
  const b = new Uint32Array(B.buffer, B.byteOffset, B.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

function assertSameSnap(a, b, what) {
  let i = firstDiff(a.frame, b.frame);
  assert.strictEqual(i, -1, what + ": frames differ at index " + i);
  i = firstDiff(a.centre, b.centre);
  assert.strictEqual(i, -1, what + ": centres differ at index " + i);
  assert.ok(Object.is(a.zoom, b.zoom), what + ": zoom " + a.zoom + " vs " + b.zoom);
  assert.ok(Object.is(a.perspective, b.perspective), what + ": perspective " + a.perspective + " vs " + b.perspective);
  assert.strictEqual(a.status, b.status, what + ": status");
}

function frameError(F, D) {
  let worst = 0;
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += F[a * D + d] * F[b * D + d];
      worst = Math.max(worst, Math.abs(s - (a === b ? 1 : 0)));
    }
  }
  return worst;
}

function unit(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return Float64Array.from(v, (x) => x / n);
}

// Largest |row r of F - u|.
function rowGap(F, r, u, D) {
  let m = 0;
  for (let d = 0; d < D; d++) m = Math.max(m, Math.abs(F[r * D + d] - u[d]));
  return m;
}

// Length of u minus its projection on rows 0 and 1 of F.
function planeResidual(F, u, D) {
  const r = Float64Array.from(u);
  for (const row of [0, 1]) {
    let p = 0;
    for (let d = 0; d < D; d++) p += r[d] * F[row * D + d];
    for (let d = 0; d < D; d++) r[d] -= p * F[row * D + d];
  }
  let s = 0;
  for (const x of r) s += x * x;
  return Math.sqrt(s);
}

// ---------------------------------------------------------------------------

test("the members: searchChanged and setRelative exist and are optional in the interface", () => {
  const inst = ET().modes.create("tumble");
  assert.strictEqual(typeof inst.searchChanged, "function");
  assert.strictEqual(typeof inst.setRelative, "function");
  assert.ok(!ET().modes.INTERFACE.includes("searchChanged"));
  assert.ok(!ET().modes.INTERFACE.includes("setRelative"));
});

test("criterion 1: same data, seed, search changes and times give bit-identical frames, pumped in one step or one unit at a time", () => {
  const fx = wiki();
  const set = setOf(fx);
  const TIMES = [0, 1, 2.2, 2.5, 3.0, 3.6, 4.5, 6.5, 9.1, 30];
  function run(mode) {
    const inst = ready(set, 5);
    assert.strictEqual(inst.setRelative({ relative: true }, 0.5), null, "no search yet: no work");
    // Rice at 2.0; Wheat added mid-tour at 3.2, during the first turn; Rice removed at 7.
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 2.0), mode, 2.0, 2.1);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 3.2), mode, 3.2, 3.4);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["B", "Wheat"]]), 7.0), mode, 7.0, 7.3);
    return TIMES.map((t) => snap(inst, t));
  }
  const a = run("one");
  const b = run("units");
  const c = run("one");
  for (let i = 0; i < TIMES.length; i++) {
    assertSameSnap(a[i], b[i], "one step vs one-unit steps at t=" + TIMES[i]);
    assertSameSnap(a[i], c[i], "two fresh instances at t=" + TIMES[i]);
  }
  // The view really is relative after the switches.
  assert.ok(a[5].relative.active, "relative at 3.6");
  assert.strictEqual(a[9].relative.pinned[0].letter, "B");
});

test("criterion 2: the settled flag is false during the turn and true after; while true row 1 is the unit search direction within 1e-6", () => {
  const fx = wiki();
  const D = fx.D;
  const inst = ready(setOf(fx), 3);
  inst.setRelative({ relative: true }, 0);
  const work = inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0);
  assert.ok(work && typeof work.step === "function", "a fit is started");
  work.step();
  // Before the switch time is fixed nothing changes and the flag is false.
  assert.strictEqual(inst.describe().relative.pending, true);
  const T = 1.25;
  inst.mark(T);
  assert.strictEqual(inst.describe().relative.switchAt, T);
  assert.strictEqual(inst.describe().relative.pending, false);
  const u = unit(rowOf(fx, "Rice"));
  let settledSeen = 0;
  for (let k = 0; k <= 400; k++) {
    const t = T - 0.5 + k * 0.025;
    const s = inst.stateAt(t);
    if (t < T) {
      assert.strictEqual(s.relative.active, false, "not active before T at t=" + t);
      assert.strictEqual(s.relative.settled, false);
      continue;
    }
    assert.strictEqual(s.relative.active, true, "active from T at t=" + t);
    const turning = t - T < TURN;
    assert.strictEqual(s.relative.settled, !turning, "settled flag at t=" + t);
    if (s.relative.settled) {
      settledSeen++;
      const gap = rowGap(s.frame, 1, u, D);
      assert.ok(gap <= 1e-6, "row 1 is u within 1e-6 at t=" + t + " (gap " + gap + ")");
      assert.strictEqual(s.relative.mix, 1);
      assert.strictEqual(s.draw.perspective, ET().renderer.RELATIVE_PERSPECTIVE);
    } else {
      const low = t === T ? s.relative.mix === 0 : s.relative.mix > 0;
      assert.ok(low && s.relative.mix < 1, "mix from 0 toward 1 while turning at t=" + t + ": " + s.relative.mix);
      assert.ok(s.status.includes("turning until vertical = cosine to A"), s.status);
    }
  }
  assert.ok(settledSeen > 300);
  const s = inst.stateAt(20);
  assert.strictEqual(
    s.status.startsWith("relative to A · vertical = cosine to A, exact · the other two axes tumble through 8 directions holding "),
    true,
    s.status,
  );
  assert.ok(/holding \d+% of the remaining spread$/.test(s.status), s.status);
  assert.deepStrictEqual(s.relative.pinned.map((p) => [p.letter, p.axis]), [["A", "vertical"]]);
  assert.strictEqual(s.relative.measure, "cosine");
  assert.strictEqual(s.relative.free, 2);
});

test("criterion 3: add A, add B, remove A: B keeps its letter and ends vertical; every frame of each turn is orthonormal and the turn ends within the transition", () => {
  const fx = wiki();
  const D = fx.D;
  const inst = ready(setOf(fx), 11);
  inst.setRelative({ relative: true }, 0);
  const steps = [
    { at: 1.0, pairs: [["A", "Rice"]] },
    { at: 4.0, pairs: [["A", "Rice"], ["B", "Wheat"]] },
    { at: 8.0, pairs: [["B", "Wheat"]] },
  ];
  for (const st of steps) {
    const w = inst.searchChanged(searchOf(fx, st.pairs), st.at);
    assert.ok(w, "a fit is started at " + st.at);
    w.step();
    inst.mark(st.at);
    assert.ok(inst.describe().relative.transition <= TURN, "the turn takes at most the existing transition time");
    // Every frame of the turn at 120 frames a second, and a little past it.
    let worst = 0;
    for (let k = 0; k <= 200; k++) {
      const t = st.at + k / 120;
      const s = inst.stateAt(t);
      worst = Math.max(worst, frameError(s.frame, D));
      if (t - st.at < TURN) assert.strictEqual(s.relative.settled, false, "turning at t=" + t);
    }
    assert.ok(worst < 1e-5, "orthonormal through the turn at " + st.at + " (worst " + worst + ")");
    assert.strictEqual(inst.stateAt(st.at + TURN).relative.settled, true, "the turn has ended at T + " + TURN);
  }
  const s = inst.stateAt(12);
  assert.deepStrictEqual(s.relative.pinned.map((p) => [p.letter, p.axis]), [["B", "vertical"]]);
  const gap = rowGap(s.frame, 1, unit(rowOf(fx, "Wheat")), D);
  assert.ok(gap <= 1e-6, "B is the vertical row (gap " + gap + ")");
  assert.ok(s.status.startsWith("relative to B · vertical = cosine to B, exact"), s.status);
});

test("criterion 4: two searches span rows 0 and 1; three pin every row; a fourth changes no row; the same direction twice pins one axis", () => {
  const fx = wiki();
  const D = fx.D;
  // Two.
  const two = ready(setOf(fx), 2);
  two.setRelative({ relative: true }, 0);
  two.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 0.5).step();
  two.mark(0.5);
  for (const t of [2.5, 7, 19.3, 60]) {
    const s = two.stateAt(t);
    for (const label of ["Rice", "Wheat"]) {
      const r = planeResidual(s.frame, unit(rowOf(fx, label)), D);
      assert.ok(r < 1e-6, label + " lies in the span of rows 0 and 1 at t=" + t + " (residual " + r + ")");
    }
  }
  let st2 = two.stateAt(10);
  assert.deepStrictEqual(st2.relative.pinned.map((p) => [p.letter, p.axis]), [["A", "vertical"], ["B", "horizontal"]]);
  assert.ok(st2.status.includes(" · the plane of A and B is shown exactly · depth tumbles through 8 directions holding "), st2.status);

  // Three: nothing tours, no row changes with time.
  const pairs3 = [["A", "Rice"], ["B", "Wheat"], ["C", "Maize"]];
  const three = ready(setOf(fx), 2);
  three.setRelative({ relative: true }, 0);
  three.searchChanged(searchOf(fx, pairs3), 0.5).step();
  three.mark(0.5);
  const ref = snap(three, 2.0);
  for (const t of [2.5, 5, 11.1, 40, 300]) {
    const s = snap(three, t);
    const i = firstDiff(ref.frame, s.frame);
    assert.strictEqual(i, -1, "three pinned: the frame at t=" + t + " differs at " + i);
  }
  assert.strictEqual(ref.relative.free, 0);
  assert.strictEqual(ref.relative.subspace, 0);
  assert.ok(
    ref.status.endsWith(" · all three axes are pinned: the space of A, B and C is shown exactly · nothing tumbles"),
    ref.status,
  );

  // A fourth: lit, no axis, and no row changes (not even while its switch runs).
  const w4 = three.searchChanged(searchOf(fx, [...pairs3, ["D", "Bean"]]), 6.0);
  if (w4) w4.step();
  three.mark(6.0);
  for (const t of [6.0, 6.3, 7.4, 9, 50]) {
    const s = snap(three, t);
    const i = firstDiff(ref.frame, s.frame);
    assert.strictEqual(i, -1, "a fourth search changed the frame at t=" + t + " (index " + i + ")");
    assert.strictEqual(s.relative.settled, true, "still settled at t=" + t);
  }
  const s4 = three.stateAt(9);
  assert.deepStrictEqual(s4.relative.dropped, [{ letter: "D", reason: "no-axis-left", against: [] }]);
  assert.ok(s4.status.endsWith(" · nothing tumbles · D pins no axis"), s4.status);

  // The same direction twice: one axis, reported.
  const same = ready(setOf(fx), 2);
  same.setRelative({ relative: true }, 0);
  const sr = searchOf(fx, [["A", "Rice"], ["B", "Rice"]]);
  same.searchChanged(sr, 0.5).step();
  same.mark(0.5);
  const ss = same.stateAt(5);
  assert.strictEqual(ss.relative.pinned.length, 1);
  assert.deepStrictEqual(ss.relative.dropped, [{ letter: "B", reason: "same-direction", against: ["A"] }]);
  assert.ok(ss.status.includes("relative to A · ") && ss.status.endsWith(" · B pins no axis"), ss.status);
  // Its frames are those of A alone.
  const one = ready(setOf(fx), 2);
  one.setRelative({ relative: true }, 0);
  one.searchChanged(searchOf(fx, [["A", "Rice"]]), 0.5).step();
  one.mark(0.5);
  for (const t of [3, 8.8]) {
    const i = firstDiff(snap(one, t).frame, snap(same, t).frame);
    assert.strictEqual(i, -1, "same-direction pins nothing more at t=" + t + " (index " + i + ")");
  }
});

test("criterion 5: the point of view and the reranker never reach the frame", () => {
  const fx = wiki();
  const TIMES = [0.4, 1.3, 2.0, 2.7, 6, 15];
  const pairs = [["A", "Rice"], ["B", "Bread"]];
  const plain = searchOf(fx, pairs, { indices: [[1, 2, 3], [4, 5]] });
  const scale = new Float32Array(fx.D).fill(0.5);
  const pov = searchOf(fx, pairs, { scale, onlyResults: true, indices: [[9, 8, 7, 6], [1]] });
  function run(search, later) {
    const inst = ready(setOf(fx), 4);
    inst.setRelative({ relative: true }, 0);
    inst.searchChanged(search, 1.0).step();
    inst.mark(1.0);
    if (later) assert.strictEqual(inst.searchChanged(later, 2.0), null, "a change of indices, scale or onlyResults starts nothing");
    return TIMES.map((t) => snap(inst, t));
  }
  const a = run(plain, null);
  const b = run(pov, searchOf(fx, pairs, { scale: null, indices: [[0], [0, 1, 2]] }));
  for (let i = 0; i < TIMES.length; i++) assertSameSnap(a[i], b[i], "point of view / reranking at t=" + TIMES[i]);
});

test("criterion 6: mark() and a seek before a switch reproduce the frame shown then; an abandoned fit changes nothing", () => {
  const fx = wiki();
  const inst = ready(setOf(fx), 9);
  inst.setRelative({ relative: true }, 0);
  const shown = [];
  for (let k = 0; k <= 30; k++) shown.push([k * 0.1, snap(inst, k * 0.1)]);
  // An abandoned fit: started, half pumped, superseded; pumped to the end afterwards.
  const old = inst.searchChanged(searchOf(fx, [["A", "Maize"]]), 3.0);
  old.step(0);
  const w = inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 3.0);
  let k = 0;
  while (!w.step(0)) {
    k++;
    shown.push([3 + k * 1e-4, snap(inst, 3 + k * 1e-4)]); // the view keeps moving while the fit runs
  }
  assert.strictEqual(old.step(), true, "the abandoned stepper reports done");
  inst.mark(3.5);
  for (let k2 = 36; k2 <= 60; k2++) shown.push([k2 * 0.1, snap(inst, k2 * 0.1)]);
  const w2 = inst.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 6.5);
  w2.step();
  inst.mark(6.5);
  // Seek back to every time shown before each switch (and through the first turn).
  for (const [t, s] of shown) assertSameSnap(snap(inst, t), s, "seek back to t=" + t);
  // The abandoned search never shows.
  assert.deepStrictEqual(inst.stateAt(5).relative.pinned.map((p) => p.letter), ["A"]);
  const ref = ready(setOf(fx), 9);
  ref.setRelative({ relative: true }, 0);
  ref.searchChanged(searchOf(fx, [["A", "Rice"]]), 3.0).step();
  ref.mark(3.5);
  for (const t of [3.6, 4.2, 6.0]) assertSameSnap(snap(ref, t), snap(inst, t), "abandoned fit left no trace at t=" + t);
});

test("criterion 6: dataChanged with relative on matches a fresh instance given the final data (append)", () => {
  const fx = wiki();
  const D = fx.D;
  const base = setOf(fx, 0, 150);
  const full = { dimension: D, count: fx.N, vectors: fx.X.slice() };
  const pairs = [["A", "Rice"], ["B", "Bean"]];
  const inst = ready(base, 6);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, pairs), 0.5).step();
  inst.mark(0.5);
  const res = inst.dataChanged(full, { op: "append", t: 4 });
  assert.strictEqual(res.restart, false);
  // Since the review of pull request 13 (finding 6) an append starts no relative fit: the
  // fit shown is kept, and refit() (the viewer's quiet and share policy) makes it again.
  assert.ok(!res.work, "an append starts no fit");
  assert.strictEqual(inst.describe().relative.pending, false);
  const work = inst.refit();
  assert.ok(work && typeof work.step === "function", "the relative fit runs again on the new set");
  assert.strictEqual(inst.describe().relative.pending, true);
  work.step();
  inst.mark(4.2);
  assert.strictEqual(inst.describe().relative.switchAt, 4.2);
  // While the new fit's turn runs the frame stays orthonormal.
  for (let t = 4.2; t < 4.2 + TURN; t += 0.05) assert.ok(frameError(inst.stateAt(t).frame, D) < 1e-5);
  const fresh = ready(full, 6);
  fresh.setRelative({ relative: true }, 0);
  fresh.searchChanged(searchOf(fx, pairs), 0.5).step();
  fresh.mark(0.5);
  for (const t of [6, 9.4, 25]) assertSameSnap(snap(inst, t), snap(fresh, t), "append vs fresh at t=" + t);
});

test("criterion 6: dataChanged with relative on matches a fresh instance given the final data (replace, the searched point removed)", () => {
  const fx = wiki();
  const pairs = [["A", "Rice"]];
  const inst = ready(setOf(fx), 8);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, pairs), 0.5).step();
  inst.mark(0.5);
  const smaller = setWithout(fx, fx.byLabel.Rice);
  const res = inst.dataChanged(smaller, { op: "replace", t: 5 });
  assert.strictEqual(res.restart, true);
  res.work.step();
  inst.mark(1.0);
  const fresh = ready(smaller, 8);
  fresh.setRelative({ relative: true }, 0);
  const w = fresh.searchChanged(searchOf(fx, pairs), 0); // the query is Rice's vector, no longer in the set
  w.step();
  fresh.mark(1.0);
  for (const t of [3, 7.7, 21]) assertSameSnap(snap(inst, t), snap(fresh, t), "replace vs fresh at t=" + t);
  assert.strictEqual(inst.stateAt(7).relative.active, true);
});

test("criterion 7: with relative on, face() starts no swing; with it off, searchChanged changes nothing and face is today's", () => {
  const fx = wiki();
  const set = setOf(fx);
  const probe = ready(set, 1);
  const tgt = probe.stateAt(9);
  const target = { frame: new Float32Array(tgt.frame), centre: new Float32Array(tgt.centre), zoom: 1.3 };

  const on = ready(set, 1);
  on.setRelative({ relative: true }, 0);
  const w = on.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0);
  assert.strictEqual(on.face(target, 1.0), false, "no swing while a switch to the relative view is waiting");
  w.step();
  assert.strictEqual(on.face(target, 1.0), false, "nor once the fit is done");
  on.mark(1.2);
  assert.strictEqual(on.face(target, 2.0), false, "nor while the relative view is shown");
  assert.strictEqual(on.describe().facing, null);

  // Off: the queries are stored, nothing Tumble returns changes, including a swing.
  const TIMES = [0, 0.5, 1.5, 2.25, 4, 7, 10, 20];
  const plain = ready(set, 1);
  plain.face(target, 1.0);
  const told = ready(set, 1);
  assert.strictEqual(told.setRelative({ relative: false }, 0), null);
  assert.strictEqual(told.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 0.2), null);
  assert.strictEqual(told.face(target, 1.0), true);
  assert.strictEqual(told.searchChanged(searchOf(fx, [["A", "Maize"]]), 3.0), null);
  for (const t of TIMES) {
    const a = snap(plain, t);
    const b = snap(told, t);
    assertSameSnap(a, b, "relative off with searches at t=" + t);
    assert.strictEqual(b.relative, null);
    assert.strictEqual(b.perspective, undefined);
  }
  assert.deepStrictEqual(told.describe().relative, { relative: false, showOrigin: false, active: false, switchAt: null, pending: false });
  // On with no search that gives an axis: plain Tumble.
  const noAxis = ready(set, 1);
  noAxis.face(target, 1.0);
  assert.strictEqual(noAxis.setRelative({ relative: true }, 0.1), null);
  const zero = { searches: [{ letter: "A", query: new Float32Array(fx.D), indices: new Int32Array(0) }], scale: null, onlyResults: false };
  assert.strictEqual(noAxis.searchChanged(zero, 0.2), null);
  for (const t of TIMES) assertSameSnap(snap(plain, t), snap(noAxis, t), "relative on with no axis at t=" + t);
});

test("turning off turns back onto the plain tour, then the view is plain Tumble bit for bit", () => {
  const fx = wiki();
  const D = fx.D;
  const set = setOf(fx);
  const plain = ready(set, 12);
  const inst = ready(set, 12);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0).step();
  inst.mark(1.0);
  assert.strictEqual(inst.setRelative({ relative: false }, 4.0), null, "turning off needs no fit");
  assert.strictEqual(inst.describe().relative.switchAt, 4.0);
  for (let t = 4.0; t < 4.0 + TURN; t += 1 / 60) {
    const s = inst.stateAt(t);
    assert.ok(frameError(s.frame, D) < 1e-5, "orthonormal turning back at t=" + t);
    assert.strictEqual(s.relative.active, false);
    assert.ok(t === 4.0 ? s.relative.mix === 1 : s.relative.mix < 1, "mix goes back toward 0 at t=" + t);
  }
  for (const t of [4.0 + TURN, 7, 13.3]) {
    const a = snap(plain, t);
    const b = snap(inst, t);
    assertSameSnap(a, b, "plain again at t=" + t);
    assert.strictEqual(b.relative, null);
  }
  // On again with the same searches: the fit is reused and the switch is at the call's time.
  assert.strictEqual(inst.setRelative({ relative: true }, 14), null);
  assert.strictEqual(inst.describe().relative.switchAt, 14);
  assert.strictEqual(inst.stateAt(16).relative.settled, true);
});

test("Show the origin glides the centre and zoom to the wider window with no turn", () => {
  const fx = wiki();
  const D = fx.D;
  const a = ready(setOf(fx), 13);
  const b = ready(setOf(fx), 13);
  for (const inst of [a, b]) {
    inst.setRelative({ relative: true }, 0);
    inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 0.5).step();
    inst.mark(0.5);
  }
  const before = a.stateAt(3).relative.window;
  assert.ok(before.bottom > -0.06, "the window does not reach the origin on its own: " + before.bottom);
  assert.strictEqual(b.setRelative({ showOrigin: true }, 3), null);
  for (const t of [3.2, 4, 6]) {
    const i = firstDiff(snap(a, t).frame, snap(b, t).frame);
    assert.strictEqual(i, -1, "no turn at t=" + t + " (index " + i + ")");
  }
  const s = b.stateAt(6);
  assert.strictEqual(s.relative.window.bottom, -0.06);
  assert.strictEqual(s.relative.showOrigin, true);
  // The centre sits midway along the search, the zoom fills the window.
  const u = unit(rowOf(fx, "Rice"));
  const mid = (s.relative.window.top + s.relative.window.bottom) / 2;
  let gap = 0;
  for (let d = 0; d < D; d++) gap = Math.max(gap, Math.abs(s.centre[d] - mid * u[d]));
  assert.ok(gap < 1e-6, "centre on the search at the window's middle (gap " + gap + ")");
  const want = Math.min(0.78 / 0.46 / (s.relative.window.top - s.relative.window.bottom), 0.5 / (0.42 * 0.46));
  assert.ok(Math.abs(s.draw.zoom - want) < 1e-12, "zoom " + s.draw.zoom + " vs " + want);
  assert.ok(a.stateAt(6).draw.zoom > s.draw.zoom, "the wider window is zoomed out");
});

// Frobenius norm of the change between two frames.
function frameChange(A, B) {
  let s = 0;
  for (let i = 0; i < A.length; i++) s += (A[i] - B[i]) * (A[i] - B[i]);
  return Math.sqrt(s);
}

// A swing interrupted by a switch to the relative view: the setting is off, a search is
// active, face() swings toward it at 1.0 (until 7.0), and Relative is ticked either during
// the swing (3.0) or during the release after it (9.0).
for (const variant of [
  { name: "during the swing", on: 3.0 },
  { name: "during the release after the swing", on: 9.0 },
]) {
  test("a swing interrupted by the relative switch " + variant.name + ": orthonormal, no jump, reproducible, settled, and back to plain", () => {
    const fx = wiki();
    const D = fx.D;
    const set = setOf(fx);
    const FPS = 120;
    const H = 1 / FPS;
    const SWING_AT = 1.0;
    const OFF_AT = variant.on + 5;
    const probe = ready(set, 1);
    const tgt = probe.stateAt(9);
    const target = { frame: new Float32Array(tgt.frame), centre: new Float32Array(tgt.centre), zoom: 1.3 };
    const search = searchOf(fx, [["A", "Rice"]]);

    function run(mode, shownBefore) {
      const inst = ready(set, 1);
      assert.strictEqual(inst.searchChanged(search, 0.5), null, "setting off: stored only");
      assert.strictEqual(inst.face(target, SWING_AT), true, "the swing starts with the setting off");
      // Frames shown before the switch, recorded as the viewer would draw them.
      for (let t = 0; t < variant.on; t += 0.25) if (shownBefore) shownBefore.push([t, snap(inst, t)]);
      const w = inst.setRelative({ relative: true }, variant.on);
      assert.ok(w && typeof w.step === "function", "turning on with a search starts a fit");
      if (mode === "one") {
        w.step();
      } else {
        let k = 0;
        while (!w.step(0)) {
          k++;
          const t = Math.min(variant.on - 0.5 + k * 1e-4, variant.on - 1e-3);
          const s = snap(inst, t);
          if (shownBefore) shownBefore.push([t, s]);
        }
      }
      inst.mark(variant.on);
      return inst;
    }

    const shown = [];
    const a = run("one", null);
    const b = run("units", shown);
    assert.strictEqual(a.describe().relative.switchAt, variant.on);
    assert.ok(a.describe().facing.until <= Math.max(variant.on, 7.0) + 1e-12, "a swing in progress ends at the switch");

    // 3: bit-identical however pumped; seeking back reproduces what was shown before T.
    for (let t = 0; t <= OFF_AT; t += 0.37) assertSameSnap(snap(a, t), snap(b, t), "one step vs units at t=" + t);
    for (const [t, s] of shown) assertSameSnap(snap(b, t), s, "seek back to t=" + t);

    // 2: orthonormal at 120 fps from before the swing to well after the turn.
    let worst = 0;
    const end = variant.on + TURN + 2;
    for (let k = 0; k * H <= end; k++) worst = Math.max(worst, frameError(a.stateAt(k * H).frame, D));
    assert.ok(worst < 1e-5, "orthonormal through the swing and the turn (worst " + worst + ")");

    // 2: no jump at T. The turn starts from the frame shown at T (the blend is the identity
    // there, up to one orthonormalisation in double precision, about 1e-7), so the change
    // from T - 1/120 to T is the motion already under way. Bound: 1.5 times the largest
    // one-frame change seen over the second before T, plus 1e-5 for rounding.
    let before = 0;
    for (let k = 1; k <= FPS; k++) {
      const t = variant.on - k * H;
      before = Math.max(before, frameChange(snap(a, t).frame, snap(a, t - H).frame));
    }
    const jump = frameChange(snap(a, variant.on).frame, snap(a, variant.on - H).frame);
    assert.ok(jump <= 1.5 * before + 1e-5, "no jump at T: " + jump + " against one frame of motion " + before);

    // 4: settled after the turn, row 1 the search direction.
    const u = unit(rowOf(fx, "Rice"));
    for (const t of [variant.on + TURN, variant.on + TURN + 1.7, OFF_AT - 0.01]) {
      const s = a.stateAt(t);
      assert.strictEqual(s.relative.settled, true, "settled at t=" + t);
      const gap = rowGap(s.frame, 1, u, D);
      assert.ok(gap <= 1e-6, "row 1 is u within 1e-6 at t=" + t + " (gap " + gap + ")");
    }

    // 4: off again ends on plain Tumble, bit-identical to an instance with no history at all
    // (no search, no swing): the switch replaced the swing, and the turn back targets the
    // plain tour itself, not the swing's relabelled release.
    assert.strictEqual(a.setRelative({ relative: false }, OFF_AT), null);
    const fresh = ready(set, 1);
    for (const t of [OFF_AT + TURN, OFF_AT + 4.4, OFF_AT + 20]) {
      const s = snap(a, t);
      assertSameSnap(s, snap(fresh, t), "plain again at t=" + t);
      assert.strictEqual(s.relative, null);
    }
  });
}

// ----- t18 (deviation d4): the free axes reuse the plain fit ---------------------
//
// Tumble hands its relative fit the plain fit's directions for the same set (the
// centred set's 8 strongest directions, seed and rows as the plain tour fits them), so
// the free rows tour those directions with the searches removed. When the plain
// directions of the set are not known yet (after an append, or before the preparation
// has finished) the relative preparation fits them itself, the same computation, and
// keeps them with the set; the view is the same either way.

// A copy of a set: a new object, so that nothing kept with the original is found for it.
function copyOf(set) {
  return { dimension: set.dimension, count: set.count, vectors: set.vectors.slice() };
}

// What ET.math gives for the set with the plain directions reused, as Tumble asks.
function reusedFit(set, labels, seed) {
  const M = ET().math;
  const { vectors: X, count: N, dimension: D } = set;
  const plain = M.principalDirections(M.centre(X, N, D).data, N, D, 8, { seed });
  const qs = labels.map((l) => rowOf(wiki(), l));
  return M.relativeFit(X, N, D, qs, { seed, subspace: 8, sampleRows: 4096, plain });
}

test("t18: Tumble's relative fit tours the plain fit's directions with the searches removed", () => {
  const fx = wiki();
  const set = setOf(fx);
  for (const labels of [["Rice"], ["Rice", "Wheat"]]) {
    const inst = ready(set, 7);
    inst.setRelative({ relative: true }, 0);
    const pairs = labels.map((l, j) => ["AB"[j], l]);
    inst.searchChanged(searchOf(fx, pairs), 0.5).step();
    inst.mark(0.5);
    const s = inst.stateAt(5).relative;
    const want = reusedFit(set, labels, 7);
    assert.strictEqual(want.method, "plain-reused");
    assert.ok(Object.is(s.share, want.share), labels.join("+") + ": share " + s.share + " vs " + want.share);
    assert.strictEqual(s.subspace, want.subspace);
    const full = ET().math.relativeFit(set.vectors, set.count, set.dimension, labels.map((l) => rowOf(fx, l)), { seed: 7, sampleRows: 4096 });
    assert.ok(!Object.is(s.share, full.share), "not the full fit's share");
  }
});

test("t18: after an append the relative fit uses the new set's plain directions, and keeps them for the refit", () => {
  const fx = wiki();
  const D = fx.D;
  const base = setOf(fx, 0, 150);
  const full = setOf(fx);
  const M = ET().modes;
  const inst = ready(base, 6);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 0.5).step();
  inst.mark(0.5);
  assert.strictEqual(M.fittedDirections(full, 6, 8, undefined), undefined, "the new set has no plain fit yet");
  inst.dataChanged(full, { op: "append", t: 4 });
  inst.refit().step(); // the refit makes the relative fit again (finding 6 of the review of pull request 13)
  inst.mark(4.2);
  const s = inst.stateAt(9).relative;
  const want = reusedFit(full, ["Rice"], 6);
  assert.ok(Object.is(s.share, want.share), "share " + s.share + " vs " + want.share);
  // Not the old set's directions.
  const Mm = ET().math;
  const oldPlain = Mm.principalDirections(Mm.centre(base.vectors, 150, D).data, 150, D, 8, { seed: 6 });
  const stale = Mm.relativeFit(full.vectors, full.count, D, [rowOf(fx, "Rice")], { seed: 6, sampleRows: 4096, plain: oldPlain });
  assert.ok(!Object.is(s.share, stale.share), "not the share of the old set's directions");
  // The new set's plain directions are kept with it: the plain refit gets them at once.
  const kept = M.fittedDirections(full, 6, 8, undefined);
  assert.ok(kept && kept.count === 8, "kept with the new set");
  const fresh = ready(copyOf(full), 6);
  const freshPlain = fresh.describe();
  const refit = inst.refit();
  refit.step();
  inst.mark(20);
  assert.strictEqual(inst.describe().varianceShare, freshPlain.varianceShare, "the refit's share is the fresh plain fit's");
});

test("t18: a relative fit pumped before the preparation finishes fits the plain directions itself, with the same view", () => {
  const fx = wiki();
  const TIMES = [1.0, 1.7, 3, 8.5, 22];
  const pairs = [["A", "Rice"]];
  function normal() {
    const inst = ready(copyOf(setOf(fx)), 3);
    inst.setRelative({ relative: true }, 0);
    inst.searchChanged(searchOf(fx, pairs), 0.5).step();
    inst.mark(1.0);
    return inst;
  }
  // The relative fit is pumped to the end first, then the preparation.
  function early() {
    const set = copyOf(setOf(fx));
    const inst = ET().modes.create("tumble");
    inst.enter(set, { seed: 3 });
    const prep = inst.prepare();
    assert.strictEqual(inst.setRelative({ relative: true }, 0), null);
    const work = inst.searchChanged(searchOf(fx, pairs), 0.5);
    assert.ok(work, "a fit is started before the preparation is done");
    work.step();
    assert.ok(ET().modes.fittedDirections(set, 3, 8, undefined), "the plain directions it fitted are kept with the set");
    prep.step();
    inst.mark(1.0);
    return inst;
  }
  // Interleaved: a few units of the relative fit, then the whole preparation, then the rest.
  function interleaved() {
    const set = copyOf(setOf(fx));
    const inst = ET().modes.create("tumble");
    inst.enter(set, { seed: 3 });
    const prep = inst.prepare();
    inst.setRelative({ relative: true }, 0);
    const work = inst.searchChanged(searchOf(fx, pairs), 0.5);
    for (let k = 0; k < 5; k++) work.step(0);
    assert.strictEqual(work.done, false);
    prep.step();
    work.step();
    inst.mark(1.0);
    return inst;
  }
  const a = normal();
  for (const [name, b] of [
    ["early", early()],
    ["interleaved", interleaved()],
  ]) {
    for (const t of TIMES) assertSameSnap(snap(a, t), snap(b, t), name + " vs normal at t=" + t);
  }
});

test("t18: after a replace the relative fit uses the new set's plain directions", () => {
  const fx = wiki();
  const inst = ready(setOf(fx), 8);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 0.5).step();
  inst.mark(0.5);
  const smaller = setWithout(fx, fx.byLabel.Rice);
  const res = inst.dataChanged(smaller, { op: "replace", t: 5 });
  res.work.step();
  inst.mark(1.0);
  const want = reusedFit(smaller, ["Rice"], 8);
  assert.ok(Object.is(inst.stateAt(7).relative.share, want.share), "share of the new set's plain directions");
});

// ---------- t19: with the clock stopped, the relative view is shown at once ----------
//
// The viewer tells Tumble that its clock is not advancing (paused, or reduced motion) with
// inst.setStill(true). A switch or a framing change fixed while still has no turn: the event
// records duration 0, so the next frame is the settled view (or the plain one when turning
// off). With setStill(false), or never called, nothing changes, bit for bit.

test("t19: setStill is an optional member, not part of the interface", () => {
  const inst = ET().modes.create("tumble");
  assert.strictEqual(typeof inst.setStill, "function");
  assert.ok(!ET().modes.INTERFACE.includes("setStill"));
});

test("t19: still, each kind of change takes effect at its time with no turn, settled at once", () => {
  const fx = wiki();
  const D = fx.D;
  const set = setOf(fx);
  const inst = ready(set, 4);
  const plain = ready(set, 4);
  inst.setStill(true);
  const T0 = 2.0;
  // Relative on with a search: a fit, then mark (as the viewer marks while paused).
  inst.setRelative({ relative: true }, 0);
  const w = inst.searchChanged(searchOf(fx, [["A", "Rice"]]), T0);
  w.step();
  inst.mark(T0);
  let s = inst.stateAt(T0);
  assert.strictEqual(s.relative.active, true);
  assert.strictEqual(s.relative.settled, true, "settled at the switch time itself");
  assert.strictEqual(s.relative.mix, 1);
  assert.strictEqual(s.draw.perspective, ET().renderer.RELATIVE_PERSPECTIVE);
  assert.ok(rowGap(s.frame, 1, unit(rowOf(fx, "Rice")), D) <= 1e-6, "row 1 is the search's direction");
  assert.ok(s.status.includes("vertical = cosine to A, exact"), s.status);
  assert.strictEqual(inst.describe().relative.instant, true, "the event records that it had no turn");
  // Before the switch: the plain view, exactly as an instance with no search shows it.
  assertSameSnap(snap(inst, T0 - 0.01), snap(plain, T0 - 0.01), "seek before the switch");
  // The framing is the target at once (stateAt hands back one object, so ask again).
  s = inst.stateAt(T0);
  const win = s.relative.window;
  const want = Math.min(0.78 / 0.46 / (win.top - win.bottom), 0.5 / (0.42 * 0.46));
  assert.ok(Math.abs(s.draw.zoom - want) < 1e-12, "zoom at the target: " + s.draw.zoom);

  // Add a search: B pins the horizontal axis at once.
  const w2 = inst.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), T0);
  w2.step();
  inst.mark(T0);
  s = inst.stateAt(T0);
  assert.deepStrictEqual(s.relative.pinned.map((p) => p.letter), ["A", "B"]);
  assert.strictEqual(s.relative.settled, true);
  assert.ok(planeResidual(s.frame, unit(rowOf(fx, "Wheat")), D) < 1e-5, "B in the plane of rows 0 and 1");

  // Remove A: B is vertical at once.
  const w3 = inst.searchChanged(searchOf(fx, [["B", "Wheat"]]), T0);
  w3.step();
  inst.mark(T0);
  s = inst.stateAt(T0);
  assert.deepStrictEqual(s.relative.pinned.map((p) => p.letter), ["B"]);
  assert.strictEqual(s.relative.settled, true);
  assert.ok(rowGap(s.frame, 1, unit(rowOf(fx, "Wheat")), D) <= 1e-6, "row 1 is B's direction");

  // Show the origin: the wider window at once.
  assert.strictEqual(inst.setRelative({ showOrigin: true }, T0), null);
  s = inst.stateAt(T0);
  assert.strictEqual(s.relative.window.bottom <= -0.06, true);
  const win2 = s.relative.window;
  const want2 = Math.min(0.78 / 0.46 / (win2.top - win2.bottom), 0.5 / (0.42 * 0.46));
  assert.ok(Math.abs(s.draw.zoom - want2) < 1e-12, "zoom at the wider window: " + s.draw.zoom);
  inst.setRelative({ showOrigin: false }, T0);

  // Relative off: the plain view at once, plain Tumble bit for bit.
  assert.strictEqual(inst.setRelative({ relative: false }, T0), null);
  const off = snap(inst, T0);
  assert.strictEqual(off.relative, null);
  assertSameSnap(off, snap(plain, T0), "off at once");
  // And every later time is plain Tumble.
  for (const t of [T0 + 0.5, T0 + 3]) assertSameSnap(snap(inst, t), snap(plain, t), "plain after at t=" + t);
});

test("t19: still, the same changes at the same times give the same frames in two instances; seek reproduces each earlier view", () => {
  const fx = wiki();
  const set = setOf(fx);
  const TIMES = [0, 1, 1.5, 1.6, 2.0, 2.9, 3.0, 3.5, 5, 9];
  function run() {
    const inst = ready(set, 6);
    inst.setStill(true);
    inst.setRelative({ relative: true }, 0);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.5), "one", 1.5, 1.5);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 3.0), "units", 3.0, 3.0);
    return inst;
  }
  const a = run();
  const b = run();
  for (const t of TIMES) assertSameSnap(snap(a, t), snap(b, t), "two instances at t=" + t);
  assert.strictEqual(a.stateAt(1.4).relative.active, false, "before the first switch: plain");
  assert.deepStrictEqual(a.stateAt(2.9).relative.pinned.map((p) => p.letter), ["A"], "between: A only, settled");
  assert.strictEqual(a.stateAt(2.9).relative.settled, true);
  assert.deepStrictEqual(a.stateAt(3.0).relative.pinned.map((p) => p.letter), ["A", "B"]);
});

test("t19: with the clock running (setStill false, or never told) every frame is bit-identical to before", () => {
  const fx = wiki();
  const set = setOf(fx);
  const TIMES = [0, 1, 2.2, 2.5, 3.0, 3.6, 4.5, 6.5, 9.1, 30];
  function run(still) {
    const inst = ready(set, 5);
    if (still !== undefined) inst.setStill(still);
    inst.setRelative({ relative: true }, 0.5);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 2.0), "one", 2.0, 2.1);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 3.2), "one", 3.2, 3.4);
    inst.setRelative({ showOrigin: true }, 5.0);
    pumpAndMark(inst, inst.searchChanged(searchOf(fx, [["B", "Wheat"]]), 7.0), "one", 7.0, 7.3);
    return inst;
  }
  const never = run(undefined);
  const told = run(false);
  // Told still and then running again before any change: also unchanged.
  const back = ready(set, 5);
  back.setStill(true);
  back.setStill(false);
  back.setRelative({ relative: true }, 0.5);
  pumpAndMark(back, back.searchChanged(searchOf(fx, [["A", "Rice"]]), 2.0), "one", 2.0, 2.1);
  pumpAndMark(back, back.searchChanged(searchOf(fx, [["A", "Rice"], ["B", "Wheat"]]), 3.2), "one", 3.2, 3.4);
  back.setRelative({ showOrigin: true }, 5.0);
  pumpAndMark(back, back.searchChanged(searchOf(fx, [["B", "Wheat"]]), 7.0), "one", 7.0, 7.3);
  for (const t of TIMES) {
    assertSameSnap(snap(never, t), snap(told, t), "setStill(false) at t=" + t);
    assertSameSnap(snap(never, t), snap(back, t), "still then running at t=" + t);
  }
  assert.strictEqual(never.stateAt(3.4 + TURN / 2).relative.settled, false, "the turn is still there");
  assert.strictEqual(never.describe().relative.instant, false);
});

test("t19: a fit finished after the clock starts again turns as usual; still decides at the switch, not the call", () => {
  const fx = wiki();
  const set = setOf(fx);
  const inst = ready(set, 2);
  inst.setStill(true);
  inst.setRelative({ relative: true }, 0);
  const w = inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0);
  w.step();
  inst.setStill(false); // Play pressed before the switch time was fixed
  inst.mark(1.0);
  assert.strictEqual(inst.stateAt(1.0 + TURN / 2).relative.settled, false, "a turn");
  const ref = ready(set, 2);
  ref.setRelative({ relative: true }, 0);
  ref.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0).step();
  ref.mark(1.0);
  for (const t of [1.0, 1.4, 2.0, 3.0]) assertSameSnap(snap(inst, t), snap(ref, t), "as never still at t=" + t);
});
