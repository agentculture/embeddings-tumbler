"use strict";
// Unit tests for js/src/50-viewer.js: mount / update / destroy, refusals, provenance,
// literal labels, lifecycle and pausing. The DOM is helpers/fake-dom.js and the GPU
// helpers/fake-gl.js; the real thing is tests/browser/test_viewer_render.py.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeDom, walk } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();

function setup(domOpts, mountOpts) {
  const dom = makeFakeDom(domOpts);
  const el = dom.host();
  const h = api.mount(el, Object.assign({ seed: 3 }, mountOpts || {}));
  return { dom, el, h, v: h._viewer };
}

function textOf(el) {
  return el.textContent;
}

function allText(root) {
  return root.textContent;
}

// ---------- criterion 1: mount stays inside the element; replace; append ----------

test("mount appends exactly one child to the element and touches nothing else", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  const bodyBefore = dom.document.body.children.length;
  const headBefore = dom.document.head.children.length;
  const winKeysBefore = Object.keys(dom.window).sort().join(",");
  const h = api.mount(el, { seed: 1 });
  assert.strictEqual(el.children.length, 1);
  assert.strictEqual(el.children[0].className, "tumbler");
  assert.strictEqual(dom.document.body.children.length, bodyBefore, "nothing added to body");
  assert.strictEqual(dom.document.head.children.length, headBefore, "nothing added to head");
  assert.strictEqual(dom.document.body.className, "", "no class on body");
  assert.strictEqual(dom.document.documentElement.className, "");
  assert.strictEqual(el.className, "", "the host element itself is not restyled or reclassed");
  assert.deepStrictEqual(Object.keys(el.style).filter((k) => k !== "_custom"), []);
  assert.strictEqual(Object.keys(dom.window).sort().join(","), winKeysBefore, "no globals added");
  // Only the document's visibility listener (ResizeObserver exists, so no window resize).
  assert.strictEqual(dom.document.listenerCount(), 1);
  assert.strictEqual(dom.windowListenerCount(), 0);
  assert.ok(!dom.document.created.includes("style"), "no style element is created");
  assert.ok(!dom.document.created.includes("script"));
  h.destroy();
});

test("without ResizeObserver it listens to window resize, and removes it on destroy", () => {
  const { dom, h } = setup({ noResizeObserver: true });
  assert.strictEqual(dom.windowListenerCount(), 1);
  h.destroy();
  assert.strictEqual(dom.windowListenerCount(), 0);
});

test("update with a full set replaces the view and returns a result", () => {
  const { dom, h, v } = setup();
  const r1 = h.update(makeSet({ n: 90, d: 12 }));
  assert.deepStrictEqual(r1, { ok: true, op: "replace", count: 90, added: 90 });
  dom.frames(3);
  assert.strictEqual(v.renderer.status().count, 90);
  assert.strictEqual(v.renderer.status().dimension, 12);
  const r2 = h.update(makeSet({ n: 40, d: 20, model: "other/model", seed: 9 }));
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.count, 40);
  dom.frames(3);
  assert.strictEqual(v.renderer.status().count, 40);
  assert.strictEqual(v.renderer.status().dimension, 20);
  assert.match(allText(v.provenance), /other\/model/);
  assert.strictEqual(h.info().dimension, 20);
  h.destroy();
});

test("module-level update(el, data) and destroy(el) work on the mounted element", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  api.mount(el);
  const r = api.update(el, makeSet({ n: 30 }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(api.get(el).info().count, 30);
  assert.strictEqual(api.destroy(el), true);
  assert.strictEqual(api.get(el), null);
  assert.strictEqual(el.children.length, 0);
});

test("append adds points without resetting the camera or dropping points", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 150, d: 16 }));
  dom.frames(40); // prepare, then run
  assert.ok(h.info().ready);
  h.pause();
  dom.frames(2);
  const t = h.time();
  assert.ok(t > 0, "the clock ran before the pause");
  const before = new Float32Array(v.last.frame);
  const yawBefore = v.lastDraw.yaw;
  const res = h.update(makeSet({ n: 30, d: 16, op: "append", idPrefix: "q", seed: 99 }));
  assert.deepStrictEqual(res, { ok: true, op: "append", count: 180, added: 30 });
  dom.frames(1);
  assert.strictEqual(h.time(), t, "the mode clock did not restart");
  assert.deepStrictEqual(Array.from(v.last.frame), Array.from(before), "same frame at the same time");
  assert.strictEqual(v.lastDraw.yaw, yawBefore, "the viewer's own turn is kept");
  assert.strictEqual(v.renderer.status().count, 180, "every point is on the GPU copy");
  assert.strictEqual(h.info().count, 180);
  // Old points are still there in order.
  assert.strictEqual(v.set.points[0].id, "p00000");
  assert.strictEqual(v.set.points[150].id, "q00000");
  assert.match(allText(v.provenance), /180/);
  h.destroy();
});

test("an append uses the renderer's append path, not a full re-upload", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 64, d: 8 }));
  dom.frames(5);
  let setDataCalls = 0;
  let appendCalls = 0;
  const r = v.renderer;
  const origSet = r.setData;
  const origAppend = r.appendData;
  r.setData = function () {
    setDataCalls++;
    return origSet.apply(this, arguments);
  };
  r.appendData = function (a) {
    appendCalls++;
    assert.strictEqual(a.vectors.length, 5 * 8, "only the new rows are handed over");
    return origAppend.apply(this, arguments);
  };
  h.update(makeSet({ n: 5, d: 8, op: "append", idPrefix: "z" }));
  assert.strictEqual(setDataCalls, 0);
  assert.strictEqual(appendCalls, 1);
  h.destroy();
});

