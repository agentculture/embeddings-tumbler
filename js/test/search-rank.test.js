"use strict";
// ET.search (js/src/24-search.js): ranking, checks on a query, word search.
const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const { loadAssembled } = require("./helpers/load.js");

// Through the assembled file, so that line coverage is counted (the CI report is taken on it).
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

function gauss(r) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

function makeSet(N, D, seed, extra) {
  const r = rng(seed);
  const vectors = new Float32Array(N * D);
  for (let i = 0; i < vectors.length; i++) vectors[i] = gauss(r) * (1 + (i % D) / D);
  const ids = [];
  const points = [];
  for (let i = 0; i < N; i++) {
    ids.push("p" + i);
    points.push({ id: "p" + i, label: "", group: "", metadata: {} });
  }
  return Object.assign(
    { model: "m1", dimension: D, count: N, reduction: { kind: "none" }, vectors, ids, points },
    extra,
  );
}

// Independent brute force: straight from the definition, no shared code.
function brute(set, q, scale) {
  const D = set.dimension;
  const out = [];
  for (let i = 0; i < set.count; i++) {
    let dot = 0, a = 0, b = 0;
    for (let d = 0; d < D; d++) {
      const s = scale ? scale[d] : 1;
      const x = set.vectors[i * D + d] * s;
      const y = q[d] * s;
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    const c = a === 0 || b === 0 ? 0 : dot / Math.sqrt(a * b);
    out.push({ i, d: 1 - Math.max(-1, Math.min(1, c)) });
  }
  out.sort((x, y) => x.d - y.d || x.i - y.i);
  return out;
}

for (const D of [768, 1024]) {
  test("ranking equals brute force at " + D + " dimensions, and ignores everything but the data", () => {
    const set = makeSet(300, D, D);
    const q = Float32Array.from({ length: D }, (_, i) => Math.sin(i * 1.7) + 0.2);
    const res = S.rank(set, q, { k: 12 });
    const b = brute(set, q);
    assert.deepStrictEqual(res.hits.map((h) => h.index), b.slice(0, 12).map((x) => x.i));
    // the reranker's pool is the 50 nearest by default (DEFAULT_CANDIDATES)
    assert.deepStrictEqual(res.pool.map((h) => h.index), b.slice(0, 50).map((x) => x.i));
    res.hits.forEach((h, n) => {
      assert.ok(Math.abs(h.distance - b[n].d) < 1e-12);
      assert.strictEqual(h.embeddingRank, n + 1);
      assert.strictEqual(h.plainRank, n + 1);
      assert.strictEqual(h.rank, n + 1);
      assert.strictEqual(h.moved, 0);
      assert.strictEqual(h.score, null);
      assert.strictEqual(h.id, "p" + h.index);
      assert.strictEqual(h.similarity, 1 - h.distance);
    });
    assert.strictEqual(res.hits[0].gap, 0);
    assert.strictEqual(res.near, res.hits[0].distance);
    assert.strictEqual(res.radius, res.hits[11].distance);
    assert.strictEqual(res.distances.length, 300);
    assert.strictEqual(res.plainDistances, null);
    assert.strictEqual(res.measure, "cosine");
    assert.strictEqual(res.scaled, false);
    assert.strictEqual(res.count, 300);
    // set and query are not changed; a second run gives the same bytes
    const again = S.rank(set, q, { k: 12 });
    assert.deepStrictEqual(again.hits, res.hits);
  });
}

test("a scale ranks in the scaled measure and reports the plain one", () => {
  const set = makeSet(200, 64, 5);
  const q = Float32Array.from({ length: 64 }, (_, i) => Math.cos(i));
  const scale = Float32Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 3 : i % 7 === 0 ? 0 : 0.5));
  const res = S.rank(set, q, { k: 5, scale });
  const bs = brute(set, q, scale);
  const bp = brute(set, q, null);
  assert.deepStrictEqual(res.hits.map((h) => h.index), bs.slice(0, 5).map((x) => x.i));
  assert.strictEqual(res.scaled, true);
  assert.ok(res.plainDistances instanceof Float64Array);
  for (const h of res.pool) {
    const plainPos = bp.findIndex((x) => x.i === h.index);
    assert.strictEqual(h.plainRank, plainPos + 1);
    assert.ok(Math.abs(h.plainDistance - bp[plainPos].d) < 1e-12);
    assert.ok(Math.abs(h.distance - bs.find((x) => x.i === h.index).d) < 1e-12);
  }
});

