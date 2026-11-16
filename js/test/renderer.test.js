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

// ---------- follow-up review fixes (t6b) ----------

const { constantFor } = require("./helpers/fake-gl.js");

// Results come from a vm context; compare them as plain data.
const plain = (o) => JSON.parse(JSON.stringify(o));

test("the fake GL throws on a name that is not a WebGL 2 method", () => {
  const { gl } = makeFakeCanvas();
  assert.throws(() => gl.texSubImage2d(), /not a WebGL 2 method/);
  gl.texSubImage2D(0, 0, 0, 0, 1, 1, 0, 0, new Float32Array(4)); // a real one is fine
});

test("a failed upload in setData frees the GPU state; draw then returns false without throwing", () => {
  const { canvas, state } = makeFakeCanvas();
  const r = R().create(canvas).renderer;
  state.opts.throwOn = "bufferData";
  const res = r.setData(data(6, 16));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "gpu-failed");
  assert.match(res.message, /bufferData failed/);
  assert.strictEqual(state.live.size, 0, "no half-built GPU objects left");
  assert.strictEqual(r.status().ok, false);
  assert.strictEqual(r.status().count, 6, "the CPU copy holds the data");
  assert.doesNotThrow(() => assert.strictEqual(r.draw({ frame: frameFor(16) }), false));
  // a later setData does not reach the GPU until rebuild()
  assert.strictEqual(r.setData(data(5, 16)).uploaded, false);
  state.opts.throwOn = null;
  assert.deepStrictEqual(plain(r.rebuild()), { ok: true });
  assert.strictEqual(r.status().ok, true);
  assert.strictEqual(r.status().count, 5);
  assert.strictEqual(r.draw({ frame: frameFor(16) }), true);
  r.dispose();
  assert.strictEqual(state.live.size, 0);
});

test("a failed upload in appendData or setWires also frees the GPU state", () => {
  for (const which of ["append", "wires"]) {
    const { canvas, state } = makeFakeCanvas();
    const r = R().create(canvas).renderer;
    r.setData(data(8, 16));
    state.opts.throwOn = which === "append" ? "bufferData" : "vertexAttribIPointer";
    const res = which === "append" ? r.appendData(data(9, 16, 2)) : r.setWires(new Uint32Array([0, 1]));
    assert.strictEqual(res.ok, false, which);
    assert.strictEqual(state.live.size, 0, which);
    assert.strictEqual(r.draw({ frame: frameFor(16) }), false, which);
    state.opts.throwOn = null;
    assert.strictEqual(r.rebuild().ok, true, which);
    assert.strictEqual(r.draw({ frame: frameFor(16) }), true, which);
  }
});

// Appends at D = 16 with MAX_TEXTURE_SIZE 16: 4 texels per point, 4 points per row,
// 64 floats per row, 16 bytes of colour per point.
function appendRig() {
  const { canvas, state } = makeFakeCanvas({ maxTextureSize: 16 });
  const r = R().create(canvas).renderer;
  const lay = r.setData(data(8, 16)).layout;
  assert.strictEqual(lay.pointsPerRow, 4);
  assert.strictEqual(lay.width, 16);
  r.setWires(new Uint32Array([0, 1, 2, 3, 4, 5]));
  return { r, state };
}

function lastUpload(state) {
  const tex = state.texSubImages.filter((u) => u.width === 16); // the point texture (frame texture is 4 wide)
  return { tex: tex.at(-1), buf: state.bufferSubDatas.at(-1) };
}

function checkDrawCounts(r, state, points, wires) {
  state.draws.length = 0;
  assert.strictEqual(r.draw({ frame: frameFor(16), wires: 1 }), true);
  const points_ = state.draws.filter((d) => d.mode === constantFor("POINTS"));
  const lines = state.draws.filter((d) => d.mode === constantFor("LINES"));
  assert.deepStrictEqual(points_.map((d) => d.count), [points]);
  assert.deepStrictEqual(lines.map((d) => d.count), [wires * 2]);
}

