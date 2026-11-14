// ---------------------------------------------------------------------------
// 43-mode-focus.js: Focus (registered as ET.modes "focus").
//
// The view is fitted to what is being searched for: with searches active, the
// frame is the facing frame of the union of every search's query and named
// results (ET.searchSets.makeFacingFrame, seeded); with none it is the fit of
// the whole set (its three strongest directions). When the searches change the
// view turns smoothly onto the new fit. The viewer keeps spinning the cloud on
// top of the frame (yaw); while a search is shown Focus asks for the Focus
// reference's spin (the mode's `spin` member, 0.13 rad/s), so the view keeps
// turning at a clearly visible speed; with none it turns as before. A results fit is zoomed the way the reference zooms it: the results'
// reach fills 0.36 of the stage's shorter side. Unlit points are dimmer than in
// the other modes (unlitGain FOCUS_UNLIT); the Only results setting is reported
// as the draw key unlitGain 0, which hides points whose lit value is 0. See
// docs/search-interface.md and js/api/43-mode-focus.md.
// ---------------------------------------------------------------------------
(function () {
  var M = ET.modes;
  var MAX_TURNS = 64; // turns kept; older ones are dropped (a seek that far back shows the oldest kept)
  // Corrected after the owner's browser look (2026-11-14), to match
  // docs/specs/reference/tumbler-focus-view.html:
  var SPIN = 0.13; // rad/s of yaw the viewer turns Focus at with a search (the reference's; otherwise 0.06)
  // The reference maps the results' reach to 0.36 of the stage's shorter side; the renderer
  // maps one unit to 0.46 of it (ET.renderer.DEFAULTS.radius), so the reach is drawn at 0.36 / 0.46 units.
  var FOCUS_UNIT = 0.36 / 0.46;
  // The query may sit up to this many results' reaches from the centre (the stage's shorter
  // half-side is 0.5 / 0.36 = 1.39 reaches), so a query far from its results stays on stage.
  var QUERY_ROOM = 1.3;
  var MIN_REACH = 1e-3; // a reach below this (all rows on one spot) reads as this
  // Brightness of an unlit point in Focus while a search is shown (the renderer's default
  // elsewhere is 0.07). The reference draws unlit points at 0.13 of a result's alpha on a
  // 124-point page; the sample set's 12,288 points pile up under the bloom, so the value
  // that reads as faint as the reference's is lower.
  var FOCUS_UNLIT = 0.05;

  var DEFAULTS = {
    transition: 1.5, // seconds to turn from the entry view onto the first fit, and to blend draw parameters in
    turn: 1.6, // seconds to turn from the view shown onto a new fit (smoothstep)
    fitRows: 4096, // the whole-set fit uses at most this many rows (at an even stride)
    zoomSample: 512, // points used for auto-framing of the whole-set fit
  };

  function copyOf(a) {
    return Float32Array.from(a);
  }

  // The caller's search, copied so later changes by the caller cannot reach it.
  function snapshotOf(search) {
    var list = search?.searches;
    if (!Array.isArray(list) || list.length === 0) return null;
    return {
      searches: list.slice(0, 4).map(function (s, j) {
        return {
          letter: typeof s?.letter === "string" ? s.letter : ET.searchSets.LETTERS[j],
          query: copyOf(s?.query || []),
          indices: Int32Array.from(s?.indices || []),
        };
      }),
      scale: search.scale ? copyOf(search.scale) : null,
      onlyResults: search.onlyResults === true,
    };
  }

  function sameArray(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Do two snapshots ask for the same fit? (The Only results setting is not part of a fit.)
  function sameFit(a, b) {
    if (!a || !b) return a === b;
    if (a.searches.length !== b.searches.length || !sameArray(a.scale, b.scale)) return false;
    for (var j = 0; j < a.searches.length; j++) {
      if (!sameArray(a.searches[j].query, b.searches[j].query)) return false;
      if (!sameArray(a.searches[j].indices, b.searches[j].indices)) return false;
    }
    return true;
  }

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options?.[k] === undefined ? DEFAULTS[k] : options[k];

    var self = {
      time: 0,
      spin: undefined, // SPIN while a usable search is asked for (see updateSpin)
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
      searchChanged: searchChanged,
    };

    var set = null;
    var D = 0;
    var seed = 0;
    var entry = null;
    var empty = false;
    var emptyReady = false;
    var ready = false;
    var hold = null;
    var epoch = 0; // bumped by enter and leave: work queued for an earlier entry does nothing
    var want = null; // the searches asked for now (a snapshot), or null: kept across a data change
    var wantVersion = 0; // bumped when the fit asked for changes
    var whole = null; // the whole-set fit, once made for this entry
    var turns = []; // { T, from, to, dur, kind, letters }: each fixed once recorded
    var pending = null; // a finished fit waiting for its time: { result, minT, kind, letters }
    var prepared = null;
    var out = null;
    var scratch = null;

    function enter(s, opts) {
      M.requireDimension(s, 3, "Focus");
      var o = opts || {};
      set = s;
      D = s.dimension;
      seed = o.seed === undefined ? 0 : o.seed;
      entry = M.entryFrom(o.from, D);
      empty = s.count === 0;
      emptyReady = false;
      ready = false;
      whole = null;
      turns = [];
      pending = null;
      prepared = null;
      self.time = 0;
      hold = entry ? entry.frame : M.startFrame(D, seed);
      epoch++;
      out = { t: 0, frame: new Float32Array(3 * D), centre: new Float32Array(D), draw: null, wires: null, status: "", focus: null };
      scratch = { frame: new Float32Array(3 * D), centre: new Float32Array(D) };
      updateSpin();
    }

    // True when a search the set can use is asked for (a query of the set's dimension).
    function hasUsableSearch() {
      return !!want?.searches.some((s) => s.query.length === D);
    }

    // The reference's spin while a usable search is asked for; with none the member is left
    // undefined, so the viewer turns Focus at its own speed and the no-search frames are as before.
    function updateSpin() {
      self.spin = hasUsableSearch() ? SPIN : undefined;
    }

    // ----- the fits, in bounded units -------------------------------------------

    // The searches this set can use: a query of the set's dimension, hits that are rows.
    function usableSearches() {
      if (!want) return [];
      var list = [];
      for (var s of want.searches) {
        if (s.query.length !== D) continue;
        var hits = [];
        for (var i of s.indices) if (i >= 0 && i < set.count) hits.push({ index: i });
        list.push({ letter: s.letter, query: s.query, hits: hits });
      }
      return list;
    }

    // The whole set: its three strongest directions about its mean.
    function wholeJob() {
      var mine = set;
      var phase = 0;
      var stats = M.statsJob(mine);
      var cen = null;
      var pca = null;
      var job = {
        done: false,
        result: null,
        kind: "all",
        letters: [],
        progress: function () {
          if (job.done) return 1;
          return [stats.progress() * 0.1, 0.1 + (cen ? cen.progress : 0) * 0.1, 0.2 + (pca ? pca.progress : 0) * 0.8][phase];
        },
        unit: function () {
          if (phase === 0) {
            if (!stats.run()) return false;
            cen = ET.math.makeCentre(mine.vectors, mine.count, D);
            phase = 1;
          } else if (phase === 1) {
            if (!cen.step(0)) return false;
            pca = ET.math.makePrincipalDirections(cen.result.data, mine.count, D, 3, {
              seed: seed,
              sampleRows: mine.count > opt.fitRows ? opt.fitRows : undefined,
            });
            cen = null; // the centred copy is not kept
            phase = 2;
          } else if (pca.step(0)) {
            finishWhole(job, stats.result, pca.result.directions);
          }
          return job.done;
        },
      };
      return job;
    }

    function finishWhole(job, st, directions) {
      var frame = copyOf(directions);
      ET.math.orthonormalize(frame, 3, D);
      var centre = copyOf(st.mean);
      job.result = { frame: frame, centre: centre, zoom: M.autoZoom(set.vectors, set.count, D, frame, centre, opt.zoomSample) };
      job.done = true;
      whole = job.result;
    }

    // The union of the searches' queries and named results, in the facing frame.
    function resultsJob(list) {
      var fs = ET.searchSets.makeFacingFrame(set, list, { seed: seed, scale: usableScale() });
      var job = {
        done: false,
        result: null,
        kind: "results",
        letters: list.map(function (s) {
          return s.letter;
        }),
        progress: function () {
          return job.done ? 1 : fs.progress;
        },
        unit: function () {
          if (!fs.step(0)) return false;
          job.result = { frame: fs.result.frame, centre: fs.result.centre, zoom: resultsZoom(fs.result, list) };
          job.done = true;
          return true;
        },
      };
      return job;
    }

    // The length of (x - centre) in the fitted frame; x is D numbers of `a` from `at`.
    function shownLength(fit, a, at) {
      var sq = 0;
      for (var k = 0; k < 3; k++) {
        var p = 0;
        for (var d = 0; d < D; d++) p += (a[at + d] - fit.centre[d]) * fit.frame[k * D + d];
        sq += p * p;
      }
      return Math.sqrt(sq);
    }

    // The reference's zoom for a results fit: the farthest named result at FOCUS_UNIT units,
    // pulled back only as far as needed to keep each query within QUERY_ROOM of that.
    function resultsZoom(fit, list) {
      var hits = 0;
      var queries = 0;
      for (var s of list) {
        queries = Math.max(queries, shownLength(fit, s.query, 0));
        for (var h of s.hits) hits = Math.max(hits, shownLength(fit, set.vectors, h.index * D));
      }
      var reach = Math.max(hits, queries / QUERY_ROOM, MIN_REACH);
      return Number.isFinite(reach) ? FOCUS_UNIT / reach : fit.zoom;
    }

    function usableScale() {
      return want?.scale?.length === D ? want.scale : null;
    }

    function wantedJob() {
      var list = usableSearches();
      if (list.length) return resultsJob(list);
      if (whole) return { done: true, result: whole, kind: "all", letters: [], progress: 1, unit: () => true };
      return wholeJob();
    }

    // ----- turns ----------------------------------------------------------------

    // The view shown at time t, written into `into` ({ frame, centre }); returns the zoom.
    function sampleAt(t, into) {
      var i = turns.length - 1;
      while (i > 0 && turns[i].T > t) i--;
      var tn = turns[i];
      var e = tn.dur > 0 ? ET.math.smoothstep((t - tn.T) / tn.dur) : 1;
      if (e >= 1 || e <= 0) {
        // before the turn starts, and after it ends, the exact frame (no blend rounding)
        var end = e <= 0 ? tn.from : tn.to;
        into.frame.set(end.frame);
        into.centre.set(end.centre);
        return end.zoom;
      }
      ET.math.blendFrames(tn.from.frame, tn.to.frame, e, D, into.frame);
      for (var d = 0; d < D; d++) into.centre[d] = tn.from.centre[d] + (tn.to.centre[d] - tn.from.centre[d]) * e;
      return tn.from.zoom + (tn.to.zoom - tn.from.zoom) * e;
    }

    // Record the turn onto `fitted` at time T (never earlier than the last turn).
    function record(T, fitted, kind, letters) {
      var first = turns.length === 0;
      var at = first ? T : Math.max(T, turns.at(-1).T);
      var to = { frame: copyOf(fitted.frame), centre: copyOf(fitted.centre), zoom: fitted.zoom };
      var from = to;
      var dur = 0; // nothing to turn from: the first fit with no entry view is simply the view
      if (!first || entry) {
        var shown = { frame: new Float32Array(3 * D), centre: new Float32Array(D) };
        shown.zoom = first ? to.zoom : sampleAt(at, shown);
        if (first) {
          shown.frame.set(entry.frame);
          shown.centre.set(entry.centre || to.centre);
        }
        to.frame = ET.math.alignTo(to.frame, shown.frame, D);
        from = shown;
        dur = first ? opt.transition : opt.turn;
      }
      turns.push({ T: at, from: from, to: to, dur: dur, kind: kind, letters: letters });
      if (turns.length > MAX_TURNS) turns.shift();
    }

    function fixPending(t) {
      var p = pending;
      pending = null;
      record(Math.max(t, p.minT), p.result, p.kind, p.letters);
    }

    // ----- the interface --------------------------------------------------------

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
      var mine = epoch;
      var job = null;
      var jobVersion = -1;
      prepared = M.stepper([
        {
          required: true,
          weight: 1,
          progress: function () {
            return job ? job.progress() : 0;
          },
          run: function () {
            if (mine !== epoch || ready) return true;
            // A search that changed during the preparation restarts the fit on the new one.
            if (!job || jobVersion !== wantVersion) {
              job = wantedJob();
              jobVersion = wantVersion;
            }
            if (!job.unit()) return false;
            record(0, job.result, job.kind, job.letters);
            ready = true;
            return true;
          },
        },
      ]);
      return prepared;
    }

    function isReady() {
      return empty ? emptyReady : ready;
    }

    // The searches changed at mode time t (null: none). Returns a stepper to pump when
    // a fit has to be made (the view keeps its place until it is done and then turns
    // onto it), or null when there is nothing to pump.
    function searchChanged(search, t) {
      var next = snapshotOf(search);
      var same = sameFit(want, next);
      want = next;
      updateSpin();
      if (same) return null;
      wantVersion++;
      if (!ready || empty || !set) return null; // the preparation reads `want` when it runs
      var at = M.checkTime(t === undefined ? self.time : t);
      var job = wantedJob();
      if (job.done) {
        pending = { result: job.result, minT: at, kind: job.kind, letters: job.letters };
        fixPending(at);
        return null;
      }
      return fitStepper(job, at);
    }

    function fitStepper(job, at) {
      var mine = epoch;
      var version = wantVersion;
      return M.stepper([
        {
          required: true,
          weight: 1,
          progress: job.progress,
          run: function () {
            if (mine !== epoch || version !== wantVersion) return true; // superseded
            if (!job.unit()) return false;
            pending = { result: job.result, minT: at, kind: job.kind, letters: job.letters };
            return true;
          },
        },
      ]);
    }

    // Fix the time of a finished fit waiting to be turned onto.
    function mark(time) {
      if (pending) fixPending(M.checkTime(time));
    }

    function drawFor(zoom, t) {
      var draw = {
        zoom: zoom,
        wires: 0,
        dim: 1,
        trails: 0.17,
        fog: 0,
        fogNear: 1.2,
        fogWidth: 0.8,
        twinkle: 0.18,
        depthOfField: 1.1,
      };
      if (hasUsableSearch()) draw.unlitGain = want.onlyResults ? 0 : FOCUS_UNLIT;
      return M.blendDraw(draw, entry, t, opt.transition);
    }

    function stateAt(time) {
      var t = M.checkTime(time);
      if (!isReady() || empty) return M.holdState(out, hold, entry, t, status(t));
      if (pending) fixPending(t); // no time was given: the first query fixes it
      out.t = t;
      var zoom = sampleAt(t, out);
      out.draw = drawFor(zoom, t);
      out.wires = null;
      out.focus = null;
      out.status = status(t);
      return out;
    }

    function step(dt) {
      self.time = Math.max(0, self.time + dt);
      return stateAt(self.time);
    }

    function turnAt(t) {
      var i = turns.length - 1;
      while (i > 0 && turns[i].T > t) i--;
      return turns[i];
    }

    function status(time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      if (empty) return M.EMPTY_STATUS;
      if (!isReady()) {
        var pct = Math.round((prepared ? prepared.progress : 0) * 100);
        return "fitting the view to the set in " + D + "-d … " + pct + "%";
      }
      var tn = turnAt(t);
      return tn.kind === "results" ? "fitted to the results of " + tn.letters.join(", ") : "fitted to every point";
    }

    // Any change of the data starts the mode again from the view shown (the
    // searches are kept: the viewer asks for them again when their results change).
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      var from = entry;
      if (isReady()) {
        var s = stateAt(t);
        from = { frame: copyOf(s.frame), centre: null, draw: { ...s.draw } };
        if (!empty || entry?.centre) from.centre = copyOf(s.centre);
      }
      enter(newSet, { seed: seed, from: from });
      return M.changed(prepare(), true);
    }

    function describe() {
      var last = turns.length ? turns.at(-1) : null;
      var results = last?.kind === "results";
      return {
        id: "focus",
        projection: "linear: an orthonormal 3-frame fitted to the results of the searches, or to the whole set",
        seed: seed,
        fittedTo: results ? "results" : "all",
        searches: results ? last.letters.slice() : [],
        onlyResults: want?.onlyResults === true,
        empty: empty,
        varianceShare: null,
      };
    }

    function leave() {
      epoch++;
      turns = [];
      pending = null;
      prepared = null;
      whole = null;
      set = null;
    }

    return self;
  }

  M.register({
    id: "focus",
    title: "Focus",
    summary: "The view fitted to the search results",
    create: create,
  });
})();
