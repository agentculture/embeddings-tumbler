"use strict";
// Long sessions and far seeks: Wander keeps a bounded window of hops plus a
// bounded set of checkpoints (not every hop's frame forever), and the swap
// tour behind Lattice replays a backward seek from a checkpoint, not from the
// start. Answers stay exactly those of a fresh instance queried in order.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

const D = 24;

function copy(s) {
  return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), status: s.status };
}
function same(a, b, what) {
  assert.ok(F.bytesEqual(a.frame, b.frame), what + ": frame");
  assert.ok(F.bytesEqual(a.centre, b.centre), what + ": centre");
  assert.strictEqual(a.status, b.status, what + ": status");
}

test("Wander: after 1,500 hops the retained route is bounded and every answer equals a fresh instance's", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { dimension: D, count: 400 });
  const a = F.ready(ET, "wander", set, { seed: 4 });
  const cycle = a.describe().travel + a.describe().dwell;
  const H = 1500;
  // play forward hop by hop, as a long session does
  const fwd = new Map();
  const probe = [0, 1, 2, 17, 63, 64, 65, 200, 511, 777, 1024, 1300, 1450, 1499];
  for (let h = 0; h < H; h++) {
    const t = h * cycle + 1.3;
    const s = a.stateAt(t);
    if (probe.includes(h)) fwd.set(h, copy(s));
  }
  const r = a.retained();
  assert.ok(r.hops <= 80, `hops kept: ${r.hops}`);
  assert.ok(r.checkpoints <= 40, `checkpoints kept: ${r.checkpoints}`);
  assert.ok(r.floats <= (80 + 40 + 4) * 3 * D, `floats kept: ${r.floats}`);
  // backward, out of order and repeated, on the long-running instance
  for (const h of [1300, 2, 1499, 0, 777, 64, 1450, 65, 200, 1024, 511, 17, 63, 1, 1499, 2]) {
    same(copy(a.stateAt(h * cycle + 1.3)), fwd.get(h), "hop " + h);
  }
  assert.ok(a.retained().hops <= 80 && a.retained().checkpoints <= 40, "still bounded after the seeks");
  // ...and a fresh instance sent straight to a far time agrees
  const b = F.ready(ET, "wander", set, { seed: 4 });
  same(copy(b.stateAt(1450 * cycle + 1.3)), fwd.get(1450), "fresh, far");
  same(copy(b.stateAt(17 * cycle + 1.3)), fwd.get(17), "fresh, back");
  assert.deepStrictEqual(Array.from(b.route(30)), Array.from(a.route(30)));
});

test("Wander: a backward seek after many hops replays from a checkpoint, not from the first hop", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { dimension: D, count: 400 });
  const a = F.ready(ET, "wander", set, { seed: 4 });
  const cycle = a.describe().travel + a.describe().dwell;
  for (let h = 0; h < 1500; h++) a.stateAt(h * cycle);
  const before = a.retained().hopsComputed;
  a.stateAt(1000 * cycle + 0.5);
  const cost = a.retained().hopsComputed - before;
  assert.ok(cost <= 1500 / 16, `a seek back to hop 1000 computed ${cost} hops`);
});

test("Wander: appends far into a session keep the route before them, bounded", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET, { dimension: D, count: 400 });
  const a = F.ready(ET, "wander", set, { seed: 6 });
  const b = F.ready(ET, "wander", set, { seed: 6 });
  const cycle = a.describe().travel + a.describe().dwell;
  for (let h = 0; h < 400; h++) a.stateAt(h * cycle + 0.2);
  const kept = copy(a.stateAt(390 * cycle + 2.5));
  let cur = set;
  let t = 400 * cycle + 1;
  for (let k = 0; k < 30; k++) {
    const next = F.appendTo(ET, cur, 3, { labelled: true, group: "g" + k });
    for (const inst of [a, b]) inst.dataChanged(next, { op: "append", added: 3, t: t });
    cur = next;
    t += cycle * 7;
    for (let h = 0; h < 7; h++) a.stateAt(t - cycle * 7 + h * cycle);
  }
  // the hop shown just before the first append is still what it was
  same(copy(a.stateAt(390 * cycle + 2.5)), kept, "hop 390 after the appends");
  // the route is fixed by the data history, not by how it was queried
  for (const tt of [t + 30, 400 * cycle + 2, t - 100, 395 * cycle]) same(copy(a.stateAt(tt)), copy(b.stateAt(tt)), "t = " + tt);
  const r = a.retained();
  assert.ok(r.hops <= 80 + 80, `hops kept: ${r.hops}`);
  assert.ok(r.checkpoints <= 40, `checkpoints kept: ${r.checkpoints}`);
});

test("swap tour: a backward seek far into the tour replays from a checkpoint and agrees bit for bit", () => {
  const ET = F.freshET();
  const math = ET.math;
  const start = ET.modes.startFrame(D, 3);
  const a = math.makeSwapTour(start, D, { seed: 3, period: 1 });
  const fresh = (t) => math.makeSwapTour(start, D, { seed: 3, period: 1 }).frameAt(t);
  a.frameAt(5000.5);
  const before = a.steps();
  const back = new Float32Array(a.frameAt(4000.25));
  assert.ok(a.steps() - before <= 5000 / 16, `backward seek took ${a.steps() - before} steps`);
  assert.ok(F.bytesEqual(back, fresh(4000.25)), "same frame as a fresh tour");
  for (const t of [3.5, 4999.9, 0, 2500.1, 4000.25]) assert.ok(F.bytesEqual(new Float32Array(a.frameAt(t)), fresh(t)), "t = " + t);
  assert.ok(a.checkpoints() <= 40, `checkpoints: ${a.checkpoints()}`);
});
