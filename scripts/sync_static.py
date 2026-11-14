#!/usr/bin/env python3
"""Copy the shell and standalone-page sources to the wheel's static folder.

    python3 scripts/sync_static.py          # write the shipped copies
    python3 scripts/sync_static.py --check  # exit 1 if any shipped copy is stale

Every file directly under ``js/shells/`` and ``js/page/`` (except Markdown) is
shipped, byte-identical and under its own name, in ``embeddings_tumbler/static/``.
The core file is built by ``scripts/assemble.py`` and the sample set is copied
by ``scripts/sync_sample.py``; this script never touches those two.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIRS = (ROOT / "js" / "shells", ROOT / "js" / "page")
SHIPPED_DIR = ROOT / "embeddings_tumbler" / "static"
RESERVED = frozenset({"embeddings-tumbler.js", "sample-data.js"})


def sources() -> list[Path]:
    """The source files to ship, sorted by name. A duplicate name is an error."""
    found: dict[str, Path] = {}
    for folder in SOURCE_DIRS:
        if not folder.is_dir():
            continue
        for path in sorted(folder.iterdir()):
            if not path.is_file() or path.suffix == ".md" or path.name.startswith("."):
                continue
            if path.name in RESERVED or path.name in found:
                raise SystemExit(f"error: {path} clashes with another shipped file name")
            found[path.name] = path
    return [found[name] for name in sorted(found)]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    check = "--check" in args
    stale = []
    for source in sources():
        shipped = SHIPPED_DIR / source.name
        if shipped.exists() and shipped.read_bytes() == source.read_bytes():
            continue
        if check:
            stale.append(source.name)
        else:
            shipped.write_bytes(source.read_bytes())
    if stale:
        print(f"stale: {', '.join(stale)}; run python3 scripts/sync_static.py", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
