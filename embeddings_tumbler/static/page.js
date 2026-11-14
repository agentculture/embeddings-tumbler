// The standalone page of embeddings-tumbler: a shell around ONE viewer.
//
//   index.html                      the built-in sample set
//   index.html?data=sets/a.json     a data file from this page's own origin
//   ...&mode=lattice&seed=7         optional starting mode and view seed
//
// This script holds no rendering or projection logic. It calls only
// EmbeddingsTumbler.mount and the handle's update (and sample.generate for the
// sample set). It fetches a data file and its sibling .f32 block itself, same
// origin only, and hands the in-memory form to update, which validates it and
// shows any refusal inside the viewer. The page's own messages use textContent.
(function () {
  "use strict";

  var KIND = "embeddings-tumbler/data";
  var SCHEMA_VERSION = 1; // the version this page's copy of the core reads
  var PLAIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  var TITLE = "Embedding Tumbler";
  // The largest records file (the .json) the page reads, judged by its
  // Content-Length before the body is read, and by its length after reading
  // when the server sends none. The binary .f32 block is not limited here.
  var MAX_RECORDS_BYTES = 64 * 1024 * 1024;
  var MAX_RECORDS_TEXT = "64 MB";

  var doc = document;
  var body = doc.body;
  var space = doc.getElementById("space");
  var wait = doc.getElementById("wait");
  var waitText = doc.getElementById("wait-text");

  function setState(state) {
    body.setAttribute("data-page-state", state);
  }

  function mark(name) {
    try {
      performance.mark(name);
    } catch (err) {
      // marks are a convenience for measuring; their absence changes nothing
    }
  }

  function say(message) {
    waitText.textContent = message;
  }

  function fail(message) {
    if (wait.parentNode !== space) space.appendChild(wait);
    wait.setAttribute("role", "alert");
    say(message);
    setState("error");
  }

  function PageError(message) {
    this.pageMessage = message;
  }

  function thousands(n) {
    return Number(n).toLocaleString("en-US");
  }

  function readQuery() {
    var params = null;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (err) {
      params = null;
    }
    function get(key) {
      return params ? params.get(key) : null;
    }
    var options = {};
    var mode = get("mode");
    if (mode) options.mode = mode;
    var seed = get("seed");
    if (seed !== null && seed.trim() !== "") {
      var trimmed = seed.trim();
      options.seed = /^-?\d+(\.\d+)?$/.test(trimmed) && isFinite(Number(trimmed)) ? Number(trimmed) : seed;
    }
    // A data address of only spaces is no address: the sample set, as for data=.
    var data = get("data");
    if (data !== null && data.trim() === "") data = null;
    return { data: data, options: options };
  }

  // ---------- the per-mode notes below the viewer ----------

  function showNotes(modeId) {
    var sections = doc.querySelectorAll(".explain[data-for]");
    var any = false;
    Array.prototype.forEach.call(sections, function (s) {
      if (s.getAttribute("data-for") === modeId) any = true;
    });
    Array.prototype.forEach.call(sections, function (s) {
      var id = s.getAttribute("data-for");
      // A mode the page has no note for (one a host registered) hides them all.
      s.hidden = any ? id !== modeId : true;
    });
  }

  function fill(name, text) {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-fill="' + name + '"]'), function (el) {
      el.textContent = text;
    });
  }

  function fillNotes(info, source) {
    var dimension = Number(info && info.dimension);
    var count = Number(info && info.count);
    if (dimension > 0) fill("dimension", thousands(dimension));
    if (count >= 1000) fill("lattice-count", "A thousand");
    else if (count > 1) fill("lattice-count", "All " + thousands(count));
    else fill("lattice-count", "In a larger set, a thousand");
    if (source.sample) {
      fill("ring", "The ring of months");
      fill("ring-lower", "the ring of months");
      doc.getElementById("note-sample").hidden = false;
    } else {
      var note = doc.getElementById("note-file");
      note.textContent =
        "The vectors in this view were loaded from " +
        source.name +
        ". The provenance block above says where they came from, which model made them, and what their producer states about them.";
      note.hidden = false;
    }
  }

  // ---------- mounting ----------

  function show(data, options, source) {
    var api = window.EmbeddingsTumbler;
    mark("tumbler-page-data-ready");
    if (wait.parentNode) wait.parentNode.removeChild(wait);
    var opts = {
      title: TITLE,
      provenanceOpen: false,
      onModeChange: showNotes,
    };
    if (options.mode) opts.mode = options.mode;
    if (options.seed !== undefined) opts.seed = options.seed;
    var handle = api.mount(space, opts);
    mark("tumbler-page-mount");
    var result = handle.update(data);
    showNotes(handle.mode());
    if (result && result.ok) {
      fillNotes(handle.info(), source);
      setState("ready");
    } else {
      // The viewer shows its own plain refusal over the stage.
      setState("refused");
    }
  }

  function showSample(options) {
    var api = window.EmbeddingsTumbler;
    if (!api.sample || typeof api.sample.generate !== "function") {
      fail(
        "The sample set is not available: sample-data.js is missing from this folder. " +
          "Copy it next to this page, or open the page with ?data= and the address of a data file."
      );
      return;
    }
    say("Generating the sample set…");
    // Let the loading line paint before the generator takes the main thread.
    window.requestAnimationFrame(function () {
      window.setTimeout(function () {
        var data;
        try {
          data = api.sample.generate();
        } catch (err) {
          fail("The sample set could not be generated.");
          return;
        }
        try {
          show(data, options, { sample: true, name: "the built-in sample set" });
        } catch (err) {
          fail("The page could not start the viewer.");
        }
      }, 0);
    });
  }

  function sameOrigin(url) {
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin;
  }

  function fileName(url) {
    var parts = url.pathname.split("/");
    var last = parts[parts.length - 1] || url.pathname;
    try {
      return decodeURIComponent(last);
    } catch (err) {
      return last;
    }
  }

  function showFile(address, options) {
    var page = window.location;
    if (page.protocol !== "http:" && page.protocol !== "https:") {
      fail(
        "This page reads data files over HTTP from its own folder. Serve the folder " +
          "(for example: embeddings-tumbler viewer serve <folder>) and open the page from there."
      );
      return;
    }
    var url;
    try {
      url = new URL(address, page.href);
    } catch (err) {
      fail('The data address "' + address + '" is not a valid address.');
      return;
    }
    if (!sameOrigin(url)) {
      fail(
        'Refused: the data address "' +
          address +
          '" points at another origin. This page loads data only from its own origin (' +
          page.origin +
          ")."
      );
      return;
    }
    var name = fileName(url);
    say("Loading " + name + "…");

    // Leaving the page (pagehide) abandons the load: the requests are aborted and
    // nothing that arrives later touches a page that has moved on. If the browser
    // brings the page back from its back-forward cache, the load starts again.
    var load = { abandoned: false, controller: null };
    try {
      load.controller = typeof AbortController === "function" ? new AbortController() : null;
    } catch (err) {
      load.controller = null;
    }
    var init = { credentials: "same-origin" };
    if (load.controller) init.signal = load.controller.signal;
    window.addEventListener("pagehide", function () {
      if (load.abandoned || load.done) return;
      load.abandoned = true;
      if (load.controller) load.controller.abort();
      window.addEventListener("pageshow", function again(ev) {
        if (!ev || !ev.persisted) return;
        if (typeof window.removeEventListener === "function") window.removeEventListener("pageshow", again);
        showFile(address, options);
      });
    });
    function live() {
      return !load.abandoned;
    }
    function tooLarge() {
      return new PageError(
        'The data file "' + name + '" is too large: this page reads records files of up to ' + MAX_RECORDS_TEXT + "."
      );
    }

    function blockFailed(file) {
      return new PageError('Vector file "' + file + '" could not be read.');
    }

    window
      .fetch(url.href, init)
      .then(
        function (res) {
          if (!live()) return null;
          if (res.url && !sameOrigin(new URL(res.url))) {
            throw new PageError('Refused: "' + name + '" was redirected to another origin.');
          }
          if (!res.ok) {
            throw new PageError(
              'The data file "' + name + '" could not be loaded: the server answered ' + res.status + "."
            );
          }
          var size = res.headers && typeof res.headers.get === "function" ? res.headers.get("content-length") : null;
          if (size !== null && Number(size) > MAX_RECORDS_BYTES) throw tooLarge();
          return res.text();
        },
        function () {
          throw new PageError('The data file "' + name + '" could not be loaded.');
        }
      )
      .then(function (text) {
        if (!live() || text === null) return null;
        if (text.length > MAX_RECORDS_BYTES) throw tooLarge();
        var records;
        try {
          records = JSON.parse(text);
        } catch (err) {
          throw new PageError('The data file "' + name + '" is not valid JSON.');
        }
        var v = records && typeof records === "object" ? records.vectors : null;
        var fileForm =
          records &&
          typeof records === "object" &&
          !Array.isArray(records) &&
          records.kind === KIND &&
          records.schema_version === SCHEMA_VERSION &&
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          typeof v.file === "string";
        if (!fileForm) {
          // Not a readable file-form set: the viewer refuses it with its own message.
          load.done = true;
          show(records, options, { sample: false, name: name });
          return null;
        }
        if (!PLAIN_FILE.test(v.file)) {
          throw new PageError(
            'Vector file "' + v.file + '" must be a plain file name in the same folder as the data file.'
          );
        }
        var blockUrl = new URL(v.file, url.href);
        return window
          .fetch(blockUrl.href, init)
          .then(
            function (res) {
              if (!live()) return null;
              if (!res.ok || (res.url && !sameOrigin(new URL(res.url)))) throw blockFailed(v.file);
              return res.arrayBuffer();
            },
            function () {
              throw blockFailed(v.file);
            }
          )
          .then(function (block) {
            if (!live() || block === null) return;
            load.done = true;
            // The descriptor stays, with the block beside it: the viewer checks the
            // file form's own fields (dtype, byte order, declared length) against it.
            var data = Object.assign({}, records, { vectors: Object.assign({}, v, { data: block }) });
            show(data, options, { sample: false, name: name });
          });
      })
      .catch(function (err) {
        if (!live()) return; // abandoned: the page has moved on
        load.done = true;
        fail(err && err.pageMessage ? err.pageMessage : 'The data file "' + name + '" could not be shown.');
      });
  }

  function start() {
    if (!space || !wait || !waitText) return;
    var api = window.EmbeddingsTumbler;
    if (!api || typeof api.mount !== "function") {
      fail("The viewer is not available: embeddings-tumbler.js is missing from this folder.");
      return;
    }
    var query = readQuery();
    try {
      if (query.data) showFile(query.data, query.options);
      else showSample(query.options);
    } catch (err) {
      fail("The page could not start the viewer.");
    }
  }

  start();
})();
