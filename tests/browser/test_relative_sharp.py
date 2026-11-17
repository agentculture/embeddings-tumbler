"""The relative view is drawn sharp, and the fourth Lit setting shows everything with the
results highlighted (task t21; deviation d8 of the relative-search plan, the owner's decision
of 2026-11-17).

One session on the standalone page as a host gets it (``viewer write``), on the shipped
Wikipedia demo pair, ``index.html?relative=1&seed=3``, with a search from Rice. Reduced motion
is on, so the page starts paused with no twinkle and the settled relative view is shown at once
(task t19): a picture is then a fixed function of the data, the seed and the settings. Trails
are switched off with the page's own checkbox for the same reason (trails blend the frames
drawn while a search fades in, and how many that is depends on the machine).

**Sharp.** The measure is a comparison inside one page: the same build, the same frame and the
same lit values are drawn twice, once as built and once with the two draw keys the deviation
changes put back to what the relative view had before it (depth of field 1.1 and bloom 0.55,
handed to the renderer by a wrapper around its ``draw``). Nothing else differs, so any
difference is the deviation's. Three things are read off each picture: the pixels at or near
white (every channel at least 200; the owner's complaint was a cloud melting into white), the
pixels brighter than the sky (glow and blur spread light over more of the stage), and the local
maxima of brightness (separate dots: a blurred cloud has fewer). As measured on SwiftShader
when this was written, sharp against before: 228 against 852 near-white pixels, 33,583 against
48,322 lit pixels, 480 against 414 maxima.

**Everything, results highlighted.** Chosen in the panel's Lit menu, as a person would. The
summed light of the stage under it lies between "named results only" (the rest on the gradient
the relative view fades it with) and the same setting drawn with the keys from before the deviation
(measured 8.4, 14.5 and 20.4 million). A result is brighter than a point that is not one where
the two can be told apart: among points with no other point within 14 px, the light within
6 px of every such result is well above that of every such other point (measured: at least
47,692 against at most 24,604). Peak brightness is not used: a result and a point at its usual
brightness both come close to the top of the scale. With Relative off, the stage under the
setting carries about the light it carries with no search (measured 28.4 against 24.3
million), where "the results, evenly" leaves under a sixth of it. The counts do not change.
There is no separate menu for the rest (deviation d9 merged it into Lit).
"""

from __future__ import annotations

import pytest

from tests.browser import harness
from tests.browser import relative_site as rs

STAGE = "#space canvas.tumbler-canvas"
BEFORE_D8 = {"depthOfField": 1.1, "bloom": 0.55}  # what the relative view drew with before d8
ALONE = 14  # CSS px: a point with no other point this near can be measured on its own
DISC = 6  # CSS px: the reach of the light summed around a point

# Text and DOM layers hidden, and the 2-D overlay too: only the points are in the picture.
HIDE = """() => {
  for (const sel of ['.tumbler-masthead', '.tumbler-status', '.tumbler-labels',
                     '.tumbler-notice', '.tumbler-message', '.tumbler-empty', '.tumbler-search',
                     '.tumbler-relative-labels', '.tumbler-overlay']) {
    for (const n of document.querySelectorAll(sel)) n.style.visibility = 'hidden';
  }
}"""

SEARCH_RICE = f"""async () => {{
  const h = {rs.H};
  if (!(await h.setSearchSettings({{ k: 9 }})).ok) return false;
  return (await h.setSearches([{{ point: '{rs.RICE_ID}' }}])).ok;
}}"""

# Hand the renderer the given draw keys over the viewer's own (null: the viewer's own again),
# and ask for a frame.
FORCE = f"""(keys) => {{
  const h = {rs.H}, r = h._viewer.renderer;
  if (!r.__built) r.__built = r.draw;
  r.draw = keys
    ? function (s) {{ return r.__built.call(this, Object.assign({{}}, s, keys)); }}
    : r.__built;
  h.seek(h.time());
  return true;
}}"""

