"use strict";
// The viewer's relative setting (task t9 of the relative-search plan): mount options and
// handle methods, searches handed to Tumble, letters kept, info().search.relative, the
// status line and the provenance row, reranker failures, and the lit values with the
// gradient. Binding names: docs/relative-interface.md, "Viewer (t9, t10)".
//
// The viewer runs on the fake DOM and GPU of helpers/, loaded from the source modules
// (loadSources), so this file sees js/src/ without the assembled file being rebuilt. Large
// arrays and DOM nodes are never handed to an equality assertion: comparisons loop and
// report the first differing index, and DOM is compared by text.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");

const api = loadSources();
const ET = api._internal;
const FIX = path.join(ROOT, "tests", "fixtures", "relative");
const TURN = 1.5; // Tumble's relativeTransition

// ---------- data ----------

const cache = {};
// A fixture pair in the contract's in-memory form (vectors as a Float32Array).
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

function idOf(data, label) {
  const p = data.points.find((x) => x.label === label);
  assert.ok(p, "no point labelled " + label);
  return p.id;
}

function rowOf(set, i) {
  return set.vectors.slice(i * set.dimension, (i + 1) * set.dimension);
}

// ---------- driving the viewer ----------

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

// A viewer on the fake DOM, paused (the clock moves only by seek), with `name` loaded.
function setup(mountOpts, name = "wikipedia-subset") {
  const dom = makeFakeDom();
  const el = dom.host();
  const changes = [];
  const h = api.mount(el, {
    seed: 3,
    mode: "tumble",
    paused: true,
    searchPanel: false,
    onSearchChange: (s) => changes.push(s),
    ...mountOpts,
  });
  const v = h._viewer;
  const lit = [];
  const data = fixture(name);
  h.update(data);
  const realSetLit = v.renderer.setLit;
  v.renderer.setLit = function (l, s) {
    lit.push(l ? Float32Array.from(l) : null);
    return realSetLit.apply(this, arguments);
  };
  return { dom, h, v, lit, data, changes };
}

async function ready(t) {
  await until(t.dom, () => t.h.info().ready && !t.h.info().preparing);
}

// Search, then frames until the relative view is shown and its turn has ended.
async function searchAndSettle(t, list) {
  const r = await settle(t.dom, t.h.setSearches(list));
  assert.strictEqual(r.ok, true, r.message);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.h.seek(t.h.time() + TURN + 0.5);
  t.dom.frames(12); // a frame for the seek, and the status line (every 0.12 s)
  assert.strictEqual(t.h.info().search.relative.settled, true, "settled");
}

function sameBits(a, b, what) {
  assert.strictEqual(a.length, b.length, what + ": length");
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) assert.fail(`${what}: differs at ${i}: ${a[i]} vs ${b[i]}`);
  }
}

function provenanceRow(v, term) {
  const kids = v.provList.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName.toLowerCase() === "dt" && kids[i].textContent === term) return kids[i + 1].textContent;
  }
  return null;
}

function provenanceTerms(v) {
  return v.provList.children.filter((c) => c.tagName.toLowerCase() === "dt").map((c) => c.textContent);
}

function unitDirection(q) {
  let len = 0;
  for (let d = 0; d < q.length; d++) len += q[d] * q[d];
  len = Math.sqrt(len);
  return Array.from(q, (x) => x / len);
}

function dot(set, i, u) {
  const D = set.dimension;
  let s = 0;
  for (let d = 0; d < D; d++) s += set.vectors[i * D + d] * u[d];
  return s;
}

function ids(search, j = 0) {
  return search.searches[j].results.map((r) => r.id);
}

// Nothing in this file may reach the network: a fetch or XMLHttpRequest would land here.
const network = [];
globalThis.fetch = (...a) => {
  network.push(["fetch", String(a[0])]);
  return Promise.reject(new Error("no network in tests"));
};
globalThis.XMLHttpRequest = function () {
  network.push(["xhr"]);
};
test.after(() => {
  assert.deepStrictEqual(network, [], "no request was made");
});

