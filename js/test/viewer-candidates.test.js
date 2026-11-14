"use strict";
// The viewer's candidates and top (the owner's request: "50 candidates, top 20";
// docs/search-interface.md, "Candidates and top"). Through the handle and info().search on the
// fake DOM, with the assembled file.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const ET = api._internal;

// A held frame, so nothing but the searches matters.
api.registerMode({
  id: "stillcand",
  title: "still",
  summary: "A still frame for tests.",
  create() {
    let set = null;
    const state = (t) => {
      const D = set.dimension;
      const frame = new Float32Array(3 * D);
      frame[0] = 1;
      frame[D + 1] = 1;
      frame[2 * D + 2] = 1;
      return {
        t,
        frame,
        centre: new Float32Array(D),
        draw: { zoom: 1, wires: 0, dim: 1, trails: 0.1, fog: 0, twinkle: 0 },
        wires: null,
        status: "still",
        focus: null,
      };
    };
    return {
      enter(s) {
        set = s;
      },
      prepare: () => ({ done: true, progress: 1, result: null, step: () => true }),
      isReady: () => true,
      stateAt: state,
      step: (dt) => state(dt),
      status: () => "still",
      dataChanged(s) {
        set = s;
        return { work: null, restart: false };
      },
      mark() {},
      describe: () => ({ id: "stillcand", projection: "linear: held", seed: 1, varianceShare: null }),
      leave() {},
    };
  },
});

const tick = () => new Promise((r) => setImmediate(r));

async function until(dom, done, bound = 400) {
  for (let i = 0; i < bound && !done(); i++) {
    await tick();
    dom.frames(1);
  }
  await tick();
  assert.ok(done(), "condition not reached");
}

async function settle(dom, promise) {
  let out;
  let finished = false;
  promise.then((r) => {
    out = r;
    finished = true;
  });
  await until(dom, () => finished);
  return out;
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// 600 points, a third named (labelEvery 3): 200 named points.
function setup(mountOpts, setOpts) {
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { seed: 3, mode: "stillcand", searchPanel: false, ...mountOpts });
  const v = h._viewer;
  h.update(makeSet({ n: 600, d: 16, ...setOpts }));
  dom.frames(2);
  return { dom, h, v };
}

// The named points nearest the query of search j, by the ranking's own distances.
function nearestNamed(v, j) {
  const q = v.search.shown[j];
  const r = ET.search.rank(v.set, q.query, { k: 3 });
  const order = [];
  for (let i = 0; i < v.set.count; i++) if (ET.search.isNamed(v.set, i)) order.push(i);
  return order.sort((a, b) => r.distances[a] - r.distances[b] || a - b);
}

function reversingReranker(seen) {
  return function (query, candidates) {
    seen.push(candidates.length);
    return { scores: candidates.map((_, i) => i), model: "test/reverse" };
  };
}

test("the settings start at k 8, candidates 50, top 20; mount options set them, clamped", () => {
  const a = setup();
  assert.deepStrictEqual(
    [a.h.searchSettings().k, a.h.searchSettings().candidates, a.h.searchSettings().top],
    [8, 50, 20],
  );
  a.h.destroy();
  const b = setup({ searchK: 100, searchCandidates: 30, searchTop: 40 });
  assert.deepStrictEqual([b.h.info().search.settings.k, b.h.info().search.settings.candidates, b.h.info().search.settings.top], [100, 30, 30]);
  b.h.destroy();
  const c = setup({ searchK: 1, searchCandidates: 1000, searchTop: 2 });
  assert.deepStrictEqual([c.h.searchSettings().k, c.h.searchSettings().candidates, c.h.searchSettings().top], [3, 100, 3]);
  c.h.destroy();
});

