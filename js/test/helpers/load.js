"use strict";
// Test helpers: load the assembled file, or individual source modules, with no dependencies.
// Everything is loaded with require(), node's own module loader: no eval, no node:vm.
const crypto = require("node:crypto");
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
//
// Coverage. node's coverage report names files, and a file that is gone when the report is
// written is left out, so text run this way is counted nowhere. When the environment variable
// ET_COVERAGE_DIR names a folder inside the repository (only the coverage step of CI sets it),
// the file is written there instead, named by a hash of its content and the process id, and
// is kept, with a map beside it (`<name>.sources.json`) that says which lines of it are which
// lines of which source file. scripts/js_coverage.py reads the maps and gives the hits to the
// source files. `sources` is that list for `code`: [{ file, first, count }], `first` being the
// line of `code` (from 1) where the file's text starts; text that is not a source file (a
// stand-in, an extract of a page) has no entry. Nothing else differs: the text, the
// parameters and the fresh run on every call are the same either way.
const COVERAGE_VARIABLE = "ET_COVERAGE_DIR";
let generated = 0;

function lineCount(text) {
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") || text === "" ? breaks : breaks + 1;
}

// The map entry for a file whose whole text is the code.
function wholeFile(file, text) {
  return { file, first: 1, count: lineCount(text) };
}

// The folder ET_COVERAGE_DIR names, or null when it is not set. A folder that is not inside
// the repository is refused: generated files are only ever written under the repository root.
function coverageFolder() {
  const value = process.env[COVERAGE_VARIABLE];
  if (!value) return null;
  const folder = path.resolve(ROOT, value);
  if (!folder.startsWith(ROOT + path.sep)) {
    throw new Error(COVERAGE_VARIABLE + " must name a folder inside the repository, not " + value);
  }
  return folder;
}

function insideRoot(file) {
  const full = path.resolve(file);
  return full.startsWith(ROOT + path.sep) ? path.relative(ROOT, full).split(path.sep).join("/") : null;
}

function writeKept(folder, text, label, sources) {
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  const name = hash + "-" + process.pid;
  const file = path.join(folder, name + ".js");
  if (!fs.existsSync(file)) {
    const map = {
      generated: name + ".js",
      label,
      // One line of wrapper comes before the code.
      sources: (sources || [])
        .map((s) => ({ path: insideRoot(s.file), first: s.first + 1, count: s.count }))
        .filter((s) => s.path !== null && s.count > 0),
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, name + ".sources.json"), JSON.stringify(map) + "\n");
    fs.writeFileSync(file, text);
  }
  return file;
}

function runAsFunction(code, names, values, label, sources) {
  generated++;
  const text = "module.exports = function (" + names.join(", ") + ") {\n" + code + "\n};\n";
  const folder = coverageFolder();
  const file = folder
    ? writeKept(folder, text, label, sources)
    : path.join(os.tmpdir(), "et-test-" + process.pid + "-" + generated + "-" + label + ".js");
  if (!folder) fs.writeFileSync(file, text);
  try {
    return require(file)(...values);
  } finally {
    delete require.cache[file];
    if (!folder) fs.rmSync(file, { force: true });
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
  // The version token sits inside one line, so replacing it moves no line.
  const texts = wanted.map((f) => fs.readFileSync(path.join(SRC_DIR, f), "utf8").replaceAll("@@VERSION@@", version));
  const code = texts.join("\n");
  // Where each module's text starts in `code`: the join puts one line break after each text.
  const sources = [];
  let line = 1;
  texts.forEach((text, i) => {
    sources.push({ file: path.join(SRC_DIR, wanted[i]), first: line, count: lineCount(text) });
    line += text.split("\n").length;
  });
  const mod = { exports: {} };
  const globals = { module: mod, console, ...extraGlobals };
  runAsFunction(code, Object.keys(globals), Object.values(globals), "sources", sources);
  return mod.exports;
}

module.exports = { loadAssembled, loadSources, runAsFunction, wholeFile, COVERAGE_VARIABLE, ROOT, SRC_DIR, ASSEMBLED };
