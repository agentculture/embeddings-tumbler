"use strict";
// Static checks for task t8.
//
// Criterion 6: the core contains no network call and builds no resource address.
// Scanned: the assembled core file (embeddings_tumbler/static/embeddings-tumbler.js)
// and every module under js/src/, comments included.
//
// What is banned (NETWORK below):
//   * a call to a function named exactly `fetch`: `fetch(`, `.fetch(`, `fetch.call`,
//     `["fetch"]`; an injected fetch-like PARAMETER with another name (the loader's
//     `loadFile(jsonUrl, fetchFn, base)` calls `fetchFn(...)`) is allowed, because it is
//     the host's own function handed in explicitly, never the global;
//   * XMLHttpRequest, WebSocket, sendBeacon, EventSource, importScripts,
//     `new Image`, `new Worker` / `new SharedWorker`, `window.open`,
//     `location.assign` / `location.replace`;
//   * building a resource address: assigning `.src`, `.srcset`, `.href`, `.action`,
//     `.formAction`, `.poster`, `.data`-free `setAttribute("src" | "href" | "srcset" |
//     "action" | "formaction" | "poster" | "xlink:href", ...)`, creating a `script`,
//     `img`, `iframe`, `link`, `object`, `embed`, `audio`, `video`, `source` or `base`
//     element, and a CSS `url(` anywhere in the file (a name ending in `Url(`, such as
//     the loader's `siblingUrl(`, is not a CSS url).
//
// Also for 50-viewer.js: no markup parsing (innerHTML, outerHTML, insertAdjacentHTML,
// document.write, DOMParser, createContextualFragment), no style attribute or style
// element (setAttribute("style"), cssText, createElement("style")), nothing added to
// document.head or document.body, and no key listener on the document or window.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { SRC_DIR, ASSEMBLED } = require("./helpers/load.js");

const NETWORK = {
  "global fetch call": /(^|[^\w$])fetch\s*(\(|\.call|\.apply)|\.fetch\b|\[\s*["'`]fetch["'`]\s*\]/,
  XMLHttpRequest: /XMLHttpRequest/,
  WebSocket: /WebSocket/,
  sendBeacon: /sendBeacon/,
  EventSource: /EventSource/,
  importScripts: /importScripts/,
  "new Image": /\bnew\s+Image\b/,
  "new Worker": /\bnew\s+(Shared)?Worker\b/,
  "window.open": /\bwindow\s*\.\s*open\b/,
  "location navigation": /\blocation\s*\.\s*(assign|replace)\b/,
  "address property assignment": /\.\s*(src|srcset|href|action|formAction|poster)\s*=[^=]/,
  "address attribute": /setAttribute\s*\(\s*["'`](src|href|srcset|action|formaction|poster|xlink:href)["'`]/i,
  "resource element": /createElement(NS)?\s*\([^)]*["'`](script|img|iframe|link|object|embed|audio|video|source|base)["'`]/i,
  "CSS url()": /(^|[^\w$])url\(/i,
};

const DOM_RULES = {
  innerHTML: /innerHTML/,
  outerHTML: /outerHTML/,
  insertAdjacentHTML: /insertAdjacentHTML/,
  "document.write": /document\s*\.\s*write/,
  DOMParser: /DOMParser/,
  createContextualFragment: /createContextualFragment/,
  "style attribute": /setAttribute\s*\(\s*["'`]style["'`]/i,
  cssText: /cssText/,
  "style element": /createElement\s*\(\s*["'`]style["'`]/i,
  "document.head": /\.head\b/,
  "document.body": /\bdocument\s*\.\s*body\b|\bdoc\s*\.\s*body\b/,
  "adoptedStyleSheets": /adoptedStyleSheets|insertRule|CSSStyleSheet/,
  "global key listener": /(document|doc|window|win)\s*,\s*["'`]key(down|up|press)["'`]|(document|window)\s*\.\s*addEventListener\s*\(\s*["'`]key/,
};

function sources() {
  return fs
    .readdirSync(SRC_DIR)
    .filter((f) => /^\d\d-.*\.js$/.test(f))
    .map((f) => ({ name: "js/src/" + f, text: fs.readFileSync(path.join(SRC_DIR, f), "utf8") }));
}

function scan(text, rules) {
  const hits = [];
  for (const [label, re] of Object.entries(rules)) {
    const m = re.exec(text);
    if (m) hits.push(label + ": " + JSON.stringify(m[0]));
  }
  return hits;
}

test("the assembled core file contains no network call or resource address", () => {
  const text = fs.readFileSync(ASSEMBLED, "utf8");
  assert.deepStrictEqual(scan(text, NETWORK), []);
});

for (const src of sources()) {
  test(src.name + " contains no network call or resource address", () => {
    assert.deepStrictEqual(scan(src.text, NETWORK), []);
  });
}

test("the viewer module parses no markup, injects no style and stays inside its element", () => {
  const text = fs.readFileSync(path.join(SRC_DIR, "50-viewer.js"), "utf8");
  assert.deepStrictEqual(scan(text, DOM_RULES), []);
});

test("the viewer module puts data text in with textContent only", () => {
  const text = fs.readFileSync(path.join(SRC_DIR, "50-viewer.js"), "utf8");
  assert.match(text, /textContent/);
  assert.doesNotMatch(text, /\.innerText\s*=/);
});

test("the patterns bite: each banned construct is caught", () => {
  const bad = [
    "fetch('/x')",
    "window.fetch('/x')",
    "globalThis['fetch']('/x')",
    "fetch.call(null, u)",
    "new XMLHttpRequest()",
    "new WebSocket(u)",
    "navigator.sendBeacon(u, d)",
    "new EventSource(u)",
    "importScripts(u)",
    "var i = new Image()",
    "new Worker(u)",
    "window.open(u)",
    "location.assign(u)",
    "img.src = u",
    "a.href = '/x'",
    "el.setAttribute('src', u)",
    "el.setAttribute(\"href\", u)",
    "doc.createElement('script')",
    "document.createElement(\"img\")",
    "el.style.background = 'url(x)'",
  ];
  for (const b of bad) assert.ok(scan(b, NETWORK).length > 0, "not caught: " + b);
});

test("the patterns allow an injected fetch-like parameter and ordinary code", () => {
  const ok = [
    "function loadFile(jsonUrl, fetchFn, base) { return fetchFn(String(jsonUrl)); }",
    "var src = shaderSources(lay); compile(src.quadVertex)",
    "if (a.src == b) {}",
    "prefetchCount(3)",
    "var sourceUrl = 1",
  ];
  for (const g of ok) assert.deepStrictEqual(scan(g, NETWORK), [], g);
});

test("the DOM rules bite", () => {
  const bad = [
    "el.innerHTML = s",
    "el.insertAdjacentHTML('beforeend', s)",
    "el.setAttribute('style', 'color: red')",
    "el.style.cssText = 'x'",
    "doc.createElement('style')",
    "document.head.appendChild(x)",
    "document.body.classList.add('x')",
    "listen(v, doc, 'keydown', f)",
    "window.addEventListener('keydown', f)",
  ];
  for (const b of bad) assert.ok(scan(b, DOM_RULES).length > 0, "not caught: " + b);
});
