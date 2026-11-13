"use strict";
// A fake WebGL 2 context and canvas for node unit tests of the renderer.
// It draws nothing. It records which GPU objects are alive, which calls were
// made, and lets a test simulate context loss, restore, and shader failures.

function constantFor(name) {
  // Stable, distinct number for every GL constant name (as a real context would have).
  let h = 7;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return 0x10000 + (h % 0x7fff0000);
}

function makeFakeGL(opts) {
  const o = Object.assign(
    { maxTextureSize: 16384, colorBufferFloat: true, failCompile: false, failLink: false },
    opts || {}
  );
  const state = {
    live: new Set(), // every created object not yet deleted
    created: [], // every created object, ever
    deleted: [],
    calls: [],
    lost: false,
    canvas: null,
    texImages: [], // [{width, height, internalFormat}]
    opts: o,
  };
  let nextId = 1;
  function make(kind) {
    const obj = { kind, id: nextId++ };
    state.live.add(obj);
    state.created.push(obj);
    return obj;
  }
  function del(kind) {
    return function (obj) {
      state.calls.push(["delete" + kind, obj]);
      if (obj && state.live.has(obj)) {
        state.live.delete(obj);
        state.deleted.push(obj);
      }
    };
  }
  const C = (n) => constantFor(n);
  const loseExt = {
    loseContext() {
      state.lost = true;
      state.live.clear(); // the GPU drops everything
      if (state.canvas) state.canvas.dispatch("webglcontextlost");
    },
    restoreContext() {
      state.lost = false;
      if (state.canvas) state.canvas.dispatch("webglcontextrestored");
    },
  };
  const impl = {
    get drawingBufferWidth() {
      return state.canvas ? state.canvas.width : 300;
    },
    get drawingBufferHeight() {
      return state.canvas ? state.canvas.height : 150;
    },
    createTexture: () => make("texture"),
    createBuffer: () => make("buffer"),
    createFramebuffer: () => make("framebuffer"),
    createProgram: () => make("program"),
    createShader: (type) => Object.assign(make("shader"), { type }),
    createVertexArray: () => make("vertexArray"),
    deleteTexture: del("Texture"),
    deleteBuffer: del("Buffer"),
    deleteFramebuffer: del("Framebuffer"),
    deleteProgram: del("Program"),
    deleteShader: del("Shader"),
    deleteVertexArray: del("VertexArray"),
    shaderSource(sh, src) {
      sh.source = src;
      state.calls.push(["shaderSource", src]);
    },
    getShaderParameter: () => !o.failCompile,
    getProgramParameter: () => !o.failLink,
    getShaderInfoLog: () => "fake compile error",
    getProgramInfoLog: () => "fake link error",
    getUniformLocation: (p, name) => ({ program: p, name }),
    getAttribLocation: () => 0,
    getParameter(p) {
      if (p === C("MAX_TEXTURE_SIZE")) return o.maxTextureSize;
      return 0;
    },
    getExtension(name) {
      if (name === "EXT_color_buffer_float") return o.colorBufferFloat ? {} : null;
      if (name === "EXT_color_buffer_half_float") return null;
      if (name === "WEBGL_lose_context") return loseExt;
      return null;
    },
    checkFramebufferStatus: () => C("FRAMEBUFFER_COMPLETE"),
    isContextLost: () => state.lost,
    texImage2D(target, level, internalFormat, width, height) {
      state.texImages.push({ width, height, internalFormat });
    },
  };
  const gl = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return C(prop);
      return function () {
        state.calls.push([prop].concat(Array.prototype.slice.call(arguments)));
      };
    },
  });
  return { gl, state };
}

function makeFakeCanvas(glOpts, canvasOpts) {
  const co = Object.assign({ noWebGL2: false, throwOnGetContext: false }, canvasOpts || {});
  const { gl, state } = makeFakeGL(glOpts);
  const listeners = {};
  const canvas = {
    width: 300,
    height: 150,
    getContext(type) {
      if (co.throwOnGetContext) throw new Error("getContext blew up");
      if (type !== "webgl2" || co.noWebGL2) return null;
      return gl;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatch(type) {
      let prevented = false;
      const ev = {
        type,
        preventDefault() {
          prevented = true;
        },
      };
      for (const fn of (listeners[type] || []).slice()) fn(ev);
      return prevented;
    },
    listenerCount() {
      return Object.values(listeners).reduce((a, l) => a + l.length, 0);
    },
  };
  state.canvas = canvas;
  return { canvas, gl, state };
}

module.exports = { makeFakeGL, makeFakeCanvas, constantFor };
