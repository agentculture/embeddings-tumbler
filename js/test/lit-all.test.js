"use strict";
// Deviation d8, second part (task t21): a fourth Lit setting, "all" ("everything, results
// highlighted"). Every point that is not a result is drawn as nearly as the renderer allows
// as with no search (the lit value LIT_ALL_REST, at which the lit shader's brightness
// factor is 1), and every result is fully lit, as under "even". Counts keep meaning
// results. Binding names: docs/search-interface.md ("Several searches" and "Panel") and
// docs/relative-interface.md ("Viewer (t9, t10)").
//
// Loaded from the source modules on the fake DOM and GPU of helpers/. Large arrays are never
// handed to an equality assertion: comparisons loop and report the first differing index.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadSources();
const ET = api._internal;
const S = ET.searchSets;
const SP = ET.searchPanel;
const FIX = path.join(ROOT, "tests", "fixtures", "relative");
const TURN = 1.5; // Tumble's relativeTransition
const REST = S.LIT_ALL_REST;
const REST32 = Math.fround(REST);

const textOf = (el) => (el ? el.textContent : null);
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
  let finished = false;
  let out;
  promise.then((r) => {
    out = r;
    finished = true;
  });
  await until(dom, () => finished);
  return out;
}

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

// Record what the viewer hands the renderer's setLit.
function recordLit(v) {
  const lit = [];
  const real = v.renderer.setLit;
  v.renderer.setLit = function (l) {
    lit.push(l ? Float32Array.from(l) : null);
    return real.apply(this, arguments);
  };
  return lit;
}

// Every uploaded value is 1 at a result (inside a radius) and `rest` elsewhere.
function assertUpload(uploaded, inside, rest, what) {
  assert.strictEqual(uploaded.length, inside.length, what + ": length");
  let results = 0;
  for (let i = 0; i < uploaded.length; i++) {
    const want = inside[i] > 0 ? 1 : rest;
    if (!Object.is(uploaded[i], want)) assert.fail(`${what}: point ${i} is ${uploaded[i]}, expected ${want}`);
    if (inside[i] > 0) results++;
  }
  assert.ok(results > 0 && results < uploaded.length, what + ": the set has results and other points");
  return results;
}

// ---------- ET.searchSets ----------

test("the settings: four, the new one last, the default unchanged", () => {
  assert.deepStrictEqual(S.LIT_SETTINGS, ["even", "close", "named", "all"]);
  assert.ok(Object.isFrozen(S.LIT_SETTINGS));
  assert.strictEqual(S.DEFAULT_LIT, "even");
  assert.strictEqual(S.litSetting("all"), "all");
  for (const bad of ["ALL", "all ", "everything", 3, null, undefined]) assert.strictEqual(S.litSetting(bad), "even");
});

test("LIT_ALL_REST is the lit value at which the renderer's lit shader leaves brightness alone", () => {
  // The shader multiplies colour by mix(unlitGain, 2.2, l) at filter 1.
  assert.strictEqual(S.LIT_UNLIT_GAIN, ET.renderer.DEFAULTS.unlitGain, "the renderer's default unlitGain");
  assert.strictEqual(S.LIT_UNLIT_GAIN, 0.07);
  assert.strictEqual(S.LIT_FULL_GAIN, 2.2);
  const src = ET.renderer.shaderSources(ET.renderer.layout(8, 10, 4096)).pointVertexLit;
  assert.ok(src.includes("mix(uUnlit, 2.2, l)"), "the shader's brightness rule");
  assert.ok(src.includes("mix(0.8, 1.5, l)"), "the shader's size rule");
  assert.strictEqual(REST, (1 - 0.07) / (2.2 - 0.07));
  assert.ok(Math.abs(REST - 0.4366) < 1e-4, String(REST));
  const brightness = 0.07 + (2.2 - 0.07) * REST;
  assert.ok(Math.abs(brightness - 1) < 1e-12, "brightness factor " + brightness);
  const size = 0.8 + (1.5 - 0.8) * REST;
  assert.ok(Math.abs(size - 1.106) < 1e-3, "size factor " + size);
  assert.ok(REST > S.LIT_THRESHOLD, "above the counting threshold, so the counts must not use it");
});

