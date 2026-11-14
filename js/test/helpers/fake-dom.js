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
//
// The modern tree methods behave as in a browser: remove, before, after, replaceWith,
// append, prepend, replaceChildren, insertBefore, replaceChild, toggleAttribute,
// classList (add/remove/toggle/replace with several tokens), and dataset, a live two-way
// view of the data-* attributes. className, id and hidden reflect their attributes.

const { makeFakeGL } = require("./fake-gl.js");

class FakeStyle {
  _custom = {};
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

// Shared tree behaviour of elements, text nodes and fragments: siblings, removal and the
// ChildNode methods (remove, before, after, replaceWith). Strings passed to the insertion
// methods become text nodes, as in a browser; nothing is ever parsed as markup.
class FakeNode {
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) - 1] || null;
  }
  get nextElementSibling() {
    const kids = this.parentNode ? this.parentNode.childNodes : [];
    return kids.slice(kids.indexOf(this) + 1).find((n) => n.nodeType === 1) || null;
  }
  get previousElementSibling() {
    const kids = this.parentNode ? this.parentNode.childNodes : [];
    return kids.slice(0, Math.max(0, kids.indexOf(this))).findLast((n) => n.nodeType === 1) || null;
  }
  get isConnected() {
    const top = lineage(this).at(-1);
    const doc = top.ownerDocument;
    return !!doc && top === doc.documentElement;
  }
  remove() {
    const p = this.parentNode;
    if (!p) return;
    const i = p.childNodes.indexOf(this);
    if (i >= 0) p.childNodes.splice(i, 1);
    this.parentNode = null;
  }
  before(...items) {
    const parent = this.parentNode;
    if (!parent) return;
    const nodes = toNodes(this, items);
    let prev = this.previousSibling;
    while (prev && nodes.includes(prev)) prev = prev.previousSibling;
    detachAll(nodes);
    const ref = prev ? prev.nextSibling : parent.firstChild;
    for (const n of nodes) parent.insertBefore(n, ref);
  }
  after(...items) {
    const parent = this.parentNode;
    if (!parent) return;
    const nodes = toNodes(this, items);
    let next = this.nextSibling;
    while (next && nodes.includes(next)) next = next.nextSibling;
    detachAll(nodes);
    for (const n of nodes) parent.insertBefore(n, next);
  }
  replaceWith(...items) {
    const parent = this.parentNode;
    if (!parent) return;
    const nodes = toNodes(this, items);
    let next = this.nextSibling;
    while (next && nodes.includes(next)) next = next.nextSibling;
    detachAll(nodes.filter((n) => n !== this));
    if (this.parentNode === parent) {
      for (const n of nodes) if (n !== this) parent.insertBefore(n, this);
      if (!nodes.includes(this)) this.remove();
    } else {
      for (const n of nodes) parent.insertBefore(n, next);
    }
  }
}

// The node, its parent, its parent's parent, ... up to the root.
function lineage(node) {
  const out = [];
  for (let n = node; n; n = n.parentNode) out.push(n);
  return out;
}

// Turn ChildNode/ParentNode arguments into nodes (strings become text nodes).
function toNodes(owner, items) {
  const doc = owner.ownerDocument || null;
  return items.map((it) =>
    it !== null && typeof it === "object" && it.nodeType ? it : new FakeText(it, doc)
  );
}

function detachAll(nodes) {
  for (const n of nodes) n.remove();
}

class FakeText extends FakeNode {
  nodeType = 3;
  parentNode = null;
  constructor(text, doc) {
    super();
    this.data = String(text);
    this.ownerDocument = doc || null;
  }
  get textContent() {
    return this.data;
  }
  set textContent(value) {
    this.data = value === null || value === undefined ? "" : String(value);
  }
  get nodeValue() {
    return this.data;
  }
}

// "fooBar" <-> "data-foo-bar", as the HTML dataset mapping does.
function datasetAttr(prop) {
  return "data-" + prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}
function datasetProp(attr) {
  return attr.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
}

