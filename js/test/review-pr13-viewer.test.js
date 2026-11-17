"use strict";
// The findings of the review of pull request 13 in js/src/50-viewer.js and
// js/src/40-mode-tumble.js, each reproduced here before it was fixed:
//
//   1  the heights kept for info().search.relative kept the letters of an earlier lettering
//   4  the unit-length pass over the whole set ran on every info().search, wanted or not
//   6  every append restarted the relative fit, so under a stream it never finished
//   7  every relative event kept the whole set it was made on alive
//   8  a changed search was drawn and described with the earlier search's settled frame
//   9  a swing started during the turn back to the plain view dropped the perspective
//
// The viewer runs on the fake DOM and GPU of helpers/, loaded from the source modules
// (loadSources). Large arrays and DOM nodes are never handed to an equality assertion.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const vm = require("node:vm");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");

const api = loadSources();
const ET = api._internal;
const FIX = path.join(ROOT, "tests", "fixtures", "relative");
const TURN = 1.5; // Tumble's relativeTransition

// ---------- data ----------

const cache = {};
// A fixture pair in the contract's in-memory form (vectors as a Float32Array).
function fixture(name) {
  if (!cache[name]) {
    const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".json"), "utf8"));
    const buf = fs.readFileSync(path.join(FIX, meta.vectors.file));
    const n = meta.count * meta.dimension;
    const vectors = new Float32Array(n);
    for (let i = 0; i < n; i++) vectors[i] = buf.readFloatLE(i * 4);
    cache[name] = { meta, vectors };
  }
  const { meta, vectors } = cache[name];
  return { ...structuredClone({ ...meta, vectors: null }), vectors: new Float32Array(vectors) };
}

function idOf(data, label) {
  const p = data.points.find((x) => x.label === label);
  assert.ok(p, "no point labelled " + label);
  return p.id;
}

function indexOf(data, label) {
  const i = data.points.findIndex((x) => x.label === label);
  assert.ok(i >= 0, "no point labelled " + label);
  return i;
}

function rowAt(data, i) {
  return data.vectors.slice(i * data.dimension, (i + 1) * data.dimension);
}

// `count` rows of the wikipedia fixture from row `from`, as an append with new ids.
function appendOf(tag, from, count) {
  const src = fixture("wikipedia-subset");
  const D = src.dimension;
  const add = {
    ...src,
    op: "append",
    count: count,
    points: src.points.slice(from, from + count).map((p, i) => ({ ...p, id: tag + i })),
    vectors: src.vectors.slice(from * D, (from + count) * D),
  };
  delete add.provenance;
  delete add.reduction;
  return add;
}

// ---------- driving the viewer ----------

const tick = () => new Promise((r) => setImmediate(r));

async function until(dom, done, bound = 400) {
  for (let i = 0; i < bound && !done(); i++) {
    await tick();
    dom.frames(1);
  }
  await tick();
  assert.ok(done(), "condition not reached");
}

async function settle(dom, promise) {
  let out;
  let finished = false;
  promise.then((r) => {
    out = r;
    finished = true;
  });
  await until(dom, () => finished);
  return out;
}

// A viewer on the fake DOM, paused (the clock moves only by seek), with the fixture loaded.
function setup(mountOpts) {
  const dom = makeFakeDom();
  const el = dom.host();
  const changes = [];
  const h = api.mount(el, {
    seed: 3,
    mode: "tumble",
    paused: true,
    searchPanel: false,
    onSearchChange: (s) => changes.push(s),
    ...mountOpts,
  });
  const data = fixture("wikipedia-subset");
  h.update(data);
  return { dom, h, v: h._viewer, data, changes };
}

async function ready(t) {
  await until(t.dom, () => t.h.info().ready && !t.h.info().preparing);
}

// Search, then frames until the relative view is shown and its turn has ended.
async function searchAndSettle(t, list) {
  const r = await settle(t.dom, t.h.setSearches(list));
  assert.strictEqual(r.ok, true, r.message);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.h.seek(t.h.time() + TURN + 0.5);
  t.dom.frames(12); // a frame for the seek, and the status line (every 0.12 s)
  assert.strictEqual(t.h.info().search.relative.settled, true, "settled");
}

