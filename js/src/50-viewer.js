// ---------------------------------------------------------------------------
// 50-viewer.js: the public viewer API (task t8).
//
//   EmbeddingsTumbler.mount(el, options)  -> handle
//   EmbeddingsTumbler.update(el, data)    -> result   (also handle.update(data))
//   EmbeddingsTumbler.destroy(el)         -> boolean  (also handle.destroy())
//
// The viewer owns the DOM inside the host's element, the renderer, the clock, the
// active mode, labels, controls, the readout strip and the provenance block. It
// validates data with ET.contract, draws with ET.renderer and moves with ET.modes.
//
// Rules this module keeps (see js/api/50-viewer.md):
//   * It changes nothing outside the given element: one child element is appended
//     to it and removed again by destroy. No global style, no class on the page,
//     no global variable. Listeners on the document (visibility) and window
//     (resize, only without ResizeObserver) are removed by destroy.
//   * Every style is set through element.style from script, never through a style
//     attribute or a style element, so a strict style-src policy allows it.
//   * Text from data goes in with textContent only. Nothing parses markup.
//   * It makes no network request of any kind and builds no resource address.
//   * Bad data never throws into the host: the refusal is shown inside the element
//     and returned to the caller.
//   * No frame work runs while the document is hidden or the element is off
//     screen: the animation loop is not scheduled at all then.
// ---------------------------------------------------------------------------
ET.viewer = (function () {
  var TAU = Math.PI * 2;

  // The reference's look. Group hues are the reference's, in its region order;
  // groups take them in order of first appearance in the data.
  var GROUP_HUES = [28, 52, 96, 140, 170, 198, 226, 266, 328, 4, 298];
  var MAX_GROUP_PROPS = 24; // --tumbler-group-1 .. --tumbler-group-24
  var DARK = {
    background: "#04060b",
    sky: "#0b1430",
    foreground: "#e9eef6",
    muted: "#8a96ab",
    line: "#1b2436",
    accent: "#ffc56b",
    ungrouped: "#8cadff",
  };
  var LIGHT = {
    background: "#f6f4ee",
    sky: "#ffffff",
    foreground: "#1b2130",
    muted: "#5b6578",
    line: "#d6dae2",
    accent: "#a35f00",
    ungrouped: "#8cadff",
  };
  // The readout strip's three axis colours (horizontal, vertical, depth), 0-255. Fixed, not
  // themable. The light pair is darker so cells and legend words read on a light panel.
  var AXIS_RGB_DARK = [[255, 150, 60], [80, 220, 160], [130, 140, 255]];
  var AXIS_RGB_LIGHT = [[176, 84, 0], [0, 128, 82], [72, 82, 214]];
  var AXIS_NAMES = ["horizontal", "vertical", "depth"];
  var FONTS = {
    body: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    data: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    display: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  };
  var STAGE_HEIGHT = "clamp(300px, 62vh, 860px)";

  var DEFAULT_OPTIONS = {
    mode: "tumble",
    seed: 1,
    speed: 1,
    paused: null, // null: follow prefers-reduced-motion
    labels: true,
    trails: true,
    controls: true,
    readout: true,
    masthead: true,
    title: "",
    provenanceOpen: true,
    modeOptions: null, // { tumble: {...}, ... } passed to ET.modes.create
    maxPixelRatio: 2,
    preserveDrawingBuffer: false,
    prepareBudgetMs: 8,
    // Keep the slow spin running while a mode prepares, so the view never looks frozen
    // (owner's phone report, 2026-11-14). false: hold the picture still until ready, as 0.11.6.
    spinWhilePreparing: true,
    // Lower the drawing-buffer ratio in steps (never below 1) when the frame rate stays
    // under ADAPT_FPS while nothing prepares. false: always draw at the capped device ratio.
    adaptivePixelRatio: false, // off until the owner decides: it trades sharpness for frame rate
    refitQuietSeconds: 2,
    refitShare: 0.01,
    onError: null,
    onModeChange: null,
    onPauseChange: null,
    // Search (docs/search-interface.md, "Viewer (t8)").
    embed: null, // the host's embed(text) callback
    rerank: null, // the host's rerank(query, candidates) callback
    searchTimeoutMs: 15000,
    searchPanel: true,
    searchK: 8,
    searchCandidates: 50, // candidates handed to the reranker (3 to 100)
    searchTop: 20, // reranked candidates kept (3 to searchCandidates)
    searchLit: "even",
    onSearchChange: null,
    // Tumble's relative settings at mount (docs/relative-interface.md, "Viewer (t9, t10)").
    relative: false,
    showOrigin: false,
  };

  var CROWD_REF = 600; // bright points a view shows at full brightness (see crowding)
  var CROWD_POWER = 1;
  var BRIGHT_WEIGHT = 0.7; // a point painted at this weight or more counts toward the light load
  var LABEL_SAMPLE = 300; // labelled points projected on the CPU per frame for labels
  var LABEL_POOL = 64; // label elements at most
  var STATUS_EVERY = 0.12; // seconds between status-line updates (the reference's)
  var ZOOM_MIN = 0.2;
  var ZOOM_MAX = 12;
  // The user pan (task t17) is the renderer's draw key pan: [x, y] in units of the stage's
  // R = min(W, H) * radius (one unit of the picture after zoom and perspective), x to the right
  // and y up. An arrow key moves the picture by PAN_STEP of those units.
  var PAN_STEP = 0.1;
  var SPIN = 0.06; // rad/s of yaw while running (the reference's)
  // Heavy work's budget per frame (see "Heavy work" in js/api/50-viewer.md): a share of the
  // measured frame interval, between prepareBudgetMs and BUDGET_CEILING times it; cut to half
  // of prepareBudgetMs for one frame only when the work itself overran (a unit far longer
  // than asked: cold code, a collection): more than OVERRUN_FLOOR_MS, and more than
  // OVERRUN_MS past the budget it had.
  var WORK_SHARE = 1 / 3;
  var BUDGET_CEILING = 3;
  var OVERRUN_FLOOR_MS = 16;
  var OVERRUN_MS = 8;
  var PAUSED_BUDGET_MS = 40; // a paused view has no motion to keep smooth
  var INTERVAL_GAP_MS = 250; // a longer gap between frames is a pause, not a frame interval
  // Drawing-buffer ratio steps (adaptivePixelRatio): ADAPT_SECONDS measured seconds in a row
  // under ADAPT_FPS, while running and not preparing, lower it by ADAPT_STEP (never below 1).
  var ADAPT_FPS = 25; // under a 30 fps cap (iOS Low Power Mode), never below a measured 29.x
  var ADAPT_SECONDS = 2;
  var ADAPT_STEP = 0.5;
  // The most wire light per pixel, where the wires' light lands, before the wires are
  // scaled down (the renderer's draw key wireLoad; see "Crowded wires" in js/api/50-viewer.md).
  var WIRE_LOAD = 8;
  var BUTTON_HEIGHT = "28px"; // the reference's Pause button
  var TOUCH_HEIGHT = "32px"; // the same buttons under 600 px wide
  // Spacing and sizes a host may adjust: each is set inline as var(--tumbler-<name>,
  // <default>), so a host stylesheet sets the custom property (no !important needed) and,
  // with none set, the browser uses the viewer's own value. The browser resolves var()
  // live, so these are never read into the theme. Two have a narrow value below 600 px
  // (layoutForWidth); a host's property wins at every width. Documented in js/api/50-viewer.md.
  var PANEL_PADDING = { wide: "6px 16px 16px", narrow: "6px 12px 14px" };
  var MODE_TITLE_SIZE = { wide: "24px", narrow: "20px" };
  function spaced(name, fallback) {
    return "var(--tumbler-" + name + ", " + fallback + ")";
  }
  // Names over the sky: the reference strokes each name with a 4 px line of the
  // background at 0.85 under the fill. As page text that is a ring of hard
  // shadows: 8 at 1.5 px (slightly soft) and 8 at 2 px (half strength), which
  // came closest to the reference's canvas stroke in Chromium (measured against
  // it) and needs nothing beyond text-shadow, so every browser draws it.
  var OUTLINE_RING = (function () {
    var out = [];
    for (var k = 0; k < 8; k++) {
      var th = (Math.PI * 2 * k) / 8;
      out.push([Math.cos(th), Math.sin(th)]);
    }
    return out;
  })();
  var SHADOW =
    "A projection is a shadow of the space, not the space: each view shows three " +
    "linear directions out of all of them, so points that look close may be far apart " +
    "and points that look apart may be close.";

  // Registry of live viewers, keyed by element. Nothing else is shared between viewers.
  var live = typeof WeakMap === "function" ? new WeakMap() : null;
  var liveList = []; // fallback when WeakMap is missing: [{ el, v }]

  function lookup(el) {
    if (!el || typeof el !== "object") return null;
    if (live) return live.get(el) || null;
    for (var rec of liveList) if (rec.el === el) return rec.v;
    return null;
  }
  function remember(el, v) {
    if (live) live.set(el, v);
    else liveList.push({ el: el, v: v });
  }
  function forget(el) {
    if (live) live.delete(el);
    else liveList = liveList.filter(function (r) {
      return r.el !== el;
    });
  }

  // ---------- small pure helpers ----------

  function clamp(x, lo, hi) {
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
  }

  function hsl(h, s, l) {
    function f(n) {
      var k = (n + h / 30) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    }
    return [f(0), f(8), f(4)];
  }

  function hashUnit(i) {
    var x = Math.abs(Math.sin(i * 12.9898) * 43758.5453);
    return x - Math.floor(x);
  }

  function thousands(n) {
    var s = String(Math.round(n));
    var neg = s.startsWith("-");
    if (neg) s = s.slice(1);
    var out = "";
    while (s.length > 3) {
      out = "," + s.slice(-3) + out;
      s = s.slice(0, -3);
    }
    return (neg ? "-" : "") + s + out;
  }

  function percent(x, digits) {
    return (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  function shorten(text, max) {
    var s = String(text);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // Parse a CSS colour into [r, g, b] (0..1). Hex, rgb()/rgba() and hsl()/hsla() in
  // comma or space syntax. Returns null for anything else.
  function parseColour(str) {
    if (typeof str !== "string") return null;
    var s = str.trim().toLowerCase();
    if (!s) return null;
    var m = /^#([0-9a-f]{3,8})$/.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) {
        return [0, 1, 2].map(function (i) {
          return Number.parseInt(h.charAt(i) + h.charAt(i), 16) / 255;
        });
      }
      if (h.length === 6 || h.length === 8) {
        return [0, 2, 4].map(function (i) {
          return Number.parseInt(h.slice(i, i + 2), 16) / 255;
        });
      }
      return null;
    }
    m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
    if (!m) return null;
    var parts = m[2].split(/[\s,/]+/).filter(function (p) {
      return p !== "";
    });
    if (parts.length < 3) return null;
    function num(p, scale) {
      var pct = p.endsWith("%");
      var x = Number.parseFloat(p);
      if (!Number.isFinite(x)) return Number.NaN;
      return pct ? x / 100 : x / scale;
    }
    if (m[1].startsWith("r")) {
      var rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
      if (rgb.some(Number.isNaN)) return null;
      return rgb.map(function (c) {
        return clamp(c, 0, 1);
      });
    }
    var hue = Number.parseFloat(parts[0]);
    var sat = num(parts[1], 100);
    var lig = num(parts[2], 100);
    if (!Number.isFinite(hue) || Number.isNaN(sat) || Number.isNaN(lig)) return null;
    return hsl(((hue % 360) + 360) % 360, clamp(sat, 0, 1), clamp(lig, 0, 1));
  }

  function cssRgb(c, alpha) {
    var r = Math.round(clamp(c[0], 0, 1) * 255);
    var g = Math.round(clamp(c[1], 0, 1) * 255);
    var b = Math.round(clamp(c[2], 0, 1) * 255);
    if (alpha === undefined || alpha >= 1) return "rgb(" + r + ", " + g + ", " + b + ")";
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function luminance(c) {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  // A value the host may put in a font or length property. Anything that could name
  // a resource is refused (only plain names, numbers and length functions pass).
  function safeCssValue(s) {
    if (typeof s !== "string") return "";
    var t = s.trim();
    if (!t || t.length > 300) return "";
    if (/url\s*\x28|image-set|\\|[;{}<>]/i.test(t)) return "";
    return t;
  }

  function setStyles(el, styles) {
    var st = el.style;
    for (var k in styles) {
      if (Object.hasOwn(styles, k)) st[k] = styles[k];
    }
  }

  function readOption(options, key) {
    if (options && Object.hasOwn(options, key) && options[key] !== undefined) {
      return options[key];
    }
    return DEFAULT_OPTIONS[key];
  }

  function isElement(el) {
    return (
      !!el &&
      typeof el === "object" &&
      el.nodeType === 1 &&
      typeof el.appendChild === "function" &&
      !!el.ownerDocument
    );
  }

  function call(v, fn, arg) {
    if (typeof fn !== "function") return;
    try {
      fn(arg);
    } catch (err) {
      reportHostError(v, err);
    }
  }

  // A host callback's own error is the host's: rethrow it on a later task, outside the
  // viewer's stack, so the host's error handling sees it and the viewer keeps running.
  // Without setTimeout, a microtask; without that, console.error. Never dropped.
  function reportHostError(v, err) {
    var w = v.win || {};
    var rethrow = function () {
      throw err;
    };
    if (typeof w.setTimeout === "function") w.setTimeout(rethrow, 0);
    else if (typeof w.queueMicrotask === "function") w.queueMicrotask(rethrow);
    else {
      var c = w.console || (typeof console !== "undefined" ? console : null);
      if (typeof c?.error === "function") c.error("embeddings-tumbler: a host callback threw", err);
    }
  }

  // ---------- DOM building ----------

  function make(v, tag, cls, styles) {
    var el = v.doc.createElement(tag);
    if (cls) el.className = cls;
    if (styles) setStyles(el, styles);
    return el;
  }

  function text(v, tag, cls, str, styles) {
    var el = make(v, tag, cls, styles);
    el.textContent = str;
    return el;
  }

  function pillButton(v, cls, label) {
    var b = text(v, "button", cls, label, {
      fontFamily: "inherit",
      fontSize: "12px",
      lineHeight: "1.15",
      color: "inherit",
      background: "transparent",
      border: "1px solid",
      borderRadius: "999px",
      // The reference's .ctl button: 6 px by 16 px padding, at least 76 px wide,
      // 28 px tall at 12 px type. Under 600 px wide layoutForWidth raises the
      // height to TOUCH_HEIGHT for fingers.
      padding: "6px 16px",
      minHeight: BUTTON_HEIGHT,
      minWidth: "76px",
      cursor: "pointer",
      margin: "0",
    });
    b.type = "button";
    return b;
  }

  function build(v) {
    var root = make(v, "div", "tumbler", {
      position: "relative",
      display: "block",
      width: "100%",
      boxSizing: "border-box",
      margin: "0",
      padding: "0",
      textAlign: "left",
      fontSize: "14px",
      lineHeight: "1.5",
      overflowWrap: "break-word",
    });
    root.tabIndex = 0;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Embedding space viewer");
    root.setAttribute("aria-roledescription", "embedding space viewer");
    v.root = root;

    var stage = make(v, "div", "tumbler-stage", {
      position: "relative",
      width: "100%",
      overflow: "hidden",
      touchAction: "pan-y",
      cursor: "grab",
      isolation: "isolate",
      userSelect: "none",
      webkitUserSelect: "none",
    });
    v.stage = stage;
    var full = { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "block" };
    var gl = make(v, "canvas", "tumbler-canvas", full);
    gl.setAttribute("role", "img");
    gl.setAttribute("aria-label", "Animated 3-D projection of an embedding space (no data yet)");
    v.canvas = gl;
    var overlay = make(v, "canvas", "tumbler-overlay", full);
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.pointerEvents = "none";
    v.overlay = overlay;
    var labels = make(v, "div", "tumbler-labels", {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      overflow: "hidden",
      pointerEvents: "none",
    });
    labels.setAttribute("aria-hidden", "true");
    v.labelLayer = labels;
    // The relative overlay's texts (ruler ticks, title, result labels, origin): DOM spans
    // placed by ET.relativeOverlay.placeLabels, right after the overlay canvas.
    var relLabels = make(v, "div", "tumbler-relative-labels", {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      overflow: "hidden",
      pointerEvents: "none",
    });
    relLabels.setAttribute("aria-hidden", "true");
    v.relLabelLayer = relLabels;

    var mast = make(v, "div", "tumbler-masthead", {
      position: "absolute",
      top: spaced("masthead-top", "14px"),
      left: spaced("masthead-left", "16px"),
      right: spaced("masthead-right", "16px"),
      pointerEvents: "none",
      zIndex: "2",
    });
    v.mastTitle = text(v, "p", "tumbler-title", "", {
      margin: spaced("title-margin", "0 0 6px"),
      fontStyle: "italic",
      fontWeight: "400",
      fontSize: spaced("title-size", "clamp(28px, 6vw, 56px)"),
      lineHeight: "0.95",
    });
    v.mastLine = text(v, "p", "tumbler-subtitle", "", {
      margin: "0",
      fontSize: "12px",
      letterSpacing: "0.06em",
      textTransform: "uppercase",
    });
    mast.appendChild(v.mastTitle);
    mast.appendChild(v.mastLine);
    v.masthead = mast;

    var status = text(v, "p", "tumbler-status", "waiting for data", {
      position: "absolute",
      left: spaced("status-left", "16px"),
      right: spaced("status-right", "16px"),
      bottom: spaced("status-bottom", "10px"),
      margin: "0",
      fontSize: "12px",
      lineHeight: "1.4",
      pointerEvents: "none",
      zIndex: "2",
      whiteSpace: "normal",
      fontVariantNumeric: "tabular-nums",
    });
    status.setAttribute("aria-live", "off");
    v.status = status;

    var fatal = make(v, "div", "tumbler-message", {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      textAlign: "center",
      zIndex: "4",
      boxSizing: "border-box",
    });
    fatal.setAttribute("role", "alert");
    v.fatalText = text(v, "p", "tumbler-message-text", "", { margin: "0", maxWidth: "52ch" });
    fatal.appendChild(v.fatalText);
    v.fatal = fatal;

    var notice = make(v, "div", "tumbler-notice", {
      position: "absolute",
      left: "12px",
      right: "12px",
      top: "12px",
      display: "none",
      alignItems: "flex-start",
      gap: "10px",
      padding: "8px 10px 8px 12px",
      fontSize: "12px",
      lineHeight: "1.45",
      border: "1px solid",
      borderRadius: "6px",
      zIndex: "3",
      boxSizing: "border-box",
    });
    notice.setAttribute("role", "alert");
    v.noticeText = text(v, "p", "tumbler-notice-text", "", { margin: "0", flex: "1 1 auto", minWidth: "0" });
    var dismiss = pillButton(v, "tumbler-notice-dismiss", "Dismiss");
    dismiss.style.flex = "0 0 auto";
    dismiss.style.minWidth = "0";
    dismiss.style.padding = "2px 10px";
    dismiss.style.minHeight = "24px";
    notice.appendChild(v.noticeText);
    notice.appendChild(dismiss);
    v.notice = notice;
    v.noticeDismiss = dismiss;

    stage.appendChild(gl);
    stage.appendChild(overlay);
    stage.appendChild(relLabels);
    stage.appendChild(labels);
    stage.appendChild(mast);
    stage.appendChild(status);
    stage.appendChild(notice);
    stage.appendChild(fatal);
    var empty = text(v, "p", "tumbler-empty", "No data yet. Call update(data) to show a set of embeddings.", {
      position: "absolute",
      left: "16px",
      right: "16px",
      top: "50%",
      margin: "0",
      transform: "translateY(-50%)",
      textAlign: "center",
      fontSize: "13px",
      pointerEvents: "none",
      zIndex: "2",
    });
    stage.appendChild(empty);
    v.empty = empty;
    root.appendChild(stage);

    var panel = make(v, "div", "tumbler-panel", {
      display: "flex",
      flexDirection: "column",
      gap: spaced("panel-gap", "14px"),
      padding: spaced("panel-padding", PANEL_PADDING.wide),
    });
    v.panel = panel;

    // Mode switch: one button per registered mode.
    var nav = make(v, "div", "tumbler-modes", { display: "grid", gap: "0", borderTop: "1px solid" });
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", "View");
    v.modeNav = nav;
    v.modeButtons = [];
    var defs = ET.modes.list();
    nav.style.gridTemplateColumns = "repeat(" + Math.max(1, defs.length) + ", minmax(0, 1fr))";
    defs.forEach(function (def, i) {
      var b = make(v, "button", "tumbler-mode", {
        font: "inherit",
        textAlign: "left",
        background: "transparent",
        border: "0",
        borderTop: "2px solid transparent",
        marginTop: "-1px",
        padding: spaced("mode-padding", "10px 12px 8px 0"),
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        minWidth: "0",
        minHeight: "44px",
        color: "inherit",
      });
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.dataset.mode = def.id;
      b.setAttribute("aria-keyshortcuts", i < 9 ? String(i + 1) : "");
      var title = text(v, "b", "tumbler-mode-title", def.title, {
        fontWeight: "400",
        fontSize: spaced("mode-title-size", MODE_TITLE_SIZE.wide),
        lineHeight: "1.1",
      });
      var summary = text(v, "span", "tumbler-mode-summary", def.summary || "", {
        fontSize: spaced("mode-summary-size", "12.5px"),
        lineHeight: "1.35",
      });
      b.appendChild(title);
      b.appendChild(summary);
      nav.appendChild(b);
      v.modeButtons.push({ id: def.id, button: b, title: title, summary: summary });
    });
    panel.appendChild(nav);

    // Readout strip: one cell per dimension of the current frame.
    var readout = make(v, "div", "tumbler-readout", { display: "flex", flexDirection: "column", gap: "6px" });
    // The reference's strip: 22 px of cells between a 1 px line above and below
    // (24 px in all), whatever box-sizing the host page sets.
    var strip = make(v, "canvas", "tumbler-strip", {
      width: "100%",
      height: "22px",
      boxSizing: "content-box",
      display: "block",
      imageRendering: "pixelated",
      borderTop: "1px solid",
      borderBottom: "1px solid",
    });
    strip.width = 1;
    strip.height = 1;
    strip.setAttribute("aria-hidden", "true");
    v.strip = strip;
    var caption = make(v, "p", "tumbler-readout-caption", {
      display: "flex",
      justifyContent: "space-between",
      gap: "4px 12px",
      flexWrap: "wrap",
      margin: "0",
      fontSize: spaced("readout-caption-size", "11.5px"),
    });
    v.stripFirst = text(v, "span", "", "dimension 1");
    v.stripMiddle = make(v, "span", "");
    v.stripText = text(v, "span", "", "how much each dimension contributes to the view right now");
    v.stripMiddle.appendChild(v.stripText);
    v.stripMiddle.appendChild(v.doc.createTextNode(" \u00b7 colour: "));
    v.stripLegend = AXIS_NAMES.map(function (name, i) {
      var word = text(v, "b", "tumbler-axis-" + name, name, { fontWeight: "400" });
      if (i > 0) v.stripMiddle.appendChild(v.doc.createTextNode(" "));
      v.stripMiddle.appendChild(word);
      return word;
    });
    v.stripLast = text(v, "span", "", "");
    caption.appendChild(v.stripFirst);
    caption.appendChild(v.stripMiddle);
    caption.appendChild(v.stripLast);
    readout.appendChild(strip);
    readout.appendChild(caption);
    v.readout = readout;
    panel.appendChild(readout);

    // Controls.
    var ctl = make(v, "div", "tumbler-controls", {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: spaced("controls-gap", "10px 18px"),
      fontSize: "12px",
    });
    v.playButton = pillButton(v, "tumbler-play", "Pause");
    v.zoomResetButton = pillButton(v, "tumbler-zoom-reset", "Reset view");
    var speedLabel = make(v, "label", "tumbler-speed", { display: "inline-flex", alignItems: "center", gap: "8px" });
    speedLabel.appendChild(text(v, "span", "", "Speed"));
    var speed = make(v, "input", "", { width: "130px" });
    speed.type = "range";
    speed.min = "0.2";
    speed.max = "3";
    speed.step = "0.1";
    speed.value = String(v.speed);
    speed.setAttribute("aria-label", "Speed");
    speedLabel.appendChild(speed);
    v.speedInput = speed;
    function checkbox(cls, label, checked) {
      var l = make(v, "label", cls, { display: "inline-flex", alignItems: "center", gap: "6px" });
      var c = make(v, "input", "", { width: "15px", height: "15px", margin: "0" });
      c.type = "checkbox";
      c.checked = !!checked;
      l.appendChild(c);
      l.appendChild(text(v, "span", "", label));
      return { label: l, input: c };
    }
    var lab = checkbox("tumbler-labels-toggle", "Labels", v.showLabels);
    var trl = checkbox("tumbler-trails-toggle", "Trails", v.trails);
    v.labelsInput = lab.input;
    v.trailsInput = trl.input;
    var hint = text(
      v,
      "span",
      "tumbler-hint",
      "Drag to turn; right-drag, Shift + drag or two fingers move. Pinch, or Ctrl + wheel, to zoom; " +
        "double-click or double-tap resets. Keys 1-" +
        Math.max(1, Math.min(9, defs.length)) +
        " switch views and arrows move while the viewer has focus."
    );
    ctl.appendChild(v.playButton);
    ctl.appendChild(v.zoomResetButton);
    ctl.appendChild(speedLabel);
    ctl.appendChild(lab.label);
    ctl.appendChild(trl.label);
    ctl.appendChild(hint);
    v.controlsEl = ctl;
    v.hint = hint;
    panel.appendChild(ctl);

    // Provenance.
    var prov = make(v, "details", "tumbler-provenance", { borderTop: "1px solid", paddingTop: "10px", fontSize: "12px" });
    prov.open = !!v.options.provenanceOpen;
    var summ = text(v, "summary", "tumbler-provenance-summary", "About this view", { cursor: "pointer" });
    var dl = make(v, "dl", "tumbler-provenance-list", {
      display: "grid",
      gridTemplateColumns: "max-content minmax(0, 1fr)",
      gap: "4px 14px",
      margin: "8px 0 0",
    });
    var shadow = text(v, "p", "tumbler-shadow", SHADOW, { margin: "10px 0 0", fontStyle: "italic", maxWidth: "92ch" });
    prov.appendChild(summ);
    prov.appendChild(dl);
    prov.appendChild(shadow);
    v.provenance = prov;
    v.provSummary = summ;
    v.provList = dl;
    v.provShadow = shadow;
    panel.appendChild(prov);

    root.appendChild(panel);

    if (!v.options.controls) ctl.style.display = "none";
    if (!v.options.readout) readout.style.display = "none";
    if (!v.options.masthead) mast.style.display = "none";
    return root;
  }

  // ---------- theme ----------

  function readTheme(v) {
    var cs = null;
    try {
      cs = typeof v.win?.getComputedStyle === "function" ? v.win.getComputedStyle(v.root) : null;
    } catch (err) {
      // A host whose getComputedStyle throws gets the built-in theme.
      cs = null;
    }
    function raw(name) {
      if (typeof cs?.getPropertyValue !== "function") return "";
      var s = cs.getPropertyValue(name);
      return typeof s === "string" ? s.trim() : "";
    }
    function colour(name) {
      var s = raw(name);
      if (!s) return null;
      var c = parseColour(s);
      if (c) return c;
      return probeColour(v, s);
    }
    var bg = colour("--tumbler-background");
    var light = bg ? luminance(bg) > 0.5 : false;
    var base = light ? LIGHT : DARK;
    var t = {
      light: light,
      background: bg || parseColour(base.background),
      sky: colour("--tumbler-sky") || parseColour(base.sky),
      foreground: colour("--tumbler-foreground") || parseColour(base.foreground),
      muted: colour("--tumbler-muted") || parseColour(base.muted),
      line: colour("--tumbler-line") || parseColour(base.line),
      accent: colour("--tumbler-accent") || parseColour(base.accent),
      ungrouped: colour("--tumbler-ungrouped") || parseColour(base.ungrouped),
      font: safeCssValue(raw("--tumbler-font")) || FONTS.body,
      fontData: safeCssValue(raw("--tumbler-font-data")) || FONTS.data,
      fontDisplay: safeCssValue(raw("--tumbler-font-display")) || FONTS.display,
      stageHeight: safeCssValue(raw("--tumbler-stage-height")) || STAGE_HEIGHT,
      groups: [],
    };
    for (var i = 0; i < MAX_GROUP_PROPS; i++) {
      t.groups.push(colour("--tumbler-group-" + (i + 1)));
    }
    // The search colours the relative overlay strokes with (the panel's custom properties).
    t.searches = [];
    for (var j = 0; j < SEARCH_DEFAULTS_DARK.length; j++) t.searches.push(colour("--tumbler-search-" + (j + 1)));
    return t;
  }

  // Resolve a named or otherwise unparsed colour through the browser: set it on a
  // hidden probe inside the viewer and read the computed value.
  function probeColour(v, s) {
    if (!v.root || typeof v.win?.getComputedStyle !== "function") return null;
    var probe = null;
    try {
      probe = v.doc.createElement("span");
      probe.style.display = "none";
      probe.style.color = s;
      v.root.appendChild(probe);
      var c = parseColour(String(v.win.getComputedStyle(probe).color || ""));
      return c;
    } catch {
      // A colour the browser cannot resolve is no colour: the caller falls back to the default.
      return null;
    } finally {
      probe?.remove();
    }
  }

  function groupColour(v, index) {
    if (index < 0) return v.theme.ungrouped;
    if (index < MAX_GROUP_PROPS && v.theme.groups[index]) return v.theme.groups[index];
    if (index < GROUP_HUES.length) return hsl(GROUP_HUES[index], 0.9, 0.62);
    // Past the reference's hues: golden-angle steps, same saturation and lightness.
    return hsl((GROUP_HUES.at(-1) + 137.508 * (index - GROUP_HUES.length + 1)) % 360, 0.9, 0.62);
  }

  function applyTheme(v) {
    var t = v.theme;
    var fg = cssRgb(t.foreground);
    var muted = cssRgb(t.muted);
    var line = cssRgb(t.line);
    var accent = cssRgb(t.accent);
    var bg = cssRgb(t.background);
    setStyles(v.root, { color: fg, background: bg, fontFamily: t.font });
    var mid = mix(t.sky, t.background, 0.55);
    v.stage.style.height = t.stageHeight;
    v.stage.style.background =
      "radial-gradient(ellipse 75% 70% at 50% 46%, " +
      cssRgb(t.sky) +
      " 0%, " +
      cssRgb(mid) +
      " 48%, " +
      bg +
      " 82%)";
    // The renderer draws light on black. On a dark stage it is screened over the sky.
    // On a light stage the points are uploaded in complementary colours and the canvas
    // is inverted and multiplied: each group comes out as ink of its own hue, laid on
    // at 70% opacity (soft ink: lighter, the hues kept).
    if (t.light) {
      v.canvas.style.filter = "invert(1)";
      v.canvas.style.mixBlendMode = "multiply";
      v.canvas.style.opacity = "0.7";
    } else {
      v.canvas.style.filter = "none";
      v.canvas.style.mixBlendMode = "screen";
      v.canvas.style.opacity = "1";
    }
    v.mastTitle.style.fontFamily = t.fontDisplay;
    v.mastTitle.style.color = fg;
    v.mastTitle.style.textShadow = "0 0 28px " + cssRgb(t.background, 0.9);
    v.mastLine.style.fontFamily = t.fontData;
    v.mastLine.style.color = muted;
    v.mastLine.style.textShadow = "0 0 12px " + bg;
    setStyles(v.status, { fontFamily: t.fontData, color: accent, textShadow: "0 0 8px " + bg });
    setStyles(v.fatal, { color: fg, background: cssRgb(t.background, 0.82), fontFamily: t.font });
    setStyles(v.empty, { color: muted, fontFamily: t.fontData });
    setStyles(v.notice, { color: fg, background: cssRgb(t.background, 0.92), borderColor: accent, fontFamily: t.fontData });
    v.noticeDismiss.style.borderColor = line;
    v.noticeDismiss.style.color = fg;
    v.modeNav.style.borderTopColor = line;
    v.modeButtons.forEach(function (mb) {
      mb.title.style.fontFamily = t.fontDisplay;
      mb.summary.style.color = muted;
      mb.button.style.color = muted;
    });
    paintModeButtons(v);
    v.strip.style.borderTopColor = line;
    v.strip.style.borderBottomColor = line;
    v.readout.style.fontFamily = t.fontData;
    v.readout.lastChild.style.color = muted;
    v.readout.lastChild.style.fontFamily = t.fontData;
    setStyles(v.controlsEl, { fontFamily: t.fontData, color: muted });
    [v.playButton, v.zoomResetButton].forEach(function (b) {
      b.style.borderColor = line;
      b.style.color = fg;
      b.style.fontFamily = t.fontData;
    });
    v.speedInput.style.accentColor = accent;
    v.labelsInput.style.accentColor = accent;
    v.trailsInput.style.accentColor = accent;
    setStyles(v.provenance, { borderTopColor: line, fontFamily: t.fontData, color: muted });
    v.provSummary.style.color = fg;
    v.provShadow.style.color = fg;
    v.provShadow.style.fontFamily = t.font;
    // Label elements re-style on their next use.
    v.labelPool.forEach(function (rec) {
      rec.key = "";
    });
    v.outline = outlineShadow(t.background);
    v.stageFg = fg;
    v.stageBg = bg;
    var searchDefaults = t.light ? SEARCH_DEFAULTS_LIGHT : SEARCH_DEFAULTS_DARK;
    v.searchColours = searchDefaults.map(function (d, j) {
      return t.searches?.[j] ? cssRgb(t.searches[j]) : d;
    });
    // The reference's Wander names: the stop in white, its neighbours #c5cddb (the
    // foreground three-eighths of the way to the muted colour). On a light stage the
    // stop takes the foreground, so it stays dark ink.
    v.stopColour = t.light ? fg : "rgb(255, 255, 255)";
    v.neighbourColour = cssRgb(mix(t.foreground, t.muted, 0.375));
    v.axisRgb = t.light ? AXIS_RGB_LIGHT : AXIS_RGB_DARK;
    v.stripLegend.forEach(function (word, i) {
      word.style.color = "rgb(" + v.axisRgb[i].join(", ") + ")";
    });
  }

  // Read the host's theme and, only when it differs from the one applied, apply it
  // and clear the trails (drawn in the old colours). An update or a refreshTheme()
  // with the theme unchanged leaves the trails, label styles and colours alone.
  // Returns true when the theme changed.
  function syncTheme(v) {
    var t = readTheme(v);
    var key = JSON.stringify(t);
    if (key === v.themeKey) return false;
    v.theme = t;
    v.themeKey = key;
    applyTheme(v);
    v.needClear = true;
    return true;
  }

  // The dark outline under every name, in the stage's background colour.
  function outlineShadow(bg) {
    var strong = cssRgb(bg, 0.85);
    var half = cssRgb(bg, 0.5);
    var parts = [];
    OUTLINE_RING.forEach(function (d) {
      parts.push(px(d[0] * 1.5) + " " + px(d[1] * 1.5) + " 0.5px " + strong);
    });
    OUTLINE_RING.forEach(function (d) {
      parts.push(px(d[0] * 2) + " " + px(d[1] * 2) + " 0 " + half);
    });
    return parts.join(", ");
  }
  function px(x) {
    var r = Math.round(x * 100) / 100;
    return (r === 0 ? 0 : r) + "px";
  }

  // A group's colour for names, the ring and the spokes on a dark stage: the
  // reference draws them at 72% lightness where the points are at 62%, so the
  // lightness is raised by the same share of the way to white (hue and
  // saturation kept). Exact for the reference's hues; the same lift for a host's.
  function nameTint(c) {
    var r = c[0];
    var g = c[1];
    var b = c[2];
    var hi = Math.max(r, g, b);
    var lo = Math.min(r, g, b);
    var l = (hi + lo) / 2;
    var h = 0;
    var s = 0;
    if (hi - lo > 1e-9) {
      var d = hi - lo;
      s = d / (1 - Math.abs(2 * l - 1));
      if (hi === r) h = 60 * (((g - b) / d) % 6);
      else if (hi === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
      if (h < 0) h += 360;
    }
    var l2 = l + (1 - l) * (0.1 / 0.38);
    return hsl(h, clamp(s, 0, 1), clamp(l2, 0, 1));
  }

  function paintModeButtons(v) {
    var current = v.modeId;
    var accent = cssRgb(v.theme.accent);
    var fg = cssRgb(v.theme.foreground);
    v.modeButtons.forEach(function (mb) {
      var on = mb.id === current;
      mb.button.setAttribute("aria-pressed", on ? "true" : "false");
      mb.button.style.borderTopColor = on ? accent : "transparent";
      mb.title.style.color = on ? accent : fg;
      mb.title.style.opacity = on ? "1" : "0.6";
      mb.title.style.fontStyle = on ? "italic" : "normal";
    });
  }

  function refreshTheme(v) {
    if (v.destroyed) return;
    syncTheme(v);
    if (v.set && paintKey(v) !== v.paintKey) recolour(v);
    invalidate(v);
  }

  // What the uploaded point colours depend on; a change means a re-upload.
  function paintKey(v) {
    var t = v.theme;
    return JSON.stringify([t.light, t.ungrouped, t.groups]);
  }

  // ---------- point colours and weights ----------

  function groupIndexOf(v, group) {
    if (typeof group !== "string" || group === "") return -1;
    if (Object.hasOwn(v.groupIndex, group)) return v.groupIndex[group];
    var i = v.groupNames.length;
    v.groupIndex[group] = i;
    v.groupNames.push(group);
    return i;
  }

  // Colours and weights for points [from, to) of the set. Labelled points are full
  // weight and brightened as in the reference; unlabelled points get a small steady
  // weight from their index. When no point is labelled at all (a labels-only set
  // whose labels are its ids), every point gets a middle weight so the view is not
  // all dust.
  // Also returns `bright`: the sum of the weights of the bright points painted (weight
  // BRIGHT_WEIGHT or more), which crowding() reads as the light load.
  function paint(v, set, from, to) {
    var n = to - from;
    var colours = new Float32Array(n * 3);
    var weights = new Float32Array(n);
    var bright = 0;
    var isLabelled = ET.modes.isLabelled;
    for (var i = from; i < to; i++) {
      var p = set.points[i];
      var g = groupIndexOf(v, p.group);
      var c = groupColour(v, g);
      var labelled = isLabelled(p);
      var h = hashUnit(i);
      var w;
      if (labelled) {
        w = 1;
        c = [0.45 + 0.55 * c[0], 0.45 + 0.55 * c[1], 0.45 + 0.55 * c[2]];
      } else if (v.labelledCount === 0) w = 0.7;
      else if (g < 0) w = 0.05 + 0.2 * h * h;
      else w = 0.1 + 0.55 * h * h * h;
      if (v.theme.light) c = inkUpload(c, labelled);
      var o = (i - from) * 3;
      colours[o] = c[0];
      colours[o + 1] = c[1];
      colours[o + 2] = c[2];
      weights[i - from] = w;
      if (w >= BRIGHT_WEIGHT) bright += w;
    }
    return { colours: colours, weights: weights, bright: bright };
  }

  // Coloured ink: the hue fully saturated and darkened (labelled points a little
  // darker), uploaded as its complement; the canvas's invert(1) turns the additive
  // image back into that ink, multiplied onto the light sky.
  function inkUpload(c, labelled) {
    var lo = Math.min(c[0], c[1], c[2]);
    var hi = Math.max(c[0], c[1], c[2]);
    var span = hi - lo > 1e-6 ? hi - lo : 1;
    var k = labelled ? 0.78 : 0.88;
    var out = [0, 0, 0];
    for (var j = 0; j < 3; j++) {
      var sat = hi - lo > 1e-6 ? (c[j] - lo) / span : 0.5;
      var ink = k * (0.7 * sat + 0.3 * c[j]);
      out[j] = 1 - ink;
    }
    return out;
  }

  function countLabelled(set, from, to) {
    var n = 0;
    for (var i = from; i < to; i++) if (ET.modes.isLabelled(set.points[i])) n++;
    return n;
  }

  // Labelled points projected per frame for labels and hover (at most LABEL_SAMPLE).
  function extendLabelSample(v, set, from) {
    for (var i = from; i < set.count && v.labelSample.length < LABEL_SAMPLE; i++) {
      if (v.labelledCount === 0 || ET.modes.isLabelled(set.points[i])) v.labelSample.push(i);
    }
  }

  function recolour(v) {
    // Re-upload everything with the theme's palette (a theme change). Rare.
    var set = v.set;
    if (!set || !v.renderer || set.count === 0) return;
    var pc = paint(v, set, 0, set.count);
    var res = v.renderer.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
    v.lightLoad = pc.bright;
    if (res?.ok === false) fatal(v, res.message);
    if (v.mode) v.mode.wiresVersion = -1;
    v.paintKey = paintKey(v);
  }

  // ---------- messages ----------

  // A message over the whole stage. kind "gpu" (no WebGL, lost for good, too many
  // points) or "data" (a refusal while the view holds no set).
  function fatal(v, message, kind) {
    v.fatalKind = kind || "gpu";
    v.fatalMessage = String(message);
    v.fatalText.textContent = v.fatalMessage;
    v.fatal.style.display = "flex";
    if (v.empty) v.empty.style.display = "none";
  }
  function clearFatal(v) {
    v.fatalKind = null;
    v.fatalMessage = null;
    if (v.empty && !v.set) v.empty.style.display = "";
    v.fatalText.textContent = "";
    v.fatal.style.display = "none";
  }
  function notify(v, message) {
    v.noticeMessage = String(message);
    v.noticeText.textContent = v.noticeMessage;
    v.notice.style.display = "flex";
  }
  function clearNotice(v) {
    v.noticeMessage = null;
    v.noticeText.textContent = "";
    v.notice.style.display = "none";
  }

  // ---------- provenance ----------

  function provRow(v, term, value) {
    var dt = text(v, "dt", "tumbler-provenance-term", term, { margin: "0", color: cssRgb(v.theme.muted) });
    var dd = make(v, "dd", "tumbler-provenance-value", { margin: "0", color: cssRgb(v.theme.foreground), minWidth: "0" });
    if (Array.isArray(value)) {
      var ul = make(v, "ul", "", { margin: "0", paddingLeft: "18px" });
      value.forEach(function (item) {
        ul.appendChild(text(v, "li", "", String(item)));
      });
      dd.appendChild(ul);
    } else {
      dd.textContent = String(value);
    }
    v.provList.appendChild(dt);
    v.provList.appendChild(dd);
    return dd;
  }

  function reductionText(r) {
    if (!r || r.kind === "none") return "none: the vectors are as the model produced them";
    if (r.kind === "rotation") {
      return "exact rotation onto the data's principal directions; nothing lost, distances unchanged";
    }
    if (r.kind === "top-k") {
      return (
        "top-k: " +
        thousands(r.directions_kept) +
        " of " +
        thousands(r.source_dimension) +
        " directions kept, " +
        percent(r.variance_dropped) +
        " of the variance dropped; this view is an approximation of the space"
      );
    }
    return String(r.kind);
  }

  function viewText(v) {
    var m = v.mode;
    if (!m) {
      var def = ET.modes.get(v.modeId);
      return (def ? def.title : v.modeId) + " (starts when data arrives)";
    }
    var d = {};
    try {
      d = m.inst.describe() || {};
    } catch (err) {
      // A mode whose describe() throws is shown as a plain linear projection.
      d = {};
    }
    var out = m.title + ": " + (d.projection || "a linear projection");
    if (typeof d.varianceShare === "number" && Number.isFinite(d.varianceShare)) {
      out +=
        "; the directions it tours through hold " +
        percent(d.varianceShare) +
        " of the variance" +
        (d.varianceShareStale ? " (measured before " + thousands(d.pointsSinceFit || 0) + " new points)" : "");
    }
    return out;
  }

  function renderProvenance(v) {
    var list = v.provList;
    list.replaceChildren();
    v.provView = null;
    v.provRel = null; // the Relative row goes with the rows; syncRelativeProvenance adds it again
    var set = v.set;
    if (!set) {
      provRow(v, "Data", "none yet");
      v.provView = provRow(v, "View", viewText(v));
      provRow(v, "Seed (view)", String(v.seed));
      v.provSummary.textContent = "About this view: no data yet. " + "A projection is a shadow of the space.";
      return;
    }
    var p = set.provenance || {};
    var r = set.reduction;
    provRow(v, "Source", p.source);
    if (p.synthetic) provRow(v, "Synthetic", "yes: these vectors were generated, not produced by the named model");
    provRow(v, "Model", set.model);
    var dim = thousands(set.dimension);
    if (r?.kind === "top-k") dim += " (reduced from " + thousands(r.source_dimension) + ")";
    provRow(v, "Dimension", dim);
    provRow(v, "Items", thousands(set.count));
    provRow(v, "Seed (view)", String(v.seed));
    provRow(v, "Seed (source)", p.seed === null || p.seed === undefined ? "none" : String(p.seed));
    v.provView = provRow(v, "View", viewText(v));
    provRow(v, "Reduction", reductionText(r));
    provRow(v, "Producer", p.producer);
    if (p.endpoint) provRow(v, "Embedded through", p.endpoint);
    if (p.created) provRow(v, "Created", p.created);
    provRow(
      v,
      "Labels",
      set.text_included
        ? "may carry corpus text from the source"
        : "point ids only: this data carries no corpus text"
    );
    var lim = Array.isArray(p.limitations) ? p.limitations : [];
    var unc = Array.isArray(p.uncertain) ? p.uncertain : [];
    provRow(v, "Limitations", lim.length ? lim : "none known (the producer states none)");
    provRow(v, "Uncertain", unc.length ? unc : "nothing flagged (the producer states none)");
    v.provSummary.textContent =
      "About this view: " +
      p.source +
      " · " +
      set.model +
      " · " +
      dim +
      "-d · " +
      thousands(set.count) +
      " items · seed " +
      String(v.seed) +
      (p.synthetic ? " · synthetic" : "") +
      " · a projection is a shadow of the space";
    v.provViewText = v.provView.textContent;
    syncRelativeProvenance(v);
  }

  function refreshViewRow(v) {
    if (!v.provView) return;
    var t = viewText(v);
    if (t !== v.provViewText) {
      v.provView.textContent = t;
      v.provViewText = t;
    }
  }

  function describeSet(v) {
    var set = v.set;
    // With no data the stage says so plainly; the provenance and readout have
    // nothing to describe and are hidden.
    v.empty.style.display = set || v.fatalMessage ? "none" : "";
    v.provenance.style.display = set ? "" : "none";
    v.readout.style.display = set && v.options.readout ? "flex" : "none";
    if (!set) {
      v.canvas.setAttribute("aria-label", "Animated 3-D projection of an embedding space (no data yet)");
      v.mastLine.textContent = "";
      v.stripLast.textContent = "";
      return;
    }
    var D = set.dimension;
    v.canvas.setAttribute(
      "aria-label",
      "Animated 3-D linear projection of a " +
        thousands(D) +
        "-dimensional embedding space: " +
        thousands(set.count) +
        " points from " +
        set.model +
        ". The provenance below says where they came from."
    );
    v.mastTitle.textContent = v.options.title ? String(v.options.title) : "";
    v.mastTitle.style.display = v.options.title ? "" : "none";
    v.mastLine.textContent =
      thousands(set.count) + " embeddings · " + thousands(D) + " dimensions · one restless 3-D window";
    v.stripLast.textContent = "dimension " + thousands(D);
    v.stripText.textContent = "how much each of the " + thousands(D) + " dimensions contributes to the view right now";
  }

  // ---------- modes ----------

  function copyState(s) {
    if (!s) return null;
    var draw = {};
    for (var k in s.draw) if (Object.hasOwn(s.draw, k)) draw[k] = s.draw[k];
    return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: draw };
  }

  // Options for a mode instance: the viewer's defaults (none today), then the host's
  // modeOptions. Tumble's refit turns onto the new tour over its own
  // refitTransition ("auto": sized to the turn); mode entry keeps the mode's 1.5 s.
  var MODE_DEFAULTS = Object.create(null);
  function modeOptionsFor(v, id) {
    var out = {};
    var k;
    var d = MODE_DEFAULTS[id];
    if (d) for (k in d) if (Object.hasOwn(d, k)) out[k] = d[k];
    var mo = v.options.modeOptions;
    var host = mo && Object.hasOwn(mo, id) ? mo[id] : null;
    if (host && typeof host === "object") {
      for (k in host) if (Object.hasOwn(host, k)) out[k] = host[k];
    }
    return out;
  }

  // Start mode `id` on the current set. Returns true, or false after showing why not.
  function errorText(err, fallback) {
    return err?.message ? String(err.message) : fallback;
  }

  // Start mode `id` on the current set. Returns true, or false after showing why not
  // (v.modeError holds the message). Every call into the mode is guarded: a mode is
  // pluggable host code and may throw. The previous instance is left only once the
  // new one has entered and prepared.
  function startMode(v, id, from) {
    var def = ET.modes.get(id);
    v.modeError = null;
    if (!def) {
      v.modeError = 'There is no view called "' + String(id) + '".';
      notify(v, v.modeError);
      return false;
    }
    if (!v.set) {
      v.modeId = id;
      paintModeButtons(v);
      return true;
    }
    var inst = null;
    var prep;
    try {
      inst = ET.modes.create(id, modeOptionsFor(v, id));
      inst.enter(v.set, { seed: v.seed, from: from || null });
      prep = inst.prepare();
      if (typeof prep?.step !== "function") throw new TypeError(def.title + ": prepare() returned no stepper");
    } catch (err) {
      v.modeError = errorText(err, "This view cannot show the data.");
      notify(v, v.modeError);
      leaveSafely(inst);
      return false;
    }
    if (v.mode) leaveSafely(v.mode.inst);
    v.mode = {
      id: id,
      title: def.title,
      inst: inst,
      jobs: [prep],
      clock: 0,
      seeked: false, // seek() was called: hold the spin until ready (spinWhilePreparing)
      wiresVersion: -1,
      refit: null,
      readyAt: null,
      lastFocusTo: -1,
      prevNeighbours: null,
      curNeighbours: null,
    };
    v.modeId = id;
    passRelative(v, v.mode); // right after it is entered (Tumble keeps the settings)
    paintModeButtons(v);
    refreshViewRow(v);
    v.statusClock = STATUS_EVERY;
    return true;
  }

  // Hand the viewer's relative settings to a mode that takes them (Tumble's setRelative):
  // right after it is entered and on every change. A stepper it hands back is pumped with
  // the mode's own preparation. With both settings off the call changes nothing in Tumble.
  function passRelative(v, m) {
    if (!m || typeof m.inst.setRelative !== "function") return;
    var r;
    try {
      r = m.inst.setRelative({ relative: v.rel.relative, showOrigin: v.rel.showOrigin }, m.clock);
    } catch (err) {
      // A mode whose setRelative throws keeps its current view.
      return;
    }
    var work = typeof r?.step === "function" ? r : r?.work;
    if (typeof work?.step === "function") m.jobs.push(work);
  }

  function leaveSafely(inst) {
    if (!inst) return;
    try {
      inst.leave();
    } catch (err) {
      // a mode's leave() has nothing the viewer needs
    }
  }

  function readyOf(m) {
    try {
      return !!m?.inst.isReady();
    } catch (err) {
      // A mode whose isReady() throws is not ready.
      return false;
    }
  }

  // A frame threw: the loop stops and a notice says so; a replace or a mode switch
  // that succeeds starts it again.
  function recover(v) {
    if (!v.broken) return;
    v.broken = false;
    if (v.noticeMessage?.startsWith("The viewer stopped")) clearNotice(v);
    v.prev = null;
    invalidate(v);
  }

  function setMode(v, id) {
    if (v.destroyed) return false;
    if (typeof id !== "string") return false;
    if (v.mode?.id === id) return true;
    if (!v.set && ET.modes.get(id)) {
      v.modeId = id;
      paintModeButtons(v);
      refreshViewRow(v);
      call(v, v.options.onModeChange, id);
      return true;
    }
    var ok = startMode(v, id, copyState(v.last));
    if (ok) {
      if (v.search.shown.length) notifyModeSearch(v);
      recover(v);
      call(v, v.options.onModeChange, id);
      invalidate(v);
    }
    return ok;
  }

  // ---------- data ----------

  function update(v, data) {
    if (v.destroyed) return { ok: false, code: "destroyed", message: "This viewer has been destroyed." };
    var began = now(v);
    try {
      return applyUpdate(v, data);
    } finally {
      // A long update (a large upload) is the viewer's own work too: the next frame
      // counts the gap as lost time, as after a long frame.
      // Anything over about one frame (20 ms) would show as a skipped step.
      if (now(v) - began > 20) v.lostTime = true;
    }
  }

  function validateSafely(v, data) {
    try {
      return ET.contract.validate(data, v.set);
    } catch (err) {
      // The loader never throws for bad data (a hostile getter is its own
      // invalid-field refusal), so anything caught here is a fault, not the data's.
      return { ok: false, code: "internal", message: "Internal error while checking the data: " + errorText(err, String(err)) };
    }
  }

  // "append" or "replace": what the data asks for. A getter that throws means replace.
  function opOf(data) {
    try {
      return data.op === "append" ? "append" : "replace";
    } catch (err) {
      // A throwing op getter: the data is shown as a replace.
      return "replace";
    }
  }

  function applyOp(v, op, set) {
    try {
      return op === "append" ? applyAppend(v, set) : applyReplace(v, set);
    } catch (err) {
      // Nothing in the application path should throw; if it does, it is reported, the
      // loop is left to the frame guard, and the host gets a result.
      return { ok: false, code: "internal", message: "Internal error while showing the data: " + errorText(err, String(err)) };
    }
  }

  function applyUpdate(v, data) {
    var res = validateSafely(v, data);
    // Re-read the host's theme on every update (no polling); applied only if changed.
    syncTheme(v);
    if (v.set && paintKey(v) !== v.paintKey) recolour(v);
    if (!res?.ok) {
      return refuse(v, { ok: false, code: res ? res.code : "internal", message: res ? res.message : "Data refused." });
    }
    var op = opOf(data);
    clearNotice(v); // an older notice; a fallback view or a refusal sets its own
    var out = applyOp(v, op, res.set);
    if (!out.ok) return refuse(v, out);
    if (v.fatalKind === "data") clearFatal(v);
    if (v.fatalKind === "gpu" && v.rendering) clearFatal(v);
    if (op === "replace") recover(v);
    invalidate(v);
    return out;
  }

  function strip(r) {
    return { ok: false, code: r.code, message: r.message };
  }

  // A refusal: nothing changed. Shown inside the element, passed to onError, returned.
  function refuse(v, r) {
    var refusal = strip(r);
    // With a view showing (or a graphics message up), the refusal is a notice and the
    // view keeps running unchanged; with nothing to show it fills the stage.
    if (v.set || v.fatalKind === "gpu") notify(v, refusal.message);
    else fatal(v, refusal.message, "data");
    call(v, v.options.onError, refusal);
    invalidate(v);
    return refusal;
  }

  // What a failed update restores.
  function snapshot(v) {
    var gi = Object.create(null); // group names are untrusted: no inherited names
    for (var k in v.groupIndex) gi[k] = v.groupIndex[k];
    return {
      set: v.set,
      groupIndex: gi,
      groupNames: v.groupNames.slice(),
      labelledCount: v.labelledCount,
      lightLoad: v.lightLoad,
      labelSample: v.labelSample.slice(),
      last: v.last,
      spin: v.spin,
      drag: v.drag,
      sinceAppend: v.sinceAppend,
    };
  }

  function restore(v, snap) {
    v.set = snap.set;
    v.groupIndex = snap.groupIndex;
    v.groupNames = snap.groupNames;
    v.labelledCount = snap.labelledCount;
    v.lightLoad = snap.lightLoad;
    v.labelSample = snap.labelSample;
    v.last = snap.last;
    v.spin = snap.spin;
    v.drag = snap.drag;
    v.sinceAppend = snap.sinceAppend;
    restoreRenderer(v);
    sizeStrip(v);
    describeSet(v);
    renderProvenance(v);
  }

  // Put the renderer's copy back to the set the view holds (after a failed upload or
  // a refused update), rebuilding the GPU objects if a failure dropped them.
  function restoreRenderer(v) {
    var r = v.renderer;
    if (!r) return;
    try {
      var set = v.set;
      if (set) {
        var pc = paint(v, set, 0, set.count);
        r.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
        v.lightLoad = pc.bright;
      } else {
        v.lightLoad = 0;
        var D = r.status().dimension || 1;
        r.setData({ vectors: new Float32Array(0), dimension: D });
      }
      var st = r.status();
      if (!st.ok && !st.lost && !st.disposed) {
        var rb = r.rebuild();
        if (!rb?.ok) fatal(v, rb?.message || "The graphics card could not take the data back.");
      }
      if (v.mode) v.mode.wiresVersion = -1;
      if (v.search.litUploaded) uploadLit(v); // setData cleared the lit values
      v.paintKey = paintKey(v);
      v.needClear = true;
    } catch (err) {
      fatal(v, "The graphics card could not take the data back: " + errorText(err, String(err)));
    }
  }

  function gpuThrew(err) {
    return { ok: false, code: "gpu-failed", message: "The graphics card could not take the data: " + errorText(err, String(err)) };
  }

  // Start the first registered view other than the chosen one that can show the set.
  function startOtherMode(v) {
    for (var id of ET.modes.ids()) {
      if (id !== v.modeId && startMode(v, id, null)) return true;
    }
    return false;
  }

  function applyReplace(v, set) {
    var snap = snapshot(v);
    v.groupIndex = Object.create(null);
    v.groupNames = [];
    v.labelledCount = countLabelled(set, 0, set.count);
    v.labelSample = [];
    extendLabelSample(v, set, 0);
    v.lightLoad = 0;
    if (v.renderer) {
      var gpu;
      try {
        var pc = paint(v, set, 0, set.count);
        gpu = v.renderer.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
        v.lightLoad = pc.bright;
      } catch (err) {
        restore(v, snap);
        return gpuThrew(err);
      }
      if (gpu?.ok === false) {
        // This GPU cannot take the set (too many points, too wide, a failed build or
        // upload): the renderer may still hold the previous set, or nothing usable,
        // so the view goes back exactly to what it was, renderer copy included.
        restore(v, snap);
        return { ok: false, code: gpu.reason || "gpu-failed", message: gpu.message || "The graphics card could not take the data." };
      }
    }
    v.set = set;
    v.last = null;
    v.spin = 0;
    v.drag = { active: false, yaw: 0, pitch: 0, x: 0, y: 0, pan: false };
    v.needClear = true;
    v.sinceAppend = Infinity;
    var oldMode = v.mode;
    // startMode leaves the old instance only when the new one has started.
    var started = startMode(v, v.modeId, null);
    var firstError = v.modeError;
    // The chosen view cannot show this data (too few dimensions, or a failing
    // mode): try the others.
    if (!started) started = startOtherMode(v);
    if (!started) {
      v.mode = oldMode;
      restore(v, snap);
      return { ok: false, code: "mode-failed", message: "No view can show this data: " + (firstError || "every view refused it.") };
    }
    if (firstError) notify(v, firstError); // shown on top of the fallback view
    dropSearchesForReplace(v);
    v.paintKey = paintKey(v);
    sizeStrip(v);
    describeSet(v);
    renderProvenance(v);
    return { ok: true, op: "replace", count: set.count, added: set.count };
  }

  // The labelled count and label sample after points [from, set.count) arrive.
  function appendLabels(v, set, from) {
    var hadLabelled = v.labelledCount;
    v.labelledCount += countLabelled(set, from, set.count);
    if (hadLabelled === 0 && v.labelledCount > 0) {
      // The first labelled points arrived: rebuild the label sample from them.
      v.labelSample = [];
      extendLabelSample(v, set, 0);
    } else extendLabelSample(v, set, from);
  }

  // Upload points [from, set.count) to the renderer. Returns null on success (the light
  // load then counts them), or the refusal; the caller rolls the view back.
  function uploadAppend(v, set, from) {
    var gpu;
    var pc = null;
    try {
      pc = paint(v, set, from, set.count); // may add groups: rolled back on failure
      var D = set.dimension;
      gpu = v.renderer.appendData({
        vectors: set.vectors.subarray(from * D, set.count * D),
        colours: pc.colours,
        weights: pc.weights,
      });
    } catch (err) {
      gpu = gpuThrew(err);
      gpu.reason = "gpu-failed";
    }
    if (!gpu || gpu.ok === false) {
      return { ok: false, code: gpu?.reason || "gpu-failed", message: gpu?.message || "append failed" };
    }
    v.lightLoad += pc.bright;
    return null;
  }

  // Tell the running mode about k appended points. Returns null, or the refusal after
  // putting the old set back and starting the same view again from the frame last drawn.
  function appendToMode(v, m, set, k, snap) {
    var r;
    try {
      r = m.inst.dataChanged(set, { op: "append", added: k, t: m.clock });
    } catch (err) {
      // The mode is in an unknown state: put the old set back and start the same
      // view again from the frame last drawn.
      var msg = m.title + " failed on the new points: " + errorText(err, String(err));
      restore(v, snap);
      v.mode = null;
      leaveSafely(m.inst);
      if (!startMode(v, m.id, copyState(v.last))) startMode(v, "tumble", copyState(v.last));
      return { ok: false, code: "mode-failed", message: msg };
    }
    if (r?.restart) {
      // The mode entered again: work queued for its earlier entry (a preparation
      // or a refit still running) belongs to a state that is gone, so drop it.
      m.jobs = [];
      m.refit = null;
      m.clock = 0;
      m.readyAt = null;
    }
    if (typeof r?.work?.step === "function") m.jobs.push(r.work);
    return null;
  }

  function applyAppend(v, set) {
    var old = v.set;
    var from = old.count;
    var k = set.count - from;
    if (k <= 0) {
      v.set = set;
      renderProvenance(v);
      return { ok: true, op: "append", count: set.count, added: 0 };
    }
    var t0 = now(v);
    var snap = snapshot(v);
    appendLabels(v, set, from);
    if (v.renderer) {
      var uploadFailed = uploadAppend(v, set, from);
      if (uploadFailed) {
        restore(v, snap);
        return uploadFailed;
      }
    }
    v.set = set;
    if (v.mode) {
      var modeFailed = appendToMode(v, v.mode, set, k, snap);
      if (modeFailed) return modeFailed;
    } else if (startMode(v, v.modeId, null)) notifyModeSearch(v);
    v.sinceAppend = 0;
    describeSet(v);
    renderProvenance(v);
    searchesAfterAppend(v);
    v.timing.lastAppendMs = now(v) - t0;
    return { ok: true, op: "append", count: set.count, added: k };
  }

  // ---------- sizing ----------

  function sizeStrip(v) {
    var D = v.set ? Math.max(1, v.set.dimension) : 1;
    if (v.strip.width !== D) v.strip.width = D;
    if (v.strip.height !== 1) v.strip.height = 1;
    v.stripImage = null;
    v.stripCtx = null;
    try {
      v.stripCtx = v.strip.getContext("2d");
      if (v.stripCtx) v.stripImage = v.stripCtx.createImageData(D, 1);
    } catch {
      // No 2-D context for the strip: the readout is simply not drawn.
      v.stripCtx = null;
    }
  }

  function measure(v) {
    var w = 0;
    var h = 0;
    try {
      var r = v.stage.getBoundingClientRect();
      w = r.width;
      h = r.height;
    } catch {
      // No layout box yet: fall back to the element's client size below.
      w = 0;
    }
    w = w > 0 ? w : v.stage.clientWidth || 300;
    h = h > 0 ? h : v.stage.clientHeight || 150;
    var dpr = Math.min(Number(v.options.maxPixelRatio) || 2, v.win?.devicePixelRatio || 1);
    if (v.dprCap !== null) dpr = Math.max(1, Math.min(dpr, v.dprCap));
    var W = Math.max(2, Math.round(w * dpr));
    var H = Math.max(2, Math.round(h * dpr));
    // The picture is wiped only when the stage really changed. The root also resizes when the
    // search panel opens or closes below an unchanged stage; wiping then showed as a flicker.
    var sameStage = v.W === W && v.H === H && v.dpr === dpr;
    v.dpr = dpr;
    v.cssW = w;
    v.cssH = h;
    v.W = W;
    v.H = H;
    if (v.renderer) v.renderer.resize(W, H);
    if (v.overlay.width !== W) v.overlay.width = W;
    if (v.overlay.height !== H) v.overlay.height = H;
    var rootW = 0;
    try {
      rootW = v.root.getBoundingClientRect().width;
    } catch (err) {
      // No layout box for the root: lay out for the stage's width.
      rootW = w;
    }
    layoutForWidth(v, rootW || w);
    if (!sameStage) {
      v.needClear = true;
      v.pan = clampPan(v, v.pan[0], v.pan[1]); // a smaller stage holds the picture's centre too
    }
    invalidate(v);
  }

  // No media queries without a stylesheet, so the layout reacts to the element's width.
  // Two breakpoints, each evaluated on its own: 520 px for the provenance grid (one
  // column below it) and 600 px for the rest of the narrow layout.
  function layoutForWidth(v, width) {
    var oneColumn = width < 520;
    if (oneColumn !== v.oneColumn) {
      v.oneColumn = oneColumn;
      v.provList.style.gridTemplateColumns = oneColumn ? "minmax(0, 1fr)" : "max-content minmax(0, 1fr)";
    }
    var narrow = width < 600;
    if (narrow === v.narrow) return;
    v.narrow = narrow;
    var size = narrow ? "narrow" : "wide";
    v.modeButtons.forEach(function (mb) {
      mb.summary.style.display = narrow ? "none" : "";
      mb.title.style.fontSize = spaced("mode-title-size", MODE_TITLE_SIZE[size]);
    });
    v.panel.style.padding = spaced("panel-padding", PANEL_PADDING[size]);
    v.playButton.style.minHeight = narrow ? TOUCH_HEIGHT : BUTTON_HEIGHT;
    v.zoomResetButton.style.minHeight = narrow ? TOUCH_HEIGHT : BUTTON_HEIGHT;
  }

  // ---------- the loop ----------

  function now(v) {
    var p = v.win?.performance;
    if (typeof p?.now === "function") return p.now();
    return Date.now();
  }

  function suspended(v) {
    return !!(v.doc.hidden || !v.onScreen);
  }

  // Ask for one more frame (unless destroyed, hidden or off screen).
  function invalidate(v) {
    v.dirty = true;
    schedule(v);
  }

  function schedule(v) {
    if (v.destroyed || v.raf || suspended(v)) return;
    if (typeof v.win?.requestAnimationFrame !== "function") return;
    v.raf = v.win.requestAnimationFrame(v.tick);
  }

  function unschedule(v) {
    if (v.raf && typeof v.win?.cancelAnimationFrame === "function") v.win.cancelAnimationFrame(v.raf);
    v.raf = 0;
    v.prev = null; // the next frame after a resume starts from a fresh clock
  }

  function needsMore(v) {
    if (v.dirty) return true;
    var m = v.mode;
    if (!m || !v.set || v.set.count === 0) return false;
    if (m.jobs.length || m.refit) return true;
    if (searchBusy(v)) return true;
    // A mode that is still preparing needs frames until it is ready, even when the
    // view is paused or motion is reduced: otherwise it would wait for input forever.
    if (!readyOf(m)) return true;
    if (v.running) return true;
    if (v.drag.active || v.pinch) return true;
    // Paused: keep twinkling (the reference does) unless motion is reduced.
    return !v.reducedMotion && v.rendering;
  }

  function frame(v, t) {
    v.raf = 0;
    if (v.destroyed) return;
    if (suspended(v)) {
      v.prev = null;
      return; // no frame work while hidden or off screen; resume() reschedules
    }
    var start = now(v);
    noteInterval(v, t);
    var dt = v.prev === null ? 1 / 60 : clamp((t - v.prev) / 1000, 0.001, 0.05);
    // After a long frame of the viewer's own work (a fit), count the gap as lost time,
    // not motion, so the picture does not leap ahead by a whole clamped step.
    // The rAF timestamp of a delayed frame is the vsync time from before the delay;
    // measure the next frame from when this one actually ran, or it would leap instead.
    if (v.lastSpent > 50 || v.lostTime) {
      v.lostTime = false;
      dt = 1 / 60;
      v.prev = Math.max(t, start);
    } else v.prev = t;
    v.dirty = false;
    try {
      step(v, dt, start);
    } catch (err) {
      // The loop stops; the last picture stays with a notice over it. A replace or a
      // mode switch that succeeds starts it again (recover()).
      v.broken = true;
      notify(v, "The viewer stopped: " + errorText(err, String(err)) + ". Send new data or switch views to restart it.");
      return;
    }
    var spent = now(v) - start;
    v.lastSpent = spent;
    v.lastScript = Math.max(0, spent - v.drawSpent);
    if (spent > v.timing.longestFrameMs) v.timing.longestFrameMs = spent;
    v.frames++;
    if (v.timing.firstFrameMs === null) v.timing.firstFrameMs = now(v) - v.timing.mountAt;
    v.fpsFrames++;
    if (v.fpsAt === null) v.fpsAt = t;
    else if (t - v.fpsAt >= 1000) {
      v.fps = (v.fpsFrames * 1000) / (t - v.fpsAt);
      v.fpsAt = t;
      v.fpsFrames = 0;
      adaptPixelRatio(v);
    }
    if (!v.broken && needsMore(v)) schedule(v);
  }

  // The interval between animation frames (rAF timestamps), smoothed. It is measured only
  // between frames that ran back to back: the first frame after a pause, a resume or a
  // return from hidden starts afresh, and so does the frames-per-second window.
  function noteInterval(v, t) {
    var gap = v.rafAt === null ? Infinity : t - v.rafAt;
    v.rafAt = t;
    if (v.prev === null || gap > INTERVAL_GAP_MS) {
      v.fpsAt = null;
      v.fpsFrames = 0;
      return;
    }
    if (gap > 0) v.interval = v.interval > 0 ? v.interval * 0.75 + gap * 0.25 : gap;
  }

  // The budget for this frame's heavy work. Where the time between frames went decides it:
  // on a device whose frames are long because drawing is slow (the GPU, the compositor),
  // the work may take up to WORK_SHARE of the frame interval, so it keeps making progress
  // at any frame rate. It is cut only when the work's own script time ran well past what it
  // was given. The rest of the frame's script (the mode's state, labels, uploads) is not
  // made shorter by a smaller budget, so cutting the budget for it only starves the work:
  // measured with the CPU throttled 6x, a rule on the whole script swung the budget between
  // 24 and 4 ms every other frame. info().timing reports both (workMs, scriptMs).
  function frameBudget(v) {
    var base = Math.max(1, Number(v.options.prepareBudgetMs) || 8);
    var budget = clamp(v.interval * WORK_SHARE, base, base * BUDGET_CEILING);
    if (v.timing.workMs > Math.max(OVERRUN_FLOOR_MS, v.lastBudget + OVERRUN_MS)) budget = Math.max(1, base / 2);
    // A paused view has no motion to keep smooth, so it may spend longer per frame on
    // getting ready (it still answers input every frame).
    if (!v.running) budget = Math.max(budget, PAUSED_BUDGET_MS);
    v.lastBudget = budget;
    return budget;
  }

  // Preparation and refit work run in small units (a few milliseconds each) inside the
  // frame's budget (frameBudget), so the page keeps its frame rate while a mode prepares
  // or refits, and the work keeps going on a device that draws slowly.
  function pump(v, m, start) {
    var budget = frameBudget(v);
    v.timing.budgetMs = budget;
    pumpJobs(v, m, start, budget);
    if (m.refit && v.running && now(v) - start < budget) pumpRefit(v, m, start, budget);
    pumpSearch(v, start, budget);
    v.timing.workMs = now(v) - start;
  }

  function pumpJobs(v, m, start, budget) {
    while (m.jobs.length) {
      var job = m.jobs[0];
      var left = budget - (now(v) - start);
      if (left <= 0) break;
      if (!job.done) job.step(left);
      if (job.done) m.jobs.shift();
      else break;
    }
  }

  // One step of a running refit inside what is left of the frame's budget.
  function pumpRefit(v, m, start, budget) {
    var r0 = now(v);
    m.refit.step(Math.max(1, budget - (r0 - start)));
    var took = now(v) - r0;
    m.refitSpent += took;
    if (took > m.refitLongest) m.refitLongest = took;
    if (m.refit.done) {
      m.refit = null;
      v.timing.lastRefit = {
        atMs: now(v) - v.timing.mountAt,
        durationMs: m.refitSpent,
        longestStepMs: m.refitLongest,
      };
    }
  }

  // Tumble's refit policy after appends: once appends have been quiet for
  // refitQuietSeconds and the points added since the last fit are at least
  // refitShare of the set (and at least one), fit the directions again.
  // x > 0, false for NaN and for anything that is not a number above zero.
  function positive(x) {
    return x > 0;
  }

  function considerRefit(v, m) {
    // Never while paused (frames do not run at all while hidden or off screen): a
    // paused view must not take the refit's stall; it starts after resume.
    if (!v.running) return;
    if (m.refit || m.jobs.length || typeof m.inst.refit !== "function") return;
    if (v.sinceAppend < v.options.refitQuietSeconds) return;
    var d = m.inst.describe();
    if (!d?.varianceShareStale || !positive(d.pointsSinceFit)) return;
    if (d.pointsSinceFit < Math.max(1, Math.ceil(v.options.refitShare * v.set.count))) return;
    m.refit = m.inst.refit();
    m.refitSpent = 0;
    m.refitLongest = 0;
    v.timing.refits++;
  }

  function step(v, dt, start) {
    var m = v.mode;
    var r = v.renderer;
    v.sinceAppend += dt;
    if (!m || !v.set) {
      stepWithoutView(v, r, dt);
      return;
    }
    pump(v, m, start);
    var ready = m.inst.isReady();
    if (ready) advanceReady(v, m, dt);
    else spinWhilePreparing(v, m, dt);
    var s = m.inst.stateAt(ready ? m.clock : 0);
    if (r && s.wires && s.wires.version !== m.wiresVersion) {
      r.setWires(s.wires.pairs, s.wires.lengths);
      m.wiresVersion = s.wires.version;
    }
    if (!v.reducedMotion || v.running) v.drawTime += dt;
    easeFilter(v, dt);
    v.search.hideUnlit = hidesUnlit(v);
    syncRelativeLit(v, s);
    var ds = drawState(v, s, dt);
    v.drawSpent = 0;
    if (r && v.rendering) {
      var d0 = now(v);
      r.draw(ds);
      v.drawSpent = now(v) - d0;
    }
    v.needClear = false;
    v.last = s;
    v.lastDraw = ds;
    noteRelativeChange(v, s);
    drawLabels(v, s, ds);
    drawRelativeOverlay(v, s, ds);
    drawSearchOverlay(v, s, ds);
    drawStrip(v, s.frame);
    v.statusClock += dt;
    if (v.statusClock >= STATUS_EVERY) updateStatus(v, m, s, ready);
  }

  // Names, spokes and the hover ring when labels are on or the pointer is over the sky;
  // otherwise the overlay is cleared.
  function drawLabels(v, s, ds) {
    if (v.showLabels || v.hover) drawOverlay(v, s, ds);
    else clearOverlay(v);
  }

  // A frame with no data, or with data no view could show: a cleared picture.
  function stepWithoutView(v, r, dt) {
    if (r && v.rendering) r.draw({ clear: true, dt: dt });
    v.status.textContent = v.set ? "this view cannot show the data" : "";
    clearLabels(v, 0);
    clearRelativeOverlay(v);
  }

  // A frame on which the mode is ready: note when it first became ready, move the
  // clock and the spin while running, mark the time and consider a refit.
  function advanceReady(v, m, dt) {
    if (m.readyAt === null) {
      m.readyAt = now(v);
      // Show the mode's own status on this very frame: under reduced motion the loop
      // may stop right after it, and the "finding ..." line must not be left behind.
      v.statusClock = STATUS_EVERY;
      if (v.timing.firstReadyMs === null) v.timing.firstReadyMs = m.readyAt - v.timing.mountAt;
    }
    if (v.running) {
      m.clock += dt * v.speed;
      if (!v.drag.active) v.spin += dt * v.speed * spinFactor(m);
    }
    if (typeof m.inst.mark === "function") m.inst.mark(m.clock);
    considerRefit(v, m);
  }

  // While a mode prepares, the mode clock waits for ready (frames for a given mode time do
  // not depend on how fast the preparation ran) but the slow spin keeps turning the frame
  // the mode holds, so the view never stands still. It runs on the same rule as the spin
  // after ready (running, not dragging) and stops after a seek(), which asks for an exact
  // frame: a seek before ready shows the frame at that time once the mode is ready.
  function spinWhilePreparing(v, m, dt) {
    if (!v.options.spinWhilePreparing || m.seeked || !v.running || v.drag.active) return;
    v.spin += dt * v.speed * spinFactor(m);
  }

  // A mode is preparing while it is not ready, has queued work, or refits.
  function preparingOf(m) {
    return !!(m && (!readyOf(m) || m.jobs.length || m.refit));
  }

  // Once a second (with the frames-per-second figure): after ADAPT_SECONDS measured seconds
  // in a row under ADAPT_FPS, while the view moves, draws and prepares nothing, draw at a
  // lower ratio (ADAPT_STEP less, never below 1). It is never raised again in this mount.
  function adaptPixelRatio(v) {
    if (!v.options.adaptivePixelRatio || !v.running || !v.rendering || preparingOf(v.mode) || v.fps >= ADAPT_FPS) {
      v.slowSeconds = 0;
      return;
    }
    v.slowSeconds++;
    if (v.slowSeconds < ADAPT_SECONDS || v.dpr <= 1) return;
    v.slowSeconds = 0;
    v.dprCap = Math.max(1, v.dpr - ADAPT_STEP);
    measure(v);
  }

  // A mode may ask for its own spin with a `spin` member (rad/s, finite, 0 or more; Focus
  // asks for 0.13). v.spin counts seconds at SPIN, so it advances by this factor: exactly 1
  // for a mode that does not ask, and the yaw stays continuous across a change of mode.
  function spinFactor(m) {
    var r = m?.inst?.spin;
    return typeof r === "number" && Number.isFinite(r) && r >= 0 ? r / SPIN : 1;
  }

  // The status line, the view row and aria-busy, every STATUS_EVERY seconds.
  function updateStatus(v, m, s, ready) {
    v.statusClock = 0;
    var line = s.status;
    if (relativeShown(v, s)) line += relativeStatusTail(v, s.relative);
    if (v.userZoom !== 1) line += " · zoom " + v.userZoom.toFixed(1) + "×";
    if (panned(v)) line += " · moved";
    if (!v.running) line += " · paused";
    if (line !== v.statusText) {
      v.status.textContent = line;
      v.statusText = line;
    }
    refreshViewRow(v);
    syncRelativeProvenance(v);
    v.root.setAttribute("aria-busy", ready && !m.jobs.length ? "false" : "true");
  }

  function drawState(v, s, dt) {
    var out = {};
    var d = s.draw;
    for (var k in d) if (Object.hasOwn(d, k)) out[k] = d[k];
    out.frame = s.frame;
    out.centre = s.centre;
    out.zoom = (d.zoom || 1) * v.userZoom;
    // The user pan moves the drawn picture (the key is left out at rest, so the draw state is
    // exactly as before panning existed).
    if (panned(v)) out.pan = [v.pan[0], v.pan[1]];
    out.yaw = 0.4 + v.drag.yaw + SPIN * v.spin;
    // The relative view eases the stage's tilt to level by its mix (0 in the plain view, so
    // the expression is exactly the plain one there).
    var relMix = relativeMix(v, s);
    out.pitch = relMix > 0 ? clamp(0.16 * (1 - relMix) + v.drag.pitch, -1.3, 1.3) : clamp(0.16 + v.drag.pitch, -1.3, 1.3);
    out.pointSize = 6.5 * v.dpr;
    out.time = v.drawTime;
    out.dt = dt;
    if (!v.trails) out.trails = 0;
    // Ink is dark where light piles up, so on a light stage it is drawn with less gain
    // and bloom than light on black (cores keep their hue instead of burning to black).
    if (v.theme.light) {
      out.gain = 0.55;
      out.bloom = 0.3;
    }
    // Many full-weight points pile up into a white (or, in ink, black) ball, so the
    // overall brightness comes down as their number goes up.
    var crowd = crowding(v);
    if (crowd < 1) out.gain = (out.gain === undefined ? 1 : out.gain) * crowd;
    // Many wires through the same part of the stage pile up into white: the renderer scales
    // them down past WIRE_LOAD (the key is left out when no wires are shown).
    if (out.wires > 0) out.wireLoad = WIRE_LOAD;
    if (v.reducedMotion) out.twinkle = 0;
    // Search: how much the lit values apply (the key is left out with no search, so the
    // draw state is exactly as before search).
    if (v.search.filter > 0) out.filter = v.search.filter;
    out.clear = !!v.needClear;
    return out;
  }

  // Brightness factor for crowded sets, 1 up to a light load of CROWD_REF. The light
  // load is the sum of the weights of the bright points actually uploaded (weight
  // BRIGHT_WEIGHT or more): a labelled point counts 1, a point of a set with no
  // labelled point 0.7, the dim unlabelled points of a labelled set nothing. So it
  // is the labelled count, or 0.7 times the point count when nothing is labelled;
  // points uploaded at 0.7 before the first labelled point arrived by append keep
  // counting 0.7, as they are still drawn at that weight. The built-in sample set
  // has 290, so it is unchanged.
  function crowding(v) {
    var n = v.set ? v.lightLoad : 0;
    return n > CROWD_REF ? Math.pow(CROWD_REF / n, CROWD_POWER) : 1;
  }

  // ---------- overlay: labels, spokes, hover ----------

  function project(v, i, s, ds, out) {
    var D = v.set.dimension;
    var X = v.set.vectors;
    var F = s.frame;
    var C = s.centre;
    var o = i * D;
    var a = 0;
    var b = 0;
    var c = 0;
    for (var d = 0; d < D; d++) {
      var x = X[o + d] - C[d];
      a += x * F[d];
      b += x * F[D + d];
      c += x * F[2 * D + d];
    }
    out[0] = a;
    out[1] = b;
    out[2] = c;
    return ET.renderer.place(out, ds, v.W, v.H);
  }

  // ---------- the label sample along the frame, without a pass in full dimension ----------
  //
  // Names and hover need the screen position of every point of the label sample on every
  // frame: 3 * n * D multiply-adds done directly (921,600 for 300 points in 1,024-d; on a
  // device that runs JavaScript without a compiler that alone was about 50 ms a frame).
  // But a frame moves inside the span of a few directions for seconds at a time (Tumble:
  // the tour's eight; Lattice: one new direction per swap; a mode that prepares: the frame
  // it holds). The projector keeps an orthonormal basis Q of the directions the frames
  // shown lately lay in, with each sample point's coordinate along each (P). A frame row
  // inside the span costs its coefficients in Q (k * D) and a k-term sum per point; a row
  // with a part outside it adds that part to Q (one pass over the sample, n * D). When Q is
  // full it starts again from the frame shown. A row counts as inside when less than
  // PROJECT_TOL of its length is outside, so a position is off by at most PROJECT_TOL times
  // the point's distance from the origin: under a hundredth of a pixel.

  var PROJECT_TOL2 = 1e-12; // PROJECT_TOL squared
  var PROJECT_CAP = 32; // directions kept at most

  function makeProjector(D, ids, cap) {
    var K = Math.max(4, cap || PROJECT_CAP);
    var Q = []; // orthonormal directions, Float64Array(D) each
    var P = []; // P[j][i] = (sample point i) . Q[j]
    var coef = new Float64Array(3 * K);
    var X = null;
    var n = 0;
    var self = { D: D, ids: ids, size: 0, added: 0, resets: 0, bind: bind, into: into };

    function column(q, col, from, to) {
      for (var i = from; i < to; i++) {
        var o = ids[i] * D;
        var s = 0;
        for (var d = 0; d < D; d++) s += X[o + d] * q[d];
        col[i] = s;
      }
    }

    // The vector block and how many sample points to answer for. Points beyond the ones
    // already bound (an append) get their coordinates; the earlier rows are unchanged.
    function bind(vectors, count) {
      var from = X === null ? 0 : n;
      X = vectors;
      if (count > from) {
        for (var j = 0; j < Q.length; j++) {
          if (P[j].length < count) {
            var wider = new Float64Array(Math.max(count, ids.length));
            wider.set(P[j].subarray(0, from));
            P[j] = wider;
          }
          column(Q[j], P[j], from, count);
        }
      }
      n = count;
    }

    // Row r's coefficients in Q into coef; true when the row is inside the span.
    function coefficients(F, r) {
      var o = r * D;
      var nf = 0;
      for (var d = 0; d < D; d++) nf += F[o + d] * F[o + d];
      var got = 0;
      for (var j = 0; j < Q.length; j++) {
        var q = Q[j];
        var c = 0;
        for (var d2 = 0; d2 < D; d2++) c += F[o + d2] * q[d2];
        coef[r * K + j] = c;
        got += c * c;
      }
      return nf - got <= PROJECT_TOL2 * nf; // false for NaN too
    }

    // The part of row r outside the span, as a unit vector, or null when there is none
    // to speak of (or the row is not finite).
    function outside(F, r) {
      var o = r * D;
      var q = new Float64Array(D);
      var nf = 0;
      for (var d = 0; d < D; d++) {
        q[d] = F[o + d];
        nf += q[d] * q[d];
      }
      for (var pass = 0; pass < 2; pass++) {
        for (var b of Q) {
          var dp = 0;
          for (var d2 = 0; d2 < D; d2++) dp += q[d2] * b[d2];
          for (var d3 = 0; d3 < D; d3++) q[d3] -= dp * b[d3];
        }
      }
      var nn = 0;
      for (var d4 = 0; d4 < D; d4++) nn += q[d4] * q[d4];
      var real = nn > (PROJECT_TOL2 / 4) * nf; // false for NaN too
      if (!real) return null;
      var inv = 1 / Math.sqrt(nn);
      for (var d5 = 0; d5 < D; d5++) q[d5] *= inv;
      return q;
    }

    // Make row r answerable: 0 when it is (after adding its outside part if it had
    // one), 1 when the basis was full and has been emptied (every row starts again).
    function cover(F, r) {
      if (coefficients(F, r)) return 0;
      var q = outside(F, r);
      if (!q) return 0;
      if (Q.length >= K) {
        Q = [];
        P = [];
        self.resets++;
        return 1;
      }
      var col = new Float64Array(Math.max(n, ids.length));
      column(q, col, 0, n);
      Q.push(q);
      P.push(col);
      self.added++;
      coefficients(F, r);
      return 0;
    }

    // out[3 * i + r] = (sample point i - centre) . (frame row r), for i < n.
    function into(F, C, out) {
      var r = 0;
      var restarts = 0;
      var before = self.added;
      while (r < 3) {
        if (cover(F, r) && restarts < 2) {
          restarts++;
          r = 0;
        } else r++;
      }
      // A direction added for a later row is one the earlier rows have no coefficient
      // for yet: work all three out again against the basis as it is now.
      if (self.added !== before) for (var r2 = 0; r2 < 3; r2++) coefficients(F, r2);
      self.size = Q.length;
      var f0 = 0;
      var f1 = 0;
      var f2 = 0;
      for (var d = 0; d < D; d++) {
        f0 += C[d] * F[d];
        f1 += C[d] * F[D + d];
        f2 += C[d] * F[2 * D + d];
      }
      for (var i = 0; i < n; i++) {
        out[3 * i] = -f0;
        out[3 * i + 1] = -f1;
        out[3 * i + 2] = -f2;
      }
      for (var j = 0; j < Q.length; j++) {
        var col = P[j];
        var c0 = coef[j];
        var c1 = coef[K + j];
        var c2 = coef[2 * K + j];
        for (var i2 = 0; i2 < n; i2++) {
          out[3 * i2] += c0 * col[i2];
          out[3 * i2 + 1] += c1 * col[i2];
          out[3 * i2 + 2] += c2 * col[i2];
        }
      }
      return out;
    }

    return self;
  }

  // The projector for the label sample as it is now (a new one after a replace, a
  // rebuilt sample or a rollback; an append only adds its points).
  function sampleProjector(v, n) {
    var D = v.set.dimension;
    if (v.projector?.ids !== v.labelSample || v.projector.D !== D) v.projector = makeProjector(D, v.labelSample);
    v.projector.bind(v.set.vectors, n);
    return v.projector;
  }

  // The overlay's 2-D context, looked up once (null when there is none).
  function overlayContext(v) {
    if (v.overlayCtx === undefined) v.overlayCtx = safeContext2d(v.overlay);
    return v.overlayCtx;
  }

  function clearOverlay(v) {
    if (overlayContext(v) && v.overlayDirty) {
      v.overlayCtx.clearRect(0, 0, v.W, v.H);
      v.overlayDirty = false;
    }
    clearLabels(v, 0);
  }

  function safeContext2d(canvas) {
    try {
      return canvas.getContext("2d") || null;
    } catch (err) {
      // No 2-D context: the overlay (names, spokes, hover ring) is not drawn.
      return null;
    }
  }

  // A new element for the label pool.
  function newLabel(v) {
    var el = make(v, "span", "tumbler-label", {
      position: "absolute",
      left: "0",
      top: "0",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      willChange: "transform",
    });
    v.labelLayer.appendChild(el);
    var rec = { el: el, text: null, key: "", shown: true };
    v.labelPool.push(rec);
    return rec;
  }

  // Type size of a label: the Wander stop large, a hovered name a little above the rest.
  function labelFontSize(kind) {
    if (kind === "stop") return "26px";
    if (kind === "hover") return "12px";
    return "11px";
  }

  // Where a label sits against its anchor point.
  function labelShift(align) {
    if (align === "center") return "translate(-50%, -100%)";
    if (align === "right") return "translate(-100%, -50%)";
    return "translate(0, -50%)";
  }

  function styleLabel(v, rec, style) {
    var t = v.theme;
    var big = style.kind === "stop";
    setStyles(rec.el, {
      fontFamily: big ? t.fontDisplay : t.fontData,
      fontStyle: big ? "italic" : "normal",
      fontSize: labelFontSize(style.kind),
      letterSpacing: style.kind === "group" ? "0.06em" : "0",
      textTransform: style.kind === "group" ? "uppercase" : "none",
      color: style.colour,
      textShadow: v.outline,
    });
  }

  function label(v, used, str, x, y, style) {
    if (used >= LABEL_POOL) return used;
    var rec = v.labelPool[used] || newLabel(v);
    if (rec.text !== str) {
      rec.el.textContent = str;
      rec.text = str;
    }
    var key = style.kind + "|" + style.colour;
    if (rec.key !== key) {
      styleLabel(v, rec, style);
      rec.key = key;
    }
    var shift = labelShift(style.align);
    rec.el.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) " + shift;
    rec.el.style.opacity = String(Math.round(clamp(style.alpha, 0, 1) * 100) / 100);
    if (!rec.shown) {
      rec.el.style.display = "";
      rec.shown = true;
    }
    return used + 1;
  }

  function clearLabels(v, used) {
    for (var i = used; i < v.labelPool.length; i++) {
      var rec = v.labelPool[i];
      if (rec.shown) {
        rec.el.style.display = "none";
        rec.shown = false;
      }
    }
  }

  function labelText(v, i) {
    var p = v.set.points[i];
    var s = typeof p.label === "string" && p.label.trim() !== "" ? p.label : p.id;
    return shorten(s, 40);
  }

  function drawOverlay(v, s, ds) {
    var ctx = overlayContext(v);
    if (ctx) {
      ctx.clearRect(0, 0, v.W, v.H);
      v.overlayDirty = false;
    }
    var used = 0;
    var fogMix = clamp(Number(s.draw.fog) || 0, 0, 1);
    var n = v.labelSample.length;
    if (v.sx.length < n) {
      v.sx = new Float32Array(LABEL_SAMPLE);
      v.sy = new Float32Array(LABEL_SAMPLE);
    }
    var needSample = (v.showLabels && fogMix < 0.97) || v.hover;
    if (needSample) projectSample(v, s, ds, n);
    // Group names at the middle of their labelled points, fading out as Wander's fog comes in;
    // none in Focus while a search is shown (the results are what matters there).
    var focusSearch = v.modeId === "focus" && v.search.filter > 0;
    if (v.showLabels && fogMix < 0.97 && v.groupNames.length && !focusSearch) used = drawGroupNames(v, used, fogMix, n);
    // Wander: the stop, its labelled neighbours and spokes to them.
    if (s.focus && v.mode) used = drawFocus(v, s, ds, used);
    // Hover: the nearest sampled point within 20 px.
    if (v.hover && n) used = drawHover(v, used, n);
    if (ctx) ctx.globalAlpha = 1;
    clearLabels(v, used);
  }

  // Screen positions of the first n points of the label sample, into v.sx and v.sy:
  // their coordinates along the frame from the projector, then the screen mapping with
  // the draw state merged once.
  function projectSample(v, s, ds, n) {
    if (n === 0) return;
    if (v.sampleCoords.length < 3 * n) v.sampleCoords = new Float64Array(3 * Math.max(n, LABEL_SAMPLE));
    var co = sampleProjector(v, n).into(s.frame, s.centre, v.sampleCoords);
    var put = ET.renderer.placer(ds, v.W, v.H);
    var q = v.placed;
    for (var j = 0; j < n; j++) {
      put(co[3 * j], co[3 * j + 1], co[3 * j + 2], q);
      v.sx[j] = q.x;
      v.sy[j] = q.y;
    }
  }

  function drawGroupNames(v, used, fogMix, n) {
    var dpr = v.dpr;
    var sample = v.labelSample;
    var G = v.groupNames.length;
    var cx = new Float64Array(G);
    var cy = new Float64Array(G);
    var cn = new Float64Array(G);
    for (var k = 0; k < n; k++) {
      var g = v.groupIndex[v.set.points[sample[k]].group];
      if (g === undefined || hiddenPoint(v, sample[k])) continue;
      cx[g] += v.sx[k];
      cy[g] += v.sy[k];
      cn[g]++;
    }
    for (var gi = 0; gi < G; gi++) {
      if (!cn[gi]) continue;
      // Lighter than the points on a dark host (the reference's 72% lightness),
      // darker on a light one so the names stay readable.
      var col = cssRgb(v.theme.light ? mix(groupColour(v, gi), [0, 0, 0], 0.45) : nameTint(groupColour(v, gi)));
      used = label(v, used, shorten(v.groupNames[gi], 32), cx[gi] / cn[gi] / dpr, cy[gi] / cn[gi] / dpr - 14, {
        kind: "group",
        colour: col,
        alpha: (1 - fogMix) * 0.8,
        align: "center",
      });
    }
    return used;
  }

  function drawFocus(v, s, ds, used) {
    var f = s.focus;
    var m = v.mode;
    if (f.to !== m.lastFocusTo) {
      m.prevNeighbours = m.curNeighbours;
      m.lastFocusTo = f.to;
    }
    m.curNeighbours = f.neighbours ? Array.prototype.slice.call(f.neighbours) : [];
    if (f.phase === "dwell") return spokes(v, f.to, m.curNeighbours, 1, s, ds, used);
    var e = clamp(Number(f.e) || 0, 0, 1);
    used = spokes(v, f.from, m.prevNeighbours || [], 1 - e * 1.6, s, ds, used);
    return spokes(v, f.to, m.curNeighbours, e * e, s, ds, used);
  }

  // The index into the label sample of the point nearest the pointer within 20 px, or -1.
  function nearestSampled(v, n) {
    var dpr = v.dpr;
    var best = -1;
    var bd = 20 * dpr * (20 * dpr);
    for (var h = 0; h < n; h++) {
      if (hiddenPoint(v, v.labelSample[h])) continue;
      var dx = v.sx[h] - v.hover.x * dpr;
      var dy = v.sy[h] - v.hover.y * dpr;
      var d2 = dx * dx + dy * dy;
      if (d2 < bd) {
        bd = d2;
        best = h;
      }
    }
    return best;
  }

  function drawHover(v, used, n) {
    var best = nearestSampled(v, n);
    if (best < 0) return used;
    var ctx = v.overlayCtx;
    var dpr = v.dpr;
    var bi = v.labelSample[best];
    if (ctx) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = v.stopColour;
      ctx.beginPath();
      ctx.arc(v.sx[best], v.sy[best], 8 * dpr, 0, TAU);
      ctx.stroke();
      v.overlayDirty = true;
    }
    var right = v.sx[best] > v.W * 0.7;
    var grp = v.set.points[bi].group;
    var str = labelText(v, bi) + (grp ? " · " + shorten(grp, 24) : "");
    return label(v, used, str, v.sx[best] / dpr + (right ? -14 : 14), v.sy[best] / dpr, {
      kind: "hover",
      colour: v.stopColour,
      alpha: 1,
      align: right ? "right" : "left",
    });
  }

  // i is a point index of the current set: 0 <= i < count (false for NaN or a non-number).
  function isPointIndex(v, i) {
    return i >= 0 && i < v.set.count;
  }

  // Spokes from point i to its neighbours, a ring round it and the names, at alpha.
  // Drawn on the overlay's 2-D context when there is one.
  function spokes(v, i, neighbours, alpha, s, ds, used) {
    if (!isPointIndex(v, i) || alpha <= 0.02) return used;
    var ctx = v.overlayCtx;
    var dpr = v.dpr;
    var p = project(v, i, s, ds, v.tmp3);
    var px = p.x;
    var py = p.y;
    var gc = groupColour(v, groupIndexOf(v, v.set.points[i].group));
    var col = cssRgb(v.theme.light ? gc : nameTint(gc));
    for (var j of neighbours) {
      if (!isPointIndex(v, j)) continue;
      var q = project(v, j, s, ds, v.tmp3);
      if (ctx) {
        ctx.globalAlpha = alpha * 0.5;
        ctx.lineWidth = dpr;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        v.overlayDirty = true;
      }
      if (v.showLabels) {
        used = label(v, used, labelText(v, j), q.x / dpr + 8, q.y / dpr + 4, {
          kind: "neighbour",
          colour: v.neighbourColour,
          alpha: alpha * 0.85,
          align: "left",
        });
      }
    }
    if (ctx) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.arc(px, py, 11 * dpr, 0, TAU);
      ctx.stroke();
      v.overlayDirty = true;
    }
    if (v.showLabels) {
      used = label(v, used, labelText(v, i), px / dpr + 18, py / dpr - 12, {
        kind: "stop",
        colour: v.stopColour,
        alpha: alpha,
        align: "left",
      });
    }
    return used;
  }

  // ---------- readout strip ----------

  // One cell per dimension. Its opacity is how much that dimension contributes to the three
  // axes on screen, relative to an even share (the reference's (f0^2 + f1^2 + f2^2) * D / 3).
  // Its colour mixes the three axis colours by the dimension's squared component on each
  // axis, divided by their sum: a dimension that feeds one axis shows that axis's colour.
  function drawStrip(v, F) {
    if (!v.stripCtx || !v.stripImage || !v.set) return;
    var D = v.set.dimension;
    var px = v.stripImage.data;
    var c = v.axisRgb;
    for (var d = 0; d < D; d++) {
      var ax = F[d] * F[d];
      var ay = F[D + d] * F[D + d];
      var az = F[2 * D + d] * F[2 * D + d];
      var sum = ax + ay + az;
      var norm = sum > 0 ? sum : 1;
      var o = d * 4;
      px[o] = (c[0][0] * ax + c[1][0] * ay + c[2][0] * az) / norm;
      px[o + 1] = (c[0][1] * ax + c[1][1] * ay + c[2][1] * az) / norm;
      px[o + 2] = (c[0][2] * ax + c[1][2] * ay + c[2][2] * az) / norm;
      px[o + 3] = Math.min(255, ((sum * D) / 3) * 80);
    }
    v.stripCtx.putImageData(v.stripImage, 0, 0);
  }

  // ---------- input ----------

  function listen(v, target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    v.listeners.push([target, type, fn, opts]);
  }

  function setZoom(v, z) {
    var next = clamp(z, ZOOM_MIN, ZOOM_MAX);
    if (Math.abs(next - 1) < 0.02) next = 1;
    v.userZoom = next;
    v.statusClock = STATUS_EVERY;
    invalidate(v);
    return v.userZoom;
  }

  // ---------- the user pan ----------

  // Device pixels per pan unit: the renderer's R for this stage (the radius of the draw state
  // last drawn, which no mode changes, else the renderer's default).
  function panUnit(v) {
    var r = v.lastDraw?.radius;
    var radius = typeof r === "number" && r > 0 ? r : ET.renderer.DEFAULTS.radius;
    return Math.max(1e-6, Math.min(v.W || 1, v.H || 1) * radius);
  }

  // The pan clamped so the picture's centre (the point the zoom scales about) stays on the
  // stage: |x| at most half the stage's width and |y| half its height, in pan units.
  function clampPan(v, x, y) {
    var u = panUnit(v);
    var lx = (v.W || 1) / 2 / u;
    var ly = (v.H || 1) / 2 / u;
    return [clamp(x, -lx, lx), clamp(y, -ly, ly)];
  }

  function panned(v) {
    return v.pan[0] !== 0 || v.pan[1] !== 0;
  }

  function setPan(v, x, y) {
    var ok = typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y);
    v.pan = ok ? clampPan(v, x, y) : [0, 0];
    v.statusClock = STATUS_EVERY;
    invalidate(v);
    return [v.pan[0], v.pan[1]];
  }

  // Move the picture by (dx, dy) CSS pixels on screen (y down, as pointer coordinates are).
  function panByPixels(v, dx, dy) {
    var u = panUnit(v);
    setPan(v, v.pan[0] + (dx * v.dpr) / u, v.pan[1] - (dy * v.dpr) / u);
  }

  // Zoom 1 and no pan: what double-click, double-tap, the 0 key, the Reset view button and the
  // handle's resetView() and resetZoom() all do.
  function resetView(v) {
    setZoom(v, 1);
    setPan(v, 0, 0);
  }

  function hasFocus(v) {
    var a = v.doc.activeElement;
    return !!a && (a === v.root || (typeof v.root.contains === "function" && v.root.contains(a)));
  }

  function setRunning(v, run) {
    run = !!run;
    if (run === v.running) return;
    v.running = run;
    v.playButton.textContent = run ? "Pause" : "Play";
    v.playButton.setAttribute("aria-pressed", run ? "false" : "true");
    v.statusClock = STATUS_EVERY;
    call(v, v.options.onPauseChange, !run);
    invalidate(v);
  }

  // A key pressed while the viewer has focus (no modifier, not in a form field).
  // Returns true when the key did something, so its default action is prevented.
  function handleKey(v, k, target) {
    if (k === "Escape" || k === "Esc") {
      if (v.noticeMessage === null) return false;
      clearNotice(v);
      return true;
    }
    if (/^[1-9]$/.test(k)) return switchByKey(v, Number(k) - 1);
    if ((k === " " || k === "Spacebar") && target === v.root) {
      setRunning(v, !v.running);
      return true;
    }
    if (k === "+" || k === "=") {
      setZoom(v, v.userZoom * 1.25);
      return true;
    }
    if (k === "-" || k === "_") {
      setZoom(v, v.userZoom / 1.25);
      return true;
    }
    if (k === "0") {
      resetView(v);
      return true;
    }
    var arrow = Object.hasOwn(ARROWS, k) ? ARROWS[k] : null;
    if (arrow) {
      setPan(v, v.pan[0] + arrow[0] * PAN_STEP, v.pan[1] + arrow[1] * PAN_STEP);
      return true;
    }
    return false;
  }

  // The arrow keys move the picture the way they point (x right, y up).
  var ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

  // Keys 1-9: the view of that mode button, if there is one.
  function switchByKey(v, idx) {
    if (idx >= v.modeButtons.length) return false;
    setMode(v, v.modeButtons[idx].id);
    return true;
  }

  function wire(v) {
    var stage = v.stage;
    var pointers = {};
    var count = 0;
    var lastTap = null;

    function pos(e) {
      var r = { left: 0, top: 0 };
      try {
        r = stage.getBoundingClientRect();
      } catch (err) {
        // No layout box: measure from the page origin.
        r = { left: 0, top: 0 };
      }
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function pinchMid() {
      var ids = Object.keys(pointers);
      var a = pointers[ids[0]];
      var b = pointers[ids[1]];
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    function pinchDistance() {
      var ids = Object.keys(pointers);
      if (ids.length < 2) return 0;
      var a = pointers[ids[0]];
      var b = pointers[ids[1]];
      return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
    }

    // Only a press on the sky itself turns the cloud. A press on a control inside the
    // stage (the notice's Dismiss button, a message) is left alone: no pointer
    // capture, no drag, no focus change, so the control gets its own click.
    function onSky(e) {
      var t = e.target;
      return t === stage || t === v.canvas || t === v.overlay || t === v.labelLayer;
    }

    // The left button turns (with Shift it pans); the right button pans; others do nothing.
    listen(v, stage, "pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0 && e.button !== 2) return;
      if (!onSky(e)) return;
      pointers[e.pointerId] = {
        x: e.clientX,
        y: e.clientY,
        sx: e.clientX,
        sy: e.clientY,
        t: now(v),
        pan: e.button === 2 || !!e.shiftKey, // a pan press is never a Focus click
      };
      count = Object.keys(pointers).length;
      try {
        if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId);
      } catch (err) {
        // capture is optional
      }
      if (!hasFocus(v)) {
        try {
          v.root.focus({ preventScroll: true });
        } catch (err) {
          // focus is a convenience
        }
      }
      if (count >= 2) {
        v.drag.active = false;
        var mid = pinchMid();
        v.pinch = { d0: pinchDistance() || 1, z0: v.userZoom, mx: mid.x, my: mid.y, px: v.pan[0], py: v.pan[1] };
      } else {
        v.drag.active = true;
        v.drag.pan = e.button === 2 || !!e.shiftKey;
        v.drag.x = e.clientX;
        v.drag.y = e.clientY;
        stage.style.cursor = "grabbing";
      }
      invalidate(v);
    });
    listen(v, stage, "pointermove", function (e) {
      var pt = pointers[e.pointerId];
      if (pt) {
        pt.x = e.clientX;
        pt.y = e.clientY;
      }
      if (v.pinch && count >= 2) {
        // the fingers' distance zooms; their midpoint's movement pans
        setZoom(v, v.pinch.z0 * (pinchDistance() / v.pinch.d0));
        var mid = pinchMid();
        var u = panUnit(v);
        setPan(v, v.pinch.px + ((mid.x - v.pinch.mx) * v.dpr) / u, v.pinch.py - ((mid.y - v.pinch.my) * v.dpr) / u);
        return;
      }
      if (v.drag.active && pt && v.drag.pan) {
        panByPixels(v, e.clientX - v.drag.x, e.clientY - v.drag.y);
        v.drag.x = e.clientX;
        v.drag.y = e.clientY;
        v.hover = null;
        return;
      }
      if (v.drag.active && pt) {
        v.drag.yaw += (e.clientX - v.drag.x) * 0.007;
        v.drag.pitch = clamp(v.drag.pitch + (e.clientY - v.drag.y) * 0.007, -1.46, 1.14);
        v.drag.x = e.clientX;
        v.drag.y = e.clientY;
        v.hover = null;
        invalidate(v);
        return;
      }
      if (e.pointerType === "mouse" || e.pointerType === undefined) {
        v.hover = pos(e);
        invalidate(v);
      }
    });
    function end(e) {
      var pt = pointers[e.pointerId];
      delete pointers[e.pointerId];
      count = Object.keys(pointers).length;
      if (count < 2) v.pinch = null;
      if (count === 0) {
        v.drag.active = false;
        v.drag.pan = false;
        stage.style.cursor = "grab";
      }
      if (e.type === "pointerup" && pt && !pt.pan) focusClick(v, e, pt, pos(e));
      // Double tap (touch or pen) resets the zoom; a mouse uses dblclick.
      if (e.type === "pointerup" && pt && e.pointerType && e.pointerType !== "mouse") {
        var moved = Math.abs(e.clientX - pt.sx) + Math.abs(e.clientY - pt.sy);
        var t = now(v);
        if (moved < 12 && t - pt.t < 300) {
          if (lastTap && t - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) + Math.abs(e.clientY - lastTap.y) < 32) {
            resetView(v);
            lastTap = null;
          } else lastTap = { t: t, x: e.clientX, y: e.clientY };
        }
      }
      invalidate(v);
    }
    listen(v, stage, "pointerup", end);
    listen(v, stage, "pointercancel", end);
    listen(v, stage, "pointerleave", function () {
      v.hover = null;
      invalidate(v);
    });
    listen(v, stage, "dblclick", function (e) {
      if (!onSky(e)) return;
      if (e.preventDefault) e.preventDefault();
      resetView(v);
    });
    // A right-drag pans, so the browser's context menu is not opened over the sky.
    listen(v, stage, "contextmenu", function (e) {
      if (onSky(e) && e.preventDefault) e.preventDefault();
    });
    // Wheel zooms only over the stage and only with Ctrl or Cmd held (a trackpad pinch
    // arrives that way) or while the viewer has focus; otherwise the page scrolls.
    listen(
      v,
      stage,
      "wheel",
      function (e) {
        var mod = !!(e.ctrlKey || e.metaKey);
        if (!mod && !hasFocus(v)) return;
        if (e.preventDefault) e.preventDefault();
        var dy = Number(e.deltaY) || 0;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= 400;
        setZoom(v, v.userZoom * Math.exp(-dy * (mod ? 0.01 : 0.0015)));
      },
      { passive: false }
    );

    listen(v, v.root, "keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var target = e.target;
      var tag = target?.tagName ? String(target.tagName).toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (handleKey(v, e.key, target) && e.preventDefault) e.preventDefault();
    });

    v.modeButtons.forEach(function (mb) {
      listen(v, mb.button, "click", function () {
        setMode(v, mb.id);
      });
    });
    listen(v, v.playButton, "click", function () {
      setRunning(v, !v.running);
    });
    listen(v, v.zoomResetButton, "click", function () {
      resetView(v);
    });
    listen(v, v.noticeDismiss, "click", function () {
      clearNotice(v);
    });
    listen(v, v.speedInput, "input", function () {
      var s = Number(v.speedInput.value);
      v.speed = Number.isFinite(s) && s > 0 ? s : 1;
    });
    listen(v, v.labelsInput, "change", function () {
      v.showLabels = !!v.labelsInput.checked;
      invalidate(v);
    });
    listen(v, v.trailsInput, "change", function () {
      v.trails = !!v.trailsInput.checked;
      v.needClear = true;
      invalidate(v);
    });

    // Pause while the document is hidden or the element is off screen.
    listen(v, v.doc, "visibilitychange", function () {
      if (suspended(v)) unschedule(v);
      else invalidate(v);
    });
    var IO = v.win?.IntersectionObserver;
    if (typeof IO === "function") {
      v.io = new IO(function (entries) {
        var last = entries?.length ? entries.at(-1) : null;
        if (!last) return;
        v.onScreen = !!last.isIntersecting;
        if (suspended(v)) unschedule(v);
        else invalidate(v);
      });
      v.io.observe(v.root);
    }
    var RO = v.win?.ResizeObserver;
    if (typeof RO === "function") {
      v.ro = new RO(function () {
        measure(v);
      });
      v.ro.observe(v.stage);
      v.ro.observe(v.root);
    } else if (typeof v.win?.addEventListener === "function") {
      listen(v, v.win, "resize", function () {
        measure(v);
      });
    }
  }

  // ---------- renderer ----------

  function makeRenderer(v) {
    var made = ET.renderer.create(v.canvas, {
      releaseContext: true, // the canvas is thrown away by destroy
      preserveDrawingBuffer: !!v.options.preserveDrawingBuffer,
      onContextChange: function (ev) {
        if (v.destroyed) return;
        if (ev.type === "lost") {
          v.rendering = false;
          notify(v, "The graphics context was lost; waiting for the browser to restore it.");
        } else if (ev.type === "restored") {
          v.rendering = true;
          if (v.mode) v.mode.wiresVersion = -1;
          clearNotice(v);
          v.needClear = true;
          invalidate(v);
        } else {
          v.rendering = false;
          fatal(v, ev.message || "The graphics context could not be restored.");
          retryRebuild(v);
        }
      },
    });
    if (!made.ok) {
      v.renderer = null;
      v.rendering = false;
      fatal(v, made.message);
      return;
    }
    v.renderer = made.renderer;
    v.rendering = true;
  }

  // One retry a second after a failed restore; further retries happen on update.
  function retryRebuild(v) {
    if (v.retryTimer || typeof v.win?.setTimeout !== "function") return;
    v.retryTimer = v.win.setTimeout(function () {
      v.retryTimer = 0;
      if (v.destroyed || !v.renderer) return;
      var r = v.renderer.rebuild();
      if (r?.ok) {
        v.rendering = true;
        clearFatal(v);
        if (v.mode) v.mode.wiresVersion = -1;
        invalidate(v);
      }
    }, 1000);
  }

  // ---------- search ----------
  //
  // docs/search-interface.md, "Viewer (t8)". The viewer holds the searches shown, runs the
  // host's embed and rerank callbacks (it never fetches anything itself), pumps the ranking,
  // word-matching and facing-frame steppers inside the frame budget, hands the lit values to
  // the renderer and the facing frame to the mode. One run (a setSearches call, a settings
  // change or a re-run after an append) is in progress at a time; a newer run supersedes it,
  // and every late callback answer or stepper result of a superseded run is dropped.

  var SEARCH_MESSAGES = {
    "no-embedder":
      "Cannot embed the query: the host supplied no embed callback. Search among the loaded points still works.",
    "embed-failed": "The embedder failed to answer. The earlier results are kept.",
    "embed-timeout": "The embedder did not answer within {seconds} seconds. The earlier results are kept.",
    "embed-malformed": "The embedder's answer was not a vector with a model id. The earlier results are kept.",
    "rerank-failed": "The reranker failed to answer; the results stay in embedding order.",
    "rerank-timeout": "The reranker did not answer within {seconds} seconds; the results stay in embedding order.",
    "rerank-no-text": "A vector search with no label has no text to send to the reranker; it stays in embedding order.",
    "too-many-searches": "At most 4 searches at once; {found} were given.",
    "bad-search": "A search must be text, { text }, { vector, model } or { point }, given in an array.",
    superseded: "A newer search replaced this one.",
    destroyed: "This viewer has been destroyed.",
  };
  var FILTER_TIME = 0.35; // seconds: the reference's filterMix time constant
  var CLICK_SLOP = 5; // px a Focus click may move between press and release
  var CLICK_REACH = 16; // px from a point a Focus click may land

  function searchRefusal(code, values) {
    var tpl = Object.hasOwn(SEARCH_MESSAGES, code) ? SEARCH_MESSAGES[code] : null;
    var message = tpl
      ? tpl.replaceAll(/\{(\w+)\}/g, function (all, name) {
          return values && Object.hasOwn(values, name) ? String(values[name]) : all;
        })
      : ET.search.format(code, values);
    return { ok: false, code: code, message: message };
  }

  function plainRefusal(r) {
    return { ok: false, code: r.code, message: r.message };
  }

  function isObj(x) {
    return !!x && typeof x === "object";
  }

  function newSearchState(opts) {
    var ms = Number(opts.searchTimeoutMs);
    return {
      embed: typeof opts.embed === "function" ? opts.embed : null,
      rerank: typeof opts.rerank === "function" ? opts.rerank : null,
      timeoutMs: ms > 0 ? ms : 15000,
      settings: {
        k: ET.search.clampK(opts.searchK),
        candidates: ET.search.clampCandidates(opts.searchCandidates),
        top: ET.search.clampTop(opts.searchTop, opts.searchCandidates),
        lit: ET.searchSets.litSetting(opts.searchLit),
        distances: false,
        rerank: false,
        pointOfView: null,
        onlyResults: false,
      },
      run: null, // the run in progress
      work: [], // steppers of the run in progress: { run, job, after }
      shown: [], // the searches shown, in letter order
      shownSet: null, // the set they were worked out on
      shownUsed: null, // the settings they were worked out with: { k, candidates, top, pointOfView, rerank }
      lit: null, // ET.searchSets.litValues of the searches shown
      pairs: [],
      unmatched: [],
      code: null,
      message: null,
      facingJob: null, // { job, swing }
      facingTarget: null, // the facing frame of the searches shown, once worked out
      filter: 0, // eased toward 1 while a search is shown, toward 0 when none is
      litUploaded: false,
      hideUnlit: false, // Focus's Only results hides unlit points this frame
      panel: null,
      // The relative view (docs/relative-interface.md, "Viewer (t9, t10)").
      relActive: false, // the relative view is shown this frame
      litRelative: false, // the lit values uploaded hold the gradient
      relKey: "", // what onSearchChange last saw of the relative view
      gradient: null, // { shown, values } the gradient for the searches shown
      heights: null, // { shown, list } heights and cosines of the results shown
      unit: null, // { set, unit } ET.math.unitLength of the set shown
    };
  }

  function isCurrent(v, run) {
    return !v.destroyed && v.search.run === run;
  }

  // ----- timers and guarded callbacks -----

  function clearRunTimers(v, run) {
    var w = v.win;
    for (var id of run.timers) if (typeof w?.clearTimeout === "function") w.clearTimeout(id);
    run.timers = [];
  }

  // Call a host callback with exactly `args`. `done` gets { ok: true, value } or a refusal
  // (<prefix>-failed, <prefix>-timeout), once, and only while the run is current: a late
  // answer of a superseded run, or any answer after destroy, touches nothing.
  function callHost(v, run, fn, args, prefix, done) {
    var settled = false;
    var timer = 0;
    function finish(outcome) {
      if (settled) return;
      settled = true;
      if (!isCurrent(v, run)) return;
      if (timer) {
        run.timers = run.timers.filter(function (t) {
          return t !== timer;
        });
        v.win.clearTimeout(timer);
      }
      done(outcome);
    }
    var w = v.win;
    if (typeof w?.setTimeout === "function" && typeof w.clearTimeout === "function") {
      timer = w.setTimeout(function () {
        finish(searchRefusal(prefix + "-timeout", { seconds: v.search.timeoutMs / 1000 }));
      }, v.search.timeoutMs);
      run.timers.push(timer);
    }
    var answer;
    try {
      answer = Promise.resolve(fn(...args));
    } catch (err) {
      // The host's error is the host's own: it may carry an address or a key, so it is
      // not shown; the refusal says only that the callback failed.
      finish(searchRefusal(prefix + "-failed"));
      return;
    }
    answer.then(
      function (value) {
        finish({ ok: true, value: value });
      },
      function () {
        finish(searchRefusal(prefix + "-failed"));
      }
    );
  }

  // ----- entries -----

  // One entry of setSearches as a source: { ok: true, src } or a refusal. A text source
  // says whether it is embedded or matched among the loaded points; a vector or point
  // source is checked here (they need no callback).
  function parseEntry(v, entry) {
    if (typeof entry === "string") return textSource(v, entry, "auto");
    if (!isObj(entry)) return searchRefusal("bad-search");
    try {
      if (typeof entry.text === "string") return textSource(v, entry.text, entry.via);
      if (entry.vector !== undefined) return vectorSource(v, entry);
      if (entry.point !== undefined) return pointSource(v, entry.point);
    } catch {
      // A getter on the host's entry threw: the entry is not one of the forms.
      return searchRefusal("bad-search");
    }
    return searchRefusal("bad-search");
  }

  function textSource(v, text, via) {
    if (ET.search.tokens(text).length === 0) return searchRefusal("empty-query");
    var s = v.search;
    var same = ET.search.checkSameSpace(v.set);
    if (via === "words") return { ok: true, src: { kind: "words", text: text, note: null } };
    if (via === "embed") {
      if (!s.embed) return searchRefusal("no-embedder");
      if (!same.ok) return plainRefusal(same);
      return { ok: true, src: { kind: "embedded", text: text, note: null } };
    }
    if (s.embed && same.ok) return { ok: true, src: { kind: "embedded", text: text, note: null } };
    var note = s.embed && same.code === "reduction-not-searchable" ? same.message : null;
    return { ok: true, src: { kind: "words", text: text, note: note } };
  }

  function vectorSource(v, entry) {
    var c = ET.search.checkQuery(v.set, { vector: entry.vector, model: entry.model });
    if (!c.ok) return plainRefusal(c);
    var label = typeof entry.label === "string" && entry.label !== "" ? entry.label : null;
    return {
      ok: true,
      src: prepared("vector", label || "vector", entry.model, c.vector, { rerankText: label }),
    };
  }

  function pointSource(v, id) {
    var c = ET.search.pointQuery(v.set, id);
    if (!c.ok) return plainRefusal(c);
    return {
      ok: true,
      src: prepared("point", String(c.id), v.set.model, c.vector, {
        point: c.id,
        rerankText: ET.search.pointText(v.set, c.index),
      }),
    };
  }

  // A search whose query vector is known.
  function prepared(kind, text, model, query, extra) {
    var q = {
      kind: kind,
      text: text,
      model: model,
      queryForm: null,
      sentTo: "nowhere",
      words: null,
      point: null,
      baseNote: null,
      query: query,
      rerankText: null,
      ready: true,
    };
    if (extra) for (var k in extra) if (Object.hasOwn(extra, k)) q[k] = extra[k];
    return q;
  }

  // ----- runs -----

  function newRun(v, kind, resolve, swing) {
    return {
      kind: kind, // "set" | "settings" | "rerun"
      resolve: resolve,
      swing: swing,
      timers: [],
      searches: [], // one slot per entry; null when left out
      left: 0,
      unmatched: [],
      set: v.set,
      used: null,
      pendingEmbed: 0,
      pendingRerank: 0,
      pairs: null,
    };
  }

  // End the run in progress (if any) with `result` for its caller.
  function endRun(v, result) {
    var s = v.search;
    var run = s.run;
    if (!run) return;
    s.run = null;
    s.work = [];
    clearRunTimers(v, run);
    if (run.resolve) run.resolve(result);
  }

  function beginRun(v, run) {
    endRun(v, searchRefusal("superseded"));
    v.search.run = run;
  }

  function refuseRun(v, run, refusal) {
    if (!isCurrent(v, run)) return;
    var s = v.search;
    endRun(v, refusal);
    s.code = refusal.code;
    s.message = refusal.message;
    call(v, v.options.onError, plainRefusal(refusal));
    searchChanged(v);
    // A refused new search leaves the earlier ones; if they were waiting to be worked out
    // again (an append, a settings change), that starts now. A refused re-run is not retried.
    if (run.kind === "set" && needsRerun(v)) rerun(v, "rerun", null);
  }

  function setSearches(v, list) {
    if (v.destroyed) return Promise.resolve(searchRefusal("destroyed"));
    if (!Array.isArray(list)) return Promise.resolve(searchRefusal("bad-search"));
    if (list.length > ET.searchSets.MAX_SEARCHES) {
      return Promise.resolve(searchRefusal("too-many-searches", { found: list.length }));
    }
    if (list.length === 0) {
      clearSearches(v);
      return Promise.resolve({ ok: true, search: searchInfo(v) });
    }
    return new Promise(function (resolve) {
      var run = newRun(v, "set", resolve, true);
      beginRun(v, run);
      startSources(v, run, list);
    });
  }

  function startSources(v, run, list) {
    if (!v.set || v.set.count === 0) {
      refuseRun(v, run, searchRefusal("no-data"));
      return;
    }
    var sources = [];
    for (var entry of list) {
      var p = parseEntry(v, entry);
      if (!p.ok) {
        refuseRun(v, run, p);
        return;
      }
      sources.push(p.src);
    }
    resolveSources(v, run, sources);
    searchChanged(v); // waiting
    invalidate(v);
  }

  // Turn every source into a prepared search: embed through the host, or match words in
  // the frame budget; the others are ready already.
  function resolveSources(v, run, sources) {
    run.searches = new Array(sources.length).fill(null);
    run.left = sources.length;
    sources.forEach(function (src, i) {
      if (src.ready) settleSource(v, run, i, { ok: true, search: src });
      else if (src.kind === "embedded") embedSource(v, run, i, src);
      else matchWords(v, run, i, src);
    });
  }

  function settleSource(v, run, i, outcome) {
    if (!isCurrent(v, run)) return;
    if (!outcome.ok) {
      refuseRun(v, run, outcome);
      return;
    }
    run.searches[i] = outcome.search; // null: a words entry that matched nothing
    run.left--;
    if (run.left === 0) startRanking(v, run);
  }

  function embedSource(v, run, i, src) {
    run.pendingEmbed++;
    callHost(v, run, v.search.embed, [src.text], "embed", function (outcome) {
      run.pendingEmbed--;
      settleSource(v, run, i, outcome.ok ? checkEmbedded(v, src, outcome.value) : outcome);
    });
  }

  // The embed callback's answer, checked before anything reaches the renderer.
  function checkEmbedded(v, src, answer) {
    var vector;
    var model;
    var form;
    try {
      if (!isObj(answer) || answer.vector === undefined) return searchRefusal("embed-malformed");
      vector = answer.vector;
      model = answer.model;
      form = answer.queryForm;
    } catch {
      // A getter on the answer threw: not a vector with a model id.
      return searchRefusal("embed-malformed");
    }
    var c = ET.search.checkQuery(v.set, { vector: vector, model: model });
    if (!c.ok) return plainRefusal(c);
    return {
      ok: true,
      search: prepared("embedded", src.text, model, c.vector, {
        queryForm: typeof form === "string" ? form : null,
        sentTo: "embedder",
        rerankText: src.text,
      }),
    };
  }

  function matchWords(v, run, i, src) {
    queueWork(v, run, ET.search.makeWordQuery(v.set, src.text), function (r) {
      settleSource(v, run, i, wordOutcome(v, run, src, r));
    });
  }

  function wordOutcome(v, run, src, r) {
    for (var w of r.unmatched || []) if (!run.unmatched.includes(w)) run.unmatched.push(w);
    if (!r.ok) return r.code === "words-none" ? { ok: true, search: null } : plainRefusal(r);
    return {
      ok: true,
      search: prepared("words", src.text, v.set.model, r.vector, {
        words: { used: r.used.map(copyUsed), unmatched: r.unmatched.slice() },
        baseNote: src.note,
        rerankText: src.text,
      }),
    };
  }

  function copyUsed(u) {
    return { word: u.word, how: u.how, count: u.count };
  }

  function queueWork(v, run, job, after) {
    v.search.work.push({ run: run, job: job, after: after });
    invalidate(v);
  }

  // ----- ranking and reranking -----

  function startRanking(v, run) {
    var kept = run.searches.filter(Boolean);
    if (kept.length === 0) {
      refuseRun(v, run, searchRefusal("words-none", { words: run.unmatched.join(", ") }));
      return;
    }
    var st = v.search.settings;
    kept = giveLetters(v, kept);
    run.searches = kept;
    run.set = v.set;
    run.used = {
      k: st.k,
      candidates: st.candidates,
      top: st.top,
      // With letters by position this is "the letter's position is among the kept".
      pointOfView: hasLetter(kept, st.pointOfView) ? st.pointOfView : null,
      rerank: st.rerank,
    };
    var counts = { k: st.k, candidates: st.candidates, top: st.top };
    run.left = kept.length;
    kept.forEach(function (q) {
      q.scale = run.used.pointOfView === q.letter ? ET.searchSets.scaleFor(q.query) : null;
      q.reranker = null;
      q.sent = 0;
      q.note = q.baseNote;
      queueWork(v, run, ET.search.makeRank(run.set, q.query, { ...counts, scale: q.scale }), function (ranking) {
        q.ranking = ranking;
        q.view = ranking;
        run.left--;
        if (run.left === 0) startRerank(v, run);
      });
    });
  }

  // ----- letters (docs/relative-interface.md, "Letters are kept") -----

  function hasLetter(list, letter) {
    return (
      letter !== null &&
      list.some(function (q) {
        return q.letter === letter;
      })
    );
  }

  // Letters for the kept searches, which come back in letter order. With the Relative
  // setting off they go by position, as they always have. With it on, an entry that is the
  // same search as one shown keeps that search's letter, and the others take the lowest
  // free letters in list order.
  function giveLetters(v, kept) {
    var L = ET.searchSets.LETTERS;
    if (!v.rel.relative) {
      kept.forEach(function (q, j) {
        q.letter = ET.searchSets.letter(j);
      });
      return kept;
    }
    var shown = v.search.shown;
    var taken = [];
    kept.forEach(function (q) {
      var old = shown.find(function (o) {
        return !taken.includes(o.letter) && sameSearch(o, q);
      });
      q.letter = old ? old.letter : null;
      if (old) taken.push(old.letter);
    });
    kept.forEach(function (q) {
      if (q.letter !== null) return;
      q.letter = L.find(function (x) {
        return !taken.includes(x);
      });
      taken.push(q.letter);
    });
    return kept.slice().sort(function (a, b) {
      return L.indexOf(a.letter) - L.indexOf(b.letter);
    });
  }

  // The same search: same kind, and the same text (a typed search, embedded or matched
  // among the points), the same point id, or the same vector bytes and model.
  function sameSearch(a, b) {
    if (a.kind !== b.kind) return false;
    if (a.kind === "point") return a.point === b.point;
    if (a.kind === "vector") return a.model === b.model && sameValues(a.query, b.query);
    return a.text === b.text;
  }

  function sameValues(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var d = 0; d < a.length; d++) if (a[d] !== b[d]) return false;
    return true;
  }

  // Letters by position again (the Relative setting is off): the point of view follows
  // its search. Returns true when a letter changed.
  function letterByPosition(v) {
    var s = v.search;
    var map = {};
    var changed = false;
    s.shown.forEach(function (q, j) {
      var to = ET.searchSets.letter(j);
      map[q.letter] = to;
      if (q.letter !== to) changed = true;
    });
    if (!changed) return false;
    s.shown.forEach(function (q, j) {
      q.letter = ET.searchSets.letter(j);
    });
    var pov = s.settings.pointOfView;
    if (pov !== null) s.settings.pointOfView = Object.hasOwn(map, pov) ? map[pov] : null;
    if (s.shownUsed && s.shownUsed.pointOfView !== null) {
      var used = s.shownUsed.pointOfView;
      s.shownUsed.pointOfView = Object.hasOwn(map, used) ? map[used] : null;
    }
    return true;
  }

  function rerankOn(v, run) {
    return !!(run.used.rerank && v.search.rerank && run.set.text_included);
  }

  function startRerank(v, run) {
    if (!rerankOn(v, run)) {
      startPairs(v, run);
      return;
    }
    run.left = run.searches.length;
    run.searches.forEach(function (q) {
      if (q.rerankText === null) {
        q.note = searchRefusal("rerank-no-text").message;
        rerankDone(v, run);
        return;
      }
      var candidates = q.ranking.pool.map(function (hit) {
        return ET.search.pointText(run.set, hit.index);
      });
      q.sent = candidates.length; // never more than the candidates stated
      run.pendingRerank++;
      callHost(v, run, v.search.rerank, [q.rerankText, candidates], "rerank", function (outcome) {
        run.pendingRerank--;
        applyRerank(q, outcome);
        rerankDone(v, run);
      });
    });
  }

  function rerankDone(v, run) {
    run.left--;
    if (run.left === 0) startPairs(v, run);
  }

  // The pair reports, in the frame budget (with 100 results a search they cost far more than a
  // frame), then the run is shown.
  function startPairs(v, run) {
    if (!isCurrent(v, run)) return;
    var job;
    try {
      job = ET.searchSets.makePairReports(
        run.set,
        run.searches.map(function (q) {
          return q.view;
        })
      );
    } catch (err) {
      // Rankings always index the set they were made on; nothing to pair otherwise.
      job = null;
    }
    if (!job) {
      run.pairs = [];
      commitRun(v, run);
      return;
    }
    queueWork(v, run, job, function (pairs) {
      run.pairs = pairs;
      commitRun(v, run);
    });
  }

  // A reranker's answer: the new order, or a note and the embedding order kept.
  function applyRerank(q, outcome) {
    if (!outcome.ok) {
      q.note = outcome.message;
      return;
    }
    var scores;
    var model;
    try {
      scores = isObj(outcome.value) ? outcome.value.scores : undefined;
      model = isObj(outcome.value) ? outcome.value.model : undefined;
    } catch {
      // A getter on the answer threw: treated as a malformed answer below.
      scores = undefined;
    }
    var r = typeof model === "string" && model !== "" ? ET.search.rerankOrder(q.ranking, scores) : null;
    if (!r?.ok) {
      q.note = r ? r.message : ET.search.format("rerank-malformed");
      return;
    }
    q.view = { ...q.ranking, hits: r.hits, near: r.near, radius: r.radius };
    q.reranker = model;
  }

  // ----- what is shown -----

  function views(s) {
    return s.shown.map(function (q) {
      return q.view;
    });
  }

  function commitRun(v, run) {
    if (!isCurrent(v, run)) return;
    var s = v.search;
    s.run = null;
    s.work = [];
    clearRunTimers(v, run);
    s.shown = run.searches;
    s.shownSet = run.set;
    s.shownUsed = run.used;
    if (run.kind === "set") s.unmatched = run.unmatched.slice();
    s.code = null;
    s.message = null;
    if (run.kind === "set" && run.used.pointOfView === null) s.settings.pointOfView = null;
    // Relative turned off while this run worked: its kept letters go back to positions
    // (with the setting off from the start the letters are positional already).
    if (!v.rel.relative) letterByPosition(v);
    relight(v);
    s.pairs = run.pairs || [];
    startFacing(v, run.swing);
    notifyModeSearch(v);
    if (run.resolve) run.resolve({ ok: true, search: searchInfo(v) });
    searchChanged(v);
    if (needsRerun(v)) rerun(v, "rerun", null);
    invalidate(v);
  }

  // The searches shown are from before an append, or were worked out with settings that
  // have changed since: they need working out again (with no swing).
  function needsRerun(v) {
    var s = v.search;
    if (!s.shown.length || !v.set) return false;
    var u = s.shownUsed;
    var st = s.settings;
    return s.shownSet !== v.set || countsChanged(u, st) || u.pointOfView !== st.pointOfView || u.rerank !== st.rerank;
  }

  function countsChanged(a, b) {
    return a.k !== b.k || a.candidates !== b.candidates || a.top !== b.top;
  }

  // Work the searches shown out again from the query vectors held (word searches match
  // their words again over the set now shown). No embed call, no swing.
  function rerun(v, kind, resolve) {
    var s = v.search;
    var run = newRun(v, kind, resolve, false);
    var sources = s.shown.map(function (q) {
      if (q.kind === "words") return { kind: "words", text: q.text, note: q.baseNote };
      return prepared(q.kind, q.text, q.model, q.query, {
        queryForm: q.queryForm,
        sentTo: q.sentTo,
        point: q.point,
        baseNote: q.baseNote,
        rerankText: q.rerankText,
      });
    });
    beginRun(v, run);
    resolveSources(v, run, sources);
    searchChanged(v);
    invalidate(v);
  }

  // Lit values for the searches shown, and their upload to the renderer.
  function relight(v) {
    var s = v.search;
    s.lit = s.shown.length ? ET.searchSets.litValues(views(s), v.set.count, s.settings.lit) : null;
    uploadLit(v);
  }

  function uploadLit(v) {
    var s = v.search;
    var r = v.renderer;
    if (!r || !s.lit) return;
    var n = r.status().count;
    var lit = new Float32Array(n);
    var shared = new Uint8Array(n);
    lit.set(s.lit.lit.subarray(0, Math.min(n, s.lit.lit.length)));
    shared.set(s.lit.shared.subarray(0, Math.min(n, s.lit.shared.length)));
    // In the relative view, points the searches do not light get the faint gradient; the
    // lit values above 0 are kept exactly (results follow the Lit setting as without it).
    s.litRelative = s.relActive;
    var grad = s.relActive ? relativeGradient(v) : null;
    if (grad) {
      var m = Math.min(n, grad.length);
      for (var i = 0; i < m; i++) if (!(lit[i] > 0)) lit[i] = grad[i];
    }
    try {
      r.setLit(lit, shared);
      s.litUploaded = true;
    } catch {
      // The renderer holds no data yet: the lit values go up with the next commit.
      s.litUploaded = false;
    }
  }

  function dropLit(v) {
    var s = v.search;
    if (!s.litUploaded) return;
    s.litUploaded = false;
    try {
      v.renderer?.setLit(null);
    } catch (err) {
      // A disposed renderer has nothing left to clear.
    }
  }

  // Ease the filter toward 1 while a search is shown and toward 0 when none is; the lit
  // values are cleared from the renderer once it reaches 0.
  function easeFilter(v, dt) {
    var s = v.search;
    var target = s.shown.length ? 1 : 0;
    if (s.filter === target) return;
    s.filter += (target - s.filter) * (1 - Math.exp(-dt / FILTER_TIME));
    if (Math.abs(target - s.filter) < 1e-3) s.filter = target;
    if (s.filter === 0) dropLit(v);
  }

  function searchBusy(v) {
    var s = v.search;
    return s.work.length > 0 || !!s.facingJob || s.filter !== (s.shown.length ? 1 : 0);
  }

  // The search steppers, after the mode's own preparation, in what is left of the budget.
  function pumpSearch(v, start, budget) {
    var s = v.search;
    while (s.work.length) {
      var left = budget - (now(v) - start);
      if (left <= 0) return;
      var item = s.work[0];
      if (!stepWork(v, item, left)) return;
    }
    if (s.facingJob && budget - (now(v) - start) > 0) pumpFacing(v, budget - (now(v) - start));
  }

  // One step of the first queued stepper; true when it finished (and was handed on).
  function stepWork(v, item, left) {
    try {
      item.job.step(left);
    } catch (err) {
      refuseRun(v, item.run, { ok: false, code: "internal", message: "Internal error while searching: " + errorText(err, String(err)) });
      return false;
    }
    if (!item.job.done) return false;
    v.search.work.shift();
    item.after(item.job.result);
    return true;
  }

  // ----- the facing frame and the modes -----

  function startFacing(v, swing) {
    var s = v.search;
    s.facingJob = null;
    s.facingTarget = null;
    var pov = s.shown.find(function (q) {
      return q.scale;
    });
    var cur = v.last?.frame;
    try {
      var job = ET.searchSets.makeFacingFrame(
        v.set,
        s.shown.map(function (q) {
          return { query: q.query, hits: q.view.hits };
        }),
        {
          seed: v.seed,
          current: cur?.length === 3 * v.set.dimension ? new Float32Array(cur) : null,
          scale: pov ? pov.scale : null,
        }
      );
      s.facingJob = { job: job, swing: swing };
    } catch {
      // Fewer than three dimensions: there is no facing frame to swing to.
      s.facingJob = null;
    }
  }

  function pumpFacing(v, left) {
    var s = v.search;
    var f = s.facingJob;
    try {
      f.job.step(left);
    } catch (err) {
      // A facing frame that cannot be worked out leaves the view as it is.
      s.facingJob = null;
      return;
    }
    if (!f.job.done) return;
    s.facingJob = null;
    s.facingTarget = f.job.result;
    if (f.swing) faceNow(v);
  }

  // Ask the current mode to swing toward the facing frame. False when it has no face
  // member, refuses, or throws.
  function faceNow(v) {
    var s = v.search;
    var m = v.mode;
    if (!m || !s.facingTarget || typeof m.inst.face !== "function") return false;
    var took = false;
    try {
      took = m.inst.face(s.facingTarget, m.clock, { searches: s.shown.length }) === true;
    } catch (err) {
      // A host mode whose face throws keeps its own motion.
      took = false;
    }
    if (took) {
      searchChanged(v);
      invalidate(v);
    }
    return took;
  }

  function endSwing(v) {
    var m = v.mode;
    if (!m || typeof m.inst.face !== "function") return;
    try {
      m.inst.face(null, m.clock);
    } catch (err) {
      // nothing to end
    }
  }

  // What Focus is told about the searches (inst.searchChanged), or null.
  function modeSearch(v) {
    var s = v.search;
    if (!s.shown.length) return null;
    var pov = s.shown.find(function (q) {
      return q.scale;
    });
    return {
      searches: s.shown.map(function (q) {
        return {
          letter: q.letter,
          query: q.query,
          indices: Int32Array.from(q.view.hits, function (hit) {
            return hit.index;
          }),
        };
      }),
      scale: pov ? pov.scale : null,
      onlyResults: !!s.settings.onlyResults,
    };
  }

  // Tell a mode with a searchChanged member (Focus) about the searches. If it hands back a
  // stepper (or { work: stepper }), it is pumped with the mode's own preparation.
  function notifyModeSearch(v) {
    var m = v.mode;
    if (!m || typeof m.inst.searchChanged !== "function") return;
    var r;
    try {
      r = m.inst.searchChanged(modeSearch(v), m.clock);
    } catch (err) {
      // A host mode whose searchChanged throws keeps its current view.
      return;
    }
    var work = typeof r?.step === "function" ? r : r?.work;
    if (typeof work?.step === "function") m.jobs.push(work);
    invalidate(v);
  }

  function swinging(v) {
    var m = v.mode;
    if (!m || !v.search.shown.length || typeof m.inst.face !== "function") return false;
    try {
      var f = m.inst.describe()?.facing;
      return !!f && m.clock < f.until;
    } catch {
      // A mode whose describe throws reports no swing.
      return false;
    }
  }

  // ----- clearing, settings, callbacks -----

  function clearSearches(v) {
    if (v.destroyed) return false;
    var s = v.search;
    var had = s.shown.length > 0 || !!s.run;
    endRun(v, searchRefusal("superseded"));
    var wasShown = s.shown.length > 0;
    s.shown = [];
    s.shownSet = null;
    s.lit = null;
    s.pairs = [];
    s.unmatched = [];
    s.code = null;
    s.message = null;
    s.facingJob = null;
    s.facingTarget = null;
    if (wasShown) {
      endSwing(v);
      notifyModeSearch(v);
    }
    if (had) searchChanged(v);
    invalidate(v);
    return had;
  }

  // A replace starts with no search (the renderer's setData already cleared its lit values).
  function dropSearchesForReplace(v) {
    var s = v.search;
    var had = s.shown.length > 0 || !!s.run;
    endRun(v, searchRefusal("superseded"));
    s.shown = [];
    s.shownSet = null;
    s.lit = null;
    s.pairs = [];
    s.unmatched = [];
    s.facingJob = null;
    s.facingTarget = null;
    s.filter = 0;
    s.litUploaded = false;
    if (had) searchChanged(v);
  }

  // After an append: the results are stale until worked out again, which starts now
  // (unless a run is already working; its commit sees the new set and re-runs).
  function searchesAfterAppend(v) {
    var s = v.search;
    if (!s.shown.length) return;
    if (!s.run) rerun(v, "rerun", null);
    else searchChanged(v);
  }

  // Apply a settings patch; returns which kinds of work it needs.
  function applySettings(v, patch) {
    var s = v.search;
    var st = s.settings;
    var before = { ...st };
    applyCounts(st, patch);
    if (ET.searchSets.LIT_SETTINGS.includes(patch.lit)) st.lit = patch.lit;
    if (typeof patch.distances === "boolean") st.distances = patch.distances;
    if (typeof patch.onlyResults === "boolean") st.onlyResults = patch.onlyResults;
    if (typeof patch.rerank === "boolean") st.rerank = patch.rerank && rerankOffered(v);
    if (Object.hasOwn(patch, "pointOfView") && validPointOfView(v, patch.pointOfView)) st.pointOfView = patch.pointOfView;
    return {
      rank: countsChanged(st, before) || st.pointOfView !== before.pointOfView || st.rerank !== before.rerank,
      lit: st.lit !== before.lit,
      only: st.onlyResults !== before.onlyResults,
    };
  }

  // A count in a patch (a number, or a string holding one, as a range input gives), or null
  // when absent or not a number: null, booleans and empty strings are ignored, not read as 0.
  function patchCount(patch, key) {
    var raw = Object.hasOwn(patch, key) ? patch[key] : null;
    var text = typeof raw === "string" && raw.trim() !== "";
    if (typeof raw !== "number" && !text) return null;
    var n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // k, candidates and top from a patch; candidates first, so top is cut to the new candidates.
  function applyCounts(st, patch) {
    var k = patchCount(patch, "k");
    var candidates = patchCount(patch, "candidates");
    var top = patchCount(patch, "top");
    if (k !== null) st.k = ET.search.clampK(k);
    if (candidates !== null) st.candidates = ET.search.clampCandidates(candidates);
    st.top = ET.search.clampTop(top === null ? st.top : top, st.candidates);
  }

  // A letter of a search shown (with letters by position: one of the first n letters).
  function validPointOfView(v, value) {
    if (value === null) return true;
    return ET.searchSets.LETTERS.includes(value) && hasLetter(v.search.shown, value);
  }

  function rerankOffered(v) {
    return !!v.search.rerank && (!v.set || v.set.text_included === true);
  }

  function setSearchSettings(v, patch) {
    if (v.destroyed) return Promise.resolve(searchRefusal("destroyed"));
    var s = v.search;
    var need = applySettings(v, isObj(patch) ? patch : {});
    var running = s.run?.kind === "set";
    if (need.rank && s.shown.length && !running) {
      return new Promise(function (resolve) {
        rerun(v, "settings", resolve);
      });
    }
    if (need.lit && s.shown.length) relight(v);
    if (need.only && s.shown.length) notifyModeSearch(v);
    searchChanged(v);
    invalidate(v);
    return Promise.resolve({ ok: true, search: searchInfo(v) });
  }

  function setSearchCallbacks(v, cbs) {
    var s = v.search;
    if (!v.destroyed && isObj(cbs)) {
      var removedEmbed = takeCallback(s, cbs, "embed");
      var removedRerank = takeCallback(s, cbs, "rerank");
      if (!s.rerank) s.settings.rerank = false;
      var run = s.run;
      if (run && ((removedEmbed && run.pendingEmbed > 0) || (removedRerank && run.pendingRerank > 0))) {
        endRun(v, searchRefusal("superseded"));
      }
      searchChanged(v);
      if (!s.run && needsRerun(v)) rerun(v, "rerun", null);
    }
    return { embedder: !!s.embed && !v.destroyed, reranker: !!s.rerank && !v.destroyed };
  }

  // Set s[key] from cbs[key] (a function, or null to remove; anything else is ignored).
  // Returns true when a callback was removed or replaced.
  function takeCallback(s, cbs, key) {
    if (!Object.hasOwn(cbs, key)) return false;
    var value = cbs[key];
    if (value !== null && typeof value !== "function") return false;
    var replaced = !!s[key] && s[key] !== value;
    s[key] = value;
    return replaced;
  }

  function faceSearches(v) {
    if (v.destroyed || !v.search.shown.length) return false;
    return faceNow(v);
  }

  // ----- info().search -----

  function searchInfo(v) {
    var s = v.search;
    var set = v.set;
    var same = ET.search.checkSameSpace(set);
    var stale = !!(s.shownSet && set && s.shownSet !== set);
    return {
      active: s.shown.length > 0,
      waiting: !!s.run,
      stale: stale,
      staleBy: stale ? set.count - s.shownSet.count : 0,
      code: s.code,
      message: s.message,
      measure: ET.search.MEASURE_TEXT,
      settings: { ...s.settings },
      embedder: { available: !!s.embed },
      reranker: { available: !!s.rerank, offered: !!s.rerank && !!set && set.text_included === true },
      sameSpace: { ok: same.ok, kind: sameSpaceKind(set, same) },
      litCount: s.lit ? s.lit.litCount : 0,
      sharedCount: s.lit ? s.lit.sharedCount : 0,
      unmatched: s.unmatched.slice(),
      facing: swinging(v),
      faceable: typeof v.mode?.inst.face === "function",
      searches: s.shown.map(function (q, j) {
        return searchEntryInfo(v, q, j);
      }),
      pairs: s.pairs.map(function (p) {
        return pairInfo(v, p);
      }),
      relative: relativeInfo(v),
    };
  }

  function sameSpaceKind(set, same) {
    if (!same.ok) return same.kind || null;
    return set.reduction ? set.reduction.kind : "none";
  }

  function searchEntryInfo(v, q, j) {
    var s = v.search;
    var view = q.view;
    return {
      letter: q.letter,
      kind: q.kind,
      text: q.text,
      model: q.model,
      queryForm: q.queryForm,
      sentTo: q.sentTo,
      reranker: q.reranker,
      words: q.words ? { used: q.words.used.map(copyUsed), unmatched: q.words.unmatched.slice() } : null,
      point: q.kind === "point" ? q.point : null,
      pointOfView: !!q.scale,
      k: view.k,
      candidates: view.candidates,
      top: view.top,
      available: availableOf(view),
      sent: q.sent || 0,
      counts: countsNote(q, view),
      note: q.note,
      radius: view.radius,
      insideCount: s.lit ? s.lit.insideCounts[j] : 0,
      results: view.hits.map(function (hit) {
        return resultInfo(v, hit);
      }),
    };
  }

  // How many points could be results of a ranking: the named ones, or all when none is named.
  function availableOf(ranking) {
    return ranking.named > 0 ? ranking.named : ranking.count;
  }

  // Says so when a number asked for is more than there is to give, or null.
  function countsNote(q, view) {
    var available = availableOf(view);
    var what = available + (view.named > 0 ? " named points" : " points");
    if (q.reranker) {
      if (view.candidates <= available) return null;
      return "Only " + what + " can be results, so the reranker was given " + available + " candidates, not " + view.candidates + ".";
    }
    if (view.k <= available) return null;
    return "Only " + what + " can be results, so " + available + " are shown, not " + view.k + ".";
  }

  function resultInfo(v, hit) {
    var set = v.set || v.search.shownSet;
    return {
      id: hit.id,
      index: hit.index,
      rank: hit.rank,
      embeddingRank: hit.embeddingRank,
      plainRank: hit.plainRank,
      distance: hit.distance,
      plainDistance: hit.plainDistance,
      gap: hit.gap,
      moved: hit.moved,
      score: hit.score,
      text: ET.search.pointText(set, hit.index),
    };
  }

  function pairInfo(v, p) {
    var ids = (v.set || v.search.shownSet).ids;
    // p.a and p.b are positions among the searches shown; each search's own letter names it.
    var shown = v.search.shown;
    var L = function (j) {
      return shown[j] ? shown[j].letter : ET.searchSets.letter(j);
    };
    return {
      a: L(p.a),
      b: L(p.b),
      shared: p.shared,
      common: p.common,
      commonIds: Array.from(p.commonIndices, function (i) {
        return ids[i];
      }),
      closest: p.closest ? { a: ids[p.closest.a], b: ids[p.closest.b], distance: p.closest.distance } : null,
    };
  }

  // The searches changed: tell the panel and the host.
  function searchChanged(v) {
    if (v.destroyed) return;
    var s = v.search;
    var snapshot = null;
    if (s.panel && typeof s.panel.update === "function") {
      snapshot = searchInfo(v);
      try {
        s.panel.update(snapshot);
      } catch (err) {
        reportHostError(v, err);
      }
    }
    if (typeof v.options.onSearchChange === "function") call(v, v.options.onSearchChange, snapshot || searchInfo(v));
  }

  function destroySearch(v) {
    var s = v.search;
    var panel = s.panel;
    s.panel = null;
    if (typeof panel?.destroy === "function") {
      try {
        panel.destroy();
      } catch (err) {
        reportHostError(v, err);
      }
    }
    s.work = [];
    s.facingJob = null;
    s.facingTarget = null;
    s.shown = [];
    s.shownSet = null;
    s.lit = null;
    s.pairs = [];
    s.litUploaded = false;
    s.filter = 0;
  }

  // ----- hidden points (Focus's Only results) -----

  // Whether unlit points are hidden this frame: Focus with Only results on (its
  // describe().onlyResults), lit values set and the filter on. Worked out once per frame.
  function hidesUnlit(v) {
    var m = v.mode;
    if (v.modeId !== "focus" || !m || !v.search.lit || v.search.filter <= 0) return false;
    try {
      return m.inst.describe()?.onlyResults === true;
    } catch (err) {
      // A mode whose describe throws hides nothing.
      return false;
    }
  }

  // True when point i is hidden this frame (its lit value is 0 while unlit points are
  // hidden). Hidden points are skipped when hit-testing and labelling.
  function hiddenPoint(v, i) {
    var lit = v.search.lit;
    if (!v.search.hideUnlit || !lit) return false;
    return lit.lit[i] <= 0; // lit values are finite, in [0, 1]
  }

  // ----- the panel hook (the panel itself is js/src/45-search-panel.js, task t9) -----

  // Mount the search panel when the module is in the core file and the host did not turn it
  // off. With no ET.searchPanel this does nothing.
  function mountSearchPanel(v) {
    if (!v.options.searchPanel || typeof ET.searchPanel?.mount !== "function") return;
    var parts = {
      panel: v.panel,
      stage: v.stage,
      overlay: v.overlay,
      provenanceList: v.provList,
      provenanceSummary: v.provSummary,
    };
    try {
      v.search.panel =
        ET.searchPanel.mount(parts, v.handle, {
          document: v.doc,
          light: !!v.theme?.light,
          // The panel reads the theme it styles itself with, and the set for its suggestions
          // and for where results sit on the stage (docs/search-interface.md, "Panel (t9)").
          theme: function () {
            return v.theme || null;
          },
          data: function () {
            return v.set;
          },
        }) || null;
    } catch (err) {
      v.search.panel = null;
      reportHostError(v, err);
    }
  }

  // The panel's markers, links and result labels on the overlay, once per frame.
  function drawSearchOverlay(v, s, ds) {
    var panel = v.search.panel;
    if (typeof panel?.drawOverlay !== "function") return;
    var ctx = overlayContext(v);
    if (!ctx) return;
    try {
      var drew = panel.drawOverlay(
        ctx,
        function (vector) {
          return projectVector(v, vector, s, ds);
        },
        searchFrame(v)
      );
      if (drew !== false) v.overlayDirty = true;
    } catch (err) {
      reportHostError(v, err);
    }
  }

  // What the panel needs to draw this frame beyond the projection: each shown search's raw
  // query vector (in letter order), the filter, the pixel ratio, whether labels are on, the
  // mode, and which points are hidden (Focus's Only results).
  function searchFrame(v) {
    return {
      queries: v.search.shown.map(function (q) {
        return q.query;
      }),
      filter: v.search.filter,
      dpr: v.dpr,
      light: !!v.theme?.light,
      labels: v.showLabels,
      mode: v.modeId,
      // The relative view draws its own stems and result labels; the panel then draws none.
      relative: relativeShown(v, v.last),
      hidden: function (i) {
        return hiddenPoint(v, i);
      },
    };
  }

  // A vector of the data's dimension through the frame shown, in overlay pixels.
  function projectVector(v, vector, s, ds) {
    var D = v.set.dimension;
    var F = s.frame;
    var C = s.centre;
    var a = 0;
    var b = 0;
    var c = 0;
    for (var d = 0; d < D; d++) {
      var x = vector[d] - C[d];
      a += x * F[d];
      b += x * F[D + d];
      c += x * F[2 * D + d];
    }
    return ET.renderer.place([a, b, c], ds, v.W, v.H);
  }

  // ----- the relative view (docs/relative-interface.md, "Viewer (t9, t10)") -----

  // The search colours by letter (A to D) when the host sets no --tumbler-search-N: the same
  // values as the search panel's defaults, so a search's ruler and its ring agree.
  var SEARCH_DEFAULTS_DARK = ["#ffc56b", "#6be0ff", "#ff8fb3", "#b6ff8a"];
  var SEARCH_DEFAULTS_LIGHT = ["#a35f00", "#00708a", "#b0245a", "#3d7a00"];
  var RELATIVE_GRADIENT = 0.2; // the brightest point that is not a result, as a lit value
  var OWN_POINT_DISTANCE = 1e-7; // a point this close to its search, at its length, is its own
  var OWN_POINT_LENGTH = 1e-6;

  // The relative view is shown: Tumble's state has at least one axis pinned.
  function relativeShown(v, st) {
    return v.modeId === "tumble" && !!st?.relative?.active;
  }

  // "A", "A and B", "A, B and C".
  function relLetters(letters) {
    if (letters.length < 2) return letters.join("");
    return letters.slice(0, -1).join(", ") + " and " + letters.at(-1);
  }

  function rowDot(X, o, u, D) {
    var s = 0;
    for (var d = 0; d < D; d++) s += X[o + d] * u[d];
    return s;
  }

  // A search's unit direction in double precision, or null when its query has no length.
  function searchDirection(q) {
    var D = q.query.length;
    var len = Math.sqrt(rowDot(q.query, 0, q.query, D));
    if (!(len > ET.math.RELATIVE_ZERO_LENGTH)) return null;
    var u = new Float64Array(D);
    for (var d = 0; d < D; d++) u[d] = q.query[d] / len;
    return { u: u, length: len };
  }

  // The search's own point: at plain cosine distance below OWN_POINT_DISTANCE and of the
  // search's length (the rule the overlay draws by).
  function isOwnPoint(set, i, distance, length) {
    if (!(distance < OWN_POINT_DISTANCE)) return false;
    var D = set.dimension;
    var o = i * D;
    return Math.abs(Math.sqrt(rowDot(set.vectors, o, set.vectors.subarray(o, o + D), D)) - length) < OWN_POINT_LENGTH;
  }

  // The gradient for the searches shown, worked out once per change of the searches or the
  // data: RELATIVE_GRADIENT * g^2, g the largest over the searches of
  // clamp((c - mid) / (hi - mid), 0, 1) by plain cosine c, mid the median c (index N >> 1
  // of the ascending sort) and hi the largest c of a point other than the search's own.
  function relativeGradient(v) {
    var s = v.search;
    var set = s.shownSet;
    if (!s.shown.length || !set) return null;
    if (s.gradient?.shown === s.shown && s.gradient.set === set) return s.gradient.values;
    var N = set.count;
    var g = new Float64Array(N);
    var c = new Float64Array(N);
    for (const q of s.shown) {
      var r = q.ranking;
      var dist = r.plainDistances || r.distances;
      var dir = searchDirection(q);
      var hi = -Infinity;
      for (var i = 0; i < N; i++) {
        c[i] = 1 - dist[i];
        if (c[i] > hi && !(dir && isOwnPoint(set, i, dist[i], dir.length))) hi = c[i];
      }
      var mid = Float64Array.from(c).sort()[N >> 1];
      if (!(hi > mid)) continue;
      for (var j = 0; j < N; j++) {
        var x = clamp((c[j] - mid) / (hi - mid), 0, 1);
        if (x > g[j]) g[j] = x;
      }
    }
    var values = new Float32Array(N);
    for (var k = 0; k < N; k++) values[k] = RELATIVE_GRADIENT * g[k] * g[k];
    s.gradient = { shown: s.shown, set: set, values: values };
    return values;
  }

  // ET.math.unitLength of the set shown, once per set.
  function unitOf(v) {
    var s = v.search;
    var set = v.set;
    if (!set) return null;
    if (s.unit?.set !== set) s.unit = { set: set, unit: ET.math.unitLength(set.vectors, set.count, set.dimension) };
    return s.unit.unit;
  }

  // In the plain view with the setting on, the searches that give no axis (letters), so the
  // panel can say why nothing is pinned. The same rule Tumble applies to the same list.
  function plainDropped(v) {
    var s = v.search;
    var set = v.set;
    if (!v.rel.relative || v.modeId !== "tumble" || !s.shown.length || !set || set.dimension < 3) return [];
    var dirs = ET.math.relativeDirections(
      s.shown.map(function (q) {
        return q.query;
      }),
      set.dimension
    );
    var letterOf = function (j) {
      return s.shown[j].letter;
    };
    return dirs.dropped.map(function (d) {
      return { letter: letterOf(d.index), reason: d.reason, against: d.against.map(letterOf) };
    });
  }

  // Each search's results with their height along it (x . u) and plain cosine, aligned with
  // info().search.searches[j].results; worked out once per commit.
  function relativeResults(v) {
    var s = v.search;
    var set = s.shownSet;
    if (!set) return [];
    if (s.heights?.shown !== s.shown) {
      var D = set.dimension;
      s.heights = {
        shown: s.shown,
        list: s.shown.map(function (q) {
          var dir = searchDirection(q);
          return {
            letter: q.letter,
            results: q.view.hits.map(function (hit) {
              return {
                index: hit.index,
                id: hit.id,
                height: dir ? rowDot(set.vectors, hit.index * D, dir.u, D) : null,
                cosine: 1 - hit.plainDistance,
              };
            }),
          };
        }),
      };
    }
    return s.heights.list.map(function (e) {
      return {
        letter: e.letter,
        results: e.results.map(function (r) {
          return { ...r };
        }),
      };
    });
  }

  // info().search.relative. The mode's state is the one last drawn. In the plain view the
  // measure and unit come from the viewer's own check of the set (Tumble reports them only
  // once an axis is pinned), and dropped names the searches that give no axis.
  function relativeInfo(v) {
    var offered = v.modeId === "tumble";
    var st = offered && v.mode && v.last ? v.last.relative || null : null;
    var active = !!st?.active;
    var unit = active ? st.unit : unitOf(v);
    var measure = null;
    if (active) measure = st.measure;
    else if (unit) measure = unit.unit ? "cosine" : "length along the search";
    return {
      relative: v.rel.relative,
      showOrigin: v.rel.showOrigin,
      offered: offered,
      active: active,
      settled: active && st.settled === true,
      measure: measure,
      unit: unit ? { unit: unit.unit, min: unit.min, max: unit.max, tolerance: unit.tolerance } : null,
      pinned: active
        ? st.pinned.map(function (p) {
            return { letter: p.letter, axis: p.axis, length: p.length };
          })
        : [],
      dropped: active
        ? st.dropped.map(function (d) {
            return { letter: d.letter, reason: d.reason, against: d.against.slice() };
          })
        : plainDropped(v),
      free: active ? st.free : 3,
      fixed: active ? st.fixed : 0,
      window: active && st.window ? { ...st.window } : null,
      share: active ? st.share : null,
      subspace: active ? st.subspace : null,
      searches: active ? relativeResults(v) : [],
    };
  }

  // The viewer's pieces after the mode's relative status, before its own zoom and paused.
  function relativeStatusTail(v, rel) {
    var shown = v.search.shown;
    var out = "";
    if (
      shown.some(function (q) {
        return !!q.reranker;
      })
    ) {
      out += " · named results chosen and numbered by the reranker";
    }
    var pov = shown.find(function (q) {
      return q.scale;
    });
    if (pov) out += " · with " + pov.letter + "'s point of view, rank and height use different measures";
    if (rel.measure !== "cosine") out += " · ranked by cosine, so rank and height can disagree";
    return out;
  }

  function fixed3(x) {
    return typeof x === "number" && Number.isFinite(x) ? x.toFixed(3) : "?";
  }

  // The provenance's Relative row: the sentences that apply, in the documented order.
  function relativeProvenanceText(v, rel) {
    var L = rel.pinned.map(function (p) {
      return p.letter;
    });
    // The pinned axes are exact only once the turn onto them has ended (state.relative.settled);
    // during the turn the exactness sentences are left out (the mode's status says it turns).
    var exact = rel.settled === true;
    var parts = [];
    if (exact) parts.push("The vertical axis is exact: height is " + rel.measure + " to " + L[0] + ".");
    if (exact && L.length >= 2) {
      parts.push(
        "The horizontal axis is exact too: it is the part of " +
          L[1] +
          " that " +
          L[0] +
          " does not contain, so the plane of " +
          L[0] +
          " and " +
          L[1] +
          " is shown exactly."
      );
    }
    if (exact && L.length >= 3) {
      parts.push("The depth axis is exact too: all three axes are pinned, so the space of " + relLetters(L) + " is shown exactly and nothing tumbles.");
    }
    if (L.length < 3 && rel.subspace > 0) {
      var axes = L.length === 1 ? "The other two axes" : "The depth axis";
      var tour = L.length === 1 ? "tour" : "tours";
      var share = Math.round((rel.share || 0) * 100) + "%";
      parts.push(
        axes +
          " " +
          tour +
          " " +
          rel.subspace +
          " directions holding " +
          share +
          " of the spread the pinned axes leave: sideways position is still a shadow, and points side by side on screen can be far apart."
      );
    }
    var u = rel.unit;
    if (u?.unit) parts.push("Every vector has length one (within " + u.tolerance + "), which is why height is cosine similarity.");
    else {
      parts.push(
        "The vectors are not all of length one (lengths " +
          fixed3(u?.min) +
          " to " +
          fixed3(u?.max) +
          "), so height is length along the search, not cosine; results are still ranked by cosine, so rank and height can disagree."
      );
    }
    var pov = v.search.shown.find(function (q) {
      return q.scale;
    });
    if (pov) {
      parts.push("With " + pov.letter + "'s point of view on, its results are ranked in the scaled measure and height is not: rank and height use different measures.");
    }
    return { text: parts.join(" "), letters: relLetters(L) };
  }

  // The Relative row (after View) and the summary's "relative to" while the relative view
  // is shown; both are removed otherwise. Called with the status line and after the
  // provenance is drawn afresh (which removes them).
  function syncRelativeProvenance(v) {
    var rel = v.set && relativeShown(v, v.last) ? v.last.relative : null;
    var want = rel ? relativeProvenanceText(v, rel) : null;
    var key = want ? want.letters + "\n" + want.text : "";
    var cur = v.provRel;
    if (cur?.key === key) return;
    if (cur) {
      cur.dt.remove();
      cur.dd.remove();
      cur.clause.remove();
    }
    v.provRel = null;
    if (!want || !v.provView) return;
    var dt = text(v, "dt", "tumbler-provenance-term tumbler-relative-provenance-term", "Relative", {
      margin: "0",
      color: cssRgb(v.theme.muted),
    });
    var dd = text(v, "dd", "tumbler-provenance-value tumbler-relative-provenance-value", want.text, {
      margin: "0",
      color: cssRgb(v.theme.foreground),
      minWidth: "0",
    });
    var clause = text(v, "span", "tumbler-relative-provenance-clause", " · relative to " + want.letters);
    v.provView.after(dt, dd);
    v.provSummary.appendChild(clause);
    v.provRel = { key: key, dt: dt, dd: dd, clause: clause };
  }

  // Once a frame, before drawing: whether the relative view is shown. When that changes
  // the lit values go up again, with or without the gradient.
  function syncRelativeLit(v, st) {
    var s = v.search;
    var active = relativeShown(v, st);
    s.relActive = active;
    if (s.lit && s.litUploaded && active !== s.litRelative) uploadLit(v);
  }

  // Once a frame, after the state is kept: the panel and host hear of a change in what
  // info().search.relative reports (shown, the pinned and the dropped letters).
  function noteRelativeChange(v, st) {
    var s = v.search;
    var active = relativeShown(v, st);
    var rel = v.modeId === "tumble" ? st?.relative : null;
    var key = "";
    if (rel) {
      key =
        (active ? "on:" : "off:") +
        rel.pinned
          .map(function (p) {
            return p.letter;
          })
          .join("") +
        ":" +
        rel.dropped
          .map(function (d) {
            return d.letter;
          })
          .join("") +
        // settled is part of what a host reads (info().search.relative.settled), so the end
        // of a turn is announced too
        (active ? (rel.settled ? ":settled" : ":turning") : "");
    }
    if (key !== s.relKey) {
      s.relKey = key;
      searchChanged(v);
    }
  }

  // handle.setRelative(patch): synchronous; no ranking is redone, nothing is superseded,
  // no request is made. onSearchChange fires when a value changes.
  function setRelative(v, patch) {
    var cur = v.rel;
    var next = { relative: cur.relative, showOrigin: cur.showOrigin };
    if (v.destroyed || !isObj(patch)) return next;
    try {
      if (typeof patch.relative === "boolean") next.relative = patch.relative;
      if (typeof patch.showOrigin === "boolean") next.showOrigin = patch.showOrigin;
    } catch {
      // A getter on the host's patch threw: the patch is ignored.
      return { relative: cur.relative, showOrigin: cur.showOrigin };
    }
    if (next.relative === cur.relative && next.showOrigin === cur.showOrigin) return next;
    v.rel = next;
    var relettered = !next.relative && letterByPosition(v);
    passRelative(v, v.mode);
    if (relettered) notifyModeSearch(v);
    searchChanged(v);
    invalidate(v);
    return { relative: next.relative, showOrigin: next.showOrigin };
  }

  // What the relative overlay is told about the results (docs/relative-interface.md,
  // "Drawing (t10)"): `named`, every shown search's results each once, with reranker ranks
  // only from searches whose reranker answered (none after a failure, a timeout or a search
  // with no text), and `cut`, the vertical search's cut-off when it was reranked.
  function relativeOverlayData(v) {
    var s = v.search;
    var set = s.shownSet;
    var named = [];
    if (!set) return { named: named, cut: null };
    var byIndex = new Map();
    s.shown.forEach(function (q) {
      q.view.hits.forEach(function (hit) {
        var e = byIndex.get(hit.index);
        if (!e) {
          e = { index: hit.index, text: ET.search.pointText(set, hit.index), ranks: [] };
          byIndex.set(hit.index, e);
          named.push(e);
        }
        if (q.reranker) e.ranks.push({ letter: q.letter, rank: hit.rank });
      });
    });
    var rel = relativeShown(v, v.last) ? v.last.relative : null;
    var cut = null;
    var vertical = rel?.pinned.length
      ? s.shown.find(function (q) {
          return q.letter === rel.pinned[0].letter;
        })
      : null;
    var dir = vertical?.reranker && vertical.sent > 0 ? searchDirection(vertical) : null;
    if (dir) {
      var D = set.dimension;
      var low = Infinity;
      vertical.ranking.pool.slice(0, vertical.sent).forEach(function (hit) {
        low = Math.min(low, rowDot(set.vectors, hit.index * D, dir.u, D));
      });
      cut = { height: low, sent: vertical.sent };
    }
    return { named: named, cut: cut };
  }

  // ----- drawing the relative view (docs/relative-interface.md, "Drawing (t10)") -----

  // How far the view is into the relative look (flatness and pitch): Tumble's
  // state.relative.mix, 0 in other modes and in the plain view.
  function relativeMix(v, st) {
    if (v.modeId !== "tumble") return 0;
    var m = st?.relative?.mix;
    return typeof m === "number" && m > 0 ? Math.min(1, m) : 0;
  }

  // A search's colour follows its letter (A to D), as the panel colours it.
  function searchColour(v, q, j) {
    var at = typeof q.letter === "string" ? "ABCD".indexOf(q.letter) : -1;
    var list = v.searchColours || SEARCH_DEFAULTS_DARK;
    return list[at >= 0 ? at : j % list.length];
  }

  // The overlay's named results and cut-off, worked out again only when the searches, the set
  // or the vertical search change (not every frame).
  function overlayDataFor(v, rel) {
    var s = v.search;
    var vertical =
      (rel?.pinned?.length ? rel.pinned[0].letter : "") +
      ":" +
      s.shown
        .map(function (q) {
          return q.letter;
        })
        .join("");
    var c = v.relOverlayCache;
    if (c?.shown === s.shown && c.set === s.shownSet && c.vertical === vertical) return c.data;
    var data = relativeOverlayData(v);
    v.relOverlayCache = { shown: s.shown, set: s.shownSet, vertical: vertical, data: data };
    return data;
  }

  // Once a frame, after the names and before the panel's rings: in Tumble, with the relative
  // view shown or Show the origin on, the overlay's draw list from the mode's state and the
  // draw state given to the renderer, its shapes painted on the overlay canvas and its texts
  // placed as spans. Otherwise nothing of it is drawn and its label layer is emptied.
  function drawRelativeOverlay(v, s, ds) {
    var shown = relativeShown(v, s);
    if (!v.set || v.modeId !== "tumble" || !(shown || v.rel.showOrigin)) {
      clearRelativeOverlay(v);
      return;
    }
    var od = shown ? overlayDataFor(v, s.relative) : { named: [], cut: null };
    var list = ET.relativeOverlay.build({
      width: v.W,
      height: v.H,
      dpr: v.dpr,
      view: ds,
      vectors: v.set.vectors,
      dimension: v.set.dimension,
      frame: s.frame,
      centre: s.centre,
      relative: shown ? s.relative : null,
      searches: shown
        ? v.search.shown.map(function (q, j) {
            return { letter: q.letter, colour: searchColour(v, q, j), query: q.query };
          })
        : [],
      named: od.named,
      cut: od.cut,
      showOrigin: v.rel.showOrigin,
      labels: v.showLabels,
      ink: v.stageFg,
      paper: v.stageBg,
    });
    // The panel already rings every query (and letters it): with the panel mounted the
    // overlay's own search markers are left out, so no search is ringed twice. Without the
    // panel they are the only mark at a query and are kept.
    if (typeof v.search.panel?.drawOverlay === "function") {
      list.marks = list.marks.filter(function (mk) {
        return mk.kind !== "search";
      });
    }
    var ctx = overlayContext(v);
    var painted = false;
    if (ctx) {
      try {
        painted = ET.relativeOverlay.paint(ctx, list);
      } catch (err) {
        // A 2-D context that throws: the overlay's shapes are not drawn this frame.
        painted = false;
      }
      if (painted) v.overlayDirty = true;
    }
    var placed = ET.relativeOverlay.placeLabels(v.relLabelLayer, list, v.doc);
    v.relativeDrawn = relativeDrawnRecord(v, list, shown && s.relative.settled === true, painted, placed);
  }

  // The test hook's record of the overlay drawn this frame (handle._viewer.relativeDrawn), in
  // device pixels of the overlay canvas (divide by dpr for CSS pixels). For each named result
  // with a stem: its drawn position (x, y), the point on the ruler at its height (rulerX,
  // rulerY, through the renderer's placer) and where its height falls on the straight line
  // between the ruler's two ends (mappedX, mappedY).
  function relativeDrawnRecord(v, list, settled, painted, placed) {
    var ruler = list.ruler ? { ...list.ruler } : null;
    var origin = list.marks.find(function (mk) {
      return mk.kind === "origin";
    });
    return {
      units: "device",
      dpr: v.dpr,
      width: v.W,
      height: v.H,
      settled: settled,
      painted: painted,
      labels: placed,
      ruler: ruler,
      origin: origin ? { x: origin.x, y: origin.y, far: origin.far, seen: origin.seen } : null,
      results: list.results.map(function (r) {
        var out = { index: r.index, height: r.height, x: r.x, y: r.y, rulerX: r.rulerX, rulerY: r.rulerY, mappedX: null, mappedY: null };
        if (ruler && ruler.to !== ruler.from) {
          var f = (r.height - ruler.from) / (ruler.to - ruler.from);
          out.mappedX = ruler.x0 + f * (ruler.x1 - ruler.x0);
          out.mappedY = ruler.y0 + f * (ruler.y1 - ruler.y0);
        }
        return out;
      }),
    };
  }

  // Nothing of the relative overlay is shown: its spans hidden, the hook's record dropped.
  // The canvas part goes with the overlay's next clear (it was marked dirty when painted).
  function clearRelativeOverlay(v) {
    if (v.relativeDrawn === null) return;
    if (v.relLabelLayer) ET.relativeOverlay.placeLabels(v.relLabelLayer, null, v.doc);
    v.relativeDrawn = null;
  }

  // ----- Focus: a click on a point searches from it -----

  function focusClick(v, e, pt, at) {
    if (v.modeId !== "focus" || !v.last || !v.lastDraw || !v.set) return;
    if (Math.hypot(e.clientX - pt.sx, e.clientY - pt.sy) > CLICK_SLOP) return;
    var i = nearestPoint(v, at.x * v.dpr, at.y * v.dpr, CLICK_REACH * v.dpr);
    if (i >= 0) void setSearches(v, [{ point: v.set.ids[i] }]); // its answer is the view itself
  }

  // The index of the shown point nearest (x, y) in device pixels within reach, or -1.
  function nearestPoint(v, x, y, reach) {
    var best = -1;
    var bd = reach * reach;
    for (var i = 0; i < v.set.count; i++) {
      if (hiddenPoint(v, i)) continue;
      var p = project(v, i, v.last, v.lastDraw, v.tmp3);
      var d2 = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d2 < bd) {
        bd = d2;
        best = i;
      }
    }
    return best;
  }

  // ---------- lifecycle ----------

  // Every option: the host's value where it gave one, the default otherwise.
  function readOptions(options) {
    var opts = {};
    for (var key in DEFAULT_OPTIONS) {
      if (Object.hasOwn(DEFAULT_OPTIONS, key)) opts[key] = readOption(options, key);
    }
    return opts;
  }

  function prefersReducedMotion(win) {
    try {
      return !!win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    } catch (err) {
      // A host whose matchMedia throws is treated as not asking for reduced motion.
      return false;
    }
  }

  // A usable view seed is a finite number or a non-empty string. It is kept exactly as
  // given (7 and "7" are different seeds, and seed() hands it back unchanged).
  function isSeed(seed) {
    if (typeof seed === "number") return Number.isFinite(seed);
    return typeof seed === "string" && seed !== "";
  }

  function mount(el, options) {
    if (!isElement(el)) throw new TypeError("EmbeddingsTumbler.mount needs a DOM element");
    var existing = lookup(el);
    if (existing) return existing.handle;
    var doc = el.ownerDocument;
    var win = doc.defaultView || null;
    var opts = readOptions(options);
    var reduced = prefersReducedMotion(win);
    var seed = isSeed(opts.seed) ? opts.seed : 1;
    var v = {
      el: el,
      doc: doc,
      win: win,
      options: opts,
      seed: seed,
      speed: Number(opts.speed) > 0 ? Number(opts.speed) : 1,
      reducedMotion: reduced,
      running: opts.paused === null ? !reduced : !opts.paused,
      showLabels: !!opts.labels,
      trails: !!opts.trails,
      modeId: ET.modes.get(opts.mode) ? opts.mode : "tumble",
      set: null,
      mode: null,
      last: null,
      lastDraw: null,
      renderer: null,
      rendering: false,
      destroyed: false,
      broken: false,
      raf: 0,
      prev: null,
      dirty: true,
      onScreen: true,
      spin: 0,
      drawTime: 0,
      userZoom: 1,
      pan: [0, 0], // the user pan, the renderer's draw key pan (see PAN_STEP)
      drag: { active: false, yaw: 0, pitch: 0, x: 0, y: 0, pan: false },
      pinch: null,
      hover: null,
      needClear: true,
      statusClock: STATUS_EVERY,
      statusText: "",
      sinceAppend: Infinity,
      groupIndex: Object.create(null), // group name -> index; names are untrusted
      groupNames: [],
      labelledCount: 0,
      lightLoad: 0, // see crowding()
      labelSample: [],
      labelPool: [],
      sx: new Float32Array(LABEL_SAMPLE),
      sy: new Float32Array(LABEL_SAMPLE),
      tmp3: [0, 0, 0],
      projector: null, // the label sample's projector (makeProjector), made when first needed
      sampleCoords: new Float64Array(3 * LABEL_SAMPLE),
      placed: { x: 0, y: 0 },
      overlayDirty: false,
      // The relative overlay drawn this frame, for tests (relativeDrawnRecord); null when none.
      relativeDrawn: null,
      relOverlayCache: null,
      listeners: [],
      io: null,
      ro: null,
      retryTimer: 0,
      frames: 0,
      fps: 0,
      fpsAt: null,
      fpsFrames: 0,
      narrow: null,
      oneColumn: null,
      dpr: 1,
      W: 2,
      H: 2,
      fatalMessage: null,
      fatalKind: null,
      noticeMessage: null,
      timing: {
        mountAt: 0,
        firstFrameMs: null,
        firstReadyMs: null,
        longestFrameMs: 0,
        lastAppendMs: null,
        refits: 0,
        lastRefit: null,
        budgetMs: null,
        workMs: 0,
      },
      lastSpent: 0,
      lastScript: 0, // the last frame's script time, drawing excluded (ms)
      lastBudget: 0,
      drawSpent: 0,
      interval: 0, // smoothed time between animation frames (ms)
      rafAt: null,
      dprCap: null, // the lowered drawing-buffer ratio (adaptivePixelRatio), or null
      slowSeconds: 0,
      lostTime: false,
      paintKey: null,
      themeKey: null,
      // Tumble's relative settings, kept in every view and with no search.
      rel: { relative: opts.relative === true, showOrigin: opts.showOrigin === true },
      provRel: null, // the provenance's Relative row while the relative view is shown
      search: newSearchState(opts),
    };
    v.timing.mountAt = now(v);
    v.tick = function (t) {
      frame(v, t);
    };
    build(v);
    el.appendChild(v.root);
    syncTheme(v); // read once the root inherits the host's properties
    v.playButton.textContent = v.running ? "Pause" : "Play";
    v.playButton.setAttribute("aria-pressed", v.running ? "false" : "true");
    paintModeButtons(v);
    v.mastTitle.textContent = opts.title ? String(opts.title) : "";
    v.mastTitle.style.display = opts.title ? "" : "none";
    makeRenderer(v);
    sizeStrip(v);
    renderProvenance(v);
    describeSet(v);
    wire(v);
    measure(v);
    v.handle = makeHandle(v);
    mountSearchPanel(v);
    remember(el, v);
    invalidate(v);
    return v.handle;
  }

  function destroy(v) {
    if (v.destroyed) return false;
    endRun(v, searchRefusal("destroyed")); // waiting promises resolve with destroyed
    v.destroyed = true;
    destroySearch(v);
    unschedule(v);
    if (v.retryTimer && typeof v.win?.clearTimeout === "function") v.win.clearTimeout(v.retryTimer);
    v.retryTimer = 0;
    if (v.io) v.io.disconnect();
    if (v.ro) v.ro.disconnect();
    v.io = null;
    v.ro = null;
    v.listeners.forEach(function (l) {
      l[0].removeEventListener(l[1], l[2], l[3]);
    });
    v.listeners = [];
    if (v.mode) leaveSafely(v.mode.inst);
    v.mode = null;
    if (v.renderer) {
      try {
        v.renderer.dispose();
      } catch (err) {
        // the element goes away regardless
      }
    }
    v.renderer = null;
    v.rendering = false;
    v.root?.remove();
    forget(v.el);
    v.set = null;
    v.last = null;
    v.lastDraw = null;
    v.labelPool = [];
    return true;
  }

  function info(v) {
    var m = v.mode;
    return {
      mode: v.modeId,
      paused: !v.running,
      suspended: !v.destroyed && suspended(v),
      hidden: !!v.doc.hidden,
      onScreen: v.onScreen,
      destroyed: v.destroyed,
      reducedMotion: v.reducedMotion,
      time: m ? m.clock : 0,
      seed: v.seed,
      speed: v.speed,
      zoom: v.userZoom,
      ready: readyOf(m),
      preparing: preparingOf(m),
      broken: v.broken,
      count: v.set ? v.set.count : 0,
      dimension: v.set ? v.set.dimension : 0,
      model: v.set ? v.set.model : null,
      rendering: v.rendering,
      animating: !!v.raf,
      frames: v.frames,
      fps: v.fps,
      pixelRatio: v.dpr,
      pixelRatioLowered: v.dprCap !== null,
      status: v.statusText,
      message: v.fatalMessage || v.noticeMessage || null,
      timing: {
        firstFrameMs: v.timing.firstFrameMs,
        firstReadyMs: v.timing.firstReadyMs,
        longestFrameMs: v.timing.longestFrameMs,
        lastAppendMs: v.timing.lastAppendMs,
        refits: v.timing.refits,
        lastRefit: v.timing.lastRefit ? { ...v.timing.lastRefit } : null,
        budgetMs: v.timing.budgetMs,
        workMs: v.timing.workMs,
        scriptMs: v.lastScript,
        drawMs: v.drawSpent,
        intervalMs: v.interval,
      },
      search: searchInfo(v),
    };
  }

  function makeHandle(v) {
    var h = {
      element: v.el,
      update: function (data) {
        return update(v, data);
      },
      destroy: function () {
        return destroy(v);
      },
      pause: function () {
        if (!v.destroyed) setRunning(v, false);
      },
      resume: function () {
        if (!v.destroyed) setRunning(v, true);
      },
      isPaused: function () {
        return !v.running;
      },
      setMode: function (id) {
        return setMode(v, id);
      },
      mode: function () {
        return v.modeId;
      },
      modes: function () {
        return ET.modes.ids();
      },
      time: function () {
        return v.mode ? v.mode.clock : 0;
      },
      seek: function (t) {
        var x = Number(t);
        if (!Number.isFinite(x) || x < 0) x = 0;
        if (v.mode) {
          v.mode.clock = x;
          v.mode.seeked = true; // an exact frame is asked for: no spin while it prepares
        }
        v.spin = x * spinFactor(v.mode);
        v.needClear = true;
        invalidate(v);
        return v.mode ? v.mode.clock : 0;
      },
      seed: function () {
        return v.seed;
      },
      setSpeed: function (s) {
        var x = Number(s);
        if (Number.isFinite(x) && x > 0) {
          v.speed = x;
          v.speedInput.value = String(x);
        }
        return v.speed;
      },
      zoom: function (z) {
        if (z !== undefined && !v.destroyed) setZoom(v, Number(z) || 1);
        return v.userZoom;
      },
      // Zoom 1 and no pan (since t17 it resets the pan too, as the button does).
      resetZoom: function () {
        if (!v.destroyed) resetView(v);
      },
      // The user pan: read it, or set it with [x, y] (clamped; anything else is [0, 0]).
      pan: function (p) {
        if (p !== undefined && !v.destroyed) {
          var ok = p !== null && typeof p === "object" && p.length === 2;
          setPan(v, ok ? Number(p[0]) : Number.NaN, ok ? Number(p[1]) : Number.NaN);
        }
        return [v.pan[0], v.pan[1]];
      },
      resetView: function () {
        if (!v.destroyed) resetView(v);
      },
      refreshTheme: function () {
        refreshTheme(v);
      },
      info: function () {
        return info(v);
      },
      // Search (docs/search-interface.md, "Viewer (t8)").
      setSearches: function (list) {
        return setSearches(v, list);
      },
      clearSearches: function () {
        return clearSearches(v);
      },
      setSearchSettings: function (patch) {
        return setSearchSettings(v, patch);
      },
      searchSettings: function () {
        return { ...v.search.settings };
      },
      faceSearches: function () {
        return faceSearches(v);
      },
      setSearchCallbacks: function (cbs) {
        return setSearchCallbacks(v, cbs);
      },
      // Relative (docs/relative-interface.md, "Viewer (t9, t10)").
      setRelative: function (patch) {
        return setRelative(v, patch);
      },
      relativeSettings: function () {
        return { relative: v.rel.relative, showOrigin: v.rel.showOrigin };
      },
    };
    Object.defineProperty(h, "_viewer", { value: v, enumerable: false });
    return h;
  }

  return {
    mount: mount,
    get: function (el) {
      var v = lookup(el);
      return v ? v.handle : null;
    },
    update: function (el, data) {
      var v = lookup(el);
      if (!v) {
        return {
          ok: false,
          code: "not-mounted",
          message: "No viewer is mounted on this element; call mount(el) first.",
        };
      }
      return update(v, data);
    },
    destroy: function (el) {
      var v = lookup(el);
      return v ? destroy(v) : false;
    },
    parseColour: parseColour,
    safeCssValue: safeCssValue,
    makeProjector: makeProjector,
    SHADOW: SHADOW,
    PAN_STEP: PAN_STEP,
    // The relative overlay's results and cut-off for a mounted handle (t10 draws them).
    relativeOverlayData: function (handle) {
      var v = handle?._viewer;
      return v && !v.destroyed ? relativeOverlayData(v) : null;
    },
  };
})();

ET.api.mount = ET.viewer.mount;
ET.api.update = ET.viewer.update;
ET.api.destroy = ET.viewer.destroy;
ET.api.get = ET.viewer.get;
ET.api.registerMode = function (definition) {
  return ET.modes.register(definition);
};
