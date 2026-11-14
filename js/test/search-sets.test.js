"use strict";
// ET.searchSets (js/src/26-search-sets.js, interface js/api/26-search-sets.md): several
// searches at once. What is lit and how strongly under the three lit settings, the shared
// mark, the report for each pair, the point-of-view scale and the seeded facing frame.
//
// The rankings here are built by hand in the shape js/api/24-search.md documents (the
// module that makes them is written separately), with the test's own cosine arithmetic.
// Most tests run the committed assembled file, which is what ships and what coverage is
// measured on; the determinism tests also load the module afresh.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled, loadSources, ASSEMBLED } = require("./helpers/load.js");
const { rngFrom } = require("./helpers/math-fixtures.js");

const ET = loadAssembled()._internal;
const S = ET.searchSets;

// The assembled file loaded again from disk, not from require's cache.
function freshAssembled() {
  delete require.cache[ASSEMBLED];
  try {
    return require(ASSEMBLED)._internal;
  } finally {
    delete require.cache[ASSEMBLED];
  }
}

function bytes(A) {
  return Buffer.from(A.buffer, A.byteOffset, A.byteLength);
}

function sameBits(A, B) {
  return A.length === B.length && bytes(A).equals(bytes(B));
}

// ---------- fixtures ----------

// N points in D dimensions around `groups` seeded centres, as a loader set.
function makeSet(N, D, seed, groups = 5) {
  const rng = rngFrom(seed);
  const centres = [];
  for (let g = 0; g < groups; g++) {
    const c = new Float64Array(D);
    for (let d = 0; d < D; d++) c[d] = rng.gauss();
    centres.push(c);
  }
  const vectors = new Float32Array(N * D);
  for (let i = 0; i < N; i++) {
    const c = centres[i % groups];
    for (let d = 0; d < D; d++) vectors[i * D + d] = c[d] + 0.6 * rng.gauss();
  }
  return setOf(vectors, N, D);
}

function setOf(vectors, N, D) {
  const ids = Array.from({ length: N }, (_, i) => "p" + i);
  return { dimension: D, count: N, vectors, ids, points: ids.map((id) => ({ id, label: id })) };
}

// Cosine distance in double precision; a zero vector is at distance 1 (js/api/24-search.md).
function cosDist(a, b) {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let d = 0; d < a.length; d++) {
    ab += a[d] * b[d];
    aa += a[d] * a[d];
    bb += b[d] * b[d];
  }
  if (aa === 0 || bb === 0) return 1;
  return 1 - Math.min(1, Math.max(-1, ab / (Math.sqrt(aa) * Math.sqrt(bb))));
}

function row(set, i) {
  return set.vectors.subarray(i * set.dimension, (i + 1) * set.dimension);
}

function times(v, s) {
  return v.map((x, d) => x * s[d]);
}

// A ranking in the documented shape, by brute force: the k nearest by cosine distance
// (scaled by `scale` when given), ties to the lower index.
function ranking(set, query, k, scale) {
  const N = set.count;
  const q = scale ? times(Float64Array.from(query), scale) : query;
  const distances = new Float64Array(N);
  const plain = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const x = row(set, i);
    distances[i] = cosDist(scale ? times(Float64Array.from(x), scale) : x, q);
    plain[i] = cosDist(x, query);
  }
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => distances[a] - distances[b] || a - b);
  const hits = order.slice(0, k).map((index, r) => ({
    index,
    id: set.ids[index],
    distance: distances[index],
    similarity: 1 - distances[index],
    embeddingRank: r + 1,
    rank: r + 1,
    moved: 0,
    score: null,
    plainDistance: plain[index],
    gap: distances[index] - distances[order[0]],
  }));
  return {
    measure: "cosine",
    k,
    count: N,
    scaled: !!scale,
    hits,
    pool: hits,
    near: hits.length ? hits[0].distance : null,
    radius: hits.length ? hits[hits.length - 1].distance : null,
    distances,
    plainDistances: scale ? plain : null,
  };
}

// A hand ranking over given distances: hits are the listed indices, in that order.
function handRanking(distances, hitIndices) {
  const hits = hitIndices.map((index, r) => ({ index, distance: distances[index], rank: r + 1 }));
  const ds = hits.map((h) => h.distance);
  return {
    measure: "cosine",
    k: hits.length,
    count: distances.length,
    scaled: false,
    hits,
    pool: hits,
    near: hits.length ? Math.min(...ds) : null,
    radius: hits.length ? Math.max(...ds) : null,
    distances: Float64Array.from(distances),
    plainDistances: null,
  };
}

function queryOf(set, i, noise, seed) {
  const rng = rngFrom(seed);
  return Float32Array.from(row(set, i), (x) => x + noise * rng.gauss());
}

function facingInput(set, rankings, queries) {
  return rankings.map((r, j) => ({ query: queries[j], hits: r.hits }));
}

function frameError(F, D) {
  let worst = 0;
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      let p = 0;
      for (let d = 0; d < D; d++) p += F[a * D + d] * F[b * D + d];
      worst = Math.max(worst, Math.abs(p - (a === b ? 1 : 0)));
    }
  }
  return worst;
}

function dotRow(F, r, v, D) {
  let p = 0;
  for (let d = 0; d < D; d++) p += F[r * D + d] * v[d];
  return p;
}