test("setSearchSettings: each number clamped, top cut to candidates, junk ignored", async () => {
  const { h, dom } = setup();
  await settle(dom, h.setSearchSettings({ k: 250, candidates: 2, top: 90 }));
  assert.deepStrictEqual([h.searchSettings().k, h.searchSettings().candidates, h.searchSettings().top], [100, 3, 3]);
  await settle(dom, h.setSearchSettings({ candidates: 101, top: 64 }));
  assert.deepStrictEqual([h.searchSettings().candidates, h.searchSettings().top], [100, 64]);
  await settle(dom, h.setSearchSettings({ candidates: 40 }));
  assert.strictEqual(h.searchSettings().top, 40, "lowering candidates cuts top");
  await settle(dom, h.setSearchSettings({ k: "x", candidates: null, top: false }));
  await settle(dom, h.setSearchSettings({ k: " ", candidates: true }));
  assert.deepStrictEqual([h.searchSettings().k, h.searchSettings().candidates, h.searchSettings().top], [100, 40, 40]);
  await settle(dom, h.setSearchSettings({ k: "12" }));
  assert.strictEqual(h.searchSettings().k, 12, "a range input gives a string");
  await settle(dom, h.setSearchSettings({ k: 100 }));
  assert.deepStrictEqual([h.searchSettings().k, h.searchSettings().candidates, h.searchSettings().top], [100, 40, 40]);
  h.destroy();
});

test("with no reranker, k 100 gives the 100 nearest named points and states every count", async () => {
  const { h, v, dom } = setup();
  await settle(dom, h.setSearches(["word3"]));
  const r = await settle(dom, h.setSearchSettings({ k: 100 }));
  assert.strictEqual(r.ok, true);
  const q = h.info().search.searches[0];
  assert.strictEqual(q.results.length, 100);
  assert.deepStrictEqual(q.results.map((x) => x.index), nearestNamed(v, 0).slice(0, 100));
  assert.strictEqual(q.k, 100);
  assert.strictEqual(q.candidates, 50);
  assert.strictEqual(q.top, 20);
  assert.strictEqual(q.available, 200);
  assert.strictEqual(q.sent, 0, "nothing was sent to a reranker");
  assert.strictEqual(q.counts, null);
  assert.strictEqual(q.radius, q.results.at(-1).distance);
  h.destroy();
});