// el.dataset: a live view of the element's data-* attributes, both ways. Writes go through
// setAttribute, so they meet the same guard rails and attribute observers.
function makeDataset(el) {
  const keys = () =>
    Array.from(el.attributes.keys())
      .filter((a) => a.startsWith("data-"))
      .map(datasetProp);
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        const v = el.getAttribute(datasetAttr(prop));
        return v === null ? undefined : v;
      },
      set(_t, prop, value) {
        if (typeof prop !== "string") return false;
        el.setAttribute(datasetAttr(prop), String(value));
        return true;
      },
      has(_t, prop) {
        return typeof prop === "string" && el.hasAttribute(datasetAttr(prop));
      },
      deleteProperty(_t, prop) {
        if (typeof prop === "string") el.removeAttribute(datasetAttr(prop));
        return true;
      },
      ownKeys() {
        return keys();
      },
      getOwnPropertyDescriptor(_t, prop) {
        if (typeof prop !== "string" || !el.hasAttribute(datasetAttr(prop))) return undefined;
        return {
          value: el.getAttribute(datasetAttr(prop)),
          writable: true,
          enumerable: true,
          configurable: true,
        };
      },
    }
  );
}

// Very small selector support: ".class", "tag", "[attr=value]", "#id".
function matchesSelector(el, sel) {
  if (el.nodeType !== 1) return false;
  if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith("#")) return el.getAttribute("id") === sel.slice(1);
  const m = /^\[([\w-]+)="?([^"\]]*)"?\]$/.exec(sel);
  if (m) return el.getAttribute(m[1]) === m[2];
  return el.tagName === sel.toUpperCase();
}

// Shared ParentNode behaviour of elements and fragments.
class FakeParent extends FakeNode {
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get childElementCount() {
    return this.children.length;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes.at(-1) || null;
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    return this.children.at(-1) || null;
  }
  hasChildNodes() {
    return this.childNodes.length > 0;
  }
  // Insert child before ref (null = at the end). A fragment inserts its children.
  insertBefore(child, ref) {
    if (ref !== null && ref !== undefined && ref.parentNode !== this) {
      throw new Error("fake DOM: reference node is not a child");
    }
    if (child === ref) return child;
    if (child.nodeType === 11) {
      for (const c of child.childNodes.slice()) this.insertBefore(c, ref);
      return child;
    }
    if (child.contains?.(this)) throw new Error("fake DOM: hierarchy error");
    child.remove();
    const i = ref === null || ref === undefined ? -1 : this.childNodes.indexOf(ref);
    if (i < 0) this.childNodes.push(child);
    else this.childNodes.splice(i, 0, child);
    child.parentNode = this;
    return child;
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i < 0) throw new Error("fake DOM: not a child");
    child.remove();
    return child;
  }
  replaceChild(child, old) {
    if (old.parentNode !== this) throw new Error("fake DOM: not a child");
    if (child !== old) {
      this.insertBefore(child, old);
      old.remove();
    }
    return old;
  }
  append(...items) {
    for (const n of toNodes(this, items)) this.insertBefore(n, null);
  }
  prepend(...items) {
    const nodes = toNodes(this, items);
    detachAll(nodes);
    const ref = this.firstChild;
    for (const n of nodes) this.insertBefore(n, ref);
  }
  replaceChildren(...items) {
    const nodes = toNodes(this, items);
    detachAll(nodes);
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const n of nodes) this.insertBefore(n, null);
  }
  contains(node) {
    return lineage(node).includes(this);
  }
  querySelectorAll(sel) {
    const out = [];
    const walkTree = (el) => {
      for (const c of el.children) {
        if (matchesSelector(c, sel)) out.push(c);
        walkTree(c);
      }
    };
    walkTree(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = value === null || value === undefined ? "" : String(value);
    if (s !== "") this.appendChild(new FakeText(s, this.ownerDocument));
  }
}

// element.classList: a live view of the class attribute, as a browser's DOMTokenList.
class FakeTokenList {
  constructor(el) {
    this._el = el;
  }
  _tokens() {
    return this._el.className.split(/\s+/).filter(Boolean);
  }
  _write(list) {
    if (list.length === 0 && !this._el.hasAttribute("class")) return;
    this._el.className = list.join(" ");
  }
  get length() {
    return this._tokens().length;
  }
  get value() {
    return this._el.className;
  }
  item(i) {
    return this._tokens()[i] ?? null;
  }
  contains(c) {
    return this._tokens().includes(c);
  }
  add(...cs) {
    const list = this._tokens();
    for (const c of cs) if (!list.includes(c)) list.push(c);
    this._write(list);
  }
  remove(...cs) {
    this._write(this._tokens().filter((x) => !cs.includes(x)));
  }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.add(c);
    else if (!want && has) this.remove(c);
    return want;
  }
  replace(from, to) {
    const list = this._tokens();
    const i = list.indexOf(from);
    if (i < 0) return false;
    list[i] = to;
    this._write(list.filter((x, j) => list.indexOf(x) === j));
    return true;
  }
  forEach(fn) {
    this._tokens().forEach(fn);
  }
  [Symbol.iterator]() {
    return this._tokens()[Symbol.iterator]();
  }
}

