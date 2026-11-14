"""Real-data proof for search (plan task t14): the standalone page on real data files, with
typed text embedded by the file's own model through ``viewer serve --embed`` and a real
gateway.

    grant run --inject EMBEDDINGS_API_KEY=<name of the stored key> -- \\
      env EMBEDDINGS_EMBED_URL=<gateway base ending in /v1> \\
      uv run --with numpy python docs/evidence/real_search_browser.py <site folder> \\
        --file atlas-a.json --embed-model <model> [--query-prefix <text>] \\
        [--reduced atlas-rot.json --reduced atlas-top.json] [--seconds 10] [--out result.json]

The gateway address and key are read only by the helper process this script starts (from the
environment it inherits). This script never reads, prints or writes them. The folder must be
inside the current folder (after resolving symlinks).

What it does, per run (one data file, one model):

* Starts the real ``python -m embeddings_tumbler viewer serve <site> --embed`` on loopback,
  after writing the viewer's files into the site folder (``viewer write --apply --force``).
* Opens the standalone page on the file in Chromium (``TUMBLER_BROWSER_RENDERER=gpu`` uses the
  machine's GPU; default SwiftShader) and waits for the points.
* For each query text: asks the helper for the query vector from inside the page (the same
  call the page's own embed callback makes), runs the search by typing nothing but calling
  ``setSearches([text])`` so the page's callback embeds it, and compares the result ids,
  their order and their distances with a ranking computed here with numpy from the same
  ``.f32`` file and the vector the helper returned, over the named points only.
* Timing: with a query vector already in hand, the time from ``setSearches([{vector}])`` to
  the first animation frame in which ``info().search`` reports the lit set, 5 times.
* Frame rate: four searches active, each mode, frames counted by the viewer over ``--seconds``.
* ``--reduced`` files: embedding search must be refused with ``reduction-not-searchable`` and
  a words search among the loaded points must still light points.
* Records every request to another origin and console errors. (That no response carries the
  gateway key or address is proved with planted values in tests/browser/test_search_forms.py,
  not here: this script never learns either value.)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tests.browser import harness  # noqa: E402

HANDLE = "window.EmbeddingsTumbler.get(document.getElementById('space'))"
MODES = ["tumble", "lattice", "wander", "focus"]
QUERIES = [
    "a cold winter morning",
    "reading a file from disk",
    "parsing command line arguments",
    "the days of the week",
    "sending an email message",
    "threads and locks",
]
K = 8


def _confined(base_dir: str, value: str) -> str:
    base = os.path.realpath(base_dir)
    full = os.path.realpath(os.path.join(base, value))
    if full.startswith(base + os.sep):
        return full
    raise SystemExit(f"{value} is outside the current folder {base}")


def _named(point: dict) -> bool:
    """docs/search-interface.md: a point is named by a label or metadata.text that is not
    blank and is not its id."""
    for text in (point.get("label"), (point.get("metadata") or {}).get("text")):
        if isinstance(text, str) and text.strip() and text != point.get("id"):
            return True
    return False


def _load(site: str, name: str):
    with open(os.path.join(site, name), encoding="utf-8") as fh:
        meta = json.load(fh)
    block = np.fromfile(os.path.join(site, meta["vectors"]["file"]), dtype="<f4")
    vectors = block.reshape(meta["count"], meta["dimension"]).astype(np.float64)
    return meta, vectors


def _exact(meta: dict, vectors: np.ndarray, query: list[float]) -> list[tuple[str, float]]:
    q = np.asarray(query, dtype=np.float64)
    norms = np.linalg.norm(vectors, axis=1) * np.linalg.norm(q)
    distance = 1.0 - (vectors @ q) / norms
    named = np.array([_named(p) for p in meta["points"]])
    order = [i for i in np.argsort(distance, kind="stable") if named[i]][:K]
    return [(meta["points"][i]["id"], float(distance[i])) for i in order]


class Helper:
    def __init__(self, site: str, model: str, prefix: str | None):
        command = [sys.executable, "-m", "embeddings_tumbler", "viewer", "serve", site]
        command += ["--port", "0", "--embed", "--embed-model", model, "--json"]
        if prefix:
            command += ["--query-prefix", prefix]
        self.process = subprocess.Popen(  # noqa: S603 - our own CLI, fixed arguments
            command, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
        )
        line = self.process.stdout.readline()
        if not line.strip():
            raise SystemExit("viewer serve --embed did not start (is the gateway configured?)")
        self.origin = f"http://127.0.0.1:{json.loads(line)['port']}"

    def close(self) -> None:
        self.process.terminate()
        self.process.wait(10)
        self.process.stdout.close()


def _search_info(tab):
    return tab.evaluate(f"() => {HANDLE}.info().search")


def _run_search(tab, entry):
    return tab.evaluate(f"(e) => {HANDLE}.setSearches([e])", entry)


def _open(browser, origin: str, name: str):
    tab = harness.Tab(browser, viewport=(1280, 800))
    tab.page.set_default_navigation_timeout(300_000)
    tab.goto(f"{origin}/index.html?data={name}")
    tab.wait_for(
        f"() => {{ const h = {HANDLE}; return !!(h && h.info().ready && h.info().count > 0); }}",
        timeout=300,
        what="the real points",
    )
    return tab


def _embed_in_page(tab, text: str) -> dict:
    return tab.evaluate(
        "(t) => fetch('/_tumbler/search', {method: 'POST', headers: {'Content-Type': "
        "'application/json'}, body: JSON.stringify({op: 'embed', text: t})}).then((r) => r.json())",
        text,
    )


def _neighbours(tab, meta, vectors) -> list[dict]:
    rows = []
    for text in QUERIES:
        answer = _embed_in_page(tab, text)
        want = _exact(meta, vectors, answer["vector"])
        result = _run_search(tab, {"text": text, "via": "embed"})
        if not result.get("ok"):
            rows.append({"query": text, "ok": False, "code": result.get("code")})
            continue
        got = [(r["id"], r["distance"]) for r in result["search"]["searches"][0]["results"]]
        worst = max(abs(a[1] - b[1]) for a, b in zip(got, want)) if got else None
        labels = {p["id"]: p.get("label") for p in meta["points"]}
        rows.append(
            {
                "query": text,
                "ok": True,
                "same_ids_in_order": [g[0] for g in got] == [w[0] for w in want],
                "same_id_set": {g[0] for g in got} == {w[0] for w in want},
                "largest_distance_difference": worst,
                "results": [labels[g[0]] for g in got],
                "lit": result["search"]["litCount"],
                "sent_to": result["search"]["searches"][0].get("sentTo"),
            }
        )
    return rows


FIRST_LIT = (
    "(entry) => new Promise((done) => { const h = %s; h.clearSearches(); "
    "requestAnimationFrame(() => requestAnimationFrame(() => { const t0 = performance.now(); "
    "h.setSearches([entry]); const tick = () => { const s = h.info().search; "
    "if (s && s.active && s.litCount > 0) done(performance.now() - t0); "
    "else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })); })"
) % HANDLE


def _timing(tab, model: str, vector: list[float]) -> list[float]:
    entry = {"vector": vector, "model": model, "label": "timing"}
    return [round(tab.evaluate(FIRST_LIT, entry), 1) for _ in range(5)]


def _frame_rate(tab, meta, seconds: float) -> dict:
    ids = [p["id"] for p in meta["points"] if _named(p)]
    four = [{"point": ids[i * len(ids) // 4]} for i in range(4)]
    out = {}
    for mode in MODES:
        tab.evaluate(f"() => {HANDLE}.setMode('{mode}')")
        tab.wait_for(
            f"() => {{ const i = {HANDLE}.info(); "
            f"return i.mode === '{mode}' && i.ready && !i.preparing; }}",
            timeout=300,
            what=f"{mode} ready",
        )
        entries = four if mode != "focus" else four[:1]
        result = tab.evaluate(f"(e) => {HANDLE}.setSearches(e)", entries)
        tab.page.wait_for_timeout(2000)
        probe = f"() => ({{ f: {HANDLE}.info().frames, t: performance.now() }})"
        a = tab.evaluate(probe)
        tab.page.wait_for_timeout(int(seconds * 1000))
        b = tab.evaluate(probe)
        info = _search_info(tab)
        out[mode] = {
            "searches": len(info["searches"]) if result.get("ok") else 0,
            "lit": info["litCount"],
            "fps": round((b["f"] - a["f"]) * 1000 / (b["t"] - a["t"]), 1),
        }
    tab.evaluate(f"() => {HANDLE}.clearSearches()")
    return out


def _reduced(browser, origin: str, name: str, word: str) -> dict:
    tab = _open(browser, origin, name)
    try:
        refused = _run_search(tab, {"text": "a cold winter morning", "via": "embed"})
        words = _run_search(tab, {"text": word, "via": "words"})
        auto = _run_search(tab, word)
        note = auto["search"]["searches"][0].get("note") if auto.get("ok") else None
        return {
            "file": name,
            "embed_refused_code": refused.get("code"),
            "embed_refused_message": refused.get("message"),
            "words_ok": bool(words.get("ok")),
            "words_code": words.get("code"),
            "words_lit": words["search"]["litCount"] if words.get("ok") else 0,
            "auto_falls_back_with_note": note,
        }
    finally:
        tab.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("site")
    ap.add_argument("--file", required=True)
    ap.add_argument("--embed-model", required=True)
    ap.add_argument("--query-prefix")
    ap.add_argument("--reduced", action="append", default=[])
    ap.add_argument("--word", default="Monday")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--out")
    args = ap.parse_args()
    site = _confined(os.getcwd(), args.site)
    out = _confined(os.getcwd(), args.out) if args.out else None
    done = subprocess.run(  # noqa: S603 - our own CLI, fixed arguments
        [sys.executable, "-m", "embeddings_tumbler", "viewer", "write", site, "--apply", "--force"],
        capture_output=True,
        text=True,
        check=False,
        cwd=str(ROOT),
    )
    if done.returncode != 0:
        raise SystemExit(done.stderr)
    meta, vectors = _load(site, args.file)

    from playwright.sync_api import sync_playwright

    result: dict = {
        "file": args.file,
        "points": meta["count"],
        "dimension": meta["dimension"],
        "model": meta["model"],
        "named_points": sum(1 for p in meta["points"] if _named(p)),
        "renderer": harness.renderer(),
        "machine": platform.processor() or platform.machine(),
        "seconds": args.seconds,
    }
    helper = Helper(site, args.embed_model, args.query_prefix)
    try:
        with sync_playwright() as pw:
            browser = harness.launch(pw)
            try:
                result["browser"] = "Chromium " + browser.version
                tab = _open(browser, helper.origin, args.file)
                result["webgl_renderer"] = tab.evaluate(harness.WEBGL_RENDERER)
                started = time.monotonic()
                result["neighbours"] = _neighbours(tab, meta, vectors)
                result["neighbours_took_s"] = round(time.monotonic() - started, 1)
                vector = _embed_in_page(tab, QUERIES[0])["vector"]
                result["first_lit_frame_ms"] = _timing(tab, meta["model"], vector)
                result["frame_rate_four_searches"] = _frame_rate(tab, meta, args.seconds)
                result["foreign_requests"] = tab.foreign_requests(helper.origin)
                result["console_errors"] = tab.console_errors()
                tab.close()
                result["reduced"] = [
                    _reduced(browser, helper.origin, name, args.word) for name in args.reduced
                ]
            finally:
                browser.close()
    finally:
        helper.close()
    text = json.dumps(result, indent=2)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
