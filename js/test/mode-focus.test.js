"use strict";
// Focus (js/src/43-mode-focus.js, js/api/43-mode-focus.md): the fourth mode. The view is
// the fit of the searches' queries and named results, or of the whole set with none, and
// it turns smoothly onto a new fit when the searches change. Run through the assembled
// file, which is what ships and what coverage is measured on.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadAssembled, loadSources, SRC_DIR } = require("./helpers/load.js");
const F = require("./helpers/modes-fixtures.js");

const ET = loadAssembled()._internal;
const SEED = 11;

const SET = F.sampleSet(ET, { dimension: 48, count: 700, seed: 4 });
const D = SET.dimension;

function rowOf(i) {
  return SET.vectors.slice(i * D, (i + 1) * D);
}

// A search entry: the query is row `at`'s vector, the results its k nearest.
function entry(at, k, letter) {
  const ranking = ET.search.rank(SET, rowOf(at), { k });
  return { letter, query: rowOf(at), indices: Int32Array.from(ranking.hits, (h) => h.index) };
}

function searchOf(entries, extra) {
  return { searches: entries, scale: null, onlyResults: false, ...extra };
}

function focusReady(set, opts, createOpts) {
  const inst = ET.modes.create("focus", createOpts);
  inst.enter(set || SET, opts || { seed: SEED });
  inst.prepare().step();
  return inst;
}

function copyState(s) {
  return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: { ...s.draw }, status: s.status };
}

function bytes(A) {
  return Buffer.from(A.buffer, A.byteOffset, A.byteLength);
}

function sameBits(A, B) {
  return A.length === B.length && bytes(A).equals(bytes(B));
}

// Apply a search at mode time t the way the viewer does: pump what it returns, mark, query.
function apply(inst, search, t) {
  const work = inst.searchChanged(search, t);
  if (work) work.step();
  inst.mark(t);
  return work;
}

function dot(a, ao, b, bo) {
  let s = 0;
  for (let d = 0; d < D; d++) s += a[ao + d] * b[bo + d];
  return s;
}

// Largest |cos| of the angle between the span of the frame's rows and a direction.
function inSpan(frame, v) {
  let s = 0;
  const n = Math.sqrt(dot(v, 0, v, 0));
  for (let r = 0; r < 3; r++) s += (dot(frame, r * D, v, 0) / n) ** 2;
  return Math.sqrt(s);
}

test("criterion 1: Focus registers through the existing interface and edits no existing file", () => {
  assert.ok(fs.existsSync(path.join(SRC_DIR, "43-mode-focus.js")));
  const only = loadSources(["10-math.js", "39-modes.js", "43-mode-focus.js"])._internal;
  assert.deepStrictEqual(Array.from(only.modes.ids()), ["focus"]);
  assert.deepStrictEqual(Array.from(ET.modes.ids()), ["tumble", "lattice", "wander", "focus"]);
  const def = ET.modes.get("focus");
  assert.strictEqual(def.title, "Focus");
  assert.ok(def.summary.length > 0);
  const inst = ET.modes.create("focus");
  assert.deepStrictEqual(ET.modes.check(inst), []);
  assert.strictEqual(typeof inst.searchChanged, "function");
  assert.strictEqual(inst.face, undefined, "Focus has no face member");
  assert.throws(() => ET.modes.create("focus").enter(F.tinyDimensionSet(ET, 2, 10), { seed: 1 }), {
    name: "RangeError",
  });
});

