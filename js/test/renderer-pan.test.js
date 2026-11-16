"use strict";
// The pan draw key (task t17 of the relative-search build): a screen-space offset of the drawn
// picture, pan: [x, y], in units of the stage's radius R = min(width, height) * radius (one
// unit of the picture after zoom and perspective), positive x to the right and positive y up.
// place() and placer() add it after the perspective; the variant programs read it as uPan.
// With the pan absent or [0, 0] nothing changes: the default shader text, the GL calls and the
// CPU numbers are those pinned in renderer.test.js.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const { loadSources } = require("./helpers/load.js");
const { makeFakeCanvas } = require("./helpers/fake-gl.js");

function R() {
  return loadSources(["30-renderer.js"])._internal.renderer;
}

function data(n, d) {
  let s = 1;
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

function wiredRig() {
  const { canvas, state } = makeFakeCanvas();
  const res = R().create(canvas);
  assert.strictEqual(res.ok, true, res.message);
  res.renderer.setData(data(6, 8));
  res.renderer.setWires(new Uint32Array([0, 1, 2, 3, 4, 5]));
  return { r: res.renderer, state };
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// The same hash as renderer.test.js's placeHash (13^3 grid, four states, every number).
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

// renderer.test.js, BEFORE_T3.place: the CPU numbers from before the perspective key.
const BEFORE_PLACE = "1204304c4b3072ec159b9f237f9a8b3c128ef97ee9d0eb6cb44bd8b9fa898348";

test("pan: the draw key defaults to [0, 0] and absent or zero keeps place and placer's numbers", () => {
  const r = R();
  assert.deepStrictEqual(Array.from(r.DEFAULTS.pan), [0, 0]);
  assert.ok(Object.isFrozen(r.DEFAULTS.pan));
  assert.strictEqual(placeHash(r, {}), BEFORE_PLACE, "absent");
  assert.strictEqual(placeHash(r, { pan: [0, 0] }), BEFORE_PLACE, "[0, 0]");
  assert.strictEqual(placeHash(r, { pan: undefined }), BEFORE_PLACE, "undefined");
  // anything that is not two finite numbers reads as no pan
  for (const bad of [null, [1], [Number.NaN, 0], [0, Infinity], "1,2", { x: 1, y: 1 }, 3]) {
    assert.strictEqual(placeHash(r, { pan: bad }), BEFORE_PLACE, JSON.stringify(bad));
  }
  assert.notStrictEqual(placeHash(r, { pan: [0.1, 0] }), BEFORE_PLACE, "a pan changes the numbers");
});

test("pan: place and placer move every point by exactly pan times R, x right and y up", () => {
  const r = R();
  const W = 640;
  const H = 480;
  const o = {};
  for (const base of [{}, { zoom: 2.2, yaw: 0.7, pitch: -0.3, radius: 0.5 }, { perspective: 60, zoom: 1.5 }]) {
    const Rpx = Math.min(W, H) * (base.radius || r.DEFAULTS.radius);
    for (const pan of [
      [0.25, 0],
      [0, 0.25],
      [-0.4, 0.3],
    ]) {
      const st = { ...base, pan };
      const pl = r.placer(st, W, H);
      for (const p of [
        [0, 0, 0],
        [0.3, -0.2, 0.5],
        [-1, 1, -0.4],
      ]) {
        const a = r.place(p, base, W, H);
        const b = r.place(p, st, W, H);
        assert.ok(Math.abs(b.x - a.x - pan[0] * Rpx) < 1e-9, "x moves by pan[0] * R");
        assert.ok(Math.abs(b.y - a.y + pan[1] * Rpx) < 1e-9, "positive y moves up (canvas y down)");
        assert.strictEqual(b.scale, a.scale, "the perspective scale is untouched");
        assert.strictEqual(b.depth, a.depth, "the depth is untouched");
        pl(p[0], p[1], p[2], o);
        assert.strictEqual(o.x, b.x, "placer agrees with place");
        assert.strictEqual(o.y, b.y);
      }
    }
  }
  // the unit follows the stage: half the stage's shorter side is pan 1 / (2 * radius)
  const q = r.place([0, 0, 0], { pan: [1, 0], radius: 0.5 }, 300, 200);
  assert.strictEqual(q.x, 150 + 100);
});

test("pan: the variant sources carry uPan only when asked, added after the perspective", () => {
  const r = R();
  const lay = r.layout(8, 10, 4096);
  const flat = r.shaderSources(lay, { perspective: true });
  const both = r.shaderSources(lay, { perspective: true, pan: true });
  const base = r.shaderSources(lay);
  for (const k of ["pointVertex", "pointVertexLit", "lineVertex", "lineVertexLit"]) {
    assert.ok(!base[k].includes("uPan"), k);
    assert.ok(!flat[k].includes("uPan"), k);
    assert.ok(both[k].includes(" uniform float uPersp; uniform vec2 uPan;"), k);
    assert.ok(both[k].includes("  return vec4((x1 * s + uPan.x) * uView.x, (y2 * s + uPan.y) * uView.y, 0.0, s);"), k);
    const back = both[k]
      .replace(" uniform vec2 uPan;", "")
      .replace(
        "  return vec4((x1 * s + uPan.x) * uView.x, (y2 * s + uPan.y) * uView.y, 0.0, s);",
        "  return vec4(x1 * s * uView.x, y2 * s * uView.y, 0.0, s);"
      );
    assert.strictEqual(back, flat[k], k + ": the pan is the only difference");
  }
});

function uniformCalls(state, from, kind, name) {
  return state.calls.slice(from).filter((c) => c[0] === kind && c[1]?.name === name).map((c) => c.slice(2));
}

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

test("pan: a draw with the pan absent or zero makes exactly the calls of a draw without the key", () => {
  const a = wiredRig();
  const b = wiredRig();
  const base = { frame: frameFor(8), time: 0.4, wires: 1 };
  for (const extra of [{}, { pan: [0, 0] }, { pan: undefined }, { pan: [0, 0], perspective: 3 }]) {
    const fa = a.state.calls.length;
    const fb = b.state.calls.length;
    a.r.draw(base);
    b.r.draw({ ...base, ...extra });
    const one = callShapes(a.state, fa);
    assert.ok(one.length > 10);
    assert.deepStrictEqual(callShapes(b.state, fb), one, JSON.stringify(extra));
  }
  assert.strictEqual(uniformCalls(b.state, 0, "uniform2f", "uPan").length, 0);
  assert.strictEqual(uniformCalls(b.state, 0, "uniform1f", "uPersp").length, 0);
});

test("pan: a non-zero pan draws the points and wires with the variant programs, given uPan and uPersp", () => {
  const { r, state } = wiredRig();
  const from = state.calls.length;
  assert.strictEqual(r.draw({ frame: frameFor(8), wires: 1, pan: [0.2, -0.1] }), true);
  const pans = uniformCalls(state, from, "uniform2f", "uPan");
  assert.strictEqual(pans.length, 2, "wires then points");
  for (const p of pans) {
    assert.ok(Math.abs(p[0] - 0.2) < 1e-12 && Math.abs(p[1] + 0.1) < 1e-12);
  }
  assert.deepStrictEqual(
    uniformCalls(state, from, "uniform1f", "uPersp").map((c) => c[0]),
    [3, 3],
    "the perspective stays 3, now as a uniform"
  );
  // with the perspective changed too, both arrive
  const from2 = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1, pan: [0.5, 0.5], perspective: 60 });
  assert.strictEqual(uniformCalls(state, from2, "uniform2f", "uPan").length, 2);
  assert.deepStrictEqual(uniformCalls(state, from2, "uniform1f", "uPersp").map((c) => c[0]), [60, 60]);
  // a perspective change alone gives uPan [0, 0] to the same variant
  const from3 = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1, perspective: 60 });
  assert.deepStrictEqual(uniformCalls(state, from3, "uniform2f", "uPan"), [
    [0, 0],
    [0, 0],
  ]);
  // back at the defaults the original programs draw, with neither uniform
  const from4 = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1 });
  assert.strictEqual(uniformCalls(state, from4, "uniform2f", "uPan").length, 0);
  assert.strictEqual(uniformCalls(state, from4, "uniform1f", "uPersp").length, 0);
});

test("pan: with lit values applying, the lit variant programs draw and get uPan", () => {
  const { r, state } = wiredRig();
  r.setLit(new Float32Array([1, 0, 0.5, 0, 0, 1]));
  const from = state.calls.length;
  r.draw({ frame: frameFor(8), wires: 1, pan: [0.1, 0.1], filter: 1 });
  assert.strictEqual(uniformCalls(state, from, "uniform2f", "uPan").length, 2);
  assert.strictEqual(uniformCalls(state, from, "uniform1f", "uFilter").length, 2);
});
