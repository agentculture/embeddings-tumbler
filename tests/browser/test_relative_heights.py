"""The relative view on the shipped Wikipedia demo pair, in the standalone page (task t13 of
the relative-search plan; obligations o1, o5, o6, o11, o12 of the spec).

One page at desktop size and one at phone size. On the desktop page a person's steps, in
order: type Rice in the search box, tick Relative, watch it tumble for 30 seconds of mode
time, add Wheat, tick Show the origin, untick Relative, untick Show the origin. What each
test asserts:

* the eight named results (Rice's own point is the first result and is drawn as the search,
  so nine are asked for) are the eight nearest by cosine recomputed here from the pair, at the
  heights their cosines map to on the ruler, and no result's drawn height moves by more than
  1 pixel during the 30 seconds while the other axes visibly tumble;
* untilted, at both widths, each result is drawn within 2 percent of the ruler's visible
  length of the ruler's own point at the same height (the drawn point of equal height at depth
  zero), sampled over every frame; and the points on the stage are where the hook says (a
  screenshot of the paused stage, so the renderer under test really drew them there);
* the request log is unchanged by turning relative on and off, adding a search and showing
  the origin;
* with Show the origin in the plain view the marker gives the centre's true distance from the
  origin, recomputed here from the pair.

The renderer is SwiftShader unless ``TUMBLER_BROWSER_RENDERER=gpu``; it is in every test id.
"""

from __future__ import annotations

import math

import pytest

from tests.browser import harness
from tests.browser import relative_site as rs

DEMO_JSON = rs.STATIC / "demo-wikipedia.json"
NAMED = 8  # other points compared: the eight nearest to Rice
TUMBLE_SECONDS = 30.0
PHONE_SECONDS = 8.0
FLAT_SHARE = 0.02  # equal heights within 2 percent of the ruler's visible length
HOLD_PX = 1.0  # a drawn height moves by at most a pixel while it tumbles
DRAWN_PX = 1.5  # a point on the stage is within this of where the hook says it is drawn

TYPE = """(text) => {
  const box = document.querySelector('.tumbler-search-input');
  box.value = text;
  box.dispatchEvent(new Event('input'));
}"""
CHECK = """([sel, on]) => {
  const box = document.querySelector(sel + ' input');
  if (box.checked !== on) box.click();
  return box.checked;
}"""
ORIGIN_TEXT = """() => {
  const n = [...document.querySelectorAll('.tumbler-relative-label')]
    .find((s) => s.style.display !== 'none' && s.textContent.startsWith('origin'));
  return n ? n.textContent : null;
}"""


@pytest.fixture(scope="module")
def demo():
    meta, rows = rs.load_pair(DEMO_JSON)
    rice = rs.index_of(meta, rs.RICE_ID)
    cosines, heights = rs.along(rows, rows[rice])
    ranked = rs.nearest(cosines, NAMED + 1)
    assert ranked[0] == rice, "Rice is its own nearest point"
    mean = [math.fsum(col) / len(rows) for col in zip(*rows)]
    return {
        "meta": meta,
        "rice": rice,
        "named": ranked[1:],
        "cosine": {i: cosines[i] for i in ranked},
        "height": {i: heights[i] for i in ranked},
        "centre_length": rs.norm(mean),
        "lengths": (min(map(rs.norm, rows)), max(map(rs.norm, rows))),
    }


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    folder = rs.build_folder(tmp_path_factory.mktemp("relative-heights"))
    with harness.Server(folder) as srv:
        yield srv


def _ruler_y(ruler: dict, height: float, dpr: float) -> float:
    f = (height - ruler["from"]) / (ruler["to"] - ruler["from"])
    return (ruler["y0"] + f * (ruler["y1"] - ruler["y0"])) / dpr


