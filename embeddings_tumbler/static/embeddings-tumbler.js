/*! embeddings-tumbler 0.10.1 | source: github.com/agentculture/embeddings-tumbler | assembled from js/src by scripts/assemble.py, do not edit by hand */
(function (root) {
  "use strict";

  // Shared internal namespace. Every later module adds its functions here
  // (ET.math = {...}, ET.contract = {...}) and reads earlier modules' from it.
  var ET = {};
  ET.version = "0.10.1";
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

    // Subtract the mean. Returns { mean: Float64Array(D), data: Float32Array(N*D) }.
    // With opts.inPlace the input block itself is overwritten and returned as data.
    // Centring is a translation: all pairwise distances are unchanged.
    function centre(X, N, D, opts) {
      var mean = meanOf(X, N, D);
      var Y = opts && opts.inPlace ? X : new Float32Array(N * D);
      for (var i = 0; i < N; i++) {
        var o = i * D;
        for (var d = 0; d < D; d++) Y[o + d] = X[o + d] - mean[d];
      }
      return { mean: mean, data: Y };
    }

    // Total variance of centred data: the mean squared length of the rows.
    function totalVariance(Y, N, D) {
      checkData(Y, N, D);
      var s = 0;
      var len = N * D;
      for (var i = 0; i < len; i++) s += Y[i] * Y[i];
      return N > 0 ? s / N : 0;
    }

    // Variance of the centred data along one unit direction (row r of dirs).
    function varianceAlong(Y, N, D, dirs, r) {
      var o = r * D;
      var s = 0;
      for (var i = 0; i < N; i++) {
        var p = 0;
        var oi = i * D;
        for (var d = 0; d < D; d++) p += Y[oi + d] * dirs[o + d];
        s += p * p;
      }
      return N > 0 ? s / N : 0;
    }

    // Share of the total variance held by the span of `rows` orthonormal
    // directions (row-major, rows * D). Exact for whatever directions are given.
    function varianceShare(Y, N, D, dirs, rows) {
      checkData(Y, N, D);
      checkRows(dirs, rows, D, "varianceShare");
      var total = totalVariance(Y, N, D);
      if (!(total > 0)) return 0;
      var s = 0;
      for (var r = 0; r < rows; r++) s += varianceAlong(Y, N, D, dirs, r);
      return s / total;
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
      for (var i = 0; i < rows; i++) {
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
      return M;
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
    function principalDirections(Y, N, D, k, opts) {
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
      var S = o.sampleRows | 0;
      if (S > 0 && N > S) {
        var Ys = new Float32Array(S * D);
        for (var si = 0; si < S; si++) {
          var src = Math.floor((si * N) / S) * D;
          for (var sd = 0; sd < D; sd++) Ys[si * D + sd] = Y[src + sd];
        }
        var inner = {};
        for (var key in o) if (key !== "sampleRows") inner[key] = o[key];
        var fitted = principalDirections(Ys, S, D, k, inner);
        fitted.totalVariance = totalVariance(Y, N, D);
        fitted.method += "-sampled";
        fitted.sampledRows = S;
        finishPca(Y, N, D, fitted);
        return fitted;
      }
      // k is clamped into 1..D. Directions beyond the data's rank (at most
      // N - 1 for centred data) are an orthonormal completion with variance 0.
      var K = Math.max(1, Math.min(k | 0, D));
      var total = totalVariance(Y, N, D);
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
        orthonormalize(dirs, K, D);
        result.method = "degenerate";
        finishPca(Y, N, D, result);
        return result;
      }
      var seed = mixSeed(o.seed === undefined ? 0 : o.seed, SALT_PCA);
      if (N <= D) {
        var G = gram(Y, N, D);
        var vecs; // rows in N-space
        var nv = Math.min(K, N);
        if (N <= 64) {
          vecs = symmetricEigen(G, N).vectors;
          result.method = "gram-exact";
        } else {
          var it = subspaceIteration(
            function (Q, p, W) {
              denseApply(G, N, Q, p, W);
            },
            N,
            nv,
            o.oversample,
            seed,
            maxIt,
            tol
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
          }
        }
        orthonormalize(dirs, K, D);
      } else {
        var it2 = subspaceIteration(
          function (Q, p, W) {
            covarianceApply(Y, N, D, Q, p, W);
          },
          D,
          K,
          o.oversample,
          seed,
          maxIt,
          tol
        );
        for (var j2 = 0; j2 < K * D; j2++) dirs[j2] = it2.vectors[j2];
        orthonormalize(dirs, K, D);
        result.method = "covariance-iterative";
        result.iterations = it2.iterations;
        result.converged = it2.converged;
      }
      finishPca(Y, N, D, result);
      return result;
    }

    function finishPca(Y, N, D, result) {
      var K = result.count;
      var total = result.totalVariance;
      var s = 0;
      for (var r = 0; r < K; r++) {
        var v = varianceAlong(Y, N, D, result.directions, r);
        result.variances[r] = v;
        result.shares[r] = total > 0 ? v / total : 0;
        s += result.shares[r];
      }
      result.share = s;
    }

    function gram(Y, N, D) {
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
      }
      return G;
    }

    // W (p rows of length n) = A Q for symmetric dense A (n x n), Q given as rows.
    function denseApply(A, n, Q, p, W) {
      for (var j = 0; j < p; j++) {
        var oj = j * n;
        for (var a = 0; a < n; a++) {
          var s = 0;
          var oa = a * n;
          for (var b = 0; b < n; b++) s += A[oa + b] * Q[oj + b];
          W[oj + a] = s;
        }
      }
    }

    // W (p rows of length D) = Y^T (Y Q^T)^T, i.e. the covariance (times N)
    // applied to each row of Q, without forming the D x D matrix.
    function covarianceApply(Y, N, D, Q, p, W) {
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
      }
    }

    // Block subspace iteration with Rayleigh-Ritz for the top k eigenvectors
    // of a symmetric positive semi-definite operator on R^n. Deterministic for
    // a given seed. Returns { vectors: Float64Array(k*n) rows, values, iterations, converged }.
    function subspaceIteration(apply, n, k, oversample, seed, maxIt, tol) {
      var extra = oversample === undefined ? Math.max(4, k) : oversample;
      var p = Math.min(n, k + extra);
      var rng = makeRandom(seed);
      var Q = new Float64Array(p * n);
      rng.fillGauss(Q, 0, p * n);
      orthonormalize(Q, p, n);
      var W = new Float64Array(p * n);
      var B = new Float64Array(p * p);
      var prev = null;
      var eig = null;
      var iterations = 0;
      var converged = false;
      for (var it = 0; it <= maxIt; it++) {
        apply(Q, p, W);
        iterations = it + 1;
        for (var a = 0; a < p; a++) {
          for (var b = a; b < p; b++) {
            var s = 0;
            for (var x = 0; x < n; x++) s += Q[a * n + x] * W[b * n + x];
            B[a * p + b] = s;
            B[b * p + a] = s;
          }
        }
        eig = symmetricEigen(B, p);
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
        orthonormalize(Q, p, n);
      }
      var vectors = new Float64Array(k * n);
      for (var r2 = 0; r2 < k; r2++) {
        for (var c = 0; c < p; c++) {
          var w = eig.vectors[r2 * p + c];
          if (w === 0) continue;
          for (var x2 = 0; x2 < n; x2++) vectors[r2 * n + x2] += w * Q[c * n + x2];
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
    function guidedTour(Y, N, D, opts) {
      checkData(Y, N, D);
      var o = opts || {};
      var m = Math.min(o.subspace === undefined ? 8 : o.subspace | 0, D);
      if (m < 3) throw new RangeError("a guided tour needs a subspace of at least three directions");
      var pca = o.pca;
      if (!pca || pca.count < m || pca.dimension !== D) {
        pca = principalDirections(Y, N, D, m, {
          seed: o.seed,
          sampleRows: o.sampleRows,
          maxIterations: o.maxIterations,
          tolerance: o.tolerance,
          oversample: o.oversample,
        });
      }
      var basis = pca.directions.subarray(0, m * D);
      var tour = makeTour(basis, m, D, { seed: o.seed, speed: o.speed });
      var share = 0;
      for (var j = 0; j < m; j++) share += pca.shares[j];
      tour.kind = "guided-tour";
      tour.varianceShare = share;
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
    // basis, t); it replays cycle starts from frame0 when time goes backwards.
    // opts: { seed (0), period (3.4 s, the reference's), basis, basisRows }
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

      function enterCycle(c) {
        if (c < cycle) {
          start.set(first);
          cycle = -1;
        }
        if (cycle < 0) {
          cycle = 0;
          hiddenDirection(start, D, makeRandom(mixSeed(seed ^ SALT_SWAP, 0)), basis, basisRows, hidden);
        }
        while (cycle < c) {
          swapStep(start, cycle % 3, hidden, 1, D, start);
          orthonormalize(start, 3, D);
          cycle++;
          hiddenDirection(start, D, makeRandom(mixSeed(seed ^ SALT_SWAP, cycle)), basis, basisRows, hidden);
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
      checkData(X, N, D);
      var M = ids.length;
      if (!(M >= 1)) throw new RangeError("localFrame needs at least one point id");
      for (var q = 0; q < M; q++) {
        var id = ids[q];
        if (!(id >= 0 && id < N) || Math.floor(id) !== id) {
          throw new RangeError("localFrame: point id " + id + " is outside 0.." + (N - 1));
        }
      }
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
      var G = gram(Yl, M, D);
      var eig = symmetricEigen(G, M);
      var F64 = new Float64Array(3 * D);
      var axes = Math.min(3, M);
      for (var ax = 0; ax < axes; ax++) {
        if (!(eig.values[ax] > 1e-12 * Math.max(eig.values[0], 1e-300))) continue;
        for (var b = 0; b < M; b++) {
          var w = eig.vectors[ax * M + b];
          for (var d3 = 0; d3 < D; d3++) F64[ax * D + d3] += w * Yl[b * D + d3];
        }
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
      totalVariance: totalVariance,
      varianceShare: varianceShare,
      orthonormalize: orthonormalize,
      frameError: frameError,
      randomFrame: randomFrame,
      project: project,
      symmetricEigen: symmetricEigen,
      principalDirections: principalDirections,
      makeTour: makeTour,
      guidedTour: guidedTour,
      hiddenDirection: hiddenDirection,
      swapAngle: swapAngle,
      swapStep: swapStep,
      makeSwapTour: makeSwapTour,
      makeKnn: makeKnn,
      knn: knn,
      localFrame: localFrame,
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
      for (var j = 0; j < keys.length; j++) o[keys[j]] = clone(v[keys[j]]);
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
    var seen = {};
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
      var held = {};
      for (var b = 0; b < base.points.length; b++) held[base.points[b].id] = true;
      for (var n = 0; n < points.length; n++) {
        if (has(held, points[n].id)) return refuse("id-exists", { id: points[n].id }, base);
      }
      var merged = new Float32Array(base.vectors.length + values.length);
      merged.set(base.vectors, 0);
      merged.set(values, base.vectors.length);
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

  // validate(data, base): in-memory form. Returns { ok: true, set } or
  // { ok: false, code, message, set: base || null }.
  function validate(data, base) {
    return guarded(base, function () {
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
      var r = checkRecordsInner(records, "file", base);
      if (!r.ok) return r;
      if (!isArrayBuffer(block) && !isFloat32Array(block)) {
        return refuse("block-unreadable", { file: records.vectors.file }, base);
      }
      return finishInner(records, block, base);
    });
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
