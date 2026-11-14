"use strict";
// The viewer's search API (task t8 of the search plan; docs/search-interface.md, "Viewer (t8)"):
// mount options, the handle's search methods, the host's embed and rerank callbacks, latest
// wins, re-runs after an append, info().search. Everything is asserted through info().search
// and through what reached the renderer's setLit and the modes' face / searchChanged, never
// through pixels. The DOM and GPU are the fakes in helpers/; the core is the assembled file.
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const ET = api._internal;

// ---------- stub modes, registered through the public registerMode ----------

const calls = { face: [], searchChanged: [] };

function stubDefinition(id, extra) {
  return {
    id,
    title: id,
    summary: "A still frame for tests.",
    create() {
      let set = null;
      let onlyResults = false;
      const frame = () => {
        const D = set.dimension;
        const f = new Float32Array(3 * D);
        f[0] = 1;
        f[D + 1] = 1;
        f[2 * D + 2] = 1;
        return f;
      };
      const state = (t) => {
        const draw = { zoom: 1, wires: 0, dim: 1, trails: 0.1, fog: 0, twinkle: 0 };
        if (onlyResults) draw.unlitGain = 0;
        return { t, frame: frame(), centre: new Float32Array(set.dimension), draw, wires: null, status: id, focus: null };
      };
      const inst = {
        facing: null,
        enter(s) {
          set = s;
        },
        prepare: () => ({ done: true, progress: 1, result: null, step: () => true }),
        isReady: () => true,
        stateAt: state,
        step: (dt) => state(dt),
        status: () => id,
        dataChanged(s) {
          set = s;
          return { work: null, restart: false };
        },
        mark() {},
        describe: () => ({ id, projection: "linear: held", seed: 1, varianceShare: null, facing: inst.facing, onlyResults }),
        leave() {},
      };
      if (extra.face) {
        inst.face = function (target, t, options) {
          calls.face.push({ mode: id, target, t, options, args: arguments.length });
          inst.facing = target ? { at: t, until: t + 6 } : null;
          return true;
        };
      }
      if (extra.searchChanged) {
        inst.searchChanged = function (search, t) {
          calls.searchChanged.push({ mode: id, search, t });
          onlyResults = !!search?.onlyResults;
          return extra.searchWork ? { work: extra.searchWork() } : undefined;
        };
      }
      return inst;
    },
  };
}

api.registerMode(stubDefinition("stubface", { face: true }));
api.registerMode(stubDefinition("stubplain", {}));
api.registerMode(stubDefinition("stubfit", { searchChanged: true }));
// The click rule belongs to the mode called "focus". The real Focus mode (t7) registers it
// in its own file; until then a stub stands in, and the click test works with either.
if (!ET.modes.get("focus")) api.registerMode(stubDefinition("focus", { searchChanged: true }));

function resetCalls() {
  calls.face.length = 0;
  calls.searchChanged.length = 0;
}

// ---------- helpers ----------

function setup(mountOpts, setOpts) {
  resetCalls();
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { seed: 3, mode: "stubface", ...mountOpts });
  const v = h._viewer;
  const lit = [];
  const draws = [];
  if (setOpts !== null) h.update(makeSet({ n: 120, d: 16, ...setOpts }));
  if (v.renderer) {
    const realSetLit = v.renderer.setLit;
    v.renderer.setLit = function (l, s) {
      lit.push({ lit: l ? Float32Array.from(l) : null, shared: s ? Uint8Array.from(s) : null });
      return realSetLit.apply(this, arguments);
    };
    const realDraw = v.renderer.draw;
    v.renderer.draw = function (state) {
      draws.push(state);
      return realDraw.apply(this, arguments);
    };
  }
  dom.frames(2);
  return { dom, el, h, v, lit, draws };
}

const tick = () => new Promise((r) => setImmediate(r));

// Frames and microtasks until `done()` or a bound.
async function until(dom, done, bound = 200) {
  for (let i = 0; i < bound && !done(); i++) {
    await tick();
    dom.frames(1);
  }
  await tick();
  assert.ok(done(), "condition not reached");
}

// Run a promise to its end, pumping frames (rankings run in the frame budget).
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

// A promise the test resolves or rejects by hand.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function rowOf(set, i) {
  return Float32Array.from(set.vectors.subarray(i * set.dimension, (i + 1) * set.dimension));
}

function idsOf(search, j = 0) {
  return search.searches[j].results.map((r) => r.id);
}

// The ids lit by search j by the documented rule: distance at most the radius.
function expectedLitIndices(v, query, k) {
  const ranking = ET.search.rank(v.set, query, { k });
  const out = [];
  for (let i = 0; i < v.set.count; i++) if (ranking.distances[i] <= ranking.radius) out.push(i);
  return out;
}

function litIndices(arr) {
  const out = [];
  arr.forEach((x, i) => {
    if (x > ET.searchSets.LIT_THRESHOLD) out.push(i);
  });
  return out;
}

// ---------- criterion 1: the handle does what the panel does; info() is enough ----------

test("with no search, info().search is the empty shape, nothing reaches setLit and no draw key is added", () => {
  const { h, lit, draws, dom } = setup();
  dom.frames(3);
  const s = h.info().search;
  assert.strictEqual(s.active, false);
  assert.strictEqual(s.waiting, false);
  assert.strictEqual(s.stale, false);
  assert.strictEqual(s.staleBy, 0);
  assert.strictEqual(s.code, null);
  assert.strictEqual(s.message, null);
  assert.strictEqual(s.measure, ET.search.MEASURE_TEXT);
  assert.deepStrictEqual(s.settings, { k: 8, candidates: 50, top: 20, lit: "even", distances: false, rerank: false, pointOfView: null, onlyResults: false });
  assert.deepStrictEqual(s.embedder, { available: false });
  assert.deepStrictEqual(s.reranker, { available: false, offered: false });
  assert.deepStrictEqual(s.sameSpace, { ok: true, kind: "none" });
  assert.deepStrictEqual([s.litCount, s.sharedCount, s.facing, s.faceable], [0, 0, false, true]);
  assert.deepStrictEqual([s.searches, s.pairs, s.unmatched], [[], [], []]);
  assert.strictEqual(lit.length, 0);
  assert.ok(draws.length > 0);
  for (const d of draws) assert.ok(!("filter" in d), "no filter key without a search");
  assert.deepStrictEqual(h.searchSettings(), s.settings);
  h.destroy();
});

