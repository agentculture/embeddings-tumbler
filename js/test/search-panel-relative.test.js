"use strict";
// Task t8 of the relative-search plan: the search panel's controls and words for the
// relative view (docs/relative-interface.md, "Search panel (t8)"). The panel is built from
// source on the fake DOM with a hand-made handle and fed the shape of info().search.relative
// by hand; the viewer side is a later task.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");

const api = loadSources(["45-search-panel.js"]);
const SP = api._internal.searchPanel;

const textOf = (el) => (el ? el.textContent : null);

function fixture(name) {
  const dir = path.join(ROOT, "tests", "fixtures", "relative");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, name + ".json"), "utf8"));
  const buf = fs.readFileSync(path.join(dir, name + ".f32"));
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { meta, all, D: meta.dimension };
}

function row(f, i) {
  return f.all.subarray(i * f.D, (i + 1) * f.D);
}

function dot(a, b) {
  let s = 0;
  for (let k = 0; k < a.length; k++) s += a[k] * b[k];
  return s;
}

// Mount the panel with a handle that records setRelative and reports the given mode.
function build(mode) {
  const dom = makeFakeDom();
  const host = dom.host();
  const panelEl = dom.document.createElement("div");
  const stage = dom.document.createElement("div");
  host.appendChild(stage);
  host.appendChild(panelEl);
  const calls = [];
  const state = { mode };
  const handle = {
    mode: () => state.mode,
    clearSearches: () => true,
    setSearches: () => null,
    setSearchSettings: () => null,
    faceSearches: () => false,
    setRelative: (patch) => {
      calls.push(Object.keys(patch).map((k) => k + "=" + patch[k]).join(","));
      return patch;
    },
  };
  const panel = SP.mount({ panel: panelEl, stage, overlay: null, provenanceList: null, provenanceSummary: null }, handle, {
    document: dom.document,
  });
  return { dom, panelEl, panel, calls, state, q: (sel) => panelEl.querySelector(sel) };
}

function result(index, rank, text) {
  return { id: "p" + index, index, rank, embeddingRank: rank, plainRank: rank, distance: 0.1 * rank, plainDistance: 0.1 * rank, gap: 0, moved: 0, score: null, text };
}

function oneSearch(letter, results) {
  return {
    letter,
    kind: "embedded",
    text: letter.toLowerCase() + " text",
    model: "m/1",
    queryForm: null,
    sentTo: "embedder",
    reranker: null,
    words: null,
    point: null,
    pointOfView: false,
    k: 8,
    note: null,
    radius: 0.1,
    insideCount: results.length,
    results,
  };
}

function search(extra, searches) {
  return {
    active: searches.length > 0,
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
    searches,
    ...extra,
  };
}

function relState(extra) {
  return {
    relative: true,
    showOrigin: false,
    offered: true,
    active: true,
    settled: true,
    measure: "cosine",
    unit: { unit: true, min: 1, max: 1, tolerance: 1e-4 },
    pinned: [{ letter: "A", axis: "vertical", length: 1 }],
    dropped: [],
    fixed: 0,
    free: 2,
    window: null,
    share: 0.2,
    subspace: 10,
    searches: [],
    ...extra,
  };
}

// ---------- acceptance 1: the controls ----------

test("Relative and Show the origin: first in the controls row, shown in Tumble only, reporting their state", () => {
  const t = build("tumble");
  t.panel.update(search({ relative: relState({ relative: false }) }, [oneSearch("A", [result(1, 1, "one")])]));
  const row0 = t.q(".tumbler-search-controls");
  const kids = row0.children;
  assert.strictEqual(kids[0].className, "tumbler-search-relative");
  assert.strictEqual(kids[1].className, "tumbler-search-origin");
  assert.strictEqual(kids[2].className, "tumbler-search-face");
  const rel = t.q(".tumbler-search-relative");
  const org = t.q(".tumbler-search-origin");
  assert.strictEqual(rel.querySelector("input").type, "checkbox");
  assert.match(textOf(rel), /Relative/);
  assert.match(textOf(org), /Show the origin/);
  assert.strictEqual(rel.hidden, false);
  assert.strictEqual(org.hidden, false);
  assert.match(rel.title, /^One axis is the search itself; height is measured along it\. The other axes tumble through what is left\.$/);
  assert.match(org.title, /^Zoom out to the all-zero vector, or, in the plain view, mark where it falls\.$/);
  // The checkboxes follow the settings.
  const ri = rel.querySelector("input");
  const oi = org.querySelector("input");
  assert.strictEqual(ri.checked, false);
  t.panel.update(search({ relative: relState({ relative: true, showOrigin: true }) }, []));
  assert.deepStrictEqual([ri.checked, oi.checked], [true, true]);
  // A change calls back, one key at a time.
  ri.checked = false;
  ri.dispatchEvent({ type: "change" });
  oi.checked = false;
  oi.dispatchEvent({ type: "change" });
  ri.checked = true;
  ri.dispatchEvent({ type: "change" });
  assert.deepStrictEqual(t.calls, ["relative=false", "showOrigin=false", "relative=true"]);
});

