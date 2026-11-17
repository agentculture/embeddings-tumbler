"use strict";
// The viewer's drawing of the relative view (task t10 of the relative-search plan): the
// overlay of ET.relativeOverlay painted each frame from the mode's state, the perspective key
// and the pitch, Show the origin in both views, the test hook (handle._viewer.relativeDrawn),
// frame.relative for the panel, and the provenance's exactness only once settled. Binding
// names: docs/relative-interface.md, "Viewer (t9, t10)" and "Overlay (t7)".
//
// The viewer runs on the fake DOM and GPU of helpers/, loaded from the source modules
// (loadSources). Large arrays and DOM nodes are never handed to an equality assertion:
// comparisons loop over fields, and DOM is compared by text and counts.
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

function idOf(data, label) {
  const p = data.points.find((x) => x.label === label);
  assert.ok(p, "no point labelled " + label);
  return p.id;
}

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

function setup(mountOpts, name = "wikipedia-subset", domOpts) {
  const dom = makeFakeDom(domOpts);
  const el = dom.host();
  const h = api.mount(el, { seed: 3, mode: "tumble", paused: true, searchPanel: false, ...mountOpts });
  const v = h._viewer;
  const data = fixture(name);
  h.update(data);
  return { dom, h, v, data };
}

async function ready(t) {
  await until(t.dom, () => t.h.info().ready && !t.h.info().preparing);
}

async function searchAndSettle(t, list) {
  const r = await settle(t.dom, t.h.setSearches(list));
  assert.strictEqual(r.ok, true, r.message);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.h.seek(t.h.time() + TURN + 0.5);
  t.dom.frames(12);
  assert.strictEqual(t.h.info().search.relative.settled, true, "settled");
}

// The overlay canvas's recorded 2-D calls (the fake context keeps every call).
function overlayCalls(v) {
  return v.overlay.getContext("2d")._rec.calls;
}

function drawCalls(calls) {
  return calls.filter((c) => c[0] === "stroke" || c[0] === "fill" || c[0] === "lineTo" || c[0] === "arc").length;
}

// The texts of the relative label layer's visible spans.
function relTexts(v) {
  return v.relLabelLayer.children.filter((c) => c.style.display !== "none").map((c) => c.textContent);
}

function dotRow(set, i, u) {
  const D = set.dimension;
  let s = 0;
  for (let d = 0; d < D; d++) s += set.vectors[i * D + d] * u[d];
  return s;
}

function unitDirection(q) {
  let len = 0;
  for (let d = 0; d < q.length; d++) len += q[d] * q[d];
  len = Math.sqrt(len);
  return Array.from(q, (x) => x / len);
}

// ---------- criterion 1: painted each frame from the mode's state; nothing when off ----------

test("relative on with a search: the overlay is painted every frame with the mode's frame, centre and settled flag", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  assert.strictEqual(t.v.relLabelLayer.className, "tumbler-relative-labels");
  assert.strictEqual(t.v.relLabelLayer.getAttribute("aria-hidden"), "true");
  const kids = t.v.stage.children;
  assert.strictEqual(kids.indexOf(t.v.relLabelLayer), kids.indexOf(t.v.overlay) + 1, "right after the overlay canvas");
  const xs = [];
  for (const dt of [0, 0.7, 2.3]) {
    t.h.seek(t.h.time() + dt);
    overlayCalls(t.v).length = 0;
    t.dom.frames(1);
    const drawn = t.v.relativeDrawn;
    assert.ok(drawn, "the hook has a record");
    assert.strictEqual(drawn.settled, true);
    assert.strictEqual(drawn.painted, true);
    assert.ok(drawCalls(overlayCalls(t.v)) > 0, "shapes painted this frame");
    assert.ok(drawn.ruler && drawn.results.length > 0, "a ruler and stems");
    // The same list, built afresh from the state kept for this frame, places every result
    // where the hook says: the overlay was built from the mode's frame, centre and settled flag.
    const s = t.v.last;
    const ds = t.v.lastDraw;
    const od = ET.viewer.relativeOverlayData(t.h);
    const again = ET.relativeOverlay.build({
      width: t.v.W, height: t.v.H, dpr: t.v.dpr, view: ds, vectors: t.v.set.vectors, dimension: t.v.set.dimension,
      frame: s.frame, centre: s.centre, relative: s.relative,
      searches: t.v.search.shown.map((q) => ({ letter: q.letter, colour: "#fff", query: q.query })),
      named: od.named, cut: od.cut, showOrigin: false, labels: true,
    });
    assert.strictEqual(again.results.length, drawn.results.length);
    again.results.forEach((r, k) => {
      const d = drawn.results[k];
      assert.deepStrictEqual([d.index, d.x, d.y, d.rulerX, d.rulerY], [r.index, r.x, r.y, r.rulerX, r.rulerY]);
    });
    xs.push(drawn.results[0].x);
    // Labels: the ruler's title and ticks, and result labels (labels are on by default).
    const texts = relTexts(t.v);
    assert.ok(texts.includes("cosine to A"), "the title");
    assert.ok(texts.some((x) => /^\d\.\d$/.test(x)), "tick labels");
    // The flatness key from the mode, and the stage level.
    assert.strictEqual(ds.perspective, ET.renderer.RELATIVE_PERSPECTIVE);
    assert.strictEqual(ds.pitch, 0);
  }
  assert.ok(xs[0] !== xs[1] || xs[1] !== xs[2], "the free axes tumble, so the drawing follows the frame");
  // The searched point is its own first result and gets no stem.
  const rice = t.data.points.findIndex((p) => p.label === "Rice");
  assert.ok(!t.v.relativeDrawn.results.some((r) => r.index === rice));
  t.h.destroy();
});