// Length of what is left of v after removing its components along the frame's first m rows,
// relative to its own length.
function residualShare(F, m, v, D) {
  const w = Float64Array.from(v);
  for (let r = 0; r < m; r++) {
    const p = dotRow(F, r, w, D);
    for (let d = 0; d < D; d++) w[d] -= p * F[r * D + d];
  }
  return Math.hypot(...w) / Math.hypot(...v);
}

function meanRows(vs, D) {
  const m = new Float64Array(D);
  for (const v of vs) for (let d = 0; d < D; d++) m[d] += v[d] / vs.length;
  return m;
}

// The centre of one search as the interface defines it: the mean of its query and hits.
function centreOf(set, query, hits, scale) {
  const D = set.dimension;
  const vs = [query, ...hits.map((h) => row(set, h.index))].map((v) =>
    scale ? times(Float64Array.from(v), scale) : Float64Array.from(v),
  );
  return meanRows(vs, D);
}

// ---------- constants and small functions ----------

test("constants are the interface's values, and the lists are frozen", () => {
  assert.strictEqual(S.MAX_SEARCHES, 4);
  assert.deepStrictEqual(S.LETTERS, ["A", "B", "C", "D"]);
  assert.deepStrictEqual(S.LIT_SETTINGS, ["even", "close", "named"]);
  assert.ok(Object.isFrozen(S.LETTERS) && Object.isFrozen(S.LIT_SETTINGS));
  assert.strictEqual(S.DEFAULT_LIT, "even");
  assert.strictEqual(S.LIT_THRESHOLD, 0.02);
  assert.strictEqual(S.CLOSE_REACH, 2.2);
  assert.strictEqual(S.CLOSE_POWER, 1.6);
  assert.strictEqual(S.FACE_SALT, 0x46414345);
  assert.strictEqual(S.FACE_ITERATIONS, 25);
  assert.strictEqual(S.FACE_ZOOM, 0.7);
});

test("letter names positions 0 to 3 and refuses anything else", () => {
  assert.deepStrictEqual([0, 1, 2, 3].map(S.letter), ["A", "B", "C", "D"]);
  for (const bad of [-1, 4, 1.5, Number.NaN, "1", null, undefined]) {
    assert.throws(() => S.letter(bad), RangeError, String(bad));
  }
});

test("litSetting passes the three settings and turns anything else into the default", () => {
  for (const s of S.LIT_SETTINGS) assert.strictEqual(S.litSetting(s), s);
  for (const bad of [undefined, null, "", "EVEN", 3, {}, "close "]) {
    assert.strictEqual(S.litSetting(bad), "even");
  }
});

test("scaleFor is the absolute value of every entry, as a new Float32Array", () => {
  const q = new Float32Array([0.5, -2, 0, -0.25, 3]);
  const s = S.scaleFor(q);
  assert.ok(s instanceof Float32Array);
  assert.deepStrictEqual(Array.from(s), [0.5, 2, 0, 0.25, 3]);
  q[0] = 9;
  assert.strictEqual(s[0], 0.5, "a copy, not a view");
  assert.deepStrictEqual(Array.from(S.scaleFor([-1, 2])), [1, 2], "plain arrays are read too");
  assert.throws(() => S.scaleFor(null), TypeError);
  assert.throws(() => S.scaleFor(5), TypeError);
});

// ---------- lit values ----------

const DIST_A = [0.1, 0.2, 0.3, 0.35, 0.5, 0.9, 1.4, 0.05];
const HITS_A = [7, 0, 1, 2]; // near 0.05, radius 0.3

test("evenly: every point as near as the last named result is lit at 1, the rest at 0", () => {
  const r = handRanking(DIST_A, HITS_A);
  const out = S.litValues([r], DIST_A.length, "even");
  assert.deepStrictEqual(Array.from(out.lit), [1, 1, 1, 0, 0, 0, 0, 1]);
  assert.deepStrictEqual(Array.from(out.inside), [1, 1, 1, 0, 0, 0, 0, 1]);
  assert.deepStrictEqual(out.insideCounts, [4]);
  assert.strictEqual(out.litCount, 4);
  assert.strictEqual(out.sharedCount, 0);
  assert.deepStrictEqual(Array.from(out.shared), new Array(8).fill(0));
  assert.ok(out.lit instanceof Float32Array && out.shared instanceof Uint8Array && out.inside instanceof Uint8Array);
});

test("a point exactly at the result radius is inside", () => {
  const r = handRanking([0.2, 0.4, 0.4000001], [0, 1]);
  assert.deepStrictEqual(Array.from(S.litValues([r], 3, "even").inside), [1, 1, 0]);
});

test("by closeness: the interface's formula, 1 at the nearest result, 0 a little beyond the last", () => {
  const r = handRanking(DIST_A, HITS_A);
  const out = S.litValues([r], DIST_A.length, "close");
  const near = 0.05;
  const radius = 0.3;
  const reach = near + (radius - near) * 2.2 + 1e-6;
  DIST_A.forEach((d, i) => {
    const want = Math.fround(Math.min(Math.max(1 - (d - near) / (reach - near), 0), 1) ** 1.6);
    assert.strictEqual(out.lit[i], want, "point " + i);
  });
  assert.strictEqual(out.lit[7], 1, "the nearest named result is at full strength");
  assert.ok(out.lit[4] > 0 && out.lit[4] < 1, "a point beyond the radius but within reach still glows");
  assert.strictEqual(out.lit[5], 0, "far beyond the reach: dark");
  assert.deepStrictEqual(out.insideCounts, [4], "inside is the radius, whatever the setting");
});

