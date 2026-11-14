"use strict";
// Unit tests for the renderer's per-point lit value and shared mark (search task t4):
// renderer.setLit, the draw keys filter and unlitGain, and status().lit, as specified in
// docs/search-interface.md ("Renderer (t4)"). The GPU is a fake (helpers/fake-gl.js); the
// pictures (dimmed sets, brighter lit points, the mark on a dark and a light stage, and the
// no-search frame unchanged) are checked in tests/browser/test_renderer_render.py.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeCanvas } = require("./helpers/fake-gl.js");

// The assembled core file (rebuilt by scripts/assemble.py), so these lines count towards
// the coverage that CI attributes to js/src/30-renderer.js.
function R() {
  return loadAssembled()._internal.renderer;
}

function data(n, d) {
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const v = new Float32Array(n * d);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  return { vectors: v, dimension: d, colours: new Float32Array(n * 3).fill(0.8) };
}

function frameFor(d) {
  const f = new Float32Array(3 * d);
  f[0] = 1;
  f[d + 1] = 1;
  f[2 * d + 2] = 1;
  return f;
}

function made(glOpts, rOpts) {
  const { canvas, state } = makeFakeCanvas(glOpts);
  const res = R().create(canvas, rOpts);
  assert.strictEqual(res.ok, true, res.message);
  return { r: res.renderer, canvas, state };
}

function withData(n, d, glOpts, rOpts) {
  const m = made(glOpts, rOpts);
  assert.strictEqual(m.r.setData(data(n, d)).ok, true);
  return m;
}

const plain = (o) => JSON.parse(JSON.stringify(o));

// The calls made since `from`, with every GL object replaced by its kind, so two renderers'
// call sequences can be compared even though their objects differ.
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

// Every bufferData call since `from`: { buffer, data }.
function bufferDatas(state, from) {
  return state.calls
    .slice(from)
    .filter((c) => c[0] === "bufferData")
    .map((c) => ({ data: c[2] }));
}

// The buffer the lit vertex array reads at location 1: the last buffer bound before
// vertexAttribPointer(1, 1, ...).
function litBuffer(state) {
  let bound = null;
  let found = null;
  for (const c of state.calls) {
    if (c[0] === "bindBuffer") bound = c[2];
    if (c[0] === "vertexAttribPointer" && c[1] === 1 && c[2] === 1) found = bound;
  }
  return found;
}

// The most recently made program with a shader containing shaderNeedle.
function programOf(state, shaderNeedle) {
  for (const obj of [...state.created].reverse()) {
    if (obj.kind !== "program") continue;
    const sources = state.calls.filter((c) => c[0] === "attachShader" && c[1] === obj).map((c) => c[2].source);
    if (sources.some((s) => s.includes(shaderNeedle))) return obj;
  }
  return null;
}

function lastUsedProgramBefore(state, drawIndex) {
  let used = null;
  for (let i = 0; i < drawIndex; i++) if (state.calls[i][0] === "useProgram") used = state.calls[i][1];
  return used;
}

// The program and vertex array in force at the last POINTS draw.
function lastPointDraw(state, gl) {
  let idx = -1;
  for (let i = state.calls.length - 1; i >= 0; i--) {
    const c = state.calls[i];
    if (c[0] === "drawArrays" && c[1] === gl.POINTS) {
      idx = i;
      break;
    }
  }
  assert.ok(idx >= 0, "no point draw");
  let vao = null;
  for (let i = 0; i < idx; i++) if (state.calls[i][0] === "bindVertexArray") vao = state.calls[i][1];
  return { program: lastUsedProgramBefore(state, idx), vao, count: state.calls[idx][3] };
}

function uniformCalls(state, from, name) {
  return state.calls.slice(from).filter((c) => c[0] === "uniform1f" && c[1]?.name === name);
}

const D = 8;

// ---------- the shader sources ----------

