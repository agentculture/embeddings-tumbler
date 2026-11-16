#!/usr/bin/env python3
"""Compare the built relative view with the reference page, for one search, by numbers.

The reference page is ``docs/specs/reference/tumbler-relative-search.html``. For a search
from one article (``Rice`` unless ``--search`` says otherwise) on the shipped Wikipedia pair
(``embeddings_tumbler/static/demo-wikipedia.json`` and its ``.f32`` block) this works out:

- **What the reference page shows**, from its own rules and data, read from its script and
  redone here in Python: the search is the article's own vector (``queryFrom``); its unit
  direction is rounded to float32 and every article's height is its dot product with that
  direction, rounded to float32 (``sims``); the eight results are the eight highest other
  articles, ties by index (``rank``); with the reranker, the 50 candidates and scores held
  for that article in ``docs/specs/reference/demo-wikipedia-rerank.json`` are ordered by
  score, highest first, ties by pool order, and eight are kept. The search pins the
  vertical axis (``targetFrame``: frame row 1 is search A).
- **What the built viewer shows**, by running the assembled core file
  (``embeddings_tumbler/static/embeddings-tumbler.js``) in node through
  ``scripts/compare_relative_reference.js``: Relative on, a search from the same article,
  the clock advanced until the turn onto the pinned frame has ended, then
  ``info().search.relative`` and ``ET.viewer.relativeOverlayData`` are read.

What the build's reranker is given, and why: the build names the searched article as its
own first result (rank 1, height 1) where the reference leaves it out, so the build is run
with counts one higher, ``k`` 9, ``candidates`` 51 and ``top`` 9, for the reference's 8
results, 50 candidates and 8 kept. Its rerank callback answers with the reference file's
real scores (``Qwen/Qwen3-Reranker-0.6B``, made ahead of time by
``scripts/build_reference_rerank.py``): each of the 50 other candidates gets the score the
file holds for it, matched by its text, and the article itself gets a score above all of
them (the highest plus 1), so it stays first as in the build's own ranking. The article
itself is then dropped from the build's results before comparing.

Compared: which axis is pinned (vertical, to the searched article, with frame row 1 equal to
its unit direction within 1e-6); each of the eight results' height to 2 decimal places, and
that they are the same articles in the same order; the reranked order and the reranked
results' heights; and the height of the reranker's cut-off line.

Standard library only. It runs ``node`` with fixed arguments, reads local files, writes
nothing and sends nothing anywhere. Output is a table and a verdict, or one JSON object
with ``--json``. Exit code 0 when everything agrees, 1 when something differs, 2 when the
comparison cannot be run (no ``node``, or the build's side failed)::

    python3 scripts/compare_relative_reference.py
    python3 scripts/compare_relative_reference.py --json
"""

from __future__ import annotations

import argparse
import array
import json
import math
import shutil
import struct
import subprocess  # nosec B404 - runs node on a fixed script with fixed arguments
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PAIR = ROOT / "embeddings_tumbler" / "static" / "demo-wikipedia.json"
RERANK = ROOT / "docs" / "specs" / "reference" / "demo-wikipedia-rerank.json"
BUILD_SIDE = ROOT / "scripts" / "compare_relative_reference.js"
K = 8  # the reference page's Results slider at its start
TIMEOUT = 240

GIVEN = (
    "The build was run with k 9, candidates 51 and top 9, because it names the searched "
    "article as its own first result where the reference leaves it out. Its rerank callback "
    "answered with the reference file's real scores for the 50 other candidates, matched by "
    "text, and a score above all of them (the highest plus 1) for the article itself; the "
    "article itself was then dropped from the build's results."
)


def f32(x: float) -> float:
    """``x`` rounded to the nearest float32, as a Float32Array stores it."""
    return struct.unpack("<f", struct.pack("<f", x))[0]


