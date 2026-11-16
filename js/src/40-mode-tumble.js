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
    transition: 1.5, // seconds to blend in from the previous view (mode entry only)
    refitTransition: "auto", // seconds to turn onto a refitted tour; "auto" picks it from the turn's size
    refitTransitionMin: 1.5, // "auto" never turns faster than this many seconds
    refitTransitionMax: 12, // nor slower than this many
    fitRows: 4096, // fit the directions on at most this many rows (shares stay exact)
    centreTau: 0.7, // seconds: the camera glides to the data's mean (the reference's)
    zoomSample: 512, // points used for auto-framing
    relativeTransition: 1.5, // seconds to turn onto (or off) the relative frame (docs/relative-interface.md)
  };

  // ----- the relative setting (docs/relative-interface.md, "Tumble (t6)") -----
  //
  // With the setting on and a search that gives an axis, the frame is pinned:
  // row 1 to the first search's direction, row 0 to the part of the second the
  // first does not contain, row 2 to the third's new part (ET.math.relativeFit
  // and makeRelativeTour). A change of the searches or of the setting is an
  // event at a fixed time T, like a refit: the fit is prepared in small units
  // while the view keeps moving, T is fixed by mark(t) (or the first stateAt
  // after the fit is done), and from T the frame turns onto the new one with
  // the refit turn over relativeTransition seconds. The centre and zoom glide to
  // the ruler's window over the same time. Only the searches' letters and query
  // vectors are read, so the point of view and the reranker never reach the
  // frame. With the setting off nothing here runs and Tumble is unchanged.

  var RELATIVE_MARGIN = 0.04; // the window's margin above the top and below the bottom (the reference's)
  var RELATIVE_ORIGIN_MARGIN = 0.06; // with Show the origin, the window reaches at least this far past 0
  var RELATIVE_FILL = 0.78 / 0.46; // the window fills 78 percent of the stage's shorter side
  var RELATIVE_ZOOM_CAP = 0.5 / (0.42 * 0.46); // the reference's cap for a narrow stage
  var RELATIVE_AXES = ["vertical", "horizontal", "depth"];

  // "A", "A and B", "A, B and C".
  function joinLetters(letters) {
    if (letters.length < 2) return letters.join("");
    return letters.slice(0, -1).join(", ") + " and " + letters.at(-1);
  }

  // The searches Tumble reads: [{ letter, query: Float32Array(D) }] (copies), in
  // the order given. Entries without a query of D values are left out.
  function readQueries(search, D) {
    var list = [];
    var given = search && Array.isArray(search.searches) ? search.searches : [];
    for (var q of given) {
      var v = q?.query;
      if (v?.length !== D) continue;
      list.push({ letter: typeof q.letter === "string" ? q.letter : String(list.length + 1), query: Float32Array.from(v) });
    }
    return list;
  }

  // Two float32 vectors with the same bits.
  function sameBits(x, y) {
    if (x.length !== y.length) return false;
    var a = new Uint32Array(x.buffer, x.byteOffset, x.length);
    var b = new Uint32Array(y.buffer, y.byteOffset, y.length);
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // Two lists of searches with the same query bytes in the same order (and,
  // with `letters`, the same letters).
  function sameQueries(a, b, letters) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (letters && a[i].letter !== b[i].letter) return false;
      if (!sameBits(a[i].query, b[i].query)) return false;
    }
    return true;
  }

  // The status line of the relative view (docs/relative-interface.md, "Status strings (t6)").
  function relativeStatus(turn, settled) {
    var fit = turn.fit;
    var letters = fit.pinned.map(function (p) {
      return turn.list[p.index].letter;
    });
    var measure = fit.unit.unit ? "cosine" : "length along the search";
    var s = "relative to " + joinLetters(letters);
    if (settled) s += " · vertical = " + measure + " to " + letters[0] + ", exact";
    else s += " · turning until vertical = " + measure + " to " + letters[0];
    var share = Math.round((fit.share || 0) * 100) + "%";
    if (fit.count === 1) {
      s += " · the other two axes tumble through " + fit.subspace + " directions holding " + share + " of the remaining spread";
    } else if (fit.count === 2) {
      s += " · the plane of " + letters[0] + " and " + letters[1] + " is shown exactly";
      s += " · depth tumbles through " + fit.subspace + " directions holding " + share + " of the remaining spread";
    } else {
      s += " · all three axes are pinned: the space of " + joinLetters(letters) + " is shown exactly";
      s += " · nothing tumbles";
    }
    for (var dd of fit.dropped) s += " · " + turn.list[dd.index].letter + " pins no axis";
    return s;
  }

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options?.[k] === undefined ? DEFAULTS[k] : options[k];

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
      face: face,
      searchChanged: searchChanged,
      setRelative: setRelative,
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
    // Fitted tours in switch-time order: { tour, al (alignment or null), t0, share, count,
    // zb (the zoom basis over the tour's directions, M.zoomWith) }.
    // The first has t0 = -Infinity; a refit adds one at its switch time T.
    var tours = [];
    var pending = null; // a finished refit whose switch time is not fixed yet
    var refitRunning = false;
    var requestedAt = null; // the switch time given to refit(t)
    var progress = 0;
    var hold = null;
    var out = null;
    // Each enter() and leave() starts a new generation, and each refit() a new refit
    // generation. A stepper left over from an earlier one (a preparation or refit
    // abandoned midway) does nothing if it is pumped later: it reports done and
    // touches no state, so it can never make the instance ready on old data.
    var gen = 0;
    var refitGen = 0;
    var swings = null; // the swings toward the searches (M.makeSwings)
    // The relative setting. The settings and the searches are kept across enter();
    // the events and fits belong to one entry.
    var relOn = false;
    var showOrigin = false;
    var queries = []; // the searches last given to searchChanged: [{ letter, query }]
    // Relative events in time order: { t0, afterSwings, turn, framing, info }.
    // turn: { t0, tour (null: back to the plain tour), fit, list, set, blend,
    // duration, mixFrom, mixTo }; framing: { t0, duration, centre, zoom (shown at
    // t0), target (null: the plain framing) }. A Show the origin change adds an
    // event that shares the turn in force and starts a new framing.
    var relEvents = [];
    var relPending = null; // a relative fit started and not yet switched in: { list, set, fit }
    var relFits = []; // finished fits kept for reuse on the same set: { set, list, fit }
    var relGen = 0; // a fit of an earlier call that is pumped later does nothing

    function enter(s, opts) {
      M.requireDimension(s, 3, "Tumble");
      var o = opts || {};
      gen++;
      refitGen++;
      relGen++;
      relEvents = [];
      relPending = null;
      relFits = [];
      if (queries.some((q) => q.query.length !== s.dimension)) queries = [];
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
      swings = M.makeSwings(D, seed);
      self.time = 0;
      self.varianceShare = null;
      hold = entry ? entry.frame : M.startFrame(D, seed);
      out = {
        t: 0,
        frame: new Float32Array(3 * D),
        centre: new Float32Array(D),
        draw: null,
        wires: null,
        status: "",
        focus: null,
        relative: null,
      };
    }

    // The fit, in small units: centring (ET.math.makeCentre), then the
    // principal directions and the tour (ET.math.makeGuidedTour), each pumped
    // one unit (about a millisecond) per run(). The tour is bit-identical to
    // the blocking ET.math.guidedTour on the same data and seed. Last, the zoom
    // basis over the tour's directions (and, with `extra`, three more rows: the
    // entry frame the first seconds blend from), so that framing a frame of the
    // tour does not cost a pass over the sample in full dimension on every frame.
    function fit(onDone, live, extra) {
      var fitSet = null;
      var cen = null;
      var tourSt = null;
      var tour = null;
      var zoomJob = null;
      var extended = false;
      return [
        {
          required: true,
          weight: 1,
          progress: function () {
            return cen ? cen.progress : 0;
          },
          run: function () {
            if (!live()) return true;
            if (!cen) {
              fitSet = set;
              cen = ET.math.makeCentre(fitSet.vectors, fitSet.count, D);
            }
            return cen.step(0);
          },
        },
        {
          required: true,
          weight: 8,
          progress: function () {
            return tourSt ? tourSt.progress : 0;
          },
          run: function () {
            if (!live()) return true;
            var rows = fitSet.count > opt.fitRows ? opt.fitRows : undefined;
            if (!tourSt) {
              tourSt = ET.math.makeGuidedTour(cen.result.data, fitSet.count, D, {
                seed: seed,
                subspace: opt.subspace,
                speed: opt.speed,
                sampleRows: rows,
                pca: M.fittedDirections(fitSet, seed, opt.subspace, rows),
              });
            }
            if (!tourSt.step(0)) return false;
            tour = tourSt.result;
            M.keepDirections(fitSet, seed, opt.subspace, rows, tour.pca);
            cen = null; // the centred copy is not kept
            tourSt = null;
            return true;
          },
        },
        {
          required: true,
          weight: 0.5,
          progress: function () {
            if (!zoomJob) return 0;
            return extra && !extended ? zoomJob.progress() * 0.7 : zoomJob.progress();
          },
          run: function () {
            if (!live()) return true;
            if (!zoomJob) zoomJob = M.zoomBasisJob(fitSet.vectors, fitSet.count, D, tour.basis, tour.subspace, opt.zoomSample);
            if (!zoomJob.run()) return false;
            if (extra && !extended) {
              extended = true;
              zoomJob = M.zoomExtendJob(zoomJob.result, fitSet.vectors, extra, 3);
              return false;
            }
            onDone(tour, fitSet.count, zoomJob.result);
            return true;
          },
        },
      ];
    }

    function tracked(stp, live) {
      var inner = stp.step;
      stp.step = function (budget) {
        var r = inner(budget);
        if (live()) progress = stp.progress;
        return r;
      };
      return stp;
    }

    // A test of whether the generation `g` is still the current one.
    function liveFor(g) {
      return function () {
        return g === gen;
      };
    }

    function prepare() {
      var live = liveFor(gen);
      if (empty) {
        return M.stepper([
          {
            required: true,
            run: function () {
              if (live()) emptyReady = true;
              return true;
            },
          },
        ]);
      }
      var job = M.statsJob(set);
      var tasks = [
        {
          required: true,
          weight: 1,
          progress: job.progress,
          run: function () {
            if (!live()) return true;
            if (!job.run()) return false;
            st = job.result;
            var start = entry?.centre ? entry.centre : st.mean;
            glide = M.makeGlide(start, st.mean, opt.centreTau, D);
            return true;
          },
        },
      ].concat(
        fit(
          function (tour, count, zb) {
            var al = entry ? M.alignment(tour.frameAt(0), entry.frame, D) : null;
            tours = [{ tour: tour, al: al, t0: -Infinity, share: tour.varianceShare, count: count, zb: zb }];
            self.varianceShare = tour.varianceShare;
          },
          live,
          entry ? entry.frame : null,
        ),
      );
      return tracked(M.stepper(tasks), live);
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

    // The frame before the entry blend: the active tour, turned onto from the
    // previous one during a refit's blend.
    function innerFrame(t, res) {
      var i = activeIndex(t);
      var cur = tours[i];
      tourFrame(cur, t, res);
      if (cur.blend && t - cur.t0 < cur.blend.duration) {
        applyRefitBlend(cur.blend, 1 - refitEase((t - cur.t0) / cur.blend.duration), res, D);
      }
      return res;
    }

    function frameAt(t, res) {
      innerFrame(t, res);
      if (entry && t < opt.transition) {
        ET.math.blendFrames(entry.frame, res, ET.math.smoothstep(t / opt.transition), D, res);
      }
      return res;
    }

    function lastSwitch() {
      return tours.length ? tours.at(-1).t0 : -Infinity;
    }

    // Fix a finished refit's switch time. Never earlier than the last switch,
    // so the past already fixed is never rewritten.
    function fixSwitch(T) {
      var t0 = Math.max(T, lastSwitch());
      var shown = innerFrame(t0, new Float32Array(3 * D));
      var al = M.alignment(pending.tour.frameAt(t0), shown, D);
      var next = {
        tour: pending.tour,
        al: al,
        t0: t0,
        share: pending.tour.varianceShare,
        count: pending.count,
        zb: pending.zb,
        blend: null,
      };
      var start = tourFrame(next, t0, new Float32Array(3 * D));
      next.blend = makeRefitBlend(shown, start, D);
      next.blend.duration = refitDuration(next.blend, pending.tour, t0);
      tours.push(next);
      self.varianceShare = pending.tour.varianceShare;
      pending = null;
      refitRunning = false;
      requestedAt = null;
    }

    // How long the turn onto a refitted tour takes. With "auto": long enough
    // that the turn adds at most REFIT_EXTRA times the tour's own mean rate of
    // change at its fastest (so the frame never changes much faster than in
    // normal running), within [refitTransitionMin, refitTransitionMax].
    // A pure function of the blend (the frame shown at the switch and the new
    // tour's start), the new tour and the switch time: tourRate reads only the
    // new tour's closed form, so a later refit cannot change it.
    function refitDuration(bl, tour, t0) {
      if (typeof opt.refitTransition === "number" && opt.refitTransition > 0) return opt.refitTransition;
      var lo = opt.refitTransitionMin;
      var hi = Math.max(lo, opt.refitTransitionMax);
      var v = tourRate(tour, t0);
      var need = v > 0 ? (REFIT_PEAK * bl.rate) / (REFIT_EXTRA * v) : hi;
      // Not Math.min(hi, Math.max(lo, need)): a NaN refitTransitionMin keeps `need` here.
      if (need < lo) return lo;
      if (need > hi) return hi;
      return need;
    }

    // The draw parameters at t. `zoom` is the zoom when the caller has it (a
    // swing sets its own); otherwise the frame is framed through the active
    // tour's zoom basis (M.zoomWith: autoZoom's answer, in the tour's span).
    function drawFor(frame, centre, t, zoom) {
      var sc = st.radius / M.REFERENCE_RADIUS;
      var zb = tours[activeIndex(t)].zb;
      var draw = {
        zoom: zoom === undefined ? M.zoomWith(zb, set.vectors, set.count, D, frame, centre, opt.zoomSample) : zoom,
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
      if (!isReady() || empty) {
        M.holdState(out, hold, entry, t, status(t));
        out.relative = relInfo(t);
        return out;
      }
      if (pending) fixSwitch(t); // no time was given: the first query fixes it
      if (relPending?.fit) fixRelative(t); // likewise for a finished relative fit
      out.t = t;
      out.draw = composeState(t, out.frame, out.centre);
      out.wires = null;
      out.focus = null;
      out.status = status(t);
      out.relative = relInfo(t);
      return out;
    }

    // The frame and centre at t written into `frame` and `centre`; returns the
    // draw parameters. With no relative event this is plain Tumble's state, the
    // same arithmetic in the same order: a swing, or the tour (with the turn
    // back after a swing), the glide and the auto zoom.
    function composeState(t, frame, centre) {
      var ev = relAt(t);
      var sw = swingAt(t, ev);
      if (sw && t < sw.U) {
        var zoom = M.swingState(sw, t, frame, centre);
        var draw = drawFor(frame, centre, t, zoom);
        draw.zoom = zoom;
        return draw;
      }
      viewFrame(t, ev, frame);
      if (sw) released(sw, t, frame);
      var dr = viewDraw(t, ev, frame, centre);
      if (sw) dr.zoom = M.releaseCentreZoom(M.swingEnd(sw), M.swingRelease(sw, t, opt.transition), centre, dr.zoom);
      return dr;
    }

    // ----- relative events -----

    function lastRelT() {
      return relEvents.length ? relEvents.at(-1).t0 : -Infinity;
    }

    function lastSwingT() {
      return swings?.list.length ? swings.list.at(-1).T : -Infinity;
    }

    // The latest relative event at or before t (on a tie the later one), or null.
    function relAt(t) {
      for (var i = relEvents.length - 1; i >= 0; i--) if (relEvents[i].t0 <= t) return relEvents[i];
      return null;
    }

    // The turn in force (the newest event's), or null before any event.
    function heading() {
      return relEvents.length ? relEvents.at(-1).turn : null;
    }

    // The swing that applies at t: the latest one started by t, unless a relative
    // event came after it (a switch starts from the swing's frame and replaces it).
    function swingAt(t, ev) {
      var sw = swings.at(t);
      if (sw && ev && sw.index < ev.afterSwings) return null;
      return sw;
    }

    function relDuration() {
      var d = opt.relativeTransition;
      return d > 0 && Number.isFinite(d) ? d : DEFAULTS.relativeTransition;
    }

    // The frame with the relative events applied (no swing): the plain frame, or
    // the target of the turn in force (the relative tour or the plain frame),
    // turned onto from the frame shown at the turn's start.
    function viewFrame(t, ev, res) {
      if (!ev) return frameAt(t, res);
      var tr = ev.turn;
      if (tr.tour) tr.tour.frameAt(t, res);
      else frameAt(t, res);
      if (tr.blend && t - tr.t0 < tr.duration) applyRefitBlend(tr.blend, 1 - refitEase((t - tr.t0) / tr.duration), res, D);
      return res;
    }

    // How far the view is into the relative look at t (0 in the plain view).
    function mixAt(t, ev) {
      if (!ev) return 0;
      var tr = ev.turn;
      if (t - tr.t0 < tr.duration) return tr.mixFrom + (tr.mixTo - tr.mixFrom) * refitEase((t - tr.t0) / tr.duration);
      return tr.mixTo;
    }

    // The centre (written into `centre`) and the draw parameters at t for the
    // frame given: the plain glide and zoom, or the relative framing, glided
    // from the values shown at the framing's start.
    function viewDraw(t, ev, frame, centre) {
      if (!ev) {
        glide.at(t, centre);
        return drawFor(frame, centre, t);
      }
      var fr = ev.framing;
      var draw;
      if (fr.target) {
        centre.set(fr.target.centre);
        draw = drawFor(frame, centre, t, fr.target.zoom);
        draw.zoom = fr.target.zoom;
      } else {
        glide.at(t, centre);
        draw = drawFor(frame, centre, t);
      }
      if (t - fr.t0 < fr.duration) {
        var e = ET.math.smoothstep((t - fr.t0) / fr.duration);
        for (var d = 0; d < D; d++) centre[d] = fr.centre[d] + (centre[d] - fr.centre[d]) * e;
        draw.zoom = fr.zoom + (draw.zoom - fr.zoom) * e;
      }
      var mix = mixAt(t, ev);
      if (mix > 0) draw.perspective = 3 + (ET.renderer.RELATIVE_PERSPECTIVE - 3) * mix;
      return draw;
    }

    // The centre and zoom that frame the ruler's window along the vertical search.
    function framingTarget(fit) {
      var w = fit.window;
      var top = w.high + RELATIVE_MARGIN;
      var bottom = w.low - RELATIVE_MARGIN;
      if (showOrigin) {
        bottom = Math.min(bottom, -RELATIVE_ORIGIN_MARGIN);
        top = Math.max(top, RELATIVE_ORIGIN_MARGIN);
      }
      var mid = (top + bottom) / 2;
      var c = new Float32Array(D);
      for (var d = 0; d < D; d++) c[d] = mid * fit.directions[d];
      var zoom = Math.min(RELATIVE_FILL / (top - bottom), RELATIVE_ZOOM_CAP);
      return { centre: c, zoom: zoom, low: w.low, high: w.high, bottom: bottom, top: top };
    }

    // The state shown at T (before any event at T is added): { frame, centre, zoom, mix }.
    function shownAt(T) {
      var frame = new Float32Array(3 * D);
      var centre = new Float32Array(D);
      var draw = composeState(T, frame, centre);
      return { frame: frame, centre: centre, zoom: draw.zoom, mix: mixAt(T, relAt(T)) };
    }

    // A switch at T (never earlier than the previous relative event or swing):
    // onto the relative tour of `fit`, or back onto the plain tour (fit null).
    function addSwitch(time, fit, list) {
      var T = Math.max(time, lastRelT(), lastSwingT());
      var shown = shownAt(T);
      swings.end(T); // a swing in progress gives way to the switch
      var tour = fit
        ? ET.math.makeRelativeTour(fit.directions, fit.count, fit.basis, fit.subspace, D, { seed: seed, speed: opt.speed })
        : null;
      var start = tour ? tour.frameAt(T) : frameAt(T, new Float32Array(3 * D));
      // Already on the new frame (a search that adds no axis): nothing turns.
      var still = sameBits(shown.frame, start);
      var turn = {
        t0: T,
        tour: tour,
        fit: fit,
        list: list,
        set: set,
        blend: still ? null : makeRefitBlend(shown.frame, start, D),
        duration: still ? 0 : relDuration(),
        mixFrom: shown.mix,
        mixTo: tour ? 1 : 0,
      };
      relEvents.push({
        t0: T,
        afterSwings: swings.list.length,
        turn: turn,
        framing: { t0: T, duration: relDuration(), centre: shown.centre, zoom: shown.zoom, target: tour ? framingTarget(fit) : null },
        info: null,
      });
    }

    // Show the origin changed while the relative view is in force: the centre and
    // zoom glide from the values shown at T to the new framing; no fit, no turn.
    function addFraming(time) {
      var T = Math.max(time, lastRelT(), lastSwingT());
      var shown = shownAt(T);
      var turn = heading();
      relEvents.push({
        t0: T,
        afterSwings: swings.list.length,
        turn: turn,
        framing: { t0: T, duration: relDuration(), centre: shown.centre, zoom: shown.zoom, target: framingTarget(turn.fit) },
        info: null,
      });
    }

    function fixRelative(time) {
      var p = relPending;
      relPending = null;
      addSwitch(time, p.fit, p.list);
    }

    function cancelRelative() {
      relGen++;
      relPending = null;
    }

    function keptFit(list) {
      for (var k of relFits) if (k.set === set && sameQueries(k.list, list, false)) return k.fit;
      return null;
    }

    function keepFit(fitSet, list, fit) {
      relFits.push({ set: fitSet, list: list, fit: fit });
      if (relFits.length > 4) relFits.shift();
    }

    // A relative fit of `list` on the current set, as a stepper (one unit of
    // ET.math.makeRelativeFit per run). When it is done the switch waits for its
    // time (mark, or the first stateAt).
    function startFit(list) {
      relGen++;
      var g = gen;
      var rg = relGen;
      var fitSet = set;
      var p = { list: list, set: fitSet, fit: null };
      var job = null;
      relPending = p;
      return M.stepper([
        {
          required: true,
          weight: 1,
          progress: function () {
            return job ? job.progress : 0;
          },
          run: function () {
            if (g !== gen || rg !== relGen) return true;
            if (!job) {
              var qs = list.map(function (q) {
                return q.query;
              });
              job = ET.math.makeRelativeFit(fitSet.vectors, fitSet.count, D, qs, {
                seed: seed,
                subspace: opt.subspace,
                sampleRows: opt.fitRows,
              });
            }
            if (!job.step(0)) return false;
            p.fit = job.result;
            keepFit(fitSet, list, job.result);
            return true;
          },
        },
      ]);
    }

    // Bring what is shown in line with the setting, the searches and the set:
    // start a fit (returned as a stepper), switch now (a fit kept for the same
    // searches on the same set, or turning off), or nothing.
    function reconcile(t) {
      var h = heading();
      var shownFit = h ? h.fit : null;
      var dirs = relOn && set && !empty ? ET.math.relativeDirections(queries.map((q) => q.query), D) : null;
      if (!dirs?.count) {
        if (relPending) cancelRelative();
        if (shownFit) addSwitch(t, null, null);
        return null;
      }
      if (relPending?.set === set && sameQueries(relPending.list, queries, true)) return null;
      if (relPending) cancelRelative();
      if (shownFit && h.set === set && sameQueries(h.list, queries, true)) return null;
      var kept = keptFit(queries);
      if (kept) {
        relPending = { list: queries, set: set, fit: kept };
        if (isReady()) fixRelative(t);
        return null;
      }
      return startFit(queries);
    }

    // inst.searchChanged(search, t): only the letters and the query vectors are
    // read. With the setting off the searches are stored and nothing changes.
    function searchChanged(search, time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      var list = set ? readQueries(search, D) : [];
      var same = sameQueries(list, queries, true);
      queries = list;
      if (!relOn || same) return null;
      return reconcile(t);
    }

    // inst.setRelative({ relative?, showOrigin? }, t): a missing key keeps its value.
    function setRelative(settings, time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      var s = settings || {};
      var wasOrigin = showOrigin;
      if (typeof s.relative === "boolean") relOn = s.relative;
      if (typeof s.showOrigin === "boolean") showOrigin = s.showOrigin;
      var before = relEvents.length;
      var work = reconcile(t);
      var h = heading();
      if (showOrigin !== wasOrigin && relEvents.length === before && h?.fit) addFraming(t);
      return work;
    }

    // state.relative at t (docs/relative-interface.md): null in the plain view
    // with the setting off.
    function relInfo(t) {
      var ev = isReady() && !empty ? relAt(t) : null;
      var tr = ev ? ev.turn : null;
      var turning = !!tr && t - tr.t0 < tr.duration;
      var mix = mixAt(t, ev);
      if (!tr?.fit) {
        if (!relOn && !turning) return null;
        return {
          relative: relOn,
          showOrigin: showOrigin,
          active: false,
          settled: false,
          mix: mix,
          pinned: [],
          dropped: [],
          measure: null,
          unit: null,
          window: null,
          share: null,
          subspace: 0,
          free: 3,
          fixed: 0,
        };
      }
      if (!ev.info) ev.info = eventInfo(tr, ev.framing.target);
      var i = ev.info;
      return {
        relative: relOn,
        showOrigin: showOrigin,
        active: true,
        settled: !turning,
        mix: mix,
        pinned: i.pinned,
        dropped: i.dropped,
        measure: i.measure,
        unit: i.unit,
        window: i.window,
        share: i.share,
        subspace: i.subspace,
        free: i.free,
        fixed: i.fixed,
      };
    }

    // The parts of state.relative that stay the same for an event.
    function eventInfo(tr, target) {
      var fit = tr.fit;
      var letterOf = function (j) {
        return tr.list[j].letter;
      };
      return {
        pinned: fit.pinned.map(function (p, k) {
          return { letter: letterOf(p.index), axis: RELATIVE_AXES[k], length: p.length };
        }),
        dropped: fit.dropped.map(function (dd) {
          return { letter: letterOf(dd.index), reason: dd.reason, against: dd.against.map(letterOf) };
        }),
        measure: fit.unit.unit ? "cosine" : "length along the search",
        unit: { unit: fit.unit.unit, min: fit.unit.min, max: fit.unit.max, tolerance: fit.unit.tolerance },
        window: { low: target.low, high: target.high, bottom: target.bottom, top: target.top },
        share: fit.share,
        subspace: fit.subspace,
        free: 3 - fit.count,
        fixed: fit.fixed,
      };
    }

    // After a swing ends at U, Tumble turns back onto its tour from the frame
    // shown at U the way it turns onto a refitted tour: the tour's axes are
    // relabelled (order and sign) to match that frame, and a fixed rotation that
    // takes the tour's frame at U to the frame shown unwinds along refitEase over
    // a length chosen as for a refit ("auto": the turn adds at most half the
    // tour's mean rate). A blend over `transition` seconds, as on entry, turned up
    // to five times faster than the tour moves (measured). The centre and zoom
    // come back over `transition` (stateAt).
    function released(sw, t, frame) {
      var c = sw.cache;
      if (!c.turn) {
        var end = M.swingEnd(sw);
        var raw = viewFrame(sw.U, relAt(sw.U), new Float32Array(3 * D));
        c.al = M.alignment(raw, end.frame, D);
        var start = M.applyAlignment(raw, c.al, D);
        c.turn = makeRefitBlend(end.frame, start, D);
        c.turn.duration = refitDuration(c.turn, tours[activeIndex(sw.U)].tour, sw.U);
      }
      M.applyAlignment(new Float32Array(frame), c.al, D, frame);
      var u = (t - sw.U) / c.turn.duration;
      if (u < 1) applyRefitBlend(c.turn, 1 - refitEase(u), frame, D);
    }

    // The swing toward the searches (js/api/40-modes.md, "Facing the searches").
    // face(null, t) ends a swing in progress at t. With the relative view shown,
    // or a switch to it waiting, it starts nothing and returns false.
    function face(target, time, options) {
      if (!isReady() || empty) return false;
      if (target === null) return swings.end(time);
      if (relPending) return false;
      if (relEvents.length) {
        if (heading().fit) return false;
        time = Math.max(M.checkTime(time), lastRelT()); // a swing never starts before a switch
      }
      return swings.face(target, time, options, function (T) {
        var s = stateAt(T);
        return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), zoom: s.draw.zoom };
      });
    }

    function step(dt) {
      self.time = Math.max(0, self.time + dt);
      return stateAt(self.time);
    }

    function status(time) {
      var t = M.checkTime(time === undefined ? self.time : time);
      if (empty) return M.EMPTY_STATUS;
      if (!isReady()) return "finding the strongest directions in " + D + "-d … " + Math.round(progress * 100) + "%";
      var ev = relAt(t);
      if (ev?.turn.fit) return relativeStatus(ev.turn, t - ev.turn.t0 >= ev.turn.duration);
      var sw = swingAt(t, ev);
      if (sw && t < sw.U) return M.swingStatus(sw, "tumbling");
      var cur = tours[activeIndex(t)];
      var s = "tour of " + cur.tour.subspace + " strongest directions · " + (cur.share * 100).toFixed(1) + "% of variance";
      var since = set.count - cur.count;
      if (since > 0) s += " · before " + M.thousands(since) + " new points";
      return s;
    }

    function snapshot(t) {
      var s = stateAt(t);
      var from = { frame: new Float32Array(s.frame), centre: null, draw: { ...s.draw } };
      if (!empty || entry?.centre) from.centre = new Float32Array(s.centre);
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
        var prep = prepare();
        // With the relative setting on, the searches are kept and fitted on the new
        // set alongside the preparation; the switch waits for its time as usual.
        var rel = reconcile(0);
        return M.changed(rel ? M.stepper([pumpTask(prep, 8), pumpTask(rel, 1)]) : prep, true);
      }
      var old = set;
      set = newSet;
      st = M.stats(newSet, old);
      glide.retarget(t, st.mean);
      // The relative view in force (or a switch to it waiting) is fitted again on
      // the new set, the searches kept, and switches in at a recorded time.
      return M.changed(relOn ? reconcile(t) : null, false);
    }

    // A stepper task that pumps another stepper one unit per run.
    function pumpTask(stp, weight) {
      return {
        required: true,
        weight: weight,
        progress: function () {
          return stp.progress;
        },
        run: function () {
          return stp.step(0);
        },
      };
    }

    // Fit the directions again on the current data. Returns a stepper. The
    // switch to the new tour happens at time `t` when given (never earlier than
    // a previous switch); otherwise at mark(t) or the first stateAt after the
    // stepper is done. From the switch it turns onto the new tour over the
    // refit turn's duration (refitDuration). A stepper from an earlier refit()
    // or entry does nothing.
    function refit(t) {
      if (empty || !isReady()) return prepare();
      refitRunning = true;
      requestedAt = t === undefined ? null : M.checkTime(t);
      refitGen++;
      var g = gen;
      var rg = refitGen;
      return M.stepper(
        fit(
          function (tour, count, zb) {
            pending = { tour: tour, count: count, zb: zb };
            if (requestedAt !== null) fixSwitch(requestedAt);
          },
          function () {
            return g === gen && rg === refitGen;
          },
        ),
      );
    }

    // Fix the time of a finished event (a refit waiting for its switch).
    function mark(time) {
      if (pending) fixSwitch(M.checkTime(time));
      if (relPending?.fit && isReady() && !empty) fixRelative(M.checkTime(time));
    }

    // describe().relative (docs/relative-interface.md).
    function describeRelative() {
      var switchAt = relEvents.length ? relEvents.at(-1).t0 : null;
      var info = relInfo(self.time);
      if (!info) return { relative: false, showOrigin: showOrigin, active: false, switchAt: switchAt, pending: false };
      info.switchAt = switchAt;
      info.pending = relPending !== null;
      info.transition = relDuration();
      return info;
    }

    function describe() {
      var last = tours.length ? tours.at(-1) : null;
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
        fittedRows: last?.tour.pca ? last.tour.pca.sampledRows : 0,
        method: last?.tour.pca ? last.tour.pca.method : null,
        refitAt: last?.t0 > -Infinity ? last.t0 : null,
        refitTransition: last?.blend ? last.blend.duration : null,
        refitPending: refitRunning,
        facing: swings ? swings.describe() : null,
        empty: empty,
        relative: describeRelative(),
      };
    }

    function leave() {
      gen++;
      refitGen++;
      relGen++;
      relEvents = [];
      relPending = null;
      relFits = [];
      tours = [];
      pending = null;
      set = null;
      st = null;
      glide = null;
    }

    return self;
  }

  // ----- the turn onto a refitted tour ---------------------------------------
  //
  // At the switch time T the frame shown is A (three orthonormal rows) and the
  // new tour starts at B. The turn is a fixed rotation Q of the whole space
  // with Q B = A, made of a rotation inside B's span (3 x 3, Z) and rotations
  // in mutually orthogonal planes taking B's principal vectors to A's (the
  // shortest turn between the two spans). During the blend the frame is
  // Q(s) applied to the new tour's moving frame, with s going from 1 to 0
  // along refitEase: the tour moves at its own rate (a rotation does not change
  // it) and the turn adds a rate that the duration keeps small. Q(s) is a
  // rotation for every s, so the frame stays orthonormal and never folds.

  var REFIT_RAMP = 0.25; // refitEase speeds up over the first quarter and slows down over the last
  var REFIT_PEAK = 1 / (1 - REFIT_RAMP); // refitEase's largest slope
  var REFIT_EXTRA = 0.5; // the turn adds at most this share of the tour's mean rate
  var REFIT_TINY = 1e-6; // angles (radians) and off-span parts below this do not turn

  // Progress 0..1 with an even rate in the middle and smooth ends.
  function refitEase(u) {
    var x = Math.min(1, Math.max(0, u));
    var a = REFIT_RAMP;
    if (x > 1 - a) return 1 - refitEase(1 - x);
    if (x < a) {
      var y = x / a;
      return REFIT_PEAK * a * (y * y * y - (y * y * y * y) / 2);
    }
    return REFIT_PEAK * (a / 2 + x - a);
  }

  function dotRows(P, i, Q, j, D) {
    var s = 0;
    for (var d = 0; d < D; d++) s += P[i * D + d] * Q[j * D + d];
    return s;
  }

  function makeRefitBlend(A, B, D) {
    // M = A B^T (3 x 3) = U S V^T by the eigenvectors of M^T M.
    var Mt = crossDots(A, B, D);
    var V = ET.math.symmetricEigen(columnGram(Mt), 3).vectors; // row j: v_j
    var U = new Float64Array(9); // row j: u_j
    leftVector(Mt, V, U, 0);
    leftVector(Mt, V, U, 1);
    completeRotation(U, V);
    var pv = principalVectors(A, B, U, V, D);
    var turns = planeTurns(pv.Ap, pv.Bp, D);
    var span = axisAngle(spanRotation(V, U));
    var bl = { Bp: pv.Bp, Tp: turns.Tp, theta: turns.theta, K: span.K, phi: span.phi, duration: 0, rate: 0 };
    bl.rate = blendRate(bl, B, D);
    return bl;
  }

  // M = A B^T as 3 x 3, row-major: M[i][j] = A_i . B_j.
  function crossDots(A, B, D) {
    var Mt = new Float64Array(9);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) Mt[i * 3 + j] = dotRows(A, i, B, j, D);
    return Mt;
  }

  // M^T M (3 x 3).
  function columnGram(Mt) {
    var MtM = new Float64Array(9);
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        var s0 = 0;
        for (var k = 0; k < 3; k++) s0 += Mt[k * 3 + a] * Mt[k * 3 + b];
        MtM[a * 3 + b] = s0;
      }
    }
    return MtM;
  }

  // Row jj (0 or 1) of U: M v_jj, made orthogonal to u_0 (row 1) and normalised.
  function leftVector(Mt, V, U, jj) {
    var n = 0;
    for (var r = 0; r < 3; r++) {
      var x = 0;
      for (var c = 0; c < 3; c++) x += Mt[r * 3 + c] * V[jj * 3 + c];
      U[jj * 3 + r] = x;
    }
    if (jj === 1) {
      var dp = U[3] * U[0] + U[4] * U[1] + U[5] * U[2];
      for (var r1 = 0; r1 < 3; r1++) U[3 + r1] -= dp * U[r1];
    }
    for (var r2 = 0; r2 < 3; r2++) n += U[jj * 3 + r2] * U[jj * 3 + r2];
    if (n > 1e-18) {
      n = Math.sqrt(n);
      for (var r3 = 0; r3 < 3; r3++) U[jj * 3 + r3] /= n;
    } else {
      fallbackLeftVector(U, jj);
    }
  }

  // M has (almost) no part along v_jj: any unit vector orthogonal to the earlier ones.
  function fallbackLeftVector(U, jj) {
    var best = leastCoveredAxis(U, jj);
    for (var r4 = 0; r4 < 3; r4++) U[jj * 3 + r4] = r4 === best ? 1 : 0;
    if (jj === 1) orthonormaliseSecondRow(U);
  }

  // The standard axis least covered by u_0 (axis 0 for row 0).
  function leastCoveredAxis(U, jj) {
    var best = 0;
    var bestCover = Infinity;
    for (var e = 0; e < 3; e++) {
      var cover = jj === 0 ? 0 : Math.abs(U[e]);
      if (cover < bestCover) {
        bestCover = cover;
        best = e;
      }
    }
    return best;
  }

  // Row 1 of U made orthogonal to row 0, then unit length.
  function orthonormaliseSecondRow(U) {
    var dp2 = U[3] * U[0] + U[4] * U[1] + U[5] * U[2];
    var n2 = 0;
    for (var r5 = 0; r5 < 3; r5++) {
      U[3 + r5] -= dp2 * U[r5];
      n2 += U[3 + r5] * U[3 + r5];
    }
    n2 = Math.sqrt(n2);
    for (var r6 = 0; r6 < 3; r6++) U[3 + r6] /= n2;
  }

  // u_2 completes U so that Z = V^T U is a rotation (det +1).
  function completeRotation(U, V) {
    var detV =
      V[0] * (V[4] * V[8] - V[5] * V[7]) - V[1] * (V[3] * V[8] - V[5] * V[6]) + V[2] * (V[3] * V[7] - V[4] * V[6]);
    var sg = detV < 0 ? -1 : 1;
    U[6] = sg * (U[1] * U[5] - U[2] * U[4]);
    U[7] = sg * (U[2] * U[3] - U[0] * U[5]);
    U[8] = sg * (U[0] * U[4] - U[1] * U[3]);
  }

  // Principal vectors B'_j = sum_k v_j[k] B_k and A'_j = sum_k u_j[k] A_k.
  function principalVectors(A, B, U, V, D) {
    var Bp = new Float64Array(3 * D);
    var Ap = new Float64Array(3 * D);
    for (var j2 = 0; j2 < 3; j2++) {
      for (var k2 = 0; k2 < 3; k2++) {
        var wv = V[j2 * 3 + k2];
        var wu = U[j2 * 3 + k2];
        for (var d = 0; d < D; d++) {
          Bp[j2 * D + d] += wv * B[k2 * D + d];
          Ap[j2 * D + d] += wu * A[k2 * D + d];
        }
      }
    }
    return { Bp: Bp, Ap: Ap };
  }

  // Plane j turns B'_j toward T_j by theta_j, ending at A'_j. T_j is the part
  // of A'_j off B's span, so it is made orthogonal to all three B'_k (in exact
  // arithmetic it already is). When that part is below REFIT_TINY (float32
  // frames carry noise near 1e-7) the plane does not turn: dividing by it would
  // only blow noise up into a direction. The one exception is a reversed
  // principal vector (A'_j = -B'_j, a half turn), which turns through a
  // direction off B's span and off the planes before it; with no room for one
  // (D = 3) it is left as it is.
  function planeTurns(Ap, Bp, D) {
    var Tp = new Float64Array(3 * D);
    var theta = new Float64Array(3);
    for (var j3 = 0; j3 < 3; j3++) theta[j3] = planeTurn(Ap, Bp, Tp, j3, D);
    return { Tp: Tp, theta: theta };
  }

  // Plane j's direction (written into row j of Tp) and angle.
  function planeTurn(Ap, Bp, Tp, j3, D) {
    var cth = dotRows(Ap, j3, Bp, j3, D);
    for (var d2 = 0; d2 < D; d2++) Tp[j3 * D + d2] = Ap[j3 * D + d2];
    var nn = offSpan(Tp, j3, Bp, Tp, 0, D);
    if (nn > REFIT_TINY) {
      for (var d3 = 0; d3 < D; d3++) Tp[j3 * D + d3] /= nn;
      return Math.atan2(nn, cth);
    }
    if (cth < 0 && halfTurnDirection(Tp, j3, Bp, D)) return Math.PI;
    for (var d4 = 0; d4 < D; d4++) Tp[j3 * D + d4] = 0;
    return 0;
  }

  // Z = V^T U: Z[i][j] = v_i . u_j.
  function spanRotation(V, U) {
    var Z = new Float64Array(9);
    for (var zi = 0; zi < 3; zi++) {
      for (var zj = 0; zj < 3; zj++) {
        Z[zi * 3 + zj] = V[zi * 3] * U[zj * 3] + V[zi * 3 + 1] * U[zj * 3 + 1] + V[zi * 3 + 2] * U[zj * 3 + 2];
      }
    }
    return Z;
  }

  // Z as an axis and angle (Z = exp(phi K)): { K, phi }, with phi 0 and K zero
  // when there is no turn inside the span.
  function axisAngle(Z) {
    var cphi = (Z[0] + Z[4] + Z[8] - 1) / 2;
    var phi = Math.acos(Math.max(-1, Math.min(1, cphi)));
    var K = new Float64Array(9);
    var axis = turnAxis(Z, phi);
    if (axis) {
      K[1] = -axis[2];
      K[2] = axis[1];
      K[3] = axis[2];
      K[5] = -axis[0];
      K[6] = -axis[1];
      K[7] = axis[0];
    } else {
      phi = 0;
    }
    return { K: K, phi: phi };
  }

  // Below REFIT_TINY there is no turn inside the span (its axis would be noise):
  // null. A small sine with a large angle is a half turn, found from Z + I.
  function turnAxis(Z, phi) {
    var sphi = Math.sin(phi);
    if (phi > REFIT_TINY && sphi > 1e-6) {
      return [(Z[7] - Z[5]) / (2 * sphi), (Z[2] - Z[6]) / (2 * sphi), (Z[3] - Z[1]) / (2 * sphi)];
    }
    if (phi > Math.PI / 2) return halfTurnAxis(Z);
    return null;
  }

  // A half turn: Z + I = 2 n n^T.
  function halfTurnAxis(Z) {
    var bi = 0;
    for (var q = 1; q < 3; q++) if (Z[q * 4] > Z[bi * 4]) bi = q;
    var len = Math.sqrt(Math.max((Z[bi * 4] + 1) / 2, 1e-300));
    var axis = [0, 0, 0];
    for (var q2 = 0; q2 < 3; q2++) axis[q2] = (Z[q2 * 3 + bi] + (q2 === bi ? 1 : 0)) / (4 * len);
    return axis;
  }

  // Row j of T made orthogonal (twice) to the three rows of B and to rows 0..k-1
  // of P; returns the remaining length.
  function offSpan(T, j, B, P, k, D) {
    var o = j * D;
    for (var pass = 0; pass < 2; pass++) {
      for (var r = 0; r < 3 + k; r++) {
        if (r < 3) removeComponent(T, o, B, r * D, D);
        else removeComponent(T, o, P, (r - 3) * D, D);
      }
    }
    var n = 0;
    for (var d3 = 0; d3 < D; d3++) n += T[o + d3] * T[o + d3];
    return Math.sqrt(n);
  }

  // The row of T at offset o minus its component along the row of R at offset orr.
  function removeComponent(T, o, R, orr, D) {
    var dp = 0;
    for (var d = 0; d < D; d++) dp += T[o + d] * R[orr + d];
    for (var d2 = 0; d2 < D; d2++) T[o + d2] -= dp * R[orr + d2];
  }

  // A unit direction for a half turn of plane j: the standard basis vector that
  // keeps most of its length off B's span and off the plane directions before j
  // (lowest index on a tie), written into row j of Tp. False when there is none.
  function halfTurnDirection(Tp, j, Bp, D) {
    var best = -1;
    var bestLen = 1e-3; // with room, the best keeps at least sqrt((D - 3 - j) / D)
    for (var e = 0; e < D; e++) {
      for (var d = 0; d < D; d++) Tp[j * D + d] = d === e ? 1 : 0;
      var len = offSpan(Tp, j, Bp, Tp, j, D);
      if (len > bestLen) {
        bestLen = len;
        best = e;
      }
    }
    if (best < 0) return false;
    for (var d2 = 0; d2 < D; d2++) Tp[j * D + d2] = d2 === best ? 1 : 0;
    var n = offSpan(Tp, j, Bp, Tp, j, D);
    for (var d3 = 0; d3 < D; d3++) Tp[j * D + d3] /= n;
    return true;
  }

  // Q(s) applied to the rows of F, in place. The turned rows are orthonormalised
  // once, in double precision, before they are stored: a second pass on the
  // stored float32 rows changes no entry by more than about 1e-7 (tested).
  function applyRefitBlend(bl, s, F, D) {
    var x = new Float64Array(3 * D);
    for (var i = 0; i < 3 * D; i++) x[i] = F[i];
    rotateRows(bl, s, x, D);
    ET.math.orthonormalize(x, 3, D);
    for (var i2 = 0; i2 < 3 * D; i2++) F[i2] = x[i2];
    return F;
  }

  function rotateRows(bl, s, x, D) {
    if (s === 0) return x;
    var Z = spanTurnAt(bl.K, Math.sin(s * bl.phi), 1 - Math.cos(s * bl.phi));
    for (var r = 0; r < 3; r++) {
      var o = r * D;
      turnRowInSpan(x, o, bl.Bp, Z, D);
      turnRowInPlanes(x, o, bl, s, D);
    }
    return x;
  }

  // The turn inside B's span at this point of the blend: I + sn K + cm K^2.
  function spanTurnAt(K, sn, cm) {
    var Z = new Float64Array(9);
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        var k2 = K[a * 3] * K[b] + K[a * 3 + 1] * K[3 + b] + K[a * 3 + 2] * K[6 + b];
        Z[a * 3 + b] = (a === b ? 1 : 0) + sn * K[a * 3 + b] + cm * k2;
      }
    }
    return Z;
  }

  // The row at offset o, its part in the span of Bp turned by Z.
  function turnRowInSpan(x, o, Bp, Z, D) {
    var c0 = 0;
    var c1 = 0;
    var c2 = 0;
    for (var d = 0; d < D; d++) {
      c0 += x[o + d] * Bp[d];
      c1 += x[o + d] * Bp[D + d];
      c2 += x[o + d] * Bp[2 * D + d];
    }
    var e0 = c0 * Z[0] + c1 * Z[3] + c2 * Z[6] - c0;
    var e1 = c0 * Z[1] + c1 * Z[4] + c2 * Z[7] - c1;
    var e2 = c0 * Z[2] + c1 * Z[5] + c2 * Z[8] - c2;
    for (var d2 = 0; d2 < D; d2++) x[o + d2] += e0 * Bp[d2] + e1 * Bp[D + d2] + e2 * Bp[2 * D + d2];
  }

  // The row at offset o turned in each plane (B'_j, T_j) by s * theta_j.
  function turnRowInPlanes(x, o, bl, s, D) {
    var Bp = bl.Bp;
    var Tp = bl.Tp;
    for (var j = 0; j < 3; j++) {
      var th = s * bl.theta[j];
      if (th === 0) continue;
      var oj = j * D;
      var p = 0;
      var q = 0;
      for (var d3 = 0; d3 < D; d3++) {
        p += x[o + d3] * Bp[oj + d3];
        q += x[o + d3] * Tp[oj + d3];
      }
      var cs = Math.cos(th) - 1;
      var si = Math.sin(th);
      var wb = p * cs - q * si;
      var wt = p * si + q * cs;
      for (var d4 = 0; d4 < D; d4++) x[o + d4] += wb * Bp[oj + d4] + wt * Tp[oj + d4];
    }
  }

  // How fast the turn moves the frame per unit of s (Frobenius norm of the
  // change, largest over s), measured on the new tour's starting frame B.
  function blendRate(bl, B, D) {
    var h = 1e-4;
    var worst = 0;
    var x0 = new Float64Array(3 * D);
    var x1 = new Float64Array(3 * D);
    for (var k = 0; k <= 8; k++) {
      var s0 = Math.max(0, k / 8 - h);
      var s1 = Math.min(1, k / 8 + h);
      for (var i = 0; i < 3 * D; i++) {
        x0[i] = B[i];
        x1[i] = B[i];
      }
      rotateRows(bl, s0, x0, D);
      rotateRows(bl, s1, x1, D);
      var n = 0;
      for (var i2 = 0; i2 < 3 * D; i2++) n += (x1[i2] - x0[i2]) * (x1[i2] - x0[i2]);
      var rate = Math.sqrt(n) / (s1 - s0);
      if (rate > worst) worst = rate;
    }
    return worst;
  }

  // The tour's mean rate of change (Frobenius norm per second of mode time)
  // over the 12 s from t0, sampled every half second. The frame is the
  // coefficients times an orthonormal basis, so the coefficients' rate is the
  // frame's.
  function tourRate(tour, t0) {
    var h = 1e-3;
    var m = tour.subspace;
    var a = new Float64Array(3 * m);
    var b = new Float64Array(3 * m);
    var sum = 0;
    for (var k = 0; k < 24; k++) {
      var t = t0 + k * 0.5;
      tour.coefficientsAt(t, a);
      tour.coefficientsAt(t + h, b);
      var n = 0;
      for (var i = 0; i < 3 * m; i++) n += (b[i] - a[i]) * (b[i] - a[i]);
      sum += Math.sqrt(n) / h;
    }
    return sum / 24;
  }

  // The turn's pieces, for tests and for a mode written elsewhere.
  M.refitTurn = {
    make: makeRefitBlend,
    apply: applyRefitBlend,
    ease: refitEase,
    tourRate: tourRate,
  };

  M.register({
    id: "tumble",
    title: "Tumble",
    summary: "The window turns through the strongest directions",
    create: create,
  });
})();
