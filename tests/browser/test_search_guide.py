"""Headless-browser check of what the search guide (docs/guides/search.md) tells a person.

The guide walks a reader through the standalone page as ``embeddings-tumbler viewer write`` and
a plain ``viewer serve`` give it: the default data, the closed panel, a first search, a second
one, each control, Focus, and Clear. This test takes the same steps in the same order, once,
and each test below asserts one thing the guide states. The numbers and titles the guide
quotes for its first searches are read here from ``info().search``, never from pixels.

Uses the shared harness (``tests/browser/harness.py``); SwiftShader unless
``TUMBLER_BROWSER_RENDERER=gpu``; skips without Playwright, Chromium or WebGL 2, and fails
instead under ``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from embeddings_tumbler.cli import main
from tests.browser import harness

ROOT = Path(__file__).resolve().parents[2]
DEMO = json.loads(
    (ROOT / "embeddings_tumbler" / "static" / "demo-wikipedia.json").read_text(encoding="utf-8")
)
TITLES = {p["id"]: p["label"] for p in DEMO["points"]}
WAIT = 120

# The results the guide quotes for its first two searches (article titles, nearest first).
RIVER = ["River", "Flood", "Lake", "Nile", "Amazon River", "Drink", "Yangtze", "Drinking water"]
RIVER_DISTANCES = ["0.000", "0.435", "0.454", "0.499", "0.553", "0.555", "0.563", "0.564"]
MUSIC = [
    "Music",
    "History of music",
    "Musical instrument",
    "Singing",
    "The arts",
    "Folk music",
    "Art",
    "Classical music",
]

HANDLE = "EmbeddingsTumbler.get(document.getElementById('space'))"
READY = f"""() => {{
  const h = window.EmbeddingsTumbler && {HANDLE};
  return !!h && h.info().ready && h.info().count > 0 && !!document.querySelector('.tumbler-search');
}}"""
SEARCH = f"() => {HANDLE}.info().search"
FACTS = f"""() => {{
  const i = {HANDLE}.info();
  return {{ count: i.count, dimension: i.dimension, model: i.model, modes: {HANDLE}.modes() }};
}}"""
TYPE = """(text) => {
  const box = document.querySelector('.tumbler-search-input');
  box.value = text;
  box.dispatchEvent(new Event('input'));
}"""
SLIDE = """([selector, value]) => {
  const range = document.querySelector(selector + ' input');
  range.value = String(value);
  range.dispatchEvent(new Event('input'));
}"""
PANEL = """() => {
  const shown = (n) => !!n && n.getClientRects().length > 0;
  const bar = document.querySelector('.tumbler-search-bar');
  const one = (sel) => document.querySelector(sel);
  return {
    expanded: bar.getAttribute('aria-expanded'),
    summary: one('.tumbler-search-summary').textContent,
    bodyShown: shown(one('.tumbler-search-body')),
    label: one('.tumbler-search-input-label').textContent,
    controls: [...document.querySelectorAll('.tumbler-search-controls > *')].filter(shown)
      .map((n) => {
        const copy = n.cloneNode(true);
        copy.querySelectorAll('select, input, output').forEach((part) => part.remove());
        return copy.textContent.trim();
      }),
    lit: [...document.querySelectorAll('.tumbler-search-lit option')].map((o) => o.textContent),
    pov: [...document.querySelectorAll('.tumbler-search-pov option')].map((o) => o.textContent),
    k: ['min', 'max', 'value'].map((key) => one('.tumbler-search-k input')[key]),
    note: one('.tumbler-search-note').textContent,
    pairs: one('.tumbler-search-pairs').textContent,
    provenance: (one('.tumbler-search-provenance-value') || { textContent: '' }).textContent,
    hits: [...document.querySelectorAll('.tumbler-search-list .tumbler-search-hit')]
      .slice(0, 2).map((n) => n.textContent),
    side: shown(one('.tumbler-search-side')),
    faceDisabled: one('.tumbler-search-face').disabled,
  };
}"""


def _titles(search, letter):
    one = next(q for q in search["searches"] if q["letter"] == letter)
    return [TITLES[hit["id"]] for hit in one["results"]]


def _settled(tab, until, what):
    return tab.wait_for(SEARCH, lambda s: not s["waiting"] and until(s), timeout=WAIT, what=what)


def _posts(tab):
    return len([r for r in tab.requests if r["method"] != "GET"])


@pytest.fixture(scope="module")
def base_url(tmp_path_factory):
    folder = tmp_path_factory.mktemp("search-guide")
    assert main(["viewer", "write", str(folder), "--apply"]) == 0
    with harness.Server(folder) as server:
        yield server.origin


def _open(browser, base_url, query=""):
    tab = harness.Tab(browser, viewport=(1280, 900))
    tab.goto(base_url + "/index.html" + query)
    assert tab.wait_for(READY, timeout=WAIT, what="the viewer and its panel")
    if tab.evaluate(f"() => {HANDLE}.info().rendering") is False:
        tab.close()
        harness.unavailable("WebGL 2 unavailable in headless Chromium")
    return tab


@pytest.fixture(scope="module")
def walk(browser, base_url):
    """The guide's steps, once, in its order; what was seen after each."""
    tab = _open(browser, base_url)
    seen = {}
    try:
        seen["facts"] = tab.evaluate(FACTS)
        seen["closed"] = tab.evaluate(PANEL)
        seen["posts_before"] = _posts(tab)
        tab.page.click(".tumbler-search-bar")
        seen["opened"] = tab.evaluate(PANEL)

        tab.evaluate(TYPE, "river")
        seen["river"] = _settled(tab, lambda s: len(s["searches"]) == 1, "the first search")
        seen["river_panel"] = tab.evaluate(PANEL)

        tab.evaluate(TYPE, "river\nmusic")
        seen["two"] = _settled(tab, lambda s: len(s["searches"]) == 2, "two searches")
        seen["two_panel"] = tab.evaluate(PANEL)

        before = tab.evaluate(f"() => {HANDLE}.time()")
        seen["moved"] = tab.wait_for(
            f"(t) => {HANDLE}.time() - t", lambda d: d > 0.3, arg=before, timeout=WAIT
        )
        seen["paused"] = tab.evaluate(f"() => {HANDLE}.isPaused()")

        tab.page.click(".tumbler-search-bar")
        seen["closed_again"] = tab.evaluate(PANEL)
        seen["active_closed"] = tab.evaluate(SEARCH)["active"]
        tab.page.click(".tumbler-search-bar")

        tab.page.select_option(".tumbler-search-lit select", "close")
        seen["close"] = _settled(tab, lambda s: s["settings"]["lit"] == "close", "lit by closeness")
        tab.page.select_option(".tumbler-search-lit select", "named")
        seen["named"] = _settled(tab, lambda s: s["settings"]["lit"] == "named", "named only")
        tab.page.select_option(".tumbler-search-lit select", "even")
        _settled(tab, lambda s: s["settings"]["lit"] == "even", "lit evenly")

        tab.evaluate(SLIDE, [".tumbler-search-k", 20])
        seen["k20"] = _settled(tab, lambda s: len(s["searches"][0]["results"]) == 20, "20 results")
        tab.evaluate(SLIDE, [".tumbler-search-k", 8])
        _settled(tab, lambda s: len(s["searches"][0]["results"]) == 8, "8 results again")

        tab.page.check(".tumbler-search-distances input")
        _settled(tab, lambda s: s["settings"]["distances"], "distance difference")
        tab.evaluate("() => { document.querySelector('.tumbler-search-list').open = true; }")
        seen["distances_panel"] = tab.evaluate(PANEL)

        tab.page.select_option(".tumbler-search-pov select", "A")
        seen["pov"] = _settled(tab, lambda s: s["settings"]["pointOfView"] == "A", "point of view")
        seen["pov_panel"] = tab.evaluate(PANEL)
        tab.page.select_option(".tumbler-search-pov select", "")
        _settled(tab, lambda s: s["settings"]["pointOfView"] is None, "point of view off")

        seen["faced"] = tab.wait_for(
            f"() => {HANDLE}.faceSearches()", timeout=WAIT, what="a swing toward the searches"
        )

        tab.page.click(".tumbler-mode:nth-of-type(4)")
        tab.wait_for(f"() => {HANDLE}.mode() === 'focus' && {HANDLE}.info().ready", timeout=WAIT)
        tab.page.check(".tumbler-search-only input")
        seen["only"] = _settled(tab, lambda s: s["settings"]["onlyResults"], "only results")
        seen["focus_panel"] = tab.evaluate(PANEL)
        seen["focus_status"] = tab.wait_for(
            f"() => {HANDLE}.info().status", lambda t: t.startswith("fitted to"), timeout=WAIT
        )

        tab.page.click(".tumbler-search-clear")
        seen["cleared"] = _settled(tab, lambda s: not s["active"], "no search")
        seen["cleared_panel"] = tab.evaluate(PANEL)
        seen["posts_after"] = _posts(tab)
        seen["foreign"] = tab.foreign_requests(base_url)
        seen["errors"] = tab.console_errors()
        seen["csp"] = list(tab.csp)
        yield seen
    finally:
        tab.close()


