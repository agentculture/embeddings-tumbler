"use strict";
// Task t7 of the relative-search plan: the relative overlay (docs/relative-interface.md,
// "Overlay (t7)"). The overlay is loaded from source with the maths and the renderer; the
// mode's state.relative (t6) is made here by hand in its documented shape from the maths of
// t2 (relativeFit, makeRelativeTour), so the frames are real relative frames on the real
// fixtures. Assertions compare numbers, strings and counts, never whole objects or nodes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");

const api = loadSources(["10-math.js", "30-renderer.js", "46-relative-overlay.js"]);
const ET = api._internal;
const RO = ET.relativeOverlay;
const M = ET.math;

const FIX = path.join(ROOT, "tests", "fixtures", "relative");

function loadFixture(name) {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, name + ".json"), "utf8"));
  const buf = fs.readFileSync(path.join(FIX, meta.vectors.file));
  const D = meta.dimension;
  const N = meta.count;
  const X = new Float32Array(N * D);
  for (let i = 0; i < N * D; i++) X[i] = buf.readFloatLE(i * 4);
  const byLabel = {};
  const labels = meta.points.map((p) => p.label);
  labels.forEach((l, i) => {
    byLabel[l] = i;
  });
  return { X, N, D, byLabel, labels };
}

let wikiCache = null;
let mixedCache = null;
const wiki = () => (wikiCache ||= loadFixture("wikipedia-subset"));
const mixed = () => (mixedCache ||= loadFixture("mixed-length"));

const W = 1200;
const H = 800;
const DPR = 2;
const COLOURS = ["#ff9a3c", "#4cc9f0", "#b5e48c", "#f72585"];
const RELATIVE_FILL = 0.78 / 0.46;
const RELATIVE_ZOOM_CAP = 0.5 / (0.42 * 0.46);

function row(X, i, D) {
  return X.slice(i * D, (i + 1) * D);
}

function len(v) {
  let s = 0;
  for (let d = 0; d < v.length; d++) s += v[d] * v[d];
  return Math.sqrt(s);
}

function dotRow(X, i, D, u) {
  let s = 0;
  for (let d = 0; d < D; d++) s += X[i * D + d] * u[d];
  return s;
}

function unitOf(q) {
  const l = len(q);
  return Float64Array.from(q, (v) => v / l);
}

// The k nearest rows to q by cosine (the search's ranking), nearest first.
function nearest(fx, q, k) {
  const { X, N, D } = fx;
  const u = unitOf(q);
  const all = [];
  for (let i = 0; i < N; i++) {
    const l = len(X.subarray(i * D, (i + 1) * D));
    all.push({ index: i, cos: dotRow(X, i, D, u) / l });
  }
  all.sort((a, b) => b.cos - a.cos || a.index - b.index);
  return all.slice(0, k);
}