// ---------- criterion 1: mount option and handle; plain Tumble with no search ----------

test("relative through the mount option pins the frame once a search exists", async () => {
  const t = setup({ relative: true });
  await ready(t);
  assert.deepStrictEqual(t.h.relativeSettings(), { relative: true, showOrigin: false });
  const rel0 = t.h.info().search.relative;
  assert.strictEqual(rel0.relative, true);
  assert.strictEqual(rel0.offered, true);
  assert.strictEqual(rel0.active, false);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  const rel = t.h.info().search.relative;
  assert.strictEqual(rel.active, true);
  assert.deepStrictEqual(
    rel.pinned.map((p) => [p.letter, p.axis]),
    [["A", "vertical"]],
  );
  // Row 1 of the frame drawn is the search's unit direction (o1).
  const D = t.v.set.dimension;
  const u = unitDirection(t.v.search.shown[0].query);
  const F = t.v.last.frame;
  let worst = 0;
  for (let d = 0; d < D; d++) worst = Math.max(worst, Math.abs(F[D + d] - u[d]));
  assert.ok(worst < 1e-6, "row 1 equals u, worst " + worst);
  t.h.destroy();
});

test("relative through the handle: on, kept across views and with no search; junk is ignored", async () => {
  const t = setup({});
  await ready(t);
  assert.deepStrictEqual(t.h.relativeSettings(), { relative: false, showOrigin: false });
  const before = t.changes.length;
  assert.deepStrictEqual(t.h.setRelative({ relative: true }), { relative: true, showOrigin: false });
  assert.strictEqual(t.changes.length, before + 1, "onSearchChange fires on a change");
  assert.strictEqual(t.changes.at(-1).relative.relative, true);
  assert.deepStrictEqual(t.h.setRelative({ relative: true }), { relative: true, showOrigin: false });
  assert.strictEqual(t.changes.length, before + 1, "no change, no call");
  assert.deepStrictEqual(t.h.setRelative({ relative: "yes", showOrigin: 1 }), { relative: true, showOrigin: false });
  assert.deepStrictEqual(t.h.setRelative(null), { relative: true, showOrigin: false });
  // t22 (d9): "rest" is no setting any more. It is a key the call does not know, ignored
  // like any other: nothing changes, nothing is reported, the host is not called.
  const n0 = t.changes.length;
  for (const value of ["faint", "visible", "bright", "dazzling", 1]) {
    assert.deepStrictEqual(t.h.setRelative({ rest: value }), { relative: true, showOrigin: false });
    assert.deepStrictEqual(t.h.setRelative({ rest: value, somethingElse: true }), { relative: true, showOrigin: false });
  }
  assert.strictEqual(t.changes.length, n0, "an unknown key changes nothing");
  assert.ok(!("rest" in t.h.info().search.relative), "info() reports no rest");
  assert.ok(!("rest" in t.h.relativeSettings()));
  // A setting is not a ranking: nothing is waiting, nothing superseded.
  assert.strictEqual(t.h.info().search.waiting, false);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  assert.deepStrictEqual(
    t.h.info().search.relative.pinned.map((p) => p.letter),
    ["A"],
  );
  // Another view keeps the setting but does not offer it.
  assert.strictEqual(t.h.setMode("lattice"), true);
  t.dom.frames(2);
  let rel = t.h.info().search.relative;
  assert.deepStrictEqual([rel.relative, rel.offered, rel.active, rel.searches.length], [true, false, false, 0]);
  // Back in Tumble the settings and the search are handed to the new instance.
  assert.strictEqual(t.h.setMode("tumble"), true);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  assert.strictEqual(t.v.mode.inst.describe().relative.relative, true);
  // Off: the view turns back; the setting is reported off.
  t.h.setRelative({ relative: false });
  t.dom.frames(2);
  rel = t.h.info().search.relative;
  assert.deepStrictEqual([rel.relative, rel.active], [false, false]);
  t.h.setRelative({ showOrigin: true });
  assert.deepStrictEqual(t.h.relativeSettings(), { relative: false, showOrigin: true });
  t.h.destroy();
  assert.deepStrictEqual(t.h.setRelative({ relative: true }), { relative: false, showOrigin: true }, "after destroy: the last settings");
  assert.deepStrictEqual(t.h.relativeSettings(), { relative: false, showOrigin: true });
});

