"""t13: the wheel and the npm tarball carry the same core file, and versions stay in step.

Three groups:

- version lockstep: pyproject.toml, package.json, the CHANGELOG's top entry and
  ``scripts/sync_version.py`` (the step that carries a bumped version into
  package.json, because the vendored version-bump skill predates package.json);
- the npm package's shape: what ``npm pack`` puts in the tarball, exactly;
- ``scripts/check_packages.py``: passes on a real build of both packages and
  fails, with a clear message, on doctored ones (synthetic fixtures built in a
  temp dir, plus one doctored copy of the real tarball).
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "embeddings_tumbler" / "static"
CORE = "embeddings-tumbler.js"
SHIPPED_STATIC = (
    "embeddings-tumbler.js",
    "index.html",
    "page.css",
    "page.js",
    "sample-data.js",
    "web-component.js",
)
TARBALL_FILES = sorted(
    ["package.json", "README.md", "LICENSE"]
    + [f"embeddings_tumbler/static/{name}" for name in SHIPPED_STATIC]
)


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


check_packages = _load("check_packages", "check_packages.py")
sync_version = _load("sync_version", "sync_version.py")

HAVE_NPM = shutil.which("npm") is not None
HAVE_UV = shutil.which("uv") is not None
needs_npm = pytest.mark.skipif(not HAVE_NPM, reason="npm is not installed; cannot pack")
needs_both = pytest.mark.skipif(
    not (HAVE_NPM and HAVE_UV), reason="npm and uv are both needed to build the two packages"
)


def _pyproject_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return data["project"]["version"]


def _package_json() -> dict:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Version lockstep
# ---------------------------------------------------------------------------


def test_package_json_version_matches_pyproject():
    assert (
        _package_json()["version"] == _pyproject_version()
    ), "package.json is out of step with pyproject.toml: run python3 scripts/sync_version.py"


def test_changelog_top_entry_matches_pyproject():
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(r"^## \[([^\]]+)\]", text, re.MULTILINE)
    assert match, "CHANGELOG.md has no '## [x.y.z]' entry"
    assert match.group(1) == _pyproject_version()


def test_core_header_version_matches_pyproject():
    first = (STATIC / CORE).read_text(encoding="utf-8").splitlines()[0]
    assert check_packages.header_version((STATIC / CORE).read_bytes()) == _pyproject_version()
    assert first.startswith("/*! embeddings-tumbler ")


def test_sync_version_check_passes_on_the_repo():
    assert sync_version.main(["--check"]) == 0


def test_sync_version_check_fails_then_writes_then_passes(tmp_path, monkeypatch, capsys):
    pyproject = tmp_path / "pyproject.toml"
    package = tmp_path / "package.json"
    pyproject.write_text('[project]\nname = "x"\nversion = "1.2.4"\n', encoding="utf-8")
    original = '{\n  "name": "x",\n  "version": "1.2.3",\n  "files": ["a"]\n}\n'
    package.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sync_version, "PYPROJECT", pyproject)
    monkeypatch.setattr(sync_version, "PACKAGE_JSON", package)

    assert sync_version.main(["--check"]) == 1
    assert "1.2.3" in capsys.readouterr().err
    assert sync_version.main([]) == 0
    # Only the version string changes; formatting and key order are kept.
    assert package.read_text(encoding="utf-8") == original.replace("1.2.3", "1.2.4")
    assert sync_version.main(["--check"]) == 0


# ---------------------------------------------------------------------------
# The npm package's shape
# ---------------------------------------------------------------------------


def test_package_json_is_publishable_and_dependency_free():
    pkg = _package_json()
    assert pkg["name"] == "@culture.dev/embeddings-tumbler"
    assert not pkg.get("private")
    assert pkg["license"] == "Apache-2.0"
    assert pkg["publishConfig"] == {"access": "public"}
    # Trusted publishing checks the repository against the GitHub repo.
    assert pkg["repository"] == {
        "type": "git",
        "url": "git+https://github.com/agentculture/embeddings-tumbler.git",
    }
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        assert not pkg.get(key), key
    # No install-time or pack-time scripts run on a consumer's machine.
    lifecycle = {"preinstall", "install", "postinstall", "prepare", "prepack", "postpack"}
    assert not lifecycle & set(pkg.get("scripts", {}))


def test_entry_points_all_name_the_one_core_file():
    pkg = _package_json()
    core = "embeddings_tumbler/static/embeddings-tumbler.js"
    for key in ("main", "browser", "unpkg", "jsdelivr"):
        assert pkg[key] == core, key
    assert pkg["exports"]["."] == "./" + core
    for name in SHIPPED_STATIC:
        assert pkg["exports"]["./" + name] == "./embeddings_tumbler/static/" + name


def test_files_field_lists_exactly_the_shipped_static_set():
    pkg = _package_json()
    on_disk = sorted(p.name for p in STATIC.iterdir() if p.is_file())
    assert on_disk == sorted(SHIPPED_STATIC), "embeddings_tumbler/static/ changed: update t13"
    listed = sorted(f for f in pkg["files"] if f.startswith("embeddings_tumbler/static/"))
    assert listed == [f"embeddings_tumbler/static/{n}" for n in sorted(SHIPPED_STATIC)]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_require_resolves_the_core_file_and_returns_the_api():
    script = (
        "const p=require.resolve(process.argv[1]);"
        "const m=require(process.argv[1]);"
        "console.log(JSON.stringify({p, keys: Object.keys(m), v: m.version}))"
    )
    result = subprocess.run(
        ["node", "-e", script, str(ROOT)], capture_output=True, text=True, check=True, timeout=60
    )
    out = json.loads(result.stdout)
    assert out["p"] == str(STATIC / CORE)
    assert {"mount", "update", "destroy"} <= set(out["keys"])
    assert out["v"] == _pyproject_version()


@needs_npm
def test_npm_tarball_carries_exactly_the_shipped_files():
    result = subprocess.run(
        ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    listing = json.loads(result.stdout)[0]
    assert sorted(f["path"] for f in listing["files"]) == TARBALL_FILES
    assert listing["name"] == "@culture.dev/embeddings-tumbler"


# ---------------------------------------------------------------------------
# check_packages.py on synthetic fixtures (no build tools needed)
# ---------------------------------------------------------------------------


def _core(version: str, body: str = "var x = 1;\n") -> bytes:
    return (check_packages.banner_prefix(version) + "| fixture */\n" + body).encode("utf-8")


def _statics(version: str) -> dict[str, bytes]:
    files = {name: f"/* {name} */\n".encode() for name in SHIPPED_STATIC}
    files[CORE] = _core(version)
    return files


def _make_wheel(path: Path, version: str, statics: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("embeddings_tumbler/__init__.py", "")
        for name, data in statics.items():
            zf.writestr(f"embeddings_tumbler/static/{name}", data)
        meta = f"Metadata-Version: 2.4\nName: embeddings-tumbler\nVersion: {version}\n"
        zf.writestr(f"embeddings_tumbler-{version}.dist-info/METADATA", meta)
    return path


def _make_tarball(path: Path, version: str, statics: dict[str, bytes], extra=None) -> Path:
    members = {
        "package/package.json": json.dumps(
            {"name": "@culture.dev/embeddings-tumbler", "version": version}
        ).encode(),
        "package/README.md": b"readme\n",
        "package/LICENSE": b"license\n",
    }
    for name, data in statics.items():
        members[f"package/embeddings_tumbler/static/{name}"] = data
    members.update(extra or {})
    with tarfile.open(path, "w:gz") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return path


def _run(wheel: Path, tarball: Path, version: str = "1.0.0", npm_version: str | None = None):
    return check_packages.check(wheel, tarball, version, npm_version or version)


def test_check_passes_on_matching_fixtures(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", statics)
    assert _run(wheel, tarball) == []


def test_check_fails_when_the_core_bytes_differ(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    doctored = dict(statics, **{CORE: _core("1.0.0", body="var x = 2;\n")})
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", doctored)
    problems = _run(wheel, tarball)
    assert any("core file differs" in p for p in problems), problems


def test_check_fails_when_a_header_version_differs(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", dict(statics, **{CORE: _core("0.9.9")}))
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", statics)
    problems = _run(wheel, tarball)
    assert any("wheel core file header says 0.9.9" in p for p in problems), problems


def test_check_fails_when_package_versions_differ(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.1", statics)
    problems = _run(wheel, tarball, "1.0.0", "1.0.1")
    assert any("pyproject.toml says 1.0.0 but package.json says 1.0.1" in p for p in problems)
    assert any("header says 1.0.0" in p and "1.0.1" in p for p in problems), problems


def test_check_fails_when_a_static_file_is_missing_or_different(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    fewer = {k: v for k, v in statics.items() if k != "page.css"}
    fewer["page.js"] = b"/* changed */\n"
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", fewer)
    problems = _run(wheel, tarball)
    assert any("page.css" in p and "only in the wheel" in p for p in problems), problems
    assert any("page.js differs" in p for p in problems), problems


def test_check_fails_on_an_unexpected_tarball_file(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    extra = {"package/js/test/secret.test.js": b"x\n"}
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", statics, extra=extra)
    problems = _run(wheel, tarball)
    assert any("js/test/secret.test.js" in p for p in problems), problems


def test_check_fails_when_the_core_file_is_absent(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    tarball = _make_tarball(
        tmp_path / "t.tgz", "1.0.0", {k: v for k, v in statics.items() if k != CORE}
    )
    problems = _run(wheel, tarball)
    assert any(
        "npm tarball has no embeddings_tumbler/static/embeddings-tumbler.js" in p for p in problems
    )


def test_cli_exit_codes_and_messages_on_fixtures(tmp_path, monkeypatch, capsys):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics)
    good = _make_tarball(tmp_path / "good.tgz", "1.0.0", statics)
    bad = _make_tarball(
        tmp_path / "bad.tgz", "1.0.0", dict(statics, **{CORE: _core("1.0.0", "var y;\n")})
    )
    monkeypatch.setattr(check_packages, "read_versions", lambda: ("1.0.0", "1.0.0"))
    assert check_packages.main(["--wheel", str(wheel), "--tarball", str(good)]) == 0
    assert "packages agree" in capsys.readouterr().out
    assert check_packages.main(["--wheel", str(wheel), "--tarball", str(bad)]) == 1
    err = capsys.readouterr().err
    assert "core file differs" in err and "FAIL" in err


# ---------------------------------------------------------------------------
# check_packages.py on real builds
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real_build(tmp_path_factory):
    if not (HAVE_NPM and HAVE_UV):
        pytest.skip("npm and uv are both needed to build the two packages")
    out = tmp_path_factory.mktemp("packages")
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_packages.py"), "--out-dir", str(out)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=600,
    )
    return out, result


@needs_both
def test_check_packages_passes_on_the_real_build(real_build):
    out, result = real_build
    assert result.returncode == 0, result.stdout + result.stderr
    assert "packages agree" in result.stdout
    wheels = list(out.glob("*.whl"))
    tarballs = list(out.glob("*.tgz"))
    assert len(wheels) == 1 and len(tarballs) == 1
    with tarfile.open(tarballs[0]) as tf:
        names = sorted(m.name.removeprefix("package/") for m in tf.getmembers() if m.isfile())
    assert names == TARBALL_FILES
    with zipfile.ZipFile(wheels[0]) as zf:
        shipped = sorted(
            n.removeprefix("embeddings_tumbler/static/")
            for n in zf.namelist()
            if n.startswith("embeddings_tumbler/static/")
        )
    assert shipped == sorted(SHIPPED_STATIC)


@needs_both
def test_check_packages_fails_on_a_doctored_real_tarball(real_build, tmp_path):
    out, result = real_build
    assert result.returncode == 0, result.stdout + result.stderr
    wheel = next(out.glob("*.whl"))
    tarball = next(out.glob("*.tgz"))
    doctored = tmp_path / "doctored.tgz"
    with tarfile.open(tarball) as src, tarfile.open(doctored, "w:gz") as dst:
        for member in src.getmembers():
            data = src.extractfile(member).read() if member.isfile() else None
            if member.name == "package/embeddings_tumbler/static/embeddings-tumbler.js":
                data = data.replace(b"ET.version", b"ET.versi0n", 1)
                member.size = len(data)
            dst.addfile(member, io.BytesIO(data) if data is not None else None)
    bad = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "check_packages.py"),
            "--wheel",
            str(wheel),
            "--tarball",
            str(doctored),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert bad.returncode == 1
    assert "core file differs" in bad.stderr
