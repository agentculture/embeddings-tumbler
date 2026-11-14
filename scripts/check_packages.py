#!/usr/bin/env python3
"""Build the wheel, the sdist and the npm tarball and prove they carry the same viewer files.

    python3 scripts/check_packages.py                  # build all three into a temp dir, check
    python3 scripts/check_packages.py --out-dir DIR    # build into DIR (new or empty) and keep them
    python3 scripts/check_packages.py --wheel W --sdist S --tarball T   # check given files
    python3 scripts/check_packages.py --wheel W --sdist S --registry-tarball PKG@X.Y.Z
                                                       # compare with what npm already has
    ... --github-output "$GITHUB_OUTPUT"               # on success, write wheel=, sdist=,
                                                       # tarball= (absolute paths) for later steps

Any artefact not given is built: ``uv build --wheel``, ``uv build --sdist``, ``npm pack``.
Publishes nothing. The expected static set is the ``embeddings_tumbler/static/`` entries of
package.json's ``files``. Fails (exit 1) unless all of these hold:

- pyproject.toml's version equals package.json's; the wheel's and the sdist's metadata
  versions equal pyproject.toml's; the tarball's package.json version equals the repo's;
- the core file ``embeddings-tumbler.js`` is in all three, byte-identical, and the version
  in its header equals pyproject.toml's and package.json's;
- each artefact's files under ``embeddings_tumbler/static/`` are exactly the expected set
  (flat, nothing missing, nothing extra), byte-identical to the wheel's;
- the npm tarball carries nothing beyond package.json, README.md, LICENSE and that set;
- the wheel carries nothing beyond its own ``.dist-info/``, the static set and ``.py``
  modules of the ``embeddings_tumbler`` package (no ``js/``, ``tests/``, ``docs/``,
  ``.devague/`` or dev pages);
- the sdist is a source distribution and may carry the repository's tracked sources
  (``js/src/``, ``tests/``, ``docs/`` ...), but no ``.npmrc``, ``.pypirc`` or ``.env``.

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
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "embeddings_tumbler/"
STATIC_PREFIX = "embeddings_tumbler/static/"
CORE = "embeddings-tumbler.js"
PACKAGE_JSON = "package.json"
NPM_TARBALL = "npm tarball"
TARBALL_FIXED = (PACKAGE_JSON, "README.md", "LICENSE")
CREDENTIAL_FILES = frozenset({".npmrc", ".pypirc", ".env"})
_HEADER_RE = re.compile(rb"^/\*! embeddings-tumbler (\S+) ")
#: What --registry-tarball accepts: an npm package name (scope optional) at an exact version.
#: Nothing else reaches the npm command line, so no option can be smuggled in as a spec.
NPM_SPEC = re.compile(
    r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?"
)


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
    pkg = json.loads((ROOT / PACKAGE_JSON).read_text(encoding="utf-8"))
    return py["project"]["version"], str(pkg.get("version"))


def expected_static() -> frozenset[str]:
    """The flat static file names package.json ships (the wheel must ship the same)."""
    pkg = json.loads((ROOT / PACKAGE_JSON).read_text(encoding="utf-8"))
    return frozenset(
        f[len(STATIC_PREFIX) :] for f in pkg.get("files", []) if f.startswith(STATIC_PREFIX)
    )


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def _metadata_version(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("Version:"):
            return line.split(":", 1)[1].strip()
    return None


def read_wheel(path: Path) -> tuple[str | None, dict[str, bytes], list[str]]:
    """(metadata version, {static path below static/: bytes}, problems with its file list)."""
    version = None
    statics: dict[str, bytes] = {}
    problems: list[str] = []
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            if name.endswith("/"):
                continue
            top = name.split("/", 1)[0]
            if top.startswith("embeddings_tumbler-") and top.endswith(".dist-info"):
                if name.endswith(".dist-info/METADATA"):
                    version = _metadata_version(zf.read(name).decode("utf-8", "replace"))
            elif name.startswith(STATIC_PREFIX):
                statics[name[len(STATIC_PREFIX) :]] = zf.read(name)
            elif name.startswith(PACKAGE):
                if not name.endswith(".py"):
                    problems.append(f"wheel carries an unexpected file: {name}")
            else:
                problems.append(f"wheel carries a file outside the package: {name}")
    return version, statics, problems


def read_tarball(path: Path) -> tuple[str | None, dict[str, bytes], list[str]]:
    """(package.json version, {static path below static/: bytes}, every file path)."""
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
            if name == PACKAGE_JSON:
                version = str(json.loads(data).get("version"))
            elif name.startswith(STATIC_PREFIX):
                statics[name[len(STATIC_PREFIX) :]] = data
    return version, statics, sorted(files)


def read_sdist(path: Path) -> tuple[str | None, dict[str, bytes], list[str]]:
    """(PKG-INFO version, {static path below static/: bytes}, problems with its file list)."""
    version = None
    statics: dict[str, bytes] = {}
    problems: list[str] = []
    with tarfile.open(path, "r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            parts = member.name.split("/", 1)
            name = parts[1] if len(parts) == 2 else parts[0]
            if PurePosixPath(name).name in CREDENTIAL_FILES:
                problems.append(f"sdist carries a credential-shaped file: {name}")
            if name == "PKG-INFO":
                version = _metadata_version(
                    tf.extractfile(member).read().decode("utf-8", "replace")
                )
            elif name.startswith(STATIC_PREFIX):
                statics[name[len(STATIC_PREFIX) :]] = tf.extractfile(member).read()
    return version, statics, problems


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


def _static_set(label: str, statics: dict[str, bytes], expected: frozenset[str]) -> list[str]:
    problems = []
    for name in sorted(expected - set(statics)):
        if name == CORE:
            problems.append(f"{label} has no {STATIC_PREFIX}{CORE}")
        else:
            problems.append(f"{label} is missing {STATIC_PREFIX}{name}")
    for name in sorted(set(statics) - expected):
        if "/" in name:
            problems.append(
                f"{label} carries a file below the flat static set: {STATIC_PREFIX}{name}"
            )
        else:
            problems.append(f"{label} carries an unexpected static file: {STATIC_PREFIX}{name}")
    return problems


def _compare(label: str, wheel: dict[str, bytes], other: dict[str, bytes]) -> list[str]:
    problems = []
    for name in sorted(set(wheel) & set(other)):
        if wheel[name] == other[name]:
            continue
        if name == CORE:
            if label == NPM_TARBALL:
                problems.append(
                    f"core file differs: wheel {CORE} is {len(wheel[name])} bytes sha256 "
                    f"{_sha(wheel[name])}, npm tarball's is {len(other[name])} bytes sha256 "
                    f"{_sha(other[name])}"
                )
            else:
                problems.append(
                    f"{label} core file differs from the wheel's: {len(other[name])} bytes sha256 "
                    f"{_sha(other[name])} against {len(wheel[name])} bytes sha256 "
                    f"{_sha(wheel[name])}"
                )
        else:
            problems.append(f"{STATIC_PREFIX}{name} differs between the wheel and the {label}")
    return problems


def _check_wheel(
    wheel: Path, py_version: str, npm_version: str, expected: frozenset[str]
) -> tuple[dict[str, bytes], list[str]]:
    """(the wheel's static files, the wheel's problems)."""
    problems: list[str] = []
    wheel_version, wheel_static, wheel_problems = read_wheel(wheel)
    if wheel_version != py_version:
        problems.append(
            f"wheel metadata version is {wheel_version}, pyproject.toml says {py_version}"
        )
    problems += wheel_problems
    problems += _static_set("wheel", wheel_static, expected)
    if CORE in wheel_static:
        problems += _check_header("wheel", wheel_static[CORE], py_version, npm_version)
    return wheel_static, problems


def _check_tarball(
    tarball: Path,
    wheel_static: dict[str, bytes],
    py_version: str,
    npm_version: str,
    expected: frozenset[str],
) -> list[str]:
    problems: list[str] = []
    tar_version, tar_static, tar_files = read_tarball(tarball)
    if tar_version != npm_version:
        problems.append(
            f"npm tarball package.json is {tar_version}, package.json says {npm_version}"
        )
    problems += _static_set(NPM_TARBALL, tar_static, expected)
    if CORE in tar_static:
        problems += _check_header(NPM_TARBALL, tar_static[CORE], py_version, npm_version)
    problems += _compare(NPM_TARBALL, wheel_static, tar_static)
    for name in TARBALL_FIXED:
        if name not in tar_files:
            problems.append(f"npm tarball has no {name}")
    for name in tar_files:
        if name not in TARBALL_FIXED and not name.startswith(STATIC_PREFIX):
            problems.append(f"npm tarball carries an unexpected file: {name}")
    return problems


def _check_sdist(
    sdist: Path,
    wheel_static: dict[str, bytes],
    py_version: str,
    npm_version: str,
    expected: frozenset[str],
) -> list[str]:
    problems: list[str] = []
    sdist_version, sdist_static, sdist_problems = read_sdist(sdist)
    if sdist_version != py_version:
        problems.append(
            f"sdist metadata version is {sdist_version}, pyproject.toml says {py_version}"
        )
    problems += sdist_problems
    problems += _static_set("sdist", sdist_static, expected)
    if CORE in sdist_static:
        problems += _check_header("sdist", sdist_static[CORE], py_version, npm_version)
    problems += _compare("sdist", wheel_static, sdist_static)
    return problems


def check(
    wheel: Path,
    tarball: Path,
    py_version: str,
    npm_version: str,
    sdist: Path | None = None,
    expected: frozenset[str] | None = None,
) -> list[str]:
    """Every way the packages disagree with each other, the expected set or the versions."""
    expected = expected_static() if expected is None else expected
    problems: list[str] = []
    if py_version != npm_version:
        problems.append(
            f"pyproject.toml says {py_version} but package.json says {npm_version} "
            "(run python3 scripts/sync_version.py)"
        )
    wheel_static, wheel_problems = _check_wheel(wheel, py_version, npm_version, expected)
    problems += wheel_problems
    problems += _check_tarball(tarball, wheel_static, py_version, npm_version, expected)
    if sdist is not None:
        problems += _check_sdist(sdist, wheel_static, py_version, npm_version, expected)
    return problems


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)


def only_one(folder: Path, pattern: str) -> Path:
    """The single file matching pattern in folder; RuntimeError for zero or several."""
    found = sorted(folder.glob(pattern))
    if len(found) != 1:
        names = ", ".join(p.name for p in found) or "none"
        raise RuntimeError(
            f"expected exactly one {pattern} in {folder}, found {len(found)}: {names}"
        )
    return found[0].resolve()


def _uv_build(out_dir: Path, kind: str, pattern: str) -> Path:
    if shutil.which("uv") is None:
        raise RuntimeError(f"uv is not installed; cannot build the {kind}")
    result = _run(["uv", "build", f"--{kind}", "--out-dir", str(out_dir)])
    if result.returncode != 0:
        raise RuntimeError(f"uv build --{kind} failed:\n{result.stdout}{result.stderr}")
    return only_one(out_dir, pattern)


def build_wheel(out_dir: Path) -> Path:
    return _uv_build(out_dir, "wheel", "*.whl")


def build_sdist(out_dir: Path) -> Path:
    return _uv_build(out_dir, "sdist", "*.tar.gz")


def pack_tarball(out_dir: Path, spec: str | None = None) -> Path:
    """npm pack this repository (spec None) or a registry spec into out_dir."""
    if spec is not None and not NPM_SPEC.fullmatch(spec):
        raise RuntimeError(
            f"--registry-tarball {spec!r} is not a package at an exact version "
            "(for example @culture.dev/embeddings-tumbler@1.2.3)"
        )
    if shutil.which("npm") is None:
        raise RuntimeError("npm is not installed; cannot pack the npm tarball")
    cmd = ["npm", "pack"] + ([spec] if spec else [])
    cmd += ["--json", "--ignore-scripts", "--pack-destination", str(out_dir)]
    result = _run(cmd)
    if result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} failed:\n{result.stdout}{result.stderr}")
    listing = json.loads(result.stdout)
    if len(listing) != 1:
        raise RuntimeError(f"npm pack made {len(listing)} tarballs, expected exactly one")
    path = (out_dir / Path(listing[0]["filename"]).name).resolve()
    if only_one(out_dir, "*.tgz") != path:
        raise RuntimeError(f"npm pack reported {path.name} but {out_dir} holds another tarball")
    return path


def _artefacts(args: argparse.Namespace, build_dir: Path) -> dict[str, Path]:
    """The given artefacts, resolved, and the others built in ``build_dir``."""
    paths = {
        "wheel": args.wheel.resolve() if args.wheel else build_wheel(build_dir),
        "sdist": args.sdist.resolve() if args.sdist else build_sdist(build_dir),
        "tarball": (
            args.tarball.resolve()
            if args.tarball
            else pack_tarball(build_dir, args.registry_tarball)
        ),
    }
    for label, path in paths.items():
        if not path.is_file():
            raise RuntimeError(f"{label} {path} does not exist")
    return paths


def _keep(paths: dict[str, Path], build_dir: Path, out_dir: Path) -> dict[str, Path]:
    """Move the artefacts built in ``build_dir`` into ``out_dir``; given ones stay put."""
    out_dir.mkdir(parents=True, exist_ok=True)
    kept = {}
    for label, path in paths.items():
        if path.parent == build_dir:
            path = Path(shutil.move(path, out_dir / path.name)).resolve()
        kept[label] = path
    return kept


def _report(paths: dict[str, Path], py_version: str, npm_version: str) -> int:
    for label, path in paths.items():
        print(f"{label + ':':9}{path}")
    print(f"versions: pyproject.toml {py_version}, package.json {npm_version}")
    problems = check(paths["wheel"], paths["tarball"], py_version, npm_version, paths["sdist"])
    if problems:
        for problem in problems:
            print(f"FAIL {problem}", file=sys.stderr)
        print(f"check_packages: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    _, statics, _ = read_wheel(paths["wheel"])
    core = statics[CORE]
    print(f"core file: {CORE} {len(core)} bytes sha256 {_sha(core)} in all three")
    print(f"static set: {', '.join(sorted(statics))} (identical bytes in all three)")
    print(f"check_packages: packages agree ({py_version})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wheel", type=Path, help="check this wheel instead of building one")
    parser.add_argument("--sdist", type=Path, help="check this sdist instead of building one")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--tarball", type=Path, help="check this npm tarball instead of packing")
    source.add_argument("--registry-tarball", metavar="SPEC", help="npm pack this registry spec")
    parser.add_argument("--out-dir", type=Path, help="build into this new or empty folder, keep")
    parser.add_argument(
        "--github-output", type=Path, help="on success append wheel=/sdist=/tarball="
    )
    args = parser.parse_args(argv)
    py_version, npm_version = read_versions()
    with tempfile.TemporaryDirectory(prefix="check-packages-") as tmp:
        # The build tools only ever see this temporary folder; what --out-dir asks to keep
        # is moved there afterwards.
        build_dir = Path(tmp).resolve()
        out_dir = args.out_dir.resolve() if args.out_dir else None
        if out_dir is not None and out_dir.exists() and any(out_dir.iterdir()):
            print(
                f"FAIL --out-dir {out_dir} is not empty; give a new or empty folder",
                file=sys.stderr,
            )
            return 1
        try:
            paths = _artefacts(args, build_dir)
            if out_dir is not None:
                paths = _keep(paths, build_dir, out_dir)
        except RuntimeError as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            return 1
        status = _report(paths, py_version, npm_version)
        if status == 0 and args.github_output:
            with args.github_output.open("a", encoding="utf-8") as fh:
                for label, path in paths.items():
                    fh.write(f"{label}={path}\n")
        return status


if __name__ == "__main__":
    sys.exit(main())
