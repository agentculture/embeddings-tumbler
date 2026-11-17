#!/usr/bin/env python3
"""Attribute JavaScript test coverage to the source modules, for SonarCloud.

    ET_COVERAGE_DIR=js-coverage-generated \\
    node --test --experimental-test-coverage --test-reporter=lcov \\
         --test-reporter-destination=js-coverage.raw.lcov
    python3 scripts/js_coverage.py js-coverage.raw.lcov js-coverage.lcov js-coverage-generated

node reports covered lines against the files it ran, and the tests run the source modules in
two forms, neither of which is a module file:

- the assembled core file (``embeddings_tumbler/static/embeddings-tumbler.js``), a plain
  concatenation of ``js/src/NN-*.js`` behind a one-line banner (``scripts/assemble.py``), so
  each of its lines belongs to exactly one line of one module;
- generated files: module texts joined by the test helper (``loadSources`` and
  ``runAsFunction`` in ``js/test/helpers/load.js``), or a shell's text, wrapped in a function.
  With ``ET_COVERAGE_DIR`` set the helper keeps each one in that folder, with a map beside it
  (``<name>.sources.json``) that says which of its lines are which lines of which source file.

This script rewrites the report. Without generated files the assembled file's record is kept
as it is, and one record per module is added with the same hits at the module's own line
numbers. With them (the third argument is their folder), the hits of every generated file are
added, line by line, to the source file each line came from: a module's record is the sum of
what the assembled file and every generated file ran, the assembled file's record gets the
same sums at its own line numbers (it is the same text), and a source that is not a module
(a shell) gets a record of its own. The generated files' own records are dropped: they are
not source. Each map is checked against the files: a generated line that is not the source
line the map names is a mismatch. Paths are written relative to the repository root. Records
for other files pass through unchanged.

Sums are of what node reports. node joins the reports of the test processes by rule of
thumb, so a count is "at least once somewhere" rather than an exact number of runs; a
generated file is named per process, so its lines are summed here instead, exactly.
Branch records carry no position within a line, so the branches of one line are matched in
the order they are reported.

Every path (the two reports, the folder, each generated file, each source a map names) must
be inside the current folder after resolving symlinks; anything else is refused before a
file is read or written.

Exit codes: 0 written, 1 a path is outside the current folder, a map is missing or does not
match the files, or the report does not match the assembled file (rebuild it with
``python3 scripts/assemble.py`` and run the tests again).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import assemble  # noqa: E402  (scripts/assemble.py: the layout this file mirrors)

ASSEMBLED = assemble.OUT_FILE.relative_to(ROOT).as_posix()
MAP_SUFFIX = ".sources.json"


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
    return [_module_record(module, per[module]) for module, _, _ in spans if per.get(module)]


def _module_record(module: str, found: dict[str, list[str]]) -> list[str]:
    """The lcov record of one module from its FN, FNDA, DA and BRDA lines."""
    hit = sum(1 for d in found["DA"] if int(d.rsplit(",", 1)[1]) > 0)
    fn_hit = sum(1 for d in found["FNDA"] if int(d.split(":", 1)[1].split(",", 1)[0]) > 0)
    br_hit = sum(1 for d in found["BRDA"] if d.rsplit(",", 1)[1] not in ("-", "0"))
    return (
        ["TN:", f"SF:{module}"]
        + found["FN"]
        + found["FNDA"]
        + [f"FNF:{len(found['FN'])}", f"FNH:{fn_hit}"]
        + found["BRDA"]
        + [f"BRF:{len(found['BRDA'])}", f"BRH:{br_hit}"]
        + found["DA"]
        + [f"LF:{len(found['DA'])}", f"LH:{hit}", "end_of_record"]
    )


def _records(text: str) -> list[tuple[str, list[str]]]:
    """``(source path as written, lines)`` for each record of a report."""
    found: list[tuple[str, list[str]]] = []
    record: list[str] = []
    for raw in text.splitlines():
        record.append(raw)
        if raw.strip() != "end_of_record":
            continue
        source = next((x[3:] for x in record if x.startswith("SF:")), "")
        found.append((source, record))
        record = []
    return found


class Hits:
    """What ran in one file: line hits, branch hits per line, function hits."""

    def __init__(self) -> None:
        self.lines: dict[int, int] = {}
        self.branches: dict[int, list[int]] = {}
        self.functions: dict[tuple[int, str], int] = {}

    def __bool__(self) -> bool:
        return bool(self.lines or self.branches or self.functions)

    def add(self, other: Hits, shift: int = 0) -> None:
        """Add ``other``, whose line ``n`` is this file's line ``n + shift``."""
        for line, count in other.lines.items():
            self.lines[line + shift] = self.lines.get(line + shift, 0) + count
        for line, counts in other.branches.items():
            mine = self.branches.setdefault(line + shift, [])
            for at, count in enumerate(counts):
                if at < len(mine):
                    mine[at] += count
                else:
                    mine.append(count)
        for (line, name), count in other.functions.items():
            key = (line + shift, name)
            self.functions[key] = self.functions.get(key, 0) + count

    def window(self, first: int, count: int) -> Hits:
        """The part on lines ``first`` to ``first + count - 1``, renumbered from 1."""
        part = Hits()
        shift = 1 - first
        last = first + count
        part.lines = {n + shift: c for n, c in self.lines.items() if first <= n < last}
        part.branches = {n + shift: list(c) for n, c in self.branches.items() if first <= n < last}
        part.functions = {
            (n + shift, name): c for (n, name), c in self.functions.items() if first <= n < last
        }
        return part

    def record(self, path: str) -> list[str]:
        functions = sorted(self.functions.items())
        out = ["TN:", f"SF:{path}"]
        out += [f"FN:{line},{name}" for (line, name), _ in functions]
        out += [f"FNDA:{count},{name}" for (_, name), count in functions]
        out += [f"FNF:{len(functions)}", f"FNH:{sum(1 for _, c in functions if c > 0)}"]
        taken = [(line, count) for line in sorted(self.branches) for count in self.branches[line]]
        out += [f"BRDA:{line},{at},0,{count}" for at, (line, count) in enumerate(taken)]
        out += [f"BRF:{len(taken)}", f"BRH:{sum(1 for _, c in taken if c > 0)}"]
        out += [f"DA:{line},{self.lines[line]}" for line in sorted(self.lines)]
        hit = sum(1 for c in self.lines.values() if c > 0)
        return out + [f"LF:{len(self.lines)}", f"LH:{hit}", "end_of_record"]


