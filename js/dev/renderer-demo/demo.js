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
  const q = new URLSearchParams(location.search);
  const D = Math.max(1, Number.parseInt(q.get("d") || "1024", 10));
  const N = Math.max(1, Number.parseInt(q.get("n") || "5000", 10));
  const SEED = Number.parseInt(q.get("seed") || "20261113", 10);
  const BENCH = q.get("bench") === "1";
  const info = document.getElementById("info");
  const fpsEl = document.getElementById("fps");
  const canvas = document.getElementById("gl");
  const stats = { fps: 0, frames: 0, msPerFrame: null, ready: false, error: null };
  window.__demo = stats;

  // mulberry32. The state is kept as an unsigned 32-bit value (>>> 0): every operation
  // below reads only its low 32 bits, so the stream is the same as with a signed state.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(SEED);
  function gauss() {
    let u, v, s;
    do {
      u = rnd() * 2 - 1;
      v = rnd() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  }
  function unit(d) {
    const v = new Float32Array(d);
    let n = 0;
    for (let i = 0; i < d; i++) {
      v[i] = gauss();
      n += v[i] * v[i];
    }
    n = 1 / Math.sqrt(n);
    for (let j = 0; j < d; j++) v[j] *= n;
    return v;
  }
  function hsl(h, s, l) {
    function f(n) {
      const k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }

  // A clustered synthetic set in the spirit of the reference: regions with blobs and
  // filaments, bridges between them, and a faint unstructured halo. Unit length, centred.
  const REGIONS = 9;
  const SPREAD = [0.22, 0.16, 0.12, 0.08, 0.06];

  // Each kind of point adds its position into acc and says its colour, weight and noise.
  function regionPoint(acc, d, G, weight) {
    axpy(acc, d, 1, G.c);
    if (rnd() < 0.5) {
      for (let j = 0; j < 5; j++) axpy(acc, d, gauss() * SPREAD[j], G.dirs[j]);
    } else {
      const s = (rnd() + rnd() - 1) * 1.25;
      axpy(acc, d, 0.36 * s, G.dirs[0]);
      axpy(acc, d, 0.19 * Math.sin(2.3 * s), G.dirs[1]);
      axpy(acc, d, 0.11 * Math.cos(3.1 * s), G.dirs[2]);
    }
    return { rgb: G.rgb, weight: weight, noise: 0.004 };
  }
  function bridgePoint(acc, d, regions, rr, weight) {
    const G = regions[rr];
    const Z = regions[(rr + 1 + Math.floor(rnd() * (REGIONS - 1))) % REGIONS];
    const s2 = rnd();
    axpy(acc, d, 1 - s2, G.c);
    axpy(acc, d, s2, Z.c);
    axpy(acc, d, 0.3 * Math.sin(Math.PI * s2), G.dirs[4]);
    const rgb = [G.rgb[0] + (Z.rgb[0] - G.rgb[0]) * s2, G.rgb[1] + (Z.rgb[1] - G.rgb[1]) * s2, G.rgb[2] + (Z.rgb[2] - G.rgb[2]) * s2];
    return { rgb: rgb, weight: weight * 0.8, noise: 0.004 };
  }
  function haloPoint(acc, d) {
    for (let h = 0; h < d; h++) acc[h] = gauss();
    return { rgb: [0.55, 0.68, 1], weight: 0.05 + 0.2 * rnd() * rnd(), noise: 0 };
  }
  function axpy(acc, d, k, v) {
    for (let i = 0; i < d; i++) acc[i] += k * v[i];
  }
  // Add the noise, normalise acc into row p of X, and clear acc.
  function writeRow(X, p, d, acc, noise) {
    let nn = 0;
    for (let k = 0; k < d; k++) {
      const x = acc[k] + (rnd() + rnd() - 1) * 2.449 * noise;
      acc[k] = x;
      nn += x * x;
    }
    nn = 1 / Math.sqrt(nn);
    for (let m = 0; m < d; m++) {
      X[p * d + m] = acc[m] * nn;
      acc[m] = 0;
    }
  }

  function synthetic(n, d) {
    const regions = [];
    for (let r = 0; r < REGIONS; r++) {
      regions.push({ c: unit(d), dirs: SPREAD.map(() => unit(d)), rgb: hsl((r * 360) / REGIONS + 28, 0.9, 0.62) });
    }
    const X = new Float32Array(n * d);
    const col = new Float32Array(n * 3);
    const w = new Float32Array(n);
    const group = new Int32Array(n);
    const acc = new Float64Array(d);
    for (let p = 0; p < n; p++) {
      const t = rnd();
      let weight = 0.1 + 0.55 * Math.pow(rnd(), 3);
      const rr = Math.floor(rnd() * REGIONS);
      group[p] = rr;
      if (p < 300) weight = 1;
      let made;
      if (t < 0.6) made = regionPoint(acc, d, regions[rr], weight);
      else if (t < 0.82) made = bridgePoint(acc, d, regions, rr, weight);
      else {
        made = haloPoint(acc, d);
        group[p] = -1;
      }
      writeRow(X, p, d, acc, made.noise);
      col[p * 3] = made.rgb[0];
      col[p * 3 + 1] = made.rgb[1];
      col[p * 3 + 2] = made.rgb[2];
      w[p] = made.weight;
    }
    centre(X, n, d);
    const dirs = regions.slice(0, 6).map((g) => g.c);
    return { vectors: X, colours: col, weights: w, groups: group, dirs: dirs, source: "synthetic, seed " + SEED };
  }

  function centre(X, n, d) {
    const mean = new Float64Array(d);
    for (let i = 0; i < n; i++) for (let k = 0; k < d; k++) mean[k] += X[i * d + k] / n;
    for (let j = 0; j < n; j++) for (let m = 0; m < d; m++) X[j * d + m] -= mean[m];
  }

  // The contract fixtures this page can draw. ?fixture= only selects one of these by its
  // key: the addresses requested are the fixed ones below, so no text from the query string
  // or from a fetched file is ever put in a request. file is the block name the fixture
  // must declare; block is the fixed address fetched for it.
  const FIXTURES = [
    {
      key: "valid-384",
      data: "/tests/fixtures/contract/valid-384.json",
      file: "valid-384.f32",
      block: "/tests/fixtures/contract/valid-384.f32",
    },
    {
      key: "valid-1024",
      data: "/tests/fixtures/contract/valid-1024.json",
      file: "valid-1024.f32",
      block: "/tests/fixtures/contract/valid-1024.f32",
    },
    {
      key: "top-k-16",
      data: "/tests/fixtures/contract/top-k-16.json",
      file: "top-k-16.f32",
      block: "/tests/fixtures/contract/top-k-16.f32",
    },
    {
      key: "labels-only",
      data: "/tests/fixtures/contract/labels-only.json",
      file: "labels-only.f32",
      block: "/tests/fixtures/contract/labels-only.f32",
    },
    {
      key: "append-384",
      data: "/tests/fixtures/contract/append-384.json",
      file: "append-384.f32",
      block: "/tests/fixtures/contract/append-384.f32",
    },
  ];

  async function fixture(known) {
    const name = known.key;
    const r = await fetch(known.data);
    if (!r.ok) throw new Error("no fixture " + name);
    const meta = await r.json();
    if (meta.vectors?.file !== known.file) throw new Error("fixture " + name + " names an unexpected vector block");
    const buf = await (await fetch(known.block)).arrayBuffer();
    const d = meta.dimension;
    const n = meta.count;
    const X = new Float32Array(buf.slice(0));
    centre(X, n, d);
    const col = new Float32Array(n * 3);
    const w = new Float32Array(n).fill(1);
    const dirs = [];
    for (let i = 0; i < n; i++) {
      const c = hsl((i * 360) / n + 28, 0.9, 0.62);
      col.set(c, i * 3);
      if (dirs.length < 6) dirs.push(X.slice(i * d, i * d + d));
    }
    while (dirs.length < 6) dirs.push(unit(d));
    return { vectors: X, colours: col, weights: w, dirs: dirs, dimension: d, count: n, source: "fixture " + name + " (" + meta.model + ")" };
  }

  // Six orthonormal directions to turn the frame through.
  function basis(dirs, d) {
    const u = dirs.map((v) => Float64Array.from(v));
    for (let a = 0; a < u.length; a++) {
      for (let b = 0; b < a; b++) {
        let dp = 0;
        for (let k = 0; k < d; k++) dp += u[a][k] * u[b][k];
        for (let k2 = 0; k2 < d; k2++) u[a][k2] -= dp * u[b][k2];
      }
      let nn = 0;
      for (let k3 = 0; k3 < d; k3++) nn += u[a][k3] * u[a][k3];
      nn = Math.sqrt(nn);
      if (nn < 1e-6) {
        u[a] = Float64Array.from(unit(d));
        a--;
        continue;
      }
      for (let k4 = 0; k4 < d; k4++) u[a][k4] /= nn;
    }
    return u;
  }

  // True neighbours (full dimension) for the first S points, three wires each. The
  // brute-force cost is S * S * d multiply-adds, so S shrinks as d grows to keep the total
  // near WIRE_BUDGET, and the rows are done a slice at a time between frames so the page
  // never freezes. done(pairs, S, ms) is called at the end.
  const WIRE_BUDGET = 6e7; // multiply-adds in total
  const SLICE_BUDGET = 3e6; // multiply-adds per slice (a few milliseconds)

  // Squared distances from point i to points 0..S-1 (Infinity for i itself) into dist,
  // and their indices into order.
  function rowDistances(X, d, S, i, dist, order) {
    order.length = 0;
    for (let j = 0; j < S; j++) {
      let s = 0;
      if (j !== i) {
        for (let k = 0; k < d; k++) {
          const t = X[i * d + k] - X[j * d + k];
          s += t * t;
        }
      }
      dist[j] = j === i ? Infinity : s;
      order.push(j);
    }
  }

  function wiresInSlices(X, n, d, done) {
    let S = Math.max(2, Math.min(n, 500, Math.floor(Math.sqrt(WIRE_BUDGET / d))));
    S = Math.min(S, n);
    const perSlice = Math.max(1, Math.floor(SLICE_BUDGET / (S * d)));
    const pairs = [];
    const seen = {};
    const dist = new Float32Array(S);
    const order = [];
    const t0 = performance.now();
    let i = 0;
    function slice() {
      const end = Math.min(S, i + perSlice);
      for (; i < end; i++) {
        rowDistances(X, d, S, i, dist, order);
        order.sort((a, b) => dist[a] - dist[b]);
        for (let m = 0; m < Math.min(3, S - 1); m++) {
          const o = order[m];
          const key = i < o ? i + ":" + o : o + ":" + i;
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
    const R = window.EmbeddingsTumbler._internal.renderer;
    const made = R.create(canvas, { hdr: q.get("hdr") !== "0", onContextChange: (e) => { info.textContent += "\ncontext " + e.type + " " + e.message; } });
    if (!made.ok) {
      info.textContent = made.message;
      stats.error = made.reason;
      return;
    }
    const r = made.renderer;
    const d = set.dimension || D;
    const n = set.vectors.length / d;
    const res = r.setData({ vectors: set.vectors, dimension: d, colours: set.colours, weights: set.weights });
    if (!res.ok) {
      info.textContent = res.message;
      stats.error = res.reason;
      return;
    }
    let wireNote = "wires: measuring neighbours ...";
    const U = basis(set.dirs, d);
    const frame = new Float32Array(3 * d);
    const gl = canvas.getContext("webgl2");
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown GPU";
    const st = r.status();
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
    stats.n = n;
    stats.d = d;
    stats.hdr = st.hdr;
    stats.gpu = gpuName;
    stats.maxTextureSize = st.maxTextureSize;
    stats.maxPoints = st.layout.maxPoints;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    function resize() {
      r.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
    }
    resize();
    window.addEventListener("resize", resize);

    const state = { yaw: 0.4, pitch: 0.16, zoom: 5, wires: 0, trails: 0.17, fog: 0, depthOfField: 1.1, clear: false };
    let running = true;
    let clock = 0;
    let showWires = q.get("wires") === "1";
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; });
    window.addEventListener("pointerup", () => { drag = null; });
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

    const sample = Math.min(n, 400);
    function setFrame(t) {
      const w = [0.11, 0.07, 0.05];
      for (let a = 0; a < 3; a++) {
        const th = t * w[a] * 2;
        const c = Math.cos(th);
        const s = Math.sin(th);
        for (let k = 0; k < d; k++) frame[a * d + k] = c * U[a][k] + s * U[a + 3][k];
      }
    }
    function rms() {
      let sq = 0;
      for (let i = 0; i < sample; i++) {
        for (let a = 0; a < 3; a++) {
          let s = 0;
          for (let k = 0; k < d; k++) s += set.vectors[i * d + k] * frame[a * d + k];
          sq += s * s;
        }
      }
      return Math.sqrt(sq / sample) || 1;
    }

    let last = performance.now();
    let fpsT = last;
    let fpsN = 0;
    let benchSum = 0;
    let benchN = 0;
    const px = new Uint8Array(4);
    setFrame(0);
    state.zoom = 0.78 / rms();
    stats.ready = true;
    function tick(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
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
      const b0 = BENCH ? performance.now() : 0;
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

  function showError(e) {
    info.textContent = String(e);
    stats.error = String(e);
  }

  const asked = q.get("fixture");
  const known = FIXTURES.find((f) => f.key === asked) || null;
  if (asked !== null && !known) {
    info.textContent = "fixture must be one of: " + FIXTURES.map((f) => f.key).join(", ");
    stats.error = "bad-fixture-name";
    return;
  }
  (known ? fixture(known) : Promise.resolve(synthetic(N, D))).then(start).catch(showError);
})();
