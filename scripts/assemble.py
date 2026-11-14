#!/usr/bin/env python3
"""Assemble js/src/NN-name.js modules into the single embeddings-tumbler.js core file.

Plain concatenation in sorted filename order, behind a version-and-source banner.
The token @@VERSION@@ in a source module is replaced with pyproject.toml's version.
No transpiler, no minifier. Deterministic: same inputs, byte-identical output.

    python3 scripts/assemble.py           # write the assembled file
    python3 scripts/assemble.py --check   # exit 1 if the committed file is stale
"""

from __future__ import annotations

import argparse
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "js" / "src"
OUT_FILE = ROOT / "embeddings_tumbler" / "static" / "embeddings-tumbler.js"
SOURCE_REPO = "github.com/agentculture/embeddings-tumbler"


def read_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def banner(version: str) -> str:
    return (
        f"/*! embeddings-tumbler {version} | source: {SOURCE_REPO} | "
        "assembled from js/src by scripts/assemble.py, do not edit by hand */\n"
    )


def assemble() -> str:
    version = read_version()
    modules = sorted(SRC_DIR.glob("[0-9][0-9]-*.js"), key=lambda p: p.name)
    if not modules:
        raise SystemExit("assemble: no modules found in js/src")
    parts = [banner(version)]
    for path in modules:
        text = path.read_text(encoding="utf-8").replace("@@VERSION@@", version)
        parts.append(text if text.endswith("\n") else text + "\n")
    return "".join(parts)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="exit 1 if the output is stale")
    args = parser.parse_args(argv)
    fresh = assemble()
    if args.check:
        current = OUT_FILE.read_bytes() if OUT_FILE.exists() else b""
        if current != fresh.encode("utf-8"):
            print(
                "assemble: embeddings_tumbler/static/embeddings-tumbler.js is stale; "
                "run python3 scripts/assemble.py and commit it",
                file=sys.stderr,
            )
            return 1
        return 0
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_bytes(fresh.encode("utf-8"))
    print(f"assemble: wrote {OUT_FILE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
