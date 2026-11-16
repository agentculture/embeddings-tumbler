"use strict";
// Regression gate (task t4): with relative search off, every view's frames are bit-for-bit
// those of release 0.12.1. Goldens: js/test/fixtures/relative-off-golden.json, made by
// scripts/gen_relative_off_golden.js from the 0.12.1 assembled file.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { computeCases, VIEWS } = require("./helpers/relative-off-cases.js");

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "relative-off-golden.json"), "utf8"));
const now = computeCases();

test("the golden set covers all four views, with and without a search", () => {
  const keys = Object.keys(golden.cases);
  for (const v of VIEWS) {
    assert.ok(keys.some((k) => k.startsWith(v + "|") && k.endsWith("|none")), v + " without a search");
    assert.ok(keys.some((k) => k.startsWith(v + "|") && k.endsWith("|search")), v + " with a search");
  }
  assert.deepStrictEqual(Object.keys(now).sort(), keys.slice().sort());
});

for (const view of VIEWS) {
  test(`${view}: frames, centres and zoom equal the 0.12.1 goldens bit for bit`, () => {
    const keys = Object.keys(golden.cases).filter((k) => k.startsWith(view + "|"));
    assert.ok(keys.length > 0);
    for (const k of keys) {
      const g = golden.cases[k];
      const n = now[k];
      assert.ok(n, "case missing now: " + k);
      assert.strictEqual(n.frame, g.frame, `${k}: frame differs (golden head ${g.frameHead}, now ${n.frameHead})`);
      assert.strictEqual(n.centre, g.centre, `${k}: centre differs (golden head ${g.centreHead}, now ${n.centreHead})`);
      assert.strictEqual(n.zoom, g.zoom, `${k}: zoom differs`);
      assert.strictEqual(n.status, g.status, `${k}: status differs`);
    }
  });
}