const DIST_A = [0.1, 0.2, 0.3, 0.35, 0.5, 0.9, 1.4, 0.05];
const HITS_A = [7, 0, 1, 2]; // near 0.05, radius 0.3

test("all: results are lit at 1 as under even, every other point gets the constant, counts are of results", () => {
  const r = handRanking(DIST_A, HITS_A);
  const all = S.litValues([r], DIST_A.length, "all");
  const even = S.litValues([r], DIST_A.length, "even");
  assert.deepStrictEqual(Array.from(all.lit), [1, 1, 1, REST32, REST32, REST32, REST32, 1]);
  assert.deepStrictEqual(Array.from(all.inside), Array.from(even.inside));
  assert.deepStrictEqual(Array.from(all.shared), Array.from(even.shared));
  assert.deepStrictEqual(all.insideCounts, [4]);
  assert.strictEqual(all.litCount, 4, "the lit count is of results, not of every point");
  assert.strictEqual(all.sharedCount, 0);
  assert.strictEqual(all.rest, REST);
  assert.strictEqual(even.rest, 0, "the other settings give the rest nothing");
  assert.strictEqual(S.litValues([r], 8, "close").rest, 0);
  assert.strictEqual(S.litValues([r], 8, "named").rest, 0);
});

test("all with several searches: counts and shared marks are exactly those of even", () => {
  const a = handRanking([0.1, 0.2, 0.9, 0.9, 0.15], [0, 1]); // inside 0, 1, 4
  const b = handRanking([0.9, 0.3, 0.1, 0.9, 0.2], [2, 1]); // inside 1, 2, 4
  const all = S.litValues([a, b], 5, "all");
  const even = S.litValues([a, b], 5, "even");
  assert.deepStrictEqual(Array.from(all.lit), [1, 1, 1, REST32, 1]);
  assert.deepStrictEqual(Array.from(all.shared), [0, 1, 0, 0, 1]);
  assert.strictEqual(all.litCount, even.litCount);
  assert.strictEqual(all.sharedCount, even.sharedCount);
  assert.deepStrictEqual(all.insideCounts, even.insideCounts);
});

test("all: a search with no results, an append and no search at all leave every such point at the constant", () => {
  const none = S.litValues([handRanking([0.1, 0.2], [])], 2, "all");
  assert.deepStrictEqual(Array.from(none.lit), [REST32, REST32]);
  assert.strictEqual(none.litCount, 0);
  const appended = S.litValues([handRanking([0.1, 0.2, 0.3], [0, 1, 2])], 5, "all");
  assert.deepStrictEqual(Array.from(appended.lit), [1, 1, 1, REST32, REST32]);
  assert.strictEqual(appended.litCount, 3);
  const empty = S.litValues([], 3, "all");
  assert.deepStrictEqual(Array.from(empty.lit), [REST32, REST32, REST32]);
  assert.strictEqual(empty.litCount, 0);
  assert.strictEqual(empty.sharedCount, 0);
});

test("a junk setting still falls back to the default, not to all", () => {
  const r = handRanking(DIST_A, HITS_A);
  for (const junk of ["bright", "ALL", "everything", 4, null]) {
    assert.deepStrictEqual(S.litValues([r], 8, junk), S.litValues([r], 8, "even"), String(junk));
  }
});

// ---------- the panel ----------

function buildPanel(mode) {
  const dom = makeFakeDom();
  const host = dom.host();
  const panelEl = dom.document.createElement("div");
  const stage = dom.document.createElement("div");
  host.appendChild(stage);
  host.appendChild(panelEl);
  const calls = [];
  const handle = {
    mode: () => mode,
    clearSearches: () => true,
    setSearches: () => null,
    setSearchSettings: (patch) => {
      calls.push(Object.keys(patch).map((k) => k + "=" + patch[k]).join(","));
      return null;
    },
    faceSearches: () => false,
    setRelative: (patch) => {
      calls.push(Object.keys(patch).map((k) => k + "=" + patch[k]).join(","));
      return patch;
    },
  };
  const panel = SP.mount({ panel: panelEl, stage, overlay: null, provenanceList: null, provenanceSummary: null }, handle, {
    document: dom.document,
  });
  return { dom, panel, calls, q: (sel) => panelEl.querySelector(sel) };
}

