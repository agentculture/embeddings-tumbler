/*!
 * embeddings-tumbler built-in sample set (optional; load after the core file).
 *
 * A port of the synthetic generator in the reference demo: nine topic regions,
 * filaments inside them, bridges between them, a ring of months and an arc of
 * temperature words, plus faint unstructured points. Same random source and
 * draw order as the reference, so the reference's seed at 384 dimensions gives
 * the reference's numbers. The data is GENERATED: it is not the output of any
 * model, and its provenance says so.
 *
 * Classic script, no dependencies, nothing from another origin. In a browser it
 * attaches to the core's global as EmbeddingsTumbler.sample; under node it is
 * the module's export.
 */
(function (root) {
  "use strict";

  // The reference's own constants. 384 is the documented default of THIS sample,
  // nowhere else.
  const REFERENCE_SEED = 20261113;
  const REFERENCE_DIMENSION = 384;
  const REFERENCE_COUNT = 12288;
  const TAU = Math.PI * 2;

  const REGIONS = [
    { name: "cooking", hue: 28, words: "simmer braise whisk saffron dough skillet roast garlic broth zest caramelize ladle sourdough marinade paprika sear custard colander knead shallot reduction poach crumb glaze oven stock" },
    { name: "law", hue: 52, words: "statute verdict plaintiff clause appeal tort affidavit injunction precedent subpoena liability counsel hearing indemnity jury breach testimony docket arbitration lien bylaw deposition tribunal remedy contract ruling" },
    { name: "sport", hue: 96, words: "sprint volley tackle relay podium offside dribble rally scrum backhand marathon keeper penalty crossbar pitstop peloton dugout freekick knockout baton hurdle umpire slalom rebound tiebreak kickoff" },
    { name: "code", hue: 140, words: "compiler mutex refactor pointer closure endpoint latency commit daemon schema recursion kernel cache regex thread bytecode linter socket hashmap rollback payload shader cron traceback merge runtime" },
    { name: "money", hue: 170, words: "ledger dividend mortgage invoice equity tariff escrow yield audit collateral inflation bond overdraft payroll hedge liquidity principal surplus arrears annuity deficit margin rebate remittance solvency tax" },
    { name: "ocean", hue: 198, words: "tide reef kelp harbor current swell lagoon estuary trench plankton anchor breakwater undertow shoal brine mooring whale squall lighthouse driftwood atoll surf fathom jetty seabed gull" },
    { name: "astronomy", hue: 226, words: "nebula orbit quasar comet eclipse pulsar parallax redshift aphelion supernova telescope galaxy meteor corona zenith exoplanet asteroid equinox magnetar perigee cosmos starlight lunar solstice binary dwarf" },
    { name: "music", hue: 266, words: "chord tempo cello refrain octave snare melody vinyl harmony bassline crescendo riff falsetto metronome ballad timbre overture synth duet encore lyric fret reverb cadence choir solo" },
    { name: "emotion", hue: 328, words: "grief delight envy awe dread longing relief shame tenderness fury calm pride wonder regret hope boredom jealousy gratitude panic nostalgia contempt joy sorrow yearning serenity unease" },
    { name: "months", hue: 4, words: "" },
    { name: "temperature", hue: 298, words: "" }
  ];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const TEMPS = ["frozen", "icy", "frosty", "bitter", "chilly", "cold", "brisk", "cool", "mild", "temperate", "lukewarm", "warm", "balmy", "toasty", "hot", "sweltering", "torrid", "searing", "scorching", "blazing"];
  const SPREAD = [0.22, 0.16, 0.12, 0.08, 0.06];
  // The three points of each month: its start, its middle and its end.
  const MONTH_PREFIX = ["", "mid-", "late "];

  // The reference's seeded generator. The reference keeps the state as a signed 32-bit
  // value (`a |= 0`); here it is kept unsigned (`>>> 0`). Every operation below reads only
  // the state's low 32 bits (>>> and Math.imul convert to 32 bits first, ^ and | to signed
  // 32 bits), and a state below 2^32 plus the constant stays exact in a double, so the
  // stream is the same number for number.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pad(n) {
    return String(n).padStart(5, "0");
  }

  // The random source of one generate() call: uniform rnd(), Gaussian gauss() (polar
  // Box-Muller, the second value kept for the next call) and randUnit(), a random unit
  // vector of dimension D.
  function makeRandom(seed, D) {
    const rnd = mulberry32(seed);
    let spare = null;
    function gauss() {
      if (spare !== null) {
        const s0 = spare;
        spare = null;
        return s0;
      }
      let u;
      let v;
      let s;
      do {
        u = rnd() * 2 - 1;
        v = rnd() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      const m = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * m;
      return u * m;
    }
    function randUnit() {
      const v = new Float32Array(D);
      let n = 0;
      for (let d = 0; d < D; d++) {
        v[d] = gauss();
        n += v[d] * v[d];
      }
      n = 1 / Math.sqrt(n);
      for (let e = 0; e < D; e++) v[e] *= n;
      return v;
    }
    return { rnd, gauss, randUnit };
  }

  // The integer checks of generate() (a non-number fails Number.isFinite).
  function checkSeed(seed) {
    if (!Number.isFinite(seed) || Math.floor(seed) !== seed) {
      throw new RangeError("sample seed must be an integer");
    }
  }

  function checkDimension(D) {
    if (typeof D !== "number" || Math.floor(D) !== D || D < 8) {
      throw new RangeError("sample dimension must be an integer of at least 8");
    }
  }

  // The number of named points: every topic word, three per month, every temperature word.
  function namedCount() {
    let named = 0;
    for (let ri = 0; ri < 9; ri++) named += REGIONS[ri].words.split(" ").length;
    return named + MONTHS.length * 3 + TEMPS.length;
  }

  function checkCount(N, named) {
    if (typeof N !== "number" || Math.floor(N) !== N || N < named) {
      throw new RangeError("sample count must be an integer of at least " + named);
    }
  }

  // The structure (draw order matters): nine regions, the month ring, the temperature arc
  // and thirteen bridges between regions.
  function makeStructure(g) {
    const reg = [];
    for (let r = 0; r < 9; r++) {
      reg.push({
        c: g.randUnit(),
        dirs: SPREAD.map(() => g.randUnit()),
        ph: [g.rnd() * TAU, g.rnd() * TAU, g.rnd() * TAU]
      });
    }
    g.reg = reg;
    g.ring = { c: g.randUnit(), u: g.randUnit(), w: g.randUnit() };
    g.arc = { c: g.randUnit(), u: g.randUnit(), w: g.randUnit(), q: g.randUnit() };
    g.bridges = [];
    for (let b = 0; b < 13; b++) g.bridges.push(makeBridge(g, b));
  }

  // Bridge b: the first nine join region b to the next one, the rest join random regions.
  function makeBridge(g, b) {
    const a = b < 9 ? b : Math.floor(g.rnd() * 9);
    let z = b < 9 ? (b + 1) % 9 : Math.floor(g.rnd() * 9);
    if (z === a) z = (a + 4) % 9;
    return { a, z, bend: g.randUnit(), wob: g.randUnit() };
  }

  // The point being built is accumulated in g.acc, then committed as row i of g.X.
  function axpy(g, k, v) {
    const acc = g.acc;
    for (let d = 0; d < g.D; d++) acc[d] += k * v[d];
  }

  function blob(g, rr) {
    axpy(g, 1, g.reg[rr].c);
    for (let jj = 0; jj < 5; jj++) axpy(g, g.gauss() * SPREAD[jj], g.reg[rr].dirs[jj]);
  }

  function ringAt(g, th, rad) {
    axpy(g, 0.9, g.ring.c);
    axpy(g, rad * Math.cos(th), g.ring.u);
    axpy(g, rad * Math.sin(th), g.ring.w);
  }

  function arcAt(g, s) {
    axpy(g, 0.9, g.arc.c);
    axpy(g, (s - 0.5) * 1.1, g.arc.u);
    axpy(g, 0.36 * Math.sin(Math.PI * s), g.arc.w);
    axpy(g, 0.16 * Math.sin(TAU * s), g.arc.q);
  }

  // Add uniform noise to the accumulated point, normalise it into row i, clear the accumulator.
  function commit(g, i, noise) {
    const D = g.D;
    const acc = g.acc;
    const rnd = g.rnd;
    let n = 0;
    for (let d = 0; d < D; d++) {
      const x = acc[d] + (rnd() + rnd() - 1) * 2.449 * noise;
      acc[d] = x;
      n += x * x;
    }
    n = 1 / Math.sqrt(n);
    const o = i * D;
    for (let d = 0; d < D; d++) {
      g.X[o + d] = acc[d] * n;
      acc[d] = 0;
    }
  }

  // Each named point is written at g.n with its label and region, and g.n moves on.
  function addNamed(g, label, region, noise) {
    g.labels[g.n] = label;
    g.regionOf[g.n] = region;
    commit(g, g.n, noise);
    g.n++;
  }

  function addNamedPoints(g) {
    for (let r = 0; r < 9; r++) {
      for (const word of REGIONS[r].words.split(" ")) {
        blob(g, r);
        addNamed(g, word, r, 0.006);
      }
    }
    for (let m = 0; m < 12; m++) {
      for (let j = 0; j < 3; j++) {
        ringAt(g, ((m + j / 3) / 12) * TAU, 0.46);
        addNamed(g, MONTH_PREFIX[j] + MONTHS[m], 9, 0.003);
      }
    }
    for (let k = 0; k < TEMPS.length; k++) {
      arcAt(g, k / (TEMPS.length - 1));
      addNamed(g, TEMPS[k], 10, 0.003);
    }
  }

  // The unnamed points, one kind each. Each builds row n and returns its region (-1: none).
  function regionPoint(g, n) {
    const rg = Math.floor(g.rnd() * 9);
    const R = g.reg[rg];
    if (g.rnd() < 0.42) {
      blob(g, rg);
      commit(g, n, 0.006);
      return rg;
    }
    const f = Math.floor(g.rnd() * 3);
    const s = (g.rnd() + g.rnd() - 1) * 1.25;
    axpy(g, 1, R.c);
    axpy(g, 0.36 * s, R.dirs[f]);
    axpy(g, 0.19 * Math.sin(2.3 * s + R.ph[f]), R.dirs[(f + 1) % 5]);
    axpy(g, 0.11 * Math.cos(3.1 * s + R.ph[f]), R.dirs[(f + 2) % 5]);
    axpy(g, g.gauss() * 0.018, R.dirs[(f + 3) % 5]);
    commit(g, n, 0.0035);
    return rg;
  }

  function bridgePoint(g, n) {
    const B = g.bridges[Math.floor(g.rnd() * g.bridges.length)];
    const sb = g.rnd();
    axpy(g, 1 - sb, g.reg[B.a].c);
    axpy(g, sb, g.reg[B.z].c);
    axpy(g, 0.3 * Math.sin(Math.PI * sb), B.bend);
    axpy(g, g.gauss() * 0.02 + 0.06 * Math.sin(9 * sb), B.wob);
    const region = sb < 0.5 ? B.a : B.z;
    commit(g, n, 0.003);
    return region;
  }

  function ringPoint(g, n) {
    ringAt(g, g.rnd() * TAU, 0.46 + g.gauss() * 0.012);
    commit(g, n, 0.003);
    return 9;
  }

  function arcPoint(g, n) {
    arcAt(g, g.rnd());
    commit(g, n, 0.004);
    return 10;
  }

  function haloPoint(g, n) {
    for (let d = 0; d < g.D; d++) g.acc[d] = g.gauss();
    g.rnd(); // the reference draws the halo weight from two more values
    g.rnd();
    commit(g, n, 0);
    return -1;
  }

  // One unnamed point at row n, its kind chosen by the first draw t.
  function unnamedPoint(g, n, t) {
    if (t < 0.56) return regionPoint(g, n);
    if (t < 0.73) return bridgePoint(g, n);
    if (t < 0.8) return ringPoint(g, n);
    if (t < 0.85) return arcPoint(g, n);
    return haloPoint(g, n);
  }

  function addUnnamedPoints(g, N) {
    for (let n = g.n; n < N; n++) {
      const t = g.rnd();
      g.rnd(); // the reference draws a point weight here (used only for colour); keep the stream aligned
      g.labels[n] = "";
      g.regionOf[n] = unnamedPoint(g, n, t);
    }
  }

  // Centre the cloud, as the reference does.
  function centre(X, N, D) {
    const mean = new Float64Array(D);
    for (let i = 0; i < N; i++) {
      const o = i * D;
      for (let dd = 0; dd < D; dd++) mean[dd] += X[o + dd];
    }
    for (let dd = 0; dd < D; dd++) mean[dd] /= N;
    for (let i = 0; i < N; i++) {
      const o = i * D;
      for (let dd = 0; dd < D; dd++) X[o + dd] -= mean[dd];
    }
  }

  function makePoints(N, labels, regionOf) {
    const points = [];
    for (let i = 0; i < N; i++) {
      points.push({
        id: "p" + pad(i),
        label: labels[i],
        group: regionOf[i] >= 0 ? REGIONS[regionOf[i]].name : ""
      });
    }
    return points;
  }

  // generate({seed, dimension, count}) -> the in-memory data set (see js/api/sample-data.md).
  function generate(options) {
    const opts = options ?? {};
    const seed = opts.seed === undefined ? REFERENCE_SEED : opts.seed;
    const D = opts.dimension === undefined ? REFERENCE_DIMENSION : opts.dimension;
    const N = opts.count === undefined ? REFERENCE_COUNT : opts.count;
    checkSeed(seed);
    checkDimension(D);

    const g = makeRandom(seed, D);
    g.D = D;
    g.labels = [];
    g.regionOf = [];
    g.acc = new Float64Array(D);
    makeStructure(g);
    checkCount(N, namedCount());

    g.X = new Float32Array(N * D);
    g.n = 0;
    addNamedPoints(g);
    addUnnamedPoints(g, N);
    centre(g.X, N, D);

    return {
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      model: "synthetic/reference-sample",
      dimension: D,
      count: N,
      text_included: true,
      provenance: {
        source: "synthetic: built-in sample set (generated, not embedded from any text)",
        producer: "embeddings-tumbler sample-data.js (port of the reference demo generator)",
        synthetic: true,
        seed,
        limitations: [
          "these vectors are generated, not produced by any embedding model",
          "the month ring and the temperature arc are planted by the generator; the ring is invented here, although a real one was measured in Qwen3-Embedding-0.6B",
          "real model output is noisier and less tidy than this",
          "points without a label stand in for unnamed passages and have no group"
        ],
        uncertain: [],
        params: { dimension: D, count: N }
      },
      vectors: g.X,
      points: makePoints(N, g.labels, g.regionOf)
    };
  }

  const sample = {
    generate,
    referenceSeed: REFERENCE_SEED,
    referenceDimension: REFERENCE_DIMENSION,
    referenceCount: REFERENCE_COUNT
  };

  if (typeof module === "object" && module?.exports) {
    module.exports = sample; // node (tests)
  } else {
    root.EmbeddingsTumbler ||= {};
    root.EmbeddingsTumbler.sample = sample;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