function provenanceRow(v, term) {
  const kids = v.provList.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName.toLowerCase() === "dt" && kids[i].textContent === term) return kids[i + 1].textContent;
  }
  return null;
}

// The first index where two float arrays differ in value, or -1.
function firstDiff(a, b) {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

// Replace ET.math[name] by a counting wrapper for the length of `body`.
async function counting(name, body) {
  const real = ET.math[name];
  const count = { calls: 0 };
  ET.math[name] = function () {
    count.calls++;
    return real.apply(this, arguments);
  };
  try {
    await body(count);
  } finally {
    ET.math[name] = real;
  }
}

// Nothing in this file may reach the network: a fetch or XMLHttpRequest would land here.
const network = [];
globalThis.fetch = (...a) => {
  network.push(["fetch", String(a[0])]);
  return Promise.reject(new Error("no network in tests"));
};
globalThis.XMLHttpRequest = function () {
  network.push(["xhr"]);
};
test.after(() => {
  assert.deepStrictEqual(network, [], "no request was made");
});

// ---------- the mode alone ----------

function modeFixture() {
  const data = fixture("wikipedia-subset");
  const byLabel = {};
  data.points.forEach((p, i) => {
    byLabel[p.label] = i;
  });
  return { X: data.vectors, N: data.count, D: data.dimension, byLabel };
}

// A set as Tumble reads it: rows [0, to) of the fixture (its own copy).
function setOf(fx, to) {
  const n = to === undefined ? fx.N : to;
  return { dimension: fx.D, count: n, vectors: fx.X.slice(0, n * fx.D) };
}

function queryOf(fx, label) {
  const i = fx.byLabel[label];
  assert.ok(i !== undefined, "fixture holds " + label);
  return fx.X.slice(i * fx.D, (i + 1) * fx.D);
}

// The viewer's search object for Tumble: [[letter, label], ...].
function searchOf(fx, pairs) {
  return {
    searches: pairs.map(([letter, label]) => ({ letter, query: queryOf(fx, label), indices: new Int32Array([fx.byLabel[label]]) })),
    scale: null,
    onlyResults: false,
  };
}

function readyMode(set, seed) {
  const inst = ET.modes.create("tumble");
  inst.enter(set, { seed });
  inst.prepare().step();
  return inst;
}

function snap(inst, t) {
  const s = inst.stateAt(t);
  return {
    frame: new Float32Array(s.frame),
    centre: new Float32Array(s.centre),
    zoom: s.draw.zoom,
    perspective: s.draw.perspective,
    status: s.status,
  };
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

// The unit direction of a query as float32, the way ET.math.relativeDirections pins it.
function pinnedRow(fx, label) {
  return ET.math.relativeDirections([queryOf(fx, label)], fx.D).directions;
}

// ---------- finding 1: the heights' letters ----------

test("finding 1: info().search.relative.searches carries each search's letter as it is now, after the letters go back to positions", async () => {
  const t = setup({ relative: true });
  await ready(t);
  const rice = idOf(t.data, "Rice");
  const wheat = idOf(t.data, "Wheat");
  await searchAndSettle(t, [{ point: rice }, { point: wheat }]);
  await searchAndSettle(t, [{ point: wheat }]);
  let s = t.h.info().search;
  assert.deepStrictEqual(s.searches.map((q) => q.letter), ["B"]);
  assert.deepStrictEqual(s.relative.searches.map((q) => q.letter), ["B"]);
  // Off: wheat is lettered A again, in the same list. On again: the relative results follow.
  t.h.setRelative({ relative: false });
  t.h.setRelative({ relative: true });
  await until(t.dom, () => t.h.info().search.relative.active);
  s = t.h.info().search;
  assert.deepStrictEqual(s.searches.map((q) => q.letter), ["A"]);
  assert.deepStrictEqual(s.relative.searches.map((q) => q.letter), ["A"], "the relative results carry the letter shown");
  assert.deepStrictEqual(
    s.relative.searches[0].results.map((r) => r.id),
    s.searches[0].results.map((r) => r.id),
    "aligned with the search's results",
  );
  t.h.destroy();
});

// ---------- finding 4: the unit-length pass ----------

test("finding 4: with Relative off, appends with a search shown never run the unit-length pass; reading the measure runs it once per set", async () => {
  const t = setup({ relative: false });
  await ready(t);
  const r = await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
  assert.strictEqual(r.ok, true, r.message);
  await counting("unitLength", async (count) => {
    for (let k = 0; k < 4; k++) {
      const up = t.h.update(appendOf("s" + k + "-", k * 3, 3));
      assert.strictEqual(up.ok, true, up.message);
      await until(t.dom, () => !t.h.info().search.stale && !t.h.info().search.waiting);
      assert.strictEqual(t.h.info().search.active, true);
    }
    assert.ok(t.changes.length > 0, "the host was told of the changes");
    assert.strictEqual(count.calls, 0, "no pass over the set with Relative off");
    // The documented shape is kept: the measure and the unit figure are there when read.
    const rel = t.h.info().search.relative;
    assert.strictEqual(count.calls, 0, "info() alone does not run it");
    assert.strictEqual(rel.measure, "cosine");
    assert.strictEqual(rel.unit.unit, true);
    assert.strictEqual(rel.unit.tolerance, 0.001);
    assert.strictEqual(t.h.info().search.relative.measure, "cosine");
    assert.strictEqual(count.calls, 1, "once for the set, however often it is read");
    assert.ok(Object.keys(rel).includes("measure") && Object.keys(rel).includes("unit"), "both keys are listed");
  });
  t.h.destroy();
});

test("finding 4: in another view, and with the built-in panel, a shown search never runs the unit-length pass", async () => {
  const t = setup({ relative: true, searchPanel: true });
  await ready(t);
  await counting("unitLength", async (count) => {
    t.h.setMode("lattice");
    await ready(t);
    const r = await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
    assert.strictEqual(r.ok, true, r.message);
    const up = t.h.update(appendOf("p", 0, 3));
    assert.strictEqual(up.ok, true, up.message);
    await until(t.dom, () => !t.h.info().search.stale && !t.h.info().search.waiting);
    t.dom.frames(20);
    assert.strictEqual(count.calls, 0, "Lattice has no relative view: nothing is measured");
  });
  t.h.destroy();
});

test("finding 4: while the relative view is shown the unit figure is the fit's own, with no second pass", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  await counting("unitLength", async (count) => {
    const rel = t.h.info().search.relative;
    assert.strictEqual(rel.active, true);
    assert.strictEqual(rel.measure, "cosine");
    assert.strictEqual(rel.unit.unit, true);
    const st = t.v.mode.inst.stateAt(t.h.time()).relative;
    assert.deepStrictEqual(rel.unit, { ...st.unit });
    assert.strictEqual(count.calls, 0, "the viewer made no pass of its own");
  });
  t.h.destroy();
});

// ---------- finding 8: a changed search and the earlier search's frame ----------

test("finding 8 (mode): from the change of the searches until the new fit switches in, the view is not settled and names the searches its frame was built from", () => {
  const fx = modeFixture();
  const D = fx.D;
  const inst = readyMode(setOf(fx), 9);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0).step();
  inst.mark(1.0);
  const rice = pinnedRow(fx, "Rice");
  const wheat = pinnedRow(fx, "Wheat");
  let s = inst.stateAt(4);
  assert.strictEqual(s.relative.settled, true);
  assert.ok(s.status.includes("vertical = cosine to A, exact"), s.status);
  assert.strictEqual(firstDiff(s.relative.searches[0].query, queryOf(fx, "Rice")), -1, "the frame's search is Rice");
  // Wheat replaces Rice and takes its letter. The fit is started and not pumped.
  const w = inst.searchChanged(searchOf(fx, [["A", "Wheat"]]), 5.0);
  assert.ok(w && typeof w.step === "function");
  for (const t of [5.0, 5.2, 6.9, 30]) {
    s = inst.stateAt(t);
    assert.strictEqual(s.relative.active, true);
    assert.strictEqual(firstDiff(s.frame.subarray(D, 2 * D), rice), -1, "row 1 is still Rice's direction at t=" + t);
    assert.strictEqual(s.relative.settled, false, "not settled for the new A at t=" + t);
    assert.ok(s.status.includes("turning until vertical = cosine to A") && !s.status.includes("exact"), s.status);
    assert.deepStrictEqual(s.relative.searches.map((q) => q.letter), ["A"]);
    assert.strictEqual(firstDiff(s.relative.searches[0].query, queryOf(fx, "Rice")), -1, "it names the search of its frame");
  }
  // A time before the change shows the view as it was then.
  assert.strictEqual(inst.stateAt(4.9).relative.settled, true, "settled before the change");
  assert.ok(inst.stateAt(4.9).status.includes("exact"));
  w.step();
  inst.mark(5.5);
  assert.strictEqual(inst.stateAt(5.3).relative.settled, false, "between the change and the switch");
  assert.strictEqual(inst.stateAt(5.5 + TURN / 2).relative.settled, false, "turning onto Wheat");
  s = inst.stateAt(5.5 + TURN + 0.1);
  assert.strictEqual(s.relative.settled, true);
  assert.strictEqual(firstDiff(s.frame.subarray(D, 2 * D), wheat), -1, "row 1 is Wheat's direction");
  assert.strictEqual(firstDiff(s.relative.searches[0].query, queryOf(fx, "Wheat")), -1);
  assert.ok(s.status.includes("vertical = cosine to A, exact"), s.status);
});

