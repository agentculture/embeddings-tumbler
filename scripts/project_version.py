#!/usr/bin/env python3
"""Read or set the version in pyproject.toml's [project] table, and only there.

    python3 scripts/project_version.py get                 # print [project].version
    python3 scripts/project_version.py set 0.10.1.dev42    # rewrite [project].version

Used by publish.yml's TestPyPI dev build. Unlike a ``sed 's/^version = .*/'``
one-liner, a ``version =`` line in any other table (``[tool.*]``) is never
touched: the line is found inside the ``[project]`` table, only its quoted value
is replaced, and the result is re-read with tomllib to prove it. Stdlib only.
"""

from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_TABLE_RE = re.compile(r"^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$")
_VERSION_RE = re.compile(r'^(\s*version\s*=\s*)"([^"\\]*)"')


def get_version(text: str) -> str:
    return tomllib.loads(text)["project"]["version"]


def set_version(text: str, new: str) -> str:
    """text with only [project].version replaced by new; ValueError if it has none."""
    lines = text.splitlines(keepends=True)
    table = None
    for i, line in enumerate(lines):
        header = _TABLE_RE.match(line)
        if header:
            table = header.group(1)
            continue
        if table == "project":
            match = _VERSION_RE.match(line)
            if match:
                lines[i] = match.group(1) + f'"{new}"' + line[match.end() :]
                updated = "".join(lines)
                if get_version(updated) != new:
                    raise ValueError("rewriting [project] version did not take effect")
                return updated
    raise ValueError('no `version = "..."` line in the [project] table')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("action", choices=["get", "set"])
    parser.add_argument("version", nargs="?")
    parser.add_argument("--file", type=Path, default=ROOT / "pyproject.toml")
    args = parser.parse_args(argv)
    text = args.file.read_text(encoding="utf-8")
    if args.action == "get":
        print(get_version(text))
        return 0
    if not args.version:
        parser.error("set needs a version")
    try:
        args.file.write_text(set_version(text, args.version), encoding="utf-8")
    except (ValueError, KeyError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"[project] version: {get_version(text)} -> {args.version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
