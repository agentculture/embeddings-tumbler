#!/usr/bin/env python3
"""Generate the data-contract fixtures under tests/fixtures/contract/.

Standard library only. Deterministic: every vector value comes from a fixed
seed through a 32-bit integer generator (mulberry32) and plain IEEE arithmetic,
so two runs on any machine write byte-identical files. The contract itself is
docs/data-contract.md; this script only produces examples of it.

Each fixture is a pair, as the contract's file form requires:

* ``<name>.json`` -- the data set's JSON part (version, model, provenance,
  point records, and a descriptor of the vector block).
* ``<name>.f32``  -- the vector block: little-endian float32, row after row,
  exactly ``count * dimension * 4`` bytes.

``index.json`` lists every case: which file to load, which valid set (if any)
to load first as the base of an append, whether it is accepted, and for a
refused case the exact refusal code and message.

Usage:
    python3 scripts/gen_contract_fixtures.py            # rewrite the committed fixtures
    python3 scripts/gen_contract_fixtures.py --out DIR  # write them somewhere else
"""

from __future__ import annotations

import argparse
import copy
import json
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "tests" / "fixtures" / "contract"

SCHEMA_VERSION = 1
KIND = "embeddings-tumbler/data"

# Refusal message templates, exactly as docs/data-contract.md states them.
# Placeholders in braces are filled in by the validator.
MESSAGES = {
    "wrong-kind": 'Not an embeddings-tumbler data set: "kind" must be "embeddings-tumbler/data".',
    "schema-version": (
        "Data schema version {found} is not supported; "
        "this viewer reads schema version {supported}."
    ),
    "invalid-field": 'Field "{field}" is missing or not valid.',
    "vector-file-path": (
        'Vector file "{file}" must be a plain file name in the same folder as the data file.'
    ),
    "endpoint-is-address": (
        '"provenance.endpoint" must name the embedding route, not give a network address.'
    ),
    "block-unreadable": 'Vector file "{file}" could not be read.',
    "count-mismatch": '"count" is {count} but the data has {found} point records.',
    "duplicate-id": 'Point id "{id}" appears more than once.',
    "block-length": (
        "Vector block is {found} bytes; expected {count} points x {dimension} dimensions "
        "x 4 bytes = {expected} bytes."
    ),
    "non-finite": 'Vector of point "{id}" contains a value that is not a finite number.',
    "append-without-base": "Cannot append: the view holds no data set yet. Send a full set first.",
    "model-mismatch": (
        'Cannot append: model "{found}" differs from the view\'s model "{expected}". '
        "One view shows one model."
    ),
    "dimension-mismatch": (
        "Cannot append: dimension {found} differs from the view's dimension {expected}."
    ),
    "reduction-mismatch": (
        'Cannot append: reduction "{found}" differs from the view\'s reduction "{expected}".'
    ),
    "id-exists": 'Cannot append: point id "{id}" is already in the view.',
}


def message(code: str, **values: object) -> dict:
    text = MESSAGES[code]
    for key, value in values.items():
        text = text.replace("{" + key + "}", str(value))
    return {"code": code, "message": text}


# ---------------------------------------------------------------------------
# Deterministic numbers
# ---------------------------------------------------------------------------


def _imul(a: int, b: int) -> int:
    return (a * b) & 0xFFFFFFFF


