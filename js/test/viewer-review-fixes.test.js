"use strict";
// Viewer fixes from the code review of the embeddable viewer: trails survive an
// append, brightness agrees with the weights on the GPU, untrusted group names,
// a refused replace, and the two width breakpoints.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();

function setup(domOpts, mountOpts, rect) {
  const dom = makeFakeDom(domOpts);
  const el = dom.host(rect);
  const h = api.mount(el, Object.assign({ seed: 3 }, mountOpts || {}));
  return { dom, el, h, v: h._viewer };
}

// ---------- trails: only a real theme change clears them ----------

test("an append does not clear the trails, reset label styles or re-colour the set", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 120, d: 8 }));
  dom.frames(30);
  assert.strictEqual(v.needClear, false);
  assert.ok(v.labelPool.length > 0, "labels were drawn");
  v.labelPool.forEach((rec, i) => (rec.key = "kept" + i));
  let uploads = 0;
  const orig = v.renderer.setData;
  v.renderer.setData = function () {
    uploads++;
    return orig.apply(this, arguments);
  };
  assert.strictEqual(h.update(makeSet({ n: 10, d: 8, op: "append", idPrefix: "q" })).ok, true);
  assert.strictEqual(v.needClear, false, "the append asked for no clear");
  assert.ok(v.labelPool.every((rec, i) => rec.key === "kept" + i), "label styles kept");
  dom.frames(1);
  assert.strictEqual(v.lastDraw.clear, false, "the next frame keeps the trails");
  // a refused update changes nothing either
  assert.strictEqual(h.update(makeSet({ n: 5, d: 9, op: "append", idPrefix: "r" })).ok, false);
  assert.strictEqual(v.needClear, false, "a refusal asked for no clear");
  assert.strictEqual(uploads, 0, "no full re-upload");
  h.destroy();
});

test("a host theme change seen by update still clears the trails and re-styles", () => {
  const { dom, el, h, v } = setup();
  h.update(makeSet({ n: 60, d: 8 }));
  dom.frames(10);
  assert.strictEqual(v.needClear, false);
  el.style.setProperty("--tumbler-accent", "rgb(200, 10, 20)");
  h.update(makeSet({ n: 5, d: 8, op: "append", idPrefix: "q" }));
  assert.strictEqual(v.status.style.color, "rgb(200, 10, 20)");
  assert.strictEqual(v.needClear, true, "a theme change clears");
  dom.frames(1);
  assert.strictEqual(v.needClear, false);
  h.refreshTheme(); // nothing changed since
  assert.strictEqual(v.needClear, false, "refreshTheme with an unchanged theme keeps the trails");
  el.style.setProperty("--tumbler-accent", "rgb(10, 200, 20)");
  h.refreshTheme();
  assert.strictEqual(v.needClear, true);
  h.destroy();
});

// ---------- brightness agrees with the uploaded weights ----------

function gainOf(v) {
  return v.lastDraw.gain === undefined ? 1 : v.lastDraw.gain;
}

test("the first labelled point arriving by append does not make the set brighter", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 5000, d: 8, labelFor: (i, id) => id }));
  dom.frames(3);
  const before = gainOf(v);
  assert.ok(Math.abs(before - 600 / (0.7 * 5000)) < 1e-9, `gain ${before}`);
  h.update(makeSet({ n: 1, d: 8, op: "append", idPrefix: "q", labelFor: () => "a real label" }));
  dom.frames(1);
  const after = gainOf(v);
  // the 5,000 points uploaded at weight 0.7 are still at 0.7 on the GPU
  assert.ok(Math.abs(after - 600 / (0.7 * 5000 + 1)) < 1e-9, `gain ${after}`);
  // ...and more unlabelled points appended later are dim ones: no change
  h.update(makeSet({ n: 50, d: 8, op: "append", idPrefix: "z", labelFor: (i, id) => id }));
  dom.frames(1);
  assert.ok(Math.abs(gainOf(v) - after) < 1e-9, `gain ${gainOf(v)}`);
  h.destroy();
});

test("a failed append rolls the brightness back with the rest", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 3000, d: 8, labelEvery: 1 }));
  dom.frames(3);
  const before = gainOf(v);
  v.renderer.appendData = () => ({ ok: false, reason: "too-many-points", message: "full" });
  const r = h.update(makeSet({ n: 900, d: 8, op: "append", idPrefix: "q", labelEvery: 1 }));
  assert.strictEqual(r.ok, false);
  dom.frames(1);
  assert.strictEqual(gainOf(v), before);
  h.destroy();
});

