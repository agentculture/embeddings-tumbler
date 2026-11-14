// ---------------------------------------------------------------------------
// 42-mode-wander.js: Wander (registered as ET.modes "wander").
//
// The camera flies from labelled point to labelled point. At every stop the
// three axes are fitted again to that point's 24 true nearest neighbours
// (ET.math.localFrame), aligned to the previous axes (ET.math.alignTo) so the
// flight twists as little as possible, and blended in (ET.math.blendFrames).
// Each hop travels for 2.8 s and dwells for 2.0 s; every fifth hop leaps to
// another group. The route is drawn from the seed and the data only, hop by
// hop from its own random stream, so the frame at time t depends only on the
// data, the seed, the entry view and t. See js/api/40-modes.md.
// ---------------------------------------------------------------------------
(function () {
  var M = ET.modes;
  var SALT_WANDER = 0x3a7d3e;
  var SCAN_WORK = 1 << 17; // values compared per piece of a neighbour scan done ahead of need

  var DEFAULTS = {
    neighbours: 24, // neighbours a local frame is fitted to (the reference's K)
    neighbourLimit: 1000, // neighbours are searched among the first this-many points, plus every labelled point
    travel: 2.8, // seconds of flight per hop (the reference's)
    dwell: 2.0, // seconds at each stop (the reference's)
    leapEvery: 5, // every n-th hop leaps to another group (the reference's 5)
    nearChoices: 6, // a near hop picks among the first this-many labelled neighbours
    recent: 16, // stops not revisited within this many hops
    transition: 1.0, // seconds to blend draw parameters in from the previous view
    zoom: 2.7, // the reference's fixed zoom, at the reference's scale
    spokes: 6, // labelled neighbours listed in `focus` for the viewer's spokes
  };

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options && options[k] !== undefined ? options[k] : DEFAULTS[k];
    var cycle = opt.travel + opt.dwell;

    var self = {
      time: 0,
      enter: enter,
      prepare: prepare,
      isReady: isReady,
      stateAt: stateAt,
      step: step,
      status: status,
      dataChanged: dataChanged,
      describe: describe,
      route: route,
      neighboursOf: neighboursOf,
      mark: function () {}, // Wander has no events to fix
      leave: leave,
    };

    var set = null;
    var D = 0;
    var seed = 0;
    var seedU = 0;
    var entry = null;
    var startFrame = null;
    var startCentre = null;
    var scale = 1;
    var ready = false;
    var empty = false;
    var visit = null; // Int32Array: points the route may stop at
    var labelledCount = 0;
    var inVisit = null; // Uint8Array(N): 1 when the point is a visit candidate
    var pool = null; // Int32Array: points searched for neighbours
    var nbrCache = {};
    var targets = []; // stop of hop h
    var toFrames = []; // aligned local frame of hop h
    var ahead = null; // the next hop's work in progress: { h, j, scan, fit }
    var out = null;
    var tmpC = null;

    function enter(s, opts) {
      M.requireDimension(s, 3, "Wander");
      var o = opts || {};
      set = s;
      D = s.dimension;
      seed = o.seed === undefined ? 0 : o.seed;
      seedU = ET.math.toSeed(seed);
      entry = M.entryFrom(o.from, D);
      startFrame = entry ? entry.frame : M.startFrame(D, seed);
      startCentre = null;
      ready = false;
      empty = s.count === 0;
      nbrCache = {};
      targets = [];
      toFrames = [];
      ahead = null;
      self.time = 0;
      out = { t: 0, frame: new Float32Array(3 * D), centre: new Float32Array(D), draw: null, wires: null, status: "", focus: null };
      tmpC = new Float64Array(D);
    }

    // Visit candidates (labelled points, or every pooled point when fewer than
    // two are labelled) and the neighbour pool. O(N).
    function buildPool() {
      var N = set.count;
      var lab = [];
      for (var i = 0; i < N; i++) if (M.isLabelled(set.points[i])) lab.push(i);
      labelledCount = lab.length;
      var limit = Math.min(N, opt.neighbourLimit);
      var p = [];
      var mark = new Uint8Array(N);
      for (var a = 0; a < limit; a++) {
        p.push(a);
        mark[a] = 1;
      }
      for (var b = 0; b < lab.length; b++) {
        if (!mark[lab[b]]) {
          p.push(lab[b]);
          mark[lab[b]] = 1;
        }
      }
      pool = Int32Array.from(p);
      visit = lab.length >= 2 ? Int32Array.from(lab) : Int32Array.from(p);
      inVisit = new Uint8Array(N);
      for (var c = 0; c < visit.length; c++) inVisit[visit[c]] = 1;
    }

    // Preparation: the set's statistics (sliced), the visit list and the
    // neighbour pool (one unit, O(N)), then the first stop, computed in slices
    // as every later stop is (see workAhead), so the first frame does no heavy
    // work. The stops are the same whenever and however they are computed.
    function prepare() {
      if (empty) {
        return M.stepper([
          {
            required: true,
            run: function () {
              ready = true;
              return true;
            },
          },
        ]);
      }
      var job = M.statsJob(set);
      var pooled = false;
      return M.stepper([
        {
          required: true,
          weight: 1,
          progress: job.progress,
          run: function () {
            if (!job.run()) return false;
            var st = job.result;
            scale = st.radius / M.REFERENCE_RADIUS;
            startCentre = entry && entry.centre ? new Float32Array(entry.centre) : new Float32Array(st.mean);
            return true;
          },
        },
        {
          required: true,
          weight: 1,
          run: function () {
            if (!pooled) {
              buildPool();
              pooled = true;
              return false;
            }
            if (!workAhead(0)) return false;
            ready = true;
            return true;
          },
        },
      ]);
    }

    function isReady() {
      return ready;
    }

    // The point's `neighbours` nearest points in the pool, in the full space,
    // nearest first, ties to the lower index. O(pool * D), cached per point.
    function nearest(j) {
      if (nbrCache[j]) return nbrCache[j];
      var sc = scanStart(j);
      scanRows(sc, pool.length);
      return scanFinish(sc);
    }

    // The same search, resumable: scanRows(sc, rows) measures the next `rows`
    // pool points. The pool is scanned in order, so the result does not depend
    // on how the scan was sliced.
    function scanStart(j) {
      var K = Math.max(0, Math.min(opt.neighbours, pool.length - 1));
      return { j: j, K: K, q: 0, filled: 0, bestD: new Float64Array(K), bestI: new Int32Array(K) };
    }

    function scanRows(sc, rows) {
      var X = set.vectors;
      var K = sc.K;
      var bestD = sc.bestD;
      var bestI = sc.bestI;
      var filled = sc.filled;
      var j = sc.j;
      var oj = j * D;
      var stop = Math.min(pool.length, sc.q + rows);
      for (var q = sc.q; q < stop; q++) {
        var i = pool[q];
        if (i === j) continue;
        var oi = i * D;
        var s = 0;
        for (var d = 0; d < D; d++) {
          var x = X[oi + d] - X[oj + d];
          s += x * x;
        }
        if (filled === K && (s > bestD[K - 1] || (s === bestD[K - 1] && i > bestI[K - 1]))) continue;
        var pos = filled < K ? filled : K - 1;
        while (pos > 0 && (bestD[pos - 1] > s || (bestD[pos - 1] === s && bestI[pos - 1] > i))) {
          bestD[pos] = bestD[pos - 1];
          bestI[pos] = bestI[pos - 1];
          pos--;
        }
        bestD[pos] = s;
        bestI[pos] = i;
        if (filled < K) filled++;
      }
      sc.q = stop;
      sc.filled = filled;
      return stop >= pool.length;
    }

    function scanFinish(sc) {
      nbrCache[sc.j] = sc.bestI.subarray(0, sc.filled);
      return nbrCache[sc.j];
    }

    function nearVisits(i, max) {
      var nb = nearest(i);
      var res = [];
      for (var q = 0; q < nb.length && res.length < max; q++) if (inVisit[nb[q]]) res.push(nb[q]);
      return res;
    }

    function groupOf(i) {
      return i >= 0 && set.points[i] ? set.points[i].group || "" : "";
    }

    // The stop of hop h, from hop h's own random stream (the reference's rules).
    function pick(h) {
      var rng = ET.math.makeRandom(ET.math.mixSeed(seedU ^ SALT_WANDER, h));
      var i = h > 0 ? targets[h - 1] : -1;
      var recent = targets.slice(Math.max(0, h - opt.recent), h);
      var hopNo = h + 1;
      if (i >= 0 && hopNo % opt.leapEvery !== 0) {
        var near = nearVisits(i, opt.neighbours).filter(function (j) {
          return recent.indexOf(j) < 0;
        });
        if (near.length) return near[Math.floor(rng.next() * Math.min(near.length, opt.nearChoices))];
      }
      var gi = groupOf(i);
      for (var tries = 0; tries < 40; tries++) {
        var j = visit[Math.floor(rng.next() * visit.length)];
        if (j !== i && recent.indexOf(j) < 0 && (gi === "" || groupOf(j) !== gi)) return j;
      }
      var idx = Math.floor(rng.next() * visit.length);
      if (visit[idx] === i && visit.length > 1) idx = (idx + 1) % visit.length;
      return visit[idx];
    }

    function ensure(h) {
      while (targets.length <= h) {
        var n = targets.length;
        addStop(n, pick(n));
      }
    }

    // Hop n's local frame (fitted to stop j and its neighbours, aligned to the
    // previous hop's), appended to the route.
    function stopIds(j) {
      return [j].concat(Array.prototype.slice.call(nearest(j)));
    }

    function addStop(n, j, fitted) {
      var lf = fitted || ET.math.localFrame(set.vectors, set.count, D, stopIds(j));
      targets.push(j);
      toFrames.push(ET.math.alignTo(lf, n > 0 ? toFrames[n - 1] : startFrame, D));
      ahead = null;
    }

    // One small piece of the work for hop h, ahead of need: pick its stop,
    // then scan the pool for the stop's neighbours SCAN_WORK values at a time,
    // then fit its frame (ET.math.makeLocalFrame, one unit per call) and align
    // it. Returns true once hop h is in the route.
    // stateAt calls it every frame for the next hop, so by the time the flight
    // reaches a stop (4.8 s later) nothing is left to compute in that frame.
    // The pieces compute exactly what ensure(h) computes in one go.
    function workAhead(h) {
      if (targets.length > h) return true;
      if (targets.length < h) return false; // only the next hop is worked on ahead
      if (!ahead || ahead.h !== h) {
        var j = pick(h);
        ahead = { h: h, j: j, scan: nbrCache[j] ? null : scanStart(j), fit: null };
        return false;
      }
      if (ahead.scan) {
        if (scanRows(ahead.scan, Math.max(1, Math.floor(SCAN_WORK / D)))) {
          scanFinish(ahead.scan);
          ahead.scan = null;
        }
        return false;
      }
      if (!ahead.fit) ahead.fit = ET.math.makeLocalFrame(set.vectors, set.count, D, stopIds(ahead.j));
      if (!ahead.fit.step(0)) return false;
      addStop(h, ahead.j, ahead.fit.result);
      return true;
    }

    function hopAt(t) {
      var h = Math.floor(t / cycle);
      return { h: h, local: t - h * cycle };
    }

    function stateAt(time) {
      var t = M.checkTime(time);
      out.t = t;
      if (!ready || empty) return M.holdState(out, startFrame, entry, t, status(t));
      var hp = hopAt(t);
      var h = hp.h;
      ensure(h);
      workAhead(h + 1);
      var j = targets[h];
      var fromF = h > 0 ? toFrames[h - 1] : startFrame;
      var X = set.vectors;
      var oj = j * D;
      var phase;
      var e;
      if (hp.local < opt.travel) {
        phase = "travel";
        e = ET.math.smoothstep(hp.local / opt.travel);
        var oc = h > 0 ? targets[h - 1] * D : -1;
        for (var d = 0; d < D; d++) {
          var a = oc >= 0 ? X[oc + d] : startCentre[d];
          tmpC[d] = a + (X[oj + d] - a) * e;
        }
        for (var d2 = 0; d2 < D; d2++) out.centre[d2] = tmpC[d2];
        ET.math.blendFrames(fromF, toFrames[h], e, D, out.frame);
      } else {
        phase = "dwell";
        e = 1;
        for (var d3 = 0; d3 < D; d3++) out.centre[d3] = X[oj + d3];
        ET.math.blendFrames(fromF, toFrames[h], 1, D, out.frame);
      }
      out.focus = {
        phase: phase,
        from: h > 0 ? targets[h - 1] : -1,
        to: j,
        e: e,
        neighbours: Int32Array.from(nearVisits(j, opt.spokes)),
      };
      var draw = {
        zoom: opt.zoom / scale,
        wires: 0,
        dim: 1,
        trails: 0.17,
        fog: 1,
        fogNear: 1.2 * scale,
        fogWidth: 0.8 * scale,
        twinkle: 0.18,
        depthOfField: 1.1,
      };
      out.draw = M.blendDraw(draw, entry, t, opt.transition);
      out.status = status(t);
      return out;
    }

    // A point's name for the status line, cut to 24 characters so the line
    // stays short (the full label is the viewer's to show).
    function nameOf(i) {
      var p = set.points[i];
      var n = M.isLabelled(p) ? p.label : p.id;
      return n.length > 24 ? n.slice(0, 23) + "…" : n;
    }

    function describeStop(h, phase) {
      var j = targets[h];
      if (phase === "dwell") {
        var g = groupOf(j);
        return 'at "' + nameOf(j) + '"' + (g ? " · " + g : "") + " · stop " + (h + 1);
      }
      var i = h > 0 ? targets[h - 1] : -1;
      var gj = groupOf(j);
      var far = i >= 0 && gj !== "" && groupOf(i) !== gj;
      return (i >= 0 ? '"' + nameOf(i) + '" → ' : "heading to ") + '"' + nameOf(j) + '"' + (far ? " · long leap to " + gj : "");
    }

    function step(dt) {
      self.time = Math.max(0, self.time + dt);
      return stateAt(self.time);
    }

    function status(time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      if (empty) return M.EMPTY_STATUS;
      if (!ready) return "getting ready to wander …";
      var hp = hopAt(t);
      ensure(hp.h);
      return describeStop(hp.h, hp.local < opt.travel ? "travel" : "dwell");
    }

    // Append: the hops up to the one in progress at time t are kept (so the view
    // does not jump); later hops are chosen again with the new points, which can
    // become stops and neighbours. Replace: start over from the current view.
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      if (i.op !== "append" || newSet.dimension !== D || !ready || empty) {
        var from = entry;
        if (ready) {
          var s = stateAt(t);
          from = { frame: new Float32Array(s.frame), centre: null, draw: Object.assign({}, s.draw) };
          if (!empty || (entry && entry.centre)) from.centre = new Float32Array(s.centre);
        }
        enter(newSet, { seed: seed, from: from });
        return M.changed(prepare(), true);
      }
      var h = hopAt(t).h;
      ensure(h);
      targets.length = h + 1;
      toFrames.length = h + 1;
      ahead = null;
      set = newSet;
      nbrCache = {};
      buildPool();
      return M.changed(null, false);
    }

    function route(n) {
      if (!ready || empty) return new Int32Array(0);
      if (n > 0) ensure(n - 1);
      return Int32Array.from(targets.slice(0, n));
    }

    function neighboursOf(j) {
      return ready && !empty ? Int32Array.from(nearest(j)) : new Int32Array(0);
    }

    function describe() {
      return {
        id: "wander",
        projection: "linear: an orthonormal 3-frame fitted to each stop's neighbourhood (its top three principal directions)",
        seed: seed,
        neighbours: opt.neighbours,
        neighbourLimit: opt.neighbourLimit,
        travel: opt.travel,
        dwell: opt.dwell,
        labelled: labelledCount,
        visiting: labelledCount >= 2 ? "labelled points" : "any point",
        empty: empty,
        varianceShare: null,
      };
    }

    function leave() {
      set = null;
      nbrCache = {};
      targets = [];
      toFrames = [];
      ahead = null;
      ready = false;
    }

    return self;
  }

  M.register({
    id: "wander",
    title: "Wander",
    summary: "Fly through the space, hopping from neighbour to neighbour.",
    create: create,
  });
})();
