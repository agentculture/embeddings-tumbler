#!/usr/bin/env python3
"""Scan tracked files for committed secrets and non-localhost endpoints.

Two independent checks, tuned narrowly so prose docs full of GitHub/spec
links don't trip it:

1. Credential / API-key-shaped strings — known token formats (AWS access
   keys, GitHub tokens, Slack tokens, OpenAI-style keys, PEM private key
   blocks) plus a generic ``<secret-ish-name> = <high-entropy value>``
   assignment, anywhere in any tracked text file. References like
   ``$VAR``, ``${VAR}``, ``${{ secrets.VAR }}`` or ``${{ github.token }}``
   are env/CI placeholders, not secrets, and are excluded.

2. Non-localhost endpoints in structured config — only files that parse as
   JSON are examined (this deliberately excludes ``*.md`` prose, which is
   full of legitimate ``https://`` links), and only under keys shaped like
   ``baseUrl`` / ``endpoint`` / ``url`` / ``host`` whose value is an
   ``http(s)://`` URL. ``localhost`` / ``127.0.0.1`` / ``::1`` / ``0.0.0.0``
   are allowed; anything else fails.

3. Registry tokens and registry-token plumbing — both packages publish by
   trusted publishing (OIDC), so no tracked file may name a variable or CI
   secret that would carry a registry token (the setup-node auth variable,
   ``NPM_TOKEN``, ``PYPI_TOKEN``, the twine password, uv's publish
   token/password, ``secrets.NPM*`` / ``secrets.PYPI*`` / ``secrets.TWINE*``),
   no ``_authToken=`` may carry a literal value, and a tracked ``.npmrc`` may
   carry no auth line at all, not even a ``${VAR}`` reference. The npm and
   PyPI token shapes themselves are part of check 1.

Usage:
    scan-secrets.py                # scan all tracked files (git ls-files)
    scan-secrets.py path [path...] # scan specific files

Exit 0 if clean, 1 if any finding.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parent.parent

# Files this scanner should never inspect: its own source (full of example
# patterns/regexes in comments), its own test fixtures (deliberately planted
# fake secrets used to prove the scanner works), and lockfiles (vendored
# hashes, not secrets).
SELF_EXCLUDE = {"scripts/scan-secrets.py", "tests/test_scan_secrets.py"}
EXCLUDE_SUFFIXES = (".lock",)

# ---------------------------------------------------------------------------
# Check 1: credential / API-key-shaped strings
# ---------------------------------------------------------------------------

_KNOWN_TOKEN_PATTERNS = [
    (r"AKIA[0-9A-Z]{16}", "AWS access key id"),
    (r"gh[pousr]_[A-Za-z0-9]{36,}", "GitHub token"),
    (r"xox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"sk-[A-Za-z0-9]{20,}", "OpenAI-style secret key"),
    (r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----", "private key block"),
    (r"\bnpm_[A-Za-z0-9]{36}\b", "npm access token"),
    (r"pypi-AgE[A-Za-z0-9_-]{50,}", "PyPI API token"),
]

# key = value / key: "value" assignments where the key name is secret-ish.
#
# The value alternatives capture the WHOLE literal rather than a narrow
# base64-ish alphabet: real passwords and tokens routinely contain `@`, `:`,
# `%`, `=` or `?`, and a value-alphabet restriction let any of those slip
# through unmatched. A quoted value runs to its closing quote; an unquoted one
# runs to the first whitespace or structural delimiter. The optional quote
# after the key name is what lets a JSON key (`"apiKey": "..."`) match at
# all — without it the closing quote broke the key/value adjacency.
#
# The match is made in steps, each a small pattern, rather than by one large
# expression: a secret-ish key name, then the separator, then one of the three
# value forms. ``_assignments`` puts the steps together.

#: Secret-ish key names. No two of these can match at the same place in a
#: line, and none can start inside another, so the order does not matter.
_ASSIGNMENT_KEY_PATTERNS = (
    re.compile(r"(?i)\b(?:api|access)[_-]?key"),
    re.compile(r"(?i)\bsecret(?:[_-]?key)?"),
    re.compile(r"(?i)\b(?:token|password|passwd|pwd)"),
)

#: A JSON/YAML key's own closing quote, if any, then ``:`` or ``=``.
_ASSIGNMENT_SEPARATOR_RE = re.compile(r"""["']?\s*[:=]\s*""")