test("append inside one texture row uploads that row and the new points' colours", () => {
  const { r, state } = appendRig();
  assert.strictEqual(r.appendData(data(1, 16, 3)).reallocated, true); // 9 > 8: capacity 16
  const more = data(2, 16, 4);
  const res = r.appendData(more); // points 9, 10: row 2
  assert.deepStrictEqual(plain(res), { ok: true, reallocated: false, uploaded: true });
  const { tex, buf } = lastUpload(state);
  assert.strictEqual(tex.y, 2);
  assert.strictEqual(tex.height, 1);
  assert.strictEqual(tex.x, 0);
  assert.strictEqual(tex.length, 64);
  assert.strictEqual(tex.data[1 * 16], more.vectors[0], "point 9 sits second in row 2");
  assert.strictEqual(buf.offset, 9 * 16);
  assert.strictEqual(buf.byteLength, 2 * 16);
  checkDrawCounts(r, state, 11, 3);
});

test("append straddling a row boundary uploads both rows", () => {
  const { r, state } = appendRig();
  r.appendData(data(3, 16, 3)); // 11 points, capacity 16
  r.appendData(data(2, 16, 4)); // points 11, 12: rows 2..3
  const { tex, buf } = lastUpload(state);
  assert.strictEqual(tex.y, 2);
  assert.strictEqual(tex.height, 2);
  assert.strictEqual(tex.length, 128);
  assert.strictEqual(buf.offset, 11 * 16);
  assert.strictEqual(buf.byteLength, 2 * 16);
  checkDrawCounts(r, state, 13, 3);
});

test("append starting exactly on a row boundary uploads only the new row", () => {
  const { r, state } = appendRig();
  r.appendData(data(4, 16, 3)); // 12 points, capacity 16
  const more = data(1, 16, 4);
  r.appendData(more); // point 12: row 3 only
  const { tex, buf } = lastUpload(state);
  assert.strictEqual(tex.y, 3);
  assert.strictEqual(tex.height, 1);
  assert.strictEqual(tex.data[0], more.vectors[0]);
  assert.strictEqual(buf.offset, 12 * 16);
  assert.strictEqual(buf.byteLength, 16);
  checkDrawCounts(r, state, 13, 3);
});

test("append overflowing capacity re-uploads the whole texture at the larger size", () => {
  const { r, state } = appendRig();
  r.appendData(data(5, 16, 3)); // 13 points, capacity 16
  const subs = state.texSubImages.length;
  const images = state.texImages.length;
  const res = r.appendData(data(4, 16, 4)); // 17 > 16: capacity 32, 8 rows
  assert.deepStrictEqual(plain(res), { ok: true, reallocated: true, uploaded: true });
  assert.strictEqual(state.texSubImages.length, subs, "no partial upload");
  const pointTex = state.texImages.slice(images).filter((t) => t.width === 16);
  assert.deepStrictEqual(
    pointTex.map((t) => t.height),
    [8]
  );
  const bufData = state.calls.filter((c) => c[0] === "bufferData").pop();
  assert.strictEqual(bufData[2].byteLength, 32 * 16);
  checkDrawCounts(r, state, 17, 3);
});

test("append binds the point texture on unit 0 even when another unit is active", () => {
  const { canvas, state, gl } = makeFakeCanvas({ maxTextureSize: 16 });
  const r = R().create(canvas).renderer;
  r.setData(data(8, 16));
  r.appendData(data(1, 16, 3)); // capacity 16
  r.draw({ frame: frameFor(16) });
  gl.activeTexture(gl.TEXTURE3); // left behind by other code
  r.appendData(data(1, 16, 4));
  const { tex } = lastUpload(state);
  assert.strictEqual(tex.unit, constantFor("TEXTURE0"));
  const pointTex = state.texImages.filter((t) => t.width === 16).pop().texture;
  assert.strictEqual(tex.texture, pointTex);
});

