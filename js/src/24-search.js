// ---------------------------------------------------------------------------
// 24-search.js: ranking one search (ET.search). Pure functions, no DOM, no
// network. See js/api/24-search.md (the interface) and docs/search-interface.md.
//
// The measure is cosine distance (1 minus cosine), in double precision over every
// dimension. Ties go to the lower point index. On-screen position is never an
// input. The long scans are steppers in the convention of 10-math.js: written once
// as generators that pause between small pieces of work, so the result is the same
// however the work was sliced.
// ---------------------------------------------------------------------------
(function () {
  var DEFAULT_K = 8;
  var MIN_K = 3;
  var MAX_K = 20;
  var POOL_FACTOR = 3;
  var PREFIX_MIN = 3;
  var MEASURE = "cosine";
  var MEASURE_TEXT = "cosine distance (1 minus cosine similarity)";

  var MESSAGES = Object.freeze({
    "no-data": "There is no data to search yet.",
    "reduction-not-searchable":
      'Cannot search by embedding: the vectors in this data set were changed after embedding (reduction "{kind}"), and the file does not carry what is needed to change a query the same way. Search among the loaded points still works.',
    "query-model-missing":
      'Cannot search: the embedder did not say which model made the query vector, so it cannot be checked against the data\'s model "{expected}".',
    "query-model-mismatch":
      'Cannot search: the query was embedded by model "{found}" but the data was embedded by model "{expected}". One view compares one model.',
    "query-not-vector": "Cannot search: the query is not a list of numbers.",
    "query-dimension-mismatch":
      "Cannot search: the query vector has dimension {found} but the data has dimension {expected}.",
    "query-non-finite":
      "Cannot search: the query vector holds a value that is not a finite number (at position {index}).",
    "query-zero":
      "Cannot search: the query vector is all zeros, so it has no direction to compare.",
    "point-unknown": 'No point with id "{id}" is in the view.',
    "empty-query": "Nothing to search for: the query has no words.",
    "words-none":
      "None of these words matches a label or text among the loaded points: {words}.",
    "rerank-malformed":
      "The reranker's answer was not one score per candidate; the results stay in embedding order.",
  });

  // ----- messages and small checks -------------------------------------------

  function format(code, values) {
    if (!Object.hasOwn(MESSAGES, code)) throw new RangeError("unknown refusal code: " + code);
    return MESSAGES[code].replace(/\{(\w+)\}/g, function (whole, name) {
      return values && Object.hasOwn(values, name) ? String(values[name]) : whole;
    });
  }

  function refuse(code, values) {
    return { ok: false, code: code, message: format(code, values) };
  }

  function clampK(k) {
    if (typeof k !== "number" || !Number.isFinite(k)) return DEFAULT_K;
    return Math.min(MAX_K, Math.max(MIN_K, Math.round(k)));
  }

  function hasPoints(set) {
    return !!set && set.count > 0 && !!set.vectors && set.vectors.length >= set.count * set.dimension;
  }

  function checkSameSpace(set) {
    if (!hasPoints(set)) return refuse("no-data");
    var kind = set.reduction?.kind ?? "none";
    if (kind === "none") return { ok: true };
    var r = refuse("reduction-not-searchable", { kind: kind });
    r.kind = kind;
    return r;
  }

  function isNumericArray(v) {
    return Array.isArray(v) || v instanceof Float32Array || v instanceof Float64Array;
  }

  function allNumbers(v) {
    for (var i = 0; i < v.length; i++) if (typeof v[i] !== "number") return false;
    return true;
  }

  function firstNonFinite(v) {
    for (var i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return i;
    return -1;
  }

  function isAllZero(v) {
    for (var i = 0; i < v.length; i++) if (v[i] !== 0) return false;
    return true;
  }

  function checkModel(set, query) {
    var model = query?.model;
    if (typeof model !== "string" || model === "") {
      return refuse("query-model-missing", { expected: set.model });
    }
    if (model !== set.model) {
      return refuse("query-model-mismatch", { found: model, expected: set.model });
    }
    return null;
  }

  function checkVector(set, raw) {
    if (!isNumericArray(raw) || !allNumbers(raw)) return refuse("query-not-vector");
    if (raw.length !== set.dimension) {
      return refuse("query-dimension-mismatch", { found: raw.length, expected: set.dimension });
    }
    var vector = Float32Array.from(raw);
    var bad = firstNonFinite(vector);
    if (bad >= 0) return refuse("query-non-finite", { index: bad });
    if (isAllZero(vector)) return refuse("query-zero");
    return { ok: true, vector: vector };
  }

  function checkQuery(set, query) {
    var same = checkSameSpace(set);
    if (!same.ok) return same;
    return checkModel(set, query) ?? checkVector(set, query?.vector);
  }

  // ----- sliced work (the convention of 10-math.js) --------------------------

  var UNIT = 1 << 20; // multiply-adds per unit at most
  var CHECK = UNIT >> 4;
  var SLICE_MS = 1;

  function clockNow() {
    if (typeof performance !== "undefined" && typeof performance?.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

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

  // { step(budgetMs?) -> done, done, progress, result }: step(budgetMs) runs units
  // until budgetMs ms have passed (at least one); step() runs to the end.
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

  function runToEnd(stepper) {
    stepper.step();
    return stepper.result;
  }

  // ----- the exact scan -------------------------------------------------------

  function isF32(v, n) {
    return v instanceof Float32Array && v.length === n;
  }

  // Row sums for one point: dot with the query and squared length, plain and
  // (when scaled) with every dimension multiplied by the scale.
  function rowPlain(V, o, D, q, acc) {
    var dot = 0;
    var nn = 0;
    for (var d = 0; d < D; d++) {
      var x = V[o + d];
      dot += x * q[d];
      nn += x * x;
    }
    acc.dot = dot;
    acc.nn = nn;
  }

  function rowScaled(V, o, D, q, s2, qs2, acc) {
    var dot = 0;
    var nn = 0;
    var dotS = 0;
    var nnS = 0;
    for (var d = 0; d < D; d++) {
      var x = V[o + d];
      var xx = x * x;
      dot += x * q[d];
      nn += xx;
      dotS += x * qs2[d];
      nnS += xx * s2[d];
    }
    acc.dot = dot;
    acc.nn = nn;
    acc.dotS = dotS;
    acc.nnS = nnS;
  }

  // Cosine distance from a dot product, a squared row length and the query's length.
  function cosineDistance(dot, nn, qn) {
    if (nn === 0 || qn === 0) return 1; // no direction: similarity 0
    var c = dot / (Math.sqrt(nn) * qn);
    return 1 - Math.min(1, Math.max(-1, c));
  }

  // The best P points so far, ordered by (distance, index); rows arrive by index.
  function Pool(P) {
    this.cap = P;
    this.n = 0;
    this.dist = new Float64Array(P);
    this.idx = new Int32Array(P);
  }
  Pool.prototype.offer = function (i, d) {
    var j;
    if (this.n === this.cap) {
      if (!(d < this.dist[this.cap - 1])) return;
      j = this.cap - 1;
    } else {
      j = this.n++;
    }
    while (j > 0 && this.dist[j - 1] > d) {
      this.dist[j] = this.dist[j - 1];
      this.idx[j] = this.idx[j - 1];
      j--;
    }
    this.dist[j] = d;
    this.idx[j] = i;
  };

  function sumSquares(q, w) {
    var s = 0;
    for (var d = 0; d < q.length; d++) s += w ? q[d] * q[d] * w[d] : q[d] * q[d];
    return s;
  }

  function squares(scale) {
    var s2 = new Float64Array(scale.length);
    for (var d = 0; d < scale.length; d++) s2[d] = scale[d] * scale[d];
    return s2;
  }

  // How many points come before (dist, idx) in the order by (distance, index).
  function countBefore(distances, dist, idx) {
    var c = 0;
    for (var j = 0; j < distances.length; j++) {
      if (distances[j] < dist || (distances[j] === dist && j < idx)) c++;
    }
    return c;
  }

  function makeHit(set, index, distance, embeddingRank, plainDistance, plainRank) {
    return {
      index: index,
      id: set.ids[index],
      distance: distance,
      similarity: 1 - distance,
      embeddingRank: embeddingRank,
      rank: embeddingRank,
      moved: 0,
      score: null,
      plainDistance: plainDistance,
      plainRank: plainRank,
      gap: 0,
    };
  }

  function buildRanking(set, k, scaled, pool, distances, plainDistances, plainRanks) {
    var pooled = [];
    for (var r = 0; r < pool.n; r++) {
      var i = pool.idx[r];
      var plainD = scaled ? plainDistances[i] : pool.dist[r];
      pooled.push(makeHit(set, i, pool.dist[r], r + 1, plainD, scaled ? plainRanks[r] : r + 1));
    }
    var hits = pooled.slice(0, k);
    var near = hits.length ? hits[0].distance : null;
    var radius = hits.length ? hits[hits.length - 1].distance : null;
    for (var h = 0; h < hits.length; h++) hits[h].gap = hits[h].distance - near;
    return {
      measure: MEASURE,
      k: k,
      count: set.count,
      scaled: scaled,
      hits: hits,
      pool: pooled,
      near: near,
      radius: radius,
      distances: distances,
      plainDistances: scaled ? plainDistances : null,
    };
  }

  function* scanGen(set, q32, scale, k, wk) {
    var N = set.count;
    var D = set.dimension;
    var V = set.vectors;
    var scaled = !!scale;
    var q = Float64Array.from(q32);
    var qn = Math.sqrt(sumSquares(q, null));
    var s2 = scaled ? squares(scale) : null;
    var qs2 = null;
    var qnS = 0;
    if (scaled) {
      qs2 = new Float64Array(D);
      for (var e = 0; e < D; e++) qs2[e] = q[e] * s2[e];
      qnS = Math.sqrt(sumSquares(q, s2));
    }
    var pool = new Pool(Math.min(POOL_FACTOR * k, N));
    var distances = new Float64Array(N);
    var plainDistances = scaled ? new Float64Array(N) : null;
    var acc = { dot: 0, nn: 0, dotS: 0, nnS: 0 };
    for (var i = 0; i < N; i++) {
      if (scaled) {
        rowScaled(V, i * D, D, q, s2, qs2, acc);
        plainDistances[i] = cosineDistance(acc.dot, acc.nn, qn);
        distances[i] = cosineDistance(acc.dotS, acc.nnS, qnS);
      } else {
        rowPlain(V, i * D, D, q, acc);
        distances[i] = cosineDistance(acc.dot, acc.nn, qn);
      }
      pool.offer(i, distances[i]);
      if (wk.add(scaled ? 4 * D : 2 * D)) yield;
    }
    var plainRanks = null;
    if (scaled) {
      plainRanks = new Int32Array(pool.n);
      for (var r = 0; r < pool.n; r++) {
        var pi = pool.idx[r];
        plainRanks[r] = 1 + countBefore(plainDistances, plainDistances[pi], pi);
        if (wk.add(N)) yield;
      }
    }
    return buildRanking(set, k, scaled, pool, distances, plainDistances, plainRanks);
  }

  function makeRank(set, vector, options) {
    var D = set.dimension;
    if (!isF32(vector, D)) throw new TypeError("vector must be a Float32Array of length " + D);
    var scale = options?.scale ?? null;
    if (scale !== null && !isF32(scale, D)) {
      throw new TypeError("scale must be a Float32Array of length " + D);
    }
    var k = clampK(options?.k);
    var wk = new Tracker(set.count * (scale ? 4 * D : 2 * D));
    return genStepper(scanGen(set, vector, scale, k, wk), wk);
  }

  function rank(set, vector, options) {
    return runToEnd(makeRank(set, vector, options));
  }

  // ----- reranking -------------------------------------------------------------

  function scoresOk(ranking, scores) {
    if (!isNumericArray(scores) || scores.length !== ranking.pool.length) return false;
    for (var i = 0; i < scores.length; i++) {
      if (typeof scores[i] !== "number" || !Number.isFinite(scores[i])) return false;
    }
    return true;
  }

  function rerankOrder(ranking, scores) {
    if (!scoresOk(ranking, scores)) return refuse("rerank-malformed");
    var order = [];
    for (var i = 0; i < scores.length; i++) order.push(i);
    // Highest score first; equal scores keep embedding order (the pool's order).
    order.sort(function (a, b) {
      return scores[b] - scores[a] || a - b;
    });
    var take = Math.min(ranking.k, order.length);
    var hits = [];
    for (var r = 0; r < take; r++) {
      var hit = Object.assign({}, ranking.pool[order[r]]);
      hit.rank = r + 1;
      hit.moved = hit.embeddingRank - hit.rank;
      hit.score = scores[order[r]];
      hits.push(hit);
    }
    var near = null;
    var radius = null;
    for (var h = 0; h < hits.length; h++) {
      if (near === null || hits[h].distance < near) near = hits[h].distance;
      if (radius === null || hits[h].distance > radius) radius = hits[h].distance;
    }
    for (var g = 0; g < hits.length; g++) hits[g].gap = hits[g].distance - near;
    return { ok: true, hits: hits, near: near, radius: radius };
  }

  // ----- search from a loaded point ---------------------------------------------

  function pointQuery(set, id) {
    if (!hasPoints(set)) return refuse("no-data");
    var index = set.ids.indexOf(id);
    if (index < 0) return refuse("point-unknown", { id: id });
    var D = set.dimension;
    return { ok: true, index: index, id: id, vector: set.vectors.slice(index * D, index * D + D) };
  }

  function nonEmptyString(v) {
    return typeof v === "string" && v !== "";
  }

  function pointText(set, index) {
    var point = set.points[index];
    var text = point?.metadata?.text;
    if (nonEmptyString(text)) return text;
    if (nonEmptyString(point?.label)) return point.label;
    return set.ids[index];
  }

  // ----- search by words ----------------------------------------------------------

  function tokens(text) {
    if (typeof text !== "string") return [];
    var found = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    return Array.from(new Set(found));
  }

  // The words of one set: word -> ascending point indices, whole phrase -> indices.
  function addTo(map, key, i) {
    var list = map.get(key);
    if (!list) map.set(key, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  }

  function indexPoint(set, i, words, phrases) {
    var label = set.points[i]?.label;
    var text = set.points[i]?.metadata?.text;
    var cost = 64;
    var fields = [label, text];
    for (var f = 0; f < 2; f++) {
      if (typeof fields[f] !== "string") continue;
      cost += fields[f].length;
      var list = tokens(fields[f]);
      if (list.length === 0) continue;
      addTo(phrases, list.join(" "), i);
      for (var w = 0; w < list.length; w++) addTo(words, list[w], i);
    }
    return cost;
  }

  var wordCache = new WeakMap();

  function* indexGen(set, wk) {
    var cached = wordCache.get(set);
    if (cached) return cached;
    var words = new Map();
    var phrases = new Map();
    for (var i = 0; i < set.count; i++) {
      if (wk.add(indexPoint(set, i, words, phrases))) yield;
    }
    var built = { words: words, phrases: phrases };
    wordCache.set(set, built);
    return built;
  }

  // Points whose words start with `word`, ascending and each once.
  function prefixPoints(index, word) {
    var seen = new Set();
    index.words.forEach(function (list, key) {
      if (key.startsWith(word)) for (var j = 0; j < list.length; j++) seen.add(list[j]);
    });
    return Array.from(seen).sort(function (a, b) {
      return a - b;
    });
  }

  // How each word matches: [{ word, how, points }] and the words that match nothing.
  function resolveWords(index, words) {
    var used = [];
    var unmatched = [];
    for (var w = 0; w < words.length; w++) {
      var points = index.words.get(words[w]);
      var how = "exact";
      if (!points && Array.from(words[w]).length >= PREFIX_MIN) {
        points = prefixPoints(index, words[w]);
        how = "prefix";
      }
      if (points && points.length > 0) used.push({ word: words[w], how: how, points: points });
      else unmatched.push(words[w]);
    }
    return { used: used, unmatched: unmatched };
  }

  // Adds the mean of the rows `points` (double precision) times `weight` into `total`.
  function* addMean(set, points, weight, total, wk) {
    var D = set.dimension;
    var V = set.vectors;
    var sum = new Float64Array(D);
    for (var p = 0; p < points.length; p++) {
      var o = points[p] * D;
      for (var d = 0; d < D; d++) sum[d] += V[o + d];
      if (wk.add(D)) yield;
    }
    for (var e = 0; e < D; e++) total[e] += (sum[e] / points.length) * weight;
  }

  function wordFailure(code, words, unmatched) {
    var r = refuse(code, { words: unmatched.join(", ") });
    r.words = words;
    r.unmatched = unmatched;
    return r;
  }

  function* wordGen(set, text, wk) {
    var words = tokens(text);
    if (!hasPoints(set)) return wordFailure("no-data", words, words);
    if (words.length === 0) return wordFailure("empty-query", words, []);
    var index = yield* indexGen(set, wk);
    var phrase = words.join(" ");
    var whole = index.phrases.get(phrase);
    var picked;
    if (whole) {
      picked = {
        used: [{ word: phrase, how: "whole", points: whole }],
        unmatched: [],
      };
    } else {
      picked = resolveWords(index, words);
    }
    if (picked.used.length === 0) return wordFailure("words-none", words, picked.unmatched);
    var total = new Float64Array(set.dimension);
    for (var u = 0; u < picked.used.length; u++) {
      yield* addMean(set, picked.used[u].points, 1 / picked.used.length, total, wk);
    }
    var vector = Float32Array.from(total);
    if (isAllZero(vector)) return wordFailure("query-zero", words, picked.unmatched);
    return {
      ok: true,
      vector: vector,
      words: words,
      used: picked.used.map(function (m) {
        return { word: m.word, how: m.how, count: m.points.length };
      }),
      unmatched: picked.unmatched,
      whole: !!whole,
    };
  }

  function makeWordQuery(set, text) {
    var n = set?.count > 0 ? set.count : 1;
    var wk = new Tracker(n * (set?.dimension > 0 ? set.dimension : 1));
    return genStepper(wordGen(set, text, wk), wk);
  }

  function wordQuery(set, text) {
    return runToEnd(makeWordQuery(set, text));
  }

  ET.search = {
    DEFAULT_K: DEFAULT_K,
    MIN_K: MIN_K,
    MAX_K: MAX_K,
    POOL_FACTOR: POOL_FACTOR,
    PREFIX_MIN: PREFIX_MIN,
    MEASURE: MEASURE,
    MEASURE_TEXT: MEASURE_TEXT,
    MESSAGES: MESSAGES,
    clampK: clampK,
    format: format,
    checkSameSpace: checkSameSpace,
    checkQuery: checkQuery,
    makeRank: makeRank,
    rank: rank,
    rerankOrder: rerankOrder,
    pointQuery: pointQuery,
    pointText: pointText,
    tokens: tokens,
    makeWordQuery: makeWordQuery,
    wordQuery: wordQuery,
  };
})();
