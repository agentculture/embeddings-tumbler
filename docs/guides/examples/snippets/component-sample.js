// The built-in sample set with the web component. Load sample-data.js after the core file,
// leave out the src attribute, and hand the sample to the element from your own script.
var el = document.getElementById("space");
el.update(EmbeddingsTumbler.sample.generate({ count: 2000, dimension: 384, seed: 7 }));
