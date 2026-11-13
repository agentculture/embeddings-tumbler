"""Entry point for ``python -m embeddings_tumbler``."""

from __future__ import annotations

import sys

from embeddings_tumbler.cli import main

if __name__ == "__main__":
    sys.exit(main())
