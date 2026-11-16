#!/usr/bin/env python3
"""Measure what relative search sees in a viewer data pair.

For a data file pair (``<name>.json`` and its float32 block) this prints, and with
``--apply`` writes as JSON:

- the range of vector lengths and whether the set is unit length;
- the length of the mean vector (how far the set leans from the origin);
- for each search (an item's label): the nearest items, and the lowest, median and
  highest cosine to it over all other items;
- the share of the set's variance held by its 8 strongest directions, and, for each
  search, two shares of what remains after the search directions are removed (the
  remainder): the share its own 8 strongest directions hold (a full fit of the
  remainder), and the share the set's 8 strongest directions hold once the search
  directions are removed from them (what the viewer tours since the deviation d4 of
  2026-11-17: the plain fit reused).

A search is an item's label, or several labels joined by ``+`` (``Rice+Wheat``): their
directions are taken in order and made orthonormal, as the viewer pins them.

Standard library only. It reads local files and sends nothing anywhere. The figures in
``docs/evidence/2026-11-relative-search.md`` come from this script::

    python3 scripts/measure_relative.py embeddings_tumbler/static/demo-wikipedia.json \
        --search Rice --search Jazz --search Volcano --search Rice+Wheat
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
SAME_DIRECTION = 1e-6  # ET.math.RELATIVE_SAME_DIRECTION
PLAIN_KEEP = 1e-3  # the viewer's tolerance for keeping a plain direction (10-math.js)


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


def remove_directions(row: list[float], directions: list[list[float]]) -> list[float]:
    """The row with its components along the orthonormal directions removed, twice."""
    for _ in range(2):
        for u in directions:
            t = math.sumprod(row, u)
            row = [x - t * y for x, y in zip(row, u)]
    return row


def centred(rows: list[list[float]]) -> list[list[float]]:
    count = len(rows)
    mean = [sum(col) / count for col in zip(*rows)]
    return [[x - m for x, m in zip(row, mean)] for row in rows]


def strongest(rows: list[list[float]], seed: int) -> tuple[list[list[float]], float]:
    """The SUBSPACE strongest directions of centred rows (strongest first), and the total."""
    dim = len(rows[0])
    columns = [list(col) for col in zip(*rows)]
    total = sum(math.sumprod(row, row) for row in rows)
    rng = random.Random(seed)  # nosec B311 - a seed for a numerical start, not security
    basis = [[rng.gauss(0, 1) for _ in range(dim)] for _ in range(SUBSPACE + OVERSAMPLE)]
    orthonormalize(basis)
    for _ in range(ITERATIONS):
        weights = [[math.sumprod(row, q) for row in rows] for q in basis]
        basis = [[math.sumprod(w, col) for col in columns] for w in weights]
        orthonormalize(basis)
    held = [held_by(rows, q) for q in basis]
    order = sorted(range(len(basis)), key=lambda k: -held[k])
    return [basis[k] for k in order[:SUBSPACE]], total


def held_by(rows: list[list[float]], q: list[float]) -> float:
    return sum(math.sumprod(row, q) ** 2 for row in rows)


def share_of(rows: list[list[float]], basis: list[list[float]], total: float) -> float:
    return sum(held_by(rows, q) for q in basis) / total if total > 0 else 0.0


def search_directions(vectors: list[list[float]]) -> list[list[float]]:
    """Search directions in order, made orthonormal; one pointing the same way is dropped."""
    pinned: list[list[float]] = []
    for v in vectors:
        length = math.sqrt(math.sumprod(v, v))
        u = remove_directions([x / length for x in v], pinned)
        norm = math.sumprod(u, u)
        if norm >= SAME_DIRECTION and len(pinned) < 3:
            pinned.append([x / math.sqrt(norm) for x in u])
    return pinned


def plain_without(plain: list[list[float]], pinned: list[list[float]]) -> list[list[float]]:
    """The plain directions with the pinned ones removed, as the viewer builds its basis."""
    kept: list[list[float]] = []
    for q in plain:
        before = math.sumprod(q, q)
        v = remove_directions(list(q), pinned + kept)
        norm = math.sumprod(v, v)
        if before > 0 and norm >= PLAIN_KEEP * before:
            kept.append([x / math.sqrt(norm) for x in v])
    return kept[:SUBSPACE]


def measure(path: Path, searches: list[str], seed: int) -> dict:
    meta, rows = load_pair(path)
    labels = [str(p.get("label", p["id"])) for p in meta["points"]]
    lengths = [math.sqrt(math.sumprod(r, r)) for r in rows]
    count = len(rows)
    mean = [sum(col) / count for col in zip(*rows)]
    centred_rows = centred(rows)
    plain, plain_total = strongest(centred_rows, seed)
    out = {
        "file": path.name,
        "model": meta["model"],
        "dimension": meta["dimension"],
        "count": count,
        "length_min": min(lengths),
        "length_max": max(lengths),
        "unit_length": all(abs(v - 1) <= UNIT_TOLERANCE for v in lengths),
        "mean_length": math.sqrt(math.sumprod(mean, mean)),
        "plain_share": share_of(centred_rows, plain, plain_total),
        "subspace": SUBSPACE,
        "seed": seed,
        "searches": [],
    }
    for search in searches:
        names = search.split("+")
        for name in names:
            if name not in labels:
                raise SystemExit(f"no item is labelled {name!r}")
        i = labels.index(names[0])
        unit = [x / lengths[i] for x in rows[i]]
        cosines = sorted(
            ((math.sumprod(unit, r) / lengths[j], labels[j]) for j, r in enumerate(rows) if j != i),
            reverse=True,
        )
        pinned = search_directions([rows[labels.index(name)] for name in names])
        remainder = [remove_directions(row, pinned) for row in centred_rows]
        own, total = strongest(remainder, seed)
        reused = plain_without(plain, pinned)
        out["searches"].append(
            {
                "search": search,
                "pinned": len(pinned),
                "nearest": [[label, round(c, 4)] for c, label in cosines[:8]],
                "cosine_max": cosines[0][0],
                "cosine_median": cosines[len(cosines) // 2][0],
                "cosine_min": cosines[-1][0],
                "remainder_share": share_of(remainder, own, total),
                "reused_share": share_of(remainder, reused, total),
                "reused_directions": len(reused),
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
        ratio = s["reused_share"] / s["remainder_share"] if s["remainder_share"] > 0 else 0.0
        print(
            f"    remainder held by its own {SUBSPACE} strongest directions (full fit)"
            f" {s['remainder_share']:.4f}; by the set's {SUBSPACE} strongest with the"
            f" search removed ({s['reused_directions']} kept) {s['reused_share']:.4f}"
            f" ({ratio:.2%} of the full fit)"
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
