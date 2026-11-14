"use strict";
// How search looks, corrected after the owner's browser look (2026-11-14); see
// docs/search-interface.md. The renderer's wires follow the search, a lit point's fog is
// relieved, crowded wires are scaled down (wireLoad, wireDensity); Focus spins at the
// reference's speed and the viewer honours a mode's spin; Focus draws no group names while a
// search is shown. The GPU and DOM are the fakes in helpers/; the pictures are checked in
// tests/browser/test_renderer_render.py and tests/browser/test_search_look.py. Everything
// runs through the assembled file, so these lines count towards coverage.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeCanvas } = require("./helpers/fake-gl.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const ET = api._internal;
const R = ET.renderer;
const GL = makeFakeCanvas().gl;
const D = 8;

function data(n, d) {
  let s = 11;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const v = new Float32Array(n * d);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  return { vectors: v, dimension: d, colours: new Float32Array(n * 3).fill(0.8) };
}

function frameFor(d, scale) {
  const k = scale || 1;
  const f = new Float32Array(3 * d);
  f[0] = k;
  f[d + 1] = k;
  f[2 * d + 2] = k;
  return f;
}

function withData(n) {
  const { canvas, state } = makeFakeCanvas();
  const made = R.create(canvas);
  assert.strictEqual(made.ok, true, made.message);
  assert.strictEqual(made.renderer.setData(data(n, D)).ok, true);
  return { r: made.renderer, state };
}

function callsSince(state, from) {
  return state.calls.slice(from).map((c) =>
    c.map((a) => {
      if (a && typeof a === "object" && "kind" in a && "id" in a) return "<" + a.kind + ">";
      if (a && typeof a === "object" && "program" in a && "name" in a) return "<uniform " + a.name + ">";
      if (ArrayBuffer.isView(a)) return "<" + a.constructor.name + " " + a.length + ">";
      return a;
    }),
  );
}

// The vertex array bound at the last LINES draw, and the uniform1f calls since `from`.
function lastLineDraw(state) {
  let vao = null;
  let at = -1;
  for (let i = 0; i < state.calls.length; i++) {
    const c = state.calls[i];
    if (c[0] === "bindVertexArray") vao = c[1];
    if (c[0] === "drawArrays" && c[1] === GL.LINES) at = i;
  }
  let bound = null;
  for (let i = 0; i < at; i++) if (state.calls[i][0] === "bindVertexArray") bound = state.calls[i][1];
  return { at, vao: bound, last: vao };
}

function uniformValues(state, from, name) {
  return state.calls
    .slice(from)
    .filter((c) => c[0] === "uniform1f" && c[1]?.name === name)
    .map((c) => c[2]);
}

// The data of the last bufferData call whose array has `length` floats.
function lastBufferOf(state, length) {
  const found = state.calls.filter((c) => c[0] === "bufferData" && ArrayBuffer.isView(c[2]) && c[2].length === length);
  return found.length ? Array.from(found.at(-1)[2]) : null;
}

const PAIRS = new Uint32Array([0, 1, 1, 2, 3, 4]);

// ---------- the wire shader ----------

test("the no-search wire shader never reads a lit value; the lit one only adds the search terms", () => {
  const src = R.shaderSources(R.layout(D, 10, 4096));
  for (const word of ["aWireLit", "uFilter", "uUnlit"]) assert.ok(!src.lineVertex.includes(word), word);
  const lit = src.lineVertexLit;
  assert.match(lit, /layout\(location = 3\) in float aWireLit;/);
  const stripped = lit
    .split("\n")
    .filter((l) => l !== "uniform float uFilter, uUnlit;" && l !== "layout(location = 3) in float aWireLit;")
    .join("\n")
    .replace(" * mix(1.0, mix(uUnlit, 1.0, aWireLit), uFilter)", "");
  assert.strictEqual(stripped, src.lineVertex);
});

// ---------- wires follow the search ----------

test("with wires and lit values but filter 0, the frame is drawn with exactly the calls of a never-lit renderer", () => {
  const a = withData(6);
  const b = withData(6);
  a.r.setWires(PAIRS);
  b.r.setWires(PAIRS);
  b.r.setLit(new Float32Array([1, 1, 0, 0.5, 0, 0]), new Uint8Array([1, 0, 0, 0, 0, 0]));
  const base = { frame: frameFor(D), wires: 1 };
  for (const st of [base, { ...base, filter: 0, unlitGain: 0.3 }]) {
    const fa = a.state.calls.length;
    const fb = b.state.calls.length;
    a.r.draw(st);
    b.r.draw(st);
    assert.deepStrictEqual(callsSince(b.state, fb), callsSince(a.state, fa));
  }
  assert.strictEqual(a.r.status().wireScale, 1);
});

