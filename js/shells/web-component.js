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
// Events (bubbling): tumbler-load (detail: the update result), tumbler-error (detail:
// {code, message}). Property `handle` is the viewer handle or null; method update(data)
// forwards to the viewer. See js/api/web-component.md.
//
// Same origin only: a src is resolved against the page's base URL and refused, before any
// request, unless its origin is the page's. The component reads nothing from the
// environment and adds no request headers. All text it shows goes in as text.
(function (root) {
  "use strict";
  var NAME = "embeddings-tumbler";
  if (!root.customElements || !root.HTMLElement) return;
  // Loading this file twice must not throw: the first definition wins.
  if (root.customElements.get(NAME)) return;

  var PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  // The one place the core global is read. A missing core is a plain message, not an error.
  function getCore() {
    var T = root.EmbeddingsTumbler;
    return T && typeof T.mount === "function" ? T : null;
  }

  function parseSeed(text) {
    if (text === null || text === "") return undefined;
    var n = Number(text);
    return isFinite(n) ? n : text;
  }

  function fail(code, message) {
    return { ok: false, code: code, message: message };
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
    }

    get handle() {
      return this._handle;
    }

    connectedCallback() {
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
      var T = getCore();
      var result = this._handle && T ? T.update(this, data) : fail("not-mounted", "No viewer is mounted in this element.");
      this._report(result);
      return result;
    }

    _start() {
      if (this._handle) return;
      var T = getCore();
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
      var options = {};
      var mode = this.getAttribute("mode");
      if (mode) options.mode = mode;
      var seed = parseSeed(this.getAttribute("seed"));
      if (seed !== undefined) options.seed = seed;
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
      var T = getCore();
      if (T && this._handle) T.destroy(this);
      this._handle = null;
      this._clearNote();
    }

    // Load src if there is one; otherwise show nothing (the host calls update). Removing
    // src keeps what is on screen.
    _load() {
      var token = ++this._token;
      if (!this._handle) return;
      var src = this.getAttribute("src");
      if (src !== null) this._loadSrc(src, token);
    }

    async _loadSrc(src, token) {
      var self = this;
      var T = getCore();
      var live = function () {
        return token === self._token && self._handle !== null;
      };
      var stop = function (code, message) {
        if (!live()) return;
        self._say(message);
        self._emit("tumbler-error", { code: code, message: message });
      };
      var url;
      try {
        url = new root.URL(src, root.document.baseURI);
      } catch (err) {
        return stop("src-refused", "The src value is not a usable address.");
      }
      // Compared before any request is made. An opaque origin ("null": file:, data:) never matches.
      if (url.origin === "null" || url.origin !== root.location.origin) {
        return stop(
          "src-refused",
          "The src must be a file on this page's own origin. Nothing was requested."
        );
      }
      if (typeof root.fetch !== "function") return stop("src-unreadable", "This browser cannot load files.");
      var fetched = async function (address) {
        var res = await root.fetch(address, { credentials: "same-origin" });
        // A redirect to another origin is not data from this one.
        if (!res.ok || new root.URL(res.url || address).origin !== root.location.origin) {
          throw new Error("unreadable");
        }
        return res;
      };
      var records;
      try {
        records = await (await fetched(url.href)).json();
      } catch (err) {
        return stop("src-unreadable", "The data file could not be read as JSON.");
      }
      if (!live()) return;
      var vectors = records && typeof records === "object" ? records.vectors : null;
      if (vectors && typeof vectors === "object" && typeof vectors.file === "string" && PLAIN_NAME.test(vectors.file)) {
        var block;
        try {
          block = await (await fetched(new root.URL(vectors.file, url.href).href)).arrayBuffer();
        } catch (err) {
          return stop("block-unreadable", 'Vector file "' + vectors.file + '" could not be read.');
        }
        if (!live()) return;
        records = Object.assign({}, records, { vectors: block });
      }
      // Anything else (no vectors, a file name that is not plain) goes to the viewer as it
      // is: it validates, shows its own plain refusal and returns it.
      this._clearNote();
      this._report(T.update(this, records));
    }

    _report(result) {
      if (result && result.ok) this._emit("tumbler-load", result);
      else if (result) this._emit("tumbler-error", { code: result.code, message: result.message });
    }

    _emit(type, detail) {
      this.dispatchEvent(new root.CustomEvent(type, { bubbles: true, detail: detail }));
    }

    _say(message) {
      this._clearNote();
      var p = root.document.createElement("p");
      p.className = "tumbler-shell-message";
      p.setAttribute("role", "alert");
      p.textContent = message;
      this.appendChild(p);
      this._note = p;
    }

    _clearNote() {
      if (this._note && this._note.parentNode) this._note.parentNode.removeChild(this._note);
      this._note = null;
    }
  }

  root.customElements.define(NAME, EmbeddingsTumblerElement);
})(typeof globalThis !== "undefined" ? globalThis : this);