# Where every point is drawn (CSS px on the stage) and whether it is a result, with the draw
# keys of the frame shown.
POINTS = f"""() => {{
  const h = {rs.H}, v = h._viewer, R = EmbeddingsTumbler._internal.renderer;
  const set = v.set, D = set.dimension, F = v.last.frame, C = v.last.centre, pts = [];
  for (let i = 0; i < set.count; i++) {{
    let a = 0, b = 0, c = 0;
    for (let d = 0; d < D; d++) {{
      const x = set.vectors[i * D + d] - C[d];
      a += x * F[d]; b += x * F[D + d]; c += x * F[2 * D + d];
    }}
    const q = R.place([a, b, c], v.lastDraw, v.W, v.H);
    pts.push([q.x / v.dpr, q.y / v.dpr, v.search.lit ? v.search.lit.inside[i] : 0]);
  }}
  const box = document.querySelector('{STAGE}').getBoundingClientRect();
  const s = h.info().search;
  return {{ pts: pts, width: box.width, height: box.height,
    depthOfField: v.lastDraw.depthOfField,
    bloom: v.lastDraw.bloom === undefined ? null : v.lastDraw.bloom,
    setting: s.settings.lit, litCount: s.litCount, relative: s.relative.active }};
}}"""

PANEL = """() => {
  const lit = document.querySelector('.tumbler-search-lit select');
  return { options: [...lit.options].map((o) => [o.value, o.textContent]), lit: lit.value,
    litDisabled: lit.disabled,
    restControl: document.querySelector('.tumbler-search-rest') !== null,
    note: document.querySelector('.tumbler-search-note').textContent };
}"""


def _still(tab: harness.Tab) -> bytes:
    """A screenshot of the stage once two in a row are identical."""
    tab.evaluate(HIDE)
    last = tab.page.locator(STAGE).first.screenshot()
    for _ in range(40):
        tab.page.wait_for_timeout(150)
        now = tab.page.locator(STAGE).first.screenshot()
        if now == last:
            return now
        last = now
    raise AssertionError("the picture never stood still")


def _maxima(grid, width, height) -> int:
    """Pixels brighter than every other within two pixels (ties to the first in reading
    order), at a brightness of 240 or more of 765."""
    count = 0
    for y in range(2, height - 2):
        row = grid[y]
        for x in range(2, width - 2):
            s = row[x]
            if s < 240:
                continue
            top = True
            for dy in (-2, -1, 0, 1, 2):
                near = grid[y + dy]
                for dx in (-2, -1, 0, 1, 2):
                    o = near[x + dx]
                    if o > s or (o == s and (dy, dx) < (0, 0)):
                        top = False
                        break
                if not top:
                    break
            count += top
    return count


def _measure(tab: harness.Tab, maxima: bool = False) -> dict:
    png = _still(tab)
    state = tab.evaluate(POINTS)
    tab.evaluate(rs.SHOW_LAYERS)
    width, height, rows = harness.decode_png(png)
    k = width / state["width"]
    grid = []
    light = lit = white = 0
    for y in range(height):
        row = rows[y]
        line = [0] * width
        for x in range(width):
            r, g, b = row[3 * x], row[3 * x + 1], row[3 * x + 2]
            s = r + g + b
            line[x] = s
            if s > 90:
                lit += 1
                light += s
            if r >= 200 and g >= 200 and b >= 200:
                white += 1
        grid.append(line)

    def around(p) -> int:
        cx, cy, reach = p[0] * k, p[1] * k, DISC * k
        total = 0
        for y in range(max(0, int(cy - reach)), min(height, int(cy + reach) + 2)):
            for x in range(max(0, int(cx - reach)), min(width, int(cx + reach) + 2)):
                if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= reach * reach:
                    total += grid[y][x]
        return total

    pts = state.pop("pts")
    edge = ALONE
    alone = {"results": [], "rest": []}
    for p in pts:
        if not (edge <= p[0] < state["width"] - edge and edge <= p[1] < state["height"] - edge):
            continue
        near = sum(1 for o in pts if (o[0] - p[0]) ** 2 + (o[1] - p[1]) ** 2 <= ALONE * ALONE)
        if near == 1:
            alone["results" if p[2] > 0 else "rest"].append(around(p))
    out = {"light": light, "lit": lit, "white": white, "alone": alone, **state}
    if maxima:
        out["maxima"] = _maxima(grid, width, height)
    return out


