"""With a search active the view never stops: lit pixels keep changing every second in
Tumble, Lattice and Wander, during the swing toward the searches and after it (task t12 of
the search plan; the spec's "it never holds the view").

One page (the script form on the search set of ``search_site.py``, two searches through the
embed callback). In each of the three modes the same two searches are set again, which starts
a swing, and from the first frame of the swing the stage is sampled once per second **of the
mode's own time** for thirteen samples: a swing lasts six seconds of mode time, so the
samples cover it and the seconds after it. Each sample is compared with the one before:
of the pixels lit in either (sum of channels above 60 on a 320-wide copy of the stage), the
share whose brightness (the sum of the three channels, 0 to 765) differs by more than 90.

Measured on SwiftShader (2026-11-14, this set): a moving second changes 0.11 to 0.78 of the
lit pixels (the least in the second in which Tumble's swing ends, when the view is nearest
the frame it was swung to and turning slowest); a paused second changes 0.004 to 0.006. A
smaller difference (45) lets the twinkle through: paused 0.13, the slowest moving second
0.30, too close to tell apart.

Nothing here waits on the wall clock. The sampler is a ``requestAnimationFrame`` loop in the
page that takes a sample on the first frame at which the mode's time (``handle.time()``) has
advanced a second since the last sample; the test waits for the sampler to finish. Mode time
advances by at most 0.05 s a frame, so on a slow machine a second of it takes longer and the
samples are still a second of motion apart.

Negative control: the same sampler on the same view paused, a second of the viewer's drawing
time apart (the points still twinkle while paused, the view does not move). Its share of
changed pixels is far below the floor every moving second must reach, so the check can fail.
"""

from __future__ import annotations

import pytest

from tests.browser import harness
from tests.browser import search_site as site_

MODES = ("tumble", "lattice", "wander")
SAMPLES = 13  # one per second of mode time: twelve seconds, a six-second swing and after
CONTROL_SAMPLES = 5
MOVING = 0.05  # the least share of lit pixels that must change in every moving second
STILL = 0.02  # the most that may change in a second of the paused view (its twinkle)
SETTLE = 1.0  # seconds of drawing time for the trails to fade once the view is paused

# Starts the sampler. `clock` is "mode" (the mode's time, which stops while paused) or "draw"
# (the viewer's drawing time, which runs on while paused). State on window.__motion.
SAMPLER = f"""([clock, count]) => {{
  const h = {site_.H}, v = h._viewer;
  const canvas = document.querySelector('#space .tumbler-canvas');
  const CUT = 90, W = 320, HT = Math.max(1, Math.round(320 * canvas.height / canvas.width));
  const small = document.createElement('canvas');
  small.width = W; small.height = HT;
  const ctx = small.getContext('2d', {{ willReadFrequently: true }});
  const run = (window.__motion = {{ samples: [], done: false }});
  let prev = null, next = null;
  const now = () => (clock === 'draw' ? v.drawTime : h.time());
  function sample(at) {{
    ctx.clearRect(0, 0, W, HT);
    ctx.drawImage(canvas, 0, 0, W, HT);
    const a = ctx.getImageData(0, 0, W, HT).data;
    const px = new Uint16Array(W * HT);
    let lit = 0, union = 0, changed = 0;
    for (let i = 0, j = 0; i < a.length; i += 4, j++) {{
      const s = a[i] + a[i + 1] + a[i + 2];
      px[j] = s;
      if (s > 60) lit++;
      if (prev && (s > 60 || prev[j] > 60)) {{
        union++;
        if (Math.abs(s - prev[j]) > CUT) changed++;
      }}
    }}
    const search = h.info().search;
    run.samples.push({{ clock: at, time: h.time(), mode: h.mode(), paused: h.isPaused(),
      facing: search.facing, active: search.active, filter: v.search.filter,
      lit: lit, union: union, changed: changed }});
    prev = px;
    next = at + 1;
  }}
  function tick() {{
    const at = now();
    if (next === null || at >= next) sample(at);
    if (run.samples.length < count) requestAnimationFrame(tick);
    else run.done = true;
  }}
  requestAnimationFrame(tick);
}}"""

DONE = "() => (window.__motion && window.__motion.done ? window.__motion.samples : null)"

FILTER_IN = f"""() => {{ const h = {site_.H}, s = h._viewer.search;
  return s.filter === 1 && !h.info().search.waiting; }}"""

