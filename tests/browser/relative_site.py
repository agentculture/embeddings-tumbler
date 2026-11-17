"""What the relative-search browser tests share (task t13 of the relative-search plan).

* The data: the shipped Wikipedia demo pair and the relative fixtures, read back in Python
  (standard library only), and the expected heights and rankings worked out from the vectors
  here, never copied from the spec.
* A served folder built the way a host gets the files (``viewer write``), with the relative
  fixtures beside the page.
* JavaScript snippets that read the viewer's test hook (``handle._viewer.relativeDrawn``) and
  ``info().search.relative``, and the in-page sampler that follows the drawn results over
  mode time.
* The pixel check that the points the GPU (or SwiftShader) drew are where the hook says.

A search from a point (and a word search that matches one whole title, such as Rice) names the
point itself as its first result at cosine 1; the overlay draws it as the search, so it has no
stem and no entry in the hook's results (``docs/relative-interface.md``, "Answer: does a search
from a point name the point itself?"). Comparisons therefore ask for one result more than the
number of other points compared.
"""

from __future__ import annotations

import array
import json
import math
import shutil
import sys
from pathlib import Path

from embeddings_tumbler.cli import main
from tests.browser import harness

ROOT = harness.ROOT
STATIC = ROOT / "embeddings_tumbler" / "static"
RELATIVE_FIXTURES = ROOT / "tests" / "fixtures" / "relative"
WAIT = 240  # seconds: software rendering on a shared runner

H = "EmbeddingsTumbler.get(document.getElementById('space'))"
RICE_ID = "wp-36979"

READY = f"""() => {{
  const h = window.EmbeddingsTumbler && {H};
  return !!h && h.info().ready && h.info().frames > 2
    && !!document.querySelector('.tumbler-search');
}}"""

# The hook's record once the relative view has settled (the turn has ended), or null.
SETTLED = f"""(n) => {{
  const h = {H}, d = h._viewer.relativeDrawn, r = h.info().search.relative;
  if (!d || !d.settled || !d.ruler || !r.settled || h.info().search.waiting) return null;
  if (n !== null && r.pinned.length !== n) return null;
  return {{ hook: d, relative: r }};
}}"""

INFO_RELATIVE = f"() => {H}.info().search.relative"

# Visible relative labels (spans placed by the overlay), in placing order.
LABELS = """() => [...document.querySelectorAll('.tumbler-relative-label')]
  .filter((n) => n.style.display !== 'none' && n.textContent !== '')
  .map((n) => n.textContent)"""

# Follows the drawn results for `seconds` of mode time, one record per drawn frame, kept small:
# per result the range of its drawn y (CSS px), its ruler end and its distance from the ruler at
# its own height as a share of the ruler's visible length. State on window.__relSample.
SAMPLER = f"""([seconds]) => {{
  const h = {H}, v = h._viewer;
  const run = (window.__relSample = {{ done: false, frames: 0, unsettled: 0, t0: h.time(),
    t1: null, per: {{}}, maxPitch: 0, perspective: [null, null], rulerY0: [], rulerY1: [],
    rulerLen: [] }});
  const lo = (a, b) => (a === null ? b : Math.min(a, b));
  const hi = (a, b) => (a === null ? b : Math.max(a, b));
  function tick() {{
    const d = v.relativeDrawn;
    if (d && d.settled && d.ruler) {{
      const k = d.dpr || 1;
      const L = Math.hypot(d.ruler.x1 - d.ruler.x0, d.ruler.y1 - d.ruler.y0);
      run.frames++;
      run.maxPitch = Math.max(run.maxPitch, Math.abs(v.lastDraw.pitch));
      run.perspective = [lo(run.perspective[0], v.lastDraw.perspective),
        hi(run.perspective[1], v.lastDraw.perspective)];
      run.rulerY0[0] = lo(run.rulerY0[0] ?? null, d.ruler.y0 / k);
      run.rulerY0[1] = hi(run.rulerY0[1] ?? null, d.ruler.y0 / k);
      run.rulerY1[0] = lo(run.rulerY1[0] ?? null, d.ruler.y1 / k);
      run.rulerY1[1] = hi(run.rulerY1[1] ?? null, d.ruler.y1 / k);
      run.rulerLen[0] = lo(run.rulerLen[0] ?? null, L / k);
      run.rulerLen[1] = hi(run.rulerLen[1] ?? null, L / k);
      for (const r of d.results) {{
        const p = run.per[r.index] || (run.per[r.index] = {{ height: r.height, n: 0,
          y: [null, null], x: [null, null], rulerY: [null, null], err: 0, signed: [null, null] }});
        const err = (r.y - r.mappedY) / L;
        p.n++;
        p.y = [lo(p.y[0], r.y / k), hi(p.y[1], r.y / k)];
        p.x = [lo(p.x[0], r.x / k), hi(p.x[1], r.x / k)];
        p.rulerY = [lo(p.rulerY[0], r.rulerY / k), hi(p.rulerY[1], r.rulerY / k)];
        p.signed = [lo(p.signed[0], err), hi(p.signed[1], err)];
        p.err = Math.max(p.err, Math.abs(err));
      }}
    }} else run.unsettled++;
    if (h.time() - run.t0 >= seconds) {{ run.t1 = h.time(); run.done = true; }}
    else requestAnimationFrame(tick);
  }}
  requestAnimationFrame(tick);
}}"""

