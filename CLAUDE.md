# CLAUDE.md

Guidance for Claude Code (and any agent) working in this repository.

## What this project is

`embeddings-tumbler` is a **drop-in viewer for embedding spaces**. A host page
hands it a set of embedding vectors and it shows them as a moving 3-D window
through the full-dimensional space. A rotating tesseract is a 4-D shape seen
through a 3-D window that keeps turning; this is the same idea with hundreds or
thousands of dimensions. The data never moves. Only the viewing frame does.

Three modes ship first, and a mode is a separable unit so more can be added:

- **Tumble** — the frame drifts through the space on a guided tour.
- **Lattice** — points are wired to their true nearest neighbours (measured in
  the full space) and one visible axis at a time is swapped for a hidden one,
  drawn from the data's strongest directions.
- **Wander** — the camera flies from point to neighbouring point and re-fits
  its axes to each neighbourhood.

It is a sibling of [`embeddings-cli`](https://github.com/agentculture/embeddings-cli),
which measures embedding spaces and is the first producer of data for this
viewer.

As of 2026-11-13 no repository surveyed for this work (`embeddings-lens`,
`irc-lens`, `webglass-cli`, `embodiment`, `eidetic-cli`) contained an embedding
viewer; the only one was a demo page whose data is generated in the page. That
page is the reference: `docs/specs/reference/embedding-tumbler-demo.html`.

## Current state: built and released; search specced

The viewer is built from the converged spec and plan (18 tasks, by a workforce
run that ended 2026-11-14). In the repository: the data contract and its
fixtures (`docs/data-contract.md`, `tests/fixtures/contract/`); the core file,
assembled from `js/src/` by `scripts/assemble.py` (mathematics, contract
loader, WebGL 2 renderer, the three modes, the viewer API `mount` / `update` /
`destroy`); the built-in sample set; the two shells (`js/shells/`,
`js/page/`); the shipped copies under `embeddings_tumbler/static/`; the
`viewer overview | write | serve` CLI verbs; packaging for the wheel and for
npm with a byte-identity check (`scripts/check_packages.py`); the browser
harness (`tests/browser/`); the host and producer guides (`docs/guides/`).
`js/README.md` is the module convention and `js/api/` documents each module's
interface.

Released on npm and PyPI since 2026-11-14: 0.11.2 was the one-time manual first
npm publish, and from 0.11.4 on CI publishes both by trusted publishing with no
token (`docs/release.md`). What the build delivered, measured against the plan,
is in `docs/deliveries/2026-11-13-embeddable-space-viewer.md`. Not done yet:
only Chromium has been tested automatically. Search
(type text, or several texts, and see what links to each) is specced and
planned (`docs/plans/2026-11-14-search-in-the-embedding-viewer.md`, 18 tasks)
but not built `(planned)`: `docs/specs/2026-11-14-search-in-the-embedding-viewer.md`,
its obligations in the file of the same name ending `-obligations.md`, and two
reference pages beside the original one in `docs/specs/reference/`.

What real vectors showed, and what was changed because of it (Lattice's hidden
directions, brightness of crowded sets), is in
`docs/evidence/2026-11-14-real-atlas-proof.md`. Intended differences from the
reference, and the owner's sign-off, are in `docs/reference-differences.md`.

| What | Where |
|------|-------|
| The spec (what to build, with honesty conditions and obligations) | `docs/specs/2026-11-13-embeddable-space-viewer.md` |
| The plan (18 tasks, 7 waves, acceptance criteria) | `docs/plans/2026-11-13-embeddable-space-viewer.md` |
| The visual and behavioural reference (a single working HTML page) | `docs/specs/reference/embedding-tumbler-demo.html` |
| How to run the build with a workforce, plus per-task guidance | `docs/workforce/README.md` |
| Illustrative code sketches (API, data file, mode interface) | `docs/workforce/examples/` |
| What real vectors look like, measured | `docs/evidence/2026-11-13-real-vector-probe.md` |
| The viewer on a real Atlas, two models, measured | `docs/evidence/2026-11-14-real-atlas-proof.md` |
| Host and producer guides, with working example pages | `docs/guides/` |
| How a release is made | `docs/release.md` |
| devague frame and plan state (source of the two exports) | `.devague/` |

Mark anything you describe that is ahead of the code as `(planned)`. Update
this section as tasks land.

## Rules the spec fixes

These are confirmed requirements. Do not trade them away for convenience; if
one turns out to be wrong, stop and use the `deviate` skill.

- **One core file.** Hosts get a single dependency-free JavaScript file with
  `mount(el)`, `update(data)` and `destroy(el)`. No build step is needed to
  *use* it. In this repo the file is *assembled* from small modules under
  `js/src/` by `scripts/assemble.py`, and the assembled file is committed.
- **Nothing from another origin.** No CDN, no web fonts, no inline script. The
  file must run under `script-src 'self'`. The reference demo loads Google
  Fonts; the built site must bundle or replace them.
- **Three delivery forms over the same file:** the script, a web component
  (`<embeddings-tumbler>`), and a standalone page. The two shells contain no
  rendering or projection logic.
- **Linear projections only.** No UMAP, no t-SNE. Every view states where the
  vectors came from, the model, dimension, item count and seed, and that a
  projection is a shadow of the space.
- **Reproducible views.** The tour takes a seed; same data, seed and elapsed
  time give the same frame.
- **Dimension comes from the data.** Nothing hard-codes 384 (the reference
  does). Real vectors seen so far are 768-d, 1024-d and 2560-d.
- **One model per view.** Mixed dimensions or model ids are refused.
- **Versioned contract.** Data carries a schema version; unknown or newer
  versions are refused with a plain message. Vectors travel as a binary
  float32 block, not JSON numbers.
- **Data stays put.** The viewer sends text, labels and vectors nowhere. The
  embedding gateway address and key never reach a page.
- **Untrusted text is text.** Labels and metadata are inserted as text, never
  as markup.

## Shipping

Two channels carry the same unmodified core file: the Python wheel (package
data, with CLI verbs that write the files into a host folder or serve a folder
locally) and an npm package under the `culture.dev` organisation. Both are
published from CI by trusted publishing. No registry token is stored in the
repository.

## Commands

```bash
uv sync                                  # create .venv and install dev deps
uv run pytest -n auto                    # full suite, parallel
uv run embeddings-tumbler whoami         # the console script
uv run embeddings-tumbler learn --json

uv run black embeddings_tumbler tests    # line length 100
uv run isort embeddings_tumbler tests
uv run flake8 embeddings_tumbler tests
uv run bandit -c pyproject.toml -r embeddings_tumbler
markdownlint-cli2 "**/*.md"
python3 scripts/scan-secrets.py          # committed secrets + non-localhost endpoints
uv run teken cli doctor . --strict       # the agent-first rubric gate CI runs

node --test                              # JavaScript unit tests, no dependencies
python3 scripts/assemble.py              # rebuild the single core file (--check fails when stale)
```

## The CLI contract

The CLI is cited from teken's `python-cli` reference. Three modules are
stable-contract and the rubric depends on their exact behaviour:
`embeddings_tumbler/cli/_errors.py` (`CliError` and exit codes: `0` success,
`1` user error, `2` environment error), `embeddings_tumbler/cli/_output.py`
(results to stdout, errors and diagnostics to stderr, never mixed) and
`embeddings_tumbler/cli/__init__.py` (parser, dispatch, no traceback ever
reaches stderr).

When adding a verb: every command and sub-verb takes `--json`; a noun with
action verbs must also expose `overview`; anything that writes previews by
default, writes only with `--apply`, and refuses to overwrite without
`--force`; add an `explain` catalog entry and keep `learn` in step.

## Conventions

- **Every PR bumps the version**, including docs-only ones. Use the
  `version-bump` skill; the `version-check` CI job blocks otherwise.
- **PRs** go through the `cicd` skill. Sign online posts as
  `- embeddings-tumbler (Claude)`; the cicd scripts resolve the nick from
  `culture.yaml`, so don't hand-sign bodies those scripts author.
- **The vendored `.claude/skills/` are cited verbatim.** Do not edit them;
  re-sync from the upstream in `docs/skill-sources.md`.
- **`recall` before, `remember` after** for non-trivial work.
- **The mesh identity** is in `culture.yaml` (`backend: claude`, so this file is
  the resident prompt). Changing `backend` without the matching prompt file
  breaks `doctor` and CI.
