"""Negative controls: proof that each harness measure would catch what it is meant to catch.

A check that has never been seen to fail proves nothing. Each test here loads a deliberately
bad fixture page (``fixtures/bad-*.html``) and asserts that the harness assertion **fails** on
it:

* the network log: one request of each kind (image, script, stylesheet, fetch, XHR, beacon,
  websocket, web font, iframe, event source) to "another origin", which is a second loopback
  server on another port (never a real host), plus one to a host name that does not resolve;
  the other server's own request counter confirms the request really left the page;
* the CSP assertion: an inline script, and an external image, under a policy that forbids them;
* the console assertion: a ``console.error`` and an uncaught error (and ``allow=`` lets exactly
  what it names through);
* the leak counters: one of everything they count, never given back;
* the lit-pixel measure: a mounted viewer with no data counts (almost) nothing;
* the renderer: the browser really answered with the renderer the session asked for.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

KINDS = [
    "img",
    "script",
    "stylesheet",
    "fetch",
    "xhr",
    "beacon",
    "websocket",
    "font",
    "iframe",
    "eventsource",
]


def _open_bad(open_tab, server, query):
    tab = open_tab()
    tab.goto(server.url("bad-foreign.html?" + query))
    tab.wait_for("() => window.__bad && window.__bad.done")
    return tab


@pytest.mark.parametrize("kind", KINDS)
def test_network_log_catches_a_request_to_another_origin(open_tab, site, foreign, kind):
    server = site()
    hits_before = len(foreign.hits)
    tab = _open_bad(open_tab, server, f"kind={kind}&foreign={foreign.origin}")
    tab.wait_for(
        "() => true",
        lambda _: len(tab.foreign_requests(server.origin)) > 0,
        what=f"the {kind} request to appear in the log",
        timeout=10,
    )
    with pytest.raises(AssertionError, match="other than"):
        tab.assert_no_foreign_requests(server.origin)
    logged = tab.foreign_requests(server.origin)
    foreign_host = foreign.origin.split("//", 1)[1]
    assert all(r["url"].split("//", 1)[1].startswith(foreign_host + "/") for r in logged), logged
    # The other origin's own counter agrees that the request really went out.
    harness.wait_for(
        tab.page,
        "() => true",
        lambda _: any(f"/probe-{kind}" in h for h in foreign.hits[hits_before:]),
        what=f"the foreign server to receive the {kind} request",
        timeout=10,
    )


def test_network_log_catches_a_request_to_a_name_that_never_resolves(open_tab, site):
    server = site()
    tab = _open_bad(open_tab, server, "kind=img&foreign=http://elsewhere.invalid")
    tab.wait_for("() => true", lambda _: len(tab.foreign_requests(server.origin)) > 0)
    with pytest.raises(AssertionError):
        tab.assert_no_foreign_requests(server.origin)


def test_csp_assertion_catches_an_inline_script(open_tab, site):
    tab = open_tab()
    tab.goto(site("script-src 'self'").url("bad-inline.html"))
    tab.wait_for("() => true", lambda _: len(tab.csp) > 0, what="a violation report")
    assert tab.evaluate("() => window.__inlineRan === true") is False
    with pytest.raises(AssertionError, match="Content-Security-Policy"):
        tab.assert_no_csp_violations()
    assert tab.csp[0]["effective"] == "script-src-elem"


def test_csp_assertion_catches_a_blocked_request_to_another_origin(open_tab, site, foreign):
    tab = open_tab()
    server = site("default-src 'self'")
    hits_before = len(foreign.hits)
    tab.goto(server.url(f"bad-foreign.html?kind=img&foreign={foreign.origin}"))
    tab.wait_for("() => true", lambda _: len(tab.csp) > 0, what="a violation report")
    with pytest.raises(AssertionError):
        tab.assert_no_csp_violations()
    assert tab.csp[0]["blocked"].startswith(foreign.origin)
    assert foreign.hits[hits_before:] == [], "the policy blocked it, so nothing reached the server"


def test_console_assertion_catches_errors_and_allow_is_narrow(open_tab, site):
    tab = open_tab()
    tab.goto(site().url("bad-console.html"))
    tab.wait_for("() => true", lambda _: len(tab.console_errors()) >= 2)
    with pytest.raises(AssertionError, match="planted console error"):
        tab.assert_no_console_errors()
    with pytest.raises(AssertionError, match="planted uncaught error"):
        tab.assert_no_console_errors(allow=["planted console error"])
    tab.assert_no_console_errors(allow=["planted console error", "planted uncaught error"])


def test_leak_counters_catch_one_of_everything(open_tab, site, webgl):
    tab = open_tab()
    tab.goto(site().url("bad-leak.html"))
    tab.wait_for("() => !!window.__bad")
    baseline = tab.evaluate("() => window.__harness.snapshot()")
    tab.evaluate("() => window.__bad.leak()")
    after = tab.evaluate(
        "async () => { await window.__harness.frames(5); return window.__harness.snapshot(); }"
    )
    leaks = harness.leaks(baseline, after)
    assert set(leaks) == set(harness.LEAK_KEYS), (leaks, baseline, after)


def test_lit_pixels_of_a_viewer_with_no_data_is_near_zero(open_tab, site, webgl):
    tab = open_tab()
    tab.goto(site().url("script-host.html?manual=1"))
    tab.wait_for("() => !!window.__host")
    tab.evaluate("() => { window.EmbeddingsTumbler.mount(document.getElementById('space')); }")
    tab.wait_for("() => window.__host.info().frames", lambda f: f >= 1)
    tab.page.wait_for_timeout(300)
    lit = harness.lit_pixels(tab.png("#space canvas.tumbler-canvas"))
    assert lit < 50, lit


def test_the_browser_runs_the_renderer_the_session_asked_for(webgl):
    """The renderer is part of every test id; this makes sure it is also the truth."""
    if harness.renderer() == "swiftshader":
        assert "SwiftShader" in webgl, webgl
    else:
        assert "SwiftShader" not in webgl, f"asked for a GPU, got software rendering: {webgl}"
    print(f"WebGL renderer: {webgl}")


def test_require_browser_probe():
    """Skipped on purpose when ``TUMBLER_HARNESS_SKIP_PROBE=1``; ``tests/test_browser_require.py``
    runs it in a subprocess to show that ``TUMBLER_REQUIRE_BROWSER=1`` turns the skip into a
    failure. Otherwise it passes and does nothing."""
    import os

    if os.environ.get("TUMBLER_HARNESS_SKIP_PROBE") == "1":
        harness.unavailable("probe skip for tests/test_browser_require.py")
