"use strict";
// docs/relative-interface.md is the contract the relative-search tasks build against (task t1
// of docs/plans/2026-11-16-relative-search-in-the-embedding-viewer.md). It carries three kinds
// of machine-readable block:
//
//   <!-- interface-names module="10-math.js" object="ET.math" match="present" task="t2" prefix="ET.math." landed="auto" -->
//   ```text
//   relativeFit
//   ```
//     Function names (match="present") or non-function members (match="constants") that the
//     module publishes on the object: ET.<name>, ET.<name>.<member>, "handle" (a mounted
//     viewer's handle) or "mode:<id>" (a mode instance).
//
//   <!-- interface-strings module="40-mode-tumble.js,39-modes.js" task="t6" landed="auto" -->
//     On-screen strings with {placeholders}: every piece of text between placeholders must
//     appear in at least one of the listed js/src files.
//
//   <!-- interface-text file="js/page/page.js" task="t12" landed="auto" -->
//     Literal text that must appear in a file outside js/src (the shells).
//
// landed="auto": skipped while none of the block's names exists (for strings and text: while
// the first line is not found); once one does, every one must. landed="yes": always checked.
// A block whose module or file does not exist yet is skipped. A task that lands a block flips
// it to landed="yes" in the page. The modules are loaded afresh from js/src (loadSources): the
// assembled file is rebuilt only at merge, so the sources are what a task changes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT, SRC_DIR } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeFakeCanvas } = require("./helpers/fake-gl.js");

const PAGE = "docs/relative-interface.md";
const KINDS = ["interface-names", "interface-strings", "interface-text"];
const BLOCK = /<!-- (interface-names|interface-strings|interface-text) ([^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/g;
const ATTR = /(\w+)="([^"]*)"/g;
const PLACEHOLDER = /\{[A-Za-z]+\}/;

function parseBlocks(text) {
  const blocks = [];
  for (const m of text.matchAll(BLOCK)) {
    const attrs = {};
    for (const a of m[2].matchAll(ATTR)) attrs[a[1]] = a[2];
    const lines = m[3].split("\n").filter((s) => s.trim() !== "");
    // Names are trimmed; strings and text keep their spaces (a leading " · " is part of them).
    const names = m[1] === "interface-names" ? lines.map((s) => s.trim()) : lines;
    blocks.push({ kind: m[1], attrs, names });
  }
  return blocks;
}

// The pieces of a string template that must appear in the source, in order of appearance.
function fragments(template) {
  return template.split(PLACEHOLDER).filter((f) => f.length > 0);
}

function foundIn(source, template) {
  return fragments(template).every((f) => source.includes(f));
}

// Whether one name of an interface-names block is there on the object.
function present(block, obj, name) {
  if (obj === null || obj === undefined) return false;
  if (block.attrs.match === "constants") return name in obj && typeof obj[name] !== "function";
  return typeof obj[name] === "function";
}

// null when the block and the object agree, else a plain description.
function compareNames(block, obj) {
  if (block.attrs.match !== "present" && block.attrs.match !== "constants") {
    return "unknown match kind " + JSON.stringify(block.attrs.match);
  }
  const missing = block.names.filter((n) => !present(block, obj, n));
  return missing.length ? "missing from the module: [" + missing.join(", ") + "]" : null;
}

function compareLines(block, source) {
  const missing = block.names.filter((t) => !foundIn(source, t));
  return missing.length ? "not found in the source: " + missing.map((t) => JSON.stringify(t)).join(", ") : null;
}

// landed="auto" blocks wait for their first sign of life.
function waiting(block, probe) {
  if (block.attrs.landed === "yes") return false;
  if (block.kind === "interface-names") return !block.names.some((n) => probe(n));
  return !probe(block.names[0]);
}

function missingModules(block) {
  return block.attrs.module.split(",").filter((f) => !fs.existsSync(path.join(SRC_DIR, f.trim())));
}

function sourceOf(block) {
  if (block.kind === "interface-text") return fs.readFileSync(path.join(ROOT, block.attrs.file), "utf8");
  return block.attrs.module
    .split(",")
    .map((f) => fs.readFileSync(path.join(SRC_DIR, f.trim()), "utf8"))
    .join("\n");
}

// The object a block documents, from a fresh load of every module (undefined when the module
// does not publish it yet).
function objectFor(spec) {
  const api = loadSources();
  const ET = api._internal;
  if (spec.startsWith("ET.")) {
    let obj = ET;
    for (const part of spec.slice(3).split(".")) {
      obj = obj === null || obj === undefined ? undefined : obj[part];
    }
    return obj;
  }
  if (spec === "renderer") {
    const res = ET.renderer.create(makeFakeCanvas().canvas);
    assert.ok(res.ok, res.message);
    return res.renderer;
  }
  if (spec === "handle") {
    const dom = makeFakeDom();
    const handle = api.mount(dom.host(), { seed: 1 });
    handle.destroy();
    return handle;
  }
  if (spec.startsWith("mode:")) return ET.modes.create(spec.slice(5));
  throw new Error("unknown object " + spec);
}

