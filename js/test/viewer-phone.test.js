"use strict";
// The frame loop on a slow device (the owner's phone, 2026-11-14): the heavy-work budget
// follows the work's own script time, not the time between frames; the slow spin keeps
// turning while a mode prepares; the drawing-buffer ratio steps down when the frame rate
// stays low. Through the assembled file, on the fake DOM (helpers/fake-dom.js), whose clock
// moves only when a test moves it, so every time below is exact.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();

function setup(domOpts, mountOpts) {
  const dom = makeFakeDom(domOpts);
  const h = api.mount(dom.host(), { seed: 3, ...mountOpts });
  h.update(makeSet({ n: 60, d: 16 }));
  dom.frames(30);
  assert.ok(h.info().ready && !h.info().preparing, "the small set is ready");
  return { dom, h, v: h._viewer };
}

// A stand-in for queued heavy work: records the budget each step is given and takes `cost`
// milliseconds of the (fake) clock per step. Never done unless `finish()` is called.
function fakeJob(dom, cost) {
  const job = {
    done: false,
    given: [],
    cost: cost || 0,
    step(left) {
      job.given.push(left);
      if (job.cost) dom.advance(job.cost);
      return false;
    },
    finish() {
      job.done = true;
    },
  };
  return job;
}

// Drawing that blocks inside the viewer's callback, as WebGL calls can on a GPU-bound device.
function slowDraw(dom, v, ms) {
  const orig = v.renderer.draw;
  v.renderer.draw = function () {
    dom.advance(ms);
    return orig.apply(this, arguments);
  };
}

// ---------- the budget ----------

test("at 60 frames per second the budget is prepareBudgetMs, as before", () => {
  const { dom, h, v } = setup();
  const job = fakeJob(dom);
  v.mode.jobs.push(job);
  dom.frames(10);
  assert.strictEqual(h.info().timing.budgetMs, 8);
  assert.strictEqual(job.given.at(-1), 8);
  assert.ok(Math.abs(h.info().timing.intervalMs - 1000 / 60) < 1e-6);
  h.destroy();
});

test("long frames spent drawing (GPU-bound) raise the budget to a third of the interval", () => {
  const { dom, h, v } = setup();
  slowDraw(dom, v, 40);
  const job = fakeJob(dom);
  v.mode.jobs.push(job);
  // The fake clock moves 40 ms inside each callback (the draw) and 20 ms between them.
  for (let i = 0; i < 30; i++) dom.flush(20);
  const t = h.info().timing;
  assert.ok(Math.abs(t.budgetMs - 20) < 0.01, "a third of 60 ms: " + t.budgetMs);
  assert.ok(Math.abs(t.drawMs - 40) < 1e-9, "the draw's time is measured apart");
  assert.ok(t.scriptMs < 1, "and is not counted as script: " + t.scriptMs);
  assert.ok(job.given.slice(5).every((b) => b > 16), "never halved");
  h.destroy();
});

test("the budget never goes above three times prepareBudgetMs", () => {
  const { dom, h, v } = setup({}, { prepareBudgetMs: 2 });
  v.mode.jobs.push(fakeJob(dom));
  for (let i = 0; i < 30; i++) dom.flush(200);
  assert.strictEqual(h.info().timing.budgetMs, 6);
  h.destroy();
  const b = setup();
  b.v.mode.jobs.push(fakeJob(b.dom));
  for (let i = 0; i < 30; i++) b.dom.flush(200);
  assert.strictEqual(b.h.info().timing.budgetMs, 24, "the default ceiling");
  b.h.destroy();
});

