"use strict";
// Static checks on js/shells/web-component.js (task t10, criterion 1).
//
// The file is a shell: it contains no rendering or projection code and reaches the core
// object only through its public API. What the scan PERMITS on the core object, exactly:
//
//   * T.mount, T.update, T.destroy   (the plan's three members), and
//   * T.sample.generate              (ONE named exception: the interface fixed for wave 5
//                                     gives the element a `sample` attribute, and the sample
//                                     set exists only as EmbeddingsTumbler.sample, loaded by the
//                                     optional sample-data.js. It is read in one place, as a
//                                     call, only to produce data that goes to T.update.)
//
// Anything else on the core object fails: get, registerMode, version, _internal, any other
// member, bracket access, and any alias of the core object (it must be held only by the
// variable `T`, declared once from getCore(), and never assigned, passed or returned
// onward). The scan also bans graphics, canvas, shader, matrix and projection words, typed
// array arithmetic, animation frames, and the shared bans (no markup parsing, no style
// element or attribute, no other network API, no address, no dynamic code).
//
// `scan(source)` returns the list of violations; the last tests prove it flags deliberate
// breaches, so a pass means something.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./helpers/load.js");

const FILE = path.join(ROOT, "js", "shells", "web-component.js");
const SHIPPED = path.join(ROOT, "embeddings_tumbler", "static", "web-component.js");
const ALLOWED = new Set(["mount", "update", "destroy", "sample"]);

// Remove comments, leaving strings. Strings in this file hold plain English messages.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