test("the first points appended onto an empty set start the view", () => {
  const { dom, h, v } = setup();
  const empty = makeSet({ n: 0, d: 8 });
  assert.strictEqual(h.update(empty).ok, true);
  dom.frames(3);
  assert.match(v.status.textContent, /no points yet/);
  const r = h.update(makeSet({ n: 20, d: 8, op: "append" }));
  assert.strictEqual(r.ok, true);
  dom.frames(20);
  assert.strictEqual(v.renderer.status().count, 20);
  assert.ok(h.info().ready);
  h.destroy();
});

test("Tumble refits after appends go quiet, and says the share is stale until then", () => {
  const { dom, h, v } = setup({}, { refitQuietSeconds: 0.5 });
  h.update(makeSet({ n: 200, d: 16 }));
  dom.frames(30);
  h.update(makeSet({ n: 50, d: 16, op: "append", idPrefix: "a" }));
  dom.frames(3);
  assert.match(v.status.textContent + v.provView.textContent, /before 50 new points/);
  dom.frames(60); // > 0.5 s of frames
  assert.strictEqual(h.info().timing.refits, 1);
  dom.frames(10);
  assert.doesNotMatch(v.provView.textContent, /before/);
  h.destroy();
});

// ---------- criterion 2: invalid data ----------

test("invalid data shows a plain message inside the element and never throws", () => {
  const { dom, el, h, v } = setup();
  const errors = [];
  v.options.onError = (e) => errors.push(e);
  for (const bad of [undefined, null, 42, "text", {}, { kind: "embeddings-tumbler/data" }, []]) {
    let r;
    assert.doesNotThrow(() => {
      r = h.update(bad);
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(typeof r.code, "string");
    assert.strictEqual(typeof r.message, "string");
    assert.ok(el.contains(v.fatal));
    assert.strictEqual(v.fatal.style.display, "flex");
    assert.strictEqual(v.fatalText.textContent, r.message);
  }
  assert.strictEqual(errors.length, 7);
  // A hostile object with a throwing getter.
  const hostile = makeSet();
  Object.defineProperty(hostile, "model", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => h.update(hostile));
  dom.frames(2);
  h.destroy();
});

test("a refused append leaves the running view unchanged and shows a notice", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16 }));
  dom.frames(20);
  const count = v.renderer.status().count;
  const set = v.set;
  const r = h.update(makeSet({ n: 3, d: 8, op: "append", idPrefix: "x" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "dimension-mismatch");
  assert.strictEqual(v.set, set, "the set held is the same object");
  assert.strictEqual(v.renderer.status().count, count);
  assert.strictEqual(v.notice.style.display, "flex");
  assert.strictEqual(v.noticeText.textContent, r.message);
  assert.notStrictEqual(v.fatal.style.display, "flex", "the view is not covered");
  assert.ok(dom.pendingFrames() > 0, "the loop is still running");
  const m = h.update(makeSet({ n: 2, d: 16, op: "append", model: "another/model", idPrefix: "y" }));
  assert.strictEqual(m.code, "model-mismatch");
  const dup = h.update(makeSet({ n: 2, d: 16, op: "append" }));
  assert.strictEqual(dup.code, "id-exists");
  // A good update clears the notice.
  assert.strictEqual(h.update(makeSet({ n: 2, d: 16, op: "append", idPrefix: "w" })).ok, true);
  assert.strictEqual(v.notice.style.display, "none");
  h.destroy();
});

test("update on an element with no viewer returns a refusal, not an exception", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  const r = api.update(el, makeSet());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "not-mounted");
  assert.strictEqual(api.update(null, makeSet()).code, "not-mounted");
});

// ---------- criterion 3: provenance ----------

test("the provenance block shows source, model, dimension, count, seed, view, reduction and the shadow sentence", () => {
  const { dom, h, v } = setup();
  h.update(
    makeSet({
      n: 75,
      d: 16,
      model: "Qwen/Qwen3-Embedding-0.6B",
      provenance: {
        source: "atlas: docs/studies/atlas-plain",
        producer: "embeddings-cli 0.9.0",
        synthetic: false,
        seed: 1234,
        endpoint: "lobes gateway",
        created: "2026-11-13T19:00:00Z",
        limitations: ["vectors were embedded live"],
        uncertain: ["the ring may be an artefact"],
      },
      reduction: { kind: "top-k", source_dimension: 1024, directions_kept: 16, variance_dropped: 0.25 },
    })
  );
  dom.frames(30);
  const t = allText(v.provenance);
  for (const want of [
    "atlas: docs/studies/atlas-plain",
    "Qwen/Qwen3-Embedding-0.6B",
    "Dimension",
    "16 (reduced from 1,024)",
    "75",
    "Seed (view)",
    "Seed (source)",
    "1234",
    "Tumble",
    "linear",
    "of the variance",
    "top-k: 16 of 1,024 directions kept, 25.0% of the variance dropped",
    "approximation",
    "embeddings-cli 0.9.0",
    "lobes gateway",
    "2026-11-13T19:00:00Z",
    "vectors were embedded live",
    "the ring may be an artefact",
    "shadow of the space",
  ]) {
    assert.ok(t.includes(want), "provenance lacks: " + want + "\n" + t);
  }
  assert.ok(t.includes("3"), "the view seed (3) is shown");
  assert.ok(!/synthetic/i.test(v.provList.textContent), "not marked synthetic when it is not");
  h.destroy();
});

