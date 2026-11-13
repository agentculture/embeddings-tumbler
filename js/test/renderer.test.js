"use strict";
// Unit tests for js/src/30-renderer.js (ET.renderer). The GPU is a fake
// (helpers/fake-gl.js); the real drawing is checked by the headless-browser
// test in tests/browser/test_renderer_render.py.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, SRC_DIR } = require("./helpers/load.js");
const { makeFakeCanvas } = require("./helpers/fake-gl.js");

function R() {
  return loadSources(["30-renderer.js"])._internal.renderer;
}

function data(n, d, seed) {
  let s = seed || 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const v = new Float32Array(n * d);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  const colours = new Float32Array(n * 3).fill(0.8);
  return { vectors: v, dimension: d, colours };
}

function frameFor(d) {
  const f = new Float32Array(3 * d);
  f[0] = 1;
  f[d + 1] = 1;
  f[2 * d + 2] = 1;
  return f;
}

function created(renderer) {
  const { canvas, state } = makeFakeCanvas();
  const res = renderer.create(canvas);
  assert.strictEqual(res.ok, true, res.message);
  return { r: res.renderer, canvas, state };
}

// ---------- criterion 1: dimension comes from the data ----------

test("source file carries no literal for the reference's fixed dimension or texel count", () => {
  const src = fs.readFileSync(path.join(SRC_DIR, "30-renderer.js"), "utf8");
  assert.doesNotMatch(src, /\b384\b/);
  assert.doesNotMatch(src, /\b96\b/);
});

test("layout packs four dimensions per texel, ceil(D / 4) texels per point", () => {
  const r = R();
  for (const [d, t] of [
    [1, 1],
    [4, 1],
    [5, 2],
    [16, 4],
    [384, 96],
    [768, 192],
    [1024, 256],
    [2560, 640],
  ]) {
    const lay = r.layout(d, 1000, 16384);
    assert.strictEqual(lay.ok, true, lay.message);
    assert.strictEqual(lay.texelsPerPoint, t, "D=" + d);
    assert.strictEqual(lay.floatsPerPoint, t * 4);
    assert.ok(lay.pointsPerRow >= 1);
    assert.strictEqual(lay.width, lay.pointsPerRow * t);
    assert.ok(lay.width <= 16384);
    assert.strictEqual(lay.maxPoints, lay.pointsPerRow * 16384);
    assert.ok(lay.rows(1000) * lay.pointsPerRow >= 1000);
  }
});

test("layout refuses a dimension wider than the texture limit allows, with a message", () => {
  const r = R();
  const lay = r.layout(4 * 2048 + 1, 10, 2048);
  assert.strictEqual(lay.ok, false);
  assert.strictEqual(lay.reason, "dimension-too-large");
  assert.match(lay.message, /2048/);
});

test("layout widens rows before refusing, and refuses more points than fit", () => {
  const r = R();
  const small = r.layout(1024, 10, 16384);
  const big = r.layout(1024, small.maxPoints + 1, 16384);
  assert.strictEqual(big.ok, true);
  assert.ok(big.pointsPerRow > small.pointsPerRow);
  const tooMany = r.layout(1024, (16384 / 256) * 16384 + 1, 16384);
  assert.strictEqual(tooMany.ok, false);
  assert.strictEqual(tooMany.reason, "too-many-points");
});

test("shader loop bounds are generated from the dimension", () => {
  const r = R();
  for (const d of [3, 384, 768, 1024, 2560]) {
    const lay = r.layout(d, 100, 16384);
    const src = r.shaderSources(lay);
    const t = Math.ceil(d / 4);
    for (const key of ["pointVertex", "lineVertex"]) {
      assert.match(src[key], new RegExp("const int TEXELS = " + t + ";"), key + " D=" + d);
      assert.match(src[key], /k < TEXELS/);
      assert.match(src[key], new RegExp("const int PER_ROW = " + lay.pointsPerRow + ";"));
    }
    if (d !== 384) {
      const all = Object.values(src).join("\n");
      assert.doesNotMatch(all, /\b384\b/, "D=" + d);
      assert.doesNotMatch(all, /\b96\b/, "D=" + d);
    }
  }
});

test("the wire brightness scale follows sqrt(D / 3)", () => {
  const r = R();
  const src = r.shaderSources(r.layout(1024, 10, 16384));
  assert.ok(src.lineVertex.includes(Math.sqrt(1024 / 3).toFixed(4)));
});

test("the point texture is sized from the data, and the frame texture is ceil(D / 4) wide", () => {
  const { r, state } = created(R());
  const res = r.setData(data(10, 1024));
  assert.strictEqual(res.ok, true);
  const sizes = state.texImages.map((t) => t.width + "x" + t.height);
  assert.ok(sizes.includes("256x4"), sizes.join(","));
  assert.ok(sizes.includes(res.layout.width + "x1"), sizes.join(","));
});

