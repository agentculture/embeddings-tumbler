(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");
  const report = document.getElementById("report");
  const field = document.getElementById("query");
  let known = null; // what this page loaded: { model, byName: lower-case id or label -> vector }

  function say(text) {
    note.textContent = text;
  }

  // ---------- the two callbacks ----------

  // THE EMBED CALLBACK. The viewer calls it with the typed text and nothing else. It answers
  // { vector, model, queryForm? }: a vector of the data's dimension, the id of the model that
  // made it (required, and it must equal the data's model), and optionally which input form
  // the model was given ("query", "plain", ...).
  //
  // This example has no model, so it stands in for one: it knows the ids and labels of its own
  // points and answers with that point's vector. Nothing leaves the page. A real host calls its
  // OWN server here and returns its answer; that server holds the address and the key of the
  // embedding service, which must never reach a page.
  async function embed(text) {
    const vector = known.byName.get(text.trim().toLowerCase());
    if (!vector) throw new Error("This stand-in embedder only knows this page's ids and labels.");
    return { vector: vector, model: known.model, queryForm: "plain" };
  }

  // THE RERANK CALLBACK. The viewer calls it with the query text and the candidate texts (the
  // nearest named points, nearest first). It answers { scores, model }: one finite number per
  // candidate, in the order given, higher meaning more relevant, and the reranker's own id.
  //
  // This stand-in counts the words a candidate shares with the query. A real host sends both
  // to its own server, as for embed.
  async function rerank(query, candidates) {
    const wanted = new Set(query.toLowerCase().match(/[a-z0-9]+/g) || []);
    const scores = candidates.map(function (candidate) {
      const words = new Set(candidate.toLowerCase().match(/[a-z0-9]+/g) || []);
      let shared = 0;
      for (const word of wanted) if (words.has(word)) shared += 1;
      return shared;
    });
    return { scores: scores, model: "example/shared-words" };
  }

  // ---------- what a search reports ----------

  // onSearchChange gets info().search each time it changes. Everything the picture shows is
  // in it as numbers and text, so a host (or a test) never has to read pixels.
  function describe(search) {
    if (search.waiting) return "Working out the search.";
    if (!search.active) return "No search: every point is shown.";
    const lines = [search.litCount + " points lit. Distances are " + search.measure + "."];
    for (const one of search.searches) {
      lines.push(
        one.letter + ": " + one.kind + ' search for "' + one.text + '", text sent to ' + one.sentTo +
          (one.reranker ? ", reranked by " + one.reranker : "") + ". " + one.results.length +
          " results, " + one.insideCount + " points within " + one.radius.toFixed(3) + "."
      );
      for (const hit of one.results.slice(0, 3)) {
        lines.push("   " + hit.rank + ". " + hit.text + " (" + hit.distance.toFixed(3) + ")");
      }
    }
    for (const pair of search.pairs) {
      lines.push(pair.a + " and " + pair.b + ": " + pair.shared + " points inside both, " +
        pair.common + " results in common.");
    }
    return lines.join("\n");
  }

  // ---------- the viewer ----------

  const viewer = EmbeddingsTumbler.mount(el, {
    seed: 7,
    title: "My vectors",
    embed: embed, // without it, typed text is matched among the loaded points
    rerank: rerank, // without it, there is no reranking and no Reranker control
    searchK: 8, // results per search, 3 to 100
    onSearchChange: function (search) {
      report.textContent = describe(search);
    },
  });

  // The host does the fetching. The viewer never makes a request of its own.
  async function loadData(jsonUrl) {
    const meta = await (await fetch(jsonUrl)).json();
    const file = meta?.vectors?.file;
    if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) return { ...meta };
    const block = await (await fetch(new URL(file, new URL(jsonUrl, location.href)))).arrayBuffer();
    return { ...meta, vectors: { ...meta.vectors, data: block } };
  }

  function remember(data) {
    const flat = new Float32Array(data.vectors.data);
    const byName = new Map();
    data.points.forEach(function (point, i) {
      const vector = flat.slice(i * data.dimension, (i + 1) * data.dimension);
      byName.set(point.id.toLowerCase(), vector);
      byName.set(String(point.label).toLowerCase(), vector);
    });
    known = { model: data.model, byName: byName };
  }

  // A vector the host already has: here, the middle of two loaded points.
  function between(a, b) {
    const one = known.byName.get(a);
    const two = known.byName.get(b);
    return one.map(function (value, i) {
      return (value + two[i]) / 2;
    });
  }

  // ---------- the handle's search methods ----------

  const actions = {
    // Typed text matched among the labels and texts of the loaded points. Nothing is sent.
    words: function () {
      return viewer.setSearches([{ text: field.value, via: "words" }]);
    },
    // Typed text through the embed callback. A plain string does the same when a callback is set.
    embed: function () {
      return viewer.setSearches([{ text: field.value, via: "embed" }]);
    },
    // Up to four searches at once. They get the letters A to D in the order given.
    two: function () {
      return viewer.setSearches([{ text: "alpha", via: "words" }, { text: "beta", via: "words" }]);
    },
    // From a loaded point, by its id.
    point: function () {
      return viewer.setSearches([{ point: "p0007" }]);
    },
    // From a vector the host has. The model id is required and is checked against the data's.
    vector: function () {
      return viewer.setSearches([
        { vector: between("p0000", "p0001"), model: known.model, label: "between p0000 and p0001" },
      ]);
    },
    // Settings work the searches out again from the query vectors held: no new embed call.
    settings: function () {
      return viewer.setSearchSettings({ k: 12, lit: "close", distances: true });
    },
    rerank: function () {
      return viewer.setSearchSettings({ rerank: !viewer.searchSettings().rerank });
    },
    // The next two answer at once with true or false.
    face: function () {
      return { ok: viewer.faceSearches(), code: "not-faced", message: "There is no search to face." };
    },
    clear: function () {
      return { ok: viewer.clearSearches(), code: "nothing-to-clear", message: "There was no search." };
    },
  };

  // setSearches and setSearchSettings return promises that never reject. They resolve to
  // { ok: true, search } or { ok: false, code, message }, and a refusal changes nothing.
  document.addEventListener("click", async function (event) {
    const action = actions[event.target.dataset?.action];
    if (!action || !known) return;
    const result = await action();
    if (result.ok) say("Done: " + event.target.textContent + ".");
    else if (result.code !== "superseded") say("Refused (" + result.code + "): " + result.message);
  });

  loadData("space.json")
    .then(function (data) {
      const result = viewer.update(data);
      if (result.ok) {
        remember(data);
        say("Showing " + result.count + " points.");
      } else {
        say("The viewer refused the data (" + result.code + "): " + result.message);
      }
    })
    .catch(function (error) {
      say("Could not load the data: " + error.message);
    });
})();
