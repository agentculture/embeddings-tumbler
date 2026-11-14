"use strict";
// Unit tests for the standalone page's script (js/page/page.js) in a small fake
// browser: the query, the size limit on the records file, and abandoning a load
// when the page is left. The real page runs in tests/browser/test_standalone_page.py.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT } = require("./helpers/load.js");

// The page script is run from its real path (not a temporary copy), so that the test
// coverage report counts js/page/page.js itself.
const PAGE_FILE = path.join(ROOT, "js", "page", "page.js");
const CODE = fs.readFileSync(PAGE_FILE, "utf8");
const PAGE_FUNCTION = (names) =>
  vm.compileFunction(CODE, names, { filename: PAGE_FILE });
const ORIGIN = "http://127.0.0.1:9";

function el(id) {
  const attrs = {};
  return {
    id,
    textContent: "",
    hidden: ["note-sample", "note-file", "note-demo", "set-switch"].includes(id),
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
// `extra.route(url, init)` answers the helper route's requests (default: a network error);
// `extra.protocol` and `extra.origin` change where the page is "served" from;
// `extra.update(data)` answers the viewer's update (default: accepted); `extra.noSample`
// leaves sample-data.js out.
function runPage(search, fetchImpl, extra = {}) {
  const els = {};
  const ids = ["space", "wait", "wait-text", "note-sample", "note-file", "note-demo", "set-switch"];
  ids.concat(["set-switch-text", "set-switch-link"]).forEach((id) => (els[id] = el(id)));
  els.wait.parentNode = els.space;
  els["wait-text"].textContent = "Loading the viewer…";
  const body = el("body");
  body.setAttribute("data-page-state", "loading");
  const listeners = {};
  const world = {
    els, body, mounted: 0, generated: 0, fetches: [], listeners, updates: [],
    routeFetches: [], timers: [], mountOptions: [], cleared: [], fills: {},
  };
  const handle = {
    update(data) {
      world.updates.push(data);
      return extra.update ? extra.update(data) : { ok: true };
    },
    mode() {
      return "tumble";
    },
    info() {
      return { dimension: 8, count: 10, model: "m-demo" };
    },
  };
  const api = {
    mount(_el, options) {
      world.mountOptions.push(options);
      if (extra.mountThrows) throw new Error("mount failed");
      world.mounted++;
      return handle;
    },
    sample: extra.noSample
      ? undefined
      : {
          generate() {
            world.generated++;
            return { kind: "embeddings-tumbler/data", synthetic: true };
          },
        },
  };
  const origin = extra.origin || ORIGIN;
  const window = {
    location: {
      search,
      href: origin + "/index.html" + search,
      pathname: "/index.html",
      protocol: extra.protocol || "http:",
      origin,
    },
    EmbeddingsTumbler: api,
    fetch(url, init) {
      if (String(url).endsWith("/_tumbler/search")) {
        world.routeFetches.push({ url, init });
        return extra.route ? extra.route(url, init) : Promise.reject(new TypeError("Failed to fetch"));
      }
      world.fetches.push({ url, init });
      return fetchImpl(url, init, world);
    },
    requestAnimationFrame(cb) {
      cb();
    },
    setTimeout(cb, ms) {
      if (ms) {
        const timer = { cb, ms, cleared: false };
        world.timers.push(timer);
        return timer;
      }
      cb();
      return null;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    addEventListener(type, fn) {
      listeners[type] ??= [];
      listeners[type].push(fn);
    },
  };
  const document = {
    body,
    getElementById: (id) => els[id] || null,
    // Only the page's fill-ins are looked up by selector; each is a fake element.
    querySelectorAll: (sel) => {
      const m = /^\[data-fill="([a-z-]+)"\]$/.exec(sel);
      if (!m) return [];
      world.fills[m[1]] ??= el("fill-" + m[1]);
      return [world.fills[m[1]]];
    },
  };
  const globals = {
    window,
    document,
    performance: { mark() { /* marks are not measured here */ } },
    URL,
    URLSearchParams,
    AbortController: extra.noAbort ? undefined : AbortController,
    console,
  };
  PAGE_FUNCTION(Object.keys(globals))(...Object.values(globals));
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

test("a whitespace-only ?data= shows the default set, like an empty one", async () => {
  for (const q of ["?data=", "?data=%20%20", "?data=+", "?data=%09"]) {
    const w = runPage(q, () => Promise.reject(new Error("no demo set here")));
    await settle();
    assert.deepStrictEqual(w.fetches.map((f) => f.url), [ORIGIN + "/demo-wikipedia.json"], q);
    assert.strictEqual(w.generated, 1, q + ": the demo set could not be read, so the sample set is generated");
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

// ---------- the helper route: search by embedding ----------

function json(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

const DESCRIBE = {
  ok: true,
  embed: { model: "m-embed", query_form: "plain" },
  rerank: { model: "m-rerank" },
  limits: { maxTextChars: 8000, maxCandidates: 60, maxCandidateChars: 5, requestsPerMinute: 120 },
};

// A fake route: records bodies, answers each op the way the helper does.
function fakeRoute(describe = DESCRIBE) {
  const seen = [];
  const route = (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (body.op === "describe") return json(describe);
    if (body.op === "embed") return json({ ok: true, vector: [1, 0], model: "m-embed", query_form: "plain" });
    return json({ ok: true, scores: body.candidates.map((_c, i) => i), model: "m-rerank" });
  };
  route.seen = seen;
  return route;
}

async function sampleWith(extra, search = "") {
  const w = runPage(search, () => Promise.reject(new Error("no data request expected")), extra);
  await settle();
  await settle();
  return w;
}

test("a route that answers describe gives the viewer embed and rerank callbacks", async () => {
  const route = fakeRoute();
  const w = await sampleWith({ route });
  assert.strictEqual(w.mounted, 1);
  const opts = w.mountOptions[0];
  assert.strictEqual(typeof opts.embed, "function");
  assert.strictEqual(typeof opts.rerank, "function");
  assert.deepStrictEqual(await opts.embed("hello"), { vector: [1, 0], model: "m-embed", queryForm: "plain" });
  const ranked = await opts.rerank("q", ["abcdefghij", "xy"]);
  assert.deepStrictEqual(ranked, { scores: [0, 1], model: "m-rerank" });
  assert.deepStrictEqual(route.seen.at(-1).candidates, ["abcde", "xy"], "cut to maxCandidateChars");
  assert.deepStrictEqual(route.seen[0], { op: "describe" });
  assert.strictEqual(w.body.getAttribute("data-page-state"), "ready");
});

test("a route with no rerank gives embed only, and a probe is one request with a short timeout", async () => {
  const w = await sampleWith({ route: fakeRoute({ ...DESCRIBE, rerank: null }) });
  const opts = w.mountOptions[0];
  assert.strictEqual(typeof opts.embed, "function");
  assert.strictEqual(opts.rerank, undefined);
  assert.strictEqual(w.routeFetches.length, 1, "describe once");
  const init = w.routeFetches[0].init;
  assert.strictEqual(init.method, "POST");
  assert.strictEqual(init.redirect, "error", "a redirect is never followed");
  assert.ok(init.signal, "the probe can be cut short");
  const timer = w.timers.find((t) => t.ms <= 5000);
  assert.ok(timer, "a short probe timeout is set");
  assert.strictEqual(timer.cleared, true, "and cleared once the answer came");
});

test("the route is the page's own origin's fixed path, whatever the query or the data say", async () => {
  const foreign = "http://foreign.invalid";
  const route = fakeRoute();
  const w = await sampleWith(
    { route },
    "?helper=" + foreign + "&route=" + foreign + "/x&embed=" + foreign + "&_tumbler=" + foreign
  );
  assert.strictEqual(w.routeFetches.length, 1);
  assert.strictEqual(w.routeFetches[0].url, ORIGIN + "/_tumbler/search");
  await w.mountOptions[0].embed("t");
  assert.ok(w.routeFetches.every((f) => f.url === ORIGIN + "/_tumbler/search"));

  // A data file with fields that look like a helper address changes nothing either.
  const records = {
    kind: "other",
    helper: foreign + "/h",
    search_route: foreign + "/r",
    embed_url: foreign + "/e",
    vectors: { file: "x.f32" },
  };
  const w2 = runPage("?data=d.json", () => Promise.resolve(response(JSON.stringify(records))), { route: fakeRoute() });
  await settle();
  await settle();
  await w2.mountOptions[0].embed("t");
  assert.ok(w2.routeFetches.length >= 2);
  assert.ok(w2.routeFetches.every((f) => f.url === ORIGIN + "/_tumbler/search"));
  assert.ok(w2.fetches.every((f) => f.url.startsWith(ORIGIN + "/")));
});

test("every way the describe request can fail leaves search among loaded points, once", async () => {
  const bad = {
    "404": () => json({}, 404),
    "501": () => json({}, 501),
    "405": () => json({ ok: false, code: "wrong-method" }, 405),
    "network error": () => Promise.reject(new TypeError("Failed to fetch")),
    "non-JSON answer": () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("x")) }),
    "ok false": () => json({ ok: false }),
    "no embed model": () => json({ ok: true, embed: {}, rerank: null }),
    "not an object": () => json("<html>"),
    "null answer": () => json(null),
  };
  for (const [name, route] of Object.entries(bad)) {
    const w = await sampleWith({ route });
    assert.strictEqual(w.mounted, 1, name);
    assert.deepStrictEqual(Object.keys(w.mountOptions[0]).filter((k) => k === "embed" || k === "rerank"), [], name);
    assert.strictEqual(w.routeFetches.length, 1, name + ": no retry");
    assert.strictEqual(w.body.getAttribute("data-page-state"), "ready", name);
  }
});

test("a describe that never answers is cut off by its timeout and the page still mounts", async () => {
  const route = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const w = runPage("", () => Promise.reject(new Error("none")), { route });
  await settle();
  assert.strictEqual(w.mounted, 0, "the page waits for the probe, a short time");
  const timer = w.timers.find((t) => t.ms <= 5000);
  timer.cb();
  await settle();
  await settle();
  assert.strictEqual(w.mounted, 1);
  assert.strictEqual(w.mountOptions[0].embed, undefined);
});

test("a page opened as a plain file makes no route request at all", async () => {
  const w = await sampleWith({ protocol: "file:", origin: "null", route: fakeRoute() });
  assert.strictEqual(w.routeFetches.length, 0);
  assert.strictEqual(w.mounted, 1);
  assert.strictEqual(w.mountOptions[0].embed, undefined);
});

test("the embed callback shows the page's own words for each refusal, never the server's text", async () => {
  const sentinel = "SERVER TEXT <img src=x onerror=alert(1)>";
  const cases = [
    ["rate-limited", /busy/],
    ["text-too-long", /too long/],
    ["too-many-candidates", /Too many candidates/],
    ["gateway-timeout", /in time/],
    ["gateway-failed", /did not answer/],
    ["rerank-unavailable", /does not offer reranking/],
    ["wrong-origin", /refused the request/],
    ["something-new", /refused the request/],
  ];
  for (const [code, pattern] of cases) {
    let refuse = false;
    const route = (_u, init) => {
      const body = JSON.parse(init.body);
      if (body.op === "describe" || !refuse) return json(DESCRIBE);
      return json({ ok: false, code, message: sentinel }, 429);
    };
    const w = await sampleWith({ route });
    refuse = true;
    for (const call of [(o) => o.embed("t"), (o) => o.rerank("q", ["a"])]) {
      await assert.rejects(call(w.mountOptions[0]), (err) => {
        assert.match(err.message, pattern, code);
        assert.ok(!err.message.includes("SERVER TEXT"), "the server's text is not passed on");
        return true;
      });
    }
  }
});

test("an unreachable, non-JSON or ok:false answer to embed rejects with a plain message", async () => {
  let mode = "describe";
  const route = (_u, init) => {
    if (JSON.parse(init.body).op === "describe") return json(DESCRIBE);
    if (mode === "network") return Promise.reject(new TypeError("boom 10.0.0.5"));
    if (mode === "html") return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError("x")) });
    return json({ ok: false }, 200);
  };
  const w = await sampleWith({ route });
  const embed = w.mountOptions[0].embed;
  mode = "network";
  await assert.rejects(embed("t"), (err) => /could not be reached/.test(err.message) && !err.message.includes("10.0.0.5"));
  mode = "html";
  await assert.rejects(embed("t"), /refused the request/);
  mode = "false";
  await assert.rejects(embed("t"), /refused the request/);
});

test("a route address that is not on the page's own origin is never used", async () => {
  // A page whose location is odd enough that the fixed path would leave the origin
  // cannot be built: the page falls back to no helper rather than guess.
  const w = await sampleWith({ origin: "ftp://host", protocol: "http:", route: fakeRoute() });
  assert.strictEqual(w.routeFetches.length, 0);
  assert.strictEqual(w.mounted, 1);
});

test("with no AbortController the probe still runs, and a viewer that fails to start is reported plainly", async () => {
  const w = await sampleWith({ route: fakeRoute(), noAbort: true });
  assert.strictEqual(w.mounted, 1);
  assert.strictEqual(typeof w.mountOptions[0].embed, "function");
  assert.strictEqual(w.routeFetches[0].init.signal, undefined);

  const bad = await sampleWith({ route: fakeRoute(), mountThrows: true });
  assert.strictEqual(bad.body.getAttribute("data-page-state"), "error");
  assert.match(bad.els["wait-text"].textContent, /could not start the viewer/);
});

// ---------- the default set: the Wikipedia pair shipped beside the page ----------

const DEMO_RECORDS = {
  kind: "embeddings-tumbler/data",
  schema_version: 1,
  model: "m-demo",
  dimension: 2,
  count: 1,
  provenance: { synthetic: false },
  vectors: { file: "demo-wikipedia.f32", dtype: "float32", byte_order: "little", byte_length: 8 },
  points: [{ id: "wp-1", label: "Moon" }],
};

// Serves the demo pair (or answers `status` for every request).
function demoFetch(records = DEMO_RECORDS, status = 200) {
  return (url) => {
    if (status !== 200) return Promise.resolve({ ...response(""), ok: false, status });
    return Promise.resolve(url.endsWith(".json") ? response(JSON.stringify(records)) : response(""));
  };
}

async function settled(w) {
  for (let i = 0; i < 4; i++) await settle();
  return w;
}

test("with no address the page shows the Wikipedia pair from its own folder", async () => {
  const w = await settled(runPage("", demoFetch()));
  assert.deepStrictEqual(
    w.fetches.map((f) => f.url),
    [ORIGIN + "/demo-wikipedia.json", ORIGIN + "/demo-wikipedia.f32"]
  );
  assert.strictEqual(w.fetches[0].init.credentials, "same-origin");
  assert.strictEqual(w.generated, 0, "the synthetic set is not generated");
  assert.strictEqual(w.updates.length, 1);
  assert.strictEqual(w.updates[0].model, "m-demo");
  assert.strictEqual(Object.prototype.toString.call(w.updates[0].vectors.data), "[object ArrayBuffer]");
  assert.strictEqual(w.body.getAttribute("data-page-state"), "ready");
  assert.strictEqual(w.els["note-demo"].hidden, false);
  assert.strictEqual(w.els["note-sample"].hidden, true);
  assert.strictEqual(w.els["note-file"].hidden, true);
  assert.strictEqual(w.fills["demo-count"].textContent, "10", "the count comes from the viewer's info");
  assert.strictEqual(w.fills["demo-model"].textContent, "m-demo");
  assert.strictEqual(w.fills["demo-kind"], undefined, "a real set keeps the page's own words");
  assert.strictEqual(w.els["set-switch"].hidden, false);
  assert.strictEqual(w.els["set-switch-link"].href, "?sample=synthetic");
  assert.match(w.els["set-switch-link"].textContent, /synthetic sample set/);
});

test("a stand-in default set says it is not a model's output", async () => {
  const records = { ...DEMO_RECORDS, provenance: { synthetic: true } };
  const w = await settled(runPage("", demoFetch(records)));
  assert.match(w.fills["demo-kind"].textContent, /stand-in/);
  assert.strictEqual(w.els["note-demo"].hidden, false);
});

test("the switch keeps the mode and the seed", async () => {
  const w = await settled(runPage("?mode=lattice&seed=7", demoFetch()));
  assert.strictEqual(w.els["set-switch-link"].href, "?mode=lattice&seed=7&sample=synthetic");
});

test("?sample=synthetic shows the synthetic set and requests nothing", async () => {
  const w = await settled(runPage("?sample=synthetic", () => Promise.reject(new Error("no request expected"))));
  assert.strictEqual(w.fetches.length, 0);
  assert.strictEqual(w.generated, 1);
  assert.strictEqual(w.body.getAttribute("data-page-state"), "ready");
  assert.strictEqual(w.els["note-sample"].hidden, false);
  assert.strictEqual(w.els["note-demo"].hidden, true);
  assert.strictEqual(w.els["set-switch-text"].textContent, "Showing the synthetic sample set.");
  assert.strictEqual(w.els["set-switch-link"].href, "/index.html", "back to the default address");
  const kept = await settled(runPage("?sample=synthetic&mode=wander", () => Promise.reject(new Error("none"))));
  assert.strictEqual(kept.els["set-switch-link"].href, "?mode=wander");
});

test("a missing or unreachable Wikipedia pair falls back to the synthetic set and says so", async () => {
  const cases = {
    "404 records": demoFetch(DEMO_RECORDS, 404),
    "network error": () => Promise.reject(new TypeError("Failed to fetch")),
    "404 block": (url) =>
      Promise.resolve(url.endsWith(".json") ? response(JSON.stringify(DEMO_RECORDS)) : { ...response(""), ok: false, status: 404 }),
    "not JSON": () => Promise.resolve(response("<html>")),
  };
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const w = await settled(runPage("", fetchImpl));
    assert.strictEqual(w.generated, 1, name);
    assert.strictEqual(w.mounted, 1, name);
    assert.strictEqual(w.body.getAttribute("data-page-state"), "ready", name);
    assert.strictEqual(w.els["note-sample"].hidden, false, name);
    assert.strictEqual(w.els["note-demo"].hidden, true, name);
    assert.match(w.els["set-switch-text"].textContent, /demo-wikipedia\.json\) could not be read/, name);
    assert.strictEqual(w.els["set-switch-link"].hidden, true, name);
  }
});

