// Page script for tests/browser/test_renderer_render.py. Loads two contract
// fixtures (384-d and 1024-d), draws each with ET.renderer, and records whether
// the frame has any lit pixels. Also checks the no-HDR fallback and a context
// loss and restore. The result is left on window.__rendererResult.
(function () {
  "use strict";
  var SIZE = 256;
  var out = { cases: {}, fatal: null, unavailable: null };

  function fetchFixture(name) {
    var base = "/tests/fixtures/contract/";
    return fetch(base + name + ".json")
      .then(function (r) {
        return r.json();
      })
      .then(function (meta) {
        return fetch(base + meta.vectors.file)
          .then(function (r) {
            return r.arrayBuffer();
          })
          .then(function (buf) {
            return { meta: meta, vectors: new Float32Array(buf) };
          });
      });
  }

  // Three orthonormal rows spanning the first points' differences, the mean as centre.
  function frameFor(v, n, d) {
    var c = new Float32Array(d);
    for (var i = 0; i < n; i++) for (var k = 0; k < d; k++) c[k] += v[i * d + k] / n;
    var f = new Float32Array(3 * d);
    for (var a = 0; a < 3; a++) {
      var src = (a + 1) % n;
      for (var k2 = 0; k2 < d; k2++) f[a * d + k2] = v[src * d + k2] - c[k2] + (a === 0 ? 0 : 1e-3 * Math.sin(k2 * (a + 1)));
      for (var b = 0; b < a; b++) {
        var dp = 0;
        for (var k3 = 0; k3 < d; k3++) dp += f[a * d + k3] * f[b * d + k3];
        for (var k4 = 0; k4 < d; k4++) f[a * d + k4] -= dp * f[b * d + k4];
      }
      var nn = 0;
      for (var k5 = 0; k5 < d; k5++) nn += f[a * d + k5] * f[a * d + k5];
      nn = 1 / Math.sqrt(nn);
      for (var k6 = 0; k6 < d; k6++) f[a * d + k6] *= nn;
    }
    var sq = 0;
    for (var p = 0; p < n; p++) {
      for (var ax = 0; ax < 3; ax++) {
        var s = 0;
        for (var k7 = 0; k7 < d; k7++) s += (v[p * d + k7] - c[k7]) * f[ax * d + k7];
        sq += s * s;
      }
    }
    return { frame: f, centre: c, zoom: 0.78 / (Math.sqrt(sq / n) || 1) };
  }

  function litPixels(gl) {
    var px = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var lit = 0,
      max = 0;
    for (var i = 0; i < px.length; i += 4) {
      var m = Math.max(px[i], px[i + 1], px[i + 2]);
      if (m > 8) lit++;
      if (m > max) max = m;
    }
    return { lit: lit, max: max };
  }

  function makeCanvas() {
    var c = document.createElement("canvas");
    c.width = SIZE;
    c.height = SIZE;
    document.body.appendChild(c);
    return c;
  }

  function drawFixture(key, fx, options) {
    var R = window.EmbeddingsTumbler._internal.renderer;
    var canvas = makeCanvas();
    var events = [];
    var opts = Object.assign({ onContextChange: function (e) { events.push(e.type); } }, options || {});
    var made = R.create(canvas, opts);
    if (!made.ok) return { made: made };
    var r = made.renderer;
    var d = fx.meta.dimension,
      n = fx.meta.count;
    var colours = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      colours[i * 3] = 1;
      colours[i * 3 + 1] = 0.6 + 0.1 * i;
      colours[i * 3 + 2] = 0.3;
    }
    var set = r.setData({ vectors: fx.vectors, dimension: d, colours: colours });
    var pairs = new Uint32Array([0, 1, 1, 2]);
    r.setWires(pairs);
    var view = frameFor(fx.vectors, n, d);
    var state = { frame: view.frame, centre: view.centre, zoom: view.zoom, wires: 1, time: 0.5, pointSize: 12 };
    r.draw(state);
    var gl = canvas.getContext("webgl2");
    var res = { made: { ok: true }, set: set.ok, status: r.status(), pixels: litPixels(gl), events: events };
    return { result: res, renderer: r, gl: gl, state: state, events: events };
  }

  function waitFor(events, type) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      (function poll() {
        if (events.indexOf(type) >= 0 || performance.now() - t0 > 5000) resolve(events.indexOf(type) >= 0);
        else setTimeout(poll, 20);
      })();
    });
  }

  function run() {
    var R = window.EmbeddingsTumbler._internal.renderer;
    var probe = R.create(makeCanvas());
    if (!probe.ok) {
      out.unavailable = probe.message;
      return Promise.resolve();
    }
    probe.renderer.dispose();
    return Promise.all([fetchFixture("valid-384"), fetchFixture("valid-1024")]).then(function (fx) {
      var a = drawFixture("d384", fx[0]);
      out.cases.d384 = a.result || { made: a.made };
      var b = drawFixture("d1024", fx[1]);
      out.cases.d1024 = b.result || { made: b.made };
      var c = drawFixture("d1024_nohdr", fx[1], { hdr: false });
      out.cases.d1024_nohdr = c.result || { made: c.made };
      if (a.renderer) a.renderer.dispose();
      if (c.renderer) c.renderer.dispose();
      if (!b.renderer) return;
      // context loss and restore on the 1024-d view
      var ext = b.gl.getExtension("WEBGL_lose_context");
      if (!ext) {
        out.cases.restore = { skipped: "no WEBGL_lose_context" };
        return;
      }
      ext.loseContext();
      return waitFor(b.events, "lost").then(function (gotLost) {
        var drewWhileLost = b.renderer.draw(b.state);
        ext.restoreContext();
        return waitFor(b.events, "restored").then(function (gotRestored) {
          var drew = b.renderer.draw(b.state);
          out.cases.restore = {
            lost: gotLost,
            drewWhileLost: drewWhileLost,
            restored: gotRestored,
            drew: drew,
            events: b.events.slice(),
            pixels: litPixels(b.gl),
          };
          b.renderer.dispose();
        });
      });
    });
  }

  run()
    .catch(function (e) {
      out.fatal = String((e && e.stack) || e);
    })
    .then(function () {
      window.__rendererResult = out;
    });
})();
