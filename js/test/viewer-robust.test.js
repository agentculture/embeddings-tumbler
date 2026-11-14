"use strict";
// Robustness of js/src/50-viewer.js (review fixes): no exception from a mode, the
// renderer, validation or a host callback ever reaches the host; a broken viewer
// recovers; a paused viewer never starts a refit; a failed GPU append rolls back.
// Each test loads the sources in a fresh context so a registered mode does not leak.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const MEMBERS = ["enter", "prepare", "step-of-prepare", "stateAt", "dataChanged", "mark", "describe", "leave", "isReady"];

// A minimal, correct mode, except that the member named in `failing.on` throws.
function dummyMode(failing) {
  return {
    id: "dummy",
    title: "Dummy",
    summary: "Holds still; throws on demand.",
    create() {
      let set = null;
      const boom = (m) => {
        if (failing.on === m) throw new Error("dummy " + m + " failed");
      };
      function state(t) {
        const D = set.dimension;
        const frame = new Float32Array(3 * D);
        frame[0] = 1;
        frame[D + 1] = 1;
        frame[2 * D + 2] = 1;
        return {
          t,
          frame,
          centre: new Float32Array(D),
          draw: { zoom: 1, wires: 0, dim: 1, trails: 0.1, fog: 0, fogNear: 1.2, fogWidth: 0.8, twinkle: 0, depthOfField: 1 },
          wires: null,
          status: "dummy at " + t.toFixed(1),
          focus: null,
        };
      }
      const inst = {
        time: 0,
        enter(s) {
          boom("enter");
          set = s;
        },
        prepare() {
          boom("prepare");
          const st = {
            done: false,
            ready: false,
            progress: 0,
            step() {
              boom("step-of-prepare");
              st.done = st.ready = true;
              st.progress = 1;
              return true;
            },
          };
          return st;
        },
        isReady() {
          boom("isReady");
          return true;
        },
        stateAt(t) {
          boom("stateAt");
          return state(t);
        },
        step(dt) {
          inst.time += dt;
          return inst.stateAt(inst.time);
        },
        status(t) {
          return "dummy " + (t || 0);
        },
        dataChanged(s) {
          boom("dataChanged");
          set = s;
          return { work: null, restart: false };
        },
        mark() {
          boom("mark");
        },
        describe() {
          boom("describe");
          return { id: "dummy", projection: "linear: held still", seed: 1, varianceShare: null };
        },
        leave() {
          boom("leave");
        },
      };
      return inst;
    },
  };
}

function fresh(domOpts, mountOpts) {
  const api = loadSources();
  const dom = makeFakeDom(domOpts);
  const el = dom.host();
  const h = api.mount(el, { seed: 2, ...mountOpts });
  return { api, dom, el, h, v: h._viewer };
}

function noThrow(fn, what) {
  try {
    return fn();
  } catch (err) {
    assert.fail(what + " threw into the host: " + err.message);
  }
}

// ---------- 1: a buggy mode never throws into the host ----------

for (const member of MEMBERS) {
  test("a mode whose " + member + " throws never throws into the host", () => {
    const failing = { on: null };
    const api = loadSources();
    api.registerMode(dummyMode(failing));
    const dom = makeFakeDom();
    const el = dom.host();
    const h = api.mount(el, { mode: "dummy" });
    const v = h._viewer;
    // Start healthy, then turn the failure on.
    noThrow(() => h.update(makeSet({ n: 20, d: 8 })), "update");
    dom.frames(5);
    failing.on = member;
    let r;
    r = noThrow(() => h.update(makeSet({ n: 5, d: 8, op: "append", idPrefix: "a" })), "append");
    assert.strictEqual(typeof r.ok, "boolean");
    noThrow(() => dom.frames(10), "frame loop");
    r = noThrow(() => h.update(makeSet({ n: 30, d: 8, seed: 4 })), "replace");
    assert.strictEqual(typeof r.ok, "boolean");
    if (!r.ok) assert.strictEqual(typeof r.code, "string");
    noThrow(() => dom.frames(10), "frame loop after replace");
    noThrow(() => h.setMode("tumble"), "setMode away");
    noThrow(() => dom.frames(3), "frames");
    noThrow(() => h.setMode("dummy"), "setMode back");
    noThrow(() => dom.frames(3), "frames");
    noThrow(() => h.info(), "info");
    noThrow(() => h.seek(2), "seek");
    noThrow(() => h.refreshTheme(), "refreshTheme");
    noThrow(() => h.destroy(), "destroy");
    assert.strictEqual(el.children.length, 0);
    assert.strictEqual(dom.listenerBalance(), 0);
    assert.strictEqual(v.destroyed, true);
  });
}