test("zero rows sit at distance 1, ties go to the lower index, k is clamped and the pool is capped", () => {
  const set = makeSet(10, 4, 1);
  set.vectors.fill(0, 0, 4); // point 0 is a zero row
  set.vectors.set([1, 0, 0, 0], 4); // points 1 and 2 are the same
  set.vectors.set([1, 0, 0, 0], 8);
  const res = S.rank(set, Float32Array.of(1, 0, 0, 0), { k: 3 });
  assert.deepStrictEqual(res.hits.map((h) => h.index), [1, 2, res.hits[2].index]);
  assert.strictEqual(res.distances[0], 1);
  assert.strictEqual(res.hits[0].distance, 0);
  assert.strictEqual(res.pool.length, 10); // 50 candidates asked, 10 points in the set
  assert.strictEqual(S.rank(set, Float32Array.of(0, 0, 0, 0), { k: 3 }).hits.length, 3);
  assert.strictEqual(S.rank(set, Float32Array.of(1, 0, 0, 0), { k: 1 }).k, 3);
  assert.strictEqual(S.rank(set, Float32Array.of(1, 0, 0, 0)).hits.length, 8);
  // a zero scaled row
  const z = S.rank(set, Float32Array.of(1, 1, 0, 0), { scale: Float32Array.of(0, 0, 1, 1) });
  assert.ok(z.distances.every((d) => d === 1));
});

test("a set with no points gives an empty ranking", () => {
  const set = makeSet(0, 4, 1);
  const res = S.rank(set, Float32Array.of(1, 0, 0, 0));
  assert.deepStrictEqual(res.hits, []);
  assert.deepStrictEqual(res.pool, []);
  assert.strictEqual(res.near, null);
  assert.strictEqual(res.radius, null);
  assert.strictEqual(res.distances.length, 0);
});

test("bad arguments to makeRank throw", () => {
  const set = makeSet(5, 4, 1);
  assert.throws(() => S.makeRank(set, [1, 0, 0, 0]), TypeError);
  assert.throws(() => S.makeRank(set, new Float32Array(3)), TypeError);
  assert.throws(() => S.makeRank(set, new Float32Array(4), { scale: new Float32Array(3) }), TypeError);
  assert.throws(() => S.makeRank(set, new Float32Array(4), { scale: [1, 1, 1, 1] }), TypeError);
});

test("stepped, in any budgets, gives the same bytes as one go; progress and done behave", () => {
  const set = makeSet(3000, 512, 9);
  const q = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i));
  const scale = Float32Array.from({ length: 512 }, (_, i) => 0.1 + (i % 3));
  for (const opts of [{ k: 9 }, { k: 9, scale }]) {
    const whole = S.rank(set, q, opts);
    for (const budget of [0, 0.05, 1]) {
      const st = S.makeRank(set, q, opts);
      assert.strictEqual(st.done, false);
      assert.strictEqual(st.result, null);
      let calls = 0;
      let last = 0;
      while (!st.step(budget)) {
        calls++;
        assert.ok(st.progress >= last && st.progress < 1);
        last = st.progress;
      }
      if (budget === 0) assert.ok(calls > 1, "work was divided");
      assert.strictEqual(st.progress, 1);
      assert.strictEqual(st.step(), true);
      assert.deepStrictEqual(st.result, whole);
      assert.ok(Buffer.from(st.result.distances.buffer).equals(Buffer.from(whole.distances.buffer)));
    }
  }
});

