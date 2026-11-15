"""How search looks on the built-in sample set, corrected after the owner's browser look
(2026-11-14). See docs/search-interface.md, "Corrected after the owner's browser look".

One run of the shipped standalone page (built-in sample set, 12,288 points, 384
dimensions) at 1280 x 900, driven through the public handle. Brightness is counted on a
320 x 180 copy of the stage canvas (lit: sum of channels above 60; near white: above 600),
except where a full-size count is said. Each check has a control that shows it can fail.

- Lattice: with a search shown the wires follow it, so the near-white count drops by a
  large factor against the same moment with no search, while the results stay lit.
- Wander: at six moments of the tour (paused and sought, so the camera is the same with and
  without the search), the search frame has many hot pixels (full size, channel sum above
  600) that are not hot in the no-search frame at the same moment: the results. With a
  search every unlit point is dimmed to 0.07, so those pixels cannot come from the old
  picture; before this correction the fog dimmed the results too and the stage was nearly
  black. Control: the no-search frames are measured before any search is set (an earlier
  version of this test measured them with the Lattice search still active), and the
  overlap of the two frames' hot pixels is small, which shows the old picture is gone and
  what is hot is new.
- Focus: with a search the view keeps turning at a rate comparable to Tumble's (lit pixels
  change between frames one second apart); control: paused, only the twinkle changes them.
  No group name is drawn in Focus while a search is shown; control: Tumble with the same
  search draws them.

Nothing measured here waits on the wall clock. How far the filter has eased, how far the
trails of a sought frame have settled and when the wires are shown all advance per drawn
frame, by at most 0.05 s a frame, so a fixed sleep covers less of them the slower the frames
come (a loaded machine, a software renderer in CI): the search picture was then counted
with the filter part-way in, so with the wires only part-way dimmed. Each measurement waits
on the viewer's own state instead (`_viewer`, the handle's test hook), and the tour starts
from a sought moment of Tumble, so the frames measured are the same frames in every run.

Measured on the ranking that lights the nearest named points and every point as near as
the last of them (423 points for `tide harbor` on the sample set).
"""

from __future__ import annotations

import pytest

from tests.browser import harness

H = "window.EmbeddingsTumbler.get(document.getElementById('space'))"
PERIOD = 3.4  # Lattice's swap period (seconds)
T90 = PERIOD * 4 + PERIOD * 0.9  # swap 5, 90% through: the lattice collapses to a thin shape
WANDER_AT = (3, 8, 13, 20, 30, 45)  # seconds of Wander's tour
TUMBLE_AT = 5  # seconds of Tumble's tour: the view Wander is entered from
WIRE_FADE = 1.2  # seconds of Lattice's time for its wires to fade in (wireFade)
# Seconds of the viewer's drawing time (it advances by each frame's step, 0.05 s at most) a
# sought frame is given before it is counted: the trails (0.1 s in Lattice, 0.17 s at most)
# have then settled to within two percent whatever the frame rate.
SETTLE = 0.7

# What a Lattice count was taken on: the moment, the filter and the wires.
LATTICE_STATE = f"""() => {{
  const h = {H}, v = h._viewer, d = v.mode.inst.describe();
  return {{ mode: h.mode(), paused: h.isPaused(), time: h.time(), preparing: h.info().preparing,
    filter: v.search.filter, wires: d.wires, wiresShownAt: d.wiresShownAt }};
}}"""

GRAB = """() => new Promise((resolve) => requestAnimationFrame(() => {
  const c = document.querySelector('.tumbler-canvas');
  const t = document.createElement('canvas'); t.width = 320; t.height = 180;
  const x = t.getContext('2d'); x.drawImage(c, 0, 0, 320, 180);
  const a = x.getImageData(0, 0, 320, 180).data;
  let lit = 0, hot = 0;
  const px = new Uint16Array(320 * 180);
  for (let i = 0, j = 0; i < a.length; i += 4, j++) {
    const v = a[i] + a[i + 1] + a[i + 2];
    px[j] = v;
    if (v > 60) lit++;
    if (v > 600) hot++;
  }
  resolve({ lit: lit, hot: hot, px: Array.from(px) });
}))"""

