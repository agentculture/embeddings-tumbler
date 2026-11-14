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
    // Each enter() and leave() starts a new generation, and each refit() a new refit
    // generation. A stepper left over from an earlier one (a preparation or refit
    // abandoned midway) does nothing if it is pumped later: it reports done and
    // touches no state, so it can never make the instance ready on old data.
    var gen = 0;
    var refitGen = 0;

    function enter(s, opts) {
      M.requireDimension(s, 3, "Tumble");
      var o = opts || {};
      gen++;
      refitGen++;
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

    // The fit, in small units: centring (ET.math.makeCentre), then the
    // principal directions and the tour (ET.math.makeGuidedTour), each pumped
    // one unit (about a millisecond) per run(). The tour is bit-identical to
    // the blocking ET.math.guidedTour on the same data and seed.
    function fit(onDone, live) {
      var fitSet = null;
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
            if (!tourSt) {
              tourSt = ET.math.makeGuidedTour(cen.result.data, fitSet.count, D, {
                seed: seed,
                subspace: opt.subspace,
                speed: opt.speed,
                sampleRows: fitSet.count > opt.fitRows ? opt.fitRows : undefined,
              });
            }
            if (!tourSt.step(0)) return false;
            var tour = tourSt.result;
            cen = null; // the centred copy is not kept
            tourSt = null;
            onDone(tour, fitSet.count);
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
        }, live),
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
      return tours.length ? tours[tours.length - 1].t0 : -Infinity;
    }

    // Fix a finished refit's switch time. Never earlier than the last switch,
    // so the past already fixed is never rewritten.
    function fixSwitch(T) {
      var t0 = Math.max(T, lastSwitch());
      var shown = innerFrame(t0, new Float32Array(3 * D));
      var al = M.alignment(pending.tour.frameAt(t0), shown, D);
      var next = { tour: pending.tour, al: al, t0: t0, share: pending.tour.varianceShare, count: pending.count, blend: null };
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
      return need < lo ? lo : need > hi ? hi : need;
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
          function (tour, count) {
            pending = { tour: tour, count: count };
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
        refitTransition: last && last.blend ? last.blend.duration : null,
        refitPending: refitRunning,
        empty: empty,
      };
    }

    function leave() {
      gen++;
      refitGen++;
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
    var x = u <= 0 ? 0 : u >= 1 ? 1 : u;
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
    var Mt = new Float64Array(9);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) Mt[i * 3 + j] = dotRows(A, i, B, j, D);
    var MtM = new Float64Array(9);
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        var s0 = 0;
        for (var k = 0; k < 3; k++) s0 += Mt[k * 3 + a] * Mt[k * 3 + b];
        MtM[a * 3 + b] = s0;
      }
    }
    var V = ET.math.symmetricEigen(MtM, 3).vectors; // row j: v_j
    var U = new Float64Array(9); // row j: u_j
    for (var jj = 0; jj < 2; jj++) {
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
        // M has (almost) no part here: any unit vector orthogonal to the earlier ones
        var best = 0;
        var bestCover = Infinity;
        for (var e = 0; e < 3; e++) {
          var cover = jj === 0 ? 0 : Math.abs(U[e]);
          if (cover < bestCover) {
            bestCover = cover;
            best = e;
          }
        }
        for (var r4 = 0; r4 < 3; r4++) U[jj * 3 + r4] = r4 === best ? 1 : 0;
        if (jj === 1) {
          var dp2 = U[3] * U[0] + U[4] * U[1] + U[5] * U[2];
          var n2 = 0;
          for (var r5 = 0; r5 < 3; r5++) {
            U[3 + r5] -= dp2 * U[r5];
            n2 += U[3 + r5] * U[3 + r5];
          }
          n2 = Math.sqrt(n2);
          for (var r6 = 0; r6 < 3; r6++) U[3 + r6] /= n2;
        }
      }
    }
    // u_2 completes U so that Z = V^T U is a rotation (det +1).
    var detV =
      V[0] * (V[4] * V[8] - V[5] * V[7]) - V[1] * (V[3] * V[8] - V[5] * V[6]) + V[2] * (V[3] * V[7] - V[4] * V[6]);
    var sg = detV < 0 ? -1 : 1;
    U[6] = sg * (U[1] * U[5] - U[2] * U[4]);
    U[7] = sg * (U[2] * U[3] - U[0] * U[5]);
    U[8] = sg * (U[0] * U[4] - U[1] * U[3]);
    // Principal vectors B'_j = sum_k v_j[k] B_k and A'_j = sum_k u_j[k] A_k.
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
    // Plane j turns B'_j toward T_j by theta_j, ending at A'_j. T_j is the part
    // of A'_j off B's span, so it is made orthogonal to all three B'_k (in exact
    // arithmetic it already is). When that part is below REFIT_TINY (float32
    // frames carry noise near 1e-7) the plane does not turn: dividing by it would
    // only blow noise up into a direction. The one exception is a reversed
    // principal vector (A'_j = -B'_j, a half turn), which turns through a
    // direction off B's span and off the planes before it; with no room for one
    // (D = 3) it is left as it is.
    var Tp = new Float64Array(3 * D);
    var theta = new Float64Array(3);
    for (var j3 = 0; j3 < 3; j3++) {
      var cth = dotRows(Ap, j3, Bp, j3, D);
      for (var d2 = 0; d2 < D; d2++) Tp[j3 * D + d2] = Ap[j3 * D + d2];
      var nn = offSpan(Tp, j3, Bp, Tp, 0, D);
      if (nn > REFIT_TINY) {
        for (var d3 = 0; d3 < D; d3++) Tp[j3 * D + d3] /= nn;
        theta[j3] = Math.atan2(nn, cth);
      } else if (cth < 0 && halfTurnDirection(Tp, j3, Bp, D)) {
        theta[j3] = Math.PI;
      } else {
        for (var d4 = 0; d4 < D; d4++) Tp[j3 * D + d4] = 0;
        theta[j3] = 0;
      }
    }
    // Z = V^T U: Z[i][j] = v_i . u_j, as an axis and angle (Z = exp(phi K)).
    var Z = new Float64Array(9);
    for (var zi = 0; zi < 3; zi++) {
      for (var zj = 0; zj < 3; zj++) {
        Z[zi * 3 + zj] = V[zi * 3] * U[zj * 3] + V[zi * 3 + 1] * U[zj * 3 + 1] + V[zi * 3 + 2] * U[zj * 3 + 2];
      }
    }
    var cphi = (Z[0] + Z[4] + Z[8] - 1) / 2;
    var phi = Math.acos(cphi > 1 ? 1 : cphi < -1 ? -1 : cphi);
    var K = new Float64Array(9);
    var sphi = Math.sin(phi);
    var axis = null;
    // Below REFIT_TINY there is no turn inside the span (its axis would be noise).
    // A small sine with a large angle is a half turn, found from Z + I.
    if (phi > REFIT_TINY && sphi > 1e-6) {
      axis = [(Z[7] - Z[5]) / (2 * sphi), (Z[2] - Z[6]) / (2 * sphi), (Z[3] - Z[1]) / (2 * sphi)];
    } else if (phi > Math.PI / 2) {
      // a half turn: Z + I = 2 n n^T
      var bi = 0;
      for (var q = 1; q < 3; q++) if (Z[q * 4] > Z[bi * 4]) bi = q;
      var len = Math.sqrt(Math.max((Z[bi * 4] + 1) / 2, 1e-300));
      axis = [0, 0, 0];
      for (var q2 = 0; q2 < 3; q2++) axis[q2] = (Z[q2 * 3 + bi] + (q2 === bi ? 1 : 0)) / (4 * len);
    }
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
    var bl = { Bp: Bp, Tp: Tp, theta: theta, K: K, phi: phi, duration: 0, rate: 0 };
    bl.rate = blendRate(bl, B, D);
    return bl;
  }

  // Row j of T made orthogonal (twice) to the three rows of B and to rows 0..k-1
  // of P; returns the remaining length.
  function offSpan(T, j, B, P, k, D) {
    var o = j * D;
    for (var pass = 0; pass < 2; pass++) {
      for (var r = 0; r < 3 + k; r++) {
        var R = r < 3 ? B : P;
        var orr = (r < 3 ? r : r - 3) * D;
        var dp = 0;
        for (var d = 0; d < D; d++) dp += T[o + d] * R[orr + d];
        for (var d2 = 0; d2 < D; d2++) T[o + d2] -= dp * R[orr + d2];
      }
    }
    var n = 0;
    for (var d3 = 0; d3 < D; d3++) n += T[o + d3] * T[o + d3];
    return Math.sqrt(n);
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
    var K = bl.K;
    var sn = Math.sin(s * bl.phi);
    var cm = 1 - Math.cos(s * bl.phi);
    var Z = new Float64Array(9);
    for (var a = 0; a < 3; a++) {
      for (var b = 0; b < 3; b++) {
        var k2 = K[a * 3] * K[b] + K[a * 3 + 1] * K[3 + b] + K[a * 3 + 2] * K[6 + b];
        Z[a * 3 + b] = (a === b ? 1 : 0) + sn * K[a * 3 + b] + cm * k2;
      }
    }
    var Bp = bl.Bp;
    var Tp = bl.Tp;
    for (var r = 0; r < 3; r++) {
      var o = r * D;
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
    return x;
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
