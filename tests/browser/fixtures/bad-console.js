// Negative control (deliberately bad): one console.error and one uncaught error.
(function () {
  "use strict";
  console.error("planted console error");
  setTimeout(function () {
    window.__badDone = true;
    throw new Error("planted uncaught error");
  }, 0);
})();
