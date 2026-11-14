"use strict";
// What each mode does (task t7): Tumble's guided tour and variance share (criterion 3),
// Lattice's true-neighbour wires and axis swaps, Wander's labelled stops and local
// frames, entry from another mode, and appends.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

function absDotRows(A, B, D) {
  // |<A_r, B_s>| matrix, 3 x 3
  const m = [];
  for (let r = 0; r < 3; r++) {
    for (let s = 0; s < 3; s++) {
      let v = 0;
      for (let d = 0; d < D; d++) v += A[r * D + d] * B[s * D + d];
      m.push(Math.abs(v));
    }
  }
  return m;
}

// Same 3-D subspace: every row of A lies in the span of B.
function sameSpan(A, B, D, tol) {
  const m = absDotRows(A, B, D);
  for (let r = 0; r < 3; r++) {
    const n2 = m[r * 3] ** 2 + m[r * 3 + 1] ** 2 + m[r * 3 + 2] ** 2;
    if (Math.abs(n2 - 1) > tol) return false;
  }
  return true;
}

// ---------------------------------------------------------------- Tumble

test("criterion 3: Tumble's frames are the mathematics module's guided tour", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const N = set.count;
  const D = set.dimension;
  const tumble = F.ready(ET, "tumble", set, { seed: 21 });
  const c = ET.math.centre(set.vectors, N, D);
  const tour = ET.math.guidedTour(c.data, N, D, { seed: 21 });
  for (const t of [0, 0.25, 3.7, 9.99]) {
    assert.ok(F.bytesEqual(new Float32Array(tumble.stateAt(t).frame), tour.frameAt(t)), "frame at " + t);
  }
  assert.strictEqual(tumble.describe().subspace, 8);
});

test("criterion 3: Tumble exposes the variance share it tours through, as a number and in its status", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const N = set.count;
  const D = set.dimension;
  const tumble = F.ready(ET, "tumble", set, { seed: 21 });
  const c = ET.math.centre(set.vectors, N, D);
  const tour = ET.math.guidedTour(c.data, N, D, { seed: 21 });
  const desc = tumble.describe();
  assert.strictEqual(desc.varianceShare, tour.varianceShare);
  assert.strictEqual(tumble.varianceShare, tour.varianceShare);
  assert.strictEqual(desc.varianceShareStale, false);
  const pct = (tour.varianceShare * 100).toFixed(1) + "%";
  const status = tumble.stateAt(2).status;
  assert.ok(status.includes(pct), status);
  assert.ok(/8 strongest directions/.test(status), status);
  assert.ok(/variance/.test(status), status);
});

test("Tumble reports progress while it prepares, and holds the entry frame until ready", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const inst = ET.modes.create("tumble");
  inst.enter(set, { seed: 1 });
  const prep = inst.prepare();
  assert.strictEqual(inst.isReady(), false);
  const s = inst.stateAt(3);
  assert.ok(F.frameError(s.frame, set.dimension) < 1e-5);
  assert.ok(/strongest directions/.test(s.status) && /\d+-d/.test(s.status), s.status);
  assert.ok(!/variance/.test(s.status) || /finding/.test(s.status));
  prep.step();
  assert.ok(inst.isReady());
});