test("provenance marks synthetic data, rotations, and labels-only sets", () => {
  const { dom, h, v } = setup();
  h.update(
    makeSet({
      n: 30,
      d: 8,
      text_included: false,
      labelFor: (i, id) => id,
      reduction: { kind: "rotation", source_dimension: 8, directions_kept: 8, variance_dropped: 0 },
    })
  );
  dom.frames(2);
  const t = allText(v.provenance);
  assert.match(t, /Synthetic/);
  assert.match(t, /generated, not produced by the named model/);
  assert.match(t, /exact rotation/);
  assert.match(t, /point ids only/);
  assert.match(t, /made up for a unit test/);
  h.destroy();
});

test("the view row follows the mode", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16 }));
  dom.frames(10);
  assert.match(v.provView.textContent, /^Tumble: linear/);
  assert.strictEqual(h.setMode("lattice"), true);
  dom.frames(10);
  assert.match(v.provView.textContent, /^Lattice: linear/);
  h.setMode("wander");
  dom.frames(10);
  assert.match(v.provView.textContent, /^Wander: linear/);
  h.destroy();
});

// ---------- criterion 4: markup in labels is text ----------

test("labels and group names containing markup are shown as literal text", () => {
  const evil = "<img src=x onerror=alert(1)><b>b</b>"; // under the 40-character cut
  const { dom, h, v } = setup();
  h.update(
    makeSet({
      n: 60,
      d: 16,
      groups: ["<script>x</script>", "plain"],
      labelEvery: 1,
      labelFor: (i) => (i === 0 ? evil : "w" + i),
    })
  );
  dom.frames(30);
  const labelsText = v.labelLayer.textContent;
  assert.ok(labelsText.includes("<script>x</script>"), "group name shown literally: " + labelsText);
  // Hover exactly over point 0 (paused, so it stays put): its markup label shows as text.
  h.pause();
  dom.frames(2);
  assert.strictEqual(v.labelSample[0], 0);
  v.stage.dispatchEvent({ type: "pointermove", pointerId: 1, pointerType: "mouse", clientX: v.sx[0] / v.dpr, clientY: v.sy[0] / v.dpr });
  dom.frames(1);
  assert.ok(v.labelLayer.textContent.includes(evil), "the hovered markup label is shown literally");
  // Wander's status line names stops: it is text too.
  h.setMode("wander");
  dom.frames(400);
  const tags = walk(v.root).map((e) => e.tagName);
  assert.ok(!tags.includes("IMG") && !tags.includes("SCRIPT"), "no element made from data");
  assert.ok(v.labelLayer.textContent.length > 0);
  h.destroy();
});

test("a markup label in Wander's status line stays text", () => {
  const evil = "<i>stop</i>";
  const { dom, h, v } = setup({}, { mode: "wander" });
  h.update(makeSet({ n: 40, d: 16, labelEvery: 1, labelFor: () => evil }));
  dom.frames(300);
  assert.ok(v.status.textContent.includes(evil), v.status.textContent);
  assert.strictEqual(v.status.children.length, 0, "status holds one text node, no elements");
  h.destroy();
});

// ---------- criterion 5: destroy and pausing ----------

test("destroy stops the loop, disconnects observers, removes listeners and frees GPU objects", () => {
  const { dom, el, h, v } = setup();
  h.update(makeSet({ n: 80, d: 16 }));
  dom.frames(20);
  const gl = dom.env.glStates[0];
  assert.ok(gl.live.size > 0);
  assert.ok(dom.pendingFrames() > 0);
  const io = dom.io[0];
  const ro = dom.ro[0];
  assert.strictEqual(h.destroy(), true);
  assert.strictEqual(dom.pendingFrames(), 0, "no animation frame left");
  assert.ok(io.disconnected && ro.disconnected);
  assert.strictEqual(dom.listenerBalance(), 0, "every listener removed");
  assert.strictEqual(gl.live.size, 0, "every GPU object released");
  const deleted = gl.calls.filter((c) => /^delete/.test(c[0])).length;
  assert.ok(deleted > 0, "deleted explicitly");
  assert.strictEqual(el.children.length, 0);
  assert.strictEqual(dom.frames(10), 0);
  // Second destroy and destroy of a never-mounted element are no-ops.
  assert.strictEqual(h.destroy(), false);
  assert.strictEqual(api.destroy(dom.host()), false);
  assert.strictEqual(api.destroy(null), false);
  const r = h.update(makeSet());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, "destroyed");
  assert.strictEqual(v.destroyed, true);
});

test("mounting and destroying twenty times leaves nothing behind", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  for (let i = 0; i < 20; i++) {
    const h = api.mount(el);
    h.update(makeSet({ n: 20, d: 8 }));
    dom.frames(2);
    h.destroy();
  }
  assert.strictEqual(dom.pendingFrames(), 0);
  assert.strictEqual(dom.listenerBalance(), 0);
  assert.strictEqual(el.children.length, 0);
  assert.ok(dom.io.every((o) => o.disconnected));
  assert.ok(dom.env.glStates.every((s) => s.live.size === 0));
});

test("while the document is hidden no frame is requested and no frame work runs", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16 }));
  dom.frames(20);
  const t = h.time();
  const frames = v.frames;
  const draws = dom.env.glStates[0].draws.length;
  dom.document.setHidden(true);
  assert.strictEqual(dom.pendingFrames(), 0, "the frame request was cancelled");
  assert.strictEqual(h.info().suspended, true);
  dom.advance(60000);
  assert.strictEqual(dom.frames(30), 0);
  assert.strictEqual(v.frames, frames);
  assert.strictEqual(dom.env.glStates[0].draws.length, draws, "no draw calls");
  // Work that would ask for a frame while hidden does not get one.
  h.zoom(2);
  assert.strictEqual(dom.pendingFrames(), 0);
  dom.document.setHidden(false);
  assert.ok(dom.pendingFrames() > 0);
  dom.flush(60000); // a long gap: the clock must not jump
  assert.ok(h.time() - t < 0.06, "elapsed time advanced by at most one clamped frame");
  h.destroy();
});

