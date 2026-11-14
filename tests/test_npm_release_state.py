"""t13 review: classify whether a version is already on npm, failing closed.

``scripts/npm_release_state.py`` runs ``npm view <package> versions --json``
and prints ``absent`` (publish) or ``present`` (compare, do not publish). Any
other outcome (a network error, a registry error, output it cannot read) exits
1 so the publish job stops and publishes nothing. These tests feed canned npm
outputs; nothing here touches the network.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "npm_release_state", ROOT / "scripts" / "npm_release_state.py"
)
state = importlib.util.module_from_spec(_spec)
sys.modules["npm_release_state"] = state
_spec.loader.exec_module(state)

# Captured from npm 9.2.0 (`npm view ... --json`) on 2026-11-14.
E404_PACKAGE = json.dumps(
    {
        "error": {
            "code": "E404",
            "summary": "Not Found - GET https://registry.npmjs.org/"
            "@culture.dev%2fembeddings-tumbler - Not found",
            "detail": "'@culture.dev/embeddings-tumbler' is not in this registry.",
        }
    },
    indent=2,
)
ECONNREFUSED = json.dumps(
    {"error": {"code": "ECONNREFUSED", "summary": "FetchError: connect ECONNREFUSED"}}, indent=2
)


def test_package_not_found_is_absent():
    assert state.classify(1, E404_PACKAGE, "0.10.1") == "absent"


def test_version_in_the_list_is_present():
    assert state.classify(0, '[\n  "0.10.0",\n  "0.10.1"\n]\n', "0.10.1") == "present"


def test_a_single_published_version_comes_back_as_a_string():
    assert state.classify(0, '"0.10.1"\n', "0.10.1") == "present"


def test_package_exists_but_not_this_version_is_absent():
    assert state.classify(0, '["0.10.0", "0.10.2"]', "0.10.1") == "absent"
    assert state.classify(0, '"0.10.0"', "0.10.1") == "absent"


@pytest.mark.parametrize(
    "returncode, stdout",
    [
        (1, ECONNREFUSED),  # network
        (1, json.dumps({"error": {"code": "E500", "summary": "Internal Server Error"}})),
        (1, json.dumps({"error": {"code": "E401", "summary": "Unauthorized"}})),
        (1, ""),  # no output at all
        (1, "npm ERR! something"),  # not JSON
        (0, ""),  # success with nothing to read
        (0, "not json"),
        (0, json.dumps({"versions": ["0.10.1"]})),  # an unexpected shape
        (0, json.dumps([1, 2])),
        (2, E404_PACKAGE),  # a 404 body with an exit code npm does not use for 404
    ],
)
def test_anything_else_is_an_error(returncode, stdout):
    with pytest.raises(state.StateError):
        state.classify(returncode, stdout, "0.10.1")


def _runner(returncode, stdout, stderr=""):
    def run(cmd):
        run.cmd = cmd
        return subprocess.CompletedProcess(cmd, returncode, stdout, stderr)

    return run


def test_main_prints_the_state_and_queries_the_package(capsys):
    run = _runner(1, E404_PACKAGE, "npm ERR! code E404\n")
    assert state.main(["@culture.dev/embeddings-tumbler", "0.10.1"], run=run) == 0
    assert capsys.readouterr().out == "absent\n"
    assert run.cmd == ["npm", "view", "@culture.dev/embeddings-tumbler", "versions", "--json"]

    assert (
        state.main(["@culture.dev/embeddings-tumbler", "0.10.1"], run=_runner(0, '"0.10.1"')) == 0
    )
    assert capsys.readouterr().out == "present\n"


def test_main_fails_closed_and_prints_nothing_on_stdout(capsys):
    code = state.main(["@culture.dev/embeddings-tumbler", "0.10.1"], run=_runner(1, ECONNREFUSED))
    out, err = capsys.readouterr()
    assert code == 1
    assert out == ""
    assert "ECONNREFUSED" in err
    assert "publish nothing" in err


def test_main_fails_when_npm_cannot_be_started(capsys):
    def run(cmd):
        raise FileNotFoundError("npm")

    assert state.main(["pkg", "1.0.0"], run=run) == 1
    assert capsys.readouterr().out == ""


def test_main_needs_a_package_and_a_version():
    with pytest.raises(SystemExit):
        state.main(["only-one-arg"])


@pytest.mark.parametrize(
    "argv",
    [
        ["--registry=https://evil.example/", "0.10.1"],
        ["@culture.dev/embeddings-tumbler", "--json"],
        ["@culture.dev/embeddings-tumbler", "latest"],
        ["../pkg", "1.0.0"],
        # Non-ASCII digits (ARABIC-INDIC DIGIT ONE, FULLWIDTH DIGIT ONE) are not a version.
        ["@culture.dev/embeddings-tumbler", "\u0661.0.0"],
        ["@culture.dev/embeddings-tumbler", "1.0.\uff11"],
    ],
)
def test_main_refuses_anything_but_a_package_and_an_exact_version(argv, capsys):
    def run(cmd):
        raise AssertionError(f"npm must not run: {cmd}")

    assert state.main(argv, run=run) == 1
    out, err = capsys.readouterr()
    assert out == ""
    assert "publish nothing" in err
