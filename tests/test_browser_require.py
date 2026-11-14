"""``TUMBLER_REQUIRE_BROWSER=1`` turns a browser-suite skip into a failure (t14).

Locally a browser test skips when no browser is available; on a CI runner that is supposed to
run them a skip must fail, or the suite could stop running unnoticed. This runs the probe test in
``tests/browser/test_harness_negative_controls.py`` in a subprocess with a forced skip, with and
without the variable. The probe uses no browser, so this test runs everywhere.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PROBE = "tests/browser/test_harness_negative_controls.py::test_require_browser_probe"


def _run(require: str | None) -> subprocess.CompletedProcess:
    env = dict(os.environ, TUMBLER_HARNESS_SKIP_PROBE="1")
    env.pop("TUMBLER_REQUIRE_BROWSER", None)
    if require is not None:
        env["TUMBLER_REQUIRE_BROWSER"] = require
    return subprocess.run(
        [sys.executable, "-m", "pytest", PROBE, "-q", "-p", "no:cacheprovider", "-n", "0"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )


def test_without_the_variable_a_browser_skip_is_a_skip():
    done = _run(None)
    assert done.returncode == 0, done.stdout + done.stderr
    assert "1 skipped" in done.stdout


@pytest.mark.parametrize("value", ["1", "true"])
def test_with_the_variable_a_browser_skip_fails(value):
    done = _run(value)
    assert done.returncode == 1, done.stdout + done.stderr
    assert "1 failed" in done.stdout
    assert "TUMBLER_REQUIRE_BROWSER=1 turns every browser skip into a failure" in done.stdout


def test_zero_disables_it():
    assert _run("0").returncode == 0
