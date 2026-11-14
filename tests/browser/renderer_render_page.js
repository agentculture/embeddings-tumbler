// Page script for tests/browser/test_renderer_render.py. Loads two contract
// fixtures (384-d and 1024-d), draws each with ET.renderer, and records whether
// the frame has any lit pixels. Also checks the no-HDR fallback and a context
// loss and restore. The result is left on window.__rendererResult.
(function () {
  "use strict";
  const SIZE = 256;
  const out = { cases: {}, fatal: null, unavailable: null };

  async function fetchFixture(name) {
    const base = "/tests/fixtures/contract/";
    const meta = await (await fetch(base + name + ".json")).json();
    const buf = await (await fetch(base + meta.vectors.file)).arrayBuffer();
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

  async function run() {
    const R = window.EmbeddingsTumbler._internal.renderer;
    const probe = R.create(makeCanvas());
    if (!probe.ok) {
      out.unavailable = probe.message;
      return;
    }
    probe.renderer.dispose();
    const fx = await Promise.all([fetchFixture("valid-384"), fetchFixture("valid-1024")]);
    const a = drawFixture("d384", fx[0]);
    out.cases.d384 = a.result || { made: a.made };
    const b = drawFixture("d1024", fx[1]);
    out.cases.d1024 = b.result || { made: b.made };
    const c = drawFixture("d1024_nohdr", fx[1], { hdr: false });
    out.cases.d1024_nohdr = c.result || { made: c.made };
    a.renderer?.dispose();
    c.renderer?.dispose();
    if (b.renderer) await loseAndRestore(b);
  }

  function publish() {
    window.__rendererResult = out;
  }

  run().then(publish, function (e) {
    out.fatal = String(e?.stack || e);
    publish();
  });
})();
