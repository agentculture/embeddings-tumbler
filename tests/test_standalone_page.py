"""Static checks over the shipped standalone page (task t11).

The page (``index.html``, ``page.css``, ``page.js`` in ``embeddings_tumbler/static/``)
must run under ``Content-Security-Policy: default-src 'self'`` and load nothing
from another origin: no URL with a scheme, no inline script body, no inline
event handler, no ``style`` attribute, no ``<style>`` element, and every
``src``/``href`` a plain same-folder name that ships beside the page.
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "embeddings_tumbler" / "static"
PAGE_FILES = ("index.html", "page.css", "page.js")
PLAIN_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class _Collect(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[tuple[str, dict[str, str | None]]] = []
        self.script_bodies: list[str] = []
        self._in_script = False

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))
        self._in_script = tag == "script"

    def handle_startendtag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_script = False

    def handle_data(self, data):
        if self._in_script and data.strip():
            self.script_bodies.append(data)


@pytest.fixture(scope="module")
def page() -> _Collect:
    parser = _Collect()
    parser.feed((STATIC / "index.html").read_text(encoding="utf-8"))
    return parser


@pytest.mark.parametrize("name", PAGE_FILES)
def test_page_file_ships_and_names_no_other_origin(name):
    text = (STATIC / name).read_text(encoding="utf-8")
    assert "http://" not in text and "https://" not in text
    assert "@import" not in text
    assert "url(" not in text


def test_no_inline_script_handler_style_attribute_or_style_element(page):
    assert page.script_bodies == []
    for tag, attrs in page.tags:
        assert tag != "style", "a <style> element would need 'unsafe-inline'"
        for attr in attrs:
            assert not attr.startswith("on"), f"inline handler {attr} on <{tag}>"
            assert attr != "style", f"style attribute on <{tag}>"
        if tag == "script":
            assert attrs.get("src"), "every script is loaded by src"


def test_every_reference_is_a_shipped_same_folder_name(page):
    refs = [attrs[k] for _, attrs in page.tags for k in ("src", "href") if k in attrs]
    assert refs, "the page references its stylesheet and scripts"
    for ref in refs:
        assert ref and PLAIN_NAME.match(ref), f"{ref!r} is not a plain same-folder name"
        assert (STATIC / ref).is_file(), f"{ref} is not shipped in embeddings_tumbler/static/"


def test_page_loads_core_then_sample_then_page_script(page):
    scripts = [attrs["src"] for tag, attrs in page.tags if tag == "script"]
    assert scripts == ["embeddings-tumbler.js", "sample-data.js", "page.js"]
    sheets = [a["href"] for t, a in page.tags if t == "link" and a.get("rel") == "stylesheet"]
    assert sheets == ["page.css"]


def test_page_declares_a_strict_policy_and_a_viewport(page):
    metas = {
        (a.get("http-equiv") or a.get("name") or "").lower(): a.get("content") or ""
        for t, a in page.tags
        if t == "meta"
    }
    csp = metas.get("content-security-policy", "")
    directives = dict(
        (part.split()[0], part.split()[1:]) for part in csp.split(";") if part.strip()
    )
    assert directives.get("default-src") in (["'self'"], ["'none'"])
    for name in ("script-src", "style-src", "connect-src"):
        assert directives.get(name, directives["default-src"]) in (["'self'"], ["'none'"])
    assert "'unsafe-inline'" not in csp and "'unsafe-eval'" not in csp
    assert "width=device-width" in metas.get("viewport", "")


def test_page_script_calls_only_the_public_api():
    text = (STATIC / "page.js").read_text(encoding="utf-8")
    assert "_internal" not in text
    assert "innerHTML" not in text and "insertAdjacentHTML" not in text
    assert "document.write" not in text
    assert not re.search(r"\beval\b|new Function", text)
    assert not re.search(r"\.style\b", text), "the page script sets no inline styles"
    used = set(re.findall(r"\bapi\.([A-Za-z_]+)", text))
    assert used <= {"mount", "sample"}, used


def test_page_sources_and_shipped_copies_match():
    for name in PAGE_FILES:
        source = ROOT / "js" / "page" / name
        assert (STATIC / name).read_bytes() == source.read_bytes(), "run scripts/sync_static.py"


def test_page_text_hard_codes_no_dimension():
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    assert "384" not in html, "the dimension comes from the data, filled in by page.js"
