// Canonical host fixture 1: the script form. A plain host script that does what
// js/api/50-viewer.md tells a host to do: mount, fetch its own data file and its vector block,
// update. The data file is twin-blobs.json and its block twin-blobs.f32, which the harness
// writes beside the page; both addresses are fixed here, and a data file naming any other
// block is refused rather than followed, so nothing read from the query string or from a
// fetched file is put in a request. Query: ?seed=<n> (default 5), ?manual=1 (load the page
// but mount nothing, for the mount/destroy cycles). State on window.__host.
(function () {
  "use strict";
  const DATA_FILE = "twin-blobs.json";
  const BLOCK_FILE = "twin-blobs.f32";
  const q = new URLSearchParams(location.search);
  const T = window.EmbeddingsTumbler;
  const H = window.__harness;
  const el = document.getElementById("space");
  const seed = Number(q.get("seed") || "5");
  const host = (window.__host = { state: "idle", result: null, error: null, cycled: [] });
  let cached = null;

  async function load() {
    if (cached) return cached;
    const r = await fetch(DATA_FILE);
    if (!r.ok) throw new Error(DATA_FILE + ": " + r.status);
    const meta = await r.json();
    if (meta.vectors.file !== BLOCK_FILE) throw new Error(DATA_FILE + " names a block other than " + BLOCK_FILE);
    const rb = await fetch(BLOCK_FILE);
    if (!rb.ok) throw new Error(BLOCK_FILE + ": " + rb.status);
    const block = await rb.arrayBuffer();
    cached = { ...meta, vectors: block };
    return cached;
  }
  host.load = load;

  function info(target) {
    const h = T.get(target || el);
    return h ? h.info() : null;
  }
  host.info = info;

  // Resolves one frame after the viewer has drawn its first frame of data, or after
  // `left` polls 20 ms apart.
  function firstDrawn(h, left) {
    const s = h.info();
    if ((s.frames > 0 && s.ready) || left <= 0) return H.frames(1);
    return H.sleep(20).then(function () {
      return firstDrawn(h, left - 1);
    });
  }

  // One mount/destroy cycle, then the next, until run.n are done.
  function cycleFrom(run) {
    if (run.i++ >= run.n) return Promise.resolve({ peakGl: run.peak });
    let target = el;
    if (run.kind === "fresh") {
      target = document.createElement("div");
      target.className = "space";
      document.body.appendChild(target);
      host.cycled.push(target);
    }
    const h = T.mount(target, { seed: seed + run.i });
    if (run.data) h.update(run.data);
    const wait = run.kind === "empty" ? H.frames(2) : firstDrawn(h, 100);
    return wait.then(function () {
      run.peak = Math.max(run.peak, H.snapshot().glLive);
      T.destroy(target);
      if (run.kind === "fresh") target.remove();
      return cycleFrom(run);
    });
  }

  // n mount/destroy cycles. kind: "empty" (mount, two frames, destroy), "data" (mount, update,
  // wait for the first drawn frame, destroy) or "fresh" (as "data" on a new element each
  // time, removed afterwards). Returns the most WebGL contexts seen live at once.
  host.cycles = async function (n, kind) {
    const data = kind === "empty" ? null : await load();
    return cycleFrom({ n, kind, data, i: 0, peak: 0 });
  };

  if (q.get("manual") === "1") return;
  host.state = "loading";
  T.mount(el, { seed: seed });
  load()
    .then(function (data) {
      host.result = T.update(el, data);
      host.state = host.result.ok ? "ready" : "refused";
    })
    .catch(function (err) {
      host.error = String(err);
      host.state = "error";
    });
})();