// A settled (or turning) relative view on the fixture for the given searches, framed as t6
// frames it: centre ((top + bottom) / 2) u, zoom from the window.
function scene(fx, labelsOf, opts) {
  const o = { settled: true, mix: 1, showOrigin: false, labels: true, k: 9, t: 3.7, ...opts };
  const { X, N, D, byLabel, labels } = fx;
  const queries = labelsOf.map((l) => row(X, byLabel[l], D));
  const fit = M.relativeFit(X, N, D, queries, { seed: 5 });
  const tour = M.makeRelativeTour(fit.directions, fit.count, fit.basis, fit.subspace, D, { seed: 5 });
  const frame = tour.frameAt(o.t);
  const u = unitOf(queries[0]);
  let top = fit.window.high + 0.04;
  let bottom = fit.window.low - 0.04;
  if (o.showOrigin) {
    bottom = Math.min(bottom, -0.06);
    top = Math.max(top, 0.06);
  }
  const centre = Float32Array.from(u, (v) => ((top + bottom) / 2) * v);
  const letters = ["A", "B", "C", "D"];
  const searches = queries.map((q, j) => ({ letter: letters[j], colour: COLOURS[j], query: q }));
  const axes = ["vertical", "horizontal", "depth"];
  const relative = {
    relative: true,
    showOrigin: o.showOrigin,
    active: true,
    settled: o.settled,
    mix: o.mix,
    pinned: fit.pinned.map((p, j) => ({ letter: letters[p.index], axis: axes[j], length: p.length })),
    dropped: [],
    measure: fit.unit.unit ? "cosine" : "length along the search",
    unit: fit.unit,
    window: { low: fit.window.low, high: fit.window.high, bottom, top },
    share: fit.share,
    subspace: fit.subspace,
    free: 3 - fit.count,
    fixed: fit.fixed,
  };
  const named = [];
  const seen = new Set();
  queries.forEach((q) => {
    for (const r of nearest(fx, q, o.k)) {
      if (seen.has(r.index)) continue;
      seen.add(r.index);
      named.push({ index: r.index, text: labels[r.index], ranks: [] });
    }
  });
  const view = {
    zoom: Math.min(RELATIVE_FILL / (top - bottom), RELATIVE_ZOOM_CAP),
    yaw: 0.4,
    pitch: 0,
    perspective: ET.renderer.RELATIVE_PERSPECTIVE,
  };
  const input = {
    width: W,
    height: H,
    dpr: DPR,
    view,
    vectors: X,
    dimension: D,
    frame,
    centre,
    relative,
    searches,
    named,
    cut: null,
    showOrigin: o.showOrigin,
    labels: o.labels,
  };
  return { input, fit, frame, centre, u, queries, top, bottom, view };
}

// Independent screen mapping: the point k along unit direction u, through the frame.
function alongPx(sc, u, k) {
  const { frame, centre, view } = sc;
  const D = u.length;
  const p = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let a = 0;
    let c = 0;
    for (let d = 0; d < D; d++) {
      a += u[d] * frame[r * D + d];
      c += centre[d] * frame[r * D + d];
    }
    p[r] = k * a - c;
  }
  return ET.renderer.place(p, view, W, H);
}

function vectorPx(sc, v) {
  const { frame, centre, view } = sc;
  const D = v.length;
  const p = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    let s = 0;
    for (let d = 0; d < D; d++) s += (v[d] - centre[d]) * frame[r * D + d];
    p[r] = s;
  }
  return ET.renderer.place(p, view, W, H);
}

const kindCount = (arr, kind) => arr.filter((e) => e.kind === kind).length;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ----- criterion 1: ticks every 0.1, one stem per named result, the search's marker -----

test("Rice: ticks every 0.1 across the window, a level ring and a label at each", () => {
  const sc = scene(wiki(), ["Rice"]);
  const list = RO.build(sc.input);
  const foot = Math.max(0, sc.bottom - 0.2);
  const first = Math.ceil(foot * 10 - 1e-9);
  const last = Math.floor(sc.top * 10 + 1e-6);
  assert.ok(last - first >= 5, "the window spans several ticks");
  const ticks = list.segments.filter((s) => s.kind === "tick");
  const tickTexts = list.texts.filter((t) => t.kind === "tick");
  const rings = list.rings.filter((r) => r.kind === "level");
  assert.strictEqual(ticks.length, last - first + 1);
  assert.strictEqual(tickTexts.length, ticks.length);
  assert.strictEqual(rings.length, ticks.length);
  tickTexts.forEach((t, j) => {
    const s = (first + j) / 10;
    assert.strictEqual(t.text, s.toFixed(1));
    const p = alongPx(sc, sc.u, s);
    near(ticks[j].y0, p.y, 1e-6, "tick at " + s);
    near(t.y, p.y, 1e-6, "tick label at " + s);
    assert.strictEqual(rings[j].points.length, 2 * 49);
  });
  assert.ok(Number(tickTexts[0].text) >= foot - 1e-9 && Number(tickTexts[0].text) < foot + 0.1);
  assert.ok(Number(tickTexts.at(-1).text) <= sc.top + 1e-6 && Number(tickTexts.at(-1).text) > sc.top - 0.1);
  // the ruler runs from its foot to the window's top
  assert.strictEqual(kindCount(list.segments, "ruler"), 1);
  assert.strictEqual(list.ruler.from, foot);
  assert.strictEqual(list.ruler.to, sc.top);
  near(list.ruler.y1, alongPx(sc, sc.u, sc.top).y, 1e-6, "ruler top");
  near(list.ruler.y0, alongPx(sc, sc.u, foot).y, 1e-6, "ruler foot");
  // the title
  const titles = list.texts.filter((t) => t.kind === "title");
  assert.strictEqual(titles.length, 1);
  assert.strictEqual(titles[0].text, "cosine to A");
});