test("Tumble on append: no jump, the share is marked stale, refit crossfades to the new fit", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const D = set.dimension;
  const inst = F.ready(ET, "tumble", set, { seed: 3 });
  const before = inst.stateAt(5);
  const f5 = new Float32Array(before.frame);
  const c5 = new Float32Array(before.centre);
  const z5 = before.draw.zoom;
  const bigger = F.appendTo(ET, set, 40);
  const work = inst.dataChanged(bigger, { op: "append", added: 40, t: 5 }).work;
  if (work) work.step();
  const after = inst.stateAt(5);
  assert.ok(F.bytesEqual(f5, after.frame), "frame unchanged at the moment of the append");
  assert.ok(F.maxAbsDiff(c5, after.centre) < 1e-7, "centre unchanged at the moment of the append");
  assert.ok(Math.abs(after.draw.zoom - z5) < 1e-6 * z5, "zoom unchanged at the moment of the append");
  const d = inst.describe();
  assert.strictEqual(d.varianceShareStale, true);
  assert.strictEqual(d.pointsSinceFit, 40);
  assert.ok(/before 40 new points/.test(inst.stateAt(6).status), inst.stateAt(6).status);
  // the centre glides to the new mean (it does not jump there)
  const mean = ET.math.meanOf(bigger.vectors, bigger.count, D);
  const far = inst.stateAt(30).centre;
  assert.ok(F.maxAbsDiff(far, Float32Array.from(mean)) < 1e-5);

  // refit: frames continuous at the switch, then fresh share
  const refit = inst.refit();
  refit.step();
  const tr = 8;
  const justBefore = new Float32Array(inst.stateAt(tr - 1e-3).frame);
  const at = inst.stateAt(tr); // first query after the refit finished fixes its time
  assert.ok(F.maxAbsDiff(justBefore, at.frame) < 5e-3, "no jump at the refit");
  const d2 = inst.describe();
  assert.strictEqual(d2.varianceShareStale, false);
  assert.strictEqual(d2.pointsSinceFit, 0);
  const c = ET.math.centre(bigger.vectors, bigger.count, D);
  const fresh = ET.math.guidedTour(c.data, bigger.count, D, { seed: 3 });
  assert.strictEqual(d2.varianceShare, fresh.varianceShare);
  // after the turn (its length is chosen from its size: describe().refitTransition)
  // the frame is the new tour's (up to axis order and sign)
  const after2 = tr + d2.refitTransition + 0.5;
  const late = inst.stateAt(after2).frame;
  assert.ok(sameSpan(late, fresh.frameAt(after2), D, 1e-4));
});

// ---------------------------------------------------------------- Lattice

test("Lattice swaps one axis at a time and names it in the status line", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const D = set.dimension;
  const inst = F.ready(ET, "lattice", set, { seed: 8 });
  const period = inst.describe().period;
  assert.strictEqual(period, 3.4);
  const f0 = new Float32Array(inst.stateAt(0).frame);
  const mid = inst.stateAt(period * 0.5);
  // only row 0 moved in the first cycle
  let row0 = 0;
  let rest = 0;
  for (let d = 0; d < D; d++) {
    row0 = Math.max(row0, Math.abs(mid.frame[d] - f0[d]));
    rest = Math.max(rest, Math.abs(mid.frame[D + d] - f0[D + d]), Math.abs(mid.frame[2 * D + d] - f0[2 * D + d]));
  }
  assert.ok(row0 > 1e-2);
  assert.strictEqual(rest, 0);
  assert.ok(/swap 1 · axis X trading for a hidden direction · +50%/.test(mid.status), mid.status);
  assert.ok(/axis Y/.test(inst.stateAt(period * 1.5).status));
  assert.ok(/axis Z/.test(inst.stateAt(period * 2.5).status));
  assert.ok(/swap 4 · axis X/.test(inst.stateAt(period * 3.5).status));
  assert.ok(/wires/.test(mid.status));
});

test("Lattice wires are true neighbours in the full space, among the first 1,000 points", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { count: 1300 });
  const N = set.count;
  const D = set.dimension;
  const inst = F.ready(ET, "lattice", set, { seed: 8 });
  assert.strictEqual(inst.describe().neighbourLimit, 1000);
  const w = inst.stateAt(1).wires;
  assert.ok(w && w.pairs.length > 0);
  const ref = ET.math.knn(set.vectors, N, D, 3, { limit: 1000 });
  const seen = new Set();
  for (let e = 0; e < w.pairs.length; e += 2) {
    const i = w.pairs[e];
    const j = w.pairs[e + 1];
    assert.ok(i < 1000 && j < 1000);
    const key = Math.min(i, j) + ":" + Math.max(i, j);
    assert.ok(!seen.has(key), "no duplicate wire");
    seen.add(key);
    const ni = Array.from(ref.indices.subarray(i * 3, i * 3 + 3));
    const nj = Array.from(ref.indices.subarray(j * 3, j * 3 + 3));
    assert.ok(ni.includes(j) || nj.includes(i), `wire ${i}-${j} joins true neighbours`);
    // the length is the full-dimension distance
    let s = 0;
    for (let d = 0; d < D; d++) s += (set.vectors[i * D + d] - set.vectors[j * D + d]) ** 2;
    assert.ok(Math.abs(w.lengths[e / 2] - Math.sqrt(s)) < 1e-5);
  }
  // halo points (group "") get no wires of their own when the set has groups
  for (let i = 0; i < 1000; i++) {
    if (set.points[i].group !== "") continue;
    for (let e = 0; e < w.pairs.length; e += 2) {
      if (w.pairs[e] === i) {
        const j = w.pairs[e + 1];
        assert.ok(set.points[j].group !== "" && Array.from(ref.indices.subarray(j * 3, j * 3 + 3)).includes(i));
      }
    }
  }
  assert.ok(new RegExp(w.pairs.length / 2 + " wires").test(inst.stateAt(1).status.replace(/,/g, "")));
  // wire opacity ramps in after they are ready
  assert.ok(inst.stateAt(1).draw.wires < inst.stateAt(3).draw.wires);
  assert.strictEqual(inst.stateAt(4).draw.wires, 1);
});

