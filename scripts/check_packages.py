#!/usr/bin/env python3
"""Build the wheel and the npm tarball and prove they carry the same viewer files.

    python3 scripts/check_packages.py                   # build both into a temp dir, check
    python3 scripts/check_packages.py --out-dir dist    # build both into dist/ and keep them
    python3 scripts/check_packages.py --wheel W.whl     # check a given wheel (build the tarball)
    python3 scripts/check_packages.py --wheel W.whl --tarball T.tgz   # check two given files

Builds with ``uv build --wheel`` and ``npm pack``; publishes nothing. Fails (exit 1)
unless all of these hold:

- pyproject.toml's version equals package.json's;
- the wheel's metadata version equals pyproject.toml's, and the tarball's
  package.json version equals the repository's package.json;
- the core file ``embeddings-tumbler.js`` is in both and byte-identical;
- the version in each core file's header equals pyproject.toml's and package.json's;
- both carry the same set of files under ``embeddings_tumbler/static/``, byte for byte;
- the tarball carries nothing beyond package.json, README.md, LICENSE and those files.

Results go to stdout; every failure is a ``FAIL`` line on stderr. Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC_PREFIX = "embeddings_tumbler/static/"
CORE = "embeddings-tumbler.js"
TARBALL_FIXED = ("package.json", "README.md", "LICENSE")
_HEADER_RE = re.compile(rb"^/\*! embeddings-tumbler (\S+) ")


def banner_prefix(version: str) -> str:
    """The start of the core file's first line, as scripts/assemble.py writes it."""
    return f"/*! embeddings-tumbler {version} "


def header_version(core: bytes) -> str | None:
    """The version stamped in a core file's header, or None if there is no header."""
    match = _HEADER_RE.match(core.split(b"\n", 1)[0])
    return match.group(1).decode("utf-8", "replace") if match else None


def read_versions() -> tuple[str, str]:
    """(pyproject.toml version, package.json version) from the repository."""
    py = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return py["project"]["version"], str(pkg.get("version"))


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def read_wheel(path: Path) -> tuple[str | None, dict[str, bytes]]:
    """(metadata version, {static file name: bytes}) from a wheel."""
    version = None
    statics: dict[str, bytes] = {}
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if name.endswith(".dist-info/METADATA"):
                for line in zf.read(name).decode("utf-8", "replace").splitlines():
                    if line.startswith("Version:"):
                        version = line.split(":", 1)[1].strip()
                        break
            elif name.startswith(STATIC_PREFIX) and not name.endswith("/"):
                statics[name[len(STATIC_PREFIX) :]] = zf.read(name)
    return version, statics


