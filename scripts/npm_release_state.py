#!/usr/bin/env python3
"""Say whether a version of an npm package is already published, failing closed.

    python3 scripts/npm_release_state.py @culture.dev/embeddings-tumbler 0.10.1

Runs ``npm view <package> versions --json`` (the package's whole version list)
and prints exactly one word on stdout:

- ``absent``  : the package does not exist (npm exit 1 with error code E404), or it
  exists and this version is not in its list. The caller publishes.
- ``present`` : this version is in the list. The caller compares the registry copy
  with the commit and does not publish.

Anything else (a network error, another registry error, output that is not the
JSON npm writes) prints nothing on stdout, explains on stderr and exits 1, so the
publish job stops and publishes nothing. Stdlib only.
"""

from __future__ import annotations

import json
import subprocess
import sys


class StateError(Exception):
    """npm's answer does not say clearly whether the version is published."""


def classify(returncode: int, stdout: str, version: str) -> str:
    """Map npm's exit code and JSON stdout to "absent" or "present"; raise otherwise."""
    try:
        data = json.loads(stdout)
    except ValueError as exc:
        raise StateError(f"npm exited {returncode} with output that is not JSON") from exc
    if returncode != 0:
        error = data.get("error") if isinstance(data, dict) else None
        code = error.get("code") if isinstance(error, dict) else None
        if returncode == 1 and code == "E404":
            return "absent"
        summary = error.get("summary") if isinstance(error, dict) else None
        raise StateError(f"npm exited {returncode} with error {code}: {summary}")
    if isinstance(data, str):
        versions = [data]
    elif isinstance(data, list) and all(isinstance(v, str) for v in data):
        versions = data
    else:
        raise StateError(f"npm exited 0 with an unexpected answer: {stdout.strip()[:200]}")
    return "present" if version in versions else "absent"


def _npm(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=120)


def main(argv: list[str] | None = None, run=_npm) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        raise SystemExit("usage: npm_release_state.py <package> <version>")
    package, version = args
    cmd = ["npm", "view", package, "versions", "--json"]
    try:
        result = run(cmd)
        found = classify(result.returncode, result.stdout, version)
    except (StateError, OSError, subprocess.SubprocessError) as exc:
        print(
            f"npm_release_state: cannot tell whether {package}@{version} is published: {exc}; "
            "failing so the job will publish nothing",
            file=sys.stderr,
        )
        return 1
    print(found)
    return 0


if __name__ == "__main__":
    sys.exit(main())
