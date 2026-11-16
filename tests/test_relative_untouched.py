"""Regression gate (relative search, task t4): the data contract, its loader and the helper
route stay byte-for-byte as released in 0.12.1 (commit 9fe3213)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

# SHA-256 of each file as it is at release 0.12.1.
UNTOUCHED = {
    "docs/data-contract.md": ("2e0471314263abccb21fb5b5465fdfc5ca468c8e9772a21c42e649c0875f6fbe"),
    "js/src/20-contract.js": ("7158603ef90937509d72e1606cee00433560a60456ee4b2f2dbac7f4c097a071"),
    "embeddings_tumbler/_embed_route.py": (
        "50bb19e3cd22916120fe180d6a1697ff2c07031f1d3283e0ec6cbaa6d50e003f"
    ),
}


@pytest.mark.parametrize("name", sorted(UNTOUCHED))
def test_file_is_as_released_in_0_12_1(name: str) -> None:
    actual = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    assert actual == UNTOUCHED[name], (
        f"{name} changed since release 0.12.1. Relative search must not change the data "
        "contract, its loader or the helper route; undo the change to this file."
    )