@pytest.fixture(scope="module")
def desktop(browser, webgl, server):
    tab = rs.open_page(browser, server.url("/index.html?seed=3"), viewport=(1280, 900))
    out: dict = {"webgl": webgl}
    try:
        out["baseline"] = len(tab.requests)
        out["log_live"] = sorted(
            {r["url"].rsplit("/", 1)[-1].split("?", 1)[0] for r in tab.requests}
        )
        tab.page.click(".tumbler-search-bar")
        assert tab.evaluate(f"async () => (await {rs.H}.setSearchSettings({{ k: 9 }})).ok")
        tab.evaluate(TYPE, "Rice")
        tab.wait_for(
            f"() => {{ const s = {rs.H}.info().search; return !s.waiting && s.searches.length === 1"
            " && s.searches[0].results.length === 9; }",
            timeout=rs.WAIT,
            what="the search Rice",
        )
        out["off"] = tab.evaluate(f"() => [{rs.H}._viewer.relativeDrawn, {rs.H}.info().status]")
        out["checked"] = tab.evaluate(CHECK, [".tumbler-search-relative", True])
        out["one"] = rs.settled(tab, 1, "Rice relative")
        out["labels"] = tab.evaluate(rs.LABELS)
        out["status"] = tab.wait_for(
            f"() => {rs.H}.info().status",
            lambda t: ", exact" in t,
            timeout=rs.WAIT,
            what="the status line to say the vertical axis is exact",
        )
        out["address"] = tab.evaluate("() => location.search")
        out["sample"] = rs.sample(tab, TUMBLE_SECONDS)
        out["pixels"] = rs.drawn_points_match(tab)
        tab.evaluate(f"() => {rs.H}.resume()")

        tab.evaluate(TYPE, "Rice\nWheat")
        out["two"] = rs.settled(tab, 2, "Rice and Wheat relative")
        tab.evaluate(CHECK, [".tumbler-search-origin", True])
        out["origin_relative"] = tab.wait_for(
            f"() => {{ const d = {rs.H}._viewer.relativeDrawn; return d && d.settled && d.origin"
            f" && {rs.H}.info().search.relative.showOrigin ? d.origin : null; }}",
            timeout=rs.WAIT,
            what="the origin in the relative view",
        )
        tab.evaluate(CHECK, [".tumbler-search-relative", False])
        out["origin_plain"] = tab.wait_for(
            f"""() => {{ const h = {rs.H}, v = h._viewer, d = v.relativeDrawn;
              const r = h.info().search.relative;
              if (r.relative || r.active || v.last.relative || !d || !d.origin || d.ruler) {{
                return null;
              }}
              const n = [...document.querySelectorAll('.tumbler-relative-label')]
                .find((s) => s.style.display !== 'none' && s.textContent.startsWith('origin'));
              return n ? {{ origin: d.origin, text: n.textContent }} : null; }}""",
            timeout=rs.WAIT,
            what="the origin marker in the plain view",
        )
        tab.evaluate(CHECK, [".tumbler-search-origin", False])
        out["cleared"] = tab.wait_for(
            f"() => {rs.H}._viewer.relativeDrawn === null"
            f" && !{rs.H}.info().search.relative.showOrigin",
            timeout=rs.WAIT,
            what="nothing of the overlay drawn",
        )
        tab.page.wait_for_timeout(500)
        out["after"] = len(tab.requests)
        out["new_requests"] = tab.requests[out["baseline"] :]
        out["foreign"] = tab.foreign_requests(server.origin)
        out["errors"] = tab.console_errors()
    finally:
        tab.close()
    return out


@pytest.fixture(scope="module")
def phone(browser, webgl, server):
    tab = rs.open_page(browser, server.url("/index.html?seed=3&relative=1"), viewport=(390, 844))
    out: dict = {}
    try:
        assert tab.evaluate(f"async () => (await {rs.H}.setSearchSettings({{ k: 9 }})).ok")
        assert tab.evaluate(f"async () => (await {rs.H}.setSearches(['Rice'])).ok")
        out["one"] = rs.settled(tab, 1, "Rice relative at phone width")
        out["sample"] = rs.sample(tab, PHONE_SECONDS)
        out["pixels"] = rs.drawn_points_match(tab)
        out["errors"] = tab.console_errors()
    finally:
        tab.close()
    return out


# --------------------------------------------------------------------------- criterion 1


def test_the_named_results_are_the_nearest_by_cosine_recomputed_from_the_pair(desktop, demo):
    hook = desktop["one"]["hook"]
    assert [r["index"] for r in hook["results"]] == demo["named"]
    rel = desktop["one"]["relative"]
    assert rel["measure"] == "cosine"
    assert [p["axis"] for p in rel["pinned"]] == ["vertical"]
    listed = rel["searches"][0]["results"]
    assert [r["index"] for r in listed] == [demo["rice"]] + demo["named"]
    for r in listed:
        assert abs(r["cosine"] - demo["cosine"][r["index"]]) < 1e-6, r
        assert abs(r["height"] - demo["height"][r["index"]]) < 1e-6, r


def test_the_named_results_are_drawn_at_the_heights_their_cosines_map_to(desktop, demo):
    hook = desktop["one"]["hook"]
    ruler, dpr = hook["ruler"], hook["dpr"]
    assert hook["settled"] is True
    for r in hook["results"]:
        expected = demo["cosine"][r["index"]]
        assert abs(r["height"] - expected) < 1e-5, r
        # the stem's end on the ruler is where the cosine maps to on the ruler
        assert abs(r["rulerY"] / dpr - _ruler_y(ruler, expected, dpr)) < 0.5, r
        # and the point itself is drawn at that height, up to the flatness allowance
        length = math.hypot(ruler["x1"] - ruler["x0"], ruler["y1"] - ruler["y0"]) / dpr
        assert abs(r["y"] / dpr - _ruler_y(ruler, expected, dpr)) <= FLAT_SHARE * length, r