test("while the view turns: settled false, ruler A only, no stems, ticks or exactness in the provenance", async () => {
  // The clock runs: with it stopped the view is shown at once with no turn (t19).
  const t = setup({ relative: true, paused: false });
  await ready(t);
  const r = await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
  assert.strictEqual(r.ok, true);
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  const T = t.v.mode.inst.describe().relative.switchAt;
  assert.ok(Number.isFinite(T));
  t.h.seek(T + TURN / 2);
  t.dom.frames(12);
  const rel = t.h.info().search.relative;
  assert.deepStrictEqual([rel.active, rel.settled], [true, false]);
  const drawn = t.v.relativeDrawn;
  assert.strictEqual(drawn.settled, false);
  assert.ok(drawn.ruler, "ruler A's line");
  assert.strictEqual(drawn.results.length, 0, "no stems");
  assert.ok(!relTexts(t.v).some((x) => /^\d\.\d$/.test(x) || x === "cosine to A"), "no ticks, no title");
  const mix = t.v.last.relative.mix;
  assert.ok(mix > 0 && mix < 1, "mix " + mix);
  assert.ok(Math.abs(t.v.lastDraw.pitch - 0.16 * (1 - mix)) < 1e-12, "pitch eased by mix");
  assert.ok(Math.abs(t.v.lastDraw.perspective - (3 + (ET.renderer.RELATIVE_PERSPECTIVE - 3) * mix)) < 1e-9);
  // The status says it is turning; the provenance claims no exact axis yet.
  assert.ok(t.h.info().status.includes("turning until vertical = cosine to A"), t.h.info().status);
  const row = provenanceRow(t.v, "Relative");
  assert.ok(row, "the Relative row");
  assert.ok(!row.includes("exact"), row);
  // Settled: the exactness sentence comes in.
  t.h.seek(T + TURN + 0.5);
  t.dom.frames(12);
  assert.ok(provenanceRow(t.v, "Relative").startsWith("The vertical axis is exact: height is cosine to A. "));
  t.h.destroy();
});

function provenanceRow(v, term) {
  const kids = v.provList.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].tagName.toLowerCase() === "dt" && kids[i].textContent === term) return kids[i + 1].textContent;
  }
  return null;
}

test("relative off, or on with no search: nothing of the overlay is painted or placed, the perspective key is absent", async () => {
  for (const relative of [false, true]) {
    const t = setup({ relative });
    await ready(t);
    if (!relative) await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
    for (const time of [0.5, 4]) {
      t.h.seek(time);
      overlayCalls(t.v).length = 0;
      t.dom.frames(2);
      assert.strictEqual(t.v.relativeDrawn, null, "no record");
      assert.strictEqual(relTexts(t.v).length, 0, "no span shown");
      assert.ok(!overlayCalls(t.v).some((c) => c[0] === "arc" || c[0] === "lineTo"), "no shape painted");
      assert.ok(!("perspective" in t.v.lastDraw), "perspective at its default (key absent)");
      assert.strictEqual(t.v.lastDraw.pitch, 0.16);
    }
    t.h.destroy();
  }
});