test("the built-in rule is unchanged for fully labelled and unlabelled sets", () => {
  for (const [opts, n] of [
    [{ n: 4800, d: 8, labelEvery: 1 }, 4800],
    [{ n: 4800, d: 8, labelFor: (i, id) => id }, 0.7 * 4800],
    [{ n: 3000, d: 8, labelEvery: 10 }, 300],
  ]) {
    const { dom, h, v } = setup();
    h.update(makeSet(opts));
    dom.frames(2);
    const want = n > 600 ? 600 / n : 1;
    assert.ok(Math.abs(gainOf(v) - want) < 1e-9, `gain ${gainOf(v)} want ${want}`);
    h.destroy();
  }
});

// ---------- untrusted group names ----------

test("group names that an ordinary object treats specially each get one colour", () => {
  const names = ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"];
  const { dom, h, v } = setup();
  const r = h.update(makeSet({ n: 50, d: 8, groups: names, labelEvery: 1 }));
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(Array.from(v.groupNames), names);
  h.update(makeSet({ n: 25, d: 8, groups: names, labelEvery: 1, op: "append", idPrefix: "q" }));
  assert.deepStrictEqual(Array.from(v.groupNames), names, "no new colour per point");
  assert.strictEqual(Object.getPrototypeOf({}).polluted, undefined);
  dom.frames(5);
  h.destroy();
});

// ---------- a replace the GPU refuses changes nothing ----------

test("a replace the renderer refuses leaves the view exactly as it was", () => {
  const { dom, h, v } = setup();
  const A = makeSet({ n: 80, d: 8, model: "model/a" });
  h.update(A);
  dom.frames(20);
  const modeBefore = v.modeId;
  const provBefore = v.provenance.textContent;
  const r0 = v.renderer;
  const orig = r0.setData;
  let refused = 0;
  r0.setData = function (input) {
    if (input.dimension === 12 && !refused) {
      refused++;
      return { ok: false, reason: "too-many-points", message: "800 points of dimension 12 do not fit this GPU's textures (at most 10)." };
    }
    return orig.apply(this, arguments);
  };
  let errors = 0;
  v.options.onError = () => errors++;
  const res = h.update(makeSet({ n: 800, d: 12, model: "model/b", idPrefix: "b" }));
  assert.deepStrictEqual(res, { ok: false, code: "too-many-points", message: "800 points of dimension 12 do not fit this GPU's textures (at most 10)." });
  assert.strictEqual(errors, 1);
  assert.strictEqual(v.set.model, "model/a");
  assert.strictEqual(v.set.count, 80);
  assert.strictEqual(v.provenance.textContent, provBefore);
  assert.strictEqual(v.modeId, modeBefore);
  assert.strictEqual(r0.status().dimension, 8);
  assert.strictEqual(r0.status().count, 80);
  assert.notStrictEqual(v.fatalKind, "gpu", "no message over the stage: the old view keeps running");
  assert.match(v.notice.textContent, /do not fit/);
  dom.frames(10);
  assert.strictEqual(v.lastDraw.frame.length, 3 * 8, "drawing continues with the old set");
  assert.strictEqual(h.info().count, 80);
  h.destroy();
});

test("a first replace the renderer refuses leaves the viewer empty with the message", () => {
  const { dom, h, v } = setup();
  const orig = v.renderer.setData;
  v.renderer.setData = function (input) {
    if (input.dimension === 12) return { ok: false, reason: "dimension-too-large", message: "too wide" };
    return orig.apply(this, arguments);
  };
  const res = h.update(makeSet({ n: 20, d: 12 }));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, "dimension-too-large");
  assert.strictEqual(v.set, null);
  assert.match(v.fatal.textContent, /too wide/);
  dom.frames(3);
  assert.strictEqual(h.update(makeSet({ n: 20, d: 8 })).ok, true, "a set it can draw still works");
  h.destroy();
});

// ---------- the two width breakpoints are evaluated on their own ----------

test("the provenance grid follows its own 520 px breakpoint, inside the narrow range too", () => {
  const a = setup(undefined, undefined, { width: 560 });
  assert.match(a.v.provList.style.gridTemplateColumns, /max-content/, "560 px: two columns");
  a.el.rect.width = 360;
  a.dom.ro[0].trigger();
  assert.strictEqual(a.v.provList.style.gridTemplateColumns, "minmax(0, 1fr)", "360 px: one column");
  a.h.destroy();

  const b = setup(undefined, undefined, { width: 400 });
  assert.strictEqual(b.v.provList.style.gridTemplateColumns, "minmax(0, 1fr)", "400 px: one column");
  b.el.rect.width = 590;
  b.dom.ro[0].trigger();
  assert.match(b.v.provList.style.gridTemplateColumns, /max-content/, "590 px: two columns");
  assert.strictEqual(b.v.modeButtons[0].summary.style.display, "none", "still narrow");
  b.h.destroy();
});
