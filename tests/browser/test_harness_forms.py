"""The three canonical host forms under the network log (t14 criteria 1 and 2).

Each form is served from the host site (``conftest.host_site``: the folder ``embeddings-tumbler
viewer write`` produced, plus the fixture pages) on a loopback server, opened in a fresh
context, run through all three modes, and checked: every logged request is on the test
server's origin; no CSP violation; no console error; the canvas shows points.

Runs, and why each:

* ``script-no-csp``: fixture 1, served with **no** policy, so nothing in the browser would
  block a request to another origin: the network log alone is the measure.
* ``component-script-src-self``: fixture 2 under exactly ``script-src 'self'`` (criterion 2's
  wording), and ``component-default-src-self`` under the stricter ``default-src 'self'``.
* ``component-bypass-csp``: fixture 2 with the policy switched off in the browser
  (``bypass_csp``), so a request the policy would have blocked would show in the log.
* ``standalone-sample`` / ``standalone-data``: the shipped page, under its own
  ``default-src 'self'`` meta policy, with the built-in sample and with ``?data=``;
  ``standalone-bypass-csp`` with ``?data=`` and the policy switched off. Every run but the
  12,288-point sample clicks through all three modes.

Rendering is software (SwiftShader) unless ``TUMBLER_BROWSER_RENDERER=gpu``; the renderer is
in every test id.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

RUNS = {
    # id: (page, element id, csp header, bypass_csp)
    "script-no-csp": ("script-host.html", "space", None, False),
    "component-script-src-self": ("component-host.html", "wc", "script-src 'self'", False),
    "component-default-src-self": ("component-host.html", "wc", "default-src 'self'", False),
    "component-bypass-csp": ("component-host.html", "wc", "script-src 'self'", True),
    "standalone-sample": ("index.html", "space", None, False),
    "standalone-data": ("index.html?data=twin-blobs.json", "space", None, False),
    "standalone-bypass-csp": ("index.html?data=twin-blobs.json", "space", None, True),
}

INFO = """(id) => {
  const T = window.EmbeddingsTumbler;
  const h = T && T.get(document.getElementById(id));
  if (!h) return null;
  const i = h.info();
  return { ready: i.ready, frames: i.frames, count: i.count, mode: i.mode,
           rendering: i.rendering, message: i.message };
}"""

CLICK_MODE = """([id, mode]) => {
  document.getElementById(id).querySelector('button.tumbler-mode[data-mode="' + mode + '"]')
    .click();
  return true;
}"""


@pytest.fixture(scope="module", params=list(RUNS))
def form_run(request, browser, webgl, site):
    page, el_id, csp, bypass = RUNS[request.param]
    server = site(csp)
    tab = harness.Tab(browser, viewport=(1100, 900), bypass_csp=bypass)
    try:
        response = tab.page.goto(server.url(page))
        info = tab.wait_for(
            INFO,
            lambda i: bool(i and i["ready"] and i["count"] and i["frames"] > 3),
            arg=el_id,
            # The 12,288-point sample is slow to fit on SwiftShader, and slower still when
            # the whole suite shares the CPU with it (the coverage run in CI).
            timeout=300,
        )
        modes = {}
        # The 12,288-point sample is slow to prepare Lattice and Wander on SwiftShader; its run
        # checks the network on load and in Tumble (test_standalone_page.py covers the page).
        cycle = () if request.param == "standalone-sample" else ("lattice", "wander", "tumble")
        for mode in cycle:
            tab.evaluate(CLICK_MODE, [el_id, mode])
            start = tab.evaluate(INFO, el_id)["frames"]
            modes[mode] = tab.wait_for(
                INFO,
                lambda i, m=mode, s=start: i["mode"] == m and i["frames"] > s + 10,
                arg=el_id,
                timeout=300,
                what=f"{mode} to draw frames",
            )
        lit = harness.lit_pixels(tab.png(f"#{el_id} canvas.tumbler-canvas"))
        yield {
            "id": request.param,
            "tab": tab,
            "origin": server.origin,
            "csp_header": response.headers.get("content-security-policy"),
            "info": info,
            "modes": modes,
            "lit": lit,
        }
    finally:
        tab.close()


def test_c1_network_log_holds_only_the_test_servers_origin(form_run):
    tab = form_run["tab"]
    tab.assert_no_foreign_requests(form_run["origin"])
    urls = [r["url"].removeprefix(form_run["origin"]) for r in tab.requests]
    # The log is live: it holds the page and the core file it loaded.
    assert any(r["type"] == "document" for r in tab.requests), urls
    assert any(u.endswith("/embeddings-tumbler.js") for u in urls), urls
    if form_run["id"] != "standalone-sample":
        assert any(u.endswith("/twin-blobs.f32") for u in urls), urls  # the data fetches too
    print(f"{form_run['id']}: {len(urls)} requests, all on {form_run['origin']}: {urls}")


def test_c2_no_csp_violation(form_run):
    form_run["tab"].assert_no_csp_violations()


def test_no_console_error_or_page_error(form_run):
    form_run["tab"].assert_no_console_errors()


def test_the_canvas_shows_points_in_every_mode(form_run):
    assert form_run["info"]["rendering"] is not False, form_run["info"]["message"]
    assert form_run["lit"] > 200, f"the canvas shows {form_run['lit']} lit pixels"
    if form_run["id"] != "standalone-sample":
        assert set(form_run["modes"]) == {"lattice", "wander", "tumble"}


def test_c2_the_policy_each_run_was_served_under(form_run):
    """Criterion 2 is the ``component-script-src-self`` run: its header is exactly
    ``script-src 'self'``, and the tests above show it rendered with no violation."""
    _, _, csp, _ = RUNS[form_run["id"]]
    assert form_run["csp_header"] == csp