test("turning the relative view off clears its spans and record; another mode draws none of it", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  assert.ok(relTexts(t.v).length > 0);
  t.h.setMode("lattice");
  t.dom.frames(3);
  assert.strictEqual(t.v.relativeDrawn, null);
  assert.strictEqual(relTexts(t.v).length, 0);
  t.h.setMode("tumble");
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  t.h.setRelative({ relative: false });
  t.h.seek(t.h.time() + TURN + 0.5);
  t.dom.frames(3);
  assert.strictEqual(t.v.relativeDrawn, null);
  assert.strictEqual(relTexts(t.v).length, 0);
  t.h.destroy();
});

test("the panel gets frame.relative, and with the panel each search is ringed once", async () => {
  const t = setup({ relative: true, searchPanel: true });
  await ready(t);
  const frames = [];
  const panel = t.v.search.panel;
  const real = panel.drawOverlay;
  panel.drawOverlay = function (ctx, project, frame) {
    frames.push(frame.relative);
    return real.apply(this, arguments);
  };
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }, { point: idOf(t.data, "Wheat") }]);
  frames.length = 0;
  overlayCalls(t.v).length = 0;
  t.dom.frames(1);
  assert.deepStrictEqual(frames, [true]);
  const rings = overlayCalls(t.v).filter((c) => c[0] === "arc" && c[3] === 10 * t.v.dpr).length;
  assert.strictEqual(rings, 2, "one ring per search (the panel's)");
  t.h.setRelative({ relative: false });
  t.h.seek(t.h.time() + TURN + 0.5);
  frames.length = 0;
  t.dom.frames(1);
  assert.deepStrictEqual(frames, [false]);
  t.h.destroy();
  // Without the panel the overlay's own markers ring each search once.
  const u = setup({ relative: true });
  await ready(u);
  await searchAndSettle(u, [{ point: idOf(u.data, "Rice") }, { point: idOf(u.data, "Wheat") }]);
  overlayCalls(u.v).length = 0;
  u.dom.frames(1);
  assert.strictEqual(overlayCalls(u.v).filter((c) => c[0] === "arc" && c[3] === 10 * u.v.dpr).length, 2);
  u.h.destroy();
});

test("ink and paper follow the theme: the light theme's foreground and background reach the overlay", async () => {
  const dom = makeFakeDom();
  const el = dom.host();
  el.style.setProperty("--tumbler-background", "#ffffff");
  el.style.setProperty("--tumbler-foreground", "#102030");
  el.style.setProperty("--tumbler-search-1", "#123456");
  const h = api.mount(el, { seed: 3, mode: "tumble", paused: true, searchPanel: false, relative: true });
  const data = fixture("wikipedia-subset");
  h.update(data);
  const t = { dom, h, v: h._viewer, data };
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(data, "Rice") }]);
  assert.strictEqual(t.v.theme.light, true);
  const spans = t.v.relLabelLayer.children.filter((c) => c.style.display !== "none");
  const result = spans.find((c) => /  \d\.\d\d$/.test(c.textContent));
  assert.ok(result, "a result label");
  assert.strictEqual(result.style.color, "rgb(16, 32, 48)", "results in the theme's foreground");
  assert.ok(result.style.textShadow.includes("rgb(255, 255, 255)"), "outlined in the theme's background");
  const title = spans.find((c) => c.textContent === "cosine to A");
  assert.strictEqual(title.style.color, "rgb(18, 52, 86)", "search A's colour from --tumbler-search-1");
  h.destroy();
});

// ---------- criterion 2: Show the origin in both views ----------

