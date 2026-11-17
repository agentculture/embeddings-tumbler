"""The scripts behind relative search, run in this process with no network and no gateway.

``scripts/measure_relative.py`` (the evidence page's figures), ``build_reference_rerank.py``
(the reference page's reranker scores), ``compare_relative_reference.py`` (the build against
the reference page), ``gen_relative_fixtures.py`` (the two fixtures) and
``workforce_brief.py``. Where a script would call the gateway, ``node`` or ``devague``, the
call is replaced here by a stand-in that records what it was given.
"""

from __future__ import annotations

import array
import importlib.util
import json
import math
import shutil
import subprocess  # nosec B404 - only its CompletedProcess type is used; nothing is run
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "relative"
SUBSET = FIXTURES / "wikipedia-subset.json"
MIXED = FIXTURES / "mixed-length.json"
KEY = "SENTINEL-RERANK-KEY-71c4"
SERVED = "fake/reranker-1"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


measure = _load("measure_relative")
rerank = _load("build_reference_rerank")
compare = _load("compare_relative_reference")
fixtures = _load("gen_relative_fixtures")
brief = _load("workforce_brief")


def _rows(path: Path) -> tuple[dict, list[list[float]]]:
    """A pair read by this test's own code, to check the scripts' reading against."""
    meta = json.loads(path.read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((path.parent / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    dim = meta["dimension"]
    return meta, [block[i * dim : (i + 1) * dim].tolist() for i in range(meta["count"])]


def _dot(a: list[float], b: list[float]) -> float:
    return math.sumprod(a, b)


def _write_pair(folder: Path, rows: list[list[float]], labels: list[str], **changes) -> Path:
    """A small data pair in ``folder``; ``changes`` overwrite fields of the JSON file."""
    block = array.array("f", [x for row in rows for x in row])
    if sys.byteorder != "little":
        block.byteswap()
    (folder / "small.f32").write_bytes(block.tobytes())
    meta = {
        "model": "test/model",
        "dimension": len(rows[0]),
        "count": len(rows),
        "vectors": {"file": "small.f32"},
        "points": [{"id": f"p{i}", "label": label} for i, label in enumerate(labels)],
    }
    meta.update(changes)
    path = folder / "small.json"
    path.write_text(json.dumps(meta), encoding="utf-8")
    return path


# ------------------------------------------------------------------ measure_relative


def test_load_pair_reads_the_rows_as_stored():
    meta, rows = measure.load_pair(SUBSET)
    want_meta, want = _rows(SUBSET)
    assert meta == want_meta
    assert len(rows) == meta["count"] == 173
    assert all(len(row) == meta["dimension"] for row in rows)
    assert rows == want


def test_orthonormalize_makes_rows_unit_length_and_perpendicular():
    rows = [[1.0, 1.0, 0.0, 0.0], [1.0, 0.0, 1.0, 0.0], [0.0, 1.0, 1.0, 2.0]]
    measure.orthonormalize(rows)
    for a, row in enumerate(rows):
        assert _dot(row, row) == pytest.approx(1, abs=1e-12)
        for other in rows[:a]:
            assert _dot(row, other) == pytest.approx(0, abs=1e-12)
    # the first row keeps its direction
    assert rows[0] == pytest.approx([math.sqrt(0.5), math.sqrt(0.5), 0, 0])


def test_orthonormalize_leaves_a_row_with_nothing_left_at_zero():
    rows = [[1.0, 0.0], [2.0, 0.0]]
    measure.orthonormalize(rows)
    assert rows[0] == [1.0, 0.0]
    assert rows[1] == [0.0, 0.0]


def test_remove_directions_and_centred():
    assert measure.remove_directions([3.0, 4.0, 5.0], [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]]) == [
        0.0,
        4.0,
        0.0,
    ]
    assert measure.centred([[1.0, 2.0], [3.0, 6.0]]) == [[-1.0, -2.0], [1.0, 2.0]]


def test_strongest_finds_the_directions_that_hold_the_most():
    # Sixteen axes, the k-th holding 4**-k of the spread: the eight strongest are the first
    # eight axes, in order, and their share is known exactly.
    dim = 16
    rows = []
    for k in range(dim):
        for sign in (1.0, -1.0):
            rows.append([sign * 2.0**-k if j == k else 0.0 for j in range(dim)])
    basis, total = measure.strongest(rows, seed=7)
    assert len(basis) == measure.SUBSPACE
    assert total == pytest.approx(2 * sum(4.0**-k for k in range(dim)))
    for k, q in enumerate(basis[:4]):
        assert abs(q[k]) == pytest.approx(1, abs=1e-6), k
    exact = sum(4.0**-k for k in range(8)) / sum(4.0**-k for k in range(dim))
    assert measure.share_of(rows, basis, total) == pytest.approx(exact, abs=1e-9)
    assert measure.held_by(rows, [1.0] + [0.0] * (dim - 1)) == pytest.approx(2.0)
    # the same seed gives the same answer; nothing held of nothing is a share of zero
    assert measure.strongest(rows, seed=7)[0] == basis
    assert measure.share_of(rows, basis, 0.0) == 0.0


def test_search_directions_drops_a_repeat_and_pins_at_most_three():
    e = [[1.0 if j == k else 0.0 for j in range(5)] for k in range(5)]
    pinned = measure.search_directions([[2.0, 0, 0, 0, 0], [4.0, 0, 0, 0, 0], [1.0, 1.0, 0, 0, 0]])
    assert len(pinned) == 2  # the second search points the same way as the first
    assert pinned[0] == pytest.approx(e[0])
    assert pinned[1] == pytest.approx(e[1])
    assert len(measure.search_directions(e)) == 3


def test_plain_without_removes_the_pinned_direction_from_the_plain_ones():
    plain = [[1.0, 0.0, 0.0], [math.sqrt(0.5), math.sqrt(0.5), 0.0], [0.0, 0.0, 1.0]]
    kept = measure.plain_without(plain, [[1.0, 0.0, 0.0]])
    # the first plain direction is the pinned one and is dropped; the second loses its part
    # along it
    assert len(kept) == 2
    assert kept[0] == pytest.approx([0.0, 1.0, 0.0])
    assert kept[1] == pytest.approx([0.0, 0.0, 1.0])
    assert measure.plain_without([[0.0, 0.0, 0.0]], []) == []


@pytest.fixture(scope="module")
def measured() -> dict:
    return measure.measure(SUBSET, ["Rice", "Rice+Wheat"], 7)


def test_measure_reports_the_set(measured):
    meta, rows = _rows(SUBSET)
    assert measured["file"] == "wikipedia-subset.json"
    assert measured["model"] == meta["model"]
    assert (measured["count"], measured["dimension"]) == (173, 768)
    assert measured["unit_length"] is True
    lengths = [math.sqrt(_dot(r, r)) for r in rows]
    assert measured["length_min"] == pytest.approx(min(lengths))
    assert measured["length_max"] == pytest.approx(max(lengths))
    mean = [sum(col) / len(rows) for col in zip(*rows)]
    assert measured["mean_length"] == pytest.approx(math.sqrt(_dot(mean, mean)))
    assert 0 < measured["plain_share"] < 1
    assert (measured["subspace"], measured["seed"]) == (8, 7)


def test_measure_reports_each_search_from_the_vectors(measured):
    meta, rows = _rows(SUBSET)
    labels = [p["label"] for p in meta["points"]]
    i = labels.index("Rice")
    cosines = sorted(
        (
            _dot(rows[i], r) / math.sqrt(_dot(r, r)) / math.sqrt(_dot(rows[i], rows[i]))
            for j, r in enumerate(rows)
            if j != i
        ),
        reverse=True,
    )
    one, two = measured["searches"]
    assert (one["search"], one["pinned"]) == ("Rice", 1)
    assert (two["search"], two["pinned"]) == ("Rice+Wheat", 2)
    assert [name for name, _ in one["nearest"][:5]] == ["Cereal", "Wheat", "Maize", "Bean", "Bread"]
    assert len(one["nearest"]) == 8
    assert one["nearest"][0][1] == round(cosines[0], 4)
    assert one["cosine_max"] == pytest.approx(cosines[0])
    assert one["cosine_median"] == pytest.approx(cosines[len(cosines) // 2])
    assert one["cosine_min"] == pytest.approx(cosines[-1])
    for s in (one, two):
        # both fits are approximate (a seeded iteration), so neither is a bound on the other;
        # on this set the plain fit reused holds within a few percent of the remainder's own
        assert 0 < s["remainder_share"] < 1
        assert 0.95 < s["reused_share"] / s["remainder_share"] < 1.01
        assert s["reused_directions"] == 8


def test_measure_tells_a_set_that_is_not_unit_length():
    result = measure.measure(MIXED, [], 7)
    assert result["unit_length"] is False
    assert result["length_max"] == pytest.approx(1, abs=1e-3)
    assert result["length_min"] < 0.8
    assert result["searches"] == []


def test_measure_refuses_a_label_the_set_does_not_have():
    with pytest.raises(SystemExit, match="no item is labelled 'Nowhere'"):
        measure.measure(SUBSET, ["Rice+Nowhere"], 7)


def test_measure_main_prints_and_writes_only_with_apply(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert measure.main([str(SUBSET), "--search", "Rice", "--out", "m.json"]) == 0
    out = capsys.readouterr().out
    assert "wikipedia-subset.json: 173 x 768 from google/embeddinggemma-2" in out
    assert "(unit length: yes)" in out
    assert "Rice: cosine 0.555 to 0.839, median 0.638" in out
    assert "nearest Cereal 0.839, Wheat 0.816" in out
    assert "(8 kept)" in out
    assert not (tmp_path / "m.json").exists()  # a preview writes nothing

    assert measure.main([str(SUBSET), "--search", "Rice", "--out", "m.json", "--apply"]) == 0
    assert "wrote m.json" in capsys.readouterr().out
    written = json.loads((tmp_path / "m.json").read_text(encoding="utf-8"))
    assert written == measure.measure(SUBSET, ["Rice"], 7)


def test_measure_main_needs_out_and_will_not_overwrite_without_force(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert measure.main([str(MIXED), "--apply"]) == 1
    assert "--apply needs --out" in capsys.readouterr().err
    (tmp_path / "m.json").write_text("kept", encoding="utf-8")
    assert measure.main([str(MIXED), "--apply", "--out", "m.json"]) == 1
    assert "m.json exists; pass --force to overwrite" in capsys.readouterr().err
    assert (tmp_path / "m.json").read_text(encoding="utf-8") == "kept"
    assert measure.main([str(MIXED), "--apply", "--out", "m.json", "--force"]) == 0
    assert json.loads((tmp_path / "m.json").read_text(encoding="utf-8"))["unit_length"] is False


def test_measure_refuses_paths_outside_the_current_folder_and_the_repository(
    tmp_path, monkeypatch, capsys
):
    inside = tmp_path / "inside"
    inside.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    data = _write_pair(outside, [[1.0, 0.0], [0.0, 1.0]], ["a", "b"])
    monkeypatch.chdir(inside)
    with pytest.raises(SystemExit, match="the data file must be inside the current folder"):
        measure.load_pair(data)
    with pytest.raises(SystemExit, match="--out must be inside the current folder"):
        measure.main([str(MIXED), "--apply", "--out", str(outside / "m.json")])
    assert not (outside / "m.json").exists()
    with pytest.raises(SystemExit, match="--out must be inside"):
        measure.main([str(MIXED), "--apply", "--out", "../outside/m.json"])
    assert not (outside / "m.json").exists()
    # a path inside the repository is taken from any folder, and so is a relative one here
    assert measure.allowed_path(str(SUBSET), "x") == str(SUBSET.resolve())
    assert measure.allowed_path("m.json", "x") == str((inside / "m.json").resolve())


def test_measure_refuses_a_block_that_is_elsewhere_or_the_wrong_size(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    rows = [[1.0, 0.0], [0.0, 1.0]]
    sub = tmp_path / "sub"
    sub.mkdir()
    _write_pair(tmp_path, rows, ["a", "b"])  # a real block one folder up
    elsewhere = _write_pair(sub, rows, ["a", "b"], vectors={"file": "../small.f32"})
    with pytest.raises(SystemExit, match="the vector block must be beside its data file"):
        measure.load_pair(elsewhere)
    for changes in ({"count": 3}, {"dimension": 0}, {"count": True}, {"dimension": "2"}):
        path = _write_pair(sub, rows, ["a", "b"], **changes)
        with pytest.raises(SystemExit, match="does not match count x dimension"):
            measure.load_pair(path)
    meta, read = measure.load_pair(_write_pair(sub, rows, ["a", "b"]))
    assert read == rows
    assert meta["count"] == 2


# ------------------------------------------------------------ build_reference_rerank


def _fake_gateway(monkeypatch, calls: list, answer=None):
    """Replace the gateway call: record the request and answer one score per document."""

    def post(config, path, payload, *, timeout, failed):
        calls.append({"config": config, "path": path, "payload": payload, "timeout": timeout})
        if answer is not None:
            return answer(payload)
        count = len(payload["documents"])
        # given out of order, as a reranker gives them: the score names its document by index
        results = [
            {"index": k, "relevance_score": _score(payload["query"], payload["documents"][k])}
            for k in reversed(range(count))
        ]
        return {"model": SERVED, "results": results}

    monkeypatch.setattr(rerank._embed_route, "gateway_post", post)


def _score(query: str, document: str) -> float:
    return ((len(query) * 31 + len(document) * 17) % 1000) / 1234.5


@pytest.fixture
def small_set(tmp_path, monkeypatch) -> dict:
    """The script pointed at the 173-item fixture and at a temporary output file."""
    static = tmp_path / "static"
    static.mkdir()
    shutil.copy(SUBSET, static / "demo-wikipedia.json")
    shutil.copy(FIXTURES / "wikipedia-subset.f32", static / "wikipedia-subset.f32")
    monkeypatch.setattr(rerank, "STATIC", static)
    monkeypatch.setattr(rerank, "ROOT", tmp_path)
    monkeypatch.setattr(rerank, "OUT", tmp_path / "out" / "rerank.json")
    (tmp_path / "out").mkdir()
    monkeypatch.chdir(tmp_path)
    for name in rerank._embed_route.KEY_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(rerank._embed_route.KEY_VARIABLES[0], KEY)
    monkeypatch.setenv(rerank._embed_route.URL_VARIABLE, "http://127.0.0.1:9/v1")
    meta, rows = _rows(SUBSET)
    return {"meta": meta, "rows": rows, "out": tmp_path / "out" / "rerank.json", "tmp": tmp_path}


def test_nearest_orders_by_dot_product_and_breaks_ties_by_index(monkeypatch):
    rows = [[1.0, 0.0], [0.0, 1.0], [0.9, 0.1], [0.0, 1.0], [-1.0, 0.0]]
    assert rerank.nearest(rows, 0) == [2, 1, 3, 4]
    assert rerank.nearest(rows, 1) == [3, 2, 0, 4]
    assert rerank.pools(rows) == [rerank.nearest(rows, i) for i in range(5)]
    monkeypatch.setattr(rerank, "CANDIDATES", 2)
    assert rerank.pools(rows)[0] == [2, 1]


def test_the_committed_reference_file_holds_the_pools_this_script_works_out():
    meta, rows = rerank.load_set()
    assert len(rows) == meta["count"] == 999
    committed = json.loads(rerank.OUT.read_text(encoding="utf-8"))
    labels = [p["label"] for p in meta["points"]]
    for i in (0, labels.index("Rice"), 998):
        assert rerank.nearest(rows, i) == committed["pool"][i], i


def test_load_set_refuses_a_block_of_the_wrong_size(small_set):
    path = small_set["tmp"] / "static" / "demo-wikipedia.json"
    meta = json.loads(path.read_text(encoding="utf-8"))
    meta["count"] += 1
    path.write_text(json.dumps(meta), encoding="utf-8")
    with pytest.raises(SystemExit, match="does not match count x dimension"):
        rerank.load_set()


def test_text_of_is_the_text_or_else_the_label():
    assert rerank.text_of({"label": "Rice", "metadata": {"text": "A cereal grain."}}) == (
        "A cereal grain."
    )
    assert rerank.text_of({"label": "Rice", "metadata": {"text": "  "}}) == "Rice"
    assert rerank.text_of({"label": "Rice", "metadata": None}) == "Rice"
    assert rerank.text_of({"label": 7}) == "7"


def test_ask_sends_the_points_text_and_its_pool_and_puts_scores_in_pool_order(monkeypatch):
    calls: list = []
    _fake_gateway(monkeypatch, calls)
    monkeypatch.setattr(rerank, "CANDIDATES", 2)
    texts = ["zero", "one one", "two two two"]
    pool = [[2, 1], [0, 2], [1, 0]]
    row = rerank.ask("config", "asked/model", texts, pool, 0)
    assert calls == [
        {
            "config": "config",
            "path": "/rerank",
            "payload": {
                "model": "asked/model",
                "query": "zero",
                "documents": ["two two two", "one one"],
            },
            "timeout": 120,
        }
    ]
    assert row == {
        "i": 0,
        "pool": [2, 1],
        "scores": [_score("zero", "two two two"), _score("zero", "one one")],
        "model": SERVED,
        "model_asked": "asked/model",
    }


def test_ask_names_the_asked_model_when_the_answer_names_none_and_refuses_a_bad_answer(
    monkeypatch,
):
    monkeypatch.setattr(rerank, "CANDIDATES", 2)
    scores = [{"index": 0, "relevance_score": 0.5}, {"index": 1, "relevance_score": 0.25}]
    _fake_gateway(monkeypatch, [], answer=lambda payload: {"results": scores})
    row = rerank.ask("config", "asked/model", ["a", "b", "c"], [[1, 2]], 0)
    assert row["model"] == "asked/model"
    assert row["scores"] == [0.5, 0.25]
    _fake_gateway(monkeypatch, [], answer=lambda payload: {"results": scores[:1]})
    with pytest.raises(SystemExit, match="search 0 was not one score per candidate"):
        rerank.ask("config", "asked/model", ["a", "b", "c"], [[1, 2]], 0)


def test_read_cache_keeps_only_answers_for_this_pool_and_this_model(tmp_path):
    pool = [[1, 2], [0, 2], [0, 1]]
    lines = [
        {"i": 0, "pool": [1, 2], "scores": [1, 2], "model": "m", "model_asked": "m"},
        {"i": 1, "pool": [2, 0], "scores": [1, 2], "model": "m", "model_asked": "m"},
        {"i": 2, "pool": [0, 1], "scores": [1, 2], "model": "m", "model_asked": "other"},
    ]
    path = tmp_path / "cache.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in lines), encoding="utf-8")
    assert rerank.read_cache(str(path), pool, "m") == {0: lines[0]}
    assert rerank.read_cache(str(tmp_path / "missing.jsonl"), pool, "m") == {}
    assert rerank.read_cache(None, pool, "m") == {}


def test_the_cache_must_be_inside_the_current_folder_or_the_repository(tmp_path, monkeypatch):
    inside = tmp_path / "inside"
    inside.mkdir()
    monkeypatch.chdir(inside)
    assert rerank.cache_path("c.jsonl") == str((inside / "c.jsonl").resolve())
    assert rerank.cache_path(str(ROOT / "c.jsonl")) == str((ROOT / "c.jsonl").resolve())
    with pytest.raises(SystemExit, match="--cache must be inside the current folder"):
        rerank.cache_path(str(tmp_path / "c.jsonl"))
    with pytest.raises(SystemExit, match="--cache must be inside"):
        rerank.cache_path("../c.jsonl")


def test_document_refuses_answers_from_more_than_one_reranker():
    done = {
        0: {"pool": [1], "scores": [0.5], "model": "a"},
        1: {"pool": [0], "scores": [0.5], "model": "b"},
    }
    with pytest.raises(SystemExit, match="more than one reranker model"):
        rerank.document({"count": 2, "model": "set/model"}, done)
    done[1]["model"] = "a"
    out = rerank.document({"count": 2, "model": "set/model"}, done)
    assert (out["reranker"], out["set_model"], out["count"]) == ("a", "set/model", 2)
    assert out["pool"] == [[1], [0]]


def test_a_preview_calls_nothing_and_writes_nothing(small_set, monkeypatch, capsys):
    calls: list = []
    _fake_gateway(monkeypatch, calls)
    assert rerank.main([]) == 0
    out = capsys.readouterr().out
    assert "would rerank 173 searches of 50 candidates with Qwen/Qwen3-Reranker-0.6B" in out
    assert "would write out/rerank.json" in out
    assert calls == []
    assert not small_set["out"].exists()


def test_apply_asks_once_per_point_and_writes_the_answers(small_set, monkeypatch, capsys):
    calls: list = []
    _fake_gateway(monkeypatch, calls)
    assert rerank.main(["--apply", "--cache", "cache.jsonl", "--workers", "2"]) == 0
    captured = capsys.readouterr()
    assert "wrote out/rerank.json" in captured.out
    assert f"reranker {SERVED}" in captured.out
    assert "150 of 173" in captured.err  # progress, every 50 answers

    meta, rows = small_set["meta"], small_set["rows"]
    texts = [p["metadata"]["text"] for p in meta["points"]]
    pool = rerank.pools(rows)
    assert len(calls) == 173
    asked = {call["payload"]["query"]: call for call in calls}
    assert set(asked) == set(texts)
    i = [p["label"] for p in meta["points"]].index("Rice")
    call = asked[texts[i]]
    assert call["path"] == "/rerank"
    assert call["payload"]["model"] == "Qwen/Qwen3-Reranker-0.6B"
    assert call["payload"]["documents"] == [texts[j] for j in pool[i]]
    assert call["config"].key == KEY
    assert call["config"].rerank_model == "Qwen/Qwen3-Reranker-0.6B"

    text = small_set["out"].read_text(encoding="utf-8")
    out = json.loads(text)
    assert out["kind"] == "embeddings-tumbler/reference-rerank"
    assert (out["count"], out["candidates"], out["reranker"]) == (173, 50, SERVED)
    assert out["set_model"] == meta["model"]
    assert out["pool"] == pool
    assert len(out["scores"]) == 173
    assert out["scores"][i] == [float(f"{_score(texts[i], texts[j]):.6g}") for j in pool[i]]
    # the key and the address are in neither the file, the cache nor anything printed
    cache = (small_set["tmp"] / "cache.jsonl").read_text(encoding="utf-8")
    assert len(cache.splitlines()) == 173
    for where in (text, cache, captured.out, captured.err):
        assert KEY not in where
        assert "127.0.0.1" not in where


def test_a_second_run_continues_from_the_cache_and_needs_force_to_overwrite(
    small_set, monkeypatch, capsys
):
    calls: list = []
    _fake_gateway(monkeypatch, calls)
    assert rerank.main(["--apply", "--cache", "cache.jsonl"]) == 0
    first = small_set["out"].read_bytes()
    cache = small_set["tmp"] / "cache.jsonl"
    kept = cache.read_text(encoding="utf-8").splitlines()
    cache.write_text("\n".join(kept[:100]) + "\n", encoding="utf-8")
    calls.clear()
    capsys.readouterr()

    assert rerank.main(["--apply", "--cache", "cache.jsonl"]) == 1
    assert "out/rerank.json exists; pass --force to overwrite" in capsys.readouterr().err
    assert calls == []

    assert rerank.main(["--apply", "--force", "--cache", "cache.jsonl"]) == 0
    assert len(calls) == 73  # only the answers the cache did not hold
    assert small_set["out"].read_bytes() == first
    assert len(cache.read_text(encoding="utf-8").splitlines()) == 173

    # answers kept for another model are asked for again
    calls.clear()
    assert rerank.main(["--apply", "--force", "--cache", "cache.jsonl", "--model", "m/2"]) == 0
    assert len(calls) == 173


def test_apply_without_a_cache_writes_the_same_file(small_set, monkeypatch):
    _fake_gateway(monkeypatch, [])
    assert rerank.main(["--apply"]) == 0
    out = json.loads(small_set["out"].read_text(encoding="utf-8"))
    assert out["pool"] == rerank.pools(small_set["rows"])
    assert not (small_set["tmp"] / "cache.jsonl").exists()


# -------------------------------------------------------- compare_relative_reference


@pytest.fixture(scope="module")
def real() -> dict:
    meta, block = compare.load_pair(compare.PAIR)
    committed = json.loads(compare.RERANK.read_text(encoding="utf-8"))
    titles = [str(p["label"]) for p in meta["points"]]
    return {"meta": meta, "block": block, "rerank": committed, "titles": titles}


def _agreeing_build(ref: dict) -> dict:
    """What the build's side would report when it agrees with the reference side ``ref``."""
    own = {"index": ref["own"], "height": 1.0, "rank": 1}
    plain = [own] + [
        {"index": r["index"], "height": r["height"], "rank": n}
        for n, r in enumerate(ref["plain"], 2)
    ]
    reranked = [own] + [
        {"index": r["index"], "height": r["height"], "rank": n}
        for n, r in enumerate(ref["reranked"], 2)
    ]
    return {
        "pinned": [{"letter": "A", "axis": "vertical"}],
        "own": {"index": ref["own"]},
        "settled": True,
        "row1Error": 1e-9,
        "measure": "cosine",
        "plain": plain,
        "reranked": reranked,
        "reranker": "reference-file/scores",
        "unknownCandidates": [],
        "sent": 51,
        "cut": {"height": ref["cut"]},
        "settings": {"k": 9, "candidates": 51, "top": 9},
        "overlayRanks": [{"index": r["index"], "ranks": [r["rank"]]} for r in reranked],
    }


def test_f32_rounds_as_a_float32_array_stores():
    assert compare.f32(0.5) == 0.5
    assert compare.f32(0.1) == array.array("f", [0.1])[0]
    assert compare.f32(0.1) != 0.1


def test_compare_load_pair_reads_the_block_and_refuses_a_wrong_size(real, tmp_path):
    assert len(real["block"]) == real["meta"]["count"] * real["meta"]["dimension"]
    path = _write_pair(tmp_path, [[1.0, 0.0], [0.0, 1.0]], ["a", "b"])
    meta, block = compare.load_pair(path)
    assert list(block) == [1.0, 0.0, 0.0, 1.0]
    assert meta["count"] == 2
    with pytest.raises(SystemExit, match="does not match count x dimension"):
        compare.load_pair(_write_pair(tmp_path, [[1.0, 0.0]], ["a"], count=2))


def test_the_reference_side_for_rice_is_the_specs_eight_and_the_files_order(real):
    ref = compare.reference_side(real["meta"], real["block"], real["rerank"], "rice")
    titles = real["titles"]
    assert titles[ref["own"]] == "Rice"
    assert ref["pinned"] == [{"letter": "A", "axis": "vertical"}]
    assert [titles[r["index"]] for r in ref["plain"]] == [
        "Cereal",
        "Wheat",
        "Maize",
        "Bean",
        "Bread",
        "Vegetable",
        "Cattle",
        "Potato",
    ]
    heights = [r["height"] for r in ref["plain"]]
    assert heights == sorted(heights, reverse=True)
    assert f"{heights[0]:.2f}" == "0.84"
    # the reranked eight are the file's eight highest scores for Rice, in that order
    pool, scores = real["rerank"]["pool"][ref["own"]], real["rerank"]["scores"][ref["own"]]
    best = sorted(zip(scores, pool), key=lambda pair: -pair[0])[:8]
    assert [r["index"] for r in ref["reranked"]] == [j for _, j in best]
    assert [r["rank"] for r in ref["reranked"]] == list(range(1, 9))
    assert ref["candidates"] == 50
    assert ref["reranker"] == "Qwen/Qwen3-Reranker-0.6B"
    lowest = min(r["height"] for r in ref["reranked"])
    assert ref["cut"] <= lowest  # the cut-off line is at the last candidate's height
    with pytest.raises(SystemExit, match="no article titled 'Nowhere at all'"):
        compare.reference_side(real["meta"], real["block"], real["rerank"], "Nowhere at all")


def test_only_one_of_the_sets_own_titles_is_handed_to_node():
    titles = ["Rice", "Niccolò Machiavelli", "-rf", "a\nb", "Rock and roll"]
    assert compare.known_title("rice", titles) == "Rice"
    assert compare.known_title("NICCOLÒ MACHIAVELLI", titles) == "Niccolò Machiavelli"
    assert compare.known_title("Rock and roll", titles) == "Rock and roll"
    for label in ("Wheat", "--eval", "-rf", "a\nb", ""):
        with pytest.raises(ValueError, match="no article titled"):
            compare.known_title(label, titles)


def test_every_title_of_the_shipped_set_can_be_searched_from(real):
    for title in real["titles"]:
        assert compare.known_title(title, real["titles"]) == title


def test_build_side_runs_node_on_the_fixed_script_with_the_sets_title(monkeypatch):
    ran: list = []

    def run(command, **options):
        ran.append((command, options))
        return subprocess.CompletedProcess(command, 0, stdout='{"settled": true}', stderr="")

    monkeypatch.setattr(compare.shutil, "which", lambda name: "/somewhere/" + name)
    monkeypatch.setattr(compare.subprocess, "run", run)
    assert compare.build_side("rice", ["Wheat", "Rice"]) == {"settled": True}
    command, options = ran[0]
    assert command == [
        "/somewhere/node",
        str(compare.BUILD_SIDE),
        str(compare.PAIR),
        str(compare.RERANK),
        "Rice",
    ]
    assert options["timeout"] == compare.TIMEOUT
    assert options["cwd"] == compare.ROOT
    assert "shell" not in options

    # a title the set does not hold never reaches node
    ran.clear()
    with pytest.raises(RuntimeError, match="no article titled '--eval'"):
        compare.build_side("--eval", ["Wheat", "Rice"])
    assert ran == []


def test_build_side_says_when_node_is_missing_or_fails(monkeypatch):
    monkeypatch.setattr(compare.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="node is not installed"):
        compare.build_side("Rice", ["Rice"])

    def run(command, **options):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="no point labelled x\n")

    monkeypatch.setattr(compare.shutil, "which", lambda name: "node")
    monkeypatch.setattr(compare.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="the build's side failed: no point labelled x"):
        compare.build_side("Rice", ["Rice"])


def test_compare_lists_a_result_only_one_side_has(real):
    ref = compare.reference_side(real["meta"], real["block"], real["rerank"], "Rice")
    build = _agreeing_build(ref)
    assert compare.compare(ref, build, real["titles"])["agree"] is True
    build["plain"].pop()
    build["cut"] = None
    result = compare.compare(ref, build, real["titles"])
    assert result["agree"] is False
    failed = {c["check"] for c in result["checks"] if not c["ok"]}
    assert failed == {
        "plain: same articles in the same order",
        "plain: heights to 2 decimal places",
        "cut-off line height",
    }
    last = [r for r in result["rows"] if r["part"] == "plain"][-1]
    assert (last["place"], last["reference"], last["build"]) == (8, "Potato", "")
    assert (last["build_height"], last["build_rank"], last["agree"]) == ("", None, False)
    cut = next(c for c in result["checks"] if c["check"] == "cut-off line height")
    assert cut["detail"].startswith("build none, reference ")


def _main_with(monkeypatch, real, change=None, search="Rice"):
    """Run main() with the build's side replaced by one made from the reference side."""
    seen: list = []

    def build_side(label, titles):
        seen.append(label)
        ref = compare.reference_side(real["meta"], real["block"], real["rerank"], label)
        build = _agreeing_build(ref)
        if change:
            change(build)
        return build

    monkeypatch.setattr(compare, "build_side", build_side)
    return seen


def test_main_prints_the_table_and_agrees(monkeypatch, real, capsys):
    seen = _main_with(monkeypatch, real)
    assert compare.main([]) == 0
    assert seen == ["Rice"]
    out = capsys.readouterr().out
    assert "Search 'Rice' on 999 articles, 768 dimensions, google/embeddinggemma-2" in out
    assert "reranker scores from Qwen/Qwen3-Reranker-0.6B" in out
    assert compare.GIVEN in out
    lines = out.splitlines()
    first = next(line for line in lines if line.startswith(" 1. "))
    assert first.split() == ["1.", "Cereal", "0.84", "Cereal", "0.84", "2", "same"]
    assert sum(line.startswith("ok  ") for line in lines) == 9
    assert not any(line.startswith("FAIL") for line in lines)
    assert "DIFFERS" not in out
    assert lines[-1] == "AGREE: the build and the reference page agree on every check."


def test_main_json_holds_the_checks_and_what_the_build_was_given(monkeypatch, real, capsys):
    _main_with(monkeypatch, real, search="Wheat")
    assert compare.main(["--json", "--search", "Wheat"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["search"] == "Wheat"
    assert out["set"] == {"model": "google/embeddinggemma-2", "count": 999, "dimension": 768}
    assert out["agree"] is True
    assert out["verdict"].startswith("AGREE")
    assert out["build_settings"] == {"k": 9, "candidates": 51, "top": 9}
    assert out["given_to_the_build"] == compare.GIVEN
    assert out["build_overlay_ranks"][0] == {"title": "Wheat", "ranks": [1]}
    assert len(out["rows"]) == 16
    assert all(row["agree"] for row in out["rows"])


def test_main_says_differ_and_exits_1_when_a_height_differs(monkeypatch, real, capsys):
    def lower(build):
        build["plain"][1]["height"] -= 0.05

    _main_with(monkeypatch, real, change=lower)
    assert compare.main([]) == 1
    out = capsys.readouterr().out
    assert "FAIL plain: heights to 2 decimal places" in out
    assert "DIFFERS" in out
    assert out.splitlines()[-1].startswith("DIFFER: at least one check failed")


def test_main_exits_2_when_the_build_cannot_be_run_or_the_file_is_for_another_set(
    monkeypatch, real, tmp_path, capsys
):
    def missing(label, titles):
        raise RuntimeError("node is not installed, so the built viewer cannot be run")

    monkeypatch.setattr(compare, "build_side", missing)
    assert compare.main([]) == 2
    captured = capsys.readouterr()
    assert captured.err.strip() == (
        "cannot compare: node is not installed, so the built viewer cannot be run"
    )
    assert captured.out == ""

    other = tmp_path / "rerank.json"
    other.write_text(json.dumps({**real["rerank"], "count": 5}), encoding="utf-8")
    monkeypatch.setattr(compare, "RERANK", other)
    assert compare.main([]) == 2
    assert "the reranker file was made for another set" in capsys.readouterr().err


# ------------------------------------------------------------ gen_relative_fixtures


@pytest.fixture(scope="module")
def built() -> dict:
    return fixtures.build()


@pytest.mark.parametrize("name", ["wikipedia-subset", "mixed-length"])
def test_the_committed_fixtures_are_what_the_generator_builds(built, name):
    meta, data = built[name]
    assert data == (FIXTURES / f"{name}.f32").read_bytes()
    text = json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n"
    assert text == (FIXTURES / f"{name}.json").read_text(encoding="utf-8")


def test_the_generator_keeps_everyday_life_and_every_eighth_other_article(built):
    whole = json.loads((fixtures.STATIC / "demo-wikipedia.json").read_text(encoding="utf-8"))
    meta, data = built["wikipedia-subset"]
    everyday = [p["id"] for p in whole["points"] if p.get("group") == "Everyday life"]
    others = [p["id"] for p in whole["points"] if p.get("group") != "Everyday life"]
    kept = [p["id"] for p in meta["points"]]
    assert set(kept) == set(everyday) | set(others[::8])
    assert meta["count"] == len(kept) == 173
    assert meta["vectors"]["file"] == "wikipedia-subset.f32"
    assert meta["vectors"]["byte_length"] == len(data) == 173 * meta["dimension"] * 4
    assert meta["provenance"]["synthetic"] is False
    assert meta["provenance"]["limitations"][0].startswith("A test fixture: 173 of the demo")


def test_the_mixed_fixture_scales_each_vector_by_its_texts_length(built):
    meta, data = built["mixed-length"]
    block = array.array("f")
    block.frombytes(data)
    if sys.byteorder != "little":
        block.byteswap()
    dim = meta["dimension"]
    texts = [len(p["metadata"]["text"]) for p in meta["points"]]
    longest = max(texts)
    for i in (0, 50, texts.index(longest), 172):
        row = block[i * dim : (i + 1) * dim]
        assert math.sqrt(_dot(row, row)) == pytest.approx(texts[i] / longest, abs=1e-3), i
    assert meta["provenance"]["synthetic"] is True
    assert "The lengths are not model output." in meta["provenance"]["limitations"][0]


def test_the_generator_previews_then_writes_and_will_not_overwrite_without_force(
    built, tmp_path, monkeypatch, capsys
):
    out = tmp_path / "fixtures"
    monkeypatch.setattr(fixtures, "ROOT", tmp_path)
    monkeypatch.setattr(fixtures, "OUT", out)
    monkeypatch.setattr(fixtures, "build", lambda: built)

    monkeypatch.setattr(sys, "argv", ["gen_relative_fixtures.py"])
    assert fixtures.main() == 0
    printed = capsys.readouterr().out
    assert "wikipedia-subset: 173 x 768, 531456 bytes" in printed
    assert "mixed-length: 173 x 768, 531456 bytes" in printed
    assert "would write to fixtures (pass --apply)" in printed
    assert not out.exists()

    monkeypatch.setattr(sys, "argv", ["gen_relative_fixtures.py", "--apply"])
    assert fixtures.main() == 0
    assert "wrote 4 files to fixtures" in capsys.readouterr().out
    for name in ("wikipedia-subset", "mixed-length"):
        for ext in (".json", ".f32"):
            assert (out / (name + ext)).read_bytes() == (FIXTURES / (name + ext)).read_bytes()

    (out / "mixed-length.f32").write_bytes(b"kept")
    assert fixtures.main() == 1
    assert "fixtures exist; pass --force to overwrite" in capsys.readouterr().err
    assert (out / "mixed-length.f32").read_bytes() == b"kept"

    monkeypatch.setattr(sys, "argv", ["gen_relative_fixtures.py", "--apply", "--force"])
    assert fixtures.main() == 0
    assert (out / "mixed-length.f32").read_bytes() == (FIXTURES / "mixed-length.f32").read_bytes()


# ------------------------------------------------------------------ workforce_brief


def _plan() -> dict:
    return {
        "plan": "relative-search",
        "tasks": {
            "t7": {
                "summary": "The ruler is drawn.",
                "instruction": "Draw the ruler beside the picture.",
                "acceptance_criteria": ["Ticks every 0.1.", "The origin is marked."],
                "covers": ["c12", "h3"],
            },
            "t8": {
                "summary": "Nothing to say.",
                "instruction": "",
                "acceptance_criteria": [],
                "covers": [],
            },
        },
    }


def _brief(monkeypatch, capsys, task: str) -> tuple[str, list]:
    ran: list = []

    def run(command, **options):
        ran.append((command, options))
        return subprocess.CompletedProcess(command, 0, stdout=json.dumps(_plan()), stderr="")

    # the stand-in is in place before main() is called: the plan tool itself is never run
    monkeypatch.setattr(brief.subprocess, "run", run)
    monkeypatch.setattr(sys, "argv", ["workforce_brief.py", task, "/work/agent-" + task])
    assert brief.main() == 0
    return capsys.readouterr().out, ran


def test_the_brief_quotes_the_task_from_the_plan(monkeypatch, capsys):
    out, ran = _brief(monkeypatch, capsys, "t7")
    assert ran == [
        (
            ["devague", "plan", "waves", "--json"],
            {"check": True, "capture_output": True, "text": True},
        )
    ]
    lines = out.splitlines()
    assert lines[0] == "# Brief for task t7 (plan relative-search)"
    assert "Your worktree: `/work/agent-t7` on branch `agent/t7`. Work only there." in lines
    assert lines[lines.index("## Summary") + 2] == "The ruler is drawn."
    assert lines[lines.index("## Instruction") + 2] == "Draw the ruler beside the picture."
    at = lines.index("## Acceptance criteria")
    assert lines[at + 2 : at + 4] == ["1. Ticks every 0.1.", "2. The origin is marked."]
    assert lines[lines.index("## Spec targets this task covers") + 2] == "c12, h3"


def test_the_brief_says_so_when_a_task_has_no_instruction_or_targets(monkeypatch, capsys):
    out, _ = _brief(monkeypatch, capsys, "t8")
    lines = out.splitlines()
    assert lines[lines.index("## Instruction") + 2] == "(this task has no instruction)"
    assert lines[lines.index("## Spec targets this task covers") + 2] == "(none)"
    assert "1. " not in out
