"use strict";
// Ids, groups and metadata keys are untrusted strings: names that an ordinary
// object treats specially ("__proto__", "constructor", ...) must behave like any
// other name in every check and every index.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");

const C = loadSources(["20-contract.js"])._internal.contract;
const PROV = { source: "test", producer: "test", synthetic: true, seed: null, limitations: [], uncertain: [] };
const D = 3;
const SPECIAL = ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"];

function data(ids, op) {
  const pts = ids.map((id) => ({ id: id, label: "L" + id }));
  const d = { kind: "embeddings-tumbler/data", schema_version: 1, model: "m", dimension: D, count: ids.length, text_included: false, vectors: new Float32Array(ids.length * D).fill(1), points: pts };
  if (op) d.op = op;
  else d.provenance = PROV;
  return d;
}

for (const name of SPECIAL) {
  test("two points with the id " + JSON.stringify(name) + " are refused as duplicates", () => {
    const r = C.validate(data([name, name]), null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "duplicate-id");
  });
  test("one point with the id " + JSON.stringify(name) + " is accepted", () => {
    const r = C.validate(data([name, "b"]), null);
    assert.ok(r.ok, r.message);
    assert.deepStrictEqual(Array.from(r.set.ids), [name, "b"]);
  });
  test("an append repeating the id " + JSON.stringify(name) + " is refused with id-exists", () => {
    const base = C.validate(data([name, "b"]), null).set;
    const r = C.validate(data([name], "append"), base);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, "id-exists");
    const ok = C.validate(data(["c"], "append"), base);
    assert.ok(ok.ok, ok.message);
  });
}

test("a metadata key named __proto__ is kept as a key, not turned into a prototype", () => {
  const d = data(["a"]);
  d.points[0].metadata = JSON.parse('{"__proto__": {"polluted": 1}, "constructor": "c", "n": 2}');
  const r = C.validate(d, null);
  assert.ok(r.ok, r.message);
  const md = r.set.points[0].metadata;
  assert.deepStrictEqual(Array.from(Object.keys(md)).sort(), ["__proto__", "constructor", "n"]);
  assert.strictEqual(md.polluted, undefined);
  assert.strictEqual(Object.getPrototypeOf(Object.getPrototypeOf(md)), null, "an ordinary object");
  assert.strictEqual(JSON.stringify(md), '{"__proto__":{"polluted":1},"constructor":"c","n":2}');
  assert.strictEqual({}.polluted, undefined);
});
