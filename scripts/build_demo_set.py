#!/usr/bin/env python3
"""Embed the demo corpus and write the standalone page's default data file pair.

    python3 scripts/build_demo_set.py                 # preview: embed, check, write nothing
    python3 scripts/build_demo_set.py --apply         # embed and write the pair
    python3 scripts/build_demo_set.py --stand-in --limit 30 --apply
                                                      # the stand-in pair: no model, no network

Reads the corpus written by ``scripts/build_demo_corpus.py``
(``data/wikipedia-vital-3/corpus.jsonl``), sends each item's ``text`` to an
OpenAI-compatible embeddings endpoint in batches, and writes a data contract (schema
version 1) file pair, ``demo-wikipedia.json`` and ``demo-wikipedia.f32``, into
``embeddings_tumbler/static/`` (the one copy; both packages ship it from there).

The endpoint is configured by the same environment variables as ``viewer serve
--embed`` (``docs/search-interface.md``, helper-route section): ``EMBEDDINGS_EMBED_URL``
(the gateway's base address, ending in ``/v1``), ``EMBEDDINGS_EMBED_MODEL`` (or
``--model``) and the key in ``EMBEDDINGS_API_KEY`` or ``COLLEAGUE_API_KEY``. The key is
read from the environment only; it is sent in one request header and never printed,
logged or written. Start the script under ``grant run --inject`` so the key exists only
in its environment.

``--corpus`` and ``--out-dir`` must be inside the current folder or inside this
repository, and each file is written inside ``--out-dir`` itself (a link that leads out of
it is refused).

Refused, with nothing written: a batch whose answer names another model than the first
batch's, a vector whose length differs from the first one's, an answer with the wrong
number of vectors, and a vector with a value that is not a finite number.

The output depends only on the corpus and the endpoint's answers: points in corpus
order, ids ``wp-<page id>``, no timestamp. ``--stand-in`` replaces the endpoint with a
deterministic hash of each text (``stand-in/not-a-model``, ``synthetic: true``) so that
every other part of the build can be tested before the real pair exists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import struct
import sys
import tomllib
from collections.abc import Callable, Mapping
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:  # pragma: no cover - only when run as a plain script
    sys.path.insert(0, str(ROOT))

from embeddings_tumbler import _embed_route  # noqa: E402

CORPUS = ROOT / "data" / "wikipedia-vital-3" / "corpus.jsonl"
CORPUS_NAME = "data/wikipedia-vital-3/corpus.jsonl"
OUT_DIR = ROOT / "embeddings_tumbler" / "static"
NAME = "demo-wikipedia"
BATCH = 32
STAND_IN_MODEL = "stand-in/not-a-model"
STAND_IN_DIMENSION = 64
KIND = "embeddings-tumbler/data"
ENDPOINT_NAME = "^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$"
_FAILED = "The embedding endpoint did not answer."


class BuildError(Exception):
    """A refusal: the message is plain text and never carries the key or the address."""


def project_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def read_corpus(path: Path) -> tuple[dict, list[dict]]:
    """``(header, items)``; BuildError when the file is not a corpus."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
        records = [json.loads(line) for line in lines if line.strip()]
    except (OSError, ValueError) as err:
        raise BuildError(f"cannot read the corpus {path}: {err}") from None
    if not records or records[0].get("record") != "header":
        raise BuildError(f"{path} does not start with a header record")
    items = records[1:]
    for item in items:
        for key in ("id", "title", "group", "text"):
            if not isinstance(item.get(key), str) or not item[key]:
                raise BuildError(f"a corpus item has no {key}: {item.get('id')!r}")
    return records[0], items


def _confined(base_dir: str, value: str, folder_ok: bool = False) -> str:
    """The real path of ``value`` taken under ``base_dir``; ValueError unless it is inside.

    SonarSource's documented path-traversal check: both paths through ``os.path.realpath``,
    then a plain ``startswith(base + os.sep)``. With ``folder_ok`` the base folder itself is
    accepted too.
    """
    base = os.path.realpath(base_dir)
    full = os.path.realpath(os.path.join(base, value))
    if full.startswith(base + os.sep) or (folder_ok and full == base):
        return full
    raise ValueError(f"{value} is outside {base}")


def allowed_path(value: str, what: str, folder_ok: bool = False) -> str:
    """The real path of a path argument: inside the current folder, or inside the repository.

    A relative ``value`` is taken from the current folder. Anything else is refused, so a
    mistyped or generated argument cannot make the script read or write elsewhere.
    """
    try:
        return _confined(os.getcwd(), value, folder_ok)
    except ValueError:
        pass
    try:
        return _confined(str(ROOT), os.path.abspath(value), folder_ok)
    except ValueError:
        raise BuildError(
            f"{what} must be inside the current folder or the repository: {value}"
        ) from None