test("a search from a point: results are the exact ranking and the lit set follows the radius", async () => {
  const { h, v, dom, lit } = setup();
  // Point 3 is named (every third point carries a label), so it is its own first result.
  const query = rowOf(v.set, 3);
  const r = await settle(dom, h.setSearches([{ point: v.set.ids[3] }]));
  assert.strictEqual(r.ok, true);
  const s = h.info().search;
  assert.strictEqual(s.active, true);
  assert.strictEqual(s.waiting, false);
  const q = s.searches[0];
  assert.deepStrictEqual([q.letter, q.kind, q.text, q.point, q.model, q.sentTo], ["A", "point", v.set.ids[3], v.set.ids[3], "test/model", "nowhere"]);
  const expected = ET.search.rank(v.set, query, { k: 8 });
  assert.deepStrictEqual(idsOf(s), expected.hits.map((x) => x.id));
  assert.deepStrictEqual(q.results.map((x) => x.distance), expected.hits.map((x) => x.distance));
  assert.strictEqual(q.results[0].id, v.set.ids[3], "the point is its own nearest result");
  assert.strictEqual(q.radius, expected.radius);
  assert.strictEqual(q.k, 8);
  assert.strictEqual(q.results[0].text, ET.search.pointText(v.set, 3));
  // The lit set: what info() says, what the renderer got, and the documented rule agree.
  const want = expectedLitIndices(v, query, 8);
  assert.strictEqual(s.litCount, want.length);
  assert.strictEqual(q.insideCount, want.length);
  const last = lit.at(-1);
  assert.strictEqual(last.lit.length, v.set.count);
  assert.deepStrictEqual(litIndices(last.lit), want);
  assert.deepStrictEqual(r.search.searches[0].results, q.results);
  h.destroy();
});

test("a search by vector is checked first; a refused one changes nothing", async () => {
  const { h, v, dom, lit } = setup();
  const vec = Array.from(rowOf(v.set, 10));
  const bad = await settle(dom, h.setSearches([{ vector: vec, model: "other/model" }]));
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, "query-model-mismatch");
  assert.match(bad.message, /other\/model/);
  assert.strictEqual(h.info().search.active, false);
  assert.strictEqual(h.info().search.code, "query-model-mismatch");
  assert.strictEqual(lit.length, 0);
  const ok = await settle(dom, h.setSearches([{ vector: vec, model: "test/model", label: "my vector" }]));
  assert.strictEqual(ok.ok, true);
  const q = h.info().search.searches[0];
  assert.deepStrictEqual([q.kind, q.text, q.model, q.sentTo], ["vector", "my vector", "test/model", "nowhere"]);
  assert.strictEqual(h.info().search.code, null);
  const plain = await settle(dom, h.setSearches([{ vector: vec, model: "test/model" }]));
  assert.strictEqual(plain.search.searches[0].text, "vector");
  h.destroy();
});

test("typed text goes to the embed callback with the text and nothing else", async () => {
  const seen = [];
  let v0 = null;
  const embed = function () {
    seen.push(Array.from(arguments));
    return { vector: rowOf(v0.set, 6), model: "test/model", queryForm: "query" };
  };
  const { h, v, dom } = setup({ embed });
  v0 = v;
  const r = await settle(dom, h.setSearches(["  harbour lights  "]));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(seen, [["  harbour lights  "]]);
  const q = h.info().search.searches[0];
  assert.deepStrictEqual([q.kind, q.text, q.model, q.queryForm, q.sentTo], ["embedded", "  harbour lights  ", "test/model", "query", "embedder"]);
  assert.strictEqual(q.results[0].index, 6);
  assert.deepStrictEqual(h.info().search.embedder, { available: true });
  h.destroy();
});

test("several searches get letters in order, pairs are reported with ids", async () => {
  const { h, v, dom } = setup();
  const r = await settle(dom, h.setSearches([{ point: v.set.ids[0] }, { point: v.set.ids[3] }, { point: v.set.ids[1] }]));
  assert.strictEqual(r.ok, true);
  const s = h.info().search;
  assert.deepStrictEqual(s.searches.map((q) => q.letter), ["A", "B", "C"]);
  assert.deepStrictEqual(s.pairs.map((p) => p.a + p.b), ["AB", "AC", "BC"]);
  const rankings = s.searches.map((q, j) => ET.search.rank(v.set, rowOf(v.set, [0, 3, 1][j]), { k: 8 }));
  const pairs = ET.searchSets.pairReports(v.set, rankings);
  pairs.forEach((p, j) => {
    assert.strictEqual(s.pairs[j].shared, p.shared);
    assert.strictEqual(s.pairs[j].common, p.common);
    assert.deepStrictEqual(s.pairs[j].commonIds, p.commonIndices.map((i) => v.set.ids[i]));
    assert.deepStrictEqual(s.pairs[j].closest, p.closest ? { a: v.set.ids[p.closest.a], b: v.set.ids[p.closest.b], distance: p.closest.distance } : null);
  });
  const lv = ET.searchSets.litValues(rankings, v.set.count, "even");
  assert.strictEqual(s.sharedCount, lv.sharedCount);
  assert.deepStrictEqual(s.searches.map((q) => q.insideCount), lv.insideCounts);
  h.destroy();
});

test("words are matched among the loaded points with no embed callback; unmatched words are named", async () => {
  const { h, dom } = setup();
  const r = await settle(dom, h.setSearches(["word3 zzzz", "qqqq"]));
  assert.strictEqual(r.ok, true);
  const s = h.info().search;
  assert.strictEqual(s.searches.length, 1, "the line that matched nothing is left out");
  const q = s.searches[0];
  assert.deepStrictEqual([q.letter, q.kind, q.sentTo, q.model], ["A", "words", "nowhere", "test/model"]);
  assert.deepStrictEqual(q.words.used, [{ word: "word3", how: "exact", count: 1 }]);
  assert.deepStrictEqual(q.words.unmatched, ["zzzz"]);
  assert.deepStrictEqual(s.unmatched, ["zzzz", "qqqq"]);
  const none = await settle(dom, h.setSearches(["qqqq", "zzzz"]));
  assert.strictEqual(none.code, "words-none");
  assert.match(none.message, /qqqq, zzzz/);
  assert.strictEqual(h.info().search.searches[0].text, "word3 zzzz", "nothing changed");
  h.destroy();
});

