"""The relative view with the test reranker, and the words on the mixed-length fixture (task
t13 of the relative-search plan; obligations o4 and o8 of the spec).

Reranker: the standalone page on the shipped Wikipedia demo pair, the search Rice, Relative
on. The test reranker is given through the public handle (``setSearchCallbacks``), as the
existing candidates test does; it scores candidate ``i`` (embedding order) as ``(37 i) mod n``,
so its order is neither the embedding order nor the order of heights. Settings: 51 candidates
and top 9 (Rice's own point is a candidate and the first in embedding order; the counts are
one higher than the reference's 50 and 8, ``docs/relative-interface.md``). Expected ranks and
the cut-off height are worked out here from the pair. Asserted: without the reranker no label
carries a rank and there is no cut-off; with it, the overlay is given ranks 1 to 9, one per
kept result, every result label placed carries the rank of its own text, and the dashed
cut-off line and its text sit at the lowest candidate's height (the line read from the
overlay canvas's pixels, the text from its span).

Words: the standalone page on ``tests/fixtures/relative/mixed-length.json`` (lengths 0.35 to
1.0), the search Rice, Relative on, the result list opened. No rendered text may call the
height cosine: every occurrence of "cosine" on the page is a cosine value shown beside a
height, the search's distance measure, or a sentence saying height is not cosine.
"""

from __future__ import annotations

import re

import pytest

from tests.browser import harness
from tests.browser import relative_site as rs

CANDIDATES = 51
TOP = 9
STEP = 37  # the test reranker's score for candidate i is (STEP * i) mod n

RERANKER = f"""() => {{
  window.__rerankSeen = [];
  return {rs.H}.setSearchCallbacks({{ rerank: (query, candidates) => {{
    window.__rerankSeen.push(candidates.length);
    const n = candidates.length;
    return {{ scores: candidates.map((_c, i) => ({STEP} * i) % n), model: 'test/permute' }};
  }} }});
}}"""

CUT_TEXT = f"{CANDIDATES} candidates above this line went to the reranker"

# The cut-off text's span (its vertical middle in CSS px of the stage) and, on the overlay
# canvas, how many painted pixels each row near a given device row has across the ruler.
CUT_PLACE = """(text) => {
  const n = [...document.querySelectorAll('.tumbler-relative-label')]
    .find((s) => s.style.display !== 'none' && s.textContent === text);
  if (!n) return null;
  const r = n.getBoundingClientRect();
  const c = document.querySelector('#space canvas.tumbler-overlay').getBoundingClientRect();
  return { middle: (r.top + r.bottom) / 2 - c.top };
}"""
OVERLAY_ROWS = """([x, y, half, rows]) => {
  const c = document.querySelector('#space canvas.tumbler-overlay');
  const ctx = c.getContext('2d');
  const out = {};
  for (const dy of rows) {
    const row = ctx.getImageData(Math.round(x - half), Math.round(y) + dy, 2 * half, 1).data;
    let painted = 0;
    for (let i = 3; i < row.length; i += 4) if (row[i] > 40) painted++;
    out[dy] = painted;
  }
  return out;
}"""

# Every sentence of the page as rendered (innerText) and as held (textContent, which also
# reaches collapsed blocks such as the provenance), the status line and the relative labels.
TEXTS = f"""() => ({{
  rendered: document.body.innerText,
  held: document.body.textContent,
  status: {rs.H}.info().status,
}})"""

# What may be said with the word cosine on the mixed-length page: a cosine value beside a
# height, the search's own distance measure, and sentences saying height is not cosine.
ALLOWED_COSINE = [
    r"cosine -?\d\.\d+",
    r"cosine distance",
    r"1 minus cosine similarity",
    r"ranked by cosine",
    r"not cosine",
]


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    folder = rs.build_folder(tmp_path_factory.mktemp("relative-rerank"))
    with harness.Server(folder) as srv:
        yield srv


@pytest.fixture(scope="module")
def expected():
    meta, rows = rs.load_pair(rs.STATIC / "demo-wikipedia.json")
    rice = rs.index_of(meta, rs.RICE_ID)
    cosines, heights = rs.along(rows, rows[rice])
    pool = rs.nearest(cosines, CANDIDATES)  # embedding order, the reranker's candidates
    assert pool[0] == rice
    by_score = sorted(range(CANDIDATES), key=lambda i: (-((STEP * i) % CANDIDATES), i))[:TOP]
    kept = [pool[i] for i in by_score]
    assert rice not in kept  # so every kept result has a stem and a label

    def text(i):
        p = meta["points"][i]
        return (p.get("metadata") or {}).get("text") or p["label"]

    return {
        "kept": kept,
        "embedding_rank": [i + 1 for i in by_score],
        "rank_of_text": {text(i)[:20]: r + 1 for r, i in enumerate(kept)},
        "cut": min(heights[i] for i in pool),
        "texts": [text(i)[:20] for i in pool],
    }


