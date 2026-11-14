"""How search looks on the built-in sample set, corrected after the owner's browser look
(2026-11-14). See docs/search-interface.md, "Corrected after the owner's browser look".

One run of the shipped standalone page (built-in sample set, 12,288 points, 384
dimensions) at 1280 x 900, driven through the public handle. Brightness is counted on a
320 x 180 copy of the stage canvas (lit: sum of channels above 60; near white: above 600),
except where a full-size count is said. Each check has a control that shows it can fail.

- Lattice: with a search shown the wires follow it, so the near-white count drops by a
  large factor against the same moment with no search, while the results stay lit.
- Wander: with two identical searches every result carries the shared mark (white); the
  marked results show at several moments of the tour, where before this correction the
  fog had dimmed them away. Control: with no search the same moments have (nearly) no white
  pixel. Counted at full size: 8 results packed close together cover only a few pixels.
- Focus: with a search the view keeps turning at a rate comparable to Tumble's (lit pixels
  change between frames one second apart); control: paused, they do not. No group name is
  drawn in Focus while a search is shown; control: Tumble with the same search draws them.

The counts hold for the ranking of the time (8 results) and for one that lights many more
points: they are ratios and floors, not exact counts.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

H = "window.EmbeddingsTumbler.get(document.getElementById('space'))"
PERIOD = 3.4  # Lattice's swap period (seconds)
T90 = PERIOD * 4 + PERIOD * 0.9  # swap 5, 90% through: the lattice collapses to a thin shape

GRAB = """(full) => new Promise((resolve) => requestAnimationFrame(() => {
  const c = document.querySelector('.tumbler-canvas');
  const w = full ? c.width : 320, h = full ? c.height : 180;
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const x = t.getContext('2d'); x.drawImage(c, 0, 0, w, h);
  const a = x.getImageData(0, 0, w, h).data;
  let lit = 0, hot = 0, white = 0;
  const px = new Uint16Array(w * h);
  for (let i = 0, j = 0; i < a.length; i += 4, j++) {
    const v = a[i] + a[i + 1] + a[i + 2];
    px[j] = v;
    if (v > 60) lit++;
    if (v > 600) hot++;
    if (Math.min(a[i], a[i + 1], a[i + 2]) > 170) white++;
  }
  resolve({ lit: lit, hot: hot, white: white, px: full ? null : Array.from(px) });
}))"""

GROUP_NAMES = """() => [...document.querySelectorAll('.tumbler-labels > *')]
  .filter((e) => e.style.display !== 'none' && e.style.textTransform === 'uppercase')
  .map((e) => e.textContent)"""


def _change(a: list[int], b: list[int]) -> dict:
    union = changed = 0
    for va, vb in zip(a, b, strict=True):
        if va > 60 or vb > 60:
            union += 1
            changed += abs(va - vb) > 45
    return {"union": union, "rate": changed / max(union, 1)}


class _Run:
    def __init__(self, tab: harness.Tab):
        self.tab = tab

    def ev(self, js: str):
        return self.tab.evaluate(js)

    def grab(self, full: bool = False) -> dict:
        return self.tab.evaluate(GRAB, full)

    def ready(self):
        self.tab.wait_for(f"() => {{ const h = {H}; return !!h && h.info().ready; }}", timeout=240)

    def mode(self, name: str):
        self.ev(f"() => {H}.setMode('{name}')")
        self.ready()

    def search(self, texts: list[str]):
        self.ev(f"async () => {{ await {H}.setSearches({texts!r}); }}")
        self.tab.wait_for(f"() => {H}.info().search.litCount", timeout=120)
        self.tab.page.wait_for_timeout(1500)  # the filter eases in (time constant 0.35 s)

    def at(self, t: float, full: bool = False) -> dict:
        self.ev(f"() => {{ const h = {H}; h.pause(); h.seek({t}); }}")
        self.tab.page.wait_for_timeout(700)
        return self.grab(full)

    def motion(self) -> dict:
        a = self.grab()["px"]
        self.tab.page.wait_for_timeout(1000)
        return _change(a, self.grab()["px"])


@pytest.fixture(scope="module")
def look(browser, webgl, site) -> dict:
    server = site()
    tab = harness.Tab(browser, viewport=(1280, 900))
    out: dict = {}
    try:
        tab.goto(server.url("/index.html"))
        run = _Run(tab)
        run.ready()
        # Lattice: the same moment with no search and with one
        run.mode("lattice")
        tab.wait_for(
            "() => /[0-9] wires/.test(document.querySelector('.tumbler-status').textContent)",
            timeout=240,
        )
        tab.page.wait_for_timeout(2000)  # the wires fade in
        out["lattice_none"] = {k: v for k, v in run.at(T90).items() if k != "px"}
        run.search(["tide harbor"])
        out["lattice_search"] = {k: v for k, v in run.at(T90).items() if k != "px"}
        out["lit_count"] = run.ev(f"() => {H}.info().search.litCount")
        # Wander: two identical searches mark every result white
        run.mode("wander")
        out["wander_none"] = [run.at(t, full=True)["white"] for t in (3, 8, 13, 20, 30, 45)]
        run.search(["tide harbor", "harbor tide"])
        out["shared"] = run.ev(f"() => {H}.info().search.sharedCount")
        out["wander_marked"] = [run.at(t, full=True)["white"] for t in (3, 8, 13, 20, 30, 45)]
        # Tumble and Focus with one search, running
        run.search(["tide harbor"])
        run.ev(f"() => {H}.resume()")
        run.mode("tumble")
        tab.page.wait_for_timeout(2500)
        out["tumble_motion"] = run.motion()
        out["tumble_groups"] = run.ev(GROUP_NAMES)
        run.mode("focus")
        tab.page.wait_for_timeout(3000)  # the turn onto the results' fit
        out["focus_motion"] = run.motion()
        out["focus_groups"] = run.ev(GROUP_NAMES)
        run.ev(f"() => {H}.pause()")
        tab.page.wait_for_timeout(500)
        out["focus_paused"] = run.motion()
        tab.assert_no_console_errors()
        return out
    finally:
        tab.close()


def test_lattice_wires_follow_the_search(look):
    none, found = look["lattice_none"], look["lattice_search"]
    # control: the same moment with no search is bright where wires pile up
    assert none["hot"] >= 100, look
    assert found["hot"] * 4 <= none["hot"], look
    # the results stay lit
    assert look["lit_count"] >= 8, look
    assert found["lit"] >= 50, look


def test_wander_results_are_not_fogged_away(look):
    assert look["shared"] >= 8, look
    # control: with no search the same moments are (nearly) free of white pixels
    assert sum(look["wander_none"]) * 3 <= sum(look["wander_marked"]), look
    shown = [n for n in look["wander_marked"] if n >= 5]
    assert len(shown) >= 3, look


def test_focus_keeps_turning_with_a_search(look):
    tumble, focus, paused = look["tumble_motion"], look["focus_motion"], look["focus_paused"]
    assert focus["union"] >= 10, look
    # control: a paused view does not change, so the measure can fail
    assert paused["rate"] < 0.1, look
    assert focus["rate"] >= 0.5 * tumble["rate"], look


def test_focus_draws_no_group_names_while_a_search_is_shown(look):
    # control: the same search in Tumble draws group names
    assert look["tumble_groups"], look
    assert look["focus_groups"] == [], look