test("with filter above 0 the wires are drawn by the lit wire program with each wire's lit value", () => {
  const { r, state } = withData(7);
  r.setWires(PAIRS);
  r.setLit(new Float32Array([1, 0.6, 0, 0.5, 0.25, 0, 0]), new Uint8Array([1, 1, 0, 0, 0, 0, 0]));
  // one float per wire end: the smaller of the two ends' lit values, the mark removed
  const got = lastBufferOf(state, 6);
  const want = [0.6, 0.6, 0, 0, 0.25, 0.25];
  for (const [i, x] of want.entries()) assert.ok(Math.abs(got[i] - x) < 1e-6, String(got));
  const from = state.calls.length;
  r.draw({ frame: frameFor(D), wires: 1, filter: 0.5, unlitGain: 0.1 });
  assert.notStrictEqual(lastLineDraw(state).vao, null);
  assert.deepStrictEqual(uniformValues(state, from, "uFilter"), [0.5, 0.5], "the wire and point programs");
  assert.deepStrictEqual(uniformValues(state, from, "uUnlit"), [0.1, 0.1]);
});

test("the wires' lit values follow setWires, setLit(null) and a context restore", () => {
  const { r, state } = withData(7);
  r.setLit(new Float32Array([1, 1, 1, 0, 0, 0, 0]));
  assert.strictEqual(lastBufferOf(state, 6), null, "no wires: no wire lit buffer");
  r.setWires(PAIRS);
  assert.deepStrictEqual(lastBufferOf(state, 6), [1, 1, 1, 1, 0, 0]);
  r.setWires(new Uint32Array([2, 3]));
  assert.deepStrictEqual(lastBufferOf(state, 2), [0, 0]);
  const deletes = state.calls.filter((c) => c[0] === "deleteVertexArray").length;
  r.setLit(null);
  assert.ok(state.calls.filter((c) => c[0] === "deleteVertexArray").length >= deletes + 2, "both lit vertex arrays freed");
  const from = state.calls.length;
  r.draw({ frame: frameFor(D), wires: 1, filter: 1 });
  assert.deepStrictEqual(uniformValues(state, from, "uFilter"), [], "no lit values: nothing lit is drawn");
  r.setLit(new Float32Array([0, 0, 1, 1, 0, 0, 0]));
  assert.deepStrictEqual(lastBufferOf(state, 2), [1, 1]);
  r.appendData({ vectors: data(20, D).vectors, colours: new Float32Array(60).fill(0.5) }); // reallocates
  assert.deepStrictEqual(lastBufferOf(state, 2), [1, 1], "made again with the points");
});

// ---------- crowded wires ----------

test("wireLoad is off by default; when on, crowded wires are scaled down", () => {
  assert.strictEqual(R.DEFAULTS.wireLoad, 0);
  const { r, state } = withData(40);
  const pairs = new Uint32Array(400);
  for (let e = 0; e < 200; e++) {
    pairs[2 * e] = e % 40;
    pairs[2 * e + 1] = (e * 7 + 3) % 40;
  }
  r.setWires(pairs);
  const st = { frame: frameFor(D), wires: 1, wireGain: 1.5, trails: 0 };
  let from = state.calls.length;
  r.draw(st);
  const plainGain = uniformValues(state, from, "uGain")[0];
  assert.strictEqual(r.status().wireScale, 1);
  from = state.calls.length;
  r.draw({ ...st, wireLoad: 1e-3 });
  const scaled = r.status().wireScale;
  assert.ok(scaled > 0 && scaled < 1, scaled);
  assert.ok(Math.abs(uniformValues(state, from, "uGain")[0] - plainGain * scaled) < 1e-9 * plainGain);
  r.draw({ ...st, wireLoad: 1e9 });
  assert.strictEqual(r.status().wireScale, 1, "below the load nothing changes");
});

test("wireDensity grows with the number of wires and with how tightly the frame packs them", () => {
  const set = data(30, D);
  const pairs = new Uint32Array(120);
  for (let e = 0; e < 60; e++) {
    pairs[2 * e] = e % 30;
    pairs[2 * e + 1] = (e * 11 + 5) % 30;
  }
  const lengths = new Float32Array(60).fill(1);
  const src = (count) => ({ vectors: set.vectors, stride: D, dimension: D, pairs, lengths, count });
  const view = (scale) => ({ ...R.DEFAULTS, frame: frameFor(D, scale), centre: null, width: 400, height: 300 });
  assert.strictEqual(R.wireDensity(src(0), view(1)), 0);
  const few = R.wireDensity(src(20), view(1));
  const many = R.wireDensity(src(60), view(1));
  assert.ok(few > 0 && many > few, [few, many]);
  // packing the same wires into a smaller part of the stage, at the same shown lengths
  // (lengths scaled with the frame so the brightness term stays the same)
  const packedSrc = { ...src(60), lengths: new Float32Array(60).fill(0.25) };
  assert.ok(R.wireDensity(packedSrc, view(0.25)) > many, "packed tighter, denser");
  // wires entirely off the stage add nothing
  const off = { ...view(1), zoom: 1, width: 400, height: 300, centre: new Float32Array(D).fill(50) };
  assert.strictEqual(R.wireDensity(src(60), off), 0);
});

// ---------- Focus ----------

