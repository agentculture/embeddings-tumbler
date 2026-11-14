"""What the search browser tests share (task t12 of the search plan): a small data set with
named and unnamed points, the table of query vectors a host's embed callback answers from,
an exact ranking worked out in Python from the files as written, and the real helper
(``embeddings-tumbler viewer serve --embed``) started as a process over a fake gateway.

Used by ``test_search_forms.py`` and ``test_search_motion.py``. Standard library only.

The set: ``CLUSTERS`` clusters of ``PER_CLUSTER`` points in ``DIMENSION`` dimensions. In each
cluster the first ``NAMED_PER_CLUSTER`` points carry a label (so they are named points as
``docs/search-interface.md`` defines them: a readable text that differs from the id); the
others have an empty label. So a search's results are named points and the points it lights
are those and every unnamed point at least as near, which is what the ranking here works out.
"""

from __future__ import annotations

import json
import math
import os
import random
import struct
import subprocess
import sys
from pathlib import Path

from tests.browser import harness
from tests.test_embed_route import _Gateway

MODEL = "synthetic/search-fixture"
OTHER_MODEL = "synthetic/another-model"
RERANK_MODEL = "synthetic/search-reranker"
DIMENSION = 48
CLUSTERS = 8
PER_CLUSTER = 120
NAMED_PER_CLUSTER = 15
COUNT = CLUSTERS * PER_CLUSTER
SET_FILE = "search-set.json"
BLOCK_FILE = "search-set.f32"
TABLE_FILE = "search-queries.json"
SEED = 1412

# Query texts the table answers. The first two are good queries, near two clusters.
ALPHA = "alpha query"
BETA = "beta query"
SHORT = "short vector"  # answered with a vector one dimension short
FOREIGN_MODEL = "other model"  # answered with a good vector from another model
UNKNOWN = "no answer for this"  # not in the table: the embedder fails

# Planted in the helper's environment; none may reach the browser or a helper response.
KEY = "SENTINEL-KEY-t12-5c1e9a"
ADDRESS_PART = "SENTINEL-ADDRESS-d41e"  # the path part _Gateway.base puts in its address

ROUTE = "/_tumbler/search"
H = "window.EmbeddingsTumbler.get(document.getElementById('space'))"
WAIT = 240  # seconds: CI renders in software on a shared runner


def float32(values: list[float]) -> list[float]:
    """The values as float32 numbers, so a JSON copy and a binary copy are the same numbers."""
    return list(struct.unpack(f"<{len(values)}f", struct.pack(f"<{len(values)}f", *values)))


def _centres(rnd: random.Random) -> list[list[float]]:
    return [[rnd.gauss(0.0, 1.0) for _ in range(DIMENSION)] for _ in range(CLUSTERS)]


def _label(cluster: int, i: int) -> str:
    return f"topic {cluster} note {i}" if i < NAMED_PER_CLUSTER else ""


def write_search_set(folder: Path) -> dict:
    """Write the set, its block and the query table into ``folder``; return the table."""
    rnd = random.Random(SEED)
    centres = _centres(rnd)
    rows: list[list[float]] = []
    points = []
    for cluster, centre in enumerate(centres):
        for i in range(PER_CLUSTER):
            rows.append([c + rnd.gauss(0.0, 0.45) for c in centre])
            points.append(
                {
                    "id": f"c{cluster}-{i:03d}",
                    "label": _label(cluster, i),
                    "group": f"cluster {cluster}",
                }
            )
    block = struct.pack(f"<{COUNT * DIMENSION}f", *[x for row in rows for x in row])
    meta = {
        "schema_version": 1,
        "kind": "embeddings-tumbler/data",
        "model": MODEL,
        "dimension": DIMENSION,
        "count": COUNT,
        "text_included": True,
        "provenance": {
            "source": "synthetic: search browser tests (tests/browser/search_site.py)",
            "producer": "tests/browser/search_site.py",
            "created": "2026-11-14T00:00:00Z",
            "synthetic": True,
            "seed": SEED,
            "limitations": ["planted clusters; not model output"],
            "uncertain": [],
        },
        "vectors": {
            "file": BLOCK_FILE,
            "dtype": "float32",
            "byte_order": "little",
            "byte_length": len(block),
        },
        "points": points,
    }
    (folder / BLOCK_FILE).write_bytes(block)
    (folder / SET_FILE).write_text(json.dumps(meta, indent=1), encoding="utf-8")
    near_alpha = float32([c + rnd.gauss(0.0, 0.2) for c in centres[0]])
    near_beta = float32([c + rnd.gauss(0.0, 0.2) for c in centres[3]])
    table = {
        "queries": {
            ALPHA: {"vector": near_alpha, "model": MODEL},
            BETA: {"vector": near_beta, "model": MODEL},
            SHORT: {"vector": near_alpha[:-1], "model": MODEL},
            FOREIGN_MODEL: {"vector": near_alpha, "model": OTHER_MODEL},
        }
    }
    (folder / TABLE_FILE).write_text(json.dumps(table), encoding="utf-8")
    return table


