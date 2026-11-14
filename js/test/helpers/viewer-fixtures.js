"use strict";
// Data sets in the contract's in-memory form for the viewer tests.

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// n points in d dimensions, in `groups` clusters; every `labelEvery`-th point labelled.
function makeSet(opts) {
  const o = Object.assign(
    {
      n: 120,
      d: 16,
      groups: ["alpha", "beta", "gamma"],
      labelEvery: 3,
      seed: 7,
      model: "test/model",
      idPrefix: "p",
      op: undefined,
      provenance: undefined,
      reduction: undefined,
      text_included: true,
      labelFor: null,
      groupFor: null,
    },
    opts || {}
  );
  const r = rng(o.seed);
  const centres = o.groups.map(() => Array.from({ length: o.d }, () => r() * 2 - 1));
  const vectors = new Float32Array(o.n * o.d);
  const points = [];
  for (let i = 0; i < o.n; i++) {
    const g = o.groups.length ? i % o.groups.length : -1;
    for (let k = 0; k < o.d; k++) {
      vectors[i * o.d + k] = (g >= 0 ? centres[g][k] : 0) + (r() - 0.5) * 0.3;
    }
    const id = o.idPrefix + String(i).padStart(5, "0");
    const label = o.labelFor ? o.labelFor(i, id) : i % o.labelEvery === 0 ? "word" + i : "";
    const group = o.groupFor ? o.groupFor(i) : g >= 0 ? o.groups[g] : "";
    points.push({ id, label, group });
  }
  const data = {
    schema_version: 1,
    kind: "embeddings-tumbler/data",
    model: o.model,
    dimension: o.d,
    count: o.n,
    text_included: o.text_included,
    points,
    vectors,
  };
  if (o.op) data.op = o.op;
  if (o.op !== "append" || o.provenance) {
    data.provenance = o.provenance || {
      source: "test: generated clusters",
      producer: "viewer tests 1.0",
      synthetic: true,
      seed: 42,
      limitations: ["made up for a unit test"],
      uncertain: ["whether clusters mean anything"],
    };
  }
  if (o.reduction) data.reduction = o.reduction;
  return data;
}

module.exports = { makeSet, rng };
