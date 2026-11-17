"use strict";
// Deviation d8, first part (task t21): the relative view is drawn sharp. By the relative
// mix (0 in the plain view, 1 once the relative view is settled) the draw key depthOfField
// goes from the value it would have had to 0, and bloom from the value it would have had
// toward 0.2, never upward. With the mix at 0 the draw state is exactly what it was: keys
// that were left out stay left out. Binding names: docs/relative-interface.md,
// "Viewer (t9, t10)".
//
// The viewer runs on the fake DOM and GPU of helpers/, loaded from the source modules.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");

const api = loadSources();
const ET = api._internal;
const FIX = path.join(ROOT, "tests", "fixtures", "relative");
const TURN = 1.5; // Tumble's relativeTransition
const LIGHT = { "--tumbler-background": "#ffffff", "--tumbler-foreground": "#102030" };

const cache = {};
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
  let finished = false;
  let out;
  promise.then((r) => {
    out = r;
    finished = true;
  });
  await until(dom, () => finished);
  return out;
}

function setup(mountOpts, hostStyle) {
  const dom = makeFakeDom();
  const el = dom.host();
  for (const [k, val] of Object.entries(hostStyle || {})) el.style.setProperty(k, val);
  const h = api.mount(el, { seed: 3, mode: "tumble", paused: true, searchPanel: false, ...mountOpts });
  const data = fixture("wikipedia-subset");
  h.update(data);
  return { dom, h, v: h._viewer, data };
}

async function ready(t) {
  await until(t.dom, () => t.h.info().ready && !t.h.info().preparing);
}

async function searchRice(t) {
  const r = await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
  assert.strictEqual(r.ok, true, r.message);
}

async function settledRelative(t) {
  await searchRice(t);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.h.seek(t.h.time() + TURN + 0.5);
  t.dom.frames(12);
  assert.strictEqual(t.h.info().search.relative.settled, true, "settled");
  assert.strictEqual(t.v.last.relative.mix, 1, "the mix is exactly 1 once settled");
}

// Mid-turn: the clock runs (with it stopped the view is shown at once, with no turn).
async function midTurn(t) {
  await searchRice(t);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  const T = t.v.mode.inst.describe().relative.switchAt;
  t.h.seek(T + TURN / 2);
  t.dom.frames(12);
  const mix = t.v.last.relative.mix;
  assert.ok(mix > 0.05 && mix < 0.95, "mix " + mix);
  return mix;
}

const close = (a, b) => Math.abs(a - b) < 1e-12;

test("the two targets are named constants of the viewer", () => {
  assert.strictEqual(ET.viewer.RELATIVE_DEPTH_OF_FIELD, 0);
  assert.strictEqual(ET.viewer.RELATIVE_BLOOM, 0.2);
  assert.strictEqual(ET.renderer.DEFAULTS.depthOfField, 1.1);
  assert.strictEqual(ET.renderer.DEFAULTS.bloom, 0.55);
});

for (const [theme, style, plainBloom] of [
  ["dark", null, undefined],
  ["light", LIGHT, 0.3],
]) {
  test(`${theme}: with the mix at 0 depth of field and bloom are what they were (an absent key stays absent)`, async () => {
    // relative off with a search, and relative on with no search: both are the plain view
    for (const relative of [false, true]) {
      const t = setup({ relative }, style);
      await ready(t);
      assert.strictEqual(t.v.theme.light, theme === "light");
      if (!relative) await searchRice(t);
      for (const time of [0.5, 4]) {
        t.h.seek(time);
        t.dom.frames(2);
        const d = t.v.lastDraw;
        assert.strictEqual(d.depthOfField, 1.1, "Tumble's own depth of field");
        if (plainBloom === undefined) assert.ok(!("bloom" in d), "bloom left out: the renderer's default applies");
        else assert.strictEqual(d.bloom, plainBloom);
        assert.ok(!("wireDepthOfField" in d), "the wires' key is never added");
      }
      t.h.destroy();
    }
  });

  test(`${theme}: settled, the relative view has no depth blur and bloom 0.2, exactly`, async () => {
    const t = setup({ relative: true }, style);
    await ready(t);
    await settledRelative(t);
    assert.strictEqual(t.v.lastDraw.depthOfField, 0);
    assert.strictEqual(t.v.lastDraw.bloom, 0.2);
    assert.ok(!("wireDepthOfField" in t.v.lastDraw));
    // Relative off again: back to the plain values once the turn back is over.
    t.h.setRelative({ relative: false });
    t.dom.frames(2);
    t.h.seek(t.h.time() + TURN + 0.5);
    t.dom.frames(12);
    assert.strictEqual(t.v.lastDraw.depthOfField, 1.1);
    if (plainBloom === undefined) assert.ok(!("bloom" in t.v.lastDraw));
    else assert.strictEqual(t.v.lastDraw.bloom, plainBloom);
    t.h.destroy();
  });

  test(`${theme}: mid-turn both are blended by the mix, strictly between the two ends`, async () => {
    const t = setup({ relative: true, paused: false }, style);
    await ready(t);
    const mix = await midTurn(t);
    const from = plainBloom === undefined ? 0.55 : plainBloom;
    const d = t.v.lastDraw;
    assert.ok(close(d.depthOfField, 1.1 * (1 - mix)), "depth of field " + d.depthOfField + " at mix " + mix);
    assert.ok(close(d.bloom, from + (0.2 - from) * mix), "bloom " + d.bloom + " at mix " + mix);
    assert.ok(d.depthOfField > 0 && d.depthOfField < 1.1);
    assert.ok(d.bloom > 0.2 && d.bloom < from);
    t.h.destroy();
  });
}

test("bloom is never raised: a view whose bloom is already below 0.2 keeps it, and depth of field still goes to 0", async () => {
  const t = setup({ relative: true });
  await ready(t);
  // A mode that asks for less bloom than the relative view's (none does today).
  const inst = t.v.mode.inst;
  const real = inst.stateAt;
  inst.stateAt = function (time) {
    const s = real.call(this, time);
    s.draw.bloom = 0.1;
    s.draw.depthOfField = 0.6;
    return s;
  };
  await settledRelative(t);
  assert.strictEqual(t.v.lastDraw.bloom, 0.1);
  assert.strictEqual(t.v.lastDraw.depthOfField, 0);
  t.h.destroy();
});

test("another view draws with its own depth of field and bloom while Relative is on", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await settledRelative(t);
  assert.strictEqual(t.h.setMode("wander"), true);
  await until(t.dom, () => t.h.info().ready && !t.h.info().preparing);
  t.h.seek(t.h.time() + 6);
  t.dom.frames(6);
  assert.ok(t.v.lastDraw.depthOfField > 0, "Wander's depth of field: " + t.v.lastDraw.depthOfField);
  assert.ok(!("bloom" in t.v.lastDraw), "bloom left out");
  t.h.destroy();
});