test("by closeness: for one search a nearer point is never dimmer than a farther one", () => {
  const set = makeSet(600, 24, 11);
  const r = ranking(set, queryOf(set, 3, 0.3, 5), 12);
  const out = S.litValues([r], set.count, "close");
  const order = Array.from({ length: set.count }, (_, i) => i).sort((a, b) => r.distances[a] - r.distances[b]);
  for (let j = 1; j < order.length; j++) {
    assert.ok(out.lit[order[j - 1]] >= out.lit[order[j]], "rank " + j);
  }
  assert.ok(out.litCount > r.hits.length, "the fade reaches past the named results");
  assert.ok(out.litCount < set.count, "and ends");
});

test("a point nearer than the nearest named result (after reranking) is at full strength", () => {
  // hits reordered by a reranker: point 2 (0.01) is nearer than every hit but not a hit
  const r = handRanking([0.2, 0.3, 0.01, 0.9], [1, 0]);
  const out = S.litValues([r], 4, "close");
  assert.strictEqual(out.lit[2], 1);
  assert.strictEqual(out.inside[2], 1);
});

test("named results only: a search's hits are lit at 1 and every other point at 0", () => {
  const r = handRanking(DIST_A, HITS_A);
  const out = S.litValues([r], DIST_A.length, "named");
  assert.deepStrictEqual(Array.from(out.lit), [1, 1, 1, 0, 0, 0, 0, 1]);
  const r2 = handRanking([0.1, 0.05, 0.3, 0.2], [2, 3]); // points 0 and 1 are inside but not named
  const out2 = S.litValues([r2], 4, "named");
  assert.deepStrictEqual(Array.from(out2.lit), [0, 0, 1, 1]);
  assert.deepStrictEqual(Array.from(out2.inside), [1, 1, 1, 1]);
  assert.strictEqual(out2.litCount, 2);
});

test("an unknown setting is the default (evenly)", () => {
  const r = handRanking(DIST_A, HITS_A);
  assert.deepStrictEqual(S.litValues([r], 8, "bright"), S.litValues([r], 8, "even"));
  assert.deepStrictEqual(S.litValues([r], 8), S.litValues([r], 8, "even"));
});

test("several searches: the brightest value wins and the inside counts add up", () => {
  const a = handRanking([0.1, 0.2, 0.9, 0.9, 0.15], [0, 1]); // radius 0.2: inside 0, 1, 4
  const b = handRanking([0.9, 0.3, 0.1, 0.9, 0.2], [2, 1]); // radius 0.3: inside 1, 2, 4
  const even = S.litValues([a, b], 5, "even");
  assert.deepStrictEqual(Array.from(even.inside), [1, 2, 1, 0, 2]);
  assert.deepStrictEqual(even.insideCounts, [3, 3]);
  assert.deepStrictEqual(Array.from(even.shared), [0, 1, 0, 0, 1]);
  assert.strictEqual(even.sharedCount, 2);
  assert.strictEqual(even.litCount, 4);
  const close = S.litValues([a, b], 5, "close");
  const ca = S.litValues([a], 5, "close").lit;
  const cb = S.litValues([b], 5, "close").lit;
  for (let i = 0; i < 5; i++) assert.strictEqual(close.lit[i], Math.max(ca[i], cb[i]), "point " + i);
});

test("the shared mark needs two searches' radii: one search alone never marks a point", () => {
  const set = makeSet(500, 16, 21);
  const r = ranking(set, queryOf(set, 0, 0.2, 1), 20);
  for (const how of S.LIT_SETTINGS) {
    const out = S.litValues([r], set.count, how);
    assert.strictEqual(out.sharedCount, 0, how);
  }
});

test("a point is shared exactly when it is inside two or more radii and lit", () => {
  const set = makeSet(800, 20, 31, 3);
  const q0 = queryOf(set, 0, 0.4, 2);
  const q1 = queryOf(set, 0, 0.4, 3); // near the same point as q0, so the two overlap
  const q2 = queryOf(set, 1, 0.4, 4);
  const rs = [ranking(set, q0, 20), ranking(set, q1, 20), ranking(set, q2, 20)];
  for (const how of S.LIT_SETTINGS) {
    const out = S.litValues(rs, set.count, how);
    let shared = 0;
    for (let i = 0; i < set.count; i++) {
      const inside = rs.filter((r) => r.distances[i] <= r.radius).length;
      assert.strictEqual(out.inside[i], inside);
      const want = inside >= 2 && out.lit[i] > 0 ? 1 : 0;
      assert.strictEqual(out.shared[i], want, how + " point " + i);
      shared += want;
    }
    assert.strictEqual(out.sharedCount, shared);
    if (how === "even") assert.ok(shared > 0, "the fixture has shared points");
    if (how === "named") {
      for (let i = 0; i < set.count; i++) {
        if (out.shared[i]) assert.ok(rs.some((r) => r.hits.some((h) => h.index === i)), "named: a shared point is a hit");
      }
    }
  }
});

test("under named, a point inside two radii that is nobody's hit is not marked", () => {
  const a = handRanking([0.1, 0.2, 0.15], [0, 1]); // point 2 inside, not named
  const b = handRanking([0.3, 0.1, 0.2], [1, 0]); // point 2 inside (0.2 <= 0.3), not named
  const out = S.litValues([a, b], 3, "named");
  assert.strictEqual(out.inside[2], 2);
  assert.strictEqual(out.shared[2], 0);
  assert.strictEqual(out.sharedCount, 2);
});

