// Dev-only host page for the viewer API (task t8). Not shipped. It uses only the
// public API: EmbeddingsTumbler.mount / update / destroy, the handle's info() and
// refreshTheme(), and the optional sample file. See README.md for the query string.
(function () {
  "use strict";
  var T = window.EmbeddingsTumbler;
  var q = new URLSearchParams(location.search);
  var D = parseInt(q.get("d") || "384", 10);
  var N = parseInt(q.get("n") || "12288", 10);
  var SEED = q.get("seed") || "1";
  var MODE = q.get("mode") || "tumble";
  var ONE = q.get("one") === "1"; // mount only the left viewer (for measuring)

  var cspCount = 0;
  var cspEl = document.getElementById("csp");
  document.addEventListener("securitypolicyviolation", function () {
    cspCount++;
    cspEl.textContent = String(cspCount);
  });

  // One pool of sample points per page: the first N are the set, the rest feed appends.
  var POOL_EXTRA = 2000;
  var t0 = performance.now();
  var pool = T.sample.generate({ dimension: D, count: N + POOL_EXTRA });
  var generateMs = performance.now() - t0;

  function slice(from, to, op) {
    var o = {
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      model: pool.model,
      dimension: D,
      count: to - from,
      text_included: true,
      points: pool.points.slice(from, to),
      vectors: pool.vectors.slice(from * D, to * D),
    };
    if (op === "append") o.op = "append";
    else o.provenance = pool.provenance;
    return o;
  }

  // Points past the pool: copies of random pool points, nudged, with new ids.
  function extra(side, k) {
    var vectors = new Float32Array(k * D);
    var points = [];
    for (var i = 0; i < k; i++) {
      var src = Math.floor(Math.random() * N);
      for (var d = 0; d < D; d++) vectors[i * D + d] = pool.vectors[src * D + d] + (Math.random() - 0.5) * 0.02;
      var p = pool.points[src];
      side.extraId++;
      points.push({ id: "extra-" + side.extraId, label: "", group: p.group });
    }
    return {
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      op: "append",
      model: pool.model,
      dimension: D,
      count: k,
      text_included: true,
      points: points,
      vectors: vectors,
    };
  }

  var THEMES = [
    { name: "dark", props: {} },
    {
      name: "teal",
      props: {
        "--tumbler-background": "#021014",
        "--tumbler-sky": "#06323a",
        "--tumbler-accent": "#5fe0c8",
        "--tumbler-foreground": "#dff7f2",
        "--tumbler-font": "Georgia, serif",
      },
    },
  ];
  // Three light treatments, chosen with --tumbler-light-style (see js/api/50-viewer.md).
  [
    ["light: dark stage panel", "panel"],
    ["light: coloured ink", "ink"],
    ["light: soft ink", "soft"],
  ].forEach(function (pair) {
    THEMES.push({
      name: pair[0],
      props: {
        "--tumbler-background": "#f6f4ee",
        "--tumbler-sky": "#ffffff",
        "--tumbler-foreground": "#1b2130",
        "--tumbler-muted": "#5b6578",
        "--tumbler-line": "#d6dae2",
        "--tumbler-accent": "#a35f00",
        "--tumbler-light-style": pair[1],
      },
    });
  });
  var START_THEME = q.get("theme") || "";
  var ALL_PROPS = [];
  THEMES.forEach(function (t) {
    Object.keys(t.props).forEach(function (k) {
      if (ALL_PROPS.indexOf(k) < 0) ALL_PROPS.push(k);
    });
  });

  // Longest gap between animation frames in the last 5 s, seen by the page itself.
  var gaps = [];
  var lastFrameAt = null;
  function watchFrames(t) {
    if (lastFrameAt !== null) gaps.push([t, t - lastFrameAt]);
    lastFrameAt = t;
    while (gaps.length && gaps[0][0] < t - 5000) gaps.shift();
    requestAnimationFrame(watchFrames);
  }
  requestAnimationFrame(watchFrames);
  function longestGap() {
    var m = 0;
    gaps.forEach(function (g) {
      if (g[1] > m) m = g[1];
    });
    return m;
  }

  var sides = {};
  ["a", "b"].forEach(function (name) {
    var section = document.querySelector('[data-side="' + name + '"]');
    var side = {
      name: name,
      el: document.getElementById("space-" + name),
      info: document.getElementById("info-" + name),
      handle: null,
      next: N,
      extraId: 0,
      theme: 0,
      lastResult: null,
      appendMs: [],
    };
    sides[name] = side;
    var buttons = section.querySelectorAll("button[data-act]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", act.bind(null, side));
    }
  });

  function act(side, e) {
    var what = e.currentTarget.dataset.act;
    var r = null;
    if (what === "mount") {
      side.handle = T.mount(side.el, { seed: SEED, mode: MODE, title: side.name === "a" ? "Embedding Tumbler" : "" });
    } else if (what === "update") {
      side.next = N;
      side.extraId = 0;
      var u0 = performance.now();
      r = T.update(side.el, slice(0, N, "replace"));
      side.updateMs = performance.now() - u0;
    } else if (what === "append") {
      var data;
      if (side.next + 200 <= N + POOL_EXTRA) {
        data = slice(side.next, side.next + 200, "append");
        side.next += 200;
      } else data = extra(side, 200);
      var a0 = performance.now();
      r = T.update(side.el, data);
      side.appendMs.push(performance.now() - a0);
    } else if (what === "invalid") {
      r = T.update(side.el, { schema_version: 2, kind: "embeddings-tumbler/data" });
    } else if (what === "markup") {
      var m = slice(0, 400, "replace");
      m.points = m.points.map(function (p, i) {
        return {
          id: p.id,
          label: i === 0 ? '<img src=x onerror="alert(1)"> <b>bold?</b>' : p.label,
          group: p.group === "ocean" ? "<i>ocean</i>" : p.group,
        };
      });
      r = T.update(side.el, m);
    } else if (what === "theme") {
      setTheme(side, (side.theme + 1) % THEMES.length, e.currentTarget);
    } else if (what === "destroy") {
      r = T.destroy(side.el);
      side.handle = null;
    }
    if (r !== null) side.lastResult = r;
    show(side);
  }

  function setTheme(side, index, button) {
    side.theme = index;
    var th = THEMES[side.theme];
    ALL_PROPS.forEach(function (k) {
      side.el.style.removeProperty(k);
    });
    Object.keys(th.props).forEach(function (k) {
      side.el.style.setProperty(k, th.props[k]);
    });
    button.textContent = "theme: " + th.name;
    if (side.handle) side.handle.refreshTheme();
  }

  function show(side) {
    var h = T.get(side.el);
    var lines = [];
    if (!h) lines.push("not mounted. Press mount, then update: mount carries no data.");
    else {
      var i = h.info();
      lines.push(
        "mode " + i.mode + (i.paused ? " (paused)" : "") + (i.suspended ? " (suspended)" : "") +
          " | t " + i.time.toFixed(2) + " s | seed " + i.seed + " | zoom " + i.zoom.toFixed(2)
      );
      lines.push(i.count + " points x " + i.dimension + "-d | " + (i.fps ? i.fps.toFixed(1) : "-") + " fps | frames " + i.frames);
      lines.push(
        "first frame " + fmt(i.timing.firstFrameMs) + " ms | ready " + fmt(i.timing.firstReadyMs) +
          " ms | longest frame " + fmt(i.timing.longestFrameMs) + " ms | refits " + i.timing.refits
      );
      var lr = i.timing.lastRefit;
      lines.push(
        "longest frame gap, last 5 s: " + fmt(longestGap()) + " ms | last refit: " +
          (lr ? "at " + fmt(lr.atMs / 1000) + " s, " + fmt(lr.durationMs) + " ms of work, longest step " + fmt(lr.longestStepMs) + " ms" : "none")
      );
      if (side.updateMs !== undefined) lines.push("last update() " + fmt(side.updateMs) + " ms");
      if (side.appendMs.length) lines.push("append() ms: " + side.appendMs.map(fmt).join(", "));
    }
    if (side.lastResult !== null) lines.push("last result: " + JSON.stringify(side.lastResult));
    lines.push("sample generated in " + fmt(generateMs) + " ms");
    side.info.textContent = lines.join("\n");
  }

  function fmt(x) {
    return x === null || x === undefined ? "-" : Number(x).toFixed(1);
  }

  setInterval(function () {
    show(sides.a);
    show(sides.b);
  }, 500);

  // Start with both mounted and fed (or only the left one with ?one=1).
  window.__viewerDemo = { sides: sides, D: D, N: N };
  ["a", "b"].forEach(function (name) {
    if (ONE && name === "b") return;
    var s = sides[name];
    s.handle = T.mount(s.el, { seed: SEED, mode: MODE, title: name === "a" ? "Embedding Tumbler" : "" });
    if (START_THEME) {
      var idx = THEMES.findIndex(function (t) {
        return t.name === START_THEME || (t.props["--tumbler-light-style"] || t.name) === START_THEME;
      });
      if (idx >= 0) setTheme(s, idx, document.querySelector('[data-side="' + name + '"] button[data-act="theme"]'));
    }
    var u0 = performance.now();
    s.lastResult = T.update(s.el, slice(0, N, "replace"));
    s.updateMs = performance.now() - u0;
    show(s);
  });
})();
