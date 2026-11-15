"use strict";
// The search interface pages (js/api/24-search.md, js/api/26-search-sets.md and
// docs/search-interface.md) are the contract later tasks build against. Each page carries
// machine-readable name blocks:
//
//   <!-- interface-names module="24-search.js" object="ET.search" match="exact" task="t2" prefix="ET.search." -->
//   ```text
//   clampK
//   makeRank
//   ```
//
// This test checks that every block names the same functions as the module it documents,
// once that module exists. A block whose module file is not present yet is skipped by name.
// A block that lists additions to a module that existed before search (existing="yes") is
// skipped until the first listed name appears, and from then on every listed name must be
// there. A new module (no existing="yes") is checked in full as soon as its file exists.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { loadSources, ROOT, SRC_DIR } = require("./helpers/load.js");
const { makeFakeDom } = require("./helpers/fake-dom.js");
const { makeFakeCanvas } = require("./helpers/fake-gl.js");

const PAGES = ["js/api/24-search.md", "js/api/26-search-sets.md", "docs/search-interface.md"];

const BLOCK = /<!-- interface-names ([^>]*?) -->\s*\n```text\n([\s\S]*?)\n```/g;
const ATTR = /(\w+)="([^"]*)"/g;

// Every name block of a page: { page, attrs, names }.
function parseBlocks(page, text) {
  const blocks = [];
  for (const m of text.matchAll(BLOCK)) {
    const attrs = {};
    for (const a of m[1].matchAll(ATTR)) attrs[a[1]] = a[2];
    const names = m[2]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    blocks.push({ page, attrs, names });
  }
  return blocks;
}

function sorted(list) {
  return [...list].sort((a, b) => (a < b ? -1 : Number(a > b)));
}

// The function-valued own keys of an object.
function functionNames(obj) {
  return sorted(Object.keys(obj).filter((k) => typeof obj[k] === "function"));
}

// Compare a block with the object it documents. Returns null when they agree, else a
// plain description of the difference. `match`: "exact" (the object's functions are exactly
// the names), "constants" (each name is a non-function member), "present" (each name is a
// function member).
function compare(block, obj) {
  const want = sorted(block.names);
  if (block.attrs.match === "exact") {
    const have = functionNames(obj);
    const missing = want.filter((n) => !have.includes(n));
    const extra = have.filter((n) => !want.includes(n));
    if (!missing.length && !extra.length) return null;
    return "missing from the module: [" + missing.join(", ") + "]; not on the page: [" + extra.join(", ") + "]";
  }
  if (block.attrs.match === "constants") {
    const bad = want.filter((n) => !(n in obj) || typeof obj[n] === "function");
    return bad.length ? "constants missing or not constants: [" + bad.join(", ") + "]" : null;
  }
  if (block.attrs.match === "present") {
    const missing = want.filter((n) => typeof obj[n] !== "function");
    return missing.length ? "missing from the module: [" + missing.join(", ") + "]" : null;
  }
  return "unknown match kind " + JSON.stringify(block.attrs.match);
}

// Blocks marked existing="yes" document additions to a module that existed before search:
// skipped until the first listed name appears.
function noneYet(block, obj) {
  return block.attrs.existing === "yes" && block.names.every((n) => typeof obj[n] !== "function");
}

function missingModules(block) {
  return block.attrs.module.split(",").filter((f) => !fs.existsSync(path.join(SRC_DIR, f.trim())));
}

