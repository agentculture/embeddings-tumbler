"use strict";
// Behaviour of <embeddings-tumbler> (js/shells/web-component.js) against the real core
// file on the fake DOM (helpers/fake-dom.js + helpers/fake-elements.js). The real browser
// check is tests/browser/test_web_component.py.
const test = require("node:test");
const assert = require("node:assert");
const { makeShellEnv, fixture } = require("./helpers/fake-elements.js");

const A = fixture("valid-384");
const B = fixture("valid-1024");

const DIR = "http://host.test/page/data/";
function serve(env, name, set) {
  env.route(DIR + name + ".json", () => ({ json: set.json }));
  env.route(DIR + set.json.vectors.file, () => ({ buffer: set.buffer }));
}

// The shell runs in its own vm realm: compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

function viewerRoots(el) {
  return el.children.filter((c) => c.className === "tumbler");
}

// ---------- the element is defined once ----------

test("the element is defined once; loading the file again does not throw", () => {
  const env = makeShellEnv();
  assert.strictEqual(env.defines(), 1);
  assert.doesNotThrow(() => env.load());
  assert.strictEqual(env.defines(), 1);
  assert.ok(env.root.customElements.get("embeddings-tumbler"));
});

test("without customElements the file does nothing and does not throw", () => {
  const env = makeShellEnv({ withCore: false });
  const bare = { document: env.root.document, globalThis: null };
  bare.globalThis = bare;
  const vm = require("node:vm");
  const fs = require("node:fs");
  const { SHELL } = require("./helpers/fake-elements.js");
  assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(SHELL, "utf8"), vm.createContext(bare)));
});

// ---------- connect mounts, disconnect destroys ----------

test("adding the element mounts a viewer and removing it destroys it", () => {
  const env = makeShellEnv();
  const el = env.create();
  assert.strictEqual(env.calls.mount.length, 0, "nothing mounts before the element is in the page");
  env.connect(el);
  assert.strictEqual(env.calls.mount.length, 1);
  assert.ok(env.core.get(el), "a viewer is registered on the element");
  assert.strictEqual(viewerRoots(el).length, 1);
  assert.ok(el.handle && typeof el.handle.info === "function", "handle is the viewer handle");
  assert.strictEqual(el.style.display, "block");
  env.dom.frames(3);
  env.disconnect(el);
  assert.strictEqual(env.calls.destroy.length, 1);
  assert.strictEqual(env.core.get(el), null);
  assert.strictEqual(el.handle, null);
  assert.strictEqual(el.children.length, 0, "the viewer's DOM is gone");
  assert.strictEqual(env.dom.pendingFrames(), 0, "no animation frame is left pending");
  assert.strictEqual(env.dom.flush(), 0);
});

test("moving the element leaks no viewer: one viewer after any number of moves", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create());
  for (let i = 0; i < 3; i++) {
    env.disconnect(el);
    env.connect(el);
  }
  assert.strictEqual(viewerRoots(el).length, 1);
  assert.strictEqual(env.calls.mount.length, 4);
  assert.strictEqual(env.calls.destroy.length, 3);
  env.connectedAgain = el.connectedCallback();
  assert.strictEqual(env.calls.mount.length, 4, "a repeated connectedCallback mounts nothing new");
  assert.strictEqual(viewerRoots(el).length, 1);
});

test("mount options come from the mode and seed attributes", () => {
  const env = makeShellEnv();
  env.connect(env.create({ mode: "lattice", seed: "7" }));
  assert.deepStrictEqual(plain(env.calls.mount[0][1]), { mode: "lattice", seed: 7 });
  env.connect(env.create({ seed: "alpha" }));
  assert.deepStrictEqual(plain(env.calls.mount[1][1]), { seed: "alpha" });
});

test("changing mode switches in place; changing seed mounts again", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create({ mode: "tumble", seed: "1" }));
  el.setAttribute("mode", "wander");
  assert.strictEqual(el.handle.mode(), "wander");
  assert.strictEqual(env.calls.mount.length, 1);
  el.setAttribute("seed", "2");
  assert.strictEqual(env.calls.mount.length, 2);
  assert.strictEqual(env.calls.mount[1][1].seed, 2);
  assert.strictEqual(viewerRoots(el).length, 1);
});

test("attributes set before the element is in the page do nothing until it connects", () => {
  const env = makeShellEnv();
  const el = env.create({ mode: "wander" });
  el.setAttribute("seed", "3");
  assert.strictEqual(env.calls.mount.length, 0);
  assert.strictEqual(env.fetches.length, 0);
});

