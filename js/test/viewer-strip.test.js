"use strict";
// The readout strip is coloured by screen axis: each cell mixes the horizontal, vertical and
// depth colours by its dimension's squared component on each axis; opacity is the existing
// contribution formula. A frame is supplied by a registered mode so each cell is known exactly.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const DARK = [[255, 150, 60], [80, 220, 160], [130, 140, 255]];
const LIGHT = [[176, 84, 0], [0, 128, 82], [72, 82, 214]];
const D = 8;

// A mode that holds the frame the test gives it. Dimension 0 feeds only the horizontal axis,
// 1 only the vertical, 2 only the depth, 3 all three equally, 4 two of them (1 : 3), the
// rest nothing.
function strongFrame() {
  const f = new Float32Array(3 * D);
  const third = Math.sqrt(1 / 3);
  f[0] = 1;
  f[D + 1] = 1;
  f[2 * D + 2] = 1;
  f[3] = f[D + 3] = f[2 * D + 3] = third;
  f[4] = 0.5;
  f[D + 4] = Math.sqrt(0.75);
  return f;
}

function holdMode(frameOf) {
  return {
    id: "hold",
    title: "Hold",
    summary: "Holds a given frame.",
    create() {
      let set = null;
      const state = (t) => ({
        t,
        frame: frameOf(),
        centre: new Float32Array(set.dimension),
        draw: { zoom: 1, wires: 0, dim: 1, trails: 0.1, fog: 0, fogNear: 1.2, fogWidth: 0.8, twinkle: 0, depthOfField: 1 },
        wires: null,
        status: "hold",
        focus: null,
      });
      const inst = {
        enter(s) {
          set = s;
        },
        prepare() {
          return { done: true, ready: true, progress: 1, step: () => true };
        },
        isReady: () => true,
        stateAt: state,
        step: (dt) => state(dt),
        status: () => "hold",
        dataChanged(s) {
          set = s;
          return { work: null, restart: false };
        },
        mark() {},
        describe: () => ({ id: "hold", projection: "linear: held still", seed: 1, varianceShare: null }),
        leave() {},
      };
      return inst;
    },
  };
}

function stripOn(background) {
  const api = loadSources();
  api.registerMode(holdMode(strongFrame));
  const dom = makeFakeDom();
  const el = dom.host();
  if (background) el.style.setProperty("--tumbler-background", background);
  const h = api.mount(el, { mode: "hold", seed: 1 });
  h.update(makeSet({ n: 12, d: D }));
  dom.frames(3);
  const cells = h._viewer.strip.getContext("2d")._rec.puts.at(-1).data;
  const cell = (d) => Array.from(cells.slice(d * 4, d * 4 + 4));
  return { h, v: h._viewer, cell };
}

function expectedAlpha(frame, d) {
  const sum = frame[d] ** 2 + frame[D + d] ** 2 + frame[2 * D + d] ** 2;
  return Math.min(255, ((sum * D) / 3) * 80);
}

for (const [name, background, colours] of [
  ["dark", null, DARK],
  ["light", "#ffffff", LIGHT],
]) {
  test("a cell fed by one axis shows that axis's colour exactly (" + name + " stage)", () => {
    const { h, cell } = stripOn(background);
    for (let axis = 0; axis < 3; axis++) {
      assert.deepStrictEqual(cell(axis).slice(0, 3), colours[axis], "axis " + axis);
    }
    h.destroy();
  });

  test("a cell fed equally by all three axes shows the even mix (" + name + " stage)", () => {
    const { h, cell } = stripOn(background);
    const mix = [0, 1, 2].map((c) => (colours[0][c] + colours[1][c] + colours[2][c]) / 3);
    cell(3)
      .slice(0, 3)
      .forEach((got, c) => assert.ok(Math.abs(got - mix[c]) <= 1, "channel " + c + ": " + got + " vs " + mix[c]));
    h.destroy();
  });

  test("a cell fed by two axes mixes them by squared component (" + name + " stage)", () => {
    const { h, cell } = stripOn(background);
    const got = cell(4);
    [0, 1, 2].forEach((c) => {
      const want = colours[0][c] * 0.25 + colours[1][c] * 0.75;
      assert.ok(Math.abs(got[c] - want) <= 1, "channel " + c);
    });
    h.destroy();
  });

  test("the legend names the three axes, each in its own colour (" + name + " stage)", () => {
    const { h, v } = stripOn(background);
    assert.match(v.stripMiddle.textContent, /colour: horizontal vertical depth$/);
    assert.deepStrictEqual(
      v.stripLegend.map((w) => w.textContent),
      ["horizontal", "vertical", "depth"]
    );
    v.stripLegend.forEach((word, i) => {
      assert.strictEqual(word.style.color, "rgb(" + colours[i].join(", ") + ")");
    });
    h.destroy();
  });
}

test("the legend and cell colours are readable on their stage (contrast of at least 4.5)", () => {
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  // The viewer's default panel backgrounds: dark #04060b, light #f6f4ee (and white as a host's).
  for (const c of DARK) assert.ok(ratio(c, [4, 6, 11]) >= 4.5, "dark " + c);
  for (const c of LIGHT) {
    assert.ok(ratio(c, [246, 244, 238]) >= 4.5, "light " + c);
    assert.ok(ratio(c, [255, 255, 255]) >= 4.5, "white " + c);
  }
});

test("opacity per cell is the existing contribution formula, and an unused cell is clear", () => {
  const { h, cell } = stripOn(null);
  const frame = strongFrame();
  for (let d = 0; d < D; d++) {
    const want = expectedAlpha(frame, d);
    assert.ok(Math.abs(cell(d)[3] - Math.min(255, want)) <= 0.5, "cell " + d + " alpha");
  }
  assert.strictEqual(cell(7)[3], 0);
  assert.deepStrictEqual(cell(7).slice(0, 3), [0, 0, 0], "no share, no colour, no NaN");
  h.destroy();
});

test("the theme switches the strip colours on refresh", () => {
  const api = loadSources();
  api.registerMode(holdMode(strongFrame));
  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, { mode: "hold", seed: 1 });
  h.update(makeSet({ n: 12, d: D }));
  dom.frames(2);
  assert.deepStrictEqual(Array.from(h._viewer.strip.getContext("2d")._rec.puts.at(-1).data.slice(0, 3)), DARK[0]);
  el.style.setProperty("--tumbler-background", "#ffffff");
  h.refreshTheme();
  dom.frames(2);
  assert.deepStrictEqual(Array.from(h._viewer.strip.getContext("2d")._rec.puts.at(-1).data.slice(0, 3)), LIGHT[0]);
  h.destroy();
});
