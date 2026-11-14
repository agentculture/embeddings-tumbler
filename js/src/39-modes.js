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
  // Optional members: mark(t) (fix the time of a finished event), face(target,
  // t, options) (the swing toward the searches) and, for Tumble, refit(t).
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

  // ----- the swing toward the searches (js/api/40-modes.md, "Facing the searches")
  //
  // A swing is an event at a fixed time T. From T to its end U the frame is
  // pulled toward the facing frame Q with weight w = 1 - exp(-PULL (t - T)) while
  // it keeps drifting: the frame is the closed-form solution of the reference's
  // per-frame pull (F += (Q - F)(1 - exp(-2 dt))) with a drift velocity of
  // SWING_DRIFT rad/s per axis whose direction turns at SWING_TURN rad/s, then
  // orthonormalised. The drift's directions are drawn from the view seed and the
  // swing's number, so the frames are a pure function of the calls. The centre
  // and zoom are pulled toward the target's with the same weight. After U the
  // mode's own motion carries on from the state shown at U (each mode file).
  var SWING_DURATION = 6; // seconds of mode time (the reference's)
  var SWING_PULL = 2; // 1/s: the reference's pull, 1 - exp(-2 dt) per frame
  var SWING_DRIFT = 0.21; // rad/s per axis: half the reference tumble's 0.42
  var SWING_TURN = 1.5; // rad/s: how fast the drift's direction turns
  var SALT_SWING = 0x5e1f0c;

  function allFinite(a) {
    for (var x of a) if (!Number.isFinite(x)) return false;
    return true;
  }

  // A checked copy of a facing target { frame, centre, zoom }, or null.
  function faceTarget(target, D) {
    if (!target || typeof target !== "object") return null;
    var f = target.frame;
    var c = target.centre;
    var z = target.zoom;
    if (f?.length !== 3 * D || c?.length !== D) return null;
    var good = z > 0 && Number.isFinite(z); // false for a missing or non-numeric zoom too
    if (!good) return null;
    var frame = Float32Array.from(f);
    var centre = Float32Array.from(c);
    if (!allFinite(frame) || !allFinite(centre)) return null;
    ET.math.orthonormalize(frame, 3, D);
    return { frame: frame, centre: centre, zoom: z };
  }

  // { duration, searches } from face()'s options, or null when the duration is
  // not a positive finite number.
  function swingOptions(options) {
    var o = options || {};
    var duration = o.duration === undefined ? SWING_DURATION : o.duration;
    var good = duration > 0 && Number.isFinite(duration);
    if (!good) return null;
    var n = Math.round(o.searches);
    if (Number.isNaN(n) || n < 1) n = 1; // a missing or non-numeric count is one search
    return { duration: duration, searches: Math.min(4, n) };
  }

  function makeSwing(tg, shown, T, op, seed, index, D) {
    var Q = tg.frame;
    var A = shown.frame;
    // Each target axis is flipped to the shorter turn from the frame shown, so
    // the pull never passes through a row that cancels out.
    for (var r = 0; r < 3; r++) {
      var dp = 0;
      for (var d = 0; d < D; d++) dp += Q[r * D + d] * A[r * D + d];
      if (dp < 0) for (var d2 = 0; d2 < D; d2++) Q[r * D + d2] = -Q[r * D + d2];
    }
    var rng = ET.math.makeRandom(ET.math.mixSeed(ET.math.mixSeed(seed, SALT_SWING), index));
    var H = new Float64Array(6 * D);
    rng.fillGauss(H, 0, 6 * D);
    for (var row = 0; row < 6; row++) {
      var n = 0;
      for (var d3 = 0; d3 < D; d3++) n += H[row * D + d3] * H[row * D + d3];
      n = Math.sqrt(n) || 1;
      for (var d4 = 0; d4 < D; d4++) H[row * D + d4] /= n;
    }
    return {
      index: index,
      T: T,
      U: T + op.duration,
      n: op.searches,
      A: A,
      C0: shown.centre,
      Z0: shown.zoom,
      Q: Q,
      Qc: tg.centre,
      Qz: tg.zoom,
      H: H,
      info: shown.info || null,
      cache: {},
    };
  }

  // The swing's frame and centre at mode time t (clamped to [T, U]) written
  // into `frame` and `centre`; returns the zoom.
  function swingState(s, t, frame, centre) {
    var D = s.Qc.length;
    var tau = Math.min(Math.max(t - s.T, 0), s.U - s.T);
    var k = Math.exp(-SWING_PULL * tau); // 1 - w
    var c = Math.cos(SWING_TURN * tau) - k;
    var sn = Math.sin(SWING_TURN * tau);
    var den = SWING_PULL * SWING_PULL + SWING_TURN * SWING_TURN;
    // The drift's offset: the integral of exp(-PULL (tau - u)) times the turning
    // velocity, in closed form (zero at tau = 0, so the swing starts with no jump).
    var a = (SWING_DRIFT * (SWING_PULL * c + SWING_TURN * sn)) / den;
    var b = (SWING_DRIFT * (SWING_PULL * sn - SWING_TURN * c)) / den;
    var x = new Float64Array(3 * D);
    var H = s.H;
    for (var i = 0; i < 3 * D; i++) x[i] = s.Q[i] + k * (s.A[i] - s.Q[i]) + a * H[i] + b * H[3 * D + i];
    ET.math.orthonormalize(x, 3, D);
    for (var i2 = 0; i2 < 3 * D; i2++) frame[i2] = x[i2];
    for (var d = 0; d < D; d++) centre[d] = s.Qc[d] + k * (s.C0[d] - s.Qc[d]);
    return s.Qz + k * (s.Z0 - s.Qz);
  }

  // The state shown at the swing's end U: { frame, centre, zoom }, computed once.
  function swingEnd(s) {
    if (!s.cache.end) {
      var D = s.Qc.length;
      var e = { frame: new Float32Array(3 * D), centre: new Float32Array(D), zoom: 0 };
      e.zoom = swingState(s, s.U, e.frame, e.centre);
      s.cache.end = e;
    }
    return s.cache.end;
  }

  // How far the mode has come back after the swing: 0 at U, 1 from U + duration on.
  function swingRelease(s, t, duration) {
    var blending = t - s.U < duration; // false for a NaN duration too
    return blending ? ET.math.smoothstep((t - s.U) / duration) : 1;
  }

  // centre := from + (centre - from) e, in place; returns the zoom blended the same way.
  function releaseCentreZoom(end, e, centre, zoom) {
    if (e >= 1) return zoom;
    for (var d = 0; d < centre.length; d++) centre[d] = end.centre[d] + (centre[d] - end.centre[d]) * e;
    return end.zoom + (zoom - end.zoom) * e;
  }

  function swingStatus(s, verb) {
    return "swinging to face " + (s.n > 1 ? "the " + s.n + " searches" : "the search") + ", then " + verb + " on";
  }

  // The swings of one mode entry, in start order. shownAt(T) answers the state
  // shown at T as { frame, centre, zoom, info? } (copies); `info` is kept on the
  // swing for the mode's own use.
  function makeSwings(D, seed) {
    var list = [];

    // The latest swing that has started by t (it may have ended), or null.
    function at(t) {
      for (var i = list.length - 1; i >= 0; i--) if (list[i].T <= t) return list[i];
      return null;
    }

    function face(target, time, options, shownAt) {
      var tg = faceTarget(target, D);
      var op = swingOptions(options);
      if (!tg || !op) return false;
      var T = checkTime(time);
      var last = list.length ? list.at(-1) : null;
      if (last && last.T > T) T = last.T; // a fixed past is never rewritten
      var shown = shownAt(T);
      if (last && last.U > T) {
        last.U = T; // a new swing starts from the frame shown at its time
        last.cache = {};
      }
      list.push(makeSwing(tg, shown, T, op, seed, list.length, D));
      return true;
    }

    // End the newest swing at t if it is in progress then.
    function end(time) {
      var t = checkTime(time);
      var last = list.length ? list.at(-1) : null;
      if (!last || t < last.T || t >= last.U) return false;
      last.U = t;
      last.cache = {};
      return true;
    }

    function describe() {
      var last = list.length ? list.at(-1) : null;
      return last ? { at: last.T, until: last.U } : null;
    }

    return { at: at, face: face, end: end, describe: describe, list: list };
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
    SWING_DURATION: SWING_DURATION,
    makeSwings: makeSwings,
    swingState: swingState,
    swingEnd: swingEnd,
    swingRelease: swingRelease,
    releaseCentreZoom: releaseCentreZoom,
    swingStatus: swingStatus,
  };
})();