test("finding 8 (mode): going back to the searches of the frame shown, before the new fit is in, is settled again", () => {
  const fx = modeFixture();
  const inst = readyMode(setOf(fx), 9);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0).step();
  inst.mark(1.0);
  const w = inst.searchChanged(searchOf(fx, [["A", "Wheat"]]), 5.0);
  w.step(0);
  assert.strictEqual(inst.stateAt(5.5).relative.settled, false);
  assert.strictEqual(inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 6.0), null, "the frame shown is Rice's already");
  assert.strictEqual(inst.stateAt(6.5).relative.settled, true);
  assert.strictEqual(inst.describe().relative.pending, false);
  assert.strictEqual(w.step(), true, "the abandoned fit reports done");
  inst.mark(7);
  assert.strictEqual(inst.describe().relative.switchAt, 1.0, "and switches nothing in");
});

test("finding 8 (viewer): the overlay, the status, the provenance and info() do not call a replaced search exact while the frame is the earlier search's", async () => {
  const t = setup({ relative: true });
  await ready(t);
  const riceRow = rowAt(t.data, indexOf(t.data, "Rice"));
  const wheatRow = rowAt(t.data, indexOf(t.data, "Wheat"));
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  assert.ok(t.h.info().status.includes("vertical = cosine to A, exact"), t.h.info().status);
  assert.ok(provenanceRow(t.v, "Relative").includes("The vertical axis is exact"));
  // Hold the mode's new fit back, as a slow device does, and watch what is drawn meanwhile.
  const inst = t.v.mode.inst;
  const realChanged = inst.searchChanged;
  let held = null;
  inst.searchChanged = function () {
    const work = realChanged.apply(inst, arguments);
    if (work) held = work;
    return null;
  };
  const realBuild = ET.relativeOverlay.build;
  const builds = [];
  ET.relativeOverlay.build = function (input) {
    builds.push({ settled: input.relative ? input.relative.settled : null, searches: input.searches.map((q) => ({ letter: q.letter, query: q.query, name: q.name })) });
    return realBuild.apply(this, arguments);
  };
  try {
    t.changes.length = 0;
    const r = await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Wheat") }]));
    assert.strictEqual(r.ok, true, r.message);
    assert.ok(held, "the mode started a new fit");
    assert.deepStrictEqual(r.search.searches.map((q) => q.letter), ["A"], "Wheat takes the letter A");
    assert.strictEqual(r.search.relative.active, true);
    assert.strictEqual(r.search.relative.settled, false, "the answer to setSearches is not settled");
    builds.length = 0;
    t.dom.frames(12);
    const rel = t.h.info().search.relative;
    assert.strictEqual(rel.active, true);
    assert.strictEqual(rel.settled, false, "info(): not settled");
    assert.ok(t.h.info().status.includes("turning until vertical = cosine to A"), t.h.info().status);
    assert.ok(!t.h.info().status.includes("exact"), t.h.info().status);
    assert.ok(!provenanceRow(t.v, "Relative").includes("The vertical axis is exact"), "provenance does not call it exact");
    assert.strictEqual(t.v.relativeDrawn.settled, false, "the overlay is drawn as turning");
    assert.strictEqual(t.v.relativeDrawn.results.length, 0, "no stems");
    assert.ok(builds.length > 0, "the overlay was drawn");
    for (const b of builds) {
      assert.strictEqual(b.settled, false);
      const a = b.searches.find((q) => q.letter === "A");
      assert.ok(a, "the pinned search is given");
      assert.strictEqual(firstDiff(a.query, riceRow), -1, "the ruler follows the direction the frame was built from");
      assert.notStrictEqual(a.name, "Wheat", "and is not called by the new search's name");
    }
    assert.ok(
      t.changes.some((s) => s.relative.active && !s.relative.settled),
      "the host heard that the view is not settled",
    );
    // The fit lands: the turn onto Wheat, then settled and exact again, and the host hears it.
    t.changes.length = 0;
    held.step();
    t.dom.frames(3);
    t.h.seek(t.h.time() + TURN + 0.5);
    builds.length = 0;
    t.dom.frames(12);
    assert.strictEqual(t.h.info().search.relative.settled, true);
    assert.ok(t.h.info().status.includes("vertical = cosine to A, exact"), t.h.info().status);
    assert.ok(provenanceRow(t.v, "Relative").includes("The vertical axis is exact"));
    const last = builds.at(-1);
    assert.strictEqual(last.settled, true);
    assert.strictEqual(firstDiff(last.searches[0].query, wheatRow), -1, "the ruler is Wheat's");
    assert.strictEqual(last.searches[0].name, "Wheat");
    assert.ok(
      t.changes.some((s) => s.relative.active && s.relative.settled),
      "the host heard the settle",
    );
  } finally {
    ET.relativeOverlay.build = realBuild;
    inst.searchChanged = realChanged;
  }
  t.h.destroy();
});