// ---------- criterion 3: dispose and context loss ----------

test("dispose deletes every texture, buffer, program, shader, framebuffer and vertex array", () => {
  const { r, canvas, state } = created(R());
  r.setData(data(20, 384));
  r.setWires(new Uint32Array([0, 1, 1, 2, 3, 4]));
  r.resize(64, 48);
  r.draw({ frame: frameFor(384), dt: 0.016, time: 1, trails: 0.17, wires: 1 });
  r.draw({ frame: frameFor(384), dt: 0.016, time: 1.016, trails: 0.17, wires: 1 });
  r.appendData(data(50, 384, 9));
  const kinds = new Set(state.created.map((o) => o.kind));
  for (const k of ["texture", "buffer", "program", "framebuffer", "vertexArray"]) {
    assert.ok(kinds.has(k), "renderer should have created a " + k);
  }
  r.dispose();
  assert.strictEqual(state.live.size, 0, [...state.live].map((o) => o.kind).join(","));
  assert.strictEqual(canvas.listenerCount(), 0, "context listeners removed");
  assert.strictEqual(r.draw({ frame: frameFor(384) }), false, "draw after dispose is a no-op");
  r.dispose(); // twice is harmless
});

test("a failed construction releases what it had created and reports instead of throwing", () => {
  const { canvas, state } = makeFakeCanvas({ failCompile: true });
  const res = R().create(canvas);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "shader-failed");
  assert.match(res.message, /fake compile error/);
  assert.strictEqual(state.live.size, 0);
});

test("context loss stops drawing; restore rebuilds every resource from the kept data", () => {
  const events = [];
  const { canvas, state, gl } = makeFakeCanvas();
  const res = R().create(canvas, { onContextChange: (e) => events.push(e.type) });
  const r = res.renderer;
  r.setData(data(30, 1024));
  r.setWires(new Uint32Array([0, 1, 2, 3]));
  r.draw({ frame: frameFor(1024) });
  const before = state.live.size;
  const ext = gl.getExtension("WEBGL_lose_context");
  ext.loseContext();
  assert.deepStrictEqual(events, ["lost"]);
  assert.strictEqual(r.status().lost, true);
  assert.strictEqual(r.draw({ frame: frameFor(1024) }), false);
  ext.restoreContext();
  assert.deepStrictEqual(events, ["lost", "restored"]);
  assert.strictEqual(r.status().lost, false);
  assert.strictEqual(r.status().count, 30);
  assert.strictEqual(r.status().wires, 2);
  assert.strictEqual(r.draw({ frame: frameFor(1024) }), true);
  assert.strictEqual(state.live.size, before, "same resource set rebuilt");
  r.dispose();
  assert.strictEqual(state.live.size, 0);
});

test("the context-lost event is cancelled so the browser will restore it", () => {
  const { canvas } = makeFakeCanvas();
  R().create(canvas);
  assert.strictEqual(canvas.dispatch("webglcontextlost"), true);
});

test("a failed rebuild after restore is reported, not thrown", () => {
  const events = [];
  const { canvas, state, gl } = makeFakeCanvas();
  const r = R().create(canvas, { onContextChange: (e) => events.push(e) }).renderer;
  r.setData(data(5, 16));
  const ext = gl.getExtension("WEBGL_lose_context");
  ext.loseContext();
  state.opts.failCompile = true;
  ext.restoreContext();
  assert.strictEqual(events[1].type, "restore-failed");
  assert.match(events[1].message, /fake compile error/);
  assert.strictEqual(r.status().ok, false);
  assert.strictEqual(r.draw({ frame: frameFor(16) }), false);
  r.dispose();
  assert.strictEqual(state.live.size, 0);
});

// ---------- criterion 4: no WebGL 2 ----------

test("without WebGL 2 create() reports unavailability instead of throwing", () => {
  const r = R();
  const { canvas } = makeFakeCanvas({}, { noWebGL2: true });
  const res = r.create(canvas);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "webgl2-unavailable");
  assert.strictEqual(typeof res.message, "string");
  const { canvas: c2 } = makeFakeCanvas({}, { throwOnGetContext: true });
  assert.strictEqual(r.create(c2).reason, "webgl2-unavailable");
  assert.strictEqual(r.create(null).reason, "webgl2-unavailable");
  assert.strictEqual(r.create({}).reason, "webgl2-unavailable");
});

test("without float colour buffers the renderer falls back to direct drawing", () => {
  const { canvas } = makeFakeCanvas({ colorBufferFloat: false });
  const res = R().create(canvas);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.renderer.status().hdr, false);
  res.renderer.setData(data(4, 8));
  assert.strictEqual(res.renderer.draw({ frame: frameFor(8), trails: 0.2 }), true);
});