test("while the element is off screen no frame work runs", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16 }));
  dom.frames(10);
  const frames = v.frames;
  dom.io[0].trigger(false);
  assert.strictEqual(dom.pendingFrames(), 0);
  assert.strictEqual(dom.frames(20), 0);
  assert.strictEqual(v.frames, frames);
  dom.io[0].trigger(true);
  assert.ok(dom.frames(3) > 0);
  assert.ok(v.frames > frames);
  h.destroy();
});

test("a frame that fires after the page was hidden does nothing", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 30, d: 16 }));
  dom.frames(5);
  dom.document.hidden = true; // hidden without the event yet
  const frames = v.frames;
  dom.flush();
  assert.strictEqual(v.frames, frames);
  assert.strictEqual(dom.pendingFrames(), 0);
  h.destroy();
});

test("prefers-reduced-motion starts paused with a Play control", () => {
  const { dom, h, v } = setup({ reducedMotion: true });
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(30);
  assert.strictEqual(h.isPaused(), true);
  assert.strictEqual(v.playButton.textContent, "Play");
  assert.strictEqual(h.time(), 0);
  assert.strictEqual(v.lastDraw.twinkle, 0);
  // Paused and reduced: the loop goes idle once nothing changes.
  dom.frames(5);
  assert.strictEqual(dom.pendingFrames(), 0);
  v.playButton.click();
  assert.strictEqual(h.isPaused(), false);
  dom.frames(10);
  assert.ok(h.time() > 0);
  h.destroy();
});

test("pause, resume, seek and time", () => {
  const { dom, h } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(30);
  h.pause();
  const t = h.time();
  dom.frames(10);
  assert.strictEqual(h.time(), t);
  assert.strictEqual(h.seek(5), 5);
  assert.strictEqual(h.time(), 5);
  h.resume();
  dom.frames(1);
  assert.ok(h.time() > 5);
  h.destroy();
});

test("same data, seed and elapsed time give the same frame", () => {
  function frameAt(seed, t) {
    const { dom, h, v } = setup({}, { seed, paused: true });
    h.update(makeSet({ n: 80, d: 16 }));
    dom.frames(30);
    h.seek(t);
    dom.frames(1);
    const out = { frame: Array.from(v.last.frame), yaw: v.lastDraw.yaw };
    h.destroy();
    return out;
  }
  assert.deepStrictEqual(frameAt(5, 3.25), frameAt(5, 3.25));
  assert.notDeepStrictEqual(frameAt(5, 3.25).frame, frameAt(5, 1).frame);
});

// ---------- the rest of the brief ----------

test("while a mode prepares the status says so and the clock waits for ready", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 2000, d: 64 }));
  dom.flush();
  assert.ok(!h.info().ready, "Tumble prepares over several frames");
  assert.match(v.status.textContent, /finding the strongest directions/);
  assert.strictEqual(h.time(), 0, "no motion before ready");
  let n = 0;
  while (!h.info().ready && n++ < 500) dom.flush();
  assert.ok(h.info().ready);
  dom.frames(3);
  assert.ok(h.time() > 0);
  h.destroy();
});

test("mode buttons and keys switch modes; keys only on the viewer, never on the document", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(5);
  const lattice = v.modeButtons.find((m) => m.id === "lattice").button;
  lattice.click();
  assert.strictEqual(h.mode(), "lattice");
  assert.strictEqual(lattice.getAttribute("aria-pressed"), "true");
  v.root.dispatchEvent({ type: "keydown", key: "3", target: v.root });
  assert.strictEqual(h.mode(), "wander");
  v.root.dispatchEvent({ type: "keydown", key: "1", target: v.root });
  assert.strictEqual(h.mode(), "tumble");
  assert.ok(!dom.document.listeners.keydown, "no document key listener");
  // Keys typed into a control inside the viewer are not grabbed.
  v.root.dispatchEvent({ type: "keydown", key: "2", target: v.speedInput });
  assert.strictEqual(h.mode(), "tumble");
  h.destroy();
});

test("mode switch hands the last frame to the next mode", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16 }));
  dom.frames(40);
  h.pause();
  dom.frames(1);
  const before = Array.from(v.last.frame);
  h.setMode("lattice");
  dom.frames(1);
  const after = Array.from(v.last.frame);
  const diff = Math.max(...before.map((x, i) => Math.abs(x - after[i])));
  assert.ok(diff < 1e-5, "no jump on switching: " + diff);
  h.destroy();
});

test("wheel zooms only with a modifier or while focused; double-click resets", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(5);
  dom.document.activeElement = dom.document.body;
  const plain = v.stage.dispatchEvent({ type: "wheel", deltaY: 100 });
  assert.strictEqual(plain.defaultPrevented, false, "page scroll is not taken");
  assert.strictEqual(h.zoom(), 1);
  const pinch = v.stage.dispatchEvent({ type: "wheel", deltaY: -20, ctrlKey: true });
  assert.strictEqual(pinch.defaultPrevented, true);
  assert.ok(h.zoom() > 1);
  v.stage.dispatchEvent({ type: "dblclick" });
  assert.strictEqual(h.zoom(), 1);
  v.root.focus();
  const focused = v.stage.dispatchEvent({ type: "wheel", deltaY: 200 });
  assert.strictEqual(focused.defaultPrevented, true);
  assert.ok(h.zoom() < 1);
  // User zoom multiplies the mode's automatic zoom.
  dom.frames(1);
  assert.ok(Math.abs(v.lastDraw.zoom - v.last.draw.zoom * h.zoom()) < 1e-9);
  v.zoomResetButton.click();
  assert.strictEqual(h.zoom(), 1);
  h.destroy();
});