// ---------- finding 6: appends and the relative fit ----------

test("finding 6 (mode): an append keeps the relative fit shown and starts none; refit() fits it again, as a fresh instance on the final data shows", () => {
  const fx = modeFixture();
  const D = fx.D;
  const pairs = [["A", "Rice"], ["B", "Bean"]];
  const inst = readyMode(setOf(fx, 150), 6);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, pairs), 0.5).step();
  inst.mark(0.5);
  const before = inst.stateAt(3.9).relative;
  const rice = pinnedRow(fx, "Rice");
  // A stream of appends: no fit is started, the view stays settled, row 1 stays exact.
  let t = 4;
  for (const n of [170, 190, 210, fx.N]) {
    const res = inst.dataChanged(setOf(fx, n), { op: "append", t });
    assert.strictEqual(res.restart, false);
    assert.ok(!res.work, "no relative fit is started by an append (" + n + " rows)");
    assert.strictEqual(inst.describe().relative.pending, false);
    const s = inst.stateAt(t + 0.05);
    assert.strictEqual(s.relative.active, true);
    assert.strictEqual(s.relative.settled, true, "the pinned rows do not depend on the data");
    assert.strictEqual(firstDiff(s.frame.subarray(D, 2 * D), rice), -1, "row 1 is exact at t=" + t);
    assert.deepStrictEqual({ ...s.relative.window }, { ...before.window }, "the window waits for the refit");
    assert.ok(s.status.endsWith(" · before " + (n - 150) + " new points"), s.status);
    t += 0.1;
  }
  assert.strictEqual(inst.describe().relative.pointsSinceFit, fx.N - 150);
  // The refit (the viewer's quiet and share policy calls it) brings the relative fit along.
  const work = inst.refit();
  work.step();
  inst.mark(4.6);
  assert.strictEqual(inst.describe().relative.switchAt, 4.6);
  assert.strictEqual(inst.describe().relative.pointsSinceFit, 0);
  for (let u = 4.6; u < 4.6 + TURN; u += 0.05) {
    const s = inst.stateAt(u);
    assert.ok(frameError(s.frame, D) < 1e-5, "orthonormal at t=" + u);
    assert.strictEqual(firstDiff(s.frame.subarray(D, 2 * D), rice), -1, "row 1 stays exact through the refit's turn at t=" + u);
    assert.strictEqual(s.relative.settled, true, "and the view stays settled at t=" + u);
  }
  const fresh = readyMode(setOf(fx), 6);
  fresh.setRelative({ relative: true }, 0);
  fresh.searchChanged(searchOf(fx, pairs), 0.5).step();
  fresh.mark(0.5);
  for (const u of [6.2, 9.4, 25]) assertSameSnap(snap(inst, u), snap(fresh, u), "appends then refit vs fresh at t=" + u);
  assert.deepStrictEqual({ ...inst.stateAt(9).relative.window }, { ...fresh.stateAt(9).relative.window });
  // A time before the refit's switch still shows the earlier fit.
  assert.deepStrictEqual({ ...inst.stateAt(4.5).relative.window }, { ...before.window });
});

