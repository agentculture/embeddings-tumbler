// Canonical host fixture 1: the script form. A plain host script that does what
// js/api/50-viewer.md tells a host to do: mount, fetch its own data file and its vector block,
// update. Query: ?data=<file> (default twin-blobs.json), ?seed=<n> (default 5), ?manual=1 (load
// the page but mount nothing, for the mount/destroy cycles). State on window.__host.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var T = window.EmbeddingsTumbler;
  var H = window.__harness;
  var el = document.getElementById("space");
  var file = q.get("data") || "twin-blobs.json";
  var seed = Number(q.get("seed") || "5");
  var host = (window.__host = { state: "idle", result: null, error: null, cycled: [] });
  var cached = null;

  function load() {
    if (cached) return Promise.resolve(cached);
    return fetch(file)
      .then(function (r) {
        if (!r.ok) throw new Error(file + ": " + r.status);
        return r.json();
      })
      .then(function (meta) {
        return fetch(meta.vectors.file)
          .then(function (r) {
            if (!r.ok) throw new Error(meta.vectors.file + ": " + r.status);
            return r.arrayBuffer();
          })
          .then(function (block) {
            cached = Object.assign({}, meta, { vectors: block });
            return cached;
          });
      });
  }
  host.load = load;

  function info(target) {
    var h = T.get(target || el);
    return h ? h.info() : null;
  }
  host.info = info;

  // n mount/destroy cycles. kind: "empty" (mount, two frames, destroy), "data" (mount, update,
  // wait for the first drawn frame, destroy) or "fresh" (as "data" on a new element each
  // time, removed afterwards). Returns the most WebGL contexts seen live at once.
  host.cycles = function (n, kind) {
    var peak = 0;
    var chain = kind === "empty" ? Promise.resolve(null) : load();
    return chain.then(function (data) {
      var i = 0;
      function one() {
        if (i++ >= n) return Promise.resolve({ peakGl: peak });
        var target = el;
        if (kind === "fresh") {
          target = document.createElement("div");
          target.className = "space";
          document.body.appendChild(target);
          host.cycled.push(target);
        }
        var h = T.mount(target, { seed: seed + i });
        if (data) h.update(data);
        var wait =
          kind === "empty"
            ? H.frames(2)
            : (function poll(left) {
                var s = h.info();
                if ((s.frames > 0 && s.ready) || left <= 0) return H.frames(1);
                return H.sleep(20).then(function () { return poll(left - 1); });
              })(100);
        return wait.then(function () {
          peak = Math.max(peak, H.snapshot().glLive);
          T.destroy(target);
          if (kind === "fresh") target.remove();
          return one();
        });
      }
      return one();
    });
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
