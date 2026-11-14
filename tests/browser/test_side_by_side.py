"""The development side-by-side page shows each search reference next to the build on
comparable data, from the repository alone (docs/reference-differences.md, the search part).

The page is opened from a loopback server over the repository root, and every request to any
other origin is refused, so what passes here works with no network. Each side runs its own
search code; the test reads the results both sides list, never pixels, and waits on what the
pages show, never on the clock.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

PAGE = "/js/dev/side-by-side/"
FONTS = "https://fonts.googleapis.com/"  # the references ask for these; the build asks for nothing
WAIT_S = 240

# The Focus pair: the reference's list and the list beside the built view's stage.
FOCUS = """() => {
  const ref = document.getElementById('frame-ref').contentDocument;
  const build = document.getElementById('frame-build').contentDocument;
  const texts = (doc, sel) =>
    doc ? Array.from(doc.querySelectorAll(sel)).map((n) => n.textContent) : [];
  return {
    ref: texts(ref, '#list li .text'),
    build: texts(build, '.tumbler-search-side .tumbler-search-text'),
    refPage: ref ? ref.location.pathname : '',
    buildPage: build ? build.location.pathname : '',
  };
}"""

# The sky pair: each side's first list (search A), and the build's bar.
SKY = """() => {
  const ref = document.getElementById('frame-ref').contentDocument;
  const build = document.getElementById('frame-build').contentDocument;
  const texts = (root, sel) =>
    root ? Array.from(root.querySelectorAll(sel)).map((n) => n.textContent) : [];
  const bar = build ? build.querySelector('.tumbler-search-summary') : null;
  const refBar = ref ? ref.getElementById('find-sum') : null;
  const buildList = build ? build.querySelector('.tumbler-search-list') : null;
  return {
    ref: texts(ref ? ref.querySelector('#results details') : null, 'li .w'),
    build: texts(buildList, '.tumbler-search-text'),
    bar: bar ? bar.textContent : '',
    refBar: refBar ? refBar.textContent : '',
    buildPage: build ? build.location.pathname + build.location.search : '',
  };
}"""


@pytest.fixture(scope="module")
def repo_server():
    with harness.Server(harness.ROOT) as server:
        yield server


def _open(open_tab, server, query: str = "") -> harness.Tab:
    tab = open_tab(viewport=(1500, 1000))
    # No network: only the loopback server answers.
    tab.context.route(lambda url: not url.startswith(server.origin), lambda route: route.abort())
    tab.goto(server.url(PAGE + query))
    return tab


def _assert_clean(tab: harness.Tab, server) -> None:
    assert tab.page_errors == []
    tab.assert_no_csp_violations()
    foreign = {r["url"] for r in tab.foreign_requests(server.origin)}
    assert [u for u in foreign if not u.startswith(FONTS)] == []


def test_focus_reference_and_built_focus_list_the_same_results(open_tab, repo_server, webgl):
    tab = _open(open_tab, repo_server)
    tab.page.click("button[data-pair=focus]")
    shown = tab.wait_for(
        FOCUS,
        lambda v: len(v["ref"]) == 8 and len(v["build"]) == 8,
        timeout=WAIT_S,
        what="eight results for the starting search on both sides of the Focus pair",
    )
    assert shown["refPage"].endswith("/tumbler-focus-view.html")
    assert shown["buildPage"].endswith("/focus-build.html")
    # The same texts and vectors on both sides give the same results in the same order.
    assert shown["build"] == shown["ref"]
    assert shown["ref"][0] == "flood"

    tab.page.fill("#both-query", "things that flow")
    tab.page.click("#search-bar button")
    again = tab.wait_for(
        FOCUS,
        lambda v: v["ref"][:1] == ["waterfall"] and v["build"][:1] == ["waterfall"],
        timeout=WAIT_S,
        what="the second search on both sides of the Focus pair",
    )
    assert again["build"] == again["ref"]
    _assert_clean(tab, repo_server)


def test_sky_reference_and_built_page_show_the_same_searches(open_tab, repo_server, webgl):
    # Opened on the sky pair by its address, so the first demo's two pages are not drawn first.
    tab = _open(open_tab, repo_server, "?pair=sky")
    shown = tab.wait_for(
        SKY,
        lambda v: len(v["ref"]) == 8 and len(v["build"]) == 8 and "points lit" in v["bar"],
        timeout=WAIT_S,
        what="the starting searches on both sides of the sky pair",
    )
    assert shown["buildPage"].startswith("/embeddings_tumbler/static/index.html?sample=synthetic")
    # Both sides were given the reference's own three starting searches.
    assert shown["refBar"].startswith("A tide harbor · B reef kelp · C comet nebula · ")
    assert shown["bar"].startswith("A tide harbor · B reef kelp · C comet nebula · ")
    # Search A's named results are the same eight, in the same order, on the same vectors.
    assert shown["build"] == shown["ref"]
    assert shown["ref"][:2] == ["tide", "harbor"]
    _assert_clean(tab, repo_server)