const pageText = fs.readFileSync(path.join(ROOT, PAGE), "utf8");
const blocks = parseBlocks(pageText);

// ---------- the page and its blocks ----------

test("the page exists and carries blocks of all three kinds", () => {
  for (const kind of KINDS) {
    assert.ok(
      blocks.some((b) => b.kind === kind),
      PAGE + " has no " + kind + " block",
    );
  }
});

test("every block names its owning task and a landed state, and lists names without repeats", () => {
  for (const b of blocks) {
    assert.match(b.attrs.task || "", /^t\d+$/, PAGE + ": a " + b.kind + " block has no task");
    assert.ok(["auto", "yes"].includes(b.attrs.landed), PAGE + ": block of " + b.attrs.task + ' needs landed="auto" or "yes"');
    assert.ok(b.names.length > 0, PAGE + ": a block of " + b.attrs.task + " is empty");
    assert.strictEqual(new Set(b.names).size, b.names.length, "a repeated line in a block of " + b.attrs.task);
    if (b.kind === "interface-text") assert.ok(b.attrs.file, "an interface-text block has no file");
    else assert.ok(b.attrs.module, "a " + b.kind + " block has no module");
    if (b.kind === "interface-names") {
      for (const key of ["object", "match", "prefix"]) assert.ok(b.attrs[key], "a names block of " + b.attrs.task + " has no " + key);
    }
  }
});

test("every string template has text of its own to look for", () => {
  for (const b of blocks.filter((x) => x.kind === "interface-strings")) {
    for (const t of b.names) assert.ok(fragments(t).length > 0, "template " + JSON.stringify(t) + " is only placeholders");
  }
});

test("every listed name is documented on the page under its prefix", () => {
  for (const b of blocks.filter((x) => x.kind === "interface-names")) {
    for (const n of b.names) {
      const needle = "`" + b.attrs.prefix + n;
      let at = pageText.indexOf(needle);
      let ok = false;
      while (at >= 0 && !ok) {
        const next = pageText[at + needle.length];
        ok = next === "(" || next === "`" || next === " ";
        at = pageText.indexOf(needle, at + 1);
      }
      assert.ok(ok, PAGE + " never documents " + needle + "`");
    }
  }
});

test("every obligation o1 to o15 is mapped to a task that proves it", () => {
  for (let i = 1; i <= 15; i++) {
    const row = pageText.split("\n").find((line) => line.startsWith("| o" + i + " "));
    assert.ok(row, PAGE + " has no row for obligation o" + i);
    const cells = row.split("|").map((c) => c.trim());
    assert.match(cells[2] || "", /\bt(\d+)\b/, "obligation o" + i + " names no task");
  }
});

test("every later task of the plan appears in the page's task table", () => {
  for (let i = 2; i <= 15; i++) {
    assert.ok(
      pageText.split("\n").some((line) => line.startsWith("| t" + i + " |")),
      PAGE + " has no row for task t" + i,
    );
  }
});

