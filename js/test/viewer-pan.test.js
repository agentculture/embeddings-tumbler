"use strict";
// Panning (task t17 of the relative-search build, approved deviation): the user moves the
// picture without turning it. Right-drag and Shift + left-drag pan; left-drag turns as before;
// two fingers pan by their midpoint while their distance zooms; the arrow keys pan while the
// viewer has focus; every reset of the zoom resets the pan too. The pan is the renderer's draw
// key pan ([x, y] in units of R = min(W, H) * radius, x right, y up), so the points, the names,
// the panel's rings and the relative overlay all move together.
//
// On the fake DOM and GPU of helpers/, loaded from the source modules. Large arrays and DOM
// nodes are never handed to an equality assertion.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadSources();
const ET = api._internal;

function setup(mountOpts, domOpts) {
  const dom = makeFakeDom(domOpts);
  const h = api.mount(dom.host(), { seed: 3, ...mountOpts });
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(5);
  return { dom, h, v: h._viewer };
}

// Device pixels per pan unit: the renderer's R for the stage.
function unit(v) {
  return Math.min(v.W, v.H) * ET.renderer.DEFAULTS.radius;
}

function close(a, b, eps, msg) {
  assert.ok(Math.abs(a - b) <= (eps ?? 1e-9), (msg || "") + ": " + a + " vs " + b);
}

function press(s, opts) {
  return s.dispatchEvent({ type: "pointerdown", pointerId: 1, pointerType: "mouse", button: 0, ...opts });
}
function move(s, opts) {
  return s.dispatchEvent({ type: "pointermove", pointerId: 1, pointerType: "mouse", ...opts });
}
function lift(s, opts) {
  return s.dispatchEvent({ type: "pointerup", pointerId: 1, pointerType: "mouse", ...opts });
}

function key(v, k, extra) {
  return v.root.dispatchEvent({ type: "keydown", key: k, target: v.root, ...extra });
}

// ---------- gestures ----------

test("right-drag pans by the pointer's movement and does not turn", () => {
  const { dom, h, v } = setup();
  const s = v.stage;
  const yaw = v.drag.yaw;
  const pitch = v.drag.pitch;
  press(s, { button: 2, clientX: 100, clientY: 100 });
  assert.strictEqual(v.drag.active, true, "a pan drag pauses the idle spin like a turn drag");
  move(s, { clientX: 130, clientY: 80 });
  lift(s, { button: 2, clientX: 130, clientY: 80 });
  assert.strictEqual(v.drag.yaw, yaw, "no turn");
  assert.strictEqual(v.drag.pitch, pitch);
  const p = h.pan();
  close(p[0], (30 * v.dpr) / unit(v), 1e-12, "x right");
  close(p[1], (20 * v.dpr) / unit(v), 1e-12, "y up: the pointer went up 20 px");
  dom.frames(1);
  assert.deepStrictEqual(Array.from(v.lastDraw.pan), p, "the draw state carries the pan");
  h.destroy();
});

test("the idle spin does not advance during a pan drag", () => {
  const { dom, h, v } = setup();
  const s = v.stage;
  press(s, { button: 2, clientX: 10, clientY: 10 });
  const spin = v.spin;
  dom.frames(5);
  assert.strictEqual(v.spin, spin, "paused while held");
  lift(s, { button: 2, clientX: 10, clientY: 10 });
  dom.frames(5);
  assert.ok(v.spin > spin, "and runs again after");
  h.destroy();
});

test("Shift + left-drag pans; plain left-drag turns and does not pan", () => {
  const { h, v } = setup();
  const s = v.stage;
  press(s, { button: 0, shiftKey: true, clientX: 50, clientY: 50 });
  move(s, { clientX: 20, clientY: 90, shiftKey: true });
  lift(s, { clientX: 20, clientY: 90 });
  close(h.pan()[0], (-30 * v.dpr) / unit(v), 1e-12);
  close(h.pan()[1], (-40 * v.dpr) / unit(v), 1e-12);
  assert.strictEqual(v.drag.yaw, 0, "no turn");
  const before = h.pan();
  press(s, { button: 0, clientX: 100, clientY: 100 });
  move(s, { clientX: 140, clientY: 110 });
  lift(s, { clientX: 140, clientY: 110 });
  close(v.drag.yaw, 40 * 0.007, 1e-12, "turned as before");
  close(v.drag.pitch, 10 * 0.007, 1e-12);
  assert.deepStrictEqual(h.pan(), before, "no pan");
  h.destroy();
});