test("a mode that fails on append returns mode-failed and keeps the previous view", () => {
  const failing = { on: null };
  const api = loadSources();
  api.registerMode(dummyMode(failing));
  const dom = makeFakeDom();
  const h = api.mount(dom.host(), { mode: "dummy" });
  const v = h._viewer;
  h.update(makeSet({ n: 20, d: 8 }));
  dom.frames(5);
  const set = v.set;
  failing.on = "dataChanged";
  const r = h.update(makeSet({ n: 5, d: 8, op: "append", idPrefix: "a" }));
  failing.on = null;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "mode-failed");
  assert.match(r.message, /dummy dataChanged failed/);
  assert.strictEqual(v.set, set, "the set held is unchanged");
  assert.strictEqual(v.renderer.status().count, 20, "the GPU copy rolled back");
  assert.strictEqual(v.noticeText.textContent, r.message);
  dom.frames(5);
  assert.strictEqual(h.info().count, 20);
  assert.ok(dom.pendingFrames() > 0, "still running");
  h.destroy();
});

test("a replace no mode can show is refused and the previous view keeps running", () => {
  const failing = { on: null };
  const api = loadSources();
  api.registerMode(dummyMode(failing));
  const dom = makeFakeDom();
  const h = api.mount(dom.host(), { mode: "dummy" });
  const v = h._viewer;
  h.update(makeSet({ n: 20, d: 8 }));
  dom.frames(5);
  const set = v.set;
  // D = 2: every shipped mode refuses it, and the dummy fails on enter.
  failing.on = "enter";
  const r = h.update(makeSet({ n: 10, d: 2, groups: ["a"] }));
  failing.on = null;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "mode-failed");
  assert.strictEqual(v.set, set);
  assert.strictEqual(v.renderer.status().dimension, 8, "the GPU copy rolled back");
  assert.strictEqual(h.mode(), "dummy");
  dom.frames(5);
  assert.ok(v.frames > 0);
  h.destroy();
});

test("a renderer that throws on upload becomes a refusal, never a throw", () => {
  const { dom, h, v } = fresh();
  h.update(makeSet({ n: 20, d: 8 }));
  dom.frames(3);
  const set = v.set;
  const orig = v.renderer.setData;
  v.renderer.setData = function () {
    v.renderer.setData = orig;
    throw new TypeError("vectors has the wrong length");
  };
  const r = noThrow(() => h.update(makeSet({ n: 12, d: 8, seed: 9 })), "replace");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "gpu-failed");
  assert.strictEqual(v.set, set);
  const origA = v.renderer.appendData;
  v.renderer.appendData = function () {
    throw new RangeError("index out of range");
  };
  const a = noThrow(() => h.update(makeSet({ n: 3, d: 8, op: "append", idPrefix: "z" })), "append");
  v.renderer.appendData = origA;
  assert.strictEqual(a.ok, false);
  assert.strictEqual(a.code, "gpu-failed");
  assert.strictEqual(v.set, set);
  dom.frames(3);
  h.destroy();
});

// ---------- 2: a broken viewer recovers ----------

