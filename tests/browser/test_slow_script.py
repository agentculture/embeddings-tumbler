"""The viewer on a stand-in for a device that runs JavaScript slowly (the owner's report,
2026-11-14, second part).

The owner's iPhone showed the default page (999 named points in 1,024-d) at 6.7 frames per
second with ``info().timing`` reading: 144 ms of script per frame, 90 ms of it preparation
against a budget of 4 ms. The cost followed dimension, not point count: a multiply-add was
taking tens of nanoseconds there, as it does with no JavaScript compiler, and three things did a
million or more of them in one go (a unit of the fit, the label sample on every frame, the zoom
sample on every frame).

This opens the shipped page in a Chromium started with ``--js-flags=--jitless`` (the
interpreter only) and the CPU throttled four times, hands it 300 named points in 1,024-d and
checks, from the viewer's own timing:

* while Tumble prepares, a frame's preparation stays near the budget it was given (before, a
  unit was a whole row of the Gram matrix: tens of milliseconds whatever the budget);
* once ready, a frame's script is well under what one direct pass over the label and zoom
  samples in full dimension takes on the same page at the same moment (before, every frame
  made those passes), and the label projector made few passes.

Both checks compare times measured on the same page, so a loaded runner slows both sides
alike. It is a stand-in: nothing here ran on WebKit or a real phone.
"""

from __future__ import annotations

import statistics

import pytest

from tests.browser import harness

PAGE = "/embeddings_tumbler/static/index.html"
H = "EmbeddingsTumbler.get(document.getElementById('space'))"
COUNT = 300
DIMENSION = 1024
THROTTLE = 4
OVER_BUDGET_MS = 12
READY_FRAMES = 40

# 300 points in seven clusters, every one named, in the contract's in-memory form.
SET = f"""() => {{
  const N = {COUNT}, D = {DIMENSION};
  let s = 20261114;
  const rnd = () => {{ s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 8) / 16777216 - 0.5; }};
  const vectors = new Float32Array(N * D);
  const points = [];
  for (let i = 0; i < N; i++) {{
    const g = i % 7;
    for (let d = 0; d < D; d++) vectors[i * D + d] = rnd() * 0.4 + (d % 7 === g ? 0.5 : 0);
    points.push({{ id: 'p' + i, label: 'name ' + i, group: 'group ' + g }});
  }}
  window.__rec = [];
  const h = {H};
  const loop = () => {{ requestAnimationFrame(loop); const i = h.info();
    if (window.__frames === i.frames) return; window.__frames = i.frames;
    const t = i.timing;
    window.__rec.push([i.ready && !i.preparing, t.budgetMs, t.workMs, t.scriptMs]); }};
  requestAnimationFrame(loop);
  return h.update({{ schema_version: 1, kind: 'embeddings-tumbler/data', model: 'test/slow-script',
    dimension: D, count: N, text_included: true, vectors, points,
    provenance: {{ source: 'test: generated clusters', producer: 'browser tests 1.0',
      synthetic: true,
      seed: 20261114, limitations: ['made up for a test'], uncertain: ['nothing is known'] }} }});
}}"""
STATE = f"""() => {{ const h = window.EmbeddingsTumbler && {H}; if (!h) return null;
  const i = h.info(); return {{ count: i.count, dimension: i.dimension, ready: i.ready,
    preparing: i.preparing, frames: i.frames,
    readyFrames: (window.__rec || []).filter((r) => r[0]).length }}; }}"""
# One direct pass: every point of the label sample and of the zoom sample (300 each here)
# through the frame in full dimension, as the viewer did on every frame. The median of five.
DIRECT = f"""() => {{ const v = {H}._viewer; const X = v.set.vectors, D = v.set.dimension;
  const F = v.last.frame, C = v.last.centre; const n = 2 * Math.min(v.set.count, 300);
  const times = []; let sink = 0;
  for (let k = 0; k < 5; k++) {{ const t0 = performance.now();
    for (let p = 0; p < n; p++) {{ const o = (p % v.set.count) * D; let a = 0, b = 0, c = 0;
      for (let d = 0; d < D; d++) {{ const x = X[o + d] - C[d];
        a += x * F[d]; b += x * F[D + d]; c += x * F[2 * D + d]; }}
      sink += a + b + c; }}
    times.push(performance.now() - t0); }}
  times.sort((x, y) => x - y);
  return {{ direct: times[2], sink: Number.isFinite(sink), rec: window.__rec,
    passes: v.projector ? v.projector.added + 3 * v.projector.resets : -1 }}; }}"""