test("pinch with two pointers zooms; one pointer turns", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(5);
  const s = v.stage;
  s.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 100, clientY: 100, pointerType: "touch" });
  s.dispatchEvent({ type: "pointermove", pointerId: 1, clientX: 140, clientY: 100, pointerType: "touch" });
  assert.ok(v.drag.yaw > 0, "a drag turns the cloud");
  s.dispatchEvent({ type: "pointerdown", pointerId: 2, clientX: 200, clientY: 100, pointerType: "touch" });
  s.dispatchEvent({ type: "pointermove", pointerId: 2, clientX: 260, clientY: 100, pointerType: "touch" });
  assert.ok(h.zoom() > 1, "spreading two fingers zooms in");
  s.dispatchEvent({ type: "pointerup", pointerId: 2, clientX: 260, clientY: 100, pointerType: "touch" });
  s.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 140, clientY: 100, pointerType: "touch" });
  assert.strictEqual(v.stage.style.touchAction, "pan-y", "vertical page scroll still works on touch");
  h.destroy();
});

test("the readout strip has one cell per dimension at any dimension", () => {
  for (const d of [16, 384, 1024, 2560]) {
    const { dom, h, v } = setup();
    h.update(makeSet({ n: 12, d, groups: ["a"] }));
    dom.frames(3);
    assert.strictEqual(v.strip.width, d);
    const puts = v.strip.getContext("2d")._rec.puts;
    assert.ok(puts.length > 0);
    assert.strictEqual(puts[puts.length - 1].width, d);
    assert.match(v.stripLast.textContent, new RegExp("dimension " + d.toLocaleString("en-US")));
    h.destroy();
  }
});

test("theme comes from the host's custom properties, with defaults", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el);
  const v = h._viewer;
  assert.strictEqual(v.root.style.background, "rgb(4, 6, 11)", "default background");
  assert.strictEqual(v.canvas.style.mixBlendMode, "screen");
  el.style.setProperty("--tumbler-background", "#ffffff");
  el.style.setProperty("--tumbler-light-style", "ink");
  el.style.setProperty("--tumbler-accent", "rgb(200, 10, 20)");
  el.style.setProperty("--tumbler-font", '"Host Sans", sans-serif');
  el.style.setProperty("--tumbler-group-1", "#00ff00");
  h.refreshTheme();
  assert.strictEqual(v.root.style.background, "rgb(255, 255, 255)");
  assert.strictEqual(v.root.style.fontFamily, '"Host Sans", sans-serif');
  assert.strictEqual(v.status.style.color, "rgb(200, 10, 20)");
  assert.strictEqual(v.canvas.style.mixBlendMode, "multiply", "light host: points drawn as ink");
  assert.match(v.canvas.style.filter, /invert/);
  // The host's group colour is used for the first group.
  h.update(makeSet({ n: 6, d: 8, groups: ["only"], labelEvery: 100 }));
  const col = v.groupNames.length && v.theme.groups[0];
  assert.deepStrictEqual(col, [0, 1, 0]);
  // A value that names a resource is ignored.
  el.style.setProperty("--tumbler-font", "x; background: u" + "rl(evil)");
  h.refreshTheme();
  assert.notStrictEqual(v.root.style.fontFamily, "x; background: u" + "rl(evil)");
  h.destroy();
});

test("WebGL unavailable: a plain message inside the element, provenance still shown, no throw", () => {
  const { dom, el, h, v } = setup({ noWebGL2: true });
  assert.strictEqual(v.fatal.style.display, "flex");
  assert.match(v.fatalText.textContent, /WebGL 2/);
  let r;
  assert.doesNotThrow(() => {
    r = h.update(makeSet({ n: 20, d: 8 }));
  });
  assert.strictEqual(r.ok, true);
  assert.doesNotThrow(() => dom.frames(10));
  assert.match(v.provenance.textContent, /test\/model/);
  assert.match(v.fatalText.textContent, /WebGL 2/, "the graphics message stays");
  const bad = h.update({});
  assert.strictEqual(bad.ok, false);
  assert.match(v.fatalText.textContent, /WebGL 2/, "a refusal does not hide the graphics message");
  assert.ok(el.contains(v.notice));
  h.destroy();
});

test("context loss shows a message and a restore clears it", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 30, d: 8 }));
  dom.frames(5);
  const gl = v.canvas.getContext("webgl2");
  const ext = gl.getExtension("WEBGL_lose_context");
  ext.loseContext();
  assert.match(v.noticeText.textContent, /lost/);
  assert.doesNotThrow(() => dom.frames(5));
  ext.restoreContext();
  assert.strictEqual(v.notice.style.display, "none");
  dom.frames(5);
  h.destroy();
});

test("two viewers on one page are independent", () => {
  const dom = makeFakeDom();
  const a = api.mount(dom.host(), { mode: "lattice" });
  const b = api.mount(dom.host(), { mode: "wander" });
  a.update(makeSet({ n: 40, d: 16 }));
  b.update(makeSet({ n: 25, d: 8, model: "m2" }));
  dom.frames(10);
  assert.strictEqual(a.info().count, 40);
  assert.strictEqual(b.info().count, 25);
  assert.strictEqual(a.mode(), "lattice");
  assert.strictEqual(b.mode(), "wander");
  a.pause();
  assert.strictEqual(b.isPaused(), false);
  a.destroy();
  const t = b.time();
  dom.frames(10);
  assert.ok(b.time() > t, "the other viewer keeps running");
  b.destroy();
  assert.strictEqual(dom.listenerBalance(), 0);
});