test("with no search the frame is the fit of the whole set: its strongest directions about its mean", () => {
  const inst = focusReady();
  const s = inst.stateAt(0);
  assert.ok(F.frameError(s.frame, D) < 1e-5);
  assert.strictEqual(s.status, "fitted to every point");
  const stats = ET.modes.stats(SET);
  for (let d = 0; d < D; d++) assert.ok(Math.abs(s.centre[d] - stats.mean[d]) < 1e-6);
  const cen = ET.math.centre(SET.vectors, SET.count, D);
  const top = ET.math.principalDirections(cen.data, SET.count, D, 3, { seed: SEED });
  for (let r = 0; r < 3; r++) {
    const row = s.frame.slice(r * D, (r + 1) * D);
    const along = ET.math.varianceShare(cen.data, SET.count, D, row, 1);
    assert.ok(along > 0.5 * top.shares[r], "row " + r + " holds variance like the strongest directions");
  }
  const d = inst.describe();
  assert.deepStrictEqual(
    { id: d.id, fittedTo: d.fittedTo, searches: d.searches, onlyResults: d.onlyResults, varianceShare: d.varianceShare },
    { id: "focus", fittedTo: "all", searches: [], onlyResults: false, varianceShare: null },
  );
  assert.ok(/linear/i.test(d.projection));
  assert.strictEqual(d.seed, SEED);
});

test("with a search the frame is the fit of the results and the query", () => {
  const e = entry(40, 8, "A");
  const inst = focusReady();
  apply(inst, searchOf([e]), 0);
  const later = inst.stateAt(10);
  assert.strictEqual(later.status, "fitted to the results of A");
  assert.ok(F.frameError(later.frame, D) < 1e-5);
  // The same frame as the facing frame of the query and its results (aligned to the view
  // before): compare spans, which do not depend on axis order or sign.
  const direct = ET.searchSets.facingFrame(
    SET,
    [{ query: e.query, hits: Array.from(e.indices, (index) => ({ index })) }],
    { seed: SEED },
  );
  for (let r = 0; r < 3; r++) {
    assert.ok(inSpan(later.frame, direct.frame.slice(r * D, (r + 1) * D)) > 1 - 1e-5, "row " + r + " in the span");
  }
  assert.ok(sameBits(later.centre, direct.centre));
  assert.ok(Math.abs(later.draw.zoom - direct.zoom) < 1e-9);
  // The rows it was fitted to are spread in the view: it shows the query and results apart.
  const rows = [e.query, ...Array.from(e.indices, (i) => rowOf(i))];
  let spread = 0;
  for (const v of rows) {
    for (let r = 0; r < 3; r++) {
      let p = 0;
      for (let d = 0; d < D; d++) p += (v[d] - later.centre[d]) * later.frame[r * D + d];
      spread += p * p;
    }
  }
  assert.ok(spread > 0);
  const desc = inst.describe();
  assert.strictEqual(desc.fittedTo, "results");
  assert.deepStrictEqual(Array.from(desc.searches), ["A"]);
});

test("two searches name both letters and the first axis joins their centres", () => {
  const a = entry(5, 6, "A");
  const b = entry(300, 6, "B");
  const inst = focusReady();
  apply(inst, searchOf([a, b]), 0);
  const s = inst.stateAt(20);
  assert.strictEqual(s.status, "fitted to the results of A, B");
  assert.deepStrictEqual(Array.from(inst.describe().searches), ["A", "B"]);
  const direct = ET.searchSets.facingFrame(
    SET,
    [a, b].map((x) => ({ query: x.query, hits: Array.from(x.indices, (index) => ({ index })) })),
    { seed: SEED },
  );
  assert.strictEqual(direct.fromCentres, 1);
  for (let r = 0; r < 3; r++) assert.ok(inSpan(s.frame, direct.frame.slice(r * D, (r + 1) * D)) > 1 - 1e-5);
});

