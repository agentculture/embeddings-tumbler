"use strict";
// Appends that do not copy the base's vectors: successive sets share one buffer with
// spare capacity, and every set stays valid and unchanged in everything a reader sees.
const test = require("node:test");
const assert = require("node:assert");
const { loadSources } = require("./helpers/load.js");

const C = loadSources(["20-contract.js"])._internal.contract;
const PROV = { source: "test", producer: "test", synthetic: true, seed: null, limitations: [], uncertain: [] };
const D = 6;

function rows(n, from) {
  const v = new Float32Array(n * D);
  for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) v[i * D + d] = (from + i) * 10 + d;
  return v;
}
function points(n, from, tag) {
  const p = [];
  for (let i = 0; i < n; i++) p.push({ id: (tag || "p") + (from + i), label: "L" + (from + i) });
  return p;
}
function full(n) {
  const r = C.validate(
    { kind: "embeddings-tumbler/data", schema_version: 1, model: "m", dimension: D, count: n, text_included: false, provenance: PROV, vectors: rows(n, 0), points: points(n, 0) },
    null,
  );
  assert.ok(r.ok, r.message);
  return r.set;
}
function append(base, n, from, tag) {
  return C.validate(
    { kind: "embeddings-tumbler/data", schema_version: 1, op: "append", model: "m", dimension: D, count: n, text_included: false, vectors: rows(n, from), points: points(n, from, tag) },
    base,
  );
}
// What a reader can observe about a set, copied.
function snapshot(set) {
  return { count: set.count, ids: set.ids.slice(), points: JSON.stringify(set.points), vectors: Array.from(set.vectors) };
}
function assertSnapshot(set, snap, what) {
  assert.strictEqual(set.count, snap.count, what + ": count");
  assert.deepStrictEqual(set.ids.slice(), snap.ids, what + ": ids");
  assert.strictEqual(JSON.stringify(set.points), snap.points, what + ": points");
  assert.strictEqual(set.vectors.length, set.count * D, what + ": vectors length");
  assert.deepStrictEqual(Array.from(set.vectors), snap.vectors, what + ": vectors");
}
function assertRows(set, expectedFrom) {
  // row i of the set holds rows(…, expectedFrom[i]) values
  assert.strictEqual(set.vectors.length, set.count * D);
  for (let i = 0; i < set.count; i++) {
    for (let d = 0; d < D; d++) assert.strictEqual(set.vectors[i * D + d], expectedFrom[i] * 10 + d);
  }
}

test("a chain of appends: every set is correct, earlier sets stay unchanged, the buffer is shared", () => {
  let cur = full(5);
  const sets = [cur];
  const snaps = [snapshot(cur)];
  let shared = 0;
  for (let k = 0; k < 30; k++) {
    const r = append(cur, 3, 100 + k * 3, "a");
    assert.ok(r.ok, r.message);
    assert.notStrictEqual(r.set, cur, "an append returns a new set");
    if (r.set.vectors.buffer === cur.vectors.buffer) shared++;
    cur = r.set;
    sets.push(cur);
    snaps.push(snapshot(cur));
  }
  // most appends write into spare capacity instead of copying
  assert.ok(shared >= 25, `only ${shared} of 30 appends shared the buffer`);
  for (let i = 0; i < sets.length; i++) assertSnapshot(sets[i], snaps[i], "set " + i);
  const expected = [0, 1, 2, 3, 4];
  for (let k = 0; k < 90; k++) expected.push(100 + k);
  assertRows(cur, expected);
});

test("a fork: two appends onto the same base do not overwrite each other", () => {
  const base = append(full(4), 2, 50).set; // a set that is the newest view of its buffer
  const snapBase = snapshot(base);
  const a = append(base, 3, 200, "a");
  const snapA = snapshot(a.set);
  const b = append(base, 2, 300, "b");
  assert.ok(a.ok && b.ok);
  assertSnapshot(base, snapBase, "base");
  assertSnapshot(a.set, snapA, "A after B");
  assertRows(a.set, [0, 1, 2, 3, 50, 51, 200, 201, 202]);
  assertRows(b.set, [0, 1, 2, 3, 50, 51, 300, 301]);
  // and appending onto either branch afterwards keeps the other intact
  const a2 = append(a.set, 1, 400, "c").set;
  const b2 = append(b.set, 1, 500, "d").set;
  assertRows(a2, [0, 1, 2, 3, 50, 51, 200, 201, 202, 400]);
  assertRows(b2, [0, 1, 2, 3, 50, 51, 300, 301, 500]);
  assertSnapshot(a.set, snapA, "A after more appends");
});

test("an append onto an older set of a chain copies instead of overwriting the newer set", () => {
  const s0 = full(3);
  const s1 = append(s0, 2, 10).set;
  const s2 = append(s1, 2, 20).set;
  const snap2 = snapshot(s2);
  const s1b = append(s1, 4, 90, "x").set;
  assertSnapshot(s2, snap2, "the newer set");
  assertRows(s1b, [0, 1, 2, 10, 11, 90, 91, 92, 93]);
});

test("a refused append leaves the base and later appends untouched", () => {
  const base = append(full(3), 2, 10).set;
  const snap = snapshot(base);
  const bad = append(base, 2, 70, "p"); // a valid append onto the base first (a fork with `next` below)
  assert.ok(bad.ok);
  const refused = C.validate(
    { kind: "embeddings-tumbler/data", schema_version: 1, op: "append", model: "m", dimension: D, count: 1, text_included: false, vectors: rows(1, 99), points: [{ id: "p0", label: "dup" }] },
    base,
  );
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.code, "id-exists");
  assert.strictEqual(refused.set, base);
  assertSnapshot(base, snap, "base after refusal");
  const next = append(base, 1, 80, "q").set;
  assertRows(next, [0, 1, 2, 10, 11, 80]);
  assertRows(bad.set, [0, 1, 2, 10, 11, 70, 71]);
});

test("id checks on append still see every point of the base, after many appends", () => {
  let cur = full(2);
  for (let k = 0; k < 10; k++) cur = append(cur, 2, 1000 + 2 * k, "z").set;
  const r = C.validate(
    { kind: "embeddings-tumbler/data", schema_version: 1, op: "append", model: "m", dimension: D, count: 1, text_included: false, vectors: rows(1, 5), points: [{ id: "z1007", label: "" }] },
    cur,
  );
  assert.strictEqual(r.code, "id-exists");
  // an id that a fork added is not in the other branch
  const base = cur;
  const a = append(base, 1, 7000, "fork").set;
  const b = append(base, 1, 7000, "fork");
  assert.ok(b.ok, "the id fork7000 belongs to the other branch only");
  assert.strictEqual(a.count, b.set.count);
});

test("the host's block is never shared with a set", () => {
  const block = rows(4, 0);
  const r = C.validate(
    { kind: "embeddings-tumbler/data", schema_version: 1, model: "m", dimension: D, count: 4, text_included: false, provenance: PROV, vectors: block, points: points(4, 0) },
    null,
  );
  const add = rows(2, 9);
  const r2 = C.validate(
    { kind: "embeddings-tumbler/data", schema_version: 1, op: "append", model: "m", dimension: D, count: 2, text_included: false, vectors: add, points: points(2, 9) },
    r.set,
  );
  block[0] = -1;
  add[0] = -1;
  assert.strictEqual(r.set.vectors[0], 0);
  assert.strictEqual(r2.set.vectors[0], 0);
  assert.strictEqual(r2.set.vectors[4 * D], 90);
});