test("Relative and Show the origin are hidden outside Tumble, and the row still starts with them", () => {
  for (const mode of ["lattice", "wander", "focus", null]) {
    const t = build(mode);
    t.panel.update(search({}, [oneSearch("A", [result(1, 1, "one")])]));
    assert.strictEqual(t.q(".tumbler-search-relative").hidden, true, String(mode));
    assert.strictEqual(t.q(".tumbler-search-relative").style.display, "none", String(mode));
    assert.strictEqual(t.q(".tumbler-search-origin").hidden, true, String(mode));
    assert.strictEqual(t.q(".tumbler-search-face").hidden, false, "Face the searches stays: " + mode);
  }
  // The mode changing under a frame's drawing brings them in and takes them out.
  const t = build("lattice");
  t.panel.update(search({}, [oneSearch("A", [result(1, 1, "one")])]));
  t.panel.drawOverlay({ strokeStyle: "" }, () => ({ x: 1, y: 1 }), { mode: "tumble", filter: 0 });
  assert.strictEqual(t.q(".tumbler-search-relative").hidden, false);
  t.panel.drawOverlay({ strokeStyle: "" }, () => ({ x: 1, y: 1 }), { mode: "wander", filter: 0 });
  assert.strictEqual(t.q(".tumbler-search-relative").hidden, true);
});

test("Show the origin works with no search at all, and with no relative state the panel is as before", () => {
  const t = build("tumble");
  t.panel.update(search({}, []));
  const oi = t.q(".tumbler-search-origin").querySelector("input");
  assert.strictEqual(t.q(".tumbler-search-origin").hidden, false);
  assert.strictEqual(oi.checked, false);
  oi.checked = true;
  oi.dispatchEvent({ type: "change" });
  assert.deepStrictEqual(t.calls, ["showOrigin=true"]);
  assert.strictEqual(SP.relativeNoteText(search({}, [])), "");
  assert.strictEqual(SP.relativeNoteText(null), "");
  assert.ok(!SP.noteText(search({}, [oneSearch("A", [])]), {}).includes("axis"));
});

// ---------- acceptance 2: Face the searches ----------

test("with relative on, Face the searches is not in the panel; off brings it back", () => {
  const t = build("tumble");
  const s = [oneSearch("A", [result(1, 1, "one")])];
  t.panel.update(search({}, s));
  const face = t.q(".tumbler-search-face");
  assert.strictEqual(face.hidden, false);
  t.panel.update(search({ relative: relState({ relative: true }) }, s));
  assert.strictEqual(face.hidden, true);
  assert.strictEqual(face.style.display, "none");
  t.panel.update(search({ relative: relState({ relative: false }) }, s));
  assert.strictEqual(face.hidden, false);
  assert.notStrictEqual(face.style.display, "none");
  // Relative on outside Tumble does not hide it (the setting is kept but not offered).
  const l = build("lattice");
  l.panel.update(search({ relative: relState({ relative: true, offered: false }) }, s));
  assert.strictEqual(l.q(".tumbler-search-face").hidden, false);
});

// ---------- acceptance 3: the numbers in a result row ----------

function heightsFor(f, qi, rows) {
  const qv = row(f, qi);
  const len = Math.sqrt(dot(qv, qv));
  const u = Float32Array.from(qv, (x) => x / len);
  return rows.map((i) => {
    const v = row(f, i);
    const h = dot(v, u);
    return { index: i, id: "p" + i, height: h, cosine: h / Math.sqrt(dot(v, v)) };
  });
}

function listed(t, f, qi, rows, measure, unit) {
  const rs = rows.map((i, r) => result(i, r + 1, "item " + i));
  const heights = heightsFor(f, qi, rows);
  t.panel.update(
    search(
      { relative: relState({ measure, unit: { unit, min: 0.35, max: 1, tolerance: 1e-4 }, searches: [{ letter: "A", results: heights }] }) },
      [oneSearch("A", rs)]
    )
  );
  const t0 = t.panelEl.querySelectorAll(".tumbler-search-meta").map(textOf);
  return { metas: t0, heights };
}