test("a ranking made before an append: the new points are not inside it and get 0 from it", () => {
  const r = handRanking([0.1, 0.2, 0.3], [0, 1, 2]);
  const out = S.litValues([r], 5, "even");
  assert.deepStrictEqual(Array.from(out.lit), [1, 1, 1, 0, 0]);
  assert.deepStrictEqual(Array.from(out.inside), [1, 1, 1, 0, 0]);
  assert.deepStrictEqual(out.insideCounts, [3]);
  const named = S.litValues([handRanking([0.1, 0.2, 0.3], [0, 2])], 2, "named");
  assert.deepStrictEqual(Array.from(named.lit), [1, 0], "a hit past count is not written");
});

test("no searches: every array is zeros of the right length and both counts are 0", () => {
  const out = S.litValues([], 6, "close");
  assert.deepStrictEqual(Array.from(out.lit), new Array(6).fill(0));
  assert.deepStrictEqual(Array.from(out.shared), new Array(6).fill(0));
  assert.deepStrictEqual(Array.from(out.inside), new Array(6).fill(0));
  assert.deepStrictEqual(out.insideCounts, []);
  assert.strictEqual(out.litCount, 0);
  assert.strictEqual(out.sharedCount, 0);
  assert.strictEqual(S.litValues([], 0).lit.length, 0);
});

test("a ranking with no hits (an empty set) lights nothing", () => {
  const empty = handRanking([], []);
  const out = S.litValues([empty], 3, "close");
  assert.deepStrictEqual(Array.from(out.lit), [0, 0, 0]);
  assert.deepStrictEqual(out.insideCounts, [0]);
});

test("litValues refuses more than four searches and a bad count", () => {
  const r = handRanking([0.1], [0]);
  assert.throws(() => S.litValues([r, r, r, r, r], 1), RangeError);
  assert.doesNotThrow(() => S.litValues([r, r, r, r], 1));
  for (const bad of [-1, 1.5, Number.NaN, "3", undefined]) {
    assert.throws(() => S.litValues([r], bad), RangeError, String(bad));
  }
  assert.throws(() => S.litValues(null, 1), TypeError);
});

test("lit values read each search's own distances: a scaled ranking is never re-measured", () => {
  // the ranking's distances (its own measure) and plainDistances (unscaled) disagree;
  // only `distances` and `radius` decide what is inside.
  const r = handRanking([0.1, 0.2, 0.9], [0, 1]);
  r.scaled = true;
  r.plainDistances = Float64Array.from([0.9, 0.9, 0.05]);
  const out = S.litValues([r], 3, "even");
  assert.deepStrictEqual(Array.from(out.inside), [1, 1, 0]);
});

// ---------- pair reports ----------

test("pairs come in order A-B, A-C, A-D, B-C, B-D, C-D; fewer than two searches give none", () => {
  const set = makeSet(200, 12, 41);
  const rs = [0, 1, 2, 3].map((g) => ranking(set, queryOf(set, g, 0.3, g + 10), 6));
  const pairs = S.pairReports(set, rs);
  assert.deepStrictEqual(
    pairs.map((p) => [p.a, p.b]),
    [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ],
  );
  assert.deepStrictEqual(S.pairReports(set, rs.slice(0, 1)), []);
  assert.deepStrictEqual(S.pairReports(set, []), []);
  assert.throws(() => S.pairReports(set, [...rs, rs[0]]), RangeError);
});

test("each pair's report: shared count, named results in common, closest pair of different results", () => {
  const set = makeSet(700, 20, 51, 3);
  const qs = [queryOf(set, 0, 0.5, 7), queryOf(set, 3, 0.5, 8), queryOf(set, 1, 0.5, 9)];
  const rs = qs.map((q) => ranking(set, q, 15));
  const pairs = S.pairReports(set, rs);
  let anyCommon = false;
  for (const p of pairs) {
    const ra = rs[p.a];
    const rb = rs[p.b];
    let shared = 0;
    for (let i = 0; i < set.count; i++) {
      if (ra.distances[i] <= ra.radius && rb.distances[i] <= rb.radius) shared++;
    }
    assert.strictEqual(p.shared, shared, "shared " + p.a + p.b);
    const inB = new Set(rb.hits.map((h) => h.index));
    const common = ra.hits.map((h) => h.index).filter((i) => inB.has(i));
    assert.strictEqual(p.common, common.length);
    assert.deepStrictEqual(p.commonIndices, common, "in a's rank order");
    anyCommon ||= common.length > 0;
    let best = null;
    for (const ha of ra.hits) {
      for (const hb of rb.hits) {
        if (ha.index === hb.index) continue;
        const dd = cosDist(row(set, ha.index), row(set, hb.index));
        if (!best || dd < best.distance) best = { a: ha.index, b: hb.index, distance: dd };
      }
    }
    assert.deepStrictEqual(p.closest, best);
  }
  assert.ok(anyCommon, "the fixture has named results in common");
  assert.ok(pairs[0].shared > 0, "searches 0 and 1 overlap in the fixture");
});

test("the closest pair is null only when no two different named results exist", () => {
  const set = makeSet(50, 8, 61);
  const r = ranking(set, queryOf(set, 0, 0.1, 1), 5);
  const [p] = S.pairReports(set, [r, r]);
  assert.strictEqual(p.common, 5);
  assert.strictEqual(p.shared, r.hits.length);
  // the same five results on both sides: different results still pair up across them
  assert.notStrictEqual(p.closest, null);
  assert.notStrictEqual(p.closest.a, p.closest.b);
  // one and the same result on both sides: no pair of different results
  const one = handRanking(Array.from(r.distances), [r.hits[0].index]);
  const [q] = S.pairReports(set, [one, one]);
  assert.strictEqual(q.common, 1);
  assert.strictEqual(q.closest, null);
});