test("via: embed with no callback is no-embedder; on a reduced set auto falls back to words with a note", async () => {
  const { h, dom } = setup();
  const r = await settle(dom, h.setSearches([{ text: "word3", via: "embed" }]));
  assert.strictEqual(r.code, "no-embedder");
  assert.strictEqual(r.message, "Cannot embed the query: the host supplied no embed callback. Search among the loaded points still works.");
  h.destroy();
  let called = 0;
  const embed = () => {
    called++;
    return { vector: [], model: "test/model" };
  };
  const red = setup({ embed }, { reduction: { kind: "rotation", source_dimension: 16, directions_kept: 16, variance_dropped: 0 } });
  assert.deepStrictEqual(red.h.info().search.sameSpace, { ok: false, kind: "rotation" });
  const auto = await settle(red.dom, red.h.setSearches(["word3"]));
  assert.strictEqual(auto.ok, true);
  assert.strictEqual(auto.search.searches[0].kind, "words");
  assert.match(auto.search.searches[0].note, /reduction "rotation"/);
  const forced = await settle(red.dom, red.h.setSearches([{ text: "word3", via: "embed" }]));
  assert.strictEqual(forced.code, "reduction-not-searchable");
  const words = await settle(red.dom, red.h.setSearches([{ text: "word6", via: "words" }]));
  assert.strictEqual(words.search.searches[0].note, null);
  assert.strictEqual(called, 0, "the embedder is never asked for a set it cannot be compared with");
  red.h.destroy();
});

test("refusals of the request itself: too many, malformed, empty, no data", async () => {
  const { h, dom } = setup();
  const errors = [];
  h._viewer.options.onError = (e) => errors.push(e.code);
  assert.deepStrictEqual(await h.setSearches(["a", "b", "c", "d", "e"]), {
    ok: false,
    code: "too-many-searches",
    message: "At most 4 searches at once; 5 were given.",
  });
  assert.strictEqual((await h.setSearches("word3")).code, "bad-search");
  assert.strictEqual((await settle(dom, h.setSearches([42]))).code, "bad-search");
  assert.strictEqual((await settle(dom, h.setSearches([{ nothing: 1 }]))).code, "bad-search");
  const hostile = {};
  Object.defineProperty(hostile, "text", {
    get() {
      throw new Error("no");
    },
  });
  assert.strictEqual((await settle(dom, h.setSearches([hostile]))).code, "bad-search");
  assert.strictEqual((await settle(dom, h.setSearches(["!!!"]))).code, "empty-query");
  assert.strictEqual((await settle(dom, h.setSearches([{ point: "nope" }]))).code, "point-unknown");
  assert.deepStrictEqual(errors, ["bad-search", "bad-search", "bad-search", "empty-query", "point-unknown"]);
  h.destroy();
  const empty = setup({}, null);
  assert.strictEqual((await settle(empty.dom, empty.h.setSearches(["anything"]))).code, "no-data");
  empty.h.destroy();
});

test("setSearches([]) clears; clearSearches eases the filter out, then clears setLit, ends the swing", async () => {
  const { h, v, dom, lit, draws } = setup();
  assert.strictEqual(h.clearSearches(), false, "nothing to clear");
  await settle(dom, h.setSearches([{ point: v.set.ids[2] }]));
  dom.frames(200);
  assert.strictEqual(draws.at(-1).filter, 1, "the filter eased in to 1");
  assert.ok(draws.some((d) => d.filter > 0 && d.filter < 1), "eased, not jumped");
  const r = await h.setSearches([]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.search.active, false);
  assert.strictEqual(calls.face.at(-1).target, null, "the swing in progress is ended");
  const before = lit.length;
  dom.frames(2);
  assert.strictEqual(lit.length, before, "the lit values stay while the filter eases out");
  dom.frames(200);
  assert.strictEqual(lit.at(-1).lit, null, "setLit(null) once the filter reached 0");
  assert.ok(!("filter" in draws.at(-1)));
  assert.strictEqual(h.clearSearches(), false);
  h.destroy();
});

// ---------- criterion 2: answers out of order, late, failing, malformed ----------

test("answers out of order: the latest search wins and the earlier answer is dropped", async () => {
  const pending = [];
  const embed = (text) => {
    const d = deferred();
    pending.push({ text, d });
    return d.promise;
  };
  const { h, v, dom, lit } = setup({ embed });
  const first = h.setSearches(["first query"]);
  const second = h.setSearches(["second query"]);
  assert.strictEqual(h.info().search.waiting, true);
  pending[1].d.resolve({ vector: rowOf(v.set, 21), model: "test/model" });
  const r2 = await settle(dom, second);
  assert.strictEqual(r2.ok, true);
  assert.deepStrictEqual(await first, { ok: false, code: "superseded", message: "A newer search replaced this one." });
  const litAfter = lit.length;
  pending[0].d.resolve({ vector: rowOf(v.set, 50), model: "test/model" });
  await tick();
  dom.frames(5);
  await tick();
  const s = h.info().search;
  assert.strictEqual(s.searches[0].text, "second query");
  assert.strictEqual(s.searches[0].results[0].index, 21);
  assert.strictEqual(lit.length, litAfter, "the late answer reached nothing");
  assert.deepStrictEqual(litIndices(lit.at(-1).lit), expectedLitIndices(v, rowOf(v.set, 21), 8));
  h.destroy();
});

test("a search replaced while its ranking scan is running is dropped cleanly", async () => {
  const { h, v, dom, lit } = setup({ prepareBudgetMs: 1 }, { n: 20000, d: 256, labelEvery: 1000 });
  // Named points are every 1,000th; a search from a named point has it as its first result.
  const a = h.setSearches([{ point: v.set.ids[1000] }]);
  dom.frames(1);
  const job = v.search.work[0]?.job;
  assert.ok(job, "the ranking is queued as a stepper");
  assert.ok(!job.done, "one frame's budget does not finish a 20,000-point scan");
  const b = h.setSearches([{ point: v.set.ids[2000] }]);
  assert.strictEqual((await a).code, "superseded");
  const rb = await settle(dom, b);
  assert.strictEqual(rb.ok, true);
  assert.strictEqual(rb.search.searches[0].results[0].index, 2000);
  assert.strictEqual(lit.length, 1, "only the latest search reached the renderer");
  h.destroy();
});

test("a late answer: embed-timeout, the earlier results stay, the answer after it is dropped", async () => {
  let d = null;
  const embed = () => {
    d = deferred();
    return d.promise;
  };
  const { h, v, dom, lit } = setup({ embed, searchTimeoutMs: 2000 });
  await settle(dom, h.setSearches([{ point: v.set.ids[9] }]));
  const before = h.info().search.searches;
  const litBefore = lit.length;
  const p = h.setSearches(["slow"]);
  dom.advance(1999);
  dom.runTimers();
  await tick();
  assert.strictEqual(h.info().search.waiting, true);
  dom.advance(2);
  dom.runTimers();
  const r = await p;
  assert.deepStrictEqual(r, { ok: false, code: "embed-timeout", message: "The embedder did not answer within 2 seconds. The earlier results are kept." });
  d.resolve({ vector: rowOf(v.set, 30), model: "test/model" });
  await tick();
  dom.frames(5);
  await tick();
  const s = h.info().search;
  assert.deepStrictEqual(s.searches, before);
  assert.strictEqual(s.code, "embed-timeout");
  assert.strictEqual(s.waiting, false);
  assert.strictEqual(lit.length, litBefore);
  assert.strictEqual(dom.pendingTimers(), 0);
  h.destroy();
});

