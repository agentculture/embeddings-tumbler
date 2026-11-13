// ---------------------------------------------------------------------------
// 40-mode-tumble.js: Tumble, the guided tour (registered as ET.modes "tumble").
//
// The frame turns inside the span of the data's strongest principal directions
// (ET.math.guidedTour). The frame at time t is the tour's closed-form
// frameAt(t): it depends only on the data, the seed and t. The share of total
// variance those directions hold is reported as a number and in the status
// line. See js/api/40-modes.md.
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
      leave: leave,
    };

    var set = null;
    var D = 0;
    var seed = 0;
    var entry = null;
    var st = null; // set statistics (mean, radius)
    var glide = null;
    var tours = []; // [{ tour, al (alignment or null), t0 }]
    var fittedCount = 0;
    var pending = null; // a refit waiting for its switch time
    var refitting = false;
    var progress = 0;
    var hold = null;
    var out = null;

    function enter(s, opts) {
      var o = opts || {};
      set = s;
      D = s.dimension;
      seed = o.seed === undefined ? 0 : o.seed;
      entry = M.entryFrom(o.from, D);
      st = null;
      glide = null;
      tours = [];
      pending = null;
      refitting = false;
      progress = 0;
      fittedCount = 0;
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

    function prepare() {
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
          tours = [{ tour: tour, al: al, t0: -Infinity }];
          fittedCount = count;
          self.varianceShare = tour.varianceShare;
        }),
      );
      var stp = M.stepper(tasks);
      var inner = stp.step;
      stp.step = function (budget) {
        var r = inner(budget);
        progress = stp.progress;
        return r;
      };
      return stp;
    }

    function isReady() {
      return tours.length > 0 && glide !== null;
    }

    function tourFrame(entryT, t, res) {
      var f = entryT.tour.frameAt(t, res);
      if (entryT.al) M.applyAlignment(new Float32Array(f), entryT.al, D, f);
      return f;
    }

    function frameAt(t, res) {
      var i = tours.length - 1;
      while (i > 0 && tours[i].t0 > t) i--;
      var cur = tours[i];
      tourFrame(cur, t, res);
      if (i > 0 && t - cur.t0 < opt.transition) {
        var prev = tourFrame(tours[i - 1], t, new Float32Array(3 * D));
        ET.math.blendFrames(prev, res, ET.math.smoothstep((t - cur.t0) / opt.transition), D, res);
      }
      return res;
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
      out.t = t;
      if (!isReady()) {
        out.frame.set(hold);
        if (entry && entry.centre) out.centre.set(entry.centre);
        out.draw = entry ? Object.assign({}, entry.draw) : { wires: 0, fog: 0 };
        out.status = status(t);
        return out;
      }
      if (pending) {
        var curNow = frameAt(t, new Float32Array(3 * D));
        var al = M.alignment(pending.tour.frameAt(t), curNow, D);
        tours = tours.filter(function (x) {
          return x.t0 <= t;
        });
        tours.push({ tour: pending.tour, al: al, t0: t });
        fittedCount = pending.count;
        self.varianceShare = pending.tour.varianceShare;
        pending = null;
        refitting = false;
      }
      frameAt(t, out.frame);
      if (entry && t < opt.transition) {
        ET.math.blendFrames(entry.frame, out.frame, ET.math.smoothstep(t / opt.transition), D, out.frame);
      }
      glide.at(t, out.centre);
      out.draw = drawFor(out.frame, out.centre, t);
      out.status = status(t);
      return out;
    }

    function step(dt) {
      self.time += dt;
      return stateAt(self.time);
    }

    function pct(x) {
      return (x * 100).toFixed(1) + "%";
    }

    function status() {
      if (!isReady()) {
        return "finding the strongest directions in " + D + "-d … " + Math.round(progress * 100) + "%";
      }
      var m = tours[tours.length - 1].tour.subspace;
      var s = "tour through the " + m + " strongest directions, which hold " + pct(self.varianceShare) + " of the variance";
      var since = set.count - fittedCount;
      if (since > 0) s += " (measured before " + M.thousands(since) + " appended points)";
      if (refitting) s += " · refitting …";
      return s;
    }

    // Append: keep the tour (no jump); the camera glides to the new mean; the
    // reported share is marked stale until refit(). Replace: start over.
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      if (i.op !== "append" || newSet.dimension !== D || !isReady()) {
        var from = isReady() ? snapshot(t) : entry;
        enter(newSet, { seed: seed, from: from });
        return prepare();
      }
      var old = set;
      set = newSet;
      st = M.stats(newSet, old);
      glide.retarget(t, st.mean);
      return null;
    }

    function snapshot(t) {
      var s = stateAt(t);
      return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: Object.assign({}, s.draw) };
    }

    // Fit the directions again on the current data. Returns a stepper; when it
    // is done, the next stateAt(t) switches to the new tour, blending over
    // `transition` seconds from the old one.
    function refit() {
      if (!isReady()) return prepare();
      refitting = true;
      return M.stepper(
        fit(function (tour, count) {
          pending = { tour: tour, count: count };
        }),
      );
    }

    function describe() {
      var tour = tours.length ? tours[tours.length - 1].tour : null;
      return {
        id: "tumble",
        projection: "linear: a guided tour, a turning orthonormal 3-frame inside the span of the strongest principal directions",
        seed: seed,
        subspace: tour ? tour.subspace : opt.subspace,
        speed: opt.speed,
        varianceShare: self.varianceShare,
        varianceShareStale: isReady() ? set.count !== fittedCount : false,
        pointsSinceFit: isReady() ? set.count - fittedCount : 0,
        fittedRows: tour && tour.pca ? tour.pca.sampledRows : 0,
        method: tour && tour.pca ? tour.pca.method : null,
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