test("closest ties go to the earlier hit of a, then the earlier hit of b", () => {
  // points 0 and 1 are identical, as are 2 and 3: every cross pair is at the same distance
  const D = 3;
  const v = new Float32Array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0]);
  const set = setOf(v, 4, D);
  const a = handRanking([0, 0, 1, 1], [1, 0]);
  const b = handRanking([1, 1, 0, 0], [3, 2]);
  const [p] = S.pairReports(set, [a, b]);
  assert.deepStrictEqual(p.closest, { a: 1, b: 3, distance: 1 });
});

test("pair distances are plain cosine distances in the full space, whatever the searches' scale", () => {
  const set = makeSet(300, 16, 71);
  const q0 = queryOf(set, 0, 0.3, 1);
  const q1 = queryOf(set, 1, 0.3, 2);
  const plain = [ranking(set, q0, 8), ranking(set, q1, 8)];
  const scaled = [ranking(set, q0, 8, S.scaleFor(q0)), plain[1]];
  for (const rs of [plain, scaled]) {
    const [p] = S.pairReports(set, rs);
    const want = cosDist(row(set, p.closest.a), row(set, p.closest.b));
    assert.strictEqual(p.closest.distance, want);
  }
});

test("a zero row is at distance 1 from everything in a pair report", () => {
  const v = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const set = setOf(v, 3, 3);
  const a = handRanking([0, 1, 1], [0]);
  const b = handRanking([1, 0, 0.5], [1, 2]);
  const [p] = S.pairReports(set, [a, b]);
  assert.deepStrictEqual(p.closest, { a: 0, b: 1, distance: 1 });
});

test("opposite points are at distance 2 (the cosine is clamped)", () => {
  const v = new Float32Array([1, 2, 3, -1, -2, -3]);
  const set = setOf(v, 2, 3);
  const [p] = S.pairReports(set, [handRanking([0, 2], [0]), handRanking([2, 0], [1])]);
  assert.strictEqual(p.closest.distance, 2);
});

test("pair shared counts use the shorter ranking after an append, and empty rankings share nothing", () => {
  const set = makeSet(10, 4, 81);
  const a = handRanking([0.1, 0.1, 0.1], [0]);
  const b = handRanking([0.1, 0.1, 0.1, 0.1, 0.1], [1]);
  assert.strictEqual(S.pairReports(set, [a, b])[0].shared, 3);
  const e = handRanking([], []);
  const [p] = S.pairReports(set, [a, e]);
  assert.deepStrictEqual(p, { a: 0, b: 1, shared: 0, common: 0, commonIndices: [], closest: null });
});

test("pair reports refuse a hit that is not a row of the set", () => {
  const set = makeSet(5, 4, 91);
  const bad = handRanking([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], [5]);
  const ok = handRanking([0.1, 0.2, 0.3, 0.4, 0.5], [0]);
  assert.throws(() => S.pairReports(set, [ok, bad]), RangeError);
  assert.throws(() => S.pairReports(set, null), TypeError);
});

// ---------- the facing frame ----------

function twoSearchFixture(D = 32, seed = 101) {
  const set = makeSet(400, D, seed, 4);
  const qs = [queryOf(set, 0, 0.3, 1), queryOf(set, 1, 0.3, 2)];
  const rs = qs.map((q) => ranking(set, q, 8));
  return { set, qs, rs, searches: facingInput(set, rs, qs) };
}

test("two searches: the frame is orthonormal and its first axis joins their centres", () => {
  const { set, qs, rs, searches } = twoSearchFixture();
  const D = set.dimension;
  const res = S.facingFrame(set, searches, { seed: 7 });
  assert.ok(res.frame instanceof Float32Array && res.frame.length === 3 * D);
  assert.ok(frameError(res.frame, D) < 1e-5);
  const c0 = centreOf(set, qs[0], rs[0].hits);
  const c1 = centreOf(set, qs[1], rs[1].hits);
  const join = c1.map((x, d) => x - c0[d]);
  assert.ok(residualShare(res.frame, 1, join, D) < 1e-5, "axis 0 is along c1 - c0");
  assert.ok(dotRow(res.frame, 0, join, D) !== 0);
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [1, 2, 0]);
});

test("three and four searches: the first two or three axes span the centres", () => {
  const set = makeSet(500, 40, 111, 5);
  const D = set.dimension;
  for (const n of [3, 4]) {
    const qs = Array.from({ length: n }, (_, j) => queryOf(set, j, 0.3, 20 + j));
    const rs = qs.map((q) => ranking(set, q, 10));
    const res = S.facingFrame(set, facingInput(set, rs, qs), { seed: 3 });
    assert.ok(frameError(res.frame, D) < 1e-5);
    const c = qs.map((q, j) => centreOf(set, q, rs[j].hits));
    const m = n - 1;
    for (let j = 1; j < n; j++) {
      const join = c[j].map((x, d) => x - c[0][d]);
      assert.ok(residualShare(res.frame, m, join, D) < 1e-5, n + " searches: c" + j + " - c0 in the span");
    }
    assert.strictEqual(res.fromCentres, m);
    assert.strictEqual(res.fromSpread, 3 - m);
  }
});