test("Show the origin in the relative view widens the window to zero and marks the origin", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  const before = t.h.info().search.relative.window;
  assert.ok(before.bottom > 0, "on this set the window starts above zero: " + before.bottom);
  assert.strictEqual(t.v.relativeDrawn.origin, null, "zero is outside the window: no origin mark");
  const zoomBefore = t.v.lastDraw.zoom;
  t.h.setRelative({ showOrigin: true });
  t.h.seek(t.h.time() + TURN + 0.5);
  t.dom.frames(12);
  const after = t.h.info().search.relative.window;
  assert.ok(after.bottom <= -0.06 && after.top >= 0.06, "the window includes zero");
  assert.ok(t.v.lastDraw.zoom < zoomBefore, "zoomed out to show it");
  const drawn = t.v.relativeDrawn;
  assert.strictEqual(drawn.ruler.from, 0, "ruler A from the origin");
  assert.ok(drawn.origin, "the origin is marked");
  assert.ok(relTexts(t.v).includes("origin (0, 0, … , 0)"));
  // The origin mark is at height 0 along the ruler: on the ruler's line, at its foot.
  assert.ok(Math.abs(drawn.origin.y - drawn.ruler.y0) < 1e-6 && Math.abs(drawn.origin.x - drawn.ruler.x0) < 1e-6);
  t.h.destroy();
});

test("Show the origin in the plain view paints the marker with the true and the visible distance", async () => {
  const off = setup({});
  const on = setup({ showOrigin: true });
  await ready(off);
  await ready(on);
  for (const time of [1, 6.5]) {
    off.h.seek(time);
    on.h.seek(time);
    off.dom.frames(1);
    overlayCalls(on.v).length = 0;
    on.dom.frames(1);
    // The mode is untouched: the same frame, centre and zoom.
    const a = off.v.last;
    const b = on.v.last;
    for (let i = 0; i < a.frame.length; i++) if (!Object.is(a.frame[i], b.frame[i])) assert.fail("frame differs at " + i);
    for (let i = 0; i < a.centre.length; i++) if (!Object.is(a.centre[i], b.centre[i])) assert.fail("centre differs at " + i);
    assert.strictEqual(off.v.lastDraw.zoom, on.v.lastDraw.zoom);
    assert.strictEqual(off.v.relativeDrawn, null);
    const drawn = on.v.relativeDrawn;
    assert.ok(drawn?.origin, "the marker");
    assert.ok(drawn.painted && drawCalls(overlayCalls(on.v)) > 0);
    // The numbers: |centre| and the length of its shadow on the three rows.
    const D = on.v.set.dimension;
    let far = 0;
    for (let d = 0; d < D; d++) far += b.centre[d] * b.centre[d];
    far = Math.sqrt(far);
    let seen = 0;
    for (let r = 0; r < 3; r++) {
      let c = 0;
      for (let d = 0; d < D; d++) c += b.centre[d] * b.frame[r * D + d];
      seen += c * c;
    }
    seen = Math.sqrt(seen);
    assert.ok(Math.abs(drawn.origin.far - far) < 1e-6, "true distance");
    assert.ok(Math.abs(drawn.origin.seen - seen) < 1e-6, "visible part");
    assert.ok(relTexts(on.v).includes("origin · truly " + far.toFixed(2) + " from the centre, " + seen.toFixed(2) + " of it visible"), relTexts(on.v).join(" | "));
    // Where the all-zero vector falls under the draw state.
    const p = ET.renderer.place(
      [0, 1, 2].map((r) => {
        let c = 0;
        for (let d = 0; d < D; d++) c -= b.centre[d] * b.frame[r * D + d];
        return c;
      }),
      on.v.lastDraw,
      on.v.W,
      on.v.H,
    );
    assert.ok(Math.abs(p.x - drawn.origin.x) < 1e-6 && Math.abs(p.y - drawn.origin.y) < 1e-6);
  }
  off.h.destroy();
  on.h.destroy();
});

// ---------- criterion 3: the test hook, drawn heights against the ruler ----------

