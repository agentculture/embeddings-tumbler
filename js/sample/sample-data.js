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
  var REFERENCE_SEED = 20261113;
  var REFERENCE_DIMENSION = 384;
  var REFERENCE_COUNT = 12288;
  var TAU = Math.PI * 2;

  var REGIONS = [
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
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var TEMPS = ["frozen", "icy", "frosty", "bitter", "chilly", "cold", "brisk", "cool", "mild", "temperate", "lukewarm", "warm", "balmy", "toasty", "hot", "sweltering", "torrid", "searing", "scorching", "blazing"];
  var SPREAD = [0.22, 0.16, 0.12, 0.08, 0.06];

  // The reference's seeded generator, copied.
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pad(n) {
    var s = String(n);
    while (s.length < 5) s = "0" + s;
    return s;
  }

  // generate({seed, dimension, count}) -> the in-memory data set (see js/api/sample-data.md).
  function generate(options) {
    options = options || {};
    var seed = options.seed === undefined ? REFERENCE_SEED : options.seed;
    var D = options.dimension === undefined ? REFERENCE_DIMENSION : options.dimension;
    var N = options.count === undefined ? REFERENCE_COUNT : options.count;
    if (typeof seed !== "number" || !isFinite(seed) || Math.floor(seed) !== seed) {
      throw new RangeError("sample seed must be an integer");
    }
    if (typeof D !== "number" || Math.floor(D) !== D || D < 8) {
      throw new RangeError("sample dimension must be an integer of at least 8");
    }

    var rnd = mulberry32(seed);
    var spare = null;
    function gauss() {
      if (spare !== null) {
        var s0 = spare;
        spare = null;
        return s0;
      }
      var u, v, s;
      do {
        u = rnd() * 2 - 1;
        v = rnd() * 2 - 1;
        s = u * u + v * v;
      } while (s >= 1 || s === 0);
      var m = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * m;
      return u * m;
    }
    function randUnit() {
      var v = new Float32Array(D);
      var n = 0;
      for (var d = 0; d < D; d++) {
        v[d] = gauss();
        n += v[d] * v[d];
      }
      n = 1 / Math.sqrt(n);
      for (var e = 0; e < D; e++) v[e] *= n;
      return v;
    }

    var labels = [];
    var regionOf = [];
    var acc = new Float64Array(D);
    function axpy(k, v) {
      for (var d = 0; d < D; d++) acc[d] += k * v[d];
    }

    // Structure first (draw order matters), then the points.
    var reg = [];
    var r, j, b;
    for (r = 0; r < 9; r++) {
      reg.push({
        c: randUnit(),
        dirs: SPREAD.map(function () { return randUnit(); }),
        ph: [rnd() * TAU, rnd() * TAU, rnd() * TAU]
      });
    }
    var ring = { c: randUnit(), u: randUnit(), w: randUnit() };
    var arc = { c: randUnit(), u: randUnit(), w: randUnit(), q: randUnit() };
    var bridges = [];
    for (b = 0; b < 13; b++) {
      var a = b < 9 ? b : Math.floor(rnd() * 9);
      var z = b < 9 ? (b + 1) % 9 : Math.floor(rnd() * 9);
      if (z === a) z = (a + 4) % 9;
      bridges.push({ a: a, z: z, bend: randUnit(), wob: randUnit() });
    }
    function blob(rr) {
      axpy(1, reg[rr].c);
      for (var jj = 0; jj < 5; jj++) axpy(gauss() * SPREAD[jj], reg[rr].dirs[jj]);
    }
    function ringAt(th, rad) {
      axpy(0.9, ring.c);
      axpy(rad * Math.cos(th), ring.u);
      axpy(rad * Math.sin(th), ring.w);
    }
    function arcAt(s) {
      axpy(0.9, arc.c);
      axpy((s - 0.5) * 1.1, arc.u);
      axpy(0.36 * Math.sin(Math.PI * s), arc.w);
      axpy(0.16 * Math.sin(TAU * s), arc.q);
    }

    var named = 0;
    REGIONS.forEach(function (R, ri) {
      if (ri < 9) named += R.words.split(" ").length;
    });
    named += MONTHS.length * 3 + TEMPS.length;
    if (typeof N !== "number" || Math.floor(N) !== N || N < named) {
      throw new RangeError("sample count must be an integer of at least " + named);
    }

    var X = new Float32Array(N * D);
    function commit(i, noise) {
      var n = 0;
      var d;
      for (d = 0; d < D; d++) {
        var x = acc[d] + (rnd() + rnd() - 1) * 2.449 * noise;
        acc[d] = x;
        n += x * x;
      }
      n = 1 / Math.sqrt(n);
      var o = i * D;
      for (d = 0; d < D; d++) {
        X[o + d] = acc[d] * n;
        acc[d] = 0;
      }
    }

    var n = 0;
    for (r = 0; r < 9; r++) {
      var words = REGIONS[r].words.split(" ");
      for (var wi = 0; wi < words.length; wi++) {
        blob(r);
        labels[n] = words[wi];
        regionOf[n] = r;
        commit(n++, 0.006);
      }
    }
    for (var m = 0; m < 12; m++) {
      for (j = 0; j < 3; j++) {
        ringAt(((m + j / 3) / 12) * TAU, 0.46);
        labels[n] = (j === 0 ? "" : j === 1 ? "mid-" : "late ") + MONTHS[m];
        regionOf[n] = 9;
        commit(n++, 0.003);
      }
    }
    for (var k = 0; k < TEMPS.length; k++) {
      arcAt(k / (TEMPS.length - 1));
      labels[n] = TEMPS[k];
      regionOf[n] = 10;
      commit(n++, 0.003);
    }
    for (; n < N; n++) {
      var t = rnd();
      rnd(); // the reference draws a point weight here (used only for colour); keep the stream aligned
      labels[n] = "";
      regionOf[n] = -1;
      if (t < 0.56) {
        var rg = Math.floor(rnd() * 9);
        var R = reg[rg];
        regionOf[n] = rg;
        if (rnd() < 0.42) {
          blob(rg);
          commit(n, 0.006);
        } else {
          var f = Math.floor(rnd() * 3);
          var s = (rnd() + rnd() - 1) * 1.25;
          axpy(1, R.c);
          axpy(0.36 * s, R.dirs[f]);
          axpy(0.19 * Math.sin(2.3 * s + R.ph[f]), R.dirs[(f + 1) % 5]);
          axpy(0.11 * Math.cos(3.1 * s + R.ph[f]), R.dirs[(f + 2) % 5]);
          axpy(gauss() * 0.018, R.dirs[(f + 3) % 5]);
          commit(n, 0.0035);
        }
      } else if (t < 0.73) {
        var B = bridges[Math.floor(rnd() * bridges.length)];
        var sb = rnd();
        axpy(1 - sb, reg[B.a].c);
        axpy(sb, reg[B.z].c);
        axpy(0.3 * Math.sin(Math.PI * sb), B.bend);
        axpy(gauss() * 0.02 + 0.06 * Math.sin(9 * sb), B.wob);
        regionOf[n] = sb < 0.5 ? B.a : B.z;
        commit(n, 0.003);
      } else if (t < 0.8) {
        ringAt(rnd() * TAU, 0.46 + gauss() * 0.012);
        regionOf[n] = 9;
        commit(n, 0.003);
      } else if (t < 0.85) {
        arcAt(rnd());
        regionOf[n] = 10;
        commit(n, 0.004);
      } else {
        for (var d = 0; d < D; d++) acc[d] = gauss();
        rnd(); rnd(); // the reference draws the halo weight from two more values
        commit(n, 0);
      }
    }

    // Centre the cloud, as the reference does.
    var mean = new Float64Array(D);
    var i, dd, o;
    for (i = 0; i < N; i++) {
      o = i * D;
      for (dd = 0; dd < D; dd++) mean[dd] += X[o + dd];
    }
    for (dd = 0; dd < D; dd++) mean[dd] /= N;
    for (i = 0; i < N; i++) {
      o = i * D;
      for (dd = 0; dd < D; dd++) X[o + dd] -= mean[dd];
    }

    var points = new Array(N);
    for (i = 0; i < N; i++) {
      points[i] = {
        id: "p" + pad(i),
        label: labels[i],
        group: regionOf[i] >= 0 ? REGIONS[regionOf[i]].name : ""
      };
    }

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
        seed: seed,
        limitations: [
          "these vectors are generated, not produced by any embedding model",
          "the month ring and the temperature arc are planted by the generator; the ring is invented here, although a real one was measured in Qwen3-Embedding-0.6B",
          "real model output is noisier and less tidy than this",
          "points without a label stand in for unnamed passages and have no group"
        ],
        uncertain: [],
        params: { dimension: D, count: N }
      },
      vectors: X,
      points: points
    };
  }

  var sample = {
    generate: generate,
    referenceSeed: REFERENCE_SEED,
    referenceDimension: REFERENCE_DIMENSION,
    referenceCount: REFERENCE_COUNT
  };

  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = sample; // node (tests)
  } else {
    root.EmbeddingsTumbler = root.EmbeddingsTumbler || {};
    root.EmbeddingsTumbler.sample = sample;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
