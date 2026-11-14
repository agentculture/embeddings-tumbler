"""A small static-file server for trying the viewer locally.

Standard library only. It serves regular files under one folder, GET and HEAD
only. It reads no environment variable and no file other than the ones it
serves, so no gateway address or key can reach it.
"""

from __future__ import annotations

import ipaddress
import os
import posixpath
import socket
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

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


def address_family(host: str) -> socket.AddressFamily:
    """IPv6 for an IPv6 literal (``::1``), IPv4 for everything else."""
    try:
        if ipaddress.ip_address(host).version == 6:
            return socket.AF_INET6
    except ValueError:
        pass
    return socket.AF_INET


def _parts(raw_path: str) -> tuple[str, list[str]] | None:
    path = unquote(urlsplit(raw_path).path)
    if "\x00" in path or "\\" in path:
        return None
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if ".." in parts:
        return None
    return path, parts


def resolve_request(root: Path, raw_path: str) -> Path | None:
    """Map a request target to a regular file inside ``root``, or None."""
    split = _parts(raw_path)
    if split is None:
        return None
    path, parts = split
    candidate = root.joinpath(*parts)
    if path.endswith("/") or candidate.is_dir():
        candidate = candidate / "index.html"
    real = Path(os.path.realpath(candidate))
    if not real.is_relative_to(root) or not real.is_file():
        return None
    return real


def directory_redirect(root: Path, raw_path: str) -> str | None:
    """The slash form of a request for a folder named without its trailing slash.

    Returns the ``Location`` to send (``/sub/``, query kept), or None when the
    request is not for such a folder. Only a folder inside ``root`` that has an
    ``index.html`` the server would serve is redirected; everything else falls
    through to the normal (404) path. Like ``http.server``, so that relative
    links in the folder's page resolve against the folder, not its parent.
    """
    split = _parts(raw_path)
    if split is None:
        return None
    path, parts = split
    if path.endswith("/") or not parts:
        return None
    if resolve_request(root, raw_path) is None:
        return None
    real = Path(os.path.realpath(root.joinpath(*parts)))
    if not real.is_dir() or not real.is_relative_to(root):
        return None
    query = urlsplit(raw_path).query
    location = "/" + "/".join(quote(p) for p in parts) + "/"
    return location + ("?" + query if query else "")


class _Handler(BaseHTTPRequestHandler):
    server_version = "embeddings-tumbler"
    sys_version = ""

    def __init__(self, *args, root: Path, quiet: bool, **kwargs) -> None:
        self._root = root
        self._quiet = quiet
        super().__init__(*args, **kwargs)

    def _send_head(self) -> Path | None:
        location = directory_redirect(self._root, self.path)
        if location is not None:
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return None
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


class _ThreadingHTTPServerV6(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def make_server(
    root: Path, host: str = DEFAULT_HOST, port: int = 0, *, quiet: bool = False
) -> ThreadingHTTPServer:
    """Build (bind) the server without starting it. ``port`` 0 picks a free port."""
    real_root = Path(os.path.realpath(root))
    handler = partial(_Handler, root=real_root, quiet=quiet)
    server_class = _ThreadingHTTPServerV6 if address_family(host) == socket.AF_INET6 else None
    server = (server_class or ThreadingHTTPServer)((host, port), handler)
    server.daemon_threads = True
    return server
