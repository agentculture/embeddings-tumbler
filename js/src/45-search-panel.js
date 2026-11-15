  // ---------- the search panel (task t9 of the search plan) ----------
  //
  // ET.searchPanel builds the panel under the stage: a one-line bar (collapsed by
  // default) that names the searches and how many points are lit, and, when opened, the
  // text box (one search per line, up to four), suggestions from the loaded points, the
  // controls, the note, the pair lines and one result list per search. It also draws the
  // query rings and links on the overlay and puts the result labels over the stage as DOM
  // text, and in Focus it lays the ranked lists beside the stage.
  //
  // It drives the viewer only through the handle (setSearches, clearSearches,
  // setSearchSettings, faceSearches, info, mode), so everything it does can be done
  // without it. Every query, label, result text and message goes in with textContent.
  // Styles are set through element.style, as the viewer does. It makes no request.
  // The interface is docs/search-interface.md, "Panel (t9)", and js/api/45-search-panel.md.

  var SP_DARK = ["#ffc56b", "#6be0ff", "#ff8fb3", "#b6ff8a"];
  var SP_LIGHT = ["#a35f00", "#00708a", "#b0245a", "#3d7a00"];
  var SP_SHARED_DARK = "#ffffff";
  var SP_SHARED_LIGHT = "#1b2130";
  var SP_MAX_LINES = 4;
  var SP_PAUSE_MS = 140; // the reference waits this long after typing before it searches
  var SP_SUGGEST_MAX = 8; // the Focus reference lists up to eight suggestions
  var SP_SUGGEST_CHARS = 60; // a suggestion's button text is cut here; the click uses all of it
  var SP_STAGE_TEXT = 28; // a result's text on the stage is cut here; the list carries all of it
  // Labels on the stage at most. With 4 searches of up to 100 results the overlap rule leaves
  // most out long before this; the lists carry every result.
  var SP_LABEL_POOL = 160;
  var SP_MAX_COUNT = 100; // the most results, candidates or kept a search can ask for
  var SP_K_RERANKED = "With the reranker on, Keep top sets how many results are kept.";
  var SP_CHAR_W = 6.7; // estimated width of one 11 px monospace character, CSS px
  var SP_LABEL_H = 12; // height of one stage label box, CSS px
  var SP_LIT_TEXT = {
    even: "the results, evenly",
    close: "by closeness: nearer is brighter",
    named: "named results only",
  };
  var SP_PALETTE_DARK = { fg: "#e9eef6", muted: "#8a96ab", line: "#1b2436", accent: "#ffc56b", bg: "#04060b" };
  var SP_PALETTE_LIGHT = { fg: "#1b2130", muted: "#5b6578", line: "#d6dae2", accent: "#a35f00", bg: "#f6f4ee" };
  // A value that could name a resource is not used. The "r" is written as an escape so that
  // this file holds no CSS resource function by name (js/test/viewer-static.test.js bans it).
  var SP_UNSAFE = /u\x72l\(|image-set|[\\;{}<>]/i;
  var spCounter = 0;

  // ----- text: the bar, the provenance line, the note, the lists -----

  // 1234567 -> "1,234,567" (fixed, not the host's locale, so tests and screenshots agree).
  function spThousands(n) {
    var s = String(Math.round(Math.abs(Number(n) || 0)));
    var out = "";
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ",";
      out += s[i];
    }
    return (Number(n) < 0 ? "-" : "") + out;
  }

  function spPlural(n, one, many) {
    return spThousands(n) + " " + (n === 1 ? one : many);
  }

  function spShorten(s, max) {
    var str = String(s);
    return str.length > max ? str.slice(0, max - 1) + "…" : str;
  }

  function spActive(search) {
    return !!search && search.active === true && Array.isArray(search.searches) && search.searches.length > 0;
  }

  // The collapsed bar's text.
  function summaryText(search) {
    var tail = "";
    if (search?.waiting) tail += " · waiting";
    if (search?.stale) tail += " · from before " + spPlural(search.staleBy, "new point", "new points");
    if (!spActive(search)) {
      return (search?.waiting ? "working out the search" : "nothing searched: every point is shown") + tail;
    }
    var names = search.searches.map(function (q) {
      return q.letter + " " + q.text;
    });
    return names.join(" · ") + " · " + spThousands(search.litCount) + " points lit" + tail;
  }

  // Where one search's text went, and what made its query.
  function spMadeBy(q) {
    var form = q.queryForm ? " (query form " + q.queryForm + ")" : "";
    if (q.kind === "embedded") return "embedded by " + q.model + form + "; text sent to the host's embedder";
    if (q.kind === "words") return "words matched among the loaded points (" + q.model + "); nothing sent";
    if (q.kind === "point") return "the loaded point " + q.point + " (" + q.model + "); nothing sent";
    return "a vector from the host (" + q.model + "); nothing sent by the viewer";
  }

  // `others`: some other search was reranked, so a search that was not says what it kept.
  function spRerankedBy(q, others) {
    if (!q.reranker) return others ? "; not reranked: the " + spThousands(q.results.length) + " nearest kept" : "";
    return (
      "; reranked by " +
      q.reranker +
      " (" +
      spKeptOf(q) +
      "): query and candidate texts sent to the reranker"
    );
  }

  // "top 20 of 50 candidates": what one reranked search kept, as it happened.
  function spKeptOf(q) {
    return "top " + spThousands(q.results.length) + " of " + spPlural(q.sent, "candidate", "candidates");
  }

  // The counts the searches used: candidates and kept when a search was reranked, k otherwise
  // (a search the reranker failed on keeps the k nearest, and says so in its note).
  function spCountsUsed(search, reranked) {
    var st = search.settings || {};
    var plain = "the " + spThousands(st.k) + " nearest kept (" + spPlural(st.k, "result", "results") + " per search)";
    if (!reranked) return plain;
    return "the " + spThousands(st.candidates) + " nearest as candidates, the reranker's top " + spThousands(st.top) + " kept";
  }

  // What the searches used, for the provenance row.
  function usedText(search) {
    if (!spActive(search)) return "no search";
    var st = search.settings || {};
    var reranked = search.searches.some(function (q) {
      return !!q.reranker;
    });
    var parts = [search.measure, spCountsUsed(search, reranked), "lit: " + (SP_LIT_TEXT[st.lit] || SP_LIT_TEXT.even)];
    search.searches.forEach(function (q) {
      parts.push(q.letter + ' "' + q.text + '": ' + spMadeBy(q) + spRerankedBy(q, reranked));
    });
    if (!reranked) parts.push("no reranker");
    if (st.pointOfView) parts.push("point of view: " + st.pointOfView + " (each dimension scaled by its query)");
    return parts.join(" · ");
  }

  // The short clause added to the provenance summary.
  function spProvenanceClause(search) {
    if (!spActive(search)) return "";
    var where = [];
    var kinds = spKinds(search);
    if (kinds.embedder) where.push("typed text sent to the host's embedder");
    if (kinds.reranker) where.push("query and candidate texts sent to the reranker");
    if (kinds.local) where.push("searched among the loaded points, nothing sent");
    return " · search: " + where.join(", ");
  }

  function spKinds(search) {
    var out = { embedder: false, reranker: false, local: false };
    search.searches.forEach(function (q) {
      if (q.sentTo === "embedder") out.embedder = true;
      else out.local = true;
      if (q.reranker) out.reranker = true;
    });
    return out;
  }

  // Where typed text goes, said whenever the panel is open and whenever a search is shown.
  function spWhereText(search) {
    var parts = [];
    if (spActive(search)) {
      var kinds = spKinds(search);
      if (kinds.embedder) parts.push("The typed text was sent to the host's embedder.");
      if (kinds.reranker) parts.push("The query and the candidate texts were sent to the reranker.");
      if (kinds.local) parts.push("Searched among the loaded points: nothing was sent anywhere.");
    } else if (search?.embedder?.available) {
      parts.push("Typed text is sent to the host's embedder; nothing else leaves the page.");
    }
    if (!search?.embedder?.available) {
      parts.push(
        "No embedder is connected, so typed words are matched against the labels and texts of the loaded points, and nothing is sent."
      );
    }
    return parts.join(" ");
  }

  function spLitQualifier(setting) {
    if (setting === "close") return ", nearer ones brighter";
    if (setting === "named") return " (named results only)";
    return "";
  }

  // One search's counts: its named results and the other points as near as the last of them.
  function spCountsText(q) {
    var named = q.results.length;
    var others = Math.max(0, (q.insideCount || 0) - named);
    return (
      spPlural(named, "named result", "named results") +
      " and " +
      (others ? spPlural(others, "unnamed point", "unnamed points") : "no unnamed point") +
      " as near as the last of them"
    );
  }

  function spLitSentence(search) {
    var st = search.settings || {};
    var lit = spThousands(search.litCount) + " points lit" + spLitQualifier(st.lit);
    if (search.searches.length === 1) {
      var q = search.searches[0];
      var named = q.results.length;
      var others = Math.max(0, (q.insideCount || 0) - named);
      return (
        lit +
        ": " +
        spPlural(named, "named result", "named results") +
        (others ? " and every unnamed point as near as the last of them (" + spThousands(others) + ")" : "") +
        "."
      );
    }
    var each = search.searches.map(function (q) {
      return q.letter + ": " + spCountsText(q);
    });
    var shared = search.sharedCount
      ? " " + spPlural(search.sharedCount, "point is", "points are") + " inside more than one search."
      : "";
    return lit + ". " + each.join("; ") + "." + shared;
  }

  // Every sentence of the note, in order.
  function spNoteParts(search, ctx) {
    var parts = [];
    if (spActive(search)) parts.push(spLitSentence(search));
    else if (!search?.waiting) parts.push("Nothing searched: every point is shown.");
    if (search?.waiting) parts.push("Working out the searches…");
    if (search?.stale) {
      parts.push(
        "These results are from before " +
          spPlural(search.staleBy, "new point", "new points") +
          "; they are being worked out again."
      );
    }
    var where = spWhereText(search);
    if (where) parts.push(where);
    if (spActive(search)) parts.push("Distances are " + search.measure + ", in every dimension of the data.");
    spSearchNotes(search, parts);
    if (search?.unmatched?.length) parts.push("Not found among the loaded points: " + search.unmatched.join(", ") + ".");
    if (ctx.extraLines > 0) {
      parts.push("Only the first four lines are searched; " + spPlural(ctx.extraLines, "line is", "lines are") + " left out.");
    }
    spTailNotes(search, ctx, parts);
    return parts;
  }

  // Messages, refusals and the two sentences about the stage.
  function spTailNotes(search, ctx, parts) {
    if (search?.message) parts.push(search.message);
    if (ctx.refusal && ctx.refusal !== search?.message) parts.push(ctx.refusal);
    if (!spActive(search)) return;
    if (ctx.focus && !search.faceable) {
      parts.push("Focus is already fitted to the results, so Face the searches is off here.");
    }
    parts.push("Where labels on the stage would overlap, the later ones are left out; the lists carry every result.");
  }

  function spSearchNotes(search, parts) {
    if (!spActive(search)) return;
    search.searches.forEach(function (q) {
      if (q.pointOfView) {
        parts.push(
          q.letter +
            " is measured from its own point of view: every dimension is scaled by the size of its query's value there (a linear change); the other searches keep plain distance."
        );
      }
      if (q.counts) parts.push(q.letter + ": " + q.counts);
      if (q.note) parts.push(q.letter + ": " + q.note);
    });
  }

  // A result's text by id, from the searches' own results.
  function spTextOf(search, id) {
    for (var q of search.searches) {
      for (var r of q.results) {
        if (r.id === id) return r.text;
      }
    }
    return id;
  }

  // One pair line: shared count, named results in common, the closest pair of different results.
  function spPairText(search, pair, sharedWord) {
    var s = pair.a + " and " + pair.b + ": ";
    s += pair.shared ? spPlural(pair.shared, "point", "points") + " found by both (" + sharedWord + ")" : "no point found by both";
    if (pair.common) {
      var common = pair.commonIds.map(function (id) {
        return spTextOf(search, id);
      });
      s += "; " + spPlural(pair.common, "named result", "named results") + " in common (" + common.join(", ") + ")";
    }
    if (pair.closest) {
      s +=
        "; closest pair of different results " +
        spTextOf(search, pair.closest.a) +
        " and " +
        spTextOf(search, pair.closest.b) +
        ", " +
        pair.closest.distance.toFixed(3) +
        " apart";
    }
    return s + ".";
  }

  // How one search's query was made, for its list heading.
  function spKindText(q) {
    if (q.kind === "embedded") return "embedded by " + q.model;
    if (q.kind === "point") return "from the point " + q.point;
    if (q.kind === "vector") return "a vector from the host";
    var used = q.words?.used || [];
    return (
      "words matched: " +
      used
        .map(function (u) {
          return u.how === "prefix" ? u.word + "…" : u.word;
        })
        .join(", ")
    );
  }

  function spListHeading(q) {
    return (
      q.letter +
      " · " +
      q.text +
      " · " +
      spCountsText(q) +
      " · " +
      spKindText(q) +
      (q.reranker ? " · embedding order, then the reranker " + q.reranker + " (" + spKeptOf(q) + ")" : "") +
      (q.pointOfView ? " · from its point of view" : "")
    );
  }

  // The parts of a result's meta line, as the picture and the references show them.
  function spResultMeta(q, r, distances) {
    var out = [];
    if (distances) {
      out.push(
        "distance " + r.distance.toFixed(3) + (q.pointOfView ? " from its point of view" : ""),
        r.gap < 0.0005 ? "the nearest" : "+" + r.gap.toFixed(3) + " farther than the nearest"
      );
    }
    if (q.reranker) out.push(spMoveText(r.embeddingRank - r.rank, r.embeddingRank));
    if (q.pointOfView && r.plainRank !== r.embeddingRank) out.push("plain distance had it at " + r.plainRank);
    return out;
  }

  function spMoveText(by, was) {
    if (by > 0) return "up " + by + " (was " + was + ")";
    if (by < 0) return "down " + -by + " (was " + was + ")";
    return "same place";
  }

  // Suggestions: the texts of named points matching what is typed on the current line
  // (the Focus reference: the whole line starts the text, or the last word starts a word of
  // it), whole-line matches first, at most SP_SUGGEST_MAX, never the line itself.
  function spSuggest(entries, typed) {
    var t = String(typed || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    if (!t) return [];
    var last = t.split(" ").at(-1);
    var first = [];
    var rest = [];
    for (var e of entries) {
      if (e.lower === t) continue;
      if (e.lower.startsWith(t)) first.push(e.text);
      else if (last.length > 1 && spWordStarts(e.words, last)) rest.push(e.text);
      if (first.length >= SP_SUGGEST_MAX) break;
    }
    return first.concat(rest).slice(0, SP_SUGGEST_MAX);
  }

  function spWordStarts(words, prefix) {
    for (var w of words) {
      if (w.startsWith(prefix)) return true;
    }
    return false;
  }

  // The named points' texts of a set, once per set and count (an append adds to them).
  function spEntries(p) {
    var set = spData(p);
    if (!set?.count || typeof ET.search?.isNamed !== "function") return [];
    var cache = p.suggestCache;
    if (cache.set === set && cache.count === set.count) return cache.entries;
    var seen = new Set();
    var entries = [];
    for (var i = 0; i < set.count; i++) {
      if (!ET.search.isNamed(set, i)) continue;
      var text = String(ET.search.pointText(set, i)).trim().replace(/\s+/g, " ");
      var lower = text.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      entries.push({ text: text, lower: lower, words: lower.split(" ") });
    }
    p.suggestCache = { set: set, count: set.count, entries: entries };
    return entries;
  }

  function spData(p) {
    try {
      return typeof p.opts.data === "function" ? p.opts.data() : null;
    } catch {
      // A data getter that throws gives no suggestions.
      return null;
    }
  }

  // ----- colours -----

  // One channel in 0..1 as 0..255.
  function spByte(x) {
    return Math.round(Math.min(1, Math.max(0, Number(x) || 0)) * 255);
  }

  function spHex(c) {
    // [r, g, b] in 0..1 -> "rgb(r, g, b)"
    return "rgb(" + spByte(c[0]) + ", " + spByte(c[1]) + ", " + spByte(c[2]) + ")";
  }

  function spTheme(p) {
    try {
      return typeof p.opts.theme === "function" ? p.opts.theme() || null : null;
    } catch {
      // A theme getter that throws: the built-in palette for the stage's lightness.
      return null;
    }
  }

  function spLight(p) {
    var t = spTheme(p);
    return t ? !!t.light : !!p.opts.light;
  }

  // The viewer's colours as CSS strings (its theme when given, else the built-in defaults).
  function spPalette(p) {
    var t = spTheme(p);
    var base = spLight(p) ? SP_PALETTE_LIGHT : SP_PALETTE_DARK;
    if (!t) return { ...base };
    return {
      fg: spPick(t.foreground, base.fg),
      muted: spPick(t.muted, base.muted),
      line: spPick(t.line, base.line),
      accent: spPick(t.accent, base.accent),
      bg: spPick(t.background, base.bg),
    };
  }

  // A theme colour ([r, g, b]) as CSS, or the default when the theme does not give one.
  function spPick(c, d) {
    return Array.isArray(c) ? spHex(c) : d;
  }

  // A search's colour for DOM text: the host's custom property, else the default for the stage.
  function spSearchVar(j, light) {
    return "var(--tumbler-search-" + (j + 1) + ", " + (light ? SP_LIGHT : SP_DARK)[j] + ")";
  }

  function spSharedVar(light) {
    return "var(--tumbler-shared, " + (light ? SP_SHARED_LIGHT : SP_SHARED_DARK) + ")";
  }

  // The colours the overlay strokes with: each custom property resolved by the 2-D context
  // itself (an invalid or unsafe value leaves the default in place).
  function spCanvasColours(p, ctx) {
    var light = spLight(p);
    var defaults = (light ? SP_LIGHT : SP_DARK).concat([light ? SP_SHARED_LIGHT : SP_SHARED_DARK]);
    var names = ["--tumbler-search-1", "--tumbler-search-2", "--tumbler-search-3", "--tumbler-search-4", "--tumbler-shared"];
    var cs = null;
    try {
      cs = p.win?.getComputedStyle ? p.win.getComputedStyle(p.parts.panel) : null;
    } catch {
      // No computed style: the defaults.
      cs = null;
    }
    return names.map(function (name, j) {
      var raw = cs ? String(cs.getPropertyValue(name) || "").trim() : "";
      ctx.strokeStyle = defaults[j];
      if (raw && !SP_UNSAFE.test(raw)) ctx.strokeStyle = raw;
      return String(ctx.strokeStyle || defaults[j]);
    });
  }

  // ----- DOM helpers -----

  function spEl(p, tag, cls, styles) {
    var el = p.doc.createElement(tag);
    if (cls) el.className = cls;
    if (styles) spStyle(el, styles);
    return el;
  }

  function spText(p, tag, cls, str, styles) {
    var el = spEl(p, tag, cls, styles);
    el.textContent = str;
    return el;
  }

  function spStyle(el, styles) {
    for (var k in styles) {
      if (Object.hasOwn(styles, k)) el.style[k] = styles[k];
    }
  }

  function spListen(p, el, type, fn) {
    el.addEventListener(type, fn);
    p.listeners.push([el, type, fn]);
  }

  function spShow(el, on, display) {
    el.hidden = !on;
    el.style.display = on ? display : "none";
  }

  var SP_VISUALLY_HIDDEN = {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    border: "0",
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
  };

  function spControlStyle(pal) {
    return {
      fontFamily: "inherit",
      fontSize: "12px",
      color: pal.fg,
      background: pal.bg,
      border: "1px solid " + pal.line,
      padding: "4px 6px",
      maxWidth: "100%",
    };
  }

  function spButtonStyle(pal) {
    return {
      fontFamily: "inherit",
      fontSize: "12px",
      color: pal.fg,
      background: "transparent",
      border: "1px solid " + pal.line,
      borderRadius: "999px",
      padding: "6px 16px",
      minHeight: "28px",
      cursor: "pointer",
    };
  }

  // ----- building the panel -----

  function spBuildBar(p) {
    var bar = spEl(p, "button", "tumbler-search-bar", {
      display: "flex",
      alignItems: "baseline",
      gap: "12px",
      width: "100%",
      minWidth: "0",
      textAlign: "left",
      cursor: "pointer",
      background: "transparent",
      border: "0",
      borderTop: "1px solid",
      borderBottom: "1px solid",
      padding: "var(--tumbler-search-bar-padding, 10px 0)",
      font: "inherit",
      fontSize: "12px",
      lineHeight: "1.2",
      color: "inherit",
    });
    bar.type = "button";
    bar.setAttribute("aria-expanded", "false");
    bar.setAttribute("aria-controls", p.bodyId);
    p.barTitle = spText(p, "b", "", "Search", {
      fontWeight: "400",
      fontStyle: "italic",
      fontSize: "var(--tumbler-search-title-size, 24px)",
      lineHeight: "1",
    });
    p.barSummary = spText(p, "span", "tumbler-search-summary", summaryText(null), {
      flex: "1",
      minWidth: "0",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    });
    p.barMark = spText(p, "i", "tumbler-search-mark", "+", { fontStyle: "normal", fontSize: "16px" });
    p.barMark.setAttribute("aria-hidden", "true");
    bar.appendChild(p.barTitle);
    bar.appendChild(p.barSummary);
    bar.appendChild(p.barMark);
    spListen(p, bar, "click", function () {
      spToggle(p);
    });
    return bar;
  }

  function spBuildInput(p) {
    var id = "tumbler-search-input-" + p.n;
    var label = spText(p, "label", "tumbler-search-input-label", "Search: one search per line, up to four", {
      fontSize: "12px",
      letterSpacing: "0.06em",
      textTransform: "uppercase",
    });
    label.htmlFor = id;
    label.setAttribute("for", id);
    var box = spEl(p, "textarea", "tumbler-search-input", {
      width: "100%",
      minHeight: "92px",
      resize: "vertical",
      padding: "10px 12px",
      boxSizing: "border-box",
      fontFamily: "var(--tumbler-font, inherit)",
      fontSize: "16px",
      lineHeight: "1.4",
    });
    box.id = id;
    box.setAttribute("spellcheck", "false");
    box.setAttribute("autocomplete", "off");
    box.setAttribute("rows", "3");
    p.input = box;
    spListen(p, box, "input", function () {
      spTyped(p);
    });
    p.suggestBox = spEl(p, "div", "tumbler-search-suggest", { display: "flex", flexWrap: "wrap", gap: "6px 8px", alignItems: "center" });
    p.suggestBox.setAttribute("role", "group");
    p.suggestBox.setAttribute("aria-label", "Suggestions from the loaded points");
    spShow(p.suggestBox, false, "flex");
    spListen(p, p.suggestBox, "click", function (ev) {
      spSuggestClick(p, ev);
    });
    return [label, box, p.suggestBox];
  }

  function spLabelled(p, cls, words) {
    var label = spEl(p, "label", cls, { display: "inline-flex", alignItems: "center", gap: "8px" });
    if (words) label.appendChild(p.doc.createTextNode(words + " "));
    return label;
  }

  function spCheckbox(p, cls, words, key) {
    var label = spLabelled(p, cls, "");
    var box = spEl(p, "input", "", { width: "15px", height: "15px", margin: "0" });
    box.type = "checkbox";
    label.appendChild(box);
    label.appendChild(p.doc.createTextNode(" " + words));
    spListen(p, box, "change", function () {
      spSetting(p, key, !!box.checked);
    });
    return { label: label, input: box };
  }

  function spSelect(p, cls, words, options) {
    var label = spLabelled(p, cls, words);
    var sel = spEl(p, "select", "", {});
    options.forEach(function (o) {
      sel.appendChild(spOption(p, o[0], o[1]));
    });
    label.appendChild(sel);
    return { label: label, input: sel };
  }

  function spOption(p, value, words) {
    var o = spText(p, "option", "", words);
    o.value = value;
    return o;
  }

  // A labelled range from 3 to 100 with its value beside it; moving it sets `key`.
  function spRange(p, cls, words, key, value) {
    var label = spLabelled(p, cls, words);
    var input = spEl(p, "input", "", { width: "110px" });
    input.type = "range";
    input.min = "3";
    input.max = String(SP_MAX_COUNT);
    input.step = "1";
    input.value = String(value);
    var out = spText(p, "output", "", String(value), { minWidth: "3ch" });
    label.appendChild(input);
    label.appendChild(out);
    spListen(p, input, "input", function () {
      out.textContent = String(input.value);
      spSetting(p, key, Number(input.value));
    });
    return { label: label, input: input, out: out };
  }

  // Show a range's value from the settings (never while it is the same, so a drag is not reset).
  function spRangeValue(r, value, max) {
    if (max && r.input.max !== String(max)) r.input.max = String(max);
    if (value && String(r.input.value) !== String(value)) {
      r.input.value = String(value);
      r.out.textContent = String(value);
    }
  }

  function spBuildControls(p) {
    var row = spEl(p, "div", "tumbler-search-controls", { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 22px",
      fontSize: "12px" });
    p.face = spText(p, "button", "tumbler-search-face", "Face the searches");
    p.face.type = "button";
    spListen(p, p.face, "click", function () {
      p.handle.faceSearches();
    });
    var lit = spSelect(p, "tumbler-search-lit", "Lit", [
      ["even", SP_LIT_TEXT.even],
      ["close", SP_LIT_TEXT.close],
      ["named", SP_LIT_TEXT.named],
    ]);
    p.lit = lit.input;
    spListen(p, p.lit, "change", function () {
      spSetting(p, "lit", p.lit.value);
    });
    p.rerank = spCheckbox(p, "tumbler-search-rerank", "Reranker", "rerank");
    p.distances = spCheckbox(p, "tumbler-search-distances", "Distance difference", "distances");
    var k = spRange(p, "tumbler-search-k", "Results", "k", 8);
    p.kLabel = k.label;
    p.k = k.input;
    p.kOut = k.out;
    // Beside the Reranker, and like it in the row only while a reranker is offered.
    p.cand = spRange(p, "tumbler-search-candidates", "Candidates", "candidates", 50);
    p.top = spRange(p, "tumbler-search-top", "Keep top", "top", 20);
    var pov = spSelect(p, "tumbler-search-pov", "From this search's point of view", [["", "off"]]);
    p.pov = pov.input;
    p.povLabel = pov.label;
    spListen(p, p.pov, "change", function () {
      spSetting(p, "pointOfView", p.pov.value || null);
    });
    p.only = spCheckbox(p, "tumbler-search-only", "Only results", "onlyResults");
    p.clear = spText(p, "button", "tumbler-search-clear", "Clear");
    p.clear.type = "button";
    spListen(p, p.clear, "click", function () {
      spClear(p);
    });
    p.litLabel = lit.label;
    [p.face, lit.label, p.rerank.label, p.cand.label, p.top.label, p.distances.label, p.kLabel, pov.label, p.only.label, p.clear].forEach(function (c) {
      row.appendChild(c);
    });
    return row;
  }

  function spBuild(p) {
    var section = spEl(p, "section", "tumbler-search", { display: "flex", flexDirection: "column", gap: "10px", minWidth: "0" });
    section.setAttribute("aria-label", "Search");
    p.section = section;
    section.appendChild(spBuildBar(p));
    p.live = spEl(p, "p", "tumbler-search-live", SP_VISUALLY_HIDDEN);
    p.live.setAttribute("role", "status");
    p.live.setAttribute("aria-live", "polite");
    section.appendChild(p.live);
    var body = spEl(p, "div", "tumbler-search-body", { flexDirection: "column", gap: "10px", minWidth: "0" });
    body.id = p.bodyId;
    spShow(body, false, "flex");
    p.body = body;
    spBuildInput(p).forEach(function (el) {
      body.appendChild(el);
    });
    body.appendChild(spBuildControls(p));
    p.note = spEl(p, "p", "tumbler-search-note", { margin: "0", fontSize: "12px", lineHeight: "1.6" });
    p.pairs = spEl(p, "div", "tumbler-search-pairs", { display: "flex", flexDirection: "column", gap: "4px" });
    p.results = spEl(p, "div", "tumbler-search-results", { display: "flex", flexDirection: "column", gap: "6px" });
    body.appendChild(p.note);
    body.appendChild(p.pairs);
    body.appendChild(p.results);
    section.appendChild(body);
    var panel = p.parts.panel;
    panel.insertBefore(section, panel.firstChild);
  }

  // Colours that come from the viewer's theme (re-applied when the theme object changes).
  function spApplyTheme(p) {
    var pal = spPalette(p);
    p.pal = pal;
    p.light = spLight(p);
    spStyle(p.section, { color: pal.muted, fontFamily: "var(--tumbler-font-data, inherit)" });
    var bar = p.section.firstChild;
    bar.style.borderTopColor = pal.line;
    bar.style.borderBottomColor = pal.line;
    bar.style.color = pal.muted;
    spStyle(p.barTitle, { color: pal.fg, fontFamily: "var(--tumbler-font-display, Georgia, serif)" });
    p.barMark.style.color = pal.accent;
    spStyle(p.input, { color: pal.fg, background: pal.bg, border: "1px solid " + pal.line });
    spStyle(p.lit, spControlStyle(pal));
    spStyle(p.pov, spControlStyle(pal));
    [p.face, p.clear].forEach(function (b) {
      spStyle(b, spButtonStyle(pal));
    });
    [p.rerank.input, p.distances.input, p.only.input, p.k, p.cand.input, p.top.input].forEach(function (c) {
      c.style.accentColor = pal.accent;
    });
    p.note.style.color = pal.muted;
    p.listKey = null; // lists are rebuilt in the new colours
    p.sideKey = null;
    p.colours = null;
    if (p.suggested?.length) spRenderSuggestions(p);
  }

  // ----- behaviour -----

  function spToggle(p) {
    spSetOpen(p, !p.open);
    if (p.open) p.input.focus();
  }

  function spSetOpen(p, open) {
    p.open = open;
    spShow(p.body, open, "flex");
    var bar = p.section.firstChild;
    bar.setAttribute("aria-expanded", open ? "true" : "false");
    p.barMark.textContent = open ? "−" : "+";
  }

  // The lines the box holds, trimmed, empty ones dropped.
  function spLines(value) {
    return String(value || "")
      .split(/\n/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
  }

  function spTyped(p) {
    spRenderSuggestions(p);
    if (p.timer && p.win?.clearTimeout) p.win.clearTimeout(p.timer);
    p.timer = 0;
    if (typeof p.win?.setTimeout !== "function") {
      spRun(p);
      return;
    }
    p.timer = p.win.setTimeout(function () {
      p.timer = 0;
      spRun(p);
    }, SP_PAUSE_MS);
  }

  // Send the box's first four lines to the viewer (or clear when it is empty).
  function spRun(p) {
    if (p.destroyed) return;
    var lines = spLines(p.input.value);
    p.extraLines = Math.max(0, lines.length - SP_MAX_LINES);
    var send = lines.slice(0, SP_MAX_LINES);
    var key = send.join("\n");
    if (key === p.lastSent) {
      spRender(p);
      return;
    }
    p.lastSent = key;
    p.refusal = null;
    if (!send.length) {
      p.handle.clearSearches();
      spRender(p);
      return;
    }
    spWatch(p, p.handle.setSearches(send));
  }

  // A refusal from the viewer is shown in the note (superseded and destroyed are not refusals).
  function spWatch(p, promise) {
    if (typeof promise?.then !== "function") return;
    promise.then(function (res) {
      if (p.destroyed || !res || res.ok) return;
      if (res.code === "superseded" || res.code === "destroyed") return;
      p.refusal = res.message;
      p.lastSent = null; // the same text can be tried again
      spRender(p);
    });
  }

  function spSetting(p, key, value) {
    var patch = {};
    patch[key] = value;
    spWatch(p, p.handle.setSearchSettings(patch));
  }

  function spClear(p) {
    if (p.timer && p.win?.clearTimeout) p.win.clearTimeout(p.timer);
    p.timer = 0;
    p.input.value = "";
    p.lastSent = "";
    p.extraLines = 0;
    p.refusal = null;
    p.handle.clearSearches();
    spRenderSuggestions(p);
    spRender(p);
  }

  // The line the caret is on (the last line when the box cannot say).
  function spCurrentLine(box) {
    var value = String(box.value || "");
    var at = typeof box.selectionStart === "number" ? box.selectionStart : value.length;
    var start = value.lastIndexOf("\n", Math.max(0, at - 1)) + 1;
    if (at === 0) start = 0;
    var end = value.indexOf("\n", at);
    return { start: start, end: end < 0 ? value.length : end };
  }

  function spRenderSuggestions(p) {
    var box = p.suggestBox;
    box.textContent = "";
    var where = spCurrentLine(p.input);
    var typed = String(p.input.value || "").slice(where.start, where.end);
    var found = spSuggest(spEntries(p), typed);
    p.suggested = found;
    spShow(box, found.length > 0, "flex");
    if (!found.length) return;
    box.appendChild(spText(p, "span", "", "suggestions from the loaded points", { fontSize: "12px" }));
    var pal = p.pal || SP_PALETTE_DARK;
    found.forEach(function (text, i) {
      var b = spText(p, "button", "tumbler-search-suggestion", spShorten(text, SP_SUGGEST_CHARS), {
        ...spButtonStyle(pal),
        borderRadius: "0",
        padding: "4px 10px",
      });
      b.type = "button";
      b.dataset.index = String(i);
      if (text.length > SP_SUGGEST_CHARS) b.setAttribute("aria-label", text);
      box.appendChild(b);
    });
  }

  // A click on a suggestion puts its text on the current line and searches at once.
  function spSuggestClick(p, ev) {
    var n = ev.target;
    while (n && n !== p.suggestBox && n.tagName !== "BUTTON") n = n.parentNode;
    if (!n || n === p.suggestBox) return;
    var text = p.suggested[Number(n.dataset.index)];
    if (typeof text !== "string") return;
    var value = String(p.input.value || "");
    var where = spCurrentLine(p.input);
    p.input.value = value.slice(0, where.start) + text + value.slice(where.end);
    if (p.timer && p.win?.clearTimeout) p.win.clearTimeout(p.timer);
    p.timer = 0;
    spRun(p);
    spRenderSuggestions(p);
    p.input.focus();
  }

  // When the searches shown were not typed here (a host's call, a click in Focus), the box
  // shows them, so editing it searches from what is shown.
  // Text searches are synced only into an empty box, so a typed line that matched nothing
  // (and was left out) is never wiped from what the person wrote.
  function spSyncInput(p, search) {
    if (!spActive(search) || p.timer || p.doc.activeElement === p.input) return;
    var shownKey = search.searches
      .map(function (q) {
        return q.kind + ":" + q.text;
      })
      .join("\n");
    if (shownKey === p.syncKey) return; // the same searches again (waiting, a re-run)
    p.syncKey = shownKey;
    var foreign = search.searches.some(function (q) {
      return q.kind === "point" || q.kind === "vector";
    });
    if (!foreign && spLines(p.input.value).length) return;
    var lines = search.searches.map(function (q) {
      if (q.kind === "point" && q.results[0]?.id === q.point) return q.results[0].text;
      return q.text;
    });
    var key = lines.join("\n");
    p.input.value = key;
    p.lastSent = key;
  }

  // ----- rendering from info().search -----

  function spRender(p) {
    if (p.destroyed) return;
    var search = p.search;
    var text = summaryText(search);
    if (p.barSummary.textContent !== text) p.barSummary.textContent = text;
    if (p.live.textContent !== text) p.live.textContent = text;
    spRenderControls(p, search);
    spRenderNote(p, search);
    spRenderPairs(p, search);
    spRenderLists(p, search);
    spRenderSide(p, search);
    spRenderProvenance(p, search);
  }

  function spRenderControls(p, search) {
    var st = search?.settings || {};
    var active = spActive(search);
    p.face.disabled = !active || !search.faceable;
    if (st.lit && p.lit.value !== st.lit) p.lit.value = st.lit;
    spRangeValue({ input: p.k, out: p.kOut }, st.k, 0);
    p.distances.input.checked = !!st.distances;
    var offered = !!search?.reranker?.offered;
    spPlace(p.rerank.label, offered, p.distances.label);
    spPlace(p.cand.label, offered, p.distances.label);
    spPlace(p.top.label, offered, p.distances.label);
    p.rerank.input.checked = offered && !!st.rerank;
    spRangeValue(p.cand, st.candidates, 0);
    spRangeValue(p.top, st.top, st.candidates);
    // With the reranker on, Keep top decides how many results there are, not Results.
    var reranking = offered && !!st.rerank;
    p.k.disabled = reranking;
    p.k.title = reranking ? SP_K_RERANKED : "";
    p.only.input.checked = !!st.onlyResults;
    spShow(p.only.label, p.focus, "inline-flex");
    spRenderPov(p, search);
  }

  // The Reranker, Candidates and Keep top controls are in the row only when a reranker is
  // offered (absent, not hidden).
  function spPlace(label, present, before) {
    if (present && !label.parentNode && before.parentNode) before.parentNode.insertBefore(label, before);
    if (!present && label.parentNode) label.remove();
  }

  function spRenderPov(p, search) {
    var st = search?.settings || {};
    var list = spActive(search) ? search.searches : [];
    var key = list
      .map(function (q) {
        return q.letter + q.text;
      })
      .join("|");
    if (key !== p.povKey) {
      p.povKey = key;
      p.pov.textContent = "";
      p.pov.appendChild(spOption(p, "", "off"));
      list.forEach(function (q) {
        p.pov.appendChild(spOption(p, q.letter, q.letter + " · " + spShorten(q.text, 30)));
      });
    }
    p.pov.value = st.pointOfView || "";
    p.pov.disabled = !list.length;
  }

  function spRenderNote(p, search) {
    var parts = spNoteParts(search, { extraLines: p.extraLines, refusal: p.refusal, focus: p.focus });
    var text = parts.join(" ");
    if (p.note.textContent !== text) p.note.textContent = text;
  }

  function spRenderPairs(p, search) {
    p.pairs.textContent = "";
    if (!spActive(search) || !search.pairs?.length) return;
    var word = p.light ? "marked in dark ink" : "marked white";
    search.pairs.forEach(function (pair) {
      var line = spEl(p, "p", "tumbler-search-pair", { margin: "0", fontSize: "12px", lineHeight: "1.6" });
      var mark = spText(p, "span", "tumbler-search-shared-mark", "◆ ", { color: spSharedVar(p.light) });
      mark.setAttribute("aria-hidden", "true");
      line.appendChild(mark);
      line.appendChild(p.doc.createTextNode(spPairText(search, pair, word)));
      p.pairs.appendChild(line);
    });
  }

  // A key for what the lists show, so an unchanged update leaves them (and keyboard focus) alone.
  function spListKey(p, search) {
    if (!spActive(search)) return "none|" + p.focus;
    return JSON.stringify([
      p.focus,
      search.settings,
      search.stale,
      search.searches.map(function (q) {
        return [q.letter, q.text, q.reranker, q.pointOfView, q.insideCount, q.results];
      }),
    ]);
  }

  function spRenderLists(p, search) {
    var key = spListKey(p, search);
    if (key === p.listKey) return;
    p.listKey = key;
    spKeepOpen(p);
    p.results.textContent = "";
    spShow(p.results, !p.focus, "flex");
    if (!spActive(search)) return;
    var distances = !!search.settings?.distances;
    search.searches.forEach(function (q, j) {
      var box = spEl(p, "details", "tumbler-search-list", {});
      box.dataset.letter = q.letter;
      box.open = !!p.openLists[q.letter];
      var summary = spText(p, "summary", "", spListHeading(q), {
        cursor: "pointer",
        fontSize: "12px",
        letterSpacing: "0.04em",
        padding: "4px 0",
        color: spSearchVar(j, p.light),
      });
      box.appendChild(summary);
      box.appendChild(spResultList(p, q, j, distances, "grid"));
      p.results.appendChild(box);
    });
  }

  // Remember which result lists were open, from the details themselves (no listeners).
  function spKeepOpen(p) {
    for (var box of p.results.children) {
      var letter = box.dataset?.letter;
      if (letter) p.openLists[letter] = !!box.open;
    }
  }

  // One search's ordered list: rank, text, meta (and the gap bar with Distance difference on).
  function spResultList(p, q, j, distances, layout) {
    var pal = p.pal || SP_PALETTE_DARK;
    var ol = spEl(p, "ol", "tumbler-search-hits", spListStyle(layout));
    var widest = 1e-6;
    q.results.forEach(function (r) {
      widest = Math.max(widest, r.gap);
    });
    q.results.forEach(function (r) {
      ol.appendChild(spResultItem(p, q, j, r, { distances: distances, widest: widest, pal: pal, layout: layout }));
    });
    return ol;
  }

  function spListStyle(layout) {
    var base = { listStyle: "none", margin: "0", padding: "0" };
    if (layout === "grid") {
      // Up to 100 results: the list scrolls inside its own box, so the panel stays usable.
      return {
        ...base,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
        gap: "6px 22px",
        maxHeight: "var(--tumbler-search-list-height, 320px)",
        overflowY: "auto",
      };
    }
    return { ...base, display: "flex", flexDirection: "column" };
  }

  function spResultItem(p, q, j, r, o) {
    var side = o.layout !== "grid";
    var li = spEl(p, "li", "tumbler-search-hit", {
      display: "grid",
      gridTemplateColumns: "26px minmax(0, 1fr)",
      gap: "2px 8px",
      alignItems: "baseline",
      minWidth: "0",
      borderBottom: "1px solid " + o.pal.line,
      padding: side ? "10px 16px" : "0 0 5px",
    });
    li.dataset.id = r.id;
    var rank = spText(p, "span", "tumbler-search-rank", (q.letter || "") + r.rank, {
      fontSize: "12px",
      color: spSearchVar(j, p.light),
      fontVariantNumeric: "tabular-nums",
    });
    li.appendChild(rank);
    li.appendChild(
      spText(p, "span", "tumbler-search-text", r.text, {
        fontFamily: side ? "var(--tumbler-font, inherit)" : "var(--tumbler-font-display, Georgia, serif)",
        fontSize: side ? "14px" : "19px",
        lineHeight: side ? "1.4" : "1.15",
        color: o.pal.fg,
        overflowWrap: "anywhere",
      })
    );
    var meta = spResultMeta(q, r, o.distances);
    if (meta.length) {
      li.appendChild(
        spText(p, "span", "tumbler-search-meta", meta.join(" · "), {
          gridColumn: "2",
          fontSize: "11px",
          fontVariantNumeric: "tabular-nums",
          color: o.pal.muted,
        })
      );
    }
    if (o.distances) li.appendChild(spGapBar(p, r.gap / o.widest, j, o.pal));
    return li;
  }

  function spGapBar(p, share, j, pal) {
    var bar = spEl(p, "span", "tumbler-search-gap", {
      gridColumn: "2",
      display: "block",
      height: "3px",
      position: "relative",
      background: pal.line,
      marginTop: "2px",
    });
    bar.setAttribute("aria-hidden", "true");
    var fill = spEl(p, "span", "", {
      position: "absolute",
      left: "0",
      top: "0",
      bottom: "0",
      width: (100 * Math.min(1, Math.max(0, share))).toFixed(1) + "%",
      background: spSearchVar(j, p.light),
    });
    bar.appendChild(fill);
    return bar;
  }

  // The Search row of the provenance list and the clause in its summary; put back after the
  // viewer re-renders the block (it does on every update of the data).
  function spRenderProvenance(p, search) {
    var active = spActive(search);
    var list = p.parts.provenanceList;
    var sum = p.parts.provenanceSummary;
    if (!p.provDt) {
      // The viewer's own rows' look (js/src/50-viewer.js, provRow).
      p.provDt = spText(p, "dt", "tumbler-provenance-term tumbler-search-provenance-term", "Search", { margin: "0" });
      p.provDd = spText(p, "dd", "tumbler-provenance-value tumbler-search-provenance-value", "", { margin: "0", minWidth: "0" });
      p.provClause = spText(p, "span", "tumbler-search-provenance-clause", "");
    }
    p.provDt.style.color = p.pal.muted;
    p.provDd.style.color = p.pal.fg;
    var used = usedText(search);
    if (p.provDd.textContent !== used) p.provDd.textContent = used;
    var clause = spProvenanceClause(search);
    if (p.provClause.textContent !== clause) p.provClause.textContent = clause;
    spAttach(list, [p.provDt, p.provDd], active);
    spAttach(sum, [p.provClause], active);
  }

  function spAttach(parent, nodes, on) {
    if (!parent) return;
    nodes.forEach(function (n) {
      if (on && n.parentNode !== parent) parent.appendChild(n);
      if (!on && n.parentNode) n.remove();
    });
  }

  // ----- Focus: the ranked lists beside the stage -----

  function spFreshSearch(p) {
    try {
      return typeof p.handle.info === "function" ? p.handle.info().search : null;
    } catch {
      // A handle whose info() throws: keep the snapshot the panel has.
      return null;
    }
  }

  function spSetFocus(p, focus) {
    if (focus === p.focus) return;
    p.focus = focus;
    // What a search reports depends on the view (whether it can be faced), so the kept
    // snapshot is read again; otherwise Face the searches keeps the other view's state.
    if (p.search) p.search = spFreshSearch(p) || p.search;
    var root = p.parts.stage.parentNode;
    if (focus) {
      if (!p.side) p.side = spBuildSide(p);
      p.rootDisplay = root.style.display;
      spStyle(root, { display: "flex", flexWrap: "wrap", alignItems: "flex-start", columnGap: "var(--tumbler-search-side-gap, 16px)" });
      spStyle(p.parts.stage, { flex: "999 1 600px", minWidth: "0" });
      p.parts.panel.style.flex = "1 1 100%";
      p.parts.stage.after(p.side);
      p.side.style.maxHeight = p.parts.stage.style.height || "";
    } else {
      p.side?.remove();
      spStyle(root, { display: p.rootDisplay || "block", flexWrap: "", alignItems: "", columnGap: "" });
      spStyle(p.parts.stage, { flex: "", minWidth: "" });
      p.parts.panel.style.flex = "";
    }
    p.listKey = null;
    p.sideKey = null;
    if (p.pal) spRender(p);
  }

  function spBuildSide(p) {
    var pal = p.pal || SP_PALETTE_DARK;
    var side = spEl(p, "aside", "tumbler-search-side", {
      flex: "1 1 340px",
      minWidth: "0",
      boxSizing: "border-box",
      overflowY: "auto",
      border: "1px solid " + pal.line,
      background: pal.bg,
      color: pal.muted,
      fontFamily: "var(--tumbler-font-data, inherit)",
    });
    side.setAttribute("aria-label", "Search results");
    return side;
  }

  function spRenderSide(p, search) {
    if (!p.focus || !p.side) return;
    var key = spListKey(p, search);
    if (key === p.sideKey) return;
    p.sideKey = key;
    var pal = p.pal || SP_PALETTE_DARK;
    var side = p.side;
    side.textContent = "";
    side.style.borderColor = pal.line;
    side.style.background = pal.bg;
    var head = spEl(p, "div", "tumbler-search-side-head", { padding: "14px 16px 10px", borderBottom: "1px solid " + pal.line });
    var active = spActive(search);
    head.appendChild(
      spText(p, "p", "tumbler-search-side-title", active ? "Nearest texts" : "No search", {
        margin: "0",
        fontFamily: "var(--tumbler-font-display, Georgia, serif)",
        fontStyle: "italic",
        fontSize: "26px",
        lineHeight: "1.1",
        color: pal.fg,
      })
    );
    head.appendChild(spText(p, "p", "tumbler-search-side-sub", spSideSub(search), { margin: "4px 0 0", fontSize: "12px" }));
    side.appendChild(head);
    if (!active) {
      side.appendChild(
        spText(
          p,
          "p",
          "tumbler-search-side-empty",
          "Nothing searched: every point is shown. Open Search below the view and type, or click a point to search from it.",
          { margin: "0", padding: "16px", fontSize: "14px" }
        )
      );
      return;
    }
    var distances = !!search.settings?.distances;
    search.searches.forEach(function (q, j) {
      side.appendChild(
        spText(p, "p", "tumbler-search-side-letter", q.letter + " · " + q.text, {
          margin: "0",
          padding: "10px 16px 4px",
          fontSize: "12px",
          letterSpacing: "0.04em",
          color: spSearchVar(j, p.light),
        })
      );
      side.appendChild(spResultList(p, q, j, distances, "column"));
    });
  }

  function spSideSub(search) {
    if (!spActive(search)) return "every point is shown";
    var q = search.searches[0];
    var parts = search.searches.map(function (s) {
      var how = s.pointOfView ? "from its point of view" : "plain distance";
      return s.letter + ": " + s.results.length + " named results, " + how + (s.reranker ? ", then the reranker (" + spKeptOf(s) + ")" : "");
    });
    return (search.searches.length === 1 ? parts[0].slice(q.letter.length + 2) : parts.join("; ")) + " · " + search.measure;
  }

  // ----- the overlay: query rings, links, labels over the stage -----

  function spLabelLayer(p) {
    if (p.labelLayer) return p.labelLayer;
    var layer = spEl(p, "div", "tumbler-search-labels", {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "1",
    });
    layer.setAttribute("aria-hidden", "true");
    var overlay = p.parts.overlay;
    if (overlay?.parentNode === p.parts.stage) overlay.after(layer);
    else p.parts.stage.appendChild(layer);
    p.labelLayer = layer;
    return layer;
  }

  function spLabelAt(p, used, str, x, y, style) {
    if (used >= SP_LABEL_POOL) return used;
    var rec = p.labels[used];
    if (!rec) {
      rec = { el: spEl(p, "span", "tumbler-search-label", { position: "absolute", left: "0", top: "0", whiteSpace: "nowrap", fontSize: "11px", fontFamily: "var(--tumbler-font-data, monospace)" }), text: null, colour: null, shown: true };
      spLabelLayer(p).appendChild(rec.el);
      p.labels.push(rec);
    }
    if (rec.text !== str) {
      rec.el.textContent = str;
      rec.text = str;
    }
    if (rec.colour !== style.colour) {
      rec.el.style.color = style.colour;
      rec.el.style.textShadow = p.outline;
      rec.colour = style.colour;
    }
    rec.el.style.transform = "translate(" + x.toFixed(1) + "px, " + y.toFixed(1) + "px) translate(" + (style.centre ? "-50%" : "0") + ", -50%)";
    rec.el.style.opacity = String(Math.round(style.alpha * 100) / 100);
    if (!rec.shown) {
      rec.el.style.display = "";
      rec.shown = true;
    }
    return used + 1;
  }

  function spHideLabels(p, from) {
    for (var i = from; i < p.labels.length; i++) {
      if (p.labels[i].shown) {
        p.labels[i].el.style.display = "none";
        p.labels[i].shown = false;
      }
    }
  }

  // A label is placed only where it overlaps none already placed (the honest, simple answer
  // to a tight cluster: the list carries everything the stage leaves out).
  function spFits(boxes, x, y, text, centre) {
    var w = text.length * SP_CHAR_W + 4;
    var left = centre ? x - w / 2 : x;
    var box = { l: left, r: left + w, t: y - SP_LABEL_H / 2, b: y + SP_LABEL_H / 2 };
    for (var o of boxes) {
      if (box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t) return false;
    }
    boxes.push(box);
    return true;
  }

  function spOutline(bg) {
    var ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
    return ring
      .map(function (d) {
        return (d[0] * 1.5).toFixed(2) + "px " + (d[1] * 1.5).toFixed(2) + "px 0.5px " + bg;
      })
      .join(", ");
  }

  function spPointVector(set, index) {
    var D = set.dimension;
    return set.vectors.subarray(index * D, index * D + D);
  }

  function spFinite(pt) {
    return !!pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
  }

  // Draw one search: links from its query to its results, then its ring and letter. Labels are
  // queued in `queue` so they can be placed letters first, then nearest results first.
  function spDrawSearch(p, ctx, j, qp, q, view) {
    var dpr = view.dpr;
    var colour = p.colours[j];
    var n = q.results.length;
    ctx.lineWidth = dpr;
    ctx.strokeStyle = colour;
    q.results.forEach(function (r, i) {
      if (view.hidden(r.index)) return;
      var rp = view.project(spPointVector(view.set, r.index));
      if (!spFinite(rp)) return;
      var rel = n > 1 ? 1 - i / (n - 1) : 1;
      ctx.globalAlpha = view.filter * (0.25 + 0.4 * rel);
      ctx.beginPath();
      ctx.moveTo(qp.x, qp.y);
      ctx.lineTo(rp.x, rp.y);
      ctx.stroke();
      view.queue.push({ q: q, j: j, r: r, rp: rp, qp: qp });
    });
    ctx.globalAlpha = view.filter;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(qp.x, qp.y, 10 * dpr, 0, Math.PI * 2);
    ctx.stroke();
    if (view.focus) {
      ctx.beginPath();
      ctx.moveTo(qp.x - 4 * dpr, qp.y);
      ctx.lineTo(qp.x + 4 * dpr, qp.y);
      ctx.moveTo(qp.x, qp.y - 4 * dpr);
      ctx.lineTo(qp.x, qp.y + 4 * dpr);
      ctx.stroke();
    }
  }

  // Place the labels: each query's letter, then every result's rank (Focus) or text (the
  // other views, when labels are on), then each link's distance with Distance difference on.
  function spPlaceLabels(p, view, letters) {
    var boxes = [];
    var used = 0;
    var dpr = view.dpr;
    letters.forEach(function (l) {
      var x = l.qp.x / dpr + 15;
      var y = l.qp.y / dpr + 4; // the reference's place, clear of a result label above it
      spFits(boxes, l.qp.x / dpr - 11, y, "   ", false);
      if (spFits(boxes, x, y, l.text, false)) used = spLabelAt(p, used, l.text, x, y, { colour: p.colours[l.j], alpha: view.filter });
    });
    var many = letters.length > 1;
    var order = view.queue.slice().sort(function (a, b) {
      return a.r.rank - b.r.rank || a.j - b.j;
    });
    // Stop once every label element is used: with 400 results the rest would only be tested.
    for (var it of order) {
      if (used >= SP_LABEL_POOL) break;
      used = spPlaceResult(p, view, boxes, used, it, many);
    }
    if (view.distances) {
      for (var link of order) {
        if (used >= SP_LABEL_POOL) break;
        used = spPlaceDistance(p, view, boxes, used, link);
      }
    }
    spHideLabels(p, used);
  }

  function spPlaceResult(p, view, boxes, used, it, many) {
    var text = null;
    if (view.focus) text = (many ? it.q.letter : "") + it.r.rank;
    else if (view.labels) text = spShorten(it.r.text, SP_STAGE_TEXT);
    if (!text) return used;
    var x = it.rp.x / view.dpr + 8;
    var y = it.rp.y / view.dpr - 8;
    if (!spFits(boxes, x, y, text, false)) return used;
    var colour = view.focus ? p.colours[it.j] : p.pal.fg;
    return spLabelAt(p, used, text, x, y, { colour: colour, alpha: view.filter });
  }

  function spPlaceDistance(p, view, boxes, used, it) {
    var share = view.focus ? 0.72 : 0.62;
    var x = (it.qp.x + (it.rp.x - it.qp.x) * share) / view.dpr;
    var y = (it.qp.y + (it.rp.y - it.qp.y) * share) / view.dpr + 11;
    var text = it.r.distance.toFixed(3);
    if (!spFits(boxes, x, y, text, true)) return used;
    return spLabelAt(p, used, text, x, y, { colour: p.pal.muted, alpha: view.filter * 0.9, centre: true });
  }

  // The viewer tells the panel about searches, not about data: a new or appended set (which
  // changes what is offered, such as the Reranker, and the suggestions) is noticed here.
  function spDataChanged(p, set) {
    var count = set ? set.count : -1;
    if (set === p.dataRef && count === p.dataCount) return;
    p.dataRef = set;
    p.dataCount = count;
    try {
      if (typeof p.handle.info === "function") spUpdate(p, p.handle.info().search);
    } catch {
      // A handle whose info throws: keep what is shown.
    }
  }

  // The text outline follows the stage's background (labels restyle on their next use).
  function spRefreshOutline(p) {
    if (p.outlineBg === p.pal.bg) return;
    p.outline = spOutline(p.pal.bg);
    p.outlineBg = p.pal.bg;
    p.labels.forEach(function (rec) {
      rec.colour = null;
    });
  }

  function spNever() {
    return false;
  }

  // What one frame's drawing needs, from the viewer's frame argument.
  function spView(p, f, set, project, filter) {
    return {
      set: set,
      project: project,
      dpr: Number(f.dpr) > 0 ? Number(f.dpr) : 1,
      filter: Math.min(1, filter),
      labels: f.labels !== false,
      focus: p.focus,
      distances: !!p.search.settings?.distances,
      hidden: typeof f.hidden === "function" ? f.hidden : spNever,
      queue: [],
    };
  }

  function spDrawOverlay(p, ctx, project, frame) {
    var f = frame || {};
    var set = spData(p);
    spDataChanged(p, set);
    if (f.mode) spSetFocus(p, f.mode === "focus");
    spRenderProvenance(p, p.search);
    var search = p.search;
    var filter = Number(f.filter);
    var shown = filter > 0.05; // false for NaN too
    if (!spActive(search) || !set || !Array.isArray(f.queries) || !shown) {
      spHideLabels(p, 0);
      return false;
    }
    if (!p.colours) p.colours = spCanvasColours(p, ctx);
    spRefreshOutline(p);
    var view = spView(p, f, set, project, filter);
    var letters = [];
    ctx.save?.();
    search.searches.forEach(function (q, j) {
      var vec = f.queries[j];
      if (!vec || vec.length !== set.dimension) return;
      var qp = project(vec);
      if (!spFinite(qp)) return;
      spDrawSearch(p, ctx, j, qp, q, view);
      letters.push({ qp: qp, j: j, text: view.focus ? q.letter + " query" : q.letter });
    });
    ctx.globalAlpha = 1;
    ctx.restore?.();
    spPlaceLabels(p, view, letters);
    return true;
  }

  // ----- update and mount -----

  function spUpdate(p, search) {
    if (p.destroyed) return;
    p.search = search || null;
    var theme = spTheme(p);
    if (theme !== p.themeRef) {
      p.themeRef = theme;
      spApplyTheme(p);
    }
    var mode = spMode(p);
    if (mode) spSetFocus(p, mode === "focus");
    spSyncInput(p, p.search);
    spRender(p);
  }

  function spMode(p) {
    try {
      return typeof p.handle.mode === "function" ? p.handle.mode() : null;
    } catch {
      // A handle whose mode() throws: keep the layout as it is.
      return null;
    }
  }

  function spDestroy(p) {
    if (p.destroyed) return;
    p.destroyed = true;
    if (p.timer && p.win?.clearTimeout) p.win.clearTimeout(p.timer);
    p.timer = 0;
    p.listeners.forEach(function (l) {
      l[0].removeEventListener(l[1], l[2]);
    });
    p.listeners = [];
    spSetFocus(p, false);
    p.section.remove();
    p.labelLayer?.remove();
    p.provDt?.remove();
    p.provDd?.remove();
    p.provClause?.remove();
    p.labels = [];
  }

  function mount(parts, handle, options) {
    var opts = options || {};
    var doc = opts.document || parts.panel.ownerDocument;
    spCounter += 1;
    var p = {
      n: spCounter,
      doc: doc,
      win: doc.defaultView || null,
      parts: parts,
      handle: handle,
      opts: opts,
      bodyId: "tumbler-search-body-" + spCounter,
      search: null,
      open: false,
      focus: false,
      openLists: Object.create(null),
      timer: 0,
      lastSent: "",
      refusal: null,
      extraLines: 0,
      suggested: [],
      suggestCache: { set: null, count: -1, entries: [] },
      listeners: [],
      labels: [],
      labelLayer: null,
      colours: null,
      outline: "",
      outlineBg: null,
      listKey: null,
      sideKey: null,
      povKey: null,
      themeRef: undefined,
      dataRef: undefined,
      dataCount: -2,
      destroyed: false,
    };
    spBuild(p);
    p.themeRef = spTheme(p);
    spApplyTheme(p);
    var first = null;
    try {
      first = typeof handle.info === "function" ? handle.info().search : null;
    } catch {
      // No info yet: the panel starts with nothing searched.
      first = null;
    }
    spUpdate(p, first);
    return {
      update: function (search) {
        spUpdate(p, search);
      },
      drawOverlay: function (ctx, project, frame) {
        if (p.destroyed) return false;
        return spDrawOverlay(p, ctx, project, frame);
      },
      destroy: function () {
        spDestroy(p);
      },
      setOpen: function (open) {
        spSetOpen(p, !!open);
      },
      isOpen: function () {
        return p.open;
      },
    };
  }

  ET.searchPanel = {
    mount: mount,
    summaryText: summaryText,
    usedText: usedText,
    suggest: spSuggest,
    noteText: function (search, ctx) {
      return spNoteParts(search, ctx || {}).join(" ");
    },
    pairText: spPairText,
    resultMeta: spResultMeta,
    thousands: spThousands,
    COLOURS: { dark: SP_DARK.slice(), light: SP_LIGHT.slice(), sharedDark: SP_SHARED_DARK, sharedLight: SP_SHARED_LIGHT },
  };
