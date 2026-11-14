/*! embeddings-tumbler 0.11.0 | source: github.com/agentculture/embeddings-tumbler | assembled from js/src by scripts/assemble.py, do not edit by hand */
(function (root) {
  "use strict";

  // Shared internal namespace. Every later module adds its functions here
  // (ET.math = {...}, ET.contract = {...}) and reads earlier modules' from it.
  var ET = {};
  ET.version = "0.11.0";
  // The public API object. Only 50-viewer.js fills this (mount, update, destroy).
  ET.api = {};
  // ---------------------------------------------------------------------------
  // 10-math.js: the mathematics of the viewer (ET.math). Pure functions, no DOM.
  //
  // Conventions used throughout (see js/api/10-math.md):
  //   - Vectors arrive as one flat Float32Array of length N * D, row-major
  //     (point i occupies [i * D, i * D + D)). D always comes from the caller.
  //   - A frame is a Float32Array of length 3 * D, row-major: rows 0, 1, 2 are
  //     the x, y and z viewing axes, and the rows are orthonormal.
  //   - Every projection is linear: a point's screen coordinates are the dot
  //     products of (x - centre) with the three frame rows. Nothing here builds
  //     a non-linear layout.
  //   - Anything random takes a seed. The same inputs and seed give the same
  //     output, bit for bit, in the same engine.
  // ---------------------------------------------------------------------------
  ET.math = (function () {
    var TAU = Math.PI * 2;
    var SALT_TOUR = 0x746f7572; // fixed salts so sub-streams never collide
    var SALT_SWAP = 0x73776170;
    var SALT_PCA = 0x70636121;

    // ----- seeded random source --------------------------------------------

    // Ported from the reference. Returns a function giving uniform numbers in [0, 1).
    function mulberry32(seed) {
      var a = seed | 0;
      return function () {
        a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // A seed may be a number or a string. Numbers are truncated to 32 bits;
    // strings are hashed (FNV-1a). Anything else is refused.
    function toSeed(value) {
      if (typeof value === "number" && isFinite(value)) return Math.floor(value) >>> 0;
      if (typeof value === "string") {
        var h = 0x811c9dc5;
        for (var i = 0; i < value.length; i++) {
          h ^= value.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
      }
      throw new TypeError("seed must be a finite number or a string");
    }

    // Derive an independent 32-bit seed from (seed, salt), so that, for example,
    // cycle c of a schedule draws from its own stream whatever came before it.
    function mixSeed(seed, salt) {
      var h = (toSeed(seed) ^ Math.imul((salt | 0) + 0x9e3779b9, 0x85ebca6b)) | 0;
      h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      h ^= h >>> 16;
      return h >>> 0;
    }

    // A seeded source with uniform and standard normal draws (polar method, as
    // in the reference, but with its spare value kept per source).
    function makeRandom(seed) {
      var next = mulberry32(toSeed(seed));
      var spare = null;
      function gauss() {
        if (spare !== null) {
          var s0 = spare;
          spare = null;
          return s0;
        }
        var u, v, s;
        do {
          u = next() * 2 - 1;
          v = next() * 2 - 1;
          s = u * u + v * v;
        } while (s >= 1 || s === 0);
        var m = Math.sqrt((-2 * Math.log(s)) / s);
        spare = v * m;
        return u * m;
      }
      function fillGauss(arr, offset, length) {
        var o = offset || 0;
        var n = length === undefined ? arr.length - o : length;
        for (var i = 0; i < n; i++) arr[o + i] = gauss();
        return arr;
      }
      return { next: next, gauss: gauss, fillGauss: fillGauss };
    }

    // ----- argument checks -----------------------------------------------------

    function checkDim(D) {
      if (!(D >= 1) || Math.floor(D) !== D) throw new RangeError("dimension must be a positive integer");
    }

    // `rows` directions of length D in `dirs`, exactly: a mismatch is a caller bug.
    function checkRows(dirs, rows, D, what) {
      if (!(rows >= 1) || Math.floor(rows) !== rows || rows > D) {
        throw new TypeError(what + ": rows must be an integer from 1 to the dimension");
      }
      if (!dirs || dirs.length !== rows * D) {
        throw new TypeError(what + ": expected " + rows * D + " values (rows * dimension)");
      }
    }

    function checkData(X, N, D) {
      checkDim(D);
      if (!(N >= 0) || Math.floor(N) !== N) throw new RangeError("count must be a non-negative integer");
      if (!X || X.length < N * D) throw new RangeError("vector block is shorter than count * dimension");
    }

    // ----- sliced work ---------------------------------------------------------
    //
    // The long computations (centring, the principal-direction fit, the guided
    // tour's construction) are written once, as generator functions that pause
    // (yield) between small pieces of work. A stepper runs them a few units at a
    // time; the blocking functions run the same generators to the end without
    // pausing, so there is one code path and the results are bit-identical
    // however the work was sliced. A pause only ever falls between pieces, never
    // inside one, so where it falls changes how much work one step does and
    // nothing else. It falls after UNIT multiply-adds of work, or earlier once
    // SLICE_MS milliseconds have passed since the unit began (memory-bound loops
    // and code the engine has not optimised yet run slower per multiply-add).
    // The clock is read about every CHECK multiply-adds.

    var UNIT = 1 << 20; // multiply-adds per unit at most: about 0.6 ms of arithmetic in node
    var CHECK = UNIT >> 4;
    var SLICE_MS = 1;

    // Counts work done and says when a unit is over.
    function Tracker(total) {
      this.total = total > 0 ? total : 1;
      this.done = 0;
      this.acc = 0;
      this.nextCheck = CHECK;
      this.t0 = 0;
    }
    Tracker.prototype.add = function (cost) {
      this.done += cost;
      this.acc += cost;
      if (this.acc < this.nextCheck) return false;
      if (this.acc >= UNIT || clockNow() - this.t0 >= SLICE_MS) {
        this.acc = 0;
        this.nextCheck = CHECK;
        return true;
      }
      this.nextCheck = this.acc + CHECK;
      return false;
    };
    // The blocking calls never pause.
    var NO_PAUSE = {
      add: function () {
        return false;
      },
    };

    function runAll(gen) {
      var r = gen.next();
      while (!r.done) r = gen.next();
      return r.value;
    }

    function clockNow() {
      if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
        return performance.now();
      }
      return Date.now();
    }

    // A stepper over a generator: { step(budgetMs?) -> done, done, progress, result }.
    // step(budgetMs) runs units until budgetMs milliseconds have passed (always at
    // least one unit, so step(0) runs exactly one); step() runs to the end.
    // `result` is null until done.
    function genStepper(gen, tracker) {
      var st = { done: false, progress: 0, result: null, step: null };
      st.step = function (budgetMs) {
        if (st.done) return true;
        var limit = budgetMs === undefined ? Infinity : budgetMs;
        var start = clockNow();
        var first = true;
        while (first || limit === Infinity || clockNow() - start < limit) {
          first = false;
          tracker.t0 = clockNow();
          var r = gen.next();
          if (r.done) {
            st.done = true;
            st.result = r.value;
            st.progress = 1;
            return true;
          }
        }
        st.progress = Math.min(0.99, tracker.done / tracker.total);
        return false;
      };
      return st;
    }

    function clamp01(x) {
      return x < 0 ? 0 : x > 1 ? 1 : x;
    }

    // ----- centring and variance -------------------------------------------

    // Mean of N points in D dimensions, accumulated in double precision.
    function meanOf(X, N, D) {
      checkData(X, N, D);
      var mean = new Float64Array(D);
      for (var i = 0; i < N; i++) {
        var o = i * D;
        for (var d = 0; d < D; d++) mean[d] += X[o + d];
      }
      if (N > 0) for (var e = 0; e < D; e++) mean[e] /= N;
      return mean;
    }

    // Centring, sliced by rows: the mean (accumulated row by row in double
    // precision, as meanOf), then the centred rows.
    function* centreGen(X, N, D, inPlace, wk) {
      var mean = new Float64Array(D);
      for (var i = 0; i < N; i++) {
        var o = i * D;
        for (var d = 0; d < D; d++) mean[d] += X[o + d];
        if (wk.add(D)) yield;
      }
      if (N > 0) for (var e = 0; e < D; e++) mean[e] /= N;
      var Y = inPlace ? X : new Float32Array(N * D);
      for (var i2 = 0; i2 < N; i2++) {
        var o2 = i2 * D;
        for (var d2 = 0; d2 < D; d2++) Y[o2 + d2] = X[o2 + d2] - mean[d2];
        if (wk.add(D)) yield;
      }
      return { mean: mean, data: Y };
    }

    // Subtract the mean. Returns { mean: Float64Array(D), data: Float32Array(N*D) }.
    // With opts.inPlace the input block itself is overwritten and returned as data.
    // Centring is a translation: all pairwise distances are unchanged.
    function centre(X, N, D, opts) {
      checkData(X, N, D);
      return runAll(centreGen(X, N, D, !!(opts && opts.inPlace), NO_PAUSE));
    }

    // The same, as a stepper whose result is centre()'s, bit for bit.
    function makeCentre(X, N, D, opts) {
      checkData(X, N, D);
      var wk = new Tracker(2 * N * D);
      return genStepper(centreGen(X, N, D, !!(opts && opts.inPlace), wk), wk);
    }

    function* totalVarianceGen(Y, N, D, wk) {
      var s = 0;
      for (var i = 0; i < N; i++) {
        var o = i * D;
        for (var d = 0; d < D; d++) s += Y[o + d] * Y[o + d];
        if (wk.add(D)) yield;
      }
      return N > 0 ? s / N : 0;
    }

    // Total variance of centred data: the mean squared length of the rows.
    function totalVariance(Y, N, D) {
      checkData(Y, N, D);
      return runAll(totalVarianceGen(Y, N, D, NO_PAUSE));
    }

    // Sum over the rows of the squared projection onto each of `rows` unit
    // directions (row r of dirs), each sum taken in row order.
    function* projectedSquaresGen(Y, N, D, dirs, rows, wk) {
      var sums = new Float64Array(rows);
      for (var i = 0; i < N; i++) {
        var oi = i * D;
        for (var r = 0; r < rows; r++) {
          var o = r * D;
          var p = 0;
          for (var d = 0; d < D; d++) p += Y[oi + d] * dirs[o + d];
          sums[r] += p * p;
        }
        if (wk.add(rows * D)) yield;
      }
      return sums;
    }

    // Share of the total variance held by the span of `rows` orthonormal
    // directions (row-major, rows * D). Exact for whatever directions are given,
    // clamped to [0, 1] (rounding can otherwise overshoot 1 by about 1e-8).
    function varianceShare(Y, N, D, dirs, rows) {
      checkData(Y, N, D);
      checkRows(dirs, rows, D, "varianceShare");
      var total = totalVariance(Y, N, D);
      if (!(total > 0)) return 0;
      var sums = runAll(projectedSquaresGen(Y, N, D, dirs, rows, NO_PAUSE));
      var s = 0;
      for (var r = 0; r < rows; r++) s += N > 0 ? sums[r] / N : 0;
      return clamp01(s / total);
    }

    // ----- orthonormal frames ------------------------------------------------

    // Gram-Schmidt, in place, on `rows` rows of length D, with a second
    // re-orthogonalisation pass. Work happens in double precision. A row that
    // collapses (it lies in the span of the rows before it) is replaced by the
    // standard basis vector least covered by those rows, so the result is always
    // orthonormal and never depends on a random draw.
    function orthonormalize(M, rows, D) {
      checkDim(D);
      if (rows > D) throw new RangeError("cannot fit more orthonormal rows than the dimension");
      var v = new Float64Array(D);
      for (var i = 0; i < rows; i++) orthoRow(M, i, D, v);
      return M;
    }

    // The same, sliced by rows (one row costs about 4 * i * D multiply-adds).
    function* orthonormalizeGen(M, rows, D, wk) {
      checkDim(D);
      if (rows > D) throw new RangeError("cannot fit more orthonormal rows than the dimension");
      var v = new Float64Array(D);
      for (var i = 0; i < rows; i++) {
        orthoRow(M, i, D, v);
        if (wk.add((4 * i + 3) * D)) yield;
      }
      return M;
    }

    // Row i of M made orthogonal to rows 0..i-1 (twice) and normalised; v is scratch.
    function orthoRow(M, i, D, v) {
      var oi = i * D;
      var before = 0;
      for (var d = 0; d < D; d++) {
        v[d] = M[oi + d];
        before += v[d] * v[d];
      }
      for (var pass = 0; pass < 2; pass++) {
        for (var j = 0; j < i; j++) {
          var oj = j * D;
          var dp = 0;
          for (var d2 = 0; d2 < D; d2++) dp += v[d2] * M[oj + d2];
          for (var d3 = 0; d3 < D; d3++) v[d3] -= dp * M[oj + d3];
        }
      }
      var nn = 0;
      for (var d4 = 0; d4 < D; d4++) nn += v[d4] * v[d4];
      if (!(nn > 1e-24) || nn <= 1e-12 * before) nn = fallbackRow(M, i, D, v);
      var inv = 1 / Math.sqrt(nn);
      for (var d6 = 0; d6 < D; d6++) M[oi + d6] = v[d6] * inv;
    }

    // Standard basis vectors in order of least coverage by rows 0..i-1 (ties
    // to the lower index), each made orthogonal to those rows; the first whose
    // remainder does not collapse is written into v. Returns its squared norm.
    // Since i < D, some basis vector always keeps at least (D - i) / D of its
    // length, so the search ends.
    function fallbackRow(M, i, D, v) {
      var cover = new Float64Array(D);
      var order = [];
      for (var c = 0; c < D; c++) {
        var cv = 0;
        for (var j = 0; j < i; j++) cv += M[j * D + c] * M[j * D + c];
        cover[c] = cv;
        order.push(c);
      }
      order.sort(function (a, b) {
        return cover[a] - cover[b] || a - b;
      });
      var bestNorm = -1;
      var bestC = order[0];
      for (var t = 0; t <= D; t++) {
        // after trying every candidate, settle on the one that kept the most
        var cand = t < D ? order[t] : bestC;
        for (var d = 0; d < D; d++) v[d] = d === cand ? 1 : 0;
        for (var pass = 0; pass < 2; pass++) {
          for (var j2 = 0; j2 < i; j2++) {
            var oj = j2 * D;
            var dp = 0;
            for (var d2 = 0; d2 < D; d2++) dp += v[d2] * M[oj + d2];
            for (var d3 = 0; d3 < D; d3++) v[d3] -= dp * M[oj + d3];
          }
        }
        var nn = 0;
        for (var d4 = 0; d4 < D; d4++) nn += v[d4] * v[d4];
        if (t === D || nn > 1e-6) return nn;
        if (nn > bestNorm) {
          bestNorm = nn;
          bestC = cand;
        }
      }
      return nn;
    }

    // Largest deviation of M M^T from the identity (rows * rows entries).
    function frameError(M, rows, D) {
      var worst = 0;
      for (var a = 0; a < rows; a++) {
        for (var b = a; b < rows; b++) {
          var s = 0;
          for (var d = 0; d < D; d++) s += M[a * D + d] * M[b * D + d];
          var e = Math.abs(s - (a === b ? 1 : 0));
          if (e > worst) worst = e;
        }
      }
      return worst;
    }

    // A frame drawn uniformly at random (Gaussian rows, orthonormalised).
    function randomFrame(D, rng, out, rows) {
      checkDim(D);
      var R = rows || 3;
      var F = out || new Float32Array(R * D);
      rng.fillGauss(F, 0, R * D);
      return orthonormalize(F, R, D);
    }

    // Linear projection of N points onto a frame: out[i*3 + r] = (x_i - centre) . F_r.
    // `centre` may be null (zero). Returns Float32Array(N * rows).
    function project(X, N, D, frame, centreVec, out, rows) {
      checkData(X, N, D);
      var R = rows === undefined || rows === null ? 3 : rows;
      checkRows(frame, R, D, "project");
      if (centreVec && centreVec.length !== D) throw new TypeError("project: centre must have dimension values");
      if (out && out.length < N * R) throw new TypeError("project: out is shorter than count * rows");
      var P = out || new Float32Array(N * R);
      var x = new Float64Array(D);
      for (var i = 0; i < N; i++) {
        var o = i * D;
        if (centreVec) for (var d = 0; d < D; d++) x[d] = X[o + d] - centreVec[d];
        else for (var d0 = 0; d0 < D; d0++) x[d0] = X[o + d0];
        for (var r = 0; r < R; r++) {
          var s = 0;
          var or = r * D;
          for (var d2 = 0; d2 < D; d2++) s += x[d2] * frame[or + d2];
          P[i * R + r] = s;
        }
      }
      return P;
    }

    // ----- small symmetric eigenproblems (cyclic Jacobi) ---------------------

    // Eigen-decomposition of a symmetric n x n matrix (Float64Array, row-major).
    // Returns { values: Float64Array(n) descending, vectors: Float64Array(n*n) }
    // where vectors row j is the unit eigenvector for values[j]. Each vector's
    // largest-magnitude component is made positive, so the output is canonical.
    function symmetricEigen(A, n) {
      return runAll(symmetricEigenGen(A, n, NO_PAUSE));
    }

    function* symmetricEigenGen(A, n, wk) {
      var a = new Float64Array(A);
      var V = new Float64Array(n * n);
      for (var i = 0; i < n; i++) V[i * n + i] = 1;
      for (var sweep = 0; sweep < 100; sweep++) {
        var off = 0;
        var diag = 0;
        for (var p = 0; p < n; p++) {
          diag += a[p * n + p] * a[p * n + p];
          for (var q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
        }
        if (off <= 1e-30 * (diag + 1e-300) || off === 0) break;
        for (var p2 = 0; p2 < n; p2++) {
          for (var q2 = p2 + 1; q2 < n; q2++) {
            var apq = a[p2 * n + q2];
            if (apq === 0) continue;
            var app = a[p2 * n + p2];
            var aqq = a[q2 * n + q2];
            var theta = (aqq - app) / (2 * apq);
            var t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            var c = 1 / Math.sqrt(t * t + 1);
            var s = t * c;
            for (var k = 0; k < n; k++) {
              var akp = a[k * n + p2];
              var akq = a[k * n + q2];
              a[k * n + p2] = c * akp - s * akq;
              a[k * n + q2] = s * akp + c * akq;
            }
            for (var k2 = 0; k2 < n; k2++) {
              var apk = a[p2 * n + k2];
              var aqk = a[q2 * n + k2];
              a[p2 * n + k2] = c * apk - s * aqk;
              a[q2 * n + k2] = s * apk + c * aqk;
            }
            for (var k3 = 0; k3 < n; k3++) {
              var vkp = V[k3 * n + p2];
              var vkq = V[k3 * n + q2];
              V[k3 * n + p2] = c * vkp - s * vkq;
              V[k3 * n + q2] = s * vkp + c * vkq;
            }
          }
          if (wk.add(6 * n * (n - p2))) yield;
        }
      }
      var order = [];
      for (var j = 0; j < n; j++) order.push(j);
      order.sort(function (x, y) {
        var dv = a[y * n + y] - a[x * n + x];
        return dv !== 0 ? dv : x - y;
      });
      var values = new Float64Array(n);
      var vectors = new Float64Array(n * n);
      for (var r = 0; r < n; r++) {
        var col = order[r];
        values[r] = a[col * n + col];
        var big = 0;
        var sign = 1;
        for (var k4 = 0; k4 < n; k4++) {
          var comp = V[k4 * n + col];
          if (Math.abs(comp) > big) {
            big = Math.abs(comp);
            sign = comp < 0 ? -1 : 1;
          }
        }
        for (var k5 = 0; k5 < n; k5++) vectors[r * n + k5] = sign * V[k5 * n + col];
      }
      return { values: values, vectors: vectors };
    }

    // ----- principal directions ---------------------------------------------

    // Top-k principal directions of centred data Y (N x D).
    //   N <= D: through the N x N Gram matrix (exactly by Jacobi when N is small,
    //           otherwise by block subspace iteration on the Gram matrix).
    //   N >  D: block subspace iteration on the covariance, applied as
    //           Y^T (Y q) without forming it.
    // The reported variances are recomputed exactly along the returned
    // directions, so shares are honest even where iteration stopped early.
    // opts: { seed, maxIterations (60), tolerance (1e-6, relative change of the
    //         top-k Ritz values), oversample (k, min 4), sampleRows }
    // With sampleRows = S and N > S, the directions are fitted on S rows taken
    // at an even stride (deterministic), and the variances and shares are still
    // computed exactly over all N rows.
    // Runs makePrincipalDirections to the end: the same bytes, in one call.
    function principalDirections(Y, N, D, k, opts) {
      checkPca(Y, N, D, opts);
      return runAll(pcaGen(Y, N, D, k, opts || {}, NO_PAUSE, false));
    }

    // The same fit as a stepper { step(budgetMs?) -> done, done, progress, result }.
    // Arguments are checked here, as principalDirections checks them.
    function makePrincipalDirections(Y, N, D, k, opts) {
      checkPca(Y, N, D, opts);
      var o = opts || {};
      var wk = new Tracker(pcaWorkEstimate(N, D, k, o));
      return genStepper(pcaGen(Y, N, D, k, o, wk, false), wk);
    }

    function checkPca(Y, N, D, opts) {
      checkData(Y, N, D);
      var o = opts || {};
      var maxIt = o.maxIterations === undefined ? 60 : o.maxIterations;
      var tol = o.tolerance === undefined ? 1e-6 : o.tolerance;
      if (!(maxIt >= 0) || Math.floor(maxIt) !== maxIt) {
        throw new RangeError("maxIterations must be a non-negative integer");
      }
      if (!(tol >= 0) || !isFinite(tol)) throw new RangeError("tolerance must be a finite number >= 0");
      if (o.oversample !== undefined && (!(o.oversample >= 0) || Math.floor(o.oversample) !== o.oversample)) {
        throw new RangeError("oversample must be a non-negative integer");
      }
    }

    // A rough count of the multiply-adds a fit takes (for progress only),
    // assuming a dozen iterations.
    function pcaWorkEstimate(N, D, k, o) {
      var K = Math.max(1, Math.min(k | 0, D));
      var S = o.sampleRows | 0;
      var n = S > 0 && N > S ? S : N;
      var p = Math.min(n <= D ? n : D, K + (o.oversample === undefined ? Math.max(4, K) : o.oversample));
      var fit = n <= D ? (n * n * D) / 2 + 12 * p * n * n : 12 * 2 * n * D * p;
      return n * D + N * D + fit + K * N * D;
    }

    // pcaGen: the fit itself. `inner` marks the fit on the sampled rows, whose
    // variances the outer call recomputes over all rows, so it skips them.
    function* pcaGen(Y, N, D, k, o, wk, inner) {
      var maxIt = o.maxIterations === undefined ? 60 : o.maxIterations;
      var tol = o.tolerance === undefined ? 1e-6 : o.tolerance;
      var S = o.sampleRows | 0;
      if (S > 0 && N > S) {
        var Ys = new Float32Array(S * D);
        for (var si = 0; si < S; si++) {
          var src = Math.floor((si * N) / S) * D;
          for (var sd = 0; sd < D; sd++) Ys[si * D + sd] = Y[src + sd];
          if (wk.add(D)) yield;
        }
        var innerOpts = {};
        for (var key in o) if (key !== "sampleRows") innerOpts[key] = o[key];
        var fitted = yield* pcaGen(Ys, S, D, k, innerOpts, wk, true);
        Ys = null;
        fitted.totalVariance = yield* totalVarianceGen(Y, N, D, wk);
        fitted.method += "-sampled";
        fitted.sampledRows = S;
        yield* finishPcaGen(Y, N, D, fitted, wk);
        return fitted;
      }
      // k is clamped into 1..D. Directions beyond the data's rank (at most
      // N - 1 for centred data) are an orthonormal completion with variance 0.
      var K = Math.max(1, Math.min(k | 0, D));
      var total = yield* totalVarianceGen(Y, N, D, wk);
      var dirs = new Float32Array(K * D);
      var result = {
        count: K,
        dimension: D,
        directions: dirs,
        variances: new Float64Array(K),
        shares: new Float64Array(K),
        totalVariance: total,
        share: 0,
        method: "",
        iterations: 0,
        converged: true,
        sampledRows: N,
      };
      if (N === 0 || !(total > 0)) {
        yield* orthonormalizeGen(dirs, K, D, wk);
        result.method = "degenerate";
        if (!inner) yield* finishPcaGen(Y, N, D, result, wk);
        return result;
      }
      var seed = mixSeed(o.seed === undefined ? 0 : o.seed, SALT_PCA);
      if (N <= D) {
        var G = yield* gramGen(Y, N, D, wk);
        var vecs; // rows in N-space
        var nv = Math.min(K, N);
        if (N <= 64) {
          vecs = (yield* symmetricEigenGen(G, N, wk)).vectors;
          result.method = "gram-exact";
        } else {
          var it = yield* subspaceIterationGen(
            function (Q, p, W) {
              return denseApplyGen(G, N, Q, p, W, wk);
            },
            N,
            nv,
            o.oversample,
            seed,
            maxIt,
            tol,
            wk
          );
          vecs = it.vectors;
          result.method = "gram-iterative";
          result.iterations = it.iterations;
          result.converged = it.converged;
        }
        for (var j = 0; j < nv; j++) {
          var oj = j * D;
          for (var a = 0; a < N; a++) {
            var w = vecs[j * N + a];
            if (w === 0) continue;
            var oa = a * D;
            for (var d = 0; d < D; d++) dirs[oj + d] += w * Y[oa + d];
            if (wk.add(D)) yield;
          }
        }
        yield* orthonormalizeGen(dirs, K, D, wk);
      } else {
        var it2 = yield* subspaceIterationGen(
          function (Q, p, W) {
            return covarianceApplyGen(Y, N, D, Q, p, W, wk);
          },
          D,
          K,
          o.oversample,
          seed,
          maxIt,
          tol,
          wk
        );
        for (var j2 = 0; j2 < K * D; j2++) dirs[j2] = it2.vectors[j2];
        yield* orthonormalizeGen(dirs, K, D, wk);
        result.method = "covariance-iterative";
        result.iterations = it2.iterations;
        result.converged = it2.converged;
      }
      if (!inner) yield* finishPcaGen(Y, N, D, result, wk);
      return result;
    }

    // Exact variances and shares along the result's directions, over all rows.
    // Shares are clamped to [0, 1] (rounding can otherwise overshoot 1 slightly).
    function* finishPcaGen(Y, N, D, result, wk) {
      var K = result.count;
      var total = result.totalVariance;
      var sums = yield* projectedSquaresGen(Y, N, D, result.directions, K, wk);
      var s = 0;
      for (var r = 0; r < K; r++) {
        var v = N > 0 ? sums[r] / N : 0;
        result.variances[r] = v;
        result.shares[r] = total > 0 ? clamp01(v / total) : 0;
        s += result.shares[r];
      }
      result.share = clamp01(s);
    }

    function gram(Y, N, D) {
      return runAll(gramGen(Y, N, D, NO_PAUSE));
    }

    function* gramGen(Y, N, D, wk) {
      var G = new Float64Array(N * N);
      for (var a = 0; a < N; a++) {
        var oa = a * D;
        for (var b = a; b < N; b++) {
          var ob = b * D;
          var s = 0;
          for (var d = 0; d < D; d++) s += Y[oa + d] * Y[ob + d];
          G[a * N + b] = s;
          G[b * N + a] = s;
        }
        if (wk.add((N - a) * D)) yield;
      }
      return G;
    }

    // W (p rows of length n) = A Q for symmetric dense A (n x n), Q given as rows.
    function* denseApplyGen(A, n, Q, p, W, wk) {
      for (var j = 0; j < p; j++) {
        var oj = j * n;
        for (var a = 0; a < n; a++) {
          var s = 0;
          var oa = a * n;
          for (var b = 0; b < n; b++) s += A[oa + b] * Q[oj + b];
          W[oj + a] = s;
          if (wk.add(n)) yield;
        }
      }
    }

    // W (p rows of length D) = Y^T (Y Q^T)^T, i.e. the covariance (times N)
    // applied to each row of Q, without forming the D x D matrix.
    function* covarianceApplyGen(Y, N, D, Q, p, W, wk) {
      // Rows of Y are taken four at a time so each pass over Q and W serves
      // four points (a quarter of the memory traffic). A missing row at the end
      // repeats the last real row with weight zero. The order of additions is
      // fixed, so the result is still deterministic.
      W.fill(0);
      var z = new Float64Array(4 * p);
      for (var i = 0; i < N; i += 4) {
        var oa = i * D;
        var ob = i + 1 < N ? oa + D : oa;
        var oc = i + 2 < N ? oa + 2 * D : oa;
        var od = i + 3 < N ? oa + 3 * D : oa;
        for (var j = 0; j < p; j++) {
          var sa = 0;
          var sb = 0;
          var sc = 0;
          var sd = 0;
          var oj = j * D;
          for (var d = 0; d < D; d++) {
            var q = Q[oj + d];
            sa += Y[oa + d] * q;
            sb += Y[ob + d] * q;
            sc += Y[oc + d] * q;
            sd += Y[od + d] * q;
          }
          z[4 * j] = sa;
          z[4 * j + 1] = i + 1 < N ? sb : 0;
          z[4 * j + 2] = i + 2 < N ? sc : 0;
          z[4 * j + 3] = i + 3 < N ? sd : 0;
        }
        for (var j2 = 0; j2 < p; j2++) {
          var a = z[4 * j2];
          var b = z[4 * j2 + 1];
          var c = z[4 * j2 + 2];
          var e = z[4 * j2 + 3];
          var o2 = j2 * D;
          for (var d2 = 0; d2 < D; d2++) {
            W[o2 + d2] += a * Y[oa + d2] + b * Y[ob + d2] + (c * Y[oc + d2] + e * Y[od + d2]);
          }
        }
        if (wk.add(8 * p * D)) yield;
      }
    }

    // Block subspace iteration with Rayleigh-Ritz for the top k eigenvectors
    // of a symmetric positive semi-definite operator on R^n. Deterministic for
    // a given seed. `applyGen(Q, p, W)` returns a generator that fills W.
    // Returns { vectors: Float64Array(k*n) rows, values, iterations, converged }.
    function* subspaceIterationGen(applyGen, n, k, oversample, seed, maxIt, tol, wk) {
      var extra = oversample === undefined ? Math.max(4, k) : oversample;
      var p = Math.min(n, k + extra);
      var rng = makeRandom(seed);
      var Q = new Float64Array(p * n);
      rng.fillGauss(Q, 0, p * n);
      yield* orthonormalizeGen(Q, p, n, wk);
      var W = new Float64Array(p * n);
      var B = new Float64Array(p * p);
      var prev = null;
      var eig = null;
      var iterations = 0;
      var converged = false;
      for (var it = 0; it <= maxIt; it++) {
        yield* applyGen(Q, p, W);
        iterations = it + 1;
        for (var a = 0; a < p; a++) {
          for (var b = a; b < p; b++) {
            var s = 0;
            for (var x = 0; x < n; x++) s += Q[a * n + x] * W[b * n + x];
            B[a * p + b] = s;
            B[b * p + a] = s;
          }
          if (wk.add((p - a) * n)) yield;
        }
        eig = yield* symmetricEigenGen(B, p, wk);
        if (prev) {
          var worst = 0;
          for (var r = 0; r < k; r++) {
            var dv = Math.abs(eig.values[r] - prev[r]);
            if (dv > worst) worst = dv;
          }
          if (worst <= tol * Math.max(eig.values[0], 1e-300)) {
            converged = true;
            break;
          }
        }
        if (it === maxIt) break;
        prev = eig.values;
        var tmp = Q;
        Q = W;
        W = tmp;
        yield* orthonormalizeGen(Q, p, n, wk);
      }
      var vectors = new Float64Array(k * n);
      for (var r2 = 0; r2 < k; r2++) {
        for (var c = 0; c < p; c++) {
          var w = eig.vectors[r2 * p + c];
          if (w === 0) continue;
          for (var x2 = 0; x2 < n; x2++) vectors[r2 * n + x2] += w * Q[c * n + x2];
          if (wk.add(n)) yield;
        }
      }
      return { vectors: vectors, values: eig.values.slice(0, k), iterations: iterations, converged: converged };
    }

    // ----- the guided tour (Tumble) ------------------------------------------

    // A tour through an m-dimensional subspace spanned by orthonormal `basis`
    // rows (m * D). The frame at time t is a closed-form function of
    // (basis, seed, speed, t): F(t) = E L(t) P basis, where P is a seeded random
    // m x m rotation, L(t) turns m/2 planes at seeded frequencies, and E picks
    // the start so that F(0) is the first three basis rows. There is no state:
    // frameAt(t) gives the same frame however time has been sliced.
    // opts: { seed (0), speed (0.42 rad/s, the reference's rate) }
    function makeTour(basis, m, D, opts) {
      checkDim(D);
      if (!(m >= 3)) throw new RangeError("a tour needs at least three directions");
      if (m > D) throw new RangeError("a tour cannot use more directions than the dimension");
      var o = opts || {};
      var seed = toSeed(o.seed === undefined ? 0 : o.seed);
      var speed = o.speed === undefined ? 0.42 : o.speed;
      var rng = makeRandom(mixSeed(seed, SALT_TOUR));
      var P = new Float64Array(m * m);
      rng.fillGauss(P, 0, m * m);
      orthonormalize(P, m, m);
      var planes = Math.floor(m / 2);
      var freq = new Float64Array(planes);
      for (var h = 0; h < planes; h++) {
        var mag = speed * (0.55 + 0.9 * rng.next());
        freq[h] = rng.next() < 0.5 ? -mag : mag;
      }
      // E = first three rows of P^T: E[r][c] = P[c][r].
      var E = new Float64Array(3 * m);
      for (var r = 0; r < 3; r++) for (var c = 0; c < m; c++) E[r * m + c] = P[c * m + r];
      var L = new Float64Array(3 * m);
      var A = new Float64Array(3 * m);
      var F64 = new Float64Array(3 * D);
      var basisCopy = new Float32Array(basis.subarray ? basis.subarray(0, m * D) : basis.slice(0, m * D));

      // A(t): the 3 x m coefficients of the frame in the basis. Rows orthonormal.
      function coefficientsAt(t, out) {
        var res = out || new Float64Array(3 * m);
        for (var i = 0; i < 3 * m; i++) L[i] = E[i];
        for (var hh = 0; hh < planes; hh++) {
          var ang = freq[hh] * t;
          var cs = Math.cos(ang);
          var sn = Math.sin(ang);
          var c0 = 2 * hh;
          for (var rr = 0; rr < 3; rr++) {
            var x = E[rr * m + c0];
            var y = E[rr * m + c0 + 1];
            L[rr * m + c0] = cs * x - sn * y;
            L[rr * m + c0 + 1] = sn * x + cs * y;
          }
        }
        for (var r2 = 0; r2 < 3; r2++) {
          for (var c2 = 0; c2 < m; c2++) {
            var s = 0;
            for (var q = 0; q < m; q++) s += L[r2 * m + q] * P[q * m + c2];
            res[r2 * m + c2] = s;
          }
        }
        orthonormalize(res, 3, m);
        return res;
      }

      function frameAt(t, out) {
        if (typeof t !== "number" || !isFinite(t)) throw new RangeError("time must be a finite number");
        var F = out || new Float32Array(3 * D);
        coefficientsAt(t, A);
        F64.fill(0);
        for (var r3 = 0; r3 < 3; r3++) {
          var orow = r3 * D;
          for (var j = 0; j < m; j++) {
            var w = A[r3 * m + j];
            var ob = j * D;
            for (var d = 0; d < D; d++) F64[orow + d] += w * basisCopy[ob + d];
          }
        }
        orthonormalize(F64, 3, D);
        for (var i2 = 0; i2 < 3 * D; i2++) F[i2] = F64[i2];
        orthonormalize(F, 3, D);
        return F;
      }

      return {
        kind: "guided-tour",
        seed: seed,
        speed: speed,
        dimension: D,
        subspace: m,
        basis: basisCopy,
        frequencies: freq,
        coefficientsAt: coefficientsAt,
        frameAt: frameAt,
      };
    }

    // The guided tour over data: principal directions first, then a tour inside
    // them. Reports the share of total variance held by the toured directions.
    // opts: { seed (0), subspace (8), speed, pca (a principalDirections result
    //         to reuse); sampleRows, maxIterations, tolerance and oversample are
    //         passed to principalDirections }
    // Runs makeGuidedTour to the end: the same tour, in one call.
    function guidedTour(Y, N, D, opts) {
      var o = opts || {};
      var m = checkGuidedTour(Y, N, D, o);
      return runAll(guidedTourGen(Y, N, D, o, m, NO_PAUSE));
    }

    // The same as a stepper { step(budgetMs?) -> done, done, progress, result }
    // whose result is the tour.
    function makeGuidedTour(Y, N, D, opts) {
      var o = opts || {};
      var m = checkGuidedTour(Y, N, D, o);
      var est = needsFit(o.pca, m, D) ? pcaWorkEstimate(N, D, m, o) : 1;
      var wk = new Tracker(est);
      return genStepper(guidedTourGen(Y, N, D, o, m, wk), wk);
    }

    function needsFit(pca, m, D) {
      return !pca || pca.count < m || pca.dimension !== D;
    }

    function tourPcaOpts(o) {
      return {
        seed: o.seed,
        sampleRows: o.sampleRows,
        maxIterations: o.maxIterations,
        tolerance: o.tolerance,
        oversample: o.oversample,
      };
    }

    function checkGuidedTour(Y, N, D, o) {
      checkData(Y, N, D);
      var m = Math.min(o.subspace === undefined ? 8 : o.subspace | 0, D);
      if (m < 3) throw new RangeError("a guided tour needs a subspace of at least three directions");
      if (needsFit(o.pca, m, D)) checkPca(Y, N, D, tourPcaOpts(o));
      return m;
    }

    function* guidedTourGen(Y, N, D, o, m, wk) {
      var pca = o.pca;
      if (needsFit(pca, m, D)) pca = yield* pcaGen(Y, N, D, m, tourPcaOpts(o), wk, false);
      var basis = pca.directions.subarray(0, m * D);
      var tour = makeTour(basis, m, D, { seed: o.seed, speed: o.speed });
      var share = 0;
      for (var j = 0; j < m; j++) share += pca.shares[j];
      tour.kind = "guided-tour";
      tour.varianceShare = clamp01(share);
      tour.variances = pca.variances.slice(0, m);
      tour.totalVariance = pca.totalVariance;
      tour.pca = pca;
      return tour;
    }

    // ----- axis swap (Lattice) ------------------------------------------------

    // A unit vector orthogonal to the frame's three rows, drawn from rng. When
    // `basis` (m rows) is given it is drawn inside that subspace; if that leaves
    // nothing orthogonal it falls back to the full space.
    function hiddenDirection(frame, D, rng, basis, m, out) {
      var h = out || new Float32Array(D);
      var v = new Float64Array(4 * D);
      for (var i = 0; i < 3 * D; i++) v[i] = frame[i];
      for (var attempt = 0; attempt < 8; attempt++) {
        var useBasis = basis && m > 3 && attempt < 4;
        if (useBasis) {
          for (var d = 0; d < D; d++) v[3 * D + d] = 0;
          for (var j = 0; j < m; j++) {
            var g = rng.gauss();
            for (var d2 = 0; d2 < D; d2++) v[3 * D + d2] += g * basis[j * D + d2];
          }
        } else {
          rng.fillGauss(v, 3 * D, D);
        }
        var before = 0;
        for (var d3 = 0; d3 < D; d3++) before += v[3 * D + d3] * v[3 * D + d3];
        for (var pass = 0; pass < 2; pass++) {
          for (var r = 0; r < 3; r++) {
            var dp = 0;
            for (var d4 = 0; d4 < D; d4++) dp += v[3 * D + d4] * v[r * D + d4];
            for (var d5 = 0; d5 < D; d5++) v[3 * D + d5] -= dp * v[r * D + d5];
          }
        }
        var nn = 0;
        for (var d6 = 0; d6 < D; d6++) nn += v[3 * D + d6] * v[3 * D + d6];
        if (nn > 1e-12 * before && nn > 0) {
          var inv = 1 / Math.sqrt(nn);
          for (var d7 = 0; d7 < D; d7++) h[d7] = v[3 * D + d7] * inv;
          return h;
        }
      }
      if (D <= 3) throw new RangeError("no hidden direction exists when the dimension is three or less");
      orthonormalize(v, 4, D);
      for (var d8 = 0; d8 < D; d8++) h[d8] = v[3 * D + d8];
      return h;
    }

    // The eased quarter turn of the reference: theta = (pi/2)(u - sin(2 pi u)/(2 pi)).
    function swapAngle(u) {
      var x = u <= 0 ? 0 : u >= 1 ? 1 : u;
      return (Math.PI / 2) * (x - Math.sin(TAU * x) / TAU);
    }

    // Pure swap step: copy `start` to out and replace row `axis` with
    // cos(theta) * start[axis] + sin(theta) * hidden, theta = swapAngle(u).
    // At u >= 1 the row is exactly `hidden`.
    function swapStep(start, axis, hidden, u, D, out) {
      var F = out || new Float32Array(3 * D);
      if (F !== start) for (var i = 0; i < 3 * D; i++) F[i] = start[i];
      var o = axis * D;
      if (u >= 1) {
        for (var d = 0; d < D; d++) F[o + d] = hidden[d];
      } else {
        var th = swapAngle(u);
        var c = Math.cos(th);
        var s = Math.sin(th);
        for (var d2 = 0; d2 < D; d2++) F[o + d2] = c * start[o + d2] + s * hidden[d2];
      }
      return F;
    }

    // A schedule of swaps: during cycle c = floor(t / period), axis c mod 3
    // turns a quarter turn into a hidden direction drawn from the stream
    // mixSeed(seed ^ SALT_SWAP, c). frameAt(t) is a pure function of (frame0, seed, period,
    // basis, t); when time goes backwards it replays cycle starts from the nearest
    // kept one (bounded memory: at most 33 kept frames).
    // opts: { seed (0), period (3.4 s, the reference's), basis, basisRows }
    var SWAP_CHECKPOINT_SPACING = 16; // cycles between kept cycle starts at first
    var SWAP_CHECKPOINTS = 32;
    function makeSwapTour(frame0, D, opts) {
      checkDim(D);
      if (D < 4) throw new RangeError("axis swaps need a dimension of at least four");
      var o = opts || {};
      var seed = toSeed(o.seed === undefined ? 0 : o.seed);
      var period = o.period === undefined ? 3.4 : o.period;
      if (!(period > 0)) throw new RangeError("period must be positive");
      var basis = o.basis || null;
      var basisRows = 0;
      if (basis) {
        basisRows = o.basisRows;
        if (!(basisRows >= 3 && basisRows <= D) || Math.floor(basisRows) !== basisRows || basis.length !== basisRows * D) {
          throw new RangeError("makeSwapTour: basis needs basisRows (3..dimension) with basis.length = basisRows * dimension");
        }
      }
      var first = new Float32Array(3 * D);
      for (var i = 0; i < 3 * D; i++) first[i] = frame0[i];
      orthonormalize(first, 3, D);
      var start = new Float32Array(first);
      var hidden = new Float32Array(D);
      var cycle = -1;
      // Cycle starts kept so that a backward seek replays from the nearest one, not
      // from frame0: at most SWAP_CHECKPOINTS (besides cycle 0), spaced further
      // apart as the tour goes on. A replay from one gives the same bits as a
      // replay from frame0 (the same steps on the same values).
      var marks = [{ c: 0, start: first }];
      var spacing = SWAP_CHECKPOINT_SPACING;
      var steps = 0; // swap steps computed in all, for tests

      function keep() {
        if (cycle % spacing !== 0) return;
        var at = marks.length;
        while (at > 0 && marks[at - 1].c > cycle) at--;
        if (marks[at - 1].c === cycle) return;
        marks.splice(at, 0, { c: cycle, start: new Float32Array(start) });
        if (marks.length > SWAP_CHECKPOINTS + 1) {
          spacing *= 2;
          marks = marks.filter(function (m) {
            return m.c % spacing === 0;
          });
        }
      }

      function enterCycle(c) {
        var near = marks[0];
        for (var i = marks.length - 1; i >= 0; i--) {
          if (marks[i].c <= c) {
            near = marks[i];
            break;
          }
        }
        if (c < cycle || cycle < 0 || near.c > cycle) {
          start.set(near.start);
          cycle = near.c;
          hiddenDirection(start, D, makeRandom(mixSeed(seed ^ SALT_SWAP, cycle)), basis, basisRows, hidden);
        }
        while (cycle < c) {
          swapStep(start, cycle % 3, hidden, 1, D, start);
          orthonormalize(start, 3, D);
          cycle++;
          steps++;
          hiddenDirection(start, D, makeRandom(mixSeed(seed ^ SALT_SWAP, cycle)), basis, basisRows, hidden);
          keep();
        }
      }

      function stateAt(t) {
        if (typeof t !== "number" || !isFinite(t)) throw new RangeError("time must be a finite number");
        var x = t < 0 ? 0 : t / period;
        var c = Math.floor(x);
        enterCycle(c);
        return { cycle: c, axis: c % 3, u: x - c };
      }

      function frameAt(t, out) {
        var st = stateAt(t);
        return swapStep(start, st.axis, hidden, st.u, D, out || new Float32Array(3 * D));
      }

      return {
        kind: "axis-swap",
        seed: seed,
        period: period,
        dimension: D,
        stateAt: stateAt,
        frameAt: frameAt,
        hiddenAt: function (t) {
          stateAt(t);
          return new Float32Array(hidden);
        },
        steps: function () {
          return steps;
        },
        checkpoints: function () {
          return marks.length;
        },
      };
    }

    // ----- true nearest neighbours -------------------------------------------

    // Exact k nearest neighbours by Euclidean distance in the full D-dimensional
    // space, among the first `limit` points (default N). Ties go to the lower
    // index. Cost: O(limit^2 * D) multiply-adds in total, done row by row so a
    // caller can spread it over many slices with step(rows).
    // Returns a stepper { k, count, indices: Int32Array(count*k),
    // distances: Float32Array(count*k), next, done, step(rows) -> done }.
    function makeKnn(X, N, D, k, opts) {
      checkData(X, N, D);
      var o = opts || {};
      var S = o.limit === undefined ? N : Math.max(0, Math.min(N, o.limit | 0));
      var K = Math.max(0, Math.min(k | 0, S - 1));
      var indices = new Int32Array(S * K);
      var distances = new Float32Array(S * K);
      var bestD = new Float64Array(K + 1);
      var bestI = new Int32Array(K + 1);
      // With k = 0 there is nothing to find: the stepper starts finished.
      var state = { k: K, count: S, dimension: D, indices: indices, distances: distances, next: 0, done: false };
      if (K === 0) {
        state.next = S;
        state.done = true;
      }

      function row(i) {
        var filled = 0;
        var oi = i * D;
        for (var j = 0; j < S; j++) {
          if (j === i) continue;
          var oj = j * D;
          var bound = filled === K ? bestD[K - 1] : Infinity;
          var s = 0;
          var d = 0;
          // Partial sums with an exact early exit: once the running sum exceeds
          // the current k-th best, j cannot enter the list.
          while (d < D) {
            var end = d + 64 < D ? d + 64 : D;
            for (; d < end; d++) {
              var t = X[oi + d] - X[oj + d];
              s += t * t;
            }
            if (s > bound) break;
          }
          if (s > bound || (filled === K && s === bound && j > bestI[K - 1])) continue;
          // insert j, keeping (distance, index) ascending
          var pos = filled < K ? filled : K - 1;
          while (pos > 0 && (bestD[pos - 1] > s || (bestD[pos - 1] === s && bestI[pos - 1] > j))) {
            bestD[pos] = bestD[pos - 1];
            bestI[pos] = bestI[pos - 1];
            pos--;
          }
          bestD[pos] = s;
          bestI[pos] = j;
          if (filled < K) filled++;
        }
        for (var q = 0; q < K; q++) {
          indices[i * K + q] = bestI[q];
          distances[i * K + q] = Math.sqrt(bestD[q]);
        }
      }

      state.step = function (rows) {
        var r = rows === undefined ? S : Math.max(1, rows | 0);
        if (state.done) return true;
        var stop = Math.min(S, state.next + r);
        for (var i = state.next; i < stop; i++) row(i);
        state.next = stop;
        state.done = stop >= S;
        return state.done;
      };
      return state;
    }

    // All at once: makeKnn(...).step() to completion.
    function knn(X, N, D, k, opts) {
      var s = makeKnn(X, N, D, k, opts);
      s.step();
      return s;
    }

    // ----- local frames and alignment (Wander) ------------------------------

    // Three axes fitted to a neighbourhood: the top three principal directions
    // of the points `ids` (the point itself and its neighbours), from their
    // Gram matrix. Deterministic. Returns Float32Array(3 * D), orthonormal.
    // ids must be integers in 0..N-1 (at least one); anything else is a caller
    // bug and throws RangeError.
    function localFrame(X, N, D, ids, out) {
      checkLocalFrame(X, N, D, ids);
      return runAll(localFrameGen(X, N, D, ids, out, NO_PAUSE));
    }

    // The same as a stepper whose result is localFrame's frame, bit for bit.
    function makeLocalFrame(X, N, D, ids, out) {
      checkLocalFrame(X, N, D, ids);
      var M = ids.length;
      var wk = new Tracker(M * M * D + 4 * M * D + 50 * M * M * M);
      return genStepper(localFrameGen(X, N, D, ids, out, wk), wk);
    }

    function checkLocalFrame(X, N, D, ids) {
      checkData(X, N, D);
      var M = ids.length;
      if (!(M >= 1)) throw new RangeError("localFrame needs at least one point id");
      for (var q = 0; q < M; q++) {
        var id = ids[q];
        if (!(id >= 0 && id < N) || Math.floor(id) !== id) {
          throw new RangeError("localFrame: point id " + id + " is outside 0.." + (N - 1));
        }
      }
    }

    function* localFrameGen(X, N, D, ids, out, wk) {
      var M = ids.length;
      var mean = new Float64Array(D);
      for (var a = 0; a < M; a++) {
        var oa = ids[a] * D;
        for (var d = 0; d < D; d++) mean[d] += X[oa + d];
      }
      for (var d1 = 0; d1 < D; d1++) mean[d1] /= M;
      var Yl = new Float64Array(M * D);
      for (var a2 = 0; a2 < M; a2++) {
        var oa2 = ids[a2] * D;
        for (var d2 = 0; d2 < D; d2++) Yl[a2 * D + d2] = X[oa2 + d2] - mean[d2];
      }
      if (wk.add(2 * M * D)) yield;
      var G = yield* gramGen(Yl, M, D, wk);
      var eig = yield* symmetricEigenGen(G, M, wk);
      var F64 = new Float64Array(3 * D);
      var axes = Math.min(3, M);
      for (var ax = 0; ax < axes; ax++) {
        if (!(eig.values[ax] > 1e-12 * Math.max(eig.values[0], 1e-300))) continue;
        for (var b = 0; b < M; b++) {
          var w = eig.vectors[ax * M + b];
          for (var d3 = 0; d3 < D; d3++) F64[ax * D + d3] += w * Yl[b * D + d3];
        }
        if (wk.add(M * D)) yield;
      }
      orthonormalize(F64, 3, D);
      var F = out || new Float32Array(3 * D);
      for (var i = 0; i < 3 * D; i++) F[i] = F64[i];
      return orthonormalize(F, 3, D);
    }

    var PERMS = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];

    // Ported from the reference: reorder and flip target's axes so that the
    // flight from ref to it twists as little as possible. Ties go to the first
    // permutation in a fixed order. Returns a new Float32Array(3 * D).
    function alignTo(target, ref, D) {
      var m = new Float64Array(9);
      for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
          var dp = 0;
          for (var d = 0; d < D; d++) dp += target[i * D + d] * ref[j * D + d];
          m[i * 3 + j] = dp;
        }
      }
      var best = PERMS[0];
      var bestScore = -1;
      for (var p = 0; p < PERMS.length; p++) {
        var pr = PERMS[p];
        var sc = Math.abs(m[pr[0] * 3]) + Math.abs(m[pr[1] * 3 + 1]) + Math.abs(m[pr[2] * 3 + 2]);
        if (sc > bestScore) {
          bestScore = sc;
          best = pr;
        }
      }
      var out = new Float32Array(3 * D);
      for (var j2 = 0; j2 < 3; j2++) {
        var src = best[j2];
        var sign = m[src * 3 + j2] < 0 ? -1 : 1;
        for (var d2 = 0; d2 < D; d2++) out[j2 * D + d2] = sign * target[src * D + d2];
      }
      return out;
    }

    function smoothstep(u) {
      var x = u <= 0 ? 0 : u >= 1 ? 1 : u;
      return x * x * (3 - 2 * x);
    }

    // The reference's flight between frames: blend row by row with weight e
    // (0 gives `from`, 1 gives `to`) and re-orthonormalise. Pure.
    function blendFrames(from, to, e, D, out) {
      var F64 = new Float64Array(3 * D);
      for (var i = 0; i < 3 * D; i++) F64[i] = from[i] + (to[i] - from[i]) * e;
      orthonormalize(F64, 3, D);
      var F = out || new Float32Array(3 * D);
      for (var i2 = 0; i2 < 3 * D; i2++) F[i2] = F64[i2];
      return orthonormalize(F, 3, D);
    }

    // ----- group separation ---------------------------------------------------

    // Mean distance between points of different groups divided by mean distance
    // between points of the same group, over all pairs (the probe's measure;
    // 1.0 means no visible grouping). P holds N points of `dim` coordinates.
    // Labels that are "", null or undefined are ungrouped and left out.
    // Returns NaN when there are no within-group or no between-group pairs;
    // Infinity when all same-group pairs coincide but groups are apart; 1 when
    // every grouped point coincides.
    function groupSeparation(P, N, dim, groups) {
      var within = 0;
      var nWithin = 0;
      var between = 0;
      var nBetween = 0;
      for (var i = 0; i < N; i++) {
        var gi = groups[i];
        if (gi === "" || gi === null || gi === undefined) continue;
        var oi = i * dim;
        for (var j = i + 1; j < N; j++) {
          var gj = groups[j];
          if (gj === "" || gj === null || gj === undefined) continue;
          var oj = j * dim;
          var s = 0;
          for (var d = 0; d < dim; d++) {
            var t = P[oi + d] - P[oj + d];
            s += t * t;
          }
          var dist = Math.sqrt(s);
          if (gi === gj) {
            within += dist;
            nWithin++;
          } else {
            between += dist;
            nBetween++;
          }
        }
      }
      if (nWithin === 0 || nBetween === 0) return NaN;
      // Every same-group pair coincides: Infinity when the groups are apart,
      // 1 (nothing to see) when everything coincides.
      if (within === 0) return between > 0 ? Infinity : 1;
      return between / nBetween / (within / nWithin);
    }

    // Group separation of the data as seen through one frame.
    function frameSeparation(Y, N, D, frame, groups) {
      return groupSeparation(project(Y, N, D, frame, null), N, 3, groups);
    }

    return {
      mulberry32: mulberry32,
      toSeed: toSeed,
      mixSeed: mixSeed,
      makeRandom: makeRandom,
      meanOf: meanOf,
      centre: centre,
      makeCentre: makeCentre,
      totalVariance: totalVariance,
      varianceShare: varianceShare,
      orthonormalize: orthonormalize,
      frameError: frameError,
      randomFrame: randomFrame,
      project: project,
      symmetricEigen: symmetricEigen,
      principalDirections: principalDirections,
      makePrincipalDirections: makePrincipalDirections,
      makeTour: makeTour,
      guidedTour: guidedTour,
      makeGuidedTour: makeGuidedTour,
      hiddenDirection: hiddenDirection,
      swapAngle: swapAngle,
      swapStep: swapStep,
      makeSwapTour: makeSwapTour,
      makeKnn: makeKnn,
      knn: knn,
      localFrame: localFrame,
      makeLocalFrame: makeLocalFrame,
      alignTo: alignTo,
      smoothstep: smoothstep,
      blendFrames: blendFrames,
      groupSeparation: groupSeparation,
      frameSeparation: frameSeparation,
    };
  })();

// ---------------------------------------------------------------------------
// 20-contract.js: data contract loader and validator (schema version 1).
// Pure functions: no file, network or DOM access. See docs/data-contract.md
// (the authority) and js/api/20-contract.md (the interface).
// ---------------------------------------------------------------------------
(function () {
  var SUPPORTED = [1];
  var KIND = "embeddings-tumbler/data";
  var MAX_INT = 9007199254740991;
  var ENDPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
  var PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  var MESSAGES = {
    "wrong-kind":
      'Not an embeddings-tumbler data set: "kind" must be "embeddings-tumbler/data".',
    "schema-version":
      "Data schema version {found} is not supported; this viewer reads schema version {supported}.",
    "invalid-field": 'Field "{field}" is missing or not valid.',
    "vector-file-path":
      'Vector file "{file}" must be a plain file name in the same folder as the data file.',
    "endpoint-is-address":
      '"provenance.endpoint" must name the embedding route, not give a network address.',
    "block-unreadable": 'Vector file "{file}" could not be read.',
    "count-mismatch": '"count" is {count} but the data has {found} point records.',
    "duplicate-id": 'Point id "{id}" appears more than once.',
    "block-length":
      "Vector block is {found} bytes; expected {count} points x {dimension} dimensions x 4 bytes = {expected} bytes.",
    "non-finite": 'Vector of point "{id}" contains a value that is not a finite number.',
    "append-without-base":
      "Cannot append: the view holds no data set yet. Send a full set first.",
    "model-mismatch":
      'Cannot append: model "{found}" differs from the view\'s model "{expected}". One view shows one model.',
    "dimension-mismatch":
      "Cannot append: dimension {found} differs from the view's dimension {expected}.",
    "reduction-mismatch":
      'Cannot append: reduction "{found}" differs from the view\'s reduction "{expected}".',
    "id-exists": 'Cannot append: point id "{id}" is already in the view.',
  };

  function fill(code, values) {
    return MESSAGES[code].replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(values || {}, name) ? String(values[name]) : m;
    });
  }

  // The base set is returned with every refusal so the caller keeps what it holds.
  function refuse(code, values, base) {
    return { ok: false, code: code, message: fill(code, values), set: base || null };
  }

  function tag(v) {
    return Object.prototype.toString.call(v);
  }
  function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function isInt(v) {
    return typeof v === "number" && isFinite(v) && Math.floor(v) === v && Math.abs(v) <= MAX_INT;
  }
  function isNonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
  }
  function isStringList(v) {
    if (!Array.isArray(v)) return false;
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
    return true;
  }
  function isFloat32Array(v) {
    return tag(v) === "[object Float32Array]";
  }
  function isArrayBuffer(v) {
    return tag(v) === "[object ArrayBuffer]";
  }
  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function jsonText(v) {
    try {
      var s = JSON.stringify(v);
      return s === undefined ? "missing" : s;
    } catch (e) {
      return String(v);
    }
  }

  // Deep copy of JSON-like data, so the set never shares objects with the host.
  function clone(v) {
    if (Array.isArray(v)) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(clone(v[i]));
      return a;
    }
    if (v !== null && typeof v === "object") {
      var o = {};
      var keys = Object.keys(v);
      // defineProperty, not assignment: a key named "__proto__" stays a key.
      for (var j = 0; j < keys.length; j++) {
        Object.defineProperty(o, keys[j], { value: clone(v[keys[j]]), writable: true, enumerable: true, configurable: true });
      }
      return o;
    }
    return v;
  }

  // Returns the path of the first invalid field, or null. `form` is "memory" or "file".
  function firstInvalidField(d, op, form) {
    if (op !== undefined && op !== "replace" && op !== "append") return "op";
    var isAppend = op === "append";
    if (!isNonEmptyString(d.model)) return "model";
    if (!isInt(d.dimension) || d.dimension < 1) return "dimension";
    if (!isInt(d.count) || d.count < 0) return "count";
    if (typeof d.text_included !== "boolean") return "text_included";

    var p = d.provenance;
    if (p !== undefined || !isAppend) {
      if (!isObject(p)) return "provenance";
      if (!isNonEmptyString(p.source)) return "provenance.source";
      if (!isNonEmptyString(p.producer)) return "provenance.producer";
      if (typeof p.synthetic !== "boolean") return "provenance.synthetic";
      if (!has(p, "seed") || !(p.seed === null || isInt(p.seed))) return "provenance.seed";
      if (!isStringList(p.limitations)) return "provenance.limitations";
      if (!isStringList(p.uncertain)) return "provenance.uncertain";
      if (p.created !== undefined && typeof p.created !== "string") return "provenance.created";
      if (p.endpoint !== undefined && !isNonEmptyString(p.endpoint)) return "provenance.endpoint";
      if (p.params !== undefined && !isObject(p.params)) return "provenance.params";
    }

    var r = d.reduction;
    if (r !== undefined) {
      if (!isObject(r)) return "reduction";
      if (r.kind !== "none" && r.kind !== "rotation" && r.kind !== "top-k") return "reduction.kind";
      if (!isInt(r.source_dimension) || r.source_dimension < 1) return "reduction.source_dimension";
      if (!isInt(r.directions_kept) || r.directions_kept < 1) return "reduction.directions_kept";
      if (
        typeof r.variance_dropped !== "number" ||
        !isFinite(r.variance_dropped) ||
        r.variance_dropped < 0 ||
        r.variance_dropped > 1
      )
        return "reduction.variance_dropped";
      if (r.directions_kept !== d.dimension) return "reduction";
      if (r.kind === "top-k") {
        if (!(d.dimension < r.source_dimension) || !(r.variance_dropped < 1)) return "reduction";
      } else if (r.source_dimension !== d.dimension || r.variance_dropped !== 0) {
        return "reduction";
      }
    }

    var v = d.vectors;
    if (form === "file") {
      if (!isObject(v)) return "vectors";
      if (!isNonEmptyString(v.file)) return "vectors.file";
      if (v.dtype !== "float32") return "vectors.dtype";
      if (v.byte_order !== "little") return "vectors.byte_order";
      if (!isInt(v.byte_length) || v.byte_length !== d.count * d.dimension * 4) {
        return "vectors.byte_length";
      }
    } else if (!isFloat32Array(v) && !isArrayBuffer(v)) {
      return "vectors";
    }

    var pts = d.points;
    if (!Array.isArray(pts)) return "points";
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      if (!isObject(pt)) return "points[" + i + "]";
      if (!isNonEmptyString(pt.id)) return "points[" + i + "].id";
      if (typeof pt.label !== "string") return "points[" + i + "].label";
      if (pt.group !== undefined && typeof pt.group !== "string") return "points[" + i + "].group";
      if (pt.metadata !== undefined && !isObject(pt.metadata)) return "points[" + i + "].metadata";
    }
    return null;
  }

  // Checks 1 to 7 of the contract (everything that needs no vector block).
  function checkRecordsInner(d, form, base) {
    if (!isObject(d) || d.kind !== KIND) return refuse("wrong-kind", {}, base);
    if (!isInt(d.schema_version) || SUPPORTED.indexOf(d.schema_version) < 0) {
      return refuse(
        "schema-version",
        {
          found: has(d, "schema_version") ? jsonText(d.schema_version) : "missing",
          supported: SUPPORTED.join(", "),
        },
        base
      );
    }
    var bad = firstInvalidField(d, d.op, form);
    if (bad !== null) return refuse("invalid-field", { field: bad }, base);
    if (form === "file" && !PLAIN_NAME.test(d.vectors.file)) {
      return refuse("vector-file-path", { file: d.vectors.file }, base);
    }
    if (d.provenance !== undefined && d.provenance.endpoint !== undefined) {
      if (!ENDPOINT_NAME.test(d.provenance.endpoint)) return refuse("endpoint-is-address", {}, base);
    }
    if (d.count !== d.points.length) {
      return refuse("count-mismatch", { count: d.count, found: d.points.length }, base);
    }
    var seen = Object.create(null); // ids are untrusted: no inherited names
    for (var i = 0; i < d.points.length; i++) {
      var id = d.points[i].id;
      if (has(seen, id)) return refuse("duplicate-id", { id: id }, base);
      seen[id] = true;
    }
    return { ok: true };
  }

  var LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  // A fresh Float32Array of the block's values (little-endian bytes for an ArrayBuffer).
  function readValues(block) {
    if (isFloat32Array(block)) {
      return new Float32Array(block); // copies the view's own range only
    }
    var n = Math.floor(block.byteLength / 4);
    var out = new Float32Array(n);
    if (LITTLE) {
      out.set(new Float32Array(block, 0, n));
    } else {
      var dv = new DataView(block);
      for (var i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
    }
    return out;
  }

  // Appends write into spare capacity instead of copying the base's vectors.
  // A set's `vectors` is a Float32Array view of exactly count * dimension
  // values over a buffer that may be longer. `head` maps a buffer to the end
  // (in values) of the newest view over it. An append onto the set whose view
  // ends at the head writes its rows just after it and returns a longer view
  // over the same buffer: the older, shorter view is untouched, so the older
  // set stays valid. An append onto any other set (a fork, or a set that never
  // had spare room) copies into a new buffer of twice the needed length, so
  // the cost of appends is proportional to the points added, amortised.
  var head = typeof WeakMap === "function" ? new WeakMap() : null;

  function appendValues(baseValues, values) {
    var n0 = baseValues.length;
    var n1 = n0 + values.length;
    var buf = baseValues.buffer;
    var off = baseValues.byteOffset / 4;
    if (head && head.get(buf) === off + n0 && off + n1 <= buf.byteLength / 4) {
      var grown = new Float32Array(buf, baseValues.byteOffset, n1);
      grown.set(values, n0);
      head.set(buf, off + n1);
      return grown;
    }
    var fresh = new Float32Array(Math.max(2 * n1, 64));
    fresh.set(baseValues, 0);
    fresh.set(values, n0);
    if (head) head.set(fresh.buffer, n1);
    return fresh.subarray(0, n1);
  }

  function copyPoints(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      out.push({
        id: pts[i].id,
        label: pts[i].label,
        group: pts[i].group === undefined ? "" : pts[i].group,
        metadata: pts[i].metadata === undefined ? {} : clone(pts[i].metadata),
      });
    }
    return out;
  }

  function reductionOf(d) {
    if (d.reduction !== undefined) return clone(d.reduction);
    return {
      kind: "none",
      source_dimension: d.dimension,
      directions_kept: d.dimension,
      variance_dropped: 0,
    };
  }

  function idsOf(points) {
    return points.map(function (p) {
      return p.id;
    });
  }

  // Checks 9 to 11 and the merge. `d` has already passed checks 1 to 7.
  function finishInner(d, block, base) {
    var byteLength = block.byteLength;
    var expected = d.count * d.dimension * 4;
    if (byteLength !== expected) {
      return refuse(
        "block-length",
        { found: byteLength, count: d.count, dimension: d.dimension, expected: expected },
        base
      );
    }
    var values = readValues(block);
    for (var i = 0; i < values.length; i++) {
      if (!isFinite(values[i])) {
        var row = Math.floor(i / d.dimension);
        return refuse("non-finite", { id: d.points[row].id }, base);
      }
    }

    var points = copyPoints(d.points);
    var red = reductionOf(d);

    if (d.op === "append") {
      if (!isObject(base)) return refuse("append-without-base", {}, null);
      if (d.model !== base.model) {
        return refuse("model-mismatch", { found: d.model, expected: base.model }, base);
      }
      if (d.dimension !== base.dimension) {
        return refuse("dimension-mismatch", { found: d.dimension, expected: base.dimension }, base);
      }
      if (red.kind !== base.reduction.kind) {
        return refuse("reduction-mismatch", { found: red.kind, expected: base.reduction.kind }, base);
      }
      var held = Object.create(null);
      for (var b = 0; b < base.points.length; b++) held[base.points[b].id] = true;
      for (var n = 0; n < points.length; n++) {
        if (has(held, points[n].id)) return refuse("id-exists", { id: points[n].id }, base);
      }
      var merged = appendValues(base.vectors, values);
      var allPoints = base.points.concat(points);
      return {
        ok: true,
        set: {
          schema_version: 1,
          model: base.model,
          dimension: base.dimension,
          count: allPoints.length,
          text_included: base.text_included || d.text_included,
          provenance: base.provenance,
          reduction: base.reduction,
          vectors: merged,
          ids: idsOf(allPoints),
          points: allPoints,
        },
      };
    }

    return {
      ok: true,
      set: {
        schema_version: 1,
        model: d.model,
        dimension: d.dimension,
        count: points.length,
        text_included: d.text_included,
        provenance: clone(d.provenance),
        reduction: red,
        vectors: values,
        ids: idsOf(points),
        points: points,
      },
    };
  }

  // Never throws into the caller: an unexpected failure becomes a refusal.
  function guarded(base, fn) {
    try {
      return fn();
    } catch (e) {
      return refuse("invalid-field", { field: "(unreadable data)" }, base);
    }
  }

  // A file-form descriptor carrying its fetched block: { file, dtype, byte_order,
  // byte_length, data }, as a host or a shell hands update() a data file it fetched.
  function isDescriptorWithBlock(v) {
    return isObject(v) && !isFloat32Array(v) && !isArrayBuffer(v) && has(v, "data");
  }

  // validate(data, base): in-memory form. Returns { ok: true, set } or
  // { ok: false, code, message, set: base || null }. When `vectors` is the file
  // form's descriptor with the fetched block in `vectors.data`, the data is checked
  // as the file form (the descriptor's dtype, byte order and declared length too),
  // exactly as finish() would.
  function validate(data, base) {
    return guarded(base, function () {
      if (isObject(data) && isDescriptorWithBlock(data.vectors)) return finishFile(data, data.vectors.data, base);
      var r = checkRecordsInner(data, "memory", base);
      if (!r.ok) return r;
      return finishInner(data, data.vectors, base);
    });
  }

  // checkRecords(records): file form, checks 1 to 7. { ok: true, file } or a refusal.
  function checkRecords(records, base) {
    return guarded(base, function () {
      var r = checkRecordsInner(records, "file", base);
      if (!r.ok) return r;
      return { ok: true, file: records.vectors.file };
    });
  }

  // finish(records, block, base): file form, with the fetched block (ArrayBuffer or
  // Float32Array). Runs checks 1 to 11. A missing or wrong-typed block is block-unreadable.
  function finish(records, block, base) {
    return guarded(base, function () {
      return finishFile(records, block, base);
    });
  }

  function finishFile(records, block, base) {
    var r = checkRecordsInner(records, "file", base);
    if (!r.ok) return r;
    if (!isArrayBuffer(block) && !isFloat32Array(block)) {
      return refuse("block-unreadable", { file: records.vectors.file }, base);
    }
    return finishInner(records, block, base);
  }

  function siblingUrl(jsonUrl, file) {
    var s = String(jsonUrl).split("#")[0].split("?")[0];
    var cut = s.lastIndexOf("/");
    return cut < 0 ? file : s.slice(0, cut + 1) + file;
  }

  // loadFile(jsonUrl, fetchFn, base): file form. fetchFn is fetch-like: it takes a URL
  // string and returns a promise of { ok, json(), arrayBuffer() }. The block is fetched
  // beside the JSON file only. Resolves (never rejects) to the same result as validate.
  function loadFile(jsonUrl, fetchFn, base) {
    var records;
    return Promise.resolve()
      .then(function () {
        return fetchFn(String(jsonUrl));
      })
      .then(function (res) {
        if (!res || !res.ok) throw new Error("unreadable");
        return res.json();
      })
      .then(
        function (json) {
          records = json;
          var c = checkRecords(records, base);
          if (!c.ok) return c;
          return Promise.resolve()
            .then(function () {
              return fetchFn(siblingUrl(jsonUrl, c.file));
            })
            .then(function (res) {
              if (!res || !res.ok) throw new Error("unreadable");
              return res.arrayBuffer();
            })
            .then(
              function (buf) {
                return finish(records, buf, base);
              },
              function () {
                return refuse("block-unreadable", { file: c.file }, base);
              }
            );
        },
        function () {
          // The data file itself could not be fetched or is not JSON: the document defines
          // no code for this; it is reported as "not a data set".
          return refuse("wrong-kind", {}, base);
        }
      )
      .catch(function () {
        return refuse("wrong-kind", {}, base);
      });
  }

  ET.contract = {
    supportedVersions: SUPPORTED.slice(),
    messages: MESSAGES,
    validate: validate,
    checkRecords: checkRecords,
    finish: finish,
    loadFile: loadFile,
  };
})();
// ---------------------------------------------------------------------------
// 30-renderer.js: WebGL 2 drawing (ET.renderer).
//
// Ported from the reference page (docs/specs/reference/embedding-tumbler-demo.html):
// glowing points, true-neighbour wires, an HDR half-float target with a mip-chain
// bloom, depth of field, trails and twinkle. What changed from the reference:
//
//   * The dimension D comes from the data. Vectors are packed four dimensions per
//     RGBA32F texel, ceil(D / 4) texels per point, several points per texture row;
//     the shader's loop bound and row packing are generated from that layout and
//     checked against MAX_TEXTURE_SIZE.
//   * The renderer draws only. The caller supplies vectors, per-point colour and
//     weight, wire pairs, the frame (three orthonormal rows of length D), the centre,
//     and the draw parameters. It computes no tour, no neighbours, reads no CSS and
//     touches no DOM beyond the canvas it is given.
//   * It has a lifecycle: dispose() frees every GPU object it made, a lost context
//     is rebuilt from the data it keeps, and without WebGL 2 it reports instead of
//     throwing.
//
// The API is documented in js/api/30-renderer.md.
// ---------------------------------------------------------------------------
ET.renderer = (function () {
  // Draw parameters. Every value here is a documented default that a mode or the
  // viewer may override per frame through draw(state).
  var DEFAULTS = Object.freeze({
    zoom: 1, // scale applied to projected coordinates before perspective
    yaw: 0, // extra 3-D turn of the projected cloud about the vertical axis (radians)
    pitch: 0, // and about the horizontal axis (radians)
    radius: 0.46, // half-extent of unit coordinates as a share of min(width, height)
    pointSize: 6.5, // base point size in device pixels (multiply by devicePixelRatio)
    minPointSize: 1.5, // floor on the drawn point size in device pixels
    gain: 1, // overall brightness of points and wires
    fallbackGain: 0.55, // brightness used when there is no HDR target
    twinkle: 0.18, // amplitude of each point's slow brightness flicker, 0 = steady
    time: 0, // seconds; drives twinkle
    dt: 1 / 60, // seconds since the previous draw; drives trail fading
    trails: 0.17, // trail persistence in seconds (0 = clear every frame)
    trailGain: 1.6, // brightness compensation while trails accumulate
    clear: false, // true: wipe the trails this frame
    wires: 0, // 0..1 opacity of the true-neighbour wires
    wireGain: 1.5, // brightness of wires at wires = 1
    dim: 1, // brightness of points whose weight is below 0.99 (1 = no dimming)
    fog: 0, // 0..1: how strongly true distance from the centre dims and shrinks points
    fogNear: 1.2, // true distance (data units) at which fog starts to clear
    fogWidth: 0.8, // distance over which fog goes from clear to full
    focus: 0, // depth of the in-focus plane after the 3-D turn (0 = the cloud centre)
    depthOfField: 1.1, // how fast points swell and dim away from the focus plane
    wireDepthOfField: 0.8, // the same for wires
    bloom: 0.55, // strength of the mip-chain glow
    exposure: 1.35, // tone-mapping exposure; bright cores burn toward white
    gamma: 0.92, // output curve
    vignette: 0.72, // brightness at the corners (1 = no vignette)
    background: Object.freeze([0, 0, 0]), // added under the image, linear RGB 0..1
  });

  var MAX_ROW_WIDTH = 4096; // preferred texture row width (texels) before widening

  function unavailable(reason, message) {
    return { ok: false, reason: reason, message: message };
  }

  // ---------- layout: how N points of dimension D sit in one RGBA32F texture ----------

  function layout(dimension, count, maxTextureSize) {
    var d = dimension | 0;
    var n = Math.max(0, count | 0);
    var max = maxTextureSize | 0;
    if (d < 1 || d !== dimension) return unavailable("bad-dimension", "Dimension must be a positive integer.");
    var texels = Math.ceil(d / 4);
    if (texels > max) {
      return unavailable(
        "dimension-too-large",
        "Dimension " + d + " needs " + texels + " texels per point; this GPU allows " + max + "."
      );
    }
    var perRow = Math.max(1, Math.floor(Math.min(max, MAX_ROW_WIDTH) / texels));
    if (Math.ceil(n / perRow) > max) perRow = Math.floor(max / texels); // widen before refusing
    var maxPoints = perRow * max;
    if (n > maxPoints) {
      return unavailable(
        "too-many-points",
        n + " points of dimension " + d + " do not fit this GPU's textures (at most " + maxPoints + ")."
      );
    }
    return {
      ok: true,
      dimension: d,
      texelsPerPoint: texels,
      floatsPerPoint: texels * 4,
      pointsPerRow: perRow,
      width: perRow * texels,
      maxTextureSize: max,
      maxPoints: maxPoints,
      rows: function (points) {
        return Math.max(1, Math.ceil(points / perRow));
      },
    };
  }

  // ---------- shaders, generated from the layout ----------

  function shaderSources(lay) {
    var T = lay.texelsPerPoint;
    var P = lay.pointsPerRow;
    var wireScale = Math.sqrt(lay.dimension / 3).toFixed(4);
    var head = "#version 300 es\nprecision highp float; precision highp int; precision highp sampler2D;\n";
    // proj(): the centred vector's coordinates along the three frame rows, plus its
    // true distance from the centre, all in the full dimension.
    var proj = [
      "uniform sampler2D uX; uniform sampler2D uF;",
      "const int TEXELS = " + T + ";",
      "const int PER_ROW = " + P + ";",
      "vec3 proj(int id, out float dist) {",
      "  int base = (id % PER_ROW) * TEXELS; int row = id / PER_ROW;",
      "  vec3 p = vec3(0.0); float dd = 0.0;",
      "  for (int k = 0; k < TEXELS; k++) {",
      "    vec4 x = texelFetch(uX, ivec2(base + k, row), 0) - texelFetch(uF, ivec2(k, 3), 0);",
      "    p += vec3(dot(x, texelFetch(uF, ivec2(k, 0), 0)), dot(x, texelFetch(uF, ivec2(k, 1), 0)),",
      "              dot(x, texelFetch(uF, ivec2(k, 2), 0)));",
      "    dd += dot(x, x);",
      "  }",
      "  dist = sqrt(dd);",
      "  return p;",
      "}",
      "uniform vec4 uRot; uniform vec2 uView; uniform float uZoom; uniform float uFocus;",
      // place(): turn by yaw and pitch, then a gentle perspective. zf is the depth
      // relative to the focus plane, used for depth of field.
      "vec4 place(vec3 p, out float zf) {",
      "  p *= uZoom;",
      "  float x1 = p.x * uRot.x + p.z * uRot.y, z1 = -p.x * uRot.y + p.z * uRot.x;",
      "  float y2 = p.y * uRot.z - z1 * uRot.w; float z2 = p.y * uRot.w + z1 * uRot.z;",
      "  float s = 3.0 / max(0.6, 3.0 + z2);",
      "  zf = z2 - uFocus;",
      "  return vec4(x1 * s * uView.x, y2 * s * uView.y, 0.0, s);",
      "}",
    ].join("\n");
    var pointVertex =
      head +
      proj +
      "\n" +
      [
        "uniform float uPx, uMinPx, uFog, uTime, uGain, uDim, uTwinkle, uDof, uFogNear, uFogWidth;",
        "layout(location = 0) in vec4 aCol;",
        "out vec3 vCol;",
        "void main() {",
        "  float fid = float(gl_VertexID);",
        "  float dist, zf;",
        "  vec4 q = place(proj(gl_VertexID, dist), zf);",
        "  gl_Position = vec4(q.xy, 0.0, 1.0);",
        "  float fog = clamp((uFogNear - dist) / uFogWidth, 0.0, 1.0);",
        "  float w = aCol.a;",
        "  float blur = 1.0 + uDof * zf * zf;", // out-of-focus points swell and dim
        "  float size = uPx * q.w * (0.55 + 1.5 * w) * blur * mix(1.0, 0.45 + 1.25 * fog, uFog);",
        "  gl_PointSize = max(size, uMinPx);",
        "  float tw = (1.0 - uTwinkle) + uTwinkle * sin(uTime * (1.3 + fract(fid * 0.618) * 2.2) + fid * 12.9898);",
        "  float a = (0.16 + 0.84 * w * w) * tw / pow(blur, 1.5) * mix(1.0, 0.22 + 0.78 * fog * fog, uFog);",
        "  vCol = aCol.rgb * a * uGain * mix(1.0, uDim, step(w, 0.99));",
        "}",
      ].join("\n");
    var pointFragment = [
      "#version 300 es",
      "precision mediump float;",
      "in vec3 vCol; out vec4 o;",
      "void main() {",
      "  vec2 q = gl_PointCoord * 2.0 - 1.0;",
      "  float r2 = dot(q, q);",
      "  if (r2 > 1.0) discard;",
      "  float g = exp(-r2 * 4.5) * (1.0 - r2) + 0.9 * exp(-r2 * 38.0);",
      "  o = vec4(vCol * g, 1.0);",
      "}",
    ].join("\n");
    var lineVertex =
      head +
      proj +
      "\n" +
      [
        "uniform float uGain, uWireDof;",
        "layout(location = 0) in uvec2 aPair;",
        "layout(location = 1) in float aLen;",
        "layout(location = 2) in vec3 aCol;",
        "out vec3 vCol;",
        "void main() {",
        "  float d0, d1, zf;",
        "  vec3 p = proj(int(aPair.x), d0), p2 = proj(int(aPair.y), d1);",
        "  vec4 q = place(p, zf);",
        "  gl_Position = vec4(q.xy, 0.0, 1.0);",
        // 1 = a typical shadow length; higher = seen nearer its true length
        "  float t = length(p - p2) / max(aLen, 1e-6) * " + wireScale + ";",
        "  vCol = aCol * (0.03 + 0.2 * t * t * t) * uGain / (1.0 + uWireDof * zf * zf);",
        "}",
      ].join("\n");
    var lineFragment =
      "#version 300 es\nprecision mediump float; in vec3 vCol; out vec4 o; void main() { o = vec4(vCol, 1.0); }";
    var quadVertex = [
      "#version 300 es",
      "out vec2 vUV;",
      "void main() {",
      "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));",
      "  vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);",
      "}",
    ].join("\n");
    var fadeFragment =
      "#version 300 es\nprecision mediump float; uniform float uK; out vec4 o; void main() { o = vec4(uK, uK, uK, 1.0); }";
    var toneFragment = [
      "#version 300 es",
      "precision highp float;",
      "uniform sampler2D uT; uniform float uBloom, uExposure, uGamma, uVignette; uniform vec3 uBackground;",
      "in vec2 vUV; out vec4 o;",
      "void main() {",
      "  vec3 c = texture(uT, vUV).rgb;",
      "  vec3 bloom = textureLod(uT, vUV, 2.0).rgb * 0.5 + textureLod(uT, vUV, 3.5).rgb * 0.45",
      "             + textureLod(uT, vUV, 5.0).rgb * 0.4 + textureLod(uT, vUV, 6.5).rgb * 0.3;",
      "  c = c + bloom * uBloom;",
      "  c = 1.0 - exp(-c * uExposure);", // bright cores burn toward white
      "  float v = smoothstep(1.25, 0.35, length(vUV - 0.5) * 1.6);",
      "  o = vec4(uBackground + pow(c, vec3(uGamma)) * mix(uVignette, 1.0, v), 1.0);",
      "}",
    ].join("\n");
    return {
      pointVertex: pointVertex,
      pointFragment: pointFragment,
      lineVertex: lineVertex,
      lineFragment: lineFragment,
      quadVertex: quadVertex,
      fadeFragment: fadeFragment,
      toneFragment: toneFragment,
    };
  }

  // ---------- the screen mapping, in JavaScript (mirrors place() in the shader) ----------

  // p: [x, y, z] coordinates along the frame (already centred). Returns canvas pixels
  // (y grows downward), the perspective scale and the depth relative to the focus plane.
  function place(p, state, width, height) {
    var s = merge(state);
    var cy = Math.cos(s.yaw),
      sy = Math.sin(s.yaw),
      cp = Math.cos(s.pitch),
      sp = Math.sin(s.pitch);
    var R = Math.min(width, height) * s.radius;
    var x = p[0] * s.zoom,
      y = p[1] * s.zoom,
      z = p[2] * s.zoom;
    var x1 = x * cy + z * sy,
      z1 = -x * sy + z * cy;
    var y2 = y * cp - z1 * sp,
      z2 = y * sp + z1 * cp;
    var k = 3 / Math.max(0.6, 3 + z2);
    return { x: width / 2 + x1 * k * R, y: height / 2 - y2 * k * R, scale: k, depth: z2 - s.focus };
  }

  function merge(state) {
    var out = {};
    var key;
    for (key in DEFAULTS) out[key] = DEFAULTS[key];
    if (state) {
      for (key in state) {
        if (Object.prototype.hasOwnProperty.call(state, key) && state[key] !== undefined) {
          out[key] = state[key];
        }
      }
    }
    return out;
  }

  function isFloatArray(a) {
    return a instanceof Float32Array || (a && a.constructor && a.constructor.name === "Float32Array");
  }

  function isIndexArray(a) {
    return (
      a instanceof Uint32Array ||
      a instanceof Int32Array ||
      (a &&
        a.constructor &&
        (a.constructor.name === "Uint32Array" || a.constructor.name === "Int32Array"))
    );
  }

  // Check a block of points; returns its count.
  function checkPoints(input, dimension) {
    if (!input || !isFloatArray(input.vectors)) throw new TypeError("vectors must be a Float32Array");
    if (input.vectors.length % dimension !== 0) {
      throw new TypeError("vectors length " + input.vectors.length + " is not a multiple of dimension " + dimension);
    }
    var n = input.vectors.length / dimension;
    if (input.count !== undefined && input.count !== n) {
      throw new TypeError("count " + input.count + " does not match vectors (" + n + " points)");
    }
    if (input.colours !== undefined && input.colours !== null) {
      if (!isFloatArray(input.colours) || input.colours.length !== n * 3) {
        throw new TypeError("colours must be a Float32Array of length 3 * count");
      }
    }
    if (input.weights !== undefined && input.weights !== null) {
      if (!isFloatArray(input.weights) || input.weights.length !== n) {
        throw new TypeError("weights must be a Float32Array of length count");
      }
    }
    return n;
  }

  // ---------- one renderer bound to one canvas ----------

  function create(canvas, options) {
    var opts = options || {};
    var gl = null;
    try {
      if (canvas && typeof canvas.getContext === "function") {
        gl = canvas.getContext("webgl2", {
          alpha: !!opts.alpha,
          antialias: false,
          depth: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
          powerPreference: opts.powerPreference || "high-performance",
        });
      }
    } catch (e) {
      gl = null;
    }
    if (!gl) return unavailable("webgl2-unavailable", "WebGL 2 is not available, so the embedding view cannot be drawn.");

    var onContextChange = typeof opts.onContextChange === "function" ? opts.onContextChange : null;
    var maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;

    // Data kept on the CPU: the source for appends and for a rebuild after context loss.
    var store = {
      dimension: 0,
      count: 0,
      capacity: 0,
      lay: null,
      vectors: null, // Float32Array(capacityRows * pointsPerRow * floatsPerPoint), zero-padded
      attr: null, // Float32Array(capacity * 4): r, g, b, weight
    };
    var wires = { pairs: null, lengths: null, count: 0 };

    var gpu = null; // every GL object lives here; rebuilt after a context loss
    var lost = false;
    var disposed = false;
    var error = null; // set when a rebuild failed
    var hdr = false;
    var needClear = true;

    function track(kind, obj) {
      gpu.objects.push({ kind: kind, obj: obj });
      return obj;
    }

    function freshGpu() {
      return {
        objects: [],
        tone: null,
        fade: null,
        point: null,
        line: null,
        progLayout: null,
        quadVao: null,
        texX: null,
        texXRows: 0,
        texF: null,
        fStage: null,
        fWidth: 0,
        vboPoint: null,
        vaoPoint: null,
        vboLine: null,
        vaoLine: null,
        fbo: null,
        texHdr: null,
        hdrW: 0,
        hdrH: 0,
      };
    }

    function shaderError(message) {
      var e = new Error(message);
      e.isShaderError = true;
      return e;
    }

    // A failure while building or uploading: shader-failed for compile and link errors,
    // gpu-failed for anything else a GL call threw.
    function failure(e) {
      var msg = e && e.message ? e.message : String(e);
      if (e && e.isShaderError) return unavailable("shader-failed", "The view could not be drawn: " + msg);
      return unavailable("gpu-failed", "The view could not be sent to the GPU: " + msg);
    }

    // Drop a half-built GPU state after a failed upload and remember why. The CPU copy
    // is kept, so rebuild() (or a context restore) can try again.
    function failGpu(e) {
      freeGpu();
      gpu = null;
      error = failure(e);
      return error;
    }

    function compile(vsSrc, fsSrc, uniformNames) {
      var prog = track("program", gl.createProgram());
      var pair = [
        [gl.VERTEX_SHADER, vsSrc],
        [gl.FRAGMENT_SHADER, fsSrc],
      ];
      var shaders = [];
      for (var i = 0; i < pair.length; i++) {
        var sh = gl.createShader(pair[i][0]);
        shaders.push(sh);
        gl.shaderSource(sh, pair[i][1]);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          var log = gl.getShaderInfoLog(sh);
          for (var j = 0; j < shaders.length; j++) gl.deleteShader(shaders[j]);
          throw shaderError("shader did not compile: " + log);
        }
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      var linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
      var linkLog = linked ? "" : gl.getProgramInfoLog(prog);
      for (var k = 0; k < shaders.length; k++) {
        gl.detachShader(prog, shaders[k]);
        gl.deleteShader(shaders[k]);
      }
      if (!linked) throw shaderError("shader program did not link: " + linkLog);
      var u = {};
      for (var m = 0; m < uniformNames.length; m++) u[uniformNames[m]] = gl.getUniformLocation(prog, uniformNames[m]);
      return { program: prog, u: u };
    }

    function floatTexture(width, height, data) {
      var t = track("texture", gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    function release(obj) {
      // Delete one tracked GL object now (used when a texture or buffer is replaced).
      for (var i = 0; i < gpu.objects.length; i++) {
        if (gpu.objects[i].obj === obj) {
          deleteObject(gpu.objects[i]);
          gpu.objects.splice(i, 1);
          return;
        }
      }
    }

    function deleteObject(entry) {
      var o = entry.obj;
      if (!o) return;
      if (entry.kind === "texture") gl.deleteTexture(o);
      else if (entry.kind === "buffer") gl.deleteBuffer(o);
      else if (entry.kind === "program") gl.deleteProgram(o);
      else if (entry.kind === "framebuffer") gl.deleteFramebuffer(o);
      else if (entry.kind === "vertexArray") gl.deleteVertexArray(o);
    }

    function freeGpu() {
      if (!gpu) return;
      if (!lost) {
        for (var i = gpu.objects.length - 1; i >= 0; i--) deleteObject(gpu.objects[i]);
      }
      gpu = null;
    }

    // The parts that do not depend on the data: the tone and fade passes and the HDR target.
    function buildBase() {
      var src = shaderSources(layout(4, 1, Math.max(1, maxTextureSize)));
      gpu.tone = compile(src.quadVertex, src.toneFragment, [
        "uT",
        "uBloom",
        "uExposure",
        "uGamma",
        "uVignette",
        "uBackground",
      ]);
      gpu.fade = compile(src.quadVertex, src.fadeFragment, ["uK"]);
      gpu.quadVao = track("vertexArray", gl.createVertexArray());
      hdr = false;
      if (opts.hdr !== false) {
        hdr = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
      }
      if (hdr) {
        gpu.fbo = track("framebuffer", gl.createFramebuffer());
        gpu.texHdr = track("texture", gl.createTexture());
        if (!sizeHdr()) {
          // Float targets advertised but not usable here: fall back to direct drawing.
          release(gpu.fbo);
          release(gpu.texHdr);
          gpu.fbo = null;
          gpu.texHdr = null;
          hdr = false;
        }
      }
    }

    function sizeHdr() {
      var w = Math.max(1, gl.drawingBufferWidth | 0);
      var h = Math.max(1, gl.drawingBufferHeight | 0);
      if (w === gpu.hdrW && h === gpu.hdrH) return true;
      gl.bindTexture(gl.TEXTURE_2D, gpu.texHdr);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gpu.texHdr, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gpu.hdrW = w;
      gpu.hdrH = h;
      needClear = true;
      return ok;
    }

    // Programs whose loop bound and row packing come from the layout.
    function buildPrograms(lay) {
      if (gpu.progLayout && gpu.progLayout.texelsPerPoint === lay.texelsPerPoint && gpu.progLayout.pointsPerRow === lay.pointsPerRow) {
        return;
      }
      if (gpu.point) release(gpu.point.program);
      if (gpu.line) release(gpu.line.program);
      gpu.point = null;
      gpu.line = null;
      var src = shaderSources(lay);
      var view = ["uX", "uF", "uRot", "uView", "uZoom", "uFocus"];
      gpu.point = compile(
        src.pointVertex,
        src.pointFragment,
        view.concat(["uPx", "uMinPx", "uFog", "uTime", "uGain", "uDim", "uTwinkle", "uDof", "uFogNear", "uFogWidth"])
      );
      gpu.line = compile(src.lineVertex, src.lineFragment, view.concat(["uGain", "uWireDof"]));
      gpu.progLayout = lay;
      // the frame texture: rows 0..2 the frame, row 3 the centre
      if (gpu.texF) release(gpu.texF);
      gpu.fWidth = lay.texelsPerPoint;
      gpu.fStage = new Float32Array(gpu.fWidth * 4 * 4);
      gpu.texF = floatTexture(gpu.fWidth, 4, gpu.fStage);
    }

    // Upload the whole point store (texture and colour buffer) at its capacity.
    function uploadAllPoints() {
      var lay = store.lay;
      buildPrograms(lay);
      if (gpu.texX) release(gpu.texX);
      gpu.texXRows = lay.rows(store.capacity);
      gpu.texX = floatTexture(lay.width, gpu.texXRows, store.vectors);
      if (gpu.vboPoint) release(gpu.vboPoint);
      if (gpu.vaoPoint) release(gpu.vaoPoint);
      gpu.vaoPoint = track("vertexArray", gl.createVertexArray());
      gl.bindVertexArray(gpu.vaoPoint);
      gpu.vboPoint = track("buffer", gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vboPoint);
      gl.bufferData(gl.ARRAY_BUFFER, store.attr, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    function uploadWires() {
      if (gpu.vboLine) release(gpu.vboLine);
      if (gpu.vaoLine) release(gpu.vaoLine);
      gpu.vboLine = null;
      gpu.vaoLine = null;
      if (!wires.count) return;
      // per vertex, 24 bytes: u32 id, u32 other, f32 true length, f32 r, g, b
      var buf = new ArrayBuffer(wires.count * 2 * 24);
      var u32 = new Uint32Array(buf);
      var f32 = new Float32Array(buf);
      for (var e = 0; e < wires.count; e++) {
        var a = wires.pairs[2 * e],
          b = wires.pairs[2 * e + 1],
          len = wires.lengths[e];
        for (var end = 0; end < 2; end++) {
          var me = end ? b : a,
            other = end ? a : b,
            o = (2 * e + end) * 6;
          u32[o] = me;
          u32[o + 1] = other;
          f32[o + 2] = len;
          f32[o + 3] = store.attr[me * 4];
          f32[o + 4] = store.attr[me * 4 + 1];
          f32[o + 5] = store.attr[me * 4 + 2];
        }
      }
      gpu.vaoLine = track("vertexArray", gl.createVertexArray());
      gl.bindVertexArray(gpu.vaoLine);
      gpu.vboLine = track("buffer", gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vboLine);
      gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 24, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // Build (or rebuild after a context loss) every GPU object from the kept data.
    function buildAll() {
      freeGpu();
      gpu = freshGpu();
      try {
        buildBase();
        if (store.lay) {
          uploadAllPoints();
          uploadWires();
        }
        needClear = true;
        return { ok: true };
      } catch (e) {
        freeGpu();
        gpu = null;
        return failure(e);
      }
    }

    // Copy a block of points into the padded store starting at point `at`.
    function writePoints(input, n, at) {
      var d = store.dimension,
        stride = store.lay.floatsPerPoint,
        v = input.vectors;
      var pad = stride !== d;
      if (!pad) {
        store.vectors.set(v, at * stride);
      } else {
        for (var i = 0; i < n; i++) store.vectors.set(v.subarray(i * d, i * d + d), (at + i) * stride);
      }
      var c = input.colours,
        w = input.weights;
      for (var j = 0; j < n; j++) {
        var o = (at + j) * 4;
        store.attr[o] = c ? c[j * 3] : 1;
        store.attr[o + 1] = c ? c[j * 3 + 1] : 1;
        store.attr[o + 2] = c ? c[j * 3 + 2] : 1;
        store.attr[o + 3] = w ? w[j] : 1;
      }
    }

    function allocate(lay, capacity) {
      var rows = lay.rows(capacity);
      var vec = new Float32Array(rows * lay.pointsPerRow * lay.floatsPerPoint);
      var attr = new Float32Array(Math.max(1, capacity) * 4);
      return { vectors: vec, attr: attr };
    }

    // True when the GPU state is whole: not disposed, not lost, no failed build.
    function usable() {
      return !disposed && !lost && gpu !== null && error === null;
    }

    var api = {
      // Replace all points. Returns { ok: true, layout, uploaded } or { ok: false, reason, message }.
      setData: function (input) {
        if (disposed) return unavailable("disposed", "The renderer has been disposed.");
        var d = input && input.dimension;
        if (typeof d !== "number" || d < 1 || Math.floor(d) !== d) throw new TypeError("dimension must be a positive integer");
        var n = checkPoints(input, d);
        var lay = layout(d, n, maxTextureSize);
        if (!lay.ok) return lay;
        var cap = Math.max(1, n);
        var mem = allocate(lay, cap);
        store.dimension = d;
        store.count = n;
        store.capacity = cap;
        store.lay = lay;
        store.vectors = mem.vectors;
        store.attr = mem.attr;
        writePoints(input, n, 0);
        wires = { pairs: null, lengths: null, count: 0 };
        needClear = true;
        if (!usable()) return { ok: true, layout: lay, uploaded: false };
        try {
          uploadAllPoints();
          uploadWires();
        } catch (e) {
          return failGpu(e);
        }
        return { ok: true, layout: lay, uploaded: true };
      },

      // Add points after the existing ones. Wires are kept. Returns
      // { ok: true, reallocated, uploaded } (reallocated: the GPU copy was rebuilt at a
      // larger size; uploaded: false when only the CPU copy changed because the context is
      // lost or a build failed).
      appendData: function (input) {
        if (disposed) return unavailable("disposed", "The renderer has been disposed.");
        if (!store.lay) throw new TypeError("appendData needs a prior setData");
        if (input.dimension !== undefined && input.dimension !== store.dimension) {
          throw new TypeError("dimension " + input.dimension + " differs from the data's " + store.dimension);
        }
        var n = checkPoints(input, store.dimension);
        if (n === 0) return { ok: true, reallocated: false, uploaded: usable() };
        var total = store.count + n;
        var lay = store.lay;
        var reallocated = false;
        if (total > store.capacity) {
          if (total > lay.maxPoints) {
            lay = layout(store.dimension, total, maxTextureSize);
            if (!lay.ok) return lay;
          }
          var cap = Math.min(lay.maxPoints, Math.max(total, store.capacity * 2));
          var mem = allocate(lay, cap);
          // points are contiguous at a fixed stride whatever the row packing
          mem.vectors.set(store.vectors.subarray(0, store.count * lay.floatsPerPoint));
          mem.attr.set(store.attr.subarray(0, store.count * 4));
          store.vectors = mem.vectors;
          store.attr = mem.attr;
          store.capacity = cap;
          store.lay = lay;
          reallocated = true;
        }
        var first = store.count;
        writePoints(input, n, first);
        store.count = total;
        if (!usable()) return { ok: true, reallocated: reallocated, uploaded: false };
        try {
          if (reallocated) {
            uploadAllPoints();
          } else {
            // only the texture rows the new points touch, and their slice of the colour buffer
            var P = lay.pointsPerRow,
              r0 = Math.floor(first / P),
              r1 = Math.floor((total - 1) / P),
              rowFloats = lay.width * 4;
            gl.activeTexture(gl.TEXTURE0); // never rely on whichever unit was left active
            gl.bindTexture(gl.TEXTURE_2D, gpu.texX);
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              r0,
              lay.width,
              r1 - r0 + 1,
              gl.RGBA,
              gl.FLOAT,
              store.vectors.subarray(r0 * rowFloats, (r1 + 1) * rowFloats)
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vboPoint);
            gl.bufferSubData(gl.ARRAY_BUFFER, first * 16, store.attr.subarray(first * 4, total * 4));
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
          }
        } catch (e) {
          return failGpu(e);
        }
        return { ok: true, reallocated: reallocated, uploaded: true };
      },

      // Neighbour wires as index pairs (two per wire). lengths: optional true distances,
      // one per wire; measured from the kept vectors when absent.
      setWires: function (pairs, lengths) {
        if (disposed) return unavailable("disposed", "The renderer has been disposed.");
        if (!isIndexArray(pairs)) throw new TypeError("pairs must be a Uint32Array (or Int32Array)");
        if (pairs.length % 2 !== 0) throw new TypeError("pairs must hold two indices per wire");
        var m = pairs.length / 2;
        for (var i = 0; i < pairs.length; i++) {
          if (pairs[i] < 0 || pairs[i] >= store.count) {
            throw new RangeError("wire endpoint " + pairs[i] + " is not a point index (count " + store.count + ")");
          }
        }
        var lens;
        if (lengths !== undefined && lengths !== null) {
          if (!isFloatArray(lengths) || lengths.length !== m) throw new TypeError("lengths must be a Float32Array, one per wire");
          lens = lengths;
        } else {
          lens = new Float32Array(m);
          var stride = store.lay ? store.lay.floatsPerPoint : 0;
          for (var e = 0; e < m; e++) {
            var a = pairs[2 * e] * stride,
              b = pairs[2 * e + 1] * stride,
              s = 0;
            for (var k = 0; k < stride; k++) {
              var t = store.vectors[a + k] - store.vectors[b + k];
              s += t * t;
            }
            lens[e] = Math.sqrt(s);
          }
        }
        wires = { pairs: new Uint32Array(pairs), lengths: new Float32Array(lens), count: m };
        if (!usable()) return { ok: true, uploaded: false };
        try {
          uploadWires();
        } catch (e) {
          return failGpu(e);
        }
        return { ok: true, uploaded: true };
      },

      // Retry building every GPU object from the CPU copy, after a failed restore or a
      // failed upload. Returns { ok: true } or { ok: false, reason, message }. draw()
      // never retries by itself.
      rebuild: function () {
        if (disposed) return unavailable("disposed", "The renderer has been disposed.");
        if (lost || (typeof gl.isContextLost === "function" && gl.isContextLost())) {
          return unavailable("context-lost", "The graphics context is lost; wait for it to be restored.");
        }
        error = null;
        var res = buildAll();
        if (!res.ok) {
          error = res;
          return res;
        }
        return { ok: true };
      },

      // Set the drawing-buffer size in device pixels.
      resize: function (width, height) {
        if (disposed || !canvas) return;
        var w = Math.max(1, Math.round(width)),
          h = Math.max(1, Math.round(height));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        needClear = true;
      },

      // Draw one frame. state: see DEFAULTS, plus frame (Float32Array 3 * D) and
      // centre (Float32Array D, default zeros). Returns false when nothing could be
      // drawn (disposed, context lost, or a failed build or upload until rebuild()).
      draw: function (state) {
        if (!usable()) return false;
        var s = merge(state);
        var D = store.dimension;
        var hasData = store.count > 0 && gpu.point;
        if (hasData) {
          if (!isFloatArray(s.frame) || s.frame.length !== 3 * D) throw new TypeError("frame must be a Float32Array of length 3 * " + D);
          if (s.centre !== undefined && s.centre !== null && (!isFloatArray(s.centre) || s.centre.length !== D)) {
            throw new TypeError("centre must be a Float32Array of length " + D);
          }
          var st = gpu.fStage,
            row = gpu.fWidth * 4;
          st.fill(0);
          for (var a = 0; a < 3; a++) st.set(s.frame.subarray(a * D, a * D + D), a * row);
          if (s.centre) st.set(s.centre, 3 * row);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, gpu.texF);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gpu.fWidth, 4, gl.RGBA, gl.FLOAT, st);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gpu.texX);
        }
        if (hdr && !sizeHdr()) {
          // the target became unusable at this size; fall back for good
          release(gpu.fbo);
          release(gpu.texHdr);
          gpu.fbo = null;
          gpu.texHdr = null;
          hdr = false;
        }
        var W = Math.max(1, gl.drawingBufferWidth | 0),
          H = Math.max(1, gl.drawingBufferHeight | 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, hdr ? gpu.fbo : null);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        var gain = s.gain * (hdr ? 1 : s.fallbackGain);
        var bg = s.background || DEFAULTS.background;
        if (needClear || s.clear || !(s.trails > 0) || !hdr) {
          if (hdr) gl.clearColor(0, 0, 0, 1);
          else gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          needClear = false;
        } else {
          // dim what is already there instead of wiping it: motion leaves trails
          var k = Math.exp(-Math.max(0, s.dt) / s.trails);
          gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
          gl.useProgram(gpu.fade.program);
          gl.uniform1f(gpu.fade.u.uK, k);
          gl.bindVertexArray(gpu.quadVao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gain *= (1 - k) * s.trailGain;
        }
        gl.blendFunc(gl.ONE, gl.ONE);
        if (hasData) {
          var R = Math.min(W, H) * s.radius;
          var rot = [Math.cos(s.yaw), Math.sin(s.yaw), Math.cos(s.pitch), Math.sin(s.pitch)];
          var setView = function (p) {
            gl.useProgram(p.program);
            gl.uniform1i(p.u.uX, 0);
            gl.uniform1i(p.u.uF, 1);
            gl.uniform4f(p.u.uRot, rot[0], rot[1], rot[2], rot[3]);
            gl.uniform2f(p.u.uView, (2 * R) / W, (2 * R) / H);
            gl.uniform1f(p.u.uZoom, s.zoom);
            gl.uniform1f(p.u.uFocus, s.focus);
          };
          if (wires.count && s.wires > 0.02 && gpu.vaoLine) {
            setView(gpu.line);
            gl.uniform1f(gpu.line.u.uGain, gain * s.wires * s.wireGain);
            gl.uniform1f(gpu.line.u.uWireDof, s.wireDepthOfField);
            gl.bindVertexArray(gpu.vaoLine);
            gl.drawArrays(gl.LINES, 0, wires.count * 2);
          }
          var pu = gpu.point.u;
          setView(gpu.point);
          gl.uniform1f(pu.uPx, s.pointSize);
          gl.uniform1f(pu.uMinPx, s.minPointSize);
          gl.uniform1f(pu.uFog, s.fog);
          gl.uniform1f(pu.uTime, s.time);
          gl.uniform1f(pu.uGain, gain);
          gl.uniform1f(pu.uDim, s.dim);
          gl.uniform1f(pu.uTwinkle, s.twinkle);
          gl.uniform1f(pu.uDof, s.depthOfField);
          gl.uniform1f(pu.uFogNear, s.fogNear);
          gl.uniform1f(pu.uFogWidth, Math.max(1e-6, s.fogWidth));
          gl.bindVertexArray(gpu.vaoPoint);
          gl.drawArrays(gl.POINTS, 0, store.count);
        }
        if (hdr) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, gpu.texHdr);
          gl.generateMipmap(gl.TEXTURE_2D);
          var tu = gpu.tone.u;
          gl.useProgram(gpu.tone.program);
          gl.uniform1i(tu.uT, 2);
          gl.uniform1f(tu.uBloom, s.bloom);
          gl.uniform1f(tu.uExposure, s.exposure);
          gl.uniform1f(tu.uGamma, s.gamma);
          gl.uniform1f(tu.uVignette, s.vignette);
          gl.uniform3f(tu.uBackground, bg[0], bg[1], bg[2]);
          gl.bindVertexArray(gpu.quadVao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.activeTexture(gl.TEXTURE0);
        }
        gl.bindVertexArray(null);
        return true;
      },

      status: function () {
        return {
          ok: !disposed && error === null,
          available: true,
          disposed: disposed,
          lost: lost,
          hdr: hdr,
          error: error ? error.message : null,
          dimension: store.dimension,
          count: store.count,
          capacity: store.capacity,
          wires: wires.count,
          maxTextureSize: maxTextureSize,
          layout: store.lay,
        };
      },

      // Free every GPU object this renderer made and stop listening to the canvas.
      dispose: function () {
        if (disposed) return;
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
        freeGpu();
        disposed = true;
        store.vectors = null;
        store.attr = null;
        wires = { pairs: null, lengths: null, count: 0 };
        if (opts.releaseContext && !lost) {
          var ext = gl.getExtension("WEBGL_lose_context");
          if (ext) ext.loseContext();
        }
      },
    };

    function notify(type, message) {
      if (onContextChange) onContextChange({ type: type, message: message || "" });
    }

    function onLost(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault(); // allow a restore
      lost = true;
      if (gpu) gpu = null; // the GPU objects are gone with the context; nothing to delete
      notify("lost", "The graphics context was lost; drawing is paused until it is restored.");
    }

    function onRestored() {
      if (disposed) return;
      lost = false;
      var res = buildAll();
      if (res.ok) {
        error = null;
        notify("restored", "");
      } else {
        error = res;
        notify("restore-failed", res.message);
      }
    }

    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);

    var built = buildAll();
    if (!built.ok) {
      api.dispose();
      return built;
    }
    return { ok: true, renderer: api };
  }

  return {
    DEFAULTS: DEFAULTS,
    layout: layout,
    shaderSources: shaderSources,
    place: place,
    create: create,
  };
})();
// ---------------------------------------------------------------------------
// 39-modes.js: the mode interface and registry (ET.modes).
//
// A mode owns its motion and its draw parameters and nothing else. It never
// touches WebGL or the DOM. Given the loaded set, a seed and the time in the
// mode, it answers a frame (three orthonormal rows of length D), a centre, a
// plain draw-parameter object for ET.renderer.draw, optional wires (index
// pairs) and a one-line plain-text status. The viewer owns the renderer, the
// clock, the data and the DOM.
//
// The three shipped modes live in 40-mode-tumble.js, 41-mode-lattice.js and
// 42-mode-wander.js and register themselves here. A fourth mode registers the
// same way, without touching them or the data contract.
//
// Documented in js/api/40-modes.md.
// ---------------------------------------------------------------------------
ET.modes = (function () {
  // Members every mode instance must have (see js/api/40-modes.md).
  // Optional members: mark(t) (fix the time of a finished event) and, for
  // Tumble, refit(t).
  var INTERFACE = ["enter", "prepare", "isReady", "stateAt", "step", "status", "dataChanged", "describe", "leave"];
  var ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
  var registry = [];

  function copyDef(def) {
    return { id: def.id, title: def.title, summary: def.summary, create: def.create };
  }

  // register({ id, title, summary, create(options) -> instance })
  function register(def) {
    if (!def || typeof def !== "object") throw new TypeError("a mode definition must be an object");
    if (typeof def.id !== "string" || !ID_PATTERN.test(def.id)) {
      throw new TypeError("a mode id must be lower-case letters, digits and hyphens, starting with a letter");
    }
    if (typeof def.title !== "string" || def.title.length === 0) throw new TypeError("a mode needs a title");
    if (typeof def.summary !== "string") throw new TypeError("a mode needs a summary string");
    if (typeof def.create !== "function") throw new TypeError("a mode needs a create(options) function");
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].id === def.id) throw new Error("mode '" + def.id + "' is already registered");
    }
    registry.push(copyDef(def));
  }

  function find(id) {
    for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return registry[i];
    return null;
  }

  function get(id) {
    var d = find(id);
    return d ? copyDef(d) : null;
  }

  function list() {
    return registry.map(copyDef);
  }

  function ids() {
    return registry.map(function (d) {
      return d.id;
    });
  }

  // Names of interface members the instance lacks ([] when it conforms).
  function check(instance) {
    if (!instance || typeof instance !== "object") return INTERFACE.slice();
    return INTERFACE.filter(function (name) {
      return typeof instance[name] !== "function";
    });
  }

  function create(id, options) {
    var d = find(id);
    if (!d) throw new RangeError("no mode is registered as '" + id + "'");
    var inst = d.create(options || {});
    var missing = check(inst);
    if (missing.length) throw new TypeError("mode '" + id + "' is missing " + missing.join(", "));
    return inst;
  }

  // ----- bounded preparation ------------------------------------------------

  function now() {
    if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  // A stepper over tasks { run() -> done, required?, weight?, progress?() }.
  // Each run() call does one bounded unit of work. step(budgetMs) runs units
  // until the budget is spent (always at least one); step() with no budget runs
  // everything. The clock only decides how much work happens per call, never
  // what the work computes.
  function stepper(tasks) {
    var list = tasks.slice();
    var units = list.map(function () {
      return 0;
    });
    var finished = list.map(function () {
      return false;
    });
    var api = { done: false, ready: false, progress: 0, step: step };

    function refresh() {
      var total = 0;
      var got = 0;
      var ready = true;
      var done = true;
      for (var i = 0; i < list.length; i++) {
        var w = list[i].weight === undefined ? 1 : list[i].weight;
        total += w;
        var p;
        if (finished[i]) p = 1;
        else if (typeof list[i].progress === "function") p = Math.max(0, Math.min(0.999, list[i].progress()));
        else p = 1 - 1 / (1 + units[i]);
        got += w * p;
        if (!finished[i]) {
          done = false;
          if (list[i].required) ready = false;
        }
      }
      api.done = done;
      api.ready = ready;
      api.progress = done ? 1 : total > 0 ? got / total : 1;
    }

    function step(budgetMs) {
      var limit = budgetMs === undefined ? Infinity : budgetMs;
      var start = now();
      var first = true;
      while (!api.done && (first || now() - start < limit)) {
        first = false;
        for (var i = 0; i < list.length; i++) {
          if (finished[i]) continue;
          units[i]++;
          if (list[i].run()) finished[i] = true;
          break;
        }
        refresh();
      }
      return api.done;
    }

    refresh();
    return api;
  }

  // ----- set statistics (mean, spread), cached per set and extended on append

  var statsCache = typeof WeakMap === "function" ? new WeakMap() : null;

  function addRows(st, X, from, to, D) {
    for (var i = from; i < to; i++) {
      var o = i * D;
      for (var d = 0; d < D; d++) {
        var x = X[o + d];
        st.sum[d] += x;
        st.sumSq += x * x;
      }
    }
    st.count = to;
    finishStats(st, D);
  }

  function finishStats(st, D) {
    var n = st.count;
    var m2 = 0;
    for (var d = 0; d < D; d++) {
      var m = n > 0 ? st.sum[d] / n : 0;
      st.mean[d] = m;
      m2 += m * m;
    }
    var tv = n > 0 ? st.sumSq / n - m2 : 0;
    st.totalVariance = tv > 0 ? tv : 0;
    // Root mean squared distance from the mean: the cloud's typical radius.
    st.radius = Math.sqrt(st.totalVariance) || 1;
  }

  // Cheap check that `set` starts with `previous` (an append of it): same
  // dimension, no fewer points, and the first and last rows of `previous` are
  // equal in both. Not a proof; it catches a wrong `previous` in O(D).
  function isPrefix(previous, set) {
    var D = set.dimension;
    if (!previous || previous.dimension !== D || !(previous.count <= set.count)) return false;
    var n = previous.count;
    if (n === 0) return true;
    var a = previous.vectors;
    var b = set.vectors;
    var last = (n - 1) * D;
    for (var d = 0; d < D; d++) {
      if (a[d] !== b[d] || a[last + d] !== b[last + d]) return false;
    }
    return true;
  }

  // stats(set) -> { count, dimension, mean: Float32Array(D), radius, totalVariance }.
  // O(N * D) the first time for a set; an appended set built from a set seen
  // before (pass it as `previous`) costs O(k * D) for the k new rows.
  // Precondition: `set` is `previous` with points appended. A `previous` that
  // fails the cheap check (isPrefix) is ignored and the stats are recomputed.
  function stats(set, previous) {
    if (statsCache && statsCache.has(set)) return statsCache.get(set);
    var D = set.dimension;
    var st;
    var prev = previous && statsCache ? statsCache.get(previous) : null;
    if (prev && isPrefix(previous, set) && prev.count === previous.count) {
      st = { count: prev.count, dimension: D, sum: Float64Array.from(prev.sum), sumSq: prev.sumSq, mean: new Float32Array(D) };
      addRows(st, set.vectors, prev.count, set.count, D);
    } else {
      st = { count: 0, dimension: D, sum: new Float64Array(D), sumSq: 0, mean: new Float32Array(D) };
      addRows(st, set.vectors, 0, set.count, D);
    }
    if (statsCache) statsCache.set(set, st);
    return st;
  }

  // A sliced form of stats(set) for a stepper task. run() adds the next rows
  // (about STATS_WORK values, so about half a millisecond) and returns true
  // once the statistics are complete and cached; job.result is then the same
  // object stats(set) returns, with the same values bit for bit (the rows are
  // added in the same order). A set whose statistics are cached finishes at once.
  var STATS_WORK = 1 << 19;
  function statsJob(set) {
    var D = set.dimension;
    var rows = Math.max(1, Math.floor(STATS_WORK / Math.max(1, D)));
    var st = null;
    var job = {
      result: null,
      progress: function () {
        return job.result ? 1 : st && set.count > 0 ? st.count / set.count : 0;
      },
      run: function () {
        if (job.result) return true;
        if (!st && statsCache && statsCache.has(set)) {
          job.result = statsCache.get(set);
          return true;
        }
        if (!st) st = { count: 0, dimension: D, sum: new Float64Array(D), sumSq: 0, mean: new Float32Array(D) };
        addRows(st, set.vectors, st.count, Math.min(set.count, st.count + rows), D);
        if (st.count < set.count) return false;
        if (statsCache && !statsCache.has(set)) statsCache.set(set, st);
        job.result = statsCache ? statsCache.get(set) : st;
        return true;
      },
    };
    return job;
  }

  // ----- shared motion helpers ------------------------------------------------

  // A centre that glides exponentially (time constant tau seconds) from where it
  // is toward a target; retarget(t, target) starts a new segment at time t from
  // wherever the glide is then, so a moved target never makes it jump. Pure in t
  // for a fixed list of retargets.
  function makeGlide(start, target, tau, D) {
    var segs = [{ t0: 0, from: Float64Array.from(start), to: Float64Array.from(target) }];
    function segFor(t) {
      var s = segs[0];
      for (var i = 1; i < segs.length; i++) if (segs[i].t0 <= t) s = segs[i];
      return s;
    }
    function at(t, out) {
      var res = out || new Float32Array(D);
      var s = segFor(t);
      var dt = t - s.t0;
      var k = dt <= 0 ? 1 : Math.exp(-dt / tau);
      for (var d = 0; d < D; d++) res[d] = s.to[d] + (s.from[d] - s.to[d]) * k;
      return res;
    }
    function retarget(t, newTarget) {
      var here = Float64Array.from(at(t));
      // drop segments that start after t: they belonged to a future that changed
      segs = segs.filter(function (s) {
        return s.t0 <= t;
      });
      segs.push({ t0: t, from: here, to: Float64Array.from(newTarget) });
    }
    return { at: at, retarget: retarget };
  }

  // The permutation and signs that alignTo applied to `target` to match `ref`,
  // so the same relabelling of axes can be applied to later frames.
  function alignment(target, ref, D) {
    var aligned = ET.math.alignTo(target, ref, D);
    var perm = [0, 1, 2];
    var sign = [1, 1, 1];
    for (var j = 0; j < 3; j++) {
      var best = 0;
      var bestAbs = -1;
      var bestDot = 0;
      for (var i = 0; i < 3; i++) {
        var dp = 0;
        for (var d = 0; d < D; d++) dp += aligned[j * D + d] * target[i * D + d];
        if (Math.abs(dp) > bestAbs) {
          bestAbs = Math.abs(dp);
          best = i;
          bestDot = dp;
        }
      }
      perm[j] = best;
      sign[j] = bestDot < 0 ? -1 : 1;
    }
    return { perm: perm, sign: sign };
  }

  function applyAlignment(frame, al, D, out) {
    var res = out || new Float32Array(3 * D);
    for (var j = 0; j < 3; j++) {
      var src = al.perm[j] * D;
      var s = al.sign[j];
      for (var d = 0; d < D; d++) res[j * D + d] = s * frame[src + d];
    }
    return res;
  }

  // Copy of an entry state handed to enter({ from }), or null.
  function entryFrom(from, D) {
    if (!from || !from.frame || from.frame.length !== 3 * D) return null;
    var e = { frame: new Float32Array(from.frame), centre: null, draw: {} };
    ET.math.orthonormalize(e.frame, 3, D);
    if (from.centre && from.centre.length === D) e.centre = new Float32Array(from.centre);
    if (from.draw && typeof from.draw === "object") {
      for (var k in from.draw) {
        if (Object.prototype.hasOwnProperty.call(from.draw, k) && typeof from.draw[k] === "number" && isFinite(from.draw[k])) {
          e.draw[k] = from.draw[k];
        }
      }
    }
    return e;
  }

  // Blend numeric draw parameters from the entry's toward the mode's own over
  // `duration` seconds (smoothstep). Keys the entry lacks are the mode's at once.
  function blendDraw(draw, entry, t, duration) {
    if (!entry || !(t < duration)) return draw;
    var e = ET.math.smoothstep(t / duration);
    for (var k in draw) {
      if (Object.prototype.hasOwnProperty.call(entry.draw, k)) draw[k] = entry.draw[k] + (draw[k] - entry.draw[k]) * e;
    }
    return draw;
  }

  // A deterministic starting frame for a mode entered with no previous view.
  var SALT_START = 0x5157a7;
  function startFrame(D, seed) {
    return ET.math.randomFrame(D, ET.math.makeRandom(ET.math.mixSeed(seed, SALT_START)));
  }

  // Auto-framing. The reference's rule is zoom = 0.78 / rms of the projected
  // coordinates. On a guided tour the regions sit far apart as compact blobs,
  // so the outermost ones (and their names) left the stage although the rms was
  // the reference's (measured on the sample set: the tour's 98th-percentile
  // radius is 1.6 times its rms, and the group names sit on the outermost
  // blobs). So the zoom is also capped so that the 98th-percentile radius of the
  // sample lands at AUTO_FIT units, which leaves room for the names inside the
  // shorter side of the stage (the renderer maps 1 unit to 0.46 of it, so the
  // edge is at 1.087 units). zoom = min(0.78 / rms, AUTO_FIT / p98). An even
  // cloud keeps the reference's framing. The sample is fixed (the first
  // `sample` points, 512 by default) so an append past it does not change the
  // framing. A pure function of the data, the frame and the centre.
  var AUTO_FIT = 0.88;
  var radii = new Float64Array(0);
  function autoZoom(X, N, D, frame, centre, sample) {
    var n = Math.min(N, sample || 512);
    if (n <= 0) return 1;
    if (radii.length < n) radii = new Float64Array(n);
    var sq = 0;
    for (var i = 0; i < n; i++) {
      var o = i * D;
      var a = 0;
      var b = 0;
      var c = 0;
      for (var d = 0; d < D; d++) {
        var x = X[o + d] - centre[d];
        a += x * frame[d];
        b += x * frame[D + d];
        c += x * frame[2 * D + d];
      }
      var r2 = a * a + b * b + c * c;
      sq += r2;
      radii[i] = r2;
    }
    var rms = Math.sqrt(sq / n);
    if (!(rms > 0)) return 1;
    var view = radii.subarray(0, n);
    view.sort();
    var p98 = Math.sqrt(view[Math.min(n - 1, Math.floor(0.98 * (n - 1)))]);
    var zoom = 0.78 / rms;
    return p98 > 0 && AUTO_FIT / p98 < zoom ? AUTO_FIT / p98 : zoom;
  }

  // The sample set's typical radius (root mean squared distance from the mean,
  // measured: 0.963 at 384-d and 0.968 at 1024-d). The reference's distances
  // (fog, Wander's zoom) were tuned by eye at this scale; modes scale them by
  // radius / REFERENCE_RADIUS so other data looks the same.
  var REFERENCE_RADIUS = 0.963;

  // "12,345": a fixed thousands separator (no locale dependence).
  function thousands(n) {
    var s = String(Math.round(n));
    var neg = s.charAt(0) === "-";
    if (neg) s = s.slice(1);
    var out = "";
    while (s.length > 3) {
      out = "," + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return (neg ? "-" : "") + s + out;
  }

  // A point is labelled when its label is non-empty and is not just its id
  // (a labels-only set repeats the id as the label).
  function isLabelled(p) {
    return !!p && typeof p.label === "string" && p.label.trim() !== "" && p.label !== p.id;
  }

  // Throws a RangeError naming the data when a set has too few dimensions.
  function requireDimension(set, min, title) {
    var D = set && set.dimension;
    if (!(D >= min)) {
      throw new RangeError(
        "the set has dimension " + D + "; " + title + " needs at least " + min + " dimensions",
      );
    }
  }

  // The state a mode shows while it has nothing to move through (no points
  // yet, or still preparing): the hold frame, the entry centre (or zeros) and
  // the entry's draw parameters, no wires.
  function holdState(out, frame, entry, t, status) {
    out.t = t;
    out.frame.set(frame);
    if (entry && entry.centre) out.centre.set(entry.centre);
    else out.centre.fill(0);
    out.draw = entry ? Object.assign({}, entry.draw) : { wires: 0, fog: 0 };
    out.wires = null;
    out.focus = null;
    out.status = status;
    return out;
  }

  // What dataChanged returns: more work to pump (or null), and whether mode
  // time restarted at 0 (the mode re-entered; the viewer resets its clock and
  // waits for isReady()).
  function changed(work, restart) {
    return { work: work || null, restart: !!restart };
  }

  var EMPTY_STATUS = "no points yet";

  function checkTime(t) {
    if (typeof t !== "number" || !isFinite(t)) throw new RangeError("time must be a finite number");
    return t < 0 ? 0 : t;
  }

  return {
    INTERFACE: INTERFACE.slice(),
    register: register,
    get: get,
    list: list,
    ids: ids,
    check: check,
    create: create,
    stepper: stepper,
    now: now,
    stats: stats,
    statsJob: statsJob,
    makeGlide: makeGlide,
    alignment: alignment,
    applyAlignment: applyAlignment,
    entryFrom: entryFrom,
    blendDraw: blendDraw,
    startFrame: startFrame,
    autoZoom: autoZoom,
    AUTO_FIT: AUTO_FIT,
    REFERENCE_RADIUS: REFERENCE_RADIUS,
    thousands: thousands,
    isLabelled: isLabelled,
    checkTime: checkTime,
    requireDimension: requireDimension,
    holdState: holdState,
    changed: changed,
    isPrefix: isPrefix,
    EMPTY_STATUS: EMPTY_STATUS,
  };
})();
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
    var fitAtEntry = false; // decided once per entry: the entry waits for the fit
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
      fitAtEntry = wantsGuided(s);
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

    // Does set `s` get hidden directions from its strongest directions? Decided
    // once, at entry (fitAtEntry), so an append never leaves the mode waiting for a
    // fit that was not scheduled.
    function wantsGuided(s) {
      return opt.hidden !== "full" && Math.min(opt.subspace, s.dimension) >= 4 && s.count > 1;
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
      if (fitAtEntry) tasks = tasks.concat(fitTasks());
      tasks.push(knnTask());
      return M.stepper(tasks);
    }

    function isReady() {
      return empty ? emptyReady : glide !== null && (guided || !fitAtEntry);
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
    // first points onto an empty set, the points that make a set entered without a
    // fit (one point) big enough for one, a replace, or another dimension: start
    // over from the current view.
    function dataChanged(newSet, info) {
      var i = info || {};
      var t = i.t === undefined ? self.time : M.checkTime(i.t);
      var fitNow = !fitAtEntry && newSet.dimension === D && wantsGuided(newSet);
      if (i.op !== "append" || newSet.dimension !== D || empty || fitNow || !isReady()) {
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

  function create(options) {
    var opt = {};
    for (var k in DEFAULTS) opt[k] = options && options[k] !== undefined ? options[k] : DEFAULTS[k];
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
      for (var b = 0; b < lab.length; b++) {
        if (!mark[lab[b]]) {
          p.push(lab[b]);
          mark[lab[b]] = 1;
        }
      }
      var visit = lab.length >= 2 ? Int32Array.from(lab) : Int32Array.from(p);
      var inVisit = new Uint8Array(N);
      for (var c = 0; c < visit.length; c++) inVisit[visit[c]] = 1;
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
            startCentre = entry && entry.centre ? new Float32Array(entry.centre) : new Float32Array(st.mean);
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
        if (filled === K && (s > bestD[K - 1] || (s === bestD[K - 1] && i > bestI[K - 1]))) continue;
        var pos = filled < K ? filled : K - 1;
        while (pos > 0 && (bestD[pos - 1] > s || (bestD[pos - 1] === s && bestI[pos - 1] > i))) {
          bestD[pos] = bestD[pos - 1];
          bestI[pos] = bestI[pos - 1];
          pos--;
        }
        bestD[pos] = s;
        bestI[pos] = i;
        if (filled < K) filled++;
      }
      sc.q = stop;
      sc.filled = filled;
      return stop >= pool.length;
    }

    function scanFinish(sc) {
      var nb = sc.bestI.subarray(0, sc.filled);
      sc.c.nbr.set(sc.j, nb);
      return nb;
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
          return recent.indexOf(j) < 0;
        });
        if (near.length) return near[Math.floor(rng.next() * Math.min(near.length, opt.nearChoices))];
      }
      var gi = groupOf(i);
      for (var tries = 0; tries < 40; tries++) {
        var j = visit[Math.floor(rng.next() * visit.length)];
        if (j !== i && recent.indexOf(j) < 0 && (gi === "" || groupOf(j) !== gi)) return j;
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

    function stateAt(time) {
      var t = M.checkTime(time);
      out.t = t;
      if (!ready || empty) return M.holdState(out, startFrame, entry, t, status(t));
      var hp = hopAt(t);
      var h = hp.h;
      ensure(h - 1);
      ensure(h);
      var prevRec = rec(h - 1);
      var hereRec = rec(h);
      workAhead(h + 1);
      var j = hereRec.target;
      var fromF = prevRec.frame;
      var toF = hereRec.frame;
      var X = set.vectors;
      var oj = j * D;
      var phase;
      var e;
      if (hp.local < opt.travel) {
        phase = "travel";
        e = ET.math.smoothstep(hp.local / opt.travel);
        var oc = h > 0 ? prevRec.target * D : -1;
        for (var d = 0; d < D; d++) {
          var a = oc >= 0 ? X[oc + d] : startCentre[d];
          tmpC[d] = a + (X[oj + d] - a) * e;
        }
        for (var d2 = 0; d2 < D; d2++) out.centre[d2] = tmpC[d2];
        ET.math.blendFrames(fromF, toF, e, D, out.frame);
      } else {
        phase = "dwell";
        e = 1;
        for (var d3 = 0; d3 < D; d3++) out.centre[d3] = X[oj + d3];
        ET.math.blendFrames(fromF, toF, 1, D, out.frame);
      }
      out.focus = {
        phase: phase,
        from: h > 0 ? prevRec.target : -1,
        to: j,
        e: e,
        neighbours: Int32Array.from(nearVisits(ctx, j, opt.spokes)),
      };
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
      out.draw = M.blendDraw(draw, entry, t, opt.transition);
      out.status = status(t);
      return out;
    }

    // A point's name for the status line, cut to 24 characters so the line
    // stays short (the full label is the viewer's to show).
    function nameOf(i) {
      var p = set.points[i];
      var n = M.isLabelled(p) ? p.label : p.id;
      return n.length > 24 ? n.slice(0, 23) + "…" : n;
    }

    function describeStop(h, phase) {
      var j = rec(h).target;
      if (phase === "dwell") {
        var g = groupOf(j);
        return 'at "' + nameOf(j) + '"' + (g ? " · " + g : "") + " · stop " + (h + 1);
      }
      var i = h > 0 ? rec(h - 1).target : -1;
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
      var hp = hopAt(t);
      ensure(hp.h - 1);
      ensure(hp.h);
      return describeStop(hp.h, hp.local < opt.travel ? "travel" : "dwell");
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
          from = { frame: new Float32Array(s.frame), centre: null, draw: Object.assign({}, s.draw) };
          if (!empty || (entry && entry.centre)) from.centre = new Float32Array(s.centre);
        }
        enter(newSet, { seed: seed, from: from });
        return M.changed(prepare(), true);
      }
      var h = hopAt(t).h;
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
        visiting: ctx && ctx.labelled >= 2 ? "labelled points" : "any point",
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
// ---------------------------------------------------------------------------
// 50-viewer.js: the public viewer API (task t8).
//
//   EmbeddingsTumbler.mount(el, options)  -> handle
//   EmbeddingsTumbler.update(el, data)    -> result   (also handle.update(data))
//   EmbeddingsTumbler.destroy(el)         -> boolean  (also handle.destroy())
//
// The viewer owns the DOM inside the host's element, the renderer, the clock, the
// active mode, labels, controls, the readout strip and the provenance block. It
// validates data with ET.contract, draws with ET.renderer and moves with ET.modes.
//
// Rules this module keeps (see js/api/50-viewer.md):
//   * It changes nothing outside the given element: one child element is appended
//     to it and removed again by destroy. No global style, no class on the page,
//     no global variable. Listeners on the document (visibility) and window
//     (resize, only without ResizeObserver) are removed by destroy.
//   * Every style is set through element.style from script, never through a style
//     attribute or a style element, so a strict style-src policy allows it.
//   * Text from data goes in with textContent only. Nothing parses markup.
//   * It makes no network request of any kind and builds no resource address.
//   * Bad data never throws into the host: the refusal is shown inside the element
//     and returned to the caller.
//   * No frame work runs while the document is hidden or the element is off
//     screen: the animation loop is not scheduled at all then.
// ---------------------------------------------------------------------------
ET.viewer = (function () {
  var TAU = Math.PI * 2;

  // The reference's look. Group hues are the reference's, in its region order;
  // groups take them in order of first appearance in the data.
  var GROUP_HUES = [28, 52, 96, 140, 170, 198, 226, 266, 328, 4, 298];
  var MAX_GROUP_PROPS = 24; // --tumbler-group-1 .. --tumbler-group-24
  var DARK = {
    background: "#04060b",
    sky: "#0b1430",
    foreground: "#e9eef6",
    muted: "#8a96ab",
    line: "#1b2436",
    accent: "#ffc56b",
    ungrouped: "#8cadff",
  };
  var LIGHT = {
    background: "#f6f4ee",
    sky: "#ffffff",
    foreground: "#1b2130",
    muted: "#5b6578",
    line: "#d6dae2",
    accent: "#a35f00",
    ungrouped: "#8cadff",
  };
  var FONTS = {
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    data: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    display: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  };
  var STAGE_HEIGHT = "clamp(300px, 62vh, 860px)";
  // How the picture is drawn on a light host (--tumbler-light-style or the lightStyle
  // option): "panel" keeps a dark night-sky stage inside the light panel; "ink" draws
  // each group as saturated coloured ink on the light sky; "soft" is ink, lighter.
  var LIGHT_STYLES = ["panel", "ink", "soft"];
  var DEFAULT_LIGHT_STYLE = "soft"; // the owner's choice at sign-off (2026-11-14)

  var DEFAULT_OPTIONS = {
    mode: "tumble",
    seed: 1,
    speed: 1,
    paused: null, // null: follow prefers-reduced-motion
    labels: true,
    trails: true,
    controls: true,
    readout: true,
    masthead: true,
    title: "",
    provenanceOpen: true,
    lightStyle: null, // null: --tumbler-light-style, else DEFAULT_LIGHT_STYLE
    modeOptions: null, // { tumble: {...}, ... } passed to ET.modes.create
    maxPixelRatio: 2,
    preserveDrawingBuffer: false,
    prepareBudgetMs: 8,
    refitQuietSeconds: 2,
    refitShare: 0.01,
    onError: null,
    onModeChange: null,
    onPauseChange: null,
  };

  var CROWD_REF = 600; // bright points a view shows at full brightness (see crowding)
  var CROWD_POWER = 1;
  var BRIGHT_WEIGHT = 0.7; // a point painted at this weight or more counts toward the light load
  var LABEL_SAMPLE = 300; // labelled points projected on the CPU per frame for labels
  var LABEL_POOL = 64; // label elements at most
  var STATUS_EVERY = 0.12; // seconds between status-line updates (the reference's)
  var ZOOM_MIN = 0.2;
  var ZOOM_MAX = 12;
  var SPIN = 0.06; // rad/s of yaw while running (the reference's)
  var BUTTON_HEIGHT = "28px"; // the reference's Pause button
  var TOUCH_HEIGHT = "32px"; // the same buttons under 600 px wide
  // Names over the sky: the reference strokes each name with a 4 px line of the
  // background at 0.85 under the fill. As page text that is a ring of hard
  // shadows: 8 at 1.5 px (slightly soft) and 8 at 2 px (half strength), which
  // came closest to the reference's canvas stroke in Chromium (measured against
  // it) and needs nothing beyond text-shadow, so every browser draws it.
  var OUTLINE_RING = (function () {
    var out = [];
    for (var k = 0; k < 8; k++) {
      var th = (Math.PI * 2 * k) / 8;
      out.push([Math.cos(th), Math.sin(th)]);
    }
    return out;
  })();
  var SHADOW =
    "A projection is a shadow of the space, not the space: each view shows three " +
    "linear directions out of all of them, so points that look close may be far apart " +
    "and points that look apart may be close.";

  // Registry of live viewers, keyed by element. Nothing else is shared between viewers.
  var live = typeof WeakMap === "function" ? new WeakMap() : null;
  var liveList = []; // fallback when WeakMap is missing: [{ el, v }]

  function lookup(el) {
    if (!el || typeof el !== "object") return null;
    if (live) return live.get(el) || null;
    for (var i = 0; i < liveList.length; i++) if (liveList[i].el === el) return liveList[i].v;
    return null;
  }
  function remember(el, v) {
    if (live) live.set(el, v);
    else liveList.push({ el: el, v: v });
  }
  function forget(el) {
    if (live) live.delete(el);
    else liveList = liveList.filter(function (r) {
      return r.el !== el;
    });
  }

  // ---------- small pure helpers ----------

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  function hsl(h, s, l) {
    function f(n) {
      var k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }

  function hashUnit(i) {
    var x = Math.abs(Math.sin(i * 12.9898) * 43758.5453);
    return x - Math.floor(x);
  }

  function thousands(n) {
    var s = String(Math.round(n));
    var neg = s.charAt(0) === "-";
    if (neg) s = s.slice(1);
    var out = "";
    while (s.length > 3) {
      out = "," + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return (neg ? "-" : "") + s + out;
  }

  function percent(x, digits) {
    return (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function shorten(text, max) {
    var s = String(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // Parse a CSS colour into [r, g, b] (0..1). Hex, rgb()/rgba() and hsl()/hsla() in
  // comma or space syntax. Returns null for anything else.
  function parseColour(str) {
    if (typeof str !== "string") return null;
    var s = str.trim().toLowerCase();
    if (!s) return null;
    var m = /^#([0-9a-f]{3,8})$/.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) {
        return [0, 1, 2].map(function (i) {
          return parseInt(h.charAt(i) + h.charAt(i), 16) / 255;
        });
      }
      if (h.length === 6 || h.length === 8) {
        return [0, 2, 4].map(function (i) {
          return parseInt(h.slice(i, i + 2), 16) / 255;
        });
      }
      return null;
    }
    m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
    if (!m) return null;
    var parts = m[2].split(/[\s,/]+/).filter(function (p) {
      return p !== "";
    });
    if (parts.length < 3) return null;
    function num(p, scale) {
      var pct = p.charAt(p.length - 1) === "%";
      var x = parseFloat(p);
      if (!isFinite(x)) return NaN;
      return pct ? x / 100 : x / scale;
    }
    if (m[1].charAt(0) === "r") {
      var rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
      if (rgb.some(isNaN)) return null;
      return rgb.map(function (c) {
        return clamp(c, 0, 1);
      });
    }
    var hue = parseFloat(parts[0]);
    var sat = num(parts[1], 100);
    var lig = num(parts[2], 100);
    if (!isFinite(hue) || isNaN(sat) || isNaN(lig)) return null;
    return hsl(((hue % 360) + 360) % 360, clamp(sat, 0, 1), clamp(lig, 0, 1));
  }

  function cssRgb(c, alpha) {
    var r = Math.round(clamp(c[0], 0, 1) * 255);
    var g = Math.round(clamp(c[1], 0, 1) * 255);
    var b = Math.round(clamp(c[2], 0, 1) * 255);
    if (alpha === undefined || alpha >= 1) return "rgb(" + r + ", " + g + ", " + b + ")";
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function luminance(c) {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // A value the host may put in a font or length property. Anything that could name
  // a resource is refused (only plain names, numbers and length functions pass).
  function safeCssValue(s) {
    if (typeof s !== "string") return "";
    var t = s.trim();
    if (!t || t.length > 300) return "";
    if (/url\s*\x28|image-set|\\|[;{}<>]/i.test(t)) return "";
    return t;
  }

  function setStyles(el, styles) {
    var st = el.style;
    for (var k in styles) {
      if (Object.prototype.hasOwnProperty.call(styles, k)) st[k] = styles[k];
    }
  }

  function readOption(options, key) {
    if (options && Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined) {
      return options[key];
    }
    return DEFAULT_OPTIONS[key];
  }

  function isElement(el) {
    return (
      !!el &&
      typeof el === "object" &&
      el.nodeType === 1 &&
      typeof el.appendChild === "function" &&
      !!el.ownerDocument
    );
  }

  function call(v, fn, arg) {
    if (typeof fn !== "function") return;
    try {
      fn(arg);
    } catch (err) {
      reportHostError(v, err);
    }
  }

  // A host callback's own error is the host's: rethrow it on a later task, outside the
  // viewer's stack, so the host's error handling sees it and the viewer keeps running.
  // Without setTimeout, a microtask; without that, console.error. Never dropped.
  function reportHostError(v, err) {
    var w = v.win || {};
    var rethrow = function () {
      throw err;
    };
    if (typeof w.setTimeout === "function") w.setTimeout(rethrow, 0);
    else if (typeof w.queueMicrotask === "function") w.queueMicrotask(rethrow);
    else {
      var c = w.console || (typeof console !== "undefined" ? console : null);
      if (c && typeof c.error === "function") c.error("embeddings-tumbler: a host callback threw", err);
    }
  }

  // ---------- DOM building ----------

  function make(v, tag, cls, styles) {
    var el = v.doc.createElement(tag);
    if (cls) el.className = cls;
    if (styles) setStyles(el, styles);
    return el;
  }

  function text(v, tag, cls, str, styles) {
    var el = make(v, tag, cls, styles);
    el.textContent = str;
    return el;
  }

  function pillButton(v, cls, label) {
    var b = text(v, "button", cls, label, {
      fontFamily: "inherit",
      fontSize: "12px",
      lineHeight: "1.15",
      color: "inherit",
      background: "transparent",
      border: "1px solid",
      borderRadius: "999px",
      // The reference's .ctl button: 6 px by 16 px padding, at least 76 px wide,
      // 28 px tall at 12 px type. Under 600 px wide layoutForWidth raises the
      // height to TOUCH_HEIGHT for fingers.
      padding: "6px 16px",
      minHeight: BUTTON_HEIGHT,
      minWidth: "76px",
      cursor: "pointer",
      margin: "0",
    });
    b.type = "button";
    return b;
  }

  function build(v) {
    var root = make(v, "div", "tumbler", {
      position: "relative",
      display: "block",
      width: "100%",
      boxSizing: "border-box",
      margin: "0",
      padding: "0",
      textAlign: "left",
      fontSize: "14px",
      lineHeight: "1.5",
      overflowWrap: "break-word",
    });
    root.tabIndex = 0;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Embedding space viewer");
    root.setAttribute("aria-roledescription", "embedding space viewer");
    v.root = root;

    var stage = make(v, "div", "tumbler-stage", {
      position: "relative",
      width: "100%",
      overflow: "hidden",
      touchAction: "pan-y",
      cursor: "grab",
      isolation: "isolate",
      userSelect: "none",
      webkitUserSelect: "none",
    });
    v.stage = stage;
    var full = { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "block" };
    var gl = make(v, "canvas", "tumbler-canvas", full);
    gl.setAttribute("role", "img");
    gl.setAttribute("aria-label", "Animated 3-D projection of an embedding space (no data yet)");
    v.canvas = gl;
    var overlay = make(v, "canvas", "tumbler-overlay", full);
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.pointerEvents = "none";
    v.overlay = overlay;
    var labels = make(v, "div", "tumbler-labels", {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      overflow: "hidden",
      pointerEvents: "none",
    });
    labels.setAttribute("aria-hidden", "true");
    v.labelLayer = labels;

    var mast = make(v, "div", "tumbler-masthead", {
      position: "absolute",
      top: "14px",
      left: "16px",
      right: "16px",
      pointerEvents: "none",
      zIndex: "2",
    });
    v.mastTitle = text(v, "p", "tumbler-title", "", {
      margin: "0 0 6px",
      fontStyle: "italic",
      fontWeight: "400",
      fontSize: "clamp(28px, 6vw, 56px)",
      lineHeight: "0.95",
    });
    v.mastLine = text(v, "p", "tumbler-subtitle", "", {
      margin: "0",
      fontSize: "12px",
      letterSpacing: "0.06em",
      textTransform: "uppercase",
    });
    mast.appendChild(v.mastTitle);
    mast.appendChild(v.mastLine);
    v.masthead = mast;

    var status = text(v, "p", "tumbler-status", "waiting for data", {
      position: "absolute",
      left: "16px",
      right: "16px",
      bottom: "10px",
      margin: "0",
      fontSize: "12px",
      lineHeight: "1.4",
      pointerEvents: "none",
      zIndex: "2",
      whiteSpace: "normal",
      fontVariantNumeric: "tabular-nums",
    });
    status.setAttribute("aria-live", "off");
    v.status = status;

    var fatal = make(v, "div", "tumbler-message", {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      textAlign: "center",
      zIndex: "4",
      boxSizing: "border-box",
    });
    fatal.setAttribute("role", "alert");
    v.fatalText = text(v, "p", "tumbler-message-text", "", { margin: "0", maxWidth: "52ch" });
    fatal.appendChild(v.fatalText);
    v.fatal = fatal;

    var notice = make(v, "div", "tumbler-notice", {
      position: "absolute",
      left: "12px",
      right: "12px",
      top: "12px",
      display: "none",
      alignItems: "flex-start",
      gap: "10px",
      padding: "8px 10px 8px 12px",
      fontSize: "12px",
      lineHeight: "1.45",
      border: "1px solid",
      borderRadius: "6px",
      zIndex: "3",
      boxSizing: "border-box",
    });
    notice.setAttribute("role", "alert");
    v.noticeText = text(v, "p", "tumbler-notice-text", "", { margin: "0", flex: "1 1 auto", minWidth: "0" });
    var dismiss = pillButton(v, "tumbler-notice-dismiss", "Dismiss");
    dismiss.style.flex = "0 0 auto";
    dismiss.style.minWidth = "0";
    dismiss.style.padding = "2px 10px";
    dismiss.style.minHeight = "24px";
    notice.appendChild(v.noticeText);
    notice.appendChild(dismiss);
    v.notice = notice;
    v.noticeDismiss = dismiss;

    stage.appendChild(gl);
    stage.appendChild(overlay);
    stage.appendChild(labels);
    stage.appendChild(mast);
    stage.appendChild(status);
    stage.appendChild(notice);
    stage.appendChild(fatal);
    var empty = text(v, "p", "tumbler-empty", "No data yet. Call update(data) to show a set of embeddings.", {
      position: "absolute",
      left: "16px",
      right: "16px",
      top: "50%",
      margin: "0",
      transform: "translateY(-50%)",
      textAlign: "center",
      fontSize: "13px",
      pointerEvents: "none",
      zIndex: "2",
    });
    stage.appendChild(empty);
    v.empty = empty;
    root.appendChild(stage);

    var panel = make(v, "div", "tumbler-panel", {
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      padding: "6px 16px 16px",
    });
    v.panel = panel;

    // Mode switch: one button per registered mode.
    var nav = make(v, "div", "tumbler-modes", { display: "grid", gap: "0", borderTop: "1px solid" });
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", "View");
    v.modeNav = nav;
    v.modeButtons = [];
    var defs = ET.modes.list();
    nav.style.gridTemplateColumns = "repeat(" + Math.max(1, defs.length) + ", minmax(0, 1fr))";
    defs.forEach(function (def, i) {
      var b = make(v, "button", "tumbler-mode", {
        font: "inherit",
        textAlign: "left",
        background: "transparent",
        border: "0",
        borderTop: "2px solid transparent",
        marginTop: "-1px",
        padding: "10px 12px 8px 0",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        minWidth: "0",
        minHeight: "44px",
        color: "inherit",
      });
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("data-mode", def.id);
      b.setAttribute("aria-keyshortcuts", i < 9 ? String(i + 1) : "");
      var title = text(v, "b", "tumbler-mode-title", def.title, {
        fontWeight: "400",
        fontSize: "24px",
        lineHeight: "1.1",
      });
      var summary = text(v, "span", "tumbler-mode-summary", def.summary || "", {
        fontSize: "12.5px",
        lineHeight: "1.35",
      });
      b.appendChild(title);
      b.appendChild(summary);
      nav.appendChild(b);
      v.modeButtons.push({ id: def.id, button: b, title: title, summary: summary });
    });
    panel.appendChild(nav);

    // Readout strip: one cell per dimension of the current frame.
    var readout = make(v, "div", "tumbler-readout", { display: "flex", flexDirection: "column", gap: "6px" });
    // The reference's strip: 22 px of cells between a 1 px line above and below
    // (24 px in all), whatever box-sizing the host page sets.
    var strip = make(v, "canvas", "tumbler-strip", {
      width: "100%",
      height: "22px",
      boxSizing: "content-box",
      display: "block",
      imageRendering: "pixelated",
      borderTop: "1px solid",
      borderBottom: "1px solid",
    });
    strip.width = 1;
    strip.height = 1;
    strip.setAttribute("aria-hidden", "true");
    v.strip = strip;
    var caption = make(v, "p", "tumbler-readout-caption", {
      display: "flex",
      justifyContent: "space-between",
      gap: "4px 12px",
      flexWrap: "wrap",
      margin: "0",
      fontSize: "11.5px",
    });
    v.stripFirst = text(v, "span", "", "dimension 1");
    v.stripMiddle = text(v, "span", "", "how much each dimension contributes to the view right now");
    v.stripLast = text(v, "span", "", "");
    caption.appendChild(v.stripFirst);
    caption.appendChild(v.stripMiddle);
    caption.appendChild(v.stripLast);
    readout.appendChild(strip);
    readout.appendChild(caption);
    v.readout = readout;
    panel.appendChild(readout);

    // Controls.
    var ctl = make(v, "div", "tumbler-controls", {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: "10px 18px",
      fontSize: "12px",
    });
    v.playButton = pillButton(v, "tumbler-play", "Pause");
    v.zoomResetButton = pillButton(v, "tumbler-zoom-reset", "Reset zoom");
    var speedLabel = make(v, "label", "tumbler-speed", { display: "inline-flex", alignItems: "center", gap: "8px" });
    speedLabel.appendChild(text(v, "span", "", "Speed"));
    var speed = make(v, "input", "", { width: "130px" });
    speed.type = "range";
    speed.min = "0.2";
    speed.max = "3";
    speed.step = "0.1";
    speed.value = String(v.speed);
    speed.setAttribute("aria-label", "Speed");
    speedLabel.appendChild(speed);
    v.speedInput = speed;
    function checkbox(cls, label, checked) {
      var l = make(v, "label", cls, { display: "inline-flex", alignItems: "center", gap: "6px" });
      var c = make(v, "input", "", { width: "15px", height: "15px", margin: "0" });
      c.type = "checkbox";
      c.checked = !!checked;
      l.appendChild(c);
      l.appendChild(text(v, "span", "", label));
      return { label: l, input: c };
    }
    var lab = checkbox("tumbler-labels-toggle", "Labels", v.showLabels);
    var trl = checkbox("tumbler-trails-toggle", "Trails", v.trails);
    v.labelsInput = lab.input;
    v.trailsInput = trl.input;
    var hint = text(
      v,
      "span",
      "tumbler-hint",
      "Drag to turn. Pinch, or Ctrl + wheel, to zoom; double-click or double-tap resets. Keys 1-" +
        Math.max(1, Math.min(9, defs.length)) +
        " switch views while the viewer has focus."
    );
    ctl.appendChild(v.playButton);
    ctl.appendChild(v.zoomResetButton);
    ctl.appendChild(speedLabel);
    ctl.appendChild(lab.label);
    ctl.appendChild(trl.label);
    ctl.appendChild(hint);
    v.controlsEl = ctl;
    v.hint = hint;
    panel.appendChild(ctl);

    // Provenance.
    var prov = make(v, "details", "tumbler-provenance", { borderTop: "1px solid", paddingTop: "10px", fontSize: "12px" });
    prov.open = !!v.options.provenanceOpen;
    var summ = text(v, "summary", "tumbler-provenance-summary", "About this view", { cursor: "pointer" });
    var dl = make(v, "dl", "tumbler-provenance-list", {
      display: "grid",
      gridTemplateColumns: "max-content minmax(0, 1fr)",
      gap: "4px 14px",
      margin: "8px 0 0",
    });
    var shadow = text(v, "p", "tumbler-shadow", SHADOW, { margin: "10px 0 0", fontStyle: "italic", maxWidth: "92ch" });
    prov.appendChild(summ);
    prov.appendChild(dl);
    prov.appendChild(shadow);
    v.provenance = prov;
    v.provSummary = summ;
    v.provList = dl;
    v.provShadow = shadow;
    panel.appendChild(prov);

    root.appendChild(panel);

    if (!v.options.controls) ctl.style.display = "none";
    if (!v.options.readout) readout.style.display = "none";
    if (!v.options.masthead) mast.style.display = "none";
    return root;
  }

  // ---------- theme ----------

  function readTheme(v) {
    var cs = null;
    try {
      cs = v.win && typeof v.win.getComputedStyle === "function" ? v.win.getComputedStyle(v.root) : null;
    } catch (err) {
      cs = null;
    }
    function raw(name) {
      if (!cs || typeof cs.getPropertyValue !== "function") return "";
      var s = cs.getPropertyValue(name);
      return typeof s === "string" ? s.trim() : "";
    }
    function colour(name) {
      var s = raw(name);
      if (!s) return null;
      var c = parseColour(s);
      if (c) return c;
      return probeColour(v, s);
    }
    var bg = colour("--tumbler-background");
    var light = bg ? luminance(bg) > 0.5 : false;
    var base = light ? LIGHT : DARK;
    var t = {
      light: light,
      background: bg || parseColour(base.background),
      sky: colour("--tumbler-sky") || parseColour(base.sky),
      foreground: colour("--tumbler-foreground") || parseColour(base.foreground),
      muted: colour("--tumbler-muted") || parseColour(base.muted),
      line: colour("--tumbler-line") || parseColour(base.line),
      accent: colour("--tumbler-accent") || parseColour(base.accent),
      ungrouped: colour("--tumbler-ungrouped") || parseColour(base.ungrouped),
      font: safeCssValue(raw("--tumbler-font")) || FONTS.body,
      fontData: safeCssValue(raw("--tumbler-font-data")) || FONTS.data,
      fontDisplay: safeCssValue(raw("--tumbler-font-display")) || FONTS.display,
      stageHeight: safeCssValue(raw("--tumbler-stage-height")) || STAGE_HEIGHT,
      groups: [],
    };
    for (var i = 0; i < MAX_GROUP_PROPS; i++) {
      t.groups.push(colour("--tumbler-group-" + (i + 1)));
    }
    var style = v.options.lightStyle || raw("--tumbler-light-style");
    t.lightStyle = LIGHT_STYLES.indexOf(style) >= 0 ? style : DEFAULT_LIGHT_STYLE;
    // What the stage (sky, status, labels, messages over it) is drawn with: the host's
    // colours, except a light host with the "panel" style, whose stage stays dark.
    t.panelStage = light && t.lightStyle === "panel";
    t.ink = light && !t.panelStage;
    t.stage = t.panelStage
      ? {
          light: false,
          background: parseColour(DARK.background),
          sky: parseColour(DARK.sky),
          foreground: parseColour(DARK.foreground),
          muted: parseColour(DARK.muted),
          accent: parseColour(DARK.accent),
        }
      : { light: light, background: t.background, sky: t.sky, foreground: t.foreground, muted: t.muted, accent: t.accent };
    return t;
  }

  // Resolve a named or otherwise unparsed colour through the browser: set it on a
  // hidden probe inside the viewer and read the computed value.
  function probeColour(v, s) {
    if (!v.root || !v.win || typeof v.win.getComputedStyle !== "function") return null;
    var probe = null;
    try {
      probe = v.doc.createElement("span");
      probe.style.display = "none";
      probe.style.color = s;
      v.root.appendChild(probe);
      var c = parseColour(String(v.win.getComputedStyle(probe).color || ""));
      return c;
    } catch (err) {
      return null;
    } finally {
      if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
    }
  }

  function groupColour(v, index) {
    if (index < 0) return v.theme.ungrouped;
    if (index < MAX_GROUP_PROPS && v.theme.groups[index]) return v.theme.groups[index];
    if (index < GROUP_HUES.length) return hsl(GROUP_HUES[index], 0.9, 0.62);
    // Past the reference's hues: golden-angle steps, same saturation and lightness.
    return hsl((GROUP_HUES[GROUP_HUES.length - 1] + 137.508 * (index - GROUP_HUES.length + 1)) % 360, 0.9, 0.62);
  }

  function applyTheme(v) {
    var t = v.theme;
    var fg = cssRgb(t.foreground);
    var muted = cssRgb(t.muted);
    var line = cssRgb(t.line);
    var accent = cssRgb(t.accent);
    var bg = cssRgb(t.background);
    setStyles(v.root, { color: fg, background: bg, fontFamily: t.font });
    var st = t.stage;
    var sbg = cssRgb(st.background);
    var sfg = cssRgb(st.foreground);
    var mid = mix(st.sky, st.background, 0.55);
    v.stage.style.height = t.stageHeight;
    v.stage.style.background =
      "radial-gradient(ellipse 75% 70% at 50% 46%, " +
      cssRgb(st.sky) +
      " 0%, " +
      cssRgb(mid) +
      " 48%, " +
      sbg +
      " 82%)";
    // The renderer draws light on black. On a dark stage it is screened over the sky.
    // For ink on a light stage the points are uploaded in complementary colours and the
    // canvas is inverted and multiplied: each group comes out as ink of its own hue.
    // Soft ink is the same ink laid on at 70% opacity: lighter, the hues kept.
    if (t.ink) {
      v.canvas.style.filter = "invert(1)";
      v.canvas.style.mixBlendMode = "multiply";
      v.canvas.style.opacity = t.lightStyle === "soft" ? "0.7" : "1";
    } else {
      v.canvas.style.filter = "none";
      v.canvas.style.mixBlendMode = "screen";
      v.canvas.style.opacity = "1";
    }
    v.mastTitle.style.fontFamily = t.fontDisplay;
    v.mastTitle.style.color = sfg;
    v.mastTitle.style.textShadow = "0 0 28px " + cssRgb(st.background, 0.9);
    v.mastLine.style.fontFamily = t.fontData;
    v.mastLine.style.color = cssRgb(st.muted);
    v.mastLine.style.textShadow = "0 0 12px " + sbg;
    setStyles(v.status, { fontFamily: t.fontData, color: cssRgb(st.accent), textShadow: "0 0 8px " + sbg });
    setStyles(v.fatal, { color: sfg, background: cssRgb(st.background, 0.82), fontFamily: t.font });
    setStyles(v.empty, { color: cssRgb(st.muted), fontFamily: t.fontData });
    setStyles(v.notice, { color: sfg, background: cssRgb(st.background, 0.92), borderColor: cssRgb(st.accent), fontFamily: t.fontData });
    v.noticeDismiss.style.borderColor = t.panelStage ? DARK.line : line;
    v.noticeDismiss.style.color = sfg;
    v.modeNav.style.borderTopColor = line;
    v.modeButtons.forEach(function (mb) {
      mb.title.style.fontFamily = t.fontDisplay;
      mb.summary.style.color = muted;
      mb.button.style.color = muted;
    });
    paintModeButtons(v);
    v.strip.style.borderTopColor = line;
    v.strip.style.borderBottomColor = line;
    v.readout.style.fontFamily = t.fontData;
    v.readout.lastChild.style.color = muted;
    v.readout.lastChild.style.fontFamily = t.fontData;
    setStyles(v.controlsEl, { fontFamily: t.fontData, color: muted });
    [v.playButton, v.zoomResetButton].forEach(function (b) {
      b.style.borderColor = line;
      b.style.color = fg;
      b.style.fontFamily = t.fontData;
    });
    v.speedInput.style.accentColor = accent;
    v.labelsInput.style.accentColor = accent;
    v.trailsInput.style.accentColor = accent;
    setStyles(v.provenance, { borderTopColor: line, fontFamily: t.fontData, color: muted });
    v.provSummary.style.color = fg;
    v.provShadow.style.color = fg;
    v.provShadow.style.fontFamily = t.font;
    // Label elements re-style on their next use.
    v.labelPool.forEach(function (rec) {
      rec.key = "";
    });
    v.outline = outlineShadow(st.background);
    v.stageFg = sfg;
    // The reference's Wander names: the stop in white, its neighbours #c5cddb (the
    // foreground three-eighths of the way to the muted colour). On a light stage the
    // stop takes the foreground, so it stays dark ink.
    v.stopColour = st.light ? sfg : "rgb(255, 255, 255)";
    v.neighbourColour = cssRgb(mix(st.foreground, st.muted, 0.375));
    v.accent255 = [Math.round(t.accent[0] * 255), Math.round(t.accent[1] * 255), Math.round(t.accent[2] * 255)];
  }

  // Read the host's theme and, only when it differs from the one applied, apply it
  // and clear the trails (drawn in the old colours). An update or a refreshTheme()
  // with the theme unchanged leaves the trails, label styles and colours alone.
  // Returns true when the theme changed.
  function syncTheme(v) {
    var t = readTheme(v);
    var key = JSON.stringify(t);
    if (key === v.themeKey) return false;
    v.theme = t;
    v.themeKey = key;
    applyTheme(v);
    v.needClear = true;
    return true;
  }

  // The dark outline under every name, in the stage's background colour.
  function outlineShadow(bg) {
    var strong = cssRgb(bg, 0.85);
    var half = cssRgb(bg, 0.5);
    var parts = [];
    OUTLINE_RING.forEach(function (d) {
      parts.push(px(d[0] * 1.5) + " " + px(d[1] * 1.5) + " 0.5px " + strong);
    });
    OUTLINE_RING.forEach(function (d) {
      parts.push(px(d[0] * 2) + " " + px(d[1] * 2) + " 0 " + half);
    });
    return parts.join(", ");
  }
  function px(x) {
    var r = Math.round(x * 100) / 100;
    return (r === 0 ? 0 : r) + "px";
  }

  // A group's colour for names, the ring and the spokes on a dark stage: the
  // reference draws them at 72% lightness where the points are at 62%, so the
  // lightness is raised by the same share of the way to white (hue and
  // saturation kept). Exact for the reference's hues; the same lift for a host's.
  function nameTint(c) {
    var r = c[0];
    var g = c[1];
    var b = c[2];
    var hi = Math.max(r, g, b);
    var lo = Math.min(r, g, b);
    var l = (hi + lo) / 2;
    var h = 0;
    var s = 0;
    if (hi - lo > 1e-9) {
      var d = hi - lo;
      s = d / (1 - Math.abs(2 * l - 1));
      if (hi === r) h = 60 * (((g - b) / d) % 6);
      else if (hi === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    var l2 = l + (1 - l) * (0.1 / 0.38);
    return hsl(h, clamp(s, 0, 1), clamp(l2, 0, 1));
  }

  function paintModeButtons(v) {
    var current = v.modeId;
    var accent = cssRgb(v.theme.accent);
    var fg = cssRgb(v.theme.foreground);
    v.modeButtons.forEach(function (mb) {
      var on = mb.id === current;
      mb.button.setAttribute("aria-pressed", on ? "true" : "false");
      mb.button.style.borderTopColor = on ? accent : "transparent";
      mb.title.style.color = on ? accent : fg;
      mb.title.style.opacity = on ? "1" : "0.6";
      mb.title.style.fontStyle = on ? "italic" : "normal";
    });
  }

  function refreshTheme(v) {
    if (v.destroyed) return;
    syncTheme(v);
    if (v.set && paintKey(v) !== v.paintKey) recolour(v);
    invalidate(v);
  }

  // What the uploaded point colours depend on; a change means a re-upload.
  function paintKey(v) {
    var t = v.theme;
    return JSON.stringify([t.ink, t.lightStyle, t.ungrouped, t.groups]);
  }

  // ---------- point colours and weights ----------

  function groupIndexOf(v, group) {
    if (typeof group !== "string" || group === "") return -1;
    if (Object.prototype.hasOwnProperty.call(v.groupIndex, group)) return v.groupIndex[group];
    var i = v.groupNames.length;
    v.groupIndex[group] = i;
    v.groupNames.push(group);
    return i;
  }

  // Colours and weights for points [from, to) of the set. Labelled points are full
  // weight and brightened as in the reference; unlabelled points get a small steady
  // weight from their index. When no point is labelled at all (a labels-only set
  // whose labels are its ids), every point gets a middle weight so the view is not
  // all dust.
  // Also returns `bright`: the sum of the weights of the bright points painted (weight
  // BRIGHT_WEIGHT or more), which crowding() reads as the light load.
  function paint(v, set, from, to) {
    var n = to - from;
    var colours = new Float32Array(n * 3);
    var weights = new Float32Array(n);
    var bright = 0;
    var isLabelled = ET.modes.isLabelled;
    for (var i = from; i < to; i++) {
      var p = set.points[i];
      var g = groupIndexOf(v, p.group);
      var c = groupColour(v, g);
      var labelled = isLabelled(p);
      var h = hashUnit(i);
      var w;
      if (labelled) {
        w = 1;
        c = [0.45 + 0.55 * c[0], 0.45 + 0.55 * c[1], 0.45 + 0.55 * c[2]];
      } else if (v.labelledCount === 0) w = 0.7;
      else if (g < 0) w = 0.05 + 0.2 * h * h;
      else w = 0.1 + 0.55 * h * h * h;
      if (v.theme.ink) c = inkUpload(c, labelled);
      var o = (i - from) * 3;
      colours[o] = c[0];
      colours[o + 1] = c[1];
      colours[o + 2] = c[2];
      weights[i - from] = w;
      if (w >= BRIGHT_WEIGHT) bright += w;
    }
    return { colours: colours, weights: weights, bright: bright };
  }

  // Coloured ink: the hue fully saturated and darkened (labelled points a little
  // darker), uploaded as its complement; the canvas's invert(1) turns the additive
  // image back into that ink, multiplied onto the light sky.
  function inkUpload(c, labelled) {
    var lo = Math.min(c[0], c[1], c[2]);
    var hi = Math.max(c[0], c[1], c[2]);
    var span = hi - lo > 1e-6 ? hi - lo : 1;
    var k = labelled ? 0.78 : 0.88;
    var out = [0, 0, 0];
    for (var j = 0; j < 3; j++) {
      var sat = hi - lo > 1e-6 ? (c[j] - lo) / span : 0.5;
      var ink = k * (0.7 * sat + 0.3 * c[j]);
      out[j] = 1 - ink;
    }
    return out;
  }

  function countLabelled(set, from, to) {
    var n = 0;
    for (var i = from; i < to; i++) if (ET.modes.isLabelled(set.points[i])) n++;
    return n;
  }

  // Labelled points projected per frame for labels and hover (at most LABEL_SAMPLE).
  function extendLabelSample(v, set, from) {
    for (var i = from; i < set.count && v.labelSample.length < LABEL_SAMPLE; i++) {
      if (v.labelledCount === 0 || ET.modes.isLabelled(set.points[i])) v.labelSample.push(i);
    }
  }

  function recolour(v) {
    // Re-upload everything with the theme's palette (a theme change). Rare.
    var set = v.set;
    if (!set || !v.renderer || set.count === 0) return;
    var pc = paint(v, set, 0, set.count);
    var res = v.renderer.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
    v.lightLoad = pc.bright;
    if (res && res.ok === false) fatal(v, res.message);
    if (v.mode) v.mode.wiresVersion = -1;
    v.paintKey = paintKey(v);
  }

  // ---------- messages ----------

  // A message over the whole stage. kind "gpu" (no WebGL, lost for good, too many
  // points) or "data" (a refusal while the view holds no set).
  function fatal(v, message, kind) {
    v.fatalKind = kind || "gpu";
    v.fatalMessage = String(message);
    v.fatalText.textContent = v.fatalMessage;
    v.fatal.style.display = "flex";
    if (v.empty) v.empty.style.display = "none";
  }
  function clearFatal(v) {
    v.fatalKind = null;
    v.fatalMessage = null;
    if (v.empty && !v.set) v.empty.style.display = "";
    v.fatalText.textContent = "";
    v.fatal.style.display = "none";
  }
  function notify(v, message) {
    v.noticeMessage = String(message);
    v.noticeText.textContent = v.noticeMessage;
    v.notice.style.display = "flex";
  }
  function clearNotice(v) {
    v.noticeMessage = null;
    v.noticeText.textContent = "";
    v.notice.style.display = "none";
  }

  // ---------- provenance ----------

  function provRow(v, term, value) {
    var dt = text(v, "dt", "tumbler-provenance-term", term, { margin: "0", color: cssRgb(v.theme.muted) });
    var dd = make(v, "dd", "tumbler-provenance-value", { margin: "0", color: cssRgb(v.theme.foreground), minWidth: "0" });
    if (Array.isArray(value)) {
      var ul = make(v, "ul", "", { margin: "0", paddingLeft: "18px" });
      value.forEach(function (item) {
        ul.appendChild(text(v, "li", "", String(item)));
      });
      dd.appendChild(ul);
    } else {
      dd.textContent = String(value);
    }
    v.provList.appendChild(dt);
    v.provList.appendChild(dd);
    return dd;
  }

  function reductionText(r) {
    if (!r || r.kind === "none") return "none: the vectors are as the model produced them";
    if (r.kind === "rotation") {
      return "exact rotation onto the data's principal directions; nothing lost, distances unchanged";
    }
    if (r.kind === "top-k") {
      return (
        "top-k: " +
        thousands(r.directions_kept) +
        " of " +
        thousands(r.source_dimension) +
        " directions kept, " +
        percent(r.variance_dropped) +
        " of the variance dropped; this view is an approximation of the space"
      );
    }
    return String(r.kind);
  }

  function viewText(v) {
    var m = v.mode;
    if (!m) {
      var def = ET.modes.get(v.modeId);
      return (def ? def.title : v.modeId) + " (starts when data arrives)";
    }
    var d = {};
    try {
      d = m.inst.describe() || {};
    } catch (err) {
      d = {};
    }
    var out = m.title + ": " + (d.projection || "a linear projection");
    if (typeof d.varianceShare === "number" && isFinite(d.varianceShare)) {
      out +=
        "; the directions it tours through hold " +
        percent(d.varianceShare) +
        " of the variance" +
        (d.varianceShareStale ? " (measured before " + thousands(d.pointsSinceFit || 0) + " new points)" : "");
    }
    return out;
  }

  function renderProvenance(v) {
    var list = v.provList;
    while (list.firstChild) list.removeChild(list.firstChild);
    v.provView = null;
    var set = v.set;
    if (!set) {
      provRow(v, "Data", "none yet");
      v.provView = provRow(v, "View", viewText(v));
      provRow(v, "Seed (view)", String(v.seed));
      v.provSummary.textContent = "About this view: no data yet. " + "A projection is a shadow of the space.";
      return;
    }
    var p = set.provenance || {};
    var r = set.reduction;
    provRow(v, "Source", p.source);
    if (p.synthetic) provRow(v, "Synthetic", "yes: these vectors were generated, not produced by the named model");
    provRow(v, "Model", set.model);
    var dim = thousands(set.dimension);
    if (r && r.kind === "top-k") dim += " (reduced from " + thousands(r.source_dimension) + ")";
    provRow(v, "Dimension", dim);
    provRow(v, "Items", thousands(set.count));
    provRow(v, "Seed (view)", String(v.seed));
    provRow(v, "Seed (source)", p.seed === null || p.seed === undefined ? "none" : String(p.seed));
    v.provView = provRow(v, "View", viewText(v));
    provRow(v, "Reduction", reductionText(r));
    provRow(v, "Producer", p.producer);
    if (p.endpoint) provRow(v, "Embedded through", p.endpoint);
    if (p.created) provRow(v, "Created", p.created);
    provRow(
      v,
      "Labels",
      set.text_included
        ? "may carry corpus text from the source"
        : "point ids only: this data carries no corpus text"
    );
    var lim = Array.isArray(p.limitations) ? p.limitations : [];
    var unc = Array.isArray(p.uncertain) ? p.uncertain : [];
    provRow(v, "Limitations", lim.length ? lim : "none known (the producer states none)");
    provRow(v, "Uncertain", unc.length ? unc : "nothing flagged (the producer states none)");
    v.provSummary.textContent =
      "About this view: " +
      p.source +
      " · " +
      set.model +
      " · " +
      dim +
      "-d · " +
      thousands(set.count) +
      " items · seed " +
      String(v.seed) +
      (p.synthetic ? " · synthetic" : "") +
      " · a projection is a shadow of the space";
    v.provViewText = v.provView.textContent;
  }

  function refreshViewRow(v) {
    if (!v.provView) return;
    var t = viewText(v);
    if (t !== v.provViewText) {
      v.provView.textContent = t;
      v.provViewText = t;
    }
  }

  function describeSet(v) {
    var set = v.set;
    // With no data the stage says so plainly; the provenance and readout have
    // nothing to describe and are hidden.
    v.empty.style.display = set || v.fatalMessage ? "none" : "";
    v.provenance.style.display = set ? "" : "none";
    v.readout.style.display = set && v.options.readout ? "flex" : "none";
    if (!set) {
      v.canvas.setAttribute("aria-label", "Animated 3-D projection of an embedding space (no data yet)");
      v.mastLine.textContent = "";
      v.stripLast.textContent = "";
      return;
    }
    var D = set.dimension;
    v.canvas.setAttribute(
      "aria-label",
      "Animated 3-D linear projection of a " +
        thousands(D) +
        "-dimensional embedding space: " +
        thousands(set.count) +
        " points from " +
        set.model +
        ". The provenance below says where they came from."
    );
    v.mastTitle.textContent = v.options.title ? String(v.options.title) : "";
    v.mastTitle.style.display = v.options.title ? "" : "none";
    v.mastLine.textContent =
      thousands(set.count) + " embeddings · " + thousands(D) + " dimensions · one restless 3-D window";
    v.stripLast.textContent = "dimension " + thousands(D);
    v.stripMiddle.textContent = "how much each of the " + thousands(D) + " dimensions contributes to the view right now";
  }

  // ---------- modes ----------

  function copyState(s) {
    if (!s) return null;
    var draw = {};
    for (var k in s.draw) if (Object.prototype.hasOwnProperty.call(s.draw, k)) draw[k] = s.draw[k];
    return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: draw };
  }

  // Options for a mode instance: the viewer's defaults (none today), then the host's
  // modeOptions. Tumble's refit turns onto the new tour over its own
  // refitTransition ("auto": sized to the turn); mode entry keeps the mode's 1.5 s.
  var MODE_DEFAULTS = Object.create(null);
  function modeOptionsFor(v, id) {
    var out = {};
    var k;
    var d = MODE_DEFAULTS[id];
    if (d) for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    var mo = v.options.modeOptions;
    var host = mo && Object.prototype.hasOwnProperty.call(mo, id) ? mo[id] : null;
    if (host && typeof host === "object") {
      for (k in host) if (Object.prototype.hasOwnProperty.call(host, k)) out[k] = host[k];
    }
    return out;
  }

  // Start mode `id` on the current set. Returns true, or false after showing why not.
  function errorText(err, fallback) {
    return err && err.message ? String(err.message) : fallback;
  }

  // Start mode `id` on the current set. Returns true, or false after showing why not
  // (v.modeError holds the message). Every call into the mode is guarded: a mode is
  // pluggable host code and may throw. The previous instance is left only once the
  // new one has entered and prepared.
  function startMode(v, id, from) {
    var def = ET.modes.get(id);
    v.modeError = null;
    if (!def) {
      v.modeError = 'There is no view called "' + String(id) + '".';
      notify(v, v.modeError);
      return false;
    }
    if (!v.set) {
      v.modeId = id;
      paintModeButtons(v);
      return true;
    }
    var inst = null;
    var prep;
    try {
      inst = ET.modes.create(id, modeOptionsFor(v, id));
      inst.enter(v.set, { seed: v.seed, from: from || null });
      prep = inst.prepare();
      if (!prep || typeof prep.step !== "function") throw new TypeError(def.title + ": prepare() returned no stepper");
    } catch (err) {
      v.modeError = errorText(err, "This view cannot show the data.");
      notify(v, v.modeError);
      leaveSafely(inst);
      return false;
    }
    if (v.mode) leaveSafely(v.mode.inst);
    v.mode = {
      id: id,
      title: def.title,
      inst: inst,
      jobs: [prep],
      clock: 0,
      wiresVersion: -1,
      refit: null,
      readyAt: null,
      lastFocusTo: -1,
      prevNeighbours: null,
      curNeighbours: null,
    };
    v.modeId = id;
    paintModeButtons(v);
    refreshViewRow(v);
    v.statusClock = STATUS_EVERY;
    return true;
  }

  function leaveSafely(inst) {
    if (!inst) return;
    try {
      inst.leave();
    } catch (err) {
      // a mode's leave() has nothing the viewer needs
    }
  }

  function readyOf(m) {
    try {
      return !!(m && m.inst.isReady());
    } catch (err) {
      return false;
    }
  }

  // A frame threw: the loop stops and a notice says so; a replace or a mode switch
  // that succeeds starts it again.
  function recover(v) {
    if (!v.broken) return;
    v.broken = false;
    if (v.noticeMessage && v.noticeMessage.indexOf("The viewer stopped") === 0) clearNotice(v);
    v.prev = null;
    invalidate(v);
  }

  function setMode(v, id) {
    if (v.destroyed) return false;
    if (typeof id !== "string") return false;
    if (v.mode && v.mode.id === id) return true;
    if (!v.set && ET.modes.get(id)) {
      v.modeId = id;
      paintModeButtons(v);
      refreshViewRow(v);
      call(v, v.options.onModeChange, id);
      return true;
    }
    var ok = startMode(v, id, copyState(v.last));
    if (ok) {
      recover(v);
      call(v, v.options.onModeChange, id);
      invalidate(v);
    }
    return ok;
  }

  // ---------- data ----------

  function update(v, data) {
    if (v.destroyed) return { ok: false, code: "destroyed", message: "This viewer has been destroyed." };
    var began = now(v);
    try {
      return applyUpdate(v, data);
    } finally {
      // A long update (a large upload) is the viewer's own work too: the next frame
      // counts the gap as lost time, as after a long frame.
      // Anything over about one frame (20 ms) would show as a skipped step.
      if (now(v) - began > 20) v.lostTime = true;
    }
  }

  function applyUpdate(v, data) {
    var res;
    try {
      res = ET.contract.validate(data, v.set);
    } catch (err) {
      // The loader never throws for bad data (a hostile getter is its own
      // invalid-field refusal), so anything caught here is a fault, not the data's.
      res = { ok: false, code: "internal", message: "Internal error while checking the data: " + errorText(err, String(err)) };
    }
    // Re-read the host's theme on every update (no polling); applied only if changed.
    syncTheme(v);
    if (v.set && paintKey(v) !== v.paintKey) recolour(v);
    if (!res || !res.ok) {
      return refuse(v, { ok: false, code: res ? res.code : "internal", message: res ? res.message : "Data refused." });
    }
    var op = "replace";
    try {
      if (data.op === "append") op = "append";
    } catch (err) {
      op = "replace";
    }
    clearNotice(v); // an older notice; a fallback view or a refusal sets its own
    var out;
    try {
      out = op === "append" ? applyAppend(v, res.set) : applyReplace(v, res.set);
    } catch (err) {
      // Nothing in the application path should throw; if it does, it is reported, the
      // loop is left to the frame guard, and the host gets a result.
      out = { ok: false, code: "internal", message: "Internal error while showing the data: " + errorText(err, String(err)) };
    }
    if (!out.ok) return refuse(v, out);
    if (v.fatalKind === "data") clearFatal(v);
    if (v.fatalKind === "gpu" && v.rendering) clearFatal(v);
    if (op === "replace") recover(v);
    invalidate(v);
    return out;
  }

  function strip(r) {
    return { ok: false, code: r.code, message: r.message };
  }

  // A refusal: nothing changed. Shown inside the element, passed to onError, returned.
  function refuse(v, r) {
    var refusal = strip(r);
    // With a view showing (or a graphics message up), the refusal is a notice and the
    // view keeps running unchanged; with nothing to show it fills the stage.
    if (v.set || v.fatalKind === "gpu") notify(v, refusal.message);
    else fatal(v, refusal.message, "data");
    call(v, v.options.onError, refusal);
    invalidate(v);
    return refusal;
  }

  // What a failed update restores.
  function snapshot(v) {
    var gi = Object.create(null); // group names are untrusted: no inherited names
    for (var k in v.groupIndex) gi[k] = v.groupIndex[k];
    return {
      set: v.set,
      groupIndex: gi,
      groupNames: v.groupNames.slice(),
      labelledCount: v.labelledCount,
      lightLoad: v.lightLoad,
      labelSample: v.labelSample.slice(),
      last: v.last,
      spin: v.spin,
      drag: v.drag,
      sinceAppend: v.sinceAppend,
    };
  }

  function restore(v, snap) {
    v.set = snap.set;
    v.groupIndex = snap.groupIndex;
    v.groupNames = snap.groupNames;
    v.labelledCount = snap.labelledCount;
    v.lightLoad = snap.lightLoad;
    v.labelSample = snap.labelSample;
    v.last = snap.last;
    v.spin = snap.spin;
    v.drag = snap.drag;
    v.sinceAppend = snap.sinceAppend;
    restoreRenderer(v);
    sizeStrip(v);
    describeSet(v);
    renderProvenance(v);
  }

  // Put the renderer's copy back to the set the view holds (after a failed upload or
  // a refused update), rebuilding the GPU objects if a failure dropped them.
  function restoreRenderer(v) {
    var r = v.renderer;
    if (!r) return;
    try {
      var set = v.set;
      if (set) {
        var pc = paint(v, set, 0, set.count);
        r.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
        v.lightLoad = pc.bright;
      } else {
        v.lightLoad = 0;
        var D = r.status().dimension || 1;
        r.setData({ vectors: new Float32Array(0), dimension: D });
      }
      var st = r.status();
      if (!st.ok && !st.lost && !st.disposed) {
        var rb = r.rebuild();
        if (!rb || !rb.ok) fatal(v, (rb && rb.message) || "The graphics card could not take the data back.");
      }
      if (v.mode) v.mode.wiresVersion = -1;
      v.paintKey = paintKey(v);
      v.needClear = true;
    } catch (err) {
      fatal(v, "The graphics card could not take the data back: " + errorText(err, String(err)));
    }
  }

  function gpuThrew(err) {
    return { ok: false, code: "gpu-failed", message: "The graphics card could not take the data: " + errorText(err, String(err)) };
  }

  function applyReplace(v, set) {
    var snap = snapshot(v);
    v.groupIndex = Object.create(null);
    v.groupNames = [];
    v.labelledCount = countLabelled(set, 0, set.count);
    v.labelSample = [];
    extendLabelSample(v, set, 0);
    v.lightLoad = 0;
    if (v.renderer) {
      var gpu;
      try {
        var pc = paint(v, set, 0, set.count);
        gpu = v.renderer.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
        v.lightLoad = pc.bright;
      } catch (err) {
        restore(v, snap);
        return gpuThrew(err);
      }
      if (gpu && gpu.ok === false) {
        // This GPU cannot take the set (too many points, too wide, a failed build or
        // upload): the renderer may still hold the previous set, or nothing usable,
        // so the view goes back exactly to what it was, renderer copy included.
        restore(v, snap);
        return { ok: false, code: gpu.reason || "gpu-failed", message: gpu.message || "The graphics card could not take the data." };
      }
    }
    v.set = set;
    v.last = null;
    v.spin = 0;
    v.drag = { active: false, yaw: 0, pitch: 0, x: 0, y: 0 };
    v.needClear = true;
    v.sinceAppend = Infinity;
    var oldMode = v.mode;
    // startMode leaves the old instance only when the new one has started.
    var started = startMode(v, v.modeId, null);
    var firstError = v.modeError;
    if (!started) {
      // The chosen view cannot show this data (too few dimensions, or a failing
      // mode): try the others.
      var ids = ET.modes.ids();
      for (var i = 0; i < ids.length && !started; i++) if (ids[i] !== v.modeId) started = startMode(v, ids[i], null);
    }
    if (!started) {
      v.mode = oldMode;
      restore(v, snap);
      return { ok: false, code: "mode-failed", message: "No view can show this data: " + (firstError || "every view refused it.") };
    }
    if (firstError) notify(v, firstError); // shown on top of the fallback view
    v.paintKey = paintKey(v);
    sizeStrip(v);
    describeSet(v);
    renderProvenance(v);
    return { ok: true, op: "replace", count: set.count, added: set.count };
  }

  function applyAppend(v, set) {
    var old = v.set;
    var from = old.count;
    var k = set.count - from;
    if (k <= 0) {
      v.set = set;
      renderProvenance(v);
      return { ok: true, op: "append", count: set.count, added: 0 };
    }
    var t0 = now(v);
    var snap = snapshot(v);
    var hadLabelled = v.labelledCount;
    v.labelledCount += countLabelled(set, from, set.count);
    if (hadLabelled === 0 && v.labelledCount > 0) {
      // The first labelled points arrived: rebuild the label sample from them.
      v.labelSample = [];
      extendLabelSample(v, set, 0);
    } else extendLabelSample(v, set, from);
    if (v.renderer) {
      var gpu;
      try {
        var pc = paint(v, set, from, set.count); // may add groups: rolled back on failure
        var D = set.dimension;
        gpu = v.renderer.appendData({
          vectors: set.vectors.subarray(from * D, set.count * D),
          colours: pc.colours,
          weights: pc.weights,
        });
      } catch (err) {
        gpu = gpuThrew(err);
        gpu.reason = "gpu-failed";
      }
      if (!gpu || gpu.ok === false) {
        restore(v, snap);
        return { ok: false, code: gpu && gpu.reason ? gpu.reason : "gpu-failed", message: gpu && gpu.message ? gpu.message : "append failed" };
      }
      v.lightLoad += pc.bright;
    }
    v.set = set;
    if (v.mode) {
      var m = v.mode;
      var r;
      try {
        r = m.inst.dataChanged(set, { op: "append", added: k, t: m.clock });
      } catch (err) {
        // The mode is in an unknown state: put the old set back and start the same
        // view again from the frame last drawn.
        var msg = m.title + " failed on the new points: " + errorText(err, String(err));
        restore(v, snap);
        v.mode = null;
        leaveSafely(m.inst);
        if (!startMode(v, m.id, copyState(v.last))) startMode(v, "tumble", copyState(v.last));
        return { ok: false, code: "mode-failed", message: msg };
      }
      if (r && r.restart) {
        // The mode entered again: work queued for its earlier entry (a preparation
        // or a refit still running) belongs to a state that is gone, so drop it.
        m.jobs = [];
        m.refit = null;
        m.clock = 0;
        m.readyAt = null;
      }
      if (r && r.work && typeof r.work.step === "function") m.jobs.push(r.work);
    } else startMode(v, v.modeId, null);
    v.sinceAppend = 0;
    describeSet(v);
    renderProvenance(v);
    v.timing.lastAppendMs = now(v) - t0;
    return { ok: true, op: "append", count: set.count, added: k };
  }

  // ---------- sizing ----------

  function sizeStrip(v) {
    var D = v.set ? Math.max(1, v.set.dimension) : 1;
    if (v.strip.width !== D) v.strip.width = D;
    if (v.strip.height !== 1) v.strip.height = 1;
    v.stripImage = null;
    v.stripCtx = null;
    try {
      v.stripCtx = v.strip.getContext("2d");
      if (v.stripCtx) v.stripImage = v.stripCtx.createImageData(D, 1);
    } catch (err) {
      v.stripCtx = null;
    }
  }

  function measure(v) {
    var w = 0;
    var h = 0;
    try {
      var r = v.stage.getBoundingClientRect();
      w = r.width;
      h = r.height;
    } catch (err) {
      w = 0;
    }
    if (!(w > 0)) w = v.stage.clientWidth || 300;
    if (!(h > 0)) h = v.stage.clientHeight || 150;
    var dpr = Math.min(Number(v.options.maxPixelRatio) || 2, (v.win && v.win.devicePixelRatio) || 1);
    v.dpr = dpr;
    v.cssW = w;
    v.cssH = h;
    var W = Math.max(2, Math.round(w * dpr));
    var H = Math.max(2, Math.round(h * dpr));
    v.W = W;
    v.H = H;
    if (v.renderer) v.renderer.resize(W, H);
    if (v.overlay.width !== W) v.overlay.width = W;
    if (v.overlay.height !== H) v.overlay.height = H;
    var rootW = 0;
    try {
      rootW = v.root.getBoundingClientRect().width;
    } catch (err) {
      rootW = w;
    }
    layoutForWidth(v, rootW || w);
    v.needClear = true;
    invalidate(v);
  }

  // No media queries without a stylesheet, so the layout reacts to the element's width.
  // Two breakpoints, each evaluated on its own: 520 px for the provenance grid (one
  // column below it) and 600 px for the rest of the narrow layout.
  function layoutForWidth(v, width) {
    var oneColumn = width < 520;
    if (oneColumn !== v.oneColumn) {
      v.oneColumn = oneColumn;
      v.provList.style.gridTemplateColumns = oneColumn ? "minmax(0, 1fr)" : "max-content minmax(0, 1fr)";
    }
    var narrow = width < 600;
    if (narrow === v.narrow) return;
    v.narrow = narrow;
    v.modeButtons.forEach(function (mb) {
      mb.summary.style.display = narrow ? "none" : "";
      mb.title.style.fontSize = narrow ? "20px" : "24px";
    });
    v.panel.style.padding = narrow ? "6px 12px 14px" : "6px 16px 16px";
    v.playButton.style.minHeight = narrow ? TOUCH_HEIGHT : BUTTON_HEIGHT;
    v.zoomResetButton.style.minHeight = narrow ? TOUCH_HEIGHT : BUTTON_HEIGHT;
  }

  // ---------- the loop ----------

  function now(v) {
    var p = v.win && v.win.performance;
    if (p && typeof p.now === "function") return p.now();
    return Date.now();
  }

  function suspended(v) {
    return !!(v.doc.hidden || !v.onScreen);
  }

  // Ask for one more frame (unless destroyed, hidden or off screen).
  function invalidate(v) {
    v.dirty = true;
    schedule(v);
  }

  function schedule(v) {
    if (v.destroyed || v.raf || suspended(v)) return;
    if (!v.win || typeof v.win.requestAnimationFrame !== "function") return;
    v.raf = v.win.requestAnimationFrame(v.tick);
  }

  function unschedule(v) {
    if (v.raf && v.win && typeof v.win.cancelAnimationFrame === "function") v.win.cancelAnimationFrame(v.raf);
    v.raf = 0;
    v.prev = null; // the next frame after a resume starts from a fresh clock
  }

  function needsMore(v) {
    if (v.dirty) return true;
    var m = v.mode;
    if (!m || !v.set || v.set.count === 0) return false;
    if (m.jobs.length || m.refit) return true;
    // A mode that is still preparing needs frames until it is ready, even when the
    // view is paused or motion is reduced: otherwise it would wait for input forever.
    if (!readyOf(m)) return true;
    if (v.running) return true;
    if (v.drag.active || v.pinch) return true;
    // Paused: keep twinkling (the reference does) unless motion is reduced.
    return !v.reducedMotion && v.rendering;
  }

  function frame(v, t) {
    v.raf = 0;
    if (v.destroyed) return;
    if (suspended(v)) {
      v.prev = null;
      return; // no frame work while hidden or off screen; resume() reschedules
    }
    var start = now(v);
    var dt = v.prev === null ? 1 / 60 : clamp((t - v.prev) / 1000, 0.001, 0.05);
    // After a long frame of the viewer's own work (a fit), count the gap as lost time,
    // not motion, so the picture does not leap ahead by a whole clamped step.
    // The rAF timestamp of a delayed frame is the vsync time from before the delay;
    // measure the next frame from when this one actually ran, or it would leap instead.
    if (v.lastSpent > 50 || v.lostTime) {
      v.lostTime = false;
      dt = 1 / 60;
      v.prev = Math.max(t, start);
    } else v.prev = t;
    v.dirty = false;
    try {
      step(v, dt, start);
    } catch (err) {
      // The loop stops; the last picture stays with a notice over it. A replace or a
      // mode switch that succeeds starts it again (recover()).
      v.broken = true;
      notify(v, "The viewer stopped: " + errorText(err, String(err)) + ". Send new data or switch views to restart it.");
      return;
    }
    var spent = now(v) - start;
    v.lastSpent = spent;
    if (spent > v.timing.longestFrameMs) v.timing.longestFrameMs = spent;
    v.frames++;
    if (v.timing.firstFrameMs === null) v.timing.firstFrameMs = now(v) - v.timing.mountAt;
    v.fpsFrames++;
    if (v.fpsAt === null) v.fpsAt = t;
    else if (t - v.fpsAt >= 1000) {
      v.fps = (v.fpsFrames * 1000) / (t - v.fpsAt);
      v.fpsAt = t;
      v.fpsFrames = 0;
    }
    if (!v.broken && needsMore(v)) schedule(v);
  }

  // Preparation and refit work run in small units (a few milliseconds each) inside a
  // per-frame budget: prepareBudgetMs (8), halved after a frame that ran long, so the
  // page keeps its frame rate while a mode prepares or refits.
  function pump(v, m, start) {
    var budget = Math.max(1, Number(v.options.prepareBudgetMs) || 8);
    if (v.lastSpent > 16) budget = Math.max(1, budget / 2);
    // A paused view has no motion to keep smooth, so it may spend longer per frame on
    // getting ready (it still answers input every frame).
    if (!v.running) budget = Math.max(budget, 40);
    while (m.jobs.length) {
      var job = m.jobs[0];
      var left = budget - (now(v) - start);
      if (left <= 0) break;
      if (!job.done) job.step(left);
      if (job.done) m.jobs.shift();
      else break;
    }
    if (m.refit && v.running && now(v) - start < budget) {
      var r0 = now(v);
      m.refit.step(Math.max(1, budget - (r0 - start)));
      var took = now(v) - r0;
      m.refitSpent += took;
      if (took > m.refitLongest) m.refitLongest = took;
      if (m.refit.done) {
        m.refit = null;
        v.timing.lastRefit = {
          atMs: now(v) - v.timing.mountAt,
          durationMs: m.refitSpent,
          longestStepMs: m.refitLongest,
        };
      }
    }
  }

  // Tumble's refit policy after appends: once appends have been quiet for
  // refitQuietSeconds and the points added since the last fit are at least
  // refitShare of the set (and at least one), fit the directions again.
  function considerRefit(v, m) {
    // Never while paused (frames do not run at all while hidden or off screen): a
    // paused view must not take the refit's stall; it starts after resume.
    if (!v.running) return;
    if (m.refit || m.jobs.length || typeof m.inst.refit !== "function") return;
    if (v.sinceAppend < v.options.refitQuietSeconds) return;
    var d = m.inst.describe();
    if (!d || !d.varianceShareStale || !(d.pointsSinceFit > 0)) return;
    if (d.pointsSinceFit < Math.max(1, Math.ceil(v.options.refitShare * v.set.count))) return;
    m.refit = m.inst.refit();
    m.refitSpent = 0;
    m.refitLongest = 0;
    v.timing.refits++;
  }

  function step(v, dt, start) {
    var m = v.mode;
    var r = v.renderer;
    v.sinceAppend += dt;
    if (!m || !v.set) {
      if (r && v.rendering) r.draw({ clear: true, dt: dt });
      v.status.textContent = v.set ? "this view cannot show the data" : "";
      clearLabels(v, 0);
      return;
    }
    pump(v, m, start);
    var ready = m.inst.isReady();
    if (ready && m.readyAt === null) {
      m.readyAt = now(v);
      // Show the mode's own status on this very frame: under reduced motion the loop
      // may stop right after it, and the "finding ..." line must not be left behind.
      v.statusClock = STATUS_EVERY;
      if (v.timing.firstReadyMs === null) v.timing.firstReadyMs = m.readyAt - v.timing.mountAt;
    }
    var moving = ready && v.running;
    if (moving) {
      m.clock += dt * v.speed;
      if (!v.drag.active) v.spin += dt * v.speed;
    }
    if (ready && typeof m.inst.mark === "function") m.inst.mark(m.clock);
    if (ready) considerRefit(v, m);
    var s = m.inst.stateAt(ready ? m.clock : 0);
    if (r && s.wires && s.wires.version !== m.wiresVersion) {
      r.setWires(s.wires.pairs, s.wires.lengths);
      m.wiresVersion = s.wires.version;
    }
    if (!v.reducedMotion || v.running) v.drawTime += dt;
    var ds = drawState(v, s, dt);
    if (r && v.rendering) r.draw(ds);
    v.needClear = false;
    v.last = s;
    v.lastDraw = ds;
    if (v.showLabels || v.hover) drawOverlay(v, s, ds);
    else clearOverlay(v);
    drawStrip(v, s.frame);
    v.statusClock += dt;
    if (v.statusClock >= STATUS_EVERY) {
      v.statusClock = 0;
      var line = s.status;
      if (v.userZoom !== 1) line += " · zoom " + v.userZoom.toFixed(1) + "×";
      if (!v.running) line += " · paused";
      if (line !== v.statusText) {
        v.status.textContent = line;
        v.statusText = line;
      }
      refreshViewRow(v);
      v.root.setAttribute("aria-busy", ready && !m.jobs.length ? "false" : "true");
    }
  }

  function drawState(v, s, dt) {
    var out = {};
    var d = s.draw;
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    out.frame = s.frame;
    out.centre = s.centre;
    out.zoom = (d.zoom || 1) * v.userZoom;
    out.yaw = 0.4 + v.drag.yaw + SPIN * v.spin;
    out.pitch = clamp(0.16 + v.drag.pitch, -1.3, 1.3);
    out.pointSize = 6.5 * v.dpr;
    out.time = v.drawTime;
    out.dt = dt;
    if (!v.trails) out.trails = 0;
    // Ink is dark where light piles up, so it is drawn with less gain than light on
    // black (cores keep their hue instead of burning to black); soft ink, less again.
    if (v.theme.ink) {
      var soft = v.theme.lightStyle === "soft";
      out.gain = soft ? 0.55 : 0.7;
      out.bloom = soft ? 0.3 : 0.45;
    }
    // Many full-weight points pile up into a white (or, in ink, black) ball, so the
    // overall brightness comes down as their number goes up.
    var crowd = crowding(v);
    if (crowd < 1) out.gain = (out.gain === undefined ? 1 : out.gain) * crowd;
    if (v.reducedMotion) out.twinkle = 0;
    out.clear = !!v.needClear;
    return out;
  }

  // Brightness factor for crowded sets, 1 up to a light load of CROWD_REF. The light
  // load is the sum of the weights of the bright points actually uploaded (weight
  // BRIGHT_WEIGHT or more): a labelled point counts 1, a point of a set with no
  // labelled point 0.7, the dim unlabelled points of a labelled set nothing. So it
  // is the labelled count, or 0.7 times the point count when nothing is labelled;
  // points uploaded at 0.7 before the first labelled point arrived by append keep
  // counting 0.7, as they are still drawn at that weight. The built-in sample set
  // has 290, so it is unchanged.
  function crowding(v) {
    var n = v.set ? v.lightLoad : 0;
    return n > CROWD_REF ? Math.pow(CROWD_REF / n, CROWD_POWER) : 1;
  }

  // ---------- overlay: labels, spokes, hover ----------

  function project(v, i, s, ds, out) {
    var D = v.set.dimension;
    var X = v.set.vectors;
    var F = s.frame;
    var C = s.centre;
    var o = i * D;
    var a = 0;
    var b = 0;
    var c = 0;
    for (var d = 0; d < D; d++) {
      var x = X[o + d] - C[d];
      a += x * F[d];
      b += x * F[D + d];
      c += x * F[2 * D + d];
    }
    out[0] = a;
    out[1] = b;
    out[2] = c;
    return ET.renderer.place(out, ds, v.W, v.H);
  }

  function clearOverlay(v) {
    if (v.overlayCtx === undefined) v.overlayCtx = safeContext2d(v.overlay);
    if (v.overlayCtx && v.overlayDirty) {
      v.overlayCtx.clearRect(0, 0, v.W, v.H);
      v.overlayDirty = false;
    }
    clearLabels(v, 0);
  }

  function safeContext2d(canvas) {
    try {
      return canvas.getContext("2d") || null;
    } catch (err) {
      return null;
    }
  }

  function label(v, used, str, x, y, style) {
    if (used >= LABEL_POOL) return used;
    var rec = v.labelPool[used];
    if (!rec) {
      var el = make(v, "span", "tumbler-label", {
        position: "absolute",
        left: "0",
        top: "0",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        willChange: "transform",
      });
      v.labelLayer.appendChild(el);
      rec = { el: el, text: null, key: "", shown: true };
      v.labelPool.push(rec);
    }
    if (rec.text !== str) {
      rec.el.textContent = str;
      rec.text = str;
    }
    var key = style.kind + "|" + style.colour;
    if (rec.key !== key) {
      var t = v.theme;
      var big = style.kind === "stop";
      setStyles(rec.el, {
        fontFamily: big ? t.fontDisplay : t.fontData,
        fontStyle: big ? "italic" : "normal",
        fontSize: big ? "26px" : style.kind === "hover" ? "12px" : "11px",
        letterSpacing: style.kind === "group" ? "0.06em" : "0",
        textTransform: style.kind === "group" ? "uppercase" : "none",
        color: style.colour,
        textShadow: v.outline,
      });
      rec.key = key;
    }
    var shift =
      style.align === "center" ? "translate(-50%, -100%)" : style.align === "right" ? "translate(-100%, -50%)" : "translate(0, -50%)";
    rec.el.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) " + shift;
    rec.el.style.opacity = String(Math.round(clamp(style.alpha, 0, 1) * 100) / 100);
    if (!rec.shown) {
      rec.el.style.display = "";
      rec.shown = true;
    }
    return used + 1;
  }

  function clearLabels(v, used) {
    for (var i = used; i < v.labelPool.length; i++) {
      var rec = v.labelPool[i];
      if (rec.shown) {
        rec.el.style.display = "none";
        rec.shown = false;
      }
    }
  }

  function labelText(v, i) {
    var p = v.set.points[i];
    var s = typeof p.label === "string" && p.label.trim() !== "" ? p.label : p.id;
    return shorten(s, 40);
  }

  function drawOverlay(v, s, ds) {
    if (v.overlayCtx === undefined) v.overlayCtx = safeContext2d(v.overlay);
    var ctx = v.overlayCtx;
    var dpr = v.dpr;
    var tmp = v.tmp3;
    if (ctx) {
      ctx.clearRect(0, 0, v.W, v.H);
      v.overlayDirty = false;
    }
    var used = 0;
    var fogMix = clamp(Number(s.draw.fog) || 0, 0, 1);
    var fg = v.stageFg;
    var sample = v.labelSample;
    var n = sample.length;
    if (v.sx.length < n) {
      v.sx = new Float32Array(LABEL_SAMPLE);
      v.sy = new Float32Array(LABEL_SAMPLE);
    }
    var needSample = (v.showLabels && fogMix < 0.97) || v.hover;
    if (needSample) {
      for (var j = 0; j < n; j++) {
        var q = project(v, sample[j], s, ds, tmp);
        v.sx[j] = q.x;
        v.sy[j] = q.y;
      }
    }
    // Group names at the middle of their labelled points, fading out as Wander's fog comes in.
    if (v.showLabels && fogMix < 0.97 && v.groupNames.length) {
      var G = v.groupNames.length;
      var cx = new Float64Array(G);
      var cy = new Float64Array(G);
      var cn = new Float64Array(G);
      for (var k = 0; k < n; k++) {
        var g = v.groupIndex[v.set.points[sample[k]].group];
        if (g === undefined) continue;
        cx[g] += v.sx[k];
        cy[g] += v.sy[k];
        cn[g]++;
      }
      for (var gi = 0; gi < G; gi++) {
        if (!cn[gi]) continue;
        // Lighter than the points on a dark host (the reference's 72% lightness),
        // darker on a light one so the names stay readable.
        var col = cssRgb(v.theme.stage.light ? mix(groupColour(v, gi), [0, 0, 0], 0.45) : nameTint(groupColour(v, gi)));
        used = label(v, used, shorten(v.groupNames[gi], 32), cx[gi] / cn[gi] / dpr, cy[gi] / cn[gi] / dpr - 14, {
          kind: "group",
          colour: col,
          alpha: (1 - fogMix) * 0.8,
          align: "center",
        });
      }
    }
    // Wander: the stop, its labelled neighbours and spokes to them.
    var f = s.focus;
    var m = v.mode;
    if (f && m) {
      if (f.to !== m.lastFocusTo) {
        m.prevNeighbours = m.curNeighbours;
        m.lastFocusTo = f.to;
      }
      m.curNeighbours = f.neighbours ? Array.prototype.slice.call(f.neighbours) : [];
      if (f.phase === "dwell") used = spokes(v, ctx, f.to, m.curNeighbours, 1, s, ds, used, fg);
      else {
        var e = clamp(Number(f.e) || 0, 0, 1);
        used = spokes(v, ctx, f.from, m.prevNeighbours || [], 1 - e * 1.6, s, ds, used, fg);
        used = spokes(v, ctx, f.to, m.curNeighbours, e * e, s, ds, used, fg);
      }
    }
    // Hover: the nearest sampled point within 20 px.
    if (v.hover && n) {
      var best = -1;
      var bd = 20 * dpr * (20 * dpr);
      for (var h = 0; h < n; h++) {
        var dx = v.sx[h] - v.hover.x * dpr;
        var dy = v.sy[h] - v.hover.y * dpr;
        var d2 = dx * dx + dy * dy;
        if (d2 < bd) {
          bd = d2;
          best = h;
        }
      }
      if (best >= 0) {
        var bi = sample[best];
        if (ctx) {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.5 * dpr;
          ctx.strokeStyle = v.stopColour;
          ctx.beginPath();
          ctx.arc(v.sx[best], v.sy[best], 8 * dpr, 0, TAU);
          ctx.stroke();
          v.overlayDirty = true;
        }
        var right = v.sx[best] > v.W * 0.7;
        var grp = v.set.points[bi].group;
        var str = labelText(v, bi) + (grp ? " · " + shorten(grp, 24) : "");
        used = label(v, used, str, v.sx[best] / dpr + (right ? -14 : 14), v.sy[best] / dpr, {
          kind: "hover",
          colour: v.stopColour,
          alpha: 1,
          align: right ? "right" : "left",
        });
      }
    }
    if (ctx) ctx.globalAlpha = 1;
    clearLabels(v, used);
  }

  function spokes(v, ctx, i, neighbours, alpha, s, ds, used, fg) {
    if (!(i >= 0) || i >= v.set.count || alpha <= 0.02) return used;
    var dpr = v.dpr;
    var p = project(v, i, s, ds, v.tmp3);
    var px = p.x;
    var py = p.y;
    var gc = groupColour(v, groupIndexOf(v, v.set.points[i].group));
    var col = cssRgb(v.theme.stage.light ? gc : nameTint(gc));
    for (var k = 0; k < neighbours.length; k++) {
      var j = neighbours[k];
      if (!(j >= 0) || j >= v.set.count) continue;
      var q = project(v, j, s, ds, v.tmp3);
      if (ctx) {
        ctx.globalAlpha = alpha * 0.5;
        ctx.lineWidth = dpr;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        v.overlayDirty = true;
      }
      if (v.showLabels) {
        used = label(v, used, labelText(v, j), q.x / dpr + 8, q.y / dpr + 4, {
          kind: "neighbour",
          colour: v.neighbourColour,
          alpha: alpha * 0.85,
          align: "left",
        });
      }
    }
    if (ctx) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, 11 * dpr, 0, TAU);
      ctx.stroke();
      v.overlayDirty = true;
    }
    if (v.showLabels) {
      used = label(v, used, labelText(v, i), px / dpr + 18, py / dpr - 12, {
        kind: "stop",
        colour: v.stopColour,
        alpha: alpha,
        align: "left",
      });
    }
    return used;
  }

  // ---------- readout strip ----------

  // One cell per dimension: how much that dimension contributes to the three axes on
  // screen, relative to an even share (the reference's (f0^2 + f1^2 + f2^2) * D / 3).
  function drawStrip(v, F) {
    if (!v.stripCtx || !v.stripImage || !v.set) return;
    var D = v.set.dimension;
    var px = v.stripImage.data;
    var a = v.accent255;
    for (var d = 0; d < D; d++) {
      var e = ((F[d] * F[d] + F[D + d] * F[D + d] + F[2 * D + d] * F[2 * D + d]) * D) / 3;
      var o = d * 4;
      px[o] = a[0];
      px[o + 1] = Math.max(0, a[1] - Math.min(60, e * 12));
      px[o + 2] = a[2];
      px[o + 3] = Math.min(255, e * 80);
    }
    v.stripCtx.putImageData(v.stripImage, 0, 0);
  }

  // ---------- input ----------

  function listen(v, target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    v.listeners.push([target, type, fn, opts]);
  }

  function setZoom(v, z) {
    var next = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(next - 1) < 0.02) next = 1;
    v.userZoom = next;
    v.statusClock = STATUS_EVERY;
    invalidate(v);
    return v.userZoom;
  }

  function hasFocus(v) {
    var a = v.doc.activeElement;
    return !!a && (a === v.root || (typeof v.root.contains === "function" && v.root.contains(a)));
  }

  function setRunning(v, run) {
    run = !!run;
    if (run === v.running) return;
    v.running = run;
    v.playButton.textContent = run ? "Pause" : "Play";
    v.playButton.setAttribute("aria-pressed", run ? "false" : "true");
    v.statusClock = STATUS_EVERY;
    call(v, v.options.onPauseChange, !run);
    invalidate(v);
  }

  function wire(v) {
    var stage = v.stage;
    var pointers = {};
    var count = 0;
    var lastTap = null;

    function pos(e) {
      var r = { left: 0, top: 0 };
      try {
        r = stage.getBoundingClientRect();
      } catch (err) {
        r = { left: 0, top: 0 };
      }
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function pinchDistance() {
      var ids = Object.keys(pointers);
      if (ids.length < 2) return 0;
      var a = pointers[ids[0]];
      var b = pointers[ids[1]];
      return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
    }

    // Only a press on the sky itself turns the cloud. A press on a control inside the
    // stage (the notice's Dismiss button, a message) is left alone: no pointer
    // capture, no drag, no focus change, so the control gets its own click.
    function onSky(e) {
      var t = e.target;
      return t === stage || t === v.canvas || t === v.overlay || t === v.labelLayer;
    }

    listen(v, stage, "pointerdown", function (e) {
      if (e.button !== undefined && e.button > 0) return;
      if (!onSky(e)) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now(v) };
      count = Object.keys(pointers).length;
      try {
        if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId);
      } catch (err) {
        // capture is optional
      }
      if (!hasFocus(v)) {
        try {
          v.root.focus({ preventScroll: true });
        } catch (err) {
          // focus is a convenience
        }
      }
      if (count >= 2) {
        v.drag.active = false;
        v.pinch = { d0: pinchDistance() || 1, z0: v.userZoom };
      } else {
        v.drag.active = true;
        v.drag.x = e.clientX;
        v.drag.y = e.clientY;
        stage.style.cursor = "grabbing";
      }
      invalidate(v);
    });
    listen(v, stage, "pointermove", function (e) {
      var pt = pointers[e.pointerId];
      if (pt) {
        pt.x = e.clientX;
        pt.y = e.clientY;
      }
      if (v.pinch && count >= 2) {
        setZoom(v, v.pinch.z0 * (pinchDistance() / v.pinch.d0));
        return;
      }
      if (v.drag.active && pt) {
        v.drag.yaw += (e.clientX - v.drag.x) * 0.007;
        v.drag.pitch = clamp(v.drag.pitch + (e.clientY - v.drag.y) * 0.007, -1.46, 1.14);
        v.drag.x = e.clientX;
        v.drag.y = e.clientY;
        v.hover = null;
        invalidate(v);
        return;
      }
      if (e.pointerType === "mouse" || e.pointerType === undefined) {
        v.hover = pos(e);
        invalidate(v);
      }
    });
    function end(e) {
      var pt = pointers[e.pointerId];
      delete pointers[e.pointerId];
      count = Object.keys(pointers).length;
      if (count < 2) v.pinch = null;
      if (count === 0) {
        v.drag.active = false;
        stage.style.cursor = "grab";
      }
      // Double tap (touch or pen) resets the zoom; a mouse uses dblclick.
      if (e.type === "pointerup" && pt && e.pointerType && e.pointerType !== "mouse") {
        var moved = Math.abs(e.clientX - pt.sx) + Math.abs(e.clientY - pt.sy);
        var t = now(v);
        if (moved < 12 && t - pt.t < 300) {
          if (lastTap && t - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) + Math.abs(e.clientY - lastTap.y) < 32) {
            setZoom(v, 1);
            lastTap = null;
          } else lastTap = { t: t, x: e.clientX, y: e.clientY };
        }
      }
      invalidate(v);
    }
    listen(v, stage, "pointerup", end);
    listen(v, stage, "pointercancel", end);
    listen(v, stage, "pointerleave", function () {
      v.hover = null;
      invalidate(v);
    });
    listen(v, stage, "dblclick", function (e) {
      if (!onSky(e)) return;
      if (e.preventDefault) e.preventDefault();
      setZoom(v, 1);
    });
    // Wheel zooms only over the stage and only with Ctrl or Cmd held (a trackpad pinch
    // arrives that way) or while the viewer has focus; otherwise the page scrolls.
    listen(
      v,
      stage,
      "wheel",
      function (e) {
        var mod = !!(e.ctrlKey || e.metaKey);
        if (!mod && !hasFocus(v)) return;
        if (e.preventDefault) e.preventDefault();
        var dy = Number(e.deltaY) || 0;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= 400;
        setZoom(v, v.userZoom * Math.exp(-dy * (mod ? 0.01 : 0.0015)));
      },
      { passive: false }
    );

    listen(v, v.root, "keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var target = e.target;
      var tag = target && target.tagName ? String(target.tagName).toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      var k = e.key;
      var handled = true;
      if (k === "Escape" || k === "Esc") {
        if (v.noticeMessage !== null) clearNotice(v);
        else handled = false;
      } else if (/^[1-9]$/.test(k)) {
        var ids = v.modeButtons.map(function (mb) {
          return mb.id;
        });
        var idx = Number(k) - 1;
        if (idx < ids.length) setMode(v, ids[idx]);
        else handled = false;
      } else if ((k === " " || k === "Spacebar") && target === v.root) setRunning(v, !v.running);
      else if (k === "+" || k === "=") setZoom(v, v.userZoom * 1.25);
      else if (k === "-" || k === "_") setZoom(v, v.userZoom / 1.25);
      else if (k === "0") setZoom(v, 1);
      else handled = false;
      if (handled && e.preventDefault) e.preventDefault();
    });

    v.modeButtons.forEach(function (mb) {
      listen(v, mb.button, "click", function () {
        setMode(v, mb.id);
      });
    });
    listen(v, v.playButton, "click", function () {
      setRunning(v, !v.running);
    });
    listen(v, v.zoomResetButton, "click", function () {
      setZoom(v, 1);
    });
    listen(v, v.noticeDismiss, "click", function () {
      clearNotice(v);
    });
    listen(v, v.speedInput, "input", function () {
      var s = Number(v.speedInput.value);
      v.speed = isFinite(s) && s > 0 ? s : 1;
    });
    listen(v, v.labelsInput, "change", function () {
      v.showLabels = !!v.labelsInput.checked;
      invalidate(v);
    });
    listen(v, v.trailsInput, "change", function () {
      v.trails = !!v.trailsInput.checked;
      v.needClear = true;
      invalidate(v);
    });

    // Pause while the document is hidden or the element is off screen.
    listen(v, v.doc, "visibilitychange", function () {
      if (suspended(v)) unschedule(v);
      else invalidate(v);
    });
    var IO = v.win && v.win.IntersectionObserver;
    if (typeof IO === "function") {
      v.io = new IO(function (entries) {
        var last = entries && entries.length ? entries[entries.length - 1] : null;
        if (!last) return;
        v.onScreen = !!last.isIntersecting;
        if (suspended(v)) unschedule(v);
        else invalidate(v);
      });
      v.io.observe(v.root);
    }
    var RO = v.win && v.win.ResizeObserver;
    if (typeof RO === "function") {
      v.ro = new RO(function () {
        measure(v);
      });
      v.ro.observe(v.stage);
      v.ro.observe(v.root);
    } else if (v.win && typeof v.win.addEventListener === "function") {
      listen(v, v.win, "resize", function () {
        measure(v);
      });
    }
  }

  // ---------- renderer ----------

  function makeRenderer(v) {
    var made = ET.renderer.create(v.canvas, {
      releaseContext: true, // the canvas is thrown away by destroy
      preserveDrawingBuffer: !!v.options.preserveDrawingBuffer,
      onContextChange: function (ev) {
        if (v.destroyed) return;
        if (ev.type === "lost") {
          v.rendering = false;
          notify(v, "The graphics context was lost; waiting for the browser to restore it.");
        } else if (ev.type === "restored") {
          v.rendering = true;
          if (v.mode) v.mode.wiresVersion = -1;
          clearNotice(v);
          v.needClear = true;
          invalidate(v);
        } else {
          v.rendering = false;
          fatal(v, ev.message || "The graphics context could not be restored.");
          retryRebuild(v);
        }
      },
    });
    if (!made.ok) {
      v.renderer = null;
      v.rendering = false;
      fatal(v, made.message);
      return;
    }
    v.renderer = made.renderer;
    v.rendering = true;
  }

  // One retry a second after a failed restore; further retries happen on update.
  function retryRebuild(v) {
    if (v.retryTimer || !v.win || typeof v.win.setTimeout !== "function") return;
    v.retryTimer = v.win.setTimeout(function () {
      v.retryTimer = 0;
      if (v.destroyed || !v.renderer) return;
      var r = v.renderer.rebuild();
      if (r && r.ok) {
        v.rendering = true;
        clearFatal(v);
        if (v.mode) v.mode.wiresVersion = -1;
        invalidate(v);
      }
    }, 1000);
  }

  // ---------- lifecycle ----------

  function mount(el, options) {
    if (!isElement(el)) throw new TypeError("EmbeddingsTumbler.mount needs a DOM element");
    var existing = lookup(el);
    if (existing) return existing.handle;
    var doc = el.ownerDocument;
    var win = doc.defaultView || null;
    var opts = {};
    for (var key in DEFAULT_OPTIONS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, key)) opts[key] = readOption(options, key);
    }
    var reduced = false;
    try {
      reduced = !!(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (err) {
      reduced = false;
    }
    var seed = opts.seed;
    if (!(typeof seed === "number" && isFinite(seed)) && !(typeof seed === "string" && seed !== "")) seed = 1;
    var v = {
      el: el,
      doc: doc,
      win: win,
      options: opts,
      seed: seed,
      speed: Number(opts.speed) > 0 ? Number(opts.speed) : 1,
      reducedMotion: reduced,
      running: opts.paused === null ? !reduced : !opts.paused,
      showLabels: !!opts.labels,
      trails: !!opts.trails,
      modeId: ET.modes.get(opts.mode) ? opts.mode : "tumble",
      set: null,
      mode: null,
      last: null,
      lastDraw: null,
      renderer: null,
      rendering: false,
      destroyed: false,
      broken: false,
      raf: 0,
      prev: null,
      dirty: true,
      onScreen: true,
      spin: 0,
      drawTime: 0,
      userZoom: 1,
      drag: { active: false, yaw: 0, pitch: 0, x: 0, y: 0 },
      pinch: null,
      hover: null,
      needClear: true,
      statusClock: STATUS_EVERY,
      statusText: "",
      sinceAppend: Infinity,
      groupIndex: Object.create(null), // group name -> index; names are untrusted
      groupNames: [],
      labelledCount: 0,
      lightLoad: 0, // see crowding()
      labelSample: [],
      labelPool: [],
      sx: new Float32Array(LABEL_SAMPLE),
      sy: new Float32Array(LABEL_SAMPLE),
      tmp3: [0, 0, 0],
      overlayDirty: false,
      listeners: [],
      io: null,
      ro: null,
      retryTimer: 0,
      frames: 0,
      fps: 0,
      fpsAt: null,
      fpsFrames: 0,
      narrow: null,
      oneColumn: null,
      dpr: 1,
      W: 2,
      H: 2,
      fatalMessage: null,
      fatalKind: null,
      noticeMessage: null,
      timing: {
        mountAt: 0,
        firstFrameMs: null,
        firstReadyMs: null,
        longestFrameMs: 0,
        lastAppendMs: null,
        refits: 0,
        lastRefit: null,
      },
      lastSpent: 0,
      lostTime: false,
      paintKey: null,
      themeKey: null,
    };
    v.timing.mountAt = now(v);
    v.tick = function (t) {
      frame(v, t);
    };
    build(v);
    el.appendChild(v.root);
    syncTheme(v); // read once the root inherits the host's properties
    v.playButton.textContent = v.running ? "Pause" : "Play";
    v.playButton.setAttribute("aria-pressed", v.running ? "false" : "true");
    paintModeButtons(v);
    v.mastTitle.textContent = opts.title ? String(opts.title) : "";
    v.mastTitle.style.display = opts.title ? "" : "none";
    makeRenderer(v);
    sizeStrip(v);
    renderProvenance(v);
    describeSet(v);
    wire(v);
    measure(v);
    v.handle = makeHandle(v);
    remember(el, v);
    invalidate(v);
    return v.handle;
  }

  function destroy(v) {
    if (v.destroyed) return false;
    v.destroyed = true;
    unschedule(v);
    if (v.retryTimer && v.win && typeof v.win.clearTimeout === "function") v.win.clearTimeout(v.retryTimer);
    v.retryTimer = 0;
    if (v.io) v.io.disconnect();
    if (v.ro) v.ro.disconnect();
    v.io = null;
    v.ro = null;
    v.listeners.forEach(function (l) {
      l[0].removeEventListener(l[1], l[2], l[3]);
    });
    v.listeners = [];
    if (v.mode) leaveSafely(v.mode.inst);
    v.mode = null;
    if (v.renderer) {
      try {
        v.renderer.dispose();
      } catch (err) {
        // the element goes away regardless
      }
    }
    v.renderer = null;
    v.rendering = false;
    if (v.root && v.root.parentNode) v.root.parentNode.removeChild(v.root);
    forget(v.el);
    v.set = null;
    v.last = null;
    v.lastDraw = null;
    v.labelPool = [];
    return true;
  }

  function info(v) {
    var m = v.mode;
    return {
      mode: v.modeId,
      paused: !v.running,
      suspended: !v.destroyed && suspended(v),
      hidden: !!v.doc.hidden,
      onScreen: v.onScreen,
      destroyed: v.destroyed,
      reducedMotion: v.reducedMotion,
      time: m ? m.clock : 0,
      seed: v.seed,
      speed: v.speed,
      zoom: v.userZoom,
      ready: readyOf(m),
      preparing: !!(m && (!readyOf(m) || m.jobs.length || m.refit)),
      broken: v.broken,
      count: v.set ? v.set.count : 0,
      dimension: v.set ? v.set.dimension : 0,
      model: v.set ? v.set.model : null,
      rendering: v.rendering,
      animating: !!v.raf,
      frames: v.frames,
      fps: v.fps,
      status: v.statusText,
      message: v.fatalMessage || v.noticeMessage || null,
      timing: {
        firstFrameMs: v.timing.firstFrameMs,
        firstReadyMs: v.timing.firstReadyMs,
        longestFrameMs: v.timing.longestFrameMs,
        lastAppendMs: v.timing.lastAppendMs,
        refits: v.timing.refits,
        lastRefit: v.timing.lastRefit ? Object.assign({}, v.timing.lastRefit) : null,
      },
    };
  }

  function makeHandle(v) {
    var h = {
      element: v.el,
      update: function (data) {
        return update(v, data);
      },
      destroy: function () {
        return destroy(v);
      },
      pause: function () {
        if (!v.destroyed) setRunning(v, false);
      },
      resume: function () {
        if (!v.destroyed) setRunning(v, true);
      },
      isPaused: function () {
        return !v.running;
      },
      setMode: function (id) {
        return setMode(v, id);
      },
      mode: function () {
        return v.modeId;
      },
      modes: function () {
        return ET.modes.ids();
      },
      time: function () {
        return v.mode ? v.mode.clock : 0;
      },
      seek: function (t) {
        var x = Number(t);
        if (!isFinite(x) || x < 0) x = 0;
        if (v.mode) v.mode.clock = x;
        v.spin = x;
        v.needClear = true;
        invalidate(v);
        return v.mode ? v.mode.clock : 0;
      },
      seed: function () {
        return v.seed;
      },
      setSpeed: function (s) {
        var x = Number(s);
        if (isFinite(x) && x > 0) {
          v.speed = x;
          v.speedInput.value = String(x);
        }
        return v.speed;
      },
      zoom: function (z) {
        if (z !== undefined && !v.destroyed) setZoom(v, Number(z) || 1);
        return v.userZoom;
      },
      resetZoom: function () {
        if (!v.destroyed) setZoom(v, 1);
      },
      refreshTheme: function () {
        refreshTheme(v);
      },
      info: function () {
        return info(v);
      },
    };
    Object.defineProperty(h, "_viewer", { value: v, enumerable: false });
    return h;
  }

  return {
    mount: mount,
    get: function (el) {
      var v = lookup(el);
      return v ? v.handle : null;
    },
    update: function (el, data) {
      var v = lookup(el);
      if (!v) {
        return {
          ok: false,
          code: "not-mounted",
          message: "No viewer is mounted on this element; call mount(el) first.",
        };
      }
      return update(v, data);
    },
    destroy: function (el) {
      var v = lookup(el);
      return v ? destroy(v) : false;
    },
    parseColour: parseColour,
    safeCssValue: safeCssValue,
    SHADOW: SHADOW,
    LIGHT_STYLES: LIGHT_STYLES,
    DEFAULT_LIGHT_STYLE: DEFAULT_LIGHT_STYLE,
  };
})();

ET.api.mount = ET.viewer.mount;
ET.api.update = ET.viewer.update;
ET.api.destroy = ET.viewer.destroy;
ET.api.get = ET.viewer.get;
ET.api.registerMode = function (definition) {
  return ET.modes.register(definition);
};

  // Export. Public API only; ET is reachable as api._internal for tests.
  var api = ET.api;
  api.version = ET.version;
  Object.defineProperty(api, "_internal", { value: ET, enumerable: false });

  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api; // node (tests)
  } else {
    root.EmbeddingsTumbler = api; // classic script tag: one global
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
