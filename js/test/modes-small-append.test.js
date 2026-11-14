"use strict";
// Appends onto a set too small for a mode's fit (one point) or onto an empty set:
// whatever the mode decided at entry, the append must leave it ready (directly or
// after re-entering), never waiting for a fit nobody scheduled.
const test = require("node:test");
const assert = require("node:assert");
const F = require("./helpers/modes-fixtures.js");

const MODES = ["tumble", "lattice", "wander"];
const D = 48;

// The first `n` rows of the sample set as a set of its own.
function firstRows(ET, n) {
  const donor = F.sampleSet(ET, { dimension: D });
  const base = F.emptySet(ET, D);
  return { donor, set: n ? F.appendRows(ET, base, donor, 0, n) : base };
}

// Hand an append to the instance the way the viewer does, run its work to the end.
function appendAndSettle(inst, set, k, t) {
  const r = inst.dataChanged(set, { op: "append", added: k, t: t });
  for (let i = 0; r && r.work && !r.work.done && i < 100000; i++) r.work.step();
  return r;
}

for (const id of MODES) {
  for (const n of [1, 0]) {
    test(`${id}: ${n} point${n === 1 ? "" : "s"}, then an append of 4: the mode becomes ready and its frames are orthonormal`, () => {
      const ET = F.freshET();
      const { donor, set } = firstRows(ET, n);
      const inst = F.ready(ET, id, set, { seed: 3 });
      assert.ok(inst.isReady(), "ready on the small set");
      inst.stateAt(0.5);
      const bigger = F.appendRows(ET, set, donor, n, 4);
      const r = appendAndSettle(inst, bigger, 4, 0.5);
      assert.ok(inst.isReady(), "ready after the append" + (r && r.restart ? " (restarted)" : ""));
      for (const t of [0, 0.5, 1, 3, 7]) {
        const s = inst.stateAt(t);
        assert.ok(F.frameError(s.frame, D) < 1e-4, `${id} frame orthonormal at t=${t}`);
        for (let i = 0; i < s.frame.length; i++) assert.ok(Number.isFinite(s.frame[i]));
      }
      // ...and later appends keep it ready too.
      const more = F.appendRows(ET, bigger, donor, n + 4, 20);
      appendAndSettle(inst, more, 20, 2);
      assert.ok(inst.isReady(), "ready after a second append");
    });
  }
}

test("lattice: an append onto one point uses the strongest directions afterwards, like the whole set sent at once", () => {
  const ET = F.freshET();
  const { donor, set } = firstRows(ET, 1);
  const inst = F.ready(ET, "lattice", set, { seed: 3 });
  assert.strictEqual(inst.describe().hidden, "full", "one point: nothing to fit");
  const r = appendAndSettle(inst, F.appendRows(ET, set, donor, 1, 4), 4, 0.5);
  assert.strictEqual(r.restart, true, "the fit it skipped is made by entering again");
  assert.strictEqual(inst.describe().hidden, "strongest");
});
