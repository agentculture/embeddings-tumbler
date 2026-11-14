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
  var q = new URLSearchParams(location.search);
  var info = document.getElementById("info");
  var statusEl = document.getElementById("status");
  var fpsEl = document.getElementById("fps");
  var canvas = document.getElementById("gl");
  var CHECK = q.get("check") === "1";
  var stats = { ready: false, error: null, mode: null, frames: 0, fps: 0, fpsByMode: {}, prepMs: {}, status: "", framesByMode: {}, litByMode: {} };
  window.__modesDemo = stats;

  function fail(msg) {
    info.textContent = msg;
    stats.error = msg;
  }

  var Lib = window.EmbeddingsTumbler;
  if (!Lib || !Lib._internal || !Lib.sample) return fail("core or sample file did not load");
  var ET = Lib._internal;

  var genOpts = {};
  if (q.get("d")) genOpts.dimension = parseInt(q.get("d"), 10);
  if (q.get("n")) genOpts.count = parseInt(q.get("n"), 10);
  var seedParam = q.get("seed");
  var seed = seedParam === null ? 1 : isFinite(Number(seedParam)) ? Number(seedParam) : seedParam;

  var t0 = performance.now();
  var data;
  try {
    data = Lib.sample.generate(genOpts);
  } catch (e) {
    return fail("sample generator refused: " + e.message);
  }
  var genMs = performance.now() - t0;
  var res = ET.contract.validate(data, null);
  if (!res.ok) return fail("contract refused the sample: " + res.message);
  var set = res.set;
  var N = set.count;
  var D = set.dimension;

  // Colours by group (fixed hues), weights by whether a point is labelled.
  function hsl(h, s, l) {
    function f(n) {
      var k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }
  var groups = [];
  set.points.forEach(function (p) {
    if (p.group && groups.indexOf(p.group) < 0) groups.push(p.group);
  });
  groups.sort();
  var colours = new Float32Array(N * 3);
  var weights = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var p = set.points[i];
    var g = groups.indexOf(p.group);
    var rgb = g < 0 ? [0.55, 0.68, 1.0] : hsl((g * 360) / Math.max(1, groups.length) + 28, 0.9, 0.62);
    colours.set(rgb, i * 3);
    var h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    weights[i] = p.label ? 1 : g < 0 ? 0.05 + 0.2 * h * h : 0.1 + 0.55 * h * h * h;
  }

  var made = ET.renderer.create(canvas, { preserveDrawingBuffer: CHECK });
  if (!made.ok) return fail(made.message);
  var renderer = made.renderer;
  var set0 = renderer.setData({ vectors: set.vectors, dimension: D, colours: colours, weights: weights });
  if (!set0.ok) return fail(set0.message);

  var gl = canvas.getContext("webgl2");
  var dbg = gl.getExtension("WEBGL_debug_renderer_info");
  var gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown GPU";
  stats.gpu = gpu;
  stats.hdr = renderer.status().hdr;
  stats.n = N;
  stats.d = D;
  info.textContent =
    set.model + ", " + N + " points x " + D + "-d, seed " + String(seed) + "\n" +
    "sample generated in " + genMs.toFixed(0) + " ms; hdr " + stats.hdr + "\n" + gpu;

  var dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    renderer.resize(Math.max(2, Math.round(canvas.clientWidth * dpr)), Math.max(2, Math.round(canvas.clientHeight * dpr)));
  }
  resize();
  window.addEventListener("resize", resize);

  var yaw = 0.4;
  var pitch = 0.16;
  var running = true;
  var drag = null;
  // User zoom (dev demo only; the viewer task owns the real control): wheel on a
  // desktop, multiplied on top of the mode's own zoom. Double-click resets it.
  var userZoom = 1;
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
    var w = gl.drawingBufferWidth;
    var h = gl.drawingBufferHeight;
    var px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var lit = 0;
    for (var k = 0; k < px.length; k += 4) if (px[k] > 40 || px[k + 1] > 40 || px[k + 2] > 40) lit++;
    return lit;
  }

  var current = null;
  var last = null; // the last state drawn, handed to the next mode as its entry view

  function switchTo(id) {
    if (ET.modes.ids().indexOf(id) < 0) id = "tumble";
    if (current && current.id === id) return;
    var from = last ? { frame: new Float32Array(last.frame), centre: new Float32Array(last.centre), draw: Object.assign({}, last.draw) } : null;
    var inst = ET.modes.create(id);
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
  var buttons = document.querySelectorAll("#keys button");
  for (var bi = 0; bi < buttons.length; bi++) {
    buttons[bi].addEventListener("click", function (e) {
      var b = e.currentTarget;
      if (b.dataset.mode) switchTo(b.dataset.mode);
      else if (b.dataset.action === "pause") running = !running;
    });
  }

  switchTo(q.get("mode") || "tumble");

  var prev = performance.now();
  var fpsT = prev;
  var fpsN = 0;
  var hud = 1;
  // Diagnostics for live testing: the longest gap between frames and the most
  // script time spent in one frame during the last second, and since the mode began.
  var gapSec = 0, jsSec = 0, gapMode = 0, jsMode = 0, diagMode = null, skip = 2;
  function tick(now) {
    var tickStart = performance.now();
    var gap = now - prev;
    var dt = Math.min(0.05, Math.max(0.001, (now - prev) / 1000));
    prev = now;
    if (current.id !== diagMode) { diagMode = current.id; gapMode = 0; jsMode = 0; skip = 2; }
    if (skip > 0) skip--; else { if (gap > gapSec) gapSec = gap; if (gap > gapMode) gapMode = gap; }
    var c = current;
    if (!c.prep.done) {
      c.prep.step(8);
      if (c.prep.done && stats.prepMs[c.id] === undefined) stats.prepMs[c.id] = Math.round(performance.now() - c.started);
    }
    if (c.inst.isReady() && running) c.clock += dt;
    if (c.inst.isReady() && c.inst.mark) c.inst.mark(c.clock); // finished events happen now
    var s = c.inst.stateAt(c.inst.isReady() ? c.clock : 0);
    if (s.wires && s.wires.version !== c.wiresVersion) {
      var w = renderer.setWires(s.wires.pairs, s.wires.lengths);
      if (w && w.ok === false) stats.error = "setWires: " + w.message;
      c.wiresVersion = s.wires.version;
    }
    if (running && !drag) yaw += dt * 0.06;
    var draw = Object.assign({}, s.draw, {
      frame: s.frame,
      centre: s.centre,
      yaw: yaw,
      pitch: pitch,
      zoom: (s.draw.zoom === undefined ? 1 : s.draw.zoom) * userZoom,
      pointSize: 6.5 * dpr,
      time: now / 1000,
      dt: dt,
    });
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
    if (now - fpsT >= 1000) {
      stats.fps = (fpsN * 1000) / (now - fpsT);
      stats.fpsByMode[c.id] = Math.round(stats.fps * 10) / 10;
      var pm = stats.prepMs[c.id];
      fpsEl.textContent =
        stats.fps.toFixed(1) + " fps\n" +
        "gap " + gapSec.toFixed(0) + " / " + gapMode.toFixed(0) + " ms\n" +
        "script " + jsSec.toFixed(1) + " / " + jsMode.toFixed(1) + " ms\n" +
        "prep " + (pm === undefined ? "..." : pm + " ms");
      stats.gapMode = gapMode; stats.jsMode = jsMode;
      gapSec = 0; jsSec = 0;
      if (CHECK) stats.litByMode[c.id] = litPixels();
      fpsT = now;
      fpsN = 0;
    }
    var spent = performance.now() - tickStart;
    if (spent > jsSec) jsSec = spent;
    if (spent > jsMode) jsMode = spent;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
