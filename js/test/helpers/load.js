"use strict";
// Test helpers: load the assembled file, or individual source modules, with no dependencies.
// (The ban on eval / new Function / dynamic code applies to the ASSEMBLED file only;
// this helper uses node:vm.)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC_DIR = path.join(ROOT, "js", "src");
const ASSEMBLED = path.join(ROOT, "embeddings_tumbler", "static", "embeddings-tumbler.js");

// The assembled file as node sees it: its public API object (module.exports).
function loadAssembled() {
  return require(ASSEMBLED);
}

// Evaluate source modules in filename order, as the assembler would, in a fresh context.
// `names` is an optional list of file names (e.g. ["10-math.js"]); 00-header.js and
// 99-footer.js are always included. Returns the public API object; the shared internal
// namespace (ET) is api._internal. `extraGlobals` are added to the context.
function loadSources(names, extraGlobals) {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const all = fs.readdirSync(SRC_DIR).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
  const wanted = names
    ? all.filter((f) => f === "00-header.js" || f === "99-footer.js" || names.includes(f))
    : all;
  const code = wanted
    .map((f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8").replace(/@@VERSION@@/g, version))
    .join("\n");
  const mod = { exports: {} };
  const context = vm.createContext(Object.assign({ module: mod, console }, extraGlobals || {}));
  vm.runInContext(code, context, { filename: "assembled-from-sources.js" });
  return mod.exports;
}

module.exports = { loadAssembled, loadSources, ROOT, SRC_DIR, ASSEMBLED };
