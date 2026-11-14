"use strict";
// Tumble's turn onto a refitted tour (refitTransition), and preparation pumped in tiny
// budgets. The turn's length is chosen from its size so that the frame never changes
// much faster than in normal running; preparation slicing never changes a frame.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

// Frobenius norm of the change between two frames.
function change(A, B) {
  let s = 0;
  for (let i = 0; i < A.length; i++) s += (A[i] - B[i]) ** 2;
  return Math.sqrt(s);
}

// Points far from the rest: the mean plus three radii along one direction, a little noise.
function clusterAppend(ET, set, k) {
  const D = set.dimension;
  const st = ET.modes.stats(set);
  const rng = ET.math.makeRandom(99);
  const dir = new Float32Array(D);
  rng.fillGauss(dir);
  let n = 0;
  for (const x of dir) n += x * x;
  n = Math.sqrt(n);
  const vectors = new Float32Array(k * D);
  const points = [];
  for (let a = 0; a < k; a++) {
    for (let d = 0; d < D; d++) {
      vectors[a * D + d] = st.mean[d] + (3 * st.radius * dir[d]) / n + (0.15 * st.radius * rng.gauss()) / Math.sqrt(D);
    }
    points.push({ id: "far" + a, label: "" });
  }
  const res = ET.contract.validate(
    {
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      op: "append",
      model: set.model,
      dimension: D,
      count: k,
      text_included: false,
      vectors,
      points,
    },
    set,
  );
  assert.ok(res.ok, res.message);
  return res.set;
}

// Largest per-frame change over normal running before T, and over the refit's turn.
function peaks(inst, T, duration, speed) {
  const dt = speed / 60; // the viewer's speed scales mode time
  const L = Math.max(duration, 4);
  let prev = null;
  let normal = 0;
  let turn = 0;
  for (let i = 0; ; i++) {
    const t = T - L + i * dt;
    if (t > T + duration + dt) break;
    const f = new Float32Array(inst.stateAt(t).frame);
    if (prev) {
      const c = change(prev, f);
      if (t <= T) normal = Math.max(normal, c);
      else turn = Math.max(turn, c);
    }
    prev = f;
  }
  return { normal, turn };
}

for (const D of [48, 128]) {
  for (const kind of ["same distribution", "new cluster"]) {
    for (const speed of [1, 3]) {
      test(`Tumble refit at ${D}-d, ${kind}, speed ${speed}: the turn's peak change is at most 1.5 x normal`, () => {
        const ET = F.freshET();
        const set = F.sampleSet(ET, { dimension: D, count: 900 });
        const inst = F.ready(ET, "tumble", set, { seed: 3 });
        const bigger = kind === "new cluster" ? clusterAppend(ET, set, 300) : F.appendTo(ET, set, 120);
        const T = 7;
        inst.dataChanged(bigger, { op: "append", added: bigger.count - set.count, t: T - 1 });
        inst.refit(T).step();
        const d = inst.describe();
        assert.strictEqual(d.refitAt, T);
        assert.ok(d.refitTransition >= 1.5 && d.refitTransition <= 12, String(d.refitTransition));
        const p = peaks(inst, T, d.refitTransition, speed);
        assert.ok(p.normal > 0);
        assert.ok(p.turn <= 1.5 * p.normal, `peak ${p.turn} against normal ${p.normal} (x${(p.turn / p.normal).toFixed(2)})`);
        // continuous at both ends of the turn
        const a = new Float32Array(inst.stateAt(T - 1e-4).frame);
        assert.ok(change(a, inst.stateAt(T).frame) < 1e-3);
        assert.ok(F.frameError(inst.stateAt(T + d.refitTransition / 2).frame, D) < 1e-5);
      });
    }
  }
}

test("Tumble refit turn: pure in t and identical across instances and query orders", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { count: 900 });
  const bigger = clusterAppend(ET, set, 300);
  function made() {
    const inst = F.ready(ET, "tumble", set, { seed: 5 });
    inst.dataChanged(bigger, { op: "append", added: 300, t: 3 });
    inst.refit(4).step();
    return inst;
  }
  const a = made();
  const b = made();
  assert.strictEqual(a.describe().refitTransition, b.describe().refitTransition);
  const times = F.ticks(16, 30).map((t) => t + 2);
  const fa = F.framesAt(a, times);
  const fb = F.framesAt(b, times.slice().reverse()).reverse();
  for (let i = 0; i < times.length; i++) assert.ok(F.bytesEqual(fa[i].frame, fb[i].frame), `t = ${times[i]}`);
});

test("Tumble refitTransition: a number fixes the turn's length; entry transition unchanged", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const inst = F.ready(ET, "tumble", set, { seed: 2 }, { refitTransition: 4 });
  inst.dataChanged(F.appendTo(ET, set, 40), { op: "append", added: 40, t: 2 });
  inst.refit(3).step();
  assert.strictEqual(inst.describe().refitTransition, 4);
  const plain = F.ready(ET, "tumble", set, { seed: 2 });
  assert.strictEqual(plain.describe().refitTransition, null, "no refit yet");
});

test("Tumble preparation pumped in tiny budgets gives the frames of a blocking preparation", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { dimension: 96, count: 1200 });
  const blocking = F.ready(ET, "tumble", set, { seed: 8 });
  const ET2 = F.freshET(); // no shared statistics cache
  const set2 = F.sampleSet(ET2, { dimension: 96, count: 1200 });
  const pumped = ET2.modes.create("tumble");
  pumped.enter(set2, { seed: 8 });
  const prep = pumped.prepare();
  let units = 0;
  while (!prep.done) {
    prep.step(units % 2 ? 0 : 0.01);
    units++;
  }
  assert.ok(units > 20, `only ${units} units`);
  const times = F.ticks(10, 30);
  const a = F.framesAt(blocking, times);
  const b = F.framesAt(pumped, times);
  for (let i = 0; i < times.length; i++) {
    assert.ok(F.bytesEqual(a[i].frame, b[i].frame), `frame at ${times[i]}`);
    assert.ok(F.bytesEqual(a[i].centre, b[i].centre), `centre at ${times[i]}`);
  }
});