test("Focus asks for the reference's spin while a usable search is shown; the other modes never ask", () => {
  const set = { ...data(60, D), count: 60 };
  const inst = ET.modes.create("focus");
  inst.enter(set, { seed: 1 });
  assert.strictEqual(inst.spin, undefined, "no search: the viewer's own spin, frames as before");
  const query = set.vectors.slice(0, D);
  inst.searchChanged({ searches: [{ letter: "A", query, indices: Int32Array.from([0, 1, 2]) }] }, 0);
  assert.strictEqual(inst.spin, 0.13);
  inst.searchChanged({ searches: [{ letter: "A", query: new Float32Array(D + 1), indices: [] }] }, 0);
  assert.strictEqual(inst.spin, undefined, "a query of another dimension is not usable");
  inst.searchChanged({ searches: [{ letter: "A", query, indices: [] }] }, 0);
  inst.enter(set, { seed: 1 });
  assert.strictEqual(inst.spin, 0.13, "kept across a new entry");
  inst.searchChanged(null, 0);
  assert.strictEqual(inst.spin, undefined);
  for (const id of ["tumble", "lattice", "wander"]) assert.strictEqual(ET.modes.create(id).spin, undefined, id);
});

// ---------- the viewer ----------

function mounted(mode) {
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { seed: 3, mode });
  h.update(makeSet({ n: 90, d: 16 }));
  const draws = [];
  const v = h._viewer;
  const realDraw = v.renderer.draw;
  v.renderer.draw = function (state) {
    draws.push(state);
    return realDraw.apply(this, arguments);
  };
  return { dom, h, v, draws };
}

function readyFrames(m, n) {
  for (let i = 0; i < 400 && !m.h.info().ready; i++) m.dom.frames(1);
  assert.ok(m.h.info().ready, "the mode became ready");
  m.dom.frames(n);
}

test("the viewer turns a mode at its own spin, continuously, and seek takes it into account", async () => {
  const m = mounted("tumble");
  readyFrames(m, 2);
  let s0 = m.v.spin;
  m.dom.frames(30);
  const tumbleRate = m.v.spin - s0;
  assert.ok(tumbleRate > 0);
  m.h.setMode("focus");
  readyFrames(m, 2);
  s0 = m.v.spin;
  m.dom.frames(30);
  assert.ok(Math.abs(m.v.spin - s0 - tumbleRate) < 1e-9, "Focus with no search turns as before");
  const p = m.h.setSearches([{ vector: Array.from(m.v.set.vectors.subarray(0, 16)), model: "test/model" }]);
  for (let i = 0; i < 300 && m.v.mode.inst.spin === undefined; i++) {
    m.dom.frames(1);
    await new Promise((r) => setImmediate(r));
  }
  await p;
  s0 = m.v.spin;
  m.dom.frames(30);
  const focusRate = m.v.spin - s0;
  assert.ok(Math.abs(focusRate / tumbleRate - 0.13 / 0.06) < 1e-6, [focusRate, tumbleRate]);
  m.h.seek(3);
  assert.ok(Math.abs(m.v.spin - (3 * 0.13) / 0.06) < 1e-9);
  // a mode with a spin that is not a usable number turns at the viewer's own
  m.v.mode.inst.spin = Number.NaN;
  m.h.seek(3);
  assert.strictEqual(m.v.spin, 3);
  m.h.destroy();
});

test("wireLoad reaches the renderer only when wires are shown", async () => {
  const m = mounted("tumble");
  readyFrames(m, 3);
  assert.ok(m.draws.length > 0);
  for (const d of m.draws) assert.ok(!("wireLoad" in d), "no wires: the draw state is as before");
  m.h.setMode("lattice");
  for (let i = 0; i < 600 && !m.draws.some((d) => d.wires > 0); i++) {
    m.dom.frames(1);
    await new Promise((r) => setImmediate(r));
  }
  const withWires = m.draws.filter((d) => d.wires > 0);
  assert.ok(withWires.length > 0, "the lattice showed its wires");
  for (const d of withWires) assert.strictEqual(d.wireLoad, 8);
  m.h.destroy();
});

test("Focus draws no group names while a search is shown; Tumble does", async () => {
  const m = mounted("focus");
  readyFrames(m, 3);
  const groupNames = () => m.v.labelPool.filter((r) => r.shown && r.key.startsWith("group|")).length;
  assert.ok(groupNames() > 0, "control: Focus with no search draws group names");
  const p = m.h.setSearches([{ vector: Array.from(m.v.set.vectors.subarray(0, 16)), model: "test/model" }]);
  for (let i = 0; i < 300 && m.v.search.filter < 1; i++) {
    m.dom.frames(1);
    await new Promise((r) => setImmediate(r));
  }
  await p;
  m.dom.frames(2);
  assert.ok(m.v.search.filter > 0, "the search is shown");
  assert.strictEqual(groupNames(), 0);
  m.h.setMode("tumble");
  readyFrames(m, 3);
  assert.ok(groupNames() > 0, "control: Tumble with the same search draws them");
  m.h.destroy();
});