test("rebuild() recovers after a failed restore, and refuses while the context is lost", () => {
  const events = [];
  const { canvas, state, gl } = makeFakeCanvas();
  const r = R().create(canvas, { onContextChange: (e) => events.push(e.type) }).renderer;
  r.setData(data(5, 16));
  const ext = gl.getExtension("WEBGL_lose_context");
  ext.loseContext();
  const lostTry = r.rebuild();
  assert.strictEqual(lostTry.ok, false);
  assert.strictEqual(lostTry.reason, "context-lost");
  state.opts.failCompile = true;
  ext.restoreContext();
  assert.deepStrictEqual(events, ["lost", "restore-failed"]);
  assert.strictEqual(r.draw({ frame: frameFor(16) }), false, "draw does not retry by itself");
  const again = r.rebuild();
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, "shader-failed");
  state.opts.failCompile = false;
  assert.deepStrictEqual(plain(r.rebuild()), { ok: true });
  assert.strictEqual(r.status().ok, true);
  assert.strictEqual(r.draw({ frame: frameFor(16) }), true);
  r.dispose();
  assert.strictEqual(r.rebuild().reason, "disposed");
  assert.strictEqual(state.live.size, 0);
});

test("data changed while the context is lost reports uploaded: false and appears after restore", () => {
  const { canvas, state, gl } = makeFakeCanvas();
  const r = R().create(canvas).renderer;
  assert.strictEqual(r.setData(data(4, 16)).uploaded, true);
  const ext = gl.getExtension("WEBGL_lose_context");
  ext.loseContext();
  assert.deepStrictEqual(plain(r.appendData(data(3, 16, 2))), { ok: true, reallocated: true, uploaded: false });
  assert.deepStrictEqual(plain(r.setWires(new Uint32Array([0, 6]))), { ok: true, uploaded: false });
  const set = r.setData(data(7, 16, 5));
  assert.strictEqual(set.ok, true);
  assert.strictEqual(set.uploaded, false);
  r.setWires(new Uint32Array([1, 6]));
  ext.restoreContext();
  state.draws.length = 0;
  assert.strictEqual(r.draw({ frame: frameFor(16), wires: 1 }), true);
  assert.deepStrictEqual(
    state.draws.filter((d) => d.mode === constantFor("POINTS")).map((d) => d.count),
    [7]
  );
  assert.deepStrictEqual(
    state.draws.filter((d) => d.mode === constantFor("LINES")).map((d) => d.count),
    [2]
  );
});

test("if the HDR target fails mid-frame the fallback clears to the requested background", () => {
  const { canvas, state } = makeFakeCanvas();
  const r = R().create(canvas).renderer;
  assert.strictEqual(r.status().hdr, true);
  r.setData(data(4, 16));
  state.opts.fboIncomplete = true;
  r.resize(64, 32); // the next draw re-sizes the HDR target, which now fails
  state.clearColors.length = 0;
  assert.strictEqual(r.draw({ frame: frameFor(16), background: [0.2, 0.3, 0.4] }), true);
  assert.strictEqual(r.status().hdr, false);
  assert.deepStrictEqual(state.clearColors, [[0.2, 0.3, 0.4, 1]]);
  state.clearColors.length = 0;
  r.draw({ frame: frameFor(16), background: [0.2, 0.3, 0.4] });
  assert.deepStrictEqual(state.clearColors, [[0.2, 0.3, 0.4, 1]]);
});

test("append ending exactly at a row end does not upload the row after it", () => {
  const { r, state } = appendRig();
  r.appendData(data(1, 16, 3)); // 9 points, capacity 16
  r.appendData(data(3, 16, 4)); // points 9..11 fill row 2 exactly
  const { tex, buf } = lastUpload(state);
  assert.strictEqual(tex.y, 2);
  assert.strictEqual(tex.height, 1);
  assert.strictEqual(buf.offset, 9 * 16);
  assert.strictEqual(buf.byteLength, 3 * 16);
  checkDrawCounts(r, state, 12, 3);
});

// ---------- the perspective draw key (relative search, task t3) ----------
// docs/relative-interface.md, "Renderer (t3): the perspective key".