for (const dpr of [1, 2]) {
  test(`the hook: each named result's drawn height agrees with its height on the ruler within 1 px (Wikipedia, dpr ${dpr})`, async () => {
    const t = setup({ relative: true }, "wikipedia-subset", { devicePixelRatio: dpr });
    await ready(t);
    for (const names of [["Rice"], ["Rice", "Wheat"]]) {
      await searchAndSettle(
        t,
        names.map((n) => ({ point: idOf(t.data, n) })),
      );
      const u = unitDirection(t.v.search.shown[0].query);
      let worstRuler = 0;
      let worstLine = 0;
      for (const dt of [0, 3.1, 7.7]) {
        t.h.seek(t.h.time() + dt);
        t.dom.frames(1);
        const drawn = t.v.relativeDrawn;
        assert.strictEqual(drawn.units, "device");
        assert.strictEqual(drawn.dpr, dpr);
        assert.deepStrictEqual([drawn.width, drawn.height], [t.v.W, t.v.H]);
        assert.ok(drawn.ruler.to > drawn.ruler.from);
        for (const k of ["x0", "y0", "x1", "y1"]) assert.ok(Number.isFinite(drawn.ruler[k]), k);
        assert.ok(drawn.results.length >= 5, "named results with stems: " + drawn.results.length);
        for (const r of drawn.results) {
          assert.ok(Math.abs(r.height - dotRow(t.v.set, r.index, u)) < 1e-9, "height is x . u");
          worstRuler = Math.max(worstRuler, Math.abs(r.y - r.rulerY));
          worstLine = Math.max(worstLine, Math.abs(r.y - r.mappedY));
        }
      }
      // In device pixels; 1 CSS px is dpr device px.
      assert.ok(worstRuler <= dpr, `drawn height against the ruler point: ${worstRuler} device px`);
      assert.ok(worstLine <= dpr, `drawn height against the ruler's line: ${worstLine} device px`);
    }
    t.h.destroy();
  });
}

test("the hook on the mixed-length set: heights are lengths along the search, title names that measure", async () => {
  const t = setup({ relative: true }, "mixed-length");
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  const drawn = t.v.relativeDrawn;
  const u = unitDirection(t.v.search.shown[0].query);
  assert.ok(drawn.results.length > 0);
  for (const r of drawn.results) assert.ok(Math.abs(r.height - dotRow(t.v.set, r.index, u)) < 1e-9);
  assert.ok(relTexts(t.v).includes("length along the search to A"));
  assert.ok(relTexts(t.v).some((x) => x.includes("  cosine ")), "result labels carry the cosine too");
  t.h.destroy();
});

// ---------- t19: titles on the ruler's labels, the search's name on its marker ----------

// The visible texts of the panel's own label layer.
function panelTexts(v) {
  const layer = v.stage.querySelector(".tumbler-search-labels");
  return layer ? layer.children.filter((c) => c.style.display !== "none").map((c) => c.textContent) : [];
}

test("t19: a named result's label on the ruler shows its title; without titles the start of its text", async () => {
  const t = setup({ relative: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  const od = ET.viewer.relativeOverlayData(t.h);
  const cereal = t.data.points.findIndex((p) => p.label === "Cereal");
  const e = od.named.find((n) => n.index === cereal);
  assert.ok(e, "Cereal is a named result");
  assert.strictEqual(e.title, "Cereal");
  assert.ok(e.text.length > 40, "its text is the article's start, not its title");
  const results = t.v.relativeDrawn.results;
  const u = unitDirection(t.v.search.shown[0].query);
  const h = dotRow(t.v.set, cereal, u);
  assert.ok(results.some((r) => r.index === cereal));
  assert.ok(relTexts(t.v).includes("Cereal  " + h.toFixed(2)), "the title and the height");
  t.h.destroy();
  // The same set with no titles: the start of the text, cut to 28, as before.
  const dom = makeFakeDom();
  const h2 = api.mount(dom.host(), { seed: 3, mode: "tumble", paused: true, searchPanel: false, relative: true });
  const data = fixture("wikipedia-subset");
  const riceId = idOf(data, "Rice");
  const text = data.points[cereal].metadata.text;
  // labels that are no more than the id (most) or empty: no title to show
  data.points.forEach((p, i) => {
    p.label = i % 2 ? "" : p.id;
  });
  h2.update(data);
  const u2 = { dom, h: h2, v: h2._viewer, data };
  await ready(u2);
  await searchAndSettle(u2, [{ point: riceId }]);
  const od2 = ET.viewer.relativeOverlayData(h2);
  assert.strictEqual(od2.named.find((n) => n.index === cereal).title, null);
  const want = (text.length > 28 ? text.slice(0, 27) + "…" : text) + "  " + h.toFixed(2);
  assert.ok(relTexts(u2.v).includes(want), "the text's start: " + want);
  // and the panel's list is as it was: the result's text, not the title
  const res = h2.info().search.searches[0].results.find((r) => r.index === cereal);
  assert.strictEqual(res.text, text);
  h2.destroy();
});

test("t19: each search's letter and name are drawn once beside its marker, with and without the panel", async () => {
  for (const searchPanel of [true, false]) {
    const t = setup({ relative: true, searchPanel });
    await ready(t);
    await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }, { point: idOf(t.data, "Wheat") }]);
    t.dom.frames(1);
    const all = relTexts(t.v).concat(panelTexts(t.v));
    for (const name of ["A · Rice", "B · Wheat"]) {
      assert.strictEqual(all.filter((x) => x === name).length, 1, name + " once (panel " + searchPanel + ")");
    }
    assert.ok(!all.includes("A") && !all.includes("B"), "no bare letter beside it as well");
    // a ring per search, once
    t.dom.frames(0);
    const calls = overlayCalls(t.v);
    calls.length = 0;
    t.dom.frames(1);
    assert.strictEqual(calls.filter((c) => c[0] === "arc" && c[3] === 10 * t.v.dpr).length, 2, "one ring per search");
    // off: the panel letters the queries again, and the overlay draws nothing
    t.h.setRelative({ relative: false });
    t.dom.frames(3);
    assert.strictEqual(relTexts(t.v).length, 0);
    if (searchPanel) assert.ok(panelTexts(t.v).includes("A") && panelTexts(t.v).includes("B"), "letters in the plain view");
    t.h.destroy();
  }
});

