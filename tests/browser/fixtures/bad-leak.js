// Negative control (deliberately bad): window.__bad.leak() takes one of everything the
// harness's leak counters count and never gives it back.
(function () {
  "use strict";
  window.__bad = {
    leak: function () {
      var t = document.getElementById("target");
      (function loop() { requestAnimationFrame(loop); })();
      setTimeout(function () {}, 600000);
      setInterval(function () {}, 600000);
      new IntersectionObserver(function () {}).observe(t);
      new ResizeObserver(function () {}).observe(t);
      new MutationObserver(function () {}).observe(t, { childList: true });
      var c = document.createElement("canvas");
      c.getContext("webgl2");
      document.body.appendChild(c);
      window.addEventListener("resize", function () {});
      return true;
    },
  };
})();