test("with no search the setting is reported on and every frame equals plain Tumble's", async () => {
  const on = setup({ relative: true });
  const off = setup({ relative: false });
  await ready(on);
  await ready(off);
  for (const time of [0, 0.75, 3, 9.5]) {
    on.h.seek(time);
    off.h.seek(time);
    on.dom.frames(1);
    off.dom.frames(1);
    sameBits(on.v.last.frame, off.v.last.frame, "frame at " + time);
    sameBits(on.v.last.centre, off.v.last.centre, "centre at " + time);
    assert.strictEqual(on.v.lastDraw.zoom, off.v.lastDraw.zoom, "zoom at " + time);
    assert.strictEqual(on.v.lastDraw.perspective, off.v.lastDraw.perspective, "perspective at " + time);
  }
  on.dom.frames(10);
  off.dom.frames(10);
  assert.strictEqual(on.h.info().status, off.h.info().status);
  const rel = on.h.info().search.relative;
  assert.deepStrictEqual([rel.relative, rel.offered, rel.active, rel.settled], [true, true, false, false]);
  assert.strictEqual(rel.measure, "cosine", "the set is measured even with nothing pinned");
  assert.deepStrictEqual([rel.pinned.length, rel.dropped.length, rel.searches.length, rel.window, rel.share], [0, 0, 0, null, null]);
  assert.deepStrictEqual(provenanceTerms(on.v), provenanceTerms(off.v), "no Relative row");
  on.h.destroy();
  off.h.destroy();
});

// ---------- criterion 2: the status line and the provenance ----------

test("status and provenance on the unit-length set: cosine, the exact axes, the shadow kept", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  let status = t.h.info().status;
  assert.match(status, /^relative to A · vertical = cosine to A, exact · the other two axes tumble through \d+ directions holding \d+% of the remaining spread · paused$/);
  assert.ok(!status.includes("ranked by cosine"));
  let row = provenanceRow(t.v, "Relative");
  assert.ok(row, "a Relative row");
  assert.deepStrictEqual(provenanceTerms(t.v).slice(provenanceTerms(t.v).indexOf("View"), provenanceTerms(t.v).indexOf("View") + 2), ["View", "Relative"]);
  assert.match(row, /^The vertical axis is exact: height is cosine to A\. The other two axes tour \d+ directions holding \d+% of the spread the pinned axes leave: sideways position is still a shadow, and points side by side on screen can be far apart\. Every vector has length one \(within 0\.001\), which is why height is cosine similarity\.$/);
  assert.ok(t.v.provSummary.textContent.includes(" · relative to A"));
  assert.ok(t.v.provSummary.textContent.includes("a projection is a shadow of the space"));
  assert.ok(t.v.provShadow.textContent.length > 0, "the shadow sentence stays");

  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }, { point: idOf(t.data, "Wheat") }]);
  status = t.h.info().status;
  assert.ok(status.startsWith("relative to A and B · vertical = cosine to A, exact · the plane of A and B is shown exactly · depth tumbles through "), status);
  row = provenanceRow(t.v, "Relative");
  assert.ok(row.includes("The horizontal axis is exact too: it is the part of B that A does not contain, so the plane of A and B is shown exactly."), row);
  assert.ok(row.includes(" The depth axis tours "), row);
  assert.ok(t.v.provSummary.textContent.includes(" · relative to A and B"));

  // Point of view on: rank and height use different measures, in both places.
  await settle(t.dom, t.h.setSearchSettings({ pointOfView: "A" }));
  t.dom.frames(12);
  assert.ok(t.h.info().status.includes(" · with A's point of view, rank and height use different measures"), t.h.info().status);
  assert.ok(provenanceRow(t.v, "Relative").endsWith("With A's point of view on, its results are ranked in the scaled measure and height is not: rank and height use different measures."));

  // Relative off: the row and the summary's piece go.
  t.h.setRelative({ relative: false });
  t.dom.frames(12);
  assert.strictEqual(provenanceRow(t.v, "Relative"), null);
  assert.ok(!t.v.provSummary.textContent.includes("relative to"));
  assert.ok(!t.h.info().status.includes("relative to"));
  t.h.destroy();
});

