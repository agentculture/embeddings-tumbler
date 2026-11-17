"use strict";
// The cases of the relative-off regression gate (js/test/relative-off-golden.test.js).
// One function, `computeCases`, runs every (view, seed, time, search) case through the
// assembled file and returns a compact record per case. The goldens were made from the
// 0.12.1 file by scripts/gen_relative_off_golden.js; the test recomputes and compares.
// Inputs are deterministic: the built-in sample set and seeded modes, no timers.
const crypto = require("node:crypto");
const F = require("./modes-fixtures.js");
const { loadAssembled } = require("./load.js");

const VIEWS = ["tumble", "lattice", "wander", "focus"];
const SEEDS = [3, 11];
const TIMES = [0, 0.5, 2.25, 7, 10, 20];
const SET_OPTIONS = { dimension: 48, count: 400, seed: 20261113 };
const SEARCH_AT = 0; // the mode time a search is given
const SWING_AT = 1.0; // the mode time face() is called in the swing cases
const SWING_TIMES = [0.5, 2.25, 7, 10, 20]; // before, during, at its end (about 6 s), after release
const NAMES = ["tumble", "lattice", "wander", "focus"];

function sha(typed) {
  const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  return crypto.createHash("sha256").update(b).digest("hex");
}

function rowOf(set, i) {
  return set.vectors.slice(i * set.dimension, (i + 1) * set.dimension);
}

function entry(ET, set, at, k, letter) {
  const ranking = ET.search.rank(set, rowOf(set, at), { k });
  return { letter, query: rowOf(set, at), indices: Int32Array.from(ranking.hits, (h) => h.index) };
}

function searchOf(ET, set) {
  return {
    searches: [entry(ET, set, 40, 8, "A"), entry(ET, set, 250, 8, "B")],
    scale: null,
    onlyResults: false,
  };
}

function record(state) {
  const frame = new Float32Array(state.frame);
  const centre = new Float32Array(state.centre);
  const draw = state.draw || {};
  return {
    frame: sha(frame),
    centre: sha(centre),
    zoom: draw.zoom === undefined ? null : Number(draw.zoom),
    status: state.status === undefined ? null : String(state.status),
    frameHead: Array.from(frame.slice(0, 3)),
    centreHead: Array.from(centre.slice(0, 3)),
  };
}

// A facing target made the way the viewer makes it (see js/test/modes-face.test.js).
function facingTarget(ET, set, rows) {
  const D = set.dimension;
  const searches = rows.map((i) => ({
    query: set.vectors.slice(i * D, (i + 1) * D),
    hits: [i, i + 1, i + 2].map((index) => ({ index })),
  }));
  const st = ET.searchSets.makeFacingFrame(set, searches, { seed: 1 });
  st.step();
  return st.result;
}

// Tumble, Lattice and Wander react to a search through the swing: face() at a fixed time,
// then the release back to the mode's own motion.
function swingCases(cases, world, view, seed) {
  const inst = F.ready(world.ET, view, world.set, { seed });
  inst.face(world.facing, SWING_AT);
  for (const t of SWING_TIMES) cases[`${view}|seed=${seed}|t=${t}|swing`] = record(inst.stateAt(t));
}

// The mode's own motion at every time, with the search given first when `withSearch`.
function plainCases(cases, world, view, seed, withSearch) {
  const inst = F.ready(world.ET, view, world.set, { seed });
  if (withSearch && typeof inst.searchChanged === "function") {
    // As the viewer does: hand it the search, pump what comes back, mark the time.
    const work = inst.searchChanged(world.search, SEARCH_AT);
    if (work) work.step();
    inst.mark(SEARCH_AT);
  }
  const tag = withSearch ? "search" : "none";
  for (const t of TIMES) cases[`${view}|seed=${seed}|t=${t}|${tag}`] = record(inst.stateAt(t));
}

function viewCases(cases, world, view, seed) {
  const focus = view === "focus";
  if (!focus) swingCases(cases, world, view, seed);
  for (const withSearch of focus ? [false, true] : [false]) plainCases(cases, world, view, seed, withSearch);
}

function computeCases() {
  const ET = loadAssembled()._internal;
  const set = F.sampleSet(ET, SET_OPTIONS);
  const world = { ET, set, search: searchOf(ET, set), facing: facingTarget(ET, set, [5, 300]) };
  const cases = {};
  for (const view of VIEWS) {
    for (const seed of SEEDS) viewCases(cases, world, view, seed);
  }
  return cases;
}

module.exports = { computeCases, VIEWS, SEEDS, TIMES, SET_OPTIONS, NAMES };
