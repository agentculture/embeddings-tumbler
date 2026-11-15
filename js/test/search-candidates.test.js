"use strict";
// More candidates per search, and the reranker keeping the best of them (the owner's request
// after trying the build: "50 candidates, top 20"). ET.search's counts k, candidates and top
// (js/api/24-search.md, "Candidates and top"). Through the assembled file, for coverage.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");

const S = loadAssembled()._internal.search;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// N points of D dimensions; `named(i)` says which carry a readable label.
function makeSet(N, D, seed, named) {
  const r = rng(seed);
  const vectors = new Float32Array(N * D);
  for (let i = 0; i < vectors.length; i++) vectors[i] = r() - 0.5;
  const ids = [];
  const points = [];
  for (let i = 0; i < N; i++) {
    ids.push("p" + i);
    points.push({ id: "p" + i, label: named(i) ? "word " + i : "", group: "", metadata: {} });
  }
  return { model: "m1", dimension: D, count: N, reduction: { kind: "none" }, vectors, ids, points };
}

// Named points by distance, from the ranking's own distances (ties to the lower index).
function nearestNamed(set, ranking) {
  const order = [];
  for (let i = 0; i < set.count; i++) if (S.isNamed(set, i)) order.push(i);
  return order.sort((a, b) => ranking.distances[a] - ranking.distances[b] || a - b);
}

// A fake reranker that reverses the order: the farthest candidate scores highest.
function reverseScores(candidates) {
  return candidates.map((_, i) => i);
}

const set = makeSet(600, 24, 31, (i) => i % 2 === 0); // 300 named
const q = Float32Array.from({ length: 24 }, (_, i) => Math.sin(i * 0.9) + 0.1);

test("the constants: k 3 to 100 (8), candidates 3 to 100 (50), top 20; no pool factor", () => {
  assert.strictEqual(S.MIN_K, 3);
  assert.strictEqual(S.MAX_K, 100);
  assert.strictEqual(S.DEFAULT_K, 8);
  assert.strictEqual(S.DEFAULT_CANDIDATES, 50);
  assert.strictEqual(S.MAX_CANDIDATES, 100);
  assert.strictEqual(S.DEFAULT_TOP, 20);
  assert.strictEqual(S.POOL_FACTOR, undefined);
});

test("clamps: below 3, above 100, not a number, top above candidates", () => {
  assert.strictEqual(S.clampK(2), 3);
  assert.strictEqual(S.clampK(100), 100);
  assert.strictEqual(S.clampK(250), 100);
  assert.strictEqual(S.clampCandidates(undefined), 50);
  assert.strictEqual(S.clampCandidates("80"), 50);
  assert.strictEqual(S.clampCandidates(-4), 3);
  assert.strictEqual(S.clampCandidates(0), 3);
  assert.strictEqual(S.clampCandidates(101), 100);
  assert.strictEqual(S.clampCandidates(64.4), 64);
  assert.strictEqual(S.clampTop(undefined, undefined), 20);
  assert.strictEqual(S.clampTop(undefined, 10), 10, "the default top is cut to the candidates");
  assert.strictEqual(S.clampTop(30, 10), 10, "top above candidates is cut to candidates");
  assert.strictEqual(S.clampTop(1, 50), 3);
  assert.strictEqual(S.clampTop(Infinity, 50), 20);
  assert.strictEqual(S.clampTop(100, 100), 100);
  assert.strictEqual(S.clampTop(100, 500), 100);
});

test("the ranking states its counts; k nearest are the hits, the candidates the pool", () => {
  const res = S.rank(set, q, { k: 100, candidates: 60, top: 70 });
  const named = nearestNamed(set, res);
  assert.strictEqual(res.k, 100);
  assert.strictEqual(res.candidates, 60);
  assert.strictEqual(res.top, 60, "top is clamped to the candidates");
  assert.strictEqual(res.hits.length, 100, "with no reranker, k 100 gives 100 results");
  assert.deepStrictEqual(res.hits.map((h) => h.index), named.slice(0, 100));
  assert.deepStrictEqual(res.pool.map((h) => h.index), named.slice(0, 60));
  assert.strictEqual(res.radius, res.hits.at(-1).distance);
  // defaults
  const d = S.rank(set, q);
  assert.deepStrictEqual([d.k, d.candidates, d.top, d.hits.length, d.pool.length], [8, 50, 20, 8, 50]);
});

