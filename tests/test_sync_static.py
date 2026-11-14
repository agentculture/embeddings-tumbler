"""The shell and standalone-page files shipped in the wheel match their sources."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("sync_static", ROOT / "scripts" / "sync_static.py")
sync_static = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync_static)


def test_shipped_copies_are_current() -> None:
    assert sync_static.main(["--check"]) == 0, "run python3 scripts/sync_static.py"


def test_check_fails_on_a_stale_or_missing_copy(tmp_path: Path, monkeypatch) -> None:
    src = tmp_path / "src"
    out = tmp_path / "out"
    src.mkdir()
    out.mkdir()
    (src / "shell.js").write_text("one\n")
    (src / "notes.md").write_text("not shipped\n")
    monkeypatch.setattr(sync_static, "SOURCE_DIRS", (src,))
    monkeypatch.setattr(sync_static, "SHIPPED_DIR", out)
    assert sync_static.main(["--check"]) == 1
    assert sync_static.main([]) == 0
    assert (out / "shell.js").read_text() == "one\n"
    assert not (out / "notes.md").exists()
    assert sync_static.main(["--check"]) == 0
    (src / "shell.js").write_text("two\n")
    assert sync_static.main(["--check"]) == 1


def test_a_reserved_name_is_refused(tmp_path: Path, monkeypatch) -> None:
    src = tmp_path / "src"
    src.mkdir()
    (src / "embeddings-tumbler.js").write_text("clash\n")
    monkeypatch.setattr(sync_static, "SOURCE_DIRS", (src,))
    monkeypatch.setattr(sync_static, "SHIPPED_DIR", tmp_path)
    with pytest.raises(SystemExit):
        sync_static.main(["--check"])