test("t19: a search's name is inserted as text, never as markup", async () => {
  const t = setup({ relative: true, searchPanel: true });
  await ready(t);
  const D = t.data.dimension;
  const rice = t.data.points.findIndex((p) => p.label === "Rice");
  const vector = Array.from(t.v.set.vectors.subarray(rice * D, rice * D + D));
  const evil = "<img src=x onerror=alert(1)>";
  await searchAndSettle(t, [{ vector, model: t.data.model, label: evil }]);
  t.dom.frames(1);
  const span = t.v.relLabelLayer.children.find((c) => c.style.display !== "none" && c.textContent.startsWith("A · "));
  assert.ok(span, "the marker's name is shown");
  assert.strictEqual(span.textContent, "A · <img src=x onerror=alert(1)>");
  assert.strictEqual(span.children.length, 0, "markup is text");
  t.h.destroy();
});

// ---------- t19: with motion stopped, the relative view is shown at once ----------

// The frame shown now, as bits.
function frameBits(v) {
  return Array.from(new Uint32Array(new Float32Array(v.last.frame).buffer)).join(",");
}

async function stillRun(domOpts, mountOpts) {
  const seen = [];
  const t = setup({ relative: true, onSearchChange: (s) => seen.push(s.relative ? { active: s.relative.active, settled: s.relative.settled } : null), ...mountOpts }, "wikipedia-subset", domOpts);
  await ready(t);
  assert.strictEqual(t.v.running, false, "the clock stands still");
  t.h.seek(5);
  t.dom.frames(2);
  const record = [];
  const shot = (what) => {
    const rel = t.h.info().search.relative;
    record.push({ what, bits: frameBits(t.v), zoom: t.v.lastDraw.zoom, bottom: rel.window ? rel.window.bottom : null, active: rel.active, settled: rel.settled, pinned: rel.pinned.map((p) => p.letter).join("") });
  };
  const changed = async (fn, what) => {
    seen.length = 0;
    await fn();
    await until(t.dom, () => !t.h.info().preparing && !t.v.mode.inst.describe().relative.pending);
    t.dom.frames(1);
    assert.strictEqual(t.h.time(), 5, what + ": the clock did not move");
    shot(what);
  };
  // turning Relative on with a search already there: switch Relative off first, search, on
  t.h.setRelative({ relative: false });
  await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
  t.dom.frames(2);
  shot("plain with a search");
  await changed(() => t.h.setRelative({ relative: true }), "relative on");
  assert.ok(seen.some((s) => s && s.active && s.settled), "onSearchChange told the host it is settled");
  await changed(() => settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }, { point: idOf(t.data, "Wheat") }])), "add a search");
  await changed(() => settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Wheat") }])), "remove a search");
  await changed(() => t.h.setRelative({ showOrigin: true }), "show the origin");
  await changed(() => t.h.setRelative({ relative: false }), "relative off");
  return { t, record };
}