@pytest.fixture(scope="module")
def reranked(browser, webgl, server):
    tab = rs.open_page(browser, server.url("/index.html?seed=3&relative=1"))
    out: dict = {}
    try:
        assert tab.evaluate(RERANKER)["reranker"] is True
        assert tab.evaluate(f"async () => (await {rs.H}.setSearchSettings({{ k: 9 }})).ok")
        assert tab.evaluate(f"async () => (await {rs.H}.setSearches(['Rice'])).ok")
        rs.settled(tab, 1, "Rice relative, no reranker")
        out["plain_labels"] = tab.evaluate(rs.LABELS)
        out["plain_cut"] = tab.evaluate(f"() => {rs.H}._viewer.relOverlayCache.data.cut")
        on = f"""async () => (await {rs.H}.setSearchSettings(
            {{ rerank: true, candidates: {CANDIDATES}, top: {TOP} }})).ok"""
        assert tab.evaluate(on)
        out["state"] = tab.wait_for(
            rs.SETTLED,
            lambda v: v is not None
            and len(v["hook"]["results"]) == TOP
            and tab.evaluate(f"() => {rs.H}.info().search.searches[0].reranker") is not None,
            arg=1,
            timeout=rs.WAIT,
            what="the reranked relative view",
        )
        tab.page.wait_for_timeout(300)  # a few frames for the labels of the new results
        out["search"] = tab.evaluate(f"() => {rs.H}.info().search.searches[0]")
        out["seen"] = tab.evaluate("() => window.__rerankSeen")
        out["named"] = tab.evaluate(f"() => {rs.H}._viewer.relOverlayCache.data.named")
        out["cut"] = tab.evaluate(f"() => {rs.H}._viewer.relOverlayCache.data.cut")
        tab.evaluate(f"() => {rs.H}.pause()")
        tab.page.wait_for_timeout(300)
        out["hook"] = tab.evaluate(f"() => {rs.H}._viewer.relativeDrawn")
        out["labels"] = tab.evaluate(rs.LABELS)
        out["cut_place"] = tab.evaluate(CUT_PLACE, CUT_TEXT)
        out["foreign"] = tab.foreign_requests(server.origin)
        out["errors"] = tab.console_errors()
        out["tab"] = tab  # the overlay rows are read in the test, once the cut height is known
        yield out
    finally:
        tab.close()


@pytest.fixture(scope="module")
def mixed(browser, webgl, server):
    tab = rs.open_page(browser, server.url("/index.html?seed=3&relative=1&data=mixed-length.json"))
    out: dict = {}
    try:
        tab.page.click(".tumbler-search-bar")
        tab.evaluate("""() => { const b = document.querySelector('.tumbler-search-input');
               b.value = 'Rice'; b.dispatchEvent(new Event('input')); }""")
        out["state"] = rs.settled(tab, 1, "Rice relative on the mixed-length set")
        tab.evaluate(
            "() => { const l = document.querySelector('.tumbler-search-list');"
            " if (l) l.open = true; }"
        )
        out["status"] = tab.wait_for(
            f"() => {rs.H}.info().status",
            lambda t: ", exact" in t,
            timeout=rs.WAIT,
            what="the status line to say the vertical axis is exact",
        )
        tab.page.wait_for_timeout(300)
        out["labels"] = tab.evaluate(rs.LABELS)
        out["texts"] = tab.evaluate(TEXTS)
        out["errors"] = tab.console_errors()
        out["foreign"] = tab.foreign_requests(server.origin)
    finally:
        tab.close()
    return out


def _result_labels(labels: list[str]) -> list[str]:
    """The result labels among the overlay's texts (ticks, title, cut-off and origin left out)."""
    return [t for t in labels if re.search(r"\d\.\d\d$", t) and not t.startswith("origin")]


# --------------------------------------------------------------------------- the reranker


def test_without_the_reranker_no_label_carries_a_rank_and_there_is_no_cut_off(reranked):
    results = _result_labels(reranked["plain_labels"])
    assert results, reranked["plain_labels"]
    assert not any(re.match(r"^A?\d+\. ", t) for t in results), results
    assert reranked["plain_cut"] is None
    assert not any("candidates above this line" in t for t in reranked["plain_labels"])


