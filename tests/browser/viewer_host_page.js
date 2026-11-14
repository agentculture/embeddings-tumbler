// Page script for tests/browser/test_viewer_render.py (task t8). A plain host page
// that uses only the public API: mount, update, destroy (plus the handle's info()
// and pause() for measuring). It runs a fixed script and leaves its findings on
// window.__viewerResult:
//
//   1. mount, then update with the built-in sample set (n points, d dimensions)
//   2. switch Tumble -> Lattice -> Wander with the mode buttons, counting lit pixels
//   3. append 200 points while paused: the frame must not move, the count must grow
//   4. a replace whose labels and group names contain markup
//   5. an invalid set: a message inside the element, the call returns a refusal
//   6. destroy: the element is empty and the loop stopped
//
// Every Content-Security-Policy violation is recorded (the page runs under
// script-src 'self'; style-src 'self', so a style attribute or style element would
// be one). Query string: ?d=384&n=2000&hold=1500 (milliseconds per mode).
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const D = Number.parseInt(q.get("d") || "384", 10);
  const N = Number.parseInt(q.get("n") || "2000", 10);
  const HOLD = Number.parseInt(q.get("hold") || "1500", 10);
  const out = { steps: {}, violations: [], fatal: null, unavailable: null, done: false };
  window.__viewerResult = out;

  document.addEventListener("securitypolicyviolation", function (e) {
    out.violations.push(e.violatedDirective + " " + (e.blockedURI || "") + " " + (e.sample || ""));
  });

  const T = window.EmbeddingsTumbler;
  const el = document.getElementById("space");

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function until(fn, ms) {
    const t0 = performance.now();
    return new Promise(function (resolve) {
      (function poll() {
        const v = fn();
        if (v || performance.now() - t0 > ms) resolve(v);
        else setTimeout(poll, 50);
      })();
    });
  }
  function lit() {
    const gl = el.querySelector(".tumbler-canvas")?.getContext("webgl2");
    if (!gl) return -1;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 40 || px[i + 1] > 40 || px[i + 2] > 40) n++;
    return n;
  }
  function rect(sel) {
    const e = el.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }
  function split(data, from, to, op) {
    const d = data.dimension;
    const o = {
      schema_version: data.schema_version,
      kind: data.kind,
      model: data.model,
      dimension: d,
      count: to - from,
      text_included: data.text_included,
      points: data.points.slice(from, to),
      vectors: data.vectors.slice(from * d, to * d),
    };
    if (op === "append") o.op = "append";
    else o.provenance = data.provenance;
    return o;
  }
  function fail(err) {
    out.fatal = String(err?.stack || err);
    out.done = true;
  }

  const full = T.sample.generate({ dimension: D, count: N + 200 });
  const base = split(full, 0, N, "replace");
  const extra = split(full, N, N + 200, "append");
  let h;

  // ?manual=1: mount, show the sample set, and stop; the test drives real input.
  if (q.get("manual") === "1") {
    h = T.mount(el, { seed: 3 });
    window.__viewerHandle = h;
    out.steps.update = T.update(el, base);
    until(function () {
      return h.info().ready;
    }, 20000)
      .then(function () {
        const info = h.info();
        if (!info.rendering) out.unavailable = info.message;
        out.done = true;
      })
      .catch(fail);
    return;
  }

  // 1. mount and show the sample set; resolves when the viewer is ready (or after 20 s).
  function mountAndUpdate() {
    let t0 = performance.now();
    h = T.mount(el, { seed: 3, preserveDrawingBuffer: true, title: "Viewer host check" });
    out.steps.mountMs = performance.now() - t0;
    out.steps.childrenAfterMount = el.children.length;
    out.steps.bodyChildren = document.body.children.length;
    out.steps.headStyles = document.head.querySelectorAll("style").length;
    t0 = performance.now();
    out.steps.update = T.update(el, base);
    out.steps.updateMs = performance.now() - t0;
    return until(function () {
      return h.info().ready;
    }, 20000);
  }

  function layout() {
    const r = el.getBoundingClientRect();
    return {
      root: rect(".tumbler"),
      stage: rect(".tumbler-stage"),
      canvas: rect(".tumbler-canvas"),
      status: rect(".tumbler-status"),
      controls: rect(".tumbler-controls"),
      modes: rect(".tumbler-modes"),
      provenance: rect(".tumbler-provenance"),
      strip: rect(".tumbler-strip"),
      element: { width: r.width, height: r.height },
      rootScrollWidth: el.firstChild.scrollWidth,
      rootClientWidth: el.firstChild.clientWidth,
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      stageBackground: getComputedStyle(el.querySelector(".tumbler-stage")).backgroundImage,
      blend: getComputedStyle(el.querySelector(".tumbler-canvas")).mixBlendMode,
    };
  }

  // 2. one mode: press its button, hold, count frames and lit pixels.
  async function measureMode(id) {
    el.querySelector('[data-mode="' + id + '"]').click();
    const f0 = h.info().frames;
    const t0 = performance.now();
    await wait(HOLD);
    const f1 = h.info().frames;
    out.steps.modes[id] = {
      mode: h.mode(),
      lit: lit(),
      fps: ((f1 - f0) * 1000) / (performance.now() - t0),
      status: el.querySelector(".tumbler-status").textContent,
    };
  }

  // 3. append while paused: the frame must stay where it is.
  async function appendWhilePaused() {
    h.setMode("tumble");
    await wait(600);
    h.pause();
    await wait(200);
    const v = h._viewer;
    const before = Array.prototype.slice.call(v.last.frame, 0, 12);
    const t0 = performance.now();
    const r = T.update(el, extra);
    const ms = performance.now() - t0;
    await wait(300);
    const after = Array.prototype.slice.call(v.last.frame, 0, 12);
    let diff = 0;
    for (let i = 0; i < before.length; i++) diff = Math.max(diff, Math.abs(before[i] - after[i]));
    out.steps.append = { result: r, ms: ms, frameChange: diff, count: h.info().count, lit: lit() };
    h.resume();
  }

  // 4. markup in labels and group names.
  async function markupInLabels() {
    const evil = "<img src=/tests/browser/evil-probe.png onerror=alert(1)>";
    const m = split(full, 0, 300, "replace");
    m.points = m.points.map(function (p, i) {
      return {
        id: p.id,
        label: i === 0 ? evil : p.label,
        group: p.group === "cooking" ? "<b>cook</b>" : p.group,
      };
    });
    out.steps.markup = { result: T.update(el, m) };
    await wait(800);
    const labels = el.querySelector(".tumbler-labels").textContent;
    out.steps.markup.groupShownLiterally = labels.includes("<b>cook</b>");
    out.steps.markup.imgElements = el.querySelectorAll("img").length;
    out.steps.markup.bElements = el.querySelectorAll(".tumbler-labels b").length;
  }

  // 5. an invalid set: a message inside the element, the call returns a refusal.
  function invalidSet() {
    const r = T.update(el, { kind: "something else" });
    const msg = el.querySelector(".tumbler-notice");
    out.steps.invalid = {
      result: r,
      noticeText: msg ? msg.textContent : null,
      noticeVisible: msg ? msg.getBoundingClientRect().height > 0 : false,
    };
    return wait(300);
  }

  // 6. destroy: the element is empty and the loop stopped.
  function destroyTwice() {
    out.steps.framesBeforeDestroy = h.info().frames;
    out.steps.destroyed = T.destroy(el);
    out.steps.childrenAfterDestroy = el.children.length;
    out.steps.animatingAfterDestroy = h.info().animating;
    out.steps.destroyAgain = T.destroy(el);
  }

  async function run() {
    await mountAndUpdate();
    const info = h.info();
    if (!info.rendering) {
      out.unavailable = info.message;
      return;
    }
    out.steps.firstReady = info.timing;
    out.steps.layout = layout();
    out.steps.provenanceText = el.querySelector(".tumbler-provenance").textContent;
    out.steps.modes = {};
    await ["tumble", "lattice", "wander"].reduce(function (chain, id) {
      return chain.then(function () {
        return measureMode(id);
      });
    }, Promise.resolve());
    await appendWhilePaused();
    await markupInLabels();
    await invalidSet();
    destroyTwice();
  }

  Promise.resolve()
    .then(run)
    .then(function () {
      out.done = true;
    }, fail);
})();
