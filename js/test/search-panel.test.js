"use strict";
// The search panel (task t9 of the search plan; docs/search-interface.md, "Panel (t9)";
// js/api/45-search-panel.md). Everything runs through the ASSEMBLED core file on the fake
// DOM: the panel is mounted by the real viewer, driven by events on its own controls, and
// checked through its DOM, the handle's info().search and the overlay's recorded calls.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadAssembled, SRC_DIR } = require("./helpers/load.js");
const { makeFakeDom, walk } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const ET = api._internal;
const SP = ET.searchPanel;

const tick = () => new Promise((r) => setImmediate(r));

async function until(dom, done, bound = 300) {
  for (let i = 0; i < bound && !done(); i++) {
    await tick();
    dom.frames(1);
  }
  await tick();
  assert.ok(done(), "condition not reached");
}

function setup(mountOpts, setOpts, hostStyle) {
  const dom = makeFakeDom();
  const el = dom.host();
  for (const [k, val] of Object.entries(hostStyle || {})) el.style.setProperty(k, val);
  const h = api.mount(el, { seed: 3, mode: "tumble", ...mountOpts });
  const v = h._viewer;
  if (setOpts !== null) h.update(makeSet({ n: 120, d: 16, ...setOpts }));
  dom.frames(2);
  return { dom, el, h, v, q: (sel) => el.querySelector(sel), all: (sel) => el.querySelectorAll(sel) };
}

async function ready(t) {
  await until(t.dom, () => t.h.info().ready);
}

// Type into the box and let the pause run out.
async function type(t, value) {
  const box = t.q(".tumbler-search-input");
  box.value = value;
  box.dispatchEvent({ type: "input" });
  t.dom.advance(200);
  t.dom.runTimers();
  await until(t.dom, () => !t.h.info().search.waiting);
}

async function settled(t) {
  await until(t.dom, () => !t.h.info().search.waiting);
  t.dom.frames(2);
}

function rowOf(set, i) {
  return Float32Array.from(set.vectors.subarray(i * set.dimension, (i + 1) * set.dimension));
}

const textOf = (el) => (el ? el.textContent : null);

// ---------- pure text ----------

test("summaryText: nothing searched, searches with the lit count, waiting and stale", () => {
  assert.strictEqual(SP.summaryText(null), "nothing searched: every point is shown");
  assert.strictEqual(SP.summaryText({ active: false, waiting: true, searches: [] }), "working out the search \u00b7 waiting");
  const s = {
    active: true,
    waiting: false,
    stale: true,
    staleBy: 40,
    litCount: 1204,
    searches: [
      { letter: "A", text: "tide harbor" },
      { letter: "B", text: "reef kelp" },
    ],
  };
  assert.strictEqual(SP.summaryText(s), "A tide harbor \u00b7 B reef kelp \u00b7 1,204 points lit \u00b7 from before 40 new points");
  assert.strictEqual(SP.summaryText({ ...s, stale: false, staleBy: 1, waiting: true }), "A tide harbor \u00b7 B reef kelp \u00b7 1,204 points lit \u00b7 waiting");
  assert.strictEqual(SP.summaryText({ ...s, staleBy: 1 }).endsWith("from before 1 new point"), true);
  assert.strictEqual(SP.thousands(1234567), "1,234,567");
  assert.strictEqual(SP.thousands(-1000), "-1,000");
  assert.strictEqual(SP.thousands(12), "12");
});

function fakeSearch(extra) {
  return {
    active: true,
    waiting: false,
    stale: false,
    staleBy: 0,
    measure: "cosine distance (1 minus cosine similarity)",
    settings: { k: 8, lit: "even", distances: false, rerank: false, pointOfView: null, onlyResults: false },
    embedder: { available: true },
    reranker: { available: false, offered: false },
    litCount: 10,
    sharedCount: 0,
    unmatched: [],
    faceable: true,
    message: null,
    pairs: [],
    searches: [],
    ...extra,
  };
}

function q(letter, kind, extra) {
  return {
    letter,
    kind,
    text: letter.toLowerCase() + " text",
    model: "m/1",
    queryForm: null,
    sentTo: kind === "embedded" ? "embedder" : "nowhere",
    reranker: null,
    words: kind === "words" ? { used: [{ word: "tide", how: "exact", count: 1 }, { word: "harb", how: "prefix", count: 2 }], unmatched: [] } : null,
    point: kind === "point" ? "p1" : null,
    pointOfView: false,
    k: 8,
    note: null,
    radius: 0.1,
    insideCount: 5,
    results: [
      { id: "p1", index: 1, rank: 1, embeddingRank: 1, plainRank: 1, distance: 0.01, plainDistance: 0.01, gap: 0, moved: 0, score: null, text: "one" },
      { id: "p2", index: 2, rank: 2, embeddingRank: 3, plainRank: 4, distance: 0.02, plainDistance: 0.03, gap: 0.01, moved: 1, score: null, text: "two" },
    ],
    ...extra,
  };
}

