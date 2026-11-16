#!/usr/bin/env python3
"""Measure what relative search sees in a viewer data pair.

For a data file pair (``<name>.json`` and its float32 block) this prints, and with
``--apply`` writes as JSON:

- the range of vector lengths and whether the set is unit length;
- the length of the mean vector (how far the set leans from the origin);
- for each search (an item's label): the nearest items, and the lowest, median and
  highest cosine to it over all other items;
- the share of the set's variance held by its 8 strongest directions, and, for each
  search, the share of what remains after the search direction is removed that the 8
  strongest remaining directions hold.

Standard library only. It reads local files and sends nothing anywhere. The figures in
``docs/evidence/2026-11-relative-search.md`` come from this script::

    python3 scripts/measure_relative.py embeddings_tumbler/static/demo-wikipedia.json \
        --search Rice --search Jazz --search Volcano
"""

from __future__ import annotations

import argparse
import array
import json
import math
import random
import sys
from pathlib import Path

SUBSPACE = 8
OVERSAMPLE = 4
ITERATIONS = 14
UNIT_TOLERANCE = 1e-3


def load_pair(path: Path) -> tuple[dict, list[list[float]]]:
    meta = json.loads(path.read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((path.parent / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    count, dim = meta["count"], meta["dimension"]
    if len(block) != count * dim:
        raise SystemExit("the vector block does not match count x dimension")
    return meta, [block[i * dim : (i + 1) * dim].tolist() for i in range(count)]


def orthonormalize(rows: list[list[float]]) -> None:
    for a, row in enumerate(rows):
        for _ in range(2):
            for other in rows[:a]:
                t = math.sumprod(row, other)
                row[:] = [x - t * y for x, y in zip(row, other)]
        norm = math.sqrt(math.sumprod(row, row))
        if norm > 1e-12:
            row[:] = [x / norm for x in row]


def strongest_share(rows: list[list[float]], remove: list[float] | None, seed: int) -> float:
    """Share of the centred remainder's variance in its SUBSPACE strongest directions."""
    if remove is not None:
        rows = [
            [x - t * u for x, u in zip(row, remove)]
            for row in rows
            for t in [math.sumprod(row, remove)]
        ]
    count, dim = len(rows), len(rows[0])
    mean = [sum(col) / count for col in zip(*rows)]
    centred = [[x - m for x, m in zip(row, mean)] for row in rows]
    columns = [list(col) for col in zip(*centred)]
    total = sum(math.sumprod(row, row) for row in centred)
    rng = random.Random(seed)  # nosec B311 - a seed for a numerical start, not security
    basis = [[rng.gauss(0, 1) for _ in range(dim)] for _ in range(SUBSPACE + OVERSAMPLE)]
    orthonormalize(basis)
    for _ in range(ITERATIONS):
        weights = [[math.sumprod(row, q) for row in centred] for q in basis]
        basis = [[math.sumprod(w, col) for col in columns] for w in weights]
        orthonormalize(basis)
    held = sorted((sum(math.sumprod(row, q) ** 2 for row in centred) for q in basis), reverse=True)
    return sum(held[:SUBSPACE]) / total if total > 0 else 0.0


def measure(path: Path, searches: list[str], seed: int) -> dict:
    meta, rows = load_pair(path)
    labels = [str(p.get("label", p["id"])) for p in meta["points"]]
    lengths = [math.sqrt(math.sumprod(r, r)) for r in rows]
    count = len(rows)
    mean = [sum(col) / count for col in zip(*rows)]
    out = {
        "file": path.name,
        "model": meta["model"],
        "dimension": meta["dimension"],
        "count": count,
        "length_min": min(lengths),
        "length_max": max(lengths),
        "unit_length": all(abs(v - 1) <= UNIT_TOLERANCE for v in lengths),
        "mean_length": math.sqrt(math.sumprod(mean, mean)),
        "plain_share": strongest_share(rows, None, seed),
        "subspace": SUBSPACE,
        "seed": seed,
        "searches": [],
    }
    for name in searches:
        if name not in labels:
            raise SystemExit(f"no item is labelled {name!r}")
        i = labels.index(name)
        unit = [x / lengths[i] for x in rows[i]]
        cosines = sorted(
            ((math.sumprod(unit, r) / lengths[j], labels[j]) for j, r in enumerate(rows) if j != i),
            reverse=True,
        )
        out["searches"].append(
            {
                "search": name,
                "nearest": [[label, round(c, 4)] for c, label in cosines[:8]],
                "cosine_max": cosines[0][0],
                "cosine_median": cosines[len(cosines) // 2][0],
                "cosine_min": cosines[-1][0],
                "remainder_share": strongest_share(rows, unit, seed),
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("data", type=Path, help="the data JSON file of a pair")
    parser.add_argument(
        "--search", action="append", default=[], help="an item's label (repeatable)"
    )
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, help="where --apply writes the measurements as JSON")
    parser.add_argument(
        "--apply", action="store_true", help="write --out (the default only prints)"
    )
    parser.add_argument("--force", action="store_true", help="overwrite an existing --out file")
    args = parser.parse_args()

    result = measure(args.data, args.search, args.seed)
    print(f"{result['file']}: {result['count']} x {result['dimension']} from {result['model']}")
    unit = "yes" if result["unit_length"] else "no"
    print(
        f"  lengths {result['length_min']:.4f} to {result['length_max']:.4f} (unit length: {unit});"
        f" mean vector length {result['mean_length']:.3f}"
    )
    print(f"  {SUBSPACE} strongest directions hold {result['plain_share']:.1%} of the spread")
    for s in result["searches"]:
        nearest = ", ".join(f"{label} {c:.3f}" for label, c in s["nearest"][:5])
        print(
            f"  {s['search']}: cosine {s['cosine_min']:.3f} to {s['cosine_max']:.3f},"
            f" median {s['cosine_median']:.3f}; remainder share {s['remainder_share']:.1%};"
            f" nearest {nearest}"
        )
    if args.apply:
        if not args.out:
            print("--apply needs --out", file=sys.stderr)
            return 1
        if args.out.exists() and not args.force:
            print(f"{args.out} exists; pass --force to overwrite", file=sys.stderr)
            return 1
        args.out.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
