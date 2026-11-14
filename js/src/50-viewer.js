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
    maxPixelRatio: 2,
    preserveDrawingBuffer: false,
    prepareBudgetMs: 8,
    refitQuietSeconds: 2,
    refitShare: 0.01,
    onError: null,
    onModeChange: null,
    onPauseChange: null,
  };

  var LABEL_SAMPLE = 300; // labelled points projected on the CPU per frame for labels
  var LABEL_POOL = 64; // label elements at most
  var STATUS_EVERY = 0.12; // seconds between status-line updates (the reference's)
  var ZOOM_MIN = 0.2;
  var ZOOM_MAX = 12;
  var SPIN = 0.06; // rad/s of yaw while running (the reference's)
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
    for (var i = 0; i < liveList.length; i++) if (liveList[i].el === el) return liveList[i].v;
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
    return x < lo ? lo : x > hi ? hi : x;
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
    var neg = s.charAt(0) === "-";
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
          return parseInt(h.charAt(i) + h.charAt(i), 16) / 255;
        });
      }
      if (h.length === 6 || h.length === 8) {
        return [0, 2, 4].map(function (i) {
          return parseInt(h.slice(i, i + 2), 16) / 255;
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
      var pct = p.charAt(p.length - 1) === "%";
      var x = parseFloat(p);
      if (!isFinite(x)) return NaN;
      return pct ? x / 100 : x / scale;
    }
    if (m[1].charAt(0) === "r") {
      var rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
      if (rgb.some(isNaN)) return null;
      return rgb.map(function (c) {
        return clamp(c, 0, 1);
      });
    }
    var hue = parseFloat(parts[0]);
    var sat = num(parts[1], 100);
    var lig = num(parts[2], 100);
    if (!isFinite(hue) || isNaN(sat) || isNaN(lig)) return null;
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
      if (Object.prototype.hasOwnProperty.call(styles, k)) st[k] = styles[k];
    }
  }

  function readOption(options, key) {
    if (options && Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined) {
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
      // A host callback's own error is the host's: report it on its own stack, not ours.
      var w = v.win;
      if (w && typeof w.setTimeout === "function") {
        w.setTimeout(function () {
          throw err;
        }, 0);
      }
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
      lineHeight: "1.2",
      color: "inherit",
      background: "transparent",
      border: "1px solid",
      borderRadius: "999px",
      padding: "6px 14px",
      minHeight: "32px",
      minWidth: "64px",
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

    var mast = make(v, "div", "tumbler-masthead", {
      position: "absolute",
      top: "14px",
      left: "16px",
      right: "16px",
      pointerEvents: "none",
      zIndex: "2",
    });
    v.mastTitle = text(v, "p", "tumbler-title", "", {
      margin: "0 0 6px",
      fontStyle: "italic",
      fontWeight: "400",
      fontSize: "clamp(28px, 6vw, 56px)",
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
      left: "16px",
      right: "16px",
      bottom: "10px",
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
    stage.appendChild(labels);
    stage.appendChild(mast);
    stage.appendChild(status);
    stage.appendChild(notice);
    stage.appendChild(fatal);
    root.appendChild(stage);

    var panel = make(v, "div", "tumbler-panel", {
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      padding: "6px 16px 16px",
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
        padding: "10px 12px 8px 0",
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
      b.setAttribute("data-mode", def.id);
      b.setAttribute("aria-keyshortcuts", i < 9 ? String(i + 1) : "");
      var title = text(v, "b", "tumbler-mode-title", def.title, {
        fontWeight: "400",
        fontSize: "24px",
        lineHeight: "1.1",
      });
      var summary = text(v, "span", "tumbler-mode-summary", def.summary || "", {
        fontSize: "12.5px",
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
    var strip = make(v, "canvas", "tumbler-strip", {
      width: "100%",
      height: "18px",
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
      fontSize: "11.5px",
    });
    v.stripFirst = text(v, "span", "", "dimension 1");
    v.stripMiddle = text(v, "span", "", "how much each dimension contributes to the view right now");
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
      gap: "10px 18px",
      fontSize: "12px",
    });
    v.playButton = pillButton(v, "tumbler-play", "Pause");
    v.zoomResetButton = pillButton(v, "tumbler-zoom-reset", "Reset zoom");
    var speedLabel = make(v, "label", "tumbler-speed", { display: "inline-flex", alignItems: "center", gap: "8px" });
    speedLabel.appendChild(text(v, "span", "", "Speed"));
    var speed = make(v, "input", "", { width: "120px" });
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
      "Drag to turn. Pinch, or Ctrl + wheel, to zoom; double-click or double-tap resets. Keys 1-" +
        Math.max(1, Math.min(9, defs.length)) +
        " switch views while the viewer has focus."
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
      cs = v.win && typeof v.win.getComputedStyle === "function" ? v.win.getComputedStyle(v.root) : null;
    } catch (err) {
      cs = null;
    }
    function raw(name) {
      if (!cs || typeof cs.getPropertyValue !== "function") return "";
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
    return t;
  }

  // Resolve a named or otherwise unparsed colour through the browser: set it on a
  // hidden probe inside the viewer and read the computed value.
  function probeColour(v, s) {
    if (!v.root || !v.win || typeof v.win.getComputedStyle !== "function") return null;
    var probe = null;
    try {
      probe = v.doc.createElement("span");
      probe.style.display = "none";
      probe.style.color = s;
      v.root.appendChild(probe);
      var c = parseColour(String(v.win.getComputedStyle(probe).color || ""));
      return c;
    } catch (err) {
      return null;
    } finally {
      if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
    }
  }

  function groupColour(v, index) {
    if (index < 0) return v.theme.ungrouped;
    if (index < MAX_GROUP_PROPS && v.theme.groups[index]) return v.theme.groups[index];
    if (index < GROUP_HUES.length) return hsl(GROUP_HUES[index], 0.9, 0.62);
    // Past the reference's hues: golden-angle steps, same saturation and lightness.
    return hsl((GROUP_HUES[GROUP_HUES.length - 1] + 137.508 * (index - GROUP_HUES.length + 1)) % 360, 0.9, 0.62);
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
    // The renderer draws light on black. On a dark host it is screened over the sky;
    // on a light host it is inverted (hue kept) and multiplied, so points show as ink.
    if (t.light) {
      v.canvas.style.filter = "invert(1) hue-rotate(180deg)";
      v.canvas.style.mixBlendMode = "multiply";
    } else {
      v.canvas.style.filter = "none";
      v.canvas.style.mixBlendMode = "screen";
    }
    v.mastTitle.style.fontFamily = t.fontDisplay;
    v.mastTitle.style.textShadow = "0 0 28px " + cssRgb(t.background, 0.9);
    v.mastLine.style.fontFamily = t.fontData;
    v.mastLine.style.color = muted;
    v.mastLine.style.textShadow = "0 0 12px " + bg;
    setStyles(v.status, { fontFamily: t.fontData, color: accent, textShadow: "0 0 8px " + bg });
    setStyles(v.fatal, { color: fg, background: cssRgb(t.background, 0.82), fontFamily: t.font });
    setStyles(v.notice, { color: fg, background: cssRgb(t.background, 0.92), borderColor: accent, fontFamily: t.fontData });
    v.noticeDismiss.style.borderColor = line;
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
    v.strokeHalo = cssRgb(t.background, 0.85);
    v.accent255 = [Math.round(t.accent[0] * 255), Math.round(t.accent[1] * 255), Math.round(t.accent[2] * 255)];
    v.needClear = true;
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
    v.theme = readTheme(v);
    applyTheme(v);
    if (v.set) {
      recolour(v);
    }
    invalidate(v);
  }

  // ---------- point colours and weights ----------

  function groupIndexOf(v, group) {
    if (typeof group !== "string" || group === "") return -1;
    if (Object.prototype.hasOwnProperty.call(v.groupIndex, group)) return v.groupIndex[group];
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
  function paint(v, set, from, to) {
    var n = to - from;
    var colours = new Float32Array(n * 3);
    var weights = new Float32Array(n);
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
      var o = (i - from) * 3;
      colours[o] = c[0];
      colours[o + 1] = c[1];
      colours[o + 2] = c[2];
      weights[i - from] = w;
    }
    return { colours: colours, weights: weights };
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
    if (res && res.ok === false) fatal(v, res.message);
    if (v.mode) v.mode.wiresVersion = -1;
  }

  // ---------- messages ----------

  // A message over the whole stage. kind "gpu" (no WebGL, lost for good, too many
  // points) or "data" (a refusal while the view holds no set).
  function fatal(v, message, kind) {
    v.fatalKind = kind || "gpu";
    v.fatalMessage = String(message);
    v.fatalText.textContent = v.fatalMessage;
    v.fatal.style.display = "flex";
  }
  function clearFatal(v) {
    v.fatalKind = null;
    v.fatalMessage = null;
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
      d = {};
    }
    var out = m.title + ": " + (d.projection || "a linear projection");
    if (typeof d.varianceShare === "number" && isFinite(d.varianceShare)) {
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
    while (list.firstChild) list.removeChild(list.firstChild);
    v.provView = null;
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
    if (r && r.kind === "top-k") dim += " (reduced from " + thousands(r.source_dimension) + ")";
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
    v.stripMiddle.textContent = "how much each of the " + thousands(D) + " dimensions contributes to the view right now";
  }

  // ---------- modes ----------

  function copyState(s) {
    if (!s) return null;
    var draw = {};
    for (var k in s.draw) if (Object.prototype.hasOwnProperty.call(s.draw, k)) draw[k] = s.draw[k];
    return { frame: new Float32Array(s.frame), centre: new Float32Array(s.centre), draw: draw };
  }

  // Start mode `id` on the current set. Returns true, or false after showing why not.
  function startMode(v, id, from) {
    var def = ET.modes.get(id);
    if (!def) {
      notify(v, 'There is no view called "' + String(id) + '".');
      return false;
    }
    if (!v.set) {
      v.modeId = id;
      paintModeButtons(v);
      return true;
    }
    var inst;
    try {
      inst = ET.modes.create(id);
      inst.enter(v.set, { seed: v.seed, from: from || null });
    } catch (err) {
      notify(v, err && err.message ? err.message : "This view cannot show the data.");
      return false;
    }
    if (v.mode) {
      try {
        v.mode.inst.leave();
      } catch (err) {
        // a mode's leave() has nothing the viewer needs
      }
    }
    v.mode = {
      id: id,
      title: def.title,
      inst: inst,
      jobs: [inst.prepare()],
      clock: 0,
      wiresVersion: -1,
      held: false, // the first frame of a new instance is drawn before any heavy work
      refit: null,
      readyAt: null,
      lastFocusTo: -1,
      prevNeighbours: null,
      curNeighbours: null,
    };
    v.modeId = id;
    paintModeButtons(v);
    refreshViewRow(v);
    v.statusClock = STATUS_EVERY;
    return true;
  }

  function setMode(v, id) {
    if (v.destroyed) return false;
    if (typeof id !== "string") return false;
    if (v.mode && v.mode.id === id) return true;
    if (!v.set && ET.modes.get(id)) {
      v.modeId = id;
      paintModeButtons(v);
      refreshViewRow(v);
      call(v, v.options.onModeChange, id);
      return true;
    }
    var ok = startMode(v, id, copyState(v.last));
    if (ok) {
      call(v, v.options.onModeChange, id);
      invalidate(v);
    }
    return ok;
  }

  // ---------- data ----------

  function update(v, data) {
    if (v.destroyed) return { ok: false, code: "destroyed", message: "This viewer has been destroyed." };
    var res;
    try {
      res = ET.contract.validate(data, v.set);
    } catch (err) {
      res = { ok: false, code: "invalid-field", message: 'Field "(unreadable data)" is missing or not valid.' };
    }
    // Re-read the host's theme on every update (no polling).
    v.theme = readTheme(v);
    applyTheme(v);
    if (!res || !res.ok) {
      var refusal = { ok: false, code: res ? res.code : "invalid-field", message: res ? res.message : "Data refused." };
      // With a view showing (or a graphics message up), the refusal is a notice and
      // the view keeps running unchanged; with nothing to show it fills the stage.
      if (v.set || v.fatalKind === "gpu") notify(v, refusal.message);
      else fatal(v, refusal.message, "data");
      call(v, v.options.onError, refusal);
      invalidate(v);
      return refusal;
    }
    var op = "replace";
    try {
      if (data.op === "append") op = "append";
    } catch (err) {
      op = "replace";
    }
    clearNotice(v);
    if (v.fatalKind === "data") clearFatal(v);
    var out = op === "append" ? applyAppend(v, res.set) : applyReplace(v, res.set);
    if (out.ok) {
      if (v.fatalKind === "gpu" && v.rendering) clearFatal(v);
    } else {
      call(v, v.options.onError, out);
    }
    invalidate(v);
    return out;
  }

  function applyReplace(v, set) {
    v.groupIndex = {};
    v.groupNames = [];
    v.labelledCount = countLabelled(set, 0, set.count);
    v.labelSample = [];
    extendLabelSample(v, set, 0);
    v.set = set;
    v.last = null;
    v.spin = 0;
    v.drag = { yaw: 0, pitch: 0 };
    v.needClear = true;
    v.sinceAppend = Infinity;
    if (v.mode) {
      try {
        v.mode.inst.leave();
      } catch (err) {
        // nothing to keep
      }
      v.mode = null;
    }
    var gpu = null;
    if (v.renderer) {
      var pc = paint(v, set, 0, set.count);
      gpu = v.renderer.setData({ vectors: set.vectors, dimension: set.dimension, colours: pc.colours, weights: pc.weights });
    }
    sizeStrip(v);
    describeSet(v);
    if (!startMode(v, v.modeId, null)) {
      // The chosen view cannot show this data (too few dimensions): try the others.
      var ids = ET.modes.ids();
      for (var i = 0; i < ids.length && !v.mode; i++) if (ids[i] !== v.modeId) startMode(v, ids[i], null);
    }
    renderProvenance(v);
    if (gpu && gpu.ok === false) {
      fatal(v, gpu.message);
      return { ok: false, code: gpu.reason, message: gpu.message };
    }
    return { ok: true, op: "replace", count: set.count, added: set.count };
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
    var hadLabelled = v.labelledCount;
    v.labelledCount += countLabelled(set, from, set.count);
    if (hadLabelled === 0 && v.labelledCount > 0) {
      // The first labelled points arrived: rebuild the label sample from them.
      v.labelSample = [];
      extendLabelSample(v, set, 0);
    } else extendLabelSample(v, set, from);
    var gpu = null;
    if (v.renderer) {
      var pc = paint(v, set, from, set.count);
      var D = set.dimension;
      try {
        gpu = v.renderer.appendData({
          vectors: set.vectors.subarray(from * D, set.count * D),
          colours: pc.colours,
          weights: pc.weights,
        });
      } catch (err) {
        gpu = { ok: false, reason: "gpu-failed", message: err && err.message ? err.message : "append failed" };
      }
    }
    v.set = set;
    if (v.mode) {
      var r = v.mode.inst.dataChanged(set, { op: "append", added: k, t: v.mode.clock });
      if (r && r.work) v.mode.jobs.push(r.work);
      if (r && r.restart) {
        v.mode.clock = 0;
        v.mode.held = false;
        v.mode.readyAt = null;
      }
    } else startMode(v, v.modeId, null);
    v.sinceAppend = 0;
    describeSet(v);
    renderProvenance(v);
    v.timing.lastAppendMs = now(v) - t0;
    if (gpu && gpu.ok === false) {
      fatal(v, gpu.message);
      return { ok: false, code: gpu.reason, message: gpu.message };
    }
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
    } catch (err) {
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
    } catch (err) {
      w = 0;
    }
    if (!(w > 0)) w = v.stage.clientWidth || 300;
    if (!(h > 0)) h = v.stage.clientHeight || 150;
    var dpr = Math.min(Number(v.options.maxPixelRatio) || 2, (v.win && v.win.devicePixelRatio) || 1);
    v.dpr = dpr;
    v.cssW = w;
    v.cssH = h;
    var W = Math.max(2, Math.round(w * dpr));
    var H = Math.max(2, Math.round(h * dpr));
    v.W = W;
    v.H = H;
    if (v.renderer) v.renderer.resize(W, H);
    if (v.overlay.width !== W) v.overlay.width = W;
    if (v.overlay.height !== H) v.overlay.height = H;
    var rootW = 0;
    try {
      rootW = v.root.getBoundingClientRect().width;
    } catch (err) {
      rootW = w;
    }
    layoutForWidth(v, rootW || w);
    v.needClear = true;
    invalidate(v);
  }

  // No media queries without a stylesheet, so the layout reacts to the element's width.
  function layoutForWidth(v, width) {
    var narrow = width < 600;
    if (narrow === v.narrow) return;
    v.narrow = narrow;
    v.modeButtons.forEach(function (mb) {
      mb.summary.style.display = narrow ? "none" : "";
      mb.title.style.fontSize = narrow ? "20px" : "24px";
    });
    v.provList.style.gridTemplateColumns = width < 520 ? "minmax(0, 1fr)" : "max-content minmax(0, 1fr)";
    v.panel.style.padding = narrow ? "6px 12px 14px" : "6px 16px 16px";
  }

  // ---------- the loop ----------

  function now(v) {
    var p = v.win && v.win.performance;
    if (p && typeof p.now === "function") return p.now();
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
    if (!v.win || typeof v.win.requestAnimationFrame !== "function") return;
    v.raf = v.win.requestAnimationFrame(v.tick);
  }

  function unschedule(v) {
    if (v.raf && v.win && typeof v.win.cancelAnimationFrame === "function") v.win.cancelAnimationFrame(v.raf);
    v.raf = 0;
    v.prev = null; // the next frame after a resume starts from a fresh clock
  }

  function needsMore(v) {
    if (v.dirty) return true;
    var m = v.mode;
    if (!m || !v.set || v.set.count === 0) return false;
    if (m.jobs.length || m.refit) return true;
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
    var dt = v.prev === null ? 1 / 60 : clamp((t - v.prev) / 1000, 0.001, 0.05);
    v.prev = t;
    v.dirty = false;
    try {
      step(v, dt, start);
    } catch (err) {
      fatal(v, "The viewer stopped: " + (err && err.message ? err.message : String(err)));
      v.broken = true;
      return;
    }
    var spent = now(v) - start;
    if (spent > v.timing.longestFrameMs) v.timing.longestFrameMs = spent;
    v.frames++;
    if (v.timing.firstFrameMs === null) v.timing.firstFrameMs = now(v) - v.timing.mountAt;
    v.fpsFrames++;
    if (v.fpsAt === null) v.fpsAt = t;
    else if (t - v.fpsAt >= 1000) {
      v.fps = (v.fpsFrames * 1000) / (t - v.fpsAt);
      v.fpsAt = t;
      v.fpsFrames = 0;
    }
    if (!v.broken && needsMore(v)) schedule(v);
  }

  function pump(v, m, start) {
    var budget = Math.max(1, Number(v.options.prepareBudgetMs) || 8);
    while (m.jobs.length) {
      var job = m.jobs[0];
      var left = budget - (now(v) - start);
      if (left <= 0) break;
      if (!job.done) job.step(left);
      if (job.done) m.jobs.shift();
      else break;
    }
    if (m.refit && now(v) - start < budget) {
      m.refit.step(Math.max(1, budget - (now(v) - start)));
      if (m.refit.done) m.refit = null;
    }
  }

  // Tumble's refit policy after appends: once appends have been quiet for
  // refitQuietSeconds and the points added since the last fit are at least
  // refitShare of the set (and at least one), fit the directions again.
  function considerRefit(v, m) {
    if (m.refit || m.jobs.length || typeof m.inst.refit !== "function") return;
    if (v.sinceAppend < v.options.refitQuietSeconds) return;
    var d = m.inst.describe();
    if (!d || !d.varianceShareStale || !(d.pointsSinceFit > 0)) return;
    if (d.pointsSinceFit < Math.max(1, Math.ceil(v.options.refitShare * v.set.count))) return;
    m.refit = m.inst.refit();
    v.timing.refits++;
  }

  function step(v, dt, start) {
    var m = v.mode;
    var r = v.renderer;
    v.sinceAppend += dt;
    if (!m || !v.set) {
      if (r && v.rendering) r.draw({ clear: true, dt: dt });
      v.status.textContent = v.set ? "this view cannot show the data" : "waiting for data";
      clearLabels(v, 0);
      return;
    }
    if (m.held) pump(v, m, start);
    else m.held = true; // first frame for this instance: draw the hold state, work next frame
    var ready = m.inst.isReady();
    if (ready && m.readyAt === null) {
      m.readyAt = now(v);
      if (v.timing.firstReadyMs === null) v.timing.firstReadyMs = m.readyAt - v.timing.mountAt;
    }
    var moving = ready && v.running;
    if (moving) {
      m.clock += dt * v.speed;
      if (!v.drag.active) v.spin += dt * v.speed;
    }
    if (ready && typeof m.inst.mark === "function") m.inst.mark(m.clock);
    if (ready) considerRefit(v, m);
    var s = m.inst.stateAt(ready ? m.clock : 0);
    if (r && s.wires && s.wires.version !== m.wiresVersion) {
      r.setWires(s.wires.pairs, s.wires.lengths);
      m.wiresVersion = s.wires.version;
    }
    if (!v.reducedMotion || v.running) v.drawTime += dt;
    var ds = drawState(v, s, dt);
    if (r && v.rendering) r.draw(ds);
    v.needClear = false;
    v.last = s;
    v.lastDraw = ds;
    if (v.showLabels || v.hover) drawOverlay(v, s, ds);
    else clearOverlay(v);
    drawStrip(v, s.frame);
    v.statusClock += dt;
    if (v.statusClock >= STATUS_EVERY) {
      v.statusClock = 0;
      var line = s.status;
      if (v.userZoom !== 1) line += " · zoom " + v.userZoom.toFixed(1) + "×";
      if (!v.running) line += " · paused";
      if (line !== v.statusText) {
        v.status.textContent = line;
        v.statusText = line;
      }
      refreshViewRow(v);
      v.root.setAttribute("aria-busy", ready && !m.jobs.length ? "false" : "true");
    }
  }

  function drawState(v, s, dt) {
    var out = {};
    var d = s.draw;
    for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    out.frame = s.frame;
    out.centre = s.centre;
    out.zoom = (d.zoom || 1) * v.userZoom;
    out.yaw = 0.4 + v.drag.yaw + SPIN * v.spin;
    out.pitch = clamp(0.16 + v.drag.pitch, -1.3, 1.3);
    out.pointSize = 6.5 * v.dpr;
    out.time = v.drawTime;
    out.dt = dt;
    if (!v.trails) out.trails = 0;
    if (v.reducedMotion) out.twinkle = 0;
    out.clear = !!v.needClear;
    return out;
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

  function clearOverlay(v) {
    if (v.overlayCtx === undefined) v.overlayCtx = safeContext2d(v.overlay);
    if (v.overlayCtx && v.overlayDirty) {
      v.overlayCtx.clearRect(0, 0, v.W, v.H);
      v.overlayDirty = false;
    }
    clearLabels(v, 0);
  }

  function safeContext2d(canvas) {
    try {
      return canvas.getContext("2d") || null;
    } catch (err) {
      return null;
    }
  }

  function label(v, used, str, x, y, style) {
    if (used >= LABEL_POOL) return used;
    var rec = v.labelPool[used];
    if (!rec) {
      var el = make(v, "span", "tumbler-label", {
        position: "absolute",
        left: "0",
        top: "0",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        willChange: "transform",
      });
      v.labelLayer.appendChild(el);
      rec = { el: el, text: null, key: "", shown: true };
      v.labelPool.push(rec);
    }
    if (rec.text !== str) {
      rec.el.textContent = str;
      rec.text = str;
    }
    var key = style.kind + "|" + style.colour;
    if (rec.key !== key) {
      var t = v.theme;
      var big = style.kind === "stop";
      setStyles(rec.el, {
        fontFamily: big ? t.fontDisplay : t.fontData,
        fontStyle: big ? "italic" : "normal",
        fontSize: big ? "22px" : style.kind === "hover" ? "12px" : "11px",
        letterSpacing: style.kind === "group" ? "0.06em" : "0",
        textTransform: style.kind === "group" ? "uppercase" : "none",
        color: style.colour,
        textShadow: "0 0 4px " + v.strokeHalo + ", 0 0 2px " + v.strokeHalo,
      });
      rec.key = key;
    }
    var shift =
      style.align === "center" ? "translate(-50%, -100%)" : style.align === "right" ? "translate(-100%, -50%)" : "translate(0, -50%)";
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
    if (v.overlayCtx === undefined) v.overlayCtx = safeContext2d(v.overlay);
    var ctx = v.overlayCtx;
    var dpr = v.dpr;
    var tmp = v.tmp3;
    if (ctx) {
      ctx.clearRect(0, 0, v.W, v.H);
      v.overlayDirty = false;
    }
    var used = 0;
    var fogMix = clamp(Number(s.draw.fog) || 0, 0, 1);
    var fg = cssRgb(v.theme.foreground);
    var sample = v.labelSample;
    var n = sample.length;
    if (v.sx.length < n) {
      v.sx = new Float32Array(LABEL_SAMPLE);
      v.sy = new Float32Array(LABEL_SAMPLE);
    }
    var needSample = (v.showLabels && fogMix < 0.97) || v.hover;
    if (needSample) {
      for (var j = 0; j < n; j++) {
        var q = project(v, sample[j], s, ds, tmp);
        v.sx[j] = q.x;
        v.sy[j] = q.y;
      }
    }
    // Group names at the middle of their labelled points, fading out as Wander's fog comes in.
    if (v.showLabels && fogMix < 0.97 && v.groupNames.length) {
      var G = v.groupNames.length;
      var cx = new Float64Array(G);
      var cy = new Float64Array(G);
      var cn = new Float64Array(G);
      for (var k = 0; k < n; k++) {
        var g = v.groupIndex[v.set.points[sample[k]].group];
        if (g === undefined) continue;
        cx[g] += v.sx[k];
        cy[g] += v.sy[k];
        cn[g]++;
      }
      for (var gi = 0; gi < G; gi++) {
        if (!cn[gi]) continue;
        // Lighter than the points on a dark host (the reference's 72% lightness),
        // darker on a light one so the names stay readable.
        var col = cssRgb(v.theme.light ? mix(groupColour(v, gi), [0, 0, 0], 0.45) : mix(groupColour(v, gi), [1, 1, 1], 0.3));
        used = label(v, used, shorten(v.groupNames[gi], 32), cx[gi] / cn[gi] / dpr, cy[gi] / cn[gi] / dpr - 14, {
          kind: "group",
          colour: col,
          alpha: (1 - fogMix) * 0.8,
          align: "center",
        });
      }
    }
    // Wander: the stop, its labelled neighbours and spokes to them.
    var f = s.focus;
    var m = v.mode;
    if (f && m) {
      if (f.to !== m.lastFocusTo) {
        m.prevNeighbours = m.curNeighbours;
        m.lastFocusTo = f.to;
      }
      m.curNeighbours = f.neighbours ? Array.prototype.slice.call(f.neighbours) : [];
      if (f.phase === "dwell") used = spokes(v, ctx, f.to, m.curNeighbours, 1, s, ds, used, fg);
      else {
        var e = clamp(Number(f.e) || 0, 0, 1);
        used = spokes(v, ctx, f.from, m.prevNeighbours || [], 1 - e * 1.6, s, ds, used, fg);
        used = spokes(v, ctx, f.to, m.curNeighbours, e * e, s, ds, used, fg);
      }
    }
    // Hover: the nearest sampled point within 20 px.
    if (v.hover && n) {
      var best = -1;
      var bd = 20 * dpr * (20 * dpr);
      for (var h = 0; h < n; h++) {
        var dx = v.sx[h] - v.hover.x * dpr;
        var dy = v.sy[h] - v.hover.y * dpr;
        var d2 = dx * dx + dy * dy;
        if (d2 < bd) {
          bd = d2;
          best = h;
        }
      }
      if (best >= 0) {
        var bi = sample[best];
        if (ctx) {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 1.5 * dpr;
          ctx.strokeStyle = fg;
          ctx.beginPath();
          ctx.arc(v.sx[best], v.sy[best], 8 * dpr, 0, TAU);
          ctx.stroke();
          v.overlayDirty = true;
        }
        var right = v.sx[best] > v.W * 0.7;
        var grp = v.set.points[bi].group;
        var str = labelText(v, bi) + (grp ? " · " + shorten(grp, 24) : "");
        used = label(v, used, str, v.sx[best] / dpr + (right ? -14 : 14), v.sy[best] / dpr, {
          kind: "hover",
          colour: fg,
          alpha: 1,
          align: right ? "right" : "left",
        });
      }
    }
    if (ctx) ctx.globalAlpha = 1;
    clearLabels(v, used);
  }

  function spokes(v, ctx, i, neighbours, alpha, s, ds, used, fg) {
    if (!(i >= 0) || i >= v.set.count || alpha <= 0.02) return used;
    var dpr = v.dpr;
    var p = project(v, i, s, ds, v.tmp3);
    var px = p.x;
    var py = p.y;
    var col = cssRgb(groupColour(v, groupIndexOf(v, v.set.points[i].group)));
    for (var k = 0; k < neighbours.length; k++) {
      var j = neighbours[k];
      if (!(j >= 0) || j >= v.set.count) continue;
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
          colour: fg,
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
        colour: fg,
        alpha: alpha,
        align: "left",
      });
    }
    return used;
  }

  // ---------- readout strip ----------

  // One cell per dimension: how much that dimension contributes to the three axes on
  // screen, relative to an even share (the reference's (f0^2 + f1^2 + f2^2) * D / 3).
  function drawStrip(v, F) {
    if (!v.stripCtx || !v.stripImage || !v.set) return;
    var D = v.set.dimension;
    var px = v.stripImage.data;
    var a = v.accent255;
    for (var d = 0; d < D; d++) {
      var e = ((F[d] * F[d] + F[D + d] * F[D + d] + F[2 * D + d] * F[2 * D + d]) * D) / 3;
      var o = d * 4;
      px[o] = a[0];
      px[o + 1] = Math.max(0, a[1] - Math.min(60, e * 12));
      px[o + 2] = a[2];
      px[o + 3] = Math.min(255, e * 80);
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
        r = { left: 0, top: 0 };
      }
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function pinchDistance() {
      var ids = Object.keys(pointers);
      if (ids.length < 2) return 0;
      var a = pointers[ids[0]];
      var b = pointers[ids[1]];
      return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
    }

    listen(v, stage, "pointerdown", function (e) {
      if (e.button !== undefined && e.button > 0) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now(v) };
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
        v.pinch = { d0: pinchDistance() || 1, z0: v.userZoom };
      } else {
        v.drag.active = true;
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
        setZoom(v, v.pinch.z0 * (pinchDistance() / v.pinch.d0));
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
        stage.style.cursor = "grab";
      }
      // Double tap (touch or pen) resets the zoom; a mouse uses dblclick.
      if (e.type === "pointerup" && pt && e.pointerType && e.pointerType !== "mouse") {
        var moved = Math.abs(e.clientX - pt.sx) + Math.abs(e.clientY - pt.sy);
        var t = now(v);
        if (moved < 12 && t - pt.t < 300) {
          if (lastTap && t - lastTap.t < 350 && Math.abs(e.clientX - lastTap.x) + Math.abs(e.clientY - lastTap.y) < 32) {
            setZoom(v, 1);
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
      if (e.preventDefault) e.preventDefault();
      setZoom(v, 1);
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
      var tag = target && target.tagName ? String(target.tagName).toUpperCase() : "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      var k = e.key;
      var handled = true;
      if (/^[1-9]$/.test(k)) {
        var ids = v.modeButtons.map(function (mb) {
          return mb.id;
        });
        var idx = Number(k) - 1;
        if (idx < ids.length) setMode(v, ids[idx]);
        else handled = false;
      } else if ((k === " " || k === "Spacebar") && target === v.root) setRunning(v, !v.running);
      else if (k === "+" || k === "=") setZoom(v, v.userZoom * 1.25);
      else if (k === "-" || k === "_") setZoom(v, v.userZoom / 1.25);
      else if (k === "0") setZoom(v, 1);
      else handled = false;
      if (handled && e.preventDefault) e.preventDefault();
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
      setZoom(v, 1);
    });
    listen(v, v.noticeDismiss, "click", function () {
      clearNotice(v);
    });
    listen(v, v.speedInput, "input", function () {
      var s = Number(v.speedInput.value);
      v.speed = isFinite(s) && s > 0 ? s : 1;
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
    var IO = v.win && v.win.IntersectionObserver;
    if (typeof IO === "function") {
      v.io = new IO(function (entries) {
        var last = entries && entries.length ? entries[entries.length - 1] : null;
        if (!last) return;
        v.onScreen = !!last.isIntersecting;
        if (suspended(v)) unschedule(v);
        else invalidate(v);
      });
      v.io.observe(v.root);
    }
    var RO = v.win && v.win.ResizeObserver;
    if (typeof RO === "function") {
      v.ro = new RO(function () {
        measure(v);
      });
      v.ro.observe(v.stage);
      v.ro.observe(v.root);
    } else if (v.win && typeof v.win.addEventListener === "function") {
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
    if (v.retryTimer || !v.win || typeof v.win.setTimeout !== "function") return;
    v.retryTimer = v.win.setTimeout(function () {
      v.retryTimer = 0;
      if (v.destroyed || !v.renderer) return;
      var r = v.renderer.rebuild();
      if (r && r.ok) {
        v.rendering = true;
        clearFatal(v);
        if (v.mode) v.mode.wiresVersion = -1;
        invalidate(v);
      }
    }, 1000);
  }

  // ---------- lifecycle ----------

  function mount(el, options) {
    if (!isElement(el)) throw new TypeError("EmbeddingsTumbler.mount needs a DOM element");
    var existing = lookup(el);
    if (existing) return existing.handle;
    var doc = el.ownerDocument;
    var win = doc.defaultView || null;
    var opts = {};
    for (var key in DEFAULT_OPTIONS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, key)) opts[key] = readOption(options, key);
    }
    var reduced = false;
    try {
      reduced = !!(win && win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (err) {
      reduced = false;
    }
    var seed = opts.seed;
    if (!(typeof seed === "number" && isFinite(seed)) && !(typeof seed === "string" && seed !== "")) seed = 1;
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
      drag: { active: false, yaw: 0, pitch: 0, x: 0, y: 0 },
      pinch: null,
      hover: null,
      needClear: true,
      statusClock: STATUS_EVERY,
      statusText: "",
      sinceAppend: Infinity,
      groupIndex: {},
      groupNames: [],
      labelledCount: 0,
      labelSample: [],
      labelPool: [],
      sx: new Float32Array(LABEL_SAMPLE),
      sy: new Float32Array(LABEL_SAMPLE),
      tmp3: [0, 0, 0],
      overlayDirty: false,
      listeners: [],
      io: null,
      ro: null,
      retryTimer: 0,
      frames: 0,
      fps: 0,
      fpsAt: null,
      fpsFrames: 0,
      narrow: null,
      dpr: 1,
      W: 2,
      H: 2,
      fatalMessage: null,
      fatalKind: null,
      noticeMessage: null,
      timing: { mountAt: 0, firstFrameMs: null, firstReadyMs: null, longestFrameMs: 0, lastAppendMs: null, refits: 0 },
    };
    v.timing.mountAt = now(v);
    v.tick = function (t) {
      frame(v, t);
    };
    build(v);
    el.appendChild(v.root);
    v.theme = readTheme(v); // read once the root inherits the host's properties
    applyTheme(v);
    v.playButton.textContent = v.running ? "Pause" : "Play";
    v.playButton.setAttribute("aria-pressed", v.running ? "false" : "true");
    paintModeButtons(v);
    v.mastTitle.textContent = opts.title ? String(opts.title) : "";
    v.mastTitle.style.display = opts.title ? "" : "none";
    makeRenderer(v);
    sizeStrip(v);
    renderProvenance(v);
    wire(v);
    measure(v);
    v.handle = makeHandle(v);
    remember(el, v);
    invalidate(v);
    return v.handle;
  }

  function destroy(v) {
    if (v.destroyed) return false;
    v.destroyed = true;
    unschedule(v);
    if (v.retryTimer && v.win && typeof v.win.clearTimeout === "function") v.win.clearTimeout(v.retryTimer);
    v.retryTimer = 0;
    if (v.io) v.io.disconnect();
    if (v.ro) v.ro.disconnect();
    v.io = null;
    v.ro = null;
    v.listeners.forEach(function (l) {
      l[0].removeEventListener(l[1], l[2], l[3]);
    });
    v.listeners = [];
    if (v.mode) {
      try {
        v.mode.inst.leave();
      } catch (err) {
        // nothing to keep
      }
    }
    v.mode = null;
    if (v.renderer) v.renderer.dispose();
    v.renderer = null;
    v.rendering = false;
    if (v.root && v.root.parentNode) v.root.parentNode.removeChild(v.root);
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
      ready: !!(m && m.inst.isReady()),
      preparing: !!(m && (!m.inst.isReady() || m.jobs.length || m.refit)),
      count: v.set ? v.set.count : 0,
      dimension: v.set ? v.set.dimension : 0,
      model: v.set ? v.set.model : null,
      rendering: v.rendering,
      animating: !!v.raf,
      frames: v.frames,
      fps: v.fps,
      status: v.statusText,
      message: v.fatalMessage || v.noticeMessage || null,
      timing: {
        firstFrameMs: v.timing.firstFrameMs,
        firstReadyMs: v.timing.firstReadyMs,
        longestFrameMs: v.timing.longestFrameMs,
        lastAppendMs: v.timing.lastAppendMs,
        refits: v.timing.refits,
      },
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
        if (!isFinite(x) || x < 0) x = 0;
        if (v.mode) v.mode.clock = x;
        v.spin = x;
        v.needClear = true;
        invalidate(v);
        return v.mode ? v.mode.clock : 0;
      },
      seed: function () {
        return v.seed;
      },
      setSpeed: function (s) {
        var x = Number(s);
        if (isFinite(x) && x > 0) {
          v.speed = x;
          v.speedInput.value = String(x);
        }
        return v.speed;
      },
      zoom: function (z) {
        if (z !== undefined && !v.destroyed) setZoom(v, Number(z) || 1);
        return v.userZoom;
      },
      resetZoom: function () {
        if (!v.destroyed) setZoom(v, 1);
      },
      refreshTheme: function () {
        refreshTheme(v);
      },
      info: function () {
        return info(v);
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
    SHADOW: SHADOW,
  };
})();

ET.api.mount = ET.viewer.mount;
ET.api.update = ET.viewer.update;
ET.api.destroy = ET.viewer.destroy;
ET.api.get = ET.viewer.get;
ET.api.registerMode = function (definition) {
  return ET.modes.register(definition);
};