def mulberry32(seed: int):
    """Return a function yielding floats in [0, 1) from a 32-bit seed."""
    state = seed & 0xFFFFFFFF

    def next_float() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t = (t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return next_float


def make_vectors(seed: int, groups: list[int], dimension: int) -> list[list[float]]:
    """One vector per entry in ``groups``: a per-group centre plus small noise."""
    rnd = mulberry32(seed)
    centres: dict[int, list[float]] = {}
    for g in sorted(set(groups)):
        centres[g] = [rnd() * 2.0 - 1.0 for _ in range(dimension)]
    return [[c + (rnd() * 2.0 - 1.0) * 0.25 for c in centres[g]] for g in groups]


def pack(vectors: list[list[float]]) -> bytes:
    return b"".join(struct.pack(f"<{len(v)}f", *v) for v in vectors)


# ---------------------------------------------------------------------------
# Building data sets
# ---------------------------------------------------------------------------


def provenance(source: str, *, seed: int, limitations=None, **extra) -> dict:
    prov = {
        "source": source,
        "producer": "scripts/gen_contract_fixtures.py",
        "created": "2026-11-13T00:00:00Z",
        "synthetic": True,
        "seed": seed,
        "limitations": list(limitations or []),
        "uncertain": [],
    }
    prov.update(extra)
    return prov


def data_set(
    stem: str,
    *,
    model: str,
    dimension: int,
    points: list[dict],
    prov: dict | None,
    op: str = "replace",
    text_included: bool = True,
    reduction: dict | None = None,
) -> dict:
    data: dict = {"schema_version": SCHEMA_VERSION, "kind": KIND}
    if op != "replace":
        data["op"] = op
    data.update(
        {
            "model": model,
            "dimension": dimension,
            "count": len(points),
            "text_included": text_included,
        }
    )
    if prov is not None:
        data["provenance"] = prov
    if reduction is not None:
        data["reduction"] = reduction
    data["vectors"] = {
        "file": f"{stem}.f32",
        "dtype": "float32",
        "byte_order": "little",
        "byte_length": len(points) * dimension * 4,
    }
    data["points"] = points
    return data


MODEL_A = "fixture/model-a"
MODEL_B = "fixture/model-b"
MODEL_1024 = "fixture/model-1024"


def points_384() -> list[dict]:
    return [
        {
            "id": "a-01",
            "label": "the gateway listens on port 8001",
            "group": "alpha",
            "metadata": {"role": "base", "rank": 1},
        },
        {
            "id": "a-02",
            "label": "the gateway runs on port 8001",
            "group": "alpha",
            "metadata": {"role": "paraphrase", "rank": 2},
        },
        {
            "id": "a-03",
            "label": "<b>markup is text</b> & <script>not run</script>",
            "group": "alpha",
            "metadata": {"note": "<i>also text</i>"},
        },
        {"id": "b-01", "label": "naïve café, 東京, ünïcödé", "group": "beta"},
        {"id": "b-02", "label": "", "group": "beta", "metadata": {"nested": {"k": [1, 2]}}},
        {"id": "c-01", "label": "a point with no group"},
    ]


def build() -> tuple[dict[str, dict], dict[str, bytes], list[dict]]:
    """Return (json documents by file name, blocks by file name, index cases)."""
    docs: dict[str, dict] = {}
    blocks: dict[str, bytes] = {}

    def add(stem: str, data: dict, vectors: list[list[float]] | None = None, raw=None) -> str:
        docs[f"{stem}.json"] = data
        file_name = data.get("vectors", {}).get("file")
        if raw is not None:
            blocks[file_name] = raw
        elif vectors is not None:
            blocks[file_name] = pack(vectors)
        return f"{stem}.json"

    # --- valid sets -------------------------------------------------------
    p384 = points_384()
    v384 = make_vectors(384, [0, 0, 0, 1, 1, 2], 384)
    valid_384 = data_set(
        "valid-384",
        model=MODEL_A,
        dimension=384,
        points=p384,
        prov=provenance("fixture: valid-384", seed=384),
    )
    add("valid-384", valid_384, v384)

    p1024 = [
        {"id": f"q-{i:02d}", "label": f"rotated point {i}", "group": g}
        for i, g in enumerate(["near", "near", "far", "far"], start=1)
    ]
    valid_1024 = data_set(
        "valid-1024",
        model=MODEL_1024,
        dimension=1024,
        points=p1024,
        prov=provenance(
            "fixture: valid-1024",
            seed=1024,
            limitations=["fixture vectors are random, not from a model"],
            endpoint="fixture route",
            params={"batch_size": 4},
        ),
        reduction={
            "kind": "rotation",
            "source_dimension": 1024,
            "directions_kept": 1024,
            "variance_dropped": 0,
        },
    )
    valid_1024["provenance"]["uncertain"] = ["the near/far groups are invented"]
    add("valid-1024", valid_1024, make_vectors(1024, [0, 0, 1, 1], 1024))

    p_labels = [{"id": f"item-{i}", "label": f"item-{i}", "group": "g"} for i in range(4)]
    labels_only = data_set(
        "labels-only",
        model=MODEL_A,
        dimension=384,
        points=p_labels,
        text_included=False,
        prov=provenance("fixture: labels-only", seed=None),
        reduction={
            "kind": "none",
            "source_dimension": 384,
            "directions_kept": 384,
            "variance_dropped": 0,
        },
    )
    add("labels-only", labels_only, make_vectors(7, [0, 0, 1, 1], 384))

    p_topk = [{"id": f"k-{i}", "label": f"top-k point {i}"} for i in range(5)]
    top_k = data_set(
        "top-k-16",
        model=MODEL_1024,
        dimension=16,
        points=p_topk,
        prov=provenance("fixture: top-k-16", seed=16),
        reduction={
            "kind": "top-k",
            "source_dimension": 1024,
            "directions_kept": 16,
            "variance_dropped": 0.42,
        },
    )
    add("top-k-16", top_k, make_vectors(16, [0, 1, 2, 3, 4], 16))

    empty = data_set(
        "empty-384",
        model=MODEL_A,
        dimension=384,
        points=[],
        prov=provenance("fixture: empty-384", seed=0),
    )
    add("empty-384", empty, [])

    p_append = [
        {"id": "d-01", "label": "appended first", "group": "delta"},
        {"id": "d-02", "label": "appended second", "group": "delta"},
    ]
    append_384 = data_set(
        "append-384", model=MODEL_A, dimension=384, points=p_append, prov=None, op="append"
    )
    add("append-384", append_384, make_vectors(385, [0, 0], 384))

    p_labels_append = [{"id": f"item-{i}", "label": f"item-{i}", "group": "g"} for i in (8, 9)]
    append_labels = data_set(
        "append-labels-only",
        model=MODEL_A,
        dimension=384,
        points=p_labels_append,
        prov=None,
        op="append",
        text_included=False,
    )
    add("append-labels-only", append_labels, make_vectors(389, [0, 0], 384))

    # --- refused sets: each a copy of a valid one with exactly one fault ---
    # Copies of valid-384 keep pointing at valid-384.f32 unless the block
    # itself is the fault, so the repository carries one copy of it.
    bumped = copy.deepcopy(valid_384)
    bumped["schema_version"] = 2
    add("bumped-version", bumped)

    short = copy.deepcopy(valid_384)
    short["vectors"]["file"] = "wrong-block-length.f32"
    add("wrong-block-length", short, raw=pack(v384)[:-4])

    p768 = [{"id": "e-01", "label": "a 768-d point", "group": "epsilon"}]
    append_768 = data_set(
        "append-768", model=MODEL_A, dimension=768, points=p768, prov=None, op="append"
    )
    add("append-768", append_768, make_vectors(768, [0], 768))

    p_other = [{"id": "f-01", "label": "from another model", "group": "phi"}]
    other = data_set(
        "append-other-model", model=MODEL_B, dimension=384, points=p_other, prov=None, op="append"
    )
    add("append-other-model", other, make_vectors(386, [0], 384))

    p_rot = [{"id": "g-01", "label": "rotated append", "group": "gamma"}]
    rotated = data_set(
        "append-rotated",
        model=MODEL_A,
        dimension=384,
        points=p_rot,
        prov=None,
        op="append",
        reduction={
            "kind": "rotation",
            "source_dimension": 384,
            "directions_kept": 384,
            "variance_dropped": 0,
        },
    )
    add("append-rotated", rotated, make_vectors(387, [0], 384))

    p_exists = [
        {"id": "h-01", "label": "new point", "group": "eta"},
        {"id": "a-02", "label": "an id the base already has", "group": "eta"},
    ]
    exists = data_set(
        "append-existing-id", model=MODEL_A, dimension=384, points=p_exists, prov=None, op="append"
    )
    add("append-existing-id", exists, make_vectors(388, [0, 0], 384))

    dup = copy.deepcopy(valid_384)
    dup["points"][4]["id"] = "a-02"
    add("duplicate-id", dup)

    miscount = copy.deepcopy(valid_384)
    miscount["points"] = miscount["points"][:5]
    add("count-mismatch", miscount)

    nan_vectors = copy.deepcopy(v384)
    nan_vectors[2][100] = float("nan")
    nan_set = copy.deepcopy(valid_384)
    nan_set["vectors"]["file"] = "non-finite.f32"
    add("non-finite", nan_set, nan_vectors)

    addressed = copy.deepcopy(valid_384)
    addressed["provenance"]["endpoint"] = "http://localhost:8001/v1"
    add("endpoint-address", addressed)

    wrong_kind = copy.deepcopy(valid_384)
    wrong_kind["kind"] = "embeddings-cli/atlas"
    add("wrong-kind", wrong_kind)

    escape = copy.deepcopy(valid_384)
    escape["vectors"]["file"] = "../valid-384.f32"
    add("vector-file-path", escape)

    unreadable = copy.deepcopy(valid_384)
    unreadable["vectors"]["file"] = "no-such-block.f32"  # deliberately never written
    add("block-unreadable", unreadable)

    no_limits = copy.deepcopy(valid_384)
    del no_limits["provenance"]["limitations"]
    add("missing-limitations", no_limits)

    declared = copy.deepcopy(valid_384)
    declared["vectors"]["byte_length"] += 4
    add("byte-length-declared", declared)

    # --- the index ---------------------------------------------------------
    def ids(*sets: dict) -> list[str]:
        return [p["id"] for s in sets for p in s["points"]]

    def accepted(name: str, file: str, base: str | None, view: dict, *sets: dict) -> dict:
        # The view holds text if any part of it does (the safe direction).
        text = any(s["text_included"] for s in sets)
        return {
            "name": name,
            "file": file,
            "base": base,
            "valid": True,
            "expect": {
                "count": len(ids(*sets)),
                "ids": ids(*sets),
                "model": view["model"],
                "dimension": view["dimension"],
                "reduction": view.get("reduction", {}).get("kind", "none"),
                "text_included": text,
            },
            "refusal": None,
        }

    def refused(name: str, file: str, base: str | None, refusal: dict) -> dict:
        return {"name": name, "file": file, "base": base, "valid": False, "refusal": refusal}

    v = "valid-384.json"
    cases = [
        accepted("valid-384", v, None, valid_384, valid_384),
        accepted("valid-1024", "valid-1024.json", None, valid_1024, valid_1024),
        accepted("labels-only", "labels-only.json", None, labels_only, labels_only),
        accepted("top-k-16", "top-k-16.json", None, top_k, top_k),
        accepted("empty-set", "empty-384.json", None, empty, empty),
        accepted("append-onto-384", "append-384.json", v, valid_384, valid_384, append_384),
        accepted(
            "labels-only-append-onto-text",
            "append-labels-only.json",
            v,
            valid_384,
            valid_384,
            append_labels,
        ),
        refused("append-without-base", "append-384.json", None, message("append-without-base")),
        refused(
            "bumped-version",
            "bumped-version.json",
            None,
            message("schema-version", found=2, supported="1"),
        ),
        refused(
            "wrong-block-length",
            "wrong-block-length.json",
            None,
            message(
                "block-length",
                found=len(pack(v384)) - 4,
                count=6,
                dimension=384,
                expected=len(pack(v384)),
            ),
        ),
        refused(
            "mixed-dimension",
            "append-768.json",
            v,
            message("dimension-mismatch", found=768, expected=384),
        ),
        refused(
            "second-model",
            "append-other-model.json",
            v,
            message("model-mismatch", found=MODEL_B, expected=MODEL_A),
        ),
        refused(
            "reduction-mismatch",
            "append-rotated.json",
            v,
            message("reduction-mismatch", found="rotation", expected="none"),
        ),
        refused("id-exists", "append-existing-id.json", v, message("id-exists", id="a-02")),
        refused("duplicate-id", "duplicate-id.json", None, message("duplicate-id", id="a-02")),
        refused(
            "count-mismatch",
            "count-mismatch.json",
            None,
            message("count-mismatch", count=6, found=5),
        ),
        refused(
            "block-unreadable",
            "block-unreadable.json",
            None,
            message("block-unreadable", file="no-such-block.f32"),
        ),
        refused("non-finite", "non-finite.json", None, message("non-finite", id="a-03")),
        refused("endpoint-address", "endpoint-address.json", None, message("endpoint-is-address")),
        refused("wrong-kind", "wrong-kind.json", None, message("wrong-kind")),
        refused(
            "vector-file-path",
            "vector-file-path.json",
            None,
            message("vector-file-path", file="../valid-384.f32"),
        ),
        refused(
            "missing-limitations",
            "missing-limitations.json",
            None,
            message("invalid-field", field="provenance.limitations"),
        ),
        refused(
            "byte-length-declared",
            "byte-length-declared.json",
            None,
            message("invalid-field", field="vectors.byte_length"),
        ),
    ]
    return docs, blocks, cases


def index_document(cases: list[dict]) -> dict:
    return {
        "contract": "docs/data-contract.md",
        "generator": "scripts/gen_contract_fixtures.py",
        "schema_versions_supported": [SCHEMA_VERSION],
        "about": (
            "One entry per case. Load 'base' first as a full set (null: start empty), then "
            "apply 'file'. A valid case lists what the view holds afterwards; a refused case "
            "gives the first refusal's code and exact message, and the view is unchanged."
        ),
        "messages": MESSAGES,
        "cases": cases,
    }


def dump_json(obj: object) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


OWNED_SUFFIXES = (".json", ".f32")


class RefusedTarget(Exception):
    """The output folder holds files this generator did not write."""


def prepare(out_dir: Path) -> None:
    """Make ``out_dir`` ready without ever removing a directory tree.

    A missing or empty folder is used as it is. A non-empty folder is accepted
    only if it holds this generator's ``index.json``; then only its own kinds
    of file (``*.json`` and ``*.f32`` directly inside it) are removed, so stale
    fixtures do not linger. Sub-folders and any other file are left alone.
    """
    if not out_dir.exists():
        out_dir.mkdir(parents=True)
        return
    if not out_dir.is_dir():
        raise RefusedTarget(f"{out_dir} exists and is not a folder")
    entries = list(out_dir.iterdir())
    if not entries:
        return
    if not (out_dir / "index.json").is_file():
        raise RefusedTarget(
            f"{out_dir} is not empty and holds no index.json from this generator; "
            "refusing to write into it"
        )
    for entry in entries:
        if entry.is_file() and not entry.is_symlink() and entry.suffix in OWNED_SUFFIXES:
            entry.unlink()


def write(out_dir: Path) -> list[Path]:
    docs, blocks, cases = build()
    prepare(out_dir)
    written = []
    for name, doc in sorted(docs.items()):
        written.append(out_dir / name)
        written[-1].write_bytes(dump_json(doc))
    for name, block in sorted(blocks.items()):
        written.append(out_dir / name)
        written[-1].write_bytes(block)
    written.append(out_dir / "index.json")
    written[-1].write_bytes(dump_json(index_document(cases)))
    return written


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output folder")
    args = parser.parse_args(argv)
    try:
        written = write(args.out)
    except RefusedTarget as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    for path in written:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
