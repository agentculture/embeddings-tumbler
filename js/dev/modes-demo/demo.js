// Dev-only live check of the three modes (task t7). Not shipped, and not the viewer
// API: task t8 owns mount / update / destroy, labels, controls and provenance. This is
// the minimum glue to drive ET.modes with ET.renderer on the built-in sample set.
//
//   ?d=1024      dimension passed to the sample generator (default: the sample's own)
//   ?n=5000      point count passed to the sample generator (default: the sample's own)
//   ?seed=7      seed for the modes (default 1)
//   ?mode=wander start in this mode (tumble, lattice or wander)
//   ?check=1     keep the drawing buffer and count lit pixels once a second (for tests)
//
// Keys: 1 Tumble, 2 Lattice, 3 Wander, space pauses the motion. Drag to turn.
(function () {
  "use strict";
  const q = new URLSearchParams(location.search);
  const info = document.getElementById("info");
  const statusEl = document.getElementById("status");
  const fpsEl = document.getElementById("fps");
  const canvas = document.getElementById("gl");
  const CHECK = q.get("check") === "1";
  const stats = { ready: false, error: null, mode: null, frames: 0, fps: 0, fpsByMode: {}, prepMs: {}, status: "", framesByMode: {}, litByMode: {} };
  window.__modesDemo = stats;

  function fail(msg) {
    info.textContent = msg;
    stats.error = msg;
  }

  // The order Array#sort uses with no compare function, for strings: UTF-16 code units.
  function byCodeUnits(a, b) {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  }

  function parseSeed(text) {
    if (text === null) return 1;
    return Number.isFinite(Number(text)) ? Number(text) : text;
  }

  // Colours by group (fixed hues).
  function hsl(h, s, l) {
    function f(n) {
      const k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }

  // Per-point colours by group and weights by whether a point is labelled.
  function paint(set) {
    const N = set.count;
    const groups = [];
    for (const p of set.points) {
      if (p.group && !groups.includes(p.group)) groups.push(p.group);
    }
    groups.sort(byCodeUnits);
    const colours = new Float32Array(N * 3);
    const weights = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = set.points[i];
      const g = groups.indexOf(p.group);
      const rgb = g < 0 ? [0.55, 0.68, 1] : hsl((g * 360) / Math.max(1, groups.length) + 28, 0.9, 0.62);
      colours.set(rgb, i * 3);
      const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      let w;
      if (p.label) w = 1;
      else if (g < 0) w = 0.05 + 0.2 * h * h;
      else w = 0.1 + 0.55 * h * h * h;
      weights[i] = w;
    }
    return { colours, weights };
  }

  const Lib = window.EmbeddingsTumbler;
  if (!Lib?._internal || !Lib.sample) return fail("core or sample file did not load");
  const ET = Lib._internal;

  const genOpts = {};
  if (q.get("d")) genOpts.dimension = Number.parseInt(q.get("d"), 10);
  if (q.get("n")) genOpts.count = Number.parseInt(q.get("n"), 10);
  const seed = parseSeed(q.get("seed"));

  const t0 = performance.now();
  let data;
  try {
    data = Lib.sample.generate(genOpts);
  } catch (e) {
    return fail("sample generator refused: " + e.message);
  }
  const genMs = performance.now() - t0;
  const res = ET.contract.validate(data, null);
  if (!res.ok) return fail("contract refused the sample: " + res.message);
  const set = res.set;
  const N = set.count;
  const D = set.dimension;
  const { colours, weights } = paint(set);

  const made = ET.renderer.create(canvas, { preserveDrawingBuffer: CHECK });
  if (!made.ok) return fail(made.message);
  const renderer = made.renderer;
  const set0 = renderer.setData({ vectors: set.vectors, dimension: D, colours: colours, weights: weights });
  if (!set0.ok) return fail(set0.message);

  const gl = canvas.getContext("webgl2");
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown GPU";
  stats.gpu = gpu;
  stats.hdr = renderer.status().hdr;
  stats.n = N;
  stats.d = D;
  info.textContent =
    set.model + ", " + N + " points x " + D + "-d, seed " + String(seed) + "\n" +
    "sample generated in " + genMs.toFixed(0) + " ms; hdr " + stats.hdr + "\n" + gpu;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    renderer.resize(Math.max(2, Math.round(canvas.clientWidth * dpr)), Math.max(2, Math.round(canvas.clientHeight * dpr)));
  }
  resize();
  window.addEventListener("resize", resize);

  let yaw = 0.4;
  let pitch = 0.16;
  let running = true;
  let drag = null;
  // User zoom (dev demo only; the viewer task owns the real control): wheel on a
  // desktop, multiplied on top of the mode's own zoom. Double-click resets it.
  let userZoom = 1;
  canvas.addEventListener(
    "wheel",
    function (e) {
      e.preventDefault();
      userZoom = Math.max(0.2, Math.min(8, userZoom * Math.exp(-e.deltaY * 0.0015)));
    },
    { passive: false }
  );
  canvas.addEventListener("dblclick", function () {
    userZoom = 1;
  });
  canvas.addEventListener("pointerdown", function (e) {
    drag = [e.clientX, e.clientY];
  });
  window.addEventListener("pointerup", function () {
    drag = null;
  });
  window.addEventListener("pointermove", function (e) {
    if (!drag) return;
    yaw += (e.clientX - drag[0]) * 0.007;
    pitch = Math.max(-1.3, Math.min(1.3, pitch + (e.clientY - drag[1]) * 0.007));
    drag = [e.clientX, e.clientY];
  });

  // Pixels with any channel above 40 (only with ?check=1, which keeps the buffer).
  function litPixels() {
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    for (let k = 0; k < px.length; k += 4) if (px[k] > 40 || px[k + 1] > 40 || px[k + 2] > 40) lit++;
    return lit;
  }

  let current = null;
  let last = null; // the last state drawn, handed to the next mode as its entry view

  function switchTo(wanted) {
    const id = ET.modes.ids().includes(wanted) ? wanted : "tumble";
    if (current?.id === id) return;
    const from = last ? { frame: new Float32Array(last.frame), centre: new Float32Array(last.centre), draw: { ...last.draw } } : null;
    const inst = ET.modes.create(id);
    inst.enter(set, { seed: seed, from: from });
    current = { id: id, inst: inst, prep: inst.prepare(), clock: 0, started: performance.now(), wiresVersion: -1 };
    stats.mode = id;
  }

  window.addEventListener("keydown", function (e) {
    if (e.key === "1") switchTo("tumble");
    else if (e.key === "2") switchTo("lattice");
    else if (e.key === "3") switchTo("wander");
    else if (e.key === " ") {
      running = !running;
      e.preventDefault();
    }
  });

  // Tap targets for devices with no keyboard.
  for (const button of document.querySelectorAll("#keys button")) {
    button.addEventListener("click", function (e) {
      const b = e.currentTarget;
      if (b.dataset.mode) switchTo(b.dataset.mode);
      else if (b.dataset.action === "pause") running = !running;
    });
  }

  switchTo(q.get("mode") || "tumble");

  let prev = performance.now();
  let fpsT = prev;
  let fpsN = 0;
  let hud = 1;
  // Diagnostics for live testing: the longest gap between frames and the most
  // script time spent in one frame during the last second, and since the mode began.
  const diag = { gapSec: 0, jsSec: 0, gapMode: 0, jsMode: 0, mode: null, skip: 2 };

  // Record the gap between frames (the first two frames of a mode are skipped).
  function noteGap(gap) {
    if (current.id !== diag.mode) {
      diag.mode = current.id;
      diag.gapMode = 0;
      diag.jsMode = 0;
      diag.skip = 2;
    }
    if (diag.skip > 0) {
      diag.skip--;
      return;
    }
    if (gap > diag.gapSec) diag.gapSec = gap;
    if (gap > diag.gapMode) diag.gapMode = gap;
  }

  // Advance the current mode by dt and return its state for this frame.
  function stepMode(c, dt) {
    if (!c.prep.done) {
      c.prep.step(8);
      if (c.prep.done && stats.prepMs[c.id] === undefined) stats.prepMs[c.id] = Math.round(performance.now() - c.started);
    }
    if (c.inst.isReady() && running) c.clock += dt;
    if (c.inst.isReady() && c.inst.mark) c.inst.mark(c.clock); // finished events happen now
    const s = c.inst.stateAt(c.inst.isReady() ? c.clock : 0);
    if (s.wires && s.wires.version !== c.wiresVersion) {
      const w = renderer.setWires(s.wires.pairs, s.wires.lengths);
      if (w?.ok === false) stats.error = "setWires: " + w.message;
      c.wiresVersion = s.wires.version;
    }
    return s;
  }

  // Once a second: frames per second, the gap and script diagnostics, and lit pixels.
  function reportSecond(c, now) {
    stats.fps = (fpsN * 1000) / (now - fpsT);
    stats.fpsByMode[c.id] = Math.round(stats.fps * 10) / 10;
    const pm = stats.prepMs[c.id];
    fpsEl.textContent =
      stats.fps.toFixed(1) + " fps\n" +
      "gap " + diag.gapSec.toFixed(0) + " / " + diag.gapMode.toFixed(0) + " ms\n" +
      "script " + diag.jsSec.toFixed(1) + " / " + diag.jsMode.toFixed(1) + " ms\n" +
      "prep " + (pm === undefined ? "..." : pm + " ms");
    stats.gapMode = diag.gapMode;
    stats.jsMode = diag.jsMode;
    diag.gapSec = 0;
    diag.jsSec = 0;
    if (CHECK) stats.litByMode[c.id] = litPixels();
    fpsT = now;
    fpsN = 0;
  }

  function tick(now) {
    const tickStart = performance.now();
    const gap = now - prev;
    const dt = Math.min(0.05, Math.max(0.001, (now - prev) / 1000));
    prev = now;
    noteGap(gap);
    const c = current;
    const s = stepMode(c, dt);
    if (running && !drag) yaw += dt * 0.06;
    const draw = {
      ...s.draw,
      frame: s.frame,
      centre: s.centre,
      yaw: yaw,
      pitch: pitch,
      zoom: (s.draw.zoom === undefined ? 1 : s.draw.zoom) * userZoom,
      pointSize: 6.5 * dpr,
      time: now / 1000,
      dt: dt,
    };
    renderer.draw(draw);
    last = s;
    stats.frames++;
    stats.framesByMode[c.id] = (stats.framesByMode[c.id] || 0) + 1;
    stats.ready = true;
    hud += dt;
    if (hud >= 0.12) {
      hud = 0;
      stats.status = s.status + (running ? "" : " · paused");
      statusEl.textContent = c.id + ": " + stats.status;
    }
    fpsN++;
    if (now - fpsT >= 1000) reportSecond(c, now);
    const spent = performance.now() - tickStart;
    if (spent > diag.jsSec) diag.jsSec = spent;
    if (spent > diag.jsMode) diag.jsMode = spent;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