test("Rice: one stem per named result, ending at that result's height on the ruler", () => {
  const fx = wiki();
  const sc = scene(fx, ["Rice"]);
  const list = RO.build(sc.input);
  const rice = fx.byLabel.Rice;
  const named = sc.input.named;
  assert.strictEqual(named[0].index, rice, "Rice is its own first result");
  const stems = list.segments.filter((s) => s.kind === "stem");
  assert.strictEqual(stems.length, named.length - 1, "every named result but the search's own point");
  assert.strictEqual(list.results.length, stems.length);
  assert.ok(!list.results.some((r) => r.index === rice), "no stem for the search's own point");
  const expected = new Set(["Cereal", "Wheat", "Maize", "Bean", "Bread"].map((l) => fx.byLabel[l]));
  for (const i of expected) assert.ok(list.results.some((r) => r.index === i), fx.labels[i] + " has a stem");
  list.results.forEach((r, j) => {
    const h = dotRow(fx.X, r.index, fx.D, sc.u);
    near(r.height, h, 1e-9, "height");
    const onRuler = alongPx(sc, sc.u, h);
    near(r.rulerX, onRuler.x, 1e-6, "ruler x");
    near(r.rulerY, onRuler.y, 1e-6, "ruler y");
    const at = vectorPx(sc, row(fx.X, r.index, fx.D));
    near(r.x, at.x, 1e-3, "drawn x");
    near(r.y, at.y, 1e-3, "drawn y");
    // the stem joins the two
    near(stems[j].x0, r.x, 1e-9, "stem start");
    near(stems[j].x1, r.rulerX, 1e-9, "stem end x");
    near(stems[j].y1, r.rulerY, 1e-9, "stem end y");
    // and the end lies on ruler A's line
    const R = list.ruler;
    const cross = (R.x1 - R.x0) * (r.rulerY - R.y0) - (R.y1 - R.y0) * (r.rulerX - R.x0);
    near(cross / Math.hypot(R.x1 - R.x0, R.y1 - R.y0), 0, 1e-6, "end on the ruler");
  });
  // settled and untilted at the relative perspective, the stem's ends sit at about the same
  // screen height (o6's 2 percent of the ruler's visible length)
  const rulerLen = Math.abs(list.ruler.y1 - list.ruler.y0);
  for (const r of list.results) assert.ok(Math.abs(r.y - r.rulerY) < 0.02 * rulerLen, "level stem");
});

test("Rice: the search's marker is drawn at its own length on the ruler", () => {
  const sc = scene(wiki(), ["Rice"]);
  const list = RO.build(sc.input);
  const marks = list.marks.filter((m) => m.kind === "search");
  assert.strictEqual(marks.length, 1);
  const l = len(sc.queries[0]);
  near(l, 1, 1e-3, "unit-length query");
  const p = alongPx(sc, sc.u, l);
  near(marks[0].x, p.x, 1e-6, "marker x");
  near(marks[0].y, p.y, 1e-6, "marker y");
  const q = vectorPx(sc, sc.queries[0]);
  near(marks[0].y, q.y, 1e-3, "the raw query");
  assert.strictEqual(marks[0].colour, COLOURS[0]);
});