test("a failing callback: embed-failed, the host's error text is never shown", async () => {
  let mode = "throw";
  const embed = () => {
    if (mode === "throw") throw new Error("secret-key-123 at gateway.internal");
    return Promise.reject(new Error("secret-key-123"));
  };
  const { h, v, dom, lit } = setup({ embed });
  await settle(dom, h.setSearches([{ point: v.set.ids[1] }]));
  const before = h.info().search.searches;
  const litBefore = lit.length;
  for (const m of ["throw", "reject"]) {
    mode = m;
    const r = await settle(dom, h.setSearches(["anything"]));
    assert.deepStrictEqual(r, { ok: false, code: "embed-failed", message: "The embedder failed to answer. The earlier results are kept." });
    assert.ok(!JSON.stringify(h.info()).includes("secret"), m);
    assert.deepStrictEqual(h.info().search.searches, before, m);
  }
  assert.strictEqual(lit.length, litBefore);
  h.destroy();
});

test("a wrong-length answer never reaches the renderer and names both dimensions", async () => {
  let vec = null;
  const { h, v, dom, lit } = setup({ embed: () => ({ vector: vec, model: "test/model" }) });
  await settle(dom, h.setSearches([{ point: v.set.ids[1] }]));
  const litBefore = lit.length;
  vec = new Float32Array(15).fill(0.5);
  const r = await settle(dom, h.setSearches(["short"]));
  assert.strictEqual(r.code, "query-dimension-mismatch");
  assert.match(r.message, /dimension 15 but the data has dimension 16/);
  assert.strictEqual(lit.length, litBefore);
  assert.strictEqual(h.info().search.searches[0].kind, "point");
  h.destroy();
});

test("a non-finite answer never reaches the renderer", async () => {
  const vec = new Array(16).fill(0.1);
  vec[3] = Number.NaN;
  const { h, v, dom, lit } = setup({ embed: async () => ({ vector: vec, model: "test/model" }) });
  await settle(dom, h.setSearches([{ point: v.set.ids[1] }]));
  const litBefore = lit.length;
  const r = await settle(dom, h.setSearches(["nan"]));
  assert.strictEqual(r.code, "query-non-finite");
  assert.match(r.message, /position 3/);
  assert.strictEqual(lit.length, litBefore);
  assert.strictEqual(h.info().search.searches[0].kind, "point");
  h.destroy();
});

test("a malformed answer: embed-malformed; an answer with no model is refused, not assumed", async () => {
  let answer = null;
  const { h, v, dom } = setup({ embed: () => answer });
  const hostile = {};
  Object.defineProperty(hostile, "vector", {
    get() {
      throw new Error("x");
    },
  });
  for (const a of [null, 7, { model: "test/model" }, hostile]) {
    answer = a;
    assert.strictEqual((await settle(dom, h.setSearches(["q"]))).code, "embed-malformed");
  }
  answer = { vector: rowOf(v.set, 0) };
  const r = await settle(dom, h.setSearches(["q"]));
  assert.strictEqual(r.code, "query-model-missing");
  answer = { vector: rowOf(v.set, 0), model: "other" };
  assert.strictEqual((await settle(dom, h.setSearches(["q"]))).code, "query-model-mismatch");
  assert.strictEqual(h.info().search.active, false);
  h.destroy();
});

test("all or nothing: one refused entry leaves every earlier search as it was", async () => {
  const { h, v, dom } = setup();
  await settle(dom, h.setSearches([{ point: v.set.ids[1] }, { point: v.set.ids[2] }]));
  const before = h.info().search;
  const r = await settle(dom, h.setSearches([{ point: v.set.ids[4] }, { point: "missing" }]));
  assert.strictEqual(r.code, "point-unknown");
  const after = h.info().search;
  assert.deepStrictEqual(after.searches, before.searches);
  assert.deepStrictEqual(after.pairs, before.pairs);
  assert.strictEqual(after.litCount, before.litCount);
  h.destroy();
});

test("destroy while waiting: the promise resolves destroyed and nothing runs afterwards", async () => {
  let d = null;
  const embed = () => {
    d = deferred();
    return d.promise;
  };
  const { h, v, dom, lit } = setup({ embed });
  const p = h.setSearches(["waiting"]);
  const s = h.setSearchSettings({ lit: "named" });
  assert.strictEqual((await s).ok, true);
  assert.strictEqual(dom.pendingTimers(), 1, "the timeout timer");
  const litBefore = lit.length;
  h.destroy();
  assert.deepStrictEqual(await p, { ok: false, code: "destroyed", message: "This viewer has been destroyed." });
  assert.strictEqual(dom.pendingTimers(), 0, "the timeout is cleared");
  d.resolve({ vector: rowOf({ vectors: new Float32Array(16 * 2).fill(0.3), dimension: 16 }, 0), model: "test/model" });
  await tick();
  dom.frames(3);
  await tick();
  assert.strictEqual(dom.pendingFrames(), 0);
  assert.strictEqual(lit.length, litBefore);
  assert.strictEqual(v.search.run, null);
  assert.strictEqual((await h.setSearches(["x"])).code, "destroyed");
  assert.strictEqual((await h.setSearchSettings({ k: 4 })).code, "destroyed");
  assert.strictEqual(h.clearSearches(), false);
  assert.strictEqual(h.faceSearches(), false);
  assert.deepStrictEqual(h.setSearchCallbacks({ embed: () => null }), { embedder: false, reranker: false });
  assert.strictEqual(h.info().search.active, false);
  dom.advance(60000);
  assert.strictEqual(dom.runTimers(), 0);
});

// ---------- criterion 3: after an append, stale then worked out again ----------

