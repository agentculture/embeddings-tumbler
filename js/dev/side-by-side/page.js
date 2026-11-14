/* Dev-only: shows a reference page next to what was built, and drives both from one place.
 *
 * Three comparisons, chosen by the first row of buttons (their addresses are on the buttons):
 *   first  the first demo against the standalone page on the synthetic sample set;
 *   sky    the sky search reference against the same standalone page, same sample set, with the
 *          same searches typed into both;
 *   focus  the Focus reference against the built viewer in Focus on the reference's own data
 *          (focus-build.html reads it out of the reference page).
 *
 * The demo and the sky reference keep their mode in the URL fragment and listen for a change of
 * it, so this page sets the fragment inside the frame (same origin). The build reads ?mode= once
 * at load, so its frame is reloaded with the new query. "Restart both" reloads both. A search is
 * typed into each page's own box (or, for focus-build.html, sent through the viewer's handle),
 * so each side runs its own search code. If a frame cannot be reached (the page is not served
 * from the same origin) the status line says so.
 */
(function () {
  "use strict";

  const STORE = "et-side-by-side-checked";
  const MODES = ["tumble", "lattice", "wander"];
  const TRIES = 80; // how often a page's search box is looked for while the page starts
  const TRY_MS = 250;
  // What each comparison needs beyond the two addresses on its button.
  const PAIRS = {
    first: { modes: true, search: null, data: "the synthetic sample set" },
    sky: {
      modes: true,
      search: "tide harbor\nreef kelp\ncomet nebula", // the reference's own starting searches
      refBox: "#in-query",
      buildBox: ".tumbler-search-input",
      hint: "one search per line, up to four; words among the 290 named points",
      data: "the synthetic sample set",
    },
    focus: {
      modes: false,
      search: "water", // the reference's own starting search
      refBox: "#query",
      buildBox: null, // focus-build.html takes searches through window.sideBySideBuild
      hint: "one text; the reference holds one search at a time",
      data: "the reference's own 124 texts",
    },
  };

  const refFrame = document.getElementById("frame-ref");
  const buildFrame = document.getElementById("frame-build");
  const statusEl = document.getElementById("status");
  const pairButtons = Array.from(document.querySelectorAll("button[data-pair]"));
  const buttons = Array.from(document.querySelectorAll(".bar button[data-mode]"));
  const searchBar = document.getElementById("search-bar");
  const queryBox = document.getElementById("both-query");
  let pair = "first";
  let current = "tumble";
  let round = 0; // goes up whenever the build's frame is reloaded, so a retry for the old page stops

  function say(text) {
    statusEl.textContent = text;
  }

  function pairButton() {
    return pairButtons.find(function (b) {
      return b.dataset.pair === pair;
    });
  }

  function markButtons() {
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === current));
      b.hidden = !PAIRS[pair].modes;
    }
    for (const b of pairButtons) b.setAttribute("aria-pressed", String(b.dataset.pair === pair));
    document.querySelector("#mode-bar .bar-label").hidden = !PAIRS[pair].modes;
    searchBar.hidden = PAIRS[pair].search === null;
  }

  function buildAddress(mode) {
    const base = pairButton().dataset.build;
    if (!PAIRS[pair].modes) return base;
    return base + (base.includes("?") ? "&" : "?") + "mode=" + mode;
  }

  function refAddress(mode) {
    return pairButton().dataset.ref + (PAIRS[pair].modes ? "#" + mode : "");
  }

  function loadBuild(mode) {
    round++;
    buildFrame.src = buildAddress(mode);
  }

  // Once the build's new page has loaded (not before: the old page's box is still there until
  // then), give it the search that is in this page's box.
  buildFrame.addEventListener("load", function () {
    if (PAIRS[pair].search !== null) sendToBuild(queryBox.value, round, TRIES);
  });

  function loadBoth() {
    refFrame.src = refAddress(current);
    loadBuild(current);
  }

  // Switch the reference in place by its own fragment; report whether that worked.
  function driveRef(mode) {
    try {
      refFrame.contentWindow.location.hash = "#" + mode;
      return true;
    } catch {
      return false;
    }
  }

  function setMode(mode) {
    if (!MODES.includes(mode) || !PAIRS[pair].modes) return;
    current = mode;
    markButtons();
    loadBuild(mode);
    if (driveRef(mode)) say("Both showing " + mode + ". The reference switched in place; the build reloaded with ?mode=" + mode + ".");
    else {
      refFrame.src = refAddress(mode);
      say("Both showing " + mode + ". The reference could not be switched from here, so it was reloaded.");
    }
  }

  function setPair(name) {
    if (!Object.hasOwn(PAIRS, name)) return;
    pair = name;
    const b = pairButton();
    document.getElementById("cap-ref").textContent = b.dataset.ref.split("/").at(-1);
    document.getElementById("cap-build").textContent = b.dataset.build.split("?")[0].replace(/^\//, "") + ", " + PAIRS[name].data;
    queryBox.value = PAIRS[name].search || "";
    document.getElementById("both-hint").textContent = PAIRS[name].hint ? "(" + PAIRS[name].hint + ")" : "";
    markButtons();
    loadBoth();
    say("Loading " + b.textContent.trim() + ": the reference and the build on " + PAIRS[name].data + ".");
  }

  function restart() {
    loadBoth();
    say("Both reloaded" + (PAIRS[pair].modes ? " in " + current : "") + ".");
  }

  // ---------- the same search on both sides ----------

  // Type into a page's own search box, as a person would: set the text and fire its input event.
  function typeInto(frame, selector, text) {
    const box = frame.contentDocument?.querySelector(selector);
    if (!box) return false;
    box.value = text;
    box.dispatchEvent(new frame.contentWindow.Event("input", { bubbles: true }));
    return true;
  }

  function buildTook(text) {
    const p = PAIRS[pair];
    if (p.buildBox) return typeInto(buildFrame, p.buildBox, text);
    const api = buildFrame.contentWindow.sideBySideBuild;
    if (!api) return false;
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    api.search(lines);
    return true;
  }

  // The build's box exists only once its viewer has mounted, so look for it until it does.
  function sendToBuild(text, forRound, left) {
    if (forRound !== round) return;
    let done = false;
    try {
      done = buildTook(text);
    } catch {
      done = false; // the frame is between two pages, or on another origin
    }
    if (done) return;
    if (left <= 0) {
      say("The build's search box could not be reached; type the search into it by hand.");
      return;
    }
    window.setTimeout(function () {
      sendToBuild(text, forRound, left - 1);
    }, TRY_MS);
  }

  function searchBoth() {
    const text = queryBox.value;
    let refDone = false;
    try {
      refDone = typeInto(refFrame, PAIRS[pair].refBox, text);
    } catch {
      refDone = false; // the frame is on another origin
    }
    sendToBuild(text, round, TRIES);
    say(
      refDone
        ? "The search was typed into both pages. Each side ran its own search code on " + PAIRS[pair].data + "."
        : "The reference's search box could not be reached; type the search into it by hand. The build was sent the search."
    );
  }

  for (const b of pairButtons) {
    b.addEventListener("click", function () {
      setPair(b.dataset.pair);
    });
  }
  for (const b of buttons) {
    b.addEventListener("click", function () {
      setMode(b.dataset.mode);
    });
  }
  document.getElementById("restart").addEventListener("click", restart);
  searchBar.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (PAIRS[pair].search !== null) searchBoth();
  });

  let loaded = 0;
  function onLoad() {
    loaded++;
    if (loaded === 2) say("Both pages loaded. Each reference asks for Google Fonts from another origin; if you are offline it falls back to other fonts.");
  }
  refFrame.addEventListener("load", onLoad, { once: true });
  buildFrame.addEventListener("load", onLoad, { once: true });

  // ?pair=sky or ?pair=focus opens on that comparison.
  const asked = new URLSearchParams(window.location.search).get("pair");
  if (asked && asked !== pair) setPair(asked);

  // ---------- the checklist ----------

  let checked = {};
  try {
    checked = JSON.parse(window.localStorage.getItem(STORE) || "{}") || {};
  } catch {
    checked = {};
  }

  function save() {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(checked));
    } catch {
      /* a remembered tick is a convenience */
    }
  }

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function render(data) {
    const root = document.getElementById("groups");
    let total = 0;
    const countEl = document.getElementById("count");
    function updateCount() {
      let n = 0;
      for (const k of Object.keys(checked)) {
        if (checked[k]) n++;
      }
      countEl.textContent = n + " of " + total + " checked";
    }
    // One checklist line: a box remembered under key, the title and where the difference shows.
    function itemRow(key, item, where) {
      const li = element("li");
      const label = element("label");
      const box = element("input");
      box.type = "checkbox";
      box.checked = !!checked[key];
      box.addEventListener("change", function () {
        checked[key] = box.checked;
        save();
        updateCount();
      });
      label.appendChild(box);
      label.appendChild(element("span", "", item.title));
      const vis = element("span", "vis", where + ": " + item.visible);
      vis.setAttribute("data-vis", item.visible);
      label.appendChild(vis);
      li.appendChild(label);
      return li;
    }
    for (const g of data.groups) {
      const details = element("details");
      details.open = true;
      const summary = element("summary", "", g.group + " ");
      summary.appendChild(element("small", "", "(" + g.items.length + ")"));
      details.appendChild(summary);
      const list = element("ul");
      // The search groups say whether a difference shows on comparable data, not the sample set.
      const where = g.group.startsWith("Search") ? "on comparable data" : "on the sample set";
      for (const item of g.items) {
        total++;
        list.appendChild(itemRow(g.group + " / " + item.title, item, where));
      }
      details.appendChild(list);
      root.appendChild(details);
    }
    document.getElementById("check-note").textContent =
      "Each line is a heading in docs/reference-differences.md, where the reference, the build, the reason and the evidence are written out. The groups whose names start with Search belong to the two search references.";
    updateCount();
  }

  fetch("checklist.json")
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(render)
    .catch(function (err) {
      document.getElementById("check-note").textContent =
        "The list could not be loaded (" + err.message + "). Serve the repository root over HTTP and open this page from there; the list is docs/reference-differences.md.";
    });
})();