def test_the_default_data_is_the_wikipedia_set(walk):
    assert walk["facts"]["count"] == 999
    assert walk["facts"]["model"] == "Qwen/Qwen3-Embedding-0.6B"
    assert walk["facts"]["dimension"] == 1024


def test_focus_is_the_fourth_view(walk):
    assert walk["facts"]["modes"] == ["tumble", "lattice", "wander", "focus"]


def test_the_panel_starts_closed_as_one_line(walk):
    closed = walk["closed"]
    assert closed["expanded"] == "false"
    assert closed["bodyShown"] is False
    assert closed["summary"] == "nothing searched: every point is shown"


def test_the_open_panel_has_the_controls_the_guide_names(walk):
    opened = walk["opened"]
    assert opened["bodyShown"] is True
    assert opened["label"] == "Search: one search per line, up to four"
    assert opened["controls"] == [
        "Face the searches",
        "Lit",
        "Distance difference",
        "Results",
        "From this search's point of view",
        "Clear",
    ]
    assert opened["lit"] == [
        "the results, evenly",
        "by closeness: nearer is brighter",
        "named results only",
    ]
    assert opened["k"] == ["3", "100", "8"]


def test_with_no_helper_the_panel_says_nothing_is_sent(walk):
    assert "No embedder is connected" in walk["opened"]["note"]
    assert "nothing is sent" in walk["opened"]["note"]