test("the no-search point shader never reads a lit value; the lit one carries the reference's terms", () => {
  const r = R();
  const src = r.shaderSources(r.layout(D, 10, 4096));
  for (const word of ["aLit", "uFilter", "uUnlit", "mark"]) assert.ok(!src.pointVertex.includes(word), word);
  const lit = src.pointVertexLit;
  assert.match(lit, /layout\(location = 1\) in float aLit;/);
  assert.match(lit, /float mark = step\(1\.5, aLit\);/);
  assert.match(lit, /float l = clamp\(aLit - 2\.0 \* mark, 0\.0, 1\.0\);/);
  assert.match(lit, /\* mix\(1\.0, mix\(0\.8, 1\.5, l\), uFilter\);/);
  assert.match(lit, /\* mix\(1\.0, mix\(uUnlit, 2\.2, l\), uFilter\);/);
  assert.match(lit, /vCol \+= vec3\(0\.9\) \* a \* uGain \* mark \* uFilter;/);
  // everything else in the lit shader is the no-search shader's text, in order
  const extra = new Set([
    "uniform float uFilter, uUnlit;",
    "layout(location = 1) in float aLit;",
    "  float mark = step(1.5, aLit);",
    "  float l = clamp(aLit - 2.0 * mark, 0.0, 1.0);",
    "  vCol += vec3(0.9) * a * uGain * mark * uFilter;",
  ]);
  const stripped = lit
    .split("\n")
    .filter((line) => !extra.has(line))
    .join("\n")
    .replace(" * mix(1.0, mix(0.8, 1.5, l), uFilter)", "")
    .replace(" * mix(1.0, mix(uUnlit, 2.2, l), uFilter)", "");
  assert.strictEqual(stripped, src.pointVertex);
});

test("the draw keys filter and unlitGain default to 0 and 0.07", () => {
  const d = R().DEFAULTS;
  assert.strictEqual(d.filter, 0);
  assert.strictEqual(d.unlitGain, 0.07);
});

// ---------- setLit: shapes, status, and what is uploaded ----------

test("setLit refuses wrong types and lengths with TypeError, and needs data first", () => {
  const { r } = made();
  assert.throws(() => r.setLit(new Float32Array(0)), TypeError);
  r.setData(data(5, D));
  assert.throws(() => r.setLit(new Float32Array(4)), /length count \(5\)/);
  assert.throws(() => r.setLit([0, 0, 0, 0, 0]), TypeError);
  assert.throws(() => r.setLit(new Float64Array(5)), TypeError);
  assert.throws(() => r.setLit(new Float32Array(5), new Uint8Array(4)), /shared must be a Uint8Array/);
  assert.throws(() => r.setLit(new Float32Array(5), new Int8Array(5)), TypeError);
  assert.throws(() => r.setLit(new Float32Array(5), [1, 0, 0, 0, 0]), TypeError);
  assert.strictEqual(r.status().lit, false);
});

test("status().lit is true while lit values are set; null, setData and dispose clear them", () => {
  const { r } = withData(5, D);
  assert.strictEqual(r.status().lit, false);
  assert.deepStrictEqual(plain(r.setLit(new Float32Array(5))), { ok: true, uploaded: true });
  assert.strictEqual(r.status().lit, true);
  assert.deepStrictEqual(plain(r.setLit(null)), { ok: true, uploaded: true });
  assert.strictEqual(r.status().lit, false);
  r.setLit(new Float32Array(5), null);
  assert.strictEqual(r.status().lit, true);
  r.setData(data(6, D));
  assert.strictEqual(r.status().lit, false, "a replace starts with no search");
  r.setLit(new Float32Array(6));
  r.dispose();
  assert.strictEqual(r.status().lit, false);
  assert.strictEqual(r.setLit(new Float32Array(6)).reason, "disposed");
  assert.strictEqual(r.setLit(null).reason, "disposed");
});

