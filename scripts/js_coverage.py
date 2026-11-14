#!/usr/bin/env python3
"""Attribute JavaScript test coverage to the source modules, for SonarCloud.

    node --test --experimental-test-coverage --test-reporter=lcov \\
         --test-reporter-destination=js-coverage.raw.lcov
    python3 scripts/js_coverage.py js-coverage.raw.lcov js-coverage.lcov

The unit tests run the assembled core file (``embeddings_tumbler/static/embeddings-tumbler.js``),
so node reports every covered line against that one file. The file is a plain
concatenation of ``js/src/NN-*.js`` behind a one-line banner (``scripts/assemble.py``), so
each of its lines belongs to exactly one line of one module. This script rewrites the
report: the assembled file's record is kept as it is, and one record per module is added
with the same hits at the module's own line numbers. Paths are written relative to the
repository root. Records for other files pass through unchanged.

Exit codes: 0 written, 1 the report does not match the assembled file (rebuild it with
``python3 scripts/assemble.py`` and run the tests again).
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import assemble  # noqa: E402  (scripts/assemble.py: the layout this file mirrors)

ASSEMBLED = assemble.OUT_FILE.relative_to(ROOT).as_posix()


class Mismatch(Exception):
    """The report cannot belong to the assembled file as it is on disk."""


def layout() -> list[tuple[str, int, int]]:
    """``(module path, first assembled line, line count)`` for each module, in order."""
    version = assemble.read_version()
    line = assemble.banner(version).count("\n") + 1
    spans = []
    for path in sorted(assemble.SRC_DIR.glob("[0-9][0-9]-*.js"), key=lambda p: p.name):
        text = path.read_text(encoding="utf-8")
        count = text.count("\n") + (0 if text.endswith("\n") else 1)
        spans.append((path.relative_to(ROOT).as_posix(), line, count))
        line += count
    return spans


def locate(spans: list[tuple[str, int, int]], line: int) -> tuple[str, int] | None:
    """The module and module line of an assembled line; ``None`` for the banner."""
    for path, first, count in spans:
        if first <= line < first + count:
            return path, line - first + 1
    if line < spans[0][1]:
        return None
    raise Mismatch(f"line {line} is beyond the end of the assembled file")


def relative(path: str) -> str:
    candidate = Path(path)
    if candidate.is_absolute():
        try:
            return candidate.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            return path
    return candidate.as_posix()


def split_record(lines: list[str], spans: list[tuple[str, int, int]]) -> list[list[str]]:
    """One record per module from the assembled file's record."""
    per: dict[str, dict[str, list[str]]] = {}
    names: dict[str, str] = {}  # function name -> module

    def bucket(module: str) -> dict[str, list[str]]:
        return per.setdefault(module, {"FN": [], "FNDA": [], "DA": [], "BRDA": []})

    for raw in lines:
        tag, _, rest = raw.partition(":")
        if tag in ("FN", "DA", "BRDA"):
            number, _, tail = rest.partition(",")
            found = locate(spans, int(number))
            if found is None:
                continue
            module, own = found
            bucket(module)[tag].append(f"{tag}:{own},{tail}")
            if tag == "FN":
                names[tail] = module
        elif tag == "FNDA":
            _, _, name = rest.partition(",")
            if name in names:
                bucket(names[name])["FNDA"].append(raw)
    records = []
    for module, _, _ in spans:
        found = per.get(module)
        if not found:
            continue
        hit = sum(1 for d in found["DA"] if int(d.rsplit(",", 1)[1]) > 0)
        fn_hit = sum(1 for d in found["FNDA"] if int(d.split(":", 1)[1].split(",", 1)[0]) > 0)
        br_hit = sum(1 for d in found["BRDA"] if d.rsplit(",", 1)[1] not in ("-", "0"))
        records.append(
            ["TN:", f"SF:{module}"]
            + found["FN"]
            + found["FNDA"]
            + [f"FNF:{len(found['FN'])}", f"FNH:{fn_hit}"]
            + found["BRDA"]
            + [f"BRF:{len(found['BRDA'])}", f"BRH:{br_hit}"]
            + found["DA"]
            + [f"LF:{len(found['DA'])}", f"LH:{hit}", "end_of_record"]
        )
    return records


def convert(text: str) -> str:
    spans = layout()
    out: list[str] = []
    record: list[str] = []
    for raw in text.splitlines():
        record.append(raw)
        if raw.strip() != "end_of_record":
            continue
        source = next((x[3:] for x in record if x.startswith("SF:")), "")
        rel = relative(source)
        fixed = [f"SF:{rel}" if x.startswith("SF:") else x for x in record]
        out.extend(fixed)
        if rel == ASSEMBLED:
            for extra in split_record(record, spans):
                out.extend(extra)
        record = []
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: js_coverage.py <node lcov report> <output lcov>", file=sys.stderr)
        return 1
    try:
        text = convert(Path(args[0]).read_text(encoding="utf-8"))
    except (OSError, Mismatch, ValueError) as err:
        print(f"js_coverage: {err}", file=sys.stderr)
        return 1
    Path(args[1]).write_text(text, encoding="utf-8")
    covered = [x[3:] for x in text.splitlines() if x.startswith("SF:")]
    print(f"js_coverage: wrote {args[1]} ({len(covered)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