def _median(values: list[int]) -> int:
    return sorted(values)[len(values) // 2]


def _lit(tab: harness.Tab, value: str):
    """Choose a Lit setting in the panel's own menu."""
    tab.page.select_option(".tumbler-search-lit select", value)
    tab.wait_for(
        f"() => {rs.H}.info().search",
        lambda s: s["settings"]["lit"] == value and not s["waiting"],
        timeout=rs.WAIT,
        what=f"lit set to {value}",
    )
    tab.page.wait_for_timeout(300)


@pytest.fixture(scope="module")
def folder(tmp_path_factory):
    return rs.build_folder(tmp_path_factory.mktemp("relative-sharp"))


@pytest.fixture(scope="module")
def seen(browser, webgl, folder):
    out: dict = {}
    with harness.Server(folder) as server:
        tab = harness.Tab(browser, viewport=(1280, 900), reduced_motion="reduce")
        try:
            tab.goto(server.url("/index.html?relative=1&seed=3"))
            tab.wait_for(rs.READY, timeout=rs.WAIT, what="the standalone page")
            if tab.evaluate(f"() => {rs.H}.info().rendering") is False:
                harness.unavailable("WebGL 2 unavailable in headless Chromium")
            tab.page.click("#space .tumbler-trails-toggle input")
            out["trails"] = tab.evaluate(f"() => {rs.H}._viewer.trails")
            tab.page.click(".tumbler-search-bar")  # the panel open from the start: one layout
            tab.page.wait_for_timeout(300)
            out["none"] = _measure(tab)  # no search: the plain view, whatever Relative says

            assert tab.evaluate(SEARCH_RICE)
            rs.settled(tab, 1, "Rice relative")
            tab.page.wait_for_timeout(1500)  # the search has faded in
            out["panel_even"] = tab.evaluate(PANEL)
            out["sharp"] = _measure(tab, maxima=True)
            tab.evaluate(FORCE, BEFORE_D8)
            out["before"] = _measure(tab, maxima=True)
            tab.evaluate(FORCE, None)

            _lit(tab, "all")
            out["panel_all"] = tab.evaluate(PANEL)
            out["all"] = _measure(tab)
            tab.evaluate(FORCE, BEFORE_D8)
            out["all_before"] = _measure(tab)
            tab.evaluate(FORCE, None)

            _lit(tab, "named")
            out["panel_named"] = tab.evaluate(PANEL)
            out["named"] = _measure(tab)

            # Relative off: the plain view, under "all" and under "even".
            _lit(tab, "all")
            tab.page.click(".tumbler-search-relative input")
            tab.wait_for(
                f"() => {rs.H}.info().search.relative",
                lambda r: r["relative"] is False and r["active"] is False,
                timeout=rs.WAIT,
                what="relative off",
            )
            tab.page.wait_for_timeout(1500)
            out["plain_all"] = _measure(tab)
            _lit(tab, "even")
            out["plain_even"] = _measure(tab)
            out["address"] = tab.evaluate("() => location.search")
            out["errors"] = tab.console_errors()
            out["foreign"] = tab.foreign_requests(server.origin)
        finally:
            tab.close()
    return out


def test_the_settled_relative_view_draws_with_no_depth_blur_and_bloom_02(seen):
    assert seen["trails"] is False
    for name in ("sharp", "all", "named"):
        s = seen[name]
        assert s["relative"] is True, name
        assert s["depthOfField"] == 0, (name, s["depthOfField"], s["bloom"])
        assert s["bloom"] == 0.2, (name, s["depthOfField"], s["bloom"])
    # The plain view, with and without a search, keeps Tumble's own depth of field and the
    # renderer's default bloom (the key left out).
    for name in ("none", "plain_all", "plain_even"):
        s = seen[name]
        assert s["relative"] is False, name
        assert s["depthOfField"] == pytest.approx(1.1), name
        assert s["bloom"] is None, name


def test_the_relative_view_is_sharper_than_with_the_keys_from_before(seen):
    sharp, before = seen["sharp"], seen["before"]
    # the same frame and lit values, so the two pictures show the same points
    assert sharp["lit"] > 5000
    assert before["lit"] > 5000
    # far fewer pixels at or near white (measured 228 against 852)
    assert before["white"] > 300, before["white"]
    assert sharp["white"] <= 0.5 * before["white"], (sharp["white"], before["white"])
    # light is spread over less of the stage (measured 33,583 against 48,322)
    assert sharp["lit"] <= 0.85 * before["lit"], (sharp["lit"], before["lit"])
    # and more separate dots can be told apart (measured 480 against 414)
    assert sharp["maxima"] > before["maxima"], (sharp["maxima"], before["maxima"])


def test_the_lit_menu_has_the_fourth_option_and_it_reaches_the_viewer(seen):
    assert seen["panel_even"]["options"] == [
        ["even", "the results, evenly"],
        ["close", "by closeness: nearer is brighter"],
        ["named", "named results only"],
        ["all", "everything, results highlighted"],
    ]
    assert seen["panel_even"]["lit"] == "even"  # the default is unchanged
    assert seen["panel_all"]["lit"] == "all"
    assert seen["all"]["setting"] == "all"
    assert "(every other point is shown too)" in seen["panel_all"]["note"]
    # the counts count results under every setting
    assert seen["all"]["litCount"] == seen["sharp"]["litCount"] > 0
    assert "lit" not in seen["address"]  # Lit is not in the address, as before


def test_there_is_no_menu_for_the_rest_under_any_lit_setting(seen):
    for name in ("panel_even", "panel_all", "panel_named"):
        assert seen[name]["restControl"] is False, name
        assert seen[name]["litDisabled"] is False, name


def test_under_everything_the_rest_is_shown_and_the_sharp_keys_hold_it_down(seen):
    named, shown, before = seen["named"], seen["all"], seen["all_before"]
    # between "named results only" and the same setting with the keys from before d8
    # (measured 8.4, 14.5 and 20.4 million)
    assert shown["light"] > 1.3 * named["light"], (shown["light"], named["light"])
    assert shown["light"] < 0.85 * before["light"], (shown["light"], before["light"])
    # a point on its own that is not a result carries more light than under the gradient
    assert len(shown["alone"]["rest"]) >= 3
    assert len(named["alone"]["rest"]) >= 3
    # (measured medians 23,817 against 15,223)
    assert _median(shown["alone"]["rest"]) > 1.25 * _median(named["alone"]["rest"]), (
        shown["alone"]["rest"],
        named["alone"]["rest"],
    )


def test_under_everything_a_result_is_brighter_than_a_point_that_is_not_one(seen):
    alone = seen["all"]["alone"]
    assert len(alone["results"]) >= 3, alone
    assert len(alone["rest"]) >= 3, alone
    # measured: every result at least 47,692, every other point at most 24,604
    assert min(alone["results"]) > 1.4 * max(alone["rest"]), alone
    # the results are drawn as under "the results, evenly" (the glow of brighter neighbours
    # adds under half a percent)
    assert alone["results"] == pytest.approx(seen["sharp"]["alone"]["results"], rel=0.02)


def test_with_relative_off_everything_is_about_as_bright_as_with_no_search(seen):
    none, shown, even = seen["none"], seen["plain_all"], seen["plain_even"]
    # measured 24.3 (no search), 28.4 (everything) and 3.8 (the results, evenly) million
    assert 0.9 * none["light"] < shown["light"] < 1.35 * none["light"], (
        shown["light"],
        none["light"],
    )
    assert even["light"] < 0.4 * none["light"], (even["light"], none["light"])
    alone = shown["alone"]
    if alone["results"] and alone["rest"]:
        assert min(alone["results"]) > max(alone["rest"]), alone


def test_nothing_went_wrong_in_the_page(seen):
    assert seen["errors"] == []
    assert seen["foreign"] == []
