// Every option is optional. Options are read once, when the viewer is mounted.
var viewer = EmbeddingsTumbler.mount(document.getElementById("space"), {
  mode: "wander",          // "tumble" (default), "lattice" or "wander"
  seed: 20261113,          // makes the tour reproducible; shown on the page as "Seed (view)"
  speed: 1,                // motion speed multiplier
  paused: null,            // null: start paused only when the visitor prefers reduced motion
  title: "Support tickets",
  controls: true,          // false hides the play, zoom, speed and label controls
  provenanceOpen: false,   // start the provenance block collapsed (it cannot be removed)
  lightStyle: null,        // "panel", "ink" or "soft" on a light page
  onError: function (result) {
    console.warn("refused:", result.code, result.message);
  }
});
