"""The built relative view agrees with the reference page for the search Rice, by numbers.

Runs ``scripts/compare_relative_reference.py``, which works out what the reference page
shows from its own rules and data and what the assembled core file shows in node, and
compares the pinned axis, each result's height to 2 decimal places and the reranked order.
Skipped only when node is not installed.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import shutil
import subprocess  # nosec B404 - runs this repository's own script
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "compare_relative_reference.py"

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def _module():
    spec = importlib.util.spec_from_file_location("compare_relative_reference", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def run() -> tuple[int, dict]:
    if shutil.which("node") is None:
        pytest.skip("node is not installed")
    done = subprocess.run(  # nosec B603 - fixed interpreter and script
        [sys.executable, str(SCRIPT), "--json"],
        capture_output=True,
        text=True,
        timeout=240,
        check=False,
        cwd=ROOT,
    )
    assert done.returncode in (0, 1), done.stderr
    return done.returncode, json.loads(done.stdout)


@needs_node
def test_the_script_reports_agreement(run):
    code, out = run
    failed = [c for c in out["checks"] if not c["ok"]]
    assert not failed, failed
    assert out["agree"] is True
    assert code == 0
    assert out["verdict"].startswith("AGREE")


@needs_node
def test_rice_pins_the_vertical_axis_and_names_the_specs_eight(run):
    _, out = run
    plain = [r for r in out["rows"] if r["part"] == "plain"]
    # The spec's success signal, recomputed from the shipped pair by the script.
    assert [r["build"] for r in plain] == [
        "Cereal",
        "Wheat",
        "Maize",
        "Bean",
        "Bread",
        "Vegetable",
        "Cattle",
        "Potato",
    ]
    assert [r["build_height"] for r in plain] == [r["reference_height"] for r in plain]
    names = {c["check"] for c in out["checks"]}
    for name in (
        "pinned axis",
        "frame row 1 is the search direction",
        "plain: heights to 2 decimal places",
        "reranked: same articles in the same order",
        "reranked: heights to 2 decimal places",
    ):
        assert name in names, name


@needs_node
def test_the_build_was_given_the_reference_scores_and_counts_one_higher(run):
    _, out = run
    assert out["build_settings"] == {"k": 9, "candidates": 51, "top": 9}
    assert "real scores" in out["given_to_the_build"]
    assert out["reranker"] == "Qwen/Qwen3-Reranker-0.6B"
    # The searched article holds rank 1, so the ranks on its results start at 2.
    ranks = out["build_overlay_ranks"]
    assert ranks[0]["title"] == "Rice"
    assert ranks[0]["ranks"] == [1]
    assert [r["ranks"] for r in ranks[1:]] == [[n] for n in range(2, 10)]


def _fake(mod) -> tuple[dict, dict, list[str]]:
    """A small agreeing pair of sides, for checking that compare() can say no."""
    titles = ["own", "a", "b", "c"]
    ref = {
        "own": 0,
        "plain": [{"index": 1, "height": 0.84}, {"index": 2, "height": 0.82}],
        "reranked": [
            {"index": 2, "height": 0.82, "rank": 1},
            {"index": 1, "height": 0.84, "rank": 2},
        ],
        "cut": 0.68,
    }
    own = {"index": 0, "height": 1.0, "rank": 1}
    build = {
        "pinned": [{"letter": "A", "axis": "vertical"}],
        "own": {"index": 0},
        "settled": True,
        "row1Error": 1e-9,
        "measure": "cosine",
        "plain": [
            own,
            {"index": 1, "height": 0.8401, "rank": 2},
            {"index": 2, "height": 0.8199, "rank": 3},
        ],
        "reranked": [
            own,
            {"index": 2, "height": 0.82, "rank": 2},
            {"index": 1, "height": 0.84, "rank": 3},
        ],
        "reranker": "m",
        "unknownCandidates": [],
        "sent": 51,
        "cut": {"height": 0.6801},
    }
    assert mod.compare(ref, build, titles)["agree"] is True
    return ref, build, titles


@pytest.mark.parametrize("case", ["height", "order", "axis", "unsettled", "no reranker"])
def test_compare_says_no_when_something_differs(case):
    mod = _module()
    ref, build, titles = _fake(mod)
    broken = copy.deepcopy(build)
    if case == "height":
        broken["plain"][1]["height"] = 0.83  # 0.83 against the reference's 0.84
    elif case == "order":
        broken["reranked"][1], broken["reranked"][2] = broken["reranked"][2], broken["reranked"][1]
    elif case == "axis":
        broken["pinned"] = [{"letter": "A", "axis": "horizontal"}]
    elif case == "unsettled":
        broken["settled"] = False
    else:
        broken["reranker"] = None
    assert mod.compare(ref, broken, titles)["agree"] is False