test("the page answers whether a search from a point names the point itself", () => {
  assert.match(pageText, /## Answer: does a search from a point name the point itself\?/);
  assert.match(pageText, /\*\*Yes, today it does, when the point is named\.\*\*/);
  assert.match(pageText, /\*\*Decided here, for the relative view:\*\*/);
});

// ---------- the checks themselves, on stand-ins, so a broken check cannot pass quietly ----------

test("the parser reads all three kinds, keeping spaces in strings and trimming names", () => {
  const text =
    '<!-- interface-names module="a.js" object="ET.a" match="present" task="t2" prefix="ET.a." landed="auto" -->\n' +
    "```text\n one \ntwo\n```\n" +
    '<!-- interface-strings module="a.js,b.js" task="t6" landed="yes" -->\n' +
    "```text\n · {x} pins no axis\n```\n" +
    '<!-- interface-text file="js/page/page.js" task="t12" landed="auto" -->\n' +
    '```text\n"relative"\n```\n';
  const [n, s, t] = parseBlocks(text);
  assert.deepStrictEqual(n.names, ["one", "two"]);
  assert.strictEqual(n.attrs.landed, "auto");
  assert.deepStrictEqual(s.names, [" · {x} pins no axis"]);
  assert.deepStrictEqual(missingModules(s), ["a.js", "b.js"]);
  assert.strictEqual(t.attrs.file, "js/page/page.js");
});

test("fragments split on placeholders and keep their spaces", () => {
  assert.deepStrictEqual(fragments(" · {letter} pins no axis"), [" · ", " pins no axis"]);
  assert.deepStrictEqual(fragments("{measure} to {letter}"), [" to "]);
  assert.ok(foundIn('x = " · " + l + " pins no axis";', " · {letter} pins no axis"));
  assert.ok(!foundIn('x = " ·" + l + " pins no axis";', " · {letter} pins no axis"));
});

test("names: present, constants, a missing one and an unknown match kind", () => {
  const fns = { attrs: { match: "present" }, names: ["a", "b"] };
  assert.strictEqual(compareNames(fns, { a() {}, b() {} }), null);
  assert.match(compareNames(fns, { a() {}, b: 1 }), /\[b\]/);
  const consts = { attrs: { match: "constants" }, names: ["K"] };
  assert.strictEqual(compareNames(consts, { K: 0 }), null);
  assert.match(compareNames(consts, { K() {} }), /\[K\]/);
  assert.match(compareNames(consts, {}), /\[K\]/);
  assert.match(compareNames({ attrs: { match: "nope" }, names: [] }, {}), /unknown match kind/);
  assert.match(compareNames(fns, undefined), /\[a, b\]/);
});

test("landed: auto waits for the first sign, yes never waits, and half a block fails", () => {
  const auto = { kind: "interface-names", attrs: { match: "present", landed: "auto" }, names: ["a", "b"] };
  assert.strictEqual(
    waiting(auto, (n) => present(auto, {}, n)),
    true,
  );
  const half = { a() {} };
  assert.strictEqual(
    waiting(auto, (n) => present(auto, half, n)),
    false,
  );
  assert.match(compareNames(auto, half), /\[b\]/);
  const yes = { ...auto, attrs: { ...auto.attrs, landed: "yes" } };
  assert.strictEqual(
    waiting(yes, () => false),
    false,
  );
  const strings = { kind: "interface-strings", attrs: { landed: "auto" }, names: ["first {x}", "second"] };
  assert.strictEqual(
    waiting(strings, (t) => foundIn("second", t)),
    true,
    "strings wait on the first line only",
  );
  assert.strictEqual(
    waiting(strings, (t) => foundIn("first ", t)),
    false,
  );
  assert.match(compareLines(strings, "first "), /"second"/);
  assert.strictEqual(compareLines(strings, "first second"), null);
});

test("the objects a block can document can all be reached today", () => {
  assert.ok(objectFor("ET.math"));
  assert.ok(objectFor("ET.renderer.DEFAULTS"));
  assert.strictEqual(objectFor("ET.nothingHere.atAll"), undefined);
  assert.strictEqual(typeof objectFor("handle").info, "function");
  assert.strictEqual(typeof objectFor("mode:tumble").stateAt, "function");
  assert.strictEqual(typeof objectFor("renderer").draw, "function");
  assert.throws(() => objectFor("nothing"), /unknown object/);
});

// ---------- one test per block: the page against the code ----------

function title(b) {
  const what = b.kind === "interface-names" ? b.attrs.object + " (" + b.attrs.match + ")" : b.attrs.module || b.attrs.file;
  return PAGE + ": " + b.kind + " " + what + ", task " + b.attrs.task + ", landed " + b.attrs.landed;
}

for (const b of blocks) {
  const name = title(b);
  test(name, (t) => {
    if (b.kind === "interface-text") {
      if (!fs.existsSync(path.join(ROOT, b.attrs.file))) {
        if (b.attrs.landed === "yes") assert.fail(b.attrs.file + " does not exist");
        t.skip(b.attrs.file + " not present yet (task " + b.attrs.task + ")");
        return;
      }
    } else {
      const absent = missingModules(b);
      if (absent.length) {
        if (b.attrs.landed === "yes") assert.fail("js/src/" + absent.join(", js/src/") + " does not exist");
        t.skip("js/src/" + absent.join(", js/src/") + " not present yet (task " + b.attrs.task + ")");
        return;
      }
    }
    if (b.kind === "interface-names") {
      const obj = objectFor(b.attrs.object);
      if (waiting(b, (n) => present(b, obj, n))) {
        t.skip(b.attrs.object + ": none of the listed names exists yet (task " + b.attrs.task + ")");
        return;
      }
      const diff = compareNames(b, obj);
      assert.strictEqual(diff, null, name + ": " + diff);
      return;
    }
    const source = sourceOf(b);
    if (waiting(b, (line) => foundIn(source, line))) {
      t.skip("the first line is not in the source yet (task " + b.attrs.task + ")");
      return;
    }
    const diff = compareLines(b, source);
    assert.strictEqual(diff, null, name + ": " + diff);
  });
}
