"use strict";
// Host-adjustable spacing: every spacing or size the standalone page (or any host) may want
// to change is set inline as var(--tumbler-<name>, <default>), so a host stylesheet sets a
// custom property instead of fighting the inline style with !important. With no property
// set the browser uses the fallback, which is the viewer's own value, at both widths.

const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeSet } = require("./helpers/viewer-fixtures.js");

const api = loadAssembled();

// [what, element getter, style key, wide default, narrow default] — js/api/50-viewer.md.
const SPACING = [
  ["masthead-top", (v) => v.masthead, "top", "14px", "14px"],
  ["masthead-left", (v) => v.masthead, "left", "16px", "16px"],
  ["masthead-right", (v) => v.masthead, "right", "16px", "16px"],
  ["title-size", (v) => v.mastTitle, "fontSize", "clamp(28px, 6vw, 56px)", "clamp(28px, 6vw, 56px)"],
  ["title-margin", (v) => v.mastTitle, "margin", "0 0 6px", "0 0 6px"],
  ["status-left", (v) => v.status, "left", "16px", "16px"],
  ["status-right", (v) => v.status, "right", "16px", "16px"],
  ["status-bottom", (v) => v.status, "bottom", "10px", "10px"],
  ["panel-padding", (v) => v.panel, "padding", "6px 16px 16px", "6px 12px 14px"],
  ["panel-gap", (v) => v.panel, "gap", "14px", "14px"],
  ["mode-padding", (v) => v.modeButtons[0].button, "padding", "10px 12px 8px 0", "10px 12px 8px 0"],
  ["mode-title-size", (v) => v.modeButtons[0].title, "fontSize", "24px", "20px"],
  ["mode-summary-size", (v) => v.modeButtons[0].summary, "fontSize", "12.5px", "12.5px"],
  ["readout-caption-size", (v) => v.readout.lastChild, "fontSize", "11.5px", "11.5px"],
  ["controls-gap", (v) => v.controlsEl, "gap", "10px 18px", "10px 18px"],
];

function expected(name, fallback) {
  return "var(--tumbler-" + name + ", " + fallback + ")";
}

function checkAll(v, narrow) {
  for (const [name, get, key, wide, slim] of SPACING) {
    assert.strictEqual(get(v).style[key], expected(name, narrow ? slim : wide), name + (narrow ? " (narrow)" : " (wide)"));
  }
}

test("spacing is set inline as var(--tumbler-*, default) at a wide width", () => {
  const dom = makeFakeDom();
  const el = dom.host({ width: 900 });
  const h = api.mount(el);
  checkAll(h._viewer, false);
  // Every mode button, not only the first.
  for (const mb of h._viewer.modeButtons) {
    assert.strictEqual(mb.button.style.padding, expected("mode-padding", "10px 12px 8px 0"));
    assert.strictEqual(mb.title.style.fontSize, expected("mode-title-size", "24px"));
    assert.strictEqual(mb.summary.style.fontSize, expected("mode-summary-size", "12.5px"));
  }
  h.destroy();
});

test("spacing keeps the viewer's narrow values as fallbacks below 600 px, and back again", () => {
  const dom = makeFakeDom();
  const el = dom.host({ width: 390 });
  const h = api.mount(el);
  const v = h._viewer;
  checkAll(v, true);
  for (const mb of v.modeButtons) assert.strictEqual(mb.title.style.fontSize, expected("mode-title-size", "20px"));
  el.rect.width = 900;
  dom.ro[0].trigger();
  checkAll(v, false);
  el.rect.width = 500;
  dom.ro[0].trigger();
  checkAll(v, true);
  h.destroy();
});

test("spacing properties are not part of the theme: setting one neither re-applies nor clears", () => {
  const dom = makeFakeDom();
  const el = dom.host({ width: 900 });
  const h = api.mount(el);
  const v = h._viewer;
  h.update(makeSet({ n: 12, d: 8 }));
  const theme = v.theme;
  const key = v.themeKey;
  for (const [name] of SPACING) el.style.setProperty("--tumbler-" + name, "3px");
  v.needClear = false;
  h.refreshTheme();
  assert.strictEqual(v.needClear, false, "the trails are not cleared");
  assert.strictEqual(v.theme, theme, "the theme object is kept");
  assert.strictEqual(v.themeKey, key, "the theme key is unchanged");
  for (const [name] of SPACING) assert.ok(!key.includes(name), name + " is not read into the theme");
  // The inline values are untouched: the browser resolves var() live, no refresh needed.
  checkAll(v, false);
  h.destroy();
});
