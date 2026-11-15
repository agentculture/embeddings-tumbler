"""The demo set: ``scripts/build_demo_set.py`` against a fake embeddings endpoint, and the
pair committed under ``embeddings_tumbler/static/`` (``demo-wikipedia.json`` and ``.f32``).

The fake endpoint runs on a loopback port. A sentinel key is planted in the environment and
looked for in everything the script writes or prints.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import struct
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from tests.test_data_contract import _index
from tests.test_data_contract import validate as reference_validate

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "embeddings_tumbler" / "static"
CORPUS = ROOT / "data" / "wikipedia-vital-3" / "corpus.jsonl"
KEY = "SENTINEL-DEMO-KEY-5b9e01"
GATEWAY_TEXT = "SENTINEL-GATEWAY-TEXT-3c1d"
SERVED_MODEL = "fake/embedder-1"

_spec = importlib.util.spec_from_file_location(
    "build_demo_set", ROOT / "scripts" / "build_demo_set.py"
)
demo = importlib.util.module_from_spec(_spec)
sys.modules["build_demo_set"] = demo
_spec.loader.exec_module(demo)


def _vector(text: str, dimension: int) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [(digest[i % 32] - 128) / 128.0 for i in range(dimension)]


class FakeEndpoint:
    """An OpenAI-compatible ``/v1/embeddings`` on loopback; behaviour set per test."""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []
        self.auth: list[str | None] = []
        self.dimension = 6
        self.model = SERVED_MODEL
        self.change_at: int | None = None  # the batch number from which the answer changes
        self.change: str = ""  # "model", "dimension", "count", "error"
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length))
                endpoint.auth.append(self.headers.get("Authorization"))
                status, answer = endpoint.answer(self.path, body)
                data = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format, *args) -> None:  # noqa: A002
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def answer(self, path: str, body: dict) -> tuple[int, dict]:
        assert path == "/v1/embeddings"
        texts = body["input"]
        self.batches.append(texts)
        changed = self.change_at is not None and len(self.batches) > self.change_at
        if changed and self.change == "error":
            return 500, {"error": f"{GATEWAY_TEXT} key {KEY}"}
        dimension = self.dimension + (1 if changed and self.change == "dimension" else 0)
        model = self.model + ("-other" if changed and self.change == "model" else "")
        rows = [{"index": i, "embedding": _vector(t, dimension)} for i, t in enumerate(texts)][::-1]
        if changed and self.change == "count":
            rows = rows[1:]
        return 200, {"model": model, "data": rows}

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)


@pytest.fixture
def endpoint():
    e = FakeEndpoint()
    yield e
    e.close()


@pytest.fixture(scope="module")
def corpus(tmp_path_factory) -> Path:
    """The first 70 items of the committed corpus: three batches of 32."""
    lines = CORPUS.read_text(encoding="utf-8").splitlines()
    path = tmp_path_factory.mktemp("corpus") / "corpus.jsonl"
    path.write_text("\n".join(lines[:71]) + "\n", encoding="utf-8")
    return path


@pytest.fixture(autouse=True)
def _in_the_temporary_folder(tmp_path_factory, monkeypatch):
    """The script takes paths inside the current folder (or the repository) only."""
    monkeypatch.chdir(tmp_path_factory.getbasetemp())


def _env(endpoint: FakeEndpoint) -> dict[str, str]:
    return {"EMBEDDINGS_API_KEY": KEY, "EMBEDDINGS_EMBED_URL": endpoint.base}


def _run(args, environ, capsys):
    code = demo.main([str(a) for a in args], environ)
    out = capsys.readouterr()
    return code, out.out, out.err


def _pair(folder: Path, name: str = "demo-wikipedia") -> tuple[dict, bytes]:
    return (
        json.loads((folder / f"{name}.json").read_text(encoding="utf-8")),
        (folder / f"{name}.f32").read_bytes(),
    )


def _assert_valid(records: dict, block: bytes) -> None:
    assert reference_validate(records, block, None, _index()["messages"]) == []


def _no_key(*texts) -> None:
    for text in texts:
        assert KEY not in text
        assert GATEWAY_TEXT not in text


# --------------------------------------------------------------------------- against the fake


def test_the_script_embeds_in_batches_and_writes_a_valid_pair(endpoint, corpus, tmp_path, capsys):
    code, out, err = _run(
        ["--corpus", corpus, "--out-dir", tmp_path, "--endpoint-name", "test route", "--apply"],
        _env(endpoint),
        capsys,
    )
    assert code == 0, err
    assert [len(b) for b in endpoint.batches] == [32, 32, 6]
    assert set(endpoint.auth) == {f"Bearer {KEY}"}
    records, block = _pair(tmp_path)
    _assert_valid(records, block)
    assert records["model"] == SERVED_MODEL, "the model the endpoint names"
    assert records["dimension"] == 6
    assert records["count"] == 70
    assert records["text_included"] is True
    assert records["reduction"] == {
        "kind": "none",
        "source_dimension": 6,
        "directions_kept": 6,
        "variance_dropped": 0,
    }
    prov = records["provenance"]
    assert prov["synthetic"] is False
    assert prov["endpoint"] == "test route"
    assert prov["source"].startswith("Wikipedia: English Wikipedia, Wikipedia:Vital articles")
    assert "CC BY-SA 4.0" in prov["source"]
    assert "retrieved 2026-11-14" in prov["source"]
    assert any("creativecommons.org/licenses/by-sa/4.0/" in line for line in prov["limitations"])
    assert any(line.startswith("Changes: ") for line in prov["limitations"])
    assert prov["params"]["model_asked"] == demo._embed_route.DEFAULT_EMBED_MODEL
    items = [json.loads(line) for line in corpus.read_text(encoding="utf-8").splitlines()[1:]]
    assert [p["id"] for p in records["points"]] == [i["id"] for i in items]
    assert [p["label"] for p in records["points"]] == [i["title"] for i in items]
    assert records["points"][0]["metadata"]["text"] == items[0]["text"]
    # The vectors are the endpoint's, in corpus order (the fake answers rows reversed).
    first = struct.unpack("<6f", block[:24])
    assert first == pytest.approx(_vector(items[0]["text"], 6))
    assert "wrote 70 points x 6 dimensions" in out
    _no_key(out, err, (tmp_path / "demo-wikipedia.json").read_text(encoding="utf-8"))
    assert KEY.encode() not in block


def test_the_same_corpus_and_answers_give_the_same_bytes(endpoint, corpus, tmp_path, capsys):
    for folder in ("a", "b"):
        args = ["--corpus", corpus, "--out-dir", tmp_path / folder, "--apply"]
        assert _run(args, _env(endpoint), capsys)[0] == 0
    assert _pair(tmp_path / "a") == _pair(tmp_path / "b")


@pytest.mark.parametrize("change", ["model", "dimension", "count", "error"])
def test_an_inconsistent_or_failing_endpoint_writes_nothing(
    endpoint, corpus, tmp_path, capsys, change
):
    endpoint.change, endpoint.change_at = change, 1
    code, out, err = _run(
        ["--corpus", corpus, "--out-dir", tmp_path, "--apply"], _env(endpoint), capsys
    )
    assert code == 1
    assert not list(tmp_path.iterdir()), "nothing is written"
    expected = {
        "model": "the model changed between batches",
        "dimension": "the dimension changed between batches",
        "count": "wrong number of vectors",
        "error": "did not answer",
    }[change]
    assert expected in err
    _no_key(out, err)


def test_without_a_key_the_script_names_the_variables_only(corpus, tmp_path, capsys):
    code, out, err = _run(["--corpus", corpus, "--out-dir", tmp_path, "--apply"], {}, capsys)
    assert code == 1
    assert "EMBEDDINGS_API_KEY" in err
    assert not list(tmp_path.iterdir())


def test_an_unexpected_failure_prints_no_traceback_and_no_setting(
    endpoint, corpus, tmp_path, capsys, monkeypatch
):
    def boom(*args, **kwargs):
        raise RuntimeError(f"{KEY} {endpoint.base}")

    monkeypatch.setattr(demo._embed_route, "gateway_post", boom)
    code, out, err = _run(
        ["--corpus", corpus, "--out-dir", tmp_path, "--apply"], _env(endpoint), capsys
    )
    assert code == 2
    assert "Traceback" not in err
    assert endpoint.base not in err
    _no_key(out, err)


def test_the_key_never_reaches_a_subprocess_run_either(endpoint, corpus, tmp_path):
    env = {"PATH": "/usr/bin:/bin", **_env(endpoint)}
    endpoint.change, endpoint.change_at = "error", 0
    done = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_demo_set.py"), "--corpus", str(corpus)]
        + ["--out-dir", str(tmp_path), "--apply"],
        capture_output=True,
        text=True,
        env=env,
        cwd=tmp_path.parent,  # the folder that holds both the corpus and the output
        check=False,
        timeout=120,
    )
    assert done.returncode == 1
    _no_key(done.stdout, done.stderr)
    assert "Traceback" not in done.stderr


def test_a_preview_writes_nothing(endpoint, corpus, tmp_path, capsys):
    code, out, _ = _run(["--corpus", corpus, "--out-dir", tmp_path], _env(endpoint), capsys)
    assert code == 0
    assert "would write 70 points" in out
    assert not list(tmp_path.iterdir())


def test_the_stand_in_needs_no_endpoint_and_says_it_is_not_a_model(corpus, tmp_path, capsys):
    args = ["--corpus", corpus, "--out-dir", tmp_path, "--stand-in", "--limit", "30", "--apply"]
    assert _run(args, {}, capsys)[0] == 0
    records, block = _pair(tmp_path)
    _assert_valid(records, block)
    assert records["model"] == demo.STAND_IN_MODEL
    assert records["provenance"]["synthetic"] is True
    assert records["provenance"]["limitations"][0].startswith("STAND-IN")
    assert records["count"] == 30
    assert records["dimension"] == demo.STAND_IN_DIMENSION


@pytest.mark.parametrize(
    "extra, message",
    [
        (["--name", "../x"], "plain file name"),
        (["--endpoint-name", "gateway.internal:8001"], "not an address"),
        (["--batch", "0"], "at least 1"),
        (["--limit", "0"], "at least 1"),
    ],
)
def test_bad_arguments_are_refused(corpus, tmp_path, capsys, extra, message):
    code, _, err = _run(["--corpus", corpus, "--out-dir", tmp_path, *extra], {}, capsys)
    assert code == 1
    assert message in err


@pytest.mark.parametrize(
    "content, message",
    [
        (None, "cannot read the corpus"),
        ('{"record": "item"}\n', "header record"),
        ('{"record": "header"}\n{"id": "a", "title": "A", "group": "g"}\n', "has no text"),
        ('{"record": "header"}\n', "no items"),
    ],
)
def test_a_bad_corpus_is_refused(tmp_path, capsys, content, message):
    path = tmp_path / "c.jsonl"
    if content is not None:
        path.write_text(content, encoding="utf-8")
    code, _, err = _run(["--corpus", path, "--stand-in", "--out-dir", tmp_path / "o"], {}, capsys)
    assert code == 1
    assert message in err


@pytest.mark.parametrize("option", ["--corpus", "--out-dir"])
def test_a_path_outside_the_current_folder_and_the_repository_is_refused(
    corpus, tmp_path, capsys, monkeypatch, option
):
    inside = tmp_path / "inside"
    inside.mkdir()
    (inside / "c.jsonl").write_bytes(corpus.read_bytes())
    monkeypatch.chdir(inside)
    paths = {"--corpus": "c.jsonl", "--out-dir": "out"}
    paths[option] = str(tmp_path / "elsewhere")
    args = ["--corpus", paths["--corpus"], "--out-dir", paths["--out-dir"], "--stand-in"]
    code, _, err = _run([*args, "--apply"], {}, capsys)
    assert code == 1
    assert f"{option} must be inside the current folder or the repository" in err
    assert not (inside / "out").exists()
    assert not (tmp_path / "elsewhere").exists()


def test_relative_paths_and_the_current_folder_itself_are_taken(corpus, tmp_path, capsys):
    (tmp_path / "c.jsonl").write_bytes(corpus.read_bytes())
    here = tmp_path.name
    args = ["--corpus", f"{here}/c.jsonl", "--out-dir", here, "--stand-in", "--limit", "3"]
    code, _, _ = _run([*args, "--apply"], {}, capsys)
    assert code == 0
    assert _pair(tmp_path)[0]["count"] == 3
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "c.jsonl",
        "demo-wikipedia.f32",
        "demo-wikipedia.json",
    ]


def test_a_path_inside_the_repository_is_taken_from_any_folder(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert demo.allowed_path(str(CORPUS), "--corpus") == str(CORPUS.resolve())
    assert demo.allowed_path(".", "--out-dir", folder_ok=True) == str(tmp_path.resolve())
    with pytest.raises(demo.BuildError, match="--out-dir must be inside"):
        demo.allowed_path("..", "--out-dir", folder_ok=True)


def test_a_file_is_never_written_outside_its_folder(tmp_path):
    folder = tmp_path / "pair"
    folder.mkdir()
    with pytest.raises(demo.BuildError, match="nothing was written there"):
        demo._write(str(folder), "../x.f32", b"1234")
    assert not (tmp_path / "x.f32").exists()
    demo._write(str(folder), "x.f32", b"1234")
    assert [p.name for p in folder.iterdir()] == ["x.f32"]


def test_a_link_that_leads_out_of_the_output_folder_is_refused(corpus, tmp_path, capsys):
    out = tmp_path / "out"
    out.mkdir()
    (out / "demo-wikipedia.f32").symlink_to(tmp_path / "elsewhere.f32")
    args = ["--corpus", corpus, "--out-dir", out, "--stand-in", "--limit", "3", "--apply"]
    code, _, err = _run(args, {}, capsys)
    assert code == 1
    assert "nothing was written there" in err
    assert "Traceback" not in err
    assert not (tmp_path / "elsewhere.f32").exists()
    assert not (out / "demo-wikipedia.json").exists()


def test_malformed_vectors_are_refused():
    with pytest.raises(demo.BuildError, match="not a list of numbers"):
        demo.parse_batch({"data": [{"embedding": [1.0, float("nan")]}]}, 1)
    with pytest.raises(demo.BuildError, match="not a list of numbers"):
        demo.parse_batch({"data": ["x"]}, 1)
    assert demo.parse_batch({"data": [{"embedding": [1, 2]}]}, 1) == (None, [[1.0, 2.0]])


# --------------------------------------------------------------------------- the committed pair


@pytest.fixture(scope="module")
def committed() -> tuple[dict, bytes]:
    return _pair(STATIC)


def test_the_committed_pair_passes_the_reference_validator(committed):
    _assert_valid(*committed)


def test_the_committed_pair_comes_from_the_committed_corpus(committed):
    records, _ = committed
    lines = CORPUS.read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    items = [json.loads(line) for line in lines[1 : records["count"] + 1]]
    assert [p["id"] for p in records["points"]] == [i["id"] for i in items]
    assert [p["label"] for p in records["points"]] == [i["title"] for i in items]
    assert [p["group"] for p in records["points"]] == [i["group"] for i in items]
    prov = records["provenance"]
    assert f"revision {header['list_revision']}" in prov["source"]
    assert f"retrieved {header['retrieved']}" in prov["source"]
    assert "CC BY-SA 4.0" in prov["source"]
    assert records["text_included"] is True
    assert records["reduction"]["kind"] == "none"
    assert records["vectors"]["file"] == "demo-wikipedia.f32"


def test_the_committed_pair_says_honestly_whether_it_is_a_stand_in(committed):
    records, _ = committed
    stand_in = records["model"] == demo.STAND_IN_MODEL
    assert records["provenance"]["synthetic"] is stand_in
    if not stand_in:
        assert records["count"] == len(CORPUS.read_text(encoding="utf-8").splitlines()) - 1


def test_the_committed_pair_text_names_no_other_origin(committed):
    text = (STATIC / "demo-wikipedia.json").read_text(encoding="utf-8")
    assert "://" not in text
    assert '"//' not in text


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_the_committed_pair_is_accepted_by_the_javascript_loader(committed):
    script = """
const fs = require("node:fs"), path = require("node:path");
const C = require(process.argv[1])._internal.contract;
const dir = process.argv[2];
const fetchFile = (url) => {
  const bytes = fs.readFileSync(path.join(dir, url));
  return Promise.resolve({ ok: true, status: 200,
    json: async () => JSON.parse(bytes.toString("utf8")),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
};
C.loadFile("demo-wikipedia.json", fetchFile, null).then((r) =>
  console.log(JSON.stringify({ ok: r.ok, message: r.message || null,
    count: r.ok ? r.set.count : null, dimension: r.ok ? r.set.dimension : null })));
"""
    done = subprocess.run(
        ["node", "-e", script, str(STATIC / "embeddings-tumbler.js"), str(STATIC)],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    result = json.loads(done.stdout)
    records, _ = committed
    assert result == {
        "ok": True,
        "message": None,
        "count": records["count"],
        "dimension": records["dimension"],
    }
