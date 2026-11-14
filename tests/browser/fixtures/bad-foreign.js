// Negative control (deliberately bad): ask ?foreign=<origin> for one thing of ?kind=<kind>.
// The foreign origin is a second loopback server the test starts, never a real host: the
// address is rebuilt from fixed pieces (scheme and host from the lists below, the port as a
// number, the path from the kind's own fixed name), so no text from the query string is ever
// placed in a request.
(function () {
  "use strict";
  // The only hosts this page will ask: the loopback test server, and a name that never resolves.
  const HOSTS = ["127.0.0.1", "elsewhere.invalid"];
  const KINDS = [
    "img",
    "script",
    "stylesheet",
    "fetch",
    "xhr",
    "beacon",
    "websocket",
    "font",
    "iframe",
    "eventsource",
  ];
  const q = new URLSearchParams(location.search);
  const kind = KINDS.find((k) => k === q.get("kind")) || null;
  const bad = (window.__bad = { done: false, kind: kind, error: null, failures: [] });

  // A failure the page expects (the foreign server answers nothing useful) is recorded, not hidden.
  function failed(err) {
    bad.failures.push(String(err));
  }

  // { http, ws } base addresses for a loopback origin such as http://127.0.0.1:41234.
  function foreignBase(value) {
    const url = new URL(value);
    const host = HOSTS.find((h) => h === url.hostname);
    if (!host || url.protocol !== "http:") throw new Error("not a test origin");
    const port = url.port === "" ? "" : ":" + Number(url.port);
    return { http: "http://" + host + port, ws: "ws://" + host + port };
  }

  const ASK = {
    img(base) {
      const img = document.createElement("img");
      img.src = base.http + "/probe-img.png";
      document.body.appendChild(img);
    },
    script(base) {
      const s = document.createElement("script");
      s.src = base.http + "/probe-script.js";
      document.body.appendChild(s);
    },
    stylesheet(base) {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = base.http + "/probe-stylesheet.css";
      document.head.appendChild(l);
    },
    fetch(base) {
      fetch(base.http + "/probe-fetch.json", { mode: "no-cors" }).catch(failed);
    },
    xhr(base) {
      const x = new XMLHttpRequest();
      x.open("GET", base.http + "/probe-xhr.txt");
      x.send();
    },
    beacon(base) {
      navigator.sendBeacon(base.http + "/probe-beacon.beacon", "x");
    },
    websocket(base) {
      const ws = new WebSocket(base.ws + "/probe-websocket");
      ws.onerror = failed;
    },
    font(base) {
      const f = new FontFace("probe", "url(" + base.http + "/probe-font.woff2)");
      f.load().catch(failed);
    },
    iframe(base) {
      const fr = document.createElement("iframe");
      fr.src = base.http + "/probe-iframe.html";
      document.body.appendChild(fr);
    },
    eventsource(base) {
      const es = new EventSource(base.http + "/probe-eventsource.events");
      es.onerror = function (err) {
        failed(err);
        es.close();
      };
    },
  };

  try {
    if (kind) ASK[kind](foreignBase(q.get("foreign")));
  } catch (err) {
    bad.error = String(err);
  }
  bad.done = true;
})();