test("one search: all three axes come from the spread of its rows", () => {
  const set = makeSet(300, 24, 121);
  const q = queryOf(set, 0, 0.3, 1);
  const r = ranking(set, q, 12);
  const res = S.facingFrame(set, [{ query: q, hits: r.hits }], { seed: 1 });
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [0, 3, 0]);
  assert.ok(frameError(res.frame, set.dimension) < 1e-5);
});

test("the first spread axis is the strongest spread direction left (power iteration converges)", () => {
  // one search whose rows spread far more along e5 than anywhere else
  const D = 10;
  const rng = rngFrom(5);
  const N = 12;
  const v = new Float32Array(N * D);
  for (let i = 0; i < N; i++) {
    for (let d = 0; d < D; d++) v[i * D + d] = 0.01 * rng.gauss();
    v[i * D + 5] += (i % 2 ? 1 : -1) * (1 + i * 0.1);
  }
  const set = setOf(v, N, D);
  const hits = Array.from({ length: N - 1 }, (_, i) => ({ index: i + 1 }));
  const res = S.facingFrame(set, [{ query: row(set, 0), hits }], { seed: 9 });
  assert.ok(Math.abs(res.frame[5]) > 0.999, "axis 0 is e5");
});

test("centre is the mean of the unscaled centres and zoom is FACE_ZOOM over the reach", () => {
  const { set, qs, rs, searches } = twoSearchFixture(16, 131);
  const D = set.dimension;
  for (const scale of [null, S.scaleFor(qs[0])]) {
    const res = S.facingFrame(set, searches, { seed: 2, scale });
    const c = meanRows([centreOf(set, qs[0], rs[0].hits), centreOf(set, qs[1], rs[1].hits)], D);
    assert.deepStrictEqual(Array.from(res.centre), Array.from(Float32Array.from(c)));
    let reach = 1e-3;
    for (let j = 0; j < 2; j++) {
      for (const r of [qs[j], ...rs[j].hits.map((h) => row(set, h.index))]) {
        const rel = Array.from(r, (x, d) => x - res.centre[d]);
        reach = Math.max(reach, Math.hypot(dotRow(res.frame, 0, rel, D), dotRow(res.frame, 1, rel, D), dotRow(res.frame, 2, rel, D)));
      }
    }
    assert.ok(Math.abs(res.zoom - 0.7 / reach) < 1e-9 * res.zoom, "zoom " + res.zoom + " vs " + 0.7 / reach);
  }
});

test("the reach is at least 1e-3: one search of identical rows", () => {
  const D = 4;
  const v = new Float32Array([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  const set = setOf(v, 4, D);
  const hits = [1, 2, 3].map((index) => ({ index }));
  const res = S.facingFrame(set, [{ query: row(set, 0), hits }], { seed: 1 });
  assert.strictEqual(res.zoom, 0.7 / 1e-3);
  // no centre joins, no spread: the fallback basis, in order
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [0, 0, 3]);
  assert.deepStrictEqual(Array.from(res.frame), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
});

test("spread that lies only along the centre join falls back to the basis, skipping refused vectors", () => {
  // two searches on the line through e0: the join is e0 and nothing spreads elsewhere
  const D = 5;
  const pts = [0, 2, 5, 7].map((x) => [x, 0, 0, 0, 0]).flat();
  const set = setOf(new Float32Array(pts), 4, D);
  const searches = [
    { query: row(set, 0), hits: [{ index: 1 }] },
    { query: row(set, 2), hits: [{ index: 3 }] },
  ];
  const res = S.facingFrame(set, searches, { seed: 4 });
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [1, 0, 2]);
  assert.deepStrictEqual(Array.from(res.frame), [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0]);
});

test("spread left only as rounding noise after removing the axes counts as none", () => {
  // the same as above along a slanted line: float32 rounding leaves the rows a hair off the
  // line, so what is left after removing the join is noise, not an axis
  const D = 5;
  const pts = [0, 1.3, 4.1, 5.7].map((t) => [0.3 * t, 0.7 * t, 0.1 * t, 0, 0]).flat();
  const set = setOf(new Float32Array(pts), 4, D);
  const searches = [
    { query: row(set, 0), hits: [{ index: 1 }] },
    { query: row(set, 2), hits: [{ index: 3 }] },
  ];
  const res = S.facingFrame(set, searches, { seed: 4 });
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [1, 0, 2]);
  assert.ok(frameError(res.frame, D) < 1e-5);
});

test("searches with the same centre give no centre axis; the spread fills in", () => {
  const { set, qs, rs } = twoSearchFixture(12, 141);
  const one = { query: qs[0], hits: rs[0].hits };
  const res = S.facingFrame(set, [one, one], { seed: 1 });
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [0, 3, 0]);
  assert.ok(frameError(res.frame, set.dimension) < 1e-5);
});

test("signs: each row takes the shorter turn from the current frame", () => {
  const { set, searches } = twoSearchFixture(20, 151);
  const D = set.dimension;
  const free = S.facingFrame(set, searches, { seed: 5 });
  const flipped = Float32Array.from(free.frame);
  for (let d = 0; d < D; d++) flipped[D + d] = -flipped[D + d]; // row 1 turned around
  const res = S.facingFrame(set, searches, { seed: 5, current: flipped });
  for (let r = 0; r < 3; r++) assert.ok(dotRow(res.frame, r, flipped.subarray(r * D, (r + 1) * D), D) > 0, "row " + r);
  for (let d = 0; d < D; d++) {
    assert.strictEqual(res.frame[d], free.frame[d]);
    assert.strictEqual(res.frame[D + d], -free.frame[D + d]);
  }
  const back = S.facingFrame(set, searches, { seed: 5, current: free.frame });
  assert.ok(sameBits(back.frame, free.frame), "facing its own frame changes nothing");
});