test("finding 6 (mode): a fit under way when points arrive is not thrown away", () => {
  const fx = modeFixture();
  const inst = readyMode(setOf(fx, 150), 6);
  inst.setRelative({ relative: true }, 0);
  const w = inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 0.5);
  w.step(0);
  w.step(0);
  for (const n of [170, 190, fx.N]) {
    const res = inst.dataChanged(setOf(fx, n), { op: "append", t: 0.6 });
    assert.ok(!res.work, "the fit under way is kept, not restarted");
    assert.strictEqual(inst.describe().relative.pending, true);
  }
  w.step();
  inst.mark(0.8);
  const s = inst.stateAt(0.8 + TURN + 0.1);
  assert.strictEqual(s.relative.active, true, "the fit that was under way switches in");
  assert.strictEqual(s.relative.settled, true);
  assert.strictEqual(inst.describe().relative.pointsSinceFit, fx.N - 150, "it is known to be behind the data");
});

test("finding 6 (viewer): a stream of appends starts no relative fit; one fit follows once the appends are quiet", async () => {
  const t = setup({ relative: true, refitQuietSeconds: 0.5 });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  const windowBefore = { ...t.h.info().search.relative.window };
  t.h.resume();
  await counting("makeRelativeFit", async (count) => {
    for (let k = 0; k < 5; k++) {
      const up = t.h.update(appendOf("q" + k + "-", k * 4, 4));
      assert.strictEqual(up.ok, true, up.message);
      await tick();
      t.dom.frames(2);
    }
    await until(t.dom, () => !t.h.info().search.stale && !t.h.info().search.waiting);
    assert.strictEqual(count.calls, 0, "no relative fit while points keep arriving");
    const rel = t.h.info().search.relative;
    assert.deepStrictEqual([rel.active, rel.settled], [true, true], "the view stays shown and settled");
    assert.deepStrictEqual({ ...rel.window }, windowBefore);
    // Quiet for refitQuietSeconds: the refit runs, the relative fit with it.
    await until(t.dom, () => count.calls > 0 && !t.h.info().preparing && t.v.mode.inst.describe().relative.pointsSinceFit === 0, 600);
    assert.strictEqual(count.calls, 1, "one fit for the whole stream");
    assert.strictEqual(t.v.mode.inst.describe().pointsSinceFit, 0, "the plain tour was fitted again with it");
  });
  t.h.destroy();
});

