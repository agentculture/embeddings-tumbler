"use strict";
// Four searches of 100 results: the pair reports become a stepper (they cost about 50 ms in one
// call at 10,000 x 1,024), and the facing frame keeps short units. Results are unchanged by the
// slicing. Through the assembled file, for coverage.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");

const ET = loadAssembled()._internal;
const S = ET.search;
const SS = ET.searchSets;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSet(N, D, seed) {
  const r = rng(seed);
  const vectors = new Float32Array(N * D);
  for (let i = 0; i < vectors.length; i++) vectors[i] = r() - 0.5;
  const ids = [];
  const points = [];
  for (let i = 0; i < N; i++) {
    ids.push("p" + i);
    points.push({ id: "p" + i, label: i % 3 === 0 ? "w" + i : "", group: "", metadata: {} });
  }
  return { model: "m", dimension: D, count: N, reduction: { kind: "none" }, vectors, ids, points };
}

const D = 64;
const set = makeSet(1500, D, 3);
const searches = [1, 2, 3, 4].map((s) => {
  const r = rng(40 + s);
  const query = Float32Array.from({ length: D }, () => r() - 0.5);
  return { query, ranking: S.rank(set, query, { k: 100 }) };
});
const rankings = searches.map((s) => s.ranking);

test("makePairReports gives the same reports stepped in small slices as in one call", () => {
  assert.strictEqual(rankings[0].hits.length, 100);
  const whole = SS.pairReports(set, rankings);
  assert.strictEqual(whole.length, 6);
  const st = SS.makePairReports(set, rankings);
  assert.strictEqual(st.done, false);
  let steps = 0;
  while (!st.step(0)) {
    steps++;
    assert.ok(st.progress > 0 && st.progress < 1);
  }
  assert.ok(steps > 3, "a unit ends many times over 6 pairs of 100 x 100 results, got " + steps);
  assert.strictEqual(st.progress, 1);
  assert.deepStrictEqual(st.result, whole);
  assert.strictEqual(st.step(0), true, "a finished stepper stays done");
  for (const p of whole) {
    assert.ok(p.closest === null || (p.closest.a !== p.closest.b && p.closest.distance >= 0));
    assert.strictEqual(p.common, p.commonIndices.length);
  }
});

test("makePairReports with one or no search is done after one step, with no pair", () => {
  for (const list of [[], [rankings[0]]]) {
    const st = SS.makePairReports(set, list);
    assert.strictEqual(st.step(0), true);
    assert.deepStrictEqual(st.result, []);
  }
});

test("makePairReports checks at once: not an array, too many, a bad index", () => {
  assert.throws(() => SS.makePairReports(set, null), TypeError);
  assert.throws(() => SS.makePairReports(set, [...rankings, rankings[0]]), RangeError);
  const bad = { ...rankings[1], hits: [{ index: 99999 }] };
  assert.throws(() => SS.makePairReports(set, [rankings[0], bad]), RangeError);
});

test("the facing frame of four searches of 100 is the same stepped as in one call", () => {
  const list = searches.map((s) => ({ query: s.query, hits: s.ranking.hits }));
  const whole = SS.facingFrame(set, list, { seed: 7 });
  const st = SS.makeFacingFrame(set, list, { seed: 7 });
  let steps = 0;
  while (!st.step(0)) steps++;
  assert.ok(steps > 4, "the rows' setup and the reach pause too, got " + steps);
  assert.deepStrictEqual(Array.from(st.result.frame), Array.from(whole.frame));
  assert.deepStrictEqual(Array.from(st.result.centre), Array.from(whole.centre));
  assert.strictEqual(st.result.zoom, whole.zoom);
  // with a scale too
  const scale = SS.scaleFor(searches[0].query);
  const a = SS.facingFrame(set, list, { seed: 7, scale });
  const b = SS.makeFacingFrame(set, list, { seed: 7, scale });
  while (!b.step(0));
  assert.deepStrictEqual(Array.from(b.result.frame), Array.from(a.frame));
});
