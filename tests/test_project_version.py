"""t13 review: the TestPyPI dev build rewrites only the [project] table's version.

``scripts/project_version.py`` replaces the sed one-liner in publish.yml, which
rewrote the first ``version =`` line anywhere in pyproject.toml.
"""

from __future__ import annotations

import importlib.util
import sys
import tomllib
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "project_version", ROOT / "scripts" / "project_version.py"
)
pv = importlib.util.module_from_spec(_spec)
sys.modules["project_version"] = pv
_spec.loader.exec_module(pv)

DECOY = """\
[tool.something]
version = "9.9.9"

[project]
name = "embeddings-tumbler"
version = "0.10.1"   # the real one
description = "x"

[tool.other]
version = "8.8.8"
"""


def test_only_the_project_version_changes():
    out = pv.set_version(DECOY, "0.10.1.dev42")
    data = tomllib.loads(out)
    assert data["project"]["version"] == "0.10.1.dev42"
    assert data["tool"]["something"]["version"] == "9.9.9"
    assert data["tool"]["other"]["version"] == "8.8.8"
    assert out == DECOY.replace('version = "0.10.1"', 'version = "0.10.1.dev42"')


def test_get_reads_the_project_version():
    assert pv.get_version(DECOY) == "0.10.1"


def test_a_pyproject_without_a_project_version_is_refused():
    with pytest.raises(ValueError, match=r"\[project\]"):
        pv.set_version('[tool.x]\nversion = "1"\n[project]\nname = "y"\n', "2")


def test_the_repo_pyproject_round_trips():
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    current = pv.get_version(text)
    assert pv.set_version(text, current) == text
    assert tomllib.loads(pv.set_version(text, current + ".dev1"))["project"]["version"] == (
        current + ".dev1"
    )


def test_cli_get_and_set(tmp_path, capsys):
    path = tmp_path / "pyproject.toml"
    path.write_text(DECOY, encoding="utf-8")
    assert pv.main(["get", "--file", str(path)]) == 0
    assert capsys.readouterr().out == "0.10.1\n"
    assert pv.main(["set", "1.2.3.dev7", "--file", str(path)]) == 0
    assert tomllib.loads(path.read_text(encoding="utf-8"))["tool"]["something"]["version"] == (
        "9.9.9"
    )
    assert pv.main(["get", "--file", str(path)]) == 0
    assert capsys.readouterr().out.splitlines()[-1] == "1.2.3.dev7"


def test_the_testpypi_step_uses_the_helper_not_sed():
    doc = yaml.safe_load((ROOT / ".github" / "workflows" / "publish.yml").read_text())
    steps = doc["jobs"]["test-publish"]["steps"]
    run = next(s["run"] for s in steps if s.get("name") == "Set dev version")
    assert "sed " not in run
    assert 'python3 scripts/project_version.py set "${DEV_VERSION}"' in run
    assert 'DEV_VERSION="${BASE}.dev${{ github.run_number }}"' in run
    assert 'echo "DEV_VERSION=${DEV_VERSION}" >> "$GITHUB_ENV"' in run
