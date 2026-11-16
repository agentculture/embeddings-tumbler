(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");
  const report = document.getElementById("report");
  let loaded = false;

  function say(text) {
    note.textContent = text;
  }

  // ---------- what the relative view reports ----------

  // onSearchChange gets info().search each time it changes, and its `relative` key says
  // what the relative view is doing, as numbers and text, so a host (or a test) never has
  // to read pixels.
  function describe(search) {
    const rel = search.relative;
    const lines = ["Relative is " + (rel.relative ? "on" : "off") + ", Show the origin is " +
      (rel.showOrigin ? "on" : "off") + "."];
    if (!rel.offered) {
      lines.push("Relative is a setting of Tumble; the view is in another mode.");
      return lines.join("\n");
    }
    if (!search.active) {
      lines.push("No search, so there is nothing to measure along.");
      return lines.join("\n");
    }
    for (const gap of rel.dropped) {
      lines.push(gap.letter + " gives no axis (" + gap.reason + ").");
    }
    if (!rel.active) {
      lines.push(rel.relative ? "No search gives an axis." : "The plain view: the setting is off.");
      return lines.join("\n");
    }
    const first = rel.pinned[0];
    lines.push("Vertical axis: " + rel.measure + " to " + first.letter +
      (rel.settled ? ", exact." : ", the view is still turning onto it."));
    if (rel.window) {
      lines.push("The ruler runs from " + rel.window.low.toFixed(2) + " to " + rel.window.high.toFixed(2) + ".");
    }
    if (rel.subspace > 0) {
      lines.push("The other axes tour " + rel.subspace + " directions that hold " +
        Math.round(rel.share * 100) + "% of what remains: sideways position is still a shadow.");
    }
    for (const one of rel.searches) {
      for (const hit of one.results.slice(0, 3)) {
        // height is null for a search that has no direction; cosine is always a number
        lines.push("   " + one.letter + " " + hit.id + ": height " +
          (hit.height === null ? "none" : hit.height.toFixed(2)) + ", cosine " + hit.cosine.toFixed(3));
      }
    }
    return lines.join("\n");
  }

  // ---------- the viewer ----------

  const viewer = EmbeddingsTumbler.mount(el, {
    seed: 7,
    title: "My vectors",
    relative: true, // the Relative setting at mount; the panel's checkbox changes it too
    showOrigin: false, // the Show the origin setting at mount
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

  // ---------- the buttons ----------

  const actions = {
    // A search from a loaded point needs no embedder and sends nothing anywhere.
    one: function () {
      return viewer.setSearches([{ point: "p0007" }]);
    },
    // A second search lies in the plane shown exactly. Its letter is B.
    two: function () {
      return viewer.setSearches([{ point: "p0007" }, { point: "p0100" }]);
    },
    // setRelative is synchronous and returns the settings now in force. It sends nothing and
    // re-ranks nothing. A key that is left out keeps its value.
    relative: function () {
      const now = viewer.setRelative({ relative: !viewer.relativeSettings().relative });
      return { ok: true, now: now };
    },
    origin: function () {
      const now = viewer.setRelative({ showOrigin: !viewer.relativeSettings().showOrigin });
      return { ok: true, now: now };
    },
    clear: function () {
      return { ok: viewer.clearSearches(), code: "nothing-to-clear", message: "There was no search." };
    },
  };

  // setSearches returns a promise that never rejects: { ok: true, search } or
  // { ok: false, code, message }, and a refusal changes nothing.
  document.addEventListener("click", async function (event) {
    const action = actions[event.target.dataset?.action];
    if (!action || !loaded) return;
    const result = await action();
    if (result.ok) say("Done: " + event.target.textContent + ".");
    else if (result.code !== "superseded") say("Refused (" + result.code + "): " + result.message);
  });

  loadData("space.json")
    .then(function (data) {
      const result = viewer.update(data);
      if (result.ok) {
        loaded = true;
        say("Showing " + result.count + " points.");
      } else {
        say("The viewer refused the data (" + result.code + "): " + result.message);
      }
    })
    .catch(function (error) {
      say("Could not load the data: " + error.message);
    });
})();