test("status and provenance on the mixed-length set: length along the search, never cosine height", async () => {
  const t = setup({ relative: true }, "mixed-length");
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  const status = t.h.info().status;
  assert.ok(status.startsWith("relative to A · vertical = length along the search to A, exact · "), status);
  assert.ok(status.endsWith(" · ranked by cosine, so rank and height can disagree · paused"), status);
  const row = provenanceRow(t.v, "Relative");
  assert.ok(row.startsWith("The vertical axis is exact: height is length along the search to A. "), row);
  assert.match(row, /The vectors are not all of length one \(lengths \d+\.\d{3} to \d+\.\d{3}\), so height is length along the search, not cosine; results are still ranked by cosine, so rank and height can disagree\.$/);
  assert.ok(!row.includes("height is cosine"));
  assert.strictEqual(t.h.info().search.relative.measure, "length along the search");
  t.h.destroy();
});

// ---------- criterion 3: info().search.relative ----------

test("info() reports the setting, the pinned searches by letter, the measure, the window and the share", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }, { point: idOf(t.data, "Wheat") }]);
  const search = t.h.info().search;
  const rel = search.relative;
  assert.deepStrictEqual([rel.relative, rel.showOrigin, rel.offered, rel.active, rel.settled], [true, false, true, true, true]);
  assert.deepStrictEqual(
    rel.pinned.map((p) => [p.letter, p.axis]),
    [
      ["A", "vertical"],
      ["B", "horizontal"],
    ],
  );
  assert.ok(Math.abs(rel.pinned[0].length - 1) < 1e-3, "a point search's length on a unit-length set");
  assert.strictEqual(rel.measure, "cosine");
  assert.strictEqual(rel.unit.unit, true);
  assert.strictEqual(rel.unit.tolerance, 0.001);
  assert.deepStrictEqual(rel.dropped, []);
  for (const k of ["low", "high", "bottom", "top"]) assert.ok(Number.isFinite(rel.window[k]), k);
  assert.ok(rel.window.bottom < rel.window.low && rel.window.top > rel.window.high);
  assert.ok(rel.share > 0 && rel.share <= 1, "share " + rel.share);
  assert.ok(rel.subspace > 0);
  assert.strictEqual(rel.free, 1);
  assert.strictEqual(rel.fixed, 0);
  // The results' heights and cosines, aligned with the lists.
  assert.deepStrictEqual(
    rel.searches.map((s) => s.letter),
    ["A", "B"],
  );
  search.searches.forEach((q, j) => {
    const u = unitDirection(t.v.search.shown[j].query);
    assert.strictEqual(rel.searches[j].results.length, q.results.length);
    q.results.forEach((r, k) => {
      const x = rel.searches[j].results[k];
      assert.deepStrictEqual([x.index, x.id], [r.index, r.id]);
      assert.ok(Math.abs(x.height - dot(t.v.set, r.index, u)) < 1e-9, "height");
      assert.ok(Math.abs(x.cosine - (1 - r.plainDistance)) < 1e-12, "cosine");
    });
  });
  // The searched point itself is still the first result (ranking unchanged), at height 1.
  assert.strictEqual(search.searches[0].results[0].id, idOf(t.data, "Rice"));
  assert.ok(Math.abs(rel.searches[0].results[0].height - 1) < 1e-3);
  t.h.destroy();
});

