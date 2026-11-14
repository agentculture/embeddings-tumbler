"""scripts/js_coverage.py: coverage of the assembled file attributed to its modules."""

from __future__ import annotations

import importlib.util
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
