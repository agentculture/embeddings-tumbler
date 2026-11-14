// Search host fixture 1: the script form. Mounts the viewer with the embed callback of
// search-embed.js as a mount option, fetches its own data file and vector block (fixed
// addresses; a data file naming another block is refused rather than followed) and calls
// update. State on window.__host.
(function () {
  "use strict";
  const DATA_FILE = "search-set.json";
  const BLOCK_FILE = "search-set.f32";
  const T = window.EmbeddingsTumbler;
  const el = document.getElementById("space");
  const host = (window.__host = { state: "loading", result: null, error: null });

  async function load() {
    const r = await fetch(DATA_FILE);
    if (!r.ok) throw new Error(DATA_FILE + ": " + r.status);
    const meta = await r.json();
    if (meta.vectors.file !== BLOCK_FILE) throw new Error(DATA_FILE + " names a block other than " + BLOCK_FILE);
    const rb = await fetch(BLOCK_FILE);
    if (!rb.ok) throw new Error(BLOCK_FILE + ": " + rb.status);
    return { ...meta, vectors: await rb.arrayBuffer() };
  }

  T.mount(el, { seed: 5, embed: window.__searchEmbed });
  load()
    .then(function (data) {
      host.result = T.update(el, data);
      host.state = host.result.ok ? "ready" : "refused";
    })
    .catch(function (err) {
      host.error = String(err);
      host.state = "error";
    });
})();