function panelSearch(lit, relative) {
  const results = [{ id: "p1", index: 1, rank: 1, embeddingRank: 1, plainRank: 1, distance: 0.1, plainDistance: 0.1, gap: 0, moved: 0, score: null, text: "one" }];
  const out = {
    active: true,
    waiting: false,
    stale: false,
    staleBy: 0,
    measure: "cosine distance (1 minus cosine similarity)",
    settings: { k: 8, lit, distances: false, rerank: false, pointOfView: null, onlyResults: false },
    embedder: { available: true },
    reranker: { available: false, offered: false },
    litCount: 10,
    sharedCount: 0,
    unmatched: [],
    faceable: true,
    message: null,
    pairs: [],
    searches: [
      { letter: "A", kind: "embedded", text: "a text", model: "m/1", queryForm: null, sentTo: "embedder", reranker: null, words: null, point: null,
        pointOfView: false, k: 8, note: null, radius: 0.1, insideCount: 1, results },
    ],
  };
  if (relative !== undefined) {
    out.relative = {
      relative, showOrigin: false, offered: true, active: relative, settled: relative, measure: "cosine",
      unit: { unit: true, min: 1, max: 1, tolerance: 1e-4 }, pinned: relative ? [{ letter: "A", axis: "vertical", length: 1 }] : [],
      dropped: [], fixed: 0, free: 2, window: null, share: 0.2, subspace: 10, searches: [],
    };
  }
  return out;
}

test("the Lit menu has four options in order, the new one last with its label, and choosing it asks for lit all", () => {
  const t = buildPanel("tumble");
  t.panel.update(panelSearch("even", false));
  const sel = t.q(".tumbler-search-lit").querySelector("select");
  assert.deepStrictEqual(sel.children.map((o) => [o.value, textOf(o)]), [
    ["even", "the results, evenly"],
    ["close", "by closeness: nearer is brighter"],
    ["named", "named results only"],
    ["all", "everything, results highlighted"],
  ]);
  assert.strictEqual(sel.value, "even", "the default is unchanged");
  sel.value = "all";
  sel.dispatchEvent({ type: "change" });
  assert.deepStrictEqual(t.calls, ["lit=all"]);
  t.panel.update(panelSearch("all", false));
  assert.strictEqual(sel.value, "all", "it reports the setting");
});

test("the panel's words under all: the count is of results, and the note and the provenance say every other point is shown", () => {
  const s = panelSearch("all");
  assert.strictEqual(SP.summaryText(s), "A a text · 10 points lit");
  assert.ok(SP.noteText(s, {}).startsWith("10 points lit (every other point is shown too): 1 named result"), SP.noteText(s, {}));
  assert.ok(SP.usedText(s).includes(" · lit: everything, results highlighted · "), SP.usedText(s));
  // the other settings' words are as they were
  assert.ok(SP.noteText(panelSearch("even"), {}).startsWith("10 points lit: 1 named result"));
  assert.ok(SP.noteText(panelSearch("named"), {}).startsWith("10 points lit (named results only): "));
});

test("t22 (d9): Lit all leaves no disabled control behind: the panel has none for the rest, and Lit stays usable", () => {
  const t = buildPanel("tumble");
  for (const [lit, relative] of [["even", true], ["all", true], ["named", true], ["all", false]]) {
    t.panel.update(panelSearch(lit, relative));
    assert.strictEqual(t.q(".tumbler-search-rest"), null, lit);
    const sel = t.q(".tumbler-search-lit").querySelector("select");
    assert.ok(!sel.disabled, lit);
    assert.strictEqual(sel.value, lit);
  }
});

// ---------- the viewer: every view ----------

function setupSynthetic(mountOpts) {
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { seed: 3, mode: "tumble", paused: true, ...mountOpts });
  const v = h._viewer;
  h.update(makeSet({ n: 120, d: 16 }));
  const lit = recordLit(v);
  dom.frames(2);
  return { dom, el, h, v, lit, q: (sel) => el.querySelector(sel) };
}

