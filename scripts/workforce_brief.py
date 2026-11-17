#!/usr/bin/env python3
"""Print a task agent's brief, quoted verbatim from ``devague plan waves --json``.

Usage: python3 scripts/workforce_brief.py <task-id> <worktree-path>
"""

from __future__ import annotations

import json
import subprocess  # nosec B404 - runs the fixed devague command below
import sys


def main() -> int:
    task_id, worktree = sys.argv[1], sys.argv[2]
    raw = subprocess.run(  # nosec B603 B607 - fixed arguments, no shell
        ["devague", "plan", "waves", "--json"], check=True, capture_output=True, text=True
    ).stdout
    plan = json.loads(raw)
    task = plan["tasks"][task_id]
    lines = [
        f"# Brief for task {task_id} (plan {plan['plan']})",
        "",
        f"Your worktree: `{worktree}` on branch `agent/{task_id}`. Work only there.",
        "Read `docs/workforce/relative-search.md` in the worktree first and follow it.",
        "The text below is quoted verbatim from the confirmed plan.",
        "",
        "## Summary",
        "",
        task["summary"],
        "",
        "## Instruction",
        "",
        task["instruction"] or "(this task has no instruction)",
        "",
        "## Acceptance criteria",
        "",
        *[f"{n}. {c}" for n, c in enumerate(task["acceptance_criteria"], 1)],
        "",
        "## Spec targets this task covers",
        "",
        ", ".join(task["covers"]) or "(none)",
        "",
    ]
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
