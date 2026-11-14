#!/usr/bin/env python3
"""Check that shipped viewer files reference no external origin (stdlib only).

Usage::

    python3 scripts/check_no_external_origin.py [PATH ...] [--expect NAME ...] [--json]

Each PATH is a file or a folder (scanned recursively) inside the current folder; a PATH
that resolves outside it is refused. With no PATH it scans ``embeddings_tumbler/static/``
next to this script. Exit codes: ``0`` clean, ``1`` findings, ``2`` a path could not be read
or is outside the current folder. Hosts can run it over the folder ``embeddings-tumbler
viewer write`` produced, or over their own site, from a folder that contains it.

A port of embodiment's ``web/scripts/check-no-external-origin.mjs`` (its acceptance check that a
built page "references no external origin"), extended for files that are hand-written rather
than bundled. Rules, with where each comes from:

``html`` (``.html``, ``.htm``)
    H1 (ported): no ``href``/``src`` attribute whose value is an external origin. "External"
    is the original's test, ``^(https?:)?//``: a scheme URL or a protocol-relative URL.
    H2 (extended): any quoting (double, single, none) and more attributes that make the
    browser fetch or navigate: ``srcset``, ``action``, ``formaction``, ``poster``, ``data``,
    ``background``, ``ping``, ``manifest``, ``xlink:href``, ``cite``, ``longdesc``, and the
    ``url=`` of ``<meta http-equiv="refresh">``. Any scheme followed by ``//`` counts
    (``ws:``, ``wss:``, ``ftp:``), not only http and https.
    H3 (extended): inline ``<style>`` text and ``style`` attributes go through the CSS rules;
    inline ``<script>`` text goes through the JS rules.
``css`` (``.css``)
    C1 (ported): no ``url(...)`` with an external origin (this covers ``@font-face`` ``src``,
    so web fonts must come from the page's own origin).
    C2 (ported): no ``@import`` of an external origin, in ``url()`` or string form.
    C3 (extended): any ``scheme://`` literal anywhere in the CSS (comments included), with the
    W3C namespace allowance of J2.
``js`` (``.js``, ``.mjs``, ``.cjs``) and any other text file
    J1 (ported): no ``http://`` or ``https://`` literal **anywhere**, comments included, except
    the allow-list. Extended: any ``scheme://`` (``ws:``, ``wss:``, ``ftp:`` ...).
    J2 (ported, narrowed): the allow-list is the W3C namespace URIs (``http://www.w3.org/...``,
    identifiers ``createElementNS`` needs and never fetched), anchored on the host so
    ``https://attacker.example/www.w3.org/`` still fails. The original's second entry, React's
    error-decoder link, is dropped: nothing here ships React.
    J3 (extended): no protocol-relative string literal (``"//host..."``, ``'//host'`` or
    `` `//host` ``), which a bundled scan would miss and a browser resolves against the page.
``binary`` (anything that is not valid UTF-8, or a font/image/media suffix)
    B1 (extended): reported as "not scanned"; a new file type must be added to this script
    on purpose before it can ship. Today every shipped file is text.
Set rules
    S1 (ported in spirit: the original failed when its worklet asset was missing): with
    ``--expect NAME``, each named file must be among the files scanned; and a scan that finds
    no files at all fails.

What it does not do, by design (the original did not either): it does not parse JavaScript,
so a URL assembled at run time from pieces (``"ht" + "tp://"``) passes. The runtime check for
that is the browser harness's network log (``tests/browser/``).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent / "embeddings_tumbler" / "static"

EXTERNAL = re.compile(r"^\s*(?:[A-Za-z][A-Za-z0-9+.\-]*:)?//", re.ASCII)
SCHEME_LITERAL = re.compile(r"\b[A-Za-z][A-Za-z0-9+.\-]*://[^\s\"'`)<>]*", re.ASCII)
PROTOCOL_RELATIVE_LITERAL = re.compile(r"[\"'`]//[A-Za-z0-9\[]", re.ASCII)
ALLOWED = (re.compile(r"^https?://www\.w3\.org/", re.IGNORECASE),)

URL_ATTRIBUTES = {
    "href",
    "src",
    "srcset",
    "action",
    "formaction",
    "poster",
    "data",
    "background",
    "ping",
    "manifest",
    "xlink:href",
    "cite",
    "longdesc",
}
HTML_SUFFIXES = {".html", ".htm"}
CSS_SUFFIXES = {".css"}
JS_SUFFIXES = {".js", ".mjs", ".cjs"}
BINARY_SUFFIXES = {
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".avif",
    ".ico",
    ".mp3",
    ".mp4",
    ".webm",
    ".wasm",
    ".f32",
}


def _allowed(url: str) -> bool:
    return any(p.match(url) for p in ALLOWED)


def _line(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def check_js_text(text: str, label: str = "script.js") -> list[str]:
    """J1-J3 over JavaScript (or any text). Returns findings, empty when clean."""
    findings = []
    for m in SCHEME_LITERAL.finditer(text):
        if not _allowed(m.group(0)):
            findings.append(
                f"{label}:{_line(text, m.start())}: external origin literal {m.group(0)!r} [J1]"
            )
    for m in PROTOCOL_RELATIVE_LITERAL.finditer(text):
        snippet = text[m.start() : m.start() + 40].split("\n")[0]
        findings.append(
            f"{label}:{_line(text, m.start())}: protocol-relative literal {snippet!r} [J3]"
        )
    return findings


# Possessive quantifiers: the same matches as the plain greedy form (the value runs to the
# first quote or parenthesis either way), without its backtracking on a failed match.
_CSS_URL = re.compile(r"url\(\s*+(['\"]?)([^'\")]*+)\1\s*+\)", re.IGNORECASE)
_CSS_IMPORT = re.compile(r"@import\s+(?:url\(\s*)?['\"]?([^'\")\s;]+)", re.IGNORECASE)


def check_css_text(text: str, label: str = "styles.css") -> list[str]:
    """C1-C3 over CSS. Returns findings, empty when clean."""
    findings = []
    for m in _CSS_URL.finditer(text):
        if EXTERNAL.match(m.group(2)) and not _allowed(m.group(2)):
            findings.append(
                f"{label}:{_line(text, m.start())}: url({m.group(2)}) is an external origin [C1]"
            )
    for m in _CSS_IMPORT.finditer(text):
        if EXTERNAL.match(m.group(1)):
            findings.append(
                f"{label}:{_line(text, m.start())}: @import {m.group(1)} is an external origin [C2]"
            )
    for m in SCHEME_LITERAL.finditer(text):
        if not _allowed(m.group(0)):
            findings.append(
                f"{label}:{_line(text, m.start())}: external origin literal {m.group(0)!r} [C3]"
            )
    return findings


class _HtmlScan(HTMLParser):
    def __init__(self, label: str) -> None:
        super().__init__(convert_charrefs=True)
        self.label = label
        self.findings: list[str] = []
        self._raw: str | None = None
        self._buffer: list[str] = []

    def _where(self) -> str:
        return f"{self.label}:{self.getpos()[0]}"

    def _url_attribute(self, tag: str, name: str, value: str) -> None:
        candidates = [value]
        if name in ("srcset", "ping"):
            candidates = [c.strip().split(" ")[0] for c in re.split(r"[,\s]\s*", value)]
        rule = "H1" if name in ("href", "src") else "H2"
        for c in candidates:
            if c and EXTERNAL.match(c):
                self.findings.append(
                    f"{self._where()}: <{tag} {name}={value!r}> is an external origin [{rule}]"
                )

    def _meta_refresh(self, values: dict[str, str]) -> None:
        m = re.search(r"url\s*=\s*['\"]?([^'\";]+)", values.get("content", ""), re.I)
        if m and EXTERNAL.match(m.group(1)):
            self.findings.append(
                f"{self._where()}: meta refresh to {m.group(1)!r} is an external origin [H2]"
            )

    def _attrs(self, tag: str, attrs) -> None:
        values = {k.lower(): (v or "") for k, v in attrs}
        for name, value in values.items():
            if name in URL_ATTRIBUTES:
                self._url_attribute(tag, name, value)
            elif name == "style":
                self.findings += [
                    f + " (style attribute) [H3]" for f in check_css_text(value, self._where())
                ]
        if tag == "meta" and values.get("http-equiv", "").lower() == "refresh":
            self._meta_refresh(values)

    def handle_starttag(self, tag, attrs):
        self._attrs(tag, attrs)
        if tag in ("script", "style"):
            self._raw = tag
            self._buffer = []

    def handle_startendtag(self, tag, attrs):
        self._attrs(tag, attrs)

    def handle_data(self, data):
        if self._raw:
            self._buffer.append(data)

    def handle_endtag(self, tag):
        if self._raw and tag == self._raw:
            body = "".join(self._buffer)
            where = self._where()
            if tag == "script":
                self.findings += [f + " (inline script) [H3]" for f in check_js_text(body, where)]
            else:
                self.findings += [f + " (inline style) [H3]" for f in check_css_text(body, where)]
            self._raw = None


def check_html_text(text: str, label: str = "index.html") -> list[str]:
    """H1-H3 over HTML. Returns findings, empty when clean."""
    scan = _HtmlScan(label)
    scan.feed(text)
    scan.close()
    return scan.findings


def check_file(path: Path, label: str | None = None) -> list[str]:
    label = label or str(path)
    suffix = path.suffix.lower()
    data = path.read_bytes()
    if suffix in BINARY_SUFFIXES:
        return [f"{label}: binary file type {suffix!r} is not scanned; add a rule first [B1]"]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return [f"{label}: not UTF-8 text, so it is not scanned; add a rule first [B1]"]
    if suffix in HTML_SUFFIXES:
        return check_html_text(text, label)
    if suffix in CSS_SUFFIXES:
        return check_css_text(text, label)
    return check_js_text(text, label)


def collect(paths: list[Path], name=str) -> list[Path]:
    files: list[Path] = []
    for p in paths:
        if p.is_dir():
            files += sorted(
                f
                for f in p.rglob("*")
                if f.is_file() and "__pycache__" not in f.parts and f.suffix not in (".py", ".pyc")
            )
        elif p.is_file():
            files.append(p)
        else:
            raise FileNotFoundError(name(p))
    return files


def check_paths(
    paths: list[Path], expect: list[str] = (), name=str
) -> tuple[list[Path], list[str]]:
    """Scan every file under ``paths``. Returns ``(files scanned, findings)``.

    ``name`` gives the label a file's findings carry (default: the path as found).
    """
    files = collect(paths, name)
    findings: list[str] = []
    for f in files:
        try:
            findings += check_file(f, name(f))
        except OSError as exc:
            raise OSError(exc.errno, exc.strerror, name(f)) from exc
    if not files:
        findings.append("no files to scan [S1]")
    names = {f.name for f in files}
    for name in expect:
        if name not in names:
            findings.append(f"{name}: expected among the scanned files but missing [S1]")
    return files, findings


class OutsideFolder(OSError):
    """A path given on the command line resolves outside the current folder."""


def inside_current_folder(value: str) -> str:
    """The real path of ``value`` (symlinks followed), checked to be inside the current folder.

    SonarSource's documented path-traversal check: both paths through ``os.path.realpath``,
    then a plain ``startswith(base + os.sep)``; the current folder itself is accepted too, so
    ``.`` scans it. OutsideFolder when the path is not inside.
    """
    base = os.path.realpath(os.getcwd())
    full = os.path.realpath(os.path.join(base, value))
    if full == base or full.startswith(base + os.sep):
        return full
    raise OutsideFolder(
        f"{value}: outside the current folder {base}; run from a folder that contains it"
    )


def as_given(file: Path, relative_roots: list[str]) -> str:
    """``file`` relative to the current folder when it lies under a root given as relative.

    So findings and the file list name files as they were given on the command line.
    """
    text = str(file)
    for root in relative_roots:
        if text == root or text.startswith(root + os.sep):
            return os.path.relpath(text, os.path.realpath(os.getcwd()))
    return text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="check_no_external_origin.py",
        description="Fail if shipped viewer files reference an external origin.",
    )
    parser.add_argument("paths", nargs="*", help="files or folders to scan")
    parser.add_argument("--expect", action="append", default=[], help="a file that must exist")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    args = parser.parse_args(argv)
    try:
        roots = [inside_current_folder(p) for p in args.paths]
    except OutsideFolder as exc:
        print(f"error: refused {exc}", file=sys.stderr)
        return 2
    relative_roots = [r for p, r in zip(args.paths, roots) if not os.path.isabs(p)]

    def name(file: Path) -> str:
        return as_given(file, relative_roots)

    try:
        files, findings = check_paths([Path(r) for r in roots] or [DEFAULT_ROOT], args.expect, name)
    except OSError as exc:
        print(f"error: cannot read {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"files": [name(f) for f in files], "findings": findings}, indent=2))
    elif findings:
        print("FAIL - external origin(s) referenced:", file=sys.stderr)
        for f in findings:
            print(f"  {f}", file=sys.stderr)
    else:
        print(f"ok   - {len(files)} file(s) reference no external origin")
        for f in files:
            print(f"       {name(f)}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
