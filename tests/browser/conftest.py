"""Fixtures and hooks for every browser test (task t14). See ``tests/browser/README.md``.

* ``browser``: one Chromium per test session (per xdist worker), parametrised by the renderer
  so every test id carries it, for example ``test_x[swiftshader]``.
* ``webgl``: the WebGL renderer string the browser really answered with; skips without WebGL 2.
* ``host_site`` / ``site`` / ``foreign``: the folder the canonical fixtures are served from
  (built with ``viewer write``), loopback servers over it (with or without a CSP header), and a
  second loopback server that plays "another origin" for negative controls.
* ``open_tab``: a factory for :class:`harness.Tab` pages, closed at the end of the test.

Hooks: every skip in ``tests/browser`` becomes a failure when ``TUMBLER_REQUIRE_BROWSER=1``
(CI sets it, so the suite cannot stop running unnoticed); each browser test module is one xdist
group, so a module's shared browser session runs once under ``pytest -n auto`` (with
``--dist loadgroup``, set in ``pyproject.toml``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.browser import harness

HERE = Path(__file__).resolve().parent


def _in_browser_suite(path) -> bool:
    try:
        Path(str(path)).resolve().relative_to(HERE)
    except ValueError:
        return False
    return True


def pytest_collection_modifyitems(config, items):
    for item in items:
        if _in_browser_suite(item.path):
            item.add_marker(pytest.mark.xdist_group(name="browser-" + Path(item.path).stem))


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    if not (report.skipped and harness.require_browser() and _in_browser_suite(item.path)):
        return
    if hasattr(report, "wasxfail"):
        return
    reason = report.longrepr[2] if isinstance(report.longrepr, tuple) else str(report.longrepr)
    report.outcome = "failed"
    report.longrepr = (
        f"{harness.REQUIRE_ENV}=1 turns every browser skip into a failure; "
        f"this test would have skipped: {reason}"
    )


@pytest.fixture(scope="session", params=[harness.renderer()], ids=lambda name: name)
def browser(request):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        harness.unavailable("Playwright is not installed; run `uv sync`")
    pw = sync_playwright().start()
    try:
        b = harness.launch(pw, request.param)
    except BaseException:
        pw.stop()
        raise
    try:
        yield b
    finally:
        b.close()
        pw.stop()


@pytest.fixture(scope="session")
def webgl(browser) -> str:
    context = browser.new_context()
    try:
        page = context.new_page()
        page.goto("about:blank")
        name = page.evaluate(harness.WEBGL_RENDERER)
    finally:
        context.close()
    if not name:
        harness.unavailable("WebGL 2 is not available in this headless Chromium")
    return name


@pytest.fixture(scope="session")
def host_site(tmp_path_factory) -> Path:
    return harness.build_host_site(tmp_path_factory.mktemp("host-site"))


@pytest.fixture(scope="session")
def site(host_site):
    """``site(csp=None)``: a loopback server over the host site, one per policy, reused."""
    servers: dict[str | None, harness.Server] = {}

    def get(csp: str | None = None) -> harness.Server:
        if csp not in servers:
            servers[csp] = harness.Server(host_site, csp=csp)
        return servers[csp]

    yield get
    for s in servers.values():
        s.close()


@pytest.fixture(scope="session")
def foreign(tmp_path_factory):
    """Another origin (a second loopback server on another port) for negative controls."""
    folder = tmp_path_factory.mktemp("foreign")
    (folder / "index.html").write_text("<!doctype html><title>foreign</title>", encoding="utf-8")
    with harness.Server(folder) as server:
        yield server


@pytest.fixture
def open_tab(browser):
    tabs: list[harness.Tab] = []

    def make(**kw) -> harness.Tab:
        tab = harness.Tab(browser, **kw)
        tabs.append(tab)
        return tab

    yield make
    for tab in tabs:
        tab.close()
