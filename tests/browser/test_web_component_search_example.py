"""Headless-browser check of the web-component search example (examples/web-component-search).

The folder is copied, ``viewer write --apply`` adds the viewer files, and the copy is served on
loopback under ``Content-Security-Policy: default-src 'self'``. The page assigns ``el.embed`` once
and nothing else; the test runs a search through the handle and asserts, through
``handle.info().search``, that the search happened, that the embedder was used, and that every
request the page made went to its own origin. It also shows the page has no ``embed`` attribute
to read (an ``embed="..."`` attribute does nothing).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.browser import harness

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "docs" / "guides" / "examples" / "web-component-search"
POLICY = "default-src 'self'"
INFO = "() => document.getElementById('space').handle.info().search"
LOADED = "Showing 320 points."


@pytest.fixture
def site(tmp_path):
    for name in ("embeddings-tumbler.js", "web-component.js"):
        if not (ROOT / "embeddings_tumbler" / "static" / name).is_file():
            pytest.skip(f"shipped file not present: {name}")
    folder = tmp_path / "example"
    shutil.copytree(EXAMPLE, folder)
    done = subprocess.run(
        [sys.executable, "-m", "embeddings_tumbler", "viewer", "write", str(folder), "--apply",
         "--force"],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    assert done.returncode == 0, done.stderr
    with harness.Server(folder, csp=POLICY) as server:
        yield server.origin


def _open(browser, base):
    tab = harness.Tab(browser, viewport=(1100, 900))
    tab.page.goto(base + "/example.html")
    if tab.page.evaluate("() => !document.createElement('canvas').getContext('webgl2')"):
        tab.close()
        harness.unavailable("WebGL 2 unavailable in headless Chromium")
    harness.wait_for_text(tab.page, "#note", LOADED, timeout=30)
    return tab


def test_one_property_assignment_adds_search_on_the_pages_own_origin(site, browser):
    tab = _open(browser, site)
    try:
        page = tab.page
        before = page.evaluate(INFO)
        assert before["active"] is False
        assert before["embedder"]["available"] is True
        page.fill("#query", "p0007")
        page.click("button[type=submit]")
        search = harness.wait_for(
            page, INFO, lambda s: s["active"] and not s["waiting"], timeout=30, what="a search"
        )
        entry = search["searches"][0]
        assert entry["kind"] == "embedded"
        assert entry["sentTo"] == "embedder"
        assert entry["text"] == "p0007"
        assert entry["results"], "the search found nothing"
        assert entry["results"][0]["id"] == "p0007", "the point's own vector is nearest to itself"
        assert tab.console_errors() == []
        assert tab.csp == []
        assert tab.foreign_requests(site) == []
    finally:
        tab.close()


def test_a_text_the_example_cannot_answer_is_refused_plainly(site, browser):
    tab = _open(browser, site)
    try:
        page = tab.page
        page.fill("#query", "no such point")
        page.click("button[type=submit]")
        text = harness.wait_for_text(page, "#note", "embed-failed", timeout=30)
        assert "No search" in text
        assert page.evaluate(INFO)["active"] is False
        assert tab.foreign_requests(site) == []
    finally:
        tab.close()


def test_an_embed_attribute_is_not_read(site, browser):
    tab = _open(browser, site)
    try:
        page = tab.page
        result = page.evaluate("""async () => {
            const el = document.createElement('embeddings-tumbler');
            el.setAttribute('embed', 'window.__ran = true');
            document.getElementById('space').after(el);
            const own = { property: el.embed, ran: window.__ran === undefined };
            el.remove();
            return own;
        }""")
        assert result == {"property": None, "ran": True}
    finally:
        tab.close()
