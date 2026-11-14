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
import struct
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
    "demo-wikipedia.f32",
    "demo-wikipedia.json",
    "embeddings-tumbler.js",
    "index.html",
    "page.css",
    "page.js",
    "sample-data.js",
    "web-component.js",
)
TARBALL_FILES = sorted(
    ["package.json", "README.md", "LICENSE", "NOTICE"]
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


def _make_wheel(path: Path, version: str, statics: dict[str, bytes], extra=None) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("embeddings_tumbler/__init__.py", "")
        zf.writestr("embeddings_tumbler/cli/__init__.py", "")
        for name, data in statics.items():
            zf.writestr(f"embeddings_tumbler/static/{name}", data)
        meta = f"Metadata-Version: 2.4\nName: embeddings-tumbler\nVersion: {version}\n"
        zf.writestr(f"embeddings_tumbler-{version}.dist-info/METADATA", meta)
        zf.writestr(f"embeddings_tumbler-{version}.dist-info/licenses/LICENSE", "license\n")
        for name, data in (extra or {}).items():
            zf.writestr(name, data)
    return path


def _write_tar(path: Path, members: dict[str, bytes]) -> Path:
    with tarfile.open(path, "w:gz") as tf:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return path


def _make_tarball(path: Path, version: str, statics: dict[str, bytes], extra=None) -> Path:
    members = {
        "package/package.json": json.dumps(
            {"name": "@culture.dev/embeddings-tumbler", "version": version}
        ).encode(),
        "package/README.md": b"readme\n",
        "package/LICENSE": b"license\n",
        "package/NOTICE": b"notice\n",
    }
    for name, data in statics.items():
        members[f"package/embeddings_tumbler/static/{name}"] = data
    members.update(extra or {})
    return _write_tar(path, members)


def _make_sdist(path: Path, version: str, statics: dict[str, bytes], extra=None) -> Path:
    root = f"embeddings_tumbler-{version}/"
    pkg_info = f"Metadata-Version: 2.4\nName: embeddings-tumbler\nVersion: {version}\n"
    members = {
        root + "PKG-INFO": pkg_info.encode(),
        root + "pyproject.toml": b"[project]\n",
        root + "embeddings_tumbler/__init__.py": b"",
        # Sources legitimately travel in an sdist.
        root + "js/src/00-header.js": b"// header\n",
        root + "tests/test_x.py": b"",
        root + "docs/release.md": b"# r\n",
    }
    for name, data in statics.items():
        members[root + f"embeddings_tumbler/static/{name}"] = data
    members.update({root + k: v for k, v in (extra or {}).items()})
    return _write_tar(path, members)


def _set(tmp_path, version="1.0.0", statics=None):
    statics = statics or _statics(version)
    return (
        _make_wheel(tmp_path / "w.whl", version, statics),
        _make_tarball(tmp_path / "t.tgz", version, statics),
        _make_sdist(tmp_path / "s.tar.gz", version, statics),
    )


def _run(wheel, tarball, version="1.0.0", npm_version=None, sdist=None):
    return check_packages.check(wheel, tarball, version, npm_version or version, sdist=sdist)


def test_check_passes_on_matching_fixtures(tmp_path):
    wheel, tarball, sdist = _set(tmp_path)
    assert _run(wheel, tarball, sdist=sdist) == []
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
    assert "npm tarball is missing embeddings_tumbler/static/page.css" in problems, problems
    assert any("page.js differs between the wheel and the npm tarball" in p for p in problems)


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


# --- the wheel is as strict as the tarball -----------------------------------


def test_wheel_with_an_extra_static_file_fails(tmp_path):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", dict(statics, **{"debug.js": b"x\n"}))
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", statics)
    problems = _run(wheel, tarball)
    assert "wheel carries an unexpected static file: embeddings_tumbler/static/debug.js" in problems


def test_wheel_with_a_missing_static_file_fails(tmp_path):
    statics = _statics("1.0.0")
    fewer = {k: v for k, v in statics.items() if k != "index.html"}
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", fewer)
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", statics)
    problems = _run(wheel, tarball)
    assert "wheel is missing embeddings_tumbler/static/index.html" in problems, problems


@pytest.mark.parametrize(
    "member",
    [
        "js/dev/viewer-demo/index.html",
        "js/src/10-math.js",
        "tests/test_cli.py",
        "docs/release.md",
        ".devague/current",
        "embeddings_tumbler/dev/index.html",
        "embeddings_tumbler/static/sub/page.js",
    ],
)
def test_wheel_carrying_dev_or_source_files_fails(tmp_path, member):
    statics = _statics("1.0.0")
    wheel = _make_wheel(tmp_path / "w.whl", "1.0.0", statics, extra={member: b"x\n"})
    tarball = _make_tarball(tmp_path / "t.tgz", "1.0.0", statics)
    problems = _run(wheel, tarball)
    assert any(member in p and p.startswith("wheel carries") for p in problems), problems


# --- the sdist (uploaded to PyPI beside the wheel) ---------------------------


def test_sdist_with_a_different_core_file_fails(tmp_path):
    statics = _statics("1.0.0")
    wheel, tarball, _ = _set(tmp_path, statics=statics)
    sdist = _make_sdist(
        tmp_path / "bad.tar.gz", "1.0.0", dict(statics, **{CORE: _core("1.0.0", "var z;\n")})
    )
    problems = _run(wheel, tarball, sdist=sdist)
    assert any(p.startswith("sdist core file differs from the wheel's") for p in problems), problems


def test_sdist_with_a_missing_or_extra_static_file_fails(tmp_path):
    statics = _statics("1.0.0")
    wheel, tarball, _ = _set(tmp_path, statics=statics)
    changed = {k: v for k, v in statics.items() if k != "page.css"}
    changed["extra.js"] = b"x\n"
    changed["page.js"] = b"/* other */\n"
    sdist = _make_sdist(tmp_path / "bad.tar.gz", "1.0.0", changed)
    problems = _run(wheel, tarball, sdist=sdist)
    assert "sdist is missing embeddings_tumbler/static/page.css" in problems, problems
    assert "sdist carries an unexpected static file: embeddings_tumbler/static/extra.js" in problems
    assert any("page.js differs between the wheel and the sdist" in p for p in problems)


def test_sdist_version_and_header_are_checked(tmp_path):
    statics = _statics("1.0.0")
    wheel, tarball, _ = _set(tmp_path, statics=statics)
    sdist = _make_sdist(tmp_path / "bad.tar.gz", "0.9.0", dict(statics, **{CORE: _core("0.9.0")}))
    problems = _run(wheel, tarball, sdist=sdist)
    assert any("sdist metadata version is 0.9.0" in p for p in problems), problems
    assert any("sdist core file header says 0.9.0" in p for p in problems), problems


@pytest.mark.parametrize("name", [".npmrc", ".pypirc", ".env", "sub/.npmrc"])
def test_sdist_with_a_credential_file_fails(tmp_path, name):
    statics = _statics("1.0.0")
    wheel, tarball, _ = _set(tmp_path, statics=statics)
    sdist = _make_sdist(tmp_path / "bad.tar.gz", "1.0.0", statics, extra={name: b"x=1\n"})
    problems = _run(wheel, tarball, sdist=sdist)
    assert any("sdist carries a credential-shaped file" in p and name in p for p in problems)


def test_sdist_may_carry_sources(tmp_path):
    # js/src, tests and docs in an sdist are sources, not a leak.
    wheel, tarball, sdist = _set(tmp_path)
    assert _run(wheel, tarball, sdist=sdist) == []


# --- the command line ---------------------------------------------------------


def test_cli_exit_codes_and_messages_on_fixtures(tmp_path, monkeypatch, capsys):
    statics = _statics("1.0.0")
    wheel, good, sdist = _set(tmp_path, statics=statics)
    bad = _make_tarball(
        tmp_path / "bad.tgz", "1.0.0", dict(statics, **{CORE: _core("1.0.0", "var y;\n")})
    )
    monkeypatch.setattr(check_packages, "read_versions", lambda: ("1.0.0", "1.0.0"))
    given = ["--wheel", str(wheel), "--sdist", str(sdist)]
    out_file = tmp_path / "github_output"
    assert (
        check_packages.main(given + ["--tarball", str(good), "--github-output", str(out_file)]) == 0
    )
    assert "packages agree" in capsys.readouterr().out
    lines = out_file.read_text(encoding="utf-8").splitlines()
    assert lines == [
        f"wheel={wheel.resolve()}",
        f"sdist={sdist.resolve()}",
        f"tarball={good.resolve()}",
    ]
    out_file.unlink()
    assert (
        check_packages.main(given + ["--tarball", str(bad), "--github-output", str(out_file)]) == 1
    )
    err = capsys.readouterr().err
    assert "core file differs" in err
    assert "FAIL" in err
    assert not out_file.exists(), "paths must not be published for a failed check"


def test_out_dir_must_be_empty(tmp_path, capsys):
    out = tmp_path / "out"
    out.mkdir()
    (out / "old.tgz").write_bytes(b"stale")
    assert check_packages.main(["--out-dir", str(out)]) == 1
    assert "is not empty" in capsys.readouterr().err


def test_tarball_and_registry_tarball_are_exclusive(tmp_path, capsys):
    with pytest.raises(SystemExit):
        check_packages.main(["--tarball", "a.tgz", "--registry-tarball", "x@1.0.0"])


def test_exactly_one_built_file_is_required(tmp_path):
    (tmp_path / "a.whl").write_bytes(b"")
    (tmp_path / "b.whl").write_bytes(b"")
    with pytest.raises(RuntimeError, match="expected exactly one \\*.whl"):
        check_packages.only_one(tmp_path, "*.whl")
    with pytest.raises(RuntimeError, match="expected exactly one \\*.tgz"):
        check_packages.only_one(tmp_path, "*.tgz")


def test_registry_tarball_is_packed_by_spec(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd):
        calls.append(cmd)
        (tmp_path / "culture.dev-embeddings-tumbler-1.0.0.tgz").write_bytes(b"x")
        out = json.dumps([{"filename": "culture.dev-embeddings-tumbler-1.0.0.tgz"}])
        return subprocess.CompletedProcess(cmd, 0, out, "")

    monkeypatch.setattr(check_packages, "_run", fake_run)
    monkeypatch.setattr(check_packages.shutil, "which", lambda _: "/usr/bin/npm")
    path = check_packages.pack_tarball(tmp_path, "@culture.dev/embeddings-tumbler@1.0.0")
    assert path == tmp_path / "culture.dev-embeddings-tumbler-1.0.0.tgz"
    assert calls[0][:3] == ["npm", "pack", "@culture.dev/embeddings-tumbler@1.0.0"]


@pytest.mark.parametrize(
    "spec",
    [
        "--registry=https://evil.example/",
        "-x",
        "@culture.dev/embeddings-tumbler",
        "@culture.dev/embeddings-tumbler@latest",
        "@culture.dev/embeddings-tumbler@1.0.0 --foo",
        "../x@1.0.0",
        # Non-ASCII digits (ARABIC-INDIC DIGIT ONE, FULLWIDTH DIGIT ONE) are not a version.
        "@culture.dev/embeddings-tumbler@\u0661.0.0",
        "@culture.dev/embeddings-tumbler@1.0.\uff11",
    ],
)
def test_registry_tarball_spec_must_be_a_package_at_an_exact_version(tmp_path, monkeypatch, spec):
    def fake_run(cmd):
        raise AssertionError(f"npm must not run for {spec!r}: {cmd}")

    monkeypatch.setattr(check_packages, "_run", fake_run)
    monkeypatch.setattr(check_packages.shutil, "which", lambda _: "/usr/bin/npm")
    with pytest.raises(RuntimeError, match="not a package at an exact version"):
        check_packages.pack_tarball(tmp_path, spec)


def test_out_dir_receives_the_built_artefacts(tmp_path, monkeypatch, capsys):
    # The build tools write into a temporary folder; --out-dir gets the files afterwards,
    # and --github-output names them where they were kept.
    statics = _statics("1.0.0")
    src = tmp_path / "src"
    src.mkdir()
    wheel, tarball, sdist = _set(src, statics=statics)
    seen = []

    def fake_build(kind, made):
        def build(folder):
            seen.append(folder)
            return Path(shutil.copy(made, folder / made.name)).resolve()

        return build

    monkeypatch.setattr(check_packages, "read_versions", lambda: ("1.0.0", "1.0.0"))
    monkeypatch.setattr(check_packages, "build_wheel", fake_build("wheel", wheel))
    monkeypatch.setattr(check_packages, "build_sdist", fake_build("sdist", sdist))
    monkeypatch.setattr(
        check_packages, "pack_tarball", lambda folder, spec: fake_build("npm", tarball)(folder)
    )
    out = tmp_path / "kept"
    out_file = tmp_path / "github_output"
    assert check_packages.main(["--out-dir", str(out), "--github-output", str(out_file)]) == 0
    assert all(folder != out.resolve() for folder in seen)
    assert sorted(p.name for p in out.iterdir()) == sorted([wheel.name, sdist.name, tarball.name])
    assert out_file.read_text(encoding="utf-8").splitlines() == [
        f"wheel={(out / wheel.name).resolve()}",
        f"sdist={(out / sdist.name).resolve()}",
        f"tarball={(out / tarball.name).resolve()}",
    ]
    assert str((out / tarball.name).resolve()) in capsys.readouterr().out


# ---------------------------------------------------------------------------
# check_packages.py on real builds
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real_build(tmp_path_factory):
    if not (HAVE_NPM and HAVE_UV):
        pytest.skip("npm and uv are both needed to build the two packages")
    out = tmp_path_factory.mktemp("packages") / "dist"
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
    sdists = list(out.glob("*.tar.gz"))
    assert len(wheels) == 1
    assert len(tarballs) == 1
    assert len(sdists) == 1
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
def test_the_notice_for_the_wikipedia_text_ships_in_every_artefact(real_build):
    out, result = real_build
    assert result.returncode == 0, result.stdout + result.stderr
    notice = (ROOT / "NOTICE").read_bytes()
    assert b"CC BY-SA 4.0" in notice
    assert b"demo-wikipedia.json" in notice
    with zipfile.ZipFile(next(out.glob("*.whl"))) as zf:
        found = [n for n in zf.namelist() if n.endswith(".dist-info/licenses/NOTICE")]
        assert found, "the wheel carries no NOTICE"
        assert zf.read(found[0]) == notice
    with tarfile.open(next(out.glob("*.tgz"))) as tf:
        assert tf.extractfile("package/NOTICE").read() == notice
    with tarfile.open(next(out.glob("*.tar.gz"))) as tf:
        names = [m.name for m in tf.getmembers() if m.name.endswith("/NOTICE")]
        assert names, "the sdist carries no NOTICE"


# The packages stay under 5 MB with the FULL demo pair in them, not only with the small
# stand-in that may be committed: the stand-in pair in the real artefacts is replaced by a
# full-size one (every corpus item, 1,024 dimensions, the real JSON layout, incompressible
# vectors) and each artefact is re-packed with the same kind of compression.
SIZE_LIMIT = 5_000_000  # bytes, for the wheel and the npm tarball as downloaded
# The sdist carries the whole repository's sources (about 1.7 MB packed before the pair),
# so it is held to a looser limit that still catches the pair being carried twice.
SDIST_LIMIT = 7_000_000
UNPACKED_LIMIT = 5 * 1024 * 1024  # bytes, for the static folder as installed
FULL_DIMENSION = 1024
STATIC_PART = "embeddings_tumbler/static/"


def _full_pair() -> dict[str, bytes]:
    import argparse
    import random

    demo = _load("build_demo_set_for_size", "build_demo_set.py")
    header, items = demo.read_corpus(demo.CORPUS)
    args = argparse.Namespace(
        stand_in=False,
        batch=32,
        model_asked="Qwen/Qwen3-Embedding-0.6B",
        endpoint_name="lobes gateway",
        name="demo-wikipedia",
    )
    records = demo.build_records(header, items, "Qwen/Qwen3-Embedding-0.6B", FULL_DIMENSION, args)
    rng = random.Random(7)
    count = len(items) * FULL_DIMENSION
    block = struct.pack(f"<{count}f", *(rng.gauss(0.0, 0.03) for _ in range(count)))
    return {
        "demo-wikipedia.json": demo.records_text(records).encode("utf-8"),
        "demo-wikipedia.f32": block,
    }


def _replacement(name: str, replace: dict[str, bytes]) -> bytes | None:
    if STATIC_PART not in name:
        return None
    return replace.get(name.split(STATIC_PART)[-1])


def _repack_zip(src: Path, dst: Path, replace: dict[str, bytes]) -> int:
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for name in zin.namelist():
            data = _replacement(name, replace)
            zout.writestr(name, zin.read(name) if data is None else data)
    return dst.stat().st_size


def _repack_tar(src: Path, dst: Path, replace: dict[str, bytes]) -> int:
    with tarfile.open(src) as tin, tarfile.open(dst, "w:gz") as tout:
        for member in tin.getmembers():
            data = tin.extractfile(member).read() if member.isfile() else None
            new = _replacement(member.name, replace) if data is not None else None
            if new is not None:
                data = new
                member.size = len(data)
            tout.addfile(member, io.BytesIO(data) if data is not None else None)
    return dst.stat().st_size


@needs_both
def test_every_artefact_stays_under_5_mb_with_a_full_size_demo_pair(real_build, tmp_path):
    out, result = real_build
    assert result.returncode == 0, result.stdout + result.stderr
    full = _full_pair()
    assert len(full["demo-wikipedia.f32"]) >= 950 * FULL_DIMENSION * 4
    unpacked = sum(len(full.get(n) or (STATIC / n).read_bytes()) for n in SHIPPED_STATIC)
    sizes = {
        "wheel": _repack_zip(next(out.glob("*.whl")), tmp_path / "w.whl", full),
        "npm tarball": _repack_tar(next(out.glob("*.tgz")), tmp_path / "t.tgz", full),
        "sdist": _repack_tar(next(out.glob("*.tar.gz")), tmp_path / "s.tar.gz", full),
    }
    print(f"full-size demo pair: unpacked static {unpacked} bytes; packed {sizes}")
    assert unpacked < UNPACKED_LIMIT, unpacked
    assert sizes["wheel"] < SIZE_LIMIT, sizes
    assert sizes["npm tarball"] < SIZE_LIMIT, sizes
    assert sizes["sdist"] < SDIST_LIMIT, sizes


@needs_both
def test_check_packages_fails_on_a_doctored_real_tarball(real_build, tmp_path):
    out, result = real_build
    assert result.returncode == 0, result.stdout + result.stderr
    wheel = next(out.glob("*.whl"))
    sdist = next(out.glob("*.tar.gz"))
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
            "--sdist",
            str(sdist),
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


def test_sync_version_targets_the_top_level_key_not_the_first_in_file_order(tmp_path, monkeypatch):
    pyproject = tmp_path / "pyproject.toml"
    package = tmp_path / "package.json"
    pyproject.write_text('[project]\nname = "x"\nversion = "2.0.0"\n', encoding="utf-8")
    original = (
        "{\n"
        '  "name": "x",\n'
        '  "engines": {"node": ">=18", "version": "1.0.0"},\n'
        '  "nested": [{"version": "1.0.0"}],\n'
        '  "version": "1.0.0",\n'
        '  "files": ["a"]\n'
        "}\n"
    )
    package.write_text(original, encoding="utf-8")
    monkeypatch.setattr(sync_version, "PYPROJECT", pyproject)
    monkeypatch.setattr(sync_version, "PACKAGE_JSON", package)
    assert sync_version.main([]) == 0
    expected = original.replace('"version": "1.0.0",\n  "files"', '"version": "2.0.0",\n  "files"')
    assert package.read_text(encoding="utf-8") == expected
    data = json.loads(expected)
    assert data["engines"]["version"] == "1.0.0"
    assert data["nested"][0]["version"] == "1.0.0"


def test_sync_version_refuses_a_package_json_without_a_top_level_version(
    tmp_path, monkeypatch, capsys
):
    pyproject = tmp_path / "pyproject.toml"
    package = tmp_path / "package.json"
    pyproject.write_text('[project]\nname = "x"\nversion = "2.0.0"\n', encoding="utf-8")
    package.write_text('{"name": "x", "engines": {"version": "1.0.0"}}\n', encoding="utf-8")
    monkeypatch.setattr(sync_version, "PYPROJECT", pyproject)
    monkeypatch.setattr(sync_version, "PACKAGE_JSON", package)
    assert sync_version.main([]) == 1
    assert "top-level" in capsys.readouterr().err
