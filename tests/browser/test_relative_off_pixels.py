"""With relative off, every view draws exactly what it drew before the flatness key existed
(task t13 of the relative-search plan; obligations o6 and o9 of the spec).

"Before" is the core file of release 0.12.1 (commit 9fe3213), the last release before the
renderer's ``draw.perspective`` key (task t3) and the relative setting; it is kept here gzipped
(``embeddings-tumbler-0.12.1.js.gz``, checked by its SHA-256) because CI checks out one commit
and has no history to read it from. "After" is the shipped core file of this checkout.

Each file is loaded by its own plain page into the same browser, with reduced motion (the
viewer starts paused with no twinkle, so a picture is a fixed function of the data, the seed
and the viewport) and the same fixed seed, on the two relative fixtures
(``tests/fixtures/relative/wikipedia-subset`` and ``mixed-length``), with trails off (trails
blend the frames drawn while a search fades in, and how many frames that is depends on the
machine's timing). The same steps in both: Tumble, Lattice and Wander with no search; Wander
with a search from Rice; Focus on it; Tumble again with it. In each mode the paused view is
sought to a fixed time (``seek``), so each picture is that mode's own frame then. A search is
never cleared: while one fades out, the 2-D overlay keeps whatever it last drew when the paused
viewer goes idle, which depends on timing in both files. After each step the stage is
screenshotted once the picture is still (two screenshots in a row identical), with the text
hidden and the canvases shown (the WebGL stage and the 2-D overlay with the search's rings and
links). Every pair of screenshots must be pixel-identical.

Negative control: the same page with another seed gives a different Tumble picture, so the
comparison can fail.
"""

from __future__ import annotations

import gzip
import hashlib
import shutil
from pathlib import Path

import pytest

from tests.browser import harness
from tests.browser import relative_site as rs