// ---------- finding 7: what the events keep alive ----------

function collect() {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  gc();
}

test("finding 7: earlier sets are not kept alive by the relative events, and a seek back still shows each earlier view", async () => {
  const fx = modeFixture();
  const D = fx.D;
  const inst = readyMode(setOf(fx, 100), 4);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 0.5).step();
  inst.mark(0.5);
  const refs = [];
  const shown = [];
  let t = 3;
  // Periodic appends, each followed by its fit and switch (whichever call hands the work).
  for (let n = 110; n <= 160; n += 10) {
    shown.push([t - 0.2, snap(inst, t - 0.2), { ...inst.stateAt(t - 0.2).relative.window }]);
    let next = setOf(fx, n);
    refs.push(new WeakRef(next));
    const res = inst.dataChanged(next, { op: "append", t });
    next = null;
    if (res.work) res.work.step();
    inst.refit().step();
    inst.mark(t + 0.1);
    inst.stateAt(t + 0.1 + TURN + 0.2);
    t += 3;
  }
  assert.ok(inst.describe().relative.switchAt > 15, "each cycle switched a new fit in");
  await tick();
  collect();
  await tick();
  collect();
  const alive = refs.slice(0, -1).filter((r) => r.deref() !== undefined).length;
  assert.strictEqual(alive, 0, alive + " of " + (refs.length - 1) + " earlier sets are still held");
  assert.ok(refs.at(-1).deref(), "the current set is the mode's");
  // The history is whole: every earlier view is shown again at its time, bit for bit (frame,
  // centre, zoom, perspective). The status line counts the points that have arrived since
  // that fit against the data as it is now, as plain Tumble's does, so its tail is left out.
  const untailed = (x) => ({ ...x, status: x.status.replace(/ · before [\d,]+ new points$/, "") });
  for (const [u, s, w] of shown) {
    assertSameSnap(untailed(snap(inst, u)), untailed(s), "seek back to t=" + u);
    assert.deepStrictEqual({ ...inst.stateAt(u).relative.window }, w, "its window at t=" + u);
    assert.ok(frameError(inst.stateAt(u).frame, D) < 1e-5);
  }
});