for (const mode of ["tumble", "lattice", "wander", "focus"]) {
  test(`${mode}: the mount option and the handle reach all; results are uploaded at 1 and the rest at the constant`, async () => {
    const t = setupSynthetic({ mode, searchLit: "all", searchPanel: false });
    assert.strictEqual(t.h.searchSettings().lit, "all", "mount option searchLit");
    await until(t.dom, () => t.h.info().ready);
    const r = await settle(t.dom, t.h.setSearches([{ point: t.v.set.ids[0] }, { point: t.v.set.ids[1] }]));
    assert.strictEqual(r.ok, true, r.message);
    t.dom.frames(4);
    const results = assertUpload(t.lit.at(-1), t.v.search.lit.inside, REST32, "under all");
    const all = t.h.info().search;
    assert.strictEqual(all.settings.lit, "all");
    assert.strictEqual(all.litCount, results, "info().search.litCount counts results");
    // The handle: to even and back; the counts are the same under both.
    const even = (await settle(t.dom, t.h.setSearchSettings({ lit: "even" }))).search;
    assertUpload(t.lit.at(-1), t.v.search.lit.inside, 0, "under even");
    assert.strictEqual(even.litCount, all.litCount);
    assert.strictEqual(even.sharedCount, all.sharedCount);
    assert.deepStrictEqual(even.searches.map((q) => q.insideCount), all.searches.map((q) => q.insideCount));
    const back = await settle(t.dom, t.h.setSearchSettings({ lit: "all" }));
    assert.strictEqual(back.search.settings.lit, "all");
    assertUpload(t.lit.at(-1), t.v.search.lit.inside, REST32, "under all again");
    // unlitGain is the mode's business and is not changed by the setting
    t.dom.frames(2);
    if (mode !== "focus") assert.ok(!("unlitGain" in t.v.lastDraw), "unlitGain left at the renderer's default");
    t.h.destroy();
  });
}

test("the panel on a real viewer: choosing the fourth option reaches the viewer and the words follow", async () => {
  const t = setupSynthetic({ mode: "tumble" });
  await until(t.dom, () => t.h.info().ready);
  t.v.search.panel.setOpen(true);
  await settle(t.dom, t.h.setSearches([{ point: t.v.set.ids[0] }]));
  t.dom.frames(2);
  const before = t.h.info().search.litCount;
  const sel = t.q(".tumbler-search-lit").querySelector("select");
  assert.strictEqual(sel.children.length, 4);
  sel.value = "all";
  sel.dispatchEvent({ type: "change" });
  await until(t.dom, () => t.h.searchSettings().lit === "all" && !t.h.info().search.waiting);
  t.dom.frames(2);
  assert.strictEqual(t.h.info().search.litCount, before, "the count does not change: it counts results");
  assertUpload(t.lit.at(-1), t.v.search.lit.inside, REST32, "after the menu");
  assert.match(textOf(t.q(".tumbler-search-note")), /points lit \(every other point is shown too\)/);
  t.h.destroy();
});

test("Focus, Only results under all: Only results wins, the rest is uploaded at 0 and hidden; off, it is back at the constant", async () => {
  const t = setupSynthetic({ mode: "focus", searchLit: "all", searchPanel: false });
  await until(t.dom, () => t.h.info().ready && t.v.last !== null);
  await settle(t.dom, t.h.setSearches([{ point: t.v.set.ids[6] }]));
  await until(t.dom, () => t.v.mode.inst.describe().fittedTo === "results");
  t.dom.frames(4);
  assert.strictEqual(t.v.search.hideUnlit, false);
  assertUpload(t.lit.at(-1), t.v.search.lit.inside, REST32, "Only results off");
  await settle(t.dom, t.h.setSearchSettings({ onlyResults: true }));
  t.dom.frames(6);
  assert.strictEqual(t.v.search.hideUnlit, true);
  assert.strictEqual(t.v.lastDraw.unlitGain, 0, "Focus's own key for Only results");
  assertUpload(t.lit.at(-1), t.v.search.lit.inside, 0, "Only results on");
  // The viewer's own test of what is hidden follows the results, not the constant.
  const inside = t.v.search.lit.inside;
  for (let i = 0; i < inside.length; i++) {
    if (ET.viewer.hiddenPoint(t.h, i) !== (inside[i] === 0)) assert.fail("point " + i + " hidden wrongly");
  }
  const n = t.lit.length;
  t.dom.frames(6);
  assert.strictEqual(t.lit.length, n, "no upload while nothing changes");
  await settle(t.dom, t.h.setSearchSettings({ onlyResults: false }));
  t.dom.frames(6);
  assert.strictEqual(t.v.search.hideUnlit, false);
  assertUpload(t.lit.at(-1), t.v.search.lit.inside, REST32, "Only results off again");
  for (let i = 0; i < inside.length; i++) assert.strictEqual(ET.viewer.hiddenPoint(t.h, i), false);
  // Under even, hidden is as it always was: the unlit points.
  await settle(t.dom, t.h.setSearchSettings({ lit: "even", onlyResults: true }));
  t.dom.frames(6);
  for (let i = 0; i < inside.length; i++) {
    if (ET.viewer.hiddenPoint(t.h, i) !== (t.v.search.lit.lit[i] <= 0)) assert.fail("even: point " + i);
  }
  t.h.destroy();
});