test("a search pointing the same way as an earlier one is reported as dropped, by letter", async () => {
  const t = setup({ relative: true });
  await ready(t);
  const rice = idOf(t.data, "Rice");
  await searchAndSettle(t, [{ point: rice }, { point: rice }]);
  const rel = t.h.info().search.relative;
  assert.deepStrictEqual(
    rel.pinned.map((p) => p.letter),
    ["A"],
  );
  assert.deepStrictEqual(rel.dropped, [{ letter: "B", reason: "same-direction", against: ["A"] }]);
  assert.strictEqual(rel.free, 2);
  assert.strictEqual(ET.searchPanel.relativeNoteText(t.h.info().search), "Search B points the same way as A, so it adds no axis. It is still lit.");
  assert.ok(t.h.info().status.includes(" · B pins no axis"), t.h.info().status);
  t.h.destroy();
});

test("in the plain view with the setting on, a search with no direction is named as dropped", async () => {
  const dom = makeFakeDom();
  const h = api.mount(dom.host(), { seed: 3, mode: "tumble", paused: true, searchPanel: false, relative: true });
  const data = fixture("wikipedia-subset");
  const at = data.points.findIndex((p) => p.label === "Rice");
  data.vectors.fill(0, at * data.dimension, (at + 1) * data.dimension); // an all-zero row
  assert.strictEqual(h.update(data).ok, true);
  const t = { dom, h };
  await ready(t);
  const r = await settle(dom, h.setSearches([{ point: data.points[at].id }]));
  assert.strictEqual(r.ok, true, r.message);
  dom.frames(4);
  const rel = h.info().search.relative;
  assert.deepStrictEqual([rel.relative, rel.offered, rel.active], [true, true, false]);
  assert.deepStrictEqual(rel.dropped, [{ letter: "A", reason: "zero-length", against: [] }]);
  assert.strictEqual(ET.searchPanel.relativeNoteText(h.info().search), "Search A has no direction (its vector has length zero), so it pins no axis.");
  assert.strictEqual(rel.measure, "length along the search", "a zero row is not of length one");
  h.destroy();
});

// ---------- letters are kept while Relative is on ----------

test("letters are kept with Relative on: B stays B and is the vertical axis; pairs and point of view use letters", async () => {
  const t = setup({ relative: true });
  await ready(t);
  const rice = idOf(t.data, "Rice");
  const wheat = idOf(t.data, "Wheat");
  const maize = idOf(t.data, "Maize");
  await searchAndSettle(t, [{ point: rice }, { point: wheat }]);
  await searchAndSettle(t, [{ point: wheat }]);
  let s = t.h.info().search;
  assert.deepStrictEqual(
    s.searches.map((q) => [q.letter, q.point]),
    [["B", wheat]],
  );
  assert.deepStrictEqual(
    s.relative.pinned.map((p) => [p.letter, p.axis]),
    [["B", "vertical"]],
  );
  assert.ok(t.h.info().status.startsWith("relative to B · vertical = cosine to B, exact"));
  // A new entry takes the lowest free letter; the list stays in letter order.
  await searchAndSettle(t, [{ point: wheat }, { point: maize }]);
  s = t.h.info().search;
  assert.deepStrictEqual(
    s.searches.map((q) => [q.letter, q.point]),
    [
      ["A", maize],
      ["B", wheat],
    ],
  );
  assert.deepStrictEqual(
    s.pairs.map((p) => [p.a, p.b]),
    [["A", "B"]],
  );
  await settle(t.dom, t.h.setSearchSettings({ pointOfView: "B" }));
  s = t.h.info().search;
  assert.strictEqual(s.settings.pointOfView, "B");
  assert.deepStrictEqual(
    s.searches.map((q) => q.pointOfView),
    [false, true],
  );
  // Turning Relative off gives letters by position again (wheat stays B here) and keeps the
  // point of view on its search.
  await searchAndSettle(t, [{ point: wheat }]);
  assert.deepStrictEqual(t.h.info().search.searches.map((q) => q.letter), ["B"]);
  t.h.setRelative({ relative: false });
  s = t.h.info().search;
  assert.deepStrictEqual(s.searches.map((q) => q.letter), ["A"]);
  t.h.destroy();
});

