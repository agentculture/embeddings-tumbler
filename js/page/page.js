// The standalone page of embeddings-tumbler: a shell around ONE viewer.
//
//   index.html                      the Wikipedia set shipped beside the page
//                                   (demo-wikipedia.json and its .f32 block)
//   index.html?sample=synthetic     the built-in synthetic sample set
//   index.html?data=sets/a.json     a data file from this page's own origin
//   ...&mode=lattice&seed=7         optional starting mode and view seed
//
// With no address the page loads the Wikipedia set from its own folder. When that
// set cannot be read (a file: page, a host that copied only some files) or the
// viewer refuses it, the page shows the synthetic sample set instead and says so.
// A link under the notes switches between the two.
//
// This script holds no rendering or projection logic. It calls only
// EmbeddingsTumbler.mount and the handle's update (and sample.generate for the
// sample set). It fetches a data file and its sibling .f32 block itself, same
// origin only, and hands the in-memory form to update, which validates it and
// shows any refusal inside the viewer. The page's own messages use textContent.
//
// Search: the page asks its OWN origin whether the helper route is there
// (POST /_tumbler/search {"op":"describe"}, from `viewer serve --embed`). If it
// answers, the viewer is mounted with embed (and rerank) callbacks that post to
// that same route; otherwise with none, and search matches the loaded points.
// The route's address is fixed here: no query parameter and no data file field
// can change it.
(function () {
  "use strict";

  const KIND = "embeddings-tumbler/data";
  const SCHEMA_VERSION = 1; // the version this page's copy of the core reads
  const PLAIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const TITLE = "Embedding Tumbler";
  // The default set: a data file pair shipped beside this page (scripts/build_demo_set.py).
  const DEMO_FILE = "demo-wikipedia.json";
  const SYNTHETIC = "synthetic"; // ?sample=synthetic chooses the generated set
  const ABANDONED = Symbol("abandoned"); // what a load returns when the page moved on
  // The largest records file (the .json) the page reads, judged by its
  // Content-Length before the body is read, and by its length after reading
  // when the server sends none. The binary .f32 block is not limited here.
  const MAX_RECORDS_BYTES = 64 * 1024 * 1024;
  const MAX_RECORDS_TEXT = "64 MB";
  // The helper route: a fixed path on the page's own origin, never configurable.
  const ROUTE = "/_tumbler/search";
  const PROBE_MS = 2500; // how long the describe request may take
  const DEFAULT_CANDIDATE_CHARS = 4000;
  // What the page says for each refusal code of the route. The server's own text is
  // never shown: these are the page's words.
  const ROUTE_MESSAGES = {
    "rate-limited": "The search helper is busy: too many searches in the last minute.",
    "text-too-long": "The search text is too long for the search helper.",
    "too-many-candidates": "Too many candidates were sent to the reranker.",
    "gateway-timeout": "The embedding service did not answer in time.",
    "gateway-failed": "The embedding service did not answer.",
    "rerank-unavailable": "The search helper does not offer reranking.",
  };
  const ROUTE_UNREACHABLE = "The search helper could not be reached.";
  const ROUTE_REFUSED = "The search helper refused the request.";

  const doc = document;
  const body = doc.body;
  let helperReady = Promise.resolve({}); // the helper's callbacks, set in start()
  const space = doc.getElementById("space");
  const wait = doc.getElementById("wait");
  const waitText = doc.getElementById("wait-text");

  function setState(state) {
    body.dataset.pageState = state;
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

  // The loading line (an <output>, a polite status) becomes an alert for a failure.
  function fail(message) {
    if (wait.parentNode !== space) space.appendChild(wait);
    waitText.setAttribute("role", "alert");
    say(message);
    setState("error");
  }

  function PageError(message) {
    this.pageMessage = message;
  }

  function tooLarge(name) {
    return new PageError(
      'The data file "' + name + '" is too large: this page reads records files of up to ' + MAX_RECORDS_TEXT + "."
    );
  }

  function blockFailed(file) {
    return new PageError('Vector file "' + file + '" could not be read.');
  }

  function thousands(n) {
    return Number(n).toLocaleString("en-US");
  }

  function readQuery() {
    let params = null;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (err) {
      params = null;
    }
    function get(key) {
      return params ? params.get(key) : null;
    }
    const options = {};
    const mode = get("mode");
    if (mode) options.mode = mode;
    const seed = get("seed");
    if (seed !== null && seed.trim() !== "") {
      const trimmed = seed.trim();
      options.seed = /^-?\d+(\.\d+)?$/.test(trimmed) && Number.isFinite(Number(trimmed)) ? Number(trimmed) : seed;
    }
    // A data address of only spaces is no address: the sample set, as for data=.
    let data = get("data");
    if (data !== null && data.trim() === "") data = null;
    const sample = get("sample");
    return { data: data, options: options, synthetic: sample !== null && sample.trim() === SYNTHETIC };
  }

  // ---------- the per-mode notes below the viewer ----------

  function showNotes(modeId) {
    const sections = Array.from(doc.querySelectorAll(".explain[data-for]"));
    const any = sections.some((s) => s.dataset.for === modeId);
    for (const s of sections) {
      // A mode the page has no note for (one a host registered) hides them all.
      s.hidden = any ? s.dataset.for !== modeId : true;
    }
  }

  function fill(name, text) {
    for (const el of doc.querySelectorAll('[data-fill="' + name + '"]')) el.textContent = text;
  }

  function fillNotes(info, source) {
    const dimension = Number(info?.dimension);
    const count = Number(info?.count);
    if (dimension > 0) fill("dimension", thousands(dimension));
    if (count >= 1000) fill("lattice-count", "A thousand");
    else if (count > 1) fill("lattice-count", "All " + thousands(count));
    else fill("lattice-count", "In a larger set, a thousand");
    if (source.kind === "sample") {
      fill("ring", "The ring of months");
      fill("ring-lower", "the ring of months");
      doc.getElementById("note-sample").hidden = false;
    } else if (source.kind === "demo") {
      if (source.synthetic) fill("demo-kind", "These vectors are a stand-in (a hash of each text, not a model's output)");
      fill("demo-count", count > 0 ? thousands(count) : "no");
      if (typeof info?.model === "string" && info.model) fill("demo-model", info.model);
      reveal("note-demo");
    } else {
      const note = doc.getElementById("note-file");
      note.textContent =
        "The vectors in this view were loaded from " +
        source.name +
        ". The provenance block above says where they came from, which model made them, and what their producer states about them.";
      note.hidden = false;
    }
  }

  function reveal(id) {
    const node = doc.getElementById(id);
    if (node) node.hidden = false;
  }

  // The address of this page showing the other set: ?sample=synthetic added, or taken
  // away. The mode and the seed are kept; a data address is dropped.
  function switchAddress(synthetic) {
    let params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (err) {
      params = new URLSearchParams();
    }
    params.delete("data");
    if (synthetic) params.set("sample", SYNTHETIC);
    else params.delete("sample");
    const query = params.toString();
    return query ? "?" + query : window.location.pathname;
  }

  // The line under the notes that says which set is shown and links to the other one.
  function showSwitch(source) {
    const text = doc.getElementById("set-switch-text");
    const link = doc.getElementById("set-switch-link");
    if (!text || !link || source.kind === "file") return;
    if (source.kind === "demo") {
      text.textContent = "";
      link.textContent = "Show the synthetic sample set instead";
      link.href = switchAddress(true);
    } else if (source.why) {
      text.textContent = "Showing the synthetic sample set: " + source.why + ".";
      link.hidden = true;
    } else {
      text.textContent = "Showing the synthetic sample set.";
      link.textContent = "Show the Wikipedia set instead";
      link.href = switchAddress(false);
    }
    reveal("set-switch");
  }

  // ---------- the helper route (search by embedding) ----------

  // The route's address, built from this page's own location. It is the same on every
  // page load and nothing the query string or a data file says reaches it.
  function routeAddress() {
    const url = new URL(ROUTE, window.location.href);
    return sameOrigin(url) ? url.href : null;
  }

  function refusalText(answer) {
    const code = answer && typeof answer === "object" ? answer.code : null;
    return (typeof code === "string" && Object.hasOwn(ROUTE_MESSAGES, code) && ROUTE_MESSAGES[code]) || ROUTE_REFUSED;
  }

  // One request to the route. Resolves with the answer object, or throws an Error whose
  // message is plain text of the page's own (never the server's text).
  async function callRoute(address, payload, signal) {
    let res;
    try {
      res = await window.fetch(address, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: signal,
      });
    } catch (err) {
      throw new Error(ROUTE_UNREACHABLE);
    }
    let answer = null;
    try {
      answer = await res.json();
    } catch (err) {
      answer = null;
    }
    if (!res.ok || !answer || answer.ok !== true) throw new Error(refusalText(answer));
    return answer;
  }

  function limitOf(described, name, fallback) {
    const value = Number(described.limits?.[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  function helperCallbacks(address, described) {
    const maxChars = limitOf(described, "maxCandidateChars", DEFAULT_CANDIDATE_CHARS);
    const callbacks = {
      embed: async function (text) {
        const answer = await callRoute(address, { op: "embed", text: text });
        return { vector: answer.vector, model: answer.model, queryForm: answer.query_form };
      },
    };
    if (described.rerank && typeof described.rerank === "object") {
      callbacks.rerank = async function (query, candidates) {
        const cut = candidates.map((c) => String(c).slice(0, maxChars));
        const answer = await callRoute(address, { op: "rerank", query: query, candidates: cut });
        return { scores: answer.scores, model: answer.model };
      };
    }
    return callbacks;
  }

  // Ask the page's own origin for the helper. Always resolves: with the callbacks when
  // the route answers `describe`, and with {} for anything else (a static server's
  // 404 or 501, a network error, an answer that is not JSON, no answer in time). One
  // request, no retry.
  async function findHelper() {
    const page = window.location;
    if (page.protocol !== "http:" && page.protocol !== "https:") return {};
    const address = routeAddress();
    if (!address) return {};
    let controller = null;
    try {
      controller = new AbortController();
    } catch (err) {
      controller = null;
    }
    const timer = window.setTimeout(() => controller?.abort(), PROBE_MS);
    try {
      const described = await callRoute(address, { op: "describe" }, controller?.signal);
      if (typeof described.embed?.model !== "string" || described.embed.model === "") return {};
      return helperCallbacks(address, described);
    } catch (err) {
      return {};
    } finally {
      window.clearTimeout(timer);
    }
  }

  // ---------- mounting ----------

  async function show(data, options, source) {
    const api = window.EmbeddingsTumbler;
    mark("tumbler-page-data-ready");
    const callbacks = await helperReady;
    wait.remove();
    const opts = {
      title: TITLE,
      provenanceOpen: false,
      onModeChange: showNotes,
    };
    if (options.mode) opts.mode = options.mode;
    if (options.seed !== undefined) opts.seed = options.seed;
    if (callbacks.embed) opts.embed = callbacks.embed;
    if (callbacks.rerank) opts.rerank = callbacks.rerank;
    const handle = api.mount(space, opts);
    mark("tumbler-page-mount");
    let result = handle.update(data);
    let shown = source;
    if (!result?.ok && source.kind === "demo") {
      // The default set was refused (a damaged or older copy): the synthetic set instead.
      const sample = generateSample(api);
      if (sample) {
        result = handle.update(sample);
        shown = sampleSource("the viewer refused the Wikipedia set (" + DEMO_FILE + ")");
      }
    }
    showNotes(handle.mode());
    if (result?.ok) {
      fillNotes(handle.info(), shown);
      showSwitch(shown);
      setState("ready");
    } else {
      // The viewer shows its own plain refusal over the stage.
      setState("refused");
    }
  }

  function sampleSource(why) {
    return { kind: "sample", name: "the built-in sample set", why: why || null };
  }

  // The synthetic set, or null when sample-data.js is missing or the generator fails.
  function generateSample(api) {
    if (typeof api.sample?.generate !== "function") return null;
    try {
      return api.sample.generate();
    } catch (err) {
      return null;
    }
  }

  function showSample(options, why) {
    const api = window.EmbeddingsTumbler;
    if (typeof api.sample?.generate !== "function") {
      fail(
        (why ? "Nothing can be shown: " + why + ", and the" : "The") +
          " sample set is not available: sample-data.js is missing from this folder. " +
          "Copy it next to this page, or open the page with ?data= and the address of a data file."
      );
      return;
    }
    say("Generating the sample set…");
    // Let the loading line paint before the generator takes the main thread.
    window.requestAnimationFrame(function () {
      window.setTimeout(function () {
        let data;
        try {
          data = api.sample.generate();
        } catch (err) {
          fail("The sample set could not be generated.");
          return;
        }
        show(data, options, sampleSource(why)).catch(function () {
          fail("The page could not start the viewer.");
        });
      }, 0);
    });
  }

  function sameOrigin(url) {
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === window.location.origin;
  }

  function fileName(url) {
    const parts = url.pathname.split("/");
    const last = parts.at(-1) || url.pathname;
    try {
      return decodeURIComponent(last);
    } catch (err) {
      return last;
    }
  }

  // A readable file-form set: the records name their vectors file, which the page fetches.
  function isFileForm(records, v) {
    return (
      !!records &&
      typeof records === "object" &&
      !Array.isArray(records) &&
      records.kind === KIND &&
      records.schema_version === SCHEMA_VERSION &&
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof v.file === "string"
    );
  }

  // The records file's text, or null when the load was abandoned meanwhile.
  async function fetchRecords(url, name, init, live) {
    let res;
    try {
      res = await window.fetch(url.href, init);
    } catch (err) {
      throw new PageError('The data file "' + name + '" could not be loaded.');
    }
    if (!live()) return null;
    if (res.url && !sameOrigin(new URL(res.url))) {
      throw new PageError('Refused: "' + name + '" was redirected to another origin.');
    }
    if (!res.ok) {
      throw new PageError('The data file "' + name + '" could not be loaded: the server answered ' + res.status + ".");
    }
    const size = typeof res.headers?.get === "function" ? res.headers.get("content-length") : null;
    if (size !== null && Number(size) > MAX_RECORDS_BYTES) throw tooLarge(name);
    return res.text();
  }

  // The vectors block, or null when the load was abandoned meanwhile.
  async function fetchBlock(blockUrl, file, init, live) {
    let res;
    try {
      res = await window.fetch(blockUrl.href, init);
    } catch (err) {
      throw blockFailed(file);
    }
    if (!live()) return null;
    if (!res.ok || (res.url && !sameOrigin(new URL(res.url)))) throw blockFailed(file);
    return res.arrayBuffer();
  }

  // The set a records file holds, ready for update: for the file form, with the fetched
  // block beside its descriptor. ABANDONED when the load was abandoned meanwhile.
  async function readSet(url, name, init, live) {
    const text = await fetchRecords(url, name, init, live);
    if (!live() || text === null) return ABANDONED;
    if (text.length > MAX_RECORDS_BYTES) throw tooLarge(name);
    let records;
    try {
      records = JSON.parse(text);
    } catch (err) {
      throw new PageError('The data file "' + name + '" is not valid JSON.');
    }
    const v = records && typeof records === "object" ? records.vectors : null;
    // Not a readable file-form set: the viewer refuses it with its own message.
    if (!isFileForm(records, v)) return records;
    if (!PLAIN_FILE.test(v.file)) {
      throw new PageError('Vector file "' + v.file + '" must be a plain file name in the same folder as the data file.');
    }
    const block = await fetchBlock(new URL(v.file, url.href), v.file, init, live);
    if (!live() || block === null) return ABANDONED;
    // The descriptor stays, with the block beside it: the viewer checks the
    // file form's own fields (dtype, byte order, declared length) against it.
    return { ...records, vectors: { ...v, data: block } };
  }

  // Fetch the records file and, for the file form, its sibling block, then show them.
  async function loadFile(url, name, init, load, options) {
    const data = await readSet(url, name, init, () => !load.abandoned);
    if (data === ABANDONED) return;
    load.done = true;
    await show(data, options, { kind: "file", name: name });
  }

  // The default: the Wikipedia set beside this page, or the synthetic set when it
  // cannot be read here.
  function showDefault(options) {
    const page = window.location;
    if (page.protocol !== "http:" && page.protocol !== "https:") {
      showSample(options, "a page opened as a file cannot read the Wikipedia set beside it");
      return;
    }
    say("Loading the Wikipedia set…");
    const url = new URL(DEMO_FILE, page.href);
    readSet(url, DEMO_FILE, { credentials: "same-origin" }, () => true)
      .then(
        (data) => show(data, options, { kind: "demo", name: DEMO_FILE, synthetic: data?.provenance?.synthetic === true }),
        () => showSample(options, "the Wikipedia set (" + DEMO_FILE + ") could not be read from this folder")
      )
      .catch(function () {
        fail("The page could not start the viewer.");
      });
  }

  function showFile(address, options) {
    const page = window.location;
    if (page.protocol !== "http:" && page.protocol !== "https:") {
      fail(
        "This page reads data files over HTTP from its own folder. Serve the folder " +
          "(for example: embeddings-tumbler viewer serve <folder>) and open the page from there."
      );
      return;
    }
    let url;
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
    const name = fileName(url);
    say("Loading " + name + "…");

    // Leaving the page (pagehide) abandons the load: the requests are aborted and
    // nothing that arrives later touches a page that has moved on. If the browser
    // brings the page back from its back-forward cache, the load starts again.
    const load = { abandoned: false, controller: null };
    try {
      load.controller = typeof AbortController === "function" ? new AbortController() : null;
    } catch (err) {
      load.controller = null;
    }
    const init = { credentials: "same-origin" };
    if (load.controller) init.signal = load.controller.signal;
    window.addEventListener("pagehide", function () {
      if (load.abandoned || load.done) return;
      load.abandoned = true;
      load.controller?.abort();
      window.addEventListener("pageshow", function again(ev) {
        if (!ev?.persisted) return;
        if (typeof window.removeEventListener === "function") window.removeEventListener("pageshow", again);
        showFile(address, options);
      });
    });

    // Every failure ends here and is shown as a plain message (unless the page has moved on).
    loadFile(url, name, init, load, options).catch(function (err) {
      if (load.abandoned) return; // abandoned: the page has moved on
      load.done = true;
      fail(err?.pageMessage || 'The data file "' + name + '" could not be shown.');
    });
  }

  function start() {
    if (!space || !wait || !waitText) return;
    const api = window.EmbeddingsTumbler;
    if (typeof api?.mount !== "function") {
      fail("The viewer is not available: embeddings-tumbler.js is missing from this folder.");
      return;
    }
    const query = readQuery();
    helperReady = findHelper();
    try {
      if (query.data) showFile(query.data, query.options);
      else if (query.synthetic) showSample(query.options);
      else showDefault(query.options);
    } catch (err) {
      fail("The page could not start the viewer.");
    }
  }

  start();
})();
