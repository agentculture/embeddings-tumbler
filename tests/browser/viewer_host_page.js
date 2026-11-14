// Page script for tests/browser/test_viewer_render.py (task t8). A plain host page
// that uses only the public API: mount, update, destroy (plus the handle's info()
// and pause() for measuring). It runs a fixed script and leaves its findings on
// window.__viewerResult:
//
//   1. mount, then update with the built-in sample set (n points, d dimensions)
//   2. switch Tumble -> Lattice -> Wander with the mode buttons, counting lit pixels
//   3. append 200 points while paused: the frame must not move, the count must grow
//   4. a replace whose labels and group names contain markup
//   5. an invalid set: a message inside the element, the call returns a refusal
//   6. destroy: the element is empty and the loop stopped
//
// Every Content-Security-Policy violation is recorded (the page runs under
// script-src 'self'; style-src 'self', so a style attribute or style element would
// be one). Query string: ?d=384&n=2000&hold=1500 (milliseconds per mode).
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var D = parseInt(q.get("d") || "384", 10);
  var N = parseInt(q.get("n") || "2000", 10);
  var HOLD = parseInt(q.get("hold") || "1500", 10);
  var out = { steps: {}, violations: [], fatal: null, unavailable: null, done: false };
  window.__viewerResult = out;

  document.addEventListener("securitypolicyviolation", function (e) {
    out.violations.push(e.violatedDirective + " " + (e.blockedURI || "") + " " + (e.sample || ""));
  });

  var T = window.EmbeddingsTumbler;
  var el = document.getElementById("space");

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }
  function until(fn, ms) {
    var t0 = performance.now();
    return new Promise(function (resolve) {
      (function poll() {
        var v = fn();
        if (v || performance.now() - t0 > ms) resolve(v);
        else setTimeout(poll, 50);
      })();
    });
  }
  function lit() {
    var c = el.querySelector(".tumbler-canvas");
    var gl = c && c.getContext("webgl2");
    if (!gl) return -1;
    var w = gl.drawingBufferWidth;
    var h = gl.drawingBufferHeight;
    var px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    var n = 0;
    for (var i = 0; i < px.length; i += 4) if (px[i] > 40 || px[i + 1] > 40 || px[i + 2] > 40) n++;
    return n;
  }
  function rect(sel) {
    var e = el.querySelector(sel);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }
  function split(data, from, to, op) {
    var d = data.dimension;
    var o = {
      schema_version: data.schema_version,
      kind: data.kind,
      model: data.model,
      dimension: d,
      count: to - from,
      text_included: data.text_included,
      points: data.points.slice(from, to),
      vectors: data.vectors.slice(from * d, to * d),
    };
    if (op === "append") o.op = "append";
    else o.provenance = data.provenance;
    return o;
  }

  var full = T.sample.generate({ dimension: D, count: N + 200 });
  var base = split(full, 0, N, "replace");
  var extra = split(full, N, N + 200, "append");
  var h;

  // ?manual=1: mount, show the sample set, and stop; the test drives real input.
  if (q.get("manual") === "1") {
    h = T.mount(el, { seed: 3 });
    window.__viewerHandle = h;
    out.steps.update = T.update(el, base);
    until(function () {
      return h.info().ready;
    }, 20000).then(function () {
      var info = h.info();
      if (!info.rendering) out.unavailable = info.message;
      out.done = true;
    });
    return;
  }

  Promise.resolve()
    .then(function () {
      var t0 = performance.now();
      h = T.mount(el, { seed: 3, preserveDrawingBuffer: true, title: "Viewer host check" });
      out.steps.mountMs = performance.now() - t0;
      out.steps.childrenAfterMount = el.children.length;
      out.steps.bodyChildren = document.body.children.length;
      out.steps.headStyles = document.head.querySelectorAll("style").length;
      t0 = performance.now();
      out.steps.update = T.update(el, base);
      out.steps.updateMs = performance.now() - t0;
      return until(function () {
        return h.info().ready;
      }, 20000);
    })
    .then(function () {
      var info = h.info();
      if (!info.rendering) {
        out.unavailable = info.message;
        return;
      }
      out.steps.firstReady = info.timing;
      out.steps.layout = {
        root: rect(".tumbler"),
        stage: rect(".tumbler-stage"),
        canvas: rect(".tumbler-canvas"),
        status: rect(".tumbler-status"),
        controls: rect(".tumbler-controls"),
        modes: rect(".tumbler-modes"),
        provenance: rect(".tumbler-provenance"),
        strip: rect(".tumbler-strip"),
        element: (function () {
          var r = el.getBoundingClientRect();
          return { width: r.width, height: r.height };
        })(),
        rootScrollWidth: el.firstChild.scrollWidth,
        rootClientWidth: el.firstChild.clientWidth,
        bodyScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        stageBackground: getComputedStyle(el.querySelector(".tumbler-stage")).backgroundImage,
        blend: getComputedStyle(el.querySelector(".tumbler-canvas")).mixBlendMode,
      };
      out.steps.provenanceText = el.querySelector(".tumbler-provenance").textContent;
      out.steps.modes = {};
      var ids = ["tumble", "lattice", "wander"];
      var chain = Promise.resolve();
      ids.forEach(function (id) {
        chain = chain.then(function () {
          el.querySelector('[data-mode="' + id + '"]').click();
          var f0 = h.info().frames;
          var t0 = performance.now();
          return wait(HOLD).then(function () {
            var f1 = h.info().frames;
            out.steps.modes[id] = {
              mode: h.mode(),
              lit: lit(),
              fps: ((f1 - f0) * 1000) / (performance.now() - t0),
              status: el.querySelector(".tumbler-status").textContent,
            };
          });
        });
      });
      return chain
        .then(function () {
          // Append while paused: the frame must stay where it is.
          h.setMode("tumble");
          return wait(600);
        })
        .then(function () {
          h.pause();
          return wait(200);
        })
        .then(function () {
          var v = h._viewer;
          var before = Array.prototype.slice.call(v.last.frame, 0, 12);
          var t0 = performance.now();
          var r = T.update(el, extra);
          var ms = performance.now() - t0;
          return wait(300).then(function () {
            var after = Array.prototype.slice.call(v.last.frame, 0, 12);
            var diff = 0;
            for (var i = 0; i < before.length; i++) diff = Math.max(diff, Math.abs(before[i] - after[i]));
            out.steps.append = { result: r, ms: ms, frameChange: diff, count: h.info().count, lit: lit() };
            h.resume();
          });
        })
        .then(function () {
          // Markup in labels and group names.
          var evil = "<img src=/tests/browser/evil-probe.png onerror=alert(1)>";
          var m = split(full, 0, 300, "replace");
          m.points = m.points.map(function (p, i) {
            return {
              id: p.id,
              label: i === 0 ? evil : p.label,
              group: p.group === "cooking" ? "<b>cook</b>" : p.group,
            };
          });
          out.steps.markup = { result: T.update(el, m) };
          return wait(800).then(function () {
            var labels = el.querySelector(".tumbler-labels").textContent;
            out.steps.markup.groupShownLiterally = labels.indexOf("<b>cook</b>") >= 0;
            out.steps.markup.imgElements = el.querySelectorAll("img").length;
            out.steps.markup.bElements = el.querySelectorAll(".tumbler-labels b").length;
          });
        })
        .then(function () {
          var r = T.update(el, { kind: "something else" });
          var msg = el.querySelector(".tumbler-notice");
          out.steps.invalid = {
            result: r,
            noticeText: msg ? msg.textContent : null,
            noticeVisible: msg ? msg.getBoundingClientRect().height > 0 : false,
          };
          return wait(300);
        })
        .then(function () {
          out.steps.framesBeforeDestroy = h.info().frames;
          out.steps.destroyed = T.destroy(el);
          out.steps.childrenAfterDestroy = el.children.length;
          out.steps.animatingAfterDestroy = h.info().animating;
          out.steps.destroyAgain = T.destroy(el);
        });
    })
    .then(
      function () {
        out.done = true;
      },
      function (err) {
        out.fatal = String(err && err.stack ? err.stack : err);
        out.done = true;
      }
    );
})();