def build_site(folder: Path) -> dict:
    """The harness's host site (``viewer write`` plus the fixture pages) with the search set."""
    harness.build_host_site(folder)
    return write_search_set(folder)


# --------------------------------------------------------------------------- exact ranking


def read_set(folder: Path) -> tuple[dict, list[list[float]]]:
    """The data file and its rows, read back from the files the page is served."""
    meta = json.loads((folder / SET_FILE).read_text(encoding="utf-8"))
    raw = (folder / meta["vectors"]["file"]).read_bytes()
    d = meta["dimension"]
    flat = struct.unpack(f"<{len(raw) // 4}f", raw)
    return meta, [list(flat[i * d : (i + 1) * d]) for i in range(meta["count"])]


def is_named(point: dict) -> bool:
    """A named point: its ``metadata.text`` or its label is readable and is not its id."""
    texts = [(point.get("metadata") or {}).get("text"), point.get("label")]
    return any(isinstance(t, str) and t.strip() != "" and t != point["id"] for t in texts)


def cosine_distance(row: list[float], query: list[float]) -> float:
    dot = math.fsum(a * b for a, b in zip(row, query, strict=True))
    norms = math.sqrt(math.fsum(a * a for a in row)) * math.sqrt(math.fsum(b * b for b in query))
    if norms == 0:
        return 1.0
    return 1.0 - min(1.0, max(-1.0, dot / norms))


def rank(points: list[dict], rows: list[list[float]], query: list[float], k: int) -> dict:
    """One search, exactly: the ``k`` nearest named points (ties to the lower index), the
    radius (the farthest of them) and every point at most that far."""
    distances = [cosine_distance(row, query) for row in rows]
    named = sorted((distances[i], i) for i, p in enumerate(points) if is_named(p))
    kept = named[:k]
    radius = kept[-1][0]
    last = kept[-1][1]
    return {
        "ids": [points[i]["id"] for _, i in kept],
        "distances": [d for d, _ in kept],
        "radius": radius,
        "inside": {i for i, d in enumerate(distances) if d <= radius},
        # how near any other point comes to the radius: the ranking is only "exact" for a
        # browser that sums in another order when this is far above rounding error
        "margin": min(abs(d - radius) for i, d in enumerate(distances) if i != last),
    }


# --------------------------------------------------------------------------- page snippets

READY = f"""() => {{
  const h = window.EmbeddingsTumbler && {H};
  if (!h) return null;
  const i = h.info();
  return {{ ready: i.ready, frames: i.frames, count: i.count, preparing: i.preparing,
    rendering: i.rendering, message: i.message, embedder: i.search.embedder.available }};
}}"""

# What a search shows: from info() (the public report) and, for the lit points themselves,
# the lit values the viewer handed to the renderer (`_viewer`, the handle's test hook).
STATE = f"""() => {{
  const h = {H}, i = h.info(), s = i.search, held = h._viewer.search.lit;
  const lit = [];
  if (held) held.lit.forEach((v, k) => {{ if (v > 0) lit.push(k); }});
  return {{ count: i.count, frames: i.frames, mode: i.mode,
    active: s.active, waiting: s.waiting, stale: s.stale, staleBy: s.staleBy,
    litCount: s.litCount, sharedCount: s.sharedCount, settings: s.settings,
    embedder: s.embedder, reranker: s.reranker,
    searches: s.searches.map((q) => ({{ letter: q.letter, kind: q.kind, text: q.text,
      model: q.model, sentTo: q.sentTo, reranker: q.reranker, k: q.k, sent: q.sent,
      radius: q.radius, insideCount: q.insideCount, note: q.note,
      ids: q.results.map((r) => r.id), distances: q.results.map((r) => r.distance) }})),
    lit: lit, rendererLit: h._viewer.renderer.status().lit }};
}}"""