test("changing the search turns smoothly onto the new fit and a cleared search returns to the whole set", () => {
  const inst = focusReady();
  const whole = copyState(inst.stateAt(3));
  apply(inst, searchOf([entry(40, 8, "A")]), 4);
  const target = copyState(inst.stateAt(20));
  // Before the switch time nothing changed; at it the frame starts from the whole-set view.
  assert.ok(sameBits(inst.stateAt(3.9).frame, whole.frame));
  const start = inst.stateAt(4);
  assert.ok(F.maxAbsDiff(start.frame, whole.frame) < 1e-6);
  // Smooth: small steps, orthonormal, monotone progress to the target.
  let prev = copyState(start);
  let biggest = 0;
  let previousGap = Infinity;
  for (let t = 4; t <= 4 + 1.6 + 0.2; t += 1 / 60) {
    const s = inst.stateAt(t);
    assert.ok(F.frameError(s.frame, D) < 1e-5, "orthonormal at " + t);
    biggest = Math.max(biggest, F.maxAbsDiff(s.frame, prev.frame));
    const gap = F.maxAbsDiff(s.frame, target.frame);
    assert.ok(gap <= previousGap + 1e-6, "approaches the target");
    previousGap = gap;
    prev = copyState(s);
  }
  assert.ok(biggest < 0.1, "no jump between frames: " + biggest);
  assert.ok(F.maxAbsDiff(inst.stateAt(4 + 1.6).frame, target.frame) < 1e-6);
  // Back to no search: the whole-set fit, again smoothly.
  apply(inst, null, 30);
  assert.ok(F.maxAbsDiff(inst.stateAt(30).frame, target.frame) < 1e-6);
  const back = inst.stateAt(40);
  assert.strictEqual(back.status, "fitted to every point");
  assert.ok(F.maxAbsDiff(back.frame, whole.frame) < 1e-5 || sameBits(back.centre, whole.centre));
  assert.deepStrictEqual(inst.describe().searches, []);
  // A second change during a turn starts from the view shown then.
  apply(inst, searchOf([entry(40, 8, "A")]), 50);
  const mid = copyState(inst.stateAt(50.5));
  apply(inst, searchOf([entry(500, 8, "A")]), 50.5);
  assert.ok(F.maxAbsDiff(inst.stateAt(50.5).frame, mid.frame) < 1e-6);
});

test("the fit is made in slices and the view keeps its place until it is done", () => {
  const inst = focusReady();
  const before = copyState(inst.stateAt(1));
  const work = inst.searchChanged(searchOf([entry(40, 8, "A")]), 1);
  assert.ok(work && typeof work.step === "function");
  assert.strictEqual(work.done, false);
  let units = 0;
  while (!work.step(0)) {
    units++;
    assert.ok(sameBits(inst.stateAt(1.5).frame, before.frame), "the view has not moved");
    assert.ok(units < 10000);
  }
  assert.ok(work.done);
  inst.mark(2);
  assert.ok(sameBits(inst.stateAt(2).frame, before.frame) || F.maxAbsDiff(inst.stateAt(2).frame, before.frame) < 1e-6);
  assert.ok(F.maxAbsDiff(inst.stateAt(5).frame, before.frame) > 1e-3, "it has turned");
});

test("a search superseded while its fit runs is dropped; the latest wins", () => {
  const inst = focusReady();
  const first = inst.searchChanged(searchOf([entry(40, 8, "A")]), 1);
  const second = inst.searchChanged(searchOf([entry(500, 8, "B")]), 1.2);
  first.step();
  assert.strictEqual(first.done, true);
  inst.mark(2);
  assert.strictEqual(inst.stateAt(3).status, "fitted to every point", "the stale fit changed nothing");
  second.step();
  inst.mark(3);
  assert.strictEqual(inst.stateAt(10).status, "fitted to the results of B");
});