test("mount twice on the same element returns the same handle", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  const a = api.mount(el, { mode: "lattice" });
  const b = api.mount(el, { mode: "wander" });
  assert.strictEqual(a, b);
  assert.strictEqual(el.children.length, 1);
  assert.strictEqual(b.mode(), "lattice", "options of the second call are ignored");
  a.destroy();
});

test("mount rejects something that is not an element with a TypeError", () => {
  assert.throws(() => api.mount(null), TypeError);
  assert.throws(() => api.mount({}), TypeError);
});

test("controls are real buttons with accessible names; the canvas has a text alternative", () => {
  const { h, v } = setup();
  h.update(makeSet({ n: 20, d: 24, model: "acc/model" }));
  for (const mb of v.modeButtons) {
    assert.strictEqual(mb.button.tagName, "BUTTON");
    assert.ok(mb.button.textContent.trim().length > 0);
  }
  assert.strictEqual(v.playButton.tagName, "BUTTON");
  assert.strictEqual(v.zoomResetButton.tagName, "BUTTON");
  assert.strictEqual(v.canvas.getAttribute("role"), "img");
  assert.match(v.canvas.getAttribute("aria-label"), /24-dimensional .*20 points from acc\/model/);
  assert.strictEqual(v.status.tagName, "P");
  assert.strictEqual(v.root.tabIndex, 0);
  h.destroy();
});

test("a narrow element hides the mode summaries so controls wrap instead of overlapping", () => {
  const dom = makeFakeDom();
  const el = dom.host({ width: 390 });
  const h = api.mount(el);
  const v = h._viewer;
  assert.strictEqual(v.modeButtons[0].summary.style.display, "none");
  assert.strictEqual(v.controlsEl.style.flexWrap, "wrap");
  assert.strictEqual(v.status.style.whiteSpace, "normal");
  el.rect.width = 900;
  dom.ro[0].trigger();
  assert.strictEqual(v.modeButtons[0].summary.style.display, "");
  h.destroy();
});

test("a set with too few dimensions for the chosen mode falls back with a message", () => {
  const { dom, h, v } = setup({}, { mode: "lattice" });
  const r = h.update(makeSet({ n: 10, d: 3, groups: ["a"] }));
  assert.strictEqual(r.ok, true);
  assert.match(v.noticeText.textContent, /Lattice needs at least 4/);
  assert.strictEqual(h.mode(), "tumble");
  assert.doesNotThrow(() => dom.frames(5));
  h.destroy();
});

// ---------- fixes from the live test ----------

test("a press on a control inside the stage is not a drag and does not capture the pointer", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(5);
  h.update({});
  assert.strictEqual(v.notice.style.display, "flex");
  let captures = 0;
  v.stage.setPointerCapture = () => captures++;
  const down = v.noticeDismiss.dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 5, clientY: 5, button: 0, pointerType: "mouse" });
  assert.strictEqual(captures, 0, "no pointer capture for a press on a button");
  assert.strictEqual(down.defaultPrevented, false);
  assert.strictEqual(v.drag.active, false, "no drag starts on a control");
  v.noticeDismiss.dispatchEvent({ type: "pointermove", pointerId: 1, clientX: 80, clientY: 5, pointerType: "mouse" });
  assert.strictEqual(v.drag.yaw, 0, "moving from a control does not turn the camera");
  v.noticeDismiss.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 80, clientY: 5, pointerType: "mouse" });
  v.noticeDismiss.click();
  assert.strictEqual(v.notice.style.display, "none");
  // A double-click on a control does not reset the zoom.
  h.zoom(2);
  h.update({});
  v.noticeDismiss.dispatchEvent({ type: "dblclick" });
  assert.strictEqual(h.zoom(), 2);
  // A press on the sky still turns and captures.
  v.canvas.dispatchEvent({ type: "pointerdown", pointerId: 2, clientX: 10, clientY: 10, button: 0, pointerType: "mouse" });
  assert.strictEqual(captures, 1);
  assert.strictEqual(v.drag.active, true);
  h.destroy();
});

test("Escape dismisses the notice while the viewer has focus", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 30, d: 16 }));
  dom.frames(2);
  h.update({ kind: "nope" });
  assert.strictEqual(v.notice.style.display, "flex");
  v.root.dispatchEvent({ type: "keydown", key: "Escape", target: v.noticeDismiss });
  assert.strictEqual(v.notice.style.display, "none");
  h.destroy();
});

test("an empty mounted viewer says plainly that it has no data, with no provenance block", () => {
  const { dom, h, v } = setup();
  dom.frames(2);
  assert.notStrictEqual(v.empty.style.display, "none");
  assert.match(v.empty.textContent, /No data yet\. Call update\(data\)/);
  assert.strictEqual(v.provenance.style.display, "none");
  assert.strictEqual(v.readout.style.display, "none");
  h.update(makeSet({ n: 20, d: 8 }));
  assert.strictEqual(v.empty.style.display, "none");
  assert.notStrictEqual(v.provenance.style.display, "none");
  assert.notStrictEqual(v.readout.style.display, "none");
  // A refusal with nothing to show replaces the hint with the message.
  const { h: h2, v: v2 } = setup();
  h2.update({});
  assert.strictEqual(v2.empty.style.display, "none");
  assert.strictEqual(v2.fatal.style.display, "flex");
  h.destroy();
  h2.destroy();
});

function themed(props) {
  const dom = makeFakeDom();
  const el = dom.host();
  for (const k of Object.keys(props)) el.style.setProperty(k, props[k]);
  const h = api.mount(el);
  const v = h._viewer;
  const uploads = [];
  const orig = v.renderer.setData;
  v.renderer.setData = function (a) {
    uploads.push(Float32Array.from(a.colours));
    return orig.apply(this, arguments);
  };
  h.update(makeSet({ n: 12, d: 8, groups: ["red"], labelEvery: 100 }));
  dom.frames(3);
  return { dom, el, h, v, uploads };
}

