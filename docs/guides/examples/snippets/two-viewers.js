// Several viewers on one page are independent: one element, one viewer, each with its own
// options. Mounting an element that already has a viewer returns the existing viewer and
// ignores the new options; to change options, destroy the element's viewer and mount again.
var left = EmbeddingsTumbler.mount(document.getElementById("left"), { mode: "tumble", seed: 1 });
var right = EmbeddingsTumbler.mount(document.getElementById("right"), { mode: "lattice", seed: 2 });

EmbeddingsTumbler.mount(document.getElementById("left"), { mode: "wander" }) === left; // true

EmbeddingsTumbler.destroy(document.getElementById("left"));   // true: released
EmbeddingsTumbler.destroy(document.getElementById("left"));   // false: nothing to release