// ---------- missing core ----------

test("without the core the element says so, mounts nothing, and a later connect retries", () => {
  const env = makeShellEnv({ withCore: false });
  const el = env.create();
  const seen = env.listen(el);
  assert.doesNotThrow(() => env.connect(el));
  assert.match(el.textContent, /Load embeddings-tumbler\.js before web-component\.js/);
  assert.strictEqual(seen[0].type, "tumbler-error");
  assert.strictEqual(seen[0].detail.code, "core-missing");
  assert.strictEqual(el.handle, null);
  env.disconnect(el);
  assert.strictEqual(el.children.length, 0, "the message goes with the element's disconnect");
  env.root.EmbeddingsTumbler = env.core;
  env.connect(el);
  assert.strictEqual(viewerRoots(el).length, 1);
  assert.strictEqual(el.children.filter((c) => c.className === "tumbler-shell-message").length, 0);
});

// ---------- src ----------

test("src loads the data file and its vector block from the host's own origin", async () => {
  const env = makeShellEnv();
  serve(env, "a", A);
  const el = env.create({ src: "data/a.json" });
  const seen = env.listen(el);
  env.connect(el);
  await env.settle();
  assert.strictEqual(env.fetches.length, 2);
  assert.ok(env.fetches[0].url.endsWith("/page/data/a.json"), "resolved against the page's base URL");
  assert.ok(env.fetches[1].url.endsWith("/page/data/" + A.json.vectors.file), "the block is next to the JSON");
  for (const f of env.fetches) {
    assert.deepStrictEqual(plain(f.init), { credentials: "same-origin" }, "no other options, no headers");
  }
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].type, "tumbler-load");
  assert.strictEqual(seen[0].detail.ok, true);
  assert.strictEqual(seen[0].detail.count, A.json.count);
  assert.strictEqual(seen[0].bubbles, true);
  assert.strictEqual(el.handle.info().count, A.json.count);
});

test("a src on another origin is refused before any request, with a plain message", async () => {
  for (const bad of [
    "https://evil.test/data/a.json",
    "//evil.test/data/a.json",
    "http://host.test:8080/data/a.json",
    "https://host.test/data/a.json",
    "data:application/json,{}",
    "javascript:alert(1)",
    "file:///etc/passwd",
  ]) {
    const env = makeShellEnv();
    const el = env.create({ src: bad });
    const seen = env.listen(el);
    env.connect(el);
    await env.settle();
    assert.strictEqual(env.fetches.length, 0, "no request for " + bad);
    assert.strictEqual(env.calls.update.length, 0);
    assert.strictEqual(seen.length, 1, bad);
    assert.strictEqual(seen[0].type, "tumbler-error");
    assert.strictEqual(seen[0].detail.code, "src-refused");
    assert.match(el.textContent, /own origin/);
    assert.ok(!el.textContent.includes("evil"), "the refused address is not echoed");
  }
});

test("an address that does not parse is refused plainly, with no request", async () => {
  const env = makeShellEnv();
  const el = env.create({ src: "http://" });
  const seen = env.listen(el);
  env.connect(el);
  await env.settle();
  assert.strictEqual(env.fetches.length, 0);
  assert.strictEqual(seen[0].detail.code, "src-refused");
});

test("a missing data file shows a plain message and never throws", async () => {
  const env = makeShellEnv();
  const el = env.create({ src: "data/gone.json" });
  const seen = env.listen(el);
  env.connect(el);
  await env.settle();
  assert.strictEqual(seen[0].detail.code, "src-unreadable");
  assert.match(el.textContent, /could not be read/);
  assert.strictEqual(env.calls.update.length, 0);
  assert.ok(env.core.get(el), "the viewer stays mounted");
});

test("a file that is not JSON, and a missing vector block, each give a plain message", async () => {
  const env = makeShellEnv();
  env.route(DIR + "text.json", () => ({}));
  const el = env.connect(env.create({ src: "data/text.json" }));
  const seen = env.listen(el);
  el.setAttribute("src", "data/text.json?again");
  env.route(DIR + "text.json?again", () => ({}));
  await env.settle();
  assert.strictEqual(seen.at(-1).detail.code, "src-unreadable");
  env.route(DIR + "lonely.json", () => ({ json: A.json }));
  el.setAttribute("src", "data/lonely.json");
  await env.settle();
  assert.strictEqual(seen.at(-1).detail.code, "block-unreadable");
  assert.ok(el.textContent.includes(A.json.vectors.file));
});

