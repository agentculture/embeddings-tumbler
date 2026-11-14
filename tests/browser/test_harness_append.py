"""An append through ``update()`` adds visible points without a page reload (t14 criterion 5).

Script form (``EmbeddingsTumbler.update(el, data)``) and web-component form (``el.update(data)``,
under ``script-src 'self'``), on the twin-blobs set (two ungrouped blobs at +3 and -3 along the
first axis; ``harness.write_twin_blobs``). The append is ``fixture-data.js``'s ``arrivals``:
40 points in a tight cluster at the origin, the empty space between the blobs, in a new group,
so they take the first group colour (orange) where every base point is the ungrouped blue.

How it is made deterministic: reduced motion is emulated, so the viewer starts paused with no
twinkle and goes idle once it has drawn; two screenshots of the canvas taken 300 ms apart are
asserted identical before the append. While paused an append does not move the frame. So the
picture before and after differs only by what the append did.

One workaround, for defect D1 (see ``test_tumble_finishes_preparing_under_reduced_motion``
below): under reduced motion the viewer goes idle before Tumble has finished fitting its
directions, so the test wakes it with the public ``handle.refreshTheme()`` until the status
line no longer says it is still finding them. Without that the append itself would finish the
fit and the whole view would change with it.

Measured: no navigation (a marker on ``window`` survives, one navigation entry, no new document
request, no main-frame navigation event); the viewer's count rises 300 -> 340; orange pixels go
from none to a tight patch near the centre of the canvas; inside that patch's box the number
of lit pixels goes from (nearly) none to many. The rest of the cloud may also change a little
in brightness when the count grows; that is not asserted either way.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

FORMS = {
    # id: (page, csp, element id, append call)
    "script": (
        "script-host.html",
        None,
        "space",
        "(d) => window.EmbeddingsTumbler.update(document.getElementById('space'), d)",
    ),
    "web-component": (
        "component-host.html",
        "script-src 'self'",
        "wc",
        "(d) => document.getElementById('wc').update(d)",
    ),
}

INFO = """(id) => {
  const h = window.EmbeddingsTumbler && window.EmbeddingsTumbler.get(document.getElementById(id));
  if (!h) return null;
  const i = h.info();
  return { count: i.count, frames: i.frames, ready: i.ready, paused: i.paused,
           status: i.status, rendering: i.rendering, message: i.message };
}"""
NUDGE = """(id) => { const h = window.EmbeddingsTumbler.get(document.getElementById(id));
  h.refreshTheme(); return h.info().status; }"""
STILL_FITTING = "finding the strongest directions"
NAV_STATE = """() => ({ marker: window.__c5marker || null,
  entries: performance.getEntriesByType('navigation').length })"""


def orange(r: int, g: int, b: int) -> bool:
    """The first group colour, hsl(28 90% 62%), and not the ungrouped blue (#8cadff)."""
    return r > b + 60 and r > 120


def _canvas(tab, el_id) -> bytes:
    return tab.png(f"#{el_id} canvas.tumbler-canvas")


@pytest.fixture(params=list(FORMS))
def appended(request, open_tab, site, webgl):
    page, csp, el_id, call = FORMS[request.param]
    tab = open_tab(reduced_motion="reduce")
    server = site(csp)
    tab.goto(server.url(page))
    info = tab.wait_for(INFO, lambda i: bool(i and i["count"] == 300 and i["frames"]), arg=el_id)
    assert info["paused"] is True, "reduced motion starts the viewer paused"
    tab.wait_for(NUDGE, lambda s: STILL_FITTING not in s, arg=el_id, interval=0.05)
    tab.page.wait_for_timeout(300)
    tab.evaluate("() => { window.__c5marker = 'kept-' + Math.random(); }")
    nav0 = tab.evaluate(NAV_STATE)
    docs0, navs0 = len(tab.document_requests()), len(tab.main_navigations)
    before = _canvas(tab, el_id)
    tab.page.wait_for_timeout(300)
    again = _canvas(tab, el_id)
    frames0 = tab.evaluate(INFO, el_id)["frames"]
    base = tab.evaluate(
        "(id) => window.EmbeddingsTumbler.get(document.getElementById(id)).info()", el_id
    )
    payload_call = (
        "([id, base]) => { const d = window.__fixtureData.arrivals(base, 40, 14); return ("
        + call
        + ")(d); }"
    )
    result = tab.evaluate(
        payload_call, [el_id, {"model": base["model"], "dimension": base["dimension"]}]
    )
    info = tab.wait_for(
        INFO, lambda i: i["count"] == 340 and i["frames"] > frames0, arg=el_id, what="append"
    )
    tab.page.wait_for_timeout(500)
    after = _canvas(tab, el_id)
    return {
        "form": request.param,
        "tab": tab,
        "origin": server.origin,
        "before": before,
        "again": again,
        "after": after,
        "result": result,
        "info": info,
        "nav0": nav0,
        "nav1": tab.evaluate(NAV_STATE),
        "docs": (docs0, len(tab.document_requests())),
        "navs": (navs0, len(tab.main_navigations)),
    }


def test_c5_append_adds_visible_points_without_a_reload(appended):
    a = appended
    # No reload, no navigation.
    assert a["nav1"]["marker"] == a["nav0"]["marker"] and a["nav0"]["marker"]
    assert a["nav1"]["entries"] == a["nav0"]["entries"] == 1
    assert a["docs"][1] == a["docs"][0] == 1, "a new document request: the page was reloaded"
    assert a["navs"][1] == a["navs"][0], "the main frame navigated"
    # The viewer took the points.
    assert a["result"] == {"ok": True, "op": "append", "count": 340, "added": 40}
    assert a["info"]["count"] == 340
    # The picture: identical when nothing happens, then the new points where there were none.
    assert a["before"] == a["again"], "the paused picture is not stable, so a diff means nothing"
    width, height, orange_before = harness.pixel_mask(a["before"], orange)
    _, _, orange_after = harness.pixel_mask(a["after"], orange)
    assert len(orange_before) == 0, "the base set has no orange points"
    assert len(orange_after) >= 30, f"only {len(orange_after)} orange pixels after the append"
    x0, y0, x1, y1 = harness.bbox(orange_after)
    assert x1 - x0 < width * 0.1 and y1 - y0 < height * 0.15, "the arrivals are a tight cluster"
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    assert abs(cx - width / 2) < width * 0.1 and abs(cy - height / 2) < height * 0.2, (
        "the cluster sits at the data's centre, between the blobs",
        (cx, cy),
    )
    box = (x0 - 4, y0 - 4, x1 + 4, y1 + 4)
    _, _, lit_before = harness.pixel_mask(a["before"], harness.bright())
    _, _, lit_after = harness.pixel_mask(a["after"], harness.bright())

    def inside(points):
        return {p for p in points if box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3]}

    print(
        f"{a['form']}: lit {len(lit_before)} -> {len(lit_after)}; orange 0 -> "
        f"{len(orange_after)} in box {box}; lit in box {len(inside(lit_before))} -> "
        f"{len(inside(lit_after))}"
    )
    assert len(inside(lit_before)) <= 5, "the arrivals' place was not empty before"
    assert len(inside(lit_after)) >= 30, "no newly lit pixels where the arrivals went"
    a["tab"].assert_no_console_errors()
    a["tab"].assert_no_csp_violations()
    a["tab"].assert_no_foreign_requests(a["origin"])


