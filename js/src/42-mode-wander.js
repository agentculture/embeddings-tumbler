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
//
// Hop h depends on hop h - 1 (its stop, its frame and the recent stops), so a
// far query must replay the route; what is kept is bounded: the last WINDOW
// hops, plus at most MAX_CHECKPOINTS checkpoints (a hop's frame and recent
// stops), spaced further apart as the route grows. Replays start from the
// nearest checkpoint. An append only records which point count was in force
// from which hop (`segs`): the points of a set never change on append, so the
// neighbour pool and the visit list in force at any earlier hop can be rebuilt
// from the current set and that count.
// ---------------------------------------------------------------------------
(function () {
  var M = ET.modes;
  var SALT_WANDER = 0x3a7d3e;
  var SCAN_WORK = 1 << 17; // values compared per piece of a neighbour scan done ahead of need
  var WINDOW = 64; // hops kept after the newest one computed
  var CHECKPOINT_SPACING = 16; // hops between checkpoints at first (doubles as the route grows)
  var MAX_CHECKPOINTS = 32; // checkpoints kept, besides the route's start

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

  // Insert pool point i, at squared distance s, into a scan's best lists (nearest
  // first, ties to the lower index, at most K kept). Returns the new fill count.
  function insertNearest(bestD, bestI, filled, K, s, i) {
    if (filled === K && (s > bestD[K - 1] || (s === bestD[K - 1] && i > bestI[K - 1]))) return filled;
    var pos = filled < K ? filled : K - 1;
    while (pos > 0 && (bestD[pos - 1] > s || (bestD[pos - 1] === s && bestI[pos - 1] > i))) {
      bestD[pos] = bestD[pos - 1];
      bestI[pos] = bestI[pos - 1];
      pos--;
    }
    bestD[pos] = s;
    bestI[pos] = i;
    return filled < K ? filled + 1 : filled;
  }

  // A finished scan: its neighbours, nearest first, cached on its context.
  function scanFinish(sc) {
    var nb = sc.bestI.subarray(0, sc.filled);
    sc.c.nbr.set(sc.j, nb);
    return nb;
  }

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options?.[k] === undefined ? DEFAULTS[k] : options[k];
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
      retained: retained,
      mark: function () {}, // Wander has no events to fix
      face: face,
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
    // The data context of a point count n: { n, visit, inVisit, pool, labelled, nbr }
    // (visit: Int32Array, the points the route may stop at; inVisit: Uint8Array(n);
    // pool: Int32Array, the points searched for neighbours; nbr: neighbour cache).
    var ctx = null; // the current set's
    var oldCtx = null; // one earlier count's, for replays across an append
    var segs = []; // [{ from, n }]: from hop `from` on, stops were chosen among the first n points
    var win = null; // Map hop -> { target, frame }: the last WINDOW hops computed
    var cps = []; // checkpoints [{ h, prev, recent, frame }], by hop; cps[0] is the start (h -1)
    var spacing = CHECKPOINT_SPACING;
    var cur = null; // the route's cursor: the newest hop computed { h, prev, recent, frame }
    var hopsComputed = 0; // hops computed in all (replays included), for retained()
    var ahead = null; // the next hop's work in progress: { h, j, c, scan, fit }
    var out = null;
    var tmpC = null;
    var swings = null; // the swings toward the searches (M.makeSwings)

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
      ctx = null;
      oldCtx = null;
      segs = [{ from: 0, n: s.count }];
      win = new Map();
      cps = [{ h: -1, prev: -1, recent: [], frame: startFrame }];
      spacing = CHECKPOINT_SPACING;
      cur = { h: -1, prev: -1, recent: [], frame: startFrame };
      hopsComputed = 0;
      ahead = null;
      swings = M.makeSwings(D, seed);
      self.time = 0;
      out = { t: 0, frame: new Float32Array(3 * D), centre: new Float32Array(D), draw: null, wires: null, status: "", focus: null };
      tmpC = new Float64Array(D);
    }

    // Visit candidates (labelled points, or every pooled point when fewer than
    // two are labelled) and the neighbour pool, among the first N points. O(N).
    function makeCtx(N) {
      var lab = [];
      for (var i = 0; i < N; i++) if (M.isLabelled(set.points[i])) lab.push(i);
      var limit = Math.min(N, opt.neighbourLimit);
      var p = [];
      var mark = new Uint8Array(N);
      for (var a = 0; a < limit; a++) {
        p.push(a);
        mark[a] = 1;
      }
      for (var l of lab) {
        if (!mark[l]) {
          p.push(l);
          mark[l] = 1;
        }
      }
      var visit = lab.length >= 2 ? Int32Array.from(lab) : Int32Array.from(p);
      var inVisit = new Uint8Array(N);
      for (var v of visit) inVisit[v] = 1;
      return { n: N, visit: visit, inVisit: inVisit, pool: Int32Array.from(p), labelled: lab.length, nbr: new Map() };
    }

    // The context stops of hop h were chosen in.
    function ctxFor(h) {
      var n = segs[0].n;
      for (var i = 1; i < segs.length && segs[i].from <= h; i++) n = segs[i].n;
      if (n === ctx.n) return ctx;
      if (!oldCtx || oldCtx.n !== n) oldCtx = makeCtx(n);
      return oldCtx;
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
            startCentre = entry?.centre ? new Float32Array(entry.centre) : new Float32Array(st.mean);
            return true;
          },
        },
        {
          required: true,
          weight: 1,
          run: function () {
            if (!pooled) {
              ctx = makeCtx(set.count);
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
    function nearest(c, j) {
      var got = c.nbr.get(j);
      if (got) return got;
      var sc = scanStart(c, j);
      scanRows(sc, c.pool.length);
      return scanFinish(sc);
    }

    // The same search, resumable: scanRows(sc, rows) measures the next `rows`
    // pool points. The pool is scanned in order, so the result does not depend
    // on how the scan was sliced.
    function scanStart(c, j) {
      var K = Math.max(0, Math.min(opt.neighbours, c.pool.length - 1));
      return { c: c, j: j, K: K, q: 0, filled: 0, bestD: new Float64Array(K), bestI: new Int32Array(K) };
    }

    function scanRows(sc, rows) {
      var X = set.vectors;
      var pool = sc.c.pool;
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
        filled = insertNearest(bestD, bestI, filled, K, s, i);
      }
      sc.q = stop;
      sc.filled = filled;
      return stop >= pool.length;
    }

    function nearVisits(c, i, max) {
      var nb = nearest(c, i);
      var res = [];
      for (var q = 0; q < nb.length && res.length < max; q++) if (c.inVisit[nb[q]]) res.push(nb[q]);
      return res;
    }

    function groupOf(i) {
      return i >= 0 && set.points[i] ? set.points[i].group || "" : "";
    }

    // The stop of hop h = cur.h + 1, from hop h's own random stream (the
    // reference's rules), among the points of context c.
    function pick(h, c) {
      var rng = ET.math.makeRandom(ET.math.mixSeed(seedU ^ SALT_WANDER, h));
      var i = h > 0 ? cur.prev : -1;
      var recent = cur.recent;
      var visit = c.visit;
      var hopNo = h + 1;
      if (i >= 0 && hopNo % opt.leapEvery !== 0) {
        var near = nearVisits(c, i, opt.neighbours).filter(function (j) {
          return !recent.includes(j);
        });
        if (near.length) return near[Math.floor(rng.next() * Math.min(near.length, opt.nearChoices))];
      }
      var gi = groupOf(i);
      for (var tries = 0; tries < 40; tries++) {
        var j = visit[Math.floor(rng.next() * visit.length)];
        if (j !== i && !recent.includes(j) && (gi === "" || groupOf(j) !== gi)) return j;
      }
      var idx = Math.floor(rng.next() * visit.length);
      if (visit[idx] === i && visit.length > 1) idx = (idx + 1) % visit.length;
      return visit[idx];
    }

    // Hop k's stop and frame, if kept (the window or a checkpoint), else null.
    // Hop -1 is the start: no stop, the entry frame.
    function rec(k) {
      if (k < 0) return { target: -1, frame: startFrame };
      var w = win.get(k);
      if (w) return w;
      for (var i = cps.length - 1; i >= 0 && cps[i].h >= k; i--) if (cps[i].h === k) return { target: cps[i].prev, frame: cps[i].frame };
      return null;
    }

    // Move the cursor back to the newest checkpoint before hop k.
    function resetBefore(k) {
      var c = cps[0];
      for (var i = cps.length - 1; i >= 0; i--) {
        if (cps[i].h < k) {
          c = cps[i];
          break;
        }
      }
      cur = { h: c.h, prev: c.prev, recent: c.recent.slice(), frame: c.frame };
      win = new Map();
      ahead = null;
    }

    // Make hop k available through rec(k): from the cursor when it is behind k and
    // no checkpoint is nearer, else from the newest checkpoint before k.
    function ensure(k) {
      if (rec(k)) return;
      var near = cps[0];
      for (var i = cps.length - 1; i >= 0; i--) {
        if (cps[i].h < k) {
          near = cps[i];
          break;
        }
      }
      if (cur.h >= k || near.h > cur.h) resetBefore(k);
      while (cur.h < k) advance(null, -1);
    }

    function stopIds(c, j) {
      return [j].concat(Array.prototype.slice.call(nearest(c, j)));
    }

    // Compute hop cur.h + 1: its stop (j, or picked when j is -1) and its local
    // frame (fitted to the stop and its neighbours, or `fitted`), aligned to the
    // previous hop's. Keeps it in the window and, on the spacing, as a checkpoint.
    function advance(fitted, j) {
      var n = cur.h + 1;
      var c = ctxFor(n);
      if (j < 0) j = pick(n, c);
      var lf = fitted || ET.math.localFrame(set.vectors, set.count, D, stopIds(c, j));
      var frame = ET.math.alignTo(lf, cur.frame, D);
      var recent = cur.recent;
      recent.push(j);
      while (recent.length > Math.max(0, opt.recent)) recent.shift();
      cur.h = n;
      cur.prev = j;
      cur.frame = frame;
      hopsComputed++;
      win.set(n, { target: j, frame: frame });
      win.delete(n - WINDOW);
      if ((n + 1) % spacing === 0) checkpoint();
      ahead = null;
    }

    function checkpoint() {
      var at = cps.length;
      while (at > 0 && cps[at - 1].h > cur.h) at--;
      if (at > 0 && cps[at - 1].h === cur.h) return;
      cps.splice(at, 0, { h: cur.h, prev: cur.prev, recent: cur.recent.slice(), frame: cur.frame });
      if (cps.length > MAX_CHECKPOINTS + 1) {
        spacing *= 2;
        cps = cps.filter(function (c) {
          return c.h < 0 || (c.h + 1) % spacing === 0;
        });
      }
    }

    // One small piece of the work for hop h, ahead of need: pick its stop,
    // then scan the pool for the stop's neighbours SCAN_WORK values at a time,
    // then fit its frame (ET.math.makeLocalFrame, one unit per call) and align
    // it. Returns true once hop h is kept.
    // stateAt calls it every frame for the next hop, so by the time the flight
    // reaches a stop (4.8 s later) nothing is left to compute in that frame.
    // The pieces compute exactly what ensure(h) computes in one go.
    function workAhead(h) {
      if (rec(h)) return true;
      if (cur.h !== h - 1) return false; // only the hop after the cursor is worked on ahead
      if (!ahead || ahead.h !== h) {
        var c = ctxFor(h);
        var j = pick(h, c);
        ahead = { h: h, j: j, c: c, scan: c.nbr.has(j) ? null : scanStart(c, j), fit: null };
        return false;
      }
      if (ahead.scan) {
        if (scanRows(ahead.scan, Math.max(1, Math.floor(SCAN_WORK / D)))) {
          scanFinish(ahead.scan);
          ahead.scan = null;
        }
        return false;
      }
      if (!ahead.fit) ahead.fit = ET.math.makeLocalFrame(set.vectors, set.count, D, stopIds(ahead.c, ahead.j));
      if (!ahead.fit.step(0)) return false;
      advance(ahead.fit.result, ahead.j);
      return true;
    }

    function hopAt(t) {
      var h = Math.floor(t / cycle);
      return { h: h, local: t - h * cycle };
    }

    // The hop at t (not during a swing): with no swing before t, hopAt(t). After
    // a swing (sw, ended by t) a new leg starts at its end U with the hop after
    // the one the swing interrupted (sw.info.hT); `first` marks the leg's first
    // hop, which flies from the frame and centre shown at U.
    function legAt(sw, t) {
      if (!sw) return hopAt(t);
      var lt = t - sw.U;
      var k = Math.floor(lt / cycle);
      return { h: sw.info.hT + 1 + k, local: lt - k * cycle, first: k === 0 };
    }

    // The hop in progress at t: during a swing, the hop it interrupted.
    function hopInProgress(t) {
      var sw = swings.at(t);
      if (sw && t < sw.U) return sw.info.hT;
      return legAt(sw, t).h;
    }

    // A route frame as shown in the leg after swing sw: its axes relabelled
    // (order and sign) to match the frame shown at the swing's end, the same
    // relabelling for every hop of the leg, so the hops stay aligned to each other.
    function legFrame(sw, f) {
      return sw ? M.applyAlignment(f, sw.cache.al, D) : f;
    }

    function stateAt(time) {
      var t = M.checkTime(time);
      out.t = t;
      if (!ready || empty) return M.holdState(out, startFrame, entry, t, status(t));
      var sw = swings.at(t);
      if (sw && t < sw.U) return swingingState(sw, t);
      var hp = legAt(sw, t);
      var h = hp.h;
      var end = sw ? legEnd(sw) : null;
      ensure(h - 1);
      ensure(h);
      var prevRec = rec(h - 1);
      var hereRec = rec(h);
      workAhead(h + 1);
      var first = !!hp.first;
      var j = hereRec.target;
      var prev = h > 0 && !first ? prevRec.target : -1; // the stop flown from, or -1
      var travelling = hp.local < opt.travel;
      var e = travelling ? ET.math.smoothstep(hp.local / opt.travel) : 1;
      var from = flightStart(sw, first, prevRec);
      if (travelling) travelCentre(prev, from.centre, j, e);
      else stopCentre(j);
      ET.math.blendFrames(from.frame, legFrame(sw, hereRec.frame), e, D, out.frame);
      out.focus = {
        phase: travelling ? "travel" : "dwell",
        from: prev,
        to: j,
        e: e,
        neighbours: Int32Array.from(nearVisits(ctx, j, opt.spokes)),
      };
      out.draw = drawAt(t);
      // The centre needs no blend: the leg's first hop flies from the centre shown at U.
      if (sw) out.draw.zoom = end.zoom + (out.draw.zoom - end.zoom) * M.swingRelease(sw, t, opt.transition);
      out.status = status(t);
      return out;
    }

    // The centre during a flight: e of the way from stop `prev` (from `fromC` when there is
    // no previous stop, prev < 0) to stop j.
    function travelCentre(prev, fromC, j, e) {
      var X = set.vectors;
      var oc = prev * D;
      var oj = j * D;
      for (var d = 0; d < D; d++) {
        var a = prev >= 0 ? X[oc + d] : fromC[d];
        tmpC[d] = a + (X[oj + d] - a) * e;
      }
      for (var d2 = 0; d2 < D; d2++) out.centre[d2] = tmpC[d2];
    }

    // The centre while the camera dwells at stop j: the stop itself.
    function stopCentre(j) {
      var X = set.vectors;
      var oj = j * D;
      for (var d = 0; d < D; d++) out.centre[d] = X[oj + d];
    }

    // The state shown at swing sw's end, with the leg's relabelling of route
    // frames worked out (once) against it.
    function legEnd(sw) {
      var end = M.swingEnd(sw);
      if (!sw.cache.al) {
        ensure(sw.info.hT + 1);
        sw.cache.al = M.alignment(rec(sw.info.hT + 1).frame, end.frame, D);
      }
      return end;
    }

    // Where a flight starts: the frame and the centre used when there is no
    // previous stop. A leg's first hop starts from the state shown at the swing's end.
    function flightStart(sw, first, prevRec) {
      if (first) return M.swingEnd(sw);
      return { frame: legFrame(sw, prevRec.frame), centre: startCentre };
    }

    // During a swing: the swing's frame, centre and zoom; the spokes of the hop
    // it interrupted, as they were at its start.
    function swingingState(sw, t) {
      var zoom = M.swingState(sw, t, out.frame, out.centre);
      workAhead(sw.info.hT + 1); // the next leg's first stop, ahead of need
      out.focus = sw.info.focus;
      out.draw = drawAt(t);
      out.draw.zoom = zoom;
      out.status = status(t);
      return out;
    }

    function drawAt(t) {
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
      return M.blendDraw(draw, entry, t, opt.transition);
    }

    // The swing toward the searches (js/api/40-modes.md, "Facing the searches").
    // face(null, t) ends a swing in progress at t. The swing remembers the hop it
    // interrupts (hT) and that hop's spokes.
    function face(target, time, options) {
      if (!ready || empty) return false;
      if (target === null) return swings.end(time);
      return swings.face(target, time, options, function (T) {
        var prior = swings.at(T);
        var hT = prior && T < prior.U ? prior.info.hT : legAt(prior, T).h;
        var s = stateAt(T);
        var f = s.focus ? { ...s.focus, neighbours: new Int32Array(s.focus.neighbours) } : null;
        return {
          frame: new Float32Array(s.frame),
          centre: new Float32Array(s.centre),
          zoom: s.draw.zoom,
          info: { hT: hT, focus: f },
        };
      });
    }

    // A point's name for the status line, cut to 24 characters so the line
    // stays short (the full label is the viewer's to show).
    function nameOf(i) {
      var p = set.points[i];
      var n = M.isLabelled(p) ? p.label : p.id;
      return n.length > 24 ? n.slice(0, 23) + "…" : n;
    }

    function describeStop(h, phase, first) {
      var j = rec(h).target;
      if (phase === "dwell") {
        var g = groupOf(j);
        return 'at "' + nameOf(j) + '"' + (g ? " · " + g : "") + " · stop " + (h + 1);
      }
      var i = h > 0 && !first ? rec(h - 1).target : -1;
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
      var sw = swings.at(t);
      if (sw && t < sw.U) return M.swingStatus(sw, "wandering");
      var hp = legAt(sw, t);
      ensure(hp.h - 1);
      ensure(hp.h);
      return describeStop(hp.h, hp.local < opt.travel ? "travel" : "dwell", hp.first);
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
          from = { frame: new Float32Array(s.frame), centre: null, draw: { ...s.draw } };
          if (!empty || entry?.centre) from.centre = new Float32Array(s.centre);
        }
        enter(newSet, { seed: seed, from: from });
        return M.changed(prepare(), true);
      }
      var h = hopInProgress(t);
      // A leg that starts after h re-relabels its frames against the stops chosen again.
      for (var sw of swings.list) if (sw.info.hT >= h) sw.cache.al = null;
      // Keep the route up to hop h (computed with the data so far); drop the rest.
      ensure(h);
      if (cur.h > h) {
        resetBefore(h + 1);
        while (cur.h < h) advance(null, -1);
      }
      cps = cps.filter(function (c) {
        return c.h <= h;
      });
      segs = segs.filter(function (sg) {
        return sg.from <= h;
      });
      segs.push({ from: h + 1, n: newSet.count });
      ahead = null;
      if (!oldCtx || oldCtx.n !== ctx.n) oldCtx = ctx; // the route so far may be replayed with it
      set = newSet;
      ctx = makeCtx(set.count);
      return M.changed(null, false);
    }

    function route(n) {
      if (!ready || empty) return new Int32Array(0);
      var res = new Int32Array(Math.max(0, n));
      for (var k = 0; k < n; k++) {
        ensure(k);
        res[k] = rec(k).target;
      }
      return res;
    }

    function neighboursOf(j) {
      return ready && !empty ? Int32Array.from(nearest(ctx, j)) : new Int32Array(0);
    }

    // What the route keeps (for tests and diagnostics): hops in the window,
    // checkpoints, the Float32 values their frames hold, append segments, and
    // the hops computed in all.
    function retained() {
      return {
        hops: win ? win.size : 0,
        checkpoints: cps.length,
        floats: ((win ? win.size : 0) + cps.length) * 3 * D,
        segments: segs.length,
        hopsComputed: hopsComputed,
      };
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
        labelled: ctx ? ctx.labelled : 0,
        visiting: ctx?.labelled >= 2 ? "labelled points" : "any point",
        facing: swings ? swings.describe() : null,
        empty: empty,
        varianceShare: null,
      };
    }

    function leave() {
      set = null;
      ctx = null;
      oldCtx = null;
      win = new Map();
      cps = [];
      ahead = null;
      ready = false;
    }

    return self;
  }

  M.register({
    id: "wander",
    title: "Wander",
    summary: "Fly through the space, hopping neighbour to neighbour",
    create: create,
  });
})();
