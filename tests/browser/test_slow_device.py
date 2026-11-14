"""The standalone page on a stand-in for a slow phone (the owner's report, 2026-11-14).

The owner's iPhone drew the built-in sample set at 17 frames per second and Lattice's neighbour
measurement was at 22 percent after 30 seconds: the per-frame work budget was halved after
every long frame, and on a device whose frames are long because drawing is slow that starved
the work. This drives the shipped page in Chromium with the CPU throttled (DevTools
``Emulation.setCPUThrottlingRate``), a page-level ``requestAnimationFrame`` wrapper that lets
only every fourth callback through (about 15 frames per second), and 30 ms of busy waiting
inside the renderer's draw call (WebGL calls block on a GPU-bound device, inside the viewer's
own callback). Checked: the cloud turns while Tumble prepares; while Lattice prepares the
budget follows the frame interval (well above ``prepareBudgetMs``) instead of being halved;
Lattice finishes. It is a stand-in: nothing here ran on WebKit or a real phone.
"""

from __future__ import annotations

import time

import pytest

from tests.browser import harness

PAGE = "/embeddings_tumbler/static/index.html"
H = "EmbeddingsTumbler.get(document.getElementById('space'))"
GATE = """(() => { const raf = requestAnimationFrame.bind(window);
  const caf = cancelAnimationFrame.bind(window);
  let k = 0, id = 0; const live = new Map();
  window.requestAnimationFrame = (cb) => { const my = ++id;
    const loop = (t) => { if (!live.has(my)) return;
      if (++k % 4 === 0) { live.delete(my); cb(t); } else live.set(my, raf(loop)); };
    live.set(my, raf(loop)); return my; };
  window.cancelAnimationFrame = (my) => { const r = live.get(my); if (r) caf(r); live.delete(my); };
})();"""
STALL = f"""() => {{ const r = {H}._viewer.renderer, o = r.draw;
  r.draw = function () {{ const s = performance.now(); const x = o.apply(this, arguments);
    while (performance.now() - s < 30) {{}} return x; }}; }}"""
PROBE = f"""() => {{ const h = window.EmbeddingsTumbler && {H};
  if (!h || !h._viewer.lastDraw) return null;
  const i = h.info(); return {{ mode: i.mode, ready: i.ready, preparing: i.preparing,
  budget: i.timing.budgetMs, yaw: h._viewer.lastDraw.yaw }}; }}"""


@pytest.fixture(scope="module")
def results(browser):
    out: dict = {"budgets": [], "yaws_before_ready": set()}
    with harness.Server(harness.ROOT) as server:
        tab = harness.Tab(browser, viewport=(390, 844))
        try:
            tab.context.add_init_script(GATE)
            cdp = tab.context.new_cdp_session(tab.page)
            cdp.send("Emulation.setCPUThrottlingRate", {"rate": 2})
            tab.goto(server.url(PAGE))
            if not tab.webgl_available():
                harness.unavailable("WebGL 2 unavailable")
            first = tab.wait_for(PROBE, bool, what="the first frame")
            tab.page.evaluate(STALL)
            out["yaws_before_ready"].add(first["yaw"])
            end = time.time() + 120
            while time.time() < end:
                p = tab.page.evaluate(PROBE)
                if p["ready"]:
                    break
                out["yaws_before_ready"].add(p["yaw"])
                time.sleep(0.1)
            tab.wait_for(PROBE, lambda p: not p["preparing"], what="Tumble ready", timeout=120)
            t0 = time.time()
            tab.page.evaluate(f"() => {H}.setMode('lattice')")
            while time.time() < end + 60:
                p = tab.page.evaluate(PROBE)
                if not p["preparing"]:
                    out["lattice_s"] = time.time() - t0
                    break
                out["budgets"].append(p["budget"])
                time.sleep(0.1)
            out["errors"] = tab.console_errors(allow=["_tumbler/search"])
        finally:
            tab.close()
    return out


def test_the_cloud_turns_while_tumble_prepares(results):
    assert len(results["yaws_before_ready"]) > 3, results["yaws_before_ready"]


def test_lattice_budget_follows_the_frame_interval_and_finishes(results):
    assert "lattice_s" in results, "Lattice never finished preparing"
    budgets = [b for b in results["budgets"] if b is not None]
    assert budgets, "no budget was sampled while Lattice prepared"
    high = sum(1 for b in budgets if b >= 16)
    # The old rule gave 4 ms (halved after every long frame); at about 100 ms between frames
    # the new one gives the ceiling, 24 ms, except right after a unit overran.
    assert high >= 0.8 * len(budgets), budgets
    print(f"Lattice prepared in {results['lattice_s']:.1f} s; budgets {sorted(set(budgets))}")


def test_no_console_errors(results):
    assert results["errors"] == []
