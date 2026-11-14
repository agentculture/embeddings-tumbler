"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { loadAssembled, loadSources } = require("./helpers/load.js");

test("assembled file exports the public API object with a version", () => {
  const api = loadAssembled();
  assert.strictEqual(typeof api, "object");
  assert.match(api.version, /^\d+\.\d+\.\d+/);
});

test("sources load the same way as the assembled file", () => {
  assert.strictEqual(loadSources().version, loadAssembled().version);
});