test("mixed-length set: every named result shows length along the search and cosine, never the height called cosine", () => {
  const f = fixture("mixed-length");
  const t = build("tumble");
  const lens = [];
  for (let i = 0; i < f.meta.count; i++) lens.push([i, Math.sqrt(dot(row(f, i), row(f, i)))]);
  lens.sort((a, b) => a[1] - b[1]);
  const rows = lens.slice(0, 4).map((x) => x[0]); // the shortest vectors: height and cosine differ most
  const { metas, heights } = listed(t, f, lens[lens.length - 1][0], rows, "length along the search", false);
  assert.strictEqual(metas.length, 4);
  metas.forEach((m, i) => {
    assert.strictEqual(m, "length along the search " + heights[i].height.toFixed(3) + " · cosine " + heights[i].cosine.toFixed(3));
    assert.strictEqual(m.match(/cosine/g).length, 1, "the word cosine is only for the cosine");
    assert.ok(!/cosine\s+\S*\s*·/.test(m));
  });
  assert.ok(heights.some((h) => Math.abs(h.height - h.cosine) > 0.01), "the fixture's lengths make the two differ");
});

test("unit-length set: the height is called cosine, once, three decimals", () => {
  const f = fixture("wikipedia-subset");
  const t = build("tumble");
  const { metas, heights } = listed(t, f, 0, [1, 2, 3], "cosine", true);
  assert.strictEqual(metas.length, 3);
  metas.forEach((m, i) => {
    assert.strictEqual(m, "cosine " + heights[i].cosine.toFixed(3));
    assert.ok(!/length along the search/.test(m));
  });
});

test("rows keep their existing parts first and add the relative text after them; off, nothing is added", () => {
  const t = build("tumble");
  const rs = [result(1, 1, "one"), { ...result(2, 2, "two"), gap: 0.01 }];
  const s = oneSearch("A", rs);
  const rel = relState({ searches: [{ letter: "A", results: [{ index: 1, id: "p1", height: 0.9, cosine: 0.9 }, { index: 2, id: "p2", height: 0.8, cosine: 0.8 }] }] });
  t.panel.update(search({ settings: { k: 8, lit: "even", distances: true, rerank: false, pointOfView: null }, relative: rel }, [s]));
  const metas = t.panelEl.querySelectorAll(".tumbler-search-meta").map(textOf);
  assert.strictEqual(metas[1], "distance 0.200 · +0.010 farther than the nearest · cosine 0.800");
  t.panel.update(search({ settings: { k: 8, lit: "even", distances: true, rerank: false, pointOfView: null }, relative: { ...rel, active: false } }, [s]));
  const off = t.panelEl.querySelectorAll(".tumbler-search-meta").map(textOf);
  assert.strictEqual(off[1], "distance 0.200 · +0.010 farther than the nearest");
});

// ---------- acceptance 4: the notes ----------

const NO_DIRECTION = "Search B has no direction (its vector has length zero), so it pins no axis.";
const SAME = "Search B points the same way as A, so it adds no axis. It is still lit.";
const FOURTH = "Search D is lit but has no axis: the first three searches pin all three.";
const SMALL = "This set is too small for the free axes to follow its spread: 1 of 2 are fixed directions, not fitted ones.";

test("a zero-length, a repeated and a fourth search each show their message in the panel's note", () => {
  const t = build("tumble");
  const s = [oneSearch("A", [result(1, 1, "one")])];
  const cases = [
    [[{ letter: "B", reason: "zero-length", against: [] }], NO_DIRECTION],
    [[{ letter: "B", reason: "same-direction", against: ["A"] }], SAME],
    [[{ letter: "D", reason: "no-axis-left", against: ["A", "B", "C"] }], FOURTH],
  ];
  for (const [dropped, expected] of cases) {
    const sr = search({ relative: relState({ dropped }) }, s);
    t.panel.update(sr);
    const note = textOf(t.q(".tumbler-search-note"));
    assert.ok(note.includes(expected), expected + " in: " + note);
    assert.strictEqual(SP.relativeNoteText(sr), expected);
    assert.ok(SP.noteText(sr, {}).includes(expected));
  }
});

test("notes: letter order, two letters joined with and, too-small set, joined by a space, empty when not shown", () => {
  const dropped = [
    { letter: "C", reason: "same-direction", against: ["A", "B"] },
    { letter: "B", reason: "zero-length", against: [] },
  ];
  const sr = search({ relative: relState({ dropped, fixed: 1 }) }, [oneSearch("A", [])]);
  assert.strictEqual(
    SP.relativeNoteText(sr),
    NO_DIRECTION + " Search C points the same way as A and B, so it adds no axis. It is still lit. " + SMALL
  );
  const small = search({ relative: relState({ fixed: 1 }) }, [oneSearch("A", [])]);
  assert.strictEqual(SP.relativeNoteText(small), SMALL);
  assert.strictEqual(SP.relativeNoteText(search({ relative: relState({ relative: false, dropped, fixed: 1 }) }, [])), "");
  assert.strictEqual(SP.relativeNoteText(search({ relative: relState({ offered: false, dropped }) }, [])), "");
  assert.strictEqual(SP.relativeNoteText(search({ relative: relState({}) }, [])), "");
});

