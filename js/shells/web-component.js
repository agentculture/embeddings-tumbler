// web-component.js: the <embeddings-tumbler> custom element (task t10).
//
// A shell, not a viewer: it holds no rendering and no projection code. It calls the core
// file's public API (mount, update, destroy) and nothing else. Load embeddings-tumbler.js first, then this file:
//
//   <script src="embeddings-tumbler.js"></script>
//   <script src="web-component.js"></script>
//   <embeddings-tumbler src="data/my-set.json" mode="tumble" seed="7"></embeddings-tumbler>
//
// Attributes: src (a data file on the page's own origin), mode, seed.
// Properties (never attributes; nothing is read from markup): embed and rerank, the search
// callbacks, set as el.embed = fn and el.rerank = fn (a function or null). See js/api/web-component.md.
// Events (bubbling): tumbler-load (detail: the update result), tumbler-error (detail:
// {code, message}). Property `handle` is the viewer handle or null; method update(data)
// forwards to the viewer. See js/api/web-component.md.
//
// Same origin only: a src is resolved against the page's base URL and refused, before any
// request, unless its origin is the page's. The component reads nothing from the
// environment and adds no request headers. All text it shows goes in as text.
(function (root) {
  "use strict";
  const NAME = "embeddings-tumbler";
  if (!root.customElements || !root.HTMLElement) return;
  // Loading this file twice must not throw: the first definition wins.
  if (root.customElements.get(NAME)) return;

  const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  // The one place the core global is read. A missing core is a plain message, not an error.
  function getCore() {
    const T = root.EmbeddingsTumbler;
    return typeof T?.mount === "function" ? T : null;
  }

  function parseSeed(text) {
    if (text === null || text === "") return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }

  function fail(code, message) {
    return { ok: false, code: code, message: message };
  }

  // Fetch one same-origin file. A failed status, or a redirect to another origin, throws:
  // it is not data from this origin.
  async function fetchSameOrigin(address) {
    const res = await root.fetch(address, { credentials: "same-origin" });
    if (!res.ok || new root.URL(res.url || address).origin !== root.location.origin) {
      throw new Error("unreadable");
    }
    return res;
  }

  class EmbeddingsTumblerElement extends root.HTMLElement {
    static get observedAttributes() {
      return ["src", "mode", "seed"];
    }

    constructor() {
      super();
      this._handle = null;
      this._token = 0; // bumped whenever a load is superseded, or the viewer is destroyed
      this._note = null;
      this._embed = null; // the host's callbacks; they outlive every mount of this element
      this._rerank = null;
    }

    get handle() {
      return this._handle;
    }

    // The embed callback, or null. A property, never an attribute.
    get embed() {
      return this._embed;
    }

    set embed(value) {
      this._setCallback("_embed", "embed", value);
    }

    // The rerank callback, or null. A property, never an attribute.
    get rerank() {
      return this._rerank;
    }

    set rerank(value) {
      this._setCallback("_rerank", "rerank", value);
    }

    // A function is kept and, with a viewer mounted, handed to it; null removes the callback.
    // Anything else is ignored (as the core ignores it). Not mounted (before connect, after
    // disconnect): kept, and passed as a mount option at the next mount.
    _setCallback(field, key, value) {
      if (value !== null && typeof value !== "function") return;
      this[field] = value;
      this._handle?.setSearchCallbacks({ [key]: value });
    }

    // A property set on the element before this file defined it is an own property that
    // hides the accessor: take it off and set it again through the accessor.
    _upgrade(name) {
      if (!Object.hasOwn(this, name)) return;
      const value = this[name];
      delete this[name];
      this[name] = value;
    }

    connectedCallback() {
      this._upgrade("embed");
      this._upgrade("rerank");
      this.style.display = "block";
      this._start();
    }

    disconnectedCallback() {
      this._stop();
    }

    attributeChangedCallback(name, before, after) {
      if (before === after || !this.isConnected) return;
      if (name === "mode") {
        // A running viewer switches mode in place; setMode returns false for an unknown id.
        if (this._handle && after !== null) this._handle.setMode(after);
      } else if (name === "seed") {
        // The core ignores new options for a mounted element: mount again, then reload.
        this._stop();
        this._start();
      } else {
        this._load();
      }
    }

    // Forwards to the viewer: this is how a host appends points. Never throws.
    update(data) {
      const T = getCore();
      const result = this._handle && T ? T.update(this, data) : fail("not-mounted", "No viewer is mounted in this element.");
      this._report(result);
      return result;
    }

    _start() {
      if (this._handle) return;
      const T = getCore();
      if (!T) {
        // Chosen: say so, retry nothing. Moving the element in the DOM (or re-adding it)
        // runs this again, which is the retry the host controls.
        this._say(
          "The viewer script is not loaded. Load embeddings-tumbler.js before web-component.js."
        );
        this._emit("tumbler-error", {
          code: "core-missing",
          message: "embeddings-tumbler.js is not loaded.",
        });
        return;
      }
      this._clearNote();
      const options = {};
      const mode = this.getAttribute("mode");
      if (mode) options.mode = mode;
      const seed = parseSeed(this.getAttribute("seed"));
      if (seed !== undefined) options.seed = seed;
      if (this._embed) options.embed = this._embed;
      if (this._rerank) options.rerank = this._rerank;
      try {
        this._handle = T.mount(this, options);
      } catch (err) {
        this._say("The viewer could not start.");
        this._emit("tumbler-error", { code: "mount-failed", message: "The viewer could not start." });
        return;
      }
      this._load();
    }

    _stop() {
      this._token++; // a fetch still in flight must not touch the destroyed viewer
      const T = getCore();
      if (T && this._handle) T.destroy(this);
      this._handle = null;
      this._clearNote();
    }

    // Load src if there is one; otherwise show nothing (the host calls update). Removing
    // src keeps what is on screen. Every expected failure is reported inside _loadSrc; an
    // unexpected one is reported here through the same path, never dropped.
    _load() {
      const token = ++this._token;
      if (!this._handle) return;
      const src = this.getAttribute("src");
      if (src === null) return;
      this._loadSrc(src, token).catch(() => {
        this._refuse(token, "src-unreadable", "The data file could not be loaded.");
      });
    }

    // True while the load numbered `token` is still the current one and a viewer is mounted.
    _live(token) {
      return token === this._token && this._handle !== null;
    }

    // Show and report a load failure, unless that load has been superseded.
    _refuse(token, code, message) {
      if (!this._live(token)) return;
      this._say(message);
      this._emit("tumbler-error", { code: code, message: message });
    }

    async _loadSrc(src, token) {
      const T = getCore();
      let url;
      try {
        url = new root.URL(src, root.document.baseURI);
      } catch (err) {
        return this._refuse(token, "src-refused", "The src value is not a usable address.");
      }
      // Compared before any request is made. An opaque origin ("null": file:, data:) never matches.
      if (url.origin === "null" || url.origin !== root.location.origin) {
        return this._refuse(
          token,
          "src-refused",
          "The src must be a file on this page's own origin. Nothing was requested."
        );
      }
      if (typeof root.fetch !== "function") {
        return this._refuse(token, "src-unreadable", "This browser cannot load files.");
      }
      let records;
      try {
        records = await (await fetchSameOrigin(url.href)).json();
      } catch (err) {
        return this._refuse(token, "src-unreadable", "The data file could not be read as JSON.");
      }
      if (!this._live(token)) return;
      const vectors = records && typeof records === "object" ? records.vectors : null;
      if (vectors && typeof vectors === "object" && typeof vectors.file === "string" && PLAIN_NAME.test(vectors.file)) {
        let block;
        try {
          block = await (await fetchSameOrigin(new root.URL(vectors.file, url.href).href)).arrayBuffer();
        } catch (err) {
          return this._refuse(token, "block-unreadable", 'Vector file "' + vectors.file + '" could not be read.');
        }
        if (!this._live(token)) return;
        // The descriptor stays, with the block beside it: the core checks the file
        // form's own fields (dtype, byte order, declared length) against the block.
        records = { ...records, vectors: { ...vectors, data: block } };
      }
      // Anything else (no vectors, a file name that is not plain) goes to the viewer as it
      // is: it validates, shows its own plain refusal and returns it.
      this._clearNote();
      this._report(T.update(this, records));
    }

    _report(result) {
      if (result?.ok) this._emit("tumbler-load", result);
      else if (result) this._emit("tumbler-error", { code: result.code, message: result.message });
    }

    _emit(type, detail) {
      this.dispatchEvent(new root.CustomEvent(type, { bubbles: true, detail: detail }));
    }

    _say(message) {
      this._clearNote();
      const p = root.document.createElement("p");
      p.className = "tumbler-shell-message";
      p.setAttribute("role", "alert");
      p.textContent = message;
      this.appendChild(p);
      this._note = p;
    }

    _clearNote() {
      this._note?.remove();
      this._note = null;
    }
  }

  root.customElements.define(NAME, EmbeddingsTumblerElement);
})(typeof globalThis === "undefined" ? this : globalThis);
