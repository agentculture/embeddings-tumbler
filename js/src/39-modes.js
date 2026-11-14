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
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].id === def.id) throw new Error("mode '" + def.id + "' is already registered");
    }
    registry.push(copyDef(def));
  }

  function find(id) {
    for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return registry[i];
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
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
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

    function refresh() {
      var total = 0;
      var got = 0;
      var ready = true;
      var done = true;
      for (var i = 0; i < list.length; i++) {
        var w = list[i].weight === undefined ? 1 : list[i].weight;
        total += w;
        var p;
        if (finished[i]) p = 1;
        else if (typeof list[i].progress === "function") p = Math.max(0, Math.min(0.999, list[i].progress()));
        else p = 1 - 1 / (1 + units[i]);
        got += w * p;
        if (!finished[i]) {
          done = false;
          if (list[i].required) ready = false;
        }
      }
      api.done = done;
      api.ready = ready;
      api.progress = done ? 1 : total > 0 ? got / total : 1;
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
    st.totalVariance = tv > 0 ? tv : 0;
    // Root mean squared distance from the mean: the cloud's typical radius.
    st.radius = Math.sqrt(st.totalVariance) || 1;
  }

  // Cheap check that `set` starts with `previous` (an append of it): same
  // dimension, no fewer points, and the first and last rows of `previous` are
  // equal in both. Not a proof; it catches a wrong `previous` in O(D).
  function isPrefix(previous, set) {
    var D = set.dimension;
    if (!previous || previous.dimension !== D || !(previous.count <= set.count)) return false;
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
    if (statsCache && statsCache.has(set)) return statsCache.get(set);
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
    if (!from || !from.frame || from.frame.length !== 3 * D) return null;
    var e = { frame: new Float32Array(from.frame), centre: null, draw: {} };
    ET.math.orthonormalize(e.frame, 3, D);
    if (from.centre && from.centre.length === D) e.centre = new Float32Array(from.centre);
    if (from.draw && typeof from.draw === "object") {
      for (var k in from.draw) {
        if (Object.prototype.hasOwnProperty.call(from.draw, k) && typeof from.draw[k] === "number" && isFinite(from.draw[k])) {
          e.draw[k] = from.draw[k];
        }
      }
    }
    return e;
  }

  // Blend numeric draw parameters from the entry's toward the mode's own over
  // `duration` seconds (smoothstep). Keys the entry lacks are the mode's at once.
  function blendDraw(draw, entry, t, duration) {
    if (!entry || !(t < duration)) return draw;
    var e = ET.math.smoothstep(t / duration);
    for (var k in draw) {
      if (Object.prototype.hasOwnProperty.call(entry.draw, k)) draw[k] = entry.draw[k] + (draw[k] - entry.draw[k]) * e;
    }
    return draw;
  }

  // A deterministic starting frame for a mode entered with no previous view.
  var SALT_START = 0x5157a7;
  function startFrame(D, seed) {
    return ET.math.randomFrame(D, ET.math.makeRandom(ET.math.mixSeed(seed, SALT_START)));
  }

  // The reference's auto-framing: zoom = 0.78 / rms of the projected coordinates
  // of a fixed sample (the first `sample` points, 512 by default; fixed so an
  // append past it does not change the framing).
  function autoZoom(X, N, D, frame, centre, sample) {
    var n = Math.min(N, sample || 512);
    if (n <= 0) return 1;
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
      sq += a * a + b * b + c * c;
    }
    var rms = Math.sqrt(sq / n);
    return rms > 0 ? 0.78 / rms : 1;
  }

  // The sample set's typical radius (root mean squared distance from the mean,
  // measured: 0.963 at 384-d and 0.968 at 1024-d). The reference's distances
  // (fog, Wander's zoom) were tuned by eye at this scale; modes scale them by
  // radius / REFERENCE_RADIUS so other data looks the same.
  var REFERENCE_RADIUS = 0.963;

  // "12,345": a fixed thousands separator (no locale dependence).
  function thousands(n) {
    var s = String(Math.round(n));
    var neg = s.charAt(0) === "-";
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
    return !!p && typeof p.label === "string" && p.label.trim() !== "" && p.label !== p.id;
  }

  // Throws a RangeError naming the data when a set has too few dimensions.
  function requireDimension(set, min, title) {
    var D = set && set.dimension;
    if (!(D >= min)) {
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
    if (entry && entry.centre) out.centre.set(entry.centre);
    else out.centre.fill(0);
    out.draw = entry ? Object.assign({}, entry.draw) : { wires: 0, fog: 0 };
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
    if (typeof t !== "number" || !isFinite(t)) throw new RangeError("time must be a finite number");
    return t < 0 ? 0 : t;
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
    stats: stats,
    makeGlide: makeGlide,
    alignment: alignment,
    applyAlignment: applyAlignment,
    entryFrom: entryFrom,
    blendDraw: blendDraw,
    startFrame: startFrame,
    autoZoom: autoZoom,
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