test("setLit uploads only its own buffer: the point texture and colours are not re-sent", () => {
  const { r, state } = withData(5, D);
  const tex = state.texImages.length;
  const sub = state.texSubImages.length;
  const from = state.calls.length;
  const lit = new Float32Array([0, 0.25, 1, -1, 7]);
  const shared = new Uint8Array([0, 1, 1, 0, 0]);
  r.setLit(lit, shared);
  assert.strictEqual(state.texImages.length, tex);
  assert.strictEqual(state.texSubImages.length, sub);
  const datas = bufferDatas(state, from);
  assert.strictEqual(datas.length, 1, "one new buffer");
  // clamped to 0..1, plus 2 where marked
  assert.deepStrictEqual(Array.from(datas[0].data), [0, 2.25, 3, 0, 1]);
  const buf = litBuffer(state);
  assert.ok(buf && buf.kind === "buffer");
  // a second call (even with the same arrays) is one bufferSubData of count floats into that buffer
  const subs = state.bufferSubDatas.length;
  const from2 = state.calls.length;
  r.setLit(new Float32Array([Number.NaN, 0.5, Infinity, 0.1, 0]));
  assert.strictEqual(bufferDatas(state, from2).length, 0);
  const added = state.bufferSubDatas.slice(subs);
  assert.strictEqual(added.length, 1);
  assert.strictEqual(added[0].buffer, buf);
  assert.strictEqual(added[0].offset, 0);
  assert.strictEqual(added[0].byteLength, 5 * 4);
  assert.deepStrictEqual(Array.from(added[0].data), [0, 0.5, 1, 0.10000000149011612, 0]);
  assert.strictEqual(state.texImages.length, tex);
  assert.strictEqual(state.texSubImages.length, sub);
});

test("clearing the lit values frees the lit buffer; setting them again makes a new one", () => {
  const { r, state } = withData(5, D);
  r.setLit(new Float32Array(5));
  const buf = litBuffer(state);
  r.setLit(null);
  assert.ok(!state.live.has(buf), "lit buffer deleted");
  r.setLit(new Float32Array(5).fill(1));
  assert.ok(state.live.has(litBuffer(state)));
  assert.notStrictEqual(litBuffer(state), buf);
});

// ---------- draw: which program, and the no-search path untouched ----------

test("with no lit values, or filter 0, the frame is drawn with exactly the calls used before search", () => {
  const a = withData(6, D);
  const b = withData(6, D);
  b.r.setLit(new Float32Array([1, 0, 0.5, 0, 0, 1]), new Uint8Array([1, 0, 0, 0, 0, 0]));
  const base = { frame: frameFor(D), time: 0.3, wires: 0 };
  const fb = b.state.calls.length;
  const frames = [base, { ...base, filter: 0, unlitGain: 0.5 }, { ...base, filter: -1 }, { ...base, filter: Number.NaN }];
  for (const [k, st] of frames.entries()) {
    const fa = a.state.calls.length;
    const fk = b.state.calls.length;
    a.r.draw(st);
    b.r.draw(st);
    const one = callsSince(a.state, fa);
    assert.ok(one.length > 10);
    assert.deepStrictEqual(callsSince(b.state, fk), one, "frame " + k);
  }
  // and that program is the no-search one, over the original vertex array
  const at = lastPointDraw(b.state, makeFakeCanvas().gl);
  assert.strictEqual(at.program, programOf(b.state, "in vec4 aCol;\nout vec3 vCol;"));
  assert.strictEqual(uniformCalls(b.state, fb, "uFilter").length, 0);
});

test("with lit values and filter above 0 the lit program and vertex array draw every point", () => {
  const { r, state } = withData(6, D);
  const gl = makeFakeCanvas().gl; // constants only
  r.setLit(new Float32Array(6).fill(0.5));
  const from = state.calls.length;
  r.draw({ frame: frameFor(D), filter: 0.4 });
  const at = lastPointDraw(state, gl);
  assert.strictEqual(at.program, programOf(state, "in float aLit;"));
  assert.strictEqual(at.count, 6);
  assert.deepStrictEqual(
    uniformCalls(state, from, "uFilter").map((c) => c[2]),
    [0.4],
  );
  assert.deepStrictEqual(
    uniformCalls(state, from, "uUnlit").map((c) => c[2]),
    [0.07],
  );
  // filter is clamped to 1, unlitGain to 0 or more; 0 hides unlit points (Focus's Only results)
  const from2 = state.calls.length;
  r.draw({ frame: frameFor(D), filter: 3, unlitGain: -2 });
  assert.deepStrictEqual(uniformCalls(state, from2, "uFilter").map((c) => c[2]), [1]);
  assert.deepStrictEqual(uniformCalls(state, from2, "uUnlit").map((c) => c[2]), [0]);
  const from3 = state.calls.length;
  r.draw({ frame: frameFor(D), filter: 1, unlitGain: 0 });
  assert.deepStrictEqual(uniformCalls(state, from3, "uUnlit").map((c) => c[2]), [0]);
  // the lit vertex array reads the colour buffer at location 0 and the lit buffer at 1
  const vaoCalls = state.calls.filter((c) => c[0] === "vertexAttribPointer");
  assert.ok(vaoCalls.some((c) => c[1] === 1 && c[2] === 1 && c[5] === 4 && c[6] === 0));
});