test("an error inside a frame shows a notice, and a replace or a mode switch recovers", () => {
  const failing = { on: null };
  const api = loadSources();
  api.registerMode(dummyMode(failing));
  const dom = makeFakeDom();
  const h = api.mount(dom.host(), { mode: "dummy" });
  const v = h._viewer;
  h.update(makeSet({ n: 20, d: 8 }));
  dom.frames(3);
  failing.on = "stateAt";
  dom.frames(2);
  assert.strictEqual(v.broken, true);
  assert.strictEqual(v.notice.style.display, "flex");
  assert.match(v.noticeText.textContent, /stopped.*dummy stateAt failed/);
  assert.strictEqual(dom.pendingFrames(), 0, "the loop stopped");
  failing.on = null;
  const r = h.update(makeSet({ n: 25, d: 8, seed: 3 }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(v.broken, false);
  const f = v.frames;
  dom.frames(5);
  assert.ok(v.frames > f, "running again after a replace");
  // Break again; a mode switch recovers too.
  failing.on = "stateAt";
  dom.frames(2);
  assert.strictEqual(v.broken, true);
  failing.on = null;
  assert.strictEqual(h.setMode("tumble"), true);
  assert.strictEqual(v.broken, false);
  const g = v.frames;
  dom.frames(5);
  assert.ok(v.frames > g, "running again after a mode switch");
  h.destroy();
});

// ---------- 3: no refit while paused or suspended ----------

test("a paused viewer never starts a refit; it starts after resume", () => {
  const { dom, h } = fresh({}, { refitQuietSeconds: 0.3 });
  h.update(makeSet({ n: 200, d: 16 }));
  dom.frames(30);
  h.update(makeSet({ n: 40, d: 16, op: "append", idPrefix: "r" }));
  h.pause();
  dom.frames(120); // 2 s of frames, well past the quiet period
  assert.strictEqual(h.info().timing.refits, 0, "no refit while paused");
  h.resume();
  dom.frames(30);
  assert.strictEqual(h.info().timing.refits, 1, "the refit runs after resume");
  h.destroy();
});

test("a hidden viewer never starts a refit; it starts once visible", () => {
  const { dom, h } = fresh({}, { refitQuietSeconds: 0.3 });
  h.update(makeSet({ n: 200, d: 16 }));
  dom.frames(30);
  h.update(makeSet({ n: 40, d: 16, op: "append", idPrefix: "r" }));
  dom.document.setHidden(true);
  dom.frames(120);
  assert.strictEqual(h.info().timing.refits, 0);
  dom.document.setHidden(false);
  dom.frames(40);
  assert.strictEqual(h.info().timing.refits, 1);
  h.destroy();
});

// ---------- 4: validation errors are not disguised ----------

test("an unexpected error inside validation is reported as internal, not as bad data", () => {
  const { api, dom, h, v } = fresh();
  const ET = api._internal;
  const orig = ET.contract.validate;
  ET.contract.validate = function () {
    throw new Error("validator bug");
  };
  let r;
  try {
    r = noThrow(() => h.update(makeSet({ n: 5, d: 8 })), "update");
  } finally {
    ET.contract.validate = orig;
  }
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "internal");
  assert.match(r.message, /validator bug/);
  assert.doesNotMatch(r.message, /unreadable data/);
  // The hostile-getter case is the contract's own: invalid-field, (unreadable data).
  const hostile = makeSet();
  Object.defineProperty(hostile, "model", {
    get() {
      throw new Error("boom");
    },
  });
  const g = h.update(hostile);
  assert.strictEqual(g.code, "invalid-field");
  assert.match(g.message, /unreadable data/);
  dom.frames(2);
  assert.ok(v);
  h.destroy();
});

// ---------- 5: a failed GPU append rolls back the palette ----------

test("a failed GPU append leaves the group palette, labels and count as they were", () => {
  const { dom, h, v } = fresh();
  h.update(makeSet({ n: 30, d: 8, groups: ["a", "b"] }));
  dom.frames(5);
  const names = v.groupNames.slice();
  const labelled = v.labelledCount;
  const sample = v.labelSample.length;
  const gl = dom.env.glStates[0];
  // The append outgrows the capacity (30), so its upload re-allocates the point texture;
  // that first texImage2D fails in the GPU. Later calls (the rollback) succeed.
  const startIdx = gl.calls.length;
  Object.defineProperty(gl.opts, "throwOn", {
    configurable: true,
    get() {
      const n = gl.calls.slice(startIdx).filter((c) => c[0] === "texImage2D").length;
      return n <= 1 ? "texImage2D" : null;
    },
  });
  const r = h.update(
    makeSet({ n: 6, d: 8, op: "append", idPrefix: "n", groups: ["new-group", "other-new"], labelEvery: 1 })
  );
  Object.defineProperty(gl.opts, "throwOn", { value: null, writable: true, configurable: true });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "gpu-failed");
  assert.deepStrictEqual(v.groupNames, names, "no group added to the palette");
  assert.strictEqual(v.labelledCount, labelled);
  assert.strictEqual(v.labelSample.length, sample);
  assert.strictEqual(v.set.count, 30);
  assert.strictEqual(v.renderer.status().count, 30, "the GPU copy rolled back");
  dom.frames(5);
  assert.strictEqual(v.renderer.status().ok, true, "drawing again");
  // The next good append uses the right palette slot for a new group.
  assert.strictEqual(h.update(makeSet({ n: 2, d: 8, op: "append", idPrefix: "m", groups: ["c"] })).ok, true);
  assert.strictEqual(v.groupNames[2], "c");
  h.destroy();
});

// ---------- 6: host callbacks ----------

for (const name of ["onError", "onModeChange", "onPauseChange"]) {
  test("a throwing " + name + " leaves the viewer running and is rethrown on a later task", () => {
    const opts = {};
    opts[name] = () => {
      throw new Error(name + " is broken");
    };
    const { dom, h, v } = fresh({}, opts);
    h.update(makeSet({ n: 20, d: 8 }));
    dom.frames(3);
    noThrow(() => {
      if (name === "onError") h.update({});
      else if (name === "onModeChange") h.setMode("lattice");
      else h.pause();
    }, name);
    assert.ok(dom.pendingTimers() > 0, "the error is queued");
    assert.throws(() => dom.runTimers(), new RegExp(name + " is broken"));
    if (name === "onPauseChange") h.resume();
    const f = v.frames;
    dom.frames(3);
    assert.ok(v.frames > f, "still running");
    h.destroy();
  });
}

test("without setTimeout a callback error goes to queueMicrotask, else console.error", () => {
  const dom = makeFakeDom();
  delete dom.window.setTimeout;
  const queued = [];
  dom.window.queueMicrotask = (fn) => queued.push(fn);
  const api = loadSources();
  const h = api.mount(dom.host(), {
    onError: () => {
      throw new Error("cb broken");
    },
  });
  h.update({});
  assert.strictEqual(queued.length, 1);
  assert.throws(() => queued[0](), /cb broken/);
  h.destroy();

  const dom2 = makeFakeDom();
  delete dom2.window.setTimeout;
  const logged = [];
  dom2.window.console = { error: (...a) => logged.push(a) };
  const h2 = api.mount(dom2.host(), {
    onError: () => {
      throw new Error("cb broken 2");
    },
  });
  h2.update({});
  assert.strictEqual(logged.length, 1);
  assert.match(String(logged[0].at(-1)), /cb broken 2/);
  h2.destroy();
});