test("light background, dark stage panel: the stage keeps the night sky and screen blending", () => {
  const { h, v, uploads } = themed({ "--tumbler-background": "#ffffff", "--tumbler-light-style": "panel" });
  assert.strictEqual(v.theme.lightStyle, "panel");
  assert.strictEqual(v.root.style.background, "rgb(255, 255, 255)", "the panel follows the host");
  assert.match(v.stage.style.background, /rgb\(4, 6, 11\)/, "the stage stays dark");
  assert.strictEqual(v.canvas.style.mixBlendMode, "screen");
  assert.strictEqual(v.canvas.style.filter, "none");
  assert.strictEqual(v.status.style.color, "rgb(255, 197, 107)", "stage text uses the dark palette");
  const c = uploads[uploads.length - 1].slice(3, 6); // point 1: unlabelled, group 0
  // Group 0's colour as given to the renderer: the reference's hsl(28, .9, .62), not inverted.
  assert.ok(c[0] > 0.9 && c[2] < 0.5, Array.from(c).join(","));
  h.destroy();
});

test("light background, coloured ink: complementary colours inverted keep each group's hue", () => {
  const { h, v, uploads } = themed({ "--tumbler-background": "#ffffff", "--tumbler-light-style": "ink" });
  assert.strictEqual(v.canvas.style.filter, "invert(1)");
  assert.strictEqual(v.canvas.style.mixBlendMode, "multiply");
  const c = uploads[uploads.length - 1];
  // Orange group: after the CSS inversion the ink is 1 - uploaded, which must be orange-ish:
  // red channel strongest, blue weakest.
  const ink = [1 - c[0], 1 - c[1], 1 - c[2]];
  assert.ok(ink[0] > ink[1] && ink[1] > ink[2], ink.join(","));
  assert.ok(ink[0] - ink[2] > 0.4, "saturated, not grey or black");
  h.destroy();
});

test("light background, soft ink: like coloured ink, drawn lighter", () => {
  const { dom, h, v } = themed({ "--tumbler-background": "#ffffff", "--tumbler-light-style": "soft" });
  assert.strictEqual(v.canvas.style.filter, "invert(1)");
  dom.frames(2);
  assert.ok(v.lastDraw.gain < 1);
  h.destroy();
});

test("a light background with no style chosen uses the documented default; dark hosts are unchanged", () => {
  const { h, v } = themed({ "--tumbler-background": "#f6f4ee" });
  assert.strictEqual(v.theme.lightStyle, api._internal.viewer.DEFAULT_LIGHT_STYLE);
  h.destroy();
  const d = themed({});
  assert.strictEqual(d.v.theme.light, false);
  assert.strictEqual(d.v.canvas.style.mixBlendMode, "screen");
  assert.strictEqual(d.v.canvas.style.filter, "none");
  assert.match(d.v.stage.style.background, /rgb\(11, 20, 48\)/);
  d.h.destroy();
});

test("switching the light style on a running view re-colours it", () => {
  const { el, h, v, uploads } = themed({ "--tumbler-background": "#ffffff", "--tumbler-light-style": "panel" });
  const n = uploads.length;
  el.style.setProperty("--tumbler-light-style", "ink");
  h.refreshTheme();
  assert.strictEqual(uploads.length, n + 1);
  assert.strictEqual(v.canvas.style.filter, "invert(1)");
  h.destroy();
});

test("info() reports the last Tumble refit: when and how long", () => {
  const { dom, h } = setup({}, { refitQuietSeconds: 0.3 });
  h.update(makeSet({ n: 200, d: 16 }));
  dom.frames(30);
  assert.strictEqual(h.info().timing.lastRefit, null);
  h.update(makeSet({ n: 40, d: 16, op: "append", idPrefix: "r" }));
  dom.frames(60);
  const r = h.info().timing.lastRefit;
  assert.ok(r, "a refit happened");
  assert.strictEqual(typeof r.atMs, "number");
  assert.strictEqual(typeof r.durationMs, "number");
  assert.strictEqual(typeof r.longestStepMs, "number");
  h.destroy();
});

test("the refit crossfade is gentle: per-frame frame change stays near normal running", () => {
  for (const speed of [1, 3]) {
    const { dom, h, v } = setup({}, { speed, refitQuietSeconds: 0.5 });
    h.update(makeSet({ n: 600, d: 32, groups: ["a", "b", "c", "d", "e"] }));
    dom.frames(60);
    const prev = new Float32Array(v.last.frame);
    const change = () => {
      let s = 0;
      for (let i = 0; i < prev.length; i++) s += (prev[i] - v.last.frame[i]) ** 2;
      prev.set(v.last.frame);
      return Math.sqrt(s);
    };
    let normal = 0;
    for (let i = 0; i < 240; i++) {
      dom.flush();
      normal = Math.max(normal, change());
    }
    // Same distribution as the set (same seed, so the same cluster centres), new ids.
    h.update(makeSet({ n: 60, d: 32, op: "append", idPrefix: "n", groups: ["a", "b", "c", "d", "e"] }));
    let across = 0;
    for (let i = 0; i < 600; i++) {
      dom.flush();
      across = Math.max(across, change());
    }
    assert.strictEqual(h.info().timing.refits, 1);
    console.log(`refit crossfade, speed ${speed}: largest per-frame change ${across.toFixed(5)}, normal ${normal.toFixed(5)}`);
    assert.ok(across < 1.6 * normal, `speed ${speed}: ${across} vs normal ${normal}`);
    h.destroy();
  }
});