// ---------- the viewer: the relative view ----------

const cache = {};
function fixture(name) {
  if (!cache[name]) {
    const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".json"), "utf8"));
    const buf = fs.readFileSync(path.join(FIX, meta.vectors.file));
    const n = meta.count * meta.dimension;
    const vectors = new Float32Array(n);
    for (let i = 0; i < n; i++) vectors[i] = buf.readFloatLE(i * 4);
    cache[name] = { meta, vectors };
  }
  const { meta, vectors } = cache[name];
  return { ...structuredClone({ ...meta, vectors: null }), vectors: new Float32Array(vectors) };
}

async function relativeRice(mountOpts) {
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { seed: 3, mode: "tumble", paused: true, searchPanel: false, relative: true, ...mountOpts });
  const v = h._viewer;
  const data = fixture("wikipedia-subset");
  h.update(data);
  const lit = recordLit(v);
  await until(dom, () => h.info().ready && !h.info().preparing);
  const ids = ["Rice", "Wheat"].map((n) => data.points.find((p) => p.label === n).id);
  const r = await settle(dom, h.setSearches(ids.map((point) => ({ point }))));
  assert.strictEqual(r.ok, true, r.message);
  await until(dom, () => h.info().search.relative.active && !h.info().preparing);
  h.seek(h.time() + TURN + 0.5);
  dom.frames(12);
  assert.strictEqual(h.info().search.relative.settled, true);
  return { dom, h, v, lit };
}

test("relative view: under all the rest is uploaded at the constant, not the gradient; another Lit setting brings the gradient back", async () => {
  const t = await relativeRice({ searchLit: "all" });
  assert.strictEqual(t.v.search.litRelative, true, "the relative view is shown");
  assert.ok(!("rest" in t.h.info().search.relative));
  const inside = t.v.search.lit.inside;
  const results = assertUpload(t.lit.at(-1), inside, REST32, "relative, all");
  assert.strictEqual(t.h.info().search.litCount, results);
  // Back to even: results exactly as they were, the rest on the gradient 0.2 + 0.6 g^2.
  await settle(t.dom, t.h.setSearchSettings({ lit: "even" }));
  t.dom.frames(2);
  const even = t.lit.at(-1);
  const [base, scale] = [0.2, 0.6];
  const seen = new Set();
  for (let i = 0; i < even.length; i++) {
    if (inside[i] > 0) {
      if (even[i] !== 1) assert.fail("result " + i + " is " + even[i]);
    } else {
      if (!(even[i] >= base - 1e-7 && even[i] <= base + scale + 1e-7)) assert.fail("point " + i + " is " + even[i]);
      seen.add(even[i]);
    }
  }
  assert.ok(seen.size > 10, "a gradient again: " + seen.size + " distinct values");
  // And to all again, then relative off: still the constant (the plain view's values).
  await settle(t.dom, t.h.setSearchSettings({ lit: "all" }));
  t.dom.frames(2);
  assertUpload(t.lit.at(-1), inside, REST32, "relative, all again");
  t.h.setRelative({ relative: false });
  t.dom.frames(2);
  assert.strictEqual(t.v.search.litRelative, false);
  assertUpload(t.lit.at(-1), inside, REST32, "plain view, all");
  t.h.destroy();
});
