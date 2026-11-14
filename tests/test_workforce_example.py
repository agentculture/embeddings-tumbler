"""The planning sketch ``docs/workforce/examples/write_data_file.py`` run as a command.

Its ``main()`` takes the output folder from the command line and confines it to
the current folder. These run ``main()`` in this process: the default folder, a
sub-folder, the current folder itself, and paths that lead outside (refused,
exit 1, a plain message, nothing written).

The pair is checked for its shape only, not against ``docs/data-contract.md``:
the example is a sketch that predates the contract (its own docstring says the
contract wins) and leaves out fields the contract requires, such as
``provenance.seed``. The contract-valid producer is the one in
``docs/guides/examples/producer/``, tested in ``tests/test_guides.py``.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = REPO_ROOT / "docs" / "workforce" / "examples" / "write_data_file.py"


def _load_example():
    """Import the example by path (docs/ is not a package)."""
    spec = importlib.util.spec_from_file_location("workforce_write_data_file", EXAMPLE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


example = _load_example()


def _run_main(monkeypatch: pytest.MonkeyPatch, cwd: Path, *args: str) -> int:
    monkeypatch.chdir(cwd)
    monkeypatch.setattr(sys, "argv", ["write_data_file.py", *args])
    return example.main()


def _files_under(folder: Path) -> list[str]:
    return sorted(str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file())


@pytest.mark.parametrize(
    ("args", "printed", "folder"),
    [
        ((), "out/example.json", "out"),
        (("sub/dir",), "sub/dir/example.json", "sub/dir"),
        ((".",), "example.json", "."),
    ],
    ids=["default-folder", "sub-folder", "current-folder"],
)
def test_main_writes_the_pair_under_the_current_folder(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    args: tuple[str, ...],
    printed: str,
    folder: str,
) -> None:
    assert _run_main(monkeypatch, tmp_path, *args) == 0
    captured = capsys.readouterr()
    assert captured.out == printed + "\n"
    assert captured.err == ""

    written = tmp_path / folder
    assert _files_under(tmp_path) == sorted(
        str((Path(folder) / name)) for name in ("example.f32", "example.json")
    )
    data = json.loads((written / "example.json").read_text(encoding="utf-8"))
    block = (written / data["vectors"]["file"]).read_bytes()
    assert data["kind"] == "embeddings-tumbler/data"
    assert data["schema_version"] == 1
    assert data["vectors"]["byte_length"] == len(block)
    assert [p["id"] for p in data["points"]] == [f"p{i}" for i in range(8)]
    assert data["count"] == 8
    assert data["dimension"] == 16
    assert len(block) == 8 * 16 * 4
    assert data["provenance"]["synthetic"] is True


def test_main_accepts_an_absolute_path_inside_the_current_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    target = tmp_path / "abs"
    assert _run_main(monkeypatch, tmp_path, str(target)) == 0
    assert capsys.readouterr().out == str(target / "example.json") + "\n"
    assert _files_under(tmp_path) == ["abs/example.f32", "abs/example.json"]


@pytest.mark.parametrize("how", ["relative", "absolute"])
def test_main_refuses_a_folder_outside_the_current_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, how: str
) -> None:
    cwd = tmp_path / "inside"
    cwd.mkdir()
    outside = tmp_path / "outside"
    arg = "../outside" if how == "relative" else str(outside)
    with pytest.raises(SystemExit) as refusal:
        _run_main(monkeypatch, cwd, arg)
    # A string code is what the interpreter prints to stderr before exiting 1.
    assert refusal.value.code == f"{arg} is outside the current folder {cwd.resolve()}"
    assert not outside.exists()
    assert _files_under(tmp_path) == []


def test_a_link_that_leads_outside_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cwd = tmp_path / "inside"
    cwd.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (cwd / "link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(SystemExit) as refusal:
        _run_main(monkeypatch, cwd, "link/deeper")
    assert "is outside the current folder" in str(refusal.value.code)
    assert _files_under(outside) == []


def test_the_function_itself_writes_wherever_it_is_told(tmp_path: Path) -> None:
    """Only the command-line value is confined; the function stays usable by callers."""
    target = example.write_data_file(
        tmp_path / "anywhere",
        "pair",
        model="example/two",
        points=[{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
        vectors=[[0.0, 1.0], [1.0, 0.0]],
        source="a test",
        synthetic=True,
        include_text=False,
    )
    data = json.loads(target.read_text(encoding="utf-8"))
    assert [p["label"] for p in data["points"]] == ["a", "b"]
    assert data["text_included"] is False
    assert (tmp_path / "anywhere" / "pair.f32").stat().st_size == 2 * 2 * 4
    with pytest.raises(ValueError, match="one vector per point"):
        example.write_data_file(
            tmp_path, "x", model="m", points=[], vectors=[[1.0]], source="s", synthetic=True
        )
    with pytest.raises(ValueError, match="same dimension"):
        example.write_data_file(
            tmp_path,
            "x",
            model="m",
            points=[{"id": "a"}, {"id": "b"}],
            vectors=[[1.0], [1.0, 2.0]],
            source="s",
            synthetic=True,
        )