def test_the_first_search_gives_the_results_the_guide_quotes(walk):
    river = walk["river"]["searches"][0]
    assert [river["letter"], river["kind"], river["sentTo"]] == ["A", "words", "nowhere"]
    assert _titles(walk["river"], "A") == RIVER
    assert river["results"][0]["distance"] == pytest.approx(0, abs=1e-6)
    assert [f"{hit['distance']:.3f}" for hit in river["results"]] == RIVER_DISTANCES
    assert round(river["radius"], 3) == 0.564
    assert walk["river"]["litCount"] == 8
    assert walk["river_panel"]["summary"] == "A river · 8 points lit"


def test_two_searches_are_lettered_and_compared(walk):
    two = walk["two"]
    assert [q["letter"] for q in two["searches"]] == ["A", "B"]
    assert _titles(two, "B") == MUSIC
    assert round(two["searches"][1]["radius"], 3) == 0.494
    assert [[p["a"], p["b"], p["shared"], p["common"]] for p in two["pairs"]] == [["A", "B", 0, 0]]
    assert walk["two_panel"]["summary"] == "A river · B music · 16 points lit"
    assert "A and B: no point found by both" in walk["two_panel"]["pairs"]


def test_what_a_search_used_is_stated_beside_the_provenance(walk):
    used = walk["two_panel"]["provenance"]
    assert used.startswith("cosine distance (1 minus cosine similarity)")
    assert 'A "river": words matched among the loaded points' in used
    assert "nothing sent" in used
    assert "no reranker" in used


def test_the_note_says_distances_are_full_space(walk):
    assert (
        "Distances are cosine distance (1 minus cosine similarity), in every dimension of the data."
        in walk["two_panel"]["note"]
    )


def test_motion_never_stops_during_a_search(walk):
    assert walk["moved"] > 0.3
    assert walk["paused"] is False


def test_closing_the_panel_keeps_the_search(walk):
    assert walk["closed_again"]["expanded"] == "false"
    assert walk["closed_again"]["summary"] == "A river · B music · 16 points lit"
    assert walk["active_closed"] is True


def test_the_lit_choices_do_what_the_guide_says(walk):
    # Evenly: every point within the radius. By closeness: the same and a little beyond,
    # fading. Named only: the results and nothing else.
    assert walk["close"]["litCount"] >= walk["two"]["litCount"]
    assert walk["named"]["litCount"] == 16


def test_results_goes_up_to_what_was_asked(walk):
    assert [len(q["results"]) for q in walk["k20"]["searches"]] == [20, 20]


def test_distance_difference_writes_distances_in_the_lists(walk):
    first, second = walk["distances_panel"]["hits"]
    assert "distance 0.000" in first
    assert "the nearest" in first
    assert "farther than the nearest" in second


def test_point_of_view_belongs_to_one_search(walk):
    assert walk["distances_panel"]["pov"] == ["off", "A · river", "B · music"]
    assert [q["pointOfView"] for q in walk["pov"]["searches"]] == [True, False]
    assert "A is measured from its own point of view" in walk["pov_panel"]["note"]


def test_face_the_searches_swings_the_view(walk):
    assert walk["faced"] is True


def test_focus_fits_the_results_and_offers_only_results(walk):
    assert walk["focus_status"] == "fitted to the results of A, B"
    assert "Only results" in walk["focus_panel"]["controls"]
    assert "Only results" not in walk["opened"]["controls"]
    assert walk["focus_panel"]["side"] is True
    assert walk["only"]["faceable"] is False


def test_clear_removes_every_search(walk):
    assert walk["cleared"]["searches"] == []
    assert walk["cleared_panel"]["summary"] == "nothing searched: every point is shown"


def test_typing_sent_nothing_anywhere(walk):
    # The one POST is the page asking its own origin whether the helper is there, before any
    # typing; a plain static server has no helper, so nothing typed can go anywhere.
    assert walk["posts_before"] == 1
    assert walk["posts_after"] == 1
    assert walk["foreign"] == []
    assert walk["errors"] == []
    assert walk["csp"] == []


def test_the_synthetic_set_is_one_address_away(browser, base_url):
    tab = _open(browser, base_url, "?sample=synthetic")
    try:
        facts = tab.evaluate(FACTS)
        assert facts["count"] == 12288
        assert facts["model"] != DEMO["model"]
    finally:
        tab.close()