// ---------- colours by letter, and the overlay ----------

function recordingCtx() {
  const calls = [];
  const ctx = {
    calls,
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    arc: () => calls.push("arc"),
    stroke: () => calls.push("stroke:" + ctx.strokeStyle),
  };
  return ctx;
}

test("colours and result lists follow the search's letter, not its place in the list", () => {
  const t = build("tumble");
  const only = search({}, [oneSearch("B", [result(1, 1, "one")])]);
  t.panel.update(only);
  const summary = t.q("details").children[0];
  assert.match(summary.style.color, /--tumbler-search-2/);
  assert.match(t.q(".tumbler-search-rank").style.color, /--tumbler-search-2/);
  assert.strictEqual(textOf(t.q(".tumbler-search-rank")), "B1");
  // The overlay strokes the ring in B's colour.
  const D = 4;
  const set = { dimension: D, count: 2, vectors: new Float32Array(2 * D), labels: [] };
  const dom = makeFakeDom();
  const host = dom.host();
  const panelEl = dom.document.createElement("div");
  const stage = dom.document.createElement("div");
  host.appendChild(stage);
  host.appendChild(panelEl);
  const handle = { mode: () => "tumble", clearSearches() {}, setSearches() {}, setSearchSettings() {}, faceSearches() {} };
  const panel = SP.mount({ panel: panelEl, stage, overlay: null, provenanceList: null, provenanceSummary: null }, handle, {
    document: dom.document,
    data: () => set,
  });
  panel.update(only);
  const ctx = recordingCtx();
  assert.strictEqual(panel.drawOverlay(ctx, () => ({ x: 5, y: 5 }), { queries: [new Float32Array(D)], filter: 1, dpr: 1, mode: "tumble" }), true);
  const strokes = ctx.calls.filter((c) => c.startsWith("stroke:"));
  assert.ok(strokes.length > 0);
  assert.ok(strokes.every((c) => c === "stroke:" + SP.COLOURS.dark[1]), strokes.join(","));
});

test("frame.relative: rings and letters are drawn, links and result labels are not; off is as today", () => {
  const D = 4;
  const vectors = new Float32Array(3 * D);
  vectors[D] = 1;
  vectors[2 * D + 1] = 1;
  const set = { dimension: D, count: 3, vectors, labels: [] };
  const sr = search({}, [oneSearch("A", [result(1, 1, "one"), result(2, 2, "two")])]);
  function draw(relative) {
    const dom = makeFakeDom();
    const host = dom.host();
    const panelEl = dom.document.createElement("div");
    const stage = dom.document.createElement("div");
    host.appendChild(stage);
    host.appendChild(panelEl);
    const handle = { mode: () => "tumble", clearSearches() {}, setSearches() {}, setSearchSettings() {}, faceSearches() {} };
    const panel = SP.mount({ panel: panelEl, stage, overlay: null, provenanceList: null, provenanceSummary: null }, handle, {
      document: dom.document,
      data: () => set,
    });
    panel.update(sr);
    const ctx = recordingCtx();
    const frame = { queries: [new Float32Array(D)], filter: 1, dpr: 1, labels: true, mode: "tumble" };
    if (relative !== undefined) frame.relative = relative;
    let n = 0;
    const project = () => ({ x: 10 + 120 * n++, y: 10 + 40 * n });
    assert.strictEqual(panel.drawOverlay(ctx, project, frame), true);
    const layer = stage.querySelector(".tumbler-search-labels");
    const shown = layer.children.filter((c) => c.style.display !== "none").map(textOf);
    return { lines: ctx.calls.filter((c) => c === "lineTo").length, arcs: ctx.calls.filter((c) => c === "arc").length, shown };
  }
  const on = draw(true);
  assert.strictEqual(on.lines, 0, "no links");
  assert.strictEqual(on.arcs, 1, "the ring");
  assert.deepStrictEqual(on.shown, ["A"], "the letter, no result labels");
  const off = draw(false);
  assert.strictEqual(off.lines, 2, "links with relative off");
  assert.ok(off.shown.includes("one") && off.shown.includes("two"));
  const absent = draw(undefined);
  assert.strictEqual(absent.lines, off.lines);
  assert.deepStrictEqual(absent.shown, off.shown);
});

test("labels and notes are inserted as text, never as markup", () => {
  const t = build("tumble");
  const evil = "<img src=x onerror=alert(1)>";
  const sr = search({ relative: relState({ dropped: [{ letter: evil, reason: "zero-length", against: [] }] }) }, [oneSearch("A", [result(1, 1, evil)])]);
  t.panel.update(sr);
  const note = t.q(".tumbler-search-note");
  assert.ok(textOf(note).includes(evil));
  assert.strictEqual(note.children.length, 0);
  assert.strictEqual(t.q(".tumbler-search-text").children.length, 0);
});