SAMPLED = "() => (window.__relSample && window.__relSample.done ? window.__relSample : null)"

# Hides every text and overlay layer, so a screenshot of the stage shows only the points.
HIDE_LAYERS = """() => {
  for (const sel of ['.tumbler-relative-labels', '.tumbler-overlay', '.tumbler-search']) {
    for (const n of document.querySelectorAll(sel)) n.style.visibility = 'hidden';
  }
}"""
SHOW_LAYERS = """() => {
  for (const sel of ['.tumbler-relative-labels', '.tumbler-overlay', '.tumbler-search',
                     '.tumbler-masthead', '.tumbler-status', '.tumbler-labels',
                     '.tumbler-notice', '.tumbler-message', '.tumbler-empty']) {
    for (const n of document.querySelectorAll(sel)) n.style.visibility = '';
  }
}"""


# --------------------------------------------------------------------------- data


def load_pair(json_path: Path) -> tuple[dict, list[list[float]]]:
    """A data file and its rows (float32 widened to Python floats)."""
    meta = json.loads(json_path.read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((json_path.parent / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    dim = meta["dimension"]
    assert len(block) == meta["count"] * dim, "block does not match count x dimension"
    return meta, [block[i * dim : (i + 1) * dim].tolist() for i in range(meta["count"])]


def norm(row: list[float]) -> float:
    return math.sqrt(math.fsum(x * x for x in row))


def dot(a: list[float], b: list[float]) -> float:
    return math.fsum(x * y for x, y in zip(a, b))


def along(rows: list[list[float]], query: list[float]) -> tuple[list[float], list[float]]:
    """(cosine of every row to the query, height of every row along the query's direction)."""
    q = norm(query)
    heights = [dot(r, query) / q for r in rows]
    cosines = [h / norm(r) for h, r in zip(heights, rows)]
    return cosines, heights


def nearest(cosines: list[float], count: int) -> list[int]:
    """The ``count`` indices of highest cosine, highest first, ties to the lower index."""
    return sorted(range(len(cosines)), key=lambda i: (-cosines[i], i))[:count]


def index_of(meta: dict, point_id: str) -> int:
    return next(i for i, p in enumerate(meta["points"]) if p["id"] == point_id)


# --------------------------------------------------------------------------- the served folder


def build_folder(folder: Path) -> Path:
    """``viewer write`` (the shipped set, flat) plus the two relative fixtures beside it."""
    folder.mkdir(parents=True, exist_ok=True)
    assert main(["viewer", "write", str(folder), "--apply"]) == 0, "viewer write failed"
    for name in ("mixed-length", "wikipedia-subset"):
        for suffix in (".json", ".f32"):
            shutil.copy(RELATIVE_FIXTURES / (name + suffix), folder / (name + suffix))
    return folder


def open_page(browser, url: str, *, viewport=(1280, 900), reduced_motion=None) -> harness.Tab:
    tab = harness.Tab(browser, viewport=viewport, reduced_motion=reduced_motion)
    tab.goto(url)
    tab.wait_for(READY, timeout=WAIT, what="the viewer and its panel")
    if tab.evaluate(f"() => {H}.info().rendering") is False:
        tab.close()
        harness.unavailable("WebGL 2 unavailable in headless Chromium")
    return tab


def settled(tab: harness.Tab, pinned: int | None = None, what: str = "the relative view"):
    return tab.wait_for(SETTLED, arg=pinned, timeout=WAIT, what=f"{what} to settle")


def sample(tab: harness.Tab, seconds: float) -> dict:
    tab.evaluate(SAMPLER, [seconds])
    return tab.wait_for(
        SAMPLED, timeout=WAIT + 4 * seconds, what=f"{seconds} s of mode time sampled"
    )


# --------------------------------------------------------------------------- pixels


def drawn_points_match(tab: harness.Tab, selector: str = "#space canvas.tumbler-canvas") -> dict:
    """With the view paused, a screenshot of the stage (text and overlay hidden) and, for each
    result in the hook, the brightness-weighted centre of the bright pixels around where the
    hook says it is drawn. Returns ``{"hook": ..., "found": [...]}``; ``found[i]`` is
    ``None`` when nothing bright is within reach of result ``i``."""
    tab.evaluate(f"() => {H}.pause()")
    t = tab.evaluate(f"() => {H}.time()")
    tab.wait_for(
        f"(t) => {H}.time() === t && {H}._viewer.relativeDrawn !== null",
        arg=t,
        what="a paused frame",
    )
    tab.page.wait_for_timeout(200)
    hook = tab.evaluate(f"() => {H}._viewer.relativeDrawn")
    box = tab.evaluate(
        "(s) => { const r = document.querySelector(s).getBoundingClientRect();"
        " return [r.left, r.top, r.width, r.height]; }",
        selector,
    )
    tab.evaluate(HIDE_LAYERS)
    png = tab.png(selector, hide_text=True)
    tab.evaluate(SHOW_LAYERS)
    after = tab.evaluate(f"() => {H}._viewer.relativeDrawn")
    width, height, rows = harness.decode_png(png)
    k = hook["dpr"] or 1
    found = []
    for r in hook["results"]:
        cx, cy = r["x"] / k, r["y"] / k
        found.append(_bright_centre(rows, width, height, cx, cy, reach=7))
    return {
        "hook": hook,
        "same_after": [(a["x"], a["y"]) for a in hook["results"]]
        == [(a["x"], a["y"]) for a in after["results"]],
        "found": found,
        "size": (width, height),
        "box": box,
    }


def _bright_centre(rows, width, height, cx, cy, reach):
    """Brightness-weighted centre of pixels within ``reach`` of (cx, cy) whose brightness is
    at least half the brightest there; ``None`` when the brightest is no brighter than sky."""
    best = 0
    cells = []
    for y in range(max(0, int(cy - reach)), min(height, int(cy + reach) + 2)):
        row = rows[y]
        for x in range(max(0, int(cx - reach)), min(width, int(cx + reach) + 2)):
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > reach * reach:
                continue
            s = row[3 * x] + row[3 * x + 1] + row[3 * x + 2]
            cells.append((x, y, s))
            best = max(best, s)
    if best <= 150:
        return None
    keep = [(x, y, s) for x, y, s in cells if s >= best / 2]
    total = sum(s for _, _, s in keep)
    return {
        "x": sum((x + 0.5) * s for x, _, s in keep) / total,
        "y": sum((y + 0.5) * s for _, y, s in keep) / total,
        "peak": best,
    }