function scan(source) {
  const code = stripComments(source);
  const bad = [];
  const flag = (what) => bad.push(what);

  // 1. The core object: one holder, `T`, declared from getCore() or the global.
  const mentions = code.match(/\bEmbeddingsTumbler\b/g) || [];
  if (mentions.length !== 1 || !/var T = root\.EmbeddingsTumbler;/.test(code)) {
    flag("the core global must be read exactly once, as `var T = root.EmbeddingsTumbler;`");
  }
  const calls = code.replace("function getCore()", "");
  for (const m of calls.matchAll(/\bgetCore\(\)/g)) {
    const before = calls.slice(Math.max(0, m.index - 12), m.index);
    if (!/var T = $/.test(before)) flag("getCore() may only initialise T");
  }
  const members = new Set();
  for (const m of code.matchAll(/\bT\s*\.\s*([A-Za-z_$][\w$]*)(\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    members.add(m[1]);
    if (!ALLOWED.has(m[1])) flag("core member not in the public API subset: T." + m[1]);
  }
  if (/\bT\s*\[/.test(code)) flag("bracket access on the core object");
  if (/=\s*T\s*[;,)]/.test(code.replace(/var T = (getCore\(\)|root\.EmbeddingsTumbler);/g, ""))) {
    flag("the core object is copied to another name");
  }
  if (/[(,]\s*T\s*[,)]/.test(code)) flag("the core object is passed to a function");
  if (/\{[^}]*\}\s*=\s*T\b/.test(code)) flag("the core object is destructured");
  // T.sample is allowed only as the guard of T.sample.generate, or that call itself.
  if (/\bT\s*\.\s*sample\b(?!\s*(&&|\.\s*generate\b))/.test(code)) {
    flag("T.sample used other than as the guard or T.sample.generate()");
  }
  for (const m of code.matchAll(/\bT\s*\.\s*sample\s*\.\s*(\w+)/g)) {
    if (m[1] !== "generate") flag("T.sample." + m[1]);
  }
  for (const need of ["mount", "update", "destroy"]) {
    if (!members.has(need)) flag("the shell must use T." + need);
  }

  // 2. No rendering or projection code.
  const GRAPHICS = [
    [/getContext/, "getContext"],
    [/webgl/i, "WebGL"],
    [/\bgl\s*\./, "gl."],
    [/shader/i, "shader"],
    [/canvas/i, "canvas"],
    [/matrix|matrices/i, "matrix"],
    [/project(ion|ed|s)?\b/i, "projection"],
    [/Float(32|64)Array|DataView|Int(8|16|32)Array|Uint(8|16|32)Array/, "typed array"],
    [/requestAnimationFrame|cancelAnimationFrame/, "animation frame"],
    [/\bMath\s*\./, "arithmetic (Math.)"],
    [/_internal/, "_internal"],
    [/\bET\s*\./, "the core's shared namespace"],
  ];
  for (const [re, name] of GRAPHICS) if (re.test(code)) flag("banned: " + name);

  // 3. Shared bans: markup parsing, style, other network, addresses, dynamic code.
  const SHARED = [
    [/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/, "markup parsing"],
    [/createElement\(\s*["'](style|script|link|img|iframe|base)["']/, "creating a style, script or resource element"],
    [/setAttribute\(\s*["'](style|src|href)["']|cssText|\.style\.cssText|attachShadow/, "style attribute, resource attribute or shadow root"],
    [/XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|\bnew\s+(Image|Worker)\b/, "other network API"],
    [/https?:\/\/|\beval\b|new\s+Function|\bimport\b|require\(|localStorage|sessionStorage|document\.cookie|process\.env/, "address, dynamic code or environment"],
  ];
  for (const [re, name] of SHARED) if (re.test(code)) flag("banned: " + name);

  // 4. Every fetch is the same-origin form with no extra options or headers.
  const fetchCalls = (code.match(/\bfetch\s*\(/g) || []).length;
  const goodCalls = (code.match(/root\.fetch\(address, \{ credentials: "same-origin" \}\)/g) || []).length;
  if (fetchCalls !== goodCalls) flag("a fetch call is not exactly { credentials: \"same-origin\" }");
  if (/headers|mode\s*:|cache\s*:|referrer|Authorization|apiKey|api_key|token\s*:/i.test(code.replace(/this\._token|var token|token ===|, token/g, ""))) {
    flag("a request header, option or key");
  }
  return bad;
}

const source = fs.readFileSync(FILE, "utf8");

test("the web component calls only mount, update and destroy on the core (plus sample.generate)", () => {
  assert.deepStrictEqual(scan(source), []);
});

test("the shipped copy is the same file", () => {
  assert.strictEqual(fs.readFileSync(SHIPPED, "utf8"), source);
});

test("the scan flags deliberate breaches (it can fail)", () => {
  const cases = {
    "another core member": source.replace("T.destroy(this);", "T.destroy(this); T.get(this);"),
    "_internal": source.replace("T.destroy(this);", "T.destroy(this); T._internal.math;"),
    "registerMode": source.replace("T.destroy(this);", "T.registerMode({});"),
    "bracket access": source.replace("T.destroy(this);", 'T["get"](this);'),
    "an alias": source.replace("var T = getCore();\n      var live", "var T = getCore();\n      var C = T;\n      var live"),
    "direct global use": source.replace("var T = root.EmbeddingsTumbler;", "var T = root.EmbeddingsTumbler; root.EmbeddingsTumbler.get(1);"),
    "sample other than generate": source.replace("T.sample.generate()", "T.sample.helper()"),
    "getContext": source.replace("this._note = null;\n    }\n\n    get handle", "this._note = null;\n      this.getContext('webgl2');\n    }\n\n    get handle"),
    "gl call": source.replace("_clearNote() {", "_clearNote() { gl.drawArrays(0, 0, 1);"),
    "a shader word": source.replace("_clearNote() {", "_clearNote() { var shaderSource = 1;"),
    "a matrix word": source.replace("_clearNote() {", "_clearNote() { var matrix = 1;"),
    "typed array arithmetic": source.replace("_clearNote() {", "_clearNote() { new Float32Array(3);"),
    "an animation frame": source.replace("_clearNote() {", "_clearNote() { root.requestAnimationFrame(function () {});"),
    "innerHTML": source.replace("_clearNote() {", "_clearNote() { this.innerHTML = '';"),
    "a fetch with headers": source.replace('{ credentials: "same-origin" }', '{ credentials: "same-origin", headers: {} }'),
    "an address": source.replace("var NAME", 'var u = "https://example.org"; var NAME'),
  };
  for (const [name, mutated] of Object.entries(cases)) {
    assert.notStrictEqual(mutated, source, "mutation did not apply: " + name);
    assert.ok(scan(mutated).length > 0, "the scan missed: " + name);
  }
});
