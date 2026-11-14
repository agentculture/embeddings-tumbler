"use strict";
// Test helpers: load the assembled file, or individual source modules, with no dependencies.
// Everything is loaded with require(), node's own module loader: no eval, no node:vm.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { byCodeUnits } = require("./order.js");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_DIR = path.join(ROOT, "js", "src");
const ASSEMBLED = path.join(ROOT, "embeddings_tumbler", "static", "embeddings-tumbler.js");

// The assembled file as node sees it: its public API object (module.exports).
function loadAssembled() {
  return require(ASSEMBLED);
}

// Load a script that exists only as text (the source modules joined, or a shell run against
// a stand-in global object) through require(): it is written to a file of its own in the
// temporary folder as the body of a function whose parameters are `names`, required, and
// called with `values`. Each call runs the text afresh (the file is removed from require's
// cache and from disk), so no state carries over from one load to the next.
let generated = 0;
function runAsFunction(code, names, values, label) {
  generated++;
  const file = path.join(os.tmpdir(), "et-test-" + process.pid + "-" + generated + "-" + label + ".js");
  fs.writeFileSync(file, "module.exports = function (" + names.join(", ") + ") {\n" + code + "\n};\n");
  try {
    return require(file)(...values);
  } finally {
    delete require.cache[file];
    fs.rmSync(file, { force: true });
  }
}

// Evaluate source modules in filename order, as the assembler would, afresh each time.
// `names` is an optional list of file names (e.g. ["10-math.js"]); 00-header.js and
// 99-footer.js are always included. Returns the public API object; the shared internal
// namespace (ET) is api._internal. `extraGlobals` ({ name: value }) are visible to the
// modules as free variables.
function loadSources(names, extraGlobals) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const all = fs.readdirSync(SRC_DIR).filter((f) => /^\d\d-.*\.js$/.test(f)).sort(byCodeUnits);
  const wanted = names
    ? all.filter((f) => f === "00-header.js" || f === "99-footer.js" || names.includes(f))
    : all;
  const code = wanted
    .map((f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8").replaceAll("@@VERSION@@", version))
    .join("\n");
  const mod = { exports: {} };
  const globals = { module: mod, console, ...extraGlobals };
  runAsFunction(code, Object.keys(globals), Object.values(globals), "sources");
  return mod.exports;
}

module.exports = { loadAssembled, loadSources, runAsFunction, ROOT, SRC_DIR, ASSEMBLED };
