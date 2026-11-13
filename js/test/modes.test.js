"use strict";
// ET.modes: the mode interface, the registry, one file per mode, and a fourth mode
// registered from outside (task t7, criteria 1 and 2).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, SRC_DIR } = require("./helpers/load.js");
const F = require("./helpers/modes-fixtures.js");

const MODE_FILES = {
  tumble: "40-mode-tumble.js",
  lattice: "41-mode-lattice.js",
  wander: "42-mode-wander.js",
};

test("criterion 1: each mode lives in its own file and registers only itself", () => {
  for (const [id, file] of Object.entries(MODE_FILES)) {
    assert.ok(fs.existsSync(path.join(SRC_DIR, file)), file + " exists");
    const ET = loadSources(["10-math.js", "39-modes.js", file])._internal;
    assert.deepStrictEqual(Array.from(ET.modes.ids()), [id], file + " registers exactly " + id);
  }
});

test("criterion 1: with every module loaded the three modes are listed in order", () => {
  const ET = F.freshET();
  assert.deepStrictEqual(Array.from(ET.modes.ids()), ["tumble", "lattice", "wander"]);
  for (const def of ET.modes.list()) {
    assert.strictEqual(typeof def.title, "string");
    assert.ok(def.title.length > 0);
    assert.strictEqual(typeof def.summary, "string");
    assert.strictEqual(typeof def.create, "function");
  }
});

test("criterion 1: all three implement the same documented interface", () => {
  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const D = set.dimension;
  const drawKeys = Object.keys(ET.renderer.DEFAULTS);
  for (const id of ET.modes.ids()) {
    const inst = ET.modes.create(id);
    assert.strictEqual(ET.modes.check(inst).length, 0, id + " has every interface member");
    inst.enter(set, { seed: 3 });
    const prep = inst.prepare();
    assert.strictEqual(typeof prep.step, "function");
    assert.strictEqual(typeof prep.progress, "number");
    prep.step();
    assert.strictEqual(prep.done, true);
    assert.strictEqual(inst.isReady(), true);
    for (const t of [0, 0.5, 3.3, 7.9]) {
      const s = inst.stateAt(t);
      assert.ok(s.frame.constructor.name === "Float32Array" && s.frame.length === 3 * D, id + " frame shape");
      assert.ok(F.frameError(s.frame, D) < 1e-5, id + " frame orthonormal at " + t);
      assert.ok(s.centre.constructor.name === "Float32Array" && s.centre.length === D, id + " centre shape");
      assert.strictEqual(typeof s.status, "string");
      assert.ok(s.status.length > 0);
      for (const [k, v] of Object.entries(s.draw)) {
        assert.ok(drawKeys.includes(k), id + " draw key " + k + " is a renderer key");
        assert.ok(typeof v === "number" && isFinite(v), id + " draw " + k + " is a finite number");
      }
      assert.ok(s.wires === null || (s.wires.pairs.length % 2 === 0 && typeof s.wires.version === "number"));
      assert.strictEqual(inst.status(t), s.status);
    }
    const desc = inst.describe();
    assert.strictEqual(desc.id, id);
    assert.strictEqual(typeof desc.projection, "string");
    assert.ok(/linear/i.test(desc.projection), id + " says the projection is linear");
    inst.leave();
  }
});

test("criterion 2: a fourth dummy mode registers without editing any existing file", () => {
  const before = {};
  for (const f of fs.readdirSync(SRC_DIR)) before[f] = fs.readFileSync(path.join(SRC_DIR, f), "utf8");

  const ET = F.freshET();
  const set = F.sampleSet(ET);
  const D = set.dimension;
  ET.modes.register({
    id: "still",
    title: "Still",
    summary: "The frame does not move.",
    create: function () {
      let frame = null;
      let centre = null;
      return {
        enter(s, opts) {
          frame = new Float32Array(3 * s.dimension);
          for (let r = 0; r < 3; r++) frame[r * s.dimension + r] = 1;
          centre = new Float32Array(s.dimension);
          this.seed = opts && opts.seed;
          this.time = 0;
        },
        prepare() {
          return ET.modes.stepper([]);
        },
        isReady() {
          return frame !== null;
        },
        stateAt(t) {
          return { t, frame, centre, draw: { wires: 0 }, wires: null, status: "held still for " + t.toFixed(1) + " s" };
        },
        step(dt) {
          this.time += dt;
          return this.stateAt(this.time);
        },
        status(t) {
          return this.stateAt(t).status;
        },
        dataChanged() {
          return null;
        },
        describe() {
          return { id: "still", projection: "a fixed linear projection onto three axes", varianceShare: null };
        },
        leave() {},
      };
    },
  });
  assert.deepStrictEqual(Array.from(ET.modes.ids()), ["tumble", "lattice", "wander", "still"]);
  const inst = ET.modes.create("still");
  assert.strictEqual(ET.modes.check(inst).length, 0);
  inst.enter(set, { seed: 1 });
  inst.prepare().step();
  assert.ok(inst.isReady());
  const s = inst.step(0.5);
  assert.strictEqual(s.frame.length, 3 * D);
  assert.strictEqual(s.status, "held still for 0.5 s");

  // The three shipped modes still work next to it, and nothing on disk changed.
  for (const id of ["tumble", "lattice", "wander"]) {
    const m = F.ready(ET, id, set);
    assert.ok(F.frameError(m.stateAt(1).frame, D) < 1e-5);
  }
  for (const f of fs.readdirSync(SRC_DIR)) {
    assert.strictEqual(fs.readFileSync(path.join(SRC_DIR, f), "utf8"), before[f], f + " unchanged");
  }
});

test("registry refuses malformed and duplicate modes, and unknown ids", () => {
  const ET = F.freshET();
  assert.throws(() => ET.modes.register(null), { name: "TypeError" });
  assert.throws(() => ET.modes.register({ id: "Bad Id", title: "x", summary: "", create() {} }), { name: "TypeError" });
  assert.throws(() => ET.modes.register({ id: "nocreate", title: "x", summary: "" }), { name: "TypeError" });
  assert.throws(
    () => ET.modes.register({ id: "tumble", title: "again", summary: "", create() {} }),
    /already registered/,
  );
  assert.strictEqual(ET.modes.get("nope"), null);
  assert.throws(() => ET.modes.create("nope"), { name: "RangeError" });
  // create() refuses an instance that lacks interface members
  ET.modes.register({ id: "broken", title: "Broken", summary: "", create: () => ({ enter() {} }) });
  assert.throws(() => ET.modes.create("broken"), /missing/);
});

test("list() hands out copies: callers cannot rewrite the registry", () => {
  const ET = F.freshET();
  const l = ET.modes.list();
  l.pop();
  l[0].id = "changed";
  assert.deepStrictEqual(Array.from(ET.modes.ids()), ["tumble", "lattice", "wander"]);
});

test("stepper: bounded slices, progress and readiness", () => {
  const ET = F.freshET();
  let a = 0;
  let b = 0;
  const st = ET.modes.stepper([
    { required: true, weight: 1, run: () => ++a >= 3 },
    { required: false, weight: 3, run: () => ++b >= 2 },
  ]);
  assert.strictEqual(st.ready, false);
  st.step(0); // a zero budget still does one unit
  assert.strictEqual(a, 1);
  assert.ok(st.progress > 0 && st.progress < 1);
  st.step(0);
  st.step(0);
  assert.strictEqual(st.ready, true, "required work done");
  assert.strictEqual(st.done, false);
  assert.strictEqual(st.step(), true);
  assert.strictEqual(st.progress, 1);
  assert.strictEqual(ET.modes.stepper([]).done, true);
});
