(function () {
  "use strict";

  var el = document.getElementById("space");
  var note = document.getElementById("note");
  var addButton = document.getElementById("add");
  var added = 0;

  // The component reports through events that bubble: no callbacks to wire up.
  document.addEventListener("tumbler-load", function (event) {
    var result = event.detail;
    note.textContent = "Showing " + result.count + " points.";
  });
  document.addEventListener("tumbler-error", function (event) {
    note.textContent = "The viewer refused the data (" + event.detail.code + "): " + event.detail.message;
  });

  addButton.addEventListener("click", function () {
    var viewer = el.handle; // null until the first data has been handed over
    if (!viewer) return;
    var info = viewer.info();
    var vector = new Float32Array(info.dimension);
    for (var i = 0; i < vector.length; i++) vector[i] = Math.sin((added + 1) * (i + 1)) * 0.5;
    added += 1;
    // An append goes through the element's update(): same model and dimension, new ids.
    var result = el.update({
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      op: "append",
      model: info.model,
      dimension: info.dimension,
      count: 1,
      text_included: true,
      points: [{ id: "added-" + added, label: "added point " + added, group: "added" }],
      vectors: vector,
    });
    if (result && result.ok) note.textContent = "Showing " + result.count + " points.";
  });
})();
