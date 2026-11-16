"""The relative-search fixtures keep the properties the tests that use them rely on."""

from __future__ import annotations

import array
import json
import math
import subprocess  # nosec B404 - runs this repository's own script
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "relative"


def load(name: str) -> tuple[dict, list[list[float]]]:
    meta = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((FIXTURES / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    dim = meta["dimension"]
    assert len(block) == meta["count"] * dim == meta["vectors"]["byte_length"] // 4
    return meta, [block[i * dim : (i + 1) * dim].tolist() for i in range(meta["count"])]


def lengths(rows: list[list[float]]) -> list[float]:
    return [math.sqrt(math.sumprod(r, r)) for r in rows]


def test_subset_is_unit_length_and_holds_rice_and_its_neighbours():
    meta, rows = load("wikipedia-subset")
    assert all(abs(v - 1) < 1e-3 for v in lengths(rows))
    labels = [p["label"] for p in meta["points"]]
    for name in ("Rice", "Cereal", "Wheat", "Maize", "Bean", "Bread"):
        assert name in labels


def test_mixed_lengths_spread_by_at_least_twenty_percent():
    _, rows = load("mixed-length")
    found = lengths(rows)
    assert (max(found) - min(found)) / max(found) >= 0.2


def test_mixed_nearest_by_cosine_is_not_highest_along_the_search():
    meta, rows = load("mixed-length")
    labels = [p["label"] for p in meta["points"]]
    found = lengths(rows)
    i = labels.index("Rice")
    unit = [x / found[i] for x in rows[i]]
    others = [j for j in range(len(rows)) if j != i]
    height = {j: math.sumprod(unit, rows[j]) for j in others}
    cosine = {j: height[j] / found[j] for j in others}
    assert max(others, key=cosine.get) != max(others, key=height.get)


def test_mixed_shares_items_and_directions_with_the_subset():
    meta_a, rows_a = load("wikipedia-subset")
    meta_b, rows_b = load("mixed-length")
    assert [p["id"] for p in meta_a["points"]] == [p["id"] for p in meta_b["points"]]
    for a, b in zip(rows_a[:20], rows_b[:20]):
        scale = math.sqrt(math.sumprod(b, b))
        assert math.sumprod(a, b) / scale > 0.999999


def test_fixtures_match_their_generator():
    out = subprocess.run(  # nosec B603 - fixed arguments
        [sys.executable, str(ROOT / "scripts" / "gen_relative_fixtures.py")],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    for name in ("wikipedia-subset", "mixed-length"):
        meta, _ = load(name)
        size = meta["vectors"]["byte_length"]
        assert f"{name}: {meta['count']} x {meta['dimension']}, {size} bytes" in out
