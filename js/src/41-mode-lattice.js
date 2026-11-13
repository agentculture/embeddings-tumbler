// ---------------------------------------------------------------------------
// 41-mode-lattice.js: Lattice (registered as ET.modes "lattice").
//
// Points are wired to their true nearest neighbours, measured in the full
// space (ET.math.makeKnn, run in bounded slices). One visible axis at a time
// is turned a quarter turn into a hidden direction (ET.math.makeSwapTour), so
// the frame at time t depends only on the starting frame, the seed and t; the
// wires are drawn in addition as soon as they are measured and never change
// the frame. See js/api/40-modes.md.
// ---------------------------------------------------------------------------
(function () {
  var M = ET.modes;

  var DEFAULTS = {
    period: 3.4, // seconds per axis swap (the reference's)
    neighbourLimit: 1000, // only the first this-many points get neighbours (the reference's 1,000)
    wireNeighbours: 3, // wires per point (the reference's 3)
    sliceRows: 16, // query rows per unit of neighbour work (the reference's 16)
    transition: 1.2, // seconds to blend draw parameters in from the previous view
    wireFade: 1.2, // seconds for the wires to fade in once measured
    centreTau: 0.7, // seconds: the camera glides to the data's mean
    zoomSample: 512, // points used for auto-framing
  };

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options && options[k] !== undefined ? options[k] : DEFAULTS[k];

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
      leave: leave,
    };

    var set = null;
    var D = 0;
    var seed = 0;
    var entry = null;
    var st = null;
    var glide = null;
    var swap = null;
    var knn = null; // the stepper in progress (or finished)
    var wires = null; // { pairs, lengths, version }
    var version = 0;
    var wiresSeenAt = null; // mode time when the wires were first drawn
    var queried = false; // has stateAt been called since enter?
    var out = null;

    function enter(s, opts) {
      var o = opts || {};
      set = s;
      D = s.dimension;
      seed = o.seed === undefined ? 0 : o.seed;
      entry = M.entryFrom(o.from, D);
      st = null;
      glide = null;
      knn = null;
      wires = null;
      wiresSeenAt = null;
      queried = false;
      self.time = 0;
      var frame0 = entry ? entry.frame : M.startFrame(D, seed);
      swap = ET.math.makeSwapTour(frame0, D, { seed: seed, period: opt.period });
      out = { t: 0, frame: new Float32Array(3 * D), centre: new Float32Array(D), draw: null, wires: null, status: "", focus: null };
    }

    function statsTask() {
      return {
        required: true,
        weight: 1,
        run: function () {
          st = M.stats(set);
          var start = entry && entry.centre ? entry.centre : st.mean;
          glide = M.makeGlide(start, st.mean, opt.centreTau, D);
          return true;
        },
      };
    }

    // Neighbour measurement over the current set, then the wire list.
    function knnTask() {
      var s = set;
      var stepper = ET.math.makeKnn(s.vectors, s.count, D, opt.wireNeighbours, { limit: opt.neighbourLimit });
      knn = stepper;
      return {
        required: false,
        weight: 8,
        progress: function () {
          return stepper.count ? stepper.next / stepper.count : 1;
        },
        run: function () {
          if (knn !== stepper) return true; // superseded by a newer measurement
          if (!stepper.step(opt.sliceRows)) return false;
          buildWires(s, stepper);
          return true;
        },
      };
    }

    // Each point's first `wireNeighbours` neighbours, deduplicated. Points with no
    // group get no wires of their own when the pool has groups (the reference
    // leaves its unstructured halo unwired); they can still be another point's
    // neighbour.
    function buildWires(s, kn) {
      var S = kn.count;
      var K = kn.k;
      var anyGroup = false;
      for (var i = 0; i < S && !anyGroup; i++) anyGroup = !!s.points[i].group;
      var pairs = [];
      var lengths = [];
      var seen = {};
      for (var a = 0; a < S; a++) {
        if (anyGroup && !s.points[a].group) continue;
        for (var q = 0; q < K; q++) {
          var b = kn.indices[a * K + q];
          var key = a < b ? a * S + b : b * S + a;
          if (seen[key]) continue;
          seen[key] = 1;
          pairs.push(a, b);
          lengths.push(kn.distances[a * K + q]);
        }
      }
      version++;
      var first = wires === null;
      wires = { pairs: new Uint32Array(pairs), lengths: new Float32Array(lengths), version: version };
      // Measured before the clock started: fade in with the mode from t = 0. A
      // replacement list (after an append) is shown at full strength at once.
      if (first) wiresSeenAt = queried ? null : 0;
    }

    function prepare() {
      return M.stepper([statsTask(), knnTask()]);
    }

    function isReady() {
      return glide !== null;
    }

    function wireOpacity(t) {
      if (!wires) return 0;
      if (wiresSeenAt === null) wiresSeenAt = t;
      return ET.math.smoothstep((t - wiresSeenAt) / opt.wireFade);
    }

    function stateAt(time) {
      var t = M.checkTime(time);
      out.t = t;
      swap.frameAt(t, out.frame);
      if (glide) glide.at(t, out.centre);
      else if (entry && entry.centre) out.centre.set(entry.centre);
      var sc = st ? st.radius / M.REFERENCE_RADIUS : 1;
      var draw = {
        zoom: M.autoZoom(set.vectors, set.count, D, out.frame, out.centre, opt.zoomSample),
        wires: wireOpacity(t),
        dim: 0.55,
        trails: 0.1,
        fog: 0,
        fogNear: 1.2 * sc,
        fogWidth: 0.8 * sc,
        twinkle: 0.18,
        depthOfField: 1.1,
      };
      // the wire fade-in is its own ramp, not part of the entry blend
      var w = draw.wires;
      out.draw = M.blendDraw(draw, entry, t, opt.transition);
      out.draw.wires = w;
      queried = true;
      out.wires = wires;
      out.status = status(t);
      return out;
    }

    function step(dt) {
      self.time += dt;
      return stateAt(self.time);
    }

    function status(time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      var s = swap.stateAt(t);
      var pctSwap = String(Math.round(Math.min(1, s.u) * 100));
      while (pctSwap.length < 3) pctSwap = " " + pctSwap;
      var line = "swap " + (s.cycle + 1) + " · axis " + "XYZ".charAt(s.axis) + " trading for a hidden direction · " + pctSwap + "%";
      var measuring = knn && !knn.done;
      if (wires && !measuring) {
        line += " · " + M.thousands(wires.pairs.length / 2) + " wires";
      } else if (knn) {
        line += " · measuring true neighbours in " + D + "-d … " + Math.round((knn.next / Math.max(1, knn.count)) * 100) + "%";
        if (wires) line += " (" + M.thousands(wires.pairs.length / 2) + " wires shown)";
      } else {
        line += " · no wires yet";
      }
      return line;
    }

    // Append: the swap tour goes on unchanged and the camera glides to the new
    // mean. If new points fall inside the neighbour limit, neighbours are
    // measured again (the old wires stay until the new ones are ready).
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      if (i.op !== "append" || newSet.dimension !== D) {
        var s = stateAt(t);
        enter(newSet, {
          seed: seed,
          from: { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: Object.assign({}, s.draw) },
        });
        return prepare();
      }
      var old = set;
      set = newSet;
      if (!glide) return null; // preparation not started: it will read the new set
      st = M.stats(newSet, old);
      glide.retarget(t, st.mean);
      if (old.count < opt.neighbourLimit) return M.stepper([knnTask()]);
      return null;
    }

    function describe() {
      return {
        id: "lattice",
        projection: "linear: an orthonormal 3-frame; one axis at a time turns a quarter turn into a hidden direction",
        seed: seed,
        period: opt.period,
        neighbourLimit: opt.neighbourLimit,
        wireNeighbours: opt.wireNeighbours,
        wires: wires ? wires.pairs.length / 2 : 0,
        neighboursMeasured: !!(knn && knn.done),
        varianceShare: null,
      };
    }

    function leave() {
      knn = null;
      wires = null;
      set = null;
    }

    return self;
  }

  M.register({
    id: "lattice",
    title: "Lattice",
    summary: "True neighbours wired together, one axis swapped at a time.",
    create: create,
  });
})();
