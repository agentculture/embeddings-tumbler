#!/usr/bin/env python3
"""Carry pyproject.toml's version into package.json.

    python3 scripts/sync_version.py          # write the version into package.json
    python3 scripts/sync_version.py --check  # exit 1 if package.json is out of step

pyproject.toml is the single source of the version. The vendored version-bump
skill updates pyproject.toml and CHANGELOG.md but predates package.json, so after
a bump run this script (and ``scripts/assemble.py``, which stamps the version
into the core file's header). Only the top-level version value in package.json
changes (located by parsing, never by the first match in file order); its
formatting and key order are kept. Stdlib only.
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


def top_level_value_span(text: str, key: str) -> tuple[int, int] | None:
    """(start, end) of the value of a top-level key in a JSON object text, or None.

    Walks the top-level object with the stdlib decoder, so a nested object's
    ``"version"`` earlier in the file is never mistaken for the top-level one.
    """
    decoder = json.JSONDecoder()
    ws = re.compile(r"\s*")
    pos = ws.match(text, 0).end()
    if text[pos : pos + 1] != "{":
        raise ValueError("package.json is not a JSON object")
    pos = ws.match(text, pos + 1).end()
    if text[pos : pos + 1] == "}":
        return None
    while True:
        if text[pos : pos + 1] != '"':
            raise ValueError(f"expected a key at offset {pos}")
        name, pos = json.decoder.scanstring(text, pos + 1)
        pos = ws.match(text, pos).end()
        if text[pos : pos + 1] != ":":
            raise ValueError(f"expected ':' at offset {pos}")
        start = ws.match(text, pos + 1).end()
        _, end = decoder.raw_decode(text, start)
        if name == key:
            return start, end
        pos = ws.match(text, end).end()
        if text[pos : pos + 1] == "}":
            return None
        if text[pos : pos + 1] != ",":
            raise ValueError(f"expected ',' or '}}' at offset {pos}")
        pos = ws.match(text, pos + 1).end()


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
    span = top_level_value_span(text, "version")
    if span is None:
        print("error: package.json has no top-level version key", file=sys.stderr)
        return 1
    updated = text[: span[0]] + json.dumps(wanted) + text[span[1] :]
    if json.loads(updated).get("version") != wanted:  # pragma: no cover - defensive
        print("error: rewriting package.json's top-level version failed", file=sys.stderr)
        return 1
    PACKAGE_JSON.write_text(updated, encoding="utf-8")
    print(f"package.json: {current} -> {wanted}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