test("result labels: text cut to 28, heights with two decimals; none with labels off", () => {
  const fx = wiki();
  const sc = scene(fx, ["Rice"]);
  sc.input.named.push({ index: fx.byLabel.Rice, text: "Rice", ranks: [] }); // a repeat is drawn once
  sc.input.named[1].text = "<b>an extremely long label that goes on</b>";
  const list = RO.build(sc.input);
  const res = list.texts.filter((t) => t.kind === "result");
  assert.strictEqual(res.length, list.results.length);
  const first = res.find((t) => t.index === sc.input.named[1].index);
  const h = dotRow(fx.X, sc.input.named[1].index, fx.D, sc.u);
  assert.strictEqual(first.text, "<b>an extremely long label …  " + h.toFixed(2));
  assert.ok(!res.some((t) => t.text.includes("cosine")), "a unit-length set calls the height cosine already");
  const off = RO.build({ ...sc.input, labels: false });
  assert.strictEqual(kindCount(off.texts, "result"), 0);
  assert.strictEqual(off.results.length, list.results.length, "stems stay with labels off");
});

test("mixed-length set: the title says length along the search and labels show the cosine too", () => {
  const fx = mixed();
  const sc = scene(fx, [fx.labels[7]]);
  assert.strictEqual(sc.fit.unit.unit, false);
  const list = RO.build(sc.input);
  assert.strictEqual(list.texts.find((t) => t.kind === "title").text, "length along the search to A");
  const res = list.texts.filter((t) => t.kind === "result");
  assert.ok(res.length > 0);
  for (const t of res) {
    const i = t.index;
    const h = dotRow(fx.X, i, fx.D, sc.u);
    const c = h / len(row(fx.X, i, fx.D));
    assert.ok(t.text.endsWith("  " + h.toFixed(2) + "  cosine " + c.toFixed(2)), t.text);
  }
  assert.strictEqual(kindCount(list.rings, "unit"), 0);
});

test("two pinned: ruler B along B's own direction with dots and labels at 0.1 to 0.9", () => {
  const fx = wiki();
  const sc = scene(fx, ["Rice", "Wheat"]);
  assert.strictEqual(sc.fit.count, 2);
  const list = RO.build(sc.input);
  const b = list.segments.filter((s) => s.kind === "ruler2");
  assert.strictEqual(b.length, 1);
  const uB = unitOf(sc.queries[1]);
  const foot = Math.max(0, sc.bottom - 0.2);
  const to = Math.max(1, len(sc.queries[1])) + 0.04;
  near(b[0].y0, alongPx(sc, uB, foot).y, 1e-6, "B foot");
  near(b[0].x1, alongPx(sc, uB, to).x, 1e-6, "B end x");
  near(b[0].y1, alongPx(sc, uB, to).y, 1e-6, "B end y");
  // dots at 0.1 to 0.9, left out where they fall off the stage (the reference's 20 px slack)
  const want = [];
  for (let k = 1; k <= 9; k++) {
    const p = alongPx(sc, uB, k / 10);
    if (p.y >= -20 * DPR && p.y <= H + 20 * DPR) want.push(p);
  }
  assert.ok(want.length >= 3, "some of ruler B is on the stage");
  const dots = list.marks.filter((m) => m.kind === "dot");
  assert.strictEqual(dots.length, want.length);
  dots.forEach((d, j) => near(d.y, want[j].y, 1e-6, "dot " + j));
  const bLabels = list.texts.filter((t) => t.kind === "tick" && t.colour === COLOURS[1]);
  assert.strictEqual(bLabels.length, want.length);
  assert.strictEqual(kindCount(list.marks, "search"), 2);
  // labels carry the height along each pinned search
  const i = fx.byLabel.Maize;
  const t = list.texts.find((x) => x.kind === "result" && x.index === i);
  assert.strictEqual(t.text, "Maize  " + dotRow(fx.X, i, fx.D, sc.u).toFixed(2) + " · " + dotRow(fx.X, i, fx.D, uB).toFixed(2));
  // one pinned: no ruler B
  assert.strictEqual(kindCount(RO.build(scene(fx, ["Rice"]).input).segments, "ruler2"), 0);
});

