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
    // Where hidden directions come from. "strongest": inside the span of the data's
    // `subspace` strongest principal directions, so every picture keeps real spread
    // (in real vectors a direction drawn from the full space holds almost none, and
    // after three swaps the picture would be a random one). "full": anywhere in the
    // space, as the reference does.
    hidden: "strongest",
    subspace: 8,
    fitRows: 4096, // fit the directions on at most this many rows (as Tumble does)
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
    var guided = false; // the swap tour draws from the fitted directions
    var fitShare = null; // share of variance in those directions
    var epoch = 0; // bumped by enter and leave: work queued for an earlier entry does nothing
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
      // Until the directions are fitted (or when hidden is "full") the schedule draws
      // from the full space; no frame is answered from it before the mode is ready.
      swap = ET.math.makeSwapTour(hold, D, { seed: seed, period: opt.period });
      guided = false;
      fitShare = null;
      epoch++;
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

    // Does this set get hidden directions from its strongest directions?
    function wantsGuided() {
      return opt.hidden !== "full" && Math.min(opt.subspace, D) >= 4 && set.count > 1;
    }

    // The fit, in small units: centring, then the strongest directions (the same
    // fit Tumble uses, ET.math.makeGuidedTour, for its basis only), then the swap
    // tour over them. Required: no frame is answered before it is done, so the
    // frames depend on data, seed and time only.
    function fitTasks() {
      var mine = epoch;
      var fitSet = set;
      var cen = null;
      var tourSt = null;
      return [
        {
          required: true,
          weight: 1,
          progress: function () {
            return cen ? cen.progress : 0;
          },
          run: function () {
            if (mine !== epoch) return true;
            if (!cen) cen = ET.math.makeCentre(fitSet.vectors, fitSet.count, D);
            return cen.step(0);
          },
        },
        {
          required: true,
          weight: 6,
          progress: function () {
            return tourSt ? tourSt.progress : 0;
          },
          run: function () {
            if (mine !== epoch) return true;
            if (!tourSt) {
              tourSt = ET.math.makeGuidedTour(cen.result.data, fitSet.count, D, {
                seed: seed,
                subspace: Math.min(opt.subspace, D),
                sampleRows: fitSet.count > opt.fitRows ? opt.fitRows : undefined,
              });
            }
            if (!tourSt.step(0)) return false;
            var tour = tourSt.result;
            cen = null; // the centred copy is not kept
            tourSt = null;
            swap = ET.math.makeSwapTour(hold, D, {
              seed: seed,
              period: opt.period,
              basis: tour.basis,
              basisRows: tour.subspace,
            });
            guided = true;
            fitShare = tour.varianceShare;
            return true;
          },
        },
      ];
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
      var tasks = [statsTask()];
      if (wantsGuided()) tasks = tasks.concat(fitTasks());
      tasks.push(knnTask());
      return M.stepper(tasks);
    }

    function isReady() {
      return empty ? emptyReady : glide !== null && (guided || !wantsGuided());
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
        hidden: guided ? "strongest" : "full",
        subspace: guided ? Math.min(opt.subspace, D) : null,
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
        varianceShare: fitShare,
      };
    }

    function leave() {
      epoch++;
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
