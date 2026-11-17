"""The three delivery forms turn relative on and show the same pinned axis; Pause and reduced
motion stop the tour (task t13 of the relative-search plan; obligations o10 and o14 of the
spec).

The same data (the shipped Wikipedia demo pair), the same seed and the same search (Rice, from
its point) in each form, each with the Relative setting given the form's own way:

* the script form: a plain page that loads the core file; ``mount(el, { relative: true })``
  and ``update`` with the pair fetched by the page, as ``js/api/50-viewer.md`` tells a host;
* the web component: ``<embeddings-tumbler src=... relative>`` and nothing else, served under
  the header ``script-src 'self'``;
* the standalone page: ``index.html?relative=1``.

Asserted: each reports the setting on and pins one vertical axis to search A; the frame's
vertical row is Rice's direction (within 1e-6) in all three; the window, the ruler and the
named results' heights agree between the forms. Pause (the handle in the script form, the
Pause button in the standalone page) stops the mode's time and every drawn result while the
viewer keeps drawing, and Resume moves them again. With reduced motion the standalone page
starts paused and the mode's time stays at 0 after the search; the settled relative view, with
its exact ruler, is drawn at once without pressing Play (task t19: with the clock still, a change
has no turn), and stays settled once resumed.

An old address (deviation d9): the setting "The rest" and the page's ``rest=`` parameter were
removed before any release. ``?relative=1&rest=faint`` loads with no page error, shows the
relative view with the one fade there is (the fade values handed to the renderer are those of
the address without the parameter, and above what "faint" could give), has no such control, and
the parameter stays in the address untouched. The two pictures are not compared: two loads of
the same address differed by 2.6 percent of the stage's light when this was written (cause not
looked into), so pixels would not tell the two apart.
"""

from __future__ import annotations

import pytest

from tests.browser import harness
from tests.browser import relative_site as rs

SCRIPT_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>relative script form</title>
</head>
<body>
<div id="space" style="width:1100px;height:700px"></div>
<script src="embeddings-tumbler.js"></script>
</body>
</html>
"""

COMPONENT_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>relative web component form</title>
</head>
<body>
<embeddings-tumbler id="space" src="demo-wikipedia.json" seed="3" relative
  style="display:block;width:1100px;height:700px"></embeddings-tumbler>
<script src="embeddings-tumbler.js"></script>
<script src="web-component.js"></script>
</body>
</html>
"""

MOUNT = """async () => {
  const el = document.getElementById('space');
  const h = EmbeddingsTumbler.mount(el, { seed: 3, relative: true });
  const meta = await (await fetch('demo-wikipedia.json')).json();
  const block = await (await fetch(meta.vectors.file)).arrayBuffer();
  h.update({ ...meta, vectors: block });
  return true;
}"""

READY = f"""() => {{
  const h = window.EmbeddingsTumbler && document.getElementById('space')
    && {rs.H};
  return !!h && h.info().ready && h.info().frames > 2;
}}"""

SEARCH_RICE = f"""async () => {{
  const h = {rs.H};
  if (!(await h.setSearchSettings({{ k: 9 }})).ok) return false;
  return (await h.setSearches([{{ point: '{rs.RICE_ID}' }}])).ok;
}}"""

# Row 1 of the mode's frame dotted with Rice's unit vector, and the frame's head.
VERTICAL = f"""() => {{
  const v = {rs.H}._viewer, D = v.set.dimension, f = v.last.frame;
  const at = v.set.ids.indexOf('{rs.RICE_ID}') * D;
  let qq = 0, rq = 0, rr = 0;
  for (let j = 0; j < D; j++) {{
    const q = v.set.vectors[at + j], r = f[D + j];
    qq += q * q; rq += r * q; rr += r * r;
  }}
  return {{ cos: rq / Math.sqrt(qq * rr), head: Array.from(f.slice(D, D + 4)) }};
}}"""

STILL = f"""() => {{
  const h = {rs.H}, v = h._viewer, d = v.relativeDrawn;
  return {{ time: h.time(), paused: h.isPaused(), draw: v.drawTime, frames: h.info().frames,
    at: d ? d.results.map((r) => [r.x, r.y]) : null,
    settled: !!(d && d.settled), active: h.info().search.relative.active }};
}}"""

# The fade the relative view gives the points that are not results, as handed to the renderer:
# how many values, their sum and their largest.
LIT_SUM = f"""() => {{
  const g = {rs.H}._viewer.search.gradient;
  if (!g) return {{ count: 0 }};
  let sum = 0, top = 0;
  for (const x of g.values) {{ sum += x; if (x > top) top = x; }}
  return {{ count: g.values.length, sum: sum.toFixed(6), top: top.toFixed(6) }};
}}"""


def _form_state(tab: harness.Tab) -> dict:
    state = rs.settled(tab, 1, "Rice relative")
    return {
        "settings": tab.evaluate(f"() => {rs.H}.relativeSettings()"),
        "relative": state["relative"],
        "hook": state["hook"],
        "vertical": tab.evaluate(VERTICAL),
        "errors": tab.console_errors(),
        "csp": list(tab.csp),
    }


