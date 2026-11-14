"""Headless-browser check of the search panel (task t9 of the search plan).

The folder under test is the shipped standalone page, written by ``embeddings-tumbler viewer
write <tmp> --apply`` with a contract fixture beside it, and served on a loopback port. With
no embed route the page mounts the viewer with no callbacks, so every search here is a search
among the loaded points.

Checked, at 1280 px and 390 px wide: with two searches active and the panel closed, the panel
is one line of 48 px or less; opening and closing keeps the search (and never pauses);
typing lights points (``info().search``); suggestions appear and a click on one searches for
it; the Lit menu changes the lit count. In Focus the ranked list sits beside the stage on a
wide screen (below it on a phone) and Face the searches is disabled. A label holding markup
creates no element. The light treatment keeps the panel's text and the four search colours
readable (contrast measured on the computed colours). No request leaves the origin, no
console error, no CSP violation.

Uses the shared harness (``tests/browser/harness.py``); SwiftShader unless
``TUMBLER_BROWSER_RENDERER=gpu``; skips without Playwright, Chromium or WebGL 2, and fails
instead under ``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from embeddings_tumbler.cli import main
from tests.browser import harness

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "contract"
VIEWPORTS = {"desktop": (1280, 900), "phone": (390, 844)}
WAIT = 120

READY = """() => {
  const h = window.EmbeddingsTumbler && EmbeddingsTumbler.get(document.getElementById('space'));
  return !!h && h.info().ready && h.info().frames > 5
    && !!document.querySelector('.tumbler-search');
}"""

SEARCH = "() => EmbeddingsTumbler.get(document.getElementById('space')).info().search"

TYPE = """(text) => {
  const box = document.querySelector('.tumbler-search-input');
  box.value = text;
  box.dispatchEvent(new Event('input'));
}"""

PANEL = """() => {
  const sec = document.querySelector('.tumbler-search');
  const bar = document.querySelector('.tumbler-search-bar');
  const body = document.querySelector('.tumbler-search-body');
  const h = EmbeddingsTumbler.get(document.getElementById('space'));
  return {
    height: sec.getBoundingClientRect().height,
    barHeight: bar.getBoundingClientRect().height,
    expanded: bar.getAttribute('aria-expanded'),
    controls: bar.getAttribute('aria-controls') === body.id,
    bodyShown: body.getClientRects().length > 0,
    summary: document.querySelector('.tumbler-search-summary').textContent,
    live: document.querySelector('.tumbler-search-live').textContent,
    paused: h.isPaused(),
    active: h.info().search.active,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
}"""


@pytest.fixture(scope="module")
def base_url(tmp_path_factory):
    folder = tmp_path_factory.mktemp("panel")
    assert main(["viewer", "write", str(folder), "--apply"]) == 0
    for name in ("valid-384.json", "valid-384.f32"):
        shutil.copy(FIXTURES / name, folder / name)
    with harness.Server(folder) as server:
        yield server.origin


def _open(browser, base_url, query="?sample=synthetic", viewport=VIEWPORTS["desktop"]):
    tab = harness.Tab(browser, viewport=viewport)
    tab.goto(base_url + "/index.html" + query)
    info = tab.wait_for(READY, timeout=WAIT, what="the viewer and its panel")
    assert info
    if (
        tab.evaluate(
            "() => EmbeddingsTumbler.get(document.getElementById('space')).info().rendering"
        )
        is False
    ):
        tab.close()
        harness.unavailable("WebGL 2 unavailable in headless Chromium")
    return tab


def _search(tab, text):
    tab.evaluate(TYPE, text)
    return tab.wait_for(
        SEARCH,
        lambda s: s["active"]
        and not s["waiting"]
        and [q["text"] for q in s["searches"]] == text.split("\n"),
        timeout=WAIT,
        what=f"the search {text!r}",
    )


def _clean(tab, base_url):
    tab.assert_no_foreign_requests(base_url)
    tab.assert_no_console_errors()
    tab.assert_no_csp_violations()


@pytest.fixture(scope="module", params=list(VIEWPORTS))
def sky_run(request, browser, base_url):
    """One tab per width: two searches, the bar measured closed, opened and closed again,
    a suggestion clicked, the Lit menu changed."""
    tab = _open(browser, base_url, viewport=VIEWPORTS[request.param])
    try:
        out = {"name": request.param}
        searched = _search(tab, "tide harbor\nreef kelp")
        out["searched"] = searched
        tab.page.wait_for_timeout(300)
        out["closed"] = tab.evaluate(PANEL)
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        out["opened"] = tab.evaluate(PANEL)
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        out["reclosed"] = tab.evaluate(PANEL)
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        # Suggestions for a word start; a click searches for the suggestion.
        tab.evaluate("""() => { const b = document.querySelector('.tumbler-search-input');
               b.value = 'tide harbor\\nreef kelp\\nest'; b.dispatchEvent(new Event('input')); }""")
        out["suggestions"] = tab.wait_for(
            "() => Array.from(document.querySelectorAll('.tumbler-search-suggestion'))"
            ".map((b) => b.textContent)",
            lambda xs: len(xs) > 0,
            timeout=WAIT,
            what="suggestions",
        )
        tab.evaluate("() => document.querySelector('.tumbler-search-suggestion').click()")
        out["after_click"] = tab.wait_for(
            SEARCH,
            lambda s: not s["waiting"] and len(s["searches"]) == 3,
            timeout=WAIT,
            what="the suggestion's search",
        )
        before = out["after_click"]["litCount"]
        tab.evaluate("""() => { const s = document.querySelector('.tumbler-search-lit select');
               s.value = 'named'; s.dispatchEvent(new Event('change')); }""")
        out["named"] = tab.wait_for(
            SEARCH,
            lambda s: s["settings"]["lit"] == "named" and not s["waiting"],
            timeout=WAIT,
            what="the lit setting",
        )
        out["lit_before"] = before
        out["note"] = tab.evaluate(
            "() => document.querySelector('.tumbler-search-note').textContent"
        )
        out["provenance"] = tab.evaluate(
            "() => document.querySelector('.tumbler-provenance-summary').textContent"
        )
        _clean(tab, base_url)
    finally:
        tab.close()
    return out


def test_collapsed_panel_is_one_line_of_48_px_or_less(sky_run):
    closed = sky_run["closed"]
    assert closed["expanded"] == "false"
    assert closed["controls"]
    assert not closed["bodyShown"]
    assert closed["height"] <= 48, f"{sky_run['name']}: {closed['height']} px"
    assert closed["summary"].startswith("A tide harbor · B reef kelp · ")
    assert closed["summary"].endswith(" points lit")
    assert closed["live"] == closed["summary"]
    assert closed["scrollWidth"] <= closed["clientWidth"]


def test_opening_and_closing_keeps_the_search(sky_run):
    assert sky_run["opened"]["expanded"] == "true"
    assert sky_run["opened"]["bodyShown"]
    assert sky_run["opened"]["height"] > 48
    for state in ("opened", "reclosed"):
        assert sky_run[state]["active"]
        assert not sky_run[state]["paused"]
    assert sky_run["reclosed"]["height"] <= 48
    assert sky_run["reclosed"]["summary"] == sky_run["closed"]["summary"]


def test_typing_lights_points_found_among_the_loaded_points(sky_run):
    s = sky_run["searched"]
    assert s["litCount"] > 0
    assert [q["kind"] for q in s["searches"]] == ["words", "words"]
    assert [r["text"] for r in s["searches"][0]["results"]][:2] == ["tide", "harbor"]
    assert all(q["sentTo"] == "nowhere" for q in s["searches"])
    assert "search: searched among the loaded points, nothing sent" in sky_run["provenance"]


def test_suggestions_appear_and_a_click_searches(sky_run):
    sug = sky_run["suggestions"]
    assert "estuary" in sug
    third = sky_run["after_click"]["searches"][2]
    assert third["text"] in sug
    assert third["results"][0]["text"] == third["text"]


def test_the_lit_menu_changes_the_lit_count(sky_run):
    assert sky_run["named"]["litCount"] != sky_run["lit_before"]
    assert sky_run["named"]["litCount"] <= 3 * 8
    assert "(named results only)" in sky_run["note"]
    assert "nothing was sent anywhere" in sky_run["note"]


@pytest.mark.parametrize("name", list(VIEWPORTS))
def test_focus_lists_results_beside_the_stage_and_disables_face(browser, base_url, name):
    tab = _open(browser, base_url, "?sample=synthetic&mode=focus", VIEWPORTS[name])
    try:
        s = _search(tab, "tide harbor")
        assert s["faceable"] is False
        geo = tab.evaluate("""() => {
              const side = document.querySelector('.tumbler-search-side');
              const stage = document.querySelector('.tumbler-stage');
              const a = side.getBoundingClientRect(), b = stage.getBoundingClientRect();
              return { side: [a.left, a.top, a.width, a.height],
                stage: [b.left, b.top, b.width, b.height],
                items: Array.from(side.querySelectorAll('li .tumbler-search-text'))
                  .map((n) => n.textContent),
                face: document.querySelector('.tumbler-search-face').disabled,
                width: document.documentElement.scrollWidth
                  <= document.documentElement.clientWidth };
            }""")
        assert geo["face"] is True
        assert geo["items"][:2] == ["tide", "harbor"]
        assert geo["width"]
        side, stage = geo["side"], geo["stage"]
        if name == "desktop":
            assert side[0] >= stage[0] + stage[2] - 1, "the list is to the right of the stage"
            assert abs(side[1] - stage[1]) < 2
        else:
            assert side[1] >= stage[1] + stage[3] - 1, "the list is below the stage"
        _clean(tab, base_url)
    finally:
        tab.close()


def test_markup_in_a_label_creates_no_element(browser, base_url):
    tab = _open(browser, base_url, "?data=valid-384.json")
    try:
        s = _search(tab, "markup")
        texts = [r["text"] for r in s["searches"][0]["results"]]
        assert "<b>markup is text</b> & <script>not run</script>" in texts
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        tab.evaluate(OPEN_LISTS)
        found = tab.evaluate("""() => {
              const root = document.getElementById('space');
              return {
                scripts: root.querySelectorAll('script').length,
                bolds: Array.from(root.querySelectorAll('b'))
                  .filter((b) => b.textContent === 'markup is text').length,
                shown: Array.from(root.querySelectorAll('.tumbler-search-text')).some(
                  (n) => n.textContent === '<b>markup is text</b> & <script>not run</script>'),
              };
            }""")
        assert found == {"scripts": 0, "bolds": 0, "shown": True}
        _clean(tab, base_url)
    finally:
        tab.close()


OPEN_LISTS = (
    "() => { for (const d of document.querySelectorAll('.tumbler-search-list')) d.open = 1; }"
)

LIGHT = """() => {
  const s = document.getElementById('space').style;
  const set = {'--tumbler-background': '#f6f4ee', '--tumbler-sky': '#ffffff',
    '--tumbler-foreground': '#1b2130', '--tumbler-muted': '#5b6578',
    '--tumbler-line': '#d6dae2', '--tumbler-accent': '#a35f00'};
  for (const k in set) s.setProperty(k, set[k]);
  EmbeddingsTumbler.get(document.getElementById('space')).refreshTheme();
}"""

CONTRAST = """() => {
  const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (c) => { const v = c.map((x) => x / 255)
    .map((x) => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05); };
  const bg = rgb(getComputedStyle(document.querySelector('.tumbler')).backgroundColor);
  const of = (sel) => Array.from(document.querySelectorAll(sel))
    .map((n) => ratio(rgb(getComputedStyle(n).color), bg));
  return {
    light: EmbeddingsTumbler.get(document.getElementById('space'))._viewer.theme.light,
    summary: of('.tumbler-search-summary'), note: of('.tumbler-search-note'),
    letters: of('.tumbler-search-list summary'), ranks: of('.tumbler-search-rank'),
    texts: of('.tumbler-search-text'),
    shared: of('.tumbler-search-shared-mark'),
  };
}"""


def test_light_treatment_keeps_text_and_search_colours_readable(browser, base_url):
    tab = _open(browser, base_url)
    try:
        tab.evaluate(LIGHT)
        _search(tab, "tide harbor\nreef kelp\ncomet nebula\nmarch april")
        tab.evaluate("() => document.querySelector('.tumbler-search-bar').click()")
        tab.evaluate(OPEN_LISTS)
        c = tab.evaluate(CONTRAST)
        assert c["light"] is True
        assert len(c["letters"]) == 4
        for key in ("summary", "note", "letters", "ranks", "texts", "shared"):
            assert c[key], key
            assert min(c[key]) >= 4.5, f"{key}: {c[key]}"
        _clean(tab, base_url)
    finally:
        tab.close()
