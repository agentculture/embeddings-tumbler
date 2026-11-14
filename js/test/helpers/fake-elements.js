"use strict";
// Custom-element support for the web component's node tests (js/shells/web-component.js).
// It sits on top of fake-dom.js without loosening any of its checks (a style attribute or
// markup parsing still throws). Zero dependencies.
//
// makeShellEnv(options) returns an environment with:
//   dom        the makeFakeDom() control object (document, flush(), pendingFrames(), ...)
//   core       the core API as seen by the shell (spies in `calls`; a test may swap members)
//   calls      { mount: [], update: [], destroy: [] } argument lists
//   fetches    [{ url, init }] every fetch call, in order
//   route(url, handler)   handler(url, init) returns a response description or a promise of one:
//                         { status, json, buffer, url }   (json is a value or a function)
//   create(attrs)         a new <embeddings-tumbler> (not yet in the document)
//   connect(el), disconnect(el)   what a browser does when the element enters or leaves the page
//   load()                run web-component.js in the shell's global scope (again if asked)
//   root       the global object the shell sees (customElements, location, URL, fetch, ...)
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { makeFakeDom, FakeElement } = require("./fake-dom.js");
const { loadAssembled, ROOT } = require("./load.js");

const SHELL = path.join(ROOT, "js", "shells", "web-component.js");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "contract");

function fixture(name) {
  const json = JSON.parse(fs.readFileSync(path.join(FIXTURES, name + ".json"), "utf8"));
  const buf = fs.readFileSync(path.join(FIXTURES, name + ".f32"));
  const buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { json, buffer };
}

function makeShellEnv(options) {
  const opts = Object.assign(
    { origin: "http://host.test", sample: false, withCore: true, file: SHELL },
    options || {}
  );
  const dom = makeFakeDom();
  const doc = dom.document;
  const realCore = loadAssembled();
  const calls = { mount: [], update: [], destroy: [] };
  const core = {
    mount(el, o) {
      calls.mount.push([el, o]);
      return realCore.mount(el, o);
    },
    update(el, d) {
      calls.update.push([el, d]);
      return realCore.update(el, d);
    },
    destroy(el) {
      calls.destroy.push([el]);
      return realCore.destroy(el);
    },
    get: (el) => realCore.get(el),
  };
  if (opts.sample) core.sample = require(path.join(ROOT, "js", "sample", "sample-data.js"));

  const registry = new Map();
  let defines = 0;
  class HTMLElement extends FakeElement {
    constructor() {
      super(doc, "embeddings-tumbler");
      this.connected = false;
    }
    get isConnected() {
      return this.connected;
    }
    setAttribute(name, value) {
      const before = this.getAttribute(name);
      super.setAttribute(name, value);
      this._observe(name, before, String(value));
    }
    removeAttribute(name) {
      const before = this.getAttribute(name);
      super.removeAttribute(name);
      this._observe(name, before, null);
    }
    _observe(name, before, after) {
      const watched = this.constructor.observedAttributes || [];
      if (watched.includes(name) && this.attributeChangedCallback) {
        this.attributeChangedCallback(name, before, after);
      }
    }
  }
  const customElements = {
    define(name, ctor) {
      if (registry.has(name)) throw new Error("fake customElements: already defined: " + name);
      defines++;
      registry.set(name, ctor);
    },
    get: (name) => registry.get(name),
  };

  const fetches = [];
  const routes = new Map();
  function fetch(url, init) {
    fetches.push({ url: String(url), init });
    const handler = routes.get(String(url));
    const made = handler ? handler(String(url), init) : { status: 404 };
    return Promise.resolve(made).then((r) => {
      const status = r.status === undefined ? 200 : r.status;
      return {
        ok: status >= 200 && status < 300,
        status,
        url: r.url === undefined ? String(url) : r.url,
        json: async () => {
          if (typeof r.json === "function") return r.json();
          if (r.json === undefined) throw new SyntaxError("not json");
          return r.json;
        },
        arrayBuffer: async () => r.buffer,
      };
    });
  }

  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.bubbles = !!(init && init.bubbles);
      this.detail = init ? init.detail : null;
    }
  }

  const root = {
    customElements,
    HTMLElement,
    document: Object.assign(doc, { baseURI: opts.origin + "/page/index.html" }),
    location: { origin: opts.origin },
    URL,
    fetch,
    CustomEvent,
    console,
    EmbeddingsTumbler: opts.withCore ? core : undefined,
  };
  root.globalThis = root;
  const context = vm.createContext(root);

  function load() {
    vm.runInContext(fs.readFileSync(opts.file, "utf8"), context, { filename: "web-component.js" });
  }
  load();

  return {
    dom,
    core,
    calls,
    fetches,
    root,
    load,
    defines: () => defines,
    realCore,
    route: (url, handler) => routes.set(url, handler),
    create(attrs) {
      const ctor = customElements.get("embeddings-tumbler");
      const el = new ctor();
      for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
      return el;
    },
    connect(el) {
      doc.body.appendChild(el);
      el.connected = true;
      el.connectedCallback();
      return el;
    },
    disconnect(el) {
      doc.body.removeChild(el);
      el.connected = false;
      el.disconnectedCallback();
      return el;
    },
    // Record the events an element dispatches.
    listen(el) {
      const seen = [];
      for (const type of ["tumbler-load", "tumbler-error"]) {
        el.addEventListener(type, (e) => seen.push({ type, detail: e.detail, bubbles: e.bubbles }));
      }
      return seen;
    },
    // Let pending promise work (fetch chains) finish.
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

module.exports = { makeShellEnv, fixture, SHELL };
