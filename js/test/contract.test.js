"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT } = require("./helpers/load.js");

const DIR = path.join(ROOT, "tests", "fixtures", "contract");
const INDEX = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));
const C = loadSources(["20-contract.js"])._internal.contract;

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
const readBytes = (f) => {
  const b = fs.readFileSync(path.join(DIR, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
// A fetch-like function over the fixtures folder (the module itself does no file access).
function fixtureFetch(url) {
  const file = path.join(DIR, url);
  return Promise.resolve(
    fs.existsSync(file)
      ? {
          ok: true,
          status: 200,
          json: async () => JSON.parse(fs.readFileSync(file, "utf8")),
          arrayBuffer: async () => readBytes(url),
        }
      : { ok: false, status: 404 }
  );
}
// Results come from another vm realm: compare through plain JSON values.
const plain = (v) => JSON.parse(JSON.stringify(v));
const ids = (set) => plain(set.ids);

async function loadBase(name) {
  if (name === null) return null;
  const r = await C.loadFile(name, fixtureFetch, null);
  assert.ok(r.ok, "base " + name + " must load");
  return r.set;
}

function checkOutcome(c, r, base) {
  if (c.valid) {
    assert.ok(r.ok, c.name + ": " + r.message);
    const e = c.expect;
    assert.strictEqual(r.set.count, e.count);
    assert.deepStrictEqual(ids(r.set), e.ids);
    assert.strictEqual(r.set.points.length, e.count);
    assert.strictEqual(r.set.model, e.model);
    assert.strictEqual(r.set.dimension, e.dimension);
    assert.strictEqual(r.set.reduction.kind, e.reduction);
    assert.strictEqual(r.set.text_included, e.text_included);
    assert.strictEqual(r.set.vectors.length, e.count * e.dimension);
  } else {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, c.refusal.code, c.name);
    assert.strictEqual(r.message, c.refusal.message, c.name);
    assert.strictEqual(r.set, base, c.name + ": existing set returned unchanged");
  }
}

test("message templates equal the index's templates, and cover all 15 codes", () => {
  assert.deepStrictEqual(plain(C.messages), INDEX.messages);
  assert.strictEqual(Object.keys(C.messages).length, 15);
  assert.deepStrictEqual(plain(C.supportedVersions), INDEX.schema_versions_supported);
});

// Cases whose outcome differs in the in-memory form because the form has no file descriptor.
const FILE_ONLY = new Set(["vector-file-path", "block-unreadable", "byte-length-declared"]);
const covered = { file: new Set(), memory: new Set() };

for (const c of INDEX.cases) {
  test("file form: " + c.name, async () => {
    covered.file.add(c.name);
    const base = await loadBase(c.base);
    const r = await C.loadFile(c.file, fixtureFetch, base);
    checkOutcome(c, r, base);
  });

  test("in-memory form: " + c.name, async () => {
    covered.memory.add(c.name);
    const base = await loadBase(c.base);
    const data = readJson(c.file);
    if (FILE_ONLY.has(c.name)) {
      // The descriptor object is not a valid in-memory vectors value.
      const r = C.validate(data, base);
      // (byte-length-declared and the others fail earlier or at "vectors" in this form.)
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, c.name === "vector-file-path" ? "invalid-field" : r.code);
      assert.strictEqual(r.set, base);
      return;
    }
    data.vectors = readBytes(data.vectors.file);
    checkOutcome(c, C.validate(data, base), base);
    // Same data with a Float32Array block (values, not bytes).
    data.vectors = new Float32Array(data.vectors);
    checkOutcome(c, C.validate(data, base), base);
  });
}

test("every index case is covered by this file", () => {
  const names = INDEX.cases.map((c) => c.name);
  assert.deepStrictEqual([...covered.file].sort(), [...names].sort());
  assert.deepStrictEqual([...covered.memory].sort(), [...names].sort());
  // Every fixture json in the folder is listed.
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
  for (const f of files) assert.ok(INDEX.cases.some((c) => c.file === f), f + " not in index");
  // Every refusal code appears in some case.
  const codes = new Set(INDEX.cases.filter((c) => !c.valid).map((c) => c.refusal.code));
  for (const code of Object.keys(INDEX.messages)) {
    if (code === "invalid-field") continue;
    assert.ok(codes.has(code), code + " has no fixture case");
  }
});

test("criterion 1: bumped version names the version found and supported", async () => {
  const r = await C.loadFile("bumped-version.json", fixtureFetch, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /schema version 2 is not supported/);
  assert.match(r.message, /reads schema version 1\./);
});

test("criterion 3: append keeps existing order, base untouched, reduction exposed", async () => {
  const base = await loadBase("valid-384.json");
  const snapshot = Array.from(base.vectors);
  const baseIds = ids(base);
  const app = await C.loadFile("append-384.json", fixtureFetch, base);
  assert.ok(app.ok);
  assert.notStrictEqual(app.set, base);
  assert.deepStrictEqual(ids(app.set).slice(0, 6), baseIds);
  assert.deepStrictEqual(ids(app.set).slice(6), ["d-01", "d-02"]);
  assert.deepStrictEqual(Array.from(app.set.vectors.subarray(0, 6 * 384)), snapshot);
  assert.strictEqual(app.set.provenance.source, base.provenance.source);
  // old set untouched
  assert.strictEqual(base.count, 6);
  assert.strictEqual(base.vectors.length, 6 * 384);
  assert.deepStrictEqual(ids(base), baseIds);
  const rot = await loadBase("valid-1024.json");
  assert.strictEqual(rot.reduction.kind, "rotation");
  assert.strictEqual(rot.reduction.directions_kept, 1024);
  const tk = await loadBase("top-k-16.json");
  assert.deepStrictEqual(plain(tk.reduction), readJson("top-k-16.json").reduction);
});

test("labels, group defaults and metadata are kept as data", async () => {
  const s = await loadBase("valid-384.json");
  assert.strictEqual(s.points[2].label, "<b>markup is text</b> & <script>not run</script>");
  assert.strictEqual(s.points[5].group, "");
  assert.deepStrictEqual(plain(s.points[5].metadata), {});
  assert.deepStrictEqual(plain(s.points[4].metadata), { nested: { k: [1, 2] } });
});

test("ArrayBuffer block is little-endian bytes; Float32Array view uses its own range", () => {
  const mk = (extra) =>
    Object.assign(
      {
        schema_version: 1,
        kind: "embeddings-tumbler/data",
        model: "m",
        dimension: 2,
        count: 1,
        text_included: false,
        provenance: {
          source: "s", producer: "p", synthetic: true, seed: null, limitations: [], uncertain: [],
        },
        points: [{ id: "x", label: "x" }],
      },
      extra
    );
  const bytes = new Uint8Array(8);
  const dv = new DataView(bytes.buffer);
  dv.setFloat32(0, 1.5, true);
  dv.setFloat32(4, -2.25, true);
  let r = C.validate(mk({ vectors: bytes.buffer }), null);
  assert.deepStrictEqual(Array.from(r.set.vectors), [1.5, -2.25]);
  const big = new Float32Array([9, 9, 1.5, -2.25, 9]);
  r = C.validate(mk({ vectors: big.subarray(2, 4) }), null);
  assert.ok(r.ok);
  assert.deepStrictEqual(Array.from(r.set.vectors), [1.5, -2.25]);
  // the set holds a copy, not the host's buffer
  big[2] = 100;
  assert.strictEqual(r.set.vectors[0], 1.5);
  // descriptor object as vectors is refused
  r = C.validate(mk({ vectors: { file: "a.f32" } }), null);
  assert.strictEqual(r.code, "invalid-field");
  assert.strictEqual(r.message, 'Field "vectors" is missing or not valid.');
  // wrong-length Float32Array
  r = C.validate(mk({ vectors: new Float32Array(3) }), null);
  assert.strictEqual(r.code, "block-length");
  assert.match(r.message, /is 12 bytes; expected 1 points x 2 dimensions x 4 bytes = 8 bytes/);
});

test("refusals never throw, and return the held set", () => {
  for (const bad of [null, undefined, 5, "x", [], { kind: "embeddings-tumbler/data" }]) {
    const r = C.validate(bad, null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.set, null);
  }
  const hostile = { get kind() { throw new Error("boom"); } };
  assert.strictEqual(C.validate(hostile, null).ok, false);
});

test("schema-version placeholder forms", () => {
  const f = (v) => C.validate(Object.assign({ kind: "embeddings-tumbler/data" }, v), null).message;
  assert.match(f({}), /version missing is not/);
  assert.match(f({ schema_version: "1" }), /version "1" is not/);
  assert.match(f({ schema_version: null }), /version null is not/);
  assert.match(f({ schema_version: 1.5 }), /version 1.5 is not/);
});

test("loadFile resolves the block beside the JSON file and never rejects", async () => {
  const seen = [];
  const f = (url) => {
    seen.push(url);
    return fixtureFetch(url.split("?")[0]);
  };
  const r = await C.loadFile("valid-384.json?x=1#h", f, null);
  assert.ok(r.ok);
  assert.deepStrictEqual(seen, ["valid-384.json?x=1#h", "valid-384.f32"]);
  const rej = await C.loadFile("a.json", () => Promise.reject(new Error("net")), null);
  assert.strictEqual(rej.ok, false);
  const nonJson = await C.loadFile("a.json", async () => ({ ok: true, json: async () => { throw new Error("x"); } }), null);
  assert.strictEqual(nonJson.ok, false);
});
