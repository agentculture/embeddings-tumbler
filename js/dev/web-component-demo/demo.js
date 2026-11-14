// Dev page script: buttons that change the element in the page, a log of its events.
(function () {
  "use strict";
  var el = document.getElementById("wc");
  var log = document.getElementById("log");
  var count = 0;
  var violations = 0;
  var parent = el.parentNode;
  var next = el.nextSibling;
  var DATA = "/tests/fixtures/contract/";

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
  var actions = {
    remove: function () { el.remove(); },
    add: function () { parent.insertBefore(el, next); },
    small: function () { el.setAttribute("src", DATA + "valid-384.json"); },
    large: function () { el.setAttribute("src", DATA + "valid-1024.json"); },
    foreign: function () { el.setAttribute("src", "https://example.org/data.json"); },
    missing: function () { el.setAttribute("src", DATA + "missing.json"); },
  };
  document.addEventListener("click", function (e) {
    var act = e.target && e.target.getAttribute && e.target.getAttribute("data-act");
    if (act && actions[act]) actions[act]();
  });
})();
