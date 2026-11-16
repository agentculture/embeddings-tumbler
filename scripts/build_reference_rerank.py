#!/usr/bin/env python3
"""Reranker scores for the relative-search reference page, from the real reranker.

The reference page ``docs/specs/reference/tumbler-relative-search.html`` has no model in
it, so it cannot call a reranker. This script asks the gateway's reranker once per article
of the shipped Wikipedia demo set, the way the viewer does for a search from a point
(``docs/search-interface.md``, "Reranking"): the query text is the point's text and the
candidates are the texts of its nearest points by cosine, here the 50 nearest others.
The answers are written beside the page as ``demo-wikipedia-rerank.json``.

The endpoint and key come from the same environment variables as ``viewer serve --embed``
(``EMBEDDINGS_API_KEY`` or ``COLLEAGUE_API_KEY``). The key is never printed or written.
Run it under ``grant run`` so the key is only in this process's environment::

    grant run --inject EMBEDDINGS_API_KEY=LOBES_GATEWAY_API_KEY -- \
        python3 scripts/build_reference_rerank.py --apply

Without ``--apply`` it reports what it would do. A partial run is kept in ``--cache`` and
continued on the next run.
"""

from __future__ import annotations

import argparse
import array
import datetime
import json
import math
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from embeddings_tumbler import _embed_route  # noqa: E402

STATIC = ROOT / "embeddings_tumbler" / "static"
OUT = ROOT / "docs" / "specs" / "reference" / "demo-wikipedia-rerank.json"
CANDIDATES = 50
DEFAULT_MODEL = "Qwen/Qwen3-Reranker-0.6B"


def load_set() -> tuple[dict, list[list[float]]]:
    meta = json.loads((STATIC / "demo-wikipedia.json").read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((STATIC / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    count, dim = meta["count"], meta["dimension"]
    if len(block) != count * dim:
        raise SystemExit("the vector block does not match count x dimension")
    rows = [block[i * dim : (i + 1) * dim].tolist() for i in range(count)]
    return meta, rows


def pools(rows: list[list[float]]) -> list[list[int]]:
    """For each point, its CANDIDATES nearest other points by dot product, nearest first."""
    out = []
    for i, row in enumerate(rows):
        sims = [math.sumprod(row, other) for other in rows]
        order = sorted((j for j in range(len(rows)) if j != i), key=lambda j: (-sims[j], j))
        out.append(order[:CANDIDATES])
    return out


def text_of(point: dict) -> str:
    text = (point.get("metadata") or {}).get("text")
    return text if isinstance(text, str) and text.strip() else str(point["label"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="call the reranker and write the file")
    parser.add_argument("--force", action="store_true", help="overwrite an existing output file")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument(
        "--cache", type=Path, default=None, help="partial answers, one JSON line each"
    )
    args = parser.parse_args()

    meta, rows = load_set()
    count = meta["count"]
    if not args.apply:
        print(f"would rerank {count} searches of {CANDIDATES} candidates with {args.model}")
        print(f"would write {OUT.relative_to(ROOT)}")
        return 0
    if OUT.exists() and not args.force:
        print(f"{OUT.relative_to(ROOT)} exists; pass --force to overwrite", file=sys.stderr)
        return 1

    config = _embed_route.load_config(os.environ, rerank_model=args.model)
    pool = pools(rows)
    texts = [text_of(p) for p in meta["points"]]

    done: dict[int, dict] = {}
    if args.cache and args.cache.exists():
        for line in args.cache.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row["pool"] == pool[row["i"]] and row["model_asked"] == args.model:
                done[row["i"]] = row
    cache = args.cache.open("a", encoding="utf-8") if args.cache else None

    def one(i: int) -> dict:
        answer = _embed_route.gateway_post(
            config,
            "/rerank",
            {"model": args.model, "query": texts[i], "documents": [texts[j] for j in pool[i]]},
            timeout=120,
            failed="The reranking service did not answer.",
        )
        scores = _embed_route.parse_rerank(answer, CANDIDATES)
        if scores is None:
            raise SystemExit(
                f"the reranker's answer for search {i} was not one score per candidate"
            )
        model = answer.get("model") if isinstance(answer, dict) else None
        return {
            "i": i,
            "pool": pool[i],
            "scores": scores,
            "model": model or args.model,
            "model_asked": args.model,
        }

    todo = [i for i in range(count) if i not in done]
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as ex:
        for n, row in enumerate(ex.map(one, todo), 1):
            done[row["i"]] = row
            if cache:
                cache.write(json.dumps(row) + "\n")
                cache.flush()
            if n % 50 == 0:
                print(f"{len(done)} of {count}", file=sys.stderr)

    models = sorted({done[i]["model"] for i in range(count)})
    if len(models) != 1:
        raise SystemExit("the answers name more than one reranker model")
    out = {
        "kind": "embeddings-tumbler/reference-rerank",
        "set": "demo-wikipedia.json",
        "set_model": meta["model"],
        "count": count,
        "reranker": models[0],
        "candidates": CANDIDATES,
        "query_text": "the point's own text (metadata.text), as for a search from a point",
        "candidate_text": "each candidate's metadata.text",
        "pool_rule": "the 50 nearest other points by dot product, nearest first; ties by index",
        "made": datetime.date.today().isoformat(),
        "pool": [done[i]["pool"] for i in range(count)],
        "scores": [[float(f"{s:.6g}") for s in done[i]["scores"]] for i in range(count)],
    }
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes), reranker {models[0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