test("work that overran its budget (script-bound) halves the next frame's budget, once", () => {
  const { dom, h, v } = setup();
  const job = fakeJob(dom, 30); // every step takes 30 ms, far past the 8 ms it is given
  v.mode.jobs.push(job);
  dom.flush();
  assert.strictEqual(job.given.at(-1), 8);
  assert.strictEqual(h.info().timing.workMs, 30);
  dom.flush();
  assert.strictEqual(job.given.at(-1), 4, "halved after the overrun");
  job.cost = 2; // back to short units
  dom.flush();
  assert.strictEqual(job.given.at(-1), 4, "the frame that overran ran at 4 ms; this one follows it");
  dom.frames(3);
  assert.strictEqual(job.given.at(-1), 8, "back to the full budget");
  h.destroy();
});

test("script outside the work (labels, state) does not cut the budget", () => {
  const { dom, h, v } = setup();
  const job = fakeJob(dom);
  v.mode.jobs.push(job);
  const orig = v.mode.inst.stateAt;
  v.mode.inst.stateAt = function () {
    dom.advance(30); // a slow mode step: not the work's own time
    return orig.apply(this, arguments);
  };
  for (let i = 0; i < 10; i++) dom.flush(60);
  assert.ok(h.info().timing.scriptMs >= 30);
  assert.ok(job.given.slice(2).every((b) => b >= 8), "never halved: " + job.given.join(","));
  h.destroy();
});

test("while paused the budget is at least 40 ms", () => {
  const { dom, h, v } = setup();
  h.pause();
  const job = fakeJob(dom);
  v.mode.jobs.push(job);
  dom.frames(3);
  assert.strictEqual(h.info().timing.budgetMs, 40);
  assert.strictEqual(job.given.at(-1), 40);
  h.destroy();
});

test("while hidden no work runs, and a long gap is not taken for a frame interval", () => {
  const { dom, h, v } = setup();
  const job = fakeJob(dom);
  v.mode.jobs.push(job);
  dom.frames(3);
  const steps = job.given.length;
  dom.document.setHidden(true);
  dom.advance(5000);
  assert.strictEqual(dom.frames(10), 0);
  assert.strictEqual(job.given.length, steps, "no step while hidden");
  dom.document.setHidden(false);
  dom.flush(5000);
  dom.flush();
  assert.ok(h.info().timing.intervalMs < 17, "the gap was not measured: " + h.info().timing.intervalMs);
  assert.strictEqual(job.given.at(-1), 8);
  h.destroy();
});

// ---------- spinning while a mode prepares ----------

// Hold the current mode "not ready" until release() is called.
function holdReady(v) {
  const inst = v.mode.inst;
  const orig = inst.isReady;
  let held = true;
  inst.isReady = () => !held && orig.call(inst);
  return () => {
    held = false;
  };
}

function enterHeld(mountOpts, domOpts) {
  const s = setup(domOpts, mountOpts);
  s.h.setMode("lattice");
  s.release = holdReady(s.v);
  s.dom.flush();
  return s;
}

test("the cloud keeps spinning while a mode prepares; the mode clock waits", () => {
  const { dom, h, v, release } = enterHeld();
  const yaw0 = v.lastDraw.yaw;
  dom.frames(60);
  assert.strictEqual(h.info().ready, false);
  assert.strictEqual(h.time(), 0, "mode time starts at ready");
  const spun = v.lastDraw.yaw - yaw0;
  assert.ok(Math.abs(spun - 0.06) < 1e-9, "one second at 0.06 rad/s: " + spun);
  // No jump when the mode becomes ready: the spin goes on from where it was.
  const before = v.lastDraw.yaw;
  release();
  dom.flush();
  assert.strictEqual(h.info().ready, true);
  assert.ok(Math.abs(v.lastDraw.yaw - before - 0.001) < 1e-9, "one frame's turn, no more");
  assert.ok(h.time() > 0);
  h.destroy();
});

test("spinWhilePreparing: false holds the picture still until ready (0.11.6)", () => {
  const { dom, h, v } = enterHeld({ spinWhilePreparing: false });
  const yaw0 = v.lastDraw.yaw;
  dom.frames(60);
  assert.strictEqual(v.lastDraw.yaw, yaw0);
  h.destroy();
});

