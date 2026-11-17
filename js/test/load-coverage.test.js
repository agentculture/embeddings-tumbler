"use strict";
// The loader's coverage switch (js/test/helpers/load.js). Without ET_COVERAGE_DIR a text is run
// from a file in the temporary folder that is gone afterwards, as it always was. With it, the
// file is kept in the named folder with a map from its lines to the lines of the source files,
// which scripts/js_coverage.py reads. Either way the text runs afresh on every call.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadSources, runAsFunction, wholeFile, COVERAGE_VARIABLE, ROOT, SRC_DIR } = require("./helpers/load.js");

const FOLDER = "js-coverage-generated-test-" + process.pid;

// Run `body` with the variable set to `value` (or unset for undefined), then put it back.
function withVariable(value, body) {
  const before = process.env[COVERAGE_VARIABLE];
  if (value === undefined) delete process.env[COVERAGE_VARIABLE];
  else process.env[COVERAGE_VARIABLE] = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env[COVERAGE_VARIABLE];
    else process.env[COVERAGE_VARIABLE] = before;
    fs.rmSync(path.join(ROOT, FOLDER), { recursive: true, force: true });
  }
}

function kept() {
  const folder = path.join(ROOT, FOLDER);
  return fs.existsSync(folder) ? fs.readdirSync(folder).sort() : [];
}

function readMap(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, FOLDER, name), "utf8"));
}

test("without the variable the file is in the temporary folder and is gone afterwards", () => {
  withVariable(undefined, () => {
    const file = runAsFunction("return __filename;", [], [], "where");
    assert.strictEqual(path.dirname(file), os.tmpdir());
    assert.match(path.basename(file), /^et-test-\d+-\d+-where\.js$/);
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(fs.existsSync(path.join(ROOT, FOLDER)), false);
    assert.strictEqual(require.cache[file], undefined);
  });
});

test("with the variable the file is kept in that folder with a map of its lines", () => {
  withVariable(FOLDER, () => {
    const source = path.join(ROOT, "js", "shells", "web-component.js");
    const text = "var here = __filename;\nreturn [here, a + b];\n";
    const [file, sum] = runAsFunction(text, ["a", "b"], [2, 3], "kept", [wholeFile(source, text)]);
    assert.strictEqual(sum, 5);
    assert.strictEqual(path.dirname(file), path.join(ROOT, FOLDER));
    assert.match(path.basename(file), new RegExp("^[0-9a-f]{16}-" + process.pid + "\\.js$"));
    assert.strictEqual(fs.readFileSync(file, "utf8"), "module.exports = function (a, b) {\n" + text + "\n};\n");
    assert.strictEqual(require.cache[file], undefined);
    const stem = path.basename(file, ".js");
    assert.deepStrictEqual(kept(), [stem + ".js", stem + ".sources.json"]);
    assert.deepStrictEqual(readMap(stem + ".sources.json"), {
      generated: stem + ".js",
      label: "kept",
      // The wrapper is line 1, so the text's first line is line 2.
      sources: [{ path: "js/shells/web-component.js", first: 2, count: 2 }],
    });
  });
});

test("the same text twice is one file, and each call still runs afresh", () => {
  withVariable(FOLDER, () => {
    const text = "var made = {};\nreturn [__filename, made];";
    const [first, a] = runAsFunction(text, [], [], "twice");
    const [second, b] = runAsFunction(text, [], [], "twice");
    assert.strictEqual(first, second);
    assert.notStrictEqual(a, b);
    assert.strictEqual(kept().length, 2);
    // Text with no source file has a map with no entries.
    assert.deepStrictEqual(readMap(path.basename(first, ".js") + ".sources.json").sources, []);
  });
});

test("a source outside the repository gets no map entry", () => {
  withVariable(FOLDER, () => {
    const file = runAsFunction("return __filename;", [], [], "outside", [
      { file: path.join(os.tmpdir(), "elsewhere.js"), first: 1, count: 1 },
    ]);
    assert.deepStrictEqual(readMap(path.basename(file, ".js") + ".sources.json").sources, []);
  });
});

test("a folder outside the repository is refused and nothing is written", () => {
  for (const value of ["..", os.tmpdir(), "."]) {
    withVariable(value, () => {
      assert.throws(() => runAsFunction("return 1;", [], [], "refused"), /must name a folder inside the repository/);
    });
  }
});

test("the map of joined source modules points at each module's own lines", () => {
  withVariable(FOLDER, () => {
    const api = loadSources(["10-math.js"]);
    assert.strictEqual(typeof api._internal.math, "object");
    const maps = kept().filter((name) => name.endsWith(".sources.json"));
    assert.strictEqual(maps.length, 1);
    const map = readMap(maps[0]);
    assert.deepStrictEqual(
      map.sources.map((s) => s.path),
      ["js/src/00-header.js", "js/src/10-math.js", "js/src/99-footer.js"]
    );
    const lines = fs.readFileSync(path.join(ROOT, FOLDER, map.generated), "utf8").split("\n");
    for (const part of map.sources) {
      const own = fs.readFileSync(path.join(SRC_DIR, path.basename(part.path)), "utf8").split("\n");
      if (own[own.length - 1] === "") own.pop();
      assert.strictEqual(part.count, own.length, part.path);
      for (let i = 0; i < own.length; i++) {
        if (own[i].includes("@@VERSION@@")) continue;
        // A plain comparison first: a failed strictEqual would print both lines, which is fine
        // for one line, but the message names the place.
        if (lines[part.first - 1 + i] !== own[i]) assert.fail(part.path + " line " + (i + 1) + " is not where the map says");
      }
    }
  });
});

test("with and without the variable the modules behave the same", () => {
  const plain = withVariable(undefined, () => loadSources(["10-math.js"]));
  const mapped = withVariable(FOLDER, () => loadSources(["10-math.js"]));
  assert.strictEqual(plain.version, mapped.version);
  assert.deepStrictEqual(Object.keys(plain._internal.math).sort(), Object.keys(mapped._internal.math).sort());
});