def load_pair(path: Path) -> tuple[dict, array.array]:
    meta = json.loads(path.read_text(encoding="utf-8"))
    block = array.array("f")
    block.frombytes((path.parent / meta["vectors"]["file"]).read_bytes())
    if sys.byteorder != "little":
        block.byteswap()
    if len(block) != meta["count"] * meta["dimension"]:
        raise SystemExit("the vector block does not match count x dimension")
    return meta, block


def reference_side(meta: dict, block: array.array, rerank: dict, label: str) -> dict:
    """What the reference page shows for a search from the article ``label``."""
    n, dim = meta["count"], meta["dimension"]
    lower = [str(p["label"]).lower() for p in meta["points"]]
    if label.lower() not in lower:
        raise SystemExit(f"no article titled {label!r}")
    own = lower.index(label.lower())  # makeQuery: an exact title is that one article
    vec = [float(x) for x in block[own * dim : (own + 1) * dim]]  # queryFrom, one member
    length = math.sqrt(sum(v * v for v in vec))
    direction = [f32(v / length) for v in vec]
    sims = []
    for i in range(n):
        row = block[i * dim : (i + 1) * dim]
        sims.append(f32(sum(a * b for a, b in zip(row, direction))))
    others = sorted((i for i in range(n) if i != own), key=lambda i: (-sims[i], i))
    plain = others[:K]
    pool, scores = rerank["pool"][own], rerank["scores"][own]
    order = sorted(range(len(pool)), key=lambda r: (-scores[r], r))[:K]
    reranked = [pool[r] for r in order]
    return {
        "own": own,
        "pinned": [{"letter": "A", "axis": "vertical"}],
        "plain": [{"index": i, "height": sims[i]} for i in plain],
        "reranked": [
            {"index": i, "height": sims[i], "rank": j + 1} for j, i in enumerate(reranked)
        ],
        "candidates": len(pool),
        "cut": sims[pool[-1]],
        "reranker": rerank["reranker"],
    }