test("a unit of the scan stays short on 10,000 points of 1,024 dimensions", (t) => {
  const N = 10000;
  const D = 1024;
  const set = makeSet(N, D, 3);
  const q = Float32Array.from({ length: D }, (_, i) => Math.cos(i));
  const run = (opts) => {
    const st = S.makeRank(set, q, opts);
    let longest = 0;
    let units = 0;
    while (!st.done) {
      const t0 = performance.now();
      st.step(0);
      longest = Math.max(longest, performance.now() - t0);
      units++;
    }
    return { longest, units };
  };
  const plain = run({});
  const scaled = run({ scale: new Float32Array(D).fill(0.5) });
  console.log(
    "search scan, 10000 x 1024: plain longest unit %s ms in %d units; scaled %s ms in %d units; load %s",
    plain.longest.toFixed(2), plain.units, scaled.longest.toFixed(2), scaled.units,
    os.loadavg().map((x) => x.toFixed(1)).join(" "),
  );
  assert.ok(plain.units > 5 && scaled.units > 5);
  // The target is 4 ms; the check leaves headroom and is skipped on a busy machine.
  if (os.loadavg()[0] > os.cpus().length / 2) return t.skip("machine is loaded");
  assert.ok(plain.longest < 20 && scaled.longest < 20, "unit too long");
});

test("clampK, format and the constants", () => {
  assert.strictEqual(S.clampK(undefined), 8);
  assert.strictEqual(S.clampK(NaN), 8);
  assert.strictEqual(S.clampK("5"), 8);
  assert.strictEqual(S.clampK(1), 3);
  assert.strictEqual(S.clampK(99), 99);
  assert.strictEqual(S.clampK(101), 100);
  assert.strictEqual(S.clampK(7.6), 8);
  assert.strictEqual(S.MEASURE_TEXT, "cosine distance (1 minus cosine similarity)");
  assert.ok(Object.isFrozen(S.MESSAGES));
  assert.strictEqual(S.format("point-unknown", { id: "x" }), 'No point with id "x" is in the view.');
  assert.strictEqual(S.format("no-data"), "There is no data to search yet.");
  assert.match(S.format("query-zero", {}), /all zeros/);
  assert.match(S.format("query-dimension-mismatch", { found: 3 }), /dimension 3 but .*\{expected\}/);
  assert.throws(() => S.format("nope"), RangeError);
});

test("checkSameSpace", () => {
  const set = makeSet(3, 4, 1);
  assert.deepStrictEqual(S.checkSameSpace(set), { ok: true });
  assert.deepStrictEqual(S.checkSameSpace({ ...set, reduction: undefined }), { ok: true });
  const r = S.checkSameSpace({ ...set, reduction: { kind: "rotation" } });
  assert.strictEqual(r.code, "reduction-not-searchable");
  assert.strictEqual(r.kind, "rotation");
  assert.match(r.message, /reduction "rotation"/);
  assert.strictEqual(S.checkSameSpace(null).code, "no-data");
  assert.strictEqual(S.checkSameSpace(makeSet(0, 4, 1)).code, "no-data");
  assert.strictEqual(S.checkSameSpace({ ...set, vectors: new Float32Array(2) }).code, "no-data");
});

