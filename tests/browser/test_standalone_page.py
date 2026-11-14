"""Headless-browser check of the shipped standalone page (task t11).

The folder under test is produced the way a host gets it: ``embeddings-tumbler
viewer write <tmp> --apply`` copies the shipped set into a temporary folder, a
contract fixture pair (``valid-384.json`` and ``valid-384.f32``) is copied next
to it, and the folder is served on a loopback port. So the test also proves the
shipped set is complete and self-contained.

Checked: with no query the shipped Wikipedia pair (``demo-wikipedia.json``) is shown, its
count and dimension in the masthead, with a link to the synthetic set; without the pair the
page falls back to the synthetic set and says so; ``?sample=synthetic`` renders the sample
set (lit pixels on the canvas) with
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

import json
import shutil
import threading
from pathlib import Path

import pytest

from embeddings_tumbler import _static_server
from embeddings_tumbler._embed_route import EmbedRoute
from embeddings_tumbler.cli import main
from tests.browser import harness
from tests.test_embed_route import QUERY, _config, _Gateway

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
    masthead: (el.querySelector('.tumbler-masthead') || {}).textContent || '',
    demoNote: visible('#note-demo'),
    sampleNote: visible('#note-sample'),
    switchText: (document.getElementById('set-switch') || {}).textContent || '',
    switchHref: (document.getElementById('set-switch-link') || {}).getAttribute
      ? document.getElementById('set-switch-link').getAttribute('href') : null,
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
    # The same pair whose descriptor declares big-endian float64: the file form's own
    # checks must refuse it, not draw the bytes as garbage.
    wrong = json.loads((FIXTURES / "valid-384.json").read_text(encoding="utf-8"))
    wrong["vectors"].update({"dtype": "float64", "byte_order": "big"})
    (folder / "float64-384.json").write_text(json.dumps(wrong), encoding="utf-8")
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
    return request.param, _open(
        browser, base_url, "?sample=synthetic", VIEWPORTS[request.param], _drawn
    )


def test_sample_set_renders_with_modes_provenance_and_controls(sample_run):
    _, r = sample_run
    assert r["state"] == "ready", r["wait"]
    assert r["info"]["model"] == "synthetic/reference-sample"
    assert r["info"]["count"] > 0
    assert r["lit"], "the sky shows no lit points"
    assert r["lit"] > 200, "the sky shows no lit points"
    assert r["modes"] == ["tumble", "lattice", "wander", "focus"]
    assert r["controls"] == {"play": 1, "speed": 1, "labels": 1, "trails": 1}
    assert r["readout"] == 1
    assert r["provenance"]
    assert r["provenance"]["shown"]
    assert "synthetic/reference-sample" in r["provenance"]["text"]
    assert "shadow of the space" in r["provenance"]["text"]
    assert r["notes"] == {"tumble": True, "lattice": False, "wander": False}
    assert f"with {r['info']['dimension']} dimensions" in r["noteText"]


def test_sample_page_is_clean_and_fits_the_width(sample_run):
    name, r = sample_run
    assert r["state"] == "ready", r["wait"]
    assert r["csp"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []
    assert r["scrollWidth"] <= r["clientWidth"], f"horizontal overflow at {name}"


def test_sample_set_is_the_explicit_choice_and_links_back(sample_run):
    _, r = sample_run
    assert r["sampleNote"]
    assert not r["demoNote"]
    assert "Showing the synthetic sample set." in r["switchText"]
    assert r["switchHref"] == "/index.html"
    assert not any(u.endswith("/demo-wikipedia.json") for u in r["requests"])


DEMO = json.loads(
    (ROOT / "embeddings_tumbler" / "static" / "demo-wikipedia.json").read_text(encoding="utf-8")
)


def _thousands(n: int) -> str:
    return f"{n:,}"


def test_with_no_query_the_wikipedia_pair_is_shown_with_its_own_numbers(browser, base_url):
    r = _open(browser, base_url, "", settle=_drawn)
    assert r["state"] == "ready", r["wait"]
    assert r["info"]["model"] == DEMO["model"]
    assert r["info"]["count"] == DEMO["count"]
    assert r["info"]["dimension"] == DEMO["dimension"]
    expected = (
        f"{_thousands(DEMO['count'])} embeddings · {_thousands(DEMO['dimension'])} dimensions"
    )
    assert expected in r["masthead"], r["masthead"]
    assert "Wikipedia" in r["provenance"]["text"]
    assert "CC BY-SA 4.0" in r["provenance"]["text"]
    assert r["demoNote"]
    assert not r["sampleNote"]
    assert r["switchHref"] == "?sample=synthetic"
    assert any(u.endswith("/demo-wikipedia.f32") for u in r["requests"])
    assert r["csp"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []


@pytest.fixture(scope="module")
def bare_url(tmp_path_factory, host_folder):
    """The shipped set without the Wikipedia pair: a host that copied only some files."""
    folder = tmp_path_factory.mktemp("bare")
    for path in host_folder.iterdir():
        if not path.name.startswith("demo-wikipedia."):
            shutil.copy(path, folder / path.name)
    with harness.Server(folder) as server:
        yield server.origin


def test_without_the_pair_the_page_falls_back_to_the_synthetic_set(browser, bare_url):
    r = _open(browser, bare_url, "", settle=_drawn)
    assert r["state"] == "ready", r["wait"]
    assert r["info"]["model"] == "synthetic/reference-sample"
    assert r["sampleNote"]
    assert "could not be read from this folder" in r["switchText"]
    # The browser's own line for the missing file is the only console entry.
    assert all("404" in e for e in r["console_errors"]), r["console_errors"]
    assert r["csp"] == []
    assert r["foreign"] == []


def test_data_file_shows_its_model_and_count(browser, base_url):
    r = _open(browser, base_url, "?data=valid-384.json&mode=lattice&seed=7", settle=_drawn)
    assert r["state"] == "ready", r["wait"]
    assert r["info"]["model"] == "fixture/model-a"
    assert r["info"]["count"] == 6
    assert r["info"]["dimension"] == 384
    assert r["info"]["mode"] == "lattice"
    text = r["provenance"]["text"]
    assert "fixture/model-a" in text
    assert "fixture: valid-384" in text
    assert "6 items" in text
    assert r["notes"] == {"tumble": False, "lattice": True, "wander": False}
    assert any(u.endswith("/valid-384.f32") for u in r["requests"])
    assert r["csp"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []


def test_data_on_another_origin_is_refused_without_a_request(browser, base_url):
    r = _open(browser, base_url, "?data=" + FOREIGN)
    assert r["state"] == "error"
    assert "another origin" in r["wait"]
    assert r["info"] is None, "no viewer is mounted for a refused address"
    assert r["foreign"] == [], r["foreign"]
    assert r["csp"] == []
    assert r["console_errors"] == []


def test_missing_file_shows_a_plain_message(browser, base_url):
    r = _open(browser, base_url, "?data=no-such-set.json")
    assert r["state"] == "error"
    assert r["waitShown"]
    assert '"no-such-set.json" could not be loaded' in r["wait"]
    assert "404" in r["wait"]
    # The browser itself logs the failed request; nothing else may reach the console.
    assert r["console_errors"], "expected the browser's own 404 line in the console"
    assert all("404" in e for e in r["console_errors"]), r["console_errors"]
    assert not any(e.startswith("pageerror") for e in r["console_errors"])
    assert r["csp"] == []
    assert r["foreign"] == []


def test_a_refused_set_shows_the_viewers_message_and_no_points(browser, base_url):
    # Also the negative control for the lit-pixel count above: an empty sky counts ~0.
    r = _open(browser, base_url, "?data=bumped-version.json")
    assert r["state"] == "refused"
    assert "schema version 2" in (r["info"]["message"] or "")
    assert r["lit"] is not None, r["lit"]
    assert r["lit"] < 50, r["lit"]
    assert r["csp"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []


def test_a_descriptor_declaring_another_dtype_is_refused(browser, base_url):
    r = _open(browser, base_url, "?data=float64-384.json")
    assert r["state"] == "refused"
    assert 'Field "vectors.dtype" is missing or not valid.' in (r["info"]["message"] or "")
    assert r["lit"] is not None, r["lit"]
    assert r["lit"] < 50, r["lit"]
    assert r["csp"] == []
    assert r["console_errors"] == []
    assert r["foreign"] == []


# --------------------------------------------------------------------------- search helper

ROUTE_PATH = "/_tumbler/search"
FIXTURE_MODEL = "fixture/model-a"
BROWSER_ERRORS = [r"status of (404|405|501)"]  # the browser's own line for a refused probe
SEARCH = """async (text) => {
  const h = window.EmbeddingsTumbler.get(document.getElementById('space'));
  const result = await h.setSearches([text]);
  const s = h.info().search;
  return { result, search: {
    embedder: s.embedder, reranker: s.reranker,
    searches: s.searches.map((x) => ({ kind: x.kind, text: x.text, sentTo: x.sentTo,
      model: x.model, queryForm: x.queryForm })) } };
}"""
STATE = """() => {
  const h = window.EmbeddingsTumbler.get(document.getElementById('space'));
  const s = h.info().search;
  return { embedder: s.embedder, reranker: s.reranker };
}"""


@pytest.fixture
def helper_origin(host_folder):
    """The real server the CLI builds, with the embed route, over a fake gateway."""
    gateway = _Gateway()
    gateway.dimension = 384  # the fixture set's dimension
    gateway.model_in_answer = FIXTURE_MODEL
    route = EmbedRoute(_config(gateway.base, embed_model=FIXTURE_MODEL, rerank_model=None))
    server = _static_server.make_server(host_folder, port=0, quiet=True, embed=route)
    thread = threading.Thread(target=server.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    yield origin, gateway
    server.shutdown()
    server.server_close()
    thread.join(5)
    gateway.close()


def _tab_on(browser, origin, query):
    tab = harness.Tab(browser, viewport=VIEWPORTS["desktop"])
    tab.page.goto(origin + "/index.html" + query)
    tab.wait_for(
        PROBE,
        lambda r: r["state"] == "ready" and bool(r["info"]["ready"]),
        timeout=90,
        what="the page to be ready",
    )
    return tab


@pytest.mark.parametrize(
    "query",
    [
        "?data=valid-384.json",
        "?data=valid-384.json&helper=http://foreign.invalid&route=http://foreign.invalid/x",
    ],
    ids=["plain", "query-names-another-helper"],
)
def test_served_with_the_embed_route_typed_text_is_embedded(browser, helper_origin, query):
    origin, gateway = helper_origin
    tab = _tab_on(browser, origin, query)
    try:
        assert tab.page.evaluate(STATE)["embedder"] == {"available": True}
        answer = tab.page.evaluate(SEARCH, QUERY)
        assert answer["result"]["ok"], answer
        first = answer["search"]["searches"][0]
        assert first["kind"] == "embedded"
        assert first["sentTo"] == "embedder"
        assert first["model"] == FIXTURE_MODEL
        assert first["queryForm"] == "plain"
        assert [g["body"]["input"] for g in gateway.seen] == [[QUERY]], "the gateway got the text"
        posts = [r for r in tab.requests if r["method"] == "POST"]
        assert [urlpath(r["url"]) for r in posts] == [ROUTE_PATH, ROUTE_PATH], posts
        assert tab.foreign_requests(origin) == []
        assert tab.csp == []
        assert tab.console_errors() == []
    finally:
        tab.close()


def urlpath(url):
    return "/" + url.split("/", 3)[3]


def test_a_gateway_that_fails_leaves_a_plain_refusal_and_a_working_page(browser, helper_origin):
    origin, gateway = helper_origin
    gateway.mode = "error"
    tab = _tab_on(browser, origin, "?data=valid-384.json")
    try:
        answer = tab.page.evaluate(SEARCH, "some words")
        assert not answer["result"]["ok"]
        assert answer["result"]["code"] == "embed-failed"
        assert "SENTINEL" not in json.dumps(answer), "the gateway's text never reaches the page"
        assert tab.page.evaluate(STATE)["embedder"] == {"available": True}
        assert tab.foreign_requests(origin) == []
        # The browser's own line for the route's 502 is the only console entry.
        assert tab.console_errors(allow=[r"status of 502"]) == []
    finally:
        tab.close()


def test_served_as_plain_files_search_matches_the_loaded_points(browser, base_url):
    # base_url is the static test server: a POST to the route is refused there (501).
    tab = _tab_on(browser, base_url, "?data=valid-384.json")
    try:
        assert tab.page.evaluate(STATE)["embedder"] == {"available": False}
        answer = tab.page.evaluate(SEARCH, "gateway")
        first = answer["search"]["searches"][0]
        assert first["sentTo"] == "nowhere"
        assert first["kind"] == "words"
        refused = tab.page.evaluate("""async () => {
              const h = window.EmbeddingsTumbler.get(document.getElementById('space'));
              return await h.setSearches([{ text: 'x', via: 'embed' }]);
            }""")
        assert refused["code"] == "no-embedder"
        posts = [r for r in tab.requests if r["method"] == "POST"]
        assert len(posts) == 1, "one describe request and no retry"
        assert tab.foreign_requests(base_url) == []
        assert tab.csp == []
        assert tab.console_errors(allow=BROWSER_ERRORS) == []
    finally:
        tab.close()


def test_opened_as_a_plain_file_the_page_works_and_asks_for_nothing(browser, host_folder):
    tab = _tab_on(browser, "file://" + str(host_folder), "")
    try:
        assert tab.page.evaluate(STATE)["embedder"] == {"available": False}
        assert [r for r in tab.requests if r["method"] == "POST"] == []
        assert not [r for r in tab.requests if r["url"].startswith(("http:", "https:"))]
        assert tab.csp == []
        assert tab.console_errors() == []
    finally:
        tab.close()
