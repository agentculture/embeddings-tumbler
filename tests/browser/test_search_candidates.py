"""Headless-browser check of more candidates and the reranker's top (the owner's request:
"50 candidates, top 20"; docs/search-interface.md, "Candidates and top").

The folder under test is the shipped standalone page (``viewer write``) with no embed route,
so it shows the built-in sample set (290 named points). The page under test supplies a fake
reranker through the public handle (``setSearchCallbacks``): it reverses the embedding order
and records how many candidates it was given. Through the panel's own controls: the Reranker
checkbox, then Candidates 100 and Keep top 30. Asserted through ``info().search``: the
settings, the reranker received exactly 100 candidates, 30 results kept, each the reverse of
the embedding order, the radius the farthest kept; the collapsed bar stays one line. No
request leaves the origin, no console error, no CSP violation.

Uses the shared harness; skips without Playwright, Chromium or WebGL 2, and fails instead
under ``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from embeddings_tumbler.cli import main
from tests.browser import harness

WAIT = 120

READY = """() => {
  const h = window.EmbeddingsTumbler && EmbeddingsTumbler.get(document.getElementById('space'));
  return !!h && h.info().ready && h.info().frames > 5
    && !!document.querySelector('.tumbler-search');
}"""

SEARCH = "() => EmbeddingsTumbler.get(document.getElementById('space')).info().search"

# The page's own fake reranker: reverses the order, records each call's candidate count.
FAKE_RERANKER = """() => {
  window.__rerankSeen = [];
  const h = EmbeddingsTumbler.get(document.getElementById('space'));
  return h.setSearchCallbacks({ rerank: (query, candidates) => {
    window.__rerankSeen.push(candidates.length);
    return { scores: candidates.map((_c, i) => i), model: 'test/reverse' };
  } });
}"""

SET_RANGE = """([cls, value]) => {
  const input = document.querySelector('.' + cls + ' input');
  input.value = String(value);
  input.dispatchEvent(new Event('input'));
}"""


@pytest.fixture(scope="module")
def base_url(tmp_path_factory):
    folder: Path = tmp_path_factory.mktemp("candidates")
    assert main(["viewer", "write", str(folder), "--apply"]) == 0
    with harness.Server(folder) as server:
        yield server.origin


@pytest.fixture(scope="module")
def run(browser, base_url):
    tab = harness.Tab(browser, viewport=(1280, 900))
    try:
        tab.goto(base_url + "/index.html?sample=synthetic")
        tab.wait_for(READY, timeout=WAIT, what="the viewer and its panel")
        out = {"callbacks": tab.evaluate(FAKE_RERANKER)}
        out["controls"] = tab.wait_for(
            "() => !!document.querySelector('.tumbler-search-candidates')"
            " && !!document.querySelector('.tumbler-search-top')",
            timeout=WAIT,
            what="the Candidates and Keep top controls",
        )
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        tab.evaluate("""() => { const b = document.querySelector('.tumbler-search-input');
               b.value = 'tide harbor'; b.dispatchEvent(new Event('input')); }""")
        tab.wait_for(
            SEARCH, lambda s: s["active"] and not s["waiting"], timeout=WAIT, what="search"
        )
        tab.evaluate("""() => { const c = document.querySelector('.tumbler-search-rerank input');
               c.checked = true; c.dispatchEvent(new Event('change')); }""")
        tab.wait_for(
            SEARCH,
            lambda s: s["settings"]["rerank"] and not s["waiting"],
            timeout=WAIT,
            what="the reranker on",
        )
        tab.evaluate(SET_RANGE, ["tumbler-search-candidates", 100])
        tab.wait_for(
            SEARCH,
            lambda s: s["settings"]["candidates"] == 100 and not s["waiting"],
            timeout=WAIT,
            what="100 candidates",
        )
        tab.evaluate(SET_RANGE, ["tumbler-search-top", 30])
        out["search"] = tab.wait_for(
            SEARCH,
            lambda s: s["settings"]["top"] == 30
            and not s["waiting"]
            and len(s["searches"][0]["results"]) == 30,
            timeout=WAIT,
            what="top 30 kept",
        )
        out["seen"] = tab.evaluate("() => window.__rerankSeen")
        out["k_disabled"] = tab.evaluate(
            "() => document.querySelector('.tumbler-search-k input').disabled"
        )
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        out["bar"] = tab.evaluate(
            "() => document.querySelector('.tumbler-search').getBoundingClientRect().height"
        )
        tab.assert_no_foreign_requests(base_url)
        tab.assert_no_console_errors()
        tab.assert_no_csp_violations()
    finally:
        tab.close()
    return out


def test_candidates_and_top_set_through_the_panel(run):
    assert run["callbacks"]["reranker"] is True
    assert run["controls"]
    settings = run["search"]["settings"]
    assert (settings["candidates"], settings["top"], settings["rerank"]) == (100, 30, True)
    assert run["k_disabled"] is True


def test_the_reranker_got_exactly_100_candidates_and_30_were_kept(run):
    q = run["search"]["searches"][0]
    assert run["seen"][-1] == 100
    assert max(run["seen"]) <= 100
    assert q["reranker"] == "test/reverse"
    assert (q["candidates"], q["top"], q["sent"]) == (100, 30, 100)
    assert [r["embeddingRank"] for r in q["results"]] == list(range(100, 70, -1))
    assert q["radius"] == max(r["distance"] for r in q["results"])


def test_the_collapsed_bar_stays_one_line(run):
    assert run["bar"] <= 48