def _paused_still(tab: harness.Tab, pause, resume) -> dict:
    """Pause, let the viewer draw for a second of its drawing time, read; resume, read."""
    pause()
    tab.wait_for(f"() => {rs.H}.isPaused()", what="paused")
    first = tab.evaluate(STILL)
    later = tab.wait_for(
        STILL, lambda s: s["draw"] - first["draw"] >= 1.0, timeout=rs.WAIT, what="drawing on"
    )
    resume()
    moved = tab.wait_for(
        STILL, lambda s: s["time"] - later["time"] >= 1.0, timeout=rs.WAIT, what="resumed"
    )
    return {"first": first, "later": later, "moved": moved}


@pytest.fixture(scope="module")
def folder(tmp_path_factory):
    f = rs.build_folder(tmp_path_factory.mktemp("relative-forms"))
    (f / "relative-script.html").write_text(SCRIPT_PAGE, encoding="utf-8")
    (f / "relative-component.html").write_text(COMPONENT_PAGE, encoding="utf-8")
    return f


@pytest.fixture(scope="module")
def forms(browser, webgl, folder):
    out: dict = {}
    with harness.Server(folder) as plain, harness.Server(folder, csp="script-src 'self'") as strict:
        tab = harness.Tab(browser, viewport=(1280, 900))
        try:
            tab.goto(plain.url("/relative-script.html"))
            assert tab.evaluate(MOUNT)
            tab.wait_for(READY, timeout=rs.WAIT, what="the script form")
            assert tab.evaluate(SEARCH_RICE)
            out["script"] = _form_state(tab)
            out["script"]["pause"] = _paused_still(
                tab,
                lambda: tab.evaluate(f"() => {rs.H}.pause()"),
                lambda: tab.evaluate(f"() => {rs.H}.resume()"),
            )
            out["script"]["foreign"] = tab.foreign_requests(plain.origin)
        finally:
            tab.close()

        tab = harness.Tab(browser, viewport=(1280, 900))
        try:
            tab.goto(strict.url("/relative-component.html"))
            tab.wait_for(READY, timeout=rs.WAIT, what="the web component")
            out["component_property"] = tab.evaluate(
                "() => document.getElementById('space').relative"
            )
            assert tab.evaluate(SEARCH_RICE)
            out["component"] = _form_state(tab)
            out["component"]["foreign"] = tab.foreign_requests(strict.origin)
        finally:
            tab.close()

        tab = harness.Tab(browser, viewport=(1280, 900))
        try:
            tab.goto(plain.url("/index.html?relative=1&seed=3"))
            tab.wait_for(READY, timeout=rs.WAIT, what="the standalone page")
            out["page_checkbox"] = tab.evaluate(
                "() => document.querySelector('.tumbler-search-relative input').checked"
            )
            assert tab.evaluate(SEARCH_RICE)
            out["page"] = _form_state(tab)
            out["page"]["pause"] = _paused_still(
                tab,
                lambda: tab.page.click("#space .tumbler-play"),
                lambda: tab.page.click("#space .tumbler-play"),
            )
            out["page"]["foreign"] = tab.foreign_requests(plain.origin)
        finally:
            tab.close()

        tab = harness.Tab(browser, viewport=(1280, 900))
        try:
            tab.goto(plain.url("/index.html?relative=1&seed=3"))
            tab.wait_for(READY, timeout=rs.WAIT, what="the standalone page, no rest=")
            assert tab.evaluate(SEARCH_RICE)
            rs.settled(tab, 1, "Rice relative, no rest=")
            out["rest_absent_lit"] = tab.evaluate(LIT_SUM)
            # the same view from an address written while the setting existed
            tab.goto(plain.url("/index.html?relative=1&seed=3&rest=faint"))
            tab.wait_for(READY, timeout=rs.WAIT, what="the standalone page, rest=faint")
            assert tab.evaluate(SEARCH_RICE)
            rs.settled(tab, 1, "Rice relative, rest=faint")
            out["rest_old_lit"] = tab.evaluate(LIT_SUM)
            out["rest_settings"] = tab.evaluate(f"() => {rs.H}.relativeSettings()")
            out["rest_control"] = tab.evaluate(
                "() => document.querySelector('.tumbler-search-rest') !== null"
            )
            out["rest_address"] = tab.evaluate("() => location.search")
            out["rest_errors"] = tab.console_errors()
        finally:
            tab.close()

        tab = harness.Tab(browser, viewport=(1280, 900), reduced_motion="reduce")
        try:
            tab.goto(plain.url("/index.html?relative=1&seed=3"))
            tab.wait_for(READY, timeout=rs.WAIT, what="the standalone page, reduced motion")
            out["reduced_start"] = tab.evaluate(STILL)
            assert tab.evaluate(SEARCH_RICE)
            tab.wait_for(
                f"() => {rs.H}.info().search.relative.active", timeout=rs.WAIT, what="pinned"
            )
            # t19: no Play pressed; the settled ruler is drawn without it
            out["reduced_after"] = tab.wait_for(
                STILL, lambda s: s["settled"], timeout=rs.WAIT, what="settled while paused"
            )
            out["reduced_ruler"] = tab.evaluate(
                f"() => {{ const d = {rs.H}._viewer.relativeDrawn;"
                " return { ruler: !!d.ruler, results: d.results.length, labels: d.labels }; }"
            )
            tab.evaluate(f"() => {rs.H}.resume()")
            out["reduced_resumed"] = rs.settled(tab, 1, "Rice relative once resumed")["relative"]
            out["reduced_errors"] = tab.console_errors()
        finally:
            tab.close()
    return out


