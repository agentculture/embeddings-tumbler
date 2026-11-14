// Test-only data helper for the harness fixture pages (tests/browser/fixtures/). NOT shipped.
//
// window.__fixtureData.arrivals(base, k, seed) builds an append in the contract's in-memory
// form: k points in a tight cluster at the origin of the space (the mean of the twin-blobs set
// the harness writes, whose two blobs sit at +3 and -3 along the first axis, so the origin is
// empty space between them in every linear view), all in one new group, "arrivals". The base
// set has no groups, so its points take the ungrouped colour and the arrivals take the first
// group colour: the new points can be told apart in a screenshot by colour as well as by place.
(function () {
  "use strict";
  // The state is kept as an unsigned 32-bit number (>>> 0): the same 32 bits as the usual
  // signed form, so every draw is identical; the shifts, xors and Math.imul below only ever
  // read those 32 bits.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function arrivals(base, k, seed) {
    const d = base.dimension;
    const rnd = mulberry32(seed || 14);
    const v = new Float32Array(k * d);
    const points = [];
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < Math.min(d, 6); j++) v[i * d + j] = (rnd() - 0.5) * 0.12;
      points.push({ id: "arrival-" + i, label: "", group: "arrivals" });
    }
    return {
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      op: "append",
      model: base.model,
      dimension: d,
      count: k,
      text_included: false,
      points,
      vectors: v,
    };
  }
  window.__fixtureData = { arrivals };
})();