test("no searches gives null at once; too many searches or too few dimensions throw", () => {
  const { set, searches } = twoSearchFixture(8, 161);
  const st = S.makeFacingFrame(set, []);
  assert.strictEqual(st.done, true);
  assert.strictEqual(st.result, null);
  assert.strictEqual(st.progress, 1);
  assert.strictEqual(st.step(), true);
  assert.strictEqual(S.facingFrame(set, []), null);
  assert.throws(() => S.makeFacingFrame(set, [...searches, ...searches, searches[0]]), RangeError);
  const flat = setOf(new Float32Array([1, 0, 0, 1]), 2, 2);
  assert.throws(() => S.makeFacingFrame(flat, [{ query: new Float32Array([1, 0]), hits: [] }]), RangeError);
});

test("malformed facing-frame arguments are refused as programming errors", () => {
  const { set, searches } = twoSearchFixture(8, 171);
  const D = set.dimension;
  assert.throws(() => S.makeFacingFrame(set, null), TypeError);
  assert.throws(() => S.makeFacingFrame(set, [{ query: new Float32Array(D - 1), hits: [] }]), TypeError);
  assert.throws(() => S.makeFacingFrame(set, [{ query: null, hits: [] }]), TypeError);
  assert.throws(() => S.makeFacingFrame(set, [{ query: searches[0].query, hits: null }]), TypeError);
  assert.throws(() => S.makeFacingFrame(set, [{ query: searches[0].query, hits: [{ index: set.count }] }]), RangeError);
  assert.throws(() => S.makeFacingFrame(set, [{ query: searches[0].query, hits: [{ index: -1 }] }]), RangeError);
  assert.throws(() => S.makeFacingFrame(set, [{ query: searches[0].query, hits: [{ index: 0.5 }] }]), RangeError);
  assert.throws(() => S.makeFacingFrame(set, searches, { scale: new Float32Array(D + 1) }), TypeError);
  assert.throws(() => S.makeFacingFrame(set, searches, { scale: new Array(D).fill(1) }), TypeError);
  assert.throws(() => S.makeFacingFrame(set, searches, { current: new Float32Array(D) }), TypeError);
  assert.throws(() => S.makeFacingFrame(set, searches, { seed: {} }), TypeError);
  assert.doesNotThrow(() => S.makeFacingFrame(set, [{ query: Array.from(searches[0].query), hits: [] }]));
});

test("a query with no hits still has a centre (its own vector)", () => {
  const { set, qs } = twoSearchFixture(10, 181);
  const res = S.facingFrame(set, [
    { query: qs[0], hits: [] },
    { query: qs[1], hits: [] },
  ]);
  const join = qs[1].map((x, d) => x - qs[0][d]);
  assert.ok(residualShare(res.frame, 1, join, set.dimension) < 1e-5);
  // two single rows: no spread about their own centres, so axes 2 and 3 are the basis
  assert.deepStrictEqual([res.fromCentres, res.fromSpread, res.fromBasis], [1, 0, 2]);
});

// ---------- the point of view ----------

// Orthonormalise rows in order, twice, in double precision (the test's own Gram-Schmidt).
function orthonormalRows(rows, D) {
  const out = [];
  for (const r of rows) {
    const w = Float64Array.from(r);
    for (let pass = 0; pass < 2; pass++) {
      for (const a of out) {
        let p = 0;
        for (let d = 0; d < D; d++) p += w[d] * a[d];
        for (let d = 0; d < D; d++) w[d] -= p * a[d];
      }
    }
    const n = Math.hypot(...w);
    out.push(w.map((x) => x / n));
  }
  return out;
}

test("with a scale, the frame is the fit of the scaled space mapped back to the loaded vectors", () => {
  const { set, qs, rs } = twoSearchFixture(24, 191);
  const D = set.dimension;
  const s = S.scaleFor(qs[0]);
  // the same searches in a space where every vector was scaled beforehand
  const scaledVectors = Float32Array.from(set.vectors, (x, i) => x * s[i % D]);
  const scaledSet = setOf(scaledVectors, set.count, D);
  const pre = S.facingFrame(
    scaledSet,
    rs.map((r, j) => ({ query: Float32Array.from(qs[j], (x, d) => x * s[d]), hits: r.hits })),
    { seed: 6 },
  );
  const res = S.facingFrame(set, facingInput(set, rs, qs), { seed: 6, scale: s });
  assert.ok(frameError(res.frame, D) < 1e-5);
  const want = orthonormalRows(
    [0, 1, 2].map((r) => Array.from({ length: D }, (_, d) => pre.frame[r * D + d] * s[d])),
    D,
  );
  for (let r = 0; r < 3; r++) {
    const cos = Math.abs(dotRow(res.frame, r, want[r], D));
    assert.ok(cos > 0.9999, "row " + r + ": |cos| " + cos);
  }
  // and the scaled frame is a different view from the unscaled one
  const plain = S.facingFrame(set, facingInput(set, rs, qs), { seed: 6 });
  assert.ok(Math.abs(dotRow(plain.frame, 0, res.frame.subarray(0, D), D)) < 0.999);
});

