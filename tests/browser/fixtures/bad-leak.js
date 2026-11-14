// Negative control (deliberately bad): window.__bad.leak() takes one of everything the
// harness's leak counters count and never gives it back.
(function () {
  "use strict";
  window.__bad = {
    leak: function () {
      const t = document.getElementById("target");
      (function loop() {
        requestAnimationFrame(loop);
      })();
      setTimeout(function () {
        // never runs in time: a timer left pending
      }, 600000);
      setInterval(function () {
        // never cleared: an interval left running
      }, 600000);
      new IntersectionObserver(function () {
        // never disconnected
      }).observe(t);
      new ResizeObserver(function () {
        // never disconnected
      }).observe(t);
      new MutationObserver(function () {
        // never disconnected
      }).observe(t, { childList: true });
      const c = document.createElement("canvas");
      c.getContext("webgl2");
      document.body.appendChild(c);
      window.addEventListener("resize", function () {
        // never removed
      });
      return true;
    },
  };
})();
