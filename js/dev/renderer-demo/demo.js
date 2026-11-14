// Dev-only live check of ET.renderer (task t6). Not shipped.
//
//   ?d=1024&n=5000        synthetic clustered points at that dimension and count
//   ?fixture=valid-1024   a contract fixture from tests/fixtures/contract/
//   ?seed=7               seed for the synthetic set
//   ?bench=1              also time each frame with a GPU sync (slower, but honest)
//   ?hdr=0                force the no-HDR fallback
//
// The frame turns slowly inside a six-direction subspace; this is a stand-in for the
// tour, which lives in another module. Loader code here is a few dev lines, not the
// real contract loader.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var D = Math.max(1, parseInt(q.get("d") || "1024", 10));
  var N = Math.max(1, parseInt(q.get("n") || "5000", 10));
  var SEED = parseInt(q.get("seed") || "20261113", 10);
  var BENCH = q.get("bench") === "1";
  var info = document.getElementById("info");
  var fpsEl = document.getElementById("fps");
  var canvas = document.getElementById("gl");
  var stats = { fps: 0, frames: 0, msPerFrame: null, ready: false, error: null };
  window.__demo = stats;

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rnd = mulberry32(SEED);
  function gauss() {
    var u, v, s;
    do {
      u = rnd() * 2 - 1;
      v = rnd() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  }
  function unit(d) {
    var v = new Float32Array(d),
      n = 0;
    for (var i = 0; i < d; i++) {
      v[i] = gauss();
      n += v[i] * v[i];
    }
    n = 1 / Math.sqrt(n);
    for (var j = 0; j < d; j++) v[j] *= n;
    return v;
  }
  function hsl(h, s, l) {
    function f(n) {
      var k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }

  // A clustered synthetic set in the spirit of the reference: regions with blobs and
  // filaments, bridges between them, and a faint unstructured halo. Unit length, centred.
  function synthetic(n, d) {
    var R = 9,
      spread = [0.22, 0.16, 0.12, 0.08, 0.06];
    var regions = [];
    for (var r = 0; r < R; r++) {
      regions.push({ c: unit(d), dirs: spread.map(function () { return unit(d); }), rgb: hsl((r * 360) / R + 28, 0.9, 0.62) });
    }
    var X = new Float32Array(n * d),
      col = new Float32Array(n * 3),
      w = new Float32Array(n),
      group = new Int32Array(n),
      acc = new Float64Array(d);
    function axpy(k, v) {
      for (var i = 0; i < d; i++) acc[i] += k * v[i];
    }
    for (var p = 0; p < n; p++) {
      var t = rnd(),
        rgb,
        weight = 0.1 + 0.55 * Math.pow(rnd(), 3),
        noise = 0.004;
      var rr = Math.floor(rnd() * R),
        G = regions[rr];
      group[p] = rr;
      if (p < 300) weight = 1;
      if (t < 0.6) {
        axpy(1, G.c);
        if (rnd() < 0.5) {
          for (var j = 0; j < 5; j++) axpy(gauss() * spread[j], G.dirs[j]);
        } else {
          var s = (rnd() + rnd() - 1) * 1.25;
          axpy(0.36 * s, G.dirs[0]);
          axpy(0.19 * Math.sin(2.3 * s), G.dirs[1]);
          axpy(0.11 * Math.cos(3.1 * s), G.dirs[2]);
        }
        rgb = G.rgb;
      } else if (t < 0.82) {
        var Z = regions[(rr + 1 + Math.floor(rnd() * (R - 1))) % R],
          s2 = rnd();
        axpy(1 - s2, G.c);
        axpy(s2, Z.c);
        axpy(0.3 * Math.sin(Math.PI * s2), G.dirs[4]);
        rgb = [G.rgb[0] + (Z.rgb[0] - G.rgb[0]) * s2, G.rgb[1] + (Z.rgb[1] - G.rgb[1]) * s2, G.rgb[2] + (Z.rgb[2] - G.rgb[2]) * s2];
        weight *= 0.8;
      } else {
        for (var h = 0; h < d; h++) acc[h] = gauss();
        rgb = [0.55, 0.68, 1.0];
        weight = 0.05 + 0.2 * rnd() * rnd();
        noise = 0;
        group[p] = -1;
      }
      var nn = 0;
      for (var k = 0; k < d; k++) {
        var x = acc[k] + (rnd() + rnd() - 1) * 2.449 * noise;
        acc[k] = x;
        nn += x * x;
      }
      nn = 1 / Math.sqrt(nn);
      for (var m = 0; m < d; m++) {
        X[p * d + m] = acc[m] * nn;
        acc[m] = 0;
      }
      col[p * 3] = rgb[0];
      col[p * 3 + 1] = rgb[1];
      col[p * 3 + 2] = rgb[2];
      w[p] = weight;
    }
    centre(X, n, d);
    var dirs = regions.slice(0, 6).map(function (g) { return g.c; });
    return { vectors: X, colours: col, weights: w, groups: group, dirs: dirs, source: "synthetic, seed " + SEED };
  }

  function centre(X, n, d) {
    var mean = new Float64Array(d);
    for (var i = 0; i < n; i++) for (var k = 0; k < d; k++) mean[k] += X[i * d + k] / n;
    for (var j = 0; j < n; j++) for (var m = 0; m < d; m++) X[j * d + m] -= mean[m];
  }

  function fixture(name) {
    var base = "/tests/fixtures/contract/";
    return fetch(base + encodeURIComponent(name) + ".json")
      .then(function (r) {
        if (!r.ok) throw new Error("no fixture " + name);
        return r.json();
      })
      .then(function (meta) {
        return fetch(base + encodeURIComponent(meta.vectors.file))
          .then(function (r) {
            return r.arrayBuffer();
          })
          .then(function (buf) {
            var d = meta.dimension,
              n = meta.count,
              X = new Float32Array(buf.slice(0));
            centre(X, n, d);
            var col = new Float32Array(n * 3),
              w = new Float32Array(n).fill(1),
              dirs = [];
            for (var i = 0; i < n; i++) {
              var c = hsl((i * 360) / n + 28, 0.9, 0.62);
              col.set(c, i * 3);
              if (dirs.length < 6) dirs.push(X.slice(i * d, i * d + d));
            }
            while (dirs.length < 6) dirs.push(unit(d));
            return { vectors: X, colours: col, weights: w, dirs: dirs, dimension: d, count: n, source: "fixture " + name + " (" + meta.model + ")" };
          });
      });
  }

  // Six orthonormal directions to turn the frame through.
  function basis(dirs, d) {
    var u = dirs.map(function (v) { return Float64Array.from(v); });
    for (var a = 0; a < u.length; a++) {
      for (var b = 0; b < a; b++) {
        var dp = 0;
        for (var k = 0; k < d; k++) dp += u[a][k] * u[b][k];
        for (var k2 = 0; k2 < d; k2++) u[a][k2] -= dp * u[b][k2];
      }
      var nn = 0;
      for (var k3 = 0; k3 < d; k3++) nn += u[a][k3] * u[a][k3];
      nn = Math.sqrt(nn);
      if (nn < 1e-6) {
        u[a] = Float64Array.from(unit(d));
        a--;
        continue;
      }
      for (var k4 = 0; k4 < d; k4++) u[a][k4] /= nn;
    }
    return u;
  }

  // True neighbours (full dimension) for the first S points, three wires each. The
  // brute-force cost is S * S * d multiply-adds, so S shrinks as d grows to keep the total
  // near WIRE_BUDGET, and the rows are done a slice at a time between frames so the page
  // never freezes. done(pairs, S, ms) is called at the end.
  var WIRE_BUDGET = 6e7; // multiply-adds in total
  var SLICE_BUDGET = 3e6; // multiply-adds per slice (a few milliseconds)
  function wiresInSlices(X, n, d, done) {
    var S = Math.max(2, Math.min(n, 500, Math.floor(Math.sqrt(WIRE_BUDGET / d))));
    S = Math.min(S, n);
    var perSlice = Math.max(1, Math.floor(SLICE_BUDGET / (S * d)));
    var pairs = [],
      seen = {},
      dist = new Float32Array(S),
      order = [],
      i = 0,
      t0 = performance.now();
    function slice() {
      var end = Math.min(S, i + perSlice);
      for (; i < end; i++) {
        order.length = 0;
        for (var j = 0; j < S; j++) {
          var s = 0;
          if (j !== i) for (var k = 0; k < d; k++) {
            var t = X[i * d + k] - X[j * d + k];
            s += t * t;
          }
          dist[j] = j === i ? Infinity : s;
          order.push(j);
        }
        order.sort(function (a, b) { return dist[a] - dist[b]; });
        for (var m = 0; m < Math.min(3, S - 1); m++) {
          var o = order[m],
            key = i < o ? i + ":" + o : o + ":" + i;
          if (!seen[key]) {
            seen[key] = 1;
            pairs.push(i, o);
          }
        }
      }
      if (i < S) setTimeout(slice, 0);
      else done(new Uint32Array(pairs), S, performance.now() - t0);
    }
    setTimeout(slice, 0);
  }

  function start(set) {
    var R = window.EmbeddingsTumbler._internal.renderer;
    var made = R.create(canvas, { hdr: q.get("hdr") !== "0", onContextChange: function (e) { info.textContent += "\ncontext " + e.type + " " + e.message; } });
    if (!made.ok) {
      info.textContent = made.message;
      stats.error = made.reason;
      return;
    }
    var r = made.renderer;
    var d = set.dimension || D,
      n = set.vectors.length / d;
    var res = r.setData({ vectors: set.vectors, dimension: d, colours: set.colours, weights: set.weights });
    if (!res.ok) {
      info.textContent = res.message;
      stats.error = res.reason;
      return;
    }
    var wireNote = "wires: measuring neighbours ...";
    var U = basis(set.dirs, d);
    var frame = new Float32Array(3 * d);
    var gl = canvas.getContext("webgl2");
    var dbg = gl.getExtension("WEBGL_debug_renderer_info");
    var gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown GPU";
    var st = r.status();
    function showInfo() {
      info.textContent =
        set.source + "\n" + n + " points x " + d + "-d, " + wireNote + "\n" +
        "layout: " + st.layout.texelsPerPoint + " texels/point, " + st.layout.pointsPerRow + " points/row, max " + st.layout.maxPoints +
        " points; MAX_TEXTURE_SIZE " + st.maxTextureSize + "\nhdr: " + st.hdr + "\n" + gpuName;
    }
    showInfo();
    wiresInSlices(set.vectors, n, d, function (pairs, S, ms) {
      r.setWires(pairs);
      wireNote = pairs.length / 2 + " wires (neighbours of the first " + S + ", " + ms.toFixed(0) + " ms in slices)";
      showInfo();
    });
    Object.assign(stats, { n: n, d: d, hdr: st.hdr, gpu: gpuName, maxTextureSize: st.maxTextureSize, maxPoints: st.layout.maxPoints });

    var dpr = Math.min(2, window.devicePixelRatio || 1);
    function resize() {
      r.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
    }
    resize();
    window.addEventListener("resize", resize);

    var state = { yaw: 0.4, pitch: 0.16, zoom: 5, wires: 0, trails: 0.17, fog: 0, depthOfField: 1.1, clear: false };
    var running = true,
      clock = 0,
      showWires = q.get("wires") === "1";
    var drag = null;
    canvas.addEventListener("pointerdown", function (e) { drag = [e.clientX, e.clientY]; });
    window.addEventListener("pointerup", function () { drag = null; });
    window.addEventListener("pointermove", function (e) {
      if (!drag) return;
      state.yaw += (e.clientX - drag[0]) * 0.007;
      state.pitch = Math.max(-1.3, Math.min(1.3, state.pitch + (e.clientY - drag[1]) * 0.007));
      drag = [e.clientX, e.clientY];
    });
    window.addEventListener("keydown", function (e) {
      if (e.key === " ") running = !running;
      else if (e.key === "w") showWires = !showWires;
      else if (e.key === "t") state.trails = state.trails > 0 ? 0 : 0.17;
      else if (e.key === "f") state.fog = state.fog > 0 ? 0 : 1;
      else if (e.key === "d") state.depthOfField = state.depthOfField > 0 ? 0 : 1.1;
      else if (e.key === "c") state.clear = true;
    });

    var sample = Math.min(n, 400);
    function setFrame(t) {
      var w = [0.11, 0.07, 0.05];
      for (var a = 0; a < 3; a++) {
        var th = t * w[a] * 2,
          c = Math.cos(th),
          s = Math.sin(th);
        for (var k = 0; k < d; k++) frame[a * d + k] = c * U[a][k] + s * U[a + 3][k];
      }
    }
    function rms() {
      var sq = 0;
      for (var i = 0; i < sample; i++) {
        for (var a = 0; a < 3; a++) {
          var s = 0;
          for (var k = 0; k < d; k++) s += set.vectors[i * d + k] * frame[a * d + k];
          sq += s * s;
        }
      }
      return Math.sqrt(sq / sample) || 1;
    }

    var last = performance.now(),
      fpsT = last,
      fpsN = 0,
      benchSum = 0,
      benchN = 0,
      px = new Uint8Array(4);
    setFrame(0);
    state.zoom = 0.78 / rms();
    stats.ready = true;
    function tick(now) {
      var dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;
      if (running) {
        clock += dt;
        setFrame(clock);
        state.yaw += dt * 0.06;
      }
      if (stats.frames % 30 === 0) state.zoom += (0.78 / rms() - state.zoom) * 0.3;
      state.wires += ((showWires ? 1 : 0) - state.wires) * (1 - Math.exp(-dt / 0.4));
      state.dt = dt;
      state.time = now / 1000;
      state.frame = frame;
      state.pointSize = 6.5 * dpr;
      var b0 = BENCH ? performance.now() : 0;
      r.draw(state);
      if (BENCH) {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // waits for the GPU
        benchSum += performance.now() - b0;
        benchN++;
      }
      state.clear = false;
      stats.frames++;
      fpsN++;
      if (now - fpsT >= 1000) {
        stats.fps = (fpsN * 1000) / (now - fpsT);
        if (BENCH && benchN) stats.msPerFrame = benchSum / benchN;
        fpsEl.textContent = stats.fps.toFixed(1) + " fps" + (BENCH && benchN ? " | " + (benchSum / benchN).toFixed(1) + " ms/frame" : "");
        fpsT = now;
        fpsN = 0;
        benchSum = 0;
        benchN = 0;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  var name = q.get("fixture");
  if (name !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    info.textContent = "fixture must be a plain name such as valid-1024";
    stats.error = "bad-fixture-name";
    return;
  }
  (name ? fixture(name) : Promise.resolve(synthetic(N, D)))
    .then(start)
    .catch(function (e) {
      info.textContent = String(e);
      stats.error = String(e);
    });
})();