# --------------------------------------------------------------------------- embedding


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_batch(answer: object, expected: int) -> tuple[str | None, list[list[float]]]:
    """``(model named in the answer, vectors in input order)``; BuildError when malformed."""
    data = answer.get("data") if isinstance(answer, dict) else None
    if not isinstance(data, list) or len(data) != expected:
        raise BuildError("the endpoint answered with the wrong number of vectors")
    rows = sorted(data, key=lambda r: r.get("index", 0) if isinstance(r, dict) else 0)
    vectors = []
    for row in rows:
        vector = row.get("embedding") if isinstance(row, dict) else None
        if not isinstance(vector, list) or not vector or not all(_finite(v) for v in vector):
            raise BuildError("the endpoint answered with a vector that is not a list of numbers")
        vectors.append([float(v) for v in vector])
    model = answer.get("model")
    return (model if isinstance(model, str) and model else None), vectors


def endpoint_embedder(config: _embed_route.RouteConfig) -> Callable[[list[str]], object]:
    """A function that posts one batch of texts to ``<base>/embeddings``."""

    def embed(texts: list[str]) -> object:
        try:
            return _embed_route.gateway_post(
                config,
                "/embeddings",
                {"model": config.embed_model, "input": texts},
                timeout=120.0,
                failed=_FAILED,
            )
        except _embed_route.Refusal as err:
            raise BuildError(err.message) from None

    return embed


def stand_in_vector(text: str, dimension: int = STAND_IN_DIMENSION) -> list[float]:
    """A deterministic unit vector from the text's SHA-256: not a model, not meaning."""
    values: list[float] = []
    counter = 0
    while len(values) < dimension:
        digest = hashlib.sha256(f"{counter}:{text}".encode("utf-8")).digest()
        values += [b / 127.5 - 1.0 for b in digest]
        counter += 1
    values = values[:dimension]
    norm = math.sqrt(sum(v * v for v in values)) or 1.0
    return [v / norm for v in values]


def stand_in_embedder(texts: list[str]) -> object:
    return {
        "model": STAND_IN_MODEL,
        "data": [{"index": i, "embedding": stand_in_vector(t)} for i, t in enumerate(texts)],
    }


def embed_all(
    texts: list[str], embed: Callable[[list[str]], object], asked: str, batch: int = BATCH
) -> tuple[str, list[list[float]]]:
    """``(model, vectors)`` for every text, batch by batch, refusing any inconsistency."""
    model: str | None = None
    dimension: int | None = None
    vectors: list[list[float]] = []
    for start in range(0, len(texts), batch):
        chunk = texts[start : start + batch]
        named, rows = parse_batch(embed(chunk), len(chunk))
        named = named or asked
        if model is None:
            model = named
        elif named != model:
            raise BuildError(
                f"the model changed between batches: {model!r}, then {named!r} "
                f"(at item {start}); nothing was written"
            )
        for row in rows:
            if dimension is None:
                dimension = len(row)
            elif len(row) != dimension:
                raise BuildError(
                    f"the dimension changed between batches: {dimension}, then {len(row)} "
                    f"(at item {start}); nothing was written"
                )
        vectors += rows
    if model is None:
        raise BuildError("the corpus has no items")
    return model, vectors


# --------------------------------------------------------------------------- the pair


def licence_lines(header: dict) -> list[str]:
    """The attribution and licence statement, as provenance limitations (shown as text)."""
    return [
        "Text: the labels are article titles and each point's text is the first sentences of "
        "the article's introduction on English Wikipedia (en.wikipedia.org), by Wikipedia "
        f"contributors, licensed {header.get('licence_name', 'CC BY-SA 4.0')} "
        "(creativecommons.org/licenses/by-sa/4.0/). The text is not under this package's "
        "Apache 2.0 licence; see NOTICE.",
        "Changes: " + str(header.get("changes", "texts shortened")) + ".",
        "Each point's metadata names the Wikipedia page id and the revision id its text was "
        "read from; en.wikipedia.org/?curid=<page id> opens the article and its history.",
    ]


def provenance(header: dict, items: list[dict], args: argparse.Namespace) -> dict:
    listed = header.get("listed", len(items))
    skipped = header.get("skipped") or []
    source = (
        f"Wikipedia: English Wikipedia, {header.get('list')} (revision "
        f"{header.get('list_revision')}), retrieved {header.get('retrieved')}; text "
        f"{header.get('licence', 'CC BY-SA 4.0')}"
    )
    limitations = licence_lines(header)
    limitations.append(
        f"{len(items)} of the list's {listed} entries are included"
        + (f"; {len(skipped)} were skipped (see the corpus header)." if skipped else ".")
    )
    limitations.append(
        "Each vector is of the article's short text, not of the whole article; the "
        "vectors are as the model returned them (not normalised here)."
    )
    if args.stand_in:
        source = "stand-in: " + source
        limitations.insert(
            0,
            "STAND-IN: these vectors are a hash of each text, not the output of any model. "
            "Neighbours here mean nothing. The real set replaces this file.",
        )
    prov = {
        "source": source,
        "producer": f"embeddings-tumbler {project_version()} scripts/build_demo_set.py",
        "synthetic": bool(args.stand_in),
        "seed": None,
        "limitations": limitations,
        "uncertain": [
            "Wikipedia's articles change; the texts are those of the revision ids recorded, "
            "not of the articles today."
        ],
        "params": {
            "corpus": CORPUS_NAME,
            "list": header.get("list"),
            "list_revision": header.get("list_revision"),
            "retrieved": header.get("retrieved"),
            "licence": header.get("licence"),
            "embedded_field": "text",
            "batch_size": args.batch,
            "model_asked": args.model_asked,
        },
    }
    if args.endpoint_name:
        prov["endpoint"] = args.endpoint_name
    return prov


