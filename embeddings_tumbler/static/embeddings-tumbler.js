/*! embeddings-tumbler 0.10.1 | source: github.com/agentculture/embeddings-tumbler | assembled from js/src by scripts/assemble.py, do not edit by hand */
(function (root) {
  "use strict";

  // Shared internal namespace. Every later module adds its functions here
  // (ET.math = {...}, ET.contract = {...}) and reads earlier modules' from it.
  var ET = {};
  ET.version = "0.10.1";
  // The public API object. Only 50-viewer.js fills this (mount, update, destroy).
  ET.api = {};
// ---------------------------------------------------------------------------
// 30-renderer.js: WebGL 2 drawing (ET.renderer).
//
// Ported from the reference page (docs/specs/reference/embedding-tumbler-demo.html):
// glowing points, true-neighbour wires, an HDR half-float target with a mip-chain
// bloom, depth of field, trails and twinkle. What changed from the reference:
//
//   * The dimension D comes from the data. Vectors are packed four dimensions per
//     RGBA32F texel, ceil(D / 4) texels per point, several points per texture row;
//     the shader's loop bound and row packing are generated from that layout and
//     checked against MAX_TEXTURE_SIZE.
//   * The renderer draws only. The caller supplies vectors, per-point colour and
//     weight, wire pairs, the frame (three orthonormal rows of length D), the centre,
//     and the draw parameters. It computes no tour, no neighbours, reads no CSS and
//     touches no DOM beyond the canvas it is given.
//   * It has a lifecycle: dispose() frees every GPU object it made, a lost context
//     is rebuilt from the data it keeps, and without WebGL 2 it reports instead of
//     throwing.
//
// The API is documented in js/api/30-renderer.md.
// ---------------------------------------------------------------------------
ET.renderer = (function () {
  // Draw parameters. Every value here is a documented default that a mode or the
  // viewer may override per frame through draw(state).
  var DEFAULTS = Object.freeze({
    zoom: 1, // scale applied to projected coordinates before perspective
    yaw: 0, // extra 3-D turn of the projected cloud about the vertical axis (radians)
    pitch: 0, // and about the horizontal axis (radians)
    radius: 0.46, // half-extent of unit coordinates as a share of min(width, height)
    pointSize: 6.5, // base point size in device pixels (multiply by devicePixelRatio)
    minPointSize: 1.5, // floor on the drawn point size in device pixels
    gain: 1, // overall brightness of points and wires
    fallbackGain: 0.55, // brightness used when there is no HDR target
    twinkle: 0.18, // amplitude of each point's slow brightness flicker, 0 = steady
    time: 0, // seconds; drives twinkle
    dt: 1 / 60, // seconds since the previous draw; drives trail fading
    trails: 0.17, // trail persistence in seconds (0 = clear every frame)
    trailGain: 1.6, // brightness compensation while trails accumulate
    clear: false, // true: wipe the trails this frame
    wires: 0, // 0..1 opacity of the true-neighbour wires
    wireGain: 1.5, // brightness of wires at wires = 1
    dim: 1, // brightness of points whose weight is below 0.99 (1 = no dimming)
    fog: 0, // 0..1: how strongly true distance from the centre dims and shrinks points
    fogNear: 1.2, // true distance (data units) at which fog starts to clear
    fogWidth: 0.8, // distance over which fog goes from clear to full
    focus: 0, // depth of the in-focus plane after the 3-D turn (0 = the cloud centre)
    depthOfField: 1.1, // how fast points swell and dim away from the focus plane
    wireDepthOfField: 0.8, // the same for wires
    bloom: 0.55, // strength of the mip-chain glow
    exposure: 1.35, // tone-mapping exposure; bright cores burn toward white
    gamma: 0.92, // output curve
    vignette: 0.72, // brightness at the corners (1 = no vignette)
    background: Object.freeze([0, 0, 0]), // added under the image, linear RGB 0..1
  });

  var MAX_ROW_WIDTH = 4096; // preferred texture row width (texels) before widening

  function unavailable(reason, message) {
    return { ok: false, reason: reason, message: message };
  }

  // ---------- layout: how N points of dimension D sit in one RGBA32F texture ----------

  function layout(dimension, count, maxTextureSize) {
    var d = dimension | 0;
    var n = Math.max(0, count | 0);
    var max = maxTextureSize | 0;
    if (d < 1 || d !== dimension) return unavailable("bad-dimension", "Dimension must be a positive integer.");
    var texels = Math.ceil(d / 4);
    if (texels > max) {
      return unavailable(
        "dimension-too-large",
        "Dimension " + d + " needs " + texels + " texels per point; this GPU allows " + max + "."
      );
    }
    var perRow = Math.max(1, Math.floor(Math.min(max, MAX_ROW_WIDTH) / texels));
    if (Math.ceil(n / perRow) > max) perRow = Math.floor(max / texels); // widen before refusing
    var maxPoints = perRow * max;
    if (n > maxPoints) {
      return unavailable(
        "too-many-points",
        n + " points of dimension " + d + " do not fit this GPU's textures (at most " + maxPoints + ")."
      );
    }
    return {
      ok: true,
      dimension: d,
      texelsPerPoint: texels,
      floatsPerPoint: texels * 4,
      pointsPerRow: perRow,
      width: perRow * texels,
      maxTextureSize: max,
      maxPoints: maxPoints,
      rows: function (points) {
        return Math.max(1, Math.ceil(points / perRow));
      },
    };
  }

  // ---------- shaders, generated from the layout ----------

  function shaderSources(lay) {
    var T = lay.texelsPerPoint;
    var P = lay.pointsPerRow;
    var wireScale = Math.sqrt(lay.dimension / 3).toFixed(4);
    var head = "#version 300 es\nprecision highp float; precision highp int; precision highp sampler2D;\n";
    // proj(): the centred vector's coordinates along the three frame rows, plus its
    // true distance from the centre, all in the full dimension.
    var proj = [
      "uniform sampler2D uX; uniform sampler2D uF;",
      "const int TEXELS = " + T + ";",
      "const int PER_ROW = " + P + ";",
      "vec3 proj(int id, out float dist) {",
      "  int base = (id % PER_ROW) * TEXELS; int row = id / PER_ROW;",
      "  vec3 p = vec3(0.0); float dd = 0.0;",
      "  for (int k = 0; k < TEXELS; k++) {",
      "    vec4 x = texelFetch(uX, ivec2(base + k, row), 0) - texelFetch(uF, ivec2(k, 3), 0);",
      "    p += vec3(dot(x, texelFetch(uF, ivec2(k, 0), 0)), dot(x, texelFetch(uF, ivec2(k, 1), 0)),",
      "              dot(x, texelFetch(uF, ivec2(k, 2), 0)));",
      "    dd += dot(x, x);",
      "  }",
      "  dist = sqrt(dd);",
      "  return p;",
      "}",
      "uniform vec4 uRot; uniform vec2 uView; uniform float uZoom; uniform float uFocus;",
      // place(): turn by yaw and pitch, then a gentle perspective. zf is the depth
      // relative to the focus plane, used for depth of field.
      "vec4 place(vec3 p, out float zf) {",
      "  p *= uZoom;",
      "  float x1 = p.x * uRot.x + p.z * uRot.y, z1 = -p.x * uRot.y + p.z * uRot.x;",
      "  float y2 = p.y * uRot.z - z1 * uRot.w; float z2 = p.y * uRot.w + z1 * uRot.z;",
      "  float s = 3.0 / max(0.6, 3.0 + z2);",
      "  zf = z2 - uFocus;",
      "  return vec4(x1 * s * uView.x, y2 * s * uView.y, 0.0, s);",
      "}",
    ].join("\n");
    var pointVertex =
      head +
      proj +
      "\n" +
      [
        "uniform float uPx, uMinPx, uFog, uTime, uGain, uDim, uTwinkle, uDof, uFogNear, uFogWidth;",
        "layout(location = 0) in vec4 aCol;",
        "out vec3 vCol;",
        "void main() {",
        "  float fid = float(gl_VertexID);",
        "  float dist, zf;",
        "  vec4 q = place(proj(gl_VertexID, dist), zf);",
        "  gl_Position = vec4(q.xy, 0.0, 1.0);",
        "  float fog = clamp((uFogNear - dist) / uFogWidth, 0.0, 1.0);",
        "  float w = aCol.a;",
        "  float blur = 1.0 + uDof * zf * zf;", // out-of-focus points swell and dim
        "  float size = uPx * q.w * (0.55 + 1.5 * w) * blur * mix(1.0, 0.45 + 1.25 * fog, uFog);",
        "  gl_PointSize = max(size, uMinPx);",
        "  float tw = (1.0 - uTwinkle) + uTwinkle * sin(uTime * (1.3 + fract(fid * 0.618) * 2.2) + fid * 12.9898);",
        "  float a = (0.16 + 0.84 * w * w) * tw / pow(blur, 1.5) * mix(1.0, 0.22 + 0.78 * fog * fog, uFog);",
        "  vCol = aCol.rgb * a * uGain * mix(1.0, uDim, step(w, 0.99));",
        "}",
      ].join("\n");
    var pointFragment = [
      "#version 300 es",
      "precision mediump float;",
      "in vec3 vCol; out vec4 o;",
      "void main() {",
      "  vec2 q = gl_PointCoord * 2.0 - 1.0;",
      "  float r2 = dot(q, q);",
      "  if (r2 > 1.0) discard;",
      "  float g = exp(-r2 * 4.5) * (1.0 - r2) + 0.9 * exp(-r2 * 38.0);",
      "  o = vec4(vCol * g, 1.0);",
      "}",
    ].join("\n");
    var lineVertex =
      head +
      proj +
      "\n" +
      [
        "uniform float uGain, uWireDof;",
        "layout(location = 0) in uvec2 aPair;",
        "layout(location = 1) in float aLen;",
        "layout(location = 2) in vec3 aCol;",
        "out vec3 vCol;",
        "void main() {",
        "  float d0, d1, zf;",
        "  vec3 p = proj(int(aPair.x), d0), p2 = proj(int(aPair.y), d1);",
        "  vec4 q = place(p, zf);",
        "  gl_Position = vec4(q.xy, 0.0, 1.0);",
        // 1 = a typical shadow length; higher = seen nearer its true length
        "  float t = length(p - p2) / max(aLen, 1e-6) * " + wireScale + ";",
        "  vCol = aCol * (0.03 + 0.2 * t * t * t) * uGain / (1.0 + uWireDof * zf * zf);",
        "}",
      ].join("\n");
    var lineFragment =
      "#version 300 es\nprecision mediump float; in vec3 vCol; out vec4 o; void main() { o = vec4(vCol, 1.0); }";
    var quadVertex = [
      "#version 300 es",
      "out vec2 vUV;",
      "void main() {",
      "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));",
      "  vUV = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);",
      "}",
    ].join("\n");
    var fadeFragment =
      "#version 300 es\nprecision mediump float; uniform float uK; out vec4 o; void main() { o = vec4(uK, uK, uK, 1.0); }";
    var toneFragment = [
      "#version 300 es",
      "precision highp float;",
      "uniform sampler2D uT; uniform float uBloom, uExposure, uGamma, uVignette; uniform vec3 uBackground;",
      "in vec2 vUV; out vec4 o;",
      "void main() {",
      "  vec3 c = texture(uT, vUV).rgb;",
      "  vec3 bloom = textureLod(uT, vUV, 2.0).rgb * 0.5 + textureLod(uT, vUV, 3.5).rgb * 0.45",
      "             + textureLod(uT, vUV, 5.0).rgb * 0.4 + textureLod(uT, vUV, 6.5).rgb * 0.3;",
      "  c = c + bloom * uBloom;",
      "  c = 1.0 - exp(-c * uExposure);", // bright cores burn toward white
      "  float v = smoothstep(1.25, 0.35, length(vUV - 0.5) * 1.6);",
      "  o = vec4(uBackground + pow(c, vec3(uGamma)) * mix(uVignette, 1.0, v), 1.0);",
      "}",
    ].join("\n");
    return {
      pointVertex: pointVertex,
      pointFragment: pointFragment,
      lineVertex: lineVertex,
      lineFragment: lineFragment,
      quadVertex: quadVertex,
      fadeFragment: fadeFragment,
      toneFragment: toneFragment,
    };
  }

  // ---------- the screen mapping, in JavaScript (mirrors place() in the shader) ----------

  // p: [x, y, z] coordinates along the frame (already centred). Returns canvas pixels
  // (y grows downward), the perspective scale and the depth relative to the focus plane.
  function place(p, state, width, height) {
    var s = merge(state);
    var cy = Math.cos(s.yaw),
      sy = Math.sin(s.yaw),
      cp = Math.cos(s.pitch),
      sp = Math.sin(s.pitch);
    var R = Math.min(width, height) * s.radius;
    var x = p[0] * s.zoom,
      y = p[1] * s.zoom,
      z = p[2] * s.zoom;
    var x1 = x * cy + z * sy,
      z1 = -x * sy + z * cy;
    var y2 = y * cp - z1 * sp,
      z2 = y * sp + z1 * cp;
    var k = 3 / Math.max(0.6, 3 + z2);
    return { x: width / 2 + x1 * k * R, y: height / 2 - y2 * k * R, scale: k, depth: z2 - s.focus };
  }

  function merge(state) {
    var out = {};
    var key;
    for (key in DEFAULTS) out[key] = DEFAULTS[key];
    if (state) {
      for (key in state) {
        if (Object.prototype.hasOwnProperty.call(state, key) && state[key] !== undefined) {
          out[key] = state[key];
        }
      }
    }
    return out;
  }

  function isFloatArray(a) {
    return a instanceof Float32Array || (a && a.constructor && a.constructor.name === "Float32Array");
  }

  function isIndexArray(a) {
    return (
      a instanceof Uint32Array ||
      a instanceof Int32Array ||
      (a &&
        a.constructor &&
        (a.constructor.name === "Uint32Array" || a.constructor.name === "Int32Array"))
    );
  }

  // Check a block of points; returns its count.
  function checkPoints(input, dimension) {
    if (!input || !isFloatArray(input.vectors)) throw new TypeError("vectors must be a Float32Array");
    if (input.vectors.length % dimension !== 0) {
      throw new TypeError("vectors length " + input.vectors.length + " is not a multiple of dimension " + dimension);
    }
    var n = input.vectors.length / dimension;
    if (input.count !== undefined && input.count !== n) {
      throw new TypeError("count " + input.count + " does not match vectors (" + n + " points)");
    }
    if (input.colours !== undefined && input.colours !== null) {
      if (!isFloatArray(input.colours) || input.colours.length !== n * 3) {
        throw new TypeError("colours must be a Float32Array of length 3 * count");
      }
    }
    if (input.weights !== undefined && input.weights !== null) {
      if (!isFloatArray(input.weights) || input.weights.length !== n) {
        throw new TypeError("weights must be a Float32Array of length count");
      }
    }
    return n;
  }

  // ---------- one renderer bound to one canvas ----------

  function create(canvas, options) {
    var opts = options || {};
    var gl = null;
    try {
      if (canvas && typeof canvas.getContext === "function") {
        gl = canvas.getContext("webgl2", {
          alpha: !!opts.alpha,
          antialias: false,
          depth: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
          powerPreference: opts.powerPreference || "high-performance",
        });
      }
    } catch (e) {
      gl = null;
    }
    if (!gl) return unavailable("webgl2-unavailable", "WebGL 2 is not available, so the embedding view cannot be drawn.");

    var onContextChange = typeof opts.onContextChange === "function" ? opts.onContextChange : null;
    var maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;

    // Data kept on the CPU: the source for appends and for a rebuild after context loss.
    var store = {
      dimension: 0,
      count: 0,
      capacity: 0,
      lay: null,
      vectors: null, // Float32Array(capacityRows * pointsPerRow * floatsPerPoint), zero-padded
      attr: null, // Float32Array(capacity * 4): r, g, b, weight
    };
    var wires = { pairs: null, lengths: null, count: 0 };

    var gpu = null; // every GL object lives here; rebuilt after a context loss
    var lost = false;
    var disposed = false;
    var error = null; // set when a rebuild failed
    var hdr = false;
    var needClear = true;

    function track(kind, obj) {
      gpu.objects.push({ kind: kind, obj: obj });
      return obj;
    }

    function freshGpu() {
      return {
        objects: [],
        tone: null,
        fade: null,
        point: null,
        line: null,
        progLayout: null,
        quadVao: null,
        texX: null,
        texXRows: 0,
        texF: null,
        fStage: null,
        fWidth: 0,
        vboPoint: null,
        vaoPoint: null,
        vboLine: null,
        vaoLine: null,
        fbo: null,
        texHdr: null,
        hdrW: 0,
        hdrH: 0,
      };
    }

    function compile(vsSrc, fsSrc, uniformNames) {
      var prog = track("program", gl.createProgram());
      var pair = [
        [gl.VERTEX_SHADER, vsSrc],
        [gl.FRAGMENT_SHADER, fsSrc],
      ];
      var shaders = [];
      for (var i = 0; i < pair.length; i++) {
        var sh = gl.createShader(pair[i][0]);
        shaders.push(sh);
        gl.shaderSource(sh, pair[i][1]);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          var log = gl.getShaderInfoLog(sh);
          for (var j = 0; j < shaders.length; j++) gl.deleteShader(shaders[j]);
          throw new Error("shader did not compile: " + log);
        }
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      var linked = gl.getProgramParameter(prog, gl.LINK_STATUS);
      var linkLog = linked ? "" : gl.getProgramInfoLog(prog);
      for (var k = 0; k < shaders.length; k++) {
        gl.detachShader(prog, shaders[k]);
        gl.deleteShader(shaders[k]);
      }
      if (!linked) throw new Error("shader program did not link: " + linkLog);
      var u = {};
      for (var m = 0; m < uniformNames.length; m++) u[uniformNames[m]] = gl.getUniformLocation(prog, uniformNames[m]);
      return { program: prog, u: u };
    }

    function floatTexture(width, height, data) {
      var t = track("texture", gl.createTexture());
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    function release(obj) {
      // Delete one tracked GL object now (used when a texture or buffer is replaced).
      for (var i = 0; i < gpu.objects.length; i++) {
        if (gpu.objects[i].obj === obj) {
          deleteObject(gpu.objects[i]);
          gpu.objects.splice(i, 1);
          return;
        }
      }
    }

    function deleteObject(entry) {
      var o = entry.obj;
      if (!o) return;
      if (entry.kind === "texture") gl.deleteTexture(o);
      else if (entry.kind === "buffer") gl.deleteBuffer(o);
      else if (entry.kind === "program") gl.deleteProgram(o);
      else if (entry.kind === "framebuffer") gl.deleteFramebuffer(o);
      else if (entry.kind === "vertexArray") gl.deleteVertexArray(o);
    }

    function freeGpu() {
      if (!gpu) return;
      if (!lost) {
        for (var i = gpu.objects.length - 1; i >= 0; i--) deleteObject(gpu.objects[i]);
      }
      gpu = null;
    }

    // The parts that do not depend on the data: the tone and fade passes and the HDR target.
    function buildBase() {
      var src = shaderSources(layout(4, 1, Math.max(1, maxTextureSize)));
      gpu.tone = compile(src.quadVertex, src.toneFragment, [
        "uT",
        "uBloom",
        "uExposure",
        "uGamma",
        "uVignette",
        "uBackground",
      ]);
      gpu.fade = compile(src.quadVertex, src.fadeFragment, ["uK"]);
      gpu.quadVao = track("vertexArray", gl.createVertexArray());
      hdr = false;
      if (opts.hdr !== false) {
        hdr = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
      }
      if (hdr) {
        gpu.fbo = track("framebuffer", gl.createFramebuffer());
        gpu.texHdr = track("texture", gl.createTexture());
        if (!sizeHdr()) {
          // Float targets advertised but not usable here: fall back to direct drawing.
          release(gpu.fbo);
          release(gpu.texHdr);
          gpu.fbo = null;
          gpu.texHdr = null;
          hdr = false;
        }
      }
    }

    function sizeHdr() {
      var w = Math.max(1, gl.drawingBufferWidth | 0);
      var h = Math.max(1, gl.drawingBufferHeight | 0);
      if (w === gpu.hdrW && h === gpu.hdrH) return true;
      gl.bindTexture(gl.TEXTURE_2D, gpu.texHdr);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gpu.texHdr, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gpu.hdrW = w;
      gpu.hdrH = h;
      needClear = true;
      return ok;
    }

    // Programs whose loop bound and row packing come from the layout.
    function buildPrograms(lay) {
      if (gpu.progLayout && gpu.progLayout.texelsPerPoint === lay.texelsPerPoint && gpu.progLayout.pointsPerRow === lay.pointsPerRow) {
        return;
      }
      if (gpu.point) release(gpu.point.program);
      if (gpu.line) release(gpu.line.program);
      gpu.point = null;
      gpu.line = null;
      var src = shaderSources(lay);
      var view = ["uX", "uF", "uRot", "uView", "uZoom", "uFocus"];
      gpu.point = compile(
        src.pointVertex,
        src.pointFragment,
        view.concat(["uPx", "uMinPx", "uFog", "uTime", "uGain", "uDim", "uTwinkle", "uDof", "uFogNear", "uFogWidth"])
      );
      gpu.line = compile(src.lineVertex, src.lineFragment, view.concat(["uGain", "uWireDof"]));
      gpu.progLayout = lay;
      // the frame texture: rows 0..2 the frame, row 3 the centre
      if (gpu.texF) release(gpu.texF);
      gpu.fWidth = lay.texelsPerPoint;
      gpu.fStage = new Float32Array(gpu.fWidth * 4 * 4);
      gpu.texF = floatTexture(gpu.fWidth, 4, gpu.fStage);
    }

    // Upload the whole point store (texture and colour buffer) at its capacity.
    function uploadAllPoints() {
      var lay = store.lay;
      buildPrograms(lay);
      if (gpu.texX) release(gpu.texX);
      gpu.texXRows = lay.rows(store.capacity);
      gpu.texX = floatTexture(lay.width, gpu.texXRows, store.vectors);
      if (gpu.vboPoint) release(gpu.vboPoint);
      if (gpu.vaoPoint) release(gpu.vaoPoint);
      gpu.vaoPoint = track("vertexArray", gl.createVertexArray());
      gl.bindVertexArray(gpu.vaoPoint);
      gpu.vboPoint = track("buffer", gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vboPoint);
      gl.bufferData(gl.ARRAY_BUFFER, store.attr, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    function uploadWires() {
      if (gpu.vboLine) release(gpu.vboLine);
      if (gpu.vaoLine) release(gpu.vaoLine);
      gpu.vboLine = null;
      gpu.vaoLine = null;
      if (!wires.count) return;
      // per vertex, 24 bytes: u32 id, u32 other, f32 true length, f32 r, g, b
      var buf = new ArrayBuffer(wires.count * 2 * 24);
      var u32 = new Uint32Array(buf);
      var f32 = new Float32Array(buf);
      for (var e = 0; e < wires.count; e++) {
        var a = wires.pairs[2 * e],
          b = wires.pairs[2 * e + 1],
          len = wires.lengths[e];
        for (var end = 0; end < 2; end++) {
          var me = end ? b : a,
            other = end ? a : b,
            o = (2 * e + end) * 6;
          u32[o] = me;
          u32[o + 1] = other;
          f32[o + 2] = len;
          f32[o + 3] = store.attr[me * 4];
          f32[o + 4] = store.attr[me * 4 + 1];
          f32[o + 5] = store.attr[me * 4 + 2];
        }
      }
      gpu.vaoLine = track("vertexArray", gl.createVertexArray());
      gl.bindVertexArray(gpu.vaoLine);
      gpu.vboLine = track("buffer", gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vboLine);
      gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 24, 8);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 24, 12);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    // Build (or rebuild after a context loss) every GPU object from the kept data.
    function buildAll() {
      freeGpu();
      gpu = freshGpu();
      try {
        buildBase();
        if (store.lay) {
          uploadAllPoints();
          uploadWires();
        }
        needClear = true;
        return { ok: true };
      } catch (e) {
        freeGpu();
        gpu = null;
        return unavailable("shader-failed", "The view could not be drawn: " + (e && e.message ? e.message : String(e)));
      }
    }

    // Copy a block of points into the padded store starting at point `at`.
    function writePoints(input, n, at) {
      var d = store.dimension,
        stride = store.lay.floatsPerPoint,
        v = input.vectors;
      var pad = stride !== d;
      if (!pad) {
        store.vectors.set(v, at * stride);
      } else {
        for (var i = 0; i < n; i++) store.vectors.set(v.subarray(i * d, i * d + d), (at + i) * stride);
      }
      var c = input.colours,
        w = input.weights;
      for (var j = 0; j < n; j++) {
        var o = (at + j) * 4;
        store.attr[o] = c ? c[j * 3] : 1;
        store.attr[o + 1] = c ? c[j * 3 + 1] : 1;
        store.attr[o + 2] = c ? c[j * 3 + 2] : 1;
        store.attr[o + 3] = w ? w[j] : 1;
      }
    }

    function allocate(lay, capacity) {
      var rows = lay.rows(capacity);
      var vec = new Float32Array(rows * lay.pointsPerRow * lay.floatsPerPoint);
      var attr = new Float32Array(Math.max(1, capacity) * 4);
      return { vectors: vec, attr: attr };
    }

    function usable() {
      return !disposed && !lost && gpu !== null;
    }

    var api = {
      // Replace all points. Returns { ok: true, layout } or { ok: false, reason, message }.
      setData: function (input) {
        if (disposed) return unavailable("disposed", "The renderer has been disposed.");
        var d = input && input.dimension;
        if (typeof d !== "number" || d < 1 || Math.floor(d) !== d) throw new TypeError("dimension must be a positive integer");
        var n = checkPoints(input, d);
        var lay = layout(d, n, maxTextureSize);
        if (!lay.ok) return lay;
        var cap = Math.max(1, n);
        var mem = allocate(lay, cap);
        store.dimension = d;
        store.count = n;
        store.capacity = cap;
        store.lay = lay;
        store.vectors = mem.vectors;
        store.attr = mem.attr;
        writePoints(input, n, 0);
        wires = { pairs: null, lengths: null, count: 0 };
        needClear = true;
        if (usable()) {
          try {
            uploadAllPoints();
            uploadWires();
          } catch (e) {
            error = unavailable("shader-failed", "The view could not be drawn: " + e.message);
            return error;
          }
        }
        return { ok: true, layout: lay };
      },

      // Add points after the existing ones. Wires are kept. Returns
      // { ok: true, reallocated } (reallocated: the GPU copy was rebuilt at a larger size).
      appendData: function (input) {
        if (disposed) return unavailable("disposed", "The renderer has been disposed.");
        if (!store.lay) throw new TypeError("appendData needs a prior setData");
        if (input.dimension !== undefined && input.dimension !== store.dimension) {
          throw new TypeError("dimension " + input.dimension + " differs from the data's " + store.dimension);
        }
        var n = checkPoints(input, store.dimension);
        if (n === 0) return { ok: true, reallocated: false };
        var total = store.count + n;
        var lay = store.lay;
        var reallocated = false;
        if (total > store.capacity) {
          if (total > lay.maxPoints) {
            lay = layout(store.dimension, total, maxTextureSize);
            if (!lay.ok) return lay;
          }
          var cap = Math.min(lay.maxPoints, Math.max(total, store.capacity * 2));
          var mem = allocate(lay, cap);
          // points are contiguous at a fixed stride whatever the row packing
          mem.vectors.set(store.vectors.subarray(0, store.count * lay.floatsPerPoint));
          mem.attr.set(store.attr.subarray(0, store.count * 4));
          store.vectors = mem.vectors;
          store.attr = mem.attr;
          store.capacity = cap;
          store.lay = lay;
          reallocated = true;
        }
        var first = store.count;
        writePoints(input, n, first);
        store.count = total;
        if (usable()) {
          if (reallocated) {
            uploadAllPoints();
          } else {
            // only the texture rows the new points touch, and their slice of the colour buffer
            var P = lay.pointsPerRow,
              r0 = Math.floor(first / P),
              r1 = Math.floor((total - 1) / P),
              rowFloats = lay.width * 4;
            gl.bindTexture(gl.TEXTURE_2D, gpu.texX);
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              r0,
              lay.width,
              r1 - r0 + 1,
              gl.RGBA,
              gl.FLOAT,
              store.vectors.subarray(r0 * rowFloats, (r1 + 1) * rowFloats)
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vboPoint);
            gl.bufferSubData(gl.ARRAY_BUFFER, first * 16, store.attr.subarray(first * 4, total * 4));
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
          }
        }
        return { ok: true, reallocated: reallocated };
      },

      // Neighbour wires as index pairs (two per wire). lengths: optional true distances,
      // one per wire; measured from the kept vectors when absent.
      setWires: function (pairs, lengths) {
        if (disposed) return;
        if (!isIndexArray(pairs)) throw new TypeError("pairs must be a Uint32Array (or Int32Array)");
        if (pairs.length % 2 !== 0) throw new TypeError("pairs must hold two indices per wire");
        var m = pairs.length / 2;
        for (var i = 0; i < pairs.length; i++) {
          if (pairs[i] < 0 || pairs[i] >= store.count) {
            throw new RangeError("wire endpoint " + pairs[i] + " is not a point index (count " + store.count + ")");
          }
        }
        var lens;
        if (lengths !== undefined && lengths !== null) {
          if (!isFloatArray(lengths) || lengths.length !== m) throw new TypeError("lengths must be a Float32Array, one per wire");
          lens = lengths;
        } else {
          lens = new Float32Array(m);
          var stride = store.lay ? store.lay.floatsPerPoint : 0;
          for (var e = 0; e < m; e++) {
            var a = pairs[2 * e] * stride,
              b = pairs[2 * e + 1] * stride,
              s = 0;
            for (var k = 0; k < stride; k++) {
              var t = store.vectors[a + k] - store.vectors[b + k];
              s += t * t;
            }
            lens[e] = Math.sqrt(s);
          }
        }
        wires = { pairs: new Uint32Array(pairs), lengths: new Float32Array(lens), count: m };
        if (usable()) uploadWires();
      },

      // Set the drawing-buffer size in device pixels.
      resize: function (width, height) {
        if (disposed || !canvas) return;
        var w = Math.max(1, Math.round(width)),
          h = Math.max(1, Math.round(height));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        needClear = true;
      },

      // Draw one frame. state: see DEFAULTS, plus frame (Float32Array 3 * D) and
      // centre (Float32Array D, default zeros). Returns false when nothing could be
      // drawn (disposed, context lost, failed rebuild).
      draw: function (state) {
        if (!usable()) return false;
        var s = merge(state);
        var D = store.dimension;
        var hasData = store.count > 0 && gpu.point;
        if (hasData) {
          if (!isFloatArray(s.frame) || s.frame.length !== 3 * D) throw new TypeError("frame must be a Float32Array of length 3 * " + D);
          if (s.centre !== undefined && s.centre !== null && (!isFloatArray(s.centre) || s.centre.length !== D)) {
            throw new TypeError("centre must be a Float32Array of length " + D);
          }
          var st = gpu.fStage,
            row = gpu.fWidth * 4;
          st.fill(0);
          for (var a = 0; a < 3; a++) st.set(s.frame.subarray(a * D, a * D + D), a * row);
          if (s.centre) st.set(s.centre, 3 * row);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, gpu.texF);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gpu.fWidth, 4, gl.RGBA, gl.FLOAT, st);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, gpu.texX);
        }
        if (hdr && !sizeHdr()) {
          // the target became unusable at this size; fall back for good
          release(gpu.fbo);
          release(gpu.texHdr);
          gpu.fbo = null;
          gpu.texHdr = null;
          hdr = false;
        }
        var W = Math.max(1, gl.drawingBufferWidth | 0),
          H = Math.max(1, gl.drawingBufferHeight | 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, hdr ? gpu.fbo : null);
        gl.viewport(0, 0, W, H);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        var gain = s.gain * (hdr ? 1 : s.fallbackGain);
        var bg = s.background || DEFAULTS.background;
        if (needClear || s.clear || !(s.trails > 0) || !hdr) {
          if (hdr) gl.clearColor(0, 0, 0, 1);
          else gl.clearColor(bg[0], bg[1], bg[2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          needClear = false;
        } else {
          // dim what is already there instead of wiping it: motion leaves trails
          var k = Math.exp(-Math.max(0, s.dt) / s.trails);
          gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
          gl.useProgram(gpu.fade.program);
          gl.uniform1f(gpu.fade.u.uK, k);
          gl.bindVertexArray(gpu.quadVao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gain *= (1 - k) * s.trailGain;
        }
        gl.blendFunc(gl.ONE, gl.ONE);
        if (hasData) {
          var R = Math.min(W, H) * s.radius;
          var rot = [Math.cos(s.yaw), Math.sin(s.yaw), Math.cos(s.pitch), Math.sin(s.pitch)];
          var setView = function (p) {
            gl.useProgram(p.program);
            gl.uniform1i(p.u.uX, 0);
            gl.uniform1i(p.u.uF, 1);
            gl.uniform4f(p.u.uRot, rot[0], rot[1], rot[2], rot[3]);
            gl.uniform2f(p.u.uView, (2 * R) / W, (2 * R) / H);
            gl.uniform1f(p.u.uZoom, s.zoom);
            gl.uniform1f(p.u.uFocus, s.focus);
          };
          if (wires.count && s.wires > 0.02 && gpu.vaoLine) {
            setView(gpu.line);
            gl.uniform1f(gpu.line.u.uGain, gain * s.wires * s.wireGain);
            gl.uniform1f(gpu.line.u.uWireDof, s.wireDepthOfField);
            gl.bindVertexArray(gpu.vaoLine);
            gl.drawArrays(gl.LINES, 0, wires.count * 2);
          }
          var pu = gpu.point.u;
          setView(gpu.point);
          gl.uniform1f(pu.uPx, s.pointSize);
          gl.uniform1f(pu.uMinPx, s.minPointSize);
          gl.uniform1f(pu.uFog, s.fog);
          gl.uniform1f(pu.uTime, s.time);
          gl.uniform1f(pu.uGain, gain);
          gl.uniform1f(pu.uDim, s.dim);
          gl.uniform1f(pu.uTwinkle, s.twinkle);
          gl.uniform1f(pu.uDof, s.depthOfField);
          gl.uniform1f(pu.uFogNear, s.fogNear);
          gl.uniform1f(pu.uFogWidth, Math.max(1e-6, s.fogWidth));
          gl.bindVertexArray(gpu.vaoPoint);
          gl.drawArrays(gl.POINTS, 0, store.count);
        }
        if (hdr) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.disable(gl.BLEND);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, gpu.texHdr);
          gl.generateMipmap(gl.TEXTURE_2D);
          var tu = gpu.tone.u;
          gl.useProgram(gpu.tone.program);
          gl.uniform1i(tu.uT, 2);
          gl.uniform1f(tu.uBloom, s.bloom);
          gl.uniform1f(tu.uExposure, s.exposure);
          gl.uniform1f(tu.uGamma, s.gamma);
          gl.uniform1f(tu.uVignette, s.vignette);
          gl.uniform3f(tu.uBackground, bg[0], bg[1], bg[2]);
          gl.bindVertexArray(gpu.quadVao);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.activeTexture(gl.TEXTURE0);
        }
        gl.bindVertexArray(null);
        return true;
      },

      status: function () {
        return {
          ok: !disposed && error === null,
          available: true,
          disposed: disposed,
          lost: lost,
          hdr: hdr,
          error: error ? error.message : null,
          dimension: store.dimension,
          count: store.count,
          capacity: store.capacity,
          wires: wires.count,
          maxTextureSize: maxTextureSize,
          layout: store.lay,
        };
      },

      // Free every GPU object this renderer made and stop listening to the canvas.
      dispose: function () {
        if (disposed) return;
        canvas.removeEventListener("webglcontextlost", onLost);
        canvas.removeEventListener("webglcontextrestored", onRestored);
        freeGpu();
        disposed = true;
        store.vectors = null;
        store.attr = null;
        wires = { pairs: null, lengths: null, count: 0 };
        if (opts.releaseContext && !lost) {
          var ext = gl.getExtension("WEBGL_lose_context");
          if (ext) ext.loseContext();
        }
      },
    };

    function notify(type, message) {
      if (onContextChange) onContextChange({ type: type, message: message || "" });
    }

    function onLost(ev) {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault(); // allow a restore
      lost = true;
      if (gpu) gpu = null; // the GPU objects are gone with the context; nothing to delete
      notify("lost", "The graphics context was lost; drawing is paused until it is restored.");
    }

    function onRestored() {
      if (disposed) return;
      lost = false;
      var res = buildAll();
      if (res.ok) {
        error = null;
        notify("restored", "");
      } else {
        error = res;
        notify("restore-failed", res.message);
      }
    }

    canvas.addEventListener("webglcontextlost", onLost, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);

    var built = buildAll();
    if (!built.ok) {
      api.dispose();
      return built;
    }
    return { ok: true, renderer: api };
  }

  return {
    DEFAULTS: DEFAULTS,
    layout: layout,
    shaderSources: shaderSources,
    place: place,
    create: create,
  };
})();

  // Export. Public API only; ET is reachable as api._internal for tests.
  var api = ET.api;
  api.version = ET.version;
  Object.defineProperty(api, "_internal", { value: ET, enumerable: false });

  if (typeof module === "object" && module !== null && module.exports) {
    module.exports = api; // node (tests)
  } else {
    root.EmbeddingsTumbler = api; // classic script tag: one global
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