def _count(value: str) -> int:
    return int(value) if value.strip().isdigit() else 0


def read_hits(lines: list[str]) -> Hits:
    """The hits of one record. A function's hits are paired with its line in report order."""
    hits = Hits()
    declared: list[tuple[int, str]] = []
    called: list[tuple[int, str]] = []
    for raw in lines:
        tag, _, rest = raw.partition(":")
        if tag == "DA":
            number, _, tail = rest.partition(",")
            line = int(number)
            hits.lines[line] = hits.lines.get(line, 0) + _count(tail.split(",")[0])
        elif tag == "BRDA":
            number, _, tail = rest.partition(",")
            hits.branches.setdefault(int(number), []).append(_count(tail.rsplit(",", 1)[-1]))
        elif tag == "FN":
            number, _, name = rest.partition(",")
            declared.append((int(number), name))
        elif tag == "FNDA":
            number, _, name = rest.partition(",")
            called.append((_count(number), name))
    in_step = [name for _, name in declared] == [name for _, name in called]
    by_name = {name: count for count, name in called}
    for at, (line, name) in enumerate(declared):
        count = called[at][0] if in_step else by_name.get(name, 0)
        hits.functions[(line, name)] = hits.functions.get((line, name), 0) + count
    return hits


def _source_lines(full: str) -> list[str]:
    with open(full, encoding="utf-8") as fh:
        return fh.read().split("\n")


def read_map(generated: str) -> list[tuple[str, int, int]]:
    """``(source path, first generated line, line count)`` from the map beside a generated file.

    ``generated`` is a real path inside the current folder. Every source the map names must
    be inside the current folder too (ValueError otherwise), and each of its lines must be
    the generated file's line the map says (Mismatch otherwise); a line holding the version
    token is the one line allowed to differ.
    """
    base = os.path.realpath(os.getcwd())
    name = os.path.relpath(generated, base).replace(os.sep, "/")
    stem = generated[: -len(".js")] if generated.endswith(".js") else generated
    try:
        with open(stem + MAP_SUFFIX, encoding="utf-8") as fh:
            entries = json.load(fh)["sources"]
        spans = [(str(e["path"]), int(e["first"]), int(e["count"])) for e in entries]
    except FileNotFoundError:
        raise Mismatch(f"{name} has no map ({MAP_SUFFIX})") from None
    except (KeyError, TypeError, ValueError) as err:
        raise Mismatch(f"the map of {name} is not readable: {err}") from err
    made = _source_lines(generated)
    checked = []
    for value, first, count in spans:
        full = inside_current_folder(value)
        rel = os.path.relpath(full, base).replace(os.sep, "/")
        own = _source_lines(full)
        if own and own[-1] == "":
            own.pop()
        if count != len(own) or first < 1 or first - 1 + count > len(made):
            raise Mismatch(f"the map of {name} does not fit {rel}")
        for at, text in enumerate(own):
            if made[first - 1 + at] != text and "@@VERSION@@" not in text:
                raise Mismatch(f"{name} line {first + at} is not {rel} line {at + 1}")
        checked.append((rel, first, count))
    return checked


