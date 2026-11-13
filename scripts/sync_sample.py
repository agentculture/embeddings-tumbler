#!/usr/bin/env python3
"""Copy js/sample/sample-data.js to the wheel's static folder.

    python3 scripts/sync_sample.py          # write the shipped copy
    python3 scripts/sync_sample.py --check  # exit 1 if the shipped copy is stale

The shipped copy is byte-identical to the source; a pytest fails when it is stale.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "js" / "sample" / "sample-data.js"
SHIPPED = ROOT / "embeddings_tumbler" / "static" / "sample-data.js"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--check" in args:
        if SHIPPED.exists() and SHIPPED.read_bytes() == SOURCE.read_bytes():
            return 0
        print("stale: run python3 scripts/sync_sample.py", file=sys.stderr)
        return 1
    SHIPPED.write_bytes(SOURCE.read_bytes())
    return 0


if __name__ == "__main__":
    sys.exit(main())