// ---------- finding 9: a swing during the turn back ----------

test("finding 9: a swing started during the turn back to the plain view keeps the easing perspective", () => {
  const fx = modeFixture();
  const set = setOf(fx);
  const probe = readyMode(set, 12);
  const tgt = probe.stateAt(9);
  const target = { frame: new Float32Array(tgt.frame), centre: new Float32Array(tgt.centre), zoom: 1.3 };
  const inst = readyMode(set, 12);
  inst.setRelative({ relative: true }, 0);
  inst.searchChanged(searchOf(fx, [["A", "Rice"]]), 1.0).step();
  inst.mark(1.0);
  assert.strictEqual(inst.stateAt(3.9).draw.perspective, 60);
  assert.strictEqual(inst.setRelative({ relative: false }, 4.0), null);
  assert.strictEqual(inst.face(target, 4.3), true, "a swing may start during the turn back");
  const facing = inst.describe().facing;
  assert.ok(facing.until > 4.0 + TURN, "the swing outlasts the turn");
  let last = 60;
  let swung = 0;
  for (let k = 0; k <= 120; k++) {
    const t = 4.0 + k / 60;
    const s = inst.stateAt(t);
    const mix = s.relative ? s.relative.mix : 0;
    const want = mix > 0 ? 3 + 57 * mix : undefined;
    assert.ok(Object.is(s.draw.perspective, want), "perspective follows the mix at t=" + t + ": " + s.draw.perspective + " vs " + want);
    const now = s.draw.perspective === undefined ? 3 : s.draw.perspective;
    assert.ok(Math.abs(now - last) < 2.5, "no pop at t=" + t + ": " + last + " to " + now);
    last = now;
    if (t >= 4.3 && t < 4.0 + TURN) swung++;
  }
  assert.ok(swung > 60, "frames inside the swing and the turn were checked");
  assert.strictEqual(inst.stateAt(4.0 + TURN + 0.01).draw.perspective, undefined, "the plain value once the turn has ended");
});
