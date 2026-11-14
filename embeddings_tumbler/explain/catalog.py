"""Markdown catalog for ``embeddings-tumbler explain <path>``.

Each entry is verbatim markdown. Keys are command-path tuples. The empty tuple
and ``("embeddings-tumbler",)`` both resolve to the root entry.

Keep bodies self-contained: an agent reading one entry should get enough
context without chaining reads.
"""

from __future__ import annotations

_ROOT = """\
# embeddings-tumbler

A clonable template for AgentCulture mesh agents. It carries an agent-first CLI
(cited from the teken `python-cli` reference), a mesh identity (`culture.yaml` +
`CLAUDE.md`), the canonical guildmaster skill kit under `.claude/skills/`, and a
buildable/deployable package baseline. Clone it, rename the package, edit
`culture.yaml`, and you have a new agent.

## Verbs

- `embeddings-tumbler whoami` — identity probe from `culture.yaml`.
- `embeddings-tumbler learn` — structured self-teaching prompt.
- `embeddings-tumbler explain <path>` — markdown docs for any noun/verb.
- `embeddings-tumbler overview` — descriptive snapshot of the agent.
- `embeddings-tumbler doctor` — check the agent-identity invariants.
- `embeddings-tumbler cli overview` — describe the CLI surface.
- `embeddings-tumbler viewer write|serve|overview` — ship and try the viewer files.

## Exit-code policy

- `0` success
- `1` user-input error
- `2` environment / setup error
- `3+` reserved

## See also

- `embeddings-tumbler explain whoami`
- `embeddings-tumbler explain doctor`
"""

_WHOAMI = """\
# embeddings-tumbler whoami

Reports the agent's identity from `culture.yaml`: nick (`suffix`), backend,
served model, and the package version. Read-only.

## Usage

    embeddings-tumbler whoami
    embeddings-tumbler whoami --json
"""

_LEARN = """\
# embeddings-tumbler learn

Prints a structured self-teaching prompt covering purpose, command map,
exit-code policy, `--json` support, and the `explain` pointer.

## Usage

    embeddings-tumbler learn
    embeddings-tumbler learn --json
"""

_EXPLAIN = """\
# embeddings-tumbler explain <path>

Prints markdown documentation for any noun/verb path. Unlike `--help` (terse,
positional), `explain` is global and addressable by path.

## Usage

    embeddings-tumbler explain embeddings-tumbler
    embeddings-tumbler explain whoami
    embeddings-tumbler explain --json <path>
"""

_OVERVIEW = """\
# embeddings-tumbler overview

Read-only descriptive snapshot of the agent: identity (from `culture.yaml`), the
verb surface, and the sibling-pattern artifacts the template carries. Accepts an
ignored `target` so a stray path never hard-fails.

## Usage

    embeddings-tumbler overview
    embeddings-tumbler overview --json
"""

_DOCTOR = """\
# embeddings-tumbler doctor

Checks the agent-identity invariants `steward doctor` verifies:
prompt-file-present and backend-consistency (`claude` → `CLAUDE.md`), plus a
skills-present check. Exits 1 when unhealthy.

prompt-file-present requires the *resident* prompt the declared backend
actually reads. Other harness prompt files recognized under the same backend
name (`AGENTS.override.md`, `.pi/SYSTEM.md`, `QWEN.md`) belong to
interactively available harnesses the mesh daemon never loads; they are
reported by the informational harness-prompts check and never substituted.

## Usage

    embeddings-tumbler doctor
    embeddings-tumbler doctor --json
"""

_CLI = """\
# embeddings-tumbler cli

Noun group for CLI-surface introspection. `cli overview` describes the CLI
itself (distinct from the global `overview`, which describes the agent).

## Usage

    embeddings-tumbler cli overview
    embeddings-tumbler cli overview --json
"""
_VIEWER = """\
# embeddings-tumbler viewer

Noun group for the embedding-space viewer files packaged with this tool.

- `viewer write <folder>` copies them into a host folder.
- `viewer serve <folder>` serves a folder as static files for local testing.
- `viewer overview` describes the verbs.

## Usage

    embeddings-tumbler viewer overview
    embeddings-tumbler viewer overview --json
"""

_VIEWER_WRITE = """\
# embeddings-tumbler viewer write

Writes everything shipped under the package's `static/` folder (the core
script, and the web component and standalone page as they ship) into a host
folder, keeping relative paths. The copies are byte-identical to the packaged
files.

It previews by default: each file is listed with its size and whether it
already exists. Nothing is written without `--apply`. Existing files are never
overwritten without `--force`; the refusal happens before any file is written.
Files are written atomically. A destination that is, or passes through, a
symlink is refused.

## Usage

    embeddings-tumbler viewer write ./public/tumbler            # preview
    embeddings-tumbler viewer write ./public/tumbler --apply
    embeddings-tumbler viewer write ./public/tumbler --apply --force
    embeddings-tumbler viewer write ./public/tumbler --json

Exit codes: 0 success or preview, 1 refused (existing files, unsafe path),
2 the folder could not be written.
"""

_VIEWER_SERVE = """\
# embeddings-tumbler viewer serve

Serves a folder as static files so the viewer can be tried locally. GET and
HEAD only (anything else is 405); only regular files under the folder are
served, with no directory traversal and no symlink escape. Responses carry the
right content types (`.js`, `.html`, `.css`, `.json`, `.f32`, fonts) and
`Cache-Control: no-store`.

It binds to `127.0.0.1` by default. A non-loopback `--host` must be given
explicitly and is noted on stderr. `--port 0` picks a free port. The server
reads no gateway address or key from anywhere.

## Usage

    embeddings-tumbler viewer serve ./public/tumbler
    embeddings-tumbler viewer serve ./public/tumbler --port 0 --json

`--json` prints `{"host", "port", "url", "root"}` once, then serves until
interrupted. Exit codes: 0 stopped, 1 bad folder or port, 2 could not bind.
"""


ENTRIES: dict[tuple[str, ...], str] = {
    (): _ROOT,
    ("embeddings-tumbler",): _ROOT,
    ("whoami",): _WHOAMI,
    ("learn",): _LEARN,
    ("explain",): _EXPLAIN,
    ("overview",): _OVERVIEW,
    ("doctor",): _DOCTOR,
    ("cli",): _CLI,
    ("cli", "overview"): _CLI,
    ("viewer",): _VIEWER,
    ("viewer", "overview"): _VIEWER,
    ("viewer", "write"): _VIEWER_WRITE,
    ("viewer", "serve"): _VIEWER_SERVE,
}
