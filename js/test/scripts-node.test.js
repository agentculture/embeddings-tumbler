"use strict";
// The two node scripts under scripts/ run as commands: they read process.argv and end the
// process themselves, so each is run here as a child process (node hands its coverage
// setting on to child processes, so their lines are counted). No browser is involved: the
// comparison script mounts the assembled file on the fake DOM and GPU of js/test/helpers/.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ROOT } = require("./helpers/load.js");

const COMPARE = path.join(ROOT, "scripts", "compare_relative_reference.js");
const GOLDEN_SCRIPT = path.join(ROOT, "scripts", "gen_relative_off_golden.js");
const GOLDEN = path.join(ROOT, "js", "test", "fixtures", "relative-off-golden.json");
const PAIR = path.join(ROOT, "embeddings_tumbler", "static", "demo-wikipedia.json");
const RERANK = path.join(ROOT, "docs", "specs", "reference", "demo-wikipedia-rerank.json");

// Output is held as text and only ever compared piece by piece: a failed assertion must not
// print a whole result.
function run(script, args) {
  const done = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: done.status, out: done.stdout || "", err: done.stderr || "" };
}

test("the golden generator refuses to overwrite the fixture without --force", () => {
  const before = fs.readFileSync(GOLDEN);
  const done = run(GOLDEN_SCRIPT, []);
  assert.strictEqual(done.status, 1);
  assert.strictEqual(done.out, "");
  assert.match(done.err, /^refusing to overwrite .*relative-off-golden\.json \(pass --force, from a 0\.12\.1 checkout\)\n$/);
  assert.ok(fs.readFileSync(GOLDEN).equals(before), "the fixture is untouched");
});

test("the comparison script without its three arguments says how it is called", () => {
  for (const args of [[], [PAIR], [PAIR, RERANK]]) {
    const done = run(COMPARE, args);
    assert.strictEqual(done.status, 2);
    assert.strictEqual(done.out, "");
    assert.strictEqual(done.err, "usage: compare_relative_reference.js <pair.json> <rerank.json> <label>\n");
  }
});

test("the comparison script refuses a label the set does not hold", () => {
  const done = run(COMPARE, [PAIR, RERANK, "No such article, surely"]);
  assert.strictEqual(done.status, 2);
  assert.strictEqual(done.out, "");
  assert.strictEqual(done.err, "no point labelled No such article, surely\n");
});

test("the comparison script reports the relative view of a search from one article", () => {
  const done = run(COMPARE, [PAIR, RERANK, "Rice"]);
  assert.strictEqual(done.err, "");
  assert.strictEqual(done.status, 0);
  assert.strictEqual(done.out.split("\n").length, 2, "one line of JSON");
  const out = JSON.parse(done.out);
  const meta = JSON.parse(fs.readFileSync(PAIR, "utf8"));
  const own = meta.points.findIndex((p) => p.label === "Rice");

  assert.strictEqual(out.model, meta.model);
  assert.strictEqual(out.count, meta.count);
  assert.strictEqual(out.dimension, meta.dimension);
  assert.strictEqual(out.label, "Rice");
  assert.strictEqual(out.own.index, own);
  assert.strictEqual(out.own.id, meta.points[own].id);
  assert.strictEqual(out.settled, true);
  // One search, so one pinned axis: the vertical one, along a direction of unit length.
  assert.strictEqual(out.pinned.length, 1);
  assert.strictEqual(out.pinned[0].axis, "vertical");
  assert.strictEqual(out.pinned[0].letter, "A");
  assert.ok(Math.abs(out.pinned[0].length - 1) < 1e-6);
  // The vertical axis is the search's own direction, to float32 accuracy.
  assert.ok(out.row1Error < 1e-6, "row 1 of the frame is the search direction");

  // Nine results, the article itself first at height 1, the rest in falling height.
  assert.strictEqual(out.plain.length, 9);
  assert.strictEqual(out.plain[0].index, own);
  assert.ok(Math.abs(out.plain[0].height - 1) < 1e-5);
  for (let j = 0; j < out.plain.length; j++) {
    assert.strictEqual(out.plain[j].rank, j + 1);
    assert.ok(Math.abs(out.plain[j].height - out.plain[j].cosine) < 1e-6, "height is the cosine on a unit-length set");
    if (j > 0) assert.ok(out.plain[j].height <= out.plain[j - 1].height);
  }

  // The reranker was given the 51 candidates, knew every one, and kept the article first.
  assert.strictEqual(out.sent, 51);
  assert.strictEqual(out.unknownCandidates.length, 0);
  assert.strictEqual(out.reranker, "reference-file/scores");
  assert.strictEqual(out.reranked.length, 9);
  assert.strictEqual(out.reranked[0].index, own);
  assert.strictEqual(out.statusHasReranker, true);
  // Reranking changes the order, not where a point stands: a point named both ways has one height.
  const heights = new Map(out.plain.map((r) => [r.index, r.height]));
  for (const r of out.reranked) {
    if (heights.has(r.index)) assert.strictEqual(r.height, heights.get(r.index));
  }
  assert.strictEqual(out.overlayRanks.length, 9);
});