test("with the option off nothing is scaled: no scale and a scale of ones agree", () => {
  const { set, searches } = twoSearchFixture(16, 201);
  const ones = new Float32Array(set.dimension).fill(1);
  const a = S.facingFrame(set, searches, { seed: 8 });
  const b = S.facingFrame(set, searches, { seed: 8, scale: ones });
  assert.ok(sameBits(a.frame, b.frame));
  assert.ok(sameBits(a.centre, b.centre));
  assert.strictEqual(a.zoom, b.zoom);
});

test("a scale that flattens a mapped axis replaces it by the basis rule", () => {
  // the scale keeps only dimensions 0 and 1, so the third mapped axis has nowhere to go
  const { set, searches } = twoSearchFixture(6, 211);
  const s = new Float32Array([1, 2, 0, 0, 0, 0]);
  const res = S.facingFrame(set, searches, { seed: 1, scale: s });
  assert.ok(frameError(res.frame, 6) < 1e-5);
  assert.strictEqual(res.fromCentres + res.fromSpread + res.fromBasis, 3);
  assert.ok(res.fromBasis >= 1);
  assert.deepStrictEqual(Array.from(res.frame.subarray(12, 18)).map(Math.abs), [0, 0, 1, 0, 0, 0], "e2 replaces it");
});

// ---------- determinism and slicing ----------

function bigFixture() {
  const set = makeSet(600, 512, 221, 6);
  const qs = [0, 1, 2].map((g) => queryOf(set, g, 0.4, 30 + g));
  const rs = qs.map((q) => ranking(set, q, 20));
  return { set, qs, rs };
}

test("the stepper's result is identical whatever the budgets, and equals the blocking call", () => {
  const { set, qs, rs } = bigFixture();
  for (const n of [1, 3]) {
    const searches = facingInput(set, rs.slice(0, n), qs.slice(0, n));
    const opts = { seed: "view-seed", scale: n === 1 ? S.scaleFor(qs[0]) : null };
    const whole = S.facingFrame(set, searches, opts);
    const st = S.makeFacingFrame(set, searches, opts);
    assert.strictEqual(st.done, false);
    assert.strictEqual(st.result, null);
    let units = 0;
    let last = 0;
    while (!st.step(0)) {
      units++;
      assert.ok(st.progress >= last && st.progress < 1);
      last = st.progress;
    }
    assert.ok(units > 3, n + " searches: the work is divided (" + units + " units)");
    assert.strictEqual(st.progress, 1);
    assert.strictEqual(st.step(0), true, "a finished stepper stays finished");
    for (const key of ["frame", "centre"]) assert.ok(sameBits(st.result[key], whole[key]), key);
    for (const key of ["zoom", "fromCentres", "fromSpread", "fromBasis"]) assert.strictEqual(st.result[key], whole[key]);
    const timed = S.makeFacingFrame(set, searches, opts);
    while (!timed.step(0.05));
    assert.ok(sameBits(timed.result.frame, whole.frame), "small time budgets too");
  }
});

function runFresh(internal, fx, seed) {
  return internal.searchSets.facingFrame(fx.set, facingInput(fx.set, fx.rs, fx.qs), { seed });
}

test("two fresh runs with the same data, searches and seed give the same frame bit for bit", () => {
  const fx = bigFixture();
  fx.rs = fx.rs.slice(0, 1); // one search: all three axes depend on the seeded start
  fx.qs = fx.qs.slice(0, 1);
  const a = runFresh(freshAssembled(), fx, 42);
  const b = runFresh(freshAssembled(), fx, 42);
  const c = runFresh(loadSources(["10-math.js", "26-search-sets.js"])._internal, fx, 42);
  for (const other of [b, c]) {
    assert.ok(sameBits(a.frame, other.frame));
    assert.ok(sameBits(a.centre, other.centre));
    assert.strictEqual(a.zoom, other.zoom);
  }
  // the control: another seed starts the power iteration elsewhere, and the bits differ
  const d = runFresh(freshAssembled(), fx, 43);
  assert.ok(!sameBits(a.frame, d.frame), "a different seed gives a different frame");
  assert.ok(frameError(d.frame, fx.set.dimension) < 1e-5);
  // string seeds go through ET.math.toSeed
  assert.ok(sameBits(runFresh(ET, fx, "42").frame, runFresh(ET, fx, ET.math.toSeed("42")).frame));
});

test("the default seed is 1", () => {
  const fx = bigFixture();
  const searches = facingInput(fx.set, fx.rs.slice(0, 1), fx.qs.slice(0, 1));
  assert.ok(sameBits(S.facingFrame(fx.set, searches).frame, S.facingFrame(fx.set, searches, { seed: 1 }).frame));
});

test("the facing frame does not change its inputs", () => {
  const fx = twoSearchFixture(12, 231);
  const before = Float32Array.from(fx.set.vectors);
  const q = Float32Array.from(fx.qs[0]);
  const scale = S.scaleFor(fx.qs[0]);
  const s0 = Float32Array.from(scale);
  const current = new Float32Array(3 * 12);
  current[0] = 1;
  current[13] = 1;
  current[26] = 1;
  const c0 = Float32Array.from(current);
  S.facingFrame(fx.set, fx.searches, { scale, current });
  assert.ok(sameBits(before, fx.set.vectors) && sameBits(q, fx.qs[0]) && sameBits(s0, scale) && sameBits(c0, current));
});
