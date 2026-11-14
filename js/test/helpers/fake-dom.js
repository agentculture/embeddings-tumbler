"use strict";
// A small fake DOM for node unit tests of the viewer (js/src/50-viewer.js). Zero
// dependencies. It models only what the viewer touches: elements with children,
// text, attributes, a style object, listeners; a document with visibility; a window
// with a manual animation-frame queue, fake timers, IntersectionObserver,
// ResizeObserver, matchMedia and getComputedStyle (custom properties inherit from
// ancestors' style objects). Canvases hand out the fake WebGL 2 context from
// fake-gl.js and a recording 2-D context.
//
// Guard rails: setting innerHTML / outerHTML or calling insertAdjacentHTML throws,
// and so does setAttribute("style", ...), so a test fails if the viewer ever does it.

const { makeFakeGL } = require("./fake-gl.js");

class FakeStyle {
  constructor() {
    this._custom = {};
  }
  setProperty(name, value) {
    if (name.startsWith("--")) this._custom[name] = String(value);
    else this[name] = String(value);
  }
  getPropertyValue(name) {
    if (name.startsWith("--")) return this._custom[name] || "";
    return this[name] || "";
  }
  removeProperty(name) {
    delete this._custom[name];
    delete this[name];
  }
}

class FakeText {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.tabIndex = -1;
    this.rect = null; // { left, top, width, height } set by tests; null = from parent or default
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error("fake DOM: not a child");
    this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = value === null || value === undefined ? "" : String(value);
    if (s !== "") this.appendChild(new FakeText(s));
  }
  set innerHTML(_v) {
    throw new Error("fake DOM: innerHTML is not allowed");
  }
  get innerHTML() {
    throw new Error("fake DOM: innerHTML is not allowed");
  }
  set outerHTML(_v) {
    throw new Error("fake DOM: outerHTML is not allowed");
  }
  insertAdjacentHTML() {
    throw new Error("fake DOM: insertAdjacentHTML is not allowed");
  }
  setAttribute(name, value) {
    if (String(name).toLowerCase() === "style") throw new Error("fake DOM: style attribute is not allowed");
    if (/^on/i.test(name)) throw new Error("fake DOM: event-handler attribute is not allowed");
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  get classList() {
    const el = this;
    return {
      contains: (c) => el.className.split(/\s+/).includes(c),
      add: (c) => {
        if (!el.classList.contains(c)) el.className = (el.className + " " + c).trim();
      },
      remove: (c) => {
        el.className = el.className
          .split(/\s+/)
          .filter((x) => x && x !== c)
          .join(" ");
      },
    };
  }
  addEventListener(type, fn, opts) {
    (this.listeners[type] = this.listeners[type] || []).push({ fn, opts });
    this.ownerDocument._track(+1);
  }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const i = list.findIndex((l) => l.fn === fn);
    if (i >= 0) {
      list.splice(i, 1);
      this.ownerDocument._track(-1);
    }
  }
  listenerCount() {
    return Object.values(this.listeners).reduce((a, l) => a + l.length, 0);
  }
  // Dispatch a plain event object (bubbles to ancestors). Returns the event.
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    ev.defaultPrevented = false;
    if (!ev.preventDefault) {
      ev.preventDefault = function () {
        ev.defaultPrevented = true;
      };
    }
    for (let n = this; n; n = n.parentNode) {
      if (!n.listeners) continue;
      ev.currentTarget = n;
      for (const l of (n.listeners[ev.type] || []).slice()) l.fn.call(n, ev);
    }
    return ev;
  }
  // The fake GL context calls canvas.dispatch(type) for context loss and restore.
  dispatch(type) {
    let prevented = false;
    const ev = {
      type,
      preventDefault() {
        prevented = true;
      },
    };
    for (const l of (this.listeners[type] || []).slice()) l.fn(ev);
    return prevented;
  }
  click() {
    return this.dispatchEvent({ type: "click" });
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    if (this.rect) return Object.assign({ left: 0, top: 0 }, this.rect);
    if (this.parentNode && this.parentNode.getBoundingClientRect) {
      const p = this.parentNode.getBoundingClientRect();
      return { left: p.left, top: p.top, width: p.width, height: this.tagName === "CANVAS" ? p.height : 320 };
    }
    return { left: 0, top: 0, width: 640, height: 320 };
  }
  get clientWidth() {
    return this.getBoundingClientRect().width;
  }
  get clientHeight() {
    return this.getBoundingClientRect().height;
  }
  // Very small selector support: ".class", "tag", "[attr=value]".
  querySelectorAll(sel) {
    const out = [];
    const match = (el) => {
      if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
      const m = /^\[([\w-]+)="?([^"\]]*)"?\]$/.exec(sel);
      if (m) return el.getAttribute(m[1]) === m[2];
      return el.tagName === sel.toUpperCase();
    };
    const walk = (el) => {
      for (const c of el.children) {
        if (match(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

class FakeCanvas extends FakeElement {
  constructor(doc) {
    super(doc, "canvas");
    this.width = 300;
    this.height = 150;
    this.contexts = {};
  }
  getContext(type) {
    const env = this.ownerDocument._env;
    if (type === "webgl2") {
      if (env.noWebGL2) return null;
      if (!this.contexts.webgl2) {
        const { gl, state } = makeFakeGL(env.glOptions);
        state.canvas = this;
        this.contexts.webgl2 = gl;
        this.glState = state;
        env.glStates.push(state);
      }
      return this.contexts.webgl2;
    }
    if (type === "2d") {
      if (!this.contexts["2d"]) this.contexts["2d"] = makeFake2d(this);
      return this.contexts["2d"];
    }
    return null;
  }
}

function makeFake2d(canvas) {
  const rec = { calls: [], puts: [] };
  const impl = {
    canvas,
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img) {
      rec.puts.push({ width: img.width, height: img.height, data: Uint8ClampedArray.from(img.data) });
    },
    fillText() {
      throw new Error("fake 2d: the viewer must not draw text on a canvas (labels are DOM text)");
    },
    strokeText() {
      throw new Error("fake 2d: the viewer must not draw text on a canvas (labels are DOM text)");
    },
    _rec: rec,
  };
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return function () {
        rec.calls.push([prop].concat(Array.from(arguments)));
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

// Build a document + window pair. Options:
//   noWebGL2       canvases return null for "webgl2"
//   glOptions      passed to makeFakeGL
//   reducedMotion  matchMedia("(prefers-reduced-motion: reduce)") matches
//   noIntersectionObserver, noResizeObserver   leave them out of the window
//   devicePixelRatio
function makeFakeDom(opts) {
  const env = Object.assign(
    { noWebGL2: false, glOptions: null, reducedMotion: false, devicePixelRatio: 1, glStates: [] },
    opts || {}
  );
  env.glStates = [];
  let listenerBalance = 0;
  const doc = {
    _env: env,
    _track(d) {
      listenerBalance += d;
    },
    hidden: false,
    visibilityState: "visible",
    listeners: {},
    createElement(tag) {
      const t = String(tag).toLowerCase();
      doc.created.push(t);
      return t === "canvas" ? new FakeCanvas(doc) : new FakeElement(doc, t);
    },
    createTextNode(s) {
      return new FakeText(s);
    },
    created: [],
    addEventListener(type, fn) {
      (doc.listeners[type] = doc.listeners[type] || []).push(fn);
      listenerBalance++;
    },
    removeEventListener(type, fn) {
      const list = doc.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) {
        list.splice(i, 1);
        listenerBalance--;
      }
    },
    listenerCount() {
      return Object.values(doc.listeners).reduce((a, l) => a + l.length, 0);
    },
    setHidden(hidden) {
      doc.hidden = !!hidden;
      doc.visibilityState = hidden ? "hidden" : "visible";
      for (const fn of (doc.listeners.visibilitychange || []).slice()) fn({ type: "visibilitychange" });
    },
  };
  doc.documentElement = new FakeElement(doc, "html");
  doc.head = new FakeElement(doc, "head");
  doc.body = new FakeElement(doc, "body");
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;

  // Animation frames: queued until the test calls flush().
  let rafId = 0;
  const rafQueue = new Map();
  let clock = 1000;
  // Timers: queued until the test calls runTimers().
  let timerId = 0;
  const timers = new Map();

  const ioInstances = [];
  const roInstances = [];
  class IntersectionObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.disconnected = false;
      ioInstances.push(this);
    }
    observe(el) {
      this.targets.push(el);
    }
    unobserve(el) {
      this.targets = this.targets.filter((t) => t !== el);
    }
    disconnect() {
      this.targets = [];
      this.disconnected = true;
    }
    trigger(isIntersecting) {
      this.cb(this.targets.map((t) => ({ target: t, isIntersecting })));
    }
  }
  class ResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.disconnected = false;
      roInstances.push(this);
    }
    observe(el) {
      this.targets.push(el);
    }
    disconnect() {
      this.targets = [];
      this.disconnected = true;
    }
    trigger() {
      this.cb(this.targets.map((t) => ({ target: t })));
    }
  }

  const winListeners = {};
  const win = {
    document: doc,
    devicePixelRatio: env.devicePixelRatio,
    performance: { now: () => clock },
    requestAnimationFrame(cb) {
      const id = ++rafId;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      rafQueue.delete(id);
    },
    setTimeout(fn, ms) {
      const id = ++timerId;
      timers.set(id, { fn, at: clock + (ms || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    matchMedia(q) {
      return { matches: !!env.reducedMotion && /prefers-reduced-motion:\s*reduce/.test(q), media: q };
    },
    getComputedStyle(el) {
      return {
        getPropertyValue(name) {
          for (let n = el; n && n.style; n = n.parentNode) {
            const v = n.style.getPropertyValue(name);
            if (v) return v;
          }
          return "";
        },
        color: el.style.color || "",
      };
    },
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
      listenerBalance++;
    },
    removeEventListener(type, fn) {
      const list = winListeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) {
        list.splice(i, 1);
        listenerBalance--;
      }
    },
  };
  if (!env.noIntersectionObserver) win.IntersectionObserver = IntersectionObserver;
  if (!env.noResizeObserver) win.ResizeObserver = ResizeObserver;
  doc.defaultView = win;

  const control = {
    document: doc,
    window: win,
    env,
    io: ioInstances,
    ro: roInstances,
    // Advance the clock by ms and run the animation frames queued before the call.
    flush(ms) {
      clock += ms === undefined ? 1000 / 60 : ms;
      const batch = Array.from(rafQueue.entries());
      rafQueue.clear();
      for (const [, cb] of batch) cb(clock);
      return batch.length;
    },
    // Run n frames of 1/60 s (each frame only if one was requested).
    frames(n, ms) {
      let ran = 0;
      for (let i = 0; i < n; i++) ran += control.flush(ms);
      return ran;
    },
    pendingFrames() {
      return rafQueue.size;
    },
    advance(ms) {
      clock += ms;
    },
    now() {
      return clock;
    },
    runTimers() {
      const due = Array.from(timers.entries()).filter(([, t]) => t.at <= clock);
      for (const [id, t] of due) {
        timers.delete(id);
        t.fn();
      }
      return due.length;
    },
    pendingTimers() {
      return timers.size;
    },
    listenerBalance() {
      return listenerBalance;
    },
    windowListenerCount() {
      return Object.values(winListeners).reduce((a, l) => a + l.length, 0);
    },
    // A host element attached to the body.
    host(rect) {
      const el = doc.createElement("div");
      el.rect = Object.assign({ left: 0, top: 0, width: 640, height: 640 }, rect || {});
      doc.body.appendChild(el);
      return el;
    },
  };
  return control;
}

// Every element under (and including) root, depth first.
function walk(root) {
  const out = [];
  (function go(el) {
    out.push(el);
    for (const c of el.children) go(c);
  })(root);
  return out;
}

module.exports = { makeFakeDom, FakeElement, walk };
