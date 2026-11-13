# embeddings-tumbler

Visualize embedding space: tumble, lattice and wander through high-dimensional embeddings in a 3-D window.

## What this is

`embeddings-tumbler` is a **drop-in viewer for embedding spaces**. A host page
hands it a set of embedding vectors and it shows them as a moving 3-D window
through the full-dimensional space. A rotating tesseract is a 4-D shape seen
through a 3-D window that keeps turning; this is the same idea with hundreds or
thousands of dimensions. The data never moves. Only the viewing frame does.

Three modes ship first:

- **Tumble** — the frame drifts through the space on a guided, seeded tour.
- **Lattice** — points are wired to their true nearest neighbours (measured in
  the full space) and one visible axis at a time is swapped for a hidden one.
- **Wander** — the camera flies from point to neighbouring point and re-fits
  its axes to each neighbourhood.

Every view is a linear projection: a shadow of the space, not the space. Each
view states where the vectors came from, the model, the dimension, the item
count and the seed.

It is a sibling of [`embeddings-cli`](https://github.com/agentculture/embeddings-cli),
which measures embedding spaces and is the first producer of data for this
viewer.

## Why it exists

As of 2026-11-13 no repository surveyed for this work (`embeddings-lens`,
`irc-lens`, `webglass-cli`, `embodiment`, `eidetic-cli`) contained an embedding
viewer. The only one was a single demo page whose data is generated in the
page. That page is kept here as the visual and behavioural reference:
[`docs/specs/reference/embedding-tumbler-demo.html`](docs/specs/reference/embedding-tumbler-demo.html).

## Status: being built

The viewer is being built from a converged spec and plan. Until the tasks
land, the installed package is the agent-first CLI described under [CLI](#cli).

| What | Where |
|------|-------|
| The spec | [`docs/specs/2026-11-13-embeddable-space-viewer.md`](docs/specs/2026-11-13-embeddable-space-viewer.md) |
| The plan (18 tasks, 7 waves) | [`docs/plans/2026-11-13-embeddable-space-viewer.md`](docs/plans/2026-11-13-embeddable-space-viewer.md) |
| The approved implementation split | [`docs/plans/2026-11-13-embeddable-space-viewer-split.md`](docs/plans/2026-11-13-embeddable-space-viewer-split.md) |
| The reference demo | [`docs/specs/reference/embedding-tumbler-demo.html`](docs/specs/reference/embedding-tumbler-demo.html) |
| What real vectors look like, measured | [`docs/evidence/2026-11-13-real-vector-probe.md`](docs/evidence/2026-11-13-real-vector-probe.md) |

What it will be (planned):

- **One dependency-free JavaScript file** with `mount(el)`, `update(data)` and
  `destroy(el)`. No build step is needed to use it, and it loads nothing from
  another origin, so it runs under `script-src 'self'`.
- **Three delivery forms over that same file:** the script, a web component
  (`<embeddings-tumbler>`), and a standalone page.
- **A versioned data contract.** Vectors travel as a little-endian float32
  block; the dimension comes from the data; one model per view.
- **Two release channels carrying the same file:** the Python wheel and an npm
  package.
- **Data stays put.** The viewer sends text, labels and vectors nowhere.

## Repository scaffold

The repository was scaffolded from `culture-agent-template`, which provides the
agent-first CLI (cited from [teken](https://github.com/agentculture/teken)),
the mesh identity in `culture.yaml`, one prompt file per agent harness, the
vendored skill kit under `.claude/skills/` (see
[`docs/skill-sources.md`](docs/skill-sources.md)), and the CI baseline.

## Prompt files by harness

Four harnesses, four root files, no shared base — each file is read by
exactly one harness:

| Harness | File(s) |
|---------|---------|
| Claude Code | [`CLAUDE.md`](CLAUDE.md) |
| Pi / associate | [`AGENTS.override.md`](AGENTS.override.md) + [`.pi/SYSTEM.md`](.pi/SYSTEM.md) |
| colleague | [`AGENTS.colleague.md`](AGENTS.colleague.md) |
| Qwen Code | [`QWEN.md`](QWEN.md) |

**Claude Code** — `CLAUDE.md` is the fullest write-up of the repo's
conventions; read it first.

**Pi / associate** — `AGENTS.override.md` replaces this directory's
`AGENTS.md`/`CLAUDE.md` in Pi's context layer, so Pi does not inherit
`CLAUDE.md`. `.pi/SYSTEM.md` replaces Pi's default system prompt with the
non-coding `associate` identity (read/find/summarize only).

**colleague** — colleague's prompt cascade is `AGENTS.md` →
`AGENTS.colleague.md` → `AGENTS.colleague.<model>.md`. This repo ships only
the middle layer: there is no `AGENTS.md` (a shared base across harnesses was
considered and rejected) and no per-model override file.

**Qwen Code** — Qwen Code reads `QWEN.md` and `AGENTS.md`; since there is no
`AGENTS.md`, `QWEN.md` is its sole source of guidance.

There is intentionally **no `AGENTS.md`** at the root — each harness gets an
unrelated file rather than cascading from a shared base.

## Two selections, not one

It is tempting to read "switch harness" as one decision. It is actually two,
and the scaffold keeps them separate:

1. **The interactive harness** — which binary you run (`claude`, `pi`,
   `colleague`, `qwen`). `cd` into the clone and run any of them; all four
   are live simultaneously, and none of them requires editing a file or
   flipping a switch. A harness can be force-selected for one invocation
   (e.g. a CI smoke check) without ever touching `culture.yaml` — see
   [`docs/automation-contract.md`](docs/automation-contract.md).
2. **The mesh resident** — the single `backend` `culture.yaml` declares,
   which is what the Culture daemon starts and what `steward doctor`
   checks. `guild harness use <name>` changes only this.

`culture.yaml`'s `backend` affects (2) only. It never affects which harness
you can invoke interactively in (1). See
[`docs/harness-selection.md`](docs/harness-selection.md) for the full
writeup, including who reads this config and why existing siblings are not
retrofitted by this arc.

## Quickstart

```bash
uv sync
uv run pytest -n auto                 # run the test suite
uv run embeddings-tumbler whoami  # identity from culture.yaml
uv run embeddings-tumbler learn   # self-teaching prompt (add --json)
uv run teken cli doctor . --strict    # the agent-first rubric gate CI runs
```

## CLI

| Verb | What it does |
|------|--------------|
| `whoami` | Report this agent's nick, version, backend, and model from `culture.yaml`. |
| `learn` | Print a structured self-teaching prompt. |
| `explain <path>` | Markdown docs for any noun/verb path. |
| `overview` | Read-only descriptive snapshot of the agent. |
| `doctor` | Check the agent-identity invariants (prompt-file-present, backend-consistency). |
| `cli overview` | Describe the CLI surface itself. |

Every command supports `--json`. Results go to stdout, errors/diagnostics to
stderr (never mixed). Exit codes: `0` success, `1` user error, `2` environment
error, `3+` reserved.

## Conventions

See [`CLAUDE.md`](CLAUDE.md) for the rules the spec fixes and the working
conventions (a version bump in every PR, the `cicd` PR lane, shipping).

## The `gate` section

`culture.yaml` may carry a top-level `gate` section that declares how to set
up and test this repo, so tooling (for example a PR-fixer that re-runs the
checks before pushing) needs no per-repo knowledge:

```yaml
gate:
  setup:
  - [uv, sync]
  test:
  - [uv, run, pytest, -n, auto]
```

`setup` and `test` are each a list of commands, and each command is an argv
list (never a shell string), run in order from the repo root. The values are
configuration only; no tool supplies a default. Culture's loader ignores
unknown top-level keys, so the section is safe alongside `agents`.

## License

Apache 2.0 — see [`LICENSE`](LICENSE).
