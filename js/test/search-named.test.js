"use strict";
// Results of a search are named points (docs/search-interface.md, "Corrected after the first
// browser run"; js/api/24-search.md, "Named points"). The k results are the k nearest NAMED
// points; the result radius is the farthest of them; every loaded point at least that near is
// inside the search, named or not. A set with no named point ranks every point.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { loadAssembled, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet: makeViewerSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const ET = api._internal;
const S = ET.search;
const sample = require(path.join(ROOT, "js", "sample", "sample-data.js"));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// N random points; `named(i, r)` says whether point i gets a readable label.
function makeSet(N, D, seed, named) {
  const r = rng(seed);
  const vectors = new Float32Array(N * D);
  for (let i = 0; i < vectors.length; i++) vectors[i] = r() * 2 - 1;
  const ids = [];
  const points = [];
  for (let i = 0; i < N; i++) {
    ids.push("p" + i);
    points.push({ id: "p" + i, label: named(i, r) ? "word " + i : "", group: "", metadata: {} });
  }
  return { model: "m1", dimension: D, count: N, reduction: { kind: "none" }, vectors, ids, points };
}

// The sample set the standalone page shows, in the loader's in-memory form.
function sampleSet() {
  const data = sample.generate();
  return {
    model: data.model,
    dimension: data.dimension,
    count: data.count,
    reduction: { kind: "none" },
    vectors: data.vectors,
    ids: data.points.map((p) => p.id),
    points: data.points,
  };
}

// Independent brute force over named points only, straight from the definition.
function bruteNamed(set, q, scale) {
  const D = set.dimension;
  const all = [];
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
    all.push({ i, d: 1 - Math.max(-1, Math.min(1, c)) });
  }
  const label = (i) => set.points[i].label;
  const named = all.filter((x) => label(x.i) !== "" && label(x.i) !== set.ids[x.i]);
  named.sort((x, y) => x.d - y.d || x.i - y.i);
  return { all, named };
}

test("isNamed: readable text that is not just the id; pointText agrees", () => {
  const set = {
    ids: ["a", "b", "c", "d", "e", "f", "g", "h"],
    points: [
      { id: "a", label: "harbour" }, // a label
      { id: "b", label: "b" }, // the label is the id (a labels-only set)
      { id: "c", label: "" }, // an empty label
      { id: "d", label: "   " }, // only white space
      { id: "e", label: "", metadata: { text: "a longer passage" } }, // text in metadata
      { id: "f", label: "f", metadata: { text: "f" } }, // both just the id
      { id: "g", label: "g", metadata: { text: 7 } }, // metadata text that is not a string
      null, // no record at all
    ],
  };
  const want = [true, false, false, false, true, false, false, false];
  set.ids.forEach((id, i) => {
    assert.strictEqual(S.isNamed(set, i), want[i], "isNamed(" + id + ")");
    assert.strictEqual(S.pointText(set, i) !== id, want[i], "pointText(" + id + ") is not the id");
  });
  assert.strictEqual(S.pointText(set, 3), "d", "white space alone is not text");
  assert.strictEqual(S.isNamed({ ids: ["x"] }, 0), false, "a set without point records");
});