test("pause and reduced motion stop the spin while preparing", () => {
  const paused = enterHeld();
  paused.h.pause();
  paused.dom.flush();
  const yaw0 = paused.v.lastDraw.yaw;
  paused.dom.frames(30);
  assert.strictEqual(paused.v.lastDraw.yaw, yaw0, "paused");
  paused.h.destroy();
  const reduced = enterHeld({}, { reducedMotion: true });
  const yaw1 = reduced.v.lastDraw.yaw;
  reduced.dom.frames(30);
  assert.strictEqual(reduced.v.lastDraw.yaw, yaw1, "reduced motion starts paused");
  reduced.h.destroy();
});

test("a seek() during preparation holds the spin, so the frame at that time is exact", () => {
  const { dom, h, v, release } = enterHeld();
  h.seek(2);
  dom.flush();
  const yaw = v.lastDraw.yaw;
  dom.frames(30);
  assert.strictEqual(v.lastDraw.yaw, yaw, "held at the seeked spin");
  assert.strictEqual(h.time(), 2);
  release();
  h.pause();
  dom.flush();
  assert.strictEqual(v.lastDraw.yaw, yaw);
  assert.strictEqual(h.time(), 2);
  h.destroy();
});

// ---------- the drawing-buffer ratio ----------

function slowFrames(dom, seconds, ms) {
  for (let i = 0; i < (seconds * 1000) / ms; i++) dom.flush(ms);
}

test("a frame rate under 25 for two seconds lowers the ratio in steps, never below 1", () => {
  const { dom, h, v } = setup({ devicePixelRatio: 3 }, { adaptivePixelRatio: true });
  assert.strictEqual(h.info().pixelRatio, 2, "capped by maxPixelRatio");
  assert.strictEqual(h.info().pixelRatioLowered, false);
  const w2 = v.W;
  slowFrames(dom, 3.5, 100);
  assert.strictEqual(h.info().pixelRatio, 1.5);
  assert.strictEqual(h.info().pixelRatioLowered, true);
  assert.strictEqual(v.W, Math.round(w2 * 0.75), "the drawing buffer follows");
  slowFrames(dom, 10, 100);
  assert.strictEqual(h.info().pixelRatio, 1, "floor");
  h.destroy();
});

test("the ratio stays when the option is off, at 60 fps, while paused and while preparing", () => {
  const off = setup({ devicePixelRatio: 2 }, { adaptivePixelRatio: false });
  slowFrames(off.dom, 5, 100);
  assert.strictEqual(off.h.info().pixelRatio, 2, "option off");
  off.h.destroy();
  const unset = setup({ devicePixelRatio: 2 }, {});
  slowFrames(unset.dom, 5, 100);
  assert.strictEqual(unset.h.info().pixelRatio, 2, "off unless the host asks for it");
  unset.h.destroy();
  const fast = setup({ devicePixelRatio: 2 }, { adaptivePixelRatio: true });
  fast.dom.frames(400);
  assert.strictEqual(fast.h.info().pixelRatio, 2, "60 fps");
  fast.h.destroy();
  const paused = setup({ devicePixelRatio: 2 }, { adaptivePixelRatio: true });
  paused.h.pause();
  slowFrames(paused.dom, 5, 100);
  assert.strictEqual(paused.h.info().pixelRatio, 2, "paused");
  paused.h.destroy();
  const prep = setup({ devicePixelRatio: 2 }, { adaptivePixelRatio: true });
  prep.v.mode.jobs.push(fakeJob(prep.dom));
  slowFrames(prep.dom, 5, 100);
  assert.strictEqual(prep.h.info().pixelRatio, 2, "preparing");
  prep.h.destroy();
});

test("a 30 fps cap (iOS Low Power Mode) does not lower the ratio", () => {
  const { dom, h } = setup({ devicePixelRatio: 2 }, { adaptivePixelRatio: true });
  slowFrames(dom, 6, 1000 / 30);
  assert.strictEqual(h.info().pixelRatio, 2);
  h.destroy();
});