test("the middle button still does nothing", () => {
  const { h, v } = setup();
  press(v.stage, { button: 1, clientX: 50, clientY: 50 });
  move(v.stage, { clientX: 90, clientY: 50 });
  lift(v.stage, { button: 1, clientX: 90, clientY: 50 });
  assert.deepStrictEqual(h.pan(), [0, 0]);
  assert.strictEqual(v.drag.yaw, 0);
  h.destroy();
});

test("the context menu is suppressed on the sky only", () => {
  const { h, v } = setup();
  assert.strictEqual(v.canvas.dispatchEvent({ type: "contextmenu" }).defaultPrevented, true);
  assert.strictEqual(v.stage.dispatchEvent({ type: "contextmenu" }).defaultPrevented, true);
  assert.strictEqual(v.playButton.dispatchEvent({ type: "contextmenu" }).defaultPrevented, false);
  h.destroy();
});

test("two fingers pan by their midpoint while their distance still zooms", () => {
  const { h, v } = setup();
  const s = v.stage;
  const t = (type, id, x, y) => s.dispatchEvent({ type, pointerId: id, clientX: x, clientY: y, pointerType: "touch" });
  t("pointerdown", 1, 100, 100);
  t("pointerdown", 2, 200, 100);
  // both move right by 40 and down by 10: the distance is unchanged, so only a pan
  t("pointermove", 1, 140, 110);
  t("pointermove", 2, 240, 110);
  assert.strictEqual(h.zoom(), 1, "no zoom");
  close(h.pan()[0], (40 * v.dpr) / unit(v), 1e-12);
  close(h.pan()[1], (-10 * v.dpr) / unit(v), 1e-12);
  assert.strictEqual(v.drag.yaw, 0, "no turn");
  // now spread them apart symmetrically: a zoom with the midpoint, so the pan, unchanged
  const before = h.pan();
  t("pointermove", 1, 90, 110);
  t("pointermove", 2, 290, 110);
  assert.ok(h.zoom() > 1.9, "spreading zooms in: " + h.zoom());
  close(h.pan()[0], before[0], 1e-12);
  close(h.pan()[1], before[1], 1e-12);
  t("pointerup", 2, 290, 110);
  t("pointerup", 1, 90, 110);
  h.destroy();
});

test("arrow keys pan by a fixed step while the viewer has focus, not with Ctrl, Cmd or Alt", () => {
  const { h, v } = setup();
  const step = ET.viewer.PAN_STEP;
  assert.ok(step > 0 && step < 0.5, "a small fixed step: " + step);
  assert.strictEqual(key(v, "ArrowRight").defaultPrevented, true);
  close(h.pan()[0], step, 1e-12, "right moves the picture right");
  key(v, "ArrowUp");
  close(h.pan()[1], step, 1e-12, "up moves it up");
  key(v, "ArrowLeft");
  key(v, "ArrowLeft");
  key(v, "ArrowDown");
  close(h.pan()[0], -step, 1e-12);
  close(h.pan()[1], 0, 1e-12);
  const before = h.pan();
  for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
    assert.strictEqual(key(v, "ArrowRight", { [mod]: true }).defaultPrevented, false, mod);
  }
  // typed into a field inside the viewer: not taken
  key(v, "ArrowRight", { target: v.speedInput });
  assert.deepStrictEqual(h.pan(), before);
  h.destroy();
});

// ---------- the clamp ----------