test("hdr can be switched off by option", () => {
  const { canvas } = makeFakeCanvas();
  assert.strictEqual(R().create(canvas, { hdr: false }).renderer.status().hdr, false);
});

// ---------- data, append, wires, draw ----------

test("setData validates shapes and reports dimension and count", () => {
  const { r } = created(R());
  assert.throws(() => r.setData({ vectors: new Float32Array(10), dimension: 3 }), { name: "TypeError" });
  assert.throws(() => r.setData({ vectors: [1, 2, 3], dimension: 3 }), { name: "TypeError" });
  assert.throws(
    () => r.setData({ vectors: new Float32Array(6), dimension: 3, colours: new Float32Array(3) }),
    { name: "TypeError" }
  );
  const res = r.setData({ vectors: new Float32Array(6), dimension: 3 });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(r.status().count, 2);
  assert.strictEqual(r.status().dimension, 3);
});

test("setData refuses more points than the texture limit allows, with a message", () => {
  const { canvas } = makeFakeCanvas({ maxTextureSize: 16 });
  const r = R().create(canvas).renderer;
  const res = r.setData({ vectors: new Float32Array(64 * 16 * 17), dimension: 64 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "too-many-points");
});

test("appendData adds points in place while capacity lasts, and grows when it runs out", () => {
  const { r, state } = created(R());
  r.setData(data(8, 1024));
  r.setWires(new Uint32Array([0, 1]));
  const t0 = state.texImages.length;
  let res = r.appendData(data(4, 1024, 3));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(r.status().count, 12);
  assert.strictEqual(r.status().wires, 1, "append keeps wires");
  const grew = res.reallocated;
  // a second small append fits in the doubled capacity
  res = r.appendData(data(1, 1024, 4));
  assert.strictEqual(res.reallocated, false);
  assert.strictEqual(r.status().count, 13);
  assert.ok(grew === true || state.texImages.length === t0);
  assert.throws(() => r.appendData(data(2, 512)), { name: "TypeError" }, "dimension must match");
});

test("appendData before any setData is refused", () => {
  const { r } = created(R());
  assert.throws(() => r.appendData(data(2, 16)), { name: "TypeError" });
});

test("setWires checks indices; wire lengths are measured when not given", () => {
  const { r } = created(R());
  r.setData(data(3, 5));
  assert.throws(() => r.setWires(new Uint32Array([0, 3])), { name: "RangeError" });
  assert.throws(() => r.setWires(new Uint32Array([0])), { name: "TypeError" });
  assert.throws(() => r.setWires([0, 1]), { name: "TypeError" });
  r.setWires(new Uint32Array([0, 1, 1, 2]));
  assert.strictEqual(r.status().wires, 2);
  r.setWires(new Uint32Array([0, 1]), new Float32Array([0.5]));
  assert.strictEqual(r.status().wires, 1);
  r.setData(data(3, 5));
  assert.strictEqual(r.status().wires, 0, "new data clears wires");
});

test("draw checks the frame length against the data's dimension", () => {
  const { r } = created(R());
  r.setData(data(3, 10));
  assert.throws(() => r.draw({ frame: new Float32Array(30 - 1) }), { name: "TypeError" });
  assert.throws(() => r.draw({ frame: frameFor(10), centre: new Float32Array(9) }), { name: "TypeError" });
  assert.strictEqual(r.draw({ frame: frameFor(10), centre: new Float32Array(10) }), true);
});

test("draw with no data still clears and returns true", () => {
  const { r } = created(R());
  assert.strictEqual(r.draw({}), true);
});

test("place() maps a projected point the same way the vertex shader does", () => {
  const r = R();
  const p = r.place([0, 0, 0], { zoom: 2 }, 200, 100);
  assert.strictEqual(p.x, 100);
  assert.strictEqual(p.y, 50);
  const q = r.place([0.1, 0, 0], { zoom: 1, yaw: 0, pitch: 0, radius: 0.5 }, 200, 100);
  assert.ok(Math.abs(q.x - (100 + 0.1 * 50)) < 1e-9);
  const up = r.place([0, 0.1, 0], { zoom: 1, yaw: 0, pitch: 0 }, 200, 100);
  assert.ok(up.y < 50, "positive y is up on screen");
});

test("defaults are exposed and frozen", () => {
  const d = R().DEFAULTS;
  assert.ok(Object.isFrozen(d));
  for (const k of ["pointSize", "trails", "wires", "focus", "depthOfField", "twinkle", "bloom"]) {
    assert.ok(k in d, k);
  }
});