test("letters stay positional with Relative off, as before", async () => {
  const t = setup({ relative: false });
  await ready(t);
  const rice = idOf(t.data, "Rice");
  const wheat = idOf(t.data, "Wheat");
  await settle(t.dom, t.h.setSearches([{ point: rice }, { point: wheat }]));
  await settle(t.dom, t.h.setSearches([{ point: wheat }]));
  assert.deepStrictEqual(t.h.info().search.searches.map((q) => [q.letter, q.point]), [["A", wheat]]);
  t.h.destroy();
});

test("a replace drops the searches as before and keeps the setting; an append re-runs them", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  // An append: the searches are worked out again, the letter and the pinned axis kept.
  const extra = fixture("mixed-length");
  const add = { ...extra, op: "append", count: 3, points: extra.points.slice(0, 3).map((p, i) => ({ ...p, id: "x" + i })), vectors: extra.vectors.slice(0, 3 * extra.dimension) };
  delete add.provenance;
  delete add.reduction;
  const r = t.h.update(add);
  assert.strictEqual(r.ok, true, r.message);
  await until(t.dom, () => !t.h.info().search.stale && !t.h.info().search.waiting && t.h.info().search.relative.active);
  assert.deepStrictEqual(t.h.info().search.searches.map((q) => q.letter), ["A"]);
  // A replace: no search, the setting kept and handed to the new instance.
  t.h.update(fixture("wikipedia-subset"));
  await ready(t);
  const s = t.h.info().search;
  assert.deepStrictEqual([s.active, s.searches.length, s.relative.relative, s.relative.active], [false, 0, true, false]);
  assert.strictEqual(t.v.mode.inst.describe().relative.relative, true);
  t.h.destroy();
});

// ---------- criterion 4: reranker failure, timeout, no text ----------

async function rerankCase(rerank, entry, opts) {
  const t = setup({ relative: true, rerank, ...opts });
  await ready(t);
  const plain = await settle(t.dom, t.h.setSearches([entry(t)]));
  const embeddingOrder = ids(plain.search);
  return { t, embeddingOrder };
}

function assertNoRanks(t, embeddingOrder, note) {
  const s = t.h.info().search;
  assert.deepStrictEqual(ids(s), embeddingOrder, "embedding order");
  assert.strictEqual(s.searches[0].reranker, null);
  assert.strictEqual(s.searches[0].note, note);
  const data = ET.viewer.relativeOverlayData(t.h);
  assert.ok(data.named.length > 0);
  assert.ok(
    data.named.every((n) => n.ranks.length === 0),
    "no rank reaches the overlay",
  );
  assert.strictEqual(data.cut, null, "no cut-off line");
  assert.ok(!t.h.info().status.includes("reranker"), t.h.info().status);
}

test("a reranker that fails keeps embedding order, no ranks reach the overlay, the existing note", async () => {
  const { t, embeddingOrder } = await rerankCase(
    () => {
      throw new Error("down");
    },
    (t) => ({ point: idOf(t.data, "Rice") }),
  );
  await settle(t.dom, t.h.setSearchSettings({ rerank: true }));
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.dom.frames(12);
  assertNoRanks(t, embeddingOrder, "The reranker failed to answer; the results stay in embedding order.");
  t.h.destroy();
});

test("a reranker that times out keeps embedding order, no ranks, the existing note", async () => {
  const { t, embeddingOrder } = await rerankCase(
    () => new Promise(() => {}),
    (t) => ({ point: idOf(t.data, "Rice") }),
    { searchTimeoutMs: 1000 },
  );
  const p = t.h.setSearchSettings({ rerank: true });
  await until(t.dom, () => t.dom.pendingTimers() > 0);
  t.dom.advance(1001);
  t.dom.runTimers();
  await settle(t.dom, p);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.dom.frames(12);
  assertNoRanks(t, embeddingOrder, "The reranker did not answer within 1 seconds; the results stay in embedding order.");
  t.h.destroy();
});