test("checkQuery refuses in order, with plain messages naming both sides", () => {
  const set = makeSet(3, 4, 1);
  const ok = { model: "m1", vector: [1, 2, 3, 4] };
  const code = (q, s = set) => S.checkQuery(s, q).code;
  assert.strictEqual(code(ok, null), "no-data");
  assert.strictEqual(code(ok, { ...set, reduction: { kind: "top-k" } }), "reduction-not-searchable");
  assert.strictEqual(code({ vector: ok.vector }), "query-model-missing");
  assert.strictEqual(code({ model: "", vector: ok.vector }), "query-model-missing");
  assert.strictEqual(code(null), "query-model-missing");
  const mm = S.checkQuery(set, { model: "other", vector: ok.vector });
  assert.strictEqual(mm.code, "query-model-mismatch");
  assert.ok(mm.message.includes('"other"') && mm.message.includes('"m1"'));
  assert.match(S.checkQuery(set, { vector: 1 }).message, /not the data's model|data's model "m1"/);
  for (const bad of [undefined, "1234", 5, new ArrayBuffer(16), new BigInt64Array(4), [1, 2, 3, "4"], [1, 2, 3, null]]) {
    assert.strictEqual(code({ model: "m1", vector: bad }), "query-not-vector");
  }
  const dm = S.checkQuery(set, { model: "m1", vector: [1, 2, 3] });
  assert.strictEqual(dm.code, "query-dimension-mismatch");
  assert.ok(dm.message.includes("dimension 3") && dm.message.includes("dimension 4"));
  const nf = S.checkQuery(set, { model: "m1", vector: [1, NaN, 3, 4] });
  assert.strictEqual(nf.code, "query-non-finite");
  assert.match(nf.message, /position 1/);
  assert.strictEqual(code({ model: "m1", vector: [1, 2, Infinity, 4] }), "query-non-finite");
  assert.strictEqual(code({ model: "m1", vector: [1, 2, 1e300, 4] }), "query-non-finite");
  assert.strictEqual(code({ model: "m1", vector: [0, 0, 0, 0] }), "query-zero");
});

test("checkQuery accepts arrays and typed arrays and returns a copy", () => {
  const set = makeSet(3, 4, 1);
  for (const v of [[1, 2, 3, 4], Float32Array.of(1, 2, 3, 4), Float64Array.of(1, 2, 3, 4)]) {
    const c = S.checkQuery(set, { model: "m1", vector: v });
    assert.strictEqual(c.ok, true);
    assert.ok(c.vector instanceof Float32Array);
    assert.deepStrictEqual(Array.from(c.vector), [1, 2, 3, 4]);
    v[0] = 99;
    assert.strictEqual(c.vector[0], 1);
  }
});

test("rerankOrder reorders the pool, refuses malformed scores, leaves the ranking alone", () => {
  const set = makeSet(60, 8, 4);
  const q = Float32Array.from({ length: 8 }, (_, i) => i - 3);
  const ranking = S.rank(set, q, { k: 3, candidates: 9, top: 3 });
  assert.strictEqual(ranking.pool.length, 9);
  const before = JSON.stringify(ranking.hits);
  const scores = ranking.pool.map((_, i) => (i === 7 ? 5 : i === 4 ? 5 : 0));
  const re = S.rerankOrder(ranking, scores);
  assert.strictEqual(re.ok, true);
  assert.deepStrictEqual(re.hits.map((h) => h.embeddingRank), [5, 8, 1]);
  assert.deepStrictEqual(re.hits.map((h) => h.rank), [1, 2, 3]);
  assert.deepStrictEqual(re.hits.map((h) => h.moved), [4, 6, -2]);
  assert.deepStrictEqual(re.hits.map((h) => h.score), [5, 5, 0]);
  assert.strictEqual(re.near, Math.min(...re.hits.map((h) => h.distance)));
  assert.strictEqual(re.radius, Math.max(...re.hits.map((h) => h.distance)));
  assert.strictEqual(re.hits[0].gap, re.hits[0].distance - re.near);
  assert.strictEqual(re.hits.find((h) => h.gap === 0).distance, re.near);
  assert.strictEqual(JSON.stringify(ranking.hits), before);
  assert.strictEqual(ranking.hits[0].score, null);
  for (const bad of [null, "x", [], scores.slice(1), scores.map((s, i) => (i ? s : NaN)), scores.map((s, i) => (i ? s : "1")), scores.map((s, i) => (i ? s : Infinity))]) {
    const r = S.rerankOrder(ranking, bad);
    assert.strictEqual(r.code, "rerank-malformed");
    assert.strictEqual(r.ok, false);
  }
  assert.strictEqual(S.rerankOrder(ranking, new Float64Array(9)).ok, true);
  const tiny = S.rank(makeSet(2, 4, 2), Float32Array.of(1, 2, 3, 4), { k: 8 });
  const t = S.rerankOrder(tiny, [0, 1]);
  assert.strictEqual(t.hits.length, 2);
  const none = S.rerankOrder(S.rank(makeSet(0, 4, 2), Float32Array.of(1, 2, 3, 4)), []);
  assert.deepStrictEqual([none.hits, none.near, none.radius], [[], null, null]);
});

