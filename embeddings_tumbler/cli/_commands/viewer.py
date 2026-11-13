"""``embeddings-tumbler viewer`` — put the viewer files in a host folder, or serve them.

One noun with action verbs (``write``, ``serve``) plus the required ``overview``.
A noun keeps the viewer verbs together and leaves the global verb namespace to
the agent-first set (whoami, learn, explain, overview, doctor).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from embeddings_tumbler import _static_server, _viewer_files
from embeddings_tumbler.cli._commands.overview import emit_overview
from embeddings_tumbler.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from embeddings_tumbler.cli._output import emit_diagnostic, emit_result


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


def cmd_serve(args: argparse.Namespace) -> int:
    root = Path(args.folder)
    if not root.is_dir():
        raise CliError(EXIT_USER_ERROR, f"not a folder: {root}", "pass an existing folder")
    if not 0 <= args.port <= 65535:
        raise CliError(EXIT_USER_ERROR, f"port out of range: {args.port}", "use 0-65535")
    if not _static_server.is_loopback(args.host):
        emit_diagnostic(
            f"warning: binding to {args.host}, which is not loopback; "
            "anyone who can reach this address can read the folder."
        )
    try:
        server = _static_server.make_server(root, args.host, args.port, quiet=_json(args))
    except OSError as err:
        raise CliError(
            EXIT_ENV_ERROR,
            f"could not bind {args.host}:{args.port}: {err}",
            "pick another --port (0 picks a free one)",
        ) from err
    host, port = server.server_address[:2]
    shown = f"[{host}]" if ":" in host else host
    url = f"http://{shown}:{port}/"
    result = {"host": host, "port": port, "url": url, "root": str(root.resolve())}
    if _json(args):
        emit_result(result, json_mode=True)
    else:
        emit_result(f"serving {result['root']} at {url}", json_mode=False)
    sys.stdout.flush()
    emit_diagnostic("static files only; press Ctrl+C to stop.")
    run_server(server)
    return 0


def _overview_sections() -> list[dict[str, object]]:
    return [
        {
            "title": "Verbs",
            "items": [
                "write <folder> — copy the viewer files into a host folder "
                "(previews; --apply writes; --force overwrites)",
                "serve <folder> — serve a folder as static files on loopback",
                "overview — describe this noun",
            ],
        },
        {
            "title": "Conventions",
            "items": [
                "every verb supports --json",
                "write never overwrites without --force; serve is loopback unless --host says so",
                "serve is static only and reads no gateway address or key",
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
    p.add_argument("--json", action="store_true", help="Emit structured JSON.")
    p.set_defaults(func=cmd_viewer_overview, json=False)
    noun_sub = p.add_subparsers(dest="viewer_command", parser_class=type(p))

    w = noun_sub.add_parser(
        "write", help="Write the viewer files into a folder (preview unless --apply)."
    )
    w.add_argument("target", help="Host folder to write into.")
    w.add_argument("--apply", action="store_true", help="Actually write (default is a preview).")
    w.add_argument("--force", action="store_true", help="Overwrite files that already exist.")
    w.add_argument("--json", action="store_true", help="Emit structured JSON.")
    w.set_defaults(func=cmd_write)

    s = noun_sub.add_parser("serve", help="Serve a folder as static files (loopback by default).")
    s.add_argument("folder", help="Folder to serve.")
    s.add_argument("--host", default=_static_server.DEFAULT_HOST, help="Bind address.")
    s.add_argument("--port", type=int, default=8000, help="Port; 0 picks a free one.")
    s.add_argument("--json", action="store_true", help="Emit structured JSON.")
    s.set_defaults(func=cmd_serve)

    ov = noun_sub.add_parser("overview", help="Describe the viewer verbs.")
    ov.add_argument("--json", action="store_true", help="Emit structured JSON.")
    ov.set_defaults(func=cmd_viewer_overview)