# Hot pixels (sum of channels above 600) of the full-size stage: stored under `key`, or
# compared with the mask stored under `key` (new: hot here and not there; both: hot in both).
HOT = """([key, store]) => new Promise((resolve) => requestAnimationFrame(() => {
  const c = document.querySelector('.tumbler-canvas');
  const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
  const x = t.getContext('2d'); x.drawImage(c, 0, 0);
  const a = x.getImageData(0, 0, c.width, c.height).data;
  const mask = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < a.length; i += 4, j++) {
    mask[j] = a[i] + a[i + 1] + a[i + 2] > 600 ? 1 : 0;
  }
  window.__hot = window.__hot || {};
  const old = window.__hot[key];
  let hot = 0, fresh = 0, both = 0;
  for (let j = 0; j < mask.length; j++) {
    hot += mask[j];
    if (old && mask[j] && !old[j]) fresh++;
    if (old && mask[j] && old[j]) both++;
  }
  if (store) window.__hot[key] = mask;
  resolve({ hot: hot, fresh: fresh, both: both });
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

    def grab(self) -> dict:
        return self.tab.evaluate(GRAB)

    def ready(self):
        self.tab.wait_for(f"() => {{ const h = {H}; return !!h && h.info().ready; }}", timeout=240)

    def mode(self, name: str):
        self.ev(f"() => {H}.setMode('{name}')")
        self.ready()

    def search(self, texts: list[str]):
        self.ev(f"async () => {{ await {H}.setSearches({texts!r}); }}")
        self.tab.wait_for(f"() => {H}.info().search.litCount", timeout=120)
        # the filter eases in (time constant 0.35 s of drawn frames) and the frame that
        # faces the results is worked out: wait for both, however slowly the frames come
        self.tab.wait_for(
            f"""() => {{ const h = {H}, s = h._viewer.search;
              return s.filter === 1 && !s.work.length && !s.facingJob
                && !h.info().search.waiting; }}""",
            timeout=120,
        )

    def clear(self):
        self.ev(f"async () => {{ await {H}.clearSearches(); }}")
        # the filter eases out (time constant 0.35 s); _viewer is the handle's test hook
        self.tab.wait_for(
            f"() => {{ const v = {H}._viewer; return !v || v.search.filter === 0; }}", timeout=60
        )

    def hold(self, t: float):
        """Pause at moment `t` of the tour and wait until that frame's picture has settled."""
        began = self.ev(
            f"() => {{ const h = {H}; h.pause(); h.seek({t}); return h._viewer.drawTime; }}"
        )
        self.tab.wait_for(f"(t0) => {H}._viewer.drawTime - t0 >= {SETTLE}", arg=began, timeout=120)

    def at(self, t: float) -> dict:
        self.hold(t)
        return self.grab()

    def hot(self, t: float, store: bool) -> dict:
        self.hold(t)
        return self.tab.evaluate(HOT, [str(t), store])

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
        tab.goto(server.url("/index.html?sample=synthetic"))
        run = _Run(tab)
        run.ready()
        # the view Wander is entered from: a fixed moment of Tumble, not wherever the tour
        # had got to when the page was ready
        run.hold(TUMBLE_AT)
        # Wander, in one visit (the camera's path depends on the view it was entered from):
        # the moments with no search ever set, then the same moments with the search
        run.mode("wander")
        out["wander_none"] = [run.hot(t, True)["hot"] for t in WANDER_AT]
        run.search(["tide harbor"])
        out["wander_search"] = [run.hot(t, False) for t in WANDER_AT]
        run.clear()
        # Lattice: the same moment with no search and with one. The view is paused (since
        # Wander's first moment), so Lattice's time stays 0 while the neighbours are
        # measured and the wires are shown from time 0: fully faded in long before T90.
        run.mode("lattice")
        tab.wait_for(
            f"""() => {{ const h = {H}; return !h.info().preparing
              && h._viewer.mode.inst.describe().wiresShownAt !== null; }}""",
            timeout=240,
        )
        out["lattice_none"] = {k: v for k, v in run.at(T90).items() if k != "px"}
        out["lattice_none"]["state"] = run.ev(LATTICE_STATE)
        run.search(["tide harbor"])
        out["lattice_search"] = {k: v for k, v in run.at(T90).items() if k != "px"}
        out["lattice_search"]["state"] = run.ev(LATTICE_STATE)
        out["lit_count"] = run.ev(f"() => {H}.info().search.litCount")
        # Tumble and Focus with the search, running
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
    # both counts are of the same frame: Lattice, paused at T90, nothing left to prepare,
    # the wires measured and fully faded in; the filter fully out, then fully in
    for frame in (none, found):
        state = frame["state"]
        assert state["mode"] == "lattice", look
        assert state["paused"], look
        assert not state["preparing"], look
        assert state["time"] == T90, look
        assert state["wires"] > 0, look
        assert state["wiresShownAt"] + WIRE_FADE <= T90, look
    assert none["state"]["wires"] == found["state"]["wires"], look
    assert none["state"]["filter"] == 0, look
    assert found["state"]["filter"] == 1, look
    # control: the same moment with no search is bright where wires pile up
    assert none["hot"] >= 100, look
    assert found["hot"] * 4 <= none["hot"], look
    # the results stay lit
    assert look["lit_count"] >= 8, look
    assert found["lit"] >= 50, look


def test_wander_results_are_not_fogged_away(look):
    found = look["wander_search"]
    # the results: hot pixels that the no-search frame does not have, at every moment
    for k, frame in enumerate(found):
        assert frame["fresh"] >= 200, (k, look)
    # control: the old picture is gone (unlit points are dimmed), so what is hot is new
    assert sum(f["both"] for f in found) * 4 <= sum(f["hot"] for f in found), look
    assert sum(look["wander_none"]) > 0, look  # the no-search frames were measured


def test_focus_keeps_turning_with_a_search(look):
    tumble, focus, paused = look["tumble_motion"], look["focus_motion"], look["focus_paused"]
    assert focus["union"] >= 10, look
    # control: a paused view changes only by its twinkle (which runs on while paused and,
    # with hundreds of bright results, changes about a tenth of the lit pixels), so the
    # measure can fail
    assert paused["rate"] < 0.25, look
    assert focus["rate"] >= 0.5 * tumble["rate"], look
    assert focus["rate"] >= paused["rate"] + 0.3, look


def test_focus_draws_no_group_names_while_a_search_is_shown(look):
    # control: the same search in Tumble draws group names
    assert look["tumble_groups"], look
    assert look["focus_groups"] == [], look