test("usedText names the measure, the counts, the lit setting, each query's model and where its text went", () => {
  assert.strictEqual(SP.usedText(null), "no search");
  const s = fakeSearch({
    settings: { k: 8, candidates: 50, top: 20, lit: "close", pointOfView: "A" },
    searches: [
      q("A", "embedded", { queryForm: "query", reranker: "r/1", sent: 50 }),
      q("B", "words"),
      q("C", "point"),
      q("D", "vector"),
    ],
  });
  const t = SP.usedText(s);
  // Both counts are stated: the candidates and how many the reranker kept (settings and per search).
  assert.match(t, /^cosine distance \(1 minus cosine similarity\) · the 50 nearest as candidates, the reranker's top 20 kept · lit: by closeness/);
  assert.match(t, /A "a text": embedded by m\/1 \(query form query\); text sent to the host's embedder; reranked by r\/1 \(top 2 of 50 candidates\): query and candidate texts sent to the reranker/);
  assert.match(t, /B "b text": words matched among the loaded points \(m\/1\); nothing sent; not reranked: the 2 nearest kept/);
  assert.match(t, /C "c text": the loaded point p1 \(m\/1\); nothing sent/);
  assert.match(t, /D "d text": a vector from the host \(m\/1\); nothing sent by the viewer/);
  assert.doesNotMatch(t, /no reranker/);
  assert.match(t, /point of view: A/);
  const plain = SP.usedText(fakeSearch({ settings: { k: 1, lit: "weird" }, searches: [q("A", "words")] }));
  assert.match(plain, /· the 1 nearest kept \(1 result per search\) · lit: the results, evenly/);
  assert.doesNotMatch(plain, /not reranked/);
  assert.match(plain, /no reranker$/);
});

test("noteText: the lit sentence, where the text went, notes, unmatched words, extra lines, refusals", () => {
  const one = fakeSearch({ litCount: 423, searches: [q("A", "words", { insideCount: 423, results: new Array(8).fill(q("A", "words").results[0]) })] });
  const t = SP.noteText(one, {});
  assert.match(t, /^423 points lit: 8 named results and every unnamed point as near as the last of them \(415\)\./);
  assert.match(t, /Searched among the loaded points: nothing was sent anywhere\./);
  assert.match(t, /Distances are cosine distance/);
  const many = fakeSearch({
    litCount: 9,
    sharedCount: 2,
    settings: { k: 2, lit: "close" },
    unmatched: ["zzz"],
    message: "A newer note.",
    stale: true,
    staleBy: 3,
    searches: [q("A", "embedded", { reranker: "r", note: "fell back", pointOfView: true }), q("B", "words", { insideCount: 2 })],
  });
  const m = SP.noteText(many, { extraLines: 2, refusal: "Refused.", focus: true });
  assert.match(m, /^9 points lit, nearer ones brighter\. A: 2 named results and 3 unnamed points as near as the last of them; B: 2 named results and no unnamed point as near as the last of them\. 2 points are inside more than one search\./);
  assert.match(m, /from before 3 new points/);
  assert.match(m, /The typed text was sent to the host's embedder\./);
  assert.match(m, /The query and the candidate texts were sent to the reranker\./);
  assert.match(m, /A is measured from its own point of view/);
  assert.match(m, /A: fell back/);
  assert.match(m, /Not found among the loaded points: zzz\./);
  assert.match(m, /Only the first four lines are searched; 2 lines are left out\./);
  assert.match(m, /A newer note\. Refused\./);
  assert.doesNotMatch(m, /Face the searches is off/);
  const focus = SP.noteText(fakeSearch({ faceable: false, settings: { lit: "named" }, searches: [q("A", "words")] }), { focus: true, extraLines: 1 });
  assert.match(focus, /\(named results only\)/);
  assert.match(focus, /Face the searches is off here/);
  assert.match(focus, /1 line is left out/);
  const none = SP.noteText({ active: false, embedder: { available: false }, searches: [] }, {});
  assert.match(none, /^Nothing searched: every point is shown\. No embedder is connected/);
  const idle = SP.noteText({ active: false, embedder: { available: true }, searches: [] }, {});
  assert.match(idle, /Typed text is sent to the host's embedder; nothing else leaves the page\./);
  const waiting = SP.noteText({ active: false, waiting: true, embedder: { available: true }, searches: [] });
  assert.match(waiting, /^Working out the searches/);
});

test("pairText and resultMeta carry what the picture shows, as text", () => {
  const s = fakeSearch({ searches: [q("A", "words"), q("B", "words", { results: [{ id: "p9", text: "nine" }] })] });
  const full = { a: "A", b: "B", shared: 12, common: 1, commonIds: ["p2"], closest: { a: "p1", b: "p9", distance: 0.1234 } };
  assert.strictEqual(
    SP.pairText(s, full, "marked white"),
    "A and B: 12 points found by both (marked white); 1 named result in common (two); closest pair of different results one and nine, 0.123 apart."
  );
  assert.strictEqual(SP.pairText(s, { a: "A", b: "B", shared: 0, common: 0, commonIds: [], closest: { a: "zz", b: "p9", distance: 1 } }, "w"), "A and B: no point found by both; closest pair of different results zz and nine, 1.000 apart.");
  const a = q("A", "words", { reranker: "r", pointOfView: true });
  assert.deepStrictEqual(SP.resultMeta(a, a.results[0], true), ["distance 0.010 from its point of view", "the nearest", "same place"]);
  assert.deepStrictEqual(SP.resultMeta(a, a.results[1], true), [
    "distance 0.020 from its point of view",
    "+0.010 farther than the nearest",
    "up 1 (was 3)",
    "plain distance had it at 4",
  ]);
  assert.deepStrictEqual(SP.resultMeta(a, { ...a.results[1], rank: 2, embeddingRank: 1, plainRank: 1 }, false), ["down 1 (was 1)"]);
  assert.deepStrictEqual(SP.resultMeta(a, { ...a.results[1], rank: 1, embeddingRank: 3, plainRank: 3 }, false), ["up 2 (was 3)"]);
  assert.deepStrictEqual(SP.resultMeta(q("A", "words"), a.results[1], false), []);
});

test("suggest: whole-line starts first, then word starts of the last word, at most eight, never the line itself", () => {
  const entries = ["tide", "tidal flat", "harbor tide", "riptide", "tidewater", "Tide"].map((t) => ({
    text: t,
    lower: t.toLowerCase(),
    words: t.toLowerCase().split(" "),
  }));
  assert.deepStrictEqual(SP.suggest(entries, "tid"), ["tide", "tidal flat", "tidewater", "Tide", "harbor tide"]);
  assert.deepStrictEqual(SP.suggest(entries, " Tide "), ["tidewater", "harbor tide"]);
  assert.deepStrictEqual(SP.suggest(entries, ""), []);
  assert.deepStrictEqual(SP.suggest(entries, "x t"), []); // a one-letter last word does not match word starts
  const many = Array.from({ length: 30 }, (_, i) => ({ text: "w" + i, lower: "w" + i, words: ["w" + i] }));
  assert.strictEqual(SP.suggest(many, "w").length, 8);
});

test("the default search colours read on their stages and keep apart from the readout axis colours", () => {
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const c of SP.COLOURS.dark) assert.ok(contrast(c, "#04060b") >= 7, c + " on the dark panel");
  for (const c of SP.COLOURS.light) {
    assert.ok(contrast(c, "#f6f4ee") >= 4.5, c + " on the light panel");
    assert.ok(contrast(c, "#ffffff") >= 4.5, c + " on white");
  }
  assert.ok(contrast(SP.COLOURS.sharedLight, "#f6f4ee") >= 4.5);
  assert.ok(contrast(SP.COLOURS.sharedDark, "#04060b") >= 7);
  assert.deepStrictEqual(SP.COLOURS.dark, ["#ffc56b", "#6be0ff", "#ff8fb3", "#b6ff8a"]);
  assert.deepStrictEqual(SP.COLOURS.light, ["#a35f00", "#00708a", "#b0245a", "#3d7a00"]);
});

test("the panel module parses no markup, injects no style attribute, and touches no head or body", () => {
  const text = fs.readFileSync(path.join(SRC_DIR, "45-search-panel.js"), "utf8");
  const banned = [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\s*\.\s*write/, /DOMParser/, /setAttribute\s*\(\s*["'`]style/, /cssText/, /createElement\s*\(\s*["'`]style/, /\.head\b/, /document\s*\.\s*body|doc\s*\.\s*body/, /(^|[^\w$])url\(/i, /fetch/, /XMLHttpRequest/, /fillText|strokeText/];
  for (const re of banned) assert.doesNotMatch(text, re);
  assert.match(text, /textContent/);
});

// ---------- the mounted panel ----------

test("collapsed by default: one bar with aria-expanded and aria-controls; opening and closing keeps the search", async () => {
  const t = setup();
  const section = t.v.panel.firstChild;
  assert.strictEqual(section.className, "tumbler-search");
  const bar = t.q(".tumbler-search-bar");
  const body = t.q(".tumbler-search-body");
  assert.strictEqual(bar.tagName, "BUTTON");
  assert.strictEqual(bar.getAttribute("aria-expanded"), "false");
  assert.strictEqual(bar.getAttribute("aria-controls"), body.id);
  assert.ok(body.id.startsWith("tumbler-search-body-"));
  assert.strictEqual(body.hidden, true);
  assert.strictEqual(body.style.display, "none");
  assert.strictEqual(textOf(t.q(".tumbler-search-summary")), "nothing searched: every point is shown");
  assert.strictEqual(t.q(".tumbler-search-mark").getAttribute("aria-hidden"), "true");
  const live = t.q(".tumbler-search-live");
  assert.strictEqual(live.getAttribute("aria-live"), "polite");
  assert.strictEqual(live.getAttribute("role"), "status");
  assert.strictEqual(t.q(".tumbler-search-labels"), null, "no stage layer before a search");
  await ready(t);
  bar.click();
  assert.strictEqual(bar.getAttribute("aria-expanded"), "true");
  assert.strictEqual(body.hidden, false);
  assert.strictEqual(textOf(t.q(".tumbler-search-mark")), "\u2212");
  assert.strictEqual(t.dom.document.activeElement, t.q(".tumbler-search-input"));
  await type(t, "word3\nword6");
  const s = t.h.info().search;
  assert.strictEqual(s.active, true);
  assert.deepStrictEqual(s.searches.map((x) => x.text), ["word3", "word6"]);
  assert.ok(s.litCount > 0);
  assert.match(textOf(t.q(".tumbler-search-summary")), /^A word3 · B word6 · \d+ points lit$/);
  assert.strictEqual(textOf(live), textOf(t.q(".tumbler-search-summary")));
  const panel = t.v.search.panel;
  assert.strictEqual(panel.isOpen(), true);
  bar.click();
  assert.strictEqual(bar.getAttribute("aria-expanded"), "false");
  assert.strictEqual(t.h.info().search.active, true, "closing keeps the search");
  assert.strictEqual(t.h.isPaused(), false, "closing does not pause");
  panel.setOpen(true);
  assert.strictEqual(body.hidden, false);
  t.h.destroy();
});

test("typing the same lines again sends nothing; an empty box clears; more than four lines are cut and said", async () => {
  const t = setup();
  await ready(t);
  let calls = 0;
  const real = t.h.setSearches;
  t.h.setSearches = function (list) {
    calls++;
    return real.call(this, list);
  };
  await type(t, "word3");
  await type(t, "  word3  \n\n");
  assert.strictEqual(calls, 1);
  await type(t, "word3\nword6\nword9\nword12\nword15\nword18");
  assert.strictEqual(t.h.info().search.searches.length, 4);
  assert.match(textOf(t.q(".tumbler-search-note")), /Only the first four lines are searched; 2 lines are left out\./);
  await type(t, "");
  assert.strictEqual(t.h.info().search.active, false);
  assert.strictEqual(textOf(t.q(".tumbler-search-summary")), "nothing searched: every point is shown");
  t.h.destroy();
});

test("words that match nothing are named; a refusal is shown in the note and can be retried", async () => {
  const t = setup();
  await ready(t);
  await type(t, "zzzqqq");
  const note = textOf(t.q(".tumbler-search-note"));
  assert.match(note, /None of these words matches/);
  assert.match(note, /No embedder is connected, so typed words are matched against the labels and texts of the loaded points, and nothing is sent\./);
  t.h.destroy();
});

test("with an embedder the note and the provenance say the text went to it; a failing embedder is shown", async () => {
  let fail = false;
  const t = setup({
    embed: (text) => {
      if (fail) throw new Error("secret-address");
      return { vector: rowOf(t.v.set, 9), model: "test/model", queryForm: "query", text };
    },
  });
  await ready(t);
  await type(t, "anything at all");
  const s = t.h.info().search;
  assert.strictEqual(s.searches[0].sentTo, "embedder");
  assert.match(textOf(t.q(".tumbler-search-note")), /The typed text was sent to the host's embedder\./);
  const dds = t.all(".tumbler-search-provenance-value");
  assert.strictEqual(dds.length, 1);
  assert.match(textOf(dds[0]), /embedded by test\/model \(query form query\); text sent to the host's embedder/);
  assert.match(textOf(t.q(".tumbler-search-provenance-clause")), /search: typed text sent to the host's embedder/);
  assert.strictEqual(t.q(".tumbler-search-provenance-term").parentNode, t.v.provList);
  // The viewer re-renders the provenance on an append; the row comes back.
  t.h.update(makeSet({ n: 3, d: 16, op: "append", idPrefix: "x", seed: 9 }));
  await settled(t);
  assert.strictEqual(t.q(".tumbler-search-provenance-term").parentNode, t.v.provList);
  assert.ok(t.v.provSummary.textContent.includes("search: typed text sent"));
  fail = true;
  await type(t, "something else");
  const note = textOf(t.q(".tumbler-search-note"));
  assert.match(note, /The embedder failed to answer/);
  assert.doesNotMatch(note, /secret-address/);
  t.h.destroy();
});

test("controls: Lit, Distance difference, Results, point of view and Clear go through setSearchSettings and back", async () => {
  const t = setup({}, { n: 240, labelEvery: 12 });
  await ready(t);
  t.v.search.panel.setOpen(true);
  await type(t, "word12\nword36");
  const lit = t.q(".tumbler-search-lit").querySelector("select");
  const before = t.h.info().search.litCount;
  lit.value = "named";
  lit.dispatchEvent({ type: "change" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().lit, "named");
  assert.notStrictEqual(t.h.info().search.litCount, before, "the Lit menu changes the lit count");
  assert.match(textOf(t.q(".tumbler-search-note")), /\(named results only\)/);
  const dist = t.q(".tumbler-search-distances").querySelector("input");
  dist.checked = true;
  dist.dispatchEvent({ type: "change" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().distances, true);
  const metas = t.all(".tumbler-search-meta").map(textOf);
  assert.ok(metas.some((m) => /^distance \d\.\d{3} · the nearest$/.test(m)), metas.join(" | "));
  assert.ok(metas.some((m) => /farther than the nearest/.test(m)));
  assert.ok(t.all(".tumbler-search-gap").length > 0);
  const k = t.q(".tumbler-search-k").querySelector("input");
  k.value = "5";
  k.dispatchEvent({ type: "input" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().k, 5);
  assert.strictEqual(t.h.info().search.searches[0].results.length, 5);
  assert.strictEqual(textOf(t.q(".tumbler-search-k").querySelector("output")), "5");
  const pov = t.q(".tumbler-search-pov").querySelector("select");
  assert.deepStrictEqual(pov.children.map((o) => o.value), ["", "A", "B"]);
  assert.match(textOf(pov.children[1]), /^A · word12$/);
  pov.value = "B";
  pov.dispatchEvent({ type: "change" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().pointOfView, "B");
  assert.strictEqual(t.h.info().search.searches[1].pointOfView, true);
  assert.match(textOf(t.q(".tumbler-search-note")), /B is measured from its own point of view/);
  pov.value = "";
  pov.dispatchEvent({ type: "change" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().pointOfView, null);
  // A host's settings change shows in the controls.
  t.h.setSearchSettings({ lit: "close", k: 7 });
  await settled(t);
  assert.strictEqual(lit.value, "close");
  assert.strictEqual(k.value, "7");
  t.q(".tumbler-search-clear").click();
  assert.strictEqual(t.h.info().search.active, false);
  assert.strictEqual(t.q(".tumbler-search-input").value, "");
  assert.strictEqual(pov.disabled, true);
  t.h.destroy();
});

test("result lists are real lists, closed until opened, and stay open across updates", async () => {
  const t = setup();
  await ready(t);
  await type(t, "word3\nword6");
  const lists = t.all(".tumbler-search-list");
  assert.strictEqual(lists.length, 2);
  assert.strictEqual(lists[0].tagName, "DETAILS");
  assert.strictEqual(lists[0].open, false);
  assert.match(textOf(lists[0].querySelector("summary")), /^A · word3 · \d+ named results? and .* · words matched: word3$/);
  assert.strictEqual(lists[0].querySelector("summary").style.color, "var(--tumbler-search-1, #ffc56b)");
  const ol = lists[0].querySelector("ol");
  assert.ok(ol.children.length >= 3);
  assert.strictEqual(textOf(ol.children[0].querySelector(".tumbler-search-rank")), "A1");
  assert.strictEqual(textOf(ol.children[0].querySelector(".tumbler-search-text")), "word3");
  lists[1].open = true;
  t.h.setSearchSettings({ distances: true });
  await settled(t);
  const again = t.all(".tumbler-search-list");
  assert.notStrictEqual(again[1], lists[1], "rebuilt for the new setting");
  assert.strictEqual(again[1].open, true);
  assert.strictEqual(again[0].open, false);
  // An update that changes nothing leaves the lists as they are.
  t.v.search.panel.update(t.h.info().search);
  assert.strictEqual(t.all(".tumbler-search-list")[1], again[1]);
  t.h.destroy();
});

test("Reranker: absent with no rerank callback and for a labels-only set; present, named and moving with one", async () => {
  const none = setup();
  assert.strictEqual(none.q(".tumbler-search-rerank"), null);
  assert.strictEqual(none.q(".tumbler-search-candidates"), null, "no reranker: no Candidates");
  assert.strictEqual(none.q(".tumbler-search-top"), null, "no reranker: no Keep top");
  none.h.destroy();
  const rerank = (query, candidates) => ({ scores: candidates.map((c, i) => -i * (c === "word6" ? -5 : 1)), model: "rr/1" });
  const ids = setup({ rerank }, { text_included: false });
  assert.strictEqual(ids.q(".tumbler-search-rerank"), null, "labels-only: no Reranker");
  ids.h.destroy();
  const t = setup({ rerank });
  const label = t.q(".tumbler-search-rerank");
  assert.ok(label);
  // Candidates and Keep top sit beside the Reranker, before Distance difference (class names
  // compared, so a failure prints one line).
  assert.strictEqual(label.nextSibling.className, "tumbler-search-candidates");
  assert.strictEqual(label.nextSibling.nextSibling.className, "tumbler-search-top");
  assert.strictEqual(label.nextSibling.nextSibling.nextSibling.className, "tumbler-search-distances");
  await ready(t);
  await type(t, "word3");
  const box = label.querySelector("input");
  box.checked = true;
  box.dispatchEvent({ type: "change" });
  await settled(t);
  const s = t.h.info().search;
  assert.strictEqual(s.searches[0].reranker, "rr/1");
  assert.match(textOf(t.q(".tumbler-search-list").querySelector("summary")), /embedding order, then the reranker rr\/1 \(top 20 of 40 candidates\)/);
  assert.ok(t.all(".tumbler-search-meta").some((m) => /same place|up \d|down \d/.test(textOf(m))));
  assert.match(textOf(t.q(".tumbler-search-provenance-value")), /reranked by rr\/1 \(top 20 of 40 candidates\): query and candidate texts sent to the reranker/);
  // 40 named points, 50 candidates asked: the note says so
  assert.match(textOf(t.q(".tumbler-search-note")), /A: Only 40 named points can be results, so the reranker was given 40 candidates, not 50\./);
  t.h.setSearchCallbacks({ rerank: null });
  await settled(t);
  t.v.search.panel.update(t.h.info().search);
  assert.strictEqual(t.q(".tumbler-search-rerank"), null);
  assert.strictEqual(t.q(".tumbler-search-candidates"), null);
  assert.strictEqual(t.q(".tumbler-search-top"), null);
  t.h.destroy();
});

test("Face the searches: enabled with a search in a mode with face, disabled in Focus; Only results only in Focus", async () => {
  const t = setup();
  await ready(t);
  const face = t.q(".tumbler-search-face");
  assert.strictEqual(face.disabled, true, "nothing to face yet");
  const only = t.q(".tumbler-search-only");
  assert.strictEqual(only.style.display, "none");
  await type(t, "word3");
  assert.strictEqual(face.disabled, false);
  let faced = 0;
  const realFace = t.h.faceSearches;
  t.h.faceSearches = () => {
    faced++;
    return realFace();
  };
  face.click();
  assert.strictEqual(faced, 1);
  t.h.setMode("focus");
  await until(t.dom, () => t.h.info().ready);
  t.v.search.panel.update(t.h.info().search);
  assert.strictEqual(t.h.info().search.faceable, false);
  assert.strictEqual(face.disabled, true);
  assert.strictEqual(only.style.display, "inline-flex");
  const box = only.querySelector("input");
  box.checked = true;
  box.dispatchEvent({ type: "change" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().onlyResults, true);
  assert.match(textOf(t.q(".tumbler-search-note")), /Face the searches is off here/);
  t.h.destroy();
});

test("Focus: the ranked lists sit beside the stage; leaving Focus puts the layout back", async () => {
  const t = setup({ mode: "focus" });
  await ready(t);
  const root = t.v.root;
  const side = t.q(".tumbler-search-side");
  assert.ok(side, "Focus has the list beside the stage");
  assert.strictEqual(side.previousSibling, t.v.stage);
  assert.strictEqual(root.style.display, "flex");
  assert.strictEqual(root.style.flexWrap, "wrap");
  assert.strictEqual(t.v.stage.style.flex, "999 1 600px");
  assert.strictEqual(t.v.panel.style.flex, "1 1 100%");
  assert.strictEqual(textOf(side.querySelector(".tumbler-search-side-title")), "No search");
  assert.match(textOf(side.querySelector(".tumbler-search-side-empty")), /click a point to search from it/);
  await type(t, "word3");
  assert.strictEqual(textOf(side.querySelector(".tumbler-search-side-title")), "Nearest texts");
  assert.match(textOf(side.querySelector(".tumbler-search-side-sub")), /^\d+ named results, plain distance · cosine distance/);
  const items = side.querySelectorAll("li");
  assert.ok(items.length >= 3);
  assert.strictEqual(textOf(items[0].querySelector(".tumbler-search-text")), "word3");
  assert.strictEqual(t.q(".tumbler-search-results").style.display, "none", "no second copy under the stage in Focus");
  await type(t, "word3\nword6");
  assert.match(textOf(side.querySelector(".tumbler-search-side-sub")), /^A: \d+ named results, plain distance; B:/);
  assert.strictEqual(side.querySelectorAll(".tumbler-search-side-letter").length, 2);
  t.h.setMode("tumble");
  t.dom.frames(2);
  assert.strictEqual(side.parentNode, null);
  assert.strictEqual(root.style.display, "block");
  assert.strictEqual(t.v.stage.style.flex, "");
  assert.strictEqual(t.q(".tumbler-search-results").style.display, "flex");
  t.h.destroy();
});

test("in Focus a click on a point searches from it and the box shows the point's text", async () => {
  const t = setup({ mode: "focus" });
  await ready(t);
  t.h.setSearches([{ point: t.v.set.ids[6] }]);
  await settled(t);
  assert.strictEqual(t.q(".tumbler-search-input").value, "word6");
  // A host's text search does not overwrite what the person typed.
  t.q(".tumbler-search-input").value = "kept";
  t.h.setSearches(["word9"]);
  await settled(t);
  assert.strictEqual(t.q(".tumbler-search-input").value, "kept");
  t.h.destroy();
});

test("suggestions: typing lists named texts from the loaded points; clicking one searches for it", async () => {
  const t = setup({}, { labelFor: (i) => (i % 3 === 0 ? (i % 2 ? "harbor wall " : "tide pool ") + i : "") });
  await ready(t);
  t.v.search.panel.setOpen(true);
  const box = t.q(".tumbler-search-input");
  box.value = "tide";
  box.dispatchEvent({ type: "input" });
  const sug = t.q(".tumbler-search-suggest");
  assert.strictEqual(sug.hidden, false);
  const buttons = sug.querySelectorAll("button");
  assert.strictEqual(buttons.length, 8);
  assert.ok(buttons.every((b) => /^tide pool \d+$/.test(textOf(b))));
  assert.strictEqual(textOf(sug.firstChild), "suggestions from the loaded points");
  // the word-start rule: the last word "wa" starts "wall"
  box.value = "x\nharbor wa";
  box.dispatchEvent({ type: "input" });
  const chosen = textOf(sug.querySelectorAll("button")[0]);
  assert.match(chosen, /^harbor wall \d+$/);
  sug.querySelectorAll("button")[0].dispatchEvent({ type: "click" });
  assert.strictEqual(box.value, "x\n" + chosen);
  await settled(t);
  assert.deepStrictEqual(t.h.info().search.searches.map((s) => s.text), [chosen]);
  assert.match(t.h.info().search.unmatched.join(","), /x/);
  // a click on the container itself does nothing
  sug.dispatchEvent({ type: "click" });
  box.value = "";
  box.dispatchEvent({ type: "input" });
  assert.strictEqual(sug.hidden, true);
  t.h.destroy();
});

test("markup in labels, queries and results creates no element and shows as text", async () => {
  const evil = '<img src=x onerror="alert(1)"><b>bold</b>';
  const t = setup({}, { labelFor: (i) => (i % 3 === 0 ? evil + i : "") });
  await ready(t);
  const createdBefore = t.dom.document.created.length;
  t.v.search.panel.setOpen(true);
  await type(t, "img");
  const s = t.h.info().search;
  assert.strictEqual(s.active, true);
  const box = t.q(".tumbler-search-input");
  box.value = "<img";
  box.dispatchEvent({ type: "input" });
  t.h.setSearchSettings({ distances: true });
  await settled(t);
  const made = t.dom.document.created.slice(createdBefore);
  assert.ok(!made.includes("img"), "no img element");
  assert.ok(!made.includes("script"));
  const texts = t.all(".tumbler-search-text").map(textOf);
  assert.ok(texts.some((x) => x.startsWith(evil)), texts.join(" | "));
  assert.ok(walk(t.v.root).every((n) => n.tagName !== "IMG"));
  assert.ok(t.all(".tumbler-search-suggestion").some((b) => textOf(b).startsWith("<img")));
  assert.match(textOf(t.q(".tumbler-search-summary")), /^A img/);
  t.h.destroy();
});

test("the overlay: rings and links per search, labels as DOM text, overlaps left out, distances on links", async () => {
  const t = setup();
  await ready(t);
  await type(t, "word3\nword6");
  t.dom.frames(30); // the filter eases in
  const ctx = t.v.overlay.getContext("2d");
  const calls = ctx._rec.calls.map((c) => c[0]);
  assert.ok(calls.includes("arc"));
  assert.ok(calls.includes("lineTo"));
  const layer = t.q(".tumbler-search-labels");
  assert.ok(layer);
  assert.strictEqual(layer.getAttribute("aria-hidden"), "true");
  assert.strictEqual(layer.previousSibling, t.v.overlay);
  const shown = () => layer.children.filter((c) => c.style.display !== "none").map(textOf);
  assert.ok(shown().includes("A"));
  assert.ok(shown().includes("B"));
  assert.ok(shown().some((x) => /^word\d+$/.test(x)), shown().join(","));
  // Labels off: no result texts on the stage (the letters stay).
  t.v.labelsInput.checked = false;
  t.v.labelsInput.dispatchEvent({ type: "change" });
  t.dom.frames(2);
  assert.ok(!shown().some((x) => /^word/.test(x)));
  t.h.setSearchSettings({ distances: true });
  await settled(t);
  assert.ok(shown().some((x) => /^\d\.\d{3}$/.test(x)), shown().join(","));
  // Every label box was placed without overlap: a pile of identical positions keeps one.
  const panel = t.v.search.panel;
  const same = () => ({ x: 50, y: 50, scale: 1, depth: 0 });
  const queries = t.h.info().search.searches.map(() => new Float32Array(16));
  panel.drawOverlay(ctx, same, { queries, filter: 1, dpr: 1, labels: true, mode: "tumble" });
  const piled = shown();
  assert.ok(piled.length < 2 + 2 * 8, "overlapping labels are left out: " + piled.length);
  // No search, or a faded filter: nothing drawn and the labels hidden.
  assert.strictEqual(panel.drawOverlay(ctx, same, { queries, filter: 0.01, dpr: 1 }), false);
  assert.deepStrictEqual(shown(), []);
  assert.strictEqual(panel.drawOverlay(ctx, same, { queries: [new Float32Array(3)], filter: 1, dpr: 1 }), true);
  assert.strictEqual(panel.drawOverlay(ctx, () => ({ x: NaN, y: 0 }), { queries, filter: 1, dpr: 2, hidden: () => true }), true);
  t.h.clearSearches();
  t.dom.frames(2);
  assert.strictEqual(panel.drawOverlay(ctx, same, { queries, filter: 1 }), false);
  t.h.destroy();
});

test("the overlay in Focus draws ranks and a crosshair ring; the canvas colours come from the custom properties", async () => {
  const t = setup({ mode: "focus" }, undefined, { "--tumbler-search-1": "rgb(1, 2, 3)", "--tumbler-search-2": "ur" + "l(x)" });
  await ready(t);
  await type(t, "word3");
  t.dom.frames(30);
  const layer = t.q(".tumbler-search-labels");
  const shown = layer.children.filter((c) => c.style.display !== "none");
  assert.ok(shown.some((c) => textOf(c) === "A query"));
  assert.ok(shown.some((c) => textOf(c) === "1"));
  const ctx = t.v.overlay.getContext("2d");
  assert.ok(ctx._rec.calls.filter((c) => c[0] === "moveTo").length >= 2, "links and the crosshair");
  t.h.setSearches(["word3", "word6"]);
  await settled(t);
  t.dom.frames(30);
  const texts = layer.children.filter((c) => c.style.display !== "none").map(textOf);
  assert.ok(texts.includes("A1") || texts.includes("B1"), texts.join(","));
  t.h.destroy();
});

test("the light treatment: light defaults for the search colours, the theme's ink for text", async () => {
  const t = setup({}, undefined, { "--tumbler-background": "#f6f4ee" });
  await ready(t);
  assert.strictEqual(t.v.theme.light, true);
  await type(t, "word3\nword6");
  t.dom.frames(30);
  assert.strictEqual(t.q(".tumbler-search-list").querySelector("summary").style.color, "var(--tumbler-search-1, #a35f00)");
  assert.strictEqual(t.q(".tumbler-search-section") === null, true);
  assert.strictEqual(t.q(".tumbler-search").style.color, "rgb(91, 101, 120)");
  assert.strictEqual(t.q(".tumbler-search-input").style.color, "rgb(27, 33, 48)");
  const pair = t.q(".tumbler-search-pair");
  if (pair) {
    assert.match(textOf(pair), /marked in dark ink|no point found by both/);
    assert.strictEqual(pair.querySelector(".tumbler-search-shared-mark").style.color, "var(--tumbler-shared, #1b2130)");
  }
  // A theme change is picked up: dark again.
  t.el.style.setProperty("--tumbler-background", "#04060b");
  t.h.refreshTheme();
  t.v.search.panel.update(t.h.info().search);
  assert.strictEqual(t.q(".tumbler-search-list").querySelector("summary").style.color, "var(--tumbler-search-1, #ffc56b)");
  t.h.destroy();
});

test("pair lines report what both searches found, with the shared mark", async () => {
  const t = setup();
  await ready(t);
  await type(t, "word3\nword6");
  const pairs = t.all(".tumbler-search-pair");
  assert.strictEqual(pairs.length, 1);
  assert.match(textOf(pairs[0]), /^\u25c6 A and B: /);
  assert.strictEqual(pairs[0].querySelector(".tumbler-search-shared-mark").getAttribute("aria-hidden"), "true");
  t.h.destroy();
});

test("stale results are said in the bar and the note after an append", async () => {
  const t = setup();
  await ready(t);
  await type(t, "word3");
  let seen = null;
  const panel = t.v.search.panel;
  const real = panel.update;
  t.v.search.panel = {
    ...panel,
    update(s) {
      if (s.stale && !seen) seen = { bar: SP.summaryText(s), note: SP.noteText(s, {}) };
      return real(s);
    },
  };
  t.h.update(makeSet({ n: 4, d: 16, op: "append", idPrefix: "y", seed: 5 }));
  await settled(t);
  assert.ok(seen, "an update while stale");
  assert.match(seen.bar, /from before 4 new points/);
  assert.match(seen.note, /from before 4 new points; they are being worked out again/);
  t.h.destroy();
});

test("destroy removes the panel, its stage layer, its provenance row and every listener", async () => {
  const t = setup();
  await ready(t);
  await type(t, "word3");
  t.dom.frames(30);
  const panel = t.v.search.panel;
  const section = t.q(".tumbler-search");
  const layer = t.q(".tumbler-search-labels");
  const dt = t.q(".tumbler-search-provenance-term");
  t.h.destroy();
  assert.strictEqual(section.parentNode, null);
  assert.strictEqual(layer.parentNode, null);
  assert.strictEqual(dt.parentNode, null);
  assert.strictEqual(t.dom.listenerBalance(), 0);
  panel.destroy(); // twice is harmless
  assert.strictEqual(panel.drawOverlay(null, null, {}), false);
  panel.update(null);
});

test("mount on its own: a handle with no info and a theme getter that throws still builds the panel", () => {
  const dom = makeFakeDom();
  const host = dom.host();
  const panelEl = dom.document.createElement("div");
  const stage = dom.document.createElement("div");
  host.appendChild(stage);
  host.appendChild(panelEl);
  let cleared = 0;
  const handle = {
    mode() {
      throw new Error("no mode");
    },
    clearSearches() {
      cleared++;
      return true;
    },
    setSearches: () => null,
    setSearchSettings: () => null,
    faceSearches: () => false,
  };
  const panel = SP.mount({ panel: panelEl, stage, overlay: null, provenanceList: null, provenanceSummary: null }, handle, {
    document: dom.document,
    light: true,
    theme() {
      throw new Error("no theme");
    },
    data() {
      throw new Error("no data");
    },
  });
  assert.strictEqual(panelEl.firstChild.className, "tumbler-search");
  assert.strictEqual(textOf(panelEl.querySelector(".tumbler-search-summary")), "nothing searched: every point is shown");
  assert.strictEqual(panelEl.querySelector(".tumbler-search").style.color, "#5b6578", "light defaults with no theme");
  const box = panelEl.querySelector(".tumbler-search-input");
  box.value = "a\nb";
  box.dispatchEvent({ type: "input" });
  dom.advance(200);
  dom.runTimers();
  panelEl.querySelector(".tumbler-search-clear").click();
  assert.strictEqual(cleared, 1);
  const ctx = { strokeStyle: "", calls: [] };
  panel.update(fakeSearch({ searches: [q("A", "words")] }));
  assert.strictEqual(panel.drawOverlay(ctx, () => ({ x: 1, y: 1 }), { queries: [new Float32Array(2)], filter: 1 }), false, "no data, nothing drawn");
  panel.destroy();
  assert.strictEqual(panelEl.children.length, 0);
});

test("Candidates and Keep top: labelled ranges beside the Reranker that drive the handle", async () => {
  const seen = [];
  const rerank = (query, candidates) => {
    seen.push(candidates.length);
    return { scores: candidates.map((_, i) => i), model: "rr/2" };
  };
  const t = setup({ rerank }, { n: 600 }); // 200 named points
  await ready(t);
  const cand = t.q(".tumbler-search-candidates");
  const top = t.q(".tumbler-search-top");
  assert.match(textOf(cand), /^Candidates /);
  assert.match(textOf(top), /^Keep top /);
  const ci = cand.querySelector("input");
  const ti = top.querySelector("input");
  assert.deepStrictEqual([ci.type, ci.min, ci.max, ci.value], ["range", "3", "100", "50"]);
  assert.deepStrictEqual([ti.type, ti.min, ti.max, ti.value], ["range", "3", "50", "20"]);
  const k = t.q(".tumbler-search-k").querySelector("input");
  assert.strictEqual(k.max, "100", "Results goes to 100");
  assert.strictEqual(k.disabled, false);
  await type(t, "word3");
  const box = t.q(".tumbler-search-rerank").querySelector("input");
  box.checked = true;
  box.dispatchEvent({ type: "change" });
  await settled(t);
  assert.strictEqual(k.disabled, true, "with the reranker on, Keep top sets the results");
  assert.match(k.title, /Keep top sets how many results/);
  ci.value = "100";
  ci.dispatchEvent({ type: "input" });
  await settled(t);
  assert.strictEqual(t.h.searchSettings().candidates, 100);
  assert.strictEqual(textOf(cand.querySelector("output")), "100");
  assert.strictEqual(ti.max, "100");
  ti.value = "60";
  ti.dispatchEvent({ type: "input" });
  await settled(t);
  const s = t.h.info().search;
  assert.strictEqual(s.settings.top, 60);
  assert.strictEqual(seen.at(-1), 100, "the reranker got 100 candidates");
  assert.strictEqual(s.searches[0].results.length, 60);
  assert.match(textOf(t.q(".tumbler-search-provenance-value")), /the 100 nearest as candidates, the reranker's top 60 kept/);
  // lowering candidates under top cuts top, and the range follows
  t.h.setSearchSettings({ candidates: 30 }); // resolves as frames are pumped, by settled()
  await settled(t);
  t.v.search.panel.update(t.h.info().search);
  assert.deepStrictEqual([ti.max, ti.value, textOf(top.querySelector("output"))], ["30", "30", "30"]);
  t.h.destroy();
});

test("a 100-result list scrolls inside its own box", async () => {
  const t = setup({ searchK: 100 }, { n: 600 });
  await ready(t);
  await type(t, "word3");
  const list = t.q(".tumbler-search-list");
  const ol = list.querySelector("ol");
  assert.strictEqual(ol.children.length, 100);
  assert.strictEqual(ol.style.overflowY, "auto");
  assert.match(ol.style.maxHeight, /320px/);
  assert.match(textOf(list.querySelector("summary")), /^A · word3 · 100 named results/);
  t.h.destroy();
});
