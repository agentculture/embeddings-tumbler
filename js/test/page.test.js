"use strict";
// Unit tests for the standalone page's script (js/page/page.js) in a small fake
// browser: the query, the size limit on the records file, and abandoning a load
// when the page is left. The real page runs in tests/browser/test_standalone_page.py.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { runAsFunction, ROOT } = require("./helpers/load.js");

const CODE = fs.readFileSync(path.join(ROOT, "js", "page", "page.js"), "utf8");
const ORIGIN = "http://127.0.0.1:9";

function el(id) {
  const attrs = {};
  return {
    id,
    textContent: "",
    hidden: id === "note-sample" || id === "note-file",
    parentNode: null,
    attrs,
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k];
    },
    appendChild(c) {
      c.parentNode = this;
    },
    removeChild(c) {
      c.parentNode = null;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    // data-* attributes as the browser's dataset maps them ("pageState" <-> "data-page-state").
    dataset: new Proxy(
      {},
      {
        get: (_t, k) => attrs["data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())],
        set: (_t, k, v) => {
          attrs["data-" + String(k).replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())] = String(v);
          return true;
        },
      }
    ),
  };
}

// Run page.js with `search` and a fetch stand-in. Returns the fake world.
function runPage(search, fetchImpl) {
  const els = {};
  ["space", "wait", "wait-text", "note-sample", "note-file"].forEach((id) => (els[id] = el(id)));
  els.wait.parentNode = els.space;
  els["wait-text"].textContent = "Loading the viewer…";
  const body = el("body");
  body.setAttribute("data-page-state", "loading");
  const listeners = {};
  const world = { els, body, mounted: 0, generated: 0, fetches: [], listeners, updates: [] };
  const handle = {
    update(data) {
      world.updates.push(data);
      return { ok: true };
    },
    mode() {
      return "tumble";
    },
    info() {
      return { dimension: 8, count: 10 };
    },
  };
  const api = {
    mount() {
      world.mounted++;
      return handle;
    },
    sample: {
      generate() {
        world.generated++;
        return { kind: "embeddings-tumbler/data" };
      },
    },
  };
  const window = {
    location: { search, href: ORIGIN + "/index.html" + search, protocol: "http:", origin: ORIGIN },
    EmbeddingsTumbler: api,
    fetch(url, init) {
      world.fetches.push({ url, init });
      return fetchImpl(url, init, world);
    },
    requestAnimationFrame(cb) {
      cb();
    },
    setTimeout(cb) {
      cb();
    },
    addEventListener(type, fn) {
      listeners[type] ??= [];
      listeners[type].push(fn);
    },
  };
  const document = {
    body,
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
  };
  const globals = {
    window,
    document,
    performance: { mark() { /* marks are not measured here */ } },
    URL,
    URLSearchParams,
    AbortController,
    console,
  };
  runAsFunction(CODE, Object.keys(globals), Object.values(globals), "page");
  world.fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev || { type }));
  return world;
}

function response(body, headers) {
  const h = { ...headers };
  const res = {
    ok: true,
    status: 200,
    url: "",
    read: false,
    headers: { get: (n) => (h[n.toLowerCase()] === undefined ? null : String(h[n.toLowerCase()])) },
    text() {
      res.read = true;
      return Promise.resolve(body);
    },
    arrayBuffer() {
      res.read = true;
      return Promise.resolve(new ArrayBuffer(8));
    },
  };
  return res;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a whitespace-only ?data= shows the sample set, like an empty one", async () => {
  for (const q of ["?data=", "?data=%20%20", "?data=+", "?data=%09"]) {
    const w = runPage(q, () => Promise.reject(new Error("no request expected")));
    await settle();
    assert.strictEqual(w.fetches.length, 0, q + ": nothing is requested");
    assert.strictEqual(w.generated, 1, q + ": the sample set is generated");
    assert.strictEqual(w.mounted, 1, q);
    assert.strictEqual(w.body.getAttribute("data-page-state"), "ready", q);
  }
});