def read_tarball(path: Path) -> tuple[str | None, dict[str, bytes], list[str]]:
    """(package.json version, {static file name: bytes}, every file path) from a tarball."""
    version = None
    statics: dict[str, bytes] = {}
    files: list[str] = []
    with tarfile.open(path, "r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            name = member.name.removeprefix("package/")
            files.append(name)
            data = tf.extractfile(member).read()
            if name == "package.json":
                version = str(json.loads(data).get("version"))
            elif name.startswith(STATIC_PREFIX):
                statics[name[len(STATIC_PREFIX) :]] = data
    return version, statics, sorted(files)


def _check_header(label: str, core: bytes, py_version: str, npm_version: str) -> list[str]:
    found = header_version(core)
    if found is None:
        return [f"{label} core file has no 'embeddings-tumbler <version>' header"]
    problems = []
    if found != py_version:
        problems.append(f"{label} core file header says {found}, pyproject.toml says {py_version}")
    if found != npm_version:
        problems.append(f"{label} core file header says {found}, package.json says {npm_version}")
    return problems


def check(wheel: Path, tarball: Path, py_version: str, npm_version: str) -> list[str]:
    """Every way the two packages disagree with each other or with the versions."""
    problems: list[str] = []
    if py_version != npm_version:
        problems.append(
            f"pyproject.toml says {py_version} but package.json says {npm_version} "
            "(run python3 scripts/sync_version.py)"
        )
    wheel_version, wheel_static = read_wheel(wheel)
    tar_version, tar_static, tar_files = read_tarball(tarball)
    if wheel_version != py_version:
        problems.append(
            f"wheel metadata version is {wheel_version}, pyproject.toml says {py_version}"
        )
    if tar_version != npm_version:
        problems.append(
            f"npm tarball package.json is {tar_version}, package.json says {npm_version}"
        )

    wheel_core = wheel_static.get(CORE)
    tar_core = tar_static.get(CORE)
    if wheel_core is None:
        problems.append(f"wheel has no {STATIC_PREFIX}{CORE}")
    else:
        problems += _check_header("wheel", wheel_core, py_version, npm_version)
    if tar_core is None:
        problems.append(f"npm tarball has no {STATIC_PREFIX}{CORE}")
    else:
        problems += _check_header("npm tarball", tar_core, py_version, npm_version)
    if wheel_core is not None and tar_core is not None and wheel_core != tar_core:
        problems.append(
            f"core file differs: wheel {CORE} is {len(wheel_core)} bytes sha256 "
            f"{_sha(wheel_core)}, npm tarball's is {len(tar_core)} bytes sha256 {_sha(tar_core)}"
        )

    for name in sorted(set(wheel_static) - set(tar_static)):
        problems.append(f"{STATIC_PREFIX}{name} is only in the wheel")
    for name in sorted(set(tar_static) - set(wheel_static)):
        problems.append(f"{STATIC_PREFIX}{name} is only in the npm tarball")
    for name in sorted(set(wheel_static) & set(tar_static)):
        if name != CORE and wheel_static[name] != tar_static[name]:
            problems.append(f"{STATIC_PREFIX}{name} differs between the wheel and the npm tarball")

    for name in TARBALL_FIXED:
        if name not in tar_files:
            problems.append(f"npm tarball has no {name}")
    for name in tar_files:
        if name not in TARBALL_FIXED and not name.startswith(STATIC_PREFIX):
            problems.append(f"npm tarball carries an unexpected file: {name}")
    return problems


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


def build_wheel(out_dir: Path) -> Path:
    if shutil.which("uv") is None:
        raise RuntimeError("uv is not installed; cannot build the wheel")
    before = set(out_dir.glob("*.whl"))
    result = _run(["uv", "build", "--wheel", "--out-dir", str(out_dir)])
    if result.returncode != 0:
        raise RuntimeError(f"uv build --wheel failed:\n{result.stdout}{result.stderr}")
    built = sorted(set(out_dir.glob("*.whl")) - before) or sorted(out_dir.glob("*.whl"))
    if len(built) != 1:
        raise RuntimeError(f"expected one wheel in {out_dir}, found {len(built)}")
    return built[0]


def build_tarball(out_dir: Path) -> Path:
    if shutil.which("npm") is None:
        raise RuntimeError("npm is not installed; cannot pack the npm tarball")
    result = _run(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", str(out_dir)])
    if result.returncode != 0:
        raise RuntimeError(f"npm pack failed:\n{result.stdout}{result.stderr}")
    filename = json.loads(result.stdout)[0]["filename"]
    return out_dir / Path(filename).name


def _report(wheel: Path, tarball: Path, py_version: str, npm_version: str) -> int:
    print(f"wheel:       {wheel.name}")
    print(f"npm tarball: {tarball.name}")
    print(f"versions:    pyproject.toml {py_version}, package.json {npm_version}")
    problems = check(wheel, tarball, py_version, npm_version)
    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        print(f"check_packages: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    _, statics = read_wheel(wheel)
    core = statics[CORE]
    print(f"core file:   {CORE} {len(core)} bytes sha256 {_sha(core)} in both")
    print(f"static set:  {', '.join(sorted(statics))} (identical bytes in both)")
    print(f"check_packages: packages agree ({py_version})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wheel", type=Path, help="check this wheel instead of building one")
    parser.add_argument("--tarball", type=Path, help="check this npm tarball instead of packing")
    parser.add_argument("--out-dir", type=Path, help="build into this folder and keep the files")
    args = parser.parse_args(argv)
    py_version, npm_version = read_versions()
    with tempfile.TemporaryDirectory(prefix="check-packages-") as tmp:
        out_dir = args.out_dir or Path(tmp)
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            wheel = args.wheel or build_wheel(out_dir.resolve())
            tarball = args.tarball or build_tarball(out_dir.resolve())
        except RuntimeError as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            return 1
        return _report(wheel, tarball, py_version, npm_version)


if __name__ == "__main__":
    sys.exit(main())
