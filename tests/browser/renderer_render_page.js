// Page script for tests/browser/test_renderer_render.py. Loads two contract
// fixtures (384-d and 1024-d), draws each with ET.renderer, and records whether
// the frame has any lit pixels. Also checks the no-HDR fallback and a context
// loss and restore, and the per-point lit values and shared mark of search (task t4):
// see searchCases below. The result is left on window.__rendererResult.
(function () {
  "use strict";
  const SIZE = 256;
  const out = { cases: {}, fatal: null, unavailable: null };

  // The two fixtures this page draws, at fixed addresses. A data file naming any other block
  // is refused rather than followed, so nothing read from a fetched file is put in a request.
  const FIXTURES = {
    "valid-384": {
      data: "/tests/fixtures/contract/valid-384.json",
      file: "valid-384.f32",
      block: "/tests/fixtures/contract/valid-384.f32",
    },
    "valid-1024": {
      data: "/tests/fixtures/contract/valid-1024.json",
      file: "valid-1024.f32",
      block: "/tests/fixtures/contract/valid-1024.f32",
    },
  };

  async function fetchFixture(fixture) {
    const meta = await (await fetch(fixture.data)).json();
    if (meta.vectors.file !== fixture.file) throw new Error(fixture.data + " names an unexpected block");
    const buf = await (await fetch(fixture.block)).arrayBuffer();
    return { meta: meta, vectors: new Float32Array(buf) };
  }

  // The mean of the n points of v (d values each).
  function meanOf(v, n, d) {
    const c = new Float32Array(d);
    for (let i = 0; i < n; i++) for (let k = 0; k < d; k++) c[k] += v[i * d + k] / n;
    return c;
  }

  // Row a: point (a + 1) % n minus the centre (rows 1 and 2 nudged off it), then Gram-Schmidt
  // against the rows before it and normalised.
  function setRow(f, a, v, n, d, c) {
    const src = (a + 1) % n;
    for (let k = 0; k < d; k++) f[a * d + k] = v[src * d + k] - c[k] + (a === 0 ? 0 : 1e-3 * Math.sin(k * (a + 1)));
    for (let b = 0; b < a; b++) {
      let dp = 0;
      for (let k = 0; k < d; k++) dp += f[a * d + k] * f[b * d + k];
      for (let k = 0; k < d; k++) f[a * d + k] -= dp * f[b * d + k];
    }
    let nn = 0;
    for (let k = 0; k < d; k++) nn += f[a * d + k] * f[a * d + k];
    nn = 1 / Math.sqrt(nn);
    for (let k = 0; k < d; k++) f[a * d + k] *= nn;
  }

  // Sum over points and the three axes of the squared projection of (point - centre).
  function projectedSquares(v, n, d, c, f) {
    let sq = 0;
    for (let p = 0; p < n; p++) {
      for (let ax = 0; ax < 3; ax++) {
        let s = 0;
        for (let k = 0; k < d; k++) s += (v[p * d + k] - c[k]) * f[ax * d + k];
        sq += s * s;
      }
    }
    return sq;
  }

  // Three orthonormal rows spanning the first points' differences, the mean as centre.
  function frameFor(v, n, d) {
    const c = meanOf(v, n, d);
    const f = new Float32Array(3 * d);
    for (let a = 0; a < 3; a++) setRow(f, a, v, n, d, c);
    const sq = projectedSquares(v, n, d, c, f);
    return { frame: f, centre: c, zoom: 0.78 / (Math.sqrt(sq / n) || 1) };
  }

  function litPixels(gl) {
    const px = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    let max = 0;
    for (let i = 0; i < px.length; i += 4) {
      const m = Math.max(px[i], px[i + 1], px[i + 2]);
      if (m > 8) lit++;
      if (m > max) max = m;
    }
    return { lit: lit, max: max };
  }

  function makeCanvas() {
    const c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    document.body.appendChild(c);
    return c;
  }

  function drawFixture(key, fx, options) {
    const R = window.EmbeddingsTumbler._internal.renderer;
    const canvas = makeCanvas();
    const events = [];
    const opts = {
      onContextChange: function (e) {
        events.push(e.type);
      },
      ...options,
    };
    const made = R.create(canvas, opts);
    if (!made.ok) return { made: made };
    const r = made.renderer;
    const d = fx.meta.dimension;
    const n = fx.meta.count;
    const colours = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colours[i * 3] = 1;
      colours[i * 3 + 1] = 0.6 + 0.1 * i;
      colours[i * 3 + 2] = 0.3;
    }
    const set = r.setData({ vectors: fx.vectors, dimension: d, colours: colours });
    const pairs = new Uint32Array([0, 1, 1, 2]);
    r.setWires(pairs);
    const view = frameFor(fx.vectors, n, d);
    const state = { frame: view.frame, centre: view.centre, zoom: view.zoom, wires: 1, time: 0.5, pointSize: 12 };
    r.draw(state);
    const gl = canvas.getContext("webgl2");
    const res = { made: { ok: true }, set: set.ok, status: r.status(), pixels: litPixels(gl), events: events };
    return { result: res, renderer: r, gl: gl, state: state, events: events };
  }

  function waitFor(events, type) {
    return new Promise(function (resolve) {
      const t0 = performance.now();
      (function poll() {
        if (events.includes(type) || performance.now() - t0 > 5000) resolve(events.includes(type));
        else setTimeout(poll, 20);
      })();
    });
  }

  // Context loss and restore on the 1024-d view.
  async function loseAndRestore(b) {
    const ext = b.gl.getExtension("WEBGL_lose_context");
    if (!ext) {
      out.cases.restore = { skipped: "no WEBGL_lose_context" };
      return;
    }
    ext.loseContext();
    const gotLost = await waitFor(b.events, "lost");
    const drewWhileLost = b.renderer.draw(b.state);
    ext.restoreContext();
    const gotRestored = await waitFor(b.events, "restored");
    const drew = b.renderer.draw(b.state);
    out.cases.restore = {
      lost: gotLost,
      drewWhileLost: drewWhileLost,
      restored: gotRestored,
      drew: drew,
      events: b.events.slice(),
      pixels: litPixels(b.gl),
    };
    b.renderer.dispose();
  }

  // ---------- search (t4): lit values, filter, the shared mark ----------

  // A small synthetic set whose screen positions are known: a 5 x 5 grid in the plane of
  // the first two dimensions (z = 0, so every point has the same perspective), with small
  // values in the other dimensions. The dimension is not special; it comes from here.
  const GRID_D = 12;
  const GRID = [-0.8, -0.4, 0, 0.4, 0.8];
  const GRID_N = GRID.length * GRID.length;
  const ORANGE = [1, 0.55, 0.2];

  function gridSet(n) {
    const v = new Float32Array(n * GRID_D);
    for (let i = 0; i < n; i++) {
      v[i * GRID_D] = GRID[i % 5];
      v[i * GRID_D + 1] = GRID[Math.floor(i / 5) % 5];
      for (let k = 3; k < GRID_D; k++) v[i * GRID_D + k] = 0.05 * Math.sin(i * 7 + k);
    }
    return v;
  }

  function solid(n, rgb) {
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set(rgb, i * 3);
    return c;
  }

  // The viewer's soft-ink upload for a light stage (js/src/50-viewer.js, inkUpload, labelled):
  // the hue saturated and darkened, then its complement.
  function inkUpload(c) {
    const lo = Math.min(c[0], c[1], c[2]);
    const span = Math.max(c[0], c[1], c[2]) - lo;
    return c.map((x) => 1 - 0.78 * (0.7 * ((x - lo) / span) + 0.3 * x));
  }

  function gridFrame() {
    const f = new Float32Array(3 * GRID_D);
    f[0] = 1;
    f[GRID_D + 1] = 1;
    f[2 * GRID_D + 2] = 1;
    return f;
  }

  // Steady, cleared every frame: the same draw gives the same picture.
  const GRID_STATE = { frame: gridFrame(), centre: new Float32Array(GRID_D), twinkle: 0, pointSize: 8, trails: 0 };

  // Canvas pixel position of grid point i (y down), as the shader places it.
  function gridPixel(R, i, state) {
    const p = R.place([GRID[i % 5], GRID[Math.floor(i / 5) % 5], 0], state, SIZE, SIZE);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  function readAll(gl) {
    const px = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  function countLit(px) {
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 8) lit++;
    return lit;
  }

  // Sum of r + g + b over a (2h + 1)^2 window centred on canvas pixel (x, y down).
  function windowSum(px, at, h) {
    let sum = 0;
    for (let dy = -h; dy <= h; dy++) {
      for (let dx = -h; dx <= h; dx++) {
        const o = ((SIZE - 1 - (at.y + dy)) * SIZE + (at.x + dx)) * 4; // readPixels rows go up
        sum += px[o] + px[o + 1] + px[o + 2];
      }
    }
    return sum;
  }

  function firstDiff(a, b) {
    if (a.length !== b.length) return -2;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
    return -1;
  }

  // A renderer on a fresh canvas inside `parent` (the body by default).
  function gridRenderer(options, parent) {
    const R = window.EmbeddingsTumbler._internal.renderer;
    const canvas = makeCanvas();
    if (parent) parent.appendChild(canvas);
    const made = R.create(canvas, { releaseContext: true, ...options });
    if (!made.ok) throw new Error("renderer: " + made.message);
    return { r: made.renderer, gl: canvas.getContext("webgl2"), canvas: canvas };
  }

  function gridData(colour, n) {
    const count = n || GRID_N;
    return { vectors: gridSet(count), dimension: GRID_D, colours: solid(count, colour || ORANGE) };
  }

  function retire(g) {
    g.r.dispose();
    g.canvas.remove();
  }

  // A lit array of `n` points: 0 everywhere except the given { index: value } pairs.
  function litOf(n, pairs) {
    const lit = new Float32Array(n);
    for (const k of Object.keys(pairs)) lit[Number(k)] = pairs[k];
    return lit;
  }

  // Frames from a renderer that never had lit values against one whose lit values are set
  // but not applied (filter 0), then cleared: every byte the same. Several frames with trails
  // on, so fading is compared too.
  function identityCase(options) {
    const a = gridRenderer(options);
    const b = gridRenderer(options);
    a.r.setData(gridData());
    b.r.setData(gridData());
    const lit = litOf(GRID_N, { 0: 1, 6: 0.5 });
    const shared = new Uint8Array(GRID_N);
    shared[0] = 1;
    b.r.setLit(lit, shared);
    const frames = [
      { ...GRID_STATE, twinkle: 0.18, time: 0.5 },
      { ...GRID_STATE, twinkle: 0.18, time: 0.6, trails: 0.17, filter: 0 },
      { ...GRID_STATE, twinkle: 0.18, time: 0.7, trails: 0.17, filter: 0, unlitGain: 0 },
    ];
    const diffs = [];
    for (const st of frames) {
      a.r.draw(st);
      const pa = readAll(a.gl);
      b.r.draw(st);
      diffs.push(firstDiff(pa, readAll(b.gl)));
    }
    b.r.setLit(null);
    a.r.draw(GRID_STATE);
    const pa = readAll(a.gl);
    b.r.draw(GRID_STATE);
    diffs.push(firstDiff(pa, readAll(b.gl)));
    const res = { diffs: diffs, lit: countLit(pa), hdr: a.r.status().hdr };
    retire(a);
    retire(b);
    return res;
  }

  // Dimming and brightness: a lit set against the same set with no filter; and point 11 (lit
  // 1) against its mirror image point 13 (lit 0.4), with points 16 and 18 both lit 0.7 as the
  // control that mirror positions read the same.
  function dimCase(options) {
    const g = gridRenderer(options);
    g.r.setData(gridData());
    g.r.draw(GRID_STATE);
    const plain = countLit(readAll(g.gl));
    const set = g.r.setLit(litOf(GRID_N, { 11: 1, 13: 0.4, 16: 0.7, 18: 0.7 }));
    g.r.draw({ ...GRID_STATE, filter: 1 });
    const px = readAll(g.gl);
    const at = (i) => windowSum(px, gridPixel(window.EmbeddingsTumbler._internal.renderer, i, GRID_STATE), 6);
    const res = {
      set: set,
      status: g.r.status(),
      plainLit: plain,
      dimmedLit: countLit(px),
      high: at(11),
      low: at(13),
      controlLeft: at(16),
      controlRight: at(18),
      unlit: at(12),
    };
    retire(g);
    return res;
  }

  // The lit buffer's offsets through appends: point `bright` lit 1, every other point 0, so
  // its window must outshine an unlit neighbour's. `steps` are run in order.
  function appendCase(steps) {
    const R = window.EmbeddingsTumbler._internal.renderer;
    const g = gridRenderer();
    const log = [];
    for (const step of steps) log.push(step(g.r));
    g.r.draw({ ...GRID_STATE, filter: 1 });
    const px = readAll(g.gl);
    const sums = {};
    for (let i = 0; i < g.r.status().count; i++) sums[i] = windowSum(px, gridPixel(R, i, GRID_STATE), 6);
    const res = { log: log, sums: sums, count: g.r.status().count, capacity: g.r.status().capacity };
    retire(g);
    return res;
  }

  function appendCases() {
    const data = (from, to) => {
      const all = gridData(ORANGE, to);
      return { vectors: all.vectors.subarray(from * GRID_D), colours: all.colours.subarray(from * 3) };
    };
    // set 10, append 1 (reallocates to capacity 20), append 9 in place (count 20), then light 17
    const appendThenLit = appendCase([
      (r) => r.setData(gridData(ORANGE, 10)),
      (r) => r.appendData(data(10, 11)),
      (r) => r.appendData(data(11, 20)),
      (r) => r.setLit(litOf(20, { 17: 1 })),
    ]);
    // set 10, append 1 (capacity 20), light 7 and 10, append 6 in place, append 8 more
    // (reallocates to capacity 40); the appended points come in at lit value 0
    const litThenAppend = appendCase([
      (r) => r.setData(gridData(ORANGE, 10)),
      (r) => r.appendData(data(10, 11)),
      (r) => r.setLit(litOf(11, { 7: 1, 10: 1 })),
      (r) => r.appendData(data(11, 17)),
      (r) => r.appendData(data(17, 25)),
    ]);
    return { appendThenLit: appendThenLit, litThenAppend: litThenAppend };
  }

  // Two stages as the viewer builds them (js/src/50-viewer.js, "The renderer draws light on
  // black"): a dark sky with the canvas screened over it, and a light sky with the canvas
  // inverted, multiplied and at 70% opacity, drawn in complementary colours with gain 0.55
  // and bloom 0.3. Points 11 and 13 (mirror images) are both lit 1; 13 carries the shared
  // mark. The test reads the composited colours from screenshots of the two stages.
  function stage(id, background) {
    const el = document.createElement("div");
    el.id = id;
    el.style.width = SIZE + "px";
    el.style.height = SIZE + "px";
    el.style.background = background;
    el.style.isolation = "isolate";
    el.style.lineHeight = "0";
    document.body.appendChild(el);
    return el;
  }

  function markStage(id, light) {
    const el = stage(id, light ? "rgb(244, 239, 230)" : "rgb(11, 20, 48)");
    const g = gridRenderer({ preserveDrawingBuffer: true }, el);
    g.canvas.style.display = "block";
    g.canvas.style.mixBlendMode = light ? "multiply" : "screen";
    g.canvas.style.filter = light ? "invert(1)" : "none";
    g.canvas.style.opacity = light ? "0.7" : "1";
    g.r.setData(gridData(light ? inkUpload(ORANGE) : ORANGE));
    const shared = new Uint8Array(GRID_N);
    shared[13] = 1;
    g.r.setLit(litOf(GRID_N, { 11: 1, 13: 1 }), shared);
    const state = light ? { ...GRID_STATE, gain: 0.55, bloom: 0.3, filter: 1 } : { ...GRID_STATE, filter: 1 };
    g.r.draw(state);
    const R = window.EmbeddingsTumbler._internal.renderer;
    return { selector: "#" + id, plain: gridPixel(R, 11, state), marked: gridPixel(R, 13, state), lit: g.r.status().lit };
  }

  // Leak count for the search buffers: every GL object made by the renderer's context while
  // lit values are set, appended over and cleared, is deleted by dispose.
  function countingContext(gl) {
    const live = new Set();
    const kinds = ["Buffer", "VertexArray", "Program", "Texture", "Framebuffer"];
    for (const k of kinds) {
      const make = gl["create" + k].bind(gl);
      const drop = gl["delete" + k].bind(gl);
      gl["create" + k] = function () {
        const o = make();
        live.add(o);
        return o;
      };
      gl["delete" + k] = function (o) {
        live.delete(o);
        drop(o);
      };
    }
    return live;
  }

  function leakCase() {
    const g = gridRenderer();
    const live = countingContext(g.gl); // counts from here on: none made yet by this wrapper
    g.r.setData(gridData(ORANGE, 10));
    const afterData = live.size;
    g.r.setLit(litOf(10, { 1: 1 }));
    g.r.draw({ ...GRID_STATE, filter: 1 });
    g.r.appendData(gridData(ORANGE, 15)); // reallocates: the lit buffer is made again
    g.r.setLit(null);
    g.r.setLit(litOf(25, { 2: 1 }), new Uint8Array(25).fill(1));
    g.r.draw({ ...GRID_STATE, filter: 1 });
    const peak = live.size;
    g.r.dispose();
    const res = { afterData: afterData, peak: peak, afterDispose: live.size };
    g.canvas.remove();
    return res;
  }

  // Context loss and restore with lit values set: the dimmed picture comes back unchanged.
  async function litRestoreCase() {
    const events = [];
    const g = gridRenderer({
      onContextChange: function (e) {
        events.push(e.type);
      },
    });
    const ext = g.gl.getExtension("WEBGL_lose_context");
    if (!ext) return { skipped: "no WEBGL_lose_context" };
    g.r.setData(gridData());
    g.r.setLit(litOf(GRID_N, { 3: 1 }));
    const st = { ...GRID_STATE, filter: 1 };
    g.r.draw(st);
    const before = readAll(g.gl);
    ext.loseContext();
    await waitFor(events, "lost");
    ext.restoreContext();
    const restored = await waitFor(events, "restored");
    const drew = g.r.draw(st);
    const res = {
      restored: restored,
      drew: drew,
      lit: g.r.status().lit,
      diff: firstDiff(before, readAll(g.gl)),
      litPixels: countLit(before),
    };
    retire(g);
    return res;
  }

  async function searchCases() {
    out.search = {
      identity: identityCase(),
      identityNoHdr: identityCase({ hdr: false }),
      dim: dimCase(),
      dimNoHdr: dimCase({ hdr: false }),
      ...appendCases(),
      leak: leakCase(),
      restore: await litRestoreCase(),
      stages: { dark: markStage("stage-dark", false), light: markStage("stage-light", true) },
    };
  }

  async function run() {
    const R = window.EmbeddingsTumbler._internal.renderer;
    const probe = R.create(makeCanvas());
    if (!probe.ok) {
      out.unavailable = probe.message;
      return;
    }
    probe.renderer.dispose();
    const fx = await Promise.all([fetchFixture(FIXTURES["valid-384"]), fetchFixture(FIXTURES["valid-1024"])]);
    const a = drawFixture("d384", fx[0]);
    out.cases.d384 = a.result || { made: a.made };
    const b = drawFixture("d1024", fx[1]);
    out.cases.d1024 = b.result || { made: b.made };
    const c = drawFixture("d1024_nohdr", fx[1], { hdr: false });
    out.cases.d1024_nohdr = c.result || { made: c.made };
    a.renderer?.dispose();
    c.renderer?.dispose();
    if (b.renderer) await loseAndRestore(b);
    await searchCases();
  }

  function publish() {
    window.__rendererResult = out;
  }

  run().then(publish, function (e) {
    out.fatal = String(e?.stack || e);
    publish();
  });
})();
