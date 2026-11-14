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
  var KNN_SLICE_MS = 1; // a unit of neighbour work stops after its first row once this has passed

  var DEFAULTS = {
    period: 3.4, // seconds per axis swap (the reference's)
    neighbourLimit: 1000, // only the first this-many points get neighbours (the reference's 1,000)
    wireNeighbours: 3, // wires per point (the reference's 3)
    sliceRows: 16, // at most this many query rows per unit of neighbour work (the reference's 16)
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
      mark: mark,
      leave: leave,
    };

    var set = null;
    var D = 0;
    var seed = 0;
    var entry = null;
    var empty = false;
    var emptyReady = false;
    var st = null;
    var glide = null;
    var swap = null;
    var hold = null;
    var knn = null; // the stepper in progress (or finished)
    var version = 0;
    // Wire lists in the order they were shown: { wires: {pairs, lengths, version}, T }.
    // A list is drawn from its time T on; T is fixed by mark(t), or by the first
    // stateAt after the list was measured, and never earlier than the last T.
    var lists = [];
    var pendingWires = null; // a measured list whose time is not fixed yet
    var out = null;

    function enter(s, opts) {
      M.requireDimension(s, 4, "Lattice");
      var o = opts || {};
      set = s;
      D = s.dimension;
      seed = o.seed === undefined ? 0 : o.seed;
      entry = M.entryFrom(o.from, D);
      empty = s.count === 0;
      emptyReady = false;
      st = null;
      glide = null;
      knn = null;
      lists = [];
      pendingWires = null;
      self.time = 0;
      hold = entry ? entry.frame : M.startFrame(D, seed);
      swap = ET.math.makeSwapTour(hold, D, { seed: seed, period: opt.period });
      out = { t: 0, frame: new Float32Array(3 * D), centre: new Float32Array(D), draw: null, wires: null, status: "", focus: null };
    }

    function statsTask() {
      var job = M.statsJob(set);
      return {
        required: true,
        weight: 1,
        progress: job.progress,
        run: function () {
          if (!job.run()) return false;
          st = job.result;
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
          // Query rows one at a time until about KNN_SLICE_MS has passed (at
          // least one row, at most sliceRows). The rows are measured in order
          // whatever the slicing, so the wires never depend on it.
          var start = M.now();
          var rows = 0;
          while (!stepper.done && rows < opt.sliceRows && (rows === 0 || M.now() - start < KNN_SLICE_MS)) {
            stepper.step(1);
            rows++;
          }
          if (!stepper.done) return false;
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
      pendingWires = { pairs: new Uint32Array(pairs), lengths: new Float32Array(lengths), version: version };
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
      return M.stepper([statsTask(), knnTask()]);
    }

    function isReady() {
      return empty ? emptyReady : glide !== null;
    }

    function lastT() {
      return lists.length ? lists[lists.length - 1].T : -Infinity;
    }

    function fixWires(T) {
      lists.push({ wires: pendingWires, T: Math.max(T, lastT()) });
      pendingWires = null;
    }

    // Fix the time of a finished event (a measured wire list waiting to be shown).
    function mark(time) {
      if (pendingWires) fixWires(M.checkTime(time));
    }

    function activeList(t) {
      for (var i = lists.length - 1; i >= 0; i--) if (lists[i].T <= t) return lists[i];
      return null;
    }

    // The first list fades in over wireFade from its time; later lists replace
    // it at full strength.
    function wireOpacity(t) {
      if (!lists.length || t < lists[0].T) return 0;
      return ET.math.smoothstep((t - lists[0].T) / opt.wireFade);
    }

    function stateAt(time) {
      var t = M.checkTime(time);
      if (!isReady() || empty) return M.holdState(out, hold, entry, t, status(t));
      if (pendingWires) fixWires(t); // no time was given: the first query fixes it
      out.t = t;
      swap.frameAt(t, out.frame);
      glide.at(t, out.centre);
      var sc = st.radius / M.REFERENCE_RADIUS;
      var draw = {
        zoom: M.autoZoom(set.vectors, set.count, D, out.frame, out.centre, opt.zoomSample),
        wires: 0,
        dim: 0.55,
        trails: 0.1,
        fog: 0,
        fogNear: 1.2 * sc,
        fogWidth: 0.8 * sc,
        twinkle: 0.18,
        depthOfField: 1.1,
      };
      out.draw = M.blendDraw(draw, entry, t, opt.transition);
      // the wire fade-in is its own ramp, not part of the entry blend
      out.draw.wires = wireOpacity(t);
      var list = activeList(t);
      out.wires = list ? list.wires : null;
      out.focus = null;
      out.status = status(t);
      return out;
    }

    function step(dt) {
      self.time = Math.max(0, self.time + dt);
      return stateAt(self.time);
    }

    // Short on purpose (about 70 characters at most); detail is in describe().
    function status(time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      if (empty) return M.EMPTY_STATUS;
      var s = swap.stateAt(t);
      var pctSwap = String(Math.round(Math.min(1, s.u) * 100));
      while (pctSwap.length < 3) pctSwap = " " + pctSwap;
      var line = "swap " + (s.cycle + 1) + " · axis " + "XYZ".charAt(s.axis) + " trading for a hidden direction · " + pctSwap + "%";
      var list = isReady() ? activeList(t) : null;
      if (list) {
        var nw = list.wires.pairs.length / 2;
        line += " · " + M.thousands(nw) + (nw === 1 ? " wire" : " wires");
      }
      else if (knn) line += " · measuring " + Math.round((knn.next / Math.max(1, knn.count)) * 100) + "%";
      else line += " · no wires yet";
      return line;
    }

    // Append: the swap tour goes on unchanged and the camera glides to the new
    // mean. If new points fall inside the neighbour limit, neighbours are
    // measured again (the old wires stay until the new ones are shown). The
    // first points onto an empty set, a replace, or another dimension: start
    // over from the current view.
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      if (i.op !== "append" || newSet.dimension !== D || empty || !isReady()) {
        var from = entry;
        if (isReady()) {
          var s = stateAt(t);
          from = { frame: new Float32Array(s.frame), centre: null, draw: Object.assign({}, s.draw) };
          if (!empty || (entry && entry.centre)) from.centre = new Float32Array(s.centre);
        }
        enter(newSet, { seed: seed, from: from });
        return M.changed(prepare(), true);
      }
      var old = set;
      set = newSet;
      st = M.stats(newSet, old);
      glide.retarget(t, st.mean);
      if (old.count < opt.neighbourLimit) return M.changed(M.stepper([knnTask()]), false);
      return M.changed(null, false);
    }

    function describe() {
      var last = lists.length ? lists[lists.length - 1] : null;
      return {
        id: "lattice",
        projection: "linear: an orthonormal 3-frame; one axis at a time turns a quarter turn into a hidden direction",
        seed: seed,
        period: opt.period,
        neighbourLimit: opt.neighbourLimit,
        wireNeighbours: opt.wireNeighbours,
        wires: last ? last.wires.pairs.length / 2 : 0,
        neighboursMeasured: !!(knn && knn.done),
        wiresShownAt: lists.length ? lists[0].T : null,
        wiresReplacedAt: lists.length > 1 ? last.T : null,
        wiresPending: pendingWires !== null,
        empty: empty,
        varianceShare: null,
      };
    }

    function leave() {
      knn = null;
      lists = [];
      pendingWires = null;
      set = null;
    }

    return self;
  }

  M.register({
    id: "lattice",
    title: "Lattice",
    summary: "True neighbours wired together, one axis swapped at a time",
    create: create,
  });
})();
