"""Headless-browser check of the shipped standalone page (task t11).

The folder under test is produced the way a host gets it: ``embeddings-tumbler
viewer write <tmp> --apply`` copies the shipped set into a temporary folder, a
contract fixture pair (``valid-384.json`` and ``valid-384.f32``) is copied next
to it, and the folder is served on a loopback port. So the test also proves the
shipped set is complete and self-contained.

Checked: with no query the sample set renders (lit pixels on the canvas) with
all three mode buttons, the provenance block and the controls; ``?data=``
shows that file's model and count in the provenance; a ``data`` address on
another origin is refused with a plain message and no request to it; a missing
file shows a plain message; a set the viewer refuses (``bumped-version.json``)
shows the viewer's message and an empty sky (the lit-pixel count's negative
control); zero console errors (bar the missing file's own
404), zero CSP violations, zero requests to any other origin; no horizontal
overflow at 390 px wide.

Uses the shared harness (``tests/browser/harness.py``): one browser per session, SwiftShader
(software) unless ``TUMBLER_BROWSER_RENDERER=gpu``, the renderer in every test id. Skips when
Playwright, a matching Chromium build, or WebGL 2 is not available, and fails instead under
``TUMBLER_REQUIRE_BROWSER=1``.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from embeddings_tumbler.cli import main
from tests.browser import harness

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "contract"
VIEWPORTS = {"desktop": (1280, 800), "phone": (390, 844)}
FOREIGN = "http://foreign.invalid/data/set.json"

PROBE = """() => {
  const el = document.getElementById('space');
  const api = window.EmbeddingsTumbler;
  const h = api && api.get(el);
  const info = h ? h.info() : null;
  const q = (s) => el.querySelectorAll(s).length;
  const prov = el.querySelector('.tumbler-provenance');
  const visible = (sel) => {
    const n = document.querySelector(sel);
    return !!n && !n.hidden && n.getClientRects().length > 0;
  };
  return {
    state: document.body.getAttribute('data-page-state'),
    wait: (document.getElementById('wait-text') || {}).textContent || null,
    waitShown: !!document.getElementById('wait') && document.getElementById('wait').isConnected,
    info: info && { ready: info.ready, frames: info.frames, count: info.count,
      dimension: info.dimension, model: info.model, rendering: info.rendering,
      mode: info.mode, message: info.message },
    modes: Array.from(el.querySelectorAll('button.tumbler-mode')).map((b) => b.dataset.mode),
    controls: { play: q('button.tumbler-play'), speed: q('label.tumbler-speed input'),
      labels: q('label.tumbler-labels-toggle input'),
      trails: q('label.tumbler-trails-toggle input') },
    provenance: prov ? { shown: prov.getClientRects().length > 0, text: prov.textContent } : null,
    readout: q('canvas.tumbler-strip'),
    notes: { tumble: visible('.explain[data-for="tumble"]'),
      lattice: visible('.explain[data-for="lattice"]'),
      wander: visible('.explain[data-for="wander"]') },
    noteText: (document.querySelector('.explain[data-for="tumble"]') || {}).textContent || '',
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
}"""


HIDE_TEXT = """() => {
  for (const sel of ['.tumbler-masthead', '.tumbler-status', '.tumbler-labels',
                     '.tumbler-notice', '.tumbler-message', '.tumbler-empty']) {
    for (const n of document.querySelectorAll(sel)) n.style.visibility = 'hidden';
  }
}"""


@pytest.fixture(scope="module")
def host_folder(tmp_path_factory):
    folder = tmp_path_factory.mktemp("host")
    assert main(["viewer", "write", str(folder), "--apply"]) == 0
    for name in ("valid-384.json", "valid-384.f32", "bumped-version.json"):
        shutil.copy(FIXTURES / name, folder / name)
    for name in ("index.html", "page.css", "page.js", "embeddings-tumbler.js", "sample-data.js"):
        assert (folder / name).is_file(), f"viewer write did not ship {name}"
    return folder


@pytest.fixture(scope="module")
def base_url(host_folder):
    with harness.Server(host_folder) as server:
        yield server.origin


def _open(browser, base_url, query="", viewport=VIEWPORTS["desktop"], settle=lambda r: True):
    tab = harness.Tab(browser, viewport=viewport)
    page = tab.page
    try:
        page.goto(base_url + "/index.html" + query)
        try:
            tab.wait_for(
                PROBE,
                lambda r: r["state"] in ("error", "refused")
                or (r["state"] == "ready" and settle(r)),
                timeout=60,
                what="the page to settle",
            )
        except AssertionError:
            # As before the harness: a page that has not settled after 60 s is still measured,
            # and the tests' own assertions decide (on a heavily loaded CPU the sample's Tumble
            # fit can take longer than that on SwiftShader, while the page is already drawn).
            pass
        page.wait_for_timeout(300)
        result = page.evaluate(PROBE)
        # The harness records CSP violations from the first script on, through a binding.
        result["csp"] = list(tab.csp)
        # Lit points only: hide the text drawn over the sky (after the CSP record
        # is taken; CSSOM writes are not inline style and need no policy).
        page.evaluate(HIDE_TEXT)
        canvas = page.query_selector("#space canvas.tumbler-canvas")
        result["lit"] = harness.lit_pixels(canvas.screenshot()) if canvas else None
    finally:
        tab.close()
    info = result.get("info") or {}
    if result["state"] == "ready" and info.get("rendering") is False:
        harness.unavailable(f"WebGL 2 unavailable in headless Chromium: {info.get('message')}")
    result["console_errors"] = tab.console_errors()
    result["requests"] = [r["url"] for r in tab.requests]
    result["foreign"] = [r["url"] for r in tab.foreign_requests(base_url)]
    return result


def _drawn(r):
    info = r.get("info") or {}
    return bool(info.get("ready")) and info.get("frames", 0) > 5


@pytest.fixture(scope="module", params=list(VIEWPORTS))
def sample_run(request, browser, base_url):
    return request.param, _open(browser, base_url, "", VIEWPORTS[request.param], _drawn)


def test_sample_set_renders_with_modes_provenance_and_controls(sample_run):
    _, r = sample_run
    assert r["state"] == "ready", r["wait"]
    assert r["info"]["model"] == "synthetic/reference-sample"
    assert r["info"]["count"] > 0
    assert r["lit"] and r["lit"] > 200, "the sky shows no lit points"
    assert r["modes"] == ["tumble", "lattice", "wander"]
    assert r["controls"] == {"play": 1, "speed": 1, "labels": 1, "trails": 1}
    assert r["readout"] == 1
    assert r["provenance"] and r["provenance"]["shown"]
    assert "synthetic/reference-sample" in r["provenance"]["text"]
    assert "shadow of the space" in r["provenance"]["text"]
    assert r["notes"] == {"tumble": True, "lattice": False, "wander": False}
    assert f"with {r['info']['dimension']} dimensions" in r["noteText"]


def test_sample_page_is_clean_and_fits_the_width(sample_run):
    name, r = sample_run
    assert r["csp"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []
    assert r["scrollWidth"] <= r["clientWidth"], f"horizontal overflow at {name}"


def test_data_file_shows_its_model_and_count(browser, base_url):
    r = _open(browser, base_url, "?data=valid-384.json&mode=lattice&seed=7", settle=_drawn)
    assert r["state"] == "ready", r["wait"]
    assert r["info"]["model"] == "fixture/model-a"
    assert r["info"]["count"] == 6 and r["info"]["dimension"] == 384
    assert r["info"]["mode"] == "lattice"
    text = r["provenance"]["text"]
    assert "fixture/model-a" in text and "fixture: valid-384" in text
    assert "6 items" in text
    assert r["notes"] == {"tumble": False, "lattice": True, "wander": False}
    assert any(u.endswith("/valid-384.f32") for u in r["requests"])
    assert r["csp"] == [] and r["console_errors"] == [] and r["foreign"] == []


def test_data_on_another_origin_is_refused_without_a_request(browser, base_url):
    r = _open(browser, base_url, "?data=" + FOREIGN)
    assert r["state"] == "error"
    assert "another origin" in r["wait"]
    assert r["info"] is None, "no viewer is mounted for a refused address"
    assert r["foreign"] == [], r["foreign"]
    assert r["csp"] == [] and r["console_errors"] == []


def test_missing_file_shows_a_plain_message(browser, base_url):
    r = _open(browser, base_url, "?data=no-such-set.json")
    assert r["state"] == "error"
    assert r["waitShown"]
    assert '"no-such-set.json" could not be loaded' in r["wait"]
    assert "404" in r["wait"]
    # The browser itself logs the failed request; nothing else may reach the console.
    assert all("404" in e for e in r["console_errors"]), r["console_errors"]
    assert not any(e.startswith("pageerror") for e in r["console_errors"])
    assert r["csp"] == [] and r["foreign"] == []


def test_a_refused_set_shows_the_viewers_message_and_no_points(browser, base_url):
    # Also the negative control for the lit-pixel count above: an empty sky counts ~0.
    r = _open(browser, base_url, "?data=bumped-version.json")
    assert r["state"] == "refused"
    assert "schema version 2" in (r["info"]["message"] or "")
    assert r["lit"] is not None and r["lit"] < 50, r["lit"]
    assert r["csp"] == [] and r["console_errors"] == [] and r["foreign"] == []
