#!/usr/bin/env python3
"""Write an embeddings-tumbler data file pair (NAME.json + NAME.f32).

Input: JSON lines, one object per line:
  {"id": "p1", "label": "text", "group": "optional", "metadata": {...optional}, "vector": [floats]}
Blank lines are skipped. All vectors must have the same length.

Usage:
  write_data_file.py INPUT OUTDIR NAME --model MODEL [--source S] [--producer P]
      [--synthetic] [--seed N] [--endpoint NAME] [--limitation TEXT ...]
      [--uncertain TEXT ...] [--labels-only] [--keep-groups]
Output is deterministic (no timestamp is written).
--labels-only: text_included=false, label:=id, no metadata, group kept only
with --keep-groups (you assert group names are not corpus text).
"""
import argparse, json, math, os, re, struct, sys


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("outdir")
    ap.add_argument("name")
    ap.add_argument("--model", required=True)
    ap.add_argument("--source", default="unspecified input file")
    ap.add_argument("--producer", default="write_data_file.py 0.1.0")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--endpoint", default=None)
    ap.add_argument("--limitation", action="append", default=[])
    ap.add_argument("--uncertain", action="append", default=[])
    ap.add_argument("--labels-only", action="store_true")
    ap.add_argument("--keep-groups", action="store_true")
    a = ap.parse_args()

    if not a.model:
        fail("model must be non-empty")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", a.name):
        fail("name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$")
    if a.endpoint is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}", a.endpoint):
        fail("endpoint must be a plain name (letters, digits, space, _ -), not an address")
    if a.seed is not None and abs(a.seed) > 9007199254740991:
        fail("seed out of integer range")

    points, vecs, seen, dim = [], [], set(), None
    try:
        fh = open(a.input, encoding="utf-8")
    except OSError as e:
        fail(f"cannot read input: {e}")
    with fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except ValueError as e:
                fail(f"line {n}: invalid JSON ({e})")
            if not isinstance(o, dict):
                fail(f"line {n}: not an object")
            pid = o.get("id")
            if not isinstance(pid, str) or not pid:
                fail(f"line {n}: id must be a non-empty string")
            if pid in seen:
                fail(f"line {n}: duplicate id {pid!r}")
            seen.add(pid)
            v = o.get("vector")
            if not isinstance(v, list) or not v:
                fail(f"line {n}: vector must be a non-empty list")
            for x in v:
                if isinstance(x, bool) or not isinstance(x, (int, float)):
                    fail(f"line {n}: vector holds a non-number")
            if dim is None:
                dim = len(v)
            elif len(v) != dim:
                fail(f"line {n}: vector length {len(v)} != {dim}")
            try:
                fv = [struct.unpack("<f", struct.pack("<f", float(x)))[0] for x in v]
            except OverflowError:
                fail(f"line {n}: value too large for float32")
            if not all(math.isfinite(x) for x in fv):
                fail(f"line {n}: non-finite value")
            vecs.append(fv)
            label = o.get("label", pid)
            group = o.get("group", "")
            meta = o.get("metadata", {})
            if not isinstance(label, str) or not isinstance(group, str) or not isinstance(meta, dict):
                fail(f"line {n}: label/group must be strings, metadata an object")
            rec = {"id": pid}
            if a.labels_only:
                rec["label"] = pid
                if a.keep_groups and group:
                    rec["group"] = group
            else:
                rec["label"] = label
                if group:
                    rec["group"] = group
                if meta:
                    rec["metadata"] = meta
            points.append(rec)
    if dim is None:
        fail("input holds no points (this script needs at least one to learn the dimension)")

    block = b"".join(struct.pack(f"<{dim}f", *v) for v in vecs)
    prov = {
        "source": a.source, "producer": a.producer, "synthetic": a.synthetic,
        "seed": a.seed, "limitations": a.limitation, "uncertain": a.uncertain,
    }
    if a.endpoint is not None:
        prov["endpoint"] = a.endpoint
    f32name = a.name + ".f32"
    doc = {
        "schema_version": 1, "kind": "embeddings-tumbler/data", "model": a.model,
        "dimension": dim, "count": len(points), "text_included": not a.labels_only,
        "provenance": prov,
        "vectors": {"file": f32name, "dtype": "float32", "byte_order": "little",
                    "byte_length": len(block)},
        "points": points,
    }
    text = json.dumps(doc, allow_nan=False, ensure_ascii=False, indent=1) + "\n"
    os.makedirs(a.outdir, exist_ok=True)
    jp, bp = os.path.join(a.outdir, a.name + ".json"), os.path.join(a.outdir, f32name)
    with open(jp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    with open(bp, "wb") as f:
        f.write(block)
    verify(jp, bp)
    print(f"wrote {jp} and {bp}: {len(points)} points x {dim} dims")


def verify(jp, bp):
    """Re-read the written files and check them against the guide's rules."""
    with open(jp, encoding="utf-8") as f:
        d = json.load(f)
    raw = open(bp, "rb").read()
    errs = []
    if d.get("kind") != "embeddings-tumbler/data" or d.get("schema_version") != 1:
        errs.append("kind/schema_version")
    if d["count"] != len(d["points"]):
        errs.append("count != len(points)")
    if d["vectors"]["byte_length"] != d["count"] * d["dimension"] * 4 or len(raw) != d["vectors"]["byte_length"]:
        errs.append("byte length")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", d["vectors"]["file"]) or d["vectors"]["file"] != os.path.basename(bp):
        errs.append("vectors.file")
    ids = [p["id"] for p in d["points"]]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and i for i in ids):
        errs.append("ids")
    n = d["count"] * d["dimension"]
    if not all(math.isfinite(x) for x in struct.unpack(f"<{n}f", raw)):
        errs.append("non-finite")
    p = d["provenance"]
    for k in ("source", "producer", "synthetic", "seed", "limitations", "uncertain"):
        if k not in p:
            errs.append("provenance." + k)
    if not d["text_included"]:
        if any(q["label"] != q["id"] or "metadata" in q for q in d["points"]):
            errs.append("labels-only set carries text")
    if errs:
        fail("self-check failed: " + ", ".join(errs))


if __name__ == "__main__":
    main()