test("Lattice: the neighbour limit is a parameter, and the work runs in bounded slices", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const inst = ET.modes.create("lattice", { neighbourLimit: 300, sliceRows: 10 });
  inst.enter(set, { seed: 1 });
  const prep = inst.prepare();
  prep.step(0);
  prep.step(0);
  assert.ok(prep.progress > 0 && prep.progress < 1);
  assert.ok(/measuring \d+%/.test(inst.stateAt(1).status), inst.stateAt(1).status);
  prep.step();
  const w = inst.stateAt(2).wires;
  for (const i of w.pairs) assert.ok(i < 300);
});

test("Lattice on append: frame and wires unchanged at once; new wires come from new work", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { count: 500 });
  const inst = F.ready(ET, "lattice", set, { seed: 2 });
  const s = inst.stateAt(4);
  const f = new Float32Array(s.frame);
  const c = new Float32Array(s.centre);
  const v0 = s.wires.version;
  const bigger = F.appendTo(ET, set, 30, { group: "law" });
  const work = inst.dataChanged(bigger, { op: "append", added: 30, t: 4 }).work;
  const s2 = inst.stateAt(4);
  assert.ok(F.bytesEqual(f, s2.frame));
  assert.ok(F.maxAbsDiff(c, s2.centre) < 1e-7);
  assert.strictEqual(s2.wires.version, v0, "old wires stay until new ones are measured");
  assert.ok(work, "points inside the neighbour limit need new measurements");
  work.step();
  const s3 = inst.stateAt(5);
  assert.ok(s3.wires.version > v0);
  assert.ok(Array.from(s3.wires.pairs).some((i) => i >= 500), "appended points are wired");
});

// ---------------------------------------------------------------- Wander

test("Wander visits labelled points, dwells on them, and fits a local frame from 24 neighbours", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const N = set.count;
  const D = set.dimension;
  const inst = F.ready(ET, "wander", set, { seed: 5 });
  const desc = inst.describe();
  assert.strictEqual(desc.neighbours, 24);
  assert.strictEqual(desc.travel, 2.8);
  assert.strictEqual(desc.dwell, 2.0);
  const cycle = desc.travel + desc.dwell;
  const stops = inst.route(6);
  assert.strictEqual(stops.length, 6);
  for (let h = 0; h < 6; h++) {
    const j = stops[h];
    assert.ok(set.points[j].label !== "", "stop " + h + " is labelled");
    const st = inst.stateAt(h * cycle + desc.travel + 0.5); // dwelling
    for (let d = 0; d < D; d++) assert.strictEqual(st.centre[d], set.vectors[j * D + d]);
    assert.ok(st.status.startsWith('at "' + set.points[j].label + '"'), st.status);
    assert.ok(/stop \d+/.test(st.status));
    assert.strictEqual(st.focus.phase, "dwell");
    assert.strictEqual(st.focus.to, j);
    // the local frame spans the top three directions of the point and its 24 nearest
    const nb = inst.neighboursOf(j);
    assert.strictEqual(nb.length, 24);
    const lf = ET.math.localFrame(set.vectors, N, D, [j].concat(Array.from(nb)));
    assert.ok(sameSpan(st.frame, lf, D, 1e-4));
  }
  const travelling = inst.stateAt(cycle + 1);
  assert.strictEqual(travelling.focus.phase, "travel");
  assert.ok(travelling.status.includes("→"), travelling.status);
  // a long leap every fifth hop goes to another group
  const leap = stops[3]; // hop number 5 (1-based) is index 4; it departs from stops[3]
  assert.notStrictEqual(set.points[stops[4]].group, set.points[leap].group);
});