test("a redirect to another origin is not accepted as data", async () => {
  const env = makeShellEnv();
  env.route(DIR + "r.json", () => ({ json: A.json, url: "https://evil.test/r.json" }));
  const el = env.connect(env.create({ src: "data/r.json" }));
  const seen = env.listen(el);
  el.setAttribute("src", "data/r.json?x");
  env.route(DIR + "r.json?x", () => ({ json: A.json, url: "https://evil.test/r.json" }));
  await env.settle();
  assert.strictEqual(env.calls.update.length, 0);
  assert.strictEqual(seen.at(-1).detail.code, "src-unreadable");
});

test("a vector file name that is not plain is never fetched; the viewer refuses it", async () => {
  for (const file of ["../secret.f32", "https://evil.test/x.f32", "/x.f32", "a/b.f32"]) {
    const env = makeShellEnv();
    const json = JSON.parse(JSON.stringify(A.json));
    json.vectors.file = file;
    env.route(DIR + "p.json", () => ({ json }));
    const el = env.create({ src: "data/p.json" });
    const seen = env.listen(el);
    env.connect(el);
    await env.settle();
    assert.strictEqual(env.fetches.length, 1, "only the JSON was requested for " + file);
    assert.ok(["vector-file-path", "invalid-field"].includes(seen[0].detail.code), seen[0].detail.code);
  }
});

test("the file form's own checks run on src data: wrong dtype, byte order or declared length is refused", async () => {
  const cases = [
    [{ dtype: "float64" }, "invalid-field", 'Field "vectors.dtype" is missing or not valid.'],
    [{ byte_order: "big" }, "invalid-field", 'Field "vectors.byte_order" is missing or not valid.'],
    [{ byte_length: 12 }, "invalid-field", 'Field "vectors.byte_length" is missing or not valid.'],
  ];
  for (const [change, code, message] of cases) {
    const env = makeShellEnv();
    const json = JSON.parse(JSON.stringify(A.json));
    Object.assign(json.vectors, change);
    env.route(DIR + "f.json", () => ({ json }));
    env.route(DIR + json.vectors.file, () => ({ buffer: A.buffer }));
    const el = env.create({ src: "data/f.json" });
    const seen = env.listen(el);
    env.connect(el);
    await env.settle();
    assert.strictEqual(seen.length, 1, JSON.stringify(change));
    assert.strictEqual(seen[0].type, "tumbler-error", JSON.stringify(change));
    assert.strictEqual(seen[0].detail.code, code);
    assert.strictEqual(seen[0].detail.message, message, "the core's own message");
    assert.strictEqual(el.handle.info().count, 0, "nothing drawn");
  }
});

test("a block shorter than declared is refused with the contract's block-length message", async () => {
  const env = makeShellEnv();
  serve(env, "a", A);
  env.route(DIR + A.json.vectors.file, () => ({ buffer: A.buffer.slice(0, A.buffer.byteLength - 4) }));
  const el = env.create({ src: "data/a.json" });
  const seen = env.listen(el);
  env.connect(el);
  await env.settle();
  assert.strictEqual(seen[0].detail.code, "block-length");
});

test("valid JSON that is not a data set is handed to the viewer, which refuses it plainly", async () => {
  const env = makeShellEnv();
  env.route(DIR + "n.json", () => ({ json: { hello: 1 } }));
  const el = env.create({ src: "data/n.json" });
  const seen = env.listen(el);
  env.connect(el);
  await env.settle();
  assert.strictEqual(env.calls.update.length, 1);
  assert.strictEqual(seen[0].type, "tumbler-error");
  assert.strictEqual(seen[0].detail.code, "wrong-kind");
});

test("changing src loads the other file as a replace", async () => {
  const env = makeShellEnv();
  serve(env, "a", A);
  serve(env, "b", B);
  const el = env.connect(env.create({ src: "data/a.json" }));
  const seen = env.listen(el);
  await env.settle();
  assert.strictEqual(el.handle.info().dimension, 384);
  el.setAttribute("src", "data/b.json");
  await env.settle();
  assert.strictEqual(el.handle.info().dimension, 1024);
  assert.strictEqual(el.handle.info().count, B.json.count);
  assert.strictEqual(seen.at(-1).detail.op, "replace");
  assert.strictEqual(viewerRoots(el).length, 1);
  assert.strictEqual(env.calls.mount.length, 1, "the same viewer shows the new file");
});

