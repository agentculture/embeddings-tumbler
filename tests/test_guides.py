"""The two guides (docs/guides/) cannot drift from the contract or from the tested examples.

* Every html / js / css block in a guide is the exact content of a file under
  docs/guides/examples/, named by a marker line ``<!-- file: path -->`` before the fence.
* The producer guide's field tables and refusal list equal the contract's.
* The host guide names every refusal code and every ``--tumbler-*`` property.
* The producer guide's minimal file, the second producer's output and the committed example
  data are accepted by the reference validator of tests/test_data_contract.py.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from tests.test_data_contract import _index, validate

ROOT = Path(__file__).resolve().parents[1]
GUIDES = ROOT / "docs" / "guides"
HOST = GUIDES / "host.md"
PRODUCER = GUIDES / "producer.md"
CONTRACT = ROOT / "docs" / "data-contract.md"
VIEWER_API = ROOT / "js" / "api" / "50-viewer.md"
EXAMPLES = GUIDES / "examples"
CHECKED_LANGS = {"html", "js", "javascript", "css"}
FENCE = re.compile(
    r"^(?P<marker><!-- file: (?P<path>\S+) -->\n\n)?```(?P<lang>\w*)\n(?P<body>.*?)\n```$",
    re.M | re.S,
)


def _blocks(md: Path):
    text = md.read_text(encoding="utf-8")
    return [m for m in FENCE.finditer(text)]


@pytest.mark.parametrize("guide", [HOST, PRODUCER], ids=lambda p: p.name)
def test_every_code_block_in_a_checked_language_is_a_tested_file(guide: Path) -> None:
    for m in _blocks(guide):
        if m["marker"]:
            target = (GUIDES / m["path"]).resolve()
            assert target.is_relative_to(EXAMPLES), m["path"]
            assert target.is_file(), f"{guide.name}: no file {m['path']}"
            assert m["body"] + "\n" == target.read_text(
                encoding="utf-8"
            ), f"{guide.name}: block differs from {m['path']}"
        else:
            assert (
                m["lang"] not in CHECKED_LANGS
            ), f"{guide.name}: unmarked {m['lang']} block:\n{m['body'][:80]}"


def test_the_guides_use_the_marker_scheme() -> None:
    assert len([m for m in _blocks(HOST) if m["marker"]]) >= 8
    assert len([m for m in _blocks(PRODUCER) if m["marker"]]) >= 1


def _table(md_path: Path, heading: str) -> dict[str, bool]:
    lines = md_path.read_text(encoding="utf-8").splitlines()
    start = next(i for i, ln in enumerate(lines) if re.fullmatch(rf"#{{2,4}} {heading}", ln))
    rows: dict[str, bool] = {}
    for ln in lines[start + 1 :]:
        if ln.startswith("#"):
            break
        if ln.startswith("|") and not ln.startswith("|--") and not ln.startswith("| Field"):
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            rows[cells[0].strip("`")] = cells[2].lower().startswith("yes")
        elif rows and not ln.startswith("|"):
            break
    return rows


@pytest.mark.parametrize(
    "heading",
    ["Top-level fields", "Provenance", "Reduction record", "Vector block", "Point records"],
)
def test_producer_field_tables_match_the_contract(heading: str) -> None:
    theirs = _table(CONTRACT, heading)
    mine = _table(PRODUCER, heading)
    assert theirs, heading
    assert mine == theirs, f"{heading}: guide {mine} vs contract {theirs}"


def _codes(md_path: Path, heading: str) -> set[str]:
    text = md_path.read_text(encoding="utf-8")
    section = text.split(f"\n### {heading}\n", 1)[1]
    section = re.split(r"\n#{2,3} ", section, maxsplit=1)[0]
    rows = re.findall(r"^\| `([a-z-]+)` \|", section, re.M)
    return set(rows)


def test_producer_refusal_codes_match_the_contract() -> None:
    contract_codes = _codes(CONTRACT, "Codes and messages")
    guide_codes = set(
        re.findall(r"^\| `([a-z-]+)` \| [^|]*\| [^|]*\|$", PRODUCER.read_text("utf-8"), re.M)
    )
    assert len(contract_codes) == 15
    assert guide_codes == contract_codes


def test_host_guide_names_every_refusal_code_and_the_viewer_codes() -> None:
    text = HOST.read_text("utf-8")
    for code in _codes(CONTRACT, "Codes and messages"):
        assert f"`{code}`" in text, code
    for code in (
        "not-mounted",
        "destroyed",
        "mode-failed",
        "gpu-failed",
        "internal",
        "too-many-points",
        "dimension-too-large",
        "shader-failed",
    ):
        assert f"`{code}`" in text, code


def test_host_guide_names_every_theming_property() -> None:
    api = VIEWER_API.read_text("utf-8")
    names = set(re.findall(r"^\| `(--tumbler-[a-z0-9-]+)`", api, re.M))
    assert "--tumbler-stage-height" in names
    text = HOST.read_text("utf-8")
    for name in names:
        assert f"`{name}`" in text, name


def _read_pair(json_path: Path):
    data = json.loads(json_path.read_text("utf-8"))
    return data, (json_path.parent / data["vectors"]["file"]).read_bytes()


@pytest.mark.parametrize(
    "rel",
    [
        "producer/minimal.json",
        "script/space.json",
        "web-component/space.json",
        "standalone/space.json",
    ],
)
def test_committed_example_data_is_accepted(rel: str) -> None:
    data, block = _read_pair(EXAMPLES / rel)
    assert validate(data, block, None, _index()["messages"]) == []


def test_the_three_example_folders_carry_the_same_data() -> None:
    names = ("space.json", "space.f32")
    for n in names:
        first = (EXAMPLES / "script" / n).read_bytes()
        for d in ("web-component", "standalone"):
            assert (EXAMPLES / d / n).read_bytes() == first


def test_second_producer_output_is_accepted(tmp_path: Path) -> None:
    script = EXAMPLES / "producer" / "write_data_file.py"
    sample = EXAMPLES / "producer" / "sample-input.jsonl"
    done = subprocess.run(
        [sys.executable, "-I", str(script), str(sample), str(tmp_path), "out",
         "--model", "synthetic/cold-test", "--source", "synthetic 4-cluster sample",
         "--synthetic", "--seed", "7", "--limitation", "made-up vectors"],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 0, done.stderr
    data, block = _read_pair(tmp_path / "out.json")
    assert validate(data, block, None, _index()["messages"]) == []
    assert data["count"] == 320
    assert data["dimension"] == 12
    # The committed example data is that output with the block renamed to space.f32.
    assert block == (EXAMPLES / "script" / "space.f32").read_bytes()