test("Wander still moves on a set with no labelled points (labels equal ids)", () => {
  const ET = F.freshET();
  const base = F.sample.generate({ dimension: 24, count: 400 });
  base.text_included = false;
  base.points = base.points.map((p) => ({ id: p.id, label: p.id, group: "" }));
  const res = ET.contract.validate(base, null);
  assert.ok(res.ok, res.message);
  const set = res.set;
  const inst = F.ready(ET, "wander", set, { seed: 5 });
  assert.strictEqual(inst.describe().labelled, 0);
  const stops = inst.route(5);
  assert.strictEqual(new Set(stops).size > 1, true);
  const a = new Float32Array(inst.stateAt(0.1).centre);
  const b = new Float32Array(inst.stateAt(9).centre);
  assert.ok(F.maxAbsDiff(a, b) > 1e-3);
  assert.ok(F.frameError(inst.stateAt(9).frame, 24) < 1e-5);
});

test("Wander on append: the stop in progress is kept, future stops may use new points", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const inst = F.ready(ET, "wander", set, { seed: 5 });
  const t = 6.1; // second hop, travelling
  const s = inst.stateAt(t);
  const f = new Float32Array(s.frame);
  const c = new Float32Array(s.centre);
  const first = inst.route(2);
  const bigger = F.appendTo(ET, set, 20, { labelled: true, group: "music" });
  const work = inst.dataChanged(bigger, { op: "append", added: 20, t }).work;
  if (work) work.step();
  const s2 = inst.stateAt(t);
  assert.ok(F.bytesEqual(f, s2.frame));
  assert.ok(F.bytesEqual(c, s2.centre));
  assert.deepStrictEqual(Array.from(inst.route(2)), Array.from(first));
  assert.strictEqual(inst.describe().labelled, 290 + 20);
});

// ---------------------------------------------------------------- entry and draw parameters

test("each mode starts from the frame, centre and draw parameters it is handed", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const D = set.dimension;
  const wander = F.ready(ET, "wander", set, { seed: 1 });
  const s = wander.stateAt(7.3);
  const from = { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: Object.assign({}, s.draw) };
  for (const id of ["tumble", "lattice", "wander"]) {
    const inst = F.ready(ET, id, set, { seed: 2, from });
    const s0 = inst.stateAt(0);
    assert.ok(F.maxAbsDiff(s0.frame, from.frame) < 1e-6, id + " frame continuous");
    assert.ok(F.maxAbsDiff(s0.centre, from.centre) < 1e-6, id + " centre continuous");
    for (const k of Object.keys(s0.draw)) {
      if (k in from.draw && k !== "wires") {
        assert.ok(Math.abs(s0.draw[k] - from.draw[k]) < 1e-9, id + " draw." + k + " continuous");
      }
    }
    // small steps stay small
    const s1 = inst.stateAt(1 / 60);
    assert.ok(F.maxAbsDiff(s1.frame, from.frame) < 0.05, id + " no jump in the first frame");
    assert.ok(F.frameError(s1.frame, D) < 1e-5);
  }
});

test("draw parameters port the reference's feel", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const t = F.ready(ET, "tumble", set).stateAt(5).draw;
  const lat = F.ready(ET, "lattice", set);
  lat.mark(0); // wires measured before the clock started: shown from t = 0
  const l = lat.stateAt(5).draw;
  const w = F.ready(ET, "wander", set).stateAt(5).draw;
  assert.strictEqual(t.wires, 0);
  assert.strictEqual(t.fog, 0);
  assert.strictEqual(t.trails, 0.17);
  assert.strictEqual(l.wires, 1);
  assert.strictEqual(l.dim, 0.55);
  assert.ok(Math.abs(l.trails - 0.1) < 1e-12);
  assert.strictEqual(w.fog, 1);
  assert.ok(w.zoom > 2 && w.zoom < 3.5, "Wander's fixed zoom, scaled to the data");
  assert.ok(t.zoom > 0 && isFinite(t.zoom));
});

// ---------- Lattice's hidden directions (found on a real Atlas, plan task t16) ----------