def test_the_reranker_ranked_the_candidates_worked_out_from_the_pair(reranked, expected):
    q = reranked["search"]
    assert q["reranker"] == "test/permute"
    assert (q["candidates"], q["top"], q["sent"]) == (CANDIDATES, TOP, CANDIDATES)
    assert reranked["seen"][-1] == CANDIDATES
    assert [r["index"] for r in q["results"]] == expected["kept"]
    assert [r["rank"] for r in q["results"]] == list(range(1, TOP + 1))
    assert [r["embeddingRank"] for r in q["results"]] == expected["embedding_rank"]


def test_labels_carry_ranks_1_to_top(reranked, expected):
    named = reranked["named"]
    assert [n["index"] for n in named] == expected["kept"]
    assert [[(r["letter"], r["rank"]) for r in n["ranks"]] for n in named] == [
        [("A", r)] for r in range(1, TOP + 1)
    ]
    assert sorted(r["index"] for r in reranked["hook"]["results"]) == sorted(expected["kept"])
    placed = _result_labels(reranked["labels"])
    print(f"result labels placed: {len(placed)} of {TOP} (the rest overlap): {placed}")
    assert placed, reranked["labels"]
    for label in placed:
        m = re.match(r"^(\d+)\. (.*)$", label)
        assert m, f"a result label without a rank: {label!r}"
        rank = int(m.group(1))
        assert 1 <= rank <= TOP, label
        assert expected["rank_of_text"].get(m.group(2)[:20]) == rank, label


def test_the_cut_off_is_at_the_lowest_candidates_height(reranked, expected):
    cut = reranked["cut"]
    assert cut["sent"] == CANDIDATES
    assert abs(cut["height"] - expected["cut"]) < 1e-5, (cut, expected["cut"])
    hook = reranked["hook"]
    ruler, dpr = hook["ruler"], hook["dpr"]
    assert ruler["from"] < expected["cut"] < min(r["height"] for r in hook["results"])
    f = (expected["cut"] - ruler["from"]) / (ruler["to"] - ruler["from"])
    y = ruler["y0"] + f * (ruler["y1"] - ruler["y0"])  # device px
    x = ruler["x0"] + f * (ruler["x1"] - ruler["x0"])
    assert CUT_TEXT in reranked["labels"]
    place = reranked["cut_place"]
    assert abs(place["middle"] - y / dpr) <= 2.0, (place, y / dpr)
    half = int(140 * dpr)
    rows = reranked["tab"].evaluate(OVERLAY_ROWS, [x, y, half, [-1, 0, 1, 5, 6, 7, 8]])
    on_line = max(rows["-1"], rows["0"], rows["1"])
    below = max(rows["5"], rows["6"], rows["7"], rows["8"])
    print(
        f"cut-off at height {expected['cut']:.4f}, y {y / dpr:.1f} px: painted pixels on the"
        f" line {on_line} of {2 * half}, a few pixels below {below}"
    )
    assert on_line >= 0.35 * 2 * half, rows  # a dashed line across the ruler
    assert below <= 0.1 * 2 * half, rows  # and nothing like it just below
    assert reranked["foreign"] == []
    assert reranked["errors"] == []


# --------------------------------------------------------------------------- the words


def test_the_mixed_length_page_never_calls_the_height_cosine(mixed):
    rel = mixed["state"]["relative"]
    assert rel["measure"] == "length along the search"
    assert rel["unit"]["unit"] is False
    texts = mixed["texts"]
    for name in ("rendered", "held", "status"):
        rest = texts[name]
        for pattern in ALLOWED_COSINE:
            rest = re.sub(pattern, "", rest)
        bad = [rest[max(0, m.start() - 40) : m.end() + 40] for m in re.finditer("cosine", rest)]
        assert not bad, f"{name} text calls something cosine: {bad}"
    for phrase in ("cosine to", "= cosine", "height is cosine"):
        assert phrase not in texts["held"], phrase


def test_the_mixed_length_page_names_the_height_length_along_the_search(mixed):
    assert "length along the search to A" in mixed["labels"]
    assert "cosine to A" not in mixed["labels"]
    assert mixed["status"].startswith(
        "relative to A · vertical = length along the search to A, exact"
    )
    assert "so height is length along the search, not cosine" in mixed["texts"]["held"]
    results = _result_labels(mixed["labels"])
    assert results, mixed["labels"]
    for label in results:  # both numbers: the height, then the cosine beside it
        assert re.search(r"  -?\d\.\d\d  cosine -?\d\.\d\d$", label), label
    assert mixed["foreign"] == []
    assert mixed["errors"] == []