FORMS = ["script", "component", "page"]


@pytest.mark.parametrize("form", FORMS)
def test_each_form_turns_relative_on_and_pins_the_vertical_axis_to_the_search(forms, form):
    f = forms[form]
    assert f["settings"] == {"relative": True, "showOrigin": False}
    rel = f["relative"]
    assert rel["relative"] is True and rel["active"] is True and rel["settled"] is True
    assert [(p["letter"], p["axis"]) for p in rel["pinned"]] == [("A", "vertical")]
    assert abs(f["vertical"]["cos"] - 1) < 1e-6, f["vertical"]
    assert len(f["hook"]["results"]) == 8
    assert f["errors"] == [] and f["csp"] == [] and f["foreign"] == []


def test_the_forms_are_given_the_setting_their_own_way(forms):
    assert forms["component_property"] is True
    assert forms["page_checkbox"] is True


def test_the_three_forms_show_the_same_pinned_axis(forms):
    base = forms["script"]
    for form in ("component", "page"):
        f = forms[form]
        assert f["relative"]["pinned"] == base["relative"]["pinned"]
        for key in ("low", "high", "bottom", "top"):
            assert abs(f["relative"]["window"][key] - base["relative"]["window"][key]) < 1e-9
        assert [r["index"] for r in f["hook"]["results"]] == [
            r["index"] for r in base["hook"]["results"]
        ]
        for a, b in zip(f["hook"]["results"], base["hook"]["results"]):
            assert abs(a["height"] - b["height"]) < 1e-9
        for key in ("from", "to"):
            assert abs(f["hook"]["ruler"][key] - base["hook"]["ruler"][key]) < 1e-9
        for a, b in zip(f["vertical"]["head"], base["vertical"]["head"]):
            assert abs(a - b) < 1e-6


@pytest.mark.parametrize("form", ["script", "page"])
def test_pause_stops_the_tour_and_resume_moves_it_again(forms, form):
    p = forms[form]["pause"]
    first, later, moved = p["first"], p["later"], p["moved"]
    assert first["paused"] and later["paused"] and not moved["paused"]
    assert later["frames"] > first["frames"]  # the viewer drew on while paused
    assert later["time"] == first["time"]
    assert later["at"] == first["at"] and len(first["at"]) == 8
    assert later["settled"] and moved["settled"]
    assert moved["time"] - later["time"] >= 1.0
    assert moved["at"] != later["at"]


def test_reduced_motion_stops_the_tour(forms):
    start, after = forms["reduced_start"], forms["reduced_after"]
    assert start["paused"] is True and after["paused"] is True
    assert start["time"] == 0 and after["time"] == 0
    assert after["active"] is True  # the search pins the axis ...
    # ... and, with motion stopped, the settled view is shown at once (t19; before t19 it
    # waited for Play, which this test asserted as settled False)
    assert after["settled"] is True
    assert forms["reduced_resumed"]["settled"] is True
    assert forms["reduced_errors"] == []


def test_reduced_motion_draws_the_settled_ruler_without_play(forms):
    ruler = forms["reduced_ruler"]
    assert ruler["ruler"] is True
    assert ruler["results"] > 0  # stems to the named results: the ruler is drawn as exact
    assert ruler["labels"] > 0


def test_an_old_address_with_rest_loads_as_without_it_and_keeps_the_parameter(forms):
    assert forms["rest_errors"] == []
    assert forms["rest_settings"] == {"relative": True, "showOrigin": False}
    assert forms["rest_control"] is False
    # the parameter is left alone: neither read nor removed
    assert "rest=faint" in forms["rest_address"]
    assert "relative=1" in forms["rest_address"]
    # the lit values handed to the renderer are those of the address without it
    assert forms["rest_old_lit"] == forms["rest_absent_lit"]
    fade = forms["rest_old_lit"]
    assert fade["count"] == 999
    # every value is at least the base 0.2, and the largest is above 0.2, which was the most
    # "faint" (0 + 0.2 g^2) could give
    assert float(fade["sum"]) >= 0.2 * fade["count"] - 1e-3
    assert 0.2 < float(fade["top"]) <= 0.8 + 1e-6