// A set built like real vectors: groups that barely separate in the full space.
function plantedSet(ET, D) {
  const { plantedGroups } = require("./helpers/math-fixtures.js");
  const f = plantedGroups(D);
  const points = f.groups.map((g, i) => ({ id: "p" + i, label: "", group: g }));
  const res = ET.contract.validate(
    { schema_version: 1, kind: "embeddings-tumbler/data", op: "replace", model: "test/planted", dimension: D,
      count: f.N, text_included: false, provenance: { source: "test", producer: "node test", synthetic: true, seed: 7, limitations: [], uncertain: [] },
      reduction: { kind: "none", source_dimension: D, directions_kept: D, variance_dropped: 0 },
      vectors: f.X.buffer.slice(0), points },
    null
  );
  assert.ok(res.ok, res.message);
  return { set: res.set, groups: f.groups };
}

function meanSeparation(ET, inst, set, groups, from, to) {
  const m = ET.math;
  const Y = m.centre(set.vectors, set.count, set.dimension).data;
  let sum = 0;
  let n = 0;
  for (let t = from; t <= to; t += 0.5) {
    sum += m.frameSeparation(Y, set.count, set.dimension, inst.stateAt(t).frame, groups);
    n++;
  }
  return sum / n;
}

test("Lattice keeps showing groups after every axis has been swapped; full-space swaps do not", () => {
  const ET = F.freshET();
  const { set, groups } = plantedSet(ET, 1024);
  const strongest = F.ready(ET, "lattice", set, { seed: 5 });
  const full = F.ready(ET, "lattice", set, { seed: 5 }, { hidden: "full" });
  // From 12 s on (period 3.4 s) all three starting axes have been traded away.
  const a = meanSeparation(ET, strongest, set, groups, 12, 72);
  const b = meanSeparation(ET, full, set, groups, 12, 72);
  assert.ok(b < 1.2, `full-space hidden directions: ${b}`);
  assert.ok(a >= 1.3, `strongest directions: ${a}`);
  assert.ok(a - b >= 0.2, `strongest ${a} vs full ${b}`);
  assert.strictEqual(strongest.describe().hidden, "strongest");
  assert.strictEqual(strongest.describe().subspace, 8);
  assert.ok(strongest.describe().varianceShare > 0 && strongest.describe().varianceShare <= 1);
  assert.strictEqual(full.describe().hidden, "full");
  assert.strictEqual(full.describe().varianceShare, null);
});

test("Lattice with strongest directions: frames stay orthonormal, in the fitted span, and deterministic", () => {
  const ET = F.freshET();
  const { set } = plantedSet(ET, 96);
  const a = F.ready(ET, "lattice", set, { seed: 9 });
  const b = F.ready(ET, "lattice", set, { seed: 9 });
  const D = set.dimension;
  const Y = ET.math.centre(set.vectors, set.count, D).data;
  const basis = ET.math.guidedTour(Y, set.count, D, { seed: 9, subspace: 8 }).basis;
  for (const t of [0, 1.7, 12, 13.3, 40, 200.5]) {
    const fa = a.stateAt(t).frame;
    assert.ok(F.frameError(fa, D) < 1e-5, `orthonormal at ${t}`);
    assert.ok(F.bytesEqual(fa, b.stateAt(t).frame), `deterministic at ${t}`);
    if (t >= 12) {
      // Every axis lies (almost) inside the span of the 8 fitted directions. The start
      // frame is a random one outside that span, and each hidden direction is made
      // orthogonal to the axes still shown, so the first few carry a small part from
      // outside; it is gone once those axes have been traded away again.
      for (let r = 0; r < 3; r++) {
        let inside = 0;
        for (let k = 0; k < 8; k++) {
          let dot = 0;
          for (let d = 0; d < D; d++) dot += fa[r * D + d] * basis[k * D + d];
          inside += dot * dot;
        }
        assert.ok(inside > (t >= 40 ? 1 - 1e-3 : 0.95) && inside < 1 + 1e-4, `axis ${r} at ${t}: ${inside}`);
      }
    }
  }
});

test("Lattice: a set too small for a fit (dimension 4 has room; one point does not) still runs", () => {
  const ET = F.freshET();
  const tiny = F.tinyDimensionSet(ET, 4, 12);
  const inst = F.ready(ET, "lattice", tiny, { seed: 2 });
  assert.ok(inst.isReady());
  assert.ok(F.frameError(inst.stateAt(20).frame, 4) < 1e-5);
});