const crypto = require("node:crypto");

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Every shader source for one layout, joined in key order, hashed.
function sourcesHash(r, d, n, maxTex, opts) {
  const src = r.shaderSources(r.layout(d, n, maxTex), opts);
  return sha(
    Object.keys(src)
      .sort()
      .map((k) => k + "\n" + src[k])
      .join("\n----\n")
  );
}

// place() and placer() over a 13^3 grid of points under four states, every number hashed
// as float64 bytes. `extra` is merged into every state.
function placeHash(r, extra) {
  const states = [
    {},
    { zoom: 2.588, pitch: 0 },
    { zoom: 1.3, yaw: 0.4, pitch: 0.16, radius: 0.5, focus: 0.2 },
    { zoom: 3, yaw: -1.1, pitch: 0.9 },
  ];
  const parts = [];
  const o = {};
  for (const base of states) {
    const st = { ...base, ...extra };
    const pl = r.placer(st, 640, 480);
    for (let i = -6; i <= 6; i++) {
      for (let j = -6; j <= 6; j++) {
        for (let k = -6; k <= 6; k++) {
          const p = [i * 0.17, j * 0.13, k * 0.21];
          const q = r.place(p, st, 640, 480);
          pl(p[0], p[1], p[2], o);
          parts.push(q.x, q.y, q.scale, q.depth, o.x, o.y);
        }
      }
    }
  }
  return sha(Buffer.from(new Float64Array(parts).buffer));
}

// Hashes computed from js/src/30-renderer.js as it was before task t3 (commit 1215ee3), by the
// same two functions above: the shader sources for four layouts and the CPU place/placer numbers.
const BEFORE_T3 = {
  src3: "025ca05226d9cd32becc787985d173290fb14c928acca7bf16857ee73cb6fe80",
  src768: "6eb066a40ecace3bf0bfc31cd3e446cd451111a7364c69fb1119f598c80dea2d",
  src1024: "21fe93690393775334f6ec3b584adc18d8bd725db4c3e34b192493c907ac1513",
  src2560: "dd2acb9a7bca80ba35fceed6b8f34bc41954841d62397cebee1a47741afda68f",
  place: "1204304c4b3072ec159b9f237f9a8b3c128ef97ee9d0eb6cb44bd8b9fa898348",
};

const LAYOUTS = [
  ["src3", 3, 10, 16384],
  ["src768", 768, 999, 16384],
  ["src1024", 1024, 5000, 8192],
  ["src2560", 2560, 200, 4096],
];

test("perspective: the draw key defaults to 3 and the relative value is 60", () => {
  const r = R();
  assert.strictEqual(r.DEFAULTS.perspective, 3);
  assert.strictEqual(r.RELATIVE_PERSPECTIVE, 60);
});

test("perspective criterion 1: the default shader sources are the strings from before t3", () => {
  const r = R();
  for (const [key, d, n, m] of LAYOUTS) {
    assert.strictEqual(sourcesHash(r, d, n, m), BEFORE_T3[key], key + " (no options)");
    assert.strictEqual(sourcesHash(r, d, n, m, undefined), BEFORE_T3[key], key + " (undefined)");
    assert.strictEqual(sourcesHash(r, d, n, m, {}), BEFORE_T3[key], key + " ({})");
  }
  // the text the interface page names is still there, word for word
  const src = r.shaderSources(r.layout(8, 10, 4096));
  for (const k of ["pointVertex", "pointVertexLit", "lineVertex", "lineVertexLit"]) {
    assert.ok(src[k].includes("  float s = 3.0 / max(0.6, 3.0 + z2);"), k);
    assert.ok(!src[k].includes("uPersp"), k);
  }
});

test("perspective criterion 1: place and placer with the key absent or 3 give the numbers from before t3", () => {
  const r = R();
  assert.strictEqual(placeHash(r, {}), BEFORE_T3.place, "absent");
  assert.strictEqual(placeHash(r, { perspective: 3 }), BEFORE_T3.place, "3");
  assert.strictEqual(placeHash(r, { perspective: undefined }), BEFORE_T3.place, "undefined");
  assert.notStrictEqual(placeHash(r, { perspective: 60 }), BEFORE_T3.place, "60 changes the numbers");
});

