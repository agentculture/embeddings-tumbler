"""scripts/js_coverage.py: coverage of the assembled file attributed to its modules."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "js_coverage.py"
RAW, OUT = "raw.lcov", "out.lcov"

spec = importlib.util.spec_from_file_location("js_coverage", SCRIPT)
cov = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cov)


def test_the_layout_covers_the_assembled_file_exactly() -> None:
    spans = cov.layout()
    assembled = (ROOT / cov.ASSEMBLED).read_text(encoding="utf-8").splitlines()
    assert spans[0][1] == 2  # line 1 is the banner
    last_path, last_first, last_count = spans[-1]
    assert last_first + last_count - 1 == len(assembled)
    # Every module's first and last line sits where the layout says.
    for path, first, count in spans:
        source = (ROOT / path).read_text(encoding="utf-8").splitlines()
        assert len(source) == count
        for own in (1, count):
            if "@@VERSION@@" in source[own - 1]:
                continue
            assert assembled[first + own - 2] == source[own - 1], (path, own)


def test_locate_maps_lines_and_skips_the_banner() -> None:
    spans = cov.layout()
    assert cov.locate(spans, 1) is None
    path, first, count = spans[1]
    assert cov.locate(spans, first) == (path, 1)
    assert cov.locate(spans, first + count - 1) == (path, count)
    assert cov.locate(spans, first - 1)[0] == spans[0][0]


def _report(first: int) -> str:
    absolute = ROOT / cov.ASSEMBLED
    return "\n".join(
        [
            "TN:",
            f"SF:{absolute}",
            f"FN:{first},alpha",
            "FNDA:3,alpha",
            f"DA:{first},3",
            f"DA:{first + 1},0",
            f"BRDA:{first},0,0,1",
            "LF:2",
            "LH:1",
            "end_of_record",
            "TN:",
            "SF:js/sample/sample-data.js",
            "DA:1,1",
            "LF:1",
            "LH:1",
            "end_of_record",
            "",
        ]
    )


def test_convert_adds_a_record_per_module_and_keeps_the_others() -> None:
    spans = cov.layout()
    path, first, _ = spans[2]
    text = cov.convert(_report(first))
    records = [r.strip().splitlines() for r in text.split("end_of_record") if r.strip()]
    by_file = {next(x[3:] for x in r if x.startswith("SF:")): r for r in records}
    assert set(by_file) == {cov.ASSEMBLED, path, "js/sample/sample-data.js"}
    module = by_file[path]
    assert "FN:1,alpha" in module
    assert "FNDA:3,alpha" in module
    assert "DA:1,3" in module
    assert "DA:2,0" in module
    assert "BRDA:1,0,0,1" in module
    assert "LF:2" in module
    assert "LH:1" in module
    # The assembled file's own record is kept, with a repository-relative path.
    assert f"DA:{first},3" in by_file[cov.ASSEMBLED]


def test_a_report_longer_than_the_file_is_refused(tmp_path: Path) -> None:
    bad = tmp_path / RAW
    bad.write_text(_report(10_000_000), encoding="utf-8")
    done = _run(tmp_path, RAW, OUT)
    assert done.returncode == 1
    assert "beyond the end" in done.stderr
    assert not (tmp_path / OUT).exists()


def _run(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    # Both paths must be inside the folder the script runs from.
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False, cwd=cwd
    )


def test_a_report_is_converted_and_written(tmp_path: Path) -> None:
    first = cov.layout()[2][1]
    (tmp_path / RAW).write_text(_report(first), encoding="utf-8")
    done = _run(tmp_path, RAW, OUT)
    assert done.returncode == 0, done.stderr
    assert done.stdout == f"js_coverage: wrote {OUT} (3 files)\n"
    assert (tmp_path / OUT).read_text(encoding="utf-8") == cov.convert(_report(first))


def test_paths_outside_the_current_folder_are_refused(tmp_path: Path) -> None:
    here = tmp_path / "here"
    here.mkdir()
    (tmp_path / RAW).write_text(_report(cov.layout()[2][1]), encoding="utf-8")
    (here / RAW).write_text(_report(cov.layout()[2][1]), encoding="utf-8")
    for args in (("../" + RAW, OUT), (RAW, str(tmp_path / OUT))):
        done = _run(here, *args)
        assert done.returncode == 1
        assert "is outside the current folder" in done.stderr
    assert not (here / OUT).exists()
    assert not (tmp_path / OUT).exists()


# --- generated files: text the test helper wrote for require(), with a map to its sources.

GEN = "generated"
HEADER, MATH, FOOTER = "js/src/00-header.js", "js/src/10-math.js", "js/src/99-footer.js"
SHELL = "js/shells/web-component.js"


def _lines(path: str) -> list[str]:
    return (ROOT / path).read_text(encoding="utf-8").splitlines()


def _generate(cwd: Path, name: str, sources: list[str]) -> dict[str, int]:
    """Write a generated file and its map as the helper does; the first line of each source."""
    for path in sources:
        (cwd / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / path, cwd / path)
    made = ["module.exports = function (module, console) {"]
    entries, firsts = [], {}
    for path in sources:
        own = _lines(path)
        firsts[path] = len(made) + 1
        entries.append({"path": path, "first": firsts[path], "count": len(own)})
        made += [x.replace("@@VERSION@@", "9.9.9") for x in own] + [""]
    made += ["};"]
    folder = cwd / GEN
    folder.mkdir(exist_ok=True)
    (folder / f"{name}.js").write_text("\n".join(made) + "\n", encoding="utf-8")
    payload = {"generated": f"{name}.js", "label": "sources", "sources": entries}
    (folder / f"{name}.sources.json").write_text(json.dumps(payload), encoding="utf-8")
    return firsts


def _record(path: str, lines: list[str]) -> str:
    return "\n".join(["TN:", f"SF:{path}", *lines, "end_of_record"]) + "\n"


def _by_file(text: str) -> dict[str, list[str]]:
    records = [r.strip().splitlines() for r in text.split("end_of_record") if r.strip()]
    return {next(x[3:] for x in r if x.startswith("SF:")): r for r in records}


def _convert(cwd: Path, monkeypatch, report: str) -> dict[str, list[str]]:
    monkeypatch.chdir(cwd)
    return _by_file(cov.convert(report, str((cwd / GEN).resolve())))


def test_two_generated_files_and_the_assembled_file_sum_on_a_module_line(
    tmp_path: Path, monkeypatch
) -> None:
    spans = {path: first for path, first, _ in cov.layout()}
    one = _generate(tmp_path, "aaaa-1", [HEADER, MATH, FOOTER])
    two = _generate(tmp_path, "bbbb-2", [HEADER, MATH, FOOTER])
    at = spans[MATH]  # the assembled line of the module's first line
    report = (
        _record(str(ROOT / cov.ASSEMBLED), ["DA:1,7", f"DA:{at + 4},3", f"DA:{at + 5},0"])
        + _record(
            f"{GEN}/aaaa-1.js",
            # Line 1 is the wrapper: it belongs to no source and is dropped.
            ["DA:1,9", f"DA:{one[MATH] + 4},2", f"DA:{one[MATH] + 5},0", f"DA:{one[MATH] + 6},5"],
        )
        + _record(f"{GEN}/bbbb-2.js", [f"DA:{two[MATH] + 4},10", f"DA:{two[MATH] + 5},0"])
        + _record("js/sample/sample-data.js", ["DA:1,1", "LF:1", "LH:1"])
    )
    by_file = _convert(tmp_path, monkeypatch, report)
    # The generated files' own records are dropped; the others stay.
    assert set(by_file) == {cov.ASSEMBLED, MATH, "js/sample/sample-data.js"}
    module = by_file[MATH]
    assert [x for x in module if x.startswith("DA:")] == ["DA:5,15", "DA:6,0", "DA:7,5"]
    assert "LF:3" in module
    assert "LH:2" in module
    # The assembled file is the same text, so it gets the same sums at its own lines.
    assembled = [x for x in by_file[cov.ASSEMBLED] if x.startswith("DA:")]
    assert assembled == ["DA:1,7", f"DA:{at + 4},15", f"DA:{at + 5},0", f"DA:{at + 6},5"]
    assert by_file["js/sample/sample-data.js"] == ["TN:", "SF:js/sample/sample-data.js"] + [
        "DA:1,1",
        "LF:1",
        "LH:1",
    ]


def test_a_partial_module_list_reaches_only_its_own_modules(tmp_path: Path, monkeypatch) -> None:
    spans = {path: first for path, first, _ in cov.layout()}
    firsts = _generate(tmp_path, "cccc-3", [HEADER, FOOTER])
    report = _record(str(ROOT / cov.ASSEMBLED), [f"DA:{spans[MATH]},4"]) + _record(
        f"{GEN}/cccc-3.js", [f"DA:{firsts[HEADER]},1", f"DA:{firsts[FOOTER] + 1},6"]
    )
    by_file = _convert(tmp_path, monkeypatch, report)
    assert set(by_file) == {cov.ASSEMBLED, HEADER, MATH, FOOTER}
    assert "DA:1,4" in by_file[MATH]
    assert "LF:1" in by_file[MATH]
    assert "DA:1,1" in by_file[HEADER]
    assert "DA:2,6" in by_file[FOOTER]
    assert f"DA:{spans[FOOTER] + 1},6" in by_file[cov.ASSEMBLED]


def test_functions_and_branches_of_a_line_are_summed(tmp_path: Path, monkeypatch) -> None:
    spans = {path: first for path, first, _ in cov.layout()}
    firsts = _generate(tmp_path, "dddd-4", [HEADER, MATH, FOOTER])
    at, own = spans[MATH] + 9, firsts[MATH] + 9
    report = _record(
        str(ROOT / cov.ASSEMBLED),
        [f"FN:{at},f", "FNDA:0,f", f"BRDA:{at},0,0,0", f"BRDA:{at},1,0,2", f"DA:{at},0"],
    ) + _record(
        f"{GEN}/dddd-4.js",
        [f"FN:{own},f", "FNDA:3,f", f"BRDA:{own},7,0,1", f"DA:{own},3"],
    )
    module = _convert(tmp_path, monkeypatch, report)[MATH]
    assert "FN:10,f" in module
    assert "FNDA:3,f" in module
    assert "FNF:1" in module
    assert "FNH:1" in module
    # Branches of one line are matched in the order they are reported.
    assert [x for x in module if x.startswith("BRDA:")] == ["BRDA:10,0,0,1", "BRDA:10,1,0,2"]
    assert "BRF:2" in module
    assert "BRH:2" in module
    assert "DA:10,3" in module


def test_a_shell_run_as_generated_text_gets_its_own_record(tmp_path: Path, monkeypatch) -> None:
    firsts = _generate(tmp_path, "eeee-5", [SHELL])
    _generate(tmp_path, "ffff-6", [])  # text with no source file: an empty map
    report = (
        _record(f"{GEN}/eeee-5.js", ["DA:1,1", f"DA:{firsts[SHELL] + 2},4"])
        + _record(f"{GEN}/ffff-6.js", ["DA:1,1", "DA:2,1"])
        + _record(SHELL, ["DA:3,1", "DA:4,0"])  # the same file also run directly
    )
    by_file = _convert(tmp_path, monkeypatch, report)
    assert set(by_file) == {SHELL}
    assert [x for x in by_file[SHELL] if x.startswith("DA:")] == ["DA:3,5", "DA:4,0"]


def test_without_generated_files_the_report_is_as_before(tmp_path: Path, monkeypatch) -> None:
    report = _report(cov.layout()[2][1])
    before = cov.convert(report)
    monkeypatch.chdir(tmp_path)
    (tmp_path / GEN).mkdir()
    assert cov.convert(report, str((tmp_path / GEN).resolve())) == before
    # Maps with no record in the report change nothing either.
    _generate(tmp_path, "aaaa-1", [HEADER, MATH, FOOTER])
    assert cov.convert(report, str((tmp_path / GEN).resolve())) == before
    (tmp_path / RAW).write_text(report, encoding="utf-8")
    done = _run(tmp_path, RAW, OUT, GEN)
    assert done.returncode == 0, done.stderr
    assert (tmp_path / OUT).read_text(encoding="utf-8") == before


def _refused(cwd: Path, report: str, *extra: str) -> str:
    (cwd / RAW).write_text(report, encoding="utf-8")
    done = _run(cwd, RAW, OUT, *(extra or (GEN,)))
    assert done.returncode == 1
    assert done.stdout == ""
    assert not (cwd / OUT).exists()
    return done.stderr


def test_a_map_pointing_outside_the_current_folder_is_refused(tmp_path: Path) -> None:
    here = tmp_path / "here"
    here.mkdir()
    _generate(here, "aaaa-1", [HEADER])
    outside = tmp_path / "outside.js"
    shutil.copyfile(ROOT / HEADER, outside)
    report = _record(f"{GEN}/aaaa-1.js", ["DA:2,1"])
    for value in ("../outside.js", str(outside)):
        entry = {"path": value, "first": 2, "count": len(_lines(HEADER))}
        (here / GEN / "aaaa-1.sources.json").write_text(
            json.dumps({"sources": [entry]}), encoding="utf-8"
        )
        assert "is outside the current folder" in _refused(here, report)
    # A link inside the folder to a file outside it is outside too.
    (here / "link.js").symlink_to(outside)
    entry = {"path": "link.js", "first": 2, "count": len(_lines(HEADER))}
    (here / GEN / "aaaa-1.sources.json").write_text(
        json.dumps({"sources": [entry]}), encoding="utf-8"
    )
    assert "is outside the current folder" in _refused(here, report)


def test_a_folder_of_generated_files_outside_the_current_folder_is_refused(tmp_path: Path) -> None:
    here = tmp_path / "here"
    here.mkdir()
    _generate(tmp_path, "aaaa-1", [HEADER])
    report = _record(str(tmp_path / GEN / "aaaa-1.js"), ["DA:2,1"])
    for folder in ("../" + GEN, str(tmp_path / GEN), "."):
        assert "is outside the current folder" in _refused(here, report, folder)


def test_a_generated_file_without_a_map_or_not_matching_it_is_refused(tmp_path: Path) -> None:
    _generate(tmp_path, "aaaa-1", [HEADER, MATH])
    report = _record(f"{GEN}/aaaa-1.js", ["DA:2,1"])
    # A source that has changed since the generated file was written.
    with (tmp_path / MATH).open("a", encoding="utf-8") as fh:
        fh.write("// one more line\n")
    assert "does not fit js/src/10-math.js" in _refused(tmp_path, report)
    lines = _lines(MATH)
    lines[3] = lines[3] + " // changed"
    (tmp_path / MATH).write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert "is not js/src/10-math.js line 4" in _refused(tmp_path, report)
    (tmp_path / GEN / "aaaa-1.sources.json").write_text("{}", encoding="utf-8")
    assert "is not readable" in _refused(tmp_path, report)
    (tmp_path / GEN / "aaaa-1.sources.json").unlink()
    assert "has no map" in _refused(tmp_path, report)


def test_three_arguments_at_most() -> None:
    done = _run(ROOT, "a", "b", "c", "d")
    assert done.returncode == 1
    assert done.stderr.startswith("usage: js_coverage.py ")
