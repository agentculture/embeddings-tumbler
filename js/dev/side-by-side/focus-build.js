/* Dev-only: the built viewer in Focus on the same data as the Focus reference page.
 *
 * The reference (docs/specs/reference/tumbler-focus-view.html) carries 124 texts and 18 extra
 * query phrases with real model vectors inside its own script. This page fetches that file
 * from its own origin, reads the data out of it, and hands the 124 texts to the built viewer
 * through the public API (mount, update), so both sides show the same vectors and nothing is
 * copied into the repository a second time.
 *
 * No model runs here either. The host's embed callback is a stand-in that answers the way the
 * reference places a query: the stored vector of the whole phrase when there is one, otherwise
 * the mean of the stored vectors of the words it knows. A phrase with no known word is refused,
 * as the reference refuses it. There is no rerank callback, so no Reranker is offered: the
 * reference's reranker is a toy and the build has none of its own.
 */
(function () {
  "use strict";

  const REF = "/docs/specs/reference/tumbler-focus-view.html";
  const SEED = 7; // the reference's seed
  const intro = document.getElementById("intro");

  function say(text) {
    intro.textContent = text;
  }

  // The one line of the reference's script that holds its data.
  function readData(html) {
    const found = /^\s*const DATA = (\{.*\});\s*$/m.exec(html);
    if (!found) throw new Error("the reference's data line was not found");
    return JSON.parse(found[1]);
  }

  // Row k of the reference's 8-bit block, scaled and normalised exactly as the reference does.
  function makeRows(data) {
    const D = data.dimension;
    const bytes = Uint8Array.from(atob(data.vectors), (c) => c.codePointAt(0));
    return function row(k) {
      const v = new Float32Array(D);
      let sum = 0;
      for (let i = 0; i < D; i++) {
        const b = bytes[k * D + i];
        v[i] = ((b > 127 ? b - 256 : b) * data.scales[k]) / 127;
        sum += v[i] * v[i];
      }
      const n = Math.sqrt(sum) || 1;
      for (let i = 0; i < D; i++) v[i] /= n;
      return v;
    };
  }

  function makeSet(data, row) {
    const D = data.dimension;
    const N = data.items.length;
    const vectors = new Float32Array(N * D);
    const points = data.items.map(function (item, k) {
      vectors.set(row(k), k * D);
      return { id: "t" + String(k + 1).padStart(3, "0"), label: item[0], group: data.groups[item[1]], metadata: { text: item[0] } };
    });
    return {
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      model: data.model,
      dimension: D,
      count: N,
      text_included: true,
      provenance: {
        source: "the Focus reference page's own data: " + N + " words and phrases, read from " + REF,
        producer: "js/dev/side-by-side/focus-build.js (development only)",
        synthetic: false,
        seed: null, // the reference names no seed for how its vectors were made
        limitations: [
          "the reference stores these vectors at 8-bit precision; they are normalised again here",
          "typed text is not embedded: a stand-in answers only from the vectors the reference page stores",
        ],
        uncertain: [],
      },
      vectors: vectors,
      points: points,
    };
  }

  // The reference's placeQuery: the whole phrase's stored vector, else the mean of known words.
  function makeEmbed(data, row) {
    const D = data.dimension;
    const N = data.items.length;
    const known = new Map();
    data.items.forEach(function (item, k) {
      known.set(item[0].toLowerCase(), row(k));
    });
    data.queries.forEach(function (q, k) {
      known.set(q.toLowerCase(), row(N + k));
    });
    return function embed(text) {
      const whole = String(text).trim().toLowerCase().replace(/\s+/g, " ");
      if (known.has(whole)) return { vector: known.get(whole), model: data.model, queryForm: "stored phrase" };
      const v = new Float32Array(D);
      let used = 0;
      for (const w of whole.match(/[a-z]+/g) || []) {
        const k = known.get(w);
        if (!k) continue;
        used++;
        for (let i = 0; i < D; i++) v[i] += k[i];
      }
      if (!used) throw new Error("no stored vector for this text");
      return { vector: v, model: data.model, queryForm: "mean of stored words" };
    };
  }

  function start(data) {
    const row = makeRows(data);
    const handle = window.EmbeddingsTumbler.mount(document.getElementById("space"), {
      mode: "focus",
      seed: SEED,
      embed: makeEmbed(data, row),
      title: "Built Focus view on the Focus reference's data",
    });
    const result = handle.update(makeSet(data, row));
    if (!result.ok) {
      say("The viewer refused the reference's data: " + result.message);
      return;
    }
    say(
      "Build: the viewer in Focus on the reference's own " +
        data.items.length +
        " texts (" +
        data.model +
        ", " +
        data.dimension +
        " dimensions, read from the reference page). A stand-in embed callback answers from the reference's stored vectors; no model runs."
    );
    // The side-by-side page (same origin) calls this to run the same search on both sides.
    window.sideBySideBuild = {
      search: function (lines) {
        return handle.setSearches(lines);
      },
    };
  }

  fetch(REF)
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.text();
    })
    .then(function (html) {
      start(readData(html));
    })
    .catch(function (err) {
      say("The reference's data could not be read (" + err.message + "). Serve the repository root over HTTP and open this page from there.");
    });
})();
