
// ---------------------------------------------------------------------------
// 20-contract.js: data contract loader and validator (schema version 1).
// Pure functions: no file, network or DOM access. See docs/data-contract.md
// (the authority) and js/api/20-contract.md (the interface).
// ---------------------------------------------------------------------------
(function () {
  var SUPPORTED = [1];
  var KIND = "embeddings-tumbler/data";
  var MAX_INT = 9007199254740991;
  var ENDPOINT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
  var PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  var MESSAGES = {
    "wrong-kind":
      'Not an embeddings-tumbler data set: "kind" must be "embeddings-tumbler/data".',
    "schema-version":
      "Data schema version {found} is not supported; this viewer reads schema version {supported}.",
    "invalid-field": 'Field "{field}" is missing or not valid.',
    "vector-file-path":
      'Vector file "{file}" must be a plain file name in the same folder as the data file.',
    "endpoint-is-address":
      '"provenance.endpoint" must name the embedding route, not give a network address.',
    "block-unreadable": 'Vector file "{file}" could not be read.',
    "count-mismatch": '"count" is {count} but the data has {found} point records.',
    "duplicate-id": 'Point id "{id}" appears more than once.',
    "block-length":
      "Vector block is {found} bytes; expected {count} points x {dimension} dimensions x 4 bytes = {expected} bytes.",
    "non-finite": 'Vector of point "{id}" contains a value that is not a finite number.',
    "append-without-base":
      "Cannot append: the view holds no data set yet. Send a full set first.",
    "model-mismatch":
      'Cannot append: model "{found}" differs from the view\'s model "{expected}". One view shows one model.',
    "dimension-mismatch":
      "Cannot append: dimension {found} differs from the view's dimension {expected}.",
    "reduction-mismatch":
      'Cannot append: reduction "{found}" differs from the view\'s reduction "{expected}".',
    "id-exists": 'Cannot append: point id "{id}" is already in the view.',
  };

  function fill(code, values) {
    return MESSAGES[code].replace(/\{(\w+)\}/g, function (m, name) {
      return Object.hasOwn(values || {}, name) ? String(values[name]) : m;
    });
  }

  // The base set is returned with every refusal so the caller keeps what it holds.
  function refuse(code, values, base) {
    return { ok: false, code: code, message: fill(code, values), set: base || null };
  }

  function tag(v) {
    return Object.prototype.toString.call(v);
  }
  function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function isInt(v) {
    return typeof v === "number" && Number.isFinite(v) && Math.floor(v) === v && Math.abs(v) <= MAX_INT;
  }
  function isNonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
  }
  function isStringList(v) {
    if (!Array.isArray(v)) return false;
    for (const item of v) if (typeof item !== "string") return false;
    return true;
  }
  function isFloat32Array(v) {
    return tag(v) === "[object Float32Array]";
  }
  function isArrayBuffer(v) {
    return tag(v) === "[object ArrayBuffer]";
  }
  function has(o, k) {
    return Object.hasOwn(o, k);
  }

  function jsonText(v) {
    try {
      var s = JSON.stringify(v);
      return s === undefined ? "missing" : s;
    } catch {
      // JSON.stringify throws for a value it cannot write (a BigInt, a cycle, a
      // throwing toJSON); the message then shows the plain string form instead,
      // and the error itself carries nothing the message needs.
      return String(v);
    }
  }

  // Deep copy of JSON-like data, so the set never shares objects with the host.
  function clone(v) {
    if (Array.isArray(v)) {
      var a = [];
      for (const item of v) a.push(clone(item));
      return a;
    }
    if (v !== null && typeof v === "object") {
      var o = {};
      // defineProperty, not assignment: a key named "__proto__" stays a key.
      for (const key of Object.keys(v)) {
        Object.defineProperty(o, key, { value: clone(v[key]), writable: true, enumerable: true, configurable: true });
      }
      return o;
    }
    return v;
  }

  // Returns the path of the first invalid field, or null. `form` is "memory" or "file".
  // The checks run in the contract's field order; each helper returns the path
  // of its first invalid field, or null to go on to the next.
  function firstInvalidField(d, op, form) {
    return (
      invalidTopField(d, op) ??
      invalidProvenance(d.provenance, op === "append") ??
      invalidReduction(d.reduction, d) ??
      invalidVectors(d.vectors, d, form) ??
      invalidPoints(d.points)
    );
  }

  function invalidTopField(d, op) {
    if (op !== undefined && op !== "replace" && op !== "append") return "op";
    if (!isNonEmptyString(d.model)) return "model";
    if (!isInt(d.dimension) || d.dimension < 1) return "dimension";
    if (!isInt(d.count) || d.count < 0) return "count";
    if (typeof d.text_included !== "boolean") return "text_included";
    return null;
  }

  // Provenance is required, except on an append, where it may be left out.
  function invalidProvenance(p, isAppend) {
    if (p === undefined && isAppend) return null;
    return invalidProvenanceRequired(p) ?? invalidProvenanceOptional(p);
  }

  function invalidProvenanceRequired(p) {
    if (!isObject(p)) return "provenance";
    if (!isNonEmptyString(p.source)) return "provenance.source";
    if (!isNonEmptyString(p.producer)) return "provenance.producer";
    if (typeof p.synthetic !== "boolean") return "provenance.synthetic";
    if (!has(p, "seed") || !(p.seed === null || isInt(p.seed))) return "provenance.seed";
    if (!isStringList(p.limitations)) return "provenance.limitations";
    if (!isStringList(p.uncertain)) return "provenance.uncertain";
    return null;
  }

  function invalidProvenanceOptional(p) {
    if (p.created !== undefined && typeof p.created !== "string") return "provenance.created";
    if (p.endpoint !== undefined && !isNonEmptyString(p.endpoint)) return "provenance.endpoint";
    if (p.params !== undefined && !isObject(p.params)) return "provenance.params";
    return null;
  }

  // The reduction is optional; when given, its fields must be valid and agree
  // with the data's dimension.
  function invalidReduction(r, d) {
    if (r === undefined) return null;
    return invalidReductionField(r) ?? invalidReductionAgreement(r, d);
  }

  function invalidReductionField(r) {
    if (!isObject(r)) return "reduction";
    if (r.kind !== "none" && r.kind !== "rotation" && r.kind !== "top-k") return "reduction.kind";
    if (!isInt(r.source_dimension) || r.source_dimension < 1) return "reduction.source_dimension";
    if (!isInt(r.directions_kept) || r.directions_kept < 1) return "reduction.directions_kept";
    if (
      typeof r.variance_dropped !== "number" ||
      !Number.isFinite(r.variance_dropped) ||
      r.variance_dropped < 0 ||
      r.variance_dropped > 1
    )
      return "reduction.variance_dropped";
    return null;
  }

  // Runs after invalidReductionField and invalidTopField passed, so every value
  // compared here is a finite number (no NaN can make a comparison false both ways).
  function invalidReductionAgreement(r, d) {
    if (r.directions_kept !== d.dimension) return "reduction";
    if (r.kind === "top-k") {
      if (d.dimension >= r.source_dimension || r.variance_dropped >= 1) return "reduction";
    } else if (r.source_dimension !== d.dimension || r.variance_dropped !== 0) {
      return "reduction";
    }
    return null;
  }

  function invalidVectors(v, d, form) {
    if (form === "file") return invalidVectorFile(v, d);
    return isFloat32Array(v) || isArrayBuffer(v) ? null : "vectors";
  }

  function invalidVectorFile(v, d) {
    if (!isObject(v)) return "vectors";
    if (!isNonEmptyString(v.file)) return "vectors.file";
    if (v.dtype !== "float32") return "vectors.dtype";
    if (v.byte_order !== "little") return "vectors.byte_order";
    if (!isInt(v.byte_length) || v.byte_length !== d.count * d.dimension * 4) {
      return "vectors.byte_length";
    }
    return null;
  }

  function invalidPoints(pts) {
    if (!Array.isArray(pts)) return "points";
    for (var i = 0; i < pts.length; i++) {
      var bad = invalidPoint(pts[i]);
      if (bad !== null) return "points[" + i + "]" + bad;
    }
    return null;
  }

  // The invalid field of one point record as a path suffix ("" for the record
  // itself, ".id" and so on), or null.
  function invalidPoint(pt) {
    if (!isObject(pt)) return "";
    if (!isNonEmptyString(pt.id)) return ".id";
    if (typeof pt.label !== "string") return ".label";
    if (pt.group !== undefined && typeof pt.group !== "string") return ".group";
    if (pt.metadata !== undefined && !isObject(pt.metadata)) return ".metadata";
    return null;
  }

  // Checks 1 to 7 of the contract (everything that needs no vector block).
  function checkRecordsInner(d, form, base) {
    if (!isObject(d) || d.kind !== KIND) return refuse("wrong-kind", {}, base);
    if (!isInt(d.schema_version) || !SUPPORTED.includes(d.schema_version)) {
      return refuse(
        "schema-version",
        {
          found: has(d, "schema_version") ? jsonText(d.schema_version) : "missing",
          supported: SUPPORTED.join(", "),
        },
        base
      );
    }
    var bad = firstInvalidField(d, d.op, form);
    if (bad !== null) return refuse("invalid-field", { field: bad }, base);
    if (form === "file" && !PLAIN_NAME.test(d.vectors.file)) {
      return refuse("vector-file-path", { file: d.vectors.file }, base);
    }
    // After firstInvalidField, provenance is either an object or (on an append) absent.
    if (d.provenance?.endpoint !== undefined && !ENDPOINT_NAME.test(d.provenance.endpoint)) {
      return refuse("endpoint-is-address", {}, base);
    }
    if (d.count !== d.points.length) {
      return refuse("count-mismatch", { count: d.count, found: d.points.length }, base);
    }
    var seen = Object.create(null); // ids are untrusted: no inherited names
    for (const point of d.points) {
      var id = point.id;
      if (has(seen, id)) return refuse("duplicate-id", { id: id }, base);
      seen[id] = true;
    }
    return { ok: true };
  }

  var LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  // A fresh Float32Array of the block's values (little-endian bytes for an ArrayBuffer).
  function readValues(block) {
    if (isFloat32Array(block)) {
      return new Float32Array(block); // copies the view's own range only
    }
    var n = Math.floor(block.byteLength / 4);
    var out = new Float32Array(n);
    if (LITTLE) {
      out.set(new Float32Array(block, 0, n));
    } else {
      var dv = new DataView(block);
      for (var i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
    }
    return out;
  }

  // Appends write into spare capacity instead of copying the base's vectors.
  // A set's `vectors` is a Float32Array view of exactly count * dimension
  // values over a buffer that may be longer. `head` maps a buffer to the end
  // (in values) of the newest view over it. An append onto the set whose view
  // ends at the head writes its rows just after it and returns a longer view
  // over the same buffer: the older, shorter view is untouched, so the older
  // set stays valid. An append onto any other set (a fork, or a set that never
  // had spare room) copies into a new buffer of twice the needed length, so
  // the cost of appends is proportional to the points added, amortised.
  var head = typeof WeakMap === "function" ? new WeakMap() : null;

  function appendValues(baseValues, values) {
    var n0 = baseValues.length;
    var n1 = n0 + values.length;
    var buf = baseValues.buffer;
    var off = baseValues.byteOffset / 4;
    if (head?.get(buf) === off + n0 && off + n1 <= buf.byteLength / 4) {
      var grown = new Float32Array(buf, baseValues.byteOffset, n1);
      grown.set(values, n0);
      head.set(buf, off + n1);
      return grown;
    }
    var fresh = new Float32Array(Math.max(2 * n1, 64));
    fresh.set(baseValues, 0);
    fresh.set(values, n0);
    if (head) head.set(fresh.buffer, n1);
    return fresh.subarray(0, n1);
  }

  function copyPoints(pts) {
    var out = [];
    for (const p of pts) {
      out.push({
        id: p.id,
        label: p.label,
        group: p.group === undefined ? "" : p.group,
        metadata: p.metadata === undefined ? {} : clone(p.metadata),
      });
    }
    return out;
  }

  function reductionOf(d) {
    if (d.reduction !== undefined) return clone(d.reduction);
    return {
      kind: "none",
      source_dimension: d.dimension,
      directions_kept: d.dimension,
      variance_dropped: 0,
    };
  }

  function idsOf(points) {
    return points.map(function (p) {
      return p.id;
    });
  }

  // Checks 9 to 11 and the merge. `d` has already passed checks 1 to 7.
  function finishInner(d, block, base) {
    var byteLength = block.byteLength;
    var expected = d.count * d.dimension * 4;
    if (byteLength !== expected) {
      return refuse(
        "block-length",
        { found: byteLength, count: d.count, dimension: d.dimension, expected: expected },
        base
      );
    }
    var values = readValues(block);
    var bad = firstNonFinite(values);
    if (bad >= 0) {
      var row = Math.floor(bad / d.dimension);
      return refuse("non-finite", { id: d.points[row].id }, base);
    }

    var points = copyPoints(d.points);
    var red = reductionOf(d);
    if (d.op === "append") return mergeAppend(d, values, points, red, base);

    return {
      ok: true,
      set: {
        schema_version: 1,
        model: d.model,
        dimension: d.dimension,
        count: points.length,
        text_included: d.text_included,
        provenance: clone(d.provenance),
        reduction: red,
        vectors: values,
        ids: idsOf(points),
        points: points,
      },
    };
  }

  // Index of the first value that is not a finite number, or -1.
  function firstNonFinite(values) {
    for (var i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return i;
    return -1;
  }

  // Check 11 (an append agrees with the set it extends) and the merge.
  function mergeAppend(d, values, points, red, base) {
    if (!isObject(base)) return refuse("append-without-base", {}, null);
    if (d.model !== base.model) {
      return refuse("model-mismatch", { found: d.model, expected: base.model }, base);
    }
    if (d.dimension !== base.dimension) {
      return refuse("dimension-mismatch", { found: d.dimension, expected: base.dimension }, base);
    }
    if (red.kind !== base.reduction.kind) {
      return refuse("reduction-mismatch", { found: red.kind, expected: base.reduction.kind }, base);
    }
    var held = Object.create(null);
    for (const p of base.points) held[p.id] = true;
    for (const p of points) {
      if (has(held, p.id)) return refuse("id-exists", { id: p.id }, base);
    }
    var merged = appendValues(base.vectors, values);
    var allPoints = base.points.concat(points);
    return {
      ok: true,
      set: {
        schema_version: 1,
        model: base.model,
        dimension: base.dimension,
        count: allPoints.length,
        text_included: base.text_included || d.text_included,
        provenance: base.provenance,
        reduction: base.reduction,
        vectors: merged,
        ids: idsOf(allPoints),
        points: allPoints,
      },
    };
  }

  // Never throws into the caller: an unexpected failure becomes a refusal.
  function guarded(base, fn) {
    try {
      return fn();
    } catch {
      // Whatever threw (a hostile getter or proxy in the host's data, a value no
      // check foresaw), the caller gets a refusal, never the exception; the
      // refusal is the whole report, so the error itself is not kept.
      return refuse("invalid-field", { field: "(unreadable data)" }, base);
    }
  }

  // A file-form descriptor carrying its fetched block: { file, dtype, byte_order,
  // byte_length, data }, as a host or a shell hands update() a data file it fetched.
  function isDescriptorWithBlock(v) {
    return isObject(v) && !isFloat32Array(v) && !isArrayBuffer(v) && has(v, "data");
  }

  // validate(data, base): in-memory form. Returns { ok: true, set } or
  // { ok: false, code, message, set: base || null }. When `vectors` is the file
  // form's descriptor with the fetched block in `vectors.data`, the data is checked
  // as the file form (the descriptor's dtype, byte order and declared length too),
  // exactly as finish() would.
  function validate(data, base) {
    return guarded(base, function () {
      if (isObject(data) && isDescriptorWithBlock(data.vectors)) return finishFile(data, data.vectors.data, base);
      var r = checkRecordsInner(data, "memory", base);
      if (!r.ok) return r;
      return finishInner(data, data.vectors, base);
    });
  }

  // checkRecords(records): file form, checks 1 to 7. { ok: true, file } or a refusal.
  function checkRecords(records, base) {
    return guarded(base, function () {
      var r = checkRecordsInner(records, "file", base);
      if (!r.ok) return r;
      return { ok: true, file: records.vectors.file };
    });
  }

  // finish(records, block, base): file form, with the fetched block (ArrayBuffer or
  // Float32Array). Runs checks 1 to 11. A missing or wrong-typed block is block-unreadable.
  function finish(records, block, base) {
    return guarded(base, function () {
      return finishFile(records, block, base);
    });
  }

  function finishFile(records, block, base) {
    var r = checkRecordsInner(records, "file", base);
    if (!r.ok) return r;
    if (!isArrayBuffer(block) && !isFloat32Array(block)) {
      return refuse("block-unreadable", { file: records.vectors.file }, base);
    }
    return finishInner(records, block, base);
  }

  function siblingUrl(jsonUrl, file) {
    var s = String(jsonUrl).split("#")[0].split("?")[0];
    var cut = s.lastIndexOf("/");
    return cut < 0 ? file : s.slice(0, cut + 1) + file;
  }

  // loadFile(jsonUrl, fetchFn, base): file form. fetchFn is fetch-like: it takes a URL
  // string and returns a promise of { ok, json(), arrayBuffer() }. The block is fetched
  // beside the JSON file only. Resolves (never rejects) to the same result as validate.
  function loadFile(jsonUrl, fetchFn, base) {
    return Promise.resolve()
      .then(function () {
        return fetchFn(String(jsonUrl));
      })
      .then(function (res) {
        if (!res?.ok) throw new Error("unreadable");
        return res.json();
      })
      .then(
        function (records) {
          var c = checkRecords(records, base);
          if (!c.ok) return c;
          return loadBlock(records, jsonUrl, c.file, fetchFn, base);
        },
        function () {
          // The data file itself could not be fetched or is not JSON: the document defines
          // no code for this; it is reported as "not a data set".
          return refuse("wrong-kind", {}, base);
        }
      )
      .catch(function () {
        return refuse("wrong-kind", {}, base);
      });
  }

  // The second half of loadFile, once the records have passed checks 1 to 7: fetch
  // the block `file` beside the JSON file and run finish(). Resolves (never
  // rejects); any failure to fetch or read the block is block-unreadable.
  function loadBlock(records, jsonUrl, file, fetchFn, base) {
    return Promise.resolve()
      .then(function () {
        return fetchFn(siblingUrl(jsonUrl, file));
      })
      .then(function (res) {
        if (!res?.ok) throw new Error("unreadable");
        return res.arrayBuffer();
      })
      .then(
        function (buf) {
          return finish(records, buf, base);
        },
        function () {
          return refuse("block-unreadable", { file: file }, base);
        }
      );
  }

  ET.contract = {
    supportedVersions: SUPPORTED.slice(),
    messages: MESSAGES,
    validate: validate,
    checkRecords: checkRecords,
    finish: finish,
    loadFile: loadFile,
  };
})();
