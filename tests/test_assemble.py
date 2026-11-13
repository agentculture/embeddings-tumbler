"""t3: the JS assembler, the assembled core file, and the node test runner."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
ASSEMBLED = ROOT / "embeddings_tumbler" / "static" / "embeddings-tumbler.js"


def _load_assembler():
    spec = importlib.util.spec_from_file_location("assemble", ROOT / "scripts" / "assemble.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


assemble = _load_assembler()


def _pyproject_version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "version"
    ]


def test_assembly_is_deterministic():
    assert assemble.assemble() == assemble.assemble()
    assert assemble.assemble().encode("utf-8") == assemble.assemble().encode("utf-8")


def test_committed_file_is_not_stale():
    assert ASSEMBLED.read_bytes() == assemble.assemble().encode(
        "utf-8"
    ), "committed embeddings-tumbler.js is stale: run python3 scripts/assemble.py"
    assert assemble.main(["--check"]) == 0


def test_check_fails_when_stale(tmp_path, monkeypatch):
    stale = tmp_path / "embeddings-tumbler.js"
    stale.write_text("// old\n", encoding="utf-8")
    monkeypatch.setattr(assemble, "OUT_FILE", stale)
    assert assemble.main(["--check"]) == 1
    missing = tmp_path / "nope.js"
    monkeypatch.setattr(assemble, "OUT_FILE", missing)
    assert assemble.main(["--check"]) == 1


def test_header_names_project_version_and_source():
    first = ASSEMBLED.read_text(encoding="utf-8").splitlines()[0]
    version = _pyproject_version()
    assert first.startswith("/*!")
    assert "embeddings-tumbler" in first
    assert f" {version} " in first
    assert "agentculture/embeddings-tumbler" in first


def test_versions_agree():
    version = _pyproject_version()
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert pkg["version"] == version
    assert f'ET.version = "{version}"' in ASSEMBLED.read_text(encoding="utf-8")
    assert "@@VERSION@@" not in ASSEMBLED.read_text(encoding="utf-8")


def test_package_json_has_no_dependencies_and_runs_node_test():
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert pkg["scripts"]["test"] == "node --test"
    for key in ("dependencies", "devDependencies", "peerDependencies"):
        assert not pkg.get(key)


BANNED = {
    "http(s) URL": r"https?://",
    "eval": r"\beval\b",
    "new Function": r"\bnew\s+Function\b",
    "import of another module": r"\bimport\b|\brequire\s*\(",
}


@pytest.mark.parametrize("label", list(BANNED))
def test_assembled_file_has_no_banned_constructs(label):
    text = ASSEMBLED.read_text(encoding="utf-8")
    match = re.search(BANNED[label], text)
    assert match is None, f"assembled file contains {label}: {match.group(0)!r}"


def test_static_ban_detects_violations():
    # The ban patterns must actually bite.
    for bad in ("fetch('https://x.example')", "eval(s)", "new Function('a')", "import x from 'y'"):
        assert any(re.search(p, bad) for p in BANNED.values()), bad


def test_static_file_is_in_wheel_package_data():
    # hatch ships every non-ignored file under the declared package directory.
    cfg = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert "embeddings_tumbler" in cfg["tool"]["hatch"]["build"]["targets"]["wheel"]["packages"]
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", str(ASSEMBLED)], cwd=ROOT, check=False
    ).returncode
    assert ignored == 1, "assembled file is git-ignored, so it would not ship"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_node_test_runs_from_repo_root():
    result = subprocess.run(
        ["node", "--test"], cwd=ROOT, capture_output=True, text=True, check=False, timeout=120
    )
    assert result.returncode == 0, result.stdout + result.stderr
