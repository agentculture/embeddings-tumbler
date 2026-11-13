/*! embeddings-tumbler 0.10.1 | source: github.com/agentculture/embeddings-tumbler | assembled from js/src by scripts/assemble.py, do not edit by hand */
(function (root) {
  "use strict";

  // Shared internal namespace. Every later module adds its functions here
  // (ET.math = {...}, ET.contract = {...}) and reads earlier modules' from it.
  var ET = {};
  ET.version = "0.10.1";
  // The public API object. Only 50-viewer.js fills this (mount, update, destroy).
  ET.api = {};

  // Export. Public API only; ET is reachable as api._internal for tests.
  var api = ET.api;
  api.version = ET.version;
  Object.defineProperty(api, "_internal", { value: ET, enumerable: false });

  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api; // node (tests)
  } else {
    root.EmbeddingsTumbler = api; // classic script tag: one global
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