test("perspective: the variant shaders read uPersp in place() and differ from the default in that only", () => {
  const r = R();
  const lay = r.layout(8, 10, 4096);
  const base = r.shaderSources(lay);
  const flat = r.shaderSources(lay, { perspective: true });
  for (const k of ["pointVertex", "pointVertexLit", "lineVertex", "lineVertexLit"]) {
    assert.ok(flat[k].includes("  float s = uPersp / max(0.6, uPersp + z2);"), k);
    const back = flat[k]
      .replace("  float s = uPersp / max(0.6, uPersp + z2);", "  float s = 3.0 / max(0.6, 3.0 + z2);")
      .replace(" uniform float uFocus; uniform float uPersp;", " uniform float uFocus;");
    assert.strictEqual(back, base[k], k);
  }
  for (const k of ["pointFragment", "lineFragment", "quadVertex", "fadeFragment", "toneFragment"]) {
    assert.strictEqual(flat[k], base[k], k);
  }
});

test("perspective: place and placer agree at any value and follow s = P / max(0.6, P + z2)", () => {
  const r = R();
  const o = {};
  for (const P of [3, 10, 33.3, 60]) {
    const st = { zoom: 1.7, yaw: 0.3, pitch: 0.2, perspective: P };
    const pl = r.placer(st, 800, 600);
    for (const p of [
      [0.2, -0.4, 0.9],
      [-1, 1, -1],
      [0.05, 0.6, 2.5],
    ]) {
      const q = r.place(p, st, 800, 600);
      pl(p[0], p[1], p[2], o);
      assert.strictEqual(o.x, q.x);
      assert.strictEqual(o.y, q.y);
    }
    const flatZ = r.place([0, 0, 0.5], { perspective: P, zoom: 1 }, 100, 100);
    assert.ok(Math.abs(flatZ.scale - P / Math.max(0.6, P + 0.5)) < 1e-15, "scale at " + P);
  }
  // a value that is not a positive finite number reads as the default
  for (const bad of [0, -5, Number.NaN, Infinity, "60", null]) {
    assert.strictEqual(placeHash(r, { perspective: bad }), BEFORE_T3.place, String(bad));
  }
});

// The point program used at the last POINTS draw, and the vertex shader source attached to it.
function lastPointProgram(state) {
  let used = null;
  let at = null;
  for (const c of state.calls) {
    if (c[0] === "useProgram") used = c[1];
    if (c[0] === "drawArrays" && c[1] === constantFor("POINTS")) at = used;
  }
  const vs = state.calls.find((c) => c[0] === "attachShader" && c[1] === at && c[2].type === constantFor("VERTEX_SHADER"));
  return { program: at, source: vs ? vs[2].source : null };
}

function uniform1f(state, from, name) {
  return state.calls.slice(from).filter((c) => c[0] === "uniform1f" && c[1]?.name === name).map((c) => c[2]);
}

// Calls since `from` with GL objects reduced to their kind, so two renderers compare.
function callShapes(state, from) {
  return state.calls.slice(from).map((c) =>
    c.map((a) => {
      if (a && typeof a === "object" && "kind" in a && "id" in a) return "<" + a.kind + ">";
      if (a && typeof a === "object" && "program" in a && "name" in a) return "<uniform " + a.name + ">";
      if (ArrayBuffer.isView(a)) return "<" + a.constructor.name + " " + a.length + ">";
      return a;
    })
  );
}

function wiredRig() {
  const m = created(R());
  m.r.setData(data(6, 8));
  m.r.setWires(new Uint32Array([0, 1, 2, 3, 4, 5]));
  return m;
}