for (const variant of [
  { name: "paused", dom: undefined, mount: { paused: true } },
  { name: "under reduced motion", dom: { reducedMotion: true }, mount: { paused: null } },
]) {
  test("t19: " + variant.name + ", every change shows its settled view on the next frame, with the ruler exact", async () => {
    const { t, record } = await stillRun(variant.dom, variant.mount);
    const by = Object.fromEntries(record.map((r) => [r.what, r]));
    assert.deepStrictEqual([by["plain with a search"].active, by["relative on"].active, by["relative on"].settled], [false, true, true]);
    assert.strictEqual(by["add a search"].pinned, "AB");
    assert.strictEqual(by["add a search"].settled, true);
    assert.strictEqual(by["remove a search"].pinned, "B");
    assert.strictEqual(by["remove a search"].settled, true);
    assert.strictEqual(by["show the origin"].settled, true);
    assert.strictEqual(by["relative off"].active, false);
    assert.ok(!t.v.relativeDrawn?.ruler, "off: no ruler (Show the origin is still on, so the plain marker stays)");
    // the view really changed with each step: a new frame, or (Show the origin, which turns
    // nothing) the wider window and the zoom that frames it
    const turned = record.filter((r) => r.what !== "show the origin");
    assert.strictEqual(new Set(turned.map((r) => r.bits)).size, turned.length, "each change gave a new frame");
    assert.ok(by["show the origin"].bottom <= -0.06, "the window reaches zero at once");
    assert.ok(by["show the origin"].zoom < by["remove a search"].zoom, "zoomed out at once");
    // Show the origin again while relative: the window reaches zero at once and is drawn exact
    t.h.setRelative({ relative: true });
    t.dom.frames(1);
    const drawn = t.v.relativeDrawn;
    assert.strictEqual(drawn.settled, true);
    assert.strictEqual(drawn.ruler.from, 0, "the ruler from the origin");
    assert.ok(drawn.origin && drawn.results.length > 0, "origin and stems drawn");
    assert.strictEqual(t.v.mode.inst.describe().relative.instant, true);
    // A seek before the changes shows the earlier, plain view.
    t.h.seek(4);
    t.dom.frames(1);
    assert.strictEqual(t.h.info().search.relative.active, false, "before the events: plain");
    t.h.destroy();
  });
}

test("t19: still, two instances given the same changes show the same frames", async () => {
  const a = await stillRun(undefined, { paused: true });
  const b = await stillRun(undefined, { paused: true });
  assert.strictEqual(a.record.length, b.record.length);
  a.record.forEach((r, k) => assert.ok(r.bits === b.record[k].bits, "frame after " + r.what));
  a.t.h.destroy();
  b.t.h.destroy();
});

test("t19: with the clock running a change still turns, and Pause then a change is at once", async () => {
  const t = setup({ relative: true, paused: false });
  await ready(t);
  await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Rice") }]));
  await until(t.dom, () => t.h.info().search.relative.active && !t.h.info().preparing);
  assert.strictEqual(t.h.info().search.relative.settled, false, "running: the view turns");
  assert.strictEqual(t.v.mode.inst.describe().relative.instant, false);
  t.h.pause();
  t.dom.frames(1);
  const c = t.h.time();
  await settle(t.dom, t.h.setSearches([{ point: idOf(t.data, "Wheat") }]));
  await until(t.dom, () => !t.h.info().preparing && !t.v.mode.inst.describe().relative.pending);
  t.dom.frames(1);
  assert.strictEqual(t.h.time(), c);
  assert.strictEqual(t.h.info().search.relative.settled, true, "paused: at once");
  t.h.destroy();
});

test("t22 (d9): the panel has no control for the rest; Lit is the one that decides how the rest is shown", async () => {
  const t = setup({ relative: true, searchPanel: true });
  await ready(t);
  await searchAndSettle(t, [{ point: idOf(t.data, "Rice") }]);
  assert.strictEqual(t.v.el.querySelector(".tumbler-search-rest"), null, "no such control");
  const lit = t.v.el.querySelector(".tumbler-search-lit")?.querySelector("select");
  assert.ok(lit, "Lit is in the panel");
  assert.ok(!lit.disabled);
  t.h.destroy();
});