test("after an append the results are stale, then worked out again with no call and no swing", async () => {
  let embeds = 0;
  let v0 = null;
  const embed = () => {
    embeds++;
    return { vector: rowOf(v0.set, 0), model: "test/model" };
  };
  const changes = [];
  const { h, v, dom, lit } = setup({ embed, onSearchChange: (s) => changes.push(s) });
  v0 = v;
  await settle(dom, h.setSearches(["word0", { point: v.set.ids[1] }, "word3"]));
  assert.strictEqual(embeds, 2);
  dom.frames(30);
  const faces = calls.face.length;
  assert.strictEqual(faces, 1, "one swing for the new searches");
  // Append points that sit right on point 0: they belong among its nearest.
  const extra = makeSet({ n: 6, d: 16, op: "append", idPrefix: "n" });
  for (let i = 0; i < 6; i++) extra.vectors.set(rowOf(v.set, 0), i * 16);
  extra.points.forEach((p) => {
    p.group = "alpha";
  });
  const r = h.update(extra);
  assert.strictEqual(r.ok, true);
  const s = h.info().search;
  assert.strictEqual(s.stale, true);
  assert.strictEqual(s.staleBy, 6);
  assert.strictEqual(s.waiting, true, "the re-run started at once");
  assert.ok(changes.some((c) => c.stale && c.staleBy === 6), "onSearchChange heard the results went stale");
  await until(dom, () => !h.info().search.waiting);
  const fresh = h.info().search;
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(fresh.staleBy, 0);
  assert.ok(idsOf(fresh, 0).some((id) => id.startsWith("n")), "the new points are among the results");
  assert.deepStrictEqual(idsOf(fresh, 0), ET.search.rank(v.set, rowOf(v.set, 0), { k: 8 }).hits.map((x) => x.id));
  assert.strictEqual(embeds, 2, "no new embed call");
  assert.strictEqual(lit.at(-1).lit.length, 126);
  dom.frames(30);
  assert.strictEqual(calls.face.length, faces, "a re-run does not swing");
  h.destroy();
});

test("appends during a re-run are folded into one more re-run; a replace clears every search", async () => {
  const { h, v, dom } = setup();
  await settle(dom, h.setSearches(["word3"]));
  h.update(makeSet({ n: 3, d: 16, op: "append", idPrefix: "a", seed: 2 }));
  h.update(makeSet({ n: 4, d: 16, op: "append", idPrefix: "b", seed: 3 }));
  assert.strictEqual(h.info().search.staleBy, 7);
  await until(dom, () => !h.info().search.waiting && !h.info().search.stale);
  assert.strictEqual(h.info().search.searches[0].kind, "words");
  assert.strictEqual(v.search.shownSet, v.set);
  const pending = h.setSearches(["word6"]);
  h.update(makeSet({ n: 30, d: 16, seed: 5 }));
  assert.strictEqual((await pending).code, "superseded");
  assert.strictEqual(h.info().search.active, false);
  h.destroy();
});

// ---------- criterion 5: reranking ----------

test("with no rerank callback there is no reranking and info() says so", async () => {
  const { h, v, dom } = setup();
  await settle(dom, h.setSearches([{ point: v.set.ids[2] }]));
  const r = await settle(dom, h.setSearchSettings({ rerank: true }));
  assert.strictEqual(r.ok, true);
  const s = h.info().search;
  assert.strictEqual(s.settings.rerank, false);
  assert.deepStrictEqual(s.reranker, { available: false, offered: false });
  assert.strictEqual(s.searches[0].reranker, null);
  assert.ok(s.searches[0].results.every((x) => x.moved === 0 && x.score === null));
  h.destroy();
});

test("with a rerank callback each result carries its move and the reranker's name", async () => {
  const seen = [];
  const rerank = function (query, candidates) {
    seen.push({ args: arguments.length, query, candidates });
    return { scores: candidates.map((c, i) => i), model: "test/reranker" }; // reverse the order
  };
  const { h, v, dom } = setup({ rerank });
  assert.deepStrictEqual(h.info().search.reranker, { available: true, offered: true });
  await settle(dom, h.setSearches(["word3"]));
  assert.strictEqual(seen.length, 0, "rerank is off until asked for");
  // 24 candidates, top 8 (before the owner's request the pool was 3 x k = 24 and k results kept)
  const r = await settle(dom, h.setSearchSettings({ rerank: true, candidates: 24, top: 8 }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].args, 2);
  assert.strictEqual(seen[0].query, "word3");
  const pool = ET.search.rank(v.set, v.search.shown[0].query, { k: 8, candidates: 24 }).pool;
  assert.deepStrictEqual(seen[0].candidates, pool.map((x) => ET.search.pointText(v.set, x.index)));
  const q = h.info().search.searches[0];
  assert.strictEqual(q.reranker, "test/reranker");
  assert.strictEqual(h.info().search.settings.rerank, true);
  assert.deepStrictEqual(q.results.map((x) => x.embeddingRank), [24, 23, 22, 21, 20, 19, 18, 17]);
  assert.deepStrictEqual(q.results.map((x) => x.moved), [23, 21, 19, 17, 15, 13, 11, 9]);
  assert.strictEqual(q.radius, Math.max(...q.results.map((x) => x.distance)));
  h.destroy();
});

test("a reranker that fails, times out or answers wrongly leaves embedding order with a note", async () => {
  let behave = "throw";
  let d = null;
  const rerank = (query, candidates) => {
    if (behave === "throw") throw new Error("secret");
    if (behave === "late") {
      d = deferred();
      return d.promise;
    }
    if (behave === "short") return { scores: [1, 2], model: "r" };
    if (behave === "nan") return { scores: candidates.map(() => Number.NaN), model: "r" };
    return { scores: candidates.map(() => 1) }; // no model
  };
  const { h, v, dom } = setup({ rerank, searchTimeoutMs: 1000 });
  await settle(dom, h.setSearches([{ point: v.set.ids[2] }]));
  const plain = idsOf(h.info().search);
  const expectNote = {
    throw: "The reranker failed to answer; the results stay in embedding order.",
    short: ET.search.MESSAGES["rerank-malformed"],
    nan: ET.search.MESSAGES["rerank-malformed"],
    nomodel: ET.search.MESSAGES["rerank-malformed"],
  };
  for (const b of ["throw", "short", "nan", "nomodel"]) {
    behave = b;
    // Each pass turns rerank on, then off again, so every pass reranks afresh.
    const r = await settle(dom, h.setSearchSettings({ rerank: true }));
    assert.strictEqual(r.ok, true, b);
    const q = h.info().search.searches[0];
    assert.strictEqual(q.note, expectNote[b], b);
    assert.strictEqual(q.reranker, null, b);
    assert.deepStrictEqual(idsOf(h.info().search), plain, b);
    await settle(dom, h.setSearchSettings({ rerank: false }));
  }
  behave = "late";
  const p = h.setSearchSettings({ rerank: true });
  await until(dom, () => d !== null);
  dom.advance(1001);
  dom.runTimers();
  const r = await settle(dom, p);
  assert.strictEqual(r.search.searches[0].note, "The reranker did not answer within 1 seconds; the results stay in embedding order.");
  d.resolve({ scores: [], model: "late" });
  await tick();
  assert.strictEqual(h.info().search.searches[0].reranker, null);
  h.destroy();
});