// ----- criterion 2: the origin's true distance, the unit circle -----

test("relative view with Show the origin: true distance is len(centre), unit circle on a unit-length set", () => {
  const sc = scene(wiki(), ["Rice"], { showOrigin: true });
  const list = RO.build(sc.input);
  const origin = list.marks.filter((m) => m.kind === "origin");
  assert.strictEqual(origin.length, 1);
  let far = 0;
  for (const v of sc.centre) far += v * v;
  near(origin[0].far, Math.sqrt(far), 1e-6, "true distance");
  const p = alongPx(sc, sc.u, 0);
  near(origin[0].y, p.y, 1e-6, "at height 0");
  assert.strictEqual(list.ruler.from, 0, "the ruler starts at the origin");
  assert.strictEqual(list.texts.find((t) => t.kind === "origin").text, "origin (0, 0, … , 0)");
  assert.strictEqual(sc.fit.unit.unit, true);
  const unit = list.rings.filter((r) => r.kind === "unit");
  assert.strictEqual(unit.length, 1);
  // the circle has radius one unit about the origin
  // (untilted, a unit vector along the vertical row lands exactly one unit radius above it)
  const D = sc.u.length;
  const one = vectorPx(sc, Float32Array.from(sc.frame.subarray(D, 2 * D)));
  near(Math.hypot(one.x - p.x, one.y - p.y), unit[0].radius, 1e-6 * unit[0].radius, "unit radius");
  // the unit check false: no circle
  const notUnit = { ...sc.input, relative: { ...sc.input.relative, unit: { ...sc.fit.unit, unit: false } } };
  assert.strictEqual(kindCount(RO.build(notUnit).rings, "unit"), 0);
  // Show the origin off: no origin, no circle
  const plainOff = RO.build({ ...sc.input, showOrigin: false });
  assert.strictEqual(kindCount(plainOff.marks, "origin"), 0);
  assert.strictEqual(kindCount(plainOff.rings, "unit"), 0);
});

test("relative view on the mixed-length set with Show the origin: no unit circle", () => {
  const fx = mixed();
  const sc = scene(fx, [fx.labels[3]], { showOrigin: true });
  const list = RO.build(sc.input);
  assert.strictEqual(kindCount(list.marks, "origin"), 1);
  let far = 0;
  for (const v of sc.centre) far += v * v;
  near(list.marks.find((m) => m.kind === "origin").far, Math.sqrt(far), 1e-6, "true distance");
  assert.strictEqual(kindCount(list.rings, "unit"), 0);
});

test("plain view with Show the origin: the marker where zero falls, true and visible distance", () => {
  const fx = wiki();
  const { X, N, D } = fx;
  const centre = new Float32Array(D);
  for (let i = 0; i < N; i++) for (let d = 0; d < D; d++) centre[d] += X[i * D + d] / N;
  const sc = scene(fx, ["Rice"]);
  const frame = sc.frame;
  const view = { zoom: 2.5, yaw: 0.7, pitch: 0.16 };
  const input = { ...sc.input, frame, centre, view, relative: null, showOrigin: true };
  const list = RO.build(input);
  const origin = list.marks.filter((m) => m.kind === "origin");
  assert.strictEqual(origin.length, 1);
  let far = 0;
  for (const v of centre) far += v * v;
  far = Math.sqrt(far);
  near(origin[0].far, far, 1e-6, "true distance");
  near(far, 0.79, 0.05, "the set sits far from the origin");
  let seen = 0;
  const cF = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    for (let d = 0; d < D; d++) cF[r] += centre[d] * frame[r * D + d];
    seen += cF[r] * cF[r];
  }
  seen = Math.sqrt(seen);
  near(origin[0].seen, seen, 1e-6, "visible part");
  const p = ET.renderer.place([-cF[0], -cF[1], -cF[2]], view, W, H);
  near(origin[0].x, p.x, 1e-6, "origin x");
  near(origin[0].y, p.y, 1e-6, "origin y");
  const texts = list.texts.filter((t) => t.kind === "origin");
  assert.strictEqual(texts.length, 1);
  assert.strictEqual(texts[0].text, "origin · truly " + far.toFixed(2) + " from the centre, " + seen.toFixed(2) + " of it visible");
  assert.strictEqual(list.rings.length, 0, "no unit circle in the plain view");
  assert.strictEqual(list.segments.length, 0);
  assert.strictEqual(list.ruler, null);
  // Show the origin off in the plain view: an empty list
  const empty = RO.build({ ...input, showOrigin: false });
  assert.strictEqual(empty.segments.length + empty.rings.length + empty.marks.length + empty.texts.length, 0);
  // a relative state that is not active is the plain view
  const inactive = RO.build({ ...input, relative: { relative: true, active: false, settled: false, mix: 0.4, pinned: [] } });
  assert.strictEqual(kindCount(inactive.marks, "origin"), 1);
  assert.strictEqual(inactive.ruler, null);
});

