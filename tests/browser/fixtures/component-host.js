// Canonical host fixture 2: the web-component form. The page under test is the
// <embeddings-tumbler> element in the markup; this script only watches (it records the
// element's bubbling events) and offers the add/remove cycles. It runs before web-component.js
// defines the element. ?manual=1 takes the element out of the page before it is defined, so
// nothing mounts until a test adds an element. State on window.__wc.
(function () {
  "use strict";
  const H = window.__harness;
  const q = new URLSearchParams(location.search);
  const wc = (window.__wc = { events: [], cycled: [] });
  ["tumbler-load", "tumbler-error"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      wc.events.push({ type: type, detail: e.detail, target: e.target?.id });
    });
  });
  if (q.get("manual") === "1") {
    const first = document.getElementById("wc");
    if (first) first.remove();
  }

  // Resolves when el reports its first tumbler-load or tumbler-error.
  function settled(el) {
    return new Promise(function (resolve) {
      function settle() {
        el.removeEventListener("tumbler-load", settle);
        el.removeEventListener("tumbler-error", settle);
        resolve();
      }
      el.addEventListener("tumbler-load", settle);
      el.addEventListener("tumbler-error", settle);
    });
  }

  // One add/remove cycle of a fresh element, then the next, until run.n are done.
  function cycleFrom(run) {
    if (run.i++ >= run.n) return Promise.resolve({ peakGl: run.peak });
    const el = document.createElement("embeddings-tumbler");
    el.id = "cycle-" + wc.cycled.length;
    el.setAttribute("src", run.src || "twin-blobs.json");
    el.setAttribute("seed", String(run.i));
    wc.cycled.push(el);
    const done = settled(el);
    document.body.appendChild(el);
    if (!run.wait) {
      el.remove();
      return Promise.resolve().then(function () {
        return cycleFrom(run);
      });
    }
    return done
      .then(function () {
        return H.frames(3);
      })
      .then(function () {
        run.peak = Math.max(run.peak, H.snapshot().glLive);
        el.remove();
        return cycleFrom(run);
      });
  }

  // n add/remove cycles of a fresh element. wait=true: add, wait for its tumbler-load (or
  // tumbler-error) and a drawn frame, remove. wait=false: add and remove in the same task, so
  // the element's fetch is still in flight when it goes (the shell must drop it).
  wc.cycles = function (n, wait, src) {
    return cycleFrom({ n, wait, src, i: 0, peak: 0 });
  };
})();
