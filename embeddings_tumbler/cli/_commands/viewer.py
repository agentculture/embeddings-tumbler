"""``embeddings-tumbler viewer`` — put the viewer files in a host folder, or serve them.

One noun with action verbs (``write``, ``serve``) plus the required ``overview``.
A noun keeps the viewer verbs together and leaves the global verb namespace to
the agent-first set (whoami, learn, explain, overview, doctor).
"""

from __future__ import annotations

import argparse
import errno
import ipaddress
import os
import sys
from pathlib import Path

from embeddings_tumbler import _embed_route, _static_server, _viewer_files
from embeddings_tumbler.cli._commands.overview import emit_overview
from embeddings_tumbler.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from embeddings_tumbler.cli._output import emit_diagnostic, emit_result

_JSON_HELP = "Emit structured JSON."


def _json(args: argparse.Namespace) -> bool:
    return bool(getattr(args, "json", False))


def _file_row(f: _viewer_files.PlannedFile) -> dict[str, object]:
    return {"path": f.rel, "bytes": f.size, "exists": f.exists}


def cmd_write(args: argparse.Namespace, source_root=None) -> int:
    target = Path(args.target)
    try:
        planned = _viewer_files.plan(target, source_root)
        applying = bool(args.apply)
        if applying:
            _viewer_files.apply(target, planned, force=bool(args.force))
    except _viewer_files.WriteRefused as err:
        raise CliError(EXIT_USER_ERROR, err.message, err.remediation) from err
    except OSError as err:
        raise CliError(
            EXIT_ENV_ERROR, f"could not write to {target}: {err}", "check the folder permissions"
        ) from err
    rows = [_file_row(f) for f in planned]
    clashes = [f.rel for f in planned if f.exists]
    if _json(args):
        emit_result(
            {
                "target": str(target),
                "applied": applying,
                "force": bool(args.force),
                "files": rows,
                "would_overwrite": clashes,
            },
            json_mode=True,
        )
        return 0
    lines = [f"{'wrote' if applying else 'would write'} {len(rows)} file(s) to {target}"]
    for r in rows:
        state = "exists" if r["exists"] else "new"
        lines.append(f"  {r['path']}  {r['bytes']} bytes  ({state})")
    emit_result("\n".join(lines), json_mode=False)
    if not applying:
        note = "preview only; nothing written. Re-run with --apply to write."
        if clashes:
            note += " Existing files need --force to be overwritten."
        emit_diagnostic(note)
    return 0


def run_server(server) -> None:
    """The blocking path, kept thin so tests can replace it."""
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


_EMBED_ONLY_FLAGS = (
    ("embed_model", "--embed-model"),
    ("rerank_model", "--rerank-model"),
    ("query_prefix", "--query-prefix"),
    ("embed_allow_remote", "--embed-allow-remote"),
)


