"""The guides (docs/guides/) cannot drift from the contract or from the tested examples.

* Every html / js / css block in a guide is the exact content of a file under
  docs/guides/examples/, named by a marker line ``<!-- file: path -->`` before the fence.
* The producer guide's field tables and refusal list equal the contract's.
* The host guide names every refusal code and every ``--tumbler-*`` property.
* The producer guide's minimal file, the second producer's output and the committed example
  data are accepted by the reference validator of tests/test_data_contract.py.
* The host guide's search section names every search method, option, setting, refusal code,
  helper flag and environment variable the code has, and the search guide names every control
  of the panel with the code's own numbers and wording.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from embeddings_tumbler import _embed_route
from embeddings_tumbler.cli._commands import viewer as viewer_cmd
from tests.test_data_contract import _index, validate

ROOT = Path(__file__).resolve().parents[1]
GUIDES = ROOT / "docs" / "guides"
HOST = GUIDES / "host.md"
PRODUCER = GUIDES / "producer.md"
SEARCH = GUIDES / "search.md"
SEARCH_INTERFACE = ROOT / "docs" / "search-interface.md"
SEARCH_API = ROOT / "js" / "api" / "24-search.md"
SEARCH_SOURCE = ROOT / "js" / "src" / "24-search.js"
PANEL_SOURCE = ROOT / "js" / "src" / "45-search-panel.js"
DEMO = ROOT / "embeddings_tumbler" / "static" / "demo-wikipedia.json"
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


@pytest.mark.parametrize("guide", [HOST, PRODUCER, SEARCH], ids=lambda p: p.name)
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
    marked = {m["path"] for m in _blocks(HOST) if m["marker"]}
    for name in ("example.html", "host.js", "host.css"):
        assert f"examples/script-search/{name}" in marked
    for name in ("example.html", "host.js"):
        assert f"examples/web-component-search/{name}" in marked
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
        "script-search/space.json",
        "web-component-search/space.json",
    ],
)
def test_committed_example_data_is_accepted(rel: str) -> None:
    data, block = _read_pair(EXAMPLES / rel)
    assert validate(data, block, None, _index()["messages"]) == []


def test_the_example_folders_carry_the_same_data() -> None:
    names = ("space.json", "space.f32")
    for n in names:
        first = (EXAMPLES / "script" / n).read_bytes()
        for d in ("web-component", "standalone", "script-search", "web-component-search"):
            assert (EXAMPLES / d / n).read_bytes() == first


SECOND_PRODUCER = EXAMPLES / "producer" / "write_data_file.py"
SAMPLE_NAME = "sample-input.jsonl"
SAMPLE_INPUT = EXAMPLES / "producer" / SAMPLE_NAME


def _run_second_producer(cwd: Path, source: str, outdir: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-I", str(SECOND_PRODUCER), source, outdir, "out",
         "--model", "synthetic/cold-test", "--source", "synthetic 4-cluster sample",
         "--synthetic", "--seed", "7", "--limitation", "made-up vectors"],
        capture_output=True, text=True, check=False, cwd=cwd,
    )  # fmt: skip


def test_second_producer_output_is_accepted(tmp_path: Path) -> None:
    # The script reads and writes only inside the folder it runs in.
    shutil.copyfile(SAMPLE_INPUT, tmp_path / SAMPLE_NAME)
    done = _run_second_producer(tmp_path, SAMPLE_NAME, "pair")
    assert done.returncode == 0, done.stderr
    assert done.stdout.startswith(f"wrote {os.path.join('pair', 'out')}.json and ")
    data, block = _read_pair(tmp_path / "pair" / "out.json")
    assert validate(data, block, None, _index()["messages"]) == []
    assert data["count"] == 320
    assert data["dimension"] == 12
    # The committed example data is that output with the block renamed to space.f32.
    assert block == (EXAMPLES / "script" / "space.f32").read_bytes()


@pytest.mark.parametrize("which", ["input", "outdir"])
def test_second_producer_refuses_paths_outside_its_folder(tmp_path: Path, which: str) -> None:
    here = tmp_path / "here"
    here.mkdir()
    shutil.copyfile(SAMPLE_INPUT, here / SAMPLE_NAME)
    shutil.copyfile(SAMPLE_INPUT, tmp_path / "outside.jsonl")
    source, outdir = SAMPLE_NAME, "."
    if which == "input":
        source = "../outside.jsonl"
    else:
        outdir = str(tmp_path / "elsewhere")
    done = _run_second_producer(here, source, outdir)
    assert done.returncode == 1
    assert "is outside the current folder" in done.stderr
    assert not (tmp_path / "elsewhere").exists()
    assert not (here / "out.json").exists()


# ---------- search: the host guide and the search guide against the code ----------


def _named(md_path: Path, module: str) -> list[str]:
    """The names in the ``interface-names`` block a page keeps for one module."""
    text = md_path.read_text("utf-8")
    block = re.search(
        rf'<!-- interface-names module="{re.escape(module)}"[^>]*-->\n```text\n(.*?)\n```',
        text,
        re.S,
    )
    assert block, module
    return block[1].split()


def _section(md_path: Path, heading: str) -> str:
    text = md_path.read_text("utf-8")
    body = re.split(rf"^#{{2,4}} {re.escape(heading)}$", text, maxsplit=1, flags=re.M)[1]
    return re.split(r"^#{2,4} ", body, maxsplit=1, flags=re.M)[0]


def _first_cells(section: str) -> list[str]:
    return re.findall(r"^\| `([^`]+)` \|", section, re.M)


def _js_number(source: Path, name: str) -> int:
    found = re.search(rf"^  var {name} = (\d+);", source.read_text("utf-8"), re.M)
    assert found, name
    return int(found[1])


def _subparsers(parser: argparse.ArgumentParser) -> dict[str, argparse.ArgumentParser]:
    return next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction)).choices


def _serve_flags() -> list[str]:
    parser = argparse.ArgumentParser()
    viewer_cmd.register(parser.add_subparsers())
    serve = _subparsers(_subparsers(parser)["viewer"])["serve"]
    return [
        option
        for action in serve._actions
        for option in action.option_strings
        if "embed" in option or option in ("--rerank-model", "--query-prefix")
    ]


def test_host_guide_names_every_search_method_of_the_handle() -> None:
    text = _section(HOST, "The handle's search methods")
    methods = _named(SEARCH_INTERFACE, "50-viewer.js")
    assert len(methods) == 6
    for method in methods:
        assert f"`{method}(" in text, method


def test_host_guide_names_every_search_option() -> None:
    options = [
        cell.split("(")[0] for cell in _first_cells(_section(SEARCH_INTERFACE, "Mount options"))
    ]
    assert "embed" in options
    mine = _section(HOST, "Search options at mount")
    for option in options:
        assert f"`{option}" in mine, option


def test_host_guide_names_every_search_setting() -> None:
    settings = _first_cells(
        _section(SEARCH_INTERFACE, "`handle.setSearchSettings(patch) -> Promise<result>`")
    )
    assert len(settings) == 8
    assert _first_cells(_section(HOST, "The handle's search methods"))[-8:] == settings


def test_host_guide_names_every_search_refusal_code() -> None:
    codes = set(_first_cells(_section(SEARCH_API, "Refusal codes")))
    codes |= set(_first_cells(_section(SEARCH_INTERFACE, "Viewer refusal codes")))
    assert len(codes) == 23
    text = _section(HOST, "Search refusals")
    for code in codes - {"destroyed"}:
        assert f"`{code}`" in text, code


def test_host_guide_reports_the_search_fields_of_info() -> None:
    text = _section(HOST, "What `info()` reports about search")
    for name in (
        "active", "waiting", "stale", "staleBy", "code", "message", "measure", "settings",
        "embedder.available", "reranker.available", "reranker.offered", "sameSpace.ok",
        "litCount", "sharedCount", "unmatched", "facing", "faceable", "searches", "pairs",
        "letter", "kind", "text", "model", "queryForm", "sentTo", "reranker", "sent", "words",
        "point", "k", "candidates", "top", "available", "counts", "note", "radius",
        "insideCount", "pointOfView", "results",
    ):  # fmt: skip
        assert f"`{name}`" in text, name


@pytest.mark.parametrize("guide", [HOST, SEARCH], ids=lambda p: p.name)
def test_guides_name_the_helper_flags_and_where_the_key_lives(guide: Path) -> None:
    text = guide.read_text("utf-8")
    flags = _serve_flags()
    assert "--embed-allow-remote" in flags
    for flag in flags:
        assert f"`{flag}" in text, flag
    for variable in (_embed_route.URL_VARIABLE, _embed_route.MODEL_VARIABLE):
        assert f"`{variable}`" in text, variable
    for variable in _embed_route.KEY_VARIABLES:
        assert f"`{variable}`" in text, variable
    assert _embed_route.DEFAULT_EMBED_URL in text
    assert _embed_route.DEFAULT_EMBED_MODEL in text
    assert "loopback" in text


def test_host_guide_states_the_limits_the_helper_route_has() -> None:
    text = " ".join(_section(HOST, "Search in the standalone page, and the local helper").split())
    assert f"`POST {_embed_route.ROUTE}`" in text
    assert f"({_embed_route.MAX_TEXT_CHARS:,} characters)" in text
    assert f"candidates ({_embed_route.MAX_CANDIDATES})" in text
    assert f"requests ({_embed_route.REQUESTS_PER_MINUTE} a minute)" in text


def test_search_guide_names_every_control_of_the_panel() -> None:
    panel = PANEL_SOURCE.read_text("utf-8")
    text = SEARCH.read_text("utf-8")
    for label in (
        "Face the searches", "Lit", "Reranker", "Distance difference", "Results", "Candidates",
        "Keep top", "From this search's point of view", "Only results", "Clear",
    ):  # fmt: skip
        assert f'"{label}"' in panel, label
        assert f"**{label}**" in text, label
    choices = re.findall(r'^    (?:even|close|named): "([^"]+)",$', panel, re.M)
    assert len(choices) == 3
    for choice in choices:
        assert f"*{choice[0].upper()}{choice[1:]}*" in text, choice


def test_search_guide_quotes_the_panels_own_sentences() -> None:
    panel = PANEL_SOURCE.read_text("utf-8")
    text = " ".join(SEARCH.read_text("utf-8").split())
    for sentence in (
        "The typed text was sent to the host's embedder.",
        "The query and the candidate texts were sent to the reranker.",
        "Typed text is sent to the host's embedder; nothing else leaves the page.",
        "No embedder is connected, so typed words are matched against the labels and texts of "
        "the loaded points, and nothing is sent.",
    ):
        assert sentence in panel, sentence
        assert sentence in text, sentence


@pytest.mark.parametrize("guide", [HOST, SEARCH], ids=lambda p: p.name)
def test_guides_state_the_codes_own_search_numbers(guide: Path) -> None:
    text = " ".join(guide.read_text("utf-8").split())
    low, high = _js_number(SEARCH_SOURCE, "MIN_K"), _js_number(SEARCH_SOURCE, "MAX_K")
    assert [low, high, _js_number(SEARCH_SOURCE, "MAX_CANDIDATES")] == [3, 100, 100]
    assert f"{low} to {high}" in text
    for name in ("DEFAULT_K", "DEFAULT_CANDIDATES", "DEFAULT_TOP"):
        assert re.search(rf"\b{_js_number(SEARCH_SOURCE, name)}\b", text), name
    assert "cosine distance (1 minus cosine similarity)" in text
    assert "lettered" in text


def test_search_guide_states_what_the_owner_decided() -> None:
    text = " ".join(SEARCH.read_text("utf-8").split())
    demo = json.loads(DEMO.read_text("utf-8"))
    for needle in (
        f"{demo['count']} articles",
        demo["model"],
        "CC BY-SA 4.0",
        "`NOTICE`",
        "`index.html?sample=synthetic`",
        "8 unless you change it",
        "50 to begin with",
        "20 to begin with",
        "up to four",
        "Distances are measured in the full space.",
        "A picture is a shadow of the space.",
        "nearer is brighter",
        "does not stop while a search is shown",
        "The address and the key never reach the page.",
        "Only Chromium",
        "cannot be searched by meaning",
    ):
        assert needle in text, needle


def test_host_guide_states_what_search_does_not_do() -> None:
    text = " ".join(_section(HOST, "What search does not do").split())
    assert "Reduced data files cannot be searched by embedding." in text
    assert "Only Chromium has been tested automatically" in text
