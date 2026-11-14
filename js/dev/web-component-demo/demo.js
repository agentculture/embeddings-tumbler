// Dev page script: buttons that change the element in the page, a log of its events.
(function () {
  "use strict";
  const el = document.getElementById("wc");
  const log = document.getElementById("log");
  let count = 0;
  let violations = 0;
  const parent = el.parentNode;
  const next = el.nextSibling;
  const DATA = "/tests/fixtures/contract/";

  function note(text) {
    log.textContent = (count === 1 ? "" : log.textContent + "\n") + text;
  }
  ["tumbler-load", "tumbler-error"].forEach(function (type) {
    document.addEventListener(type, function (e) {
      count++;
      document.getElementById("events").textContent = String(count);
      note(type + " " + JSON.stringify(e.detail));
    });
  });
  document.addEventListener("securitypolicyviolation", function () {
    violations++;
    document.getElementById("csp").textContent = String(violations);
  });
  // Put the element back where it was.
  function putBack() {
    if (next) next.before(el);
    else parent.append(el);
  }
  const actions = {
    remove: function () { el.remove(); },
    add: putBack,
    sample: function () { el.update(EmbeddingsTumbler.sample.generate()); },
    small: function () { el.setAttribute("src", DATA + "valid-384.json"); },
    large: function () { el.setAttribute("src", DATA + "valid-1024.json"); },
    foreign: function () { el.setAttribute("src", "https://example.org/data.json"); },
    missing: function () { el.setAttribute("src", DATA + "missing.json"); },
  };
  document.addEventListener("click", function (e) {
    const act = e.target?.dataset?.act;
    if (act && actions[act]) actions[act]();
  });
})();
