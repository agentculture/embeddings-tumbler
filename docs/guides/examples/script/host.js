(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");
  const addButton = document.getElementById("add");
  const toggleButton = document.getElementById("toggle");
  let viewer = null;
  let added = 0;

  function say(text) {
    note.textContent = text;
  }

  function show(result) {
    if (result.ok) {
      say("Showing " + result.count + " points.");
    } else {
      say("The viewer refused the data (" + result.code + "): " + result.message);
    }
  }

  // The host does the fetching. The viewer never makes a request of its own.
  async function loadData(jsonUrl) {
    const response = await fetch(jsonUrl);
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + jsonUrl);
    const meta = await response.json();
    const file = meta?.vectors?.file;
    // Only fetch a plain file name from the data's own folder.
    if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) {
      return { ...meta }; // the viewer will refuse it with a plain message
    }
    const blockResponse = await fetch(new URL(file, new URL(jsonUrl, location.href)));
    if (!blockResponse.ok) throw new Error("HTTP " + blockResponse.status + " for " + file);
    const block = await blockResponse.arrayBuffer();
    // The block goes beside the file-form descriptor, so the viewer checks
    // the descriptor's dtype, byte order and length against it.
    return { ...meta, vectors: { ...meta.vectors, data: block } };
  }

  function start() {
    // mount once per element; options are read now and cannot change later.
    viewer = EmbeddingsTumbler.mount(el, { mode: "tumble", seed: 7, title: "My vectors" });
    toggleButton.textContent = "Remove the viewer";
    addButton.disabled = false;
    loadData("space.json")
      .then(function (data) {
        show(viewer.update(data));
      })
      .catch(function (error) {
        say("Could not load the data: " + error.message);
      });
  }

  function addPoint() {
    if (!viewer) return;
    const info = viewer.info();
    const vector = new Float32Array(info.dimension);
    for (let i = 0; i < vector.length; i++) vector[i] = Math.sin((added + 1) * (i + 1)) * 0.5;
    added += 1;
    // An append: same model and dimension as the view, new ids, no provenance needed.
    show(
      viewer.update({
        schema_version: 1,
        kind: "embeddings-tumbler/data",
        op: "append",
        model: info.model,
        dimension: info.dimension,
        count: 1,
        text_included: true,
        points: [{ id: "added-" + added, label: "added point " + added, group: "added" }],
        vectors: vector,
      })
    );
  }

  function toggle() {
    if (viewer) {
      EmbeddingsTumbler.destroy(el); // releases the canvas, the listeners and the GPU context
      viewer = null;
      toggleButton.textContent = "Bring the viewer back";
      addButton.disabled = true;
      say("The viewer was removed.");
    } else {
      start();
    }
  }

  addButton.addEventListener("click", addPoint);
  toggleButton.addEventListener("click", toggle);
  start();
})();
