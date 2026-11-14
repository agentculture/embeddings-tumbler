/* Dev-only: drives the reference demo and the built standalone page from one row of buttons.
 *
 * The reference keeps its mode in the URL fragment and listens for a change of it, so this page
 * sets the fragment inside its frame (same origin). The build reads ?mode= once at load, so this
 * page reloads that frame with the new query. "Restart both" reloads both at the current mode so
 * the two start from the same moment. If a frame cannot be reached (the page is not served from
 * the same origin), the reference is reloaded with the fragment instead and the status says so.
 */
(function () {
  "use strict";

  var REF = "/docs/specs/reference/embedding-tumbler-demo.html";
  var BUILD = "/embeddings_tumbler/static/index.html";
  var STORE = "et-side-by-side-checked";
  var MODES = ["tumble", "lattice", "wander"];

  var refFrame = document.getElementById("frame-ref");
  var buildFrame = document.getElementById("frame-build");
  var statusEl = document.getElementById("status");
  var buttons = Array.prototype.slice.call(document.querySelectorAll(".bar button[data-mode]"));
  var current = "tumble";

  function say(text) {
    statusEl.textContent = text;
  }

  function markButtons() {
    buttons.forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === current));
    });
  }

  function loadBuild(mode) {
    buildFrame.src = BUILD + "?mode=" + mode;
  }

  function loadRef(mode) {
    refFrame.src = REF + "#" + mode;
  }

  // Switch the reference in place by its own fragment; report whether that worked.
  function driveRef(mode) {
    try {
      refFrame.contentWindow.location.hash = "#" + mode;
      return true;
    } catch (err) {
      return false;
    }
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) return;
    current = mode;
    markButtons();
    loadBuild(mode);
    if (driveRef(mode)) say("Both showing " + mode + ". The reference switched in place; the build reloaded with ?mode=" + mode + ".");
    else {
      loadRef(mode);
      say("Both showing " + mode + ". The reference could not be switched from here, so it was reloaded.");
    }
  }

  function restart() {
    loadRef(current);
    loadBuild(current);
    say("Both reloaded in " + current + ".");
  }

  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      setMode(b.getAttribute("data-mode"));
    });
  });
  document.getElementById("restart").addEventListener("click", restart);

  var loaded = 0;
  function onLoad() {
    loaded++;
    if (loaded === 2) say("Both pages loaded. The reference asks for Google Fonts from another origin; if you are offline it falls back to other fonts.");
  }
  refFrame.addEventListener("load", onLoad, { once: true });
  buildFrame.addEventListener("load", onLoad, { once: true });

  // ---------- the checklist ----------

  var checked = {};
  try {
    checked = JSON.parse(window.localStorage.getItem(STORE) || "{}") || {};
  } catch (err) {
    checked = {};
  }

  function save() {
    try {
      window.localStorage.setItem(STORE, JSON.stringify(checked));
    } catch (err) {
      /* a remembered tick is a convenience */
    }
  }

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function render(data) {
    var root = document.getElementById("groups");
    var total = 0;
    var countEl = document.getElementById("count");
    function updateCount() {
      var n = 0;
      Object.keys(checked).forEach(function (k) {
        if (checked[k]) n++;
      });
      countEl.textContent = n + " of " + total + " checked";
    }
    data.groups.forEach(function (g) {
      var details = element("details");
      details.open = true;
      var summary = element("summary", "", g.group + " ");
      summary.appendChild(element("small", "", "(" + g.items.length + ")"));
      details.appendChild(summary);
      var list = element("ul");
      g.items.forEach(function (item) {
        total++;
        var key = g.group + " / " + item.title;
        var li = element("li");
        var label = element("label");
        var box = element("input");
        box.type = "checkbox";
        box.checked = !!checked[key];
        box.addEventListener("change", function () {
          checked[key] = box.checked;
          save();
          updateCount();
        });
        label.appendChild(box);
        label.appendChild(element("span", "", item.title));
        var vis = element("span", "vis", "on the sample set: " + item.visible);
        vis.setAttribute("data-vis", item.visible);
        label.appendChild(vis);
        li.appendChild(label);
        list.appendChild(li);
      });
      details.appendChild(list);
      root.appendChild(details);
    });
    document.getElementById("check-note").textContent =
      "Each line is a heading in docs/reference-differences.md, where the reference, the build, the reason and the evidence are written out. The last group is what the side-by-side found that nobody had written down.";
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