test("a failure clears when the next src loads", async () => {
  const env = makeShellEnv();
  serve(env, "a", A);
  const el = env.connect(env.create({ src: "https://evil.test/a.json" }));
  assert.match(el.textContent, /own origin/);
  el.setAttribute("src", "data/a.json");
  await env.settle();
  assert.ok(!/own origin/.test(el.textContent));
  assert.strictEqual(el.handle.info().count, A.json.count);
});

test("removing src keeps what is shown", async () => {
  const env = makeShellEnv();
  serve(env, "a", A);
  const el = env.connect(env.create({ src: "data/a.json" }));
  await env.settle();
  const before = env.fetches.length;
  el.removeAttribute("src");
  await env.settle();
  assert.strictEqual(env.fetches.length, before);
  assert.strictEqual(el.handle.info().count, A.json.count);
});

// ---------- races ----------

function deferred() {
  let go;
  const p = new Promise((r) => (go = r));
  return { p, go };
}

test("a fetch in flight when the element is removed never reaches update", async () => {
  const env = makeShellEnv();
  const gate = deferred();
  env.route(DIR + "a.json", () => gate.p);
  env.route(DIR + A.json.vectors.file, () => ({ buffer: A.buffer }));
  const el = env.connect(env.create({ src: "data/a.json" }));
  const seen = env.listen(el);
  await env.settle();
  env.disconnect(el);
  gate.go({ json: A.json });
  await env.settle();
  assert.strictEqual(env.calls.update.length, 0);
  assert.strictEqual(env.core.get(el), null);
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(el.children.length, 0);
});

test("removed and re-added while a fetch is in flight: the old fetch is dropped", async () => {
  const env = makeShellEnv();
  const gate = deferred();
  let first = true;
  env.route(DIR + "a.json", () => {
    if (first) {
      first = false;
      return gate.p;
    }
    return { json: A.json };
  });
  env.route(DIR + A.json.vectors.file, () => ({ buffer: A.buffer }));
  const el = env.connect(env.create({ src: "data/a.json" }));
  await env.settle();
  env.disconnect(el);
  env.connect(el);
  await env.settle();
  assert.strictEqual(env.calls.update.length, 1);
  gate.go({ json: A.json });
  await env.settle();
  assert.strictEqual(env.calls.update.length, 1, "the stale response was ignored");
});

test("a slow reply for an old src never overwrites a newer src", async () => {
  const env = makeShellEnv();
  const slow = deferred();
  env.route(DIR + "a.json", () => slow.p);
  env.route(DIR + A.json.vectors.file, () => ({ buffer: A.buffer }));
  serve(env, "b", B);
  const el = env.connect(env.create({ src: "data/a.json" }));
  await env.settle();
  el.setAttribute("src", "data/b.json");
  await env.settle();
  assert.strictEqual(el.handle.info().dimension, 1024);
  slow.go({ json: A.json });
  await env.settle();
  assert.strictEqual(el.handle.info().dimension, 1024, "still the newer file");
  assert.strictEqual(env.calls.update.length, 1);
});

// ---------- update, events ----------

test("update(data) forwards to the viewer and fires the events", async () => {
  const env = makeShellEnv();
  const el = env.connect(env.create());
  const seen = env.listen(el);
  const ok = el.update(Object.assign({}, A.json, { vectors: A.buffer }));
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(seen[0].type, "tumbler-load");
  const bad = el.update({ nope: 1 });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(seen[1].type, "tumbler-error");
  assert.deepStrictEqual(Object.keys(seen[1].detail).sort(), ["code", "message"]);
  const lone = env.create();
  assert.strictEqual(lone.update({}).code, "not-mounted", "before connection: a result, no throw");
});

// ---------- styling and text ----------

test("the element styles itself only through el.style: no style element, attribute or markup", async () => {
  const env = makeShellEnv();
  serve(env, "a", A);
  const el = env.connect(env.create({ src: "data/a.json" }));
  await env.settle();
  assert.strictEqual(el.style.display, "block");
  assert.ok(!el.hasAttribute("style"));
  assert.ok(!env.dom.document.created.includes("style"));
  assert.ok(!env.dom.document.created.includes("script"));
  // fake-dom throws on setAttribute("style"), innerHTML and insertAdjacentHTML: reaching here proves none ran.
});

test("shell messages are text, not markup", () => {
  const env = makeShellEnv({ withCore: false });
  const el = env.connect(env.create());
  const note = el.children[0];
  assert.strictEqual(note.tagName, "P");
  assert.strictEqual(note.childNodes.length, 1);
  assert.strictEqual(note.childNodes[0].nodeType, 3);
});