test("perspective criterion 1: a draw at the default makes exactly the calls of a draw without the key", () => {
  const a = wiredRig();
  const b = wiredRig();
  const shadersBefore = b.state.calls.filter((c) => c[0] === "shaderSource").length;
  const base = { frame: frameFor(8), time: 0.4, wires: 1 };
  for (const extra of [{}, { perspective: 3 }, { perspective: undefined }]) {
    const fa = a.state.calls.length;
    const fb = b.state.calls.length;
    a.r.draw(base);
    b.r.draw({ ...base, ...extra });
    const one = callShapes(a.state, fa);
    assert.ok(one.length > 10);
    assert.deepStrictEqual(callShapes(b.state, fb), one, JSON.stringify(extra));
  }
  assert.strictEqual(b.state.calls.filter((c) => c[0] === "shaderSource").length, shadersBefore, "nothing compiled");
  assert.strictEqual(uniform1f(b.state, 0, "uPersp").length, 0);
});

test("perspective: at another value the points and wires are drawn by variant programs given uPersp", () => {
  const { r, state } = wiredRig();
  const from = state.calls.length;
  assert.strictEqual(r.draw({ frame: frameFor(8), wires: 1, perspective: 60 }), true);
  assert.deepStrictEqual(uniform1f(state, from, "uPersp"), [60, 60], "wires then points");
  assert.match(lastPointProgram(state).source, /float s = uPersp \/ max\(0\.6, uPersp \+ z2\);/);
  // the variant is compiled once and kept; the next value is just a uniform
  const shaders = state.calls.filter((c) => c[0] === "shaderSource").length;
  const from2 = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1, perspective: 31.5 });
  assert.deepStrictEqual(uniform1f(state, from2, "uPersp"), [31.5, 31.5]);
  assert.strictEqual(state.calls.filter((c) => c[0] === "shaderSource").length, shaders);
  // back at 3 the original program draws again, with no uPersp
  const from3 = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1 });
  assert.strictEqual(uniform1f(state, from3, "uPersp").length, 0);
  assert.match(lastPointProgram(state).source, /float s = 3\.0 \/ max\(0\.6, 3\.0 \+ z2\);/);
});

test("perspective: with lit values applying, the lit variant programs draw and get uPersp and uFilter", () => {
  const { r, state } = wiredRig();
  r.setLit(new Float32Array([1, 0, 0.5, 0, 0, 1]));
  const from = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1, perspective: 60, filter: 1 });
  assert.deepStrictEqual(uniform1f(state, from, "uPersp"), [60, 60]);
  assert.deepStrictEqual(uniform1f(state, from, "uFilter"), [1, 1]);
  const src = lastPointProgram(state).source;
  assert.match(src, /in float aLit;/);
  assert.match(src, /uPersp \/ max\(0\.6, uPersp \+ z2\)/);
});

test("perspective: variants follow a layout change, are freed by dispose, and a compile failure is reported", () => {
  const { r, state } = wiredRig();
  r.draw({ frame: frameFor(8), perspective: 60 });
  r.setData(data(4, 40)); // a different layout: the programs are rebuilt
  r.draw({ frame: frameFor(40), perspective: 60 });
  assert.match(lastPointProgram(state).source, /const int TEXELS = 10;/);
  assert.match(lastPointProgram(state).source, /uPersp/);
  r.dispose();
  for (const o of state.live) assert.notStrictEqual(o.kind, "program", "every program freed");
  const m = wiredRig();
  m.state.opts.failCompile = true;
  assert.strictEqual(m.r.draw({ frame: frameFor(8), perspective: 60 }), false);
  assert.strictEqual(m.r.status().ok, false);
  assert.match(m.r.status().error, /shader/);
});

