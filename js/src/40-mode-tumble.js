// ---------------------------------------------------------------------------
// 40-mode-tumble.js: Tumble, the guided tour (registered as ET.modes "tumble").
//
// The frame turns inside the span of the data's strongest principal directions
// (ET.math.guidedTour). The frame at time t is the tour's closed-form
// frameAt(t): it depends only on the data, the seed and t. The share of total
// variance those directions hold is reported as a number and in the status
// line. A refit is an event at a fixed time T: before T the old tour, from T
// on the new one, blended in. See js/api/40-modes.md.
// ---------------------------------------------------------------------------
(function () {
  var M = ET.modes;

  var DEFAULTS = {
    subspace: 8, // directions the tour moves through
    speed: 0.42, // rad/s, the reference's rate
    transition: 1.5, // seconds to blend in from the previous view
    fitRows: 4096, // fit the directions on at most this many rows (shares stay exact)
    centreTau: 0.7, // seconds: the camera glides to the data's mean (the reference's)
    zoomSample: 512, // points used for auto-framing
  };

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options && options[k] !== undefined ? options[k] : DEFAULTS[k];

    var self = {
      time: 0,
      varianceShare: null,
      enter: enter,
      prepare: prepare,
      isReady: isReady,
      stateAt: stateAt,
      step: step,
      status: status,
      dataChanged: dataChanged,
      describe: describe,
      refit: refit,
      mark: mark,
      leave: leave,
    };

    var set = null;
    var D = 0;
    var seed = 0;
    var entry = null;
    var empty = false;
    var emptyReady = false;
    var st = null; // set statistics (mean, radius)
    var glide = null;
    // Fitted tours in switch-time order: { tour, al (alignment or null), t0, share, count }.
    // The first has t0 = -Infinity; a refit adds one at its switch time T.
    var tours = [];
    var pending = null; // a finished refit whose switch time is not fixed yet
    var refitRunning = false;
    var requestedAt = null; // the switch time given to refit(t)
    var progress = 0;
    var hold = null;
    var out = null;

    function enter(s, opts) {
      M.requireDimension(s, 3, "Tumble");
      var o = opts || {};
      set = s;
      D = s.dimension;
      seed = o.seed === undefined ? 0 : o.seed;
      entry = M.entryFrom(o.from, D);
      empty = s.count === 0;
      emptyReady = false;
      st = null;
      glide = null;
      tours = [];
      pending = null;
      refitRunning = false;
      requestedAt = null;
      progress = 0;
      self.time = 0;
      self.varianceShare = null;
      hold = entry ? entry.frame : M.startFrame(D, seed);
      out = { t: 0, frame: new Float32Array(3 * D), centre: new Float32Array(D), draw: null, wires: null, status: "", focus: null };
    }

    function fit(onDone) {
      var Y = null;
      var fitSet = null;
      return [
        {
          required: true,
          weight: 1,
          run: function () {
            fitSet = set;
            Y = ET.math.centre(fitSet.vectors, fitSet.count, D).data;
            return true;
          },
        },
        {
          required: true,
          weight: 8,
          run: function () {
            var tour = ET.math.guidedTour(Y, fitSet.count, D, {
              seed: seed,
              subspace: opt.subspace,
              speed: opt.speed,
              sampleRows: fitSet.count > opt.fitRows ? opt.fitRows : undefined,
            });
            Y = null; // the centred copy is not kept
            onDone(tour, fitSet.count);
            return true;
          },
        },
      ];
    }

    function tracked(stp) {
      var inner = stp.step;
      stp.step = function (budget) {
        var r = inner(budget);
        progress = stp.progress;
        return r;
      };
      return stp;
    }

    function prepare() {
      if (empty) {
        return M.stepper([
          {
            required: true,
            run: function () {
              emptyReady = true;
              return true;
            },
          },
        ]);
      }
      var tasks = [
        {
          required: true,
          weight: 1,
          run: function () {
            st = M.stats(set);
            var start = entry && entry.centre ? entry.centre : st.mean;
            glide = M.makeGlide(start, st.mean, opt.centreTau, D);
            return true;
          },
        },
      ].concat(
        fit(function (tour, count) {
          var al = entry ? M.alignment(tour.frameAt(0), entry.frame, D) : null;
          tours = [{ tour: tour, al: al, t0: -Infinity, share: tour.varianceShare, count: count }];
          self.varianceShare = tour.varianceShare;
        }),
      );
      return tracked(M.stepper(tasks));
    }

    function isReady() {
      return empty ? emptyReady : tours.length > 0 && glide !== null;
    }

    function tourFrame(entryT, t, res) {
      var f = entryT.tour.frameAt(t, res);
      if (entryT.al) M.applyAlignment(new Float32Array(f), entryT.al, D, f);
      return f;
    }

    function activeIndex(t) {
      var i = tours.length - 1;
      while (i > 0 && tours[i].t0 > t) i--;
      return i;
    }

    function frameAt(t, res) {
      var i = activeIndex(t);
      var cur = tours[i];
      tourFrame(cur, t, res);
      if (i > 0 && t - cur.t0 < opt.transition) {
        var prev = tourFrame(tours[i - 1], t, new Float32Array(3 * D));
        ET.math.blendFrames(prev, res, ET.math.smoothstep((t - cur.t0) / opt.transition), D, res);
      }
      if (entry && t < opt.transition) {
        ET.math.blendFrames(entry.frame, res, ET.math.smoothstep(t / opt.transition), D, res);
      }
      return res;
    }

    function lastSwitch() {
      return tours.length ? tours[tours.length - 1].t0 : -Infinity;
    }

    // Fix a finished refit's switch time. Never earlier than the last switch,
    // so the past already fixed is never rewritten.
    function fixSwitch(T) {
      var t0 = Math.max(T, lastSwitch());
      var al = M.alignment(pending.tour.frameAt(t0), frameAt(t0, new Float32Array(3 * D)), D);
      tours.push({ tour: pending.tour, al: al, t0: t0, share: pending.tour.varianceShare, count: pending.count });
      self.varianceShare = pending.tour.varianceShare;
      pending = null;
      refitRunning = false;
      requestedAt = null;
    }

    function drawFor(frame, centre, t) {
      var sc = st.radius / M.REFERENCE_RADIUS;
      var draw = {
        zoom: M.autoZoom(set.vectors, set.count, D, frame, centre, opt.zoomSample),
        wires: 0,
        dim: 1,
        trails: 0.17,
        fog: 0,
        fogNear: 1.2 * sc,
        fogWidth: 0.8 * sc,
        twinkle: 0.18,
        depthOfField: 1.1,
      };
      return M.blendDraw(draw, entry, t, opt.transition);
    }

    function stateAt(time) {
      var t = M.checkTime(time);
      if (!isReady() || empty) return M.holdState(out, hold, entry, t, status(t));
      if (pending) fixSwitch(t); // no time was given: the first query fixes it
      out.t = t;
      frameAt(t, out.frame);
      glide.at(t, out.centre);
      out.draw = drawFor(out.frame, out.centre, t);
      out.wires = null;
      out.focus = null;
      out.status = status(t);
      return out;
    }

    function step(dt) {
      self.time = Math.max(0, self.time + dt);
      return stateAt(self.time);
    }

    function status(time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      if (empty) return M.EMPTY_STATUS;
      if (!isReady()) return "finding the strongest directions in " + D + "-d … " + Math.round(progress * 100) + "%";
      var cur = tours[activeIndex(t)];
      var s = "tour of " + cur.tour.subspace + " strongest directions · " + (cur.share * 100).toFixed(1) + "% of variance";
      var since = set.count - cur.count;
      if (since > 0) s += " · before " + M.thousands(since) + " new points";
      return s;
    }

    function snapshot(t) {
      var s = stateAt(t);
      var from = { frame: new Float32Array(s.frame), centre: null, draw: Object.assign({}, s.draw) };
      if (!empty || (entry && entry.centre)) from.centre = new Float32Array(s.centre);
      return from;
    }

    // Append: keep the tour (no jump); the camera glides to the new mean; the
    // reported share is marked stale until refit(). The first points onto an
    // empty set, a replace, or another dimension: start over from the view.
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      if (i.op !== "append" || newSet.dimension !== D || empty || !isReady()) {
        var from = isReady() ? snapshot(t) : entry;
        enter(newSet, { seed: seed, from: from });
        return M.changed(prepare(), true);
      }
      var old = set;
      set = newSet;
      st = M.stats(newSet, old);
      glide.retarget(t, st.mean);
      return M.changed(null, false);
    }

    // Fit the directions again on the current data. Returns a stepper. The
    // switch to the new tour happens at time `t` when given (never earlier than
    // a previous switch); otherwise at mark(t) or the first stateAt after the
    // stepper is done. From the switch the new tour blends in over `transition`.
    function refit(t) {
      if (empty || !isReady()) return prepare();
      refitRunning = true;
      requestedAt = t === undefined ? null : M.checkTime(t);
      return M.stepper(
        fit(function (tour, count) {
          pending = { tour: tour, count: count };
          if (requestedAt !== null) fixSwitch(requestedAt);
        }),
      );
    }

    // Fix the time of a finished event (a refit waiting for its switch).
    function mark(time) {
      if (pending) fixSwitch(M.checkTime(time));
    }

    function describe() {
      var last = tours.length ? tours[tours.length - 1] : null;
      var fittedCount = last ? last.count : 0;
      return {
        id: "tumble",
        projection: "linear: a guided tour, a turning orthonormal 3-frame inside the span of the strongest principal directions",
        seed: seed,
        subspace: last ? last.tour.subspace : opt.subspace,
        speed: opt.speed,
        varianceShare: self.varianceShare,
        varianceShareStale: isReady() && !empty ? set.count !== fittedCount : false,
        pointsSinceFit: isReady() && !empty ? set.count - fittedCount : 0,
        fittedRows: last && last.tour.pca ? last.tour.pca.sampledRows : 0,
        method: last && last.tour.pca ? last.tour.pca.method : null,
        refitAt: last && last.t0 > -Infinity ? last.t0 : null,
        refitPending: refitRunning,
        empty: empty,
      };
    }

    function leave() {
      tours = [];
      pending = null;
      set = null;
      st = null;
      glide = null;
    }

    return self;
  }

  M.register({
    id: "tumble",
    title: "Tumble",
    summary: "The window turns through the strongest directions of the space on a guided tour.",
    create: create,
  });
})();