test("pointQuery and pointText", () => {
  const set = makeSet(4, 3, 2);
  set.points[1].label = "Alpha";
  set.points[2].label = "Beta";
  set.points[2].metadata = { text: "the longer beta text" };
  set.points[3].metadata = { text: "" };
  const pq = S.pointQuery(set, "p2");
  assert.strictEqual(pq.ok, true);
  assert.strictEqual(pq.index, 2);
  assert.deepStrictEqual(Array.from(pq.vector), Array.from(set.vectors.slice(6, 9)));
  assert.strictEqual(pq.vector.buffer.byteLength, 12);
  assert.strictEqual(S.rank(set, pq.vector).hits[0].distance, 0);
  assert.strictEqual(S.pointQuery(set, "zz").code, "point-unknown");
  assert.match(S.pointQuery(set, "zz").message, /"zz"/);
  assert.strictEqual(S.pointQuery(makeSet(0, 3, 1), "a").code, "no-data");
  // a rotated set still allows search among loaded points
  assert.strictEqual(S.pointQuery({ ...set, reduction: { kind: "rotation" } }, "p1").ok, true);
  assert.strictEqual(S.pointText(set, 2), "the longer beta text");
  assert.strictEqual(S.pointText(set, 1), "Alpha");
  assert.strictEqual(S.pointText(set, 0), "p0");
  assert.strictEqual(S.pointText(set, 3), "p3");
  const bare = { ids: ["a"], points: [{ id: "a" }] };
  assert.strictEqual(S.pointText(bare, 0), "a");
  assert.strictEqual(S.pointText({ ids: ["b"], points: [null] }, 0), "b");
});

test("tokens", () => {
  assert.deepStrictEqual(S.tokens("Red, red  GREEN-blue 42 été!"), ["red", "green", "blue", "42", "été"]);
  assert.deepStrictEqual(S.tokens("  ?! "), []);
  assert.deepStrictEqual(S.tokens(null), []);
  assert.deepStrictEqual(S.tokens(5), []);
});

function wordSet() {
  const set = makeSet(6, 3, 1);
  set.vectors.set([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 3, 0, 0, 0, 0, 0]);
  const names = [
    ["Red apple", ""],
    ["Green apple", "a crisp fruit"],
    ["Blue sky", ""],
    ["Yellow banana", "apple of my eye"],
    ["Apple", ""],
    ["Zero point", ""],
  ];
  names.forEach(([label, text], i) => {
    set.points[i].label = label;
    if (text) set.points[i].metadata = { text };
  });
  return set;
}

const near = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-6);

test("word search: a whole phrase is placed from its own vector", () => {
  const set = wordSet();
  const r = S.wordQuery(set, "  APPLE of my eye ");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.whole, true);
  assert.deepStrictEqual(r.used, [{ word: "apple of my eye", how: "whole", count: 1 }]);
  assert.deepStrictEqual(r.unmatched, []);
  assert.deepStrictEqual(r.words, ["apple", "of", "my", "eye"]);
  assert.deepStrictEqual(Array.from(r.vector), [1, 1, 0]);
  const two = S.wordQuery(set, "apple");
  assert.strictEqual(two.whole, true); // point 4's label is exactly "Apple"
  assert.deepStrictEqual(Array.from(two.vector), [3, 0, 0]);
  assert.strictEqual(two.used[0].count, 1);
});

