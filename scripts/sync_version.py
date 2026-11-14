#!/usr/bin/env python3
"""Carry pyproject.toml's version into package.json.

    python3 scripts/sync_version.py          # write the version into package.json
    python3 scripts/sync_version.py --check  # exit 1 if package.json is out of step

pyproject.toml is the single source of the version. The vendored version-bump
skill updates pyproject.toml and CHANGELOG.md but predates package.json, so after
a bump run this script (and ``scripts/assemble.py``, which stamps the version
into the core file's header). Only the version string in package.json changes;
its formatting and key order are kept. Stdlib only.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = ROOT / "pyproject.toml"
PACKAGE_JSON = ROOT / "package.json"


def pyproject_version() -> str:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]["version"]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    wanted = pyproject_version()
    text = PACKAGE_JSON.read_text(encoding="utf-8")
    current = json.loads(text).get("version")
    if current == wanted:
        return 0
    if "--check" in args:
        print(
            f"package.json version {current} != pyproject.toml version {wanted}; "
            "run python3 scripts/sync_version.py",
            file=sys.stderr,
        )
        return 1
    pattern = re.compile(r'("version"\s*:\s*")' + re.escape(str(current)) + r'"')
    updated, count = pattern.subn(lambda m: m.group(1) + wanted + '"', text, count=1)
    if count != 1 or json.loads(updated).get("version") != wanted:
        print("error: could not find the top-level version in package.json", file=sys.stderr)
        return 1
    PACKAGE_JSON.write_text(updated, encoding="utf-8")
    print(f"package.json: {current} -> {wanted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
