"""scripts/js_coverage.py: coverage of the assembled file attributed to its modules."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "js_coverage.py"

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
    bad = tmp_path / "raw.lcov"
    bad.write_text(_report(10_000_000), encoding="utf-8")
    done = subprocess.run(
        [sys.executable, str(SCRIPT), str(bad), str(tmp_path / "out.lcov")],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 1
    assert "beyond the end" in done.stderr
    assert not (tmp_path / "out.lcov").exists()