// ----- criterion 3: ranks and the reranker's cut-off -----

test("reranked: labels carry ranks 1 to top and the cut-off sits at the lowest candidate's height", () => {
  const fx = wiki();
  const top = 9;
  const sc = scene(fx, ["Rice"], { k: top });
  // the candidates sent: the 51 nearest; the lowest of them along the search
  const sent = nearest(fx, sc.queries[0], 51);
  const lowest = Math.min(...sent.map((c) => dotRow(fx.X, c.index, fx.D, sc.u)));
  // the reranker's order: here, reversed from the embedding order but for the point itself
  sc.input.named = sc.input.named.map((n, j) => ({ ...n, ranks: [{ letter: "A", rank: j === 0 ? 1 : top + 1 - j }] }));
  sc.input.cut = { height: lowest, sent: 51 };
  const list = RO.build(sc.input);
  const res = list.texts.filter((t) => t.kind === "result");
  const ranks = res.map((t) => Number(/^(\d+)\. /.exec(t.text)[1])).sort((a, b) => a - b);
  assert.deepStrictEqual(ranks, [2, 3, 4, 5, 6, 7, 8, 9], "ranks 2 to top (1 is the search's own point, drawn as the search)");
  const cut = list.segments.filter((s) => s.kind === "cut");
  assert.strictEqual(cut.length, 1);
  const p = alongPx(sc, sc.u, lowest);
  near(cut[0].y0, p.y, 1e-6, "cut y");
  near((cut[0].x0 + cut[0].x1) / 2, p.x, 1e-6, "cut across the ruler");
  assert.ok(Array.isArray(cut[0].dash) && cut[0].dash.length === 2, "dashed");
  const ct = list.texts.filter((t) => t.kind === "cut");
  assert.strictEqual(ct.length, 1);
  assert.strictEqual(ct[0].text, "51 candidates above this line went to the reranker");
});