test("the no-HDR fallback draws the lit program the same way", () => {
  const { r, state } = withData(4, D, { colorBufferFloat: false });
  assert.strictEqual(r.status().hdr, false);
  r.setLit(new Float32Array([1, 0, 0, 0]));
  r.draw({ frame: frameFor(D), filter: 1 });
  assert.strictEqual(lastPointDraw(state, makeFakeCanvas().gl).program, programOf(state, "in float aLit;"));
});

test("setWires leaves the lit values alone", () => {
  const { r, state } = withData(4, D);
  r.setLit(new Float32Array([1, 0, 0, 0]));
  const buf = litBuffer(state);
  const subs = state.bufferSubDatas.length;
  r.setWires(new Uint32Array([0, 1]));
  assert.strictEqual(r.status().lit, true);
  assert.ok(state.live.has(buf));
  assert.strictEqual(state.bufferSubDatas.slice(subs).filter((s) => s.buffer === buf).length, 0);
});

// ---------- appends ----------

test("an append inside capacity keeps the lit values and sends 0 for the new points only", () => {
  const m = withData(4, D);
  m.r.appendData(data(1, D)); // capacity 8, count 5
  m.r.setLit(new Float32Array([1, 1, 1, 1, 1]), new Uint8Array([1, 1, 1, 1, 1]));
  const buf = litBuffer(m.state);
  const subs = m.state.bufferSubDatas.length;
  const from = m.state.calls.length;
  const res = m.r.appendData(data(2, D));
  assert.strictEqual(res.reallocated, false);
  assert.strictEqual(m.r.status().lit, true);
  assert.strictEqual(bufferDatas(m.state, from).length, 0, "no buffer re-made");
  const lits = m.state.bufferSubDatas.slice(subs).filter((s) => s.buffer === buf);
  assert.strictEqual(lits.length, 1);
  assert.strictEqual(lits[0].offset, 5 * 4);
  assert.deepStrictEqual(Array.from(lits[0].data), [0, 0]);
  // and the next setLit covers all seven
  m.r.setLit(new Float32Array(7).fill(0.5));
  assert.strictEqual(m.state.bufferSubDatas.at(-1).byteLength, 7 * 4);
});

test("an append past capacity re-makes the lit buffer at the new size with the old values kept", () => {
  const { r, state } = withData(3, D);
  r.setLit(new Float32Array([0.5, 1, 0]), new Uint8Array([0, 1, 0]));
  const old = litBuffer(state);
  const from = state.calls.length;
  const res = r.appendData(data(2, D));
  assert.strictEqual(res.reallocated, true);
  assert.ok(!state.live.has(old), "old lit buffer deleted");
  const datas = bufferDatas(state, from);
  const lit = datas.at(-1).data;
  assert.strictEqual(lit.length, 6, "capacity doubled to 6");
  assert.deepStrictEqual(Array.from(lit), [0.5, 3, 0, 0, 0, 0]);
  assert.ok(state.live.has(litBuffer(state)));
  r.draw({ frame: frameFor(D), filter: 1 });
  const at = lastPointDraw(state, makeFakeCanvas().gl);
  assert.strictEqual(at.count, 5);
  assert.strictEqual(at.program, programOf(state, "in float aLit;"));
});

test("an append without lit values set makes no lit buffer", () => {
  const { r, state } = withData(3, D);
  const from = state.calls.length;
  r.appendData(data(1, D));
  assert.strictEqual(litBuffer(state), null);
  assert.strictEqual(
    callsSince(state, from).filter((c) => c[0] === "vertexAttribPointer" && c[1] === 1).length,
    0,
  );
});