def test_c5_negative_control_a_reload_is_detected(open_tab, site):
    """The no-reload checks above would catch a reload: after one, the marker is gone and the
    log holds a second document request and a second main-frame navigation."""
    tab = open_tab()
    tab.goto(site().url("script-host.html"))
    tab.wait_for("() => window.__host && window.__host.state", lambda s: s != "loading")
    tab.evaluate("() => { window.__c5marker = 'kept'; }")
    tab.page.reload()
    tab.wait_for("() => !!window.__host")
    assert tab.evaluate(NAV_STATE)["marker"] is None
    assert len(tab.document_requests()) == 2
    assert len(tab.main_navigations) == 2


@pytest.mark.xfail(
    strict=True,
    reason=(
        "defect D1 (shipped code, reported to the main agent, not fixed here): with "
        "prefers-reduced-motion the viewer goes idle before Tumble has finished fitting its "
        "directions, so the status stays at 'finding the strongest directions ... N% · paused' "
        "and the fit never completes until input, a resize, a theme change or data wakes it"
    ),
)
def test_tumble_finishes_preparing_under_reduced_motion_without_input(open_tab, site, webgl):
    tab = open_tab(reduced_motion="reduce")
    tab.goto(site().url("index.html"))  # the shipped page with the built-in sample set
    tab.wait_for(INFO, lambda i: bool(i and i["count"] and i["frames"]), arg="space")
    tab.page.wait_for_timeout(1000)
    status = tab.wait_for(INFO, lambda i: STILL_FITTING not in i["status"], arg="space", timeout=5)[
        "status"
    ]
    assert "strongest directions" in status
