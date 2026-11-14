"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadAssembled, runAsFunction, ROOT } = require("./helpers/load.js");

const SAMPLE_FILE = path.join(ROOT, "js", "sample", "sample-data.js");
const REFERENCE = path.join(ROOT, "docs", "specs", "reference", "embedding-tumbler-demo.html");
const sample = require(SAMPLE_FILE);
const { byCodeUnits } = require("./helpers/order.js");
const ET = loadAssembled()._internal;

// Run the reference's own generator (cut out of the HTML by markers), with no globals of its own.
function runReference() {
  const html = fs.readFileSync(REFERENCE, "utf8");
  const start = html.indexOf("const D = 384, TAU");
  const end = html.indexOf("/* ---------- true neighbours");
  assert.ok(start > 0, "reference start marker found");
  assert.ok(end > start, "reference end marker found after the start");
  const code =
    "(function(){ 'use strict';\n" +
    html.slice(start, end) +
    "\nreturn { X, labels, regionOf, REGIONS, N, D, NAMED, isHalo }; })()";
  return runAsFunction("return " + code + ";", [], [], "reference-generator");
}
const ref = runReference();
const bytes = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

test("criterion 1: reference seed gives the reference's point count and group names", () => {
  const data = sample.generate();
  assert.strictEqual(data.count, ref.N);
  assert.strictEqual(data.count, 12288);
  assert.strictEqual(data.dimension, ref.D);
  const refGroups = Array.from(ref.REGIONS, (r) => r.name);
  assert.deepStrictEqual(
    [...new Set(data.points.map((p) => p.group))].filter((g) => g !== "").sort(byCodeUnits),
    [...refGroups].sort(byCodeUnits)
  );
  assert.strictEqual(refGroups.length, 11);
});

test("fidelity: labels, groups and vectors match the reference exactly", () => {
  const data = sample.generate();
  for (let i = 0; i < ref.N; i++) {
    assert.strictEqual(data.points[i].label, ref.labels[i] === null ? "" : ref.labels[i], "label " + i);
    const r = ref.regionOf[i];
    assert.strictEqual(data.points[i].group, r >= 0 ? ref.REGIONS[r].name : "", "group " + i);
  }
  assert.strictEqual(ref.NAMED, 290);
  assert.strictEqual(data.points.filter((p) => p.label !== "").length, ref.NAMED);
  assert.strictEqual(data.vectors.length, ref.X.length);
  assert.strictEqual(Buffer.compare(bytes(data.vectors), bytes(ref.X)), 0, "vector bytes identical");
});

test("criterion 2: output passes the contract loader; provenance says synthetic", () => {
  for (const dimension of [384, 1024]) {
    const data = sample.generate({ dimension });
    const r = ET.contract.validate(data, null);
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.set.dimension, dimension);
    assert.strictEqual(r.set.provenance.synthetic, true);
    assert.strictEqual(r.set.count, 12288);
  }
  const p = sample.generate().provenance;
  assert.strictEqual(p.synthetic, true);
  assert.strictEqual(p.seed, 20261113);
  assert.match(p.source, /synthetic/);
  assert.ok(p.limitations.some((l) => /generated/.test(l)));
  assert.ok(p.limitations.some((l) => /month ring/.test(l) && /temperature arc/.test(l)));
  assert.match(sample.generate().model, /^synthetic\//);
});

test("determinism: same seed same bytes; different seed different data", () => {
  const a = sample.generate({ count: 600 });
  const b = sample.generate({ count: 600 });
  assert.strictEqual(Buffer.compare(bytes(a.vectors), bytes(b.vectors)), 0);
  assert.deepStrictEqual(a.points, b.points);
  const c = sample.generate({ count: 600, seed: 7 });
  assert.notStrictEqual(Buffer.compare(bytes(a.vectors), bytes(c.vectors)), 0);
  assert.strictEqual(c.provenance.seed, 7);
  assert.ok(ET.contract.validate(c, null).ok);
});

test("options: count scale, dimension, bad options refused", () => {
  assert.strictEqual(sample.generate({ count: 400 }).count, 400);
  assert.throws(() => sample.generate({ count: 10 }), RangeError);
  assert.throws(() => sample.generate({ dimension: 2 }), RangeError);
  assert.throws(() => sample.generate({ seed: 1.5 }), RangeError);
});

test("ids are unique and every vector is finite", () => {
  const data = sample.generate({ count: 1000, dimension: 64 });
  assert.strictEqual(new Set(data.points.map((p) => p.id)).size, 1000);
  assert.ok(data.vectors.every(Number.isFinite));
});

test("timing (informational)", () => {
  for (const dimension of [384, 1024]) {
    const t0 = process.hrtime.bigint();
    const data = sample.generate({ dimension });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log("generate() at " + dimension + "-d: " + ms.toFixed(0) + " ms");
    assert.strictEqual(data.dimension, dimension);
    assert.strictEqual(data.vectors.length, data.count * dimension);
    assert.ok(Number.isFinite(ms));
    assert.ok(ms >= 0);
  }
});