test("50 candidates, top 20 with a reversing reranker: the 20 last of the 50 nearest, radius the farthest kept", async () => {
  const seen = [];
  const { h, v, dom } = setup({ rerank: reversingReranker(seen) });
  await settle(dom, h.setSearches(["word3", "word9"]));
  const r = await settle(dom, h.setSearchSettings({ rerank: true }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, [50, 50], "the reranker received exactly 50 candidates per search");
  const s = h.info().search;
  assert.deepStrictEqual([s.settings.candidates, s.settings.top], [50, 20]);
  for (const [j, q] of s.searches.entries()) {
    assert.strictEqual(q.reranker, "test/reverse");
    assert.strictEqual(q.results.length, 20);
    assert.deepStrictEqual(q.results.map((x) => x.index), nearestNamed(v, j).slice(30, 50).reverse());
    assert.deepStrictEqual(q.results.map((x) => x.embeddingRank), Array.from({ length: 20 }, (_, i) => 50 - i));
    assert.strictEqual(q.results[0].moved, 49);
    assert.strictEqual(q.radius, Math.max(...q.results.map((x) => x.distance)));
    assert.deepStrictEqual([q.candidates, q.top, q.sent, q.counts], [50, 20, 50, null]);
    // the lit radius follows the kept results
    let inside = 0;
    for (const d of ET.search.rank(v.set, v.search.shown[j].query).distances) if (d <= q.radius) inside++;
    assert.strictEqual(q.insideCount, inside);
  }
  assert.strictEqual(s.pairs.length, 1, "the pair report was worked out in the run");
  // 100 candidates: the reranker receives 100
  seen.length = 0;
  await settle(dom, h.setSearchSettings({ candidates: 100, top: 3 }));
  assert.deepStrictEqual(seen, [100, 100]);
  assert.strictEqual(h.info().search.searches[0].results.length, 3);
  assert.deepStrictEqual(h.info().search.searches[0].results.map((x) => x.embeddingRank), [100, 99, 98]);
  h.destroy();
});

test("fewer named points than asked: the counts are cut and the search says so", async () => {
  const seen = [];
  // 60 points, labelEvery 10: 6 named
  const { h, dom } = setup({ rerank: reversingReranker(seen) }, { n: 60, labelEvery: 10 });
  await settle(dom, h.setSearches(["word10"]));
  await settle(dom, h.setSearchSettings({ k: 30 }));
  let q = h.info().search.searches[0];
  assert.strictEqual(q.results.length, 6);
  assert.strictEqual(q.counts, "Only 6 named points can be results, so 6 are shown, not 30.");
  await settle(dom, h.setSearchSettings({ rerank: true }));
  q = h.info().search.searches[0];
  assert.deepStrictEqual(seen, [6]);
  assert.strictEqual(q.sent, 6);
  assert.strictEqual(q.results.length, 6);
  assert.strictEqual(q.counts, "Only 6 named points can be results, so the reranker was given 6 candidates, not 50.");
  h.destroy();
  // no named point at all: every point is a candidate
  const none = setup({}, { n: 40, labelFor: () => "" });
  await settle(none.dom, none.h.setSearches([{ point: none.v.set.ids[0] }]));
  await settle(none.dom, none.h.setSearchSettings({ k: 100 }));
  q = none.h.info().search.searches[0];
  assert.strictEqual(q.results.length, 40);
  assert.strictEqual(q.counts, "Only 40 points can be results, so 40 are shown, not 100.");
  none.h.destroy();
});

test("a late reranker keeps the embedding order with its note; a failing one too; latest wins", async () => {
  let behave = "late";
  let d = null;
  const rerank = (query, candidates) => {
    if (behave === "throw") throw new Error("secret");
    if (behave === "late") {
      d = deferred();
      return d.promise;
    }
    return { scores: candidates.map((_, i) => i), model: "test/reverse" };
  };
  const { h, dom } = setup({ rerank, searchTimeoutMs: 1000 });
  await settle(dom, h.setSearches(["word3"]));
  const plain = h.info().search.searches[0].results.map((x) => x.id);
  const p = h.setSearchSettings({ rerank: true, candidates: 100, top: 30 });
  await until(dom, () => d !== null);
  dom.advance(1001);
  dom.runTimers();
  const r = await settle(dom, p);
  const q = r.search.searches[0];
  assert.strictEqual(q.note, "The reranker did not answer within 1 seconds; the results stay in embedding order.");
  assert.strictEqual(q.reranker, null);
  assert.deepStrictEqual(q.results.map((x) => x.id), plain, "the k nearest, as with no reranker");
  assert.strictEqual(q.sent, 100, "what was sent is still stated");
  d.resolve({ scores: new Array(100).fill(0), model: "late" });
  await tick();
  assert.strictEqual(h.info().search.searches[0].reranker, null, "a late answer changes nothing");
  // failing
  behave = "throw";
  await settle(dom, h.setSearchSettings({ top: 10 }));
  assert.strictEqual(h.info().search.searches[0].note, "The reranker failed to answer; the results stay in embedding order.");
  assert.strictEqual(h.info().search.searches[0].results.length, 8);
  // latest wins: a slow change is superseded by a newer one
  behave = "late";
  d = null;
  const first = h.setSearchSettings({ top: 12 });
  await until(dom, () => d !== null);
  const slow = d;
  behave = "ok";
  const second = h.setSearchSettings({ top: 15 });
  const [a, b] = await Promise.all([settle(dom, first), settle(dom, second)]);
  assert.strictEqual(a.code, "superseded");
  assert.strictEqual(b.ok, true);
  slow.resolve({ scores: new Array(100).fill(0), model: "late" });
  await tick();
  const s = h.info().search;
  assert.strictEqual(s.settings.top, 15);
  assert.strictEqual(s.searches[0].reranker, "test/reverse");
  assert.strictEqual(s.searches[0].results.length, 15);
  h.destroy();
});

test("four searches of 100 results: the pair reports are worked out in slices, never in one long call", async () => {
  const { h, v, dom } = setup({ searchK: 100 }, { n: 1200 });
  const r = await settle(dom, h.setSearches(["word3", "word99", "word300", "word600"]));
  assert.strictEqual(r.ok, true);
  const s = h.info().search;
  assert.strictEqual(s.searches.length, 4);
  for (const q of s.searches) assert.strictEqual(q.results.length, 100);
  assert.strictEqual(s.pairs.length, 6);
  const want = ET.searchSets.pairReports(v.set, v.search.shown.map((q) => q.view));
  assert.deepStrictEqual(
    s.pairs.map((p) => [p.shared, p.common]),
    want.map((p) => [p.shared, p.common]),
  );
  h.destroy();
});