test("50 candidates, top 20, a reranker that reverses: the 20 last of the 50 nearest", () => {
  const ranking = S.rank(set, q, { candidates: 50, top: 20 });
  const named = nearestNamed(set, ranking);
  const sent = ranking.pool.map((h) => h.index);
  assert.strictEqual(sent.length, 50, "the reranker receives exactly 50 candidates");
  assert.deepStrictEqual(sent, named.slice(0, 50));
  const re = S.rerankOrder(ranking, reverseScores(ranking.pool));
  assert.strictEqual(re.ok, true);
  assert.strictEqual(re.hits.length, 20);
  assert.deepStrictEqual(re.hits.map((h) => h.index), named.slice(30, 50).reverse());
  assert.deepStrictEqual(re.hits.map((h) => h.embeddingRank), Array.from({ length: 20 }, (_, i) => 50 - i));
  assert.deepStrictEqual(re.hits.map((h) => h.moved), Array.from({ length: 20 }, (_, i) => 50 - i - (i + 1)));
  // the radius is the farthest kept result, here the 50th nearest
  assert.strictEqual(re.radius, Math.max(...re.hits.map((h) => h.distance)));
  assert.strictEqual(re.radius, ranking.distances[named[49]]);
  assert.strictEqual(re.near, ranking.distances[named[30]]);
});

test("100 candidates: the reranker receives 100; top 3 keeps 3", () => {
  const ranking = S.rank(set, q, { candidates: 100, top: 3 });
  assert.strictEqual(ranking.pool.length, 100);
  const re = S.rerankOrder(ranking, reverseScores(ranking.pool));
  assert.strictEqual(re.hits.length, 3);
  assert.deepStrictEqual(re.hits.map((h) => h.embeddingRank), [100, 99, 98]);
  // a score list for another number of candidates is refused
  assert.strictEqual(S.rerankOrder(ranking, reverseScores(new Array(50))).code, "rerank-malformed");
});

test("fewer named points than asked: every number is cut to what there is", () => {
  const few = makeSet(200, 12, 5, (i) => i % 25 === 0); // 8 named
  const fq = Float32Array.from({ length: 12 }, (_, i) => i - 5);
  const res = S.rank(few, fq, { k: 100, candidates: 100, top: 40 });
  assert.strictEqual(res.named, 8);
  assert.strictEqual(res.hits.length, 8);
  assert.strictEqual(res.pool.length, 8);
  assert.deepStrictEqual([res.k, res.candidates, res.top], [100, 100, 40], "the asked counts are kept");
  const re = S.rerankOrder(res, reverseScores(res.pool));
  assert.strictEqual(re.hits.length, 8);
  // no named point at all: every point is a candidate
  const none = makeSet(70, 12, 6, () => false);
  const all = S.rank(none, fq, { k: 100, candidates: 100 });
  assert.strictEqual(all.hits.length, 70);
  assert.strictEqual(all.pool.length, 70);
});

test("a ranking made by hand without top keeps k after reranking", () => {
  const ranking = S.rank(set, q, { k: 5, candidates: 12 });
  const legacy = { ...ranking };
  delete legacy.top;
  assert.strictEqual(S.rerankOrder(legacy, reverseScores(ranking.pool)).hits.length, 5);
});

test("with a scale, the pool of 100 carries plain ranks and stepping changes nothing", () => {
  const scale = Float32Array.from(q, (x) => Math.abs(x));
  const res = S.rank(set, q, { k: 100, candidates: 100, scale });
  assert.strictEqual(res.pool.length, 100);
  assert.strictEqual(res.hits.length, 100);
  for (const h of res.pool) assert.ok(h.plainRank >= 1);
  const st = S.makeRank(set, q, { k: 100, candidates: 100, scale });
  while (!st.step(0));
  assert.deepStrictEqual(st.result.pool, res.pool);
  assert.deepStrictEqual(st.result.hits, res.hits);
});
