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
INPUT and OUTDIR must be inside the folder you run the script from (OUTDIR may be
"." itself): the script reads and writes nowhere else, so a mistyped or generated
path such as ../../somewhere cannot read or overwrite files outside that folder.
--labels-only: text_included=false, label:=id, no metadata, group kept only
with --keep-groups (you assert group names are not corpus text).
"""

import argparse
import json
import math
import os
import re
import struct
import sys

PLAIN_NAME = r"[A-Za-z0-9][A-Za-z0-9._-]*"


def fail(msg):
    sys.stderr.write("error: " + msg + "\n")
    sys.exit(1)


def inside_here(path, folder_ok=False):
    """The real path of PATH; stop unless it is inside the current folder.

    Symlinks are followed first, so a link cannot point the script elsewhere.
    With folder_ok, the current folder itself is accepted too.
    """
    here = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(here, path))
    if full.startswith(here + os.sep) or (folder_ok and full == here):
        return full
    # Like fail(): prints "error: ..." on stderr and exits with status 1.
    raise SystemExit(
        f"error: {path} is outside the current folder {here}; "
        "run the script from a folder that holds it"
    )


def parse_args():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
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
    return ap.parse_args()


def check_args(a):
    if not a.model:
        fail("model must be non-empty")
    if not re.fullmatch(PLAIN_NAME, a.name):
        fail("name must match ^[A-Za-z0-9][A-Za-z0-9._-]*$")
    if a.endpoint is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,63}", a.endpoint):
        fail("endpoint must be a plain name (letters, digits, space, _ -), not an address")
    if a.seed is not None and abs(a.seed) > 9007199254740991:
        fail("seed out of integer range")


def read_vector(n, o, dim):
    """The point's vector as float32 values, checked against the dimension seen so far."""
    v = o.get("vector")
    if not isinstance(v, list) or not v:
        fail(f"line {n}: vector must be a non-empty list")
    for x in v:
        if isinstance(x, bool) or not isinstance(x, (int, float)):
            fail(f"line {n}: vector holds a non-number")
    if dim is not None and len(v) != dim:
        fail(f"line {n}: vector length {len(v)} != {dim}")
    try:
        fv = [struct.unpack("<f", struct.pack("<f", float(x)))[0] for x in v]
    except OverflowError:
        fail(f"line {n}: value too large for float32")
    if not all(math.isfinite(x) for x in fv):
        fail(f"line {n}: non-finite value")
    return fv


def make_record(n, o, pid, a):
    """The point record, carrying only what --labels-only and --keep-groups allow."""
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
        return rec
    rec["label"] = label
    if group:
        rec["group"] = group
    if meta:
        rec["metadata"] = meta
    return rec


def parse_line(n, line, seen, dim, a):
    """One input line as (record, float32 vector)."""
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
    fv = read_vector(n, o, dim)
    return make_record(n, o, pid, a), fv


def read_points(given, a):
    """(point records, float32 vectors, dimension) from the JSON-lines input."""
    points, vecs, seen, dim = [], [], set(), None
    path = inside_here(given)
    try:
        fh = open(path, encoding="utf-8")
    except OSError as e:
        fail(f"cannot read input: {e}")
    with fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            rec, fv = parse_line(n, line, seen, dim, a)
            dim = len(fv)
            vecs.append(fv)
            points.append(rec)
    if dim is None:
        fail("input holds no points (this script needs at least one to learn the dimension)")
    return points, vecs, dim


def main():
    a = parse_args()
    check_args(a)
    points, vecs, dim = read_points(a.input, a)

    block = b"".join(struct.pack(f"<{dim}f", *v) for v in vecs)
    prov = {
        "source": a.source, "producer": a.producer, "synthetic": a.synthetic,
        "seed": a.seed, "limitations": a.limitation, "uncertain": a.uncertain,
    }  # fmt: skip
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
    }  # fmt: skip
    text = json.dumps(doc, allow_nan=False, ensure_ascii=False, indent=1) + "\n"
    outdir = inside_here(a.outdir, folder_ok=True)
    os.makedirs(outdir, exist_ok=True)
    jp = inside_here(os.path.join(outdir, a.name + ".json"))
    bp = inside_here(os.path.join(outdir, f32name))
    with open(jp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    with open(bp, "wb") as f:
        f.write(block)
    verify(jp, bp)
    shown = os.path.join(a.outdir, a.name)
    print(f"wrote {shown}.json and {shown}.f32: {len(points)} points x {dim} dims")


def layout_errors(d, raw, bp):
    """The kind, count, byte-length and vectors.file rules."""
    errs = []
    if d.get("kind") != "embeddings-tumbler/data" or d.get("schema_version") != 1:
        errs.append("kind/schema_version")
    if d["count"] != len(d["points"]):
        errs.append("count != len(points)")
    byte_length = d["vectors"]["byte_length"]
    if byte_length != d["count"] * d["dimension"] * 4 or len(raw) != byte_length:
        errs.append("byte length")
    vfile = d["vectors"]["file"]
    if not re.fullmatch(PLAIN_NAME, vfile) or vfile != os.path.basename(bp):
        errs.append("vectors.file")
    return errs


def content_errors(d, raw):
    """The ids, values, provenance and labels-only rules."""
    errs = []
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
    texts = (q["label"] != q["id"] or "metadata" in q for q in d["points"])
    if not d["text_included"] and any(texts):
        errs.append("labels-only set carries text")
    return errs


def verify(written_json, written_block):
    """Re-read the written files and check them against the guide's rules."""
    jp, bp = inside_here(written_json), inside_here(written_block)
    with open(jp, encoding="utf-8") as f:
        d = json.load(f)
    with open(bp, "rb") as f:
        raw = f.read()
    errs = layout_errors(d, raw, bp) + content_errors(d, raw)
    if errs:
        fail("self-check failed: " + ", ".join(errs))


if __name__ == "__main__":
    main()
