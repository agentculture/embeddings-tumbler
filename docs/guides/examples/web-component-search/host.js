(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");

  // The vectors this page already has, read once from its own files, by point id.
  const table = fetch("space.json")
    .then((res) => res.json())
    .then(async (data) => {
      const block = await (await fetch(data.vectors.file)).arrayBuffer();
      const flat = new Float32Array(block);
      const byId = new Map();
      data.points.forEach((p, i) => {
        byId.set(p.id, flat.slice(i * data.dimension, (i + 1) * data.dimension));
      });
      return { model: data.model, byId: byId };
    });

  // THE ONE ASSIGNMENT THAT ADDS SEARCH. The viewer calls this with the typed text, and
  // wants back { vector, model }: a vector of the data's dimension and the id of the model
  // that made it.
  //
  // This example answers from vectors already in the page: it looks the text up among the
  // point ids and returns that point's own vector. Nothing leaves the page. A real host
  // would call its OWN server here (for example fetch("/my/embed", { method: "POST", ... })
  // and return its answer), and that server would hold the key to the embedding model. The
  // viewer itself never makes a request, and the key must never reach the page.
  el.embed = async function (text) {
    const known = await table;
    const vector = known.byId.get(text.trim());
    if (!vector) throw new Error("This example only knows its own point ids.");
    return { vector: vector, model: known.model };
  };

  document.addEventListener("tumbler-load", function (event) {
    note.textContent = "Showing " + event.detail.count + " points.";
  });
  document.addEventListener("tumbler-error", function (event) {
    note.textContent = "The viewer refused the data (" + event.detail.code + "): " + event.detail.message;
  });

  document.getElementById("ask").addEventListener("submit", async function (event) {
    event.preventDefault();
    const viewer = el.handle; // null until the element has mounted
    if (!viewer) return;
    const result = await viewer.setSearches([document.getElementById("query").value]);
    if (result.ok) note.textContent = "Searched for " + result.search.searches[0].text + ".";
    else note.textContent = "No search (" + result.code + "): " + result.message;
  });
})();
