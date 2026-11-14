"use strict";
// Fidelity to the reference demo (docs/specs/reference/embedding-tumbler-demo.html):
// the sizes, colours and wording a side-by-side found different and that were put
// back. The pictures themselves are compared in a browser; these tests pin the
// settings that make them match. See docs/reference-differences.md.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { loadAssembled, loadSources, ROOT } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();
const sample = require(path.join(ROOT, "js", "sample", "sample-data.js"));

function setup(domOpts, mountOpts) {
  const dom = makeFakeDom(domOpts);
  const el = dom.host(domOpts?.width ? { width: domOpts.width } : undefined);
  const h = api.mount(el, { seed: 3, ...mountOpts });
  return { dom, el, h, v: h._viewer };
}

function rgb(s) {
  const m = /rgba?\(([^)]*)\)/.exec(s);
  return m ? m[1].split(",").map((x) => Number(x)) : null;
}

function near(a, b, tol) {
  return a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= tol);
}

// The reference's hsl(h 90% 72%) for group hue h, as 0..255 channels.
function hsl255(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)].map((c) => Math.round(c * 255));
}
const GROUP_HUES = [28, 52, 96, 140, 170, 198, 226, 266, 328, 4, 298];

function shownLabels(v) {
  return v.labelPool.filter((r) => r.shown).map((r) => r.el);
}

// ---------- item 6: the mode summaries ----------

test("Lattice's and Wander's summaries are the reference's words exactly", () => {
  const ET = loadSources()._internal;
  assert.strictEqual(ET.modes.get("lattice").summary, "True neighbours wired together, one axis swapped at a time");
  assert.strictEqual(ET.modes.get("wander").summary, "Fly through the space, hopping neighbour to neighbour");
});

test("Tumble's summary is honest about the tour, of the reference's length, with no full stop", () => {
  const ET = loadSources()._internal;
  const s = ET.modes.get("tumble").summary;
  const ref = "The window turns through every dimension at once";
  assert.notStrictEqual(s, ref, "the reference's words are not true of a guided tour");
  assert.match(s, /strongest directions/);
  assert.ok(!/[.]\s*$/.test(s), "no trailing full stop: " + s);
  assert.ok(Math.abs(s.length - ref.length) <= 8, s.length + " characters against " + ref.length);
});

// ---------- item 1: the dark outline under every name ----------

test("labels carry a dark outline of the stage background, like the reference's 4 px stroke", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16, labelEvery: 1 }));
  dom.frames(20);
  const labels = shownLabels(v);
  assert.ok(labels.length > 0, "group names are shown");
  for (const el of labels) {
    const shadows = el.style.textShadow.split(/,(?![^(]*\))/);
    assert.ok(shadows.length >= 8, "an outline all round, not a glow: " + el.style.textShadow);
    // The outline is the stage background (#04060b) at the reference's 0.85.
    assert.ok(shadows.some((s) => /rgba\(4, 6, 11, 0\.85\)/.test(s)), el.style.textShadow);
    // Every part is offset by at most 2 px, the half-width of the reference's 4 px stroke.
    for (const s of shadows) {
      const px = s.trim().split(/\s+/).slice(0, 3).map(parseFloat);
      assert.ok(Math.hypot(px[0], px[1]) <= 2.01 && px[2] <= 1, s);
    }
  }
  h.destroy();
});

test("on a light stage the outline takes the host's background colour, not a night colour", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  el.style.setProperty("--tumbler-background", "#f6f4ee");
  el.style.setProperty("--tumbler-light-style", "ink");
  const h = api.mount(el, { seed: 3 });
  const v = h._viewer;
  h.update(makeSet({ n: 60, d: 16, labelEvery: 1 }));
  dom.frames(20);
  const labels = shownLabels(v);
  assert.ok(labels.length > 0);
  for (const l of labels) {
    assert.match(l.style.textShadow, /rgba\(246, 244, 238, 0\.85\)/);
    assert.doesNotMatch(l.style.textShadow, /rgba\(4, 6, 11/);
  }
  h.destroy();
});