test("a vector search with no label is not reranked: embedding order, no ranks, the existing note", async () => {
  let called = 0;
  const { t, embeddingOrder } = await rerankCase(
    (q, c) => {
      called++;
      return { scores: c.map((_, i) => i), model: "test/reverse" };
    },
    (t) => ({ vector: rowOf(t.v.set, t.data.points.findIndex((p) => p.label === "Rice")), model: t.v.set.model }),
  );
  await settle(t.dom, t.h.setSearchSettings({ rerank: true }));
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.dom.frames(12);
  assert.strictEqual(called, 0);
  assertNoRanks(t, embeddingOrder, "A vector search with no label has no text to send to the reranker; it stays in embedding order.");
  t.h.destroy();
});

test("a reranker that answers: ranks reach the overlay and the cut-off is the lowest candidate's height", async () => {
  const { t } = await rerankCase(
    (q, c) => ({ scores: c.map((_, i) => i), model: "test/reverse" }),
    (t) => ({ point: idOf(t.data, "Rice") }),
  );
  await settle(t.dom, t.h.setSearchSettings({ rerank: true }));
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.dom.frames(12);
  const s = t.h.info().search;
  assert.strictEqual(s.searches[0].reranker, "test/reverse");
  assert.ok(t.h.info().status.includes(" · named results chosen and numbered by the reranker"), t.h.info().status);
  const data = ET.viewer.relativeOverlayData(t.h);
  assert.ok(data.named.every((n) => n.ranks.length === 1 && n.ranks[0].letter === "A"));
  assert.deepStrictEqual(
    data.named.map((n) => n.ranks[0].rank),
    s.searches[0].results.map((r) => r.rank),
  );
  const q = t.v.search.shown[0];
  const u = unitDirection(q.query);
  let low = Infinity;
  for (const hit of q.ranking.pool) low = Math.min(low, dot(t.v.set, hit.index, u));
  assert.strictEqual(data.cut.sent, q.ranking.pool.length);
  assert.ok(Math.abs(data.cut.height - low) < 1e-9);
  t.h.destroy();
});

// ---------- criterion 5: lit values ----------

// The fade of the points that are not results has one strength (deviation d9): 0.2 + 0.6 g^2,
// what the setting "The rest" called bright while it existed (d6).
const FADE_BASE = 0.2;
const FADE_SCALE = 0.6;

test("the fade's two constants are published, and no level table is", () => {
  assert.strictEqual(ET.viewer.RELATIVE_FADE_BASE, FADE_BASE);
  assert.strictEqual(ET.viewer.RELATIVE_FADE_SCALE, FADE_SCALE);
  assert.ok(!("RELATIVE_REST" in ET.viewer));
});

// The gradient by the documented rule, worked out here independently.
function expectedGradient(set, queries, own) {
  const N = set.count;
  const g = new Float64Array(N);
  queries.forEach((query, j) => {
    const r = ET.search.rank(set, query, { k: 3 });
    const c = Array.from(r.distances, (d) => 1 - d);
    const mid = c.slice().sort((a, b) => a - b)[N >> 1];
    let hi = -Infinity;
    c.forEach((x, i) => {
      if (i !== own[j] && x > hi) hi = x;
    });
    c.forEach((x, i) => {
      const y = Math.min(1, Math.max(0, (x - mid) / (hi - mid)));
      if (y > g[i]) g[i] = y;
    });
  });
  return Float32Array.from(g, (x) => FADE_BASE + FADE_SCALE * x * x);
}