test("a records file whose Content-Length is over the limit is refused before its body is read", async () => {
  let res = null;
  const w = runPage("?data=big.json", () => {
    res = response("{}", { "content-length": 64 * 1024 * 1024 + 1 });
    return Promise.resolve(res);
  });
  await settle();
  assert.strictEqual(w.fetches.length, 1);
  assert.strictEqual(res.read, false, "the body is never read");
  assert.strictEqual(w.mounted, 0);
  assert.strictEqual(w.body.getAttribute("data-page-state"), "error");
  assert.match(w.els["wait-text"].textContent, /"big\.json" is too large/);
  assert.match(w.els["wait-text"].textContent, /64 MB/);
  assert.strictEqual(w.els["wait-text"].getAttribute("role"), "alert", "a failure is announced as an alert");
});

test("a records file at the limit, or with no Content-Length, is read", async () => {
  for (const headers of [{ "content-length": 64 * 1024 * 1024 }, {}]) {
    let res = null;
    const w = runPage("?data=ok.json", () => {
      res = response('{"kind":"other"}', headers);
      return Promise.resolve(res);
    });
    await settle();
    assert.strictEqual(res.read, true);
    // Not a file-form set: handed to the viewer, which refuses it itself.
    assert.strictEqual(w.mounted, 1);
  }
});

test("a data file is handed over with its descriptor and the fetched block, so the viewer checks both", async () => {
  const records = {
    kind: "embeddings-tumbler/data",
    schema_version: 1,
    model: "m",
    dimension: 1,
    count: 2,
    vectors: { file: "x.f32", dtype: "float64", byte_order: "big", byte_length: 8 },
    points: [],
  };
  const w = runPage("?data=x.json", (url) =>
    Promise.resolve(url.endsWith(".json") ? response(JSON.stringify(records)) : response(""))
  );
  await settle();
  await settle();
  assert.strictEqual(w.fetches.length, 2);
  assert.strictEqual(w.updates.length, 1);
  const v = w.updates[0].vectors;
  assert.strictEqual(v.dtype, "float64", "the descriptor's fields reach the viewer");
  assert.strictEqual(v.byte_order, "big");
  assert.strictEqual(v.byte_length, 8);
  assert.strictEqual(v.file, "x.f32");
  assert.strictEqual(Object.prototype.toString.call(v.data), "[object ArrayBuffer]");
});

test("a load still in flight when the page is left is abandoned and changes nothing", async () => {
  const w = runPage("?data=slow.json", (url, init) => {
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  });
  await settle();
  assert.strictEqual(w.fetches.length, 1);
  const signal = w.fetches[0].init.signal;
  assert.ok(signal, "the request carries an abort signal");
  assert.strictEqual(signal.aborted, false, "the signal is not aborted yet");
  const before = w.els["wait-text"].textContent;
  w.fire("pagehide", { type: "pagehide", persisted: false });
  await settle();
  assert.strictEqual(signal.aborted, true, "pagehide aborts the request");
  assert.strictEqual(w.body.getAttribute("data-page-state"), "loading", "no error is shown for an abandoned load");
  assert.strictEqual(w.els["wait-text"].textContent, before);
  assert.strictEqual(w.mounted, 0);
});

test("a response that arrives after the page was left is ignored", async () => {
  let release = null;
  const w = runPage("?data=late.json", () => new Promise((resolve) => (release = resolve)));
  await settle();
  w.fire("pagehide", { type: "pagehide", persisted: true });
  release(response('{"kind":"other"}'));
  await settle();
  assert.strictEqual(w.mounted, 0, "nothing is mounted on a page that has moved on");
  assert.strictEqual(w.body.getAttribute("data-page-state"), "loading");
});

test("a page restored from the back-forward cache after an abandoned load loads again", async () => {
  let calls = 0;
  const w = runPage("?data=again.json", (url, init) => {
    calls++;
    if (calls === 1) {
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    return Promise.resolve(response('{"kind":"other"}'));
  });
  await settle();
  w.fire("pagehide", { type: "pagehide", persisted: true });
  await settle();
  w.fire("pageshow", { type: "pageshow", persisted: true });
  await settle();
  assert.strictEqual(calls, 2, "the file is requested again");
  assert.strictEqual(w.mounted, 1);
});