def _is_unspecified(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_unspecified
    except ValueError:
        return False


def _embed_route_for(args: argparse.Namespace) -> _embed_route.EmbedRoute | None:
    """The embed route when ``--embed`` is given, else None (and no environment read)."""
    if not getattr(args, "embed", False):
        stray = [flag for name, flag in _EMBED_ONLY_FLAGS if getattr(args, name, None)]
        if stray:
            raise CliError(EXIT_USER_ERROR, f"{stray[0]} needs --embed", "add --embed")
        return None
    if _is_unspecified(args.host):
        raise CliError(
            EXIT_USER_ERROR,
            f"--embed cannot bind the wildcard address {args.host}",
            "bind --host to one address of this machine",
        )
    if not _static_server.is_loopback(args.host) and not args.embed_allow_remote:
        raise CliError(
            EXIT_USER_ERROR,
            f"--embed on {args.host}, which is not loopback, needs --embed-allow-remote",
            "bind to 127.0.0.1, or add --embed-allow-remote if others should reach it",
        )
    try:
        config = _embed_route.load_config(
            os.environ,
            embed_model=args.embed_model,
            rerank_model=args.rerank_model,
            query_prefix=args.query_prefix,
        )
    except _embed_route.ConfigError as err:
        raise CliError(EXIT_ENV_ERROR, err.message, err.remediation) from err
    return _embed_route.EmbedRoute(config)


def _check_serve_args(args: argparse.Namespace) -> Path:
    root = Path(args.folder)
    if not root.is_dir():
        raise CliError(EXIT_USER_ERROR, f"not a folder: {root}", "pass an existing folder")
    if not 0 <= args.port <= 65535:
        raise CliError(EXIT_USER_ERROR, f"port out of range: {args.port}", "use 0-65535")
    return root


def cmd_serve(args: argparse.Namespace) -> int:
    root = _check_serve_args(args)
    embed = _embed_route_for(args)
    if not _static_server.is_loopback(args.host):
        emit_diagnostic(
            f"warning: binding to {args.host}, which is not loopback; "
            "anyone who can reach this address can read the folder."
        )
    try:
        server = _static_server.make_server(
            root, args.host, args.port, quiet=_json(args), embed=embed
        )
    except OSError as err:
        if err.errno == errno.EADDRINUSE:
            remedy = "pick another --port (0 picks a free one)"
        else:
            remedy = "check that --host is an address of this machine (127.0.0.1 or ::1)"
        raise CliError(
            EXIT_ENV_ERROR, f"could not bind {args.host}:{args.port}: {err}", remedy
        ) from err
    host, port = server.server_address[:2]
    shown = f"[{host}]" if ":" in host else host
    url = f"http://{shown}:{port}/"
    result: dict[str, object] = {
        "host": host,
        "port": port,
        "url": url,
        "root": str(root.resolve()),
    }
    if embed is not None:
        result["embed"] = embed.config.public()
    if _json(args):
        emit_result(result, json_mode=True)
    else:
        emit_result(f"serving {result['root']} at {url}", json_mode=False)
    sys.stdout.flush()
    if embed is None:
        emit_diagnostic("static files only; press Ctrl+C to stop.")
    else:
        rerank = embed.config.rerank_model or "off"
        emit_diagnostic(
            f"search route on at {_embed_route.ROUTE} (embed model {embed.config.embed_model}, "
            f"rerank {rerank}, query form {embed.config.query_form}); press Ctrl+C to stop."
        )
    run_server(server)
    return 0


def _overview_sections() -> list[dict[str, object]]:
    return [
        {
            "title": "Verbs",
            "items": [
                "write <folder> — copy the viewer files into a host folder "
                "(previews; --apply writes; --force overwrites)",
                "serve <folder> — serve a folder as static files on loopback "
                "(--embed adds a same-origin search route)",
                "overview — describe this noun",
            ],
        },
        {
            "title": "Conventions",
            "items": [
                "every verb supports --json",
                "write never overwrites without --force; serve is loopback unless --host says so",
                "serve is static only and reads no gateway address or key unless --embed; "
                "with --embed the key stays in the server process",
            ],
        },
    ]


def cmd_viewer_overview(args: argparse.Namespace) -> int:
    emit_overview("embeddings-tumbler viewer", _overview_sections(), json_mode=_json(args))
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "viewer",
        help="Write the viewer files into a host folder, or serve a folder locally.",
    )
    p.add_argument("--json", action="store_true", help=_JSON_HELP)
    p.set_defaults(func=cmd_viewer_overview, json=False)
    noun_sub = p.add_subparsers(dest="viewer_command", parser_class=type(p))

    w = noun_sub.add_parser(
        "write", help="Write the viewer files into a folder (preview unless --apply)."
    )
    w.add_argument("target", help="Host folder to write into.")
    w.add_argument("--apply", action="store_true", help="Actually write (default is a preview).")
    w.add_argument("--force", action="store_true", help="Overwrite files that already exist.")
    w.add_argument("--json", action="store_true", help=_JSON_HELP)
    w.set_defaults(func=cmd_write)

    s = noun_sub.add_parser("serve", help="Serve a folder as static files (loopback by default).")
    s.add_argument("folder", help="Folder to serve.")
    s.add_argument("--host", default=_static_server.DEFAULT_HOST, help="Bind address.")
    s.add_argument("--port", type=int, default=8000, help="Port; 0 picks a free one.")
    s.add_argument(
        "--embed",
        action="store_true",
        help="Add the search route POST /_tumbler/search (reads the gateway settings).",
    )
    s.add_argument("--embed-model", default=None, help="Embedding model to ask the gateway for.")
    s.add_argument(
        "--rerank-model", default=None, help="Offer reranking with this model (off by default)."
    )
    s.add_argument("--query-prefix", default=None, help="Text put before every query.")
    s.add_argument(
        "--embed-allow-remote",
        action="store_true",
        help="Allow --embed on a non-loopback --host.",
    )
    s.add_argument("--json", action="store_true", help=_JSON_HELP)
    s.set_defaults(func=cmd_serve)

    ov = noun_sub.add_parser("overview", help="Describe the viewer verbs.")
    ov.add_argument("--json", action="store_true", help=_JSON_HELP)
    ov.set_defaults(func=cmd_viewer_overview)