@pytest.fixture(scope="module")
def results(browser):
    args = harness.RENDERER_ARGS[harness.renderer()] + harness.COMMON_ARGS
    try:
        slow = browser.browser_type.launch(args=[*args, "--js-flags=--jitless"])
    except Exception as exc:  # no second browser here: the same as no browser
        harness.unavailable(f"Chromium could not be launched without its compiler: {exc}")
    out: dict = {}
    try:
        with harness.Server(harness.ROOT) as server:
            tab = harness.Tab(slow, viewport=(390, 844))
            try:
                tab.goto(server.url(PAGE))
                if not tab.webgl_available():
                    harness.unavailable("WebGL 2 unavailable")
                tab.wait_for(
                    STATE,
                    lambda s: bool(s) and s["count"] > 0,
                    what="the page's own set",
                    timeout=180,
                )
                cdp = tab.context.new_cdp_session(tab.page)
                cdp.send("Emulation.setCPUThrottlingRate", {"rate": THROTTLE})
                out["update"] = tab.page.evaluate(SET)
                tab.wait_for(
                    STATE,
                    lambda s: s["count"] == COUNT and s["readyFrames"] >= READY_FRAMES,
                    what="Tumble ready on the slow set and forty frames of it",
                    timeout=600,
                )
                out.update(tab.page.evaluate(DIRECT))
                out["errors"] = tab.console_errors(allow=["_tumbler/search"])
            finally:
                tab.close()
    finally:
        slow.close()
    return out


def test_the_set_was_taken(results):
    assert results["update"]["ok"] is True, results["update"]


def test_preparation_stays_near_its_budget(results):
    preparing = [r for r in results["rec"] if not r[0] and r[1] is not None]
    assert len(preparing) >= 10, f"only {len(preparing)} frames were seen while Tumble prepared"
    over = sum(1 for r in preparing if r[2] > r[1] + OVER_BUDGET_MS)
    worst = max(r[2] - r[1] for r in preparing)
    # Before: a unit was a row of the Gram matrix (up to 307,200 multiply-adds here, tens of
    # milliseconds on this stand-in), and three frames in ten ran more than 12 ms past
    # their budget (191 of 623, measured; js/api/50-viewer.md, "Slow devices"). Now a unit
    # ends within a piece of 4,096 multiply-adds of the clock saying so, and none did. A
    # loaded runner can still hold a frame, so two frames in ten may be over, not none.
    assert over * 5 <= len(preparing), (over, len(preparing), worst)
    print(f"preparing: {over} of {len(preparing)} frames over the budget by {OVER_BUDGET_MS} ms")


def test_a_ready_frame_costs_far_less_than_one_direct_pass(results):
    assert results["sink"] is True
    ready = [r[3] for r in results["rec"] if r[0]]
    assert len(ready) >= READY_FRAMES
    script = statistics.median(ready)
    direct = results["direct"]
    # Before, every frame made these passes itself (and more), so its script was above the
    # direct figure; measured after the change on the development machine it was a fifth.
    assert script < 0.5 * direct, (script, direct)
    print(f"ready: {script:.1f} ms of script per frame; one direct pass {direct:.1f} ms")


def test_the_label_sample_was_passed_over_a_few_times_not_every_frame(results):
    ready = sum(1 for r in results["rec"] if r[0])
    # Done directly, every frame is three passes over the label sample.
    assert ready >= READY_FRAMES
    assert results["passes"] >= 0, "the viewer made no projector"
    assert results["passes"] <= 60


def test_no_console_errors(results):
    assert results["errors"] == []