def test_no_result_moves_by_more_than_a_pixel_during_30_seconds_of_tumbling(desktop, demo):
    s = desktop["sample"]
    assert s["t1"] - s["t0"] >= TUMBLE_SECONDS
    assert s["frames"] >= 200, s["frames"]
    assert s["unsettled"] == 0, s["unsettled"]
    assert sorted(int(k) for k in s["per"]) == sorted(demo["named"])
    moved = {k: p["y"][1] - p["y"][0] for k, p in s["per"].items()}
    swept = {k: p["x"][1] - p["x"][0] for k, p in s["per"].items()}
    print(
        f"30 s, {s['frames']} frames: drawn height moved at most {max(moved.values()):.3f} px;"
        f" sideways sweep {min(swept.values()):.0f} to {max(swept.values()):.0f} px"
    )
    for k, p in s["per"].items():
        assert p["n"] == s["frames"], (k, p["n"])
        assert moved[k] <= HOLD_PX, (k, p["y"])
        assert p["rulerY"][1] - p["rulerY"][0] <= HOLD_PX, (k, p["rulerY"])
    # the control: the free axes really tumbled, so a frozen view cannot pass
    assert max(swept.values()) > 50, swept
    assert s["rulerY0"][1] - s["rulerY0"][0] <= HOLD_PX
    assert s["rulerY1"][1] - s["rulerY1"][0] <= HOLD_PX


# --------------------------------------------------------------------------- criterion 2


def _flatness(view: dict, label: str) -> float:
    s = view["sample"]
    assert s["frames"] > 0
    assert s["unsettled"] == 0
    assert s["maxPitch"] < 1e-9, s["maxPitch"]  # untilted
    assert s["perspective"] == [60, 60], s["perspective"]  # the flat view, every frame
    worst = max(p["err"] for p in s["per"].values())
    spread = max(p["signed"][1] for p in s["per"].values()) - min(
        p["signed"][0] for p in s["per"].values()
    )
    print(
        f"{label}: {s['frames']} frames x {len(s['per'])} results; worst distance from the ruler"
        f" point of equal height {100 * worst:.3f}% of the ruler ({s['rulerLen'][0]:.0f} px);"
        f" spread of signed distances {100 * spread:.3f}%"
    )
    return worst


@pytest.mark.parametrize("which", ["desktop", "phone"])
def test_equal_heights_are_drawn_within_2_percent_of_the_ruler(which, request, webgl):
    view = request.getfixturevalue(which)
    assert _flatness(view, which) <= FLAT_SHARE


@pytest.mark.parametrize("which", ["desktop", "phone"])
def test_the_renderer_draws_the_points_where_the_hook_places_them(which, request, webgl):
    found = request.getfixturevalue(which)["pixels"]
    assert found["same_after"], "the paused view moved while the screenshot was taken"
    hook = found["hook"]
    k = hook["dpr"] or 1
    assert len(hook["results"]) == NAMED
    off = []
    for r, f in zip(hook["results"], found["found"]):
        assert f is not None, f"nothing drawn near result {r['index']} at {r['x'] / k, r['y'] / k}"
        off.append(math.hypot(f["x"] - r["x"] / k, f["y"] - r["y"] / k))
    print(f"{which} on {webgl}: drawn points within {max(off):.2f} px of the hook's positions")
    assert max(off) <= DRAWN_PX, off


# --------------------------------------------------------------------------- criterion 3


def test_relative_on_and_off_searches_and_the_origin_make_no_request(desktop):
    assert {"index.html", "embeddings-tumbler.js", "demo-wikipedia.f32"} <= set(
        desktop["log_live"]
    ), desktop["log_live"]
    assert desktop["checked"] is True
    assert desktop["new_requests"] == [], desktop["new_requests"]
    assert desktop["after"] == desktop["baseline"]
    assert desktop["foreign"] == []
    assert desktop["errors"] == []


# --------------------------------------------------------------------------- the rest


def test_relative_off_draws_nothing_of_the_overlay(desktop):
    hook, status = desktop["off"]
    assert hook is None
    assert not status.startswith("relative to")


def test_the_status_and_the_ruler_title_say_cosine_on_the_unit_length_set(desktop, demo):
    lo, hi = demo["lengths"]
    assert hi - lo < 1e-3  # the set is unit length, so the measure is cosine
    assert desktop["status"].startswith("relative to A · vertical = cosine to A, exact")
    assert "cosine to A" in desktop["labels"]
    assert "relative=1" in desktop["address"]


def test_a_second_search_pins_the_horizontal_axis(desktop):
    rel = desktop["two"]["relative"]
    assert [(p["letter"], p["axis"]) for p in rel["pinned"]] == [
        ("A", "vertical"),
        ("B", "horizontal"),
    ]


def test_the_origin_marker_gives_the_centres_true_distance(desktop, demo):
    text = desktop["origin_plain"]["text"]
    far = demo["centre_length"]
    print(f"plain view origin text: {text!r}; centre length from the pair {far:.4f}")
    assert text.startswith(f"origin · truly {far:.2f} from the centre, ")
    assert abs(desktop["origin_plain"]["origin"]["far"] - far) < 1e-4
    assert desktop["origin_relative"] is not None
    assert desktop["cleared"] is True
