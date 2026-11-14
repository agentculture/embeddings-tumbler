// ---------------------------------------------------------------------------
// 26-search-sets.js: several searches at once (ET.searchSets).
//
// Up to four searches are active together. Given their rankings (the shape
// ET.search makes, js/api/24-search.md) this module answers what is lit and
// how strongly under the three lit settings, which points carry the shared
// mark, the report for each pair of searches, the point-of-view scale of one
// search, and the seeded linear view that faces the searches.
//
// Pure: no DOM, no WebGL, no network. The only random numbers are drawn from
// ET.math.makeRandom on a seed derived from the view seed, so the same data,
// searches and seed give the same frame bit for bit. Every projection is
// linear: the facing frame is three orthonormal rows applied to every point.
//
// Documented in js/api/26-search-sets.md.
// ---------------------------------------------------------------------------
ET.searchSets = (function () {
  var MAX_SEARCHES = 4;
  var LETTERS = Object.freeze(["A", "B", "C", "D"]);
  var LIT_SETTINGS = Object.freeze(["even", "close", "named"]);
  var DEFAULT_LIT = "even";
  var LIT_THRESHOLD = 0.02;
  var CLOSE_REACH = 2.2;
  var CLOSE_POWER = 1.6;
  var FACE_SALT = 0x46414345;
  var FACE_ITERATIONS = 25;
  var FACE_ZOOM = 0.7;
  var FACE_MIN_REACH = 1e-3;
  // A candidate axis is kept when what is left after removing the axes so far
  // is longer than KEEP times its length before.
  var KEEP = 1e-6;
  // The facing-frame stepper pauses after this many multiply-adds (counted, not
  // timed, so the pauses fall at the same places on every run).
  var FACE_UNIT = 1 << 17;

  // ----- small functions -----------------------------------------------------

  function letter(j) {
    if (!Number.isInteger(j) || j < 0 || j >= MAX_SEARCHES) {
      throw new RangeError("a search position is an integer from 0 to " + (MAX_SEARCHES - 1));
    }
    return LETTERS[j];
  }

  function litSetting(value) {
    return LIT_SETTINGS.includes(value) ? value : DEFAULT_LIT;
  }

  function isVectorLike(v) {
    return v !== null && typeof v === "object" && typeof v.length === "number";
  }

  function scaleFor(vector) {
    if (!isVectorLike(vector)) throw new TypeError("scaleFor: the query vector must be an array of numbers");
    var s = new Float32Array(vector.length);
    for (var d = 0; d < vector.length; d++) s[d] = Math.abs(vector[d]);
    return s;
  }

  function checkSearches(searches) {
    if (!Array.isArray(searches)) throw new TypeError("searches must be an array");
    if (searches.length > MAX_SEARCHES) {
      throw new RangeError("at most " + MAX_SEARCHES + " searches can be active at once");
    }
  }

  function hasResults(ranking) {
    return typeof ranking.radius === "number" && ranking.hits.length > 0;
  }

  // ----- lit values ----------------------------------------------------------

  function closeValue(d, near, reach) {
    var x = Math.min(Math.max(1 - (d - near) / (reach - near), 0), 1);
    return x ** CLOSE_POWER;
  }

  // The value one search gives a point at distance d (named results are set apart).
  function searchValue(how, d, isIn, near, reach) {
    if (how === "close") return closeValue(d, near, reach);
    return how === "even" && isIn ? 1 : 0;
  }

  function lightNamed(ranking, count, out) {
    for (const hit of ranking.hits) {
      var at = hit.index;
      if (at < count) out.lit[at] = 1;
    }
  }

  // Adds one search to `out`; returns how many points are inside it.
  function lightSearch(ranking, count, how, out) {
    if (!hasResults(ranking)) return 0;
    var dist = ranking.distances;
    var n = Math.min(count, dist.length);
    var radius = ranking.radius;
    var near = ranking.near;
    var reach = near + (radius - near) * CLOSE_REACH + 1e-6;
    var inside = 0;
    for (var i = 0; i < n; i++) {
      var isIn = dist[i] <= radius;
      if (isIn) {
        out.inside[i]++;
        inside++;
      }
      var v = searchValue(how, dist[i], isIn, near, reach);
      if (v > out.lit[i]) out.lit[i] = v;
    }
    if (how === "named") lightNamed(ranking, count, out);
    return inside;
  }

  function litValues(searches, count, setting) {
    checkSearches(searches);
    if (!Number.isInteger(count) || count < 0) throw new RangeError("count must be a non-negative integer");
    var how = litSetting(setting);
    var out = {
      lit: new Float32Array(count),
      shared: new Uint8Array(count),
      inside: new Uint8Array(count),
      insideCounts: [],
      litCount: 0,
      sharedCount: 0,
    };
    for (const search of searches) out.insideCounts.push(lightSearch(search, count, how, out));
    for (var i = 0; i < count; i++) {
      if (out.lit[i] > LIT_THRESHOLD) out.litCount++;
      if (out.inside[i] >= 2 && out.lit[i] > 0) {
        out.shared[i] = 1;
        out.sharedCount++;
      }
    }
    return out;
  }

  // ----- pair reports --------------------------------------------------------

  function checkIndex(index, count) {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new RangeError("a named result's index is not a row of the set: " + index);
    }
  }

  // The length of every named result's row, in double precision.
  function hitLengths(X, D, count, hits) {
    var lengths = new Float64Array(hits.length);
    for (var h = 0; h < hits.length; h++) {
      checkIndex(hits[h].index, count);
      var o = hits[h].index * D;
      var sum = 0;
      for (var d = 0; d < D; d++) sum += X[o + d] * X[o + d];
      lengths[h] = Math.sqrt(sum);
    }
    return lengths;
  }

  // Plain cosine distance between two loaded rows; a zero row is at distance 1.
  function rowDistance(X, D, i, j, li, lj) {
    if (li === 0 || lj === 0) return 1;
    var oi = i * D;
    var oj = j * D;
    var dot = 0;
    for (var d = 0; d < D; d++) dot += X[oi + d] * X[oj + d];
    var cos = Math.min(Math.max(dot / (li * lj), -1), 1);
    return 1 - cos;
  }

  function sharedBetween(ra, rb) {
    if (!hasResults(ra) || !hasResults(rb)) return 0;
    var n = Math.min(ra.distances.length, rb.distances.length);
    var shared = 0;
    for (var i = 0; i < n; i++) {
      if (ra.distances[i] <= ra.radius && rb.distances[i] <= rb.radius) shared++;
    }
    return shared;
  }

  // The closest pair of different named results, one from each search; pauses when a unit
  // of work ends (counted, so the pauses fall at the same places on every run).
  function* closestPairGen(X, D, ra, rb, la, lb, wk) {
    var best = null;
    for (var x = 0; x < ra.hits.length; x++) {
      var ia = ra.hits[x].index;
      for (var y = 0; y < rb.hits.length; y++) {
        var ib = rb.hits[y].index;
        if (ia === ib) continue;
        var dist = rowDistance(X, D, ia, ib, la[x], lb[y]);
        if (best === null || dist < best.distance) best = { a: ia, b: ib, distance: dist };
        if (wk.add(D)) yield;
      }
    }
    return best;
  }

  // One pair's report.
  function* pairGen(set, a, b, ra, rb, lengths, wk) {
    var inB = new Set();
    for (const hit of rb.hits) inB.add(hit.index);
    var commonIndices = [];
    for (const hit of ra.hits) {
      if (inB.has(hit.index)) commonIndices.push(hit.index);
    }
    var shared = sharedBetween(ra, rb);
    if (wk.add(Math.min(ra.distances.length, rb.distances.length))) yield;
    var closest = yield* closestPairGen(set.vectors, set.dimension, ra, rb, lengths[a], lengths[b], wk);
    return {
      a: a,
      b: b,
      shared: shared,
      common: commonIndices.length,
      commonIndices: commonIndices,
      closest: closest,
    };
  }

  function* pairsGen(set, searches, lengths, wk) {
    var pairs = [];
    for (var a = 0; a < searches.length; a++) {
      for (var b = a + 1; b < searches.length; b++) {
        pairs.push(yield* pairGen(set, a, b, searches[a], searches[b], lengths, wk));
      }
    }
    return pairs;
  }

  // The pair reports as a stepper (the facing frame's convention). The rows' lengths and the
  // checks of every index are worked out here, so a bad index throws at once.
  function makePairReports(set, searches) {
    checkSearches(searches);
    var D = set.dimension;
    var lengths = [];
    for (const search of searches) lengths.push(hitLengths(set.vectors, D, set.count, search.hits));
    var total = 1;
    for (var a = 0; a < searches.length; a++) {
      for (var b = a + 1; b < searches.length; b++) {
        total += searches[a].hits.length * searches[b].hits.length * D + set.count;
      }
    }
    var wk = new FaceWork(total);
    return faceStepper(pairsGen(set, searches, lengths, wk), wk);
  }

  function pairReports(set, searches) {
    var st = makePairReports(set, searches);
    st.step();
    return st.result;
  }

  // ----- the facing frame: vector helpers (double precision) -----------------

  function dotD(a, b, D) {
    var s = 0;
    for (var d = 0; d < D; d++) s += a[d] * b[d];
    return s;
  }

  function lengthD(a, D) {
    return Math.sqrt(dotD(a, a, D));
  }

  // Removes from v its components along each of `axes` (orthonormal rows), once.
  function removeAxes(v, axes, D) {
    for (const axis of axes) {
      var p = dotD(v, axis, D);
      for (var d = 0; d < D; d++) v[d] -= p * axis[d];
    }
  }

  // Step 3: Gram-Schmidt against the axes so far (twice); kept when what is left
  // is longer than KEEP times the candidate, then normalised and appended.
  function offer(axes, candidate, D) {
    var before = lengthD(candidate, D);
    removeAxes(candidate, axes, D);
    removeAxes(candidate, axes, D);
    var after = lengthD(candidate, D);
    if (before > 0 && after > KEEP * before) {
      for (var d = 0; d < D; d++) candidate[d] /= after;
      axes.push(candidate);
      return true;
    }
    return false;
  }

  // Step 6: the standard basis vectors e_0, e_1, ... in order until one is kept.
  // With fewer than three axes and D >= 3 one always is.
  function offerBasis(axes, D) {
    for (var d = 0; d < D; d++) {
      var e = new Float64Array(D);
      e[d] = 1;
      if (offer(axes, e, D)) return;
    }
  }

  function checkLength(v, length, what) {
    if (!isVectorLike(v) || v.length !== length) {
      throw new TypeError("facing frame: " + what + " must have " + length + " values");
    }
  }

  function checkOption(v, length, what) {
    if (v === null || v === undefined) return null;
    if (!(v instanceof Float32Array) || v.length !== length) {
      throw new TypeError("facing frame: " + what + " must be a Float32Array of " + length + " values");
    }
    return v;
  }

  function checkFacing(set, searches) {
    var D = set.dimension;
    for (const search of searches) {
      checkLength(search.query, D, "each query");
      if (!Array.isArray(search.hits)) throw new TypeError("facing frame: each search needs a hits array");
      for (const hit of search.hits) checkIndex(hit.index, set.count);
    }
  }

  // ----- the facing frame: the computation, as a generator --------------------

  // Counts multiply-adds and says when a unit of work is over.
  function FaceWork(total) {
    this.total = total;
    this.done = 0;
    this.acc = 0;
  }
  FaceWork.prototype.add = function (cost) {
    this.done += cost;
    this.acc += cost;
    if (this.acc < FACE_UNIT) return false;
    this.acc = 0;
    return true;
  };

  // One search's rows: its query and its named results' loaded vectors.
  function searchRows(X, D, search) {
    var mine = [search.query];
    for (const hit of search.hits) {
      var o = hit.index * D;
      mine.push(X.subarray(o, o + D));
    }
    return mine;
  }

  // The mean of rows (each optionally scaled by s), in double precision.
  function meanOfRows(rows, D, s) {
    var c = new Float64Array(D);
    for (const row of rows) {
      for (var d = 0; d < D; d++) c[d] += s ? row[d] * s[d] : row[d];
    }
    for (var e = 0; e < D; e++) c[e] /= rows.length;
    return c;
  }

  // (row * s) - c for one row, in double precision.
  function offsetOf(row, D, s, c) {
    var v = new Float64Array(D);
    for (var d = 0; d < D; d++) v[d] = (s ? row[d] * s[d] : row[d]) - c[d];
    return v;
  }

  // The rows of every search (its query and its named results), unscaled, each
  // search's centre scaled and unscaled, and each scaled row's offset from its
  // search's scaled centre.
  // Pauses after each search's centres and whenever a unit of work ends among its offsets, so
  // searches of 100 results keep units short.
  function* gatherRows(fit, wk) {
    var out = { scaledCentres: [], plainCentres: [], offsets: [], plainRows: [] };
    for (const search of fit.searches) {
      var mine = searchRows(fit.X, fit.D, search);
      var c = meanOfRows(mine, fit.D, fit.scale);
      out.scaledCentres.push(c);
      out.plainCentres.push(meanOfRows(mine, fit.D, null));
      wk.add(2 * mine.length * fit.D);
      yield;
      for (const row of mine) {
        out.plainRows.push(row);
        out.offsets.push(offsetOf(row, fit.D, fit.scale, c));
        if (wk.add(fit.D)) yield;
      }
    }
    return out;
  }

  // One pass of the power iteration over rows `from` on: w += (row . v) row for each,
  // stopping after the row at which a unit of work ends. Returns the next row to do,
  // or -1 when the rows ran out without a unit ending. (A plain function that resumes
  // at `from`: the generator itself pays for a for...of over the rows, measured.)
  function spreadPass(offsets, from, v, w, D, wk) {
    for (var r = from; r < offsets.length; r++) {
      var row = offsets[r];
      var p = dotD(row, v, D);
      for (var d = 0; d < D; d++) w[d] += p * row[d];
      if (wk.add(2 * D)) return r + 1;
    }
    return -1;
  }

  // Step 5: a power iteration on the spread of the rows about their own centres,
  // from a seeded start. Returns the candidate, or null when the spread left
  // outside the axes so far is zero (then the basis fallback applies).
  function* spreadAxis(fit, offsets, axes, wk) {
    var D = fit.D;
    var v = new Float64Array(D);
    ET.math.makeRandom(ET.math.mixSeed(fit.seed, FACE_SALT + axes.length)).fillGauss(v);
    for (var it = 0; it < FACE_ITERATIONS; it++) {
      var w = new Float64Array(D);
      var next = spreadPass(offsets, 0, v, w, D, wk);
      while (next >= 0) {
        yield;
        next = spreadPass(offsets, next, v, w, D, wk);
      }
      var before = lengthD(w, D);
      removeAxes(w, axes, D);
      var after = lengthD(w, D);
      if (after <= KEEP * before) return null;
      for (var e = 0; e < D; e++) w[e] /= after;
      v = w;
    }
    return v;
  }

  // Step 7: with a scale, axis a becomes a * s and the three are made
  // orthonormal again in order; a degenerate one is replaced by the basis rule.
  function mapBack(axes, origins, s, D) {
    var mapped = [];
    for (var k = 0; k < axes.length; k++) {
      var m = new Float64Array(D);
      for (var d = 0; d < D; d++) m[d] = axes[k][d] * s[d];
      if (!offer(mapped, m, D)) {
        offerBasis(mapped, D);
        origins[k] = "basis";
      }
    }
    return mapped;
  }

  // Step 8: the frame's rows, each negated when it points away from the same
  // row of the current frame.
  function signedFrame(axes, current, D) {
    var frame = new Float32Array(3 * D);
    for (var k = 0; k < 3; k++) {
      var away = current !== null && dotD(axes[k], current.subarray(k * D, (k + 1) * D), D) < 0;
      var sign = away ? -1 : 1;
      for (var d = 0; d < D; d++) frame[k * D + d] = sign * axes[k][d];
    }
    return frame;
  }

  // Step 9: the length of frame (x - centre).
  function shownLength(frame, x, centre, D) {
    var sq = 0;
    for (var a = 0; a < 3; a++) {
      var p = 0;
      for (var f = 0; f < D; f++) p += (x[f] - centre[f]) * frame[a * D + f];
      sq += p * p;
    }
    return Math.sqrt(sq);
  }

  function countOf(origins, what) {
    return origins.filter((o) => o === what).length;
  }

  // Steps 8 and 9: signs against the current frame, then centre and zoom.
  function* finish(fit, rows, axes, origins, wk) {
    var D = fit.D;
    var frame = signedFrame(axes, fit.current, D);
    var centre = Float32Array.from(meanOfRows(rows.plainCentres, D, null));
    var reach = FACE_MIN_REACH;
    for (const row of rows.plainRows) {
      reach = Math.max(reach, shownLength(frame, row, centre, D));
      if (wk.add(3 * D)) yield;
    }
    return {
      frame: frame,
      centre: centre,
      zoom: FACE_ZOOM / reach,
      fromCentres: countOf(origins, "centres"),
      fromSpread: countOf(origins, "spread"),
      fromBasis: countOf(origins, "basis"),
    };
  }

  function* facingGen(fit, wk) {
    var D = fit.D;
    var rows = yield* gatherRows(fit, wk);
    var axes = [];
    var origins = [];
    var cs = rows.scaledCentres;
    for (var j = 1; j < cs.length && axes.length < 3; j++) {
      var join = new Float64Array(D);
      for (var d = 0; d < D; d++) join[d] = cs[j][d] - cs[0][d];
      if (offer(axes, join, D)) origins.push("centres");
    }
    while (axes.length < 3) {
      var candidate = yield* spreadAxis(fit, rows.offsets, axes, wk);
      if (candidate && offer(axes, candidate, D)) {
        origins.push("spread");
      } else {
        offerBasis(axes, D);
        origins.push("basis");
      }
    }
    if (fit.scale) axes = mapBack(axes, origins, fit.scale, D);
    return yield* finish(fit, rows, axes, origins, wk);
  }

  function now() {
    return performance.now();
  }

  // { step(budgetMs?) -> done, done, progress, result }, as ET.math's steppers:
  // step(budgetMs) runs units until budgetMs ms have passed (at least one);
  // step() runs to the end. The clock decides only how many units run per call.
  function faceStepper(gen, wk) {
    var st = { done: false, progress: 0, result: null, step: null };
    st.step = function (budgetMs) {
      if (st.done) return true;
      var limit = budgetMs === undefined ? Infinity : budgetMs;
      var start = now();
      do {
        var r = gen.next();
        if (r.done) {
          st.done = true;
          st.result = r.value;
          st.progress = 1;
          return true;
        }
      } while (now() - start < limit);
      st.progress = Math.min(0.99, wk.done / wk.total);
      return false;
    };
    return st;
  }

  // Written as a comparison so that NaN (and undefined) are not enough.
  function hasThreeDimensions(D) {
    return D >= 3;
  }

  function makeFacingFrame(set, searches, options) {
    var o = options || {};
    checkSearches(searches);
    var D = set.dimension;
    if (!hasThreeDimensions(D)) throw new RangeError("the facing frame needs at least 3 dimensions");
    var fit = {
      X: set.vectors,
      D: D,
      searches: searches,
      seed: ET.math.toSeed(o.seed === undefined ? 1 : o.seed),
      scale: checkOption(o.scale, D, "scale"),
      current: checkOption(o.current, 3 * D, "current"),
    };
    checkFacing(set, searches);
    if (!searches.length) {
      return {
        done: true,
        progress: 1,
        result: null,
        step: function () {
          return true;
        },
      };
    }
    var rowCount = 0;
    for (const search of searches) rowCount += 1 + search.hits.length;
    var wk = new FaceWork(rowCount * D * (6 + 2 * FACE_ITERATIONS * 3));
    return faceStepper(facingGen(fit, wk), wk);
  }

  function facingFrame(set, searches, options) {
    var st = makeFacingFrame(set, searches, options);
    st.step();
    return st.result;
  }

  return {
    MAX_SEARCHES: MAX_SEARCHES,
    LETTERS: LETTERS,
    LIT_SETTINGS: LIT_SETTINGS,
    DEFAULT_LIT: DEFAULT_LIT,
    LIT_THRESHOLD: LIT_THRESHOLD,
    CLOSE_REACH: CLOSE_REACH,
    CLOSE_POWER: CLOSE_POWER,
    FACE_SALT: FACE_SALT,
    FACE_ITERATIONS: FACE_ITERATIONS,
    FACE_ZOOM: FACE_ZOOM,
    letter: letter,
    litSetting: litSetting,
    scaleFor: scaleFor,
    litValues: litValues,
    pairReports: pairReports,
    makePairReports: makePairReports,
    makeFacingFrame: makeFacingFrame,
    facingFrame: facingFrame,
  };
})();