MODE_READY = f"""(mode) => {{ const h = {site_.H}, i = h.info();
  return i.mode === mode && i.ready && !i.preparing && !h.isPaused(); }}"""

DRAW_TIME = f"() => {site_.H}._viewer.drawTime"

FACING = f"() => {site_.H}.info().search.facing"


def _sampled(tab: harness.Tab, clock: str, count: int) -> list[dict]:
    tab.evaluate(SAMPLER, [clock, count])
    return tab.wait_for(DONE, timeout=site_.WAIT, what=f"{count} samples a second apart")


@pytest.fixture(scope="module")
def motion(browser, webgl, tmp_path_factory) -> dict:
    folder = tmp_path_factory.mktemp("search-motion")
    site_.build_site(folder)
    searches = [site_.ALPHA, site_.BETA]
    out: dict = {}
    with harness.Server(folder) as server:
        tab = harness.Tab(browser, viewport=(1100, 700))
        try:
            site_.open_form(tab, f"{server.origin}/search-script-host.html")
            assert tab.evaluate(site_.SET_SEARCHES, searches)["ok"] is True
            tab.wait_for(FILTER_IN, timeout=site_.WAIT, what="the search to fade in")
            for mode in MODES:
                tab.evaluate(f"(mode) => {site_.H}.setMode(mode)", mode)
                tab.wait_for(MODE_READY, arg=mode, timeout=site_.WAIT, what=f"{mode} ready")
                # the same searches again: a new search swings the view, once
                assert tab.evaluate(site_.SET_SEARCHES, searches)["ok"] is True
                tab.wait_for(FACING, timeout=site_.WAIT, what=f"the swing in {mode}")
                out[mode] = _sampled(tab, "mode", SAMPLES)
            tab.evaluate(f"() => {site_.H}.pause()")
            began = tab.evaluate(DRAW_TIME)
            tab.wait_for(
                f"(t0) => {site_.H}._viewer.drawTime - t0 >= {SETTLE}",
                arg=began,
                timeout=site_.WAIT,
                what="the paused picture to settle",
            )
            out["paused"] = _sampled(tab, "draw", CONTROL_SAMPLES)
            tab.assert_no_foreign_requests(server.origin)
            tab.assert_no_console_errors()
        finally:
            tab.close()
    return out


def _seconds(samples: list[dict]) -> list[dict]:
    """Each sample after the first with the one before it: one second of the view."""
    out = []
    for a, b in zip(samples, samples[1:]):
        rate = b["changed"] / max(b["union"], 1)
        out.append({"from": a, "to": b, "rate": rate, "gap": b["clock"] - a["clock"]})
    return out


@pytest.mark.parametrize("mode", MODES)
def test_lit_pixels_change_every_second_during_and_after_the_swing(motion, mode):
    samples = motion[mode]
    assert len(samples) == SAMPLES
    for s in samples:
        assert s["mode"] == mode, s
        assert s["active"] is True, s
        assert s["paused"] is False, s
        assert s["filter"] == 1, s
        assert s["lit"] >= 50, s  # the stage was read with the picture on it
    seconds = _seconds(samples)
    during = [x for x in seconds if x["from"]["facing"] and x["to"]["facing"]]
    after = [x for x in seconds if not x["from"]["facing"] and not x["to"]["facing"]]
    assert len(during) >= 3, [s["facing"] for s in samples]
    assert len(after) >= 4, [s["facing"] for s in samples]
    for second in seconds:
        # a second of the mode's time, to within the two frames around it
        assert 1.0 <= second["gap"] < 1.2, second
        assert second["to"]["union"] >= 50, second
        assert second["rate"] >= MOVING, second


def test_the_check_fails_on_a_paused_view(motion):
    """Negative control: paused, with the search still shown, a second changes little."""
    samples = motion["paused"]
    assert len(samples) == CONTROL_SAMPLES
    times = {s["time"] for s in samples}
    assert len(times) == 1, times  # the mode's time stood still
    for s in samples:
        assert s["paused"] is True, s
        assert s["active"] is True, s
        assert s["lit"] >= 50, s  # the same picture is on the stage, not a blank one
    for second in _seconds(samples):
        assert second["gap"] >= 1.0, second
        assert second["to"]["union"] >= 50, second
        assert second["rate"] <= STILL, second
        assert second["rate"] < MOVING, second
