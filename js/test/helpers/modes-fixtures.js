"use strict";
// Shared fixtures for the mode tests (js/test/modes*.test.js).
const path = require("node:path");
const { loadSources, ROOT } = require("./load.js");

const sample = require(path.join(ROOT, "js", "sample", "sample-data.js"));

// A fresh ET namespace with every source module loaded.
function freshET() {
  return loadSources()._internal;
}

// The built-in sample set, small, validated through the contract loader.
function sampleSet(ET, opts) {
  const o = Object.assign({ dimension: 48, count: 700, seed: 20261113 }, opts || {});
  const res = ET.contract.validate(sample.generate(o), null);
  if (!res.ok) throw new Error("sample set refused: " + res.message);
  return res.set;
}

// An append of `k` points made from existing rows plus a small offset, validated.
function appendTo(ET, set, k, opts) {
  const o = opts || {};
  const D = set.dimension;
  const vectors = new Float32Array(k * D);
  const points = [];
  for (let a = 0; a < k; a++) {
    const src = (a * 37) % set.count;
    for (let d = 0; d < D; d++) {
      vectors[a * D + d] = set.vectors[src * D + d] + 0.01 * Math.sin(a + d);
    }
    points.push({
      id: "app" + String(set.count + a),
      label: o.labelled ? "appended " + a : "",
      group: o.group || "",
    });
  }
  const data = {
    schema_version: 1,
    kind: "embeddings-tumbler/data",
    op: "append",
    model: set.model,
    dimension: D,
    count: k,
    text_included: set.text_included,
    provenance: set.provenance,
    vectors,
    points,
  };
  const res = ET.contract.validate(data, set);
  if (!res.ok) throw new Error("append refused: " + res.code + " " + res.message);
  return res.set;
}

function frameError(F, D) {
  let worst = 0;
  for (let a = 0; a < 3; a++) {
    for (let b = 0; b < 3; b++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += F[a * D + d] * F[b * D + d];
      worst = Math.max(worst, Math.abs(s - (a === b ? 1 : 0)));
    }
  }
  return worst;
}

function maxAbsDiff(A, B) {
  let m = 0;
  for (let i = 0; i < A.length; i++) m = Math.max(m, Math.abs(A[i] - B[i]));
  return m;
}

function bytesEqual(A, B) {
  if (A.length !== B.length) return false;
  const a = Buffer.from(A.buffer, A.byteOffset, A.byteLength);
  const b = Buffer.from(B.buffer, B.byteOffset, B.byteLength);
  return a.equals(b);
}

// Create a mode instance, enter it, and pump its preparation to completion.
function ready(ET, id, set, enterOpts, createOpts) {
  const inst = ET.modes.create(id, createOpts);
  inst.enter(set, enterOpts || { seed: 7 });
  inst.prepare().step();
  return inst;
}

// The frames (copied) of an instance at the given absolute times.
function framesAt(inst, times) {
  return times.map((t) => {
    const s = inst.stateAt(t);
    return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), status: s.status };
  });
}

function ticks(seconds, fps) {
  const out = [];
  const n = Math.round(seconds * fps);
  for (let i = 0; i <= n; i++) out.push(i / fps);
  return out;
}

module.exports = {
  freshET,
  sampleSet,
  appendTo,
  frameError,
  maxAbsDiff,
  bytesEqual,
  ready,
  framesAt,
  ticks,
  sample,
};