test("a labels-only set offers no reranking; a vector search with no label is not reranked", async () => {
  const rerank = (q, c) => ({ scores: c.map(() => 0), model: "r" });
  const lo = setup({ rerank }, { text_included: false });
  assert.deepStrictEqual(lo.h.info().search.reranker, { available: true, offered: false });
  await settle(lo.dom, lo.h.setSearches([{ point: lo.v.set.ids[0] }]));
  await settle(lo.dom, lo.h.setSearchSettings({ rerank: true }));
  assert.strictEqual(lo.h.info().search.settings.rerank, false);
  lo.h.destroy();
  const { h, v, dom } = setup({ rerank });
  await settle(dom, h.setSearchSettings({ rerank: true }));
  const r = await settle(dom, h.setSearches([{ vector: rowOf(v.set, 3), model: "test/model" }, { vector: rowOf(v.set, 4), model: "test/model", label: "four" }]));
  assert.strictEqual(r.search.searches[0].note, "A vector search with no label has no text to send to the reranker; it stays in embedding order.");
  assert.strictEqual(r.search.searches[0].reranker, null);
  assert.strictEqual(r.search.searches[1].reranker, "r");
  h.destroy();
});

// ---------- swing, Focus, settings ----------

test("a new search swings the view once, with the facing frame; faceSearches repeats it", async () => {
  const { h, v, dom } = setup();
  await settle(dom, h.setSearches([{ point: v.set.ids[0] }, { point: v.set.ids[1] }]));
  await until(dom, () => calls.face.length > 0);
  const f = calls.face[0];
  assert.strictEqual(f.mode, "stubface");
  assert.strictEqual(f.args, 3);
  assert.deepStrictEqual(f.options, { searches: 2 });
  assert.ok(f.t >= 0 && f.t <= v.mode.clock, "called at the mode's time");
  assert.strictEqual(f.target.frame.length, 3 * 16);
  const want = ET.searchSets.facingFrame(v.set, v.search.shown.map((q) => ({ query: q.query, hits: q.view.hits })), { seed: 3 });
  assert.strictEqual(f.target.centre.length, 16);
  assert.ok(Math.abs(f.target.zoom - want.zoom) < 1e-9);
  assert.strictEqual(h.info().search.facing, true);
  await settle(dom, h.setSearchSettings({ lit: "close" }));
  await settle(dom, h.setSearchSettings({ k: 5 }));
  dom.frames(20);
  assert.strictEqual(calls.face.length, 1, "settings changes do not swing");
  assert.strictEqual(h.faceSearches(), true);
  assert.strictEqual(calls.face.length, 2);
  h.setMode("stubplain");
  assert.strictEqual(h.faceSearches(), false, "a mode with no face member");
  assert.strictEqual(h.info().search.faceable, false);
  assert.strictEqual(h.info().search.facing, false);
  h.destroy();
});

test("faceSearches is false with no search and while the facing frame is worked out", async () => {
  const { h, v, dom } = setup();
  assert.strictEqual(h.faceSearches(), false);
  const p = h.setSearches([{ point: v.set.ids[0] }]);
  assert.strictEqual(h.faceSearches(), false);
  await settle(dom, p);
  h.destroy();
});

test("a mode with searchChanged hears the searches, the point-of-view scale and Only results", async () => {
  const { h, v, dom } = setup({ mode: "stubfit" });
  await settle(dom, h.setSearches([{ point: v.set.ids[0] }, { point: v.set.ids[5] }]));
  const last = calls.searchChanged.at(-1);
  assert.strictEqual(last.mode, "stubfit");
  assert.deepStrictEqual(last.search.searches.map((s) => s.letter), ["A", "B"]);
  assert.deepStrictEqual(Array.from(last.search.searches[0].indices), h.info().search.searches[0].results.map((r) => r.index));
  assert.ok(last.search.searches[1].query instanceof Float32Array);
  assert.strictEqual(last.search.scale, null);
  assert.strictEqual(last.search.onlyResults, false);
  await settle(dom, h.setSearchSettings({ pointOfView: "B" }));
  const pov = calls.searchChanged.at(-1).search;
  assert.deepStrictEqual(Array.from(pov.scale), Array.from(ET.searchSets.scaleFor(rowOf(v.set, 5))));
  assert.deepStrictEqual(h.info().search.searches.map((s) => s.pointOfView), [false, true]);
  await settle(dom, h.setSearchSettings({ onlyResults: true }));
  assert.strictEqual(calls.searchChanged.at(-1).search.onlyResults, true);
  h.clearSearches();
  assert.strictEqual(calls.searchChanged.at(-1).search, null);
  h.destroy();
});

test("entering a mode with searchChanged while searches are shown tells it at once, and its work is pumped", async () => {
  let stepped = 0;
  const id = "stubwork";
  api.registerMode(
    stubDefinition(id, {
      searchChanged: true,
      searchWork: () => ({
        done: false,
        step() {
          stepped++;
          this.done = true;
          return true;
        },
      }),
    })
  );
  const { h, v, dom } = setup();
  await settle(dom, h.setSearches([{ point: v.set.ids[0] }]));
  resetCalls();
  assert.strictEqual(h.setMode(id), true);
  assert.strictEqual(calls.searchChanged.length, 1);
  assert.strictEqual(calls.searchChanged[0].t, 0);
  dom.frames(2);
  assert.strictEqual(stepped, 1);
  h.destroy();
});