test("the pan is clamped so the picture's centre stays on the stage", () => {
  const { dom, h, v } = setup();
  const el = v.root.parentNode;
  const lx = v.W / 2 / unit(v);
  const ly = v.H / 2 / unit(v);
  assert.deepStrictEqual(h.pan([100, -100]), [lx, -ly]);
  press(v.stage, { button: 2, clientX: 0, clientY: 0 });
  move(v.stage, { clientX: 5000, clientY: 5000 });
  lift(v.stage, { button: 2, clientX: 5000, clientY: 5000 });
  assert.deepStrictEqual(h.pan(), [lx, -ly]);
  for (let i = 0; i < 200; i++) key(v, "ArrowLeft");
  close(h.pan()[0], -lx, 1e-12);
  // the centre of the picture is at the stage's edge, not beyond
  dom.frames(1);
  const c = ET.renderer.place([0, 0, 0], v.lastDraw, v.W, v.H);
  close(c.x, 0, 1e-6, "left edge");
  close(c.y, v.H, 1e-6, "bottom edge");
  // a stage that shrinks re-clamps the pan held
  el.rect = { ...el.rect, width: 300 };
  dom.ro[0].trigger();
  assert.strictEqual(v.W, 300, "the stage is narrower");
  const l2 = v.W / 2 / unit(v);
  assert.ok(l2 < lx);
  close(h.pan()[0], -l2, 1e-12, "re-clamped to the smaller stage");
  // anything that is not two finite numbers resets it, like zoom()
  assert.deepStrictEqual(h.pan("nope"), [0, 0]);
  h.pan([0.1, 0.1]);
  assert.deepStrictEqual(h.pan([Number.NaN, 1]), [0, 0]);
  assert.deepStrictEqual(h.pan(), [0, 0], "a read changes nothing");
  h.destroy();
});

// ---------- reset ----------

function panAndZoom(h) {
  h.pan([0.3, -0.2]);
  h.zoom(2);
  assert.notDeepStrictEqual(h.pan(), [0, 0]);
}

test("every way of resetting the zoom resets the pan too", () => {
  const { h, v } = setup();
  const s = v.stage;
  const resets = {
    dblclick: () => s.dispatchEvent({ type: "dblclick" }),
    key0: () => key(v, "0"),
    button: () => v.zoomResetButton.click(),
    resetZoom: () => h.resetZoom(),
    resetView: () => h.resetView(),
    doubleTap: () => {
      for (const id of [5, 6]) {
        s.dispatchEvent({ type: "pointerdown", pointerId: id, clientX: 50, clientY: 50, pointerType: "touch" });
        s.dispatchEvent({ type: "pointerup", pointerId: id, clientX: 50, clientY: 50, pointerType: "touch" });
      }
    },
  };
  for (const [name, fn] of Object.entries(resets)) {
    panAndZoom(h);
    fn();
    assert.deepStrictEqual(h.pan(), [0, 0], name + " resets the pan");
    assert.strictEqual(h.zoom(), 1, name + " resets the zoom");
  }
  h.destroy();
});

test("the reset button is offered and named for the view, and the status line says the picture is moved", () => {
  const { dom, h, v } = setup();
  assert.strictEqual(v.zoomResetButton.textContent, "Reset view");
  assert.strictEqual(v.zoomResetButton.className.includes("tumbler-zoom-reset"), true, "the class is kept");
  dom.frames(10);
  assert.ok(!/moved/.test(h.info().status), h.info().status);
  h.pan([0.2, 0]);
  dom.frames(10);
  assert.notStrictEqual(v.zoomResetButton.style.display, "none", "offered at zoom 1 when panned");
  assert.ok(/ · moved/.test(h.info().status), h.info().status);
  assert.ok(!/zoom/.test(h.info().status), "zoom 1 is not mentioned");
  h.zoom(2);
  dom.frames(10);
  assert.ok(/ · zoom 2\.0× · moved/.test(h.info().status), h.info().status);
  h.resetView();
  dom.frames(10);
  assert.ok(!/moved|zoom/.test(h.info().status), h.info().status);
  h.destroy();
});

