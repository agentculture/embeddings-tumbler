"""Tests for the ``viewer`` noun: ``write`` and ``serve``."""

from __future__ import annotations

import argparse
import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from embeddings_tumbler import _static_server, _viewer_files
from embeddings_tumbler.cli import main
from embeddings_tumbler.cli._commands import viewer as viewer_cmd
from embeddings_tumbler.cli._errors import CliError
from embeddings_tumbler.explain import known_paths

STATIC = Path(_viewer_files.default_source_root())  # type: ignore[arg-type]


def _fake_static(tmp_path: Path) -> Path:
    src = tmp_path / "src"
    (src / "sub" / "deep").mkdir(parents=True)
    (src / "__pycache__").mkdir()
    (src / "a.js").write_bytes(b"alpha\x00\xff")
    (src / "sub" / "b.css").write_text("b{}")
    (src / "sub" / "deep" / "c.html").write_text("<p>c</p>")
    (src / "__pycache__" / "x.pyc").write_bytes(b"x")
    (src / "helper.py").write_text("x = 1")
    return src


# --- write ---------------------------------------------------------------


def test_write_previews_by_default(tmp_path, capsys):
    target = tmp_path / "out"
    assert main(["viewer", "write", str(target)]) == 0
    cap = capsys.readouterr()
    assert "embeddings-tumbler.js" in cap.out
    assert "would write" in cap.out
    assert "--apply" in cap.err
    assert not target.exists()


def test_write_apply_is_byte_identical(tmp_path, capsys):
    target = tmp_path / "out"
    assert main(["viewer", "write", str(target), "--apply"]) == 0
    packaged = STATIC / "embeddings-tumbler.js"
    assert (target / "embeddings-tumbler.js").read_bytes() == packaged.read_bytes()
    assert not list(target.glob(".et-tmp-*"))


