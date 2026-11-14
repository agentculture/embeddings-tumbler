"""Plan and write the packaged viewer files into a host folder.

Pure logic, no CLI: the ``viewer write`` verb wraps it. The source is whatever
ships under ``embeddings_tumbler/static/`` (read through ``importlib.resources``),
so new files appear here without a code change. Source files are only read.
"""

from __future__ import annotations

import contextlib
import os
import secrets
from dataclasses import dataclass
from importlib import resources
from importlib.resources.abc import Traversable
from pathlib import Path

_SKIP_DIRS = {"__pycache__"}
_SKIP_SUFFIXES = {".py", ".pyc", ".pyo"}


class WriteRefused(Exception):
    """A planned write that must not happen (unsafe path, conflict)."""

    def __init__(self, message: str, remediation: str = "") -> None:
        super().__init__(message)
        self.message = message
        self.remediation = remediation


@dataclass(frozen=True)
class PlannedFile:
    rel: str  # POSIX-style path relative to the target folder
    size: int
    exists: bool
    source: Traversable


def default_source_root() -> Traversable:
    return resources.files("embeddings_tumbler") / "static"


def _walk(node: Traversable, prefix: tuple[str, ...]) -> list[tuple[tuple[str, ...], Traversable]]:
    found: list[tuple[tuple[str, ...], Traversable]] = []
    for child in sorted(node.iterdir(), key=lambda c: c.name):
        if child.is_dir():
            if child.name not in _SKIP_DIRS:
                found.extend(_walk(child, prefix + (child.name,)))
        elif child.is_file() and Path(child.name).suffix not in _SKIP_SUFFIXES:
            found.append((prefix + (child.name,), child))
    return found


def _safe_destination(target: Path, parts: tuple[str, ...]) -> Path:
    """Return the destination path, refusing anything that could leave ``target``."""
    root = target.resolve()
    dest = root.joinpath(*parts)
    cursor = root
    for part in parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise WriteRefused(
                f"refusing to write through a symlink: {cursor}",
                "remove the symlink or choose another folder",
            )
    if not dest.resolve().is_relative_to(root):
        raise WriteRefused(f"path escapes the target folder: {dest}")
    if dest.is_dir():
        raise WriteRefused(
            f"a directory is in the way of file: {dest}", "remove it or choose another folder"
        )
    return dest


def plan(target: Path, source_root: Traversable | None = None) -> list[PlannedFile]:
    """List what would be written to ``target``. Touches nothing on disk."""
    root = source_root if source_root is not None else default_source_root()
    if not root.is_dir():
        raise WriteRefused("no viewer files are packaged", "reinstall embeddings-tumbler")
    if target.exists() and not target.is_dir():
        raise WriteRefused(f"target is not a folder: {target}", "choose a folder path")
    planned = []
    for parts, source in _walk(root, ()):
        dest = _safe_destination(target, parts)
        planned.append(
            PlannedFile(
                rel="/".join(parts),
                size=len(source.read_bytes()),
                exists=dest.exists(),
                source=source,
            )
        )
    return planned


#: The most a written file is ever given: owner read/write, group and other read. Never
#: group or other write: a served asset has no reason to be writable by anyone else.
SERVED_FILE_MODE = 0o644


def _new_file_mode() -> int:
    """:data:`SERVED_FILE_MODE` reduced by this process's umask (0644 under 022 or 002)."""
    # Reading the umask means setting one for an instant. Set the strictest value while
    # we look (never 0), so a file created in that instant by anything else is private.
    umask = os.umask(0o077)
    os.umask(umask)
    return SERVED_FILE_MODE & ~umask


def _write_atomic(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # A fresh, unpredictable name created exclusively ("x" refuses an existing file or
    # symlink), then renamed over the destination. The mode is set on the temporary
    # file, before it takes its name: at most 0644, reduced by the user's umask, so a
    # web server running as another user can read the assets and nobody else can write
    # them. The same rule as `embeddings export` in embeddings-cli.
    mode = _new_file_mode()
    tmp = dest.parent / f".et-tmp-{secrets.token_hex(16)}"
    # Opened before the try: if the name was taken, the file is not ours to remove.
    with open(tmp, "xb") as handle:
        try:
            handle.write(data)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            handle.close()
            os.replace(tmp, dest)
        except BaseException:
            with contextlib.suppress(OSError):
                handle.close()
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise


def apply(target: Path, planned: list[PlannedFile], *, force: bool) -> None:
    """Write the planned files. Refuses, before writing anything, on existing files."""
    clashes = [f.rel for f in planned if f.exists]
    if clashes and not force:
        raise WriteRefused(
            "refusing to overwrite existing files: " + ", ".join(clashes),
            "re-run with --force to overwrite them",
        )
    for item in planned:
        dest = _safe_destination(target, tuple(item.rel.split("/")))
        _write_atomic(dest, item.source.read_bytes())
