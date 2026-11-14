// Canonical host fixture 2: the web-component form. The page under test is the
// <embeddings-tumbler> element in the markup; this script only watches (it records the
// element's bubbling events) and offers the add/remove cycles. It runs before web-component.js
// defines the element. ?manual=1 takes the element out of the page before it is defined, so
// nothing mounts until a test adds an element. State on window.__wc.
(function () {
  "use strict";
  var H = window.__harness;
  var q = new URLSearchParams(location.search);
  var wc = (window.__wc = { events: [], cycled: [] });
  ["tumbler-load", "tumbler-error"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      wc.events.push({ type: type, detail: e.detail, target: e.target && e.target.id });
    });
  });
  if (q.get("manual") === "1") {
    var first = document.getElementById("wc");
    if (first) first.remove();
  }

  // n add/remove cycles of a fresh element. wait=true: add, wait for its tumbler-load (or
  // tumbler-error) and a drawn frame, remove. wait=false: add and remove in the same task, so
  // the element's fetch is still in flight when it goes (the shell must drop it).
  wc.cycles = function (n, wait, src) {
    var peak = 0;
    var i = 0;
    function one() {
      if (i++ >= n) return Promise.resolve({ peakGl: peak });
      var el = document.createElement("embeddings-tumbler");
      el.id = "cycle-" + wc.cycled.length;
      el.setAttribute("src", src || "twin-blobs.json");
      el.setAttribute("seed", String(i));
      wc.cycled.push(el);
      var done = new Promise(function (resolve) {
        function settle() {
          el.removeEventListener("tumbler-load", settle);
          el.removeEventListener("tumbler-error", settle);
          resolve();
        }
        el.addEventListener("tumbler-load", settle);
        el.addEventListener("tumbler-error", settle);
      });
      document.body.appendChild(el);
      if (!wait) {
        el.remove();
        return Promise.resolve().then(one);
      }
      return done
        .then(function () { return H.frames(3); })
        .then(function () {
          peak = Math.max(peak, H.snapshot().glLive);
          el.remove();
          return one();
        });
    }
    return one();
  };
})();