// Criterion 2 (obligation o6): at RELATIVE_PERSPECTIVE, untilted, two points of equal frame
// height at the two depth ends of the cloud are placed within 2 percent of the ruler's visible
// length of each other by the CPU place().
//
// The depth range, derived from the framing in docs/relative-interface.md ("Centre and zoom"):
// the zoom is min(RELATIVE_FILL / (top - bottom), RELATIVE_ZOOM_CAP). On the Wikipedia set
// (999 x 768, embeddinggemma), a search from each of 12 points spread over the set gives
// low 0.476 .. 0.561 and high 1 (the search's own length), so top - bottom is at most 0.644 and
// the zoom is always the cap, 0.5 / (0.42 * 0.46) = 2.588: the largest zoom the framing allows.
// The depth row toured the 8 principal directions of the remainder when this was measured
// (since then: the set's 8 strongest directions with the search removed, nearly the same span) and
// the centre lies along the search, so a point's depth is x . r for a unit r in that span. Over
// 4000 directions per search the widest depth range after zoom was 1.661 (worst error 1.38
// percent); along the first principal direction alone it was about 1.45. The test uses depth
// ends of +-0.85 after zoom (width 1.70, above every measured one) and the interface page's
// rough +-1.0, and puts the two points at the top of the window, where the error is largest.
function heightError(r, P, zNear, zFar) {
  const W = 1280;
  const H = 720;
  const zoom = 0.5 / (0.42 * 0.46);
  const top = 1.04;
  const bottom = 0.44;
  const c = (top + bottom) / 2; // the centre's height along the search
  const st = { zoom, yaw: 0, pitch: 0, radius: 0.46, perspective: P };
  const ruler = Math.abs(r.place([0, top - c, 0], st, W, H).y - r.place([0, bottom - c, 0], st, W, H).y);
  const near = r.place([0, top - c, zNear / zoom], st, W, H);
  const far = r.place([0, top - c, zFar / zoom], st, W, H);
  return Math.abs(near.y - far.y) / ruler;
}

test("perspective criterion 2: at 60, equal heights at the cloud's two depth ends are within 2 percent of the ruler", () => {
  const r = R();
  const P = r.RELATIVE_PERSPECTIVE;
  const measured = heightError(r, P, -0.85, 0.85);
  const rough = heightError(r, P, -1, 1);
  assert.ok(measured < 0.02, "depth +-0.85: " + (100 * measured).toFixed(3) + " percent");
  assert.ok(rough < 0.02, "depth +-1.0: " + (100 * rough).toFixed(3) + " percent");
  assert.ok(Math.abs(measured - 0.01417) < 0.0002, "about 1.42 percent, got " + (100 * measured).toFixed(3));
  assert.ok(Math.abs(rough - 0.01667) < 0.0002, "about 1.67 percent, got " + (100 * rough).toFixed(3));
  // the same test sees the default perspective's tilt: far outside the limit
  assert.ok(heightError(r, 3, -0.85, 0.85) > 0.2);
});

// Criterion 3: the faint similarity gradient reaches the renderer inside the lit values. With
// filter 0 (no search active, or relative off) or with no lit values set, a lit array holding
// gradient values draws exactly as a renderer that never had lit values: the same calls, the same
// program, the same uniforms, so the same pixels.
test("perspective criterion 3: gradient values in the lit array change nothing with filter 0 or none set", () => {
  const plainRig = wiredRig();
  const gradient = wiredRig();
  const cleared = wiredRig();
  // results at 1, every other point a faint RELATIVE_GRADIENT * g^2 style value below 0.3
  gradient.r.setLit(new Float32Array([1, 0.018, 0.21, 0.004, 0.27, 0.1]));
  cleared.r.setLit(new Float32Array([1, 0.018, 0.21, 0.004, 0.27, 0.1]));
  cleared.r.setLit(null);
  const base = { frame: frameFor(8), time: 0.7, wires: 1 };
  for (const st of [base, { ...base, filter: 0 }, { ...base, filter: 0, perspective: 3 }]) {
    const f0 = plainRig.state.calls.length;
    const f1 = gradient.state.calls.length;
    const f2 = cleared.state.calls.length;
    plainRig.r.draw(st);
    gradient.r.draw(st);
    cleared.r.draw(st);
    const one = callShapes(plainRig.state, f0);
    assert.deepStrictEqual(callShapes(gradient.state, f1), one, "gradient set, " + JSON.stringify(st.filter));
    assert.deepStrictEqual(callShapes(cleared.state, f2), one, "gradient cleared");
  }
  assert.strictEqual(uniform1f(gradient.state, 0, "uFilter").length, 0);
});
