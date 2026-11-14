// Page script for tests/browser/test_web_component.py (task t10). It only watches: it
// records the element's bubbling events and every Content-Security-Policy violation, counts
// animation-frame requests, and offers a pixel counter. It never touches the viewer; the
// page under test is just the <embeddings-tumbler> element in the markup.
(function () {
  "use strict";
  var state = { events: [], violations: [], frameRequests: 0 };
  window.__wc = state;
  var raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    state.frameRequests++;
    return raf(cb);
  };
  document.addEventListener("securitypolicyviolation", function (e) {
    state.violations.push(e.violatedDirective + " " + (e.blockedURI || ""));
  });
  ["tumbler-load", "tumbler-error"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      state.events.push({ type: type, detail: e.detail, target: e.target && e.target.id });
    });
  });
  // The most lit pixels seen on the element's canvas over the next n animation frames
  // (read right after the viewer draws, before the frame is shown).
  window.__litMax = function (el, n) {
    return new Promise(function (resolve) {
      var best = -1;
      (function step(left) {
        var c = el.querySelector(".tumbler-canvas");
        var gl = c && c.getContext("webgl2");
        if (gl) {
          var w = gl.drawingBufferWidth;
          var h = gl.drawingBufferHeight;
          var px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          var lit = 0;
          for (var i = 0; i < px.length; i += 4) {
            if (px[i] > 40 || px[i + 1] > 40 || px[i + 2] > 40) lit++;
          }
          if (lit > best) best = lit;
        }
        if (left > 0) raf(function () { step(left - 1); });
        else resolve(best);
      })(n);
    });
  };
})();
