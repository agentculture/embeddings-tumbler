"""t9: the shipped sample set is the source file, byte for byte, and obeys the static bans."""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "js" / "sample" / "sample-data.js"
SHIPPED = ROOT / "embeddings_tumbler" / "static" / "sample-data.js"

_spec = importlib.util.spec_from_file_location("sync_sample", ROOT / "scripts" / "sync_sample.py")
sync_sample = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_sample)

BANNED = {
    "http(s) URL": r"https?://",
    "eval": r"\beval\b",
    "new Function": r"\bnew\s+Function\b",
    "import of another module": r"\bimport\b|\brequire\s*\(",
}


def test_shipped_copy_is_not_stale():
    assert (
        SHIPPED.read_bytes() == SOURCE.read_bytes()
    ), "embeddings_tumbler/static/sample-data.js is stale: run python3 scripts/sync_sample.py"
    assert sync_sample.main(["--check"]) == 0


def test_check_fails_when_stale(tmp_path, monkeypatch):
    stale = tmp_path / "sample-data.js"
    stale.write_text("// old\n", encoding="utf-8")
    monkeypatch.setattr(sync_sample, "SHIPPED", stale)
    assert sync_sample.main(["--check"]) == 1
    monkeypatch.setattr(sync_sample, "SHIPPED", tmp_path / "missing.js")
    assert sync_sample.main(["--check"]) == 1


@pytest.mark.parametrize("label", list(BANNED))
def test_shipped_sample_has_no_banned_constructs(label):
    text = SHIPPED.read_text(encoding="utf-8")
    match = re.search(BANNED[label], text)
    assert match is None, f"sample file contains {label}: {match.group(0)!r}"