test("settings: lit, k and point of view work the searches out again; invalid values are ignored", async () => {
  const { h, v, dom, lit } = setup({ searchK: 4, searchLit: "named" });
  assert.deepStrictEqual(h.searchSettings(), { k: 4, candidates: 50, top: 20, lit: "named", distances: false, rerank: false, pointOfView: null, onlyResults: false });
  await settle(dom, h.setSearches([{ point: v.set.ids[0] }, { point: v.set.ids[1] }]));
  assert.strictEqual(h.info().search.litCount, 8, "named only: the hits of both searches");
  const n = lit.length;
  await settle(dom, h.setSearchSettings({ lit: "even" }));
  assert.strictEqual(lit.length, n + 1, "a lit change uploads new values");
  assert.deepStrictEqual(litIndices(lit.at(-1).lit), Array.from(new Set([...expectedLitIndices(v, rowOf(v.set, 0), 4), ...expectedLitIndices(v, rowOf(v.set, 1), 4)])).sort((a, b) => a - b));
  // k goes to 100 (it was 20 before the owner asked for more); the set has 40 named points.
  const r = await settle(dom, h.setSearchSettings({ k: 130 }));
  assert.strictEqual(r.search.settings.k, 100);
  assert.strictEqual(r.search.searches[0].results.length, 40);
  await settle(dom, h.setSearchSettings({ pointOfView: "A" }));
  const s = h.info().search;
  const scaled = ET.search.rank(v.set, rowOf(v.set, 0), { k: 100, scale: ET.searchSets.scaleFor(rowOf(v.set, 0)) });
  assert.deepStrictEqual(idsOf(s, 0), scaled.hits.map((x) => x.id));
  assert.deepStrictEqual(s.searches[0].results.map((x) => x.plainRank), scaled.hits.map((x) => x.plainRank));
  assert.strictEqual(s.searches[0].pointOfView, true);
  const before = h.searchSettings();
  await settle(dom, h.setSearchSettings({ pointOfView: "D", lit: "loud", k: "many", distances: 1, nonsense: true }));
  assert.deepStrictEqual(h.searchSettings(), before, "invalid values are ignored");
  await settle(dom, h.setSearchSettings({ distances: true }));
  assert.strictEqual(h.searchSettings().distances, true);
  await settle(dom, h.setSearchSettings(null));
  // The point of view belongs to a letter; with fewer searches it is off.
  await settle(dom, h.setSearches([{ point: v.set.ids[9] }]));
  assert.strictEqual(h.searchSettings().pointOfView, "A");
  await settle(dom, h.setSearchSettings({ pointOfView: null }));
  assert.strictEqual(h.info().search.searches[0].pointOfView, false);
  h.destroy();
});

test("a settings change while a new search is working is applied when it lands", async () => {
  const d = deferred();
  const { h, v, dom } = setup({ embed: () => d.promise });
  const p = h.setSearches(["x"]);
  const s = await h.setSearchSettings({ k: 3 });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.search.waiting, true);
  d.resolve({ vector: rowOf(v.set, 2), model: "test/model" });
  await settle(dom, p);
  await until(dom, () => !h.info().search.waiting);
  assert.strictEqual(h.info().search.searches[0].results.length, 3);
  h.destroy();
});

// ---------- callbacks after mount, onSearchChange, the panel hook ----------

test("setSearchCallbacks sets, replaces and removes; a call waiting on a removed callback is superseded", async () => {
  const d = deferred();
  const { h, dom } = setup();
  assert.deepStrictEqual(h.setSearchCallbacks({ embed: () => d.promise }), { embedder: true, reranker: false });
  assert.deepStrictEqual(h.setSearchCallbacks({ rerank: "nope", embed: 3 }), { embedder: true, reranker: false });
  assert.deepStrictEqual(h.setSearchCallbacks(null), { embedder: true, reranker: false });
  const p = h.setSearches(["waiting"]);
  assert.deepStrictEqual(h.setSearchCallbacks({ embed: null, rerank: () => null }), { embedder: false, reranker: true });
  assert.strictEqual((await p).code, "superseded");
  assert.deepStrictEqual(h.info().search.embedder, { available: false });
  const words = await settle(dom, h.setSearches(["word3"]));
  assert.strictEqual(words.search.searches[0].kind, "words");
  await settle(dom, h.setSearchSettings({ rerank: true }));
  assert.strictEqual(h.searchSettings().rerank, true);
  h.setSearchCallbacks({ rerank: null });
  assert.strictEqual(h.searchSettings().rerank, false);
  h.destroy();
});

test("onSearchChange hears each change; a throwing one does not break the viewer", async () => {
  const seen = [];
  const { h, v, dom } = setup({
    onSearchChange(s) {
      seen.push(s);
      throw new Error("host bug");
    },
  });
  await settle(dom, h.setSearches([{ point: v.set.ids[0] }]));
  assert.ok(seen.length >= 2);
  assert.strictEqual(seen[0].waiting, true);
  assert.ok(seen.some((s) => s.active && !s.waiting));
  h.clearSearches();
  assert.strictEqual(seen.at(-1).active, false);
  assert.ok(dom.pendingTimers() > 0, "the host's error is rethrown on a later task");
  h.destroy();
});

test("the search panel hook: nothing without ET.searchPanel; with it, mount, update, overlay, destroy", async () => {
  // The core file now carries the real panel (t9); it is put back at the end.
  const real = ET.searchPanel;
  delete ET.searchPanel;
  const plain = setup();
  assert.strictEqual(plain.v.search.panel, null);
  plain.h.destroy();
  const log = [];
  ET.searchPanel = {
    mount(parts, handle, options) {
      log.push(["mount", Object.keys(parts).sort(), typeof handle.setSearches, options.document === parts.panel.ownerDocument]);
      return {
        update: (s) => log.push(["update", s.active]),
        drawOverlay(ctx, project) {
          const p = project(new Float32Array(16));
          log.push(["draw", typeof ctx.clearRect, Number.isFinite(p.x) && Number.isFinite(p.y)]);
        },
        destroy: () => log.push(["destroy"]),
      };
    },
  };
  try {
    const off = setup({ searchPanel: false });
    assert.strictEqual(off.v.search.panel, null);
    off.h.destroy();
    assert.strictEqual(log.length, 0);
    const { h, v, dom } = setup();
    assert.deepStrictEqual(log[0], ["mount", ["overlay", "panel", "provenanceList", "provenanceSummary", "stage"], "function", true]);
    await settle(dom, h.setSearches([{ point: v.set.ids[0] }]));
    assert.ok(log.some((e) => e[0] === "update" && e[1] === true));
    assert.ok(log.some((e) => e[0] === "draw" && e[1] === "function" && e[2] === true));
    h.destroy();
    assert.deepStrictEqual(log.at(-1), ["destroy"]);
    // A panel that throws is reported, never thrown into the host.
    ET.searchPanel = {
      mount: () => ({
        update() {
          throw new Error("u");
        },
        drawOverlay() {
          throw new Error("d");
        },
        destroy() {
          throw new Error("x");
        },
      }),
    };
    const bad = setup();
    await settle(bad.dom, bad.h.setSearches([{ point: bad.v.set.ids[0] }]));
    bad.dom.frames(2);
    assert.strictEqual(bad.h.info().broken, false);
    assert.strictEqual(bad.h.destroy(), true);
    ET.searchPanel = {
      mount() {
        throw new Error("m");
      },
    };
    const failed = setup();
    assert.strictEqual(failed.v.search.panel, null);
    failed.h.destroy();
  } finally {
    if (real) ET.searchPanel = real;
    else delete ET.searchPanel;
  }
});

