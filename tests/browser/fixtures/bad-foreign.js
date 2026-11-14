// Negative control (deliberately bad): ask ?foreign=<origin> for one thing of ?kind=<kind>.
// The foreign origin is a second loopback server the test starts, never a real host.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var o = q.get("foreign");
  var kind = q.get("kind");
  var bad = (window.__bad = { done: false, kind: kind, error: null });
  var u = o + "/probe-" + kind;
  try {
    if (kind === "img") {
      var img = document.createElement("img");
      img.src = u + ".png";
      document.body.appendChild(img);
    } else if (kind === "script") {
      var s = document.createElement("script");
      s.src = u + ".js";
      document.body.appendChild(s);
    } else if (kind === "stylesheet") {
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = u + ".css";
      document.head.appendChild(l);
    } else if (kind === "fetch") {
      fetch(u + ".json", { mode: "no-cors" }).catch(function () {});
    } else if (kind === "xhr") {
      var x = new XMLHttpRequest();
      x.open("GET", u + ".txt");
      x.send();
    } else if (kind === "beacon") {
      navigator.sendBeacon(u + ".beacon", "x");
    } else if (kind === "websocket") {
      var ws = new WebSocket(o.replace(/^http/, "ws") + "/probe-websocket");
      ws.onerror = function () {};
    } else if (kind === "font") {
      var f = new FontFace("probe", "url(" + u + ".woff2)");
      f.load().catch(function () {});
    } else if (kind === "iframe") {
      var fr = document.createElement("iframe");
      fr.src = u + ".html";
      document.body.appendChild(fr);
    } else if (kind === "eventsource") {
      var es = new EventSource(u + ".events");
      es.onerror = function () { es.close(); };
    }
  } catch (err) {
    bad.error = String(err);
  }
  bad.done = true;
})();