def build_records(
    header: dict, items: list[dict], model: str, dimension: int, args: argparse.Namespace
) -> dict:
    points = [
        {
            "id": item["id"],
            "label": item["title"],
            "group": item["group"],
            "metadata": {
                "text": item["text"],
                "page_id": item.get("page_id"),
                "revision_id": item.get("revision_id"),
            },
        }
        for item in items
    ]
    return {
        "schema_version": 1,
        "kind": KIND,
        "op": "replace",
        "model": model,
        "dimension": dimension,
        "count": len(points),
        "text_included": True,
        "provenance": provenance(header, items, args),
        "reduction": {
            "kind": "none",
            "source_dimension": dimension,
            "directions_kept": dimension,
            "variance_dropped": 0,
        },
        "vectors": {
            "file": args.name + ".f32",
            "dtype": "float32",
            "byte_order": "little",
            "byte_length": len(points) * dimension * 4,
        },
        "points": points,
    }


def records_text(records: dict) -> str:
    """Compact JSON with one point per line, so a change to the set is a readable diff."""
    head = {k: v for k, v in records.items() if k != "points"}
    lines = [json.dumps(p, ensure_ascii=False, separators=(",", ":")) for p in records["points"]]
    opening = json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1]
    return opening + ',"points":[\n' + ",\n".join(lines) + "\n]}\n"


def block_bytes(vectors: list[list[float]]) -> bytes:
    return b"".join(struct.pack(f"<{len(v)}f", *v) for v in vectors)


def _write(folder: str, name: str, data: bytes) -> None:
    """Write ``name`` in ``folder`` through a temporary file beside it, never outside it."""
    try:
        path = _confined(folder, name)
        tmp = _confined(folder, f".{name}.tmp-{os.getpid()}")
    except ValueError as err:
        raise BuildError(f"{err}; nothing was written there") from None
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def build(args: argparse.Namespace, environ: Mapping[str, str]) -> tuple[dict, bytes]:
    header, items = read_corpus(Path(allowed_path(str(args.corpus), "--corpus")))
    if args.limit is not None:
        items = items[: args.limit]
    if args.stand_in:
        embed, asked = stand_in_embedder, STAND_IN_MODEL
    else:
        try:
            config = _embed_route.load_config(environ, embed_model=args.model)
        except _embed_route.ConfigError as err:
            raise BuildError(f"{err.message} ({err.remediation})") from None
        embed, asked = endpoint_embedder(config), config.embed_model
    args.model_asked = asked
    model, vectors = embed_all([item["text"] for item in items], embed, asked, args.batch)
    records = build_records(header, items, model, len(vectors[0]), args)
    return records, block_bytes(vectors)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", type=Path, default=CORPUS, help="the corpus JSONL file")
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR, help="where the pair goes")
    parser.add_argument("--name", default=NAME, help="the pair's file name, without extension")
    parser.add_argument("--model", help="the model to ask for (default: as viewer serve)")
    parser.add_argument("--batch", type=int, default=BATCH, help="texts per request")
    parser.add_argument("--limit", type=int, help="embed only the first N items")
    parser.add_argument("--endpoint-name", help="a name for the route, e.g. 'lobes gateway'")
    parser.add_argument("--stand-in", action="store_true", help="hash vectors, no endpoint")
    parser.add_argument("--apply", action="store_true", help="write the pair")
    return parser


def _check_args(args: argparse.Namespace) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.name):
        raise BuildError("--name must be a plain file name")
    if args.batch < 1 or (args.limit is not None and args.limit < 1):
        raise BuildError("--batch and --limit must be at least 1")
    if args.endpoint_name and not re.fullmatch(ENDPOINT_NAME, args.endpoint_name):
        raise BuildError("--endpoint-name must be a name, not an address")


def main(argv: list[str] | None = None, environ: Mapping[str, str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        _check_args(args)
        out_dir = allowed_path(str(args.out_dir), "--out-dir", folder_ok=True)
        records, block = build(args, os.environ if environ is None else environ)
    except BuildError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    except Exception:  # noqa: BLE001 - no traceback may carry a setting or a text
        print("error: the build failed unexpectedly; nothing was written", file=sys.stderr)
        return 2
    text = records_text(records).encode("utf-8")
    summary = (
        f"{records['count']} points x {records['dimension']} dimensions from "
        f"{records['model']}: {args.name}.json {len(text)} bytes, {args.name}.f32 "
        f"{len(block)} bytes"
    )
    if not args.apply:
        print(f"would write {summary} to {args.out_dir}; re-run with --apply to write")
        return 0
    os.makedirs(out_dir, exist_ok=True)
    try:
        _write(out_dir, args.name + ".f32", block)
        _write(out_dir, args.name + ".json", text)
    except BuildError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(f"wrote {summary} to {args.out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