def build_side(label: str) -> dict:
    """What the built viewer shows, from node running the assembled core file."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node is not installed, so the built viewer cannot be run")
    done = subprocess.run(  # nosec B603 - fixed program, fixed script, arguments from this file
        [node, str(BUILD_SIDE), str(PAIR), str(RERANK), label],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        check=False,
        cwd=ROOT,
    )
    if done.returncode != 0:
        raise RuntimeError("the build's side failed: " + done.stderr.strip()[-400:])
    return json.loads(done.stdout)


def two(x: float) -> str:
    return f"{x:.2f}"


def compare(ref: dict, build: dict, titles: list[str]) -> dict:
    own = ref["own"]
    checks = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})

    pinned = [(p["letter"], p["axis"]) for p in build["pinned"]]
    check(
        "pinned axis",
        pinned == [("A", "vertical")] and build["own"]["index"] == own and build["settled"],
        f"build {pinned}, search A from {titles[build['own']['index']]!r}, settled "
        f"{build['settled']}; reference [('A', 'vertical')] from {titles[own]!r}",
    )
    check(
        "frame row 1 is the search direction",
        build["row1Error"] < 1e-6,
        f"largest difference {build['row1Error']:.1e} (bound 1e-6)",
    )
    check(
        "measure", build["measure"] == "cosine", f"build {build['measure']!r}, reference 'cosine'"
    )

    rows = []
    for part in ("plain", "reranked"):
        b = [r for r in build[part] if r["index"] != own]
        r = ref[part]
        same_items = [x["index"] for x in b] == [x["index"] for x in r]
        same_heights = len(b) == len(r) and all(
            two(x["height"]) == two(y["height"]) for x, y in zip(b, r)
        )
        check(f"{part}: same articles in the same order", same_items, f"{len(b)} against {len(r)}")
        check(f"{part}: heights to 2 decimal places", same_heights, "")
        for n in range(max(len(b), len(r))):
            x = b[n] if n < len(b) else None
            y = r[n] if n < len(r) else None
            rows.append(
                {
                    "part": part,
                    "place": n + 1,
                    "reference": titles[y["index"]] if y else "",
                    "reference_height": two(y["height"]) if y else "",
                    "build": titles[x["index"]] if x else "",
                    "build_height": two(x["height"]) if x else "",
                    "build_rank": x["rank"] if x else None,
                    "agree": bool(
                        x
                        and y
                        and x["index"] == y["index"]
                        and two(x["height"]) == two(y["height"])
                    ),
                }
            )
    check(
        "reranker answered on the build",
        build["reranker"] is not None and not build["unknownCandidates"] and build["sent"] == 51,
        f"model {build['reranker']!r}, {build['sent']} candidates sent, "
        f"{len(build['unknownCandidates'])} without a reference score",
    )
    cut = build["cut"]["height"] if build["cut"] else None
    check(
        "cut-off line height",
        cut is not None and two(cut) == two(ref["cut"]),
        f"build {two(cut) if cut is not None else 'none'}, reference {two(ref['cut'])}",
    )
    return {"checks": checks, "rows": rows, "agree": all(c["ok"] for c in checks)}


def table(result: dict) -> str:
    lines = []
    for part, heading in (
        ("plain", "Embedding order (the reference's Results 8; the build's k 9 less the article)"),
        ("reranked", "Reranked (the reference file's scores; the build's top 9 less the article)"),
    ):
        lines.append(heading)
        lines.append(
            f"{'':3} {'reference':<28} {'height':>6}   {'build':<28} {'height':>6}  rank  "
        )
        for row in (r for r in result["rows"] if r["part"] == part):
            rank = "" if row["build_rank"] is None else str(row["build_rank"])
            mark = "same" if row["agree"] else "DIFFERS"
            lines.append(
                f"{row['place']:>2}. {row['reference'][:28]:<28} {row['reference_height']:>6}   "
                f"{row['build'][:28]:<28} {row['build_height']:>6}  {rank:>4}  {mark}"
            )
        lines.append("")
    for c in result["checks"]:
        detail = f" ({c['detail']})" if c["detail"] else ""
        lines.append(f"{'ok  ' if c['ok'] else 'FAIL'} {c['check']}{detail}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--search", default="Rice", help="the article to search from (Rice)")
    parser.add_argument("--json", action="store_true", help="print one JSON object")
    args = parser.parse_args(argv)

    meta, block = load_pair(PAIR)
    rerank = json.loads(RERANK.read_text(encoding="utf-8"))
    if rerank.get("count") != meta["count"] or rerank.get("set_model") != meta["model"]:
        print("the reranker file was made for another set", file=sys.stderr)
        return 2
    titles = [str(p["label"]) for p in meta["points"]]
    ref = reference_side(meta, block, rerank, args.search)
    try:
        build = build_side(args.search)
    except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as err:
        print(f"cannot compare: {err}", file=sys.stderr)
        return 2
    result = compare(ref, build, titles)
    verdict = (
        "AGREE: the build and the reference page agree on every check."
        if result["agree"]
        else "DIFFER: at least one check failed; see above."
    )
    if args.json:
        out = {
            "search": args.search,
            "set": {"model": meta["model"], "count": meta["count"], "dimension": meta["dimension"]},
            "reranker": ref["reranker"],
            "given_to_the_build": GIVEN,
            "build_settings": build["settings"],
            "build_overlay_ranks": [
                {"title": titles[x["index"]], "ranks": x["ranks"]} for x in build["overlayRanks"]
            ],
            **result,
            "verdict": verdict,
        }
        print(json.dumps(out, indent=1))
    else:
        print(
            f"Search {args.search!r} on {meta['count']} articles, {meta['dimension']} dimensions, "
            f"{meta['model']}; reranker scores from {ref['reranker']}."
        )
        print(GIVEN)
        print()
        print(table(result))
        print()
        print(verdict)
    return 0 if result["agree"] else 1


if __name__ == "__main__":
    sys.exit(main())