test("criterion 3: Only results hides the other points in Focus only", () => {
  const e = entry(40, 8, "A");
  const inst = focusReady();
  assert.strictEqual(inst.stateAt(5).draw.unlitGain, undefined, "no search: no hiding");
  apply(inst, searchOf([e]), 5);
  assert.strictEqual(inst.stateAt(8).draw.unlitGain, undefined, "off by default: dimmed, not hidden");
  assert.strictEqual(inst.searchChanged(searchOf([e], { onlyResults: true }), 9), null, "no refit for a setting");
  assert.strictEqual(inst.stateAt(10).draw.unlitGain, 0);
  assert.strictEqual(inst.describe().onlyResults, true);
  const frameWith = copyState(inst.stateAt(12));
  inst.searchChanged(searchOf([e], { onlyResults: false }), 13);
  assert.strictEqual(inst.stateAt(12).draw.unlitGain, undefined);
  assert.ok(sameBits(inst.stateAt(12).frame, frameWith.frame), "the setting does not move the view");
  // With no usable search the setting hides nothing.
  inst.searchChanged({ searches: [], onlyResults: true }, 14);
  assert.strictEqual(inst.stateAt(15).draw.unlitGain, undefined);
  // The other three modes never set it.
  for (const id of ["tumble", "lattice", "wander"]) {
    const m = F.ready(ET, id, SET, { seed: SEED });
    for (const t of [0, 2, 9]) assert.strictEqual(m.stateAt(t).draw.unlitGain, undefined, id);
    assert.strictEqual(m.searchChanged, undefined, id + " does not take searches");
  }
});

test("criterion 4: frames are deterministic for the same data, search, seed and time", () => {
  const run = (budget) => {
    const inst = ET.modes.create("focus");
    inst.enter(SET, { seed: SEED });
    const prep = inst.prepare();
    while (!prep.done) prep.step(budget);
    const out = [];
    const sched = [
      [1, searchOf([entry(40, 8, "A")])],
      [6, searchOf([entry(40, 8, "A"), entry(300, 5, "B")])],
      [12, null],
    ];
    for (const [t, s] of sched) {
      const w = inst.searchChanged(s, t);
      while (w && !w.done) w.step(budget);
      inst.mark(t);
    }
    for (const t of F.ticks(20, 10)) {
      const s = inst.stateAt(t);
      out.push({ f: new Float32Array(s.frame), c: new Float32Array(s.centre), z: s.draw.zoom, status: s.status });
    }
    return out;
  };
  const a = run(0);
  const b = run(0.5);
  const c = run(undefined);
  for (let i = 0; i < a.length; i++) {
    for (const o of [b, c]) {
      assert.ok(sameBits(a[i].f, o[i].f), "frame " + i);
      assert.ok(sameBits(a[i].c, o[i].c), "centre " + i);
      assert.strictEqual(a[i].z, o[i].z);
      assert.strictEqual(a[i].status, o[i].status);
    }
  }
  // Another seed gives another fit of the whole set's power iteration start only where the
  // data is degenerate; the facing frame of a search depends on the seed through its spread axes.
  const other = ET.modes.create("focus");
  other.enter(SET, { seed: SEED + 1 });
  other.prepare().step();
  apply(other, searchOf([entry(40, 8, "A")]), 1);
  assert.ok(Number.isFinite(other.stateAt(10).draw.zoom));
  // A query order that goes backwards gives the same answers.
  const inst = focusReady();
  apply(inst, searchOf([entry(40, 8, "A")]), 2);
  const forward = [0, 1, 2.5, 3, 9].map((t) => new Float32Array(inst.stateAt(t).frame));
  const backward = [9, 3, 2.5, 1, 0].map((t) => new Float32Array(inst.stateAt(t).frame)).reverse();
  forward.forEach((f, i) => assert.ok(sameBits(f, backward[i])));
});

test("a search that arrives during the preparation is the first fit, with no turn from the whole set", () => {
  const inst = ET.modes.create("focus");
  inst.enter(SET, { seed: SEED });
  const prep = inst.prepare();
  prep.step(0);
  assert.strictEqual(inst.isReady(), false);
  assert.ok(/^fitting the view to the set in 48-d … \d+%$/.test(inst.status(0)));
  assert.strictEqual(inst.searchChanged(searchOf([entry(40, 8, "A")]), 0), null);
  while (!prep.done) prep.step(0);
  assert.ok(inst.isReady());
  assert.strictEqual(inst.stateAt(9).status, "fitted to the results of A");
  // Same result as asking for the search after entering and waiting.
  const late = focusReady();
  apply(late, searchOf([entry(40, 8, "A")]), 0);
  const x = inst.stateAt(30);
  const y = late.stateAt(30);
  assert.ok(F.maxAbsDiff(x.frame, y.frame) < 1e-5 || inSpan(x.frame, y.frame.slice(0, D)) > 1 - 1e-5);
});

