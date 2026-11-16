# Workforce rules: relative search

Rules for every task agent building
`docs/plans/2026-11-16-relative-search-in-the-embedding-viewer.md`. The owner
approved the split on 2026-11-16
(`docs/plans/2026-11-16-relative-search-in-the-embedding-viewer-split.md`).

## Read first

1. The spec: `docs/specs/2026-11-16-relative-search-in-the-embedding-viewer.md`.
2. Its obligations: the file of the same name ending `-obligations.md`.
3. The reference page, which is part of the spec:
   `docs/specs/reference/tumbler-relative-search.html`.
4. `docs/relative-interface.md` once task t1 has merged. It is binding for names,
   settings and on-screen wording. If it is wrong, report it; do not work around it.
5. `CLAUDE.md` and `js/README.md` (module convention and the words the assembled
   file must not contain).

## How to work

- Work only inside the worktree you were given, on its branch. Do not touch the
  main checkout, other worktrees, or files outside your task's scope. If your task
  needs a change in a file another task owns, stop and report it.
- Test first: write the failing tests that match your acceptance criteria, then
  the code.
- Do not run `scripts/assemble.py` to rewrite the assembled file, do not bump the
  version and do not edit `CHANGELOG.md`. The main agent does those at merge. Tests
  that need the assembled file may rebuild it locally, but do not commit it.
- Run every node, pytest and browser command through the cap:
  `scripts/capped.sh <seconds> <command>` (3 GB, no swap, a time limit). A command
  that was killed, timed out or hung is **not run again** until you know why. Never
  assert equality on large objects or fake DOM nodes in a way that prints them.
- Never print, log or write a gateway key or address. Tasks that need the gateway
  are not delegated.
- Run no `devague` command. If you notice your own reasoning slipped (a check you
  skipped, an assumption standing in for a measurement), say so in your final
  report; the main agent records it.
- With relative off nothing may change: `js/test/relative-off-golden.test.js`
  (from task t4, once merged) must stay green.
- Keep the repository's rules: one core file, nothing from another origin, linear
  projections only, reproducible views, untrusted text inserted as text.
- Format and lint what you touch (`black`, `isort`, `flake8` for Python;
  `markdownlint-cli2` for Markdown outside `docs/specs` and `docs/plans`).
- Commit your work to your branch with a clear message. Do not push.

## Final report

State, in this order: what you built and where; each acceptance criterion with the
test that proves it and whether it passes; the exact commands you ran and their
last lines; anything you could not do or verify; anything in another task's files
that needs changing; any lapse in your own reasoning.