test("tide harbor on the sample set: eight named results, tide and harbor first, hundreds inside", () => {
  const set = sampleSet();
  const w = S.wordQuery(set, "tide harbor");
  assert.strictEqual(w.ok, true);
  const res = S.rank(set, w.vector, { k: 8 });
  const labels = res.hits.map((h) => set.points[h.index].label);
  // The list measured on this build (cosine distance on the centred sample vectors).
  console.log("# tide harbor results:", labels.join(", "));
  assert.strictEqual(res.hits.length, 8);
  assert.deepStrictEqual(labels.slice(0, 2), ["tide", "harbor"]);
  for (const h of res.hits) {
    assert.ok(S.isNamed(set, h.index), h.id + " is named");
    assert.strictEqual(set.points[h.index].group, "ocean", h.id + " is in the ocean group");
  }
  let named = 0;
  for (let i = 0; i < set.count; i++) {
    if (S.isNamed(set, i)) named++;
    // the stage's labelled points and the named points agree on the sample set
    assert.strictEqual(S.isNamed(set, i), ET.modes.isLabelled(set.points[i]));
  }
  assert.strictEqual(res.named, named);
  assert.strictEqual(named, 290);
  // Every point at least as near as the last result is inside, named or not.
  const lit = ET.searchSets.litValues([res], set.count, "even");
  let inside = 0;
  for (const d of res.distances) if (d <= res.radius) inside++;
  console.log("# tide harbor inside the radius:", inside, "radius", res.radius);
  assert.strictEqual(lit.insideCounts[0], inside);
  assert.ok(inside >= 100 && inside < 1000, "inside count in the hundreds, got " + inside);
});

for (const D of [768, 1024]) {
  test("ranking over named points equals brute force at " + D + " dimensions (a third named)", () => {
    const set = makeSet(450, D, D + 5, (i, r) => r() < 1 / 3);
    const q = Float32Array.from({ length: D }, (_, i) => Math.sin(i * 1.3) + 0.1);
    const res = S.rank(set, q, { k: 10 });
    const b = bruteNamed(set, q);
    assert.ok(b.named.length > 100 && b.named.length < 200);
    assert.strictEqual(res.named, b.named.length);
    assert.deepStrictEqual(res.hits.map((h) => h.index), b.named.slice(0, 10).map((x) => x.i));
    assert.deepStrictEqual(res.pool.map((h) => h.index), b.named.slice(0, 50).map((x) => x.i));
    res.pool.forEach((h, n) => {
      assert.ok(Math.abs(h.distance - b.named[n].d) < 1e-12);
      assert.strictEqual(h.embeddingRank, n + 1);
      assert.strictEqual(h.plainRank, n + 1);
    });
    assert.strictEqual(res.radius, res.hits.at(-1).distance);
    // distances are still every point's
    b.all.forEach((x) => assert.ok(Math.abs(res.distances[x.i] - x.d) < 1e-12));
    // stepped in small slices: identical, bit for bit
    const st = S.makeRank(set, q, { k: 10 });
    while (!st.step(0));
    assert.deepStrictEqual(st.result.hits, res.hits);
    assert.deepStrictEqual(Array.from(st.result.distances), Array.from(res.distances));
  });
}

test("with a scale, ranks among named points: embeddingRank and plainRank count named points only", () => {
  const D = 32;
  const set = makeSet(300, D, 77, (i) => i % 3 === 1);
  const q = Float32Array.from({ length: D }, (_, i) => Math.cos(i * 0.7));
  const scale = Float32Array.from(q, (x) => Math.abs(x));
  const res = S.rank(set, q, { k: 6, scale });
  const scaled = bruteNamed(set, q, scale).named;
  const plain = bruteNamed(set, q).named;
  assert.deepStrictEqual(res.pool.map((h) => h.index), scaled.slice(0, 50).map((x) => x.i));
  for (const h of res.pool) {
    assert.strictEqual(h.plainRank, 1 + plain.findIndex((x) => x.i === h.index));
    assert.ok(Math.abs(h.plainDistance - plain.find((x) => x.i === h.index).d) < 1e-12);
  }
  const st = S.makeRank(set, q, { k: 6, scale });
  while (!st.step(0));
  assert.deepStrictEqual(st.result.pool, res.pool);
});

