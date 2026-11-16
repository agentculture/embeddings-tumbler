#!/usr/bin/env node
"use strict";
// The built viewer's half of scripts/compare_relative_reference.py: what the assembled core
// file shows in the relative view for a search from one article of a data pair.
//
//   node scripts/compare_relative_reference.js <pair.json> <rerank.json> <label>
//
// It mounts the assembled file (embeddings_tumbler/static/embeddings-tumbler.js) on the fake
// DOM and GPU of js/test/helpers/, loads the pair, turns Relative on, searches from the point
// labelled <label>, advances the viewer's clock until the turn onto the pinned frame has
// ended, and prints one JSON object on stdout. Nothing is written and nothing is fetched.
//
// The build names the search's own point first (docs/relative-interface.md, "Answer: does a
// search from a point name the point itself?"), so it is given counts one higher than the
// reference page's: k 9 for the reference's 8 results, candidates 51 and top 9 for the
// reference's 50 candidates and 8 kept. Its rerank callback answers with the reference
// file's real scores: the score the reference holds for each of the article's 50 nearest
// other articles, matched by the candidate's text, and, for the article itself, a score
// above all of them (the highest of the 50 plus 1), so that it stays first as it is in the
// build's own ranking. A candidate the reference file holds no score for is reported in
// `unknownCandidates` and scored below every other.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const api = require(path.join(ROOT, "embeddings_tumbler", "static", "embeddings-tumbler.js"));
const { makeFakeDom } = require(path.join(ROOT, "js", "test", "helpers", "fake-dom.js"));
const ET = api._internal;

const TURN = 1.5; // Tumble's relativeTransition (docs/relative-interface.md)
const MODEL = "reference-file/scores"; // the model id the callback names; the scores are the file's

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

function loadPair(file) {
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  const buf = fs.readFileSync(path.join(path.dirname(file), meta.vectors.file));
  const n = meta.count * meta.dimension;
  if (buf.length !== n * 4) fail("the vector block does not match count x dimension");
  const vectors = new Float32Array(n);
  for (let i = 0; i < n; i++) vectors[i] = buf.readFloatLE(i * 4);
  return { ...meta, vectors };
}

const tick = () => new Promise((r) => setImmediate(r));

async function until(dom, done, what, bound = 2000) {
  for (let i = 0; i < bound && !done(); i++) {
    await tick();
    dom.frames(1);
  }
  await tick();
  if (!done()) fail("the viewer did not reach: " + what);
}

async function settle(dom, promise, what) {
  let out;
  let finished = false;
  promise.then((r) => {
    out = r;
    finished = true;
  });
  await until(dom, () => finished, what);
  return out;
}

function results(info) {
  const s = info.search;
  const rel = s.relative.searches[0];
  return s.searches[0].results.map((r, j) => ({
    index: r.index,
    id: r.id,
    rank: r.rank,
    height: rel.results[j].height,
    cosine: rel.results[j].cosine,
  }));
}

async function main() {
  const [pairFile, rerankFile, label] = process.argv.slice(2);
  if (!pairFile || !rerankFile || !label) fail("usage: compare_relative_reference.js <pair.json> <rerank.json> <label>");
  const data = loadPair(pairFile);
  const rr = JSON.parse(fs.readFileSync(rerankFile, "utf8"));
  const own = data.points.findIndex((p) => p.label === label);
  if (own < 0) fail("no point labelled " + label);
  if (rr.count !== data.count) fail("the rerank file is for another set");

  // The reference's scores for this article, by the candidate's text.
  const textOf = (i) => ET.search.pointText({ ids: data.points.map((p) => p.id), points: data.points }, i);
  const pool = rr.pool[own];
  const scores = rr.scores[own];
  const byText = new Map(pool.map((i, r) => [textOf(i), scores[r]]));
  const ownScore = Math.max(...scores) + 1;
  const ownText = textOf(own);
  const unknown = [];
  const calls = [];
  const rerank = (query, candidates) => {
    calls.push({ query: query === ownText ? "the article's own text" : "other", candidates: candidates.length });
    const answer = candidates.map((c) => {
      if (c === ownText) return ownScore;
      if (byText.has(c)) return byText.get(c);
      unknown.push(c.slice(0, 40));
      return -1;
    });
    return { scores: answer, model: MODEL };
  };

  const dom = makeFakeDom();
  const el = dom.host();
  const h = api.mount(el, {
    seed: 7,
    mode: "tumble",
    paused: true,
    searchPanel: false,
    relative: true,
    rerank,
    searchK: 9,
    searchCandidates: 51,
    searchTop: 9,
  });
  h.update(data);
  await until(dom, () => h.info().ready && !h.info().preparing, "ready");

  const id = data.points[own].id;
  const r = await settle(dom, h.setSearches([{ point: id }]), "the search");
  if (!r.ok) fail("the search was refused: " + r.message);
  await until(dom, () => h.info().search.relative.active && !h.info().preparing, "the relative view");
  h.seek(h.time() + TURN + 0.5);
  dom.frames(12);
  let info = h.info();
  const rel = info.search.relative;
  if (!rel.settled) fail("the relative view did not settle");

  // Row 1 of the frame drawn against the search's unit direction.
  const v = h._viewer;
  const D = data.dimension;
  const q = v.search.shown[0].query;
  let len = 0;
  for (let d = 0; d < D; d++) len += q[d] * q[d];
  len = Math.sqrt(len);
  let worst = 0;
  for (let d = 0; d < D; d++) worst = Math.max(worst, Math.abs(v.last.frame[D + d] - q[d] / len));

  const plain = results(info);
  const out = {
    model: data.model,
    count: data.count,
    dimension: D,
    label,
    own: { index: own, id },
    settings: { k: 9, candidates: 51, top: 9 },
    pinned: rel.pinned,
    measure: rel.measure,
    settled: rel.settled,
    row1Error: worst,
    plain,
  };

  // The same search with the reranker on: the order changes, the frame and heights do not.
  const rr2 = await settle(dom, h.setSearchSettings({ rerank: true }), "the reranked search");
  if (!rr2.ok) fail("reranking was refused: " + rr2.message);
  await until(dom, () => h.info().search.relative.active && !h.info().preparing, "the reranked view");
  dom.frames(12);
  info = h.info();
  const overlay = ET.viewer.relativeOverlayData(h);
  out.reranked = results(info);
  out.reranker = info.search.searches[0].reranker;
  out.rerankNote = info.search.searches[0].note || "";
  out.sent = calls.length ? calls[calls.length - 1].candidates : 0;
  out.rerankCalls = calls;
  out.unknownCandidates = unknown;
  out.ownScore = ownScore;
  out.overlayRanks = overlay.named.map((n) => ({ index: n.index, ranks: n.ranks.map((x) => x.rank) }));
  out.cut = overlay.cut;
  out.statusHasReranker = info.status.includes("named results chosen and numbered by the reranker");
  h.destroy();
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((err) => fail("the comparison failed: " + (err && err.message ? err.message : String(err))));