test("entering from another mode's view starts exactly there and blends in", () => {
  const tumble = F.ready(ET, "tumble", SET, { seed: SEED });
  const last = copyState(tumble.stateAt(5));
  const inst = ET.modes.create("focus");
  inst.enter(SET, { seed: SEED, from: { frame: last.frame, centre: last.centre, draw: last.draw } });
  inst.prepare().step();
  const s0 = inst.stateAt(0);
  assert.ok(F.maxAbsDiff(s0.frame, last.frame) < 1e-5);
  assert.ok(F.maxAbsDiff(s0.centre, last.centre) < 1e-5);
  const later = inst.stateAt(3);
  assert.ok(F.frameError(later.frame, D) < 1e-5);
  assert.ok(F.maxAbsDiff(later.frame, last.frame) > 1e-3);
  // an entry without a centre starts at the fit's centre
  const bare = ET.modes.create("focus");
  bare.enter(SET, { seed: SEED, from: { frame: last.frame } });
  bare.prepare().step();
  assert.ok(F.frameError(bare.stateAt(0).frame, D) < 1e-5);
});

test("the draw parameters are finite renderer keys; status is plain text; wires and focus are empty", () => {
  const inst = focusReady();
  apply(inst, searchOf([entry(40, 8, "A")], { onlyResults: true }), 0);
  const keys = Object.keys(ET.renderer.DEFAULTS);
  for (const t of [0, 0.7, 3]) {
    const s = inst.stateAt(t);
    for (const [k, v] of Object.entries(s.draw)) {
      assert.ok(keys.includes(k), k);
      assert.ok(Number.isFinite(v), k);
    }
    assert.strictEqual(s.wires, null);
    assert.strictEqual(s.focus, null);
    assert.strictEqual(inst.status(t), s.status);
    assert.ok(s.status.length <= 70);
  }
  const stepped = inst.step(0.5);
  assert.strictEqual(inst.time, 0.5);
  assert.ok(F.frameError(stepped.frame, D) < 1e-5);
  inst.step(-5);
  assert.strictEqual(inst.time, 0);
  assert.throws(() => inst.stateAt(NaN), { name: "RangeError" });
  assert.strictEqual(typeof inst.status(), "string");
});

test("a search made for other data is refused quietly: bad queries and stray indices are dropped", () => {
  const inst = focusReady();
  const e = entry(40, 4, "A");
  const stray = { letter: "A", query: e.query, indices: Int32Array.of(2, 5, 9999, -3) };
  apply(inst, searchOf([stray]), 0);
  assert.strictEqual(inst.stateAt(5).status, "fitted to the results of A");
  assert.ok(F.frameError(inst.stateAt(5).frame, D) < 1e-5);
  const wrong = { letter: "B", query: new Float32Array(D - 1), indices: Int32Array.of(1) };
  apply(inst, searchOf([wrong]), 10);
  assert.strictEqual(inst.stateAt(20).status, "fitted to every point");
  assert.strictEqual(inst.describe().searches.length, 0);
  // a scale of the wrong size is ignored; a right one is used
  apply(inst, searchOf([e], { scale: new Float32Array(3) }), 30);
  assert.strictEqual(inst.stateAt(40).status, "fitted to the results of A");
  const scale = ET.searchSets.scaleFor(e.query);
  apply(inst, searchOf([e], { scale }), 50);
  const s = inst.stateAt(60);
  assert.ok(F.frameError(s.frame, D) < 1e-5);
  // letters default from the position when the entry has none
  apply(inst, searchOf([{ query: e.query, indices: e.indices }, { query: rowOf(9), indices: Int32Array.of(9) }]), 70);
  assert.strictEqual(inst.stateAt(80).status, "fitted to the results of A, B");
  // more than four searches: the first four
  const five = [1, 2, 3, 4, 5].map((i) => entry(i * 10, 3, undefined));
  apply(inst, searchOf(five), 90);
  assert.strictEqual(inst.stateAt(100).status, "fitted to the results of A, B, C, D");
  // not a search at all
  apply(inst, { searches: "nope" }, 110);
  assert.strictEqual(inst.stateAt(120).status, "fitted to every point");
  assert.strictEqual(inst.searchChanged(undefined), null);
});