test("group names are the group colour at the reference's 72% lightness on a dark stage", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 60, d: 16, labelEvery: 1, groups: ["alpha", "beta", "gamma"] }));
  dom.frames(20);
  const groups = shownLabels(v).filter((el) => el.style.textTransform === "uppercase");
  assert.strictEqual(groups.length, 3);
  for (const el of groups) {
    const g = v.groupIndex[el.textContent];
    assert.ok(near(rgb(el.style.color), hsl255(GROUP_HUES[g], 0.9, 0.72), 1), el.textContent + " " + el.style.color);
  }
  h.destroy();
});

// ---------- item 2: Wander's stop, neighbours, ring and spokes ----------

test("Wander's stop name is 26 px italic white; neighbours are #c5cddb; the ring is the group at 72%", () => {
  const { dom, h, v } = setup({}, { mode: "wander" });
  h.update(makeSet({ n: 60, d: 16, labelEvery: 1, groups: ["alpha", "beta", "gamma"] }));
  dom.frames(300);
  const labels = shownLabels(v);
  const stop = labels.filter((el) => el.style.fontSize === "26px");
  assert.ok(stop.length >= 1, "a stop name at 26 px: " + labels.map((el) => el.style.fontSize).join(" "));
  assert.strictEqual(stop[0].style.fontStyle, "italic");
  assert.deepStrictEqual(rgb(stop[0].style.color), [255, 255, 255]);
  const neighbours = labels.filter((el) => el.style.fontSize === "11px" && el.style.textTransform !== "uppercase");
  assert.ok(neighbours.length >= 1, "neighbour names are shown");
  for (const el of neighbours) assert.ok(near(rgb(el.style.color), [0xc5, 0xcd, 0xdb], 1), el.style.color);
  // The ring (the last stroke of the overlay) uses the stop's group colour at 72% lightness.
  const f = v.last.focus;
  const g = v.groupIndex[v.set.points[f.to].group];
  assert.ok(near(rgb(v.overlayCtx.strokeStyle), hsl255(GROUP_HUES[g], 0.9, 0.72), 1), v.overlayCtx.strokeStyle);
  h.destroy();
});

test("on a light stage Wander's names use the host's foreground, not white", () => {
  const dom = makeFakeDom();
  const el = dom.host();
  el.style.setProperty("--tumbler-background", "#f6f4ee");
  el.style.setProperty("--tumbler-foreground", "#1b2130");
  el.style.setProperty("--tumbler-light-style", "ink");
  const h = api.mount(el, { seed: 3, mode: "wander" });
  const v = h._viewer;
  h.update(makeSet({ n: 60, d: 16, labelEvery: 1 }));
  dom.frames(300);
  const stop = shownLabels(v).filter((l) => l.style.fontSize === "26px");
  assert.ok(stop.length >= 1);
  assert.deepStrictEqual(rgb(stop[0].style.color), [0x1b, 0x21, 0x30]);
  h.destroy();
});

// ---------- item 4: the readout strip ----------

test("the readout strip is the reference's: 22 px plus a 1 px line above and below, caption 6 px under it", () => {
  const { dom, h, v } = setup();
  h.update(makeSet({ n: 12, d: 16 }));
  dom.frames(2);
  assert.strictEqual(v.readout.style.display, "flex", "the gap needs the flex column back after data arrives");
  assert.strictEqual(v.readout.style.flexDirection, "column");
  assert.strictEqual(v.readout.style.gap, "6px");
  assert.strictEqual(v.strip.style.height, "22px");
  assert.strictEqual(v.strip.style.boxSizing, "content-box", "22 px of cells whatever the host's box-sizing");
  assert.strictEqual(v.strip.style.borderTop, "1px solid");
  assert.strictEqual(v.strip.style.borderBottom, "1px solid");
  assert.strictEqual(v.strip.style.borderTopColor, "rgb(27, 36, 54)", "the theme's line colour");
  h.destroy();
});

// ---------- item 5: the controls ----------

test("the speed slider is 130 px and the Pause button the reference's 76 by 28 px on a wide element", () => {
  const { h, v } = setup({ width: 1280 });
  assert.strictEqual(v.speedInput.style.width, "130px");
  for (const b of [v.playButton, v.zoomResetButton]) {
    assert.strictEqual(b.style.minWidth, "76px");
    assert.strictEqual(b.style.padding, "6px 16px");
    assert.strictEqual(b.style.minHeight, "28px");
    assert.strictEqual(b.style.fontSize, "12px");
  }
  h.destroy();
});