test("reranked, a word search (not a point): ranks 1 to top on the labels", () => {
  const fx = wiki();
  const sc = scene(fx, ["Rice"], { k: 9 });
  // make the search an average of Rice and Wheat so that no result is its own point
  const q = new Float32Array(fx.D);
  const a = row(fx.X, fx.byLabel.Rice, fx.D);
  const b = row(fx.X, fx.byLabel.Wheat, fx.D);
  for (let d = 0; d < fx.D; d++) q[d] = (a[d] + b[d]) / 2;
  sc.input.searches[0].query = q;
  sc.input.named = nearest(fx, q, 8).map((r, j) => ({ index: r.index, text: fx.labels[r.index], ranks: [{ letter: "A", rank: j + 1 }] }));
  const list = RO.build(sc.input);
  const ranks = list.texts.filter((t) => t.kind === "result").map((t) => Number(/^(\d+)\. /.exec(t.text)[1]));
  assert.deepStrictEqual(ranks.slice().sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(list.results.length, 8);
});

test("several searches: ranks are lettered, joined by a space", () => {
  const fx = wiki();
  const sc = scene(fx, ["Rice", "Wheat"]);
  const i = fx.byLabel.Maize;
  const n = sc.input.named.find((x) => x.index === i);
  n.ranks = [{ letter: "A", rank: 3 }, { letter: "B", rank: 2 }];
  const t = RO.build(sc.input).texts.find((x) => x.kind === "result" && x.index === i);
  assert.ok(t.text.startsWith("A3. B2. Maize  "), t.text);
});

test("no reranking, or a failed one: no ranks and no cut-off mark", () => {
  const sc = scene(wiki(), ["Rice"]);
  const list = RO.build(sc.input); // ranks [] and cut null, as the viewer passes after a failure
  assert.strictEqual(kindCount(list.segments, "cut"), 0);
  assert.strictEqual(kindCount(list.texts, "cut"), 0);
  for (const t of list.texts.filter((x) => x.kind === "result")) assert.ok(!/^[A-D]?\d+\. /.test(t.text), t.text);
});

// ----- criterion 4: not settled -----

test("not settled: ruler A's line only, faint; no ticks, rings, labels, stems or cut-off", () => {
  const sc = scene(wiki(), ["Rice", "Wheat"], { settled: false, mix: 0.5, showOrigin: true });
  sc.input.cut = { height: 0.6, sent: 51 };
  const list = RO.build(sc.input);
  assert.strictEqual(kindCount(list.segments, "tick"), 0);
  assert.strictEqual(kindCount(list.segments, "stem"), 0);
  assert.strictEqual(kindCount(list.segments, "cut"), 0);
  assert.strictEqual(kindCount(list.segments, "ruler2"), 0);
  assert.strictEqual(list.rings.length, 0);
  assert.strictEqual(list.results.length, 0);
  assert.strictEqual(list.texts.length, 0);
  const ruler = list.segments.filter((s) => s.kind === "ruler");
  assert.strictEqual(ruler.length, 1);
  assert.strictEqual(list.segments.length, 1);
  const settled = RO.build(scene(wiki(), ["Rice"]).input);
  assert.ok(ruler[0].alpha < settled.segments.find((s) => s.kind === "ruler").alpha, "faint");
  assert.strictEqual(kindCount(list.marks, "search"), 2, "the searches' markers stay");
  assert.strictEqual(kindCount(list.marks, "origin") + kindCount(list.marks, "dot"), 0);
});

// ----- paint and placeLabels -----

test("paint draws shapes only, never text, and returns false for an empty list", () => {
  const dom = makeFakeDom();
  const canvas = dom.document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const sc = scene(wiki(), ["Rice"], { showOrigin: true });
  sc.input.cut = { height: 0.6, sent: 51 };
  const list = RO.build(sc.input);
  assert.strictEqual(RO.paint(ctx, list), true); // the fake context throws on fillText and strokeText
  const calls = ctx._rec.calls;
  const strokes = calls.filter((c) => c[0] === "stroke").length;
  const marks = list.marks.filter((m) => m.kind !== "dot").length;
  assert.strictEqual(strokes, list.segments.length + list.rings.length + marks);
  assert.ok(calls.some((c) => c[0] === "setLineDash" && c[1].length === 2), "dashed cut and circle");
  const before = calls.length;
  assert.strictEqual(RO.paint(ctx, RO.build({ ...sc.input, relative: null, showOrigin: false })), false);
  assert.strictEqual(calls.length, before, "nothing drawn for an empty list");
});

test("placeLabels: spans with textContent, markup kept as text, reused, overlaps left out", () => {
  const dom = makeFakeDom();
  const layer = dom.document.createElement("div");
  const fx = wiki();
  const sc = scene(fx, ["Rice"], { showOrigin: true });
  sc.input.named[1].text = "<img src=x onerror=1>";
  const list = RO.build(sc.input);
  const shown = RO.placeLabels(layer, list, dom.document);
  assert.ok(shown > 0 && shown <= list.texts.length);
  assert.strictEqual(layer.children.length, shown);
  const spans = layer.children;
  assert.ok(spans.every((s) => s.tagName === "SPAN"));
  const texts = spans.map((s) => s.textContent);
  // the title and the ticks are placed before any result: the title always shows, and a
  // tick is left out only where it meets the title or another first-placed text
  const title0 = list.texts.find((x) => x.kind === "title");
  assert.ok(texts.includes(title0.text), "the title is shown");
  const ticks = list.texts.filter((x) => x.kind === "tick");
  const ticksShown = ticks.filter((t) => texts.includes(t.text)).length;
  assert.ok(ticksShown >= ticks.length - 1, ticksShown + " of " + ticks.length + " ticks shown");
  const markup = list.texts.find((t) => t.index === sc.input.named[1].index);
  if (texts.includes(markup.text)) {
    const span = spans.find((s) => s.textContent === markup.text);
    assert.strictEqual(span.children.length, 0, "markup is text");
  }
  // the transform places the span in CSS pixels
  const title = list.texts.find((t) => t.kind === "title");
  const tspan = spans.find((s) => s.textContent === title.text);
  assert.ok(tspan.style.transform.startsWith("translate(" + (title.x / DPR).toFixed(1) + "px, " + (title.y / DPR).toFixed(1) + "px) translate(-100%"));
  // a second call reuses the spans
  const again = RO.placeLabels(layer, list, dom.document);
  assert.strictEqual(again, shown);
  assert.strictEqual(layer.children.length, shown);
  // an empty list hides them all
  assert.strictEqual(RO.placeLabels(layer, RO.build({ ...sc.input, relative: null, showOrigin: false }), dom.document), 0);
  assert.strictEqual(layer.children.filter((s) => s.style.display !== "none").length, 0);
  // overlapping texts: the later one is left out
  const two = { dpr: 1, texts: [
    { x: 100, y: 100, text: "first label", align: "left", colour: "#fff", alpha: 1, kind: "result", height: 0.8 },
    { x: 104, y: 102, text: "second label", align: "left", colour: "#fff", alpha: 1, kind: "result", height: 0.7 },
  ] };
  const layer2 = dom.document.createElement("div");
  assert.strictEqual(RO.placeLabels(layer2, two, dom.document), 1);
  assert.strictEqual(layer2.children[0].textContent, "first label");
});

test("placeLabels keeps at most 160 spans", () => {
  const dom = makeFakeDom();
  const layer = dom.document.createElement("div");
  const texts = [];
  for (let i = 0; i < 400; i++) texts.push({ x: (i % 10) * 200, y: Math.floor(i / 10) * 20, text: "r" + i, align: "left", colour: "#fff", alpha: 1, kind: "result", height: -i });
  assert.strictEqual(RO.placeLabels(layer, { dpr: 1, texts }, dom.document), 160);
  assert.strictEqual(layer.children.length, 160);
});

test("build is pure: the same input gives the same list, and it leaves its input unchanged", () => {
  const sc = scene(wiki(), ["Rice", "Wheat"], { showOrigin: true });
  const centre = sc.input.centre.slice();
  const a = RO.build(sc.input);
  const b = RO.build(sc.input);
  assert.strictEqual(a.segments.length, b.segments.length);
  for (let j = 0; j < a.segments.length; j++) assert.strictEqual(a.segments[j].y0, b.segments[j].y0);
  assert.strictEqual(a.texts.map((t) => t.text).join("|"), b.texts.map((t) => t.text).join("|"));
  for (let d = 0; d < centre.length; d++) assert.strictEqual(sc.input.centre[d], centre[d]);
  // malformed input gives an empty list, never a throw
  const e = RO.build(null);
  assert.strictEqual(e.segments.length + e.texts.length, 0);
  assert.strictEqual(RO.build({ ...sc.input, width: 0 }).segments.length, 0);
});
