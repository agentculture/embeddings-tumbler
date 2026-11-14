// ---------------------------------------------------------------------------
// 39-modes.js: the mode interface and registry (ET.modes).
//
// A mode owns its motion and its draw parameters and nothing else. It never
// touches WebGL or the DOM. Given the loaded set, a seed and the time in the
// mode, it answers a frame (three orthonormal rows of length D), a centre, a
// plain draw-parameter object for ET.renderer.draw, optional wires (index
// pairs) and a one-line plain-text status. The viewer owns the renderer, the
// clock, the data and the DOM.
//
// The three shipped modes live in 40-mode-tumble.js, 41-mode-lattice.js and
// 42-mode-wander.js and register themselves here. A fourth mode registers the
// same way, without touching them or the data contract.
//
// Documented in js/api/40-modes.md.
// ---------------------------------------------------------------------------
ET.modes = (function () {
  // Members every mode instance must have (see js/api/40-modes.md).
  // Optional members: mark(t) (fix the time of a finished event) and, for
  // Tumble, refit(t).
  var INTERFACE = ["enter", "prepare", "isReady", "stateAt", "step", "status", "dataChanged", "describe", "leave"];
  var ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
  var registry = [];

  function copyDef(def) {
    return { id: def.id, title: def.title, summary: def.summary, create: def.create };
  }

  // register({ id, title, summary, create(options) -> instance })
  function register(def) {
    if (!def || typeof def !== "object") throw new TypeError("a mode definition must be an object");
    if (typeof def.id !== "string" || !ID_PATTERN.test(def.id)) {
      throw new TypeError("a mode id must be lower-case letters, digits and hyphens, starting with a letter");
    }
    if (typeof def.title !== "string" || def.title.length === 0) throw new TypeError("a mode needs a title");
    if (typeof def.summary !== "string") throw new TypeError("a mode needs a summary string");
    if (typeof def.create !== "function") throw new TypeError("a mode needs a create(options) function");
    for (var known of registry) {
      if (known.id === def.id) throw new Error("mode '" + def.id + "' is already registered");
    }
    registry.push(copyDef(def));
  }

  function find(id) {
    for (var d of registry) if (d.id === id) return d;
    return null;
  }

  function get(id) {
    var d = find(id);
    return d ? copyDef(d) : null;
  }

  function list() {
    return registry.map(copyDef);
  }

  function ids() {
    return registry.map(function (d) {
      return d.id;
    });
  }

  // Names of interface members the instance lacks ([] when it conforms).
  function check(instance) {
    if (!instance || typeof instance !== "object") return INTERFACE.slice();
    return INTERFACE.filter(function (name) {
      return typeof instance[name] !== "function";
    });
  }

  function create(id, options) {
    var d = find(id);
    if (!d) throw new RangeError("no mode is registered as '" + id + "'");
    var inst = d.create(options || {});
    var missing = check(inst);
    if (missing.length) throw new TypeError("mode '" + id + "' is missing " + missing.join(", "));
    return inst;
  }

  // ----- bounded preparation ------------------------------------------------

  function now() {
    if (typeof performance !== "undefined" && typeof performance?.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  // A stepper over tasks { run() -> done, required?, weight?, progress?() }.
  // Each run() call does one bounded unit of work. step(budgetMs) runs units
  // until the budget is spent (always at least one); step() with no budget runs
  // everything. The clock only decides how much work happens per call, never
  // what the work computes.
  function stepper(tasks) {
    var list = tasks.slice();
    var units = list.map(function () {
      return 0;
    });
    var finished = list.map(function () {
      return false;
    });
    var api = { done: false, ready: false, progress: 0, step: step };

    // Share of task i done so far: 1 when finished, else its own estimate
    // (kept below 1), else a guess from the units it has run.
    function taskProgress(i) {
      if (finished[i]) return 1;
      if (typeof list[i].progress === "function") return Math.max(0, Math.min(0.999, list[i].progress()));
      return 1 - 1 / (1 + units[i]);
    }

    function refresh() {
      var total = 0;
      var got = 0;
      var ready = true;
      var done = true;
      for (var i = 0; i < list.length; i++) {
        var w = list[i].weight === undefined ? 1 : list[i].weight;
        total += w;
        var p = taskProgress(i);
        got += w * p;
        if (!finished[i]) {
          done = false;
          if (list[i].required) ready = false;
        }
      }
      api.done = done;
      api.ready = ready;
      if (done) api.progress = 1;
      else api.progress = total > 0 ? got / total : 1;
    }

    function step(budgetMs) {
      var limit = budgetMs === undefined ? Infinity : budgetMs;
      var start = now();
      var first = true;
      while (!api.done && (first || now() - start < limit)) {
        first = false;
        for (var i = 0; i < list.length; i++) {
          if (finished[i]) continue;
          units[i]++;
          if (list[i].run()) finished[i] = true;
          break;
        }
        refresh();
      }
      return api.done;
    }

    refresh();
    return api;
  }

  // ----- set statistics (mean, spread), cached per set and extended on append

  var statsCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function addRows(st, X, from, to, D) {
    for (var i = from; i < to; i++) {
      var o = i * D;
      for (var d = 0; d < D; d++) {
        var x = X[o + d];
        st.sum[d] += x;
        st.sumSq += x * x;
      }
    }
    st.count = to;
    finishStats(st, D);
  }

  function finishStats(st, D) {
    var n = st.count;
    var m2 = 0;
    for (var d = 0; d < D; d++) {
      var m = n > 0 ? st.sum[d] / n : 0;
      st.mean[d] = m;
      m2 += m * m;
    }
    var tv = n > 0 ? st.sumSq / n - m2 : 0;
    st.totalVariance = Math.max(tv, 0);
    // Root mean squared distance from the mean: the cloud's typical radius.
    st.radius = Math.sqrt(st.totalVariance) || 1;
  }

  // Cheap check that `set` starts with `previous` (an append of it): same
  // dimension, no fewer points, and the first and last rows of `previous` are
  // equal in both. Not a proof; it catches a wrong `previous` in O(D).
  function isPrefix(previous, set) {
    var D = set.dimension;
    var grows = previous?.count <= set.count; // false for a missing or NaN count too
    if (!previous) return false;
    if (previous.dimension !== D || !grows) return false;
    var n = previous.count;
    if (n === 0) return true;
    var a = previous.vectors;
    var b = set.vectors;
    var last = (n - 1) * D;
    for (var d = 0; d < D; d++) {
      if (a[d] !== b[d] || a[last + d] !== b[last + d]) return false;
    }
    return true;
  }

  // stats(set) -> { count, dimension, mean: Float32Array(D), radius, totalVariance }.
  // O(N * D) the first time for a set; an appended set built from a set seen
  // before (pass it as `previous`) costs O(k * D) for the k new rows.
  // Precondition: `set` is `previous` with points appended. A `previous` that
  // fails the cheap check (isPrefix) is ignored and the stats are recomputed.
  function stats(set, previous) {
    if (statsCache?.has(set)) return statsCache.get(set);
    var D = set.dimension;
    var st;
    var prev = previous && statsCache ? statsCache.get(previous) : null;
    if (prev && isPrefix(previous, set) && prev.count === previous.count) {
      st = { count: prev.count, dimension: D, sum: Float64Array.from(prev.sum), sumSq: prev.sumSq, mean: new Float32Array(D) };
      addRows(st, set.vectors, prev.count, set.count, D);
    } else {
      st = { count: 0, dimension: D, sum: new Float64Array(D), sumSq: 0, mean: new Float32Array(D) };
      addRows(st, set.vectors, 0, set.count, D);
    }
    if (statsCache) statsCache.set(set, st);
    return st;
  }

  // A sliced form of stats(set) for a stepper task. run() adds the next rows
  // (about STATS_WORK values, so about half a millisecond) and returns true
  // once the statistics are complete and cached; job.result is then the same
  // object stats(set) returns, with the same values bit for bit (the rows are
  // added in the same order). A set whose statistics are cached finishes at once.
  var STATS_WORK = 1 << 19;
  function statsJob(set) {
    var D = set.dimension;
    var rows = Math.max(1, Math.floor(STATS_WORK / Math.max(1, D)));
    var st = null;
    var job = {
      result: null,
      progress: function () {
        if (job.result) return 1;
        return st && set.count > 0 ? st.count / set.count : 0;
      },
      run: function () {
        if (job.result) return true;
        if (!st && statsCache?.has(set)) {
          job.result = statsCache.get(set);
          return true;
        }
        if (!st) st = { count: 0, dimension: D, sum: new Float64Array(D), sumSq: 0, mean: new Float32Array(D) };
        addRows(st, set.vectors, st.count, Math.min(set.count, st.count + rows), D);
        if (st.count < set.count) return false;
        if (statsCache && !statsCache.has(set)) statsCache.set(set, st);
        job.result = statsCache ? statsCache.get(set) : st;
        return true;
      },
    };
    return job;
  }

  // ----- shared motion helpers ------------------------------------------------

  // A centre that glides exponentially (time constant tau seconds) from where it
  // is toward a target; retarget(t, target) starts a new segment at time t from
  // wherever the glide is then, so a moved target never makes it jump. Pure in t
  // for a fixed list of retargets.
  function makeGlide(start, target, tau, D) {
    var segs = [{ t0: 0, from: Float64Array.from(start), to: Float64Array.from(target) }];
    function segFor(t) {
      var s = segs[0];
      for (var i = 1; i < segs.length; i++) if (segs[i].t0 <= t) s = segs[i];
      return s;
    }
    function at(t, out) {
      var res = out || new Float32Array(D);
      var s = segFor(t);
      var dt = t - s.t0;
      var k = dt <= 0 ? 1 : Math.exp(-dt / tau);
      for (var d = 0; d < D; d++) res[d] = s.to[d] + (s.from[d] - s.to[d]) * k;
      return res;
    }
    function retarget(t, newTarget) {
      var here = Float64Array.from(at(t));
      // drop segments that start after t: they belonged to a future that changed
      segs = segs.filter(function (s) {
        return s.t0 <= t;
      });
      segs.push({ t0: t, from: here, to: Float64Array.from(newTarget) });
    }
    return { at: at, retarget: retarget };
  }

  // The permutation and signs that alignTo applied to `target` to match `ref`,
  // so the same relabelling of axes can be applied to later frames.
  function alignment(target, ref, D) {
    var aligned = ET.math.alignTo(target, ref, D);
    var perm = [0, 1, 2];
    var sign = [1, 1, 1];
    for (var j = 0; j < 3; j++) {
      var best = 0;
      var bestAbs = -1;
      var bestDot = 0;
      for (var i = 0; i < 3; i++) {
        var dp = 0;
        for (var d = 0; d < D; d++) dp += aligned[j * D + d] * target[i * D + d];
        if (Math.abs(dp) > bestAbs) {
          bestAbs = Math.abs(dp);
          best = i;
          bestDot = dp;
        }
      }
      perm[j] = best;
      sign[j] = bestDot < 0 ? -1 : 1;
    }
    return { perm: perm, sign: sign };
  }

  function applyAlignment(frame, al, D, out) {
    var res = out || new Float32Array(3 * D);
    for (var j = 0; j < 3; j++) {
      var src = al.perm[j] * D;
      var s = al.sign[j];
      for (var d = 0; d < D; d++) res[j * D + d] = s * frame[src + d];
    }
    return res;
  }

  // Copy of an entry state handed to enter({ from }), or null.
  function entryFrom(from, D) {
    if (!from?.frame) return null;
    if (from.frame.length !== 3 * D) return null;
    var e = { frame: new Float32Array(from.frame), centre: null, draw: {} };
    ET.math.orthonormalize(e.frame, 3, D);
    if (from.centre?.length === D) e.centre = new Float32Array(from.centre);
    if (from.draw && typeof from.draw === "object") {
      for (var k in from.draw) {
        if (Object.hasOwn(from.draw, k) && typeof from.draw[k] === "number" && Number.isFinite(from.draw[k])) {
          e.draw[k] = from.draw[k];
        }
      }
    }
    return e;
  }

  // Blend numeric draw parameters from the entry's toward the mode's own over
  // `duration` seconds (smoothstep). Keys the entry lacks are the mode's at once.
  function blendDraw(draw, entry, t, duration) {
    var blending = t < duration; // false for a NaN duration too
    if (!entry || !blending) return draw;
    var e = ET.math.smoothstep(t / duration);
    for (var k in draw) {
      if (Object.hasOwn(entry.draw, k)) draw[k] = entry.draw[k] + (draw[k] - entry.draw[k]) * e;
    }
    return draw;
  }

  // A deterministic starting frame for a mode entered with no previous view.
  var SALT_START = 0x5157a7;
  function startFrame(D, seed) {
    return ET.math.randomFrame(D, ET.math.makeRandom(ET.math.mixSeed(seed, SALT_START)));
  }

  // Auto-framing. The reference's rule is zoom = 0.78 / rms of the projected
  // coordinates. On a guided tour the regions sit far apart as compact blobs,
  // so the outermost ones (and their names) left the stage although the rms was
  // the reference's (measured on the sample set: the tour's 98th-percentile
  // radius is 1.6 times its rms, and the group names sit on the outermost
  // blobs). So the zoom is also capped so that the 98th-percentile radius of the
  // sample lands at AUTO_FIT units, which leaves room for the names inside the
  // shorter side of the stage (the renderer maps 1 unit to 0.46 of it, so the
  // edge is at 1.087 units). zoom = min(0.78 / rms, AUTO_FIT / p98). An even
  // cloud keeps the reference's framing. The sample is fixed (the first
  // `sample` points, 512 by default) so an append past it does not change the
  // framing. A pure function of the data, the frame and the centre.
  var AUTO_FIT = 0.88;
  var radii = new Float64Array(0);
  function autoZoom(X, N, D, frame, centre, sample) {
    var n = Math.min(N, sample || 512);
    if (n <= 0) return 1;
    if (radii.length < n) radii = new Float64Array(n);
    var sq = 0;
    for (var i = 0; i < n; i++) {
      var o = i * D;
      var a = 0;
      var b = 0;
      var c = 0;
      for (var d = 0; d < D; d++) {
        var x = X[o + d] - centre[d];
        a += x * frame[d];
        b += x * frame[D + d];
        c += x * frame[2 * D + d];
      }
      var r2 = a * a + b * b + c * c;
      sq += r2;
      radii[i] = r2;
    }
    var rms = Math.sqrt(sq / n);
    var spread = rms > 0; // false for NaN too
    if (!spread) return 1;
    var view = radii.subarray(0, n);
    view.sort();
    var p98 = Math.sqrt(view[Math.min(n - 1, Math.floor(0.98 * (n - 1)))]);
    var zoom = 0.78 / rms;
    return p98 > 0 && AUTO_FIT / p98 < zoom ? AUTO_FIT / p98 : zoom;
  }

  // The sample set's typical radius (root mean squared distance from the mean,
  // measured: 0.963 at 384-d and 0.968 at 1024-d). The reference's distances
  // (fog, Wander's zoom) were tuned by eye at this scale; modes scale them by
  // radius / REFERENCE_RADIUS so other data looks the same.
  var REFERENCE_RADIUS = 0.963;

  // "12,345": a fixed thousands separator (no locale dependence).
  function thousands(n) {
    var s = String(Math.round(n));
    var neg = s.startsWith("-");
    if (neg) s = s.slice(1);
    var out = "";
    while (s.length > 3) {
      out = "," + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return (neg ? "-" : "") + s + out;
  }

  // A point is labelled when its label is non-empty and is not just its id
  // (a labels-only set repeats the id as the label).
  function isLabelled(p) {
    return typeof p?.label === "string" && p.label.trim() !== "" && p.label !== p.id;
  }

  // Throws a RangeError naming the data when a set has too few dimensions.
  function requireDimension(set, min, title) {
    var D = set ? set.dimension : set; // a missing set names itself in the message
    var enough = D >= min; // false for a missing or non-numeric dimension too
    if (!enough) {
      throw new RangeError(
        "the set has dimension " + D + "; " + title + " needs at least " + min + " dimensions",
      );
    }
  }

  // The state a mode shows while it has nothing to move through (no points
  // yet, or still preparing): the hold frame, the entry centre (or zeros) and
  // the entry's draw parameters, no wires.
  function holdState(out, frame, entry, t, status) {
    out.t = t;
    out.frame.set(frame);
    if (entry?.centre) out.centre.set(entry.centre);
    else out.centre.fill(0);
    out.draw = entry ? { ...entry.draw } : { wires: 0, fog: 0 };
    out.wires = null;
    out.focus = null;
    out.status = status;
    return out;
  }

  // What dataChanged returns: more work to pump (or null), and whether mode
  // time restarted at 0 (the mode re-entered; the viewer resets its clock and
  // waits for isReady()).
  function changed(work, restart) {
    return { work: work || null, restart: !!restart };
  }

  var EMPTY_STATUS = "no points yet";

  function checkTime(t) {
    if (!Number.isFinite(t)) throw new RangeError("time must be a finite number");
    // Not Math.max(t, 0): that turns -0 into +0, and -0 is passed through as given.
    if (t < 0) return 0;
    return t;
  }

  return {
    INTERFACE: INTERFACE.slice(),
    register: register,
    get: get,
    list: list,
    ids: ids,
    check: check,
    create: create,
    stepper: stepper,
    now: now,
    stats: stats,
    statsJob: statsJob,
    makeGlide: makeGlide,
    alignment: alignment,
    applyAlignment: applyAlignment,
    entryFrom: entryFrom,
    blendDraw: blendDraw,
    startFrame: startFrame,
    autoZoom: autoZoom,
    AUTO_FIT: AUTO_FIT,
    REFERENCE_RADIUS: REFERENCE_RADIUS,
    thousands: thousands,
    isLabelled: isLabelled,
    checkTime: checkTime,
    requireDimension: requireDimension,
    holdState: holdState,
    changed: changed,
    isPrefix: isPrefix,
    EMPTY_STATUS: EMPTY_STATUS,
  };
})();