#: The value forms, tried in this order; group 1 is the literal itself.
_ASSIGNMENT_VALUE_PATTERNS = (
    re.compile(r'"([^"\n]{20,})"'),
    re.compile(r"'([^'\n]{20,})'"),
    re.compile(r"""([^\s"'`,;)\]}]{20,})"""),
)


def _assigned_value(line: str, pos: int) -> re.Match[str] | None:
    """The separator and literal value starting at ``pos``, or ``None``."""
    separator = _ASSIGNMENT_SEPARATOR_RE.match(line, pos)
    if separator is None:
        return None
    for pattern in _ASSIGNMENT_VALUE_PATTERNS:
        value = pattern.match(line, separator.end())
        if value is not None:
            return value
    return None


def _assignments(line: str) -> Iterator[tuple[str, str]]:
    """Yield ``(key, value)`` for each secret-ish assignment in ``line``.

    Left to right and never overlapping: a key name that lies inside a value
    already yielded is not looked at again.
    """
    keys = sorted(
        (match for pattern in _ASSIGNMENT_KEY_PATTERNS for match in pattern.finditer(line)),
        key=lambda match: match.start(),
    )
    consumed = 0
    for key in keys:
        if key.start() < consumed:
            continue
        value = _assigned_value(line, key.end())
        if value is None:
            continue
        consumed = value.end()
        yield key.group(0), value.group(1)


# Values that look like references/placeholders rather than real secrets.
_PLACEHOLDER_RE = re.compile(
    r"""^(?:
        \$\{?\{?          # $VAR, ${VAR}, ${{ ... }}
        |secrets\.        # secrets.FOO (bare, inside an already-stripped expr)
        |github\.         # github.token
        |<.*>?$           # <your-key-here>
        |\.\.\.$          # literal ellipsis placeholder
    )""",
    re.VERBOSE | re.IGNORECASE,
)

#: Whole tokens (delimited by ``-``/``_``/``.``) that mark a value as a
#: written-out placeholder rather than a credential. Matched as tokens, never
#: as free substrings: a real high-entropy secret that merely *contains* the
#: letters ``fake`` or ``example`` must still be reported.
_PLACEHOLDER_WORDS = frozenset(
    {
        "changeme",
        "your",
        "example",
        "redacted",
        "dummy",
        "fake",
        "placeholder",
        "sample",
        "todo",
        "here",
        "none",
    }
)

#: Masked-out values (``xxxxxxxx…``, ``00000000…``) are placeholders too.
_MASK_RE = re.compile(r"(?i)(x{8,}|0{8,})")

#: A value that is nothing but lowercase alphanumeric words joined by
#: ``-``/``_``/``.``. Placeholder exemption additionally requires this shape,
#: so mixed-case / punctuation-bearing high-entropy literals stay reportable
#: even when one of their tokens is an ordinary English word.
_WORDY_RE = re.compile(r"^[a-z0-9]+(?:[-_.][a-z0-9]+)*$")


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    kind: str
    detail: str

    def __str__(self) -> str:  # pragma: no cover - trivial formatting
        return f"{self.path}:{self.line}: [{self.kind}] {self.detail}"


def _is_placeholder(value: str) -> bool:
    """Is this value a reference/placeholder rather than a literal secret?

    Two ways to qualify, both whole-value judgements:

    1. it matches an env/CI reference form (``$VAR``, ``${{ secrets.X }}``,
       ``<your-key-here>``, ``...``); or
    2. it is plain lowercase word-shaped text (``_WORDY_RE``) *and* one of its
       ``-``/``_``/``.``-delimited tokens is a placeholder word, or it is
       masked out with a run of ``x``/``0``.

    Requirement 2's word-shape clause is what stops a real credential from
    being exempted merely because it contains an English substring: a value
    such as ``fake-Xk9Lm2Pq7Rt4Vw8Zb3Nc6`` carries the token ``fake`` but is
    not word-shaped, so it is still reported.
    """
    if _PLACEHOLDER_RE.match(value):
        return True
    if not _WORDY_RE.match(value):
        return False
    tokens = set(re.split(r"[-_.]+", value))
    return bool(tokens & _PLACEHOLDER_WORDS) or bool(_MASK_RE.search(value))


