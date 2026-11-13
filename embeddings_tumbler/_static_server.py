"""A small static-file server for trying the viewer locally.

Standard library only. It serves regular files under one folder, GET and HEAD
only. It reads no environment variable and no file other than the ones it
serves, so no gateway address or key can reach it.
"""

from __future__ import annotations

import ipaddress
import os
import posixpath
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

DEFAULT_HOST = "127.0.0.1"

CONTENT_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".f32": "application/octet-stream",
    ".bin": "application/octet-stream",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def resolve_request(root: Path, raw_path: str) -> Path | None:
    """Map a request target to a regular file inside ``root``, or None."""
    path = unquote(urlsplit(raw_path).path)
    if "\x00" in path or "\\" in path:
        return None
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if ".." in parts:
        return None
    candidate = root.joinpath(*parts)
    if path.endswith("/") or candidate.is_dir():
        candidate = candidate / "index.html"
    real = Path(os.path.realpath(candidate))
    if not real.is_relative_to(root) or not real.is_file():
        return None
    return real


class _Handler(BaseHTTPRequestHandler):
    server_version = "embeddings-tumbler"
    sys_version = ""

    def __init__(self, *args, root: Path, quiet: bool, **kwargs) -> None:
        self._root = root
        self._quiet = quiet
        super().__init__(*args, **kwargs)

    def _send_head(self) -> Path | None:
        target = resolve_request(self._root, self.path)
        if target is None:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return None
        ctype = CONTENT_TYPES.get(posixpath.splitext(target.name)[1].lower())
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(target.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        return target

    def do_GET(self) -> None:  # noqa: N802
        target = self._send_head()
        if target is not None:
            self.wfile.write(target.read_bytes())

    def do_HEAD(self) -> None:  # noqa: N802
        self._send_head()

    def _not_allowed(self) -> None:
        self.send_response(HTTPStatus.METHOD_NOT_ALLOWED)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed  # noqa: N815

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        if not self._quiet:
            super().log_message(format, *args)


def make_server(
    root: Path, host: str = DEFAULT_HOST, port: int = 0, *, quiet: bool = False
) -> ThreadingHTTPServer:
    """Build (bind) the server without starting it. ``port`` 0 picks a free port."""
    real_root = Path(os.path.realpath(root))
    handler = partial(_Handler, root=real_root, quiet=quiet)
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server