// The object a block documents, from a fresh load of every module.
function objectFor(spec) {
  const api = loadSources();
  const ET = api._internal;
  if (spec.startsWith("ET.")) return ET[spec.slice(3)];
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

const blocks = PAGES.flatMap((page) =>
  parseBlocks(page, fs.readFileSync(path.join(ROOT, page), "utf8")),
);

// ---------- the pages and their blocks ----------

test("each interface page exists and carries at least one name block", () => {
  for (const page of PAGES) {
    assert.ok(
      blocks.some((b) => b.page === page),
      page + " has no interface-names block",
    );
  }
});

test("every block names its module, object, match kind, task and heading prefix, and lists names", () => {
  for (const b of blocks) {
    for (const key of ["module", "object", "match", "task", "prefix"]) {
      assert.ok(b.attrs[key], b.page + ": a block has no " + key);
    }
    assert.ok(b.names.length > 0, b.page + ": block for " + b.attrs.object + " is empty");
    assert.strictEqual(new Set(b.names).size, b.names.length, "duplicate name in " + b.attrs.object);
  }
});

test("every listed name is documented on its page under its prefix", () => {
  for (const b of blocks) {
    const text = fs.readFileSync(path.join(ROOT, b.page), "utf8");
    for (const n of b.names) {
      const needle = "`" + b.attrs.prefix + n;
      const at = text.indexOf(needle);
      const next = at >= 0 ? text[at + needle.length] : "";
      assert.ok(next === "(" || next === "`", b.page + " never documents " + needle + "`");
    }
  }
});

// ---------- the comparison itself, on stand-ins, so a broken check cannot pass quietly ----------

test("the comparison catches a missing and an extra function, and passes an exact match", () => {
  const block = { attrs: { match: "exact" }, names: ["a", "b"] };
  assert.strictEqual(compare(block, { a() {}, b() {}, K: 1 }), null);
  assert.match(compare(block, { a() {} }), /missing from the module: \[b\]/);
  assert.match(compare(block, { a() {}, b() {}, c() {} }), /not on the page: \[c\]/);
});

test("the comparison checks constants and additions", () => {
  const consts = { attrs: { match: "constants" }, names: ["K", "M"] };
  assert.strictEqual(compare(consts, { K: 1, M: "x" }), null);
  assert.match(compare(consts, { K: 1, M() {} }), /\[M\]/);
  assert.match(compare(consts, { K: 1 }), /\[M\]/);
  const adds = { attrs: { match: "present", existing: "yes" }, names: ["p", "q"] };
  assert.strictEqual(noneYet(adds, { other() {} }), true);
  const fresh = { attrs: { match: "present" }, names: ["p"] };
  assert.strictEqual(noneYet(fresh, {}), false, "a new module is never skipped once it exists");
  assert.match(compare(fresh, {}), /\[p\]/);
  assert.strictEqual(noneYet(adds, { p() {} }), false);
  assert.strictEqual(compare(adds, { p() {}, q() {}, other() {} }), null);
  assert.match(compare(adds, { p() {} }), /\[q\]/);
  assert.match(compare({ attrs: { match: "nope" }, names: [] }, {}), /unknown match kind/);
  assert.strictEqual(noneYet(consts, {}), false);
});

test("the block parser reads attributes and names", () => {
  const text =
    'x\n<!-- interface-names module="a.js,b.js" object="ET.x" match="exact" task="t9" prefix="ET.x." -->\n' +
    "```text\none\n two \n\n```\n";
  const [b] = parseBlocks("p.md", text);
  assert.deepStrictEqual(b.attrs, { module: "a.js,b.js", object: "ET.x", match: "exact", task: "t9", prefix: "ET.x." });
  assert.deepStrictEqual(b.names, ["one", "two"]);
  assert.deepStrictEqual(missingModules(b), ["a.js", "b.js"]);
});

test("the objects a block can document can all be reached today", () => {
  assert.ok(objectFor("ET.modes"));
  assert.strictEqual(typeof objectFor("renderer").draw, "function");
  assert.strictEqual(typeof objectFor("handle").info, "function");
  assert.strictEqual(typeof objectFor("mode:tumble").stateAt, "function");
  assert.throws(() => objectFor("nothing"), /unknown object/);
});

// ---------- one test per block: the page against the module ----------

for (const b of blocks) {
  const title = b.page + ": " + b.attrs.object + " (" + b.attrs.match + ", task " + b.attrs.task + ")";
  test(title, (t) => {
    const absent = missingModules(b);
    if (absent.length) {
      t.skip("js/src/" + absent.join(", js/src/") + " not present yet (task " + b.attrs.task + ")");
      return;
    }
    const obj = objectFor(b.attrs.object);
    assert.ok(obj, b.attrs.object + " is not published by " + b.attrs.module);
    if (noneYet(b, obj)) {
      t.skip(b.attrs.object + ": none of the listed additions exists yet (task " + b.attrs.task + ")");
      return;
    }
    const diff = compare(b, obj);
    assert.strictEqual(diff, null, title + ": " + diff);
  });
}
