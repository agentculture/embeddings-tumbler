// Test-only instrumentation for the browser harness (tests/browser/harness.py). NOT shipped.
//
// Loaded by the fixture pages with a plain <script src> BEFORE the core file, so it runs under
// the page's own policy (script-src 'self') and is in place before the viewer exists. It wraps
// the browser APIs the viewer may hold on to and keeps live counts of what is still held:
//
//   rafPending             requestAnimationFrame callbacks requested and not yet run or cancelled
//   timeouts, intervals    setTimeout callbacks not yet run or cleared; setInterval not cleared
//   *Observers             IntersectionObserver / ResizeObserver / MutationObserver instances
//                          observing at least one target (disconnect() or unobserve() of the
//                          last target ends it)
//   glLive, glCreated      WebGL (1 or 2) contexts handed out by getContext and not lost
//                          (the viewer releases its context with WEBGL_lose_context on destroy)
//   canvases               <canvas> elements in the document
//   globalListeners        listeners added to window or document and not removed
//
// window.__harness.snapshot() returns all of them; window.__harness.loaded is the snapshot
// taken when this file ran. The harness takes its baseline before the first mount and
// compares to it (tests/browser/harness.py, leaks()).
(function () {
  "use strict";
  const w = window;
  const H = (w.__harness = w.__harness || {});
  const rafPending = new Map();
  const timeouts = new Map();
  const intervals = new Map();
  const gl = [];
  const observers = { IntersectionObserver: new Set(), ResizeObserver: new Set(), MutationObserver: new Set() };
  const listeners = new Map();
  const stats = { rafRequested: 0, timeoutsSet: 0, observersMade: 0, glCreated: 0 };

  const raf = w.requestAnimationFrame.bind(w);
  const caf = w.cancelAnimationFrame.bind(w);
  w.requestAnimationFrame = function (cb) {
    stats.rafRequested++;
    const id = raf(function (t) {
      rafPending.delete(id);
      cb(t);
    });
    rafPending.set(id, true);
    return id;
  };
  w.cancelAnimationFrame = function (id) {
    rafPending.delete(id);
    return caf(id);
  };

  const st = w.setTimeout.bind(w);
  const ct = w.clearTimeout.bind(w);
  const si = w.setInterval.bind(w);
  const ci = w.clearInterval.bind(w);
  w.setTimeout = function (fn, ms) {
    stats.timeoutsSet++;
    const rest = Array.prototype.slice.call(arguments, 2);
    const id = st(function () {
      timeouts.delete(id);
      if (typeof fn === "function") fn.apply(w, rest);
    }, ms);
    timeouts.set(id, true);
    return id;
  };
  w.clearTimeout = function (id) {
    timeouts.delete(id);
    return ct(id);
  };
  w.setInterval = function () {
    const id = si.apply(w, arguments);
    intervals.set(id, true);
    return id;
  };
  w.clearInterval = function (id) {
    intervals.delete(id);
    return ci(id);
  };

  Object.keys(observers).forEach(function (name) {
    const Orig = w[name];
    if (typeof Orig !== "function") return;
    const live = observers[name];
    const Wrapped = function (cb, opts) {
      const inner = new Orig(cb, opts);
      const targets = new Set();
      stats.observersMade++;
      const origObserve = inner.observe.bind(inner);
      const origDisconnect = inner.disconnect.bind(inner);
      inner.observe = function (target, o) {
        targets.add(target);
        live.add(inner);
        return origObserve(target, o);
      };
      if (typeof inner.unobserve === "function") {
        const origUnobserve = inner.unobserve.bind(inner);
        inner.unobserve = function (target) {
          targets.delete(target);
          if (targets.size === 0) live.delete(inner);
          return origUnobserve(target);
        };
      }
      inner.disconnect = function () {
        targets.clear();
        live.delete(inner);
        return origDisconnect();
      };
      return inner;
    };
    Wrapped.prototype = Orig.prototype;
    w[name] = Wrapped;
  });

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type) {
    const ctx = getContext.apply(this, arguments);
    if (ctx && (type === "webgl2" || type === "webgl" || type === "experimental-webgl")) {
      if (!gl.includes(ctx)) {
        gl.push(ctx);
        stats.glCreated++;
      }
    }
    return ctx;
  };

  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  function key(target, type, fn, opts) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    return { target: target === w ? "window" : "document", type: type, fn: fn, capture: capture };
  }
  function find(k) {
    let found = null;
    listeners.forEach(function (v, id) {
      if (v.target === k.target && v.type === k.type && v.fn === k.fn && v.capture === k.capture) found = id;
    });
    return found;
  }
  let nextListener = 1;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((this === w || this === document) && fn) {
      const k = key(this, type, fn, opts);
      if (find(k) === null) listeners.set(nextListener++, k);
    }
    return add.apply(this, arguments);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (this === w || this === document) {
      const id = find(key(this, type, fn, opts));
      if (id !== null) listeners.delete(id);
    }
    return remove.apply(this, arguments);
  };

  H.snapshot = function () {
    let glLive = 0;
    for (const ctx of gl) if (!ctx.isContextLost()) glLive++;
    const types = {};
    listeners.forEach(function (v) {
      const n = v.target + ":" + v.type;
      types[n] = (types[n] || 0) + 1;
    });
    return {
      canvases: document.querySelectorAll("canvas").length,
      glLive: glLive,
      glCreated: stats.glCreated,
      rafPending: rafPending.size,
      rafRequested: stats.rafRequested,
      timeouts: timeouts.size,
      timeoutsSet: stats.timeoutsSet,
      intervals: intervals.size,
      intersectionObservers: observers.IntersectionObserver.size,
      resizeObservers: observers.ResizeObserver.size,
      mutationObservers: observers.MutationObserver.size,
      observersMade: stats.observersMade,
      globalListeners: listeners.size,
      globalListenerTypes: types,
    };
  };
  // Resolves after n animation frames (through the real requestAnimationFrame, so waiting
  // does not show up in the counts).
  H.frames = function (n) {
    return new Promise(function (resolve) {
      (function step(left) {
        if (left <= 0) resolve();
        else {
          raf(function () {
            step(left - 1);
          });
        }
      })(n);
    });
  };
  H.sleep = function (ms) {
    return new Promise(function (resolve) {
      st(resolve, ms);
    });
  };
  H.loaded = H.snapshot();
})();
