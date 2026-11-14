"""Twenty mounts and destroys leave nothing behind (t14 criterion 4).

The fixture pages load ``fixtures/instrument.js`` before the core file (a plain
``<script src>`` from the test server, so the page's policy allows it). It wraps
``requestAnimationFrame``/``cancelAnimationFrame``, ``setTimeout``/``setInterval``, the three
observers, ``getContext`` and ``window``/``document`` listeners, and counts what is still held
(see that file). "Zero" means **equal to the baseline taken before the first mount**, on a page
where the core file has loaded and nothing is mounted (``?manual=1``). On these pages that
baseline is 0 for canvases, live WebGL contexts, pending animation callbacks, timers and
observers; the window/document listener count is whatever the page's own scripts added.

Script form: twenty cycles each of mount/destroy with no data, mount/update/first-frame/destroy
with data on the same element, and the same on a fresh element each time. Web component: twenty
add/wait-for-load/remove cycles of a fresh element, then twenty add/remove cycles in one task
(the fetch is still in flight when the element goes). After each batch: a few frames, then the
counts must equal the baseline, and ``EmbeddingsTumbler.get(el)`` must be ``null`` for every
element used.
"""

from __future__ import annotations

import pytest

from tests.browser import harness

SETTLE = """async () => { await window.__harness.sleep(300); await window.__harness.frames(5);
  return window.__harness.snapshot(); }"""
SNAPSHOT = "() => window.__harness.snapshot()"


def _settled(tab, extra_ms: int = 0) -> dict:
    if extra_ms:
        tab.page.wait_for_timeout(extra_ms)
    return tab.evaluate(SETTLE)


def _report(label, baseline, after, peak):
    keys = harness.LEAK_KEYS
    print(
        f"{label}: peak live WebGL contexts {peak}; "
        + ", ".join(f"{k} {baseline[k]}->{after[k]}" for k in keys)
    )


@pytest.fixture
def script_page(open_tab, site, webgl):
    tab = open_tab()
    tab.goto(site().url("script-host.html?manual=1"))
    tab.wait_for("() => !!(window.__host && window.EmbeddingsTumbler)")
    return tab


@pytest.mark.parametrize("kind", ["empty", "data", "fresh"])
def test_c4_twenty_mount_destroy_cycles_leave_nothing_script_form(script_page, kind):
    tab = script_page
    baseline = _settled(tab)
    for key in ("canvases", "glLive", "rafPending", "timeouts", "intervals"):
        assert baseline[key] == 0, (key, baseline)
    result = tab.page.evaluate(f"() => window.__host.cycles(20, '{kind}')")
    after = _settled(tab)
    _report(f"script/{kind}", baseline, after, result["peakGl"])
    assert after["glCreated"] >= 20, "the cycles did not create a WebGL context each"
    assert after["observersMade"] > baseline["observersMade"], "the viewer made no observers?"
    assert harness.leaks(baseline, after) == {}
    held = tab.evaluate("""() => {
        const T = window.EmbeddingsTumbler;
        const els = [document.getElementById('space')].concat(window.__host.cycled);
        return { viewers: els.filter((e) => T.get(e) !== null).length, checked: els.length,
                 roots: document.querySelectorAll('.tumbler').length,
                 children: document.getElementById('space').children.length };
    }""")
    assert held["viewers"] == 0, held
    assert held["roots"] == 0, held
    assert held["children"] == 0, held
    if kind == "fresh":
        assert held["checked"] == 21


def test_c4_destroying_the_auto_mounted_viewer_returns_to_the_page_before_the_core(open_tab, site):
    """The canonical page mounts on load. Destroying that viewer must return every count to the
    snapshot ``instrument.js`` took before the core file even loaded."""
    tab = open_tab()
    tab.goto(site().url("script-host.html"))
    tab.wait_for("() => window.__host.state", lambda s: s in ("ready", "refused", "error"))
    tab.wait_for("() => window.__host.info().frames", lambda f: f > 3)
    tab.evaluate("() => window.EmbeddingsTumbler.destroy(document.getElementById('space'))")
    after = _settled(tab)
    loaded = tab.evaluate("() => window.__harness.loaded")
    # The page script's own listeners are not the viewer's; compare the rest exactly.
    leaks = harness.leaks(loaded, after)
    leaks.pop("globalListeners", None)
    assert leaks == {}, leaks


@pytest.fixture
def component_page(open_tab, site, webgl):
    tab = open_tab()
    tab.goto(site("script-src 'self'").url("component-host.html?manual=1"))
    tab.wait_for("() => !!(window.__wc && customElements.get('embeddings-tumbler'))")
    assert tab.evaluate("() => document.querySelectorAll('embeddings-tumbler').length") == 0
    return tab


def test_c4_twenty_element_add_remove_cycles_leave_nothing_web_component(component_page):
    tab = component_page
    baseline = _settled(tab)
    for key in ("canvases", "glLive", "rafPending", "timeouts", "intervals"):
        assert baseline[key] == 0, (key, baseline)
    waited = tab.page.evaluate("() => window.__wc.cycles(20, true)")
    after_waited = _settled(tab)
    _report("component/wait-for-load", baseline, after_waited, waited["peakGl"])
    loads = tab.evaluate("() => window.__wc.events.filter((e) => e.type === 'tumbler-load').length")
    assert loads == 20, "each element loaded its src once"
    assert harness.leaks(baseline, after_waited) == {}

    rushed = tab.page.evaluate("() => window.__wc.cycles(20, false)")
    after_rushed = _settled(tab, extra_ms=1500)  # let the dropped fetches finish
    _report("component/in-flight", baseline, after_rushed, rushed["peakGl"])
    assert harness.leaks(baseline, after_rushed) == {}
    held = tab.evaluate("""() => {
        const T = window.EmbeddingsTumbler;
        const els = window.__wc.cycled;
        return { checked: els.length,
                 viewers: els.filter((e) => T.get(e) !== null || e.handle).length,
                 children: els.reduce((n, e) => n + e.children.length, 0),
                 roots: document.querySelectorAll('.tumbler').length,
                 loads: window.__wc.events.filter((e) => e.type === 'tumbler-load').length };
    }""")
    assert held["checked"] == 40, held
    assert held["viewers"] == 0, held
    assert held["children"] == 0, held
    assert held["roots"] == 0, held
    assert held["loads"] == 20, "a fetch that was in flight at removal still loaded a viewer"
    tab.assert_no_console_errors()
    tab.assert_no_csp_violations()