OLD_CORE = Path(__file__).resolve().parent / "embeddings-tumbler-0.12.1.js.gz"
OLD_SHA256 = "ba5e8a713aa2ba03cc31e5c5194b4e626c6cd406d07aaab4b911db8078c3659b"
FIXTURES = ("wikipedia-subset", "mixed-length")
SEED = 7
# Seconds of mode time each view is shown at (paused, so the view is the mode's frame then).
SEEK = {"tumble": 4.25, "lattice": 9.5, "wander": 6.75, "focus": 3.5, "tumble with a search": 12.0}
STEPS = ("tumble", "lattice", "wander", "wander with a search", "focus", "tumble with a search")

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>relative off: {name}</title>
</head>
<body style="margin:0;background:#000">
<div id="space" style="width:800px;height:600px"></div>
<script src="{core}"></script>
</body>
</html>
"""

MOUNT = """async ([file, seed]) => {
  const el = document.getElementById('space');
  const h = EmbeddingsTumbler.mount(el, { seed: seed, trails: false });
  const meta = await (await fetch(file)).json();
  const block = await (await fetch(meta.vectors.file)).arrayBuffer();
  h.update({ ...meta, vectors: block });
  return EmbeddingsTumbler.version;
}"""

READY = f"""(mode) => {{
  const h = window.EmbeddingsTumbler && {rs.H};
  if (!h) return false;
  const i = h.info();
  return i.ready && !i.preparing && i.mode === mode && i.frames > 2 && !i.search.waiting;
}}"""

# Text and DOM layers hidden; the WebGL stage and the 2-D overlay canvas stay visible.
HIDE = """() => {
  for (const sel of ['.tumbler-masthead', '.tumbler-status', '.tumbler-labels',
                     '.tumbler-notice', '.tumbler-message', '.tumbler-empty', '.tumbler-search',
                     '.tumbler-relative-labels']) {
    for (const n of document.querySelectorAll(sel)) n.style.visibility = 'hidden';
  }
}"""

STAGE = "#space canvas.tumbler-canvas"


def _old_core() -> bytes:
    data = gzip.decompress(OLD_CORE.read_bytes())
    assert hashlib.sha256(data).hexdigest() == OLD_SHA256, "the 0.12.1 copy is not the release"
    return data


@pytest.fixture(scope="module")
def folder(tmp_path_factory):
    f = tmp_path_factory.mktemp("relative-off")
    for name in FIXTURES:
        for suffix in (".json", ".f32"):
            shutil.copy(rs.RELATIVE_FIXTURES / (name + suffix), f / (name + suffix))
    shutil.copy(rs.STATIC / "embeddings-tumbler.js", f / "embeddings-tumbler.js")
    (f / "embeddings-tumbler-0.12.1.js").write_bytes(_old_core())
    for which, core in (("old", "embeddings-tumbler-0.12.1.js"), ("new", "embeddings-tumbler.js")):
        (f / f"off-{which}.html").write_text(PAGE.format(name=which, core=core), encoding="utf-8")
    return f


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


def _seek(tab: harness.Tab, t: float):
    """Paused, the mode's time stands still; a seek shows the mode's own frame at ``t``."""
    assert tab.evaluate(f"(t) => {rs.H}.seek(t)", t) == t
    tab.wait_for(f"(t) => {rs.H}.time() === t", arg=t, what=f"the view at {t} s")


def _ready(tab: harness.Tab, mode: str):
    tab.wait_for(READY, arg=mode, timeout=rs.WAIT, what=f"{mode} ready")


def _run(browser, url: str, file: str, seed: int, steps=STEPS) -> dict:
    tab = harness.Tab(browser, viewport=(900, 700), reduced_motion="reduce")
    shots: dict = {}
    try:
        tab.goto(url)
        shots["version"] = tab.evaluate(MOUNT, [file, seed])
        _ready(tab, "tumble")
        if tab.evaluate(f"() => {rs.H}.info().rendering") is False:
            harness.unavailable("WebGL 2 unavailable in headless Chromium")
        shots["paused"] = tab.evaluate(f"() => {rs.H}.isPaused()")
        _seek(tab, SEEK["tumble"])
        shots["tumble"] = _still(tab)
        if len(steps) > 1:
            for mode in ("lattice", "wander"):
                assert tab.evaluate(f"(m) => {rs.H}.setMode(m)", mode)
                _ready(tab, mode)
                _seek(tab, SEEK[mode])
                shots[mode] = _still(tab)
            point = f"[{{ point: '{rs.RICE_ID}' }}]"
            assert tab.evaluate(f"async () => (await {rs.H}.setSearches({point})).ok")
            _ready(tab, "wander")
            shots["wander with a search"] = _still(tab)
            for mode, step in (("focus", "focus"), ("tumble", "tumble with a search")):
                assert tab.evaluate(f"(m) => {rs.H}.setMode(m)", mode)
                _ready(tab, mode)
                _seek(tab, SEEK[step])
                shots[step] = _still(tab)
        shots["relative"] = tab.evaluate(
            f"() => typeof {rs.H}.relativeSettings === 'function'"
            f" ? {rs.H}.relativeSettings() : null"
        )
        shots["errors"] = tab.console_errors()
    finally:
        tab.close()
    return shots


def _differing(a: bytes, b: bytes) -> int:
    wa, ha, ra = harness.decode_png(a)
    wb, hb, rb = harness.decode_png(b)
    assert (wa, ha) == (wb, hb)
    count = 0
    for x, y in zip(ra, rb):
        if x != y:
            count += sum(1 for i in range(0, len(x), 3) if x[i : i + 3] != y[i : i + 3])
    return count


@pytest.fixture(scope="module")
def runs(browser, webgl, folder):
    out: dict = {"webgl": webgl}
    with harness.Server(folder) as server:
        for name in FIXTURES:
            for which in ("old", "new"):
                out[(name, which)] = _run(
                    browser, server.url(f"/off-{which}.html"), f"{name}.json", SEED
                )
        out["control"] = _run(
            browser, server.url("/off-new.html"), f"{FIXTURES[0]}.json", SEED + 1, ("tumble",)
        )
    return out


def test_the_two_core_files_are_the_release_and_this_checkout(runs):
    old, new = runs[(FIXTURES[0], "old")], runs[(FIXTURES[0], "new")]
    assert old["version"] == "0.12.1"
    assert _old_core() != (rs.STATIC / "embeddings-tumbler.js").read_bytes()
    assert old["relative"] is None  # no relative setting before
    # off in the new one
    assert new["relative"] == {"relative": False, "showOrigin": False}
    assert old["paused"] is True and new["paused"] is True  # reduced motion: a still picture


@pytest.mark.parametrize("name", FIXTURES)
@pytest.mark.parametrize("step", STEPS)
def test_relative_off_screenshots_are_pixel_identical_to_0_12_1(runs, name, step):
    old, new = runs[(name, "old")], runs[(name, "new")]
    lit = harness.lit_pixels(new[step])
    differ = _differing(old[step], new[step])
    print(f"{name} / {step} on {runs['webgl']}: {differ} pixels differ; {lit} lit")
    assert lit > 50, "the stage was screenshotted with the picture on it"
    assert differ == 0
    assert old["errors"] == [] and new["errors"] == []


def test_the_comparison_can_fail(runs):
    """Negative control: another seed, another Tumble picture."""
    differ = _differing(runs[(FIXTURES[0], "new")]["tumble"], runs["control"]["tumble"])
    print(f"seed {SEED} against seed {SEED + 1}: {differ} pixels differ")
    assert differ > 100
