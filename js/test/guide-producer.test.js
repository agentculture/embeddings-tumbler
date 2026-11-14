"use strict";
// The producer guide's second producer (docs/guides/examples/producer/write_data_file.py, written
// from the guide alone) must emit a data file pair that the real loader accepts, in both the
// text-bearing and the labels-only form; and the guide's minimal file must load too.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadSources, ROOT } = require("./helpers/load.js");

const C = loadSources(["20-contract.js"])._internal.contract;
const PRODUCER = path.join(ROOT, "docs", "guides", "examples", "producer");

function folderFetch(dir) {
  return (url) => {
    const file = path.join(dir, url);
    if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404 });
    const bytes = fs.readFileSync(file);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => JSON.parse(bytes.toString("utf8")),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  };
}

// The script only reads and writes inside the folder it runs in, so it runs in the temporary
// folder, with the sample input copied there, and writes the pair into that same folder.
function run(extra, name, dir) {
  fs.copyFileSync(path.join(PRODUCER, "sample-input.jsonl"), path.join(dir, "sample-input.jsonl"));
  const r = spawnSync(
    "python3",
    ["-I", path.join(PRODUCER, "write_data_file.py"), "sample-input.jsonl", ".", name,
      "--model", "synthetic/cold-test", "--synthetic", "--seed", "7", "--limitation", "made-up vectors"].concat(extra),
    { encoding: "utf8", cwd: dir }
  );
  assert.strictEqual(r.status, 0, r.stderr);
}

test("the second producer's text-bearing output is accepted by the loader", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guide-producer-"));
  run([], "set", dir);
  const r = await C.loadFile("set.json", folderFetch(dir), null);
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.set.count, 320);
  assert.strictEqual(r.set.dimension, 12);
  assert.strictEqual(r.set.text_included, true);
});

test("the second producer's labels-only output is accepted and carries no text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guide-producer-"));
  run(["--labels-only", "--keep-groups"], "lo", dir);
  const r = await C.loadFile("lo.json", folderFetch(dir), null);
  assert.ok(r.ok, r.message);
  assert.strictEqual(r.set.text_included, false);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "lo.json"), "utf8"));
  for (const p of data.points) {
    assert.strictEqual(p.label, p.id);
    assert.ok(!("metadata" in p));
  }
});

test("the guide's minimal file and the committed example data load", async () => {
  for (const [dir, name, count] of [
    [PRODUCER, "minimal.json", 2],
    [path.join(ROOT, "docs", "guides", "examples", "script"), "space.json", 320],
  ]) {
    const r = await C.loadFile(name, folderFetch(dir), null);
    assert.ok(r.ok, name + ": " + r.message);
    assert.strictEqual(r.set.count, count);
  }
});
