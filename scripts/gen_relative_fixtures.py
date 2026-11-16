#!/usr/bin/env python3
"""Make the two test fixtures for relative search from the shipped Wikipedia demo pair.

Both are written to ``tests/fixtures/relative/`` and follow the data contract:

- ``wikipedia-subset``: every "Everyday life" article and every eighth other article,
  with their vectors exactly as shipped (unit length).
- ``mixed-length``: the same items, each vector multiplied by the number of characters
  in its text divided by the longest text's. The directions are the model's; the lengths
  are not model output. It exists so tests can tell "length along the search" from cosine:
  its lengths spread by far more than 20 percent, and for the search Rice the item
  nearest by cosine is not the one highest along the search direction.

Standard library only; nothing is sent anywhere. Preview by default::

    python3 scripts/gen_relative_fixtures.py --apply
"""

from __future__ import annotations

import argparse
import array
import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "embeddings_tumbler" / "static"
OUT = ROOT / "tests" / "fixtures" / "relative"


def build() -> dict[str, tuple[dict, bytes]]:
    meta = json.loads((STATIC / "demo-wikipedia.json").read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((STATIC / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    dim = meta["dimension"]
    others = 0
    keep = []
    for i, point in enumerate(meta["points"]):
        if point.get("group") == "Everyday life":
            keep.append(i)
        else:
            if others % 8 == 0:
                keep.append(i)
            others += 1
    texts = [len(meta["points"][i]["metadata"]["text"]) for i in keep]
    longest = max(texts)

    def pair(name: str, scales: list[float], note: str, synthetic: bool) -> tuple[dict, bytes]:
        out = array.array("f")
        for i, scale in zip(keep, scales):
            out.extend(v * scale for v in block[i * dim : (i + 1) * dim])
        if sys.byteorder != "little":
            out.byteswap()
        data = out.tobytes()
        m = copy.deepcopy(meta)
        m["count"] = len(keep)
        m["points"] = [meta["points"][i] for i in keep]
        m["vectors"] = {**meta["vectors"], "file": name + ".f32", "byte_length": len(data)}
        m["provenance"] = {
            **meta["provenance"],
            "producer": "embeddings-tumbler scripts/gen_relative_fixtures.py",
            "synthetic": synthetic,
            "limitations": [note, *meta["provenance"].get("limitations", [])],
        }
        return m, data

    return {
        "wikipedia-subset": pair(
            "wikipedia-subset",
            [1.0] * len(keep),
            f"A test fixture: {len(keep)} of the demo set's items, vectors unchanged.",
            False,
        ),
        "mixed-length": pair(
            "mixed-length",
            [t / longest for t in texts],
            "A test fixture: each vector is the model's, multiplied by its text's length in "
            "characters divided by the longest text's. The lengths are not model output.",
            True,
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="write the fixtures")
    parser.add_argument("--force", action="store_true", help="overwrite existing fixtures")
    args = parser.parse_args()
    pairs = build()
    for name, (meta, data) in pairs.items():
        print(f"{name}: {meta['count']} x {meta['dimension']}, {len(data)} bytes")
    if not args.apply:
        print(f"would write to {OUT.relative_to(ROOT)} (pass --apply)")
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [OUT / (name + ext) for name in pairs for ext in (".json", ".f32")]
    if any(t.exists() for t in targets) and not args.force:
        print("fixtures exist; pass --force to overwrite", file=sys.stderr)
        return 1
    for name, (meta, data) in pairs.items():
        (OUT / (name + ".json")).write_text(
            json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        (OUT / (name + ".f32")).write_bytes(data)
    print(f"wrote {len(targets)} files to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