class FakeFragment extends FakeParent {
  nodeType = 11;
  childNodes = [];
  parentNode = null;
  constructor(doc) {
    super();
    this.ownerDocument = doc;
  }
}

class FakeElement extends FakeParent {
  nodeType = 1;
  childNodes = [];
  parentNode = null;
  style = new FakeStyle();
  attributes = new Map();
  listeners = {};
  tabIndex = -1;
  rect = null; // { left, top, width, height } set by tests; null = from parent or default
  pointerCapture = null; // the pointer id captured with setPointerCapture, if any
  _dataset = null;
  constructor(doc, tag) {
    super();
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
  }
  // className, id and hidden reflect their attributes, as in a browser. They write the
  // attribute map directly (not through an overridden setAttribute), like the old plain
  // properties did, so attribute observers see only explicit setAttribute calls.
  get className() {
    return this.attributes.get("class") || "";
  }
  set className(value) {
    this.attributes.set("class", String(value));
  }
  get id() {
    return this.attributes.get("id") || "";
  }
  set id(value) {
    this.attributes.set("id", String(value));
  }
  get hidden() {
    return this.attributes.has("hidden");
  }
  set hidden(value) {
    if (value) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }
  get dataset() {
    if (!this._dataset) this._dataset = makeDataset(this);
    return this._dataset;
  }
  matches(sel) {
    return matchesSelector(this, sel);
  }
  closest(sel) {
    return lineage(this).find((n) => n.nodeType === 1 && matchesSelector(n, sel)) || null;
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
  // toggleAttribute goes through setAttribute / removeAttribute, so it meets the same
  // guard rails (a "style" or "on..." attribute still throws) and attribute observers.
  toggleAttribute(name, force) {
    const has = this.hasAttribute(name);
    const want = force === undefined ? !has : !!force;
    if (want && !has) this.setAttribute(name, "");
    else if (!want && has) this.removeAttribute(name);
    return want;
  }
  getAttributeNames() {
    return Array.from(this.attributes.keys());
  }
  // A live token list over the class attribute.
  get classList() {
    return new FakeTokenList(this);
  }
  addEventListener(type, fn, opts) {
    this.listeners[type] ??= [];
    this.listeners[type].push({ fn, opts });
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
    for (const n of lineage(this)) {
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
  setPointerCapture(id) {
    this.pointerCapture = id;
  }
  releasePointerCapture(id) {
    if (this.pointerCapture === id) this.pointerCapture = null;
  }
  hasPointerCapture(id) {
    return this.pointerCapture === id;
  }
  getBoundingClientRect() {
    if (this.rect) return { left: 0, top: 0, ...this.rect };
    if (this.parentNode?.getBoundingClientRect) {
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
}

class FakeCanvas extends FakeElement {
  width = 300;
  height = 150;
  contexts = {};
  constructor(doc) {
    super(doc, "canvas");
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
  const env = { noWebGL2: false, glOptions: null, reducedMotion: false, devicePixelRatio: 1, glStates: [], ...opts };
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
      return new FakeText(s, doc);
    },
    createDocumentFragment() {
      return new FakeFragment(doc);
    },
    created: [],
    addEventListener(type, fn) {
      doc.listeners[type] ??= [];
      doc.listeners[type].push(fn);
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
          for (const n of lineage(el)) {
            if (!n.style) break;
            const v = n.style.getPropertyValue(name);
            if (v) return v;
          }
          return "";
        },
        color: el.style.color || "",
      };
    },
    addEventListener(type, fn) {
      winListeners[type] ??= [];
      winListeners[type].push(fn);
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
      el.rect = { left: 0, top: 0, width: 640, height: 640, ...rect };
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

module.exports = { makeFakeDom, FakeElement, FakeText, FakeFragment, walk };
