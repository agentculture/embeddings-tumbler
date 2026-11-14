"""Headless-browser check of the viewer's host-adjustable spacing (``--tumbler-*`` properties).

The viewer sets its spacing inline as ``var(--tumbler-<name>, <default>)`` (see
``js/api/50-viewer.md``). Two pages are measured at 1280 px and 500 px wide:

* the shipped standalone page, whose ``page.css`` sets the properties on ``.space`` (and the
  narrow mode-title size in its own 600 px media query). Its computed title size, masthead and
  status offsets, panel padding and gap, mode padding, mode title and summary sizes, caption
  size and controls gap must be the page's values, not the viewer's defaults. Each of the
  page's sixteen property settings moves at least one asserted value away from the viewer's
  default, so deleting any one of them (or all) fails this test at one width or both (checked
  one by one when it was written);
* the script-form example from the host guide, a plain host that sets no spacing property:
  it must get exactly the viewer's own defaults, wide and narrow.

Neither depends on data being drawn, so the measurement is taken once the viewer is mounted.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from embeddings_tumbler.cli import main
from tests.browser import harness

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "docs" / "guides" / "examples" / "script"
POLICY = "default-src 'self'"
WIDTHS = {"wide": 1280, "narrow": 500}

MEASURE = """() => {
  const props = {
    '.tumbler-masthead': ['top', 'left', 'right'],
    '.tumbler-title': ['font-size', 'margin-top', 'margin-bottom'],
    '.tumbler-status': ['left', 'right', 'bottom'],
    '.tumbler-panel': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left',
                       'row-gap', 'column-gap'],
    '.tumbler-mode': ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
    '.tumbler-mode-title': ['font-size'],
    '.tumbler-mode-summary': ['font-size'],
    '.tumbler-readout-caption': ['font-size'],
    '.tumbler-controls': ['row-gap', 'column-gap'],
  };
  const out = {};
  for (const [sel, names] of Object.entries(props)) {
    const el = document.querySelector('#space ' + sel);
    if (!el) { out[sel] = null; continue; }
    const cs = getComputedStyle(el);
    out[sel] = Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n)]));
  }
  return out;
}"""

MOUNTED = "() => !!document.querySelector('#space .tumbler-controls')"


def _px(**kw):
    return {k.replace("_", "-"): v for k, v in kw.items()}


def _common(gutter, top, title_margin, status_bottom, panel, mode, summary, caption, controls):
    return {
        ".tumbler-masthead": _px(top=top, left=gutter, right=gutter),
        ".tumbler-title": _px(margin_top="0px", margin_bottom=title_margin),
        ".tumbler-status": _px(left=gutter, right=gutter, bottom=status_bottom),
        ".tumbler-panel": panel,
        ".tumbler-mode": mode,
        ".tumbler-mode-summary": _px(font_size=summary),
        ".tumbler-readout-caption": _px(font_size=caption),
        ".tumbler-controls": controls,
    }


# The standalone page today (measured with its former !important rules, which these replace).
PAGE_PANEL = _px(
    padding_top="8px",
    padding_right="20px",
    padding_bottom="0px",
    padding_left="20px",
    row_gap="20px",
    column_gap="20px",
)
PAGE_MODE = _px(padding_top="12px", padding_right="16px", padding_bottom="10px", padding_left="0px")
PAGE_BASE = _common(
    "20px", "22px", "8px", "16px", PAGE_PANEL, PAGE_MODE, "13px", "12px",
    _px(row_gap="10px", column_gap="22px"),
)  # fmt: skip
PAGE = {
    "wide": {**PAGE_BASE, "title-size": "64px", "mode-title-size": "28px"},
    "narrow": {**PAGE_BASE, "title-size": "34px", "mode-title-size": "24px"},
}

# The viewer's own defaults (no property set): clamp(28px, 6vw, 56px) is 56 px at 1280 and
# 30 px at 500; the panel padding and the mode title size change below 600 px.
HOST_MODE = _px(padding_top="10px", padding_right="12px", padding_bottom="8px", padding_left="0px")


def _host(padding, title, mode_title):
    panel = {**padding, "row-gap": "14px", "column-gap": "14px"}
    base = _common(
        "16px", "14px", "6px", "10px", panel, HOST_MODE, "12.5px", "11.5px",
        _px(row_gap="10px", column_gap="18px"),
    )  # fmt: skip
    return {**base, "title-size": title, "mode-title-size": mode_title}


HOST = {
    "wide": _host(
        _px(padding_top="6px", padding_right="16px", padding_bottom="16px", padding_left="16px"),
        "56px",
        "24px",
    ),
    "narrow": _host(
        _px(padding_top="6px", padding_right="12px", padding_bottom="14px", padding_left="12px"),
        "30px",
        "20px",
    ),
}


def _expected_by_selector(spec):
    out = {k: v for k, v in spec.items() if k.startswith(".")}
    out[".tumbler-title"] = {**out[".tumbler-title"], "font-size": spec["title-size"]}
    out[".tumbler-mode-title"] = {"font-size": spec["mode-title-size"]}
    return out


@pytest.fixture(scope="module")
def page_folder(tmp_path_factory):
    folder = tmp_path_factory.mktemp("page-spacing")
    assert main(["viewer", "write", str(folder), "--apply"]) == 0
    return folder


@pytest.fixture(scope="module")
def example_folder(tmp_path_factory):
    folder = tmp_path_factory.mktemp("example-script") / "script"
    shutil.copytree(EXAMPLE, folder)
    assert main(["viewer", "write", str(folder), "--apply", "--force"]) == 0
    return folder


def _measure(browser, folder, path, width):
    with harness.Server(folder, csp=POLICY) as server:
        tab = harness.Tab(browser, viewport=(width, 900))
        try:
            tab.goto(server.url(path))
            tab.wait_for(MOUNTED, timeout=30, what="the viewer to mount")
            result = tab.evaluate(MEASURE)
            csp = list(tab.csp)
        finally:
            tab.close()
    return result, csp


def _check(result, spec):
    for sel, values in _expected_by_selector(spec).items():
        assert result[sel] == values, sel


@pytest.mark.parametrize("width", list(WIDTHS))
def test_standalone_page_spacing_comes_from_its_properties(browser, page_folder, width):
    result, csp = _measure(browser, page_folder, "/index.html", WIDTHS[width])
    assert csp == []
    _check(result, PAGE[width])


@pytest.mark.parametrize("width", list(WIDTHS))
def test_a_host_that_sets_no_property_gets_the_viewer_defaults(browser, example_folder, width):
    result, csp = _measure(browser, example_folder, "/example.html", WIDTHS[width])
    assert csp == []
    _check(result, HOST[width])
