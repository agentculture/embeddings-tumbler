  // ---------- the relative overlay: ruler, ticks, level rings, stems, origin ----------
  //
  // Task t7 of the relative-search plan (docs/relative-interface.md, "Overlay (t7)"). Pure
  // numbers in, a draw list out (build); then the shapes are painted on the 2-D overlay
  // context (paint) and the texts are put as DOM spans over the stage (placeLabels), because
  // the viewer draws no text on a canvas. Every position goes through the renderer's CPU
  // placer with the draw state given to the renderer this frame (its perspective key
  // included), so the overlay and the points agree.
  //
  // Positions in the list are in device pixels of the overlay canvas; placeLabels divides by
  // the list's dpr to place the spans in CSS pixels.

  var RO_TICK_STEP = 0.1; // a tick and a level ring every 0.1 along the vertical search
  var RO_RING_RADIUS = 0.34; // a level ring's radius, in units (the reference's)
  var RO_RING_SEGMENTS = 48; // segments of a level ring (the reference's)
  var RO_CIRCLE_SEGMENTS = 96; // segments of the unit circle about the origin
  var RO_FOOT_MARGIN = 0.2; // the ruler starts this far below the window's bottom (not below 0)
  var RO_TOP_MARGIN = 0.04; // the second ruler runs to max(1, its length) plus this
  var RO_OWN_DISTANCE = 1e-7; // a named result this close in cosine distance to its search ...
  var RO_OWN_LENGTH = 1e-6; // ... and this close in length is the search's own point
  var RO_TEXT_MAX = 28; // a result's text is cut here, as the search panel cuts it
  var RO_LABEL_POOL = 160; // the most spans placeLabels keeps
  var RO_CHAR_W = 6.7; // estimated width of one 11 px monospace character, CSS px
  var RO_LABEL_H = 12; // height of one label box, CSS px
  var RO_INK = "#ffffff"; // white marks and texts (the reference's), unless input.ink is given
  var RO_PAPER = "#04060b"; // the text outline (the reference's stage), unless input.paper is given
  var RO_FIRST_KINDS = ["title", "tick", "cut", "origin", "search"]; // placed before any result
  var RO_SPANS = typeof WeakMap === "function" ? new WeakMap() : null;

  function roEmpty(dpr, paper) {
    return { segments: [], rings: [], marks: [], texts: [], results: [], ruler: null, dpr: dpr, paper: paper };
  }

  function roLength(v) {
    var s = 0;
    for (var d = 0; d < v.length; d++) s += v[d] * v[d];
    return Math.sqrt(s);
  }

  // x . row r of the frame, in double precision.
  function roRowDot(F, D, r, v, o) {
    var s = 0;
    var base = r * D;
    var off = o || 0;
    for (var d = 0; d < D; d++) s += v[off + d] * F[base + d];
    return s;
  }

  function roShorten(s, max) {
    var str = String(s);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  function roFinite(n) {
    return typeof n === "number" && Number.isFinite(n);
  }

  // Everything one build needs about the frame and the screen.
  function roContext(input) {
    var D = input.dimension;
    var F = input.frame;
    var C = input.centre;
    var W = input.width;
    var H = input.height;
    var view = input.view || {};
    var cF = [roRowDot(F, D, 0, C), roRowDot(F, D, 1, C), roRowDot(F, D, 2, C)];
    var put = ET.renderer.placer(view, W, H);
    var dpr = Number(input.dpr) > 0 ? Number(input.dpr) : 1;
    return {
      D: D,
      F: F,
      C: C,
      X: input.vectors,
      W: W,
      H: H,
      view: view,
      dpr: dpr,
      cF: cF,
      ink: typeof input.ink === "string" ? input.ink : RO_INK,
      // frame coordinates (already centred) to overlay pixels
      at: function (a, b, c) {
        return put(a, b, c, { x: 0, y: 0 });
      },
    };
  }

  // A search's direction and its shadow on the frame's rows.
  function roSearch(cx, s) {
    var q = s.query;
    var len = roLength(q);
    var u = new Float64Array(cx.D);
    if (len > ET.math.RELATIVE_ZERO_LENGTH) for (var d = 0; d < cx.D; d++) u[d] = q[d] / len;
    return {
      letter: s.letter,
      colour: s.colour,
      query: q,
      length: len,
      u: u,
      f: [roRowDot(cx.F, cx.D, 0, u), roRowDot(cx.F, cx.D, 1, u), roRowDot(cx.F, cx.D, 2, u)],
    };
  }

  // The point k units along a search's direction, in overlay pixels.
  function roAlong(cx, sq, k) {
    return cx.at(k * sq.f[0] - cx.cF[0], k * sq.f[1] - cx.cF[1], k * sq.f[2] - cx.cF[2]);
  }

  // A vector of the data's dimension (row i of the block, or a query), in overlay pixels.
  function roVectorAt(cx, v, o) {
    var a = roRowDot(cx.F, cx.D, 0, v, o) - cx.cF[0];
    var b = roRowDot(cx.F, cx.D, 1, v, o) - cx.cF[1];
    var c = roRowDot(cx.F, cx.D, 2, v, o) - cx.cF[2];
    return cx.at(a, b, c);
  }

  // Row i dotted with a unit direction, and row i's length, in double precision.
  function roHeight(cx, i, u) {
    var o = i * cx.D;
    var s = 0;
    for (var d = 0; d < cx.D; d++) s += cx.X[o + d] * u[d];
    return s;
  }

  function roRowLength(cx, i) {
    var o = i * cx.D;
    var s = 0;
    for (var d = 0; d < cx.D; d++) s += cx.X[o + d] * cx.X[o + d];
    return Math.sqrt(s);
  }

  // The centre's true length and the part of it the frame shows.
  function roOriginNumbers(cx) {
    return {
      far: roLength(cx.C),
      seen: Math.sqrt(cx.cF[0] * cx.cF[0] + cx.cF[1] * cx.cF[1] + cx.cF[2] * cx.cF[2]),
    };
  }

  // The search's own point: a named result at cosine distance below 1e-7 from a search and
  // of the same length within 1e-6 sits on that search's marker; it gets no stem and no label.
  function roIsOwnPoint(cx, i, searches) {
    var len = roRowLength(cx, i);
    if (!(len > 0)) return false;
    for (var s of searches) {
      if (!(s.length > ET.math.RELATIVE_ZERO_LENGTH)) continue;
      var cos = roHeight(cx, i, s.u) / len;
      if (1 - cos < RO_OWN_DISTANCE && Math.abs(len - s.length) < RO_OWN_LENGTH) return true;
    }
    return false;
  }

  function roSegment(list, a, b, colour, alpha, width, kind, dash) {
    list.segments.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, colour: colour, alpha: alpha, width: width, dash: dash || null, kind: kind });
  }

  function roText(list, x, y, text, align, colour, alpha, kind, extra) {
    var t = { x: x, y: y, text: text, align: align, colour: colour, alpha: alpha, kind: kind };
    if (extra) for (var k in extra) if (Object.hasOwn(extra, k)) t[k] = extra[k];
    list.texts.push(t);
  }

  function roOriginMark(list, cx, p, alpha) {
    var n = roOriginNumbers(cx);
    list.marks.push({ x: p.x, y: p.y, r: 7 * cx.dpr, colour: cx.ink, alpha: alpha, kind: "origin", far: n.far, seen: n.seen });
    return n;
  }

  // ----- the plain view: where the all-zero vector falls, and how far it really is -----

  function roPlain(list, cx) {
    var p = cx.at(-cx.cF[0], -cx.cF[1], -cx.cF[2]);
    var n = roOriginMark(list, cx, p, 1);
    roText(list, p.x + 12 * cx.dpr, p.y, "origin · truly " + n.far.toFixed(2) + " from the centre, " + n.seen.toFixed(2) + " of it visible", "left", cx.ink, 1, "origin");
  }

  // ----- the relative view -----

  function roWindow(cx, rel, s0) {
    var w = rel.window;
    if (w && roFinite(w.top) && roFinite(w.bottom)) return { top: w.top, bottom: w.bottom };
    var hw = ET.math.heightWindow(cx.X, cx.X.length / cx.D, cx.D, s0.u, s0.length);
    var low = hw.low === null ? s0.length : hw.low;
    return { top: hw.high + 0.04, bottom: low - 0.04 };
  }

  function roRuler(list, cx, s0, foot, top, alpha) {
    var a = roAlong(cx, s0, foot);
    var b = roAlong(cx, s0, top);
    roSegment(list, a, b, s0.colour, alpha, cx.dpr, "ruler");
    list.ruler = { x0: a.x, y0: a.y, x1: b.x, y1: b.y, from: foot, to: top };
  }

  function roTicks(list, cx, s0, foot, top, m) {
    var first = Math.ceil(foot / RO_TICK_STEP - 1e-9);
    var last = Math.floor(top / RO_TICK_STEP + 1e-6);
    for (var k = first; k <= last; k++) {
      var s = k * RO_TICK_STEP;
      var p = roAlong(cx, s0, s);
      roSegment(list, { x: p.x - 4 * cx.dpr, y: p.y }, { x: p.x + 4 * cx.dpr, y: p.y }, s0.colour, 0.75 * m, cx.dpr, "tick");
      // a level ring: every point at this height, whatever its side
      var pts = new Float32Array(2 * (RO_RING_SEGMENTS + 1));
      var b = s * s0.f[1] - cx.cF[1];
      for (var j = 0; j <= RO_RING_SEGMENTS; j++) {
        var th = (j / RO_RING_SEGMENTS) * Math.PI * 2;
        var q = cx.at(s * s0.f[0] - cx.cF[0] + RO_RING_RADIUS * Math.cos(th), b, s * s0.f[2] - cx.cF[2] + RO_RING_RADIUS * Math.sin(th));
        pts[2 * j] = q.x;
        pts[2 * j + 1] = q.y;
      }
      list.rings.push({ points: pts, colour: s0.colour, alpha: 0.16 * m, kind: "level", dash: null });
      roText(list, p.x - 9 * cx.dpr, p.y, s.toFixed(1), "right", s0.colour, 0.75 * m, "tick", { height: s });
    }
  }

  function roUnitCircle(list, cx, m) {
    var o = ET.renderer.place([-cx.cF[0], -cx.cF[1], -cx.cF[2]], cx.view, cx.W, cx.H);
    var zoom = roFinite(cx.view.zoom) ? cx.view.zoom : ET.renderer.DEFAULTS.zoom;
    var radius = roFinite(cx.view.radius) ? cx.view.radius : ET.renderer.DEFAULTS.radius;
    // every vector has length one, so none can fall outside this circle
    var r = zoom * Math.min(cx.W, cx.H) * radius * o.scale;
    var pts = new Float32Array(2 * (RO_CIRCLE_SEGMENTS + 1));
    for (var j = 0; j <= RO_CIRCLE_SEGMENTS; j++) {
      var th = (j / RO_CIRCLE_SEGMENTS) * Math.PI * 2;
      pts[2 * j] = o.x + r * Math.cos(th);
      pts[2 * j + 1] = o.y + r * Math.sin(th);
    }
    list.rings.push({ points: pts, colour: cx.ink, alpha: 0.22 * m, kind: "unit", dash: [3 * cx.dpr, 6 * cx.dpr], radius: r });
  }

  // Ruler B, in the plane it shares with A, along B's own direction.
  function roSecondRuler(list, cx, sB, foot, m) {
    var to = Math.max(1, sB.length) + RO_TOP_MARGIN;
    roSegment(list, roAlong(cx, sB, foot), roAlong(cx, sB, to), sB.colour, 0.55 * m, cx.dpr, "ruler2");
    for (var k = 1; k <= 9; k++) {
      var s = k * RO_TICK_STEP;
      var p = roAlong(cx, sB, s);
      if (p.y < -20 * cx.dpr || p.y > cx.H + 20 * cx.dpr) continue;
      list.marks.push({ x: p.x, y: p.y, r: 1.8 * cx.dpr, colour: sB.colour, alpha: 0.8 * m, kind: "dot" });
      roText(list, p.x + 8 * cx.dpr, p.y + 8 * cx.dpr, s.toFixed(1), "left", sB.colour, 0.6 * m, "tick", { height: s });
    }
  }

  function roRanks(ranks, many) {
    if (!Array.isArray(ranks) || !ranks.length) return "";
    return ranks
      .map(function (r) {
        return (many ? r.letter : "") + r.rank + ".";
      })
      .join(" ");
  }

  // [{ranks} ]{text}  {heights}[  cosine {c}]
  function roResultText(cx, it, i, pinnedSearches, unit, many) {
    var len = roRowLength(cx, i);
    var heights = pinnedSearches.map(function (s) {
      return roHeight(cx, i, s.u);
    });
    var str = roShorten(it.text === undefined || it.text === null ? "" : it.text, RO_TEXT_MAX) + "  " + heights.map(function (h) {
      return h.toFixed(2);
    }).join(" · ");
    if (!unit) {
      str += "  cosine " + heights.map(function (h) {
        return (len > 0 ? h / len : 0).toFixed(2);
      }).join(" · ");
    }
    var ranks = roRanks(it.ranks, many);
    return (ranks ? ranks + " " : "") + str;
  }

  function roStems(list, cx, input, rel, s0, searches, m) {
    var pinned = [];
    for (var pin of rel.pinned) {
      var found = searches.find(function (s) {
        return s.letter === pin.letter;
      });
      if (found) pinned.push(found);
    }
    var unit = !!rel.unit?.unit;
    var many = searches.length > 1;
    var seen = new Set();
    var N = cx.X.length / cx.D;
    for (var it of input.named || []) {
      var i = it?.index;
      if (!Number.isInteger(i) || i < 0 || i >= N || seen.has(i)) continue;
      seen.add(i);
      if (roIsOwnPoint(cx, i, searches)) continue;
      var h = roHeight(cx, i, s0.u);
      var p = roVectorAt(cx, cx.X, i * cx.D);
      var r = roAlong(cx, s0, h);
      roSegment(list, p, r, s0.colour, 0.42 * m, cx.dpr, "stem");
      list.results.push({ index: i, x: p.x, y: p.y, rulerX: r.x, rulerY: r.y, height: h });
      if (input.labels) {
        var right = p.x > cx.W * 0.78;
        roText(list, p.x + (right ? -9 : 9) * cx.dpr, p.y, roResultText(cx, it, i, pinned, unit, many), right ? "right" : "left", cx.ink, 0.95, "result", { height: h, index: i });
      }
    }
  }

  function roRelative(list, cx, input, rel, searches, s0) {
    var m = Math.min(1, Math.max(0, roFinite(rel.mix) ? rel.mix : 1));
    var w = roWindow(cx, rel, s0);
    var showOrigin = !!input.showOrigin;
    var foot = showOrigin ? 0 : Math.max(0, w.bottom - RO_FOOT_MARGIN);
    var top = w.top;
    if (rel.settled) {
      roRuler(list, cx, s0, foot, top, 0.55 * m);
      roTicks(list, cx, s0, foot, top, m);
      var tp = roAlong(cx, s0, top);
      roText(list, tp.x - 9 * cx.dpr, tp.y, rel.measure + " to " + s0.letter, "right", s0.colour, 0.8 * m, "title");
      if (input.cut && roFinite(input.cut.height)) {
        // the reranker saw only the candidates: everything above this mark
        var cp = roAlong(cx, s0, input.cut.height);
        roSegment(list, { x: cp.x - 150 * cx.dpr, y: cp.y }, { x: cp.x + 150 * cx.dpr, y: cp.y }, cx.ink, 0.9 * m, cx.dpr, "cut", [4 * cx.dpr, 4 * cx.dpr]);
        roText(list, cp.x + 156 * cx.dpr, cp.y, input.cut.sent + " candidates above this line went to the reranker", "left", cx.ink, 0.85 * m, "cut");
      }
      // the origin is marked whenever height 0 is inside the window shown (spec c31); Show the
      // origin widens the window to include it and, on a unit-length set, adds the unit circle
      if (showOrigin || (w.bottom <= 0 && w.top >= 0)) {
        var op = roAlong(cx, s0, 0);
        roOriginMark(list, cx, op, m);
        roText(list, op.x + 12 * cx.dpr, op.y, "origin (0, 0, … , 0)", "left", cx.ink, m, "origin");
        if (showOrigin && rel.unit?.unit === true) roUnitCircle(list, cx, m);
      }
      if (rel.pinned.length >= 2) {
        var sB = searches.find(function (s) {
          return s.letter === rel.pinned[1].letter;
        });
        if (sB) roSecondRuler(list, cx, sB, foot, m);
      }
      roStems(list, cx, input, rel, s0, searches, m);
    } else {
      // turning: ruler A's line only, faint; it is not drawn as exact
      roRuler(list, cx, s0, foot, top, 0.25 * m);
    }
    // the searches themselves, each at its raw query
    for (var s of searches) {
      var qp = roVectorAt(cx, s.query, 0);
      list.marks.push({ x: qp.x, y: qp.y, r: 10 * cx.dpr, colour: s.colour, alpha: 1, kind: "search" });
    }
  }

  function roUsable(input) {
    if (!input || !(input.width > 0) || !(input.height > 0)) return false;
    var D = input.dimension;
    if (!Number.isInteger(D) || D < 1) return false;
    if (!input.frame || input.frame.length < 3 * D || !input.centre || input.centre.length < D) return false;
    return !!input.vectors && input.vectors.length % D === 0;
  }

  // The draw list for one frame (docs/relative-interface.md, "ET.relativeOverlay.build").
  function roBuild(input) {
    var dpr = Number(input?.dpr) > 0 ? Number(input.dpr) : 1;
    var list = roEmpty(dpr, typeof input?.paper === "string" ? input.paper : RO_PAPER);
    if (!roUsable(input)) return list;
    var cx = roContext(input);
    var rel = input.relative;
    if (rel?.active && Array.isArray(rel.pinned) && rel.pinned.length) {
      var searches = (input.searches || [])
        .filter(function (s) {
          return s?.query && s.query.length === cx.D;
        })
        .map(function (s) {
          return roSearch(cx, s);
        });
      var s0 = searches.find(function (s) {
        return s.letter === rel.pinned[0].letter;
      });
      if (s0 && s0.length > ET.math.RELATIVE_ZERO_LENGTH) {
        roRelative(list, cx, input, rel, searches, s0);
        return list;
      }
    }
    if (input.showOrigin) roPlain(list, cx);
    return list;
  }

  // ----- painting the shapes; the texts are spans (placeLabels) -----

  function roDash(ctx, dash) {
    if (typeof ctx.setLineDash === "function") ctx.setLineDash(dash || []);
  }

  function roPaintMark(ctx, mk, dpr) {
    ctx.globalAlpha = mk.alpha;
    ctx.beginPath();
    if (mk.kind === "dot") {
      ctx.fillStyle = mk.colour;
      ctx.arc(mk.x, mk.y, mk.r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = mk.colour;
    ctx.lineWidth = 1.5 * dpr;
    if (mk.kind === "origin") {
      ctx.moveTo(mk.x - mk.r, mk.y);
      ctx.lineTo(mk.x + mk.r, mk.y);
      ctx.moveTo(mk.x, mk.y - mk.r);
      ctx.lineTo(mk.x, mk.y + mk.r);
    } else {
      ctx.arc(mk.x, mk.y, mk.r, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  function roPaint(ctx, list) {
    if (!ctx || !list) return false;
    var segs = list.segments || [];
    var rings = list.rings || [];
    var marks = list.marks || [];
    if (!segs.length && !rings.length && !marks.length) return false;
    var dpr = Number(list.dpr) > 0 ? Number(list.dpr) : 1;
    if (typeof ctx.save === "function") ctx.save();
    ctx.lineJoin = "round";
    for (var r of rings) {
      ctx.globalAlpha = r.alpha;
      ctx.strokeStyle = r.colour;
      ctx.lineWidth = dpr;
      roDash(ctx, r.dash);
      ctx.beginPath();
      for (var j = 0; j + 1 < r.points.length; j += 2) {
        if (j === 0) ctx.moveTo(r.points[0], r.points[1]);
        else ctx.lineTo(r.points[j], r.points[j + 1]);
      }
      ctx.stroke();
    }
    for (var s of segs) {
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.colour;
      ctx.lineWidth = s.width;
      roDash(ctx, s.dash);
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
    }
    roDash(ctx, null);
    for (var mk of marks) roPaintMark(ctx, mk, dpr);
    ctx.globalAlpha = 1;
    if (typeof ctx.restore === "function") ctx.restore();
    return true;
  }

  // ----- the texts as spans over the stage -----

  function roOutline(bg) {
    var ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
    return ring
      .map(function (d) {
        return (d[0] * 1.5).toFixed(2) + "px " + (d[1] * 1.5).toFixed(2) + "px 0.5px " + bg;
      })
      .join(", ");
  }

  // A label is placed only where it overlaps none already placed.
  function roFits(boxes, x, y, text, align) {
    var w = text.length * RO_CHAR_W + 4;
    var left = x;
    if (align === "right") left = x - w;
    else if (align === "center") left = x - w / 2;
    var box = { l: left, r: left + w, t: y - RO_LABEL_H / 2, b: y + RO_LABEL_H / 2 };
    for (var o of boxes) {
      if (box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t) return false;
    }
    boxes.push(box);
    return true;
  }

  // Ticks and titles (and the cut-off and origin texts) first, in list order; then results,
  // nearest the top of the ruler first.
  function roOrder(texts) {
    var first = [];
    var results = [];
    texts.forEach(function (t, k) {
      if (RO_FIRST_KINDS.indexOf(t.kind) >= 0) first.push({ t: t, k: k });
      else results.push({ t: t, k: k });
    });
    first.sort(function (a, b) {
      return RO_FIRST_KINDS.indexOf(a.t.kind) - RO_FIRST_KINDS.indexOf(b.t.kind) || a.k - b.k;
    });
    results.sort(function (a, b) {
      var ha = roFinite(a.t.height) ? a.t.height : -Infinity;
      var hb = roFinite(b.t.height) ? b.t.height : -Infinity;
      return hb - ha || a.k - b.k;
    });
    return first.concat(results).map(function (e) {
      return e.t;
    });
  }

  function roSpanFor(layer, doc, pool, used) {
    var rec = pool.spans[used];
    if (rec) return rec;
    var el = doc.createElement("span");
    el.className = "tumbler-relative-label";
    var st = el.style;
    st.position = "absolute";
    st.left = "0";
    st.top = "0";
    st.whiteSpace = "nowrap";
    st.pointerEvents = "none";
    st.fontSize = "11px";
    st.fontFamily = "var(--tumbler-font-data, monospace)";
    layer.appendChild(el);
    rec = { el: el, text: null, colour: null, outline: null, shown: true };
    pool.spans.push(rec);
    return rec;
  }

  function roPlaceLabels(layer, list, doc) {
    if (!layer) return 0;
    var d = doc || layer.ownerDocument;
    var pool = RO_SPANS ? RO_SPANS.get(layer) : layer._roPool;
    if (!pool) {
      pool = { spans: [] };
      if (RO_SPANS) RO_SPANS.set(layer, pool);
      else layer._roPool = pool;
    }
    var used = 0;
    if (list && d) {
      var dpr = Number(list.dpr) > 0 ? Number(list.dpr) : 1;
      var outline = roOutline(typeof list.paper === "string" ? list.paper : RO_PAPER);
      var boxes = [];
      for (var t of roOrder(list.texts || [])) {
        if (used >= RO_LABEL_POOL) break;
        var str = String(t.text);
        var x = t.x / dpr;
        var y = t.y / dpr;
        if (!roFinite(x) || !roFinite(y) || !roFits(boxes, x, y, str, t.align)) continue;
        var rec = roSpanFor(layer, d, pool, used);
        if (rec.text !== str) {
          rec.el.textContent = str; // untrusted text is text, never markup
          rec.text = str;
        }
        if (rec.colour !== t.colour) {
          rec.el.style.color = t.colour;
          rec.colour = t.colour;
        }
        if (rec.outline !== outline) {
          rec.el.style.textShadow = outline;
          rec.outline = outline;
        }
        var shift = t.align === "right" ? "-100%" : t.align === "center" ? "-50%" : "0";
        rec.el.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) translate(" + shift + ", -50%)";
        rec.el.style.opacity = String(Math.round(Math.min(1, Math.max(0, t.alpha)) * 100) / 100);
        if (!rec.shown) {
          rec.el.style.display = "";
          rec.shown = true;
        }
        used++;
      }
    }
    for (var k = used; k < pool.spans.length; k++) {
      if (pool.spans[k].shown) {
        pool.spans[k].el.style.display = "none";
        pool.spans[k].shown = false;
      }
    }
    return used;
  }

  ET.relativeOverlay = {
    build: roBuild,
    paint: roPaint,
    placeLabels: roPlaceLabels,
  };