test("after a long frame of the viewer's own work the next frame does not leap ahead", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(30);
  const t0 = h.time();
  // Simulate a long step: the next frame arrives 400 ms later and the last frame's work was long.
  v.lastSpent = 300;
  dom.flush(400);
  assert.ok(h.time() - t0 < 0.02, "advanced by one normal frame, not 50 ms: " + (h.time() - t0));
  h.destroy();
});

test("after a long update() call the next frame does not leap ahead either", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 40, d: 16 }));
  dom.frames(30);
  const t0 = h.time();
  const orig = v.renderer.appendData;
  v.renderer.appendData = function () {
    dom.advance(120); // the upload takes 120 ms of the host's time
    return orig.apply(this, arguments);
  };
  h.update(makeSet({ n: 5, d: 16, op: "append", idPrefix: "u" }));
  v.renderer.appendData = orig;
  dom.flush(10);
  assert.ok(h.time() - t0 < 0.02, "one normal frame, not a clamped 50 ms: " + (h.time() - t0));
  h.destroy();
});

// ---------- crowded sets (found on a real Atlas, plan task t16) ----------

test("a set with thousands of labelled points is drawn dimmer, a small one is not", () => {
  // Real data files carry a text label on every point, so every point is a bright one.
  const small = setup();
  small.h.update(makeSet({ n: 300, d: 8, labelEvery: 1 }));
  small.dom.frames(3);
  assert.ok(small.v.lastDraw.gain === undefined || small.v.lastDraw.gain === 1, "300 labelled points: unchanged");
  small.h.destroy();

  const big = setup();
  big.h.update(makeSet({ n: 4800, d: 8, labelEvery: 1 }));
  big.dom.frames(3);
  // 600 bright points are shown at full brightness; beyond that 600 / n.
  assert.ok(Math.abs(big.v.lastDraw.gain - 600 / 4800) < 1e-9, `gain ${big.v.lastDraw.gain}`);
  big.h.destroy();

  // No labelled point at all (labels are the ids): every point has weight 0.7.
  const plain = setup();
  plain.h.update(makeSet({ n: 4800, d: 8, labelFor: (i, id) => id }));
  plain.dom.frames(3);
  assert.ok(Math.abs(plain.v.lastDraw.gain - 600 / (0.7 * 4800)) < 1e-9, `gain ${plain.v.lastDraw.gain}`);
  plain.h.destroy();
});

// ---------- preparations abandoned midway ----------

// Two data objects appended into one full set (same points, same order).
function joined(a, b) {
  const all = makeSet({ n: a.count + b.count, d: a.dimension });
  all.vectors = new Float32Array(a.vectors.length + b.vectors.length);
  all.vectors.set(a.vectors, 0);
  all.vectors.set(b.vectors, a.vectors.length);
  all.points = a.points.concat(b.points);
  return all;
}

function untilReady(dom, h, limit) {
  let n = 0;
  while (!h.info().ready && n++ < (limit || 1000)) dom.flush();
  assert.ok(h.info().ready, "the view became ready");
}

test("switching modes while a mode is still preparing works, and switching back starts clean", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 2000, d: 64 }));
  dom.flush();
  assert.ok(!h.info().ready, "Tumble is still preparing");
  assert.strictEqual(h.setMode("lattice"), true);
  dom.flush();
  assert.strictEqual(h.setMode("wander"), true, "and again before Lattice is ready");
  assert.strictEqual(h.setMode("tumble"), true, "and back to a fresh Tumble");
  dom.flush();
  untilReady(dom, h);
  dom.frames(10);
  assert.strictEqual(h.mode(), "tumble");
  assert.ok(h.time() > 0, "the clock runs");
  assert.ok(!v.broken, "the loop did not stop");
  assert.ok(!v.noticeMessage, "no notice: " + v.noticeMessage);
  assert.strictEqual(v.mode.inst.describe().pointsSinceFit, 0);
  for (const x of v.last.frame) assert.ok(Number.isFinite(x));
  // Lattice entered while Tumble prepared, left to finish this time
  assert.strictEqual(h.setMode("lattice"), true);
  untilReady(dom, h);
  dom.frames(5);
  assert.ok(!v.broken && !v.noticeMessage);
  h.destroy();
});

// The whole set at once, against the first part followed by an append that arrives
// after `flushes` frames of preparation (0: before the mode ran any work).
function appendedVersusWhole(mode, n, flushes) {
  const first = makeSet({ n, d: 64 });
  const more = makeSet({ n: 200, d: 64, op: "append", idPrefix: "m", seed: 9 });
  function frameAt(sets, t) {
    const { dom, h, v } = setup({}, { mode });
    h.update(sets[0]);
    if (sets[1]) {
      for (let i = 0; i < flushes; i++) dom.flush();
      assert.ok(!h.info().ready, "still preparing when the points arrive");
      h.update(sets[1]);
    }
    untilReady(dom, h);
    // checked on the very frame it turns ready: never ready on a fit of the first part
    if (mode === "tumble") assert.strictEqual(v.mode.inst.describe().pointsSinceFit, 0, "fitted on every point");
    h.pause();
    dom.frames(5);
    h.seek(t);
    dom.frames(1);
    const out = Array.from(v.last.frame);
    assert.ok(!v.broken && !v.noticeMessage, String(v.noticeMessage));
    h.destroy();
    return out;
  }
  assert.deepStrictEqual(frameAt([first, more], 2.5), frameAt([joined(first, more)], 2.5));
}

for (const mode of ["tumble", "lattice", "wander"]) {
  test(`${mode}: points appended before its preparation ran give the frames of the whole set sent at once`, () => {
    appendedVersusWhole(mode, 2000, 0);
  });
}

test("tumble: points appended in the middle of its fit give the frames of the whole set sent at once", () => {
  appendedVersusWhole("tumble", 6000, 1);
});