test("no named point: every point is a candidate, as before; fewer named than k: all of them", () => {
  const D = 24;
  const none = makeSet(60, D, 3, () => false);
  const q = Float32Array.from({ length: D }, (_, i) => (i % 5) - 2);
  const all = S.rank(none, q, { k: 8 });
  assert.strictEqual(all.named, 0);
  assert.strictEqual(all.hits.length, 8);
  assert.strictEqual(all.pool.length, 50);
  assert.strictEqual(S.pointText(none, all.hits[0].index), all.hits[0].id, "results show ids");
  // labels-only: every label is the id
  const labelsOnly = { ...none, points: none.points.map((p) => ({ ...p, label: p.id })) };
  assert.deepStrictEqual(
    S.rank(labelsOnly, q, { k: 8 }).hits.map((h) => h.index),
    all.hits.map((h) => h.index),
  );
  // five named points, k = 8: the five, nearest first; inside counts every point
  const five = makeSet(60, D, 3, (i) => [2, 11, 23, 40, 57].includes(i));
  const res = S.rank(five, q, { k: 8 });
  assert.strictEqual(res.named, 5);
  assert.strictEqual(res.k, 8);
  assert.deepStrictEqual(res.hits.map((h) => h.index).sort((a, b) => a - b), [2, 11, 23, 40, 57]);
  assert.strictEqual(res.pool.length, 5);
  let inside = 0;
  for (const d of res.distances) if (d <= res.radius) inside++;
  assert.ok(inside >= 5);
  assert.strictEqual(ET.searchSets.litValues([res], five.count, "even").insideCounts[0], inside);
  // a reranker reorders the named pool and never brings in an unnamed point
  const rr = S.rerankOrder(res, [1, 5, 2, 4, 3]);
  assert.strictEqual(rr.ok, true);
  assert.strictEqual(rr.hits.length, 5);
  for (const h of rr.hits) assert.ok(S.isNamed(five, h.index));
});

test("a picked point: named, it is its own first result at distance 0; unnamed, it is only the query", () => {
  const D = 16;
  const set = makeSet(90, D, 9, (i) => i % 3 === 0);
  const own = S.pointQuery(set, "p6");
  const r1 = S.rank(set, own.vector);
  assert.strictEqual(r1.hits[0].index, 6);
  assert.ok(r1.hits[0].distance < 1e-12, "distance 0 up to rounding");
  const other = S.pointQuery(set, "p7");
  const r2 = S.rank(set, other.vector);
  assert.ok(r2.distances[7] < 1e-12);
  for (const h of r2.hits) assert.ok(h.index % 3 === 0, "only named points are results");
  assert.ok(r2.hits[0].distance > 0);
});

// ---------- through the viewer (fake DOM, assembled file) ----------

const tick = () => new Promise((r) => setImmediate(r));

test("through the viewer: results are named points and insideCount matches the lit counts", async () => {
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { seed: 3 });
  h.update(makeViewerSet({ n: 150, d: 16 })); // every third point labelled
  dom.frames(2);
  const v = h._viewer;
  let out = null;
  h.setSearches([{ point: v.set.ids[4] }, "word9 word30"]).then((r) => {
    out = r;
  });
  for (let i = 0; i < 300 && !out; i++) {
    await tick();
    dom.frames(1);
  }
  assert.ok(out?.ok, "the searches finished");
  const s = h.info().search;
  assert.strictEqual(s.searches.length, 2);
  for (const q of s.searches) {
    assert.strictEqual(q.results.length, 8);
    for (const r of q.results) assert.ok(S.isNamed(v.set, r.index), r.id + " is named");
    assert.notStrictEqual(q.results[0].text, q.results[0].id);
  }
  assert.ok(!s.searches[0].results.some((r) => r.index === 4), "the unnamed picked point is not a result");
  // insideCount is every point (named or not) at least as near as the last result
  const query = Float32Array.from(v.set.vectors.subarray(4 * 16, 5 * 16));
  const ranking = S.rank(v.set, query, { k: 8 });
  const lit = ET.searchSets.litValues([ranking], v.set.count, "even");
  assert.strictEqual(s.searches[0].insideCount, lit.insideCounts[0]);
  let unnamedInside = 0;
  for (let i = 0; i < v.set.count; i++) {
    if (ranking.distances[i] <= ranking.radius && !S.isNamed(v.set, i)) unnamedInside++;
  }
  assert.ok(unnamedInside > 0, "unnamed points are inside the radius and lit");
  h.destroy();
});
