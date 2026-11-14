// update() never throws for bad data. It returns a result and the viewer shows the message.
const result = viewer.update(data);
if (result.ok) {
  console.log(result.op, "now showing", result.count, "points,", result.added, "added");
} else {
  switch (result.code) {
    case "append-without-base":
    case "model-mismatch":
    case "dimension-mismatch":
      // The append does not belong to this view: send a full set (a replace) instead.
      break;
    default:
      console.warn(result.code, result.message);
  }
}
