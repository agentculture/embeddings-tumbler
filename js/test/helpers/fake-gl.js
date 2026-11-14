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

// Every method of WebGL2RenderingContext (WebGL 1 methods included). A call to any
// other name throws, so a misspelled GL call fails a unit test instead of passing silently.
const WEBGL2_METHODS = new Set(
  (
    "activeTexture attachShader beginQuery beginTransformFeedback bindAttribLocation bindBuffer " +
    "bindBufferBase bindBufferRange bindFramebuffer bindRenderbuffer bindSampler bindTexture " +
    "bindTransformFeedback bindVertexArray blendColor blendEquation blendEquationSeparate blendFunc " +
    "blendFuncSeparate blitFramebuffer bufferData bufferSubData checkFramebufferStatus clear " +
    "clearBufferfi clearBufferfv clearBufferiv clearBufferuiv clearColor clearDepth clearStencil " +
    "clientWaitSync colorMask compileShader compressedTexImage2D compressedTexImage3D " +
    "compressedTexSubImage2D compressedTexSubImage3D copyBufferSubData copyTexImage2D " +
    "copyTexSubImage2D copyTexSubImage3D createBuffer createFramebuffer createProgram createQuery " +
    "createRenderbuffer createSampler createShader createTexture createTransformFeedback " +
    "createVertexArray cullFace deleteBuffer deleteFramebuffer deleteProgram deleteQuery " +
    "deleteRenderbuffer deleteSampler deleteShader deleteSync deleteTexture deleteTransformFeedback " +
    "deleteVertexArray depthFunc depthMask depthRange detachShader disable disableVertexAttribArray " +
    "drawArrays drawArraysInstanced drawBuffers drawElements drawElementsInstanced drawRangeElements " +
    "enable enableVertexAttribArray endQuery endTransformFeedback fenceSync finish flush " +
    "framebufferRenderbuffer framebufferTexture2D framebufferTextureLayer frontFace generateMipmap " +
    "getActiveAttrib getActiveUniform getActiveUniformBlockName getActiveUniformBlockParameter " +
    "getActiveUniforms getAttachedShaders getAttribLocation getBufferParameter getBufferSubData " +
    "getContextAttributes getError getExtension getFragDataLocation " +
    "getFramebufferAttachmentParameter getIndexedParameter getInternalformatParameter getParameter " +
    "getProgramInfoLog getProgramParameter getQuery getQueryParameter getRenderbufferParameter " +
    "getSamplerParameter getShaderInfoLog getShaderParameter getShaderPrecisionFormat getShaderSource " +
    "getSupportedExtensions getSyncParameter getTexParameter getTransformFeedbackVarying getUniform " +
    "getUniformBlockIndex getUniformIndices getUniformLocation getVertexAttrib getVertexAttribOffset " +
    "hint invalidateFramebuffer invalidateSubFramebuffer isBuffer isContextLost isEnabled " +
    "isFramebuffer isProgram isQuery isRenderbuffer isSampler isShader isSync isTexture " +
    "isTransformFeedback isVertexArray lineWidth linkProgram pauseTransformFeedback pixelStorei " +
    "polygonOffset readBuffer readPixels renderbufferStorage renderbufferStorageMultisample " +
    "resumeTransformFeedback sampleCoverage samplerParameterf samplerParameteri scissor shaderSource " +
    "stencilFunc stencilFuncSeparate stencilMask stencilMaskSeparate stencilOp stencilOpSeparate " +
    "texImage2D texImage3D texParameterf texParameteri texStorage2D texStorage3D texSubImage2D " +
    "texSubImage3D transformFeedbackVaryings uniform1f uniform1fv uniform1i uniform1iv uniform1ui " +
    "uniform1uiv uniform2f uniform2fv uniform2i uniform2iv uniform2ui uniform2uiv uniform3f " +
    "uniform3fv uniform3i uniform3iv uniform3ui uniform3uiv uniform4f uniform4fv uniform4i " +
    "uniform4iv uniform4ui uniform4uiv uniformBlockBinding uniformMatrix2fv uniformMatrix2x3fv " +
    "uniformMatrix2x4fv uniformMatrix3fv uniformMatrix3x2fv uniformMatrix3x4fv uniformMatrix4fv " +
    "uniformMatrix4x2fv uniformMatrix4x3fv useProgram validateProgram vertexAttrib1f vertexAttrib1fv " +
    "vertexAttrib2f vertexAttrib2fv vertexAttrib3f vertexAttrib3fv vertexAttrib4f vertexAttrib4fv " +
    "vertexAttribDivisor vertexAttribI4i vertexAttribI4iv vertexAttribI4ui vertexAttribI4uiv " +
    "vertexAttribIPointer vertexAttribPointer viewport waitSync"
  ).split(" ")
);

function makeFakeGL(opts) {
  const o = Object.assign(
    {
      maxTextureSize: 16384,
      colorBufferFloat: true,
      failCompile: false,
      failLink: false,
      fboIncomplete: false, // checkFramebufferStatus reports incomplete
      throwOn: null, // name of a GL method that throws when called
    },
    opts || {}
  );
  const state = {
    live: new Set(), // every created object not yet deleted
    created: [], // every created object, ever
    deleted: [],
    calls: [],
    lost: false,
    canvas: null,
    texImages: [], // [{width, height, internalFormat, texture}]
    texSubImages: [], // [{unit, texture, x, y, width, height, length}]
    bufferSubDatas: [], // [{buffer, offset, byteLength}]
    draws: [], // [{mode, first, count}]
    clearColors: [], // [[r, g, b, a]]
    activeUnit: null, // the active texture unit constant
    bound: new Map(), // texture unit -> bound texture
    boundBuffer: null,
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
    checkFramebufferStatus: () => (o.fboIncomplete ? 0 : C("FRAMEBUFFER_COMPLETE")),
    isContextLost: () => state.lost,
    activeTexture(unit) {
      state.activeUnit = unit;
    },
    bindTexture(target, tex) {
      state.bound.set(state.activeUnit, tex);
    },
    bindBuffer(target, buf) {
      state.boundBuffer = buf;
    },
    texImage2D(target, level, internalFormat, width, height) {
      state.texImages.push({ width, height, internalFormat, texture: state.bound.get(state.activeUnit) });
    },
    texSubImage2D(target, level, x, y, width, height, format, type, data) {
      state.texSubImages.push({
        unit: state.activeUnit,
        texture: state.bound.get(state.activeUnit),
        x,
        y,
        width,
        height,
        length: data ? data.length : 0,
        data,
      });
    },
    bufferSubData(target, offset, data) {
      state.bufferSubDatas.push({ buffer: state.boundBuffer, offset, byteLength: data.byteLength, data });
    },
    drawArrays(mode, first, count) {
      state.draws.push({ mode, first, count });
    },
    clearColor(r, g, b, a) {
      state.clearColors.push([r, g, b, a]);
    },
  };
  const gl = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return C(prop);
      if (typeof prop !== "string") return undefined;
      const known = WEBGL2_METHODS.has(prop);
      if (!known && !(prop in target)) {
        if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return target[prop];
        throw new TypeError("fake GL: " + prop + " is not a WebGL 2 method");
      }
      const own = prop in target ? target[prop] : null;
      if (own !== null && typeof own !== "function") return own;
      return function () {
        const args = Array.prototype.slice.call(arguments);
        state.calls.push([prop].concat(args));
        if (o.throwOn === prop) throw new Error("fake GL: " + prop + " failed");
        return own ? own.apply(target, args) : undefined;
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

module.exports = { makeFakeGL, makeFakeCanvas, constantFor, WEBGL2_METHODS };