SET_SEARCHES = f"async (list) => await {H}.setSearches(list)"


def open_form(tab: harness.Tab, url: str) -> dict:
    # the default navigation limit (30 s) is too short on a runner busy rendering in software
    tab.page.goto(url, timeout=WAIT * 1000)
    info = tab.wait_for(
        READY,
        lambda i: bool(i and i["ready"] and i["count"] == COUNT and i["frames"] > 3),
        timeout=WAIT,
        what="the viewer to show the search set",
    )
    if info["rendering"] is False:
        harness.unavailable("WebGL 2 unavailable in headless Chromium")
    return info


def settled(tab: harness.Tab, what: str = "the searches to be worked out") -> dict:
    """The state once no callback or ranking is working and results are not stale, and the
    viewer has drawn three more frames (so anything it was going to upload is uploaded)."""
    state = tab.wait_for(
        STATE, lambda s: not s["waiting"] and not s["stale"], timeout=WAIT, what=what
    )
    frames = state["frames"]
    return tab.wait_for(
        STATE,
        lambda s: s["frames"] >= frames + 3 and not s["waiting"] and not s["stale"],
        timeout=WAIT,
        what="three more frames",
    )


# --------------------------------------------------------------------------- the helper


class TableGateway(_Gateway):
    """The fake gateway of ``tests/test_embed_route.py``, answering embeddings from the
    query table (a text it does not hold is answered 404)."""

    def __init__(self, table: dict) -> None:
        super().__init__()
        self.table = table["queries"]

    def answer(self, handler, body: dict) -> None:
        if handler.path.endswith("/embeddings") and body["input"][0] not in self.table:
            self._write(handler, 404, b"{}")
            return
        super().answer(handler, body)

    def _ok(self, path: str, body: dict) -> dict:
        if path.endswith("/embeddings"):
            entry = self.table[body["input"][0]]
            return {"data": [{"embedding": entry["vector"], "index": 0}], "model": entry["model"]}
        answer = super()._ok(path, body)
        answer["model"] = RERANK_MODEL
        return answer


class HelperServer:
    """``embeddings-tumbler viewer serve <folder> --embed`` as a real process on a free
    loopback port, with the sentinel key and the gateway's address only in its environment.
    Its diagnostics go to ``log``."""

    def __init__(self, folder: Path, gateway: _Gateway, log: Path) -> None:
        env = {
            k: v for k, v in os.environ.items() if not k.startswith(("EMBEDDINGS_", "COLLEAGUE_"))
        }
        env["EMBEDDINGS_EMBED_URL"] = gateway.base
        env["EMBEDDINGS_API_KEY"] = KEY
        self.log = log
        self._log_file = log.open("w", encoding="utf-8")
        command = [sys.executable, "-m", "embeddings_tumbler", "viewer", "serve", str(folder)]
        command += ["--port", "0", "--embed", "--embed-model", MODEL]
        command += ["--rerank-model", RERANK_MODEL, "--json"]
        self.process = subprocess.Popen(  # noqa: S603 - our own CLI, fixed arguments
            command,
            env=env,
            cwd=str(harness.ROOT),
            stdout=subprocess.PIPE,
            stderr=self._log_file,
            text=True,
        )
        self.first_line = self.process.stdout.readline()
        if not self.first_line.strip():
            self.close()
            raise AssertionError(f"viewer serve --embed did not start: {self.output()}")
        self.result = json.loads(self.first_line)
        self.port = self.result["port"]
        self.origin = f"http://127.0.0.1:{self.port}"

    def output(self) -> str:
        """Everything the process has written: its result line and its diagnostics."""
        if not self._log_file.closed:
            self._log_file.flush()
        return self.first_line + self.log.read_text(encoding="utf-8")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(10)
        self.process.stdout.close()
        self._log_file.close()