test("a Wikipedia pair the viewer refuses is replaced by the synthetic set", async () => {
  const w = await settled(runPage("", demoFetch(), { update: (data) => ({ ok: data.synthetic === true }) }));
  assert.strictEqual(w.updates.length, 2, "the refused set, then the synthetic one");
  assert.strictEqual(w.updates[1].synthetic, true);
  assert.strictEqual(w.mounted, 1, "one viewer");
  assert.strictEqual(w.body.getAttribute("data-page-state"), "ready");
  assert.match(w.els["set-switch-text"].textContent, /the viewer refused the Wikipedia set/);
  assert.strictEqual(w.els["note-sample"].hidden, false);
});

test("a refused Wikipedia pair with no sample-data.js leaves the viewer's refusal", async () => {
  const w = await settled(runPage("", demoFetch(), { noSample: true, update: () => ({ ok: false }) }));
  assert.strictEqual(w.updates.length, 1);
  assert.strictEqual(w.body.getAttribute("data-page-state"), "refused");
});

test("a page opened as a file shows the synthetic set without trying to read the pair", async () => {
  const w = await settled(
    runPage("", () => Promise.reject(new Error("no request expected")), { protocol: "file:", origin: "null" })
  );
  assert.strictEqual(w.fetches.length, 0);
  assert.strictEqual(w.generated, 1);
  assert.match(w.els["set-switch-text"].textContent, /opened as a file/);
});

test("with neither the Wikipedia pair nor sample-data.js the page says plainly that nothing can be shown", async () => {
  const w = await settled(runPage("", demoFetch(DEMO_RECORDS, 404), { noSample: true }));
  assert.strictEqual(w.mounted, 0);
  assert.strictEqual(w.body.getAttribute("data-page-state"), "error");
  assert.match(w.els["wait-text"].textContent, /^Nothing can be shown: the Wikipedia set .* sample-data\.js is missing/);
});

test("a data address still wins over the default and shows no switch", async () => {
  const w = await settled(runPage("?data=x.json&sample=synthetic", demoFetch()));
  assert.deepStrictEqual(w.fetches.map((f) => f.url), [ORIGIN + "/x.json", ORIGIN + "/demo-wikipedia.f32"]);
  assert.strictEqual(w.generated, 0);
  assert.strictEqual(w.els["set-switch"].hidden, true);
  assert.strictEqual(w.els["note-file"].hidden, false);
});