// ---------- lifecycle: dispose, context loss, failures ----------

test("dispose with lit values set deletes the lit buffer, vertex array and program too", () => {
  const { r, state, canvas } = withData(5, D);
  r.setLit(new Float32Array(5).fill(1), new Uint8Array(5).fill(1));
  r.draw({ frame: frameFor(D), filter: 1 });
  r.dispose();
  assert.strictEqual(state.live.size, 0, "every GL object deleted");
  assert.strictEqual(canvas.listenerCount(), 0);
});

test("context restore and rebuild() re-upload the kept lit values", () => {
  const { r, state, canvas } = withData(4, D);
  r.setLit(new Float32Array([1, 0.5, 0, 0]), new Uint8Array([0, 0, 1, 0]));
  const ext = canvas.getContext("webgl2").getExtension("WEBGL_lose_context");
  ext.loseContext();
  assert.strictEqual(r.draw({ frame: frameFor(D), filter: 1 }), false);
  const from = state.calls.length;
  ext.restoreContext();
  assert.strictEqual(r.status().lit, true);
  const lit = bufferDatas(state, from).at(-1).data;
  assert.deepStrictEqual(Array.from(lit).slice(0, 4), [1, 0.5, 2, 0]);
  assert.strictEqual(r.draw({ frame: frameFor(D), filter: 1 }), true);
  assert.strictEqual(lastPointDraw(state, makeFakeCanvas().gl).program, programOf(state, "in float aLit;"));
  const from2 = state.calls.length;
  assert.strictEqual(r.rebuild().ok, true);
  assert.deepStrictEqual(Array.from(bufferDatas(state, from2).at(-1).data).slice(0, 4), [1, 0.5, 2, 0]);
  r.dispose();
  assert.strictEqual(state.live.size, 0);
});

test("lit values set or cleared while the context is lost appear (or not) after restore", () => {
  const { r, state, canvas } = withData(3, D);
  const ext = canvas.getContext("webgl2").getExtension("WEBGL_lose_context");
  ext.loseContext();
  assert.deepStrictEqual(plain(r.setLit(new Float32Array([0, 1, 0]))), { ok: true, uploaded: false });
  ext.restoreContext();
  assert.strictEqual(r.status().lit, true);
  assert.ok(litBuffer(state));
  ext.loseContext();
  assert.deepStrictEqual(plain(r.setLit(null)), { ok: true, uploaded: false });
  const from = state.calls.length;
  ext.restoreContext();
  assert.strictEqual(r.status().lit, false);
  assert.strictEqual(
    callsSince(state, from).filter((c) => c[0] === "vertexAttribPointer" && c[1] === 1).length,
    0,
  );
});

test("a GL failure while uploading lit values is reported, frees the GPU state, and rebuild() recovers", () => {
  const { r, state, canvas } = withData(3, D);
  const gl = canvas.getContext("webgl2");
  state.opts.throwOn = "bufferData";
  const res = r.setLit(new Float32Array([1, 0, 0]));
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "gpu-failed");
  assert.strictEqual(r.status().ok, false);
  assert.strictEqual(r.status().lit, true, "the CPU copy is kept");
  assert.strictEqual(r.draw({ frame: frameFor(D), filter: 1 }), false);
  assert.deepStrictEqual(plain(r.setLit(new Float32Array([0, 1, 0]))), { ok: true, uploaded: false });
  state.opts.throwOn = null;
  assert.strictEqual(r.rebuild().ok, true);
  assert.strictEqual(r.draw({ frame: frameFor(D), filter: 1 }), true);
  assert.strictEqual(lastPointDraw(state, gl).program, programOf(state, "in float aLit;"));
  // a failure in the in-place update and in the lit program's compile, too
  state.opts.throwOn = "bufferSubData";
  assert.strictEqual(r.setLit(new Float32Array(3)).reason, "gpu-failed");
  state.opts.throwOn = null;
  assert.strictEqual(r.rebuild().ok, true);
  const m = withData(3, D);
  m.state.opts.failCompile = true;
  assert.strictEqual(m.r.setLit(new Float32Array(3)).reason, "shader-failed");
  m.r.dispose();
  assert.strictEqual(m.state.live.size, 0);
});