def _generated_hits(found: list[tuple[str, list[str]]], folder: str) -> tuple[dict, set[int]]:
    """Hits per source path from the records of generated files, and which records those are."""
    base = os.path.realpath(os.getcwd())
    per: dict[str, Hits] = {}
    used: set[int] = set()
    for at, (source, lines) in enumerate(found):
        full = os.path.realpath(os.path.join(base, source))
        if not full.startswith(folder + os.sep):
            continue
        used.add(at)
        hits = read_hits(lines)
        for rel, first, count in read_map(full):
            per.setdefault(rel, Hits()).add(hits.window(first, count))
    return per, used


def _combine(found: list[tuple[str, list[str]]], per: dict[str, Hits], used: set[int]) -> str:
    """The report with the generated files' hits given to their sources."""
    spans = layout()
    modules = {path for path, _, _ in spans}
    out: list[str] = []
    written: set[str] = set()

    def assembled_records(own: Hits) -> None:
        whole = Hits()
        whole.add(own)
        parts = []
        for path, first, count in spans:
            part = own.window(first, count)
            extra = per.get(path)
            if extra:
                part.add(extra)
                whole.add(extra, first - 1)
            if part:
                parts.append(part.record(path))
        out.extend(whole.record(ASSEMBLED))
        for part in parts:
            out.extend(part)
        written.add(ASSEMBLED)
        written.update(modules)

    for at, (source, lines) in enumerate(found):
        if at in used:
            continue
        rel = relative(source)
        if rel == ASSEMBLED:
            for raw in lines:  # the same check as without generated files
                tag, _, rest = raw.partition(":")
                if tag in ("FN", "DA", "BRDA"):
                    locate(spans, int(rest.partition(",")[0]))
            assembled_records(read_hits(lines))
        elif rel in per and rel not in modules:
            both = read_hits(lines)
            both.add(per[rel])
            out.extend(both.record(rel))
            written.add(rel)
        else:
            out.extend(f"SF:{rel}" if x.startswith("SF:") else x for x in lines)
    if ASSEMBLED not in written and any(path in per for path in modules):
        assembled_records(Hits())
    for rel in sorted(per):
        if rel not in written:
            out.extend(per[rel].record(rel))
    return "\n".join(out) + "\n"


def convert(text: str, generated: str | None = None) -> str:
    """The rewritten report. ``generated`` is the real path of the generated files' folder."""
    found = _records(text)
    if generated is not None:
        per, used = _generated_hits(found, generated)
        if used:
            return _combine(found, per, used)
    spans = layout()
    out: list[str] = []
    for source, record in found:
        rel = relative(source)
        fixed = [f"SF:{rel}" if x.startswith("SF:") else x for x in record]
        out.extend(fixed)
        if rel == ASSEMBLED:
            for extra in split_record(record, spans):
                out.extend(extra)
    return "\n".join(out) + "\n"


def inside_current_folder(value: str) -> str:
    """The real path of ``value`` (symlinks followed); ValueError unless inside the current folder.

    SonarSource's documented path-traversal check: both paths through ``os.path.realpath``,
    then a plain ``startswith(base + os.sep)``.
    """
    base = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(base, value))
    if full.startswith(base + os.sep):
        return full
    raise ValueError(f"{value} is outside the current folder {base}")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (2, 3):
        print(
            "usage: js_coverage.py <node lcov report> <output lcov> [<folder of generated files>]",
            file=sys.stderr,
        )
        return 1
    try:
        report = inside_current_folder(args[0])
        output = inside_current_folder(args[1])
        generated = inside_current_folder(args[2]) if len(args) == 3 else None
        with open(report, encoding="utf-8") as fh:
            text = convert(fh.read(), generated)
    except (OSError, Mismatch, ValueError) as err:
        print(f"js_coverage: {err}", file=sys.stderr)
        return 1
    with open(output, "w", encoding="utf-8") as fh:
        fh.write(text)
    covered = [x[3:] for x in text.splitlines() if x.startswith("SF:")]
    print(f"js_coverage: wrote {args[1]} ({len(covered)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