test("word search: one equal share per word; prefix only when nothing matches exactly", () => {
  const set = wordSet();
  const r = S.wordQuery(set, "red apples sky nothing xy");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.whole, false);
  assert.deepStrictEqual(
    r.used.map((u) => [u.word, u.how, u.count]),
    [["red", "exact", 1], ["sky", "exact", 1]],
  );
  assert.deepStrictEqual(r.unmatched, ["apples", "nothing", "xy"]);
  // mean of red (1,0,0) and sky (0,0,1)
  assert.ok(near(Array.from(r.vector), [0.5, 0, 0.5]));
  const apple = S.wordQuery(set, "apple fruit");
  assert.deepStrictEqual(apple.used.map((u) => [u.word, u.how, u.count]), [["apple", "exact", 4], ["fruit", "exact", 1]]);
  assert.ok(near(Array.from(apple.vector), [1.25 / 2, (0.5 + 1) / 2, 0]));
  const pre = S.wordQuery(set, "yell bana");
  assert.deepStrictEqual(pre.used.map((u) => [u.how, u.count]), [["prefix", 1], ["prefix", 1]]);
  assert.deepStrictEqual(pre.unmatched, []);
  const mixed = S.wordQuery(set, "yellow crisper crisp");
  assert.deepStrictEqual(mixed.unmatched, ["crisper"]);
});

test("word search refusals", () => {
  const set = wordSet();
  const e = S.wordQuery(set, " ... ");
  assert.deepStrictEqual([e.ok, e.code, e.words, e.unmatched], [false, "empty-query", [], []]);
  const n = S.wordQuery(set, "plum, kiwi");
  assert.strictEqual(n.code, "words-none");
  assert.deepStrictEqual(n.unmatched, ["plum", "kiwi"]);
  assert.match(n.message, /: plum, kiwi\.$/);
  const nd = S.wordQuery(makeSet(0, 3, 1), "red");
  assert.strictEqual(nd.code, "no-data");
  assert.deepStrictEqual(nd.words, ["red"]);
  assert.strictEqual(S.wordQuery(null, "red").code, "no-data");
  const z = S.wordQuery(set, "zero nothing");
  assert.strictEqual(z.code, "query-zero");
  assert.deepStrictEqual(z.unmatched, ["nothing"]);
  // a rotated set still allows word search
  assert.strictEqual(S.wordQuery({ ...set, reduction: { kind: "rotation" } }, "sky").ok, true);
});

test("word search is the same stepped as in one go, and a set's words are cached", () => {
  const N = 4000;
  const set = makeSet(N, 64, 8);
  for (let i = 0; i < N; i++) {
    set.points[i].label = "item " + (i % 50) + " group" + (i % 7);
    set.points[i].metadata = { text: "some longer text about thing" + (i % 13) + " and item" };
  }
  const whole = S.wordQuery(set, "item 3 thing4 grou");
  assert.strictEqual(whole.ok, true);
  const st = S.makeWordQuery(set, "item 3 thing4 grou");
  assert.strictEqual(st.done, false);
  let calls = 0;
  while (!st.step(0)) calls++;
  assert.ok(calls >= 1);
  assert.deepStrictEqual(st.result, whole);
  const second = S.makeWordQuery(set, "item 3 thing4 grou");
  second.step(0); // cached: the index is not rebuilt
  assert.deepStrictEqual(runAll(second), whole);
  assert.ok(S.rank(set, whole.vector).hits.length === 8);
});

function runAll(st) {
  st.step();
  return st.result;
}

test("the stepper falls back to Date.now where there is no performance clock", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "performance");
  Object.defineProperty(globalThis, "performance", { value: undefined, configurable: true, writable: true });
  try {
    const set = makeSet(50, 8, 2);
    const q = Float32Array.from({ length: 8 }, (_, i) => i + 1);
    const st = S.makeRank(set, q);
    while (!st.step(0)) assert.ok(st.progress < 1);
    assert.strictEqual(st.result.hits.length, 8);
  } finally {
    Object.defineProperty(globalThis, "performance", saved);
  }
});