// ---------- Focus: a click searches from a point; hidden points are skipped ----------

test("in Focus a click on a point searches from it; Only results hides unlit points from hit-tests", async () => {
  const { h, v, dom } = setup({ mode: "focus" });
  await until(dom, () => h.info().ready && v.last !== null);
  dom.frames(2);
  const target = 6; // a named point: the first result of a search from it is itself
  const at = (i) => {
    const D = v.set.dimension;
    const out = [0, 0, 0];
    for (let d = 0; d < D; d++) {
      const x = v.set.vectors[i * D + d] - v.last.centre[d];
      out[0] += x * v.last.frame[d];
      out[1] += x * v.last.frame[D + d];
      out[2] += x * v.last.frame[2 * D + d];
    }
    const q = ET.renderer.place(out, v.lastDraw, v.W, v.H);
    return { x: q.x / v.dpr, y: q.y / v.dpr };
  };
  const click = (pt, moveBy = 0) => {
    v.stage.dispatchEvent({ type: "pointerdown", pointerId: 9, pointerType: "mouse", button: 0, clientX: pt.x, clientY: pt.y, target: v.canvas });
    v.stage.dispatchEvent({ type: "pointerup", pointerId: 9, pointerType: "mouse", clientX: pt.x + moveBy, clientY: pt.y, target: v.canvas });
  };
  click(at(target), 12);
  await tick();
  assert.strictEqual(h.info().search.waiting, false, "a drag is not a click");
  click(at(target));
  await until(dom, () => h.info().search.active && !h.info().search.waiting);
  const q = h.info().search.searches[0];
  assert.strictEqual(q.kind, "point");
  // The real Focus (t7) returns a stepper from searchChanged; once the viewer has pumped it
  // the mode says it is fitted to the results. (The stub stands in when Focus is absent.)
  if (v.mode.inst.describe().fittedTo !== undefined) {
    await until(dom, () => v.mode.inst.describe().fittedTo === "results");
  }
  // The nearest shown point to where the click landed is the target, or one drawn on top of it.
  const pos = at(target);
  const got = at(q.results[0].index);
  assert.ok(Math.hypot(got.x - pos.x, got.y - pos.y) <= 16);
  // Only results: points outside the search are hidden and cannot be clicked.
  await settle(dom, h.setSearchSettings({ onlyResults: true }));
  dom.frames(60);
  assert.ok(v.search.lit.lit.some((x) => x <= 0.02), "some points are unlit");
  assert.strictEqual(v.search.hideUnlit, true);
  {
    const before = h.info().search.searches[0].point;
    // Find an unlit point with no lit point within reach of it, then click it.
    const isolated = [];
    for (let i = 0; i < v.set.count; i++) {
      if (v.search.lit.lit[i] > 0.02) continue;
      const p = at(i);
      let clear = true;
      for (let j = 0; j < v.set.count && clear; j++) {
        if (v.search.lit.lit[j] <= 0.02) continue;
        const r = at(j);
        if (Math.hypot(r.x - p.x, r.y - p.y) <= 17) clear = false;
      }
      if (clear) isolated.push(i);
    }
    if (isolated.length) {
      click(at(isolated[0]));
      await tick();
      dom.frames(5);
      await tick();
      assert.strictEqual(h.info().search.searches[0].point, before, "a hidden point cannot be clicked");
    }
    // Hover skips hidden points too.
    const lab = v.labelSample.find((i) => v.search.lit.lit[i] <= 0.02);
    if (lab !== undefined) {
      const p = at(lab);
      v.stage.dispatchEvent({ type: "pointermove", pointerId: 1, pointerType: "mouse", clientX: p.x, clientY: p.y });
      dom.frames(1);
    }
  }
  h.setMode("stubface");
  const n = h.info().search.searches.length;
  click(at(0));
  await tick();
  assert.strictEqual(h.info().search.searches.length, n, "outside Focus a click keeps its old meaning");
  h.destroy();
});

test("a failed replace keeps the searches and puts the lit values back", async () => {
  const { h, v, dom, lit } = setup();
  await settle(dom, h.setSearches([{ point: v.set.ids[0] }]));
  const before = h.info().search;
  const n = lit.length;
  const realSetData = v.renderer.setData;
  let first = true;
  v.renderer.setData = function () {
    if (first) {
      first = false;
      return { ok: false, reason: "too-many-points", message: "too many" };
    }
    return realSetData.apply(this, arguments);
  };
  const r = h.update(makeSet({ n: 50, d: 16, seed: 11 }));
  assert.strictEqual(r.code, "too-many-points");
  assert.deepStrictEqual(h.info().search.searches, before.searches);
  assert.strictEqual(lit.length, n + 1, "the lit values went back up after the restore");
  assert.deepStrictEqual(Array.from(lit.at(-1).lit), Array.from(lit[n - 1].lit));
  h.destroy();
});

test("via: embed with a callback embeds; a mode whose face or searchChanged throws keeps running", async () => {
  api.registerMode({
    ...stubDefinition("stubthrow", {}),
    create() {
      const inst = stubDefinition("stubthrow", {}).create();
      inst.face = () => {
        throw new Error("face");
      };
      inst.searchChanged = () => {
        throw new Error("changed");
      };
      return inst;
    },
  });
  let v0 = null;
  const { h, v, dom } = setup({ mode: "stubthrow", embed: () => ({ vector: rowOf(v0.set, 2), model: "test/model" }) });
  v0 = v;
  const r = await settle(dom, h.setSearches([{ text: "word3", via: "embed" }]));
  assert.strictEqual(r.search.searches[0].kind, "embedded");
  dom.frames(10);
  assert.strictEqual(h.faceSearches(), false, "a face that throws took no swing");
  assert.strictEqual(h.clearSearches(), true);
  assert.strictEqual(h.info().broken, false);
  h.destroy();
});

test("with fewer than three dimensions there is no facing frame, and search still works", async () => {
  const { h, v, dom } = setup({ mode: "stubplain" }, { d: 2 });
  const r = await settle(dom, h.setSearches([{ point: v.set.ids[0] }]));
  assert.strictEqual(r.ok, true);
  dom.frames(5);
  assert.strictEqual(v.search.facingTarget, null);
  assert.strictEqual(h.faceSearches(), false);
  h.destroy();
});