def _scan_credentials(path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        for pattern, label in _KNOWN_TOKEN_PATTERNS:
            if re.search(pattern, line):
                findings.append(Finding(path, lineno, "credential", label))
        for key, value in _assignments(line):
            if _is_placeholder(value):
                continue
            findings.append(
                Finding(path, lineno, "credential", f"{key}-shaped assignment with a literal value")
            )
    return findings


# ---------------------------------------------------------------------------
# Check 2: non-localhost endpoints in structured (JSON) config
# ---------------------------------------------------------------------------

_ENDPOINT_KEY_RE = re.compile(r"(?i)^(base[_-]?url|endpoint|url|host)$")
_ALLOWED_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def _endpoint_host(value: str) -> str | None:
    """Return the normalized host of an ``http(s)://`` URL, else ``None``.

    Parsed with ``urlsplit`` rather than a regex: a regex host group that
    stops at the first colon cannot read a bracketed IPv6 authority such as
    ``http://[2001:db8::1]:8080``, which then silently took the no-match
    branch and passed the scan. ``urlsplit(...).hostname`` strips the
    brackets and lowercases the host, so it compares directly against the
    allowlist.
    """
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    return parts.hostname or None


def _walk_json(obj, path: str, lineage: str = "") -> list[tuple[str, str]]:
    """Yield (key, value) pairs for every string leaf, key-qualified."""
    out: list[tuple[str, str]] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.extend(_walk_json(v, path, k))
    elif isinstance(obj, list):
        for item in obj:
            out.extend(_walk_json(item, path, lineage))
    elif isinstance(obj, str):
        out.append((lineage, obj))
    return out


def _scan_endpoints(path: str, text: str) -> list[Finding]:
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []

    findings: list[Finding] = []
    for key, value in _walk_json(data, path):
        if not _ENDPOINT_KEY_RE.match(key):
            continue
        host = _endpoint_host(value)
        if host is None or host in _ALLOWED_HOSTS:
            continue
        findings.append(Finding(path, 1, "endpoint", f"{key}={value!r} is not localhost"))
    return findings


# ---------------------------------------------------------------------------
# Check 3: registry tokens and registry-token plumbing
# ---------------------------------------------------------------------------

_REGISTRY_PLUMBING = [
    (r"\bNODE_AUTH_TOKEN\b", "setup-node registry auth variable"),
    (r"\bNPM_TOKEN\b", "npm token variable"),
    (r"\bPYPI_(?:API_)?TOKEN\b", "PyPI token variable"),
    (r"\bTWINE_PASSWORD\b", "twine password variable"),
    (r"\bUV_PUBLISH_(?:TOKEN|PASSWORD)\b", "uv publish credential variable"),
    (r"(?i)\bsecrets\.(?:npm|pypi|twine)\w*", "registry credential in CI secrets"),
    # A literal value after _authToken= (a ${VAR} reference is not a token).
    (r"_authToken\s*=\s*(?!\$\{)\S", "literal npm auth token"),
]

_NPMRC_AUTH_RE = re.compile(r"(?i)(?:_authToken|_auth|_password)\s*=")


def _scan_registry_tokens(path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    is_npmrc = Path(path).name == ".npmrc"
    for lineno, line in enumerate(text.splitlines(), start=1):
        for pattern, label in _REGISTRY_PLUMBING:
            if re.search(pattern, line):
                findings.append(Finding(path, lineno, "registry-token", label))
        if is_npmrc and _NPMRC_AUTH_RE.search(line):
            findings.append(Finding(path, lineno, "registry-token", "auth line in a .npmrc"))
    return findings


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def _tracked_files() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def scan_paths(paths: list[str]) -> list[Finding]:
    findings: list[Finding] = []
    for rel_path in paths:
        if rel_path in SELF_EXCLUDE or rel_path.endswith(EXCLUDE_SUFFIXES):
            continue
        full_path = REPO_ROOT / rel_path
        if not full_path.is_file():
            continue
        try:
            text = full_path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        findings.extend(_scan_credentials(rel_path, text))
        findings.extend(_scan_endpoints(rel_path, text))
        findings.extend(_scan_registry_tokens(rel_path, text))
    return findings


def main(argv: list[str]) -> int:
    paths = argv[1:] if len(argv) > 1 else _tracked_files()
    findings = scan_paths(paths)
    if findings:
        print(f"scan-secrets: {len(findings)} finding(s):", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        return 1
    print(f"scan-secrets: clean ({len(paths)} file(s) checked)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