test("the hint names the pan gestures", () => {
  const { h, v } = setup();
  const hint = v.hint.textContent;
  assert.match(hint, /^Drag to turn; right-drag, Shift \+ drag or two fingers move\./);
  assert.match(hint, /arrows move/);
  assert.match(hint, /Pinch, or Ctrl \+ wheel, to zoom; double-click or double-tap resets\./);
  h.destroy();
});

// ---------- the draw state and everything placed from it ----------

test("with no pan the draw state carries no pan key; with one, labels move by the pan", () => {
  const { dom, h, v } = setup({ paused: true });
  dom.frames(2);
  assert.ok(!("pan" in v.lastDraw), "no pan key at rest");
  h.pan([0, 0]);
  dom.frames(1);
  assert.ok(!("pan" in v.lastDraw), "nor after setting zero");
  const sx = Array.from(v.sx.slice(0, 5));
  const sy = Array.from(v.sy.slice(0, 5));
  const n = sx.length;
  assert.ok(n > 0);
  h.pan([0.25, 0.1]);
  dom.frames(1);
  for (let j = 0; j < n; j++) {
    close(v.sx[j] - sx[j], 0.25 * unit(v), 1e-3, "label x " + j); // float32 positions
    close(v.sy[j] - sy[j], -0.1 * unit(v), 1e-3, "label y " + j);
  }
  h.destroy();
});

// ---------- the relative overlay ----------

const FIX = path.join(ROOT, "tests", "fixtures", "relative");
function fixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".json"), "utf8"));
  const buf = fs.readFileSync(path.join(FIX, meta.vectors.file));
  const n = meta.count * meta.dimension;
  const vectors = new Float32Array(n);
  for (let i = 0; i < n; i++) vectors[i] = buf.readFloatLE(i * 4);
  return { ...meta, vectors };
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

test("the relative overlay's ruler, stems and origin move by the pan; heights still agree with the ruler", async () => {
  const dom = makeFakeDom();
  const h = api.mount(dom.host(), { seed: 3, mode: "tumble", paused: true, searchPanel: false, relative: true });
  const v = h._viewer;
  const data = fixture("wikipedia-subset");
  h.update(data);
  await until(dom, () => h.info().ready && !h.info().preparing);
  const rice = data.points.find((p) => p.label === "Rice").id;
  let done = false;
  h.setSearches([{ point: rice }]).then(() => (done = true));
  await until(dom, () => done);
  await until(dom, () => h.info().search.relative.active && !h.info().preparing);
  h.seek(h.time() + 2);
  dom.frames(12);
  assert.strictEqual(h.info().search.relative.settled, true);
  h.setRelative({ showOrigin: true });
  dom.frames(1);
  const a = v.relativeDrawn;
  assert.ok(a?.ruler && a.results.length > 0 && a.origin, "ruler, stems and origin drawn");
  const pan = [0.2, -0.15];
  h.pan(pan);
  dom.frames(1);
  const b = v.relativeDrawn;
  const dx = pan[0] * unit(v);
  const dy = -pan[1] * unit(v);
  close(b.ruler.x0 - a.ruler.x0, dx, 1e-6, "ruler x0");
  close(b.ruler.y0 - a.ruler.y0, dy, 1e-6, "ruler y0");
  close(b.ruler.x1 - a.ruler.x1, dx, 1e-6, "ruler x1");
  close(b.ruler.y1 - a.ruler.y1, dy, 1e-6, "ruler y1");
  close(b.origin.x - a.origin.x, dx, 1e-6, "origin x");
  close(b.origin.y - a.origin.y, dy, 1e-6, "origin y");
  assert.strictEqual(b.results.length, a.results.length);
  b.results.forEach((r, k) => {
    assert.strictEqual(r.index, a.results[k].index);
    close(r.x - a.results[k].x, dx, 1e-6, "result x " + k);
    close(r.y - a.results[k].y, dy, 1e-6, "result y " + k);
    close(r.rulerY, r.y, 1, "height on the ruler agrees with the drawn height " + k);
    close(r.mappedY, r.y, 1, "and with the straight ruler " + k);
  });
  h.destroy();
});