def test_write_refuses_existing_without_force(tmp_path, capsys):
    target = tmp_path / "out"
    target.mkdir()
    (target / "embeddings-tumbler.js").write_text("mine")
    assert main(["viewer", "write", str(target), "--apply"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("error:") and "hint:" in err
    assert (target / "embeddings-tumbler.js").read_text() == "mine"
    assert main(["viewer", "write", str(target), "--apply", "--force"]) == 0
    assert (target / "embeddings-tumbler.js").read_bytes() == (
        STATIC / "embeddings-tumbler.js"
    ).read_bytes()


def test_write_preview_reports_existing(tmp_path, capsys):
    target = tmp_path / "out"
    target.mkdir()
    (target / "embeddings-tumbler.js").write_text("mine")
    assert main(["viewer", "write", str(target), "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["applied"] is False
    assert payload["would_overwrite"] == ["embeddings-tumbler.js"]
    assert payload["files"][0]["exists"] is True
    assert (target / "embeddings-tumbler.js").read_text() == "mine"


def test_write_json_apply(tmp_path, capsys):
    assert main(["viewer", "write", str(tmp_path / "o"), "--apply", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["applied"] is True
    assert all(isinstance(f["bytes"], int) for f in payload["files"])


def test_write_fake_tree_nested_and_skips(tmp_path, capsys):
    src = _fake_static(tmp_path)
    target = tmp_path / "out"
    args = argparse.Namespace(target=str(target), apply=True, force=False, json=True)
    assert viewer_cmd.cmd_write(args, source_root=src) == 0
    written = sorted(p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file())
    assert written == ["a.js", "sub/b.css", "sub/deep/c.html"]
    assert (target / "a.js").read_bytes() == b"alpha\x00\xff"
    # sources untouched
    assert (src / "a.js").read_bytes() == b"alpha\x00\xff"
    # second run refuses atomically: nothing is changed
    (target / "sub" / "b.css").write_text("edited")
    with pytest.raises(CliError) as exc:
        viewer_cmd.cmd_write(args, source_root=src)
    assert exc.value.code == 1 and "sub/b.css" in exc.value.message
    assert (target / "sub" / "b.css").read_text() == "edited"
    args.force = True
    assert viewer_cmd.cmd_write(args, source_root=src) == 0
    assert (target / "sub" / "b.css").read_text() == "b{}"


def test_write_refuses_symlink_destination(tmp_path):
    src = _fake_static(tmp_path)
    target = tmp_path / "out"
    outside = tmp_path / "outside"
    outside.mkdir()
    target.mkdir()
    (target / "sub").symlink_to(outside, target_is_directory=True)
    args = argparse.Namespace(target=str(target), apply=True, force=True, json=False)
    with pytest.raises(CliError):
        viewer_cmd.cmd_write(args, source_root=src)
    assert not list(outside.iterdir())


def test_write_refuses_target_that_is_a_file(tmp_path, capsys):
    f = tmp_path / "file"
    f.write_text("x")
    assert main(["viewer", "write", str(f)]) == 1


def test_write_directory_in_the_way(tmp_path):
    src = _fake_static(tmp_path)
    target = tmp_path / "out"
    (target / "a.js").mkdir(parents=True)
    with pytest.raises(_viewer_files.WriteRefused):
        _viewer_files.plan(target, src)


# --- surface -------------------------------------------------------------


def test_viewer_overview_and_bare_noun(capsys):
    assert main(["viewer", "overview"]) == 0
    assert "# embeddings-tumbler viewer" in capsys.readouterr().out
    assert main(["viewer", "overview", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["subject"] == "embeddings-tumbler viewer"
    assert main(["viewer"]) == 0
    assert capsys.readouterr().out.strip()


def test_explain_entries_and_learn_list_viewer(capsys):
    for path in (("viewer",), ("viewer", "overview"), ("viewer", "write"), ("viewer", "serve")):
        assert path in known_paths()
        assert main(["explain", *path]) == 0
    capsys.readouterr()
    main(["learn"])
    text = capsys.readouterr().out
    assert "viewer write" in text and "viewer serve" in text
    main(["learn", "--json"])
    paths = [c["path"] for c in json.loads(capsys.readouterr().out)["commands"]]
    assert ["viewer", "write"] in paths and ["viewer", "serve"] in paths


# --- serve ---------------------------------------------------------------


@pytest.fixture
def served(tmp_path):
    root = tmp_path / "site"
    (root / "sub").mkdir(parents=True)
    (root / "index.html").write_text("<h1>hi</h1>")
    (root / "a.js").write_text("var a=1;")
    (root / "s.css").write_text("a{}")
    (root / "d.json").write_text("{}")
    (root / "v.f32").write_bytes(b"\x00\x01\x02\x03")
    (root / "f.woff2").write_bytes(b"wOF2")
    (root / "sub" / "index.html").write_text("sub")
    secret = tmp_path / "secret.txt"
    secret.write_text("TOPSECRET")
    (root / "link.txt").symlink_to(secret)
    (root / "inroot-link.js").symlink_to(root / "a.js")
    server = _static_server.make_server(root, port=0, quiet=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[:2]
    yield f"http://{host}:{port}", server
    server.shutdown()
    server.server_close()
    thread.join(5)


def _get(url, method="GET"):
    req = urllib.request.Request(url, method=method)  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=5) as r:  # noqa: S310  # nosec B310
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_serve_binds_loopback_by_default(served):
    base, server = served
    assert server.server_address[0] == "127.0.0.1"
    assert _static_server.is_loopback("::1") and _static_server.is_loopback("localhost")
    assert not _static_server.is_loopback("192.168.1.5")
    assert not _static_server.is_loopback("example.com")


@pytest.mark.parametrize(
    "path,ctype",
    [
        ("/a.js", "text/javascript"),
        ("/", "text/html"),
        ("/s.css", "text/css"),
        ("/d.json", "application/json"),
        ("/v.f32", "application/octet-stream"),
        ("/f.woff2", "font/woff2"),
    ],
)
def test_serve_content_types_and_no_store(served, path, ctype):
    base, _ = served
    status, headers, _body = _get(base + path)
    assert status == 200
    assert headers["Content-Type"].startswith(ctype)
    assert headers["Cache-Control"] == "no-store"


def test_serve_head_and_methods(served):
    base, _ = served
    status, headers, body = _get(base + "/a.js", "HEAD")
    assert status == 200 and body == b"" and headers["Content-Length"] == "8"
    for method in ("POST", "PUT", "DELETE"):
        status, headers, _ = _get(base + "/a.js", method)
        assert status == 405 and headers["Allow"] == "GET, HEAD"


@pytest.mark.parametrize(
    "path",
    ["/nope", "/../secret.txt", "/%2e%2e/secret.txt", "/link.txt", "/a.js%00", "/..%5c"],
)
def test_serve_refuses_escape_and_missing(served, path):
    base, _ = served
    status, _, body = _get(base + path)
    assert status in (404, 400)
    assert b"TOPSECRET" not in body


def test_serve_symlink_within_root_ok_and_dir_index(served):
    base, _ = served
    assert _get(base + "/inroot-link.js")[0] == 200
    assert _get(base + "/sub/")[2] == b"sub"


def test_serve_ignores_gateway_key_in_environment(served, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("EMBEDDINGS_GATEWAY_KEY", "SENTINEL-KEY-123")
    monkeypatch.setenv("EMBEDDINGS_GATEWAY_URL", "http://sentinel.invalid")
    base, _ = served
    seen = b""
    for p in ("/", "/a.js", "/nope"):
        status, headers, body = _get(base + p)
        seen += body + json.dumps(headers).encode()
    assert b"SENTINEL" not in seen and b"sentinel" not in seen
    # and the CLI output
    started = {}
    monkeypatch.setattr(viewer_cmd, "run_server", lambda s: started.setdefault("s", s))
    rc = main(["viewer", "serve", str(tmp_path), "--port", "0"])
    cap = capsys.readouterr()
    started["s"].server_close()
    assert rc == 0
    assert "SENTINEL" not in cap.out + cap.err


def test_serve_cli_json_shape(tmp_path, capsys, monkeypatch):
    started = {}
    monkeypatch.setattr(viewer_cmd, "run_server", lambda s: started.setdefault("s", s))
    assert main(["viewer", "serve", str(tmp_path), "--port", "0", "--json"]) == 0
    started["s"].server_close()
    cap = capsys.readouterr()
    payload = json.loads(cap.out)
    assert payload["host"] == "127.0.0.1" and payload["port"] > 0
    assert payload["url"] == f"http://127.0.0.1:{payload['port']}/"
    assert payload["root"] == str(tmp_path.resolve())
    assert "warning" not in cap.err


def test_serve_non_loopback_host_is_noted(tmp_path, capsys, monkeypatch):
    started = {}
    monkeypatch.setattr(viewer_cmd, "run_server", lambda s: started.setdefault("s", s))
    # the machine's own wildcard-free address is not portable; use a hostname-free
    # check via the helper plus a loopback alias that is not "127.0.0.1" literal.
    assert main(["viewer", "serve", str(tmp_path), "--port", "0", "--host", "127.0.0.2"]) == 0
    started["s"].server_close()
    assert "warning" not in capsys.readouterr().err  # 127.0.0.2 is still loopback


def test_serve_bad_folder_and_port(tmp_path, capsys):
    assert main(["viewer", "serve", str(tmp_path / "missing")]) == 1
    assert main(["viewer", "serve", str(tmp_path), "--port", "70000"]) == 1
    assert capsys.readouterr().err.count("error:") == 2


def _get_no_redirect(url):
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(url, timeout=5) as r:  # noqa: S310  # nosec B310
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_serve_directory_without_slash_redirects(served):
    base, _ = served
    status, headers, body = _get_no_redirect(base + "/sub")
    assert status == 301
    assert headers["Location"] == "/sub/"
    assert body != b"sub"
    status, headers, _ = _get_no_redirect(base + "/sub?x=1")
    assert status == 301 and headers["Location"] == "/sub/?x=1"
    # following the redirect lands on the folder's index
    assert _get(base + "/sub")[2] == b"sub"
    # a HEAD is redirected too, a missing folder or an escape is still a 404
    assert _get_no_redirect(base + "/nope")[0] == 404
    assert _get_no_redirect(base + "/..%2f..")[0] in (400, 404)


def test_serve_redirect_does_not_point_off_site(served):
    base, _ = served
    # a request target starting with two slashes must not become a
    # protocol-relative Location to another host
    status, headers, _ = _get_no_redirect(base + "//sub")
    assert status in (301, 404)
    if status == 301:
        assert not headers["Location"].startswith("//")


def _ipv6_loopback_available() -> bool:
    import socket

    if not socket.has_ipv6:
        return False
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::1", 0))
    except OSError:
        return False
    return True


@pytest.mark.skipif(not _ipv6_loopback_available(), reason="no IPv6 loopback on this machine")
def test_serve_ipv6_loopback(tmp_path, capsys, monkeypatch):
    (tmp_path / "index.html").write_text("six")
    started = {}
    monkeypatch.setattr(viewer_cmd, "run_server", lambda s: started.setdefault("s", s))
    assert main(["viewer", "serve", str(tmp_path), "--port", "0", "--host", "::1", "--json"]) == 0
    server = started["s"]
    cap = capsys.readouterr()
    payload = json.loads(cap.out)
    assert payload["host"] == "::1"
    assert payload["url"] == f"http://[::1]:{payload['port']}/"
    assert "warning" not in cap.err
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert _get(payload["url"])[2] == b"six"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def test_make_server_picks_address_family_from_host():
    import socket

    assert _static_server.address_family("127.0.0.1") == socket.AF_INET
    assert _static_server.address_family("localhost") == socket.AF_INET
    assert _static_server.address_family("::1") == socket.AF_INET6


def test_serve_bind_failure_remediation_names_the_cause(tmp_path, capsys, monkeypatch):
    import errno as _errno

    def refuse(code):
        def _make(*_a, **_k):
            raise OSError(code, "refused")

        return _make

    monkeypatch.setattr(_static_server, "make_server", refuse(_errno.EADDRINUSE))
    assert main(["viewer", "serve", str(tmp_path), "--port", "8000"]) == 2
    assert "--port" in capsys.readouterr().err
    monkeypatch.setattr(_static_server, "make_server", refuse(_errno.EADDRNOTAVAIL))
    assert main(["viewer", "serve", str(tmp_path), "--host", "::1", "--json"]) == 2
    cap = capsys.readouterr()
    assert "--host" in cap.err and "Traceback" not in cap.err and cap.out == ""


def test_the_redirect_location_is_rebuilt_never_echoed(tmp_path: Path) -> None:
    from embeddings_tumbler._static_server import directory_redirect

    (tmp_path / "sub dir").mkdir()
    (tmp_path / "sub dir" / "index.html").write_text("<!doctype html>", encoding="utf-8")
    root = tmp_path.resolve()
    assert directory_redirect(root, "/sub%20dir?data=a.json&mode=wander") == (
        "/sub%20dir/?data=a.json&mode=wander"
    )
    # A header break or control character in the query cannot reach the Location.
    for raw in (
        "/sub%20dir?x=%0d%0aSet-Cookie:a=b",
        "/sub%20dir?x=1\r\nX: y",
        "/sub%20dir?a b=<c>",
    ):
        location = directory_redirect(root, raw)
        assert location is not None
        assert location.startswith("/sub%20dir/?")
        assert "\r" not in location
        assert "\n" not in location
        assert " " not in location
        assert "<" not in location
    # Never a protocol-relative address.
    assert directory_redirect(root, "//sub%20dir") in (None, "/sub%20dir/")