test("empty sets, tiny sets and data changes", () => {
  const empty = ET.modes.create("focus");
  empty.enter(F.emptySet(ET, 48), { seed: 1 });
  empty.prepare().step();
  assert.ok(empty.isReady());
  assert.strictEqual(empty.stateAt(1).status, "no points yet");
  assert.strictEqual(empty.searchChanged(searchOf([entry(1, 2, "A")]), 0), null);
  assert.strictEqual(empty.describe().empty, true);

  // one point and three dimensions both work
  const one = F.appendRows(ET, F.emptySet(ET, 48), SET, 0, 1);
  const tiny = focusReady(one);
  assert.ok(F.frameError(tiny.stateAt(2).frame, D) < 1e-5);
  const three = focusReady(F.tinyDimensionSet(ET, 3, 50));
  assert.ok(F.frameError(three.stateAt(2).frame, 3) < 1e-5);

  // an append restarts from the view shown, keeps the search and finishes ready
  const inst = focusReady();
  apply(inst, searchOf([entry(40, 8, "A")]), 0);
  const shown = copyState(inst.stateAt(8));
  const bigger = F.appendTo(ET, SET, 20);
  const r = inst.dataChanged(bigger, { op: "append", added: 20, t: 8 });
  assert.strictEqual(r.restart, true);
  assert.ok(r.work && typeof r.work.step === "function");
  assert.strictEqual(inst.isReady(), false);
  r.work.step();
  assert.ok(inst.isReady());
  assert.ok(F.maxAbsDiff(inst.stateAt(0).frame, shown.frame) < 1e-5, "continues from the view shown");
  assert.strictEqual(inst.stateAt(30).status, "fitted to the results of A");
  // a change before it is ready starts from the entry view; from empty it keeps the entry
  const cold = ET.modes.create("focus");
  cold.enter(SET, { seed: 3 });
  const r2 = cold.dataChanged(bigger, { op: "replace", t: 0 });
  assert.strictEqual(r2.restart, true);
  r2.work.step();
  assert.ok(cold.isReady());
  const grown = ET.modes.create("focus");
  grown.enter(F.emptySet(ET, 48), { seed: 3 });
  grown.prepare().step();
  const r3 = grown.dataChanged(SET, { op: "append", added: 700, t: 0 });
  r3.work.step();
  assert.ok(grown.isReady() && F.frameError(grown.stateAt(1).frame, D) < 1e-5);
  // an abandoned preparation does nothing when pumped later
  const stale = ET.modes.create("focus");
  stale.enter(SET, { seed: 3 });
  const old = stale.prepare();
  stale.enter(SET, { seed: 3 });
  old.step();
  assert.strictEqual(stale.isReady(), false);
  stale.prepare().step();
  assert.ok(stale.isReady());
  stale.leave();
});

test("a long session keeps a bounded number of turns", () => {
  const inst = focusReady();
  for (let i = 0; i < 70; i++) apply(inst, searchOf([entry((i * 7) % 600, 3, "A")]), i * 2);
  const s = inst.stateAt(70 * 2 + 5);
  assert.ok(F.frameError(s.frame, D) < 1e-5);
  // far back shows the oldest kept turn, never an error
  assert.ok(F.frameError(inst.stateAt(0).frame, D) < 1e-5);
  // returning to the whole set uses the fit made at entry
  apply(inst, null, 200);
  assert.strictEqual(inst.stateAt(210).status, "fitted to every point");
});