test("below 600 px wide the buttons keep a 32 px touch height (a recorded difference)", () => {
  const { el, dom, h, v } = setup({ width: 390 });
  assert.strictEqual(v.playButton.style.minHeight, "32px");
  assert.strictEqual(v.zoomResetButton.style.minHeight, "32px");
  el.rect.width = 1280;
  dom.ro[0].trigger();
  assert.strictEqual(v.playButton.style.minHeight, "28px");
  h.destroy();
});

// ---------- item 3: auto-framing keeps the cloud inside the stage ----------

function frameStats(ET, set, frame, centre, idx) {
  const D = set.dimension;
  const X = set.vectors;
  return idx.map((i) => {
    let a = 0;
    let b = 0;
    let c = 0;
    for (let d = 0; d < D; d++) {
      const x = X[i * D + d] - centre[d];
      a += x * frame[d];
      b += x * frame[D + d];
      c += x * frame[2 * D + d];
    }
    return Math.sqrt(a * a + b * b + c * c);
  });
}

function quantile(a, q) {
  const s = Float64Array.from(a).sort((x, y) => x - y); // radii: no NaN, no -0
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
}

test("autoZoom is the reference's 0.78 / rms for an even cloud, and caps the 98th-percentile radius", () => {
  const ET = loadSources()._internal;
  const M = ET.modes;
  assert.strictEqual(typeof M.AUTO_FIT, "number");
  assert.ok(M.AUTO_FIT > 0.5 && M.AUTO_FIT < 1);
  const D = 3;
  const frame = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const centre = new Float32Array(3);
  // Every point on the unit sphere: rms = p98 = 1, so 0.78 / rms wins.
  const even = new Float32Array(300 * D);
  for (let i = 0; i < 300; i++) {
    const t = (i / 300) * Math.PI * 2;
    even.set([Math.cos(t), Math.sin(t), 0], i * D);
  }
  assert.ok(Math.abs(M.autoZoom(even, 300, D, frame, centre, 512) - 0.78) < 1e-6);
  // A tight core with 10% of the points far out: the cap holds the far ones inside.
  const spread = new Float32Array(300 * D);
  for (let i = 0; i < 300; i++) spread.set([i % 10 === 0 ? 5 : 0.2, 0, 0], i * D);
  const z = M.autoZoom(spread, 300, D, frame, centre, 512);
  const rms = Math.sqrt((30 * 25 + 270 * 0.04) / 300);
  assert.ok(z < 0.78 / rms - 1e-6, "the cap is tighter than 0.78 / rms");
  assert.ok(Math.abs(z * 5 - M.AUTO_FIT) < 1e-6, "98th-percentile radius x zoom = AUTO_FIT");
});

test("over a full Tumble and Lattice run on the sample set, the 98th-percentile radius stays inside", () => {
  const ET = loadSources()._internal;
  const set = ET.contract.validate(sample.generate({ count: 4096 }), null).set;
  const idx = [];
  for (let i = 0; i < set.count; i += 2) idx.push(i);
  for (const id of ["tumble", "lattice"]) {
    const inst = ET.modes.create(id, {});
    inst.enter(set, { seed: 1, from: null });
    const prep = inst.prepare();
    while (!prep.done) prep.step(1000);
    let worst = 0;
    for (let t = 2; t <= 60; t += 2) {
      const s = inst.stateAt(t);
      const r = quantile(frameStats(ET, set, s.frame, s.centre, idx), 0.98) * s.draw.zoom;
      worst = Math.max(worst, r);
    }
    // The cap is applied to the first 512 points; over the whole set the
    // 98th-percentile radius may exceed AUTO_FIT a little, but stays within one
    // unit, inside the stage's shorter side (1.087 units at the renderer's radius
    // of 0.46). The reference's rule alone put it near 1.25.
    assert.ok(worst < 1, id + ": " + worst.toFixed(3));
  }
});