// FNV-1a over the bytes of the uploaded lit values.
function bitsHash(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// What the viewer uploaded with The rest at bright, its default, before the setting was
// removed (t22, d9): taken from the sources at commit 92c4fba with the code of this test.
// The pictures of the default did not change, to the bit.
const UPLOADED_BEFORE_D9 = { even: "3c24c0bf", close: "b193ca1a", named: "3c24c0bf" };

// Every Lit setting that fades the rest (t19, d6; one strength since t22, d9).
for (const litSetting of ["even", "close", "named"]) {
  test(`Lit ${litSetting}: results keep their lit values, every other point gets the gradient 0.2 + 0.6 g^2`, async () => {
    const t = setup({ relative: true, searchLit: litSetting });
    await ready(t);
    const names = ["Rice", "Wheat"];
    await searchAndSettle(
      t,
      names.map((n) => ({ point: idOf(t.data, n) })),
    );
    const plainLit = t.v.search.lit.lit; // ET.searchSets.litValues: what relative off uploads
    const withGradient = t.lit.at(-1);
    assert.strictEqual(t.v.search.litRelative, true);
    const own = names.map((n) => t.data.points.findIndex((p) => p.label === n));
    const expected = expectedGradient(
      t.v.set,
      own.map((i) => rowOf(t.v.set, i)),
      own,
    );
    let graded = 0;
    for (let i = 0; i < plainLit.length; i++) {
      if (plainLit[i] > 0) {
        if (!Object.is(withGradient[i], plainLit[i])) assert.fail(`result ${i}: ${withGradient[i]} vs ${plainLit[i]}`);
      } else {
        if (Math.abs(withGradient[i] - expected[i]) > 1e-6) assert.fail(`point ${i}: ${withGradient[i]} vs ${expected[i]}`);
        if (withGradient[i] > FADE_BASE + 1e-6) graded++;
        assert.ok(withGradient[i] >= FADE_BASE - 1e-7 && withGradient[i] <= FADE_BASE + FADE_SCALE + 1e-7);
      }
    }
    if (litSetting === "close") {
      // Close lights every point down to a reach past the radius; on this set that reach is
      // below the median cosine, so every point the gradient would brighten is already lit.
      for (let i = 0; i < plainLit.length; i++) if (expected[i] > 0) assert.ok(plainLit[i] > 0, "point " + i);
    } else assert.ok(graded > 10, "the gradient reaches points that are not results: " + graded);
    assert.strictEqual(bitsHash(withGradient), UPLOADED_BEFORE_D9[litSetting], "the upload is what The rest = bright gave");
    // A "rest" in the patch is an unknown key: nothing is uploaded, nothing changes.
    const uploads = t.lit.length;
    for (const value of ["faint", "visible", "bright"]) t.h.setRelative({ rest: value });
    t.dom.frames(2);
    assert.strictEqual(t.lit.length, uploads, "no upload for an unknown key");
    // The counts count only the lit values of the searches.
    assert.strictEqual(t.h.info().search.litCount, t.v.search.lit.litCount);
    // Relative off: exactly the lit values without it.
    t.h.setRelative({ relative: false });
    t.dom.frames(2);
    assert.strictEqual(t.v.search.litRelative, false);
    sameBits(t.lit.at(-1), plainLit, "lit with relative off");
    t.h.destroy();
  });
}

test("relative off: the lit values uploaded are exactly litValues, with no gradient", async () => {
  const t = setup({ relative: false });
  await ready(t);
  await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
  t.dom.frames(4);
  sameBits(t.lit.at(-1), t.v.search.lit.lit, "lit");
  assert.strictEqual(t.h.info().search.relative.active, false);
  t.h.destroy();
});

test("t22 (d9): a mount option relativeRest is an unknown option: ignored, the view and the uploads are as without it", async () => {
  const hashes = [];
  for (const given of ["visible", "faint", "bright", "glaring", undefined]) {
    const t = setup({ relative: true, relativeRest: given });
    await ready(t);
    assert.deepStrictEqual(t.h.relativeSettings(), { relative: true, showOrigin: false }, String(given));
    assert.ok(!("rest" in t.h.info().search.relative));
    await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }, { point: idOf(t.data, "Wheat") }]);
    hashes.push(bitsHash(t.lit.at(-1)));
    t.h.destroy();
  }
  assert.deepStrictEqual(hashes, hashes.map(() => UPLOADED_BEFORE_D9.even));
});
