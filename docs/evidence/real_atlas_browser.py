"""Real-Atlas proof (plan task t16): run the three delivery forms on a real data file in
Chromium, log every request, and measure the frame rate of a large real file.

    uv run python docs/evidence/real_atlas_browser.py <small.json> [--large <large.json>]
        [--seconds 10] [--out result.json] [--shots <folder>]

``TUMBLER_BROWSER_RENDERER=gpu`` uses the machine's GPU (default: SwiftShader, software).

What it does, with the repository's own browser harness (``tests/browser/harness.py``):

* Copies the three guide example hosts (``docs/guides/examples/{script,web-component,
  standalone}``), puts the real data pair in each, runs ``embeddings-tumbler viewer write
  <folder> --apply`` and serves each on loopback with ``Content-Security-Policy: default-src
  'self'``. The script and web-component examples load a file named ``space.json``, so the
  real pair is copied under that name and the one field ``vectors.file`` is rewritten to
  match; nothing else in the data changes. The standalone page is given the file under its
  own name through ``?data=``.
* For each form: waits for the real points, visits all three modes, and records every
  request the page made, requests to any other origin, console errors, page errors and
  policy violations.
* With ``--large``: opens the standalone page on that file and measures frames per second
  for each mode over ``--seconds`` seconds (frames counted by the viewer itself,
  ``info().frames``), after the mode reports ready and two seconds to settle.

Writes nothing but the temporary folders, the optional ``--out`` JSON and ``--shots`` images.
The only network traffic is between the browser and the loopback servers started here.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tests.browser import harness  # noqa: E402

EXAMPLES = ROOT / "docs" / "guides" / "examples"
POLICY = "default-src 'self'"
MODES = ["tumble", "lattice", "wander"]

HANDLE = "window.EmbeddingsTumbler.get(document.getElementById('space'))"
INFO = (
    "() => { const h = %s; if (!h) return null; const i = h.info(); return { mode: i.mode, "
    "ready: i.ready, count: i.count, dimension: i.dimension, model: i.model, frames: i.frames, "
    "fps: i.fps, status: i.status, message: i.message, rendering: i.rendering, "
    "timing: i.timing, now: performance.now() }; }"
) % HANDLE


def _copy_pair(data: Path, folder: Path, name: str | None = None) -> str:
    """Copy <data>.json and its vector block into ``folder``; return the JSON file name."""
    meta = json.loads(data.read_text(encoding="utf-8"))
    block = data.parent / meta["vectors"]["file"]
    if name is None:
        shutil.copyfile(data, folder / data.name)
        shutil.copyfile(block, folder / block.name)
        return data.name
    meta["vectors"]["file"] = name + ".f32"
    (folder / (name + ".json")).write_text(json.dumps(meta), encoding="utf-8")
    shutil.copyfile(block, folder / (name + ".f32"))
    return name + ".json"


def _site(form: str, data: Path, tmp: Path) -> tuple[Path, str]:
    folder = tmp / form
    shutil.copytree(EXAMPLES / form, folder)
    for old in ("space.json", "space.f32"):
        (folder / old).unlink(missing_ok=True)
    if form == "standalone":
        path = "/index.html?data=" + _copy_pair(data, folder)
    else:
        _copy_pair(data, folder, "space")
        path = "/example.html"
    done = subprocess.run(
        [sys.executable, "-m", "embeddings_tumbler", "viewer", "write", str(folder), "--apply",
         "--force"],
        capture_output=True, text=True, check=False,
    )  # fmt: skip
    if done.returncode != 0:
        raise SystemExit(done.stderr)
    return folder, path


def _wait_ready(tab, mode: str, timeout: float = 180):
    return tab.wait_for(
        INFO, lambda i: bool(i and i["mode"] == mode and i["ready"] and i["count"] > 0),
        timeout=timeout, what=f"{mode} ready",
    )  # fmt: skip


def _visit(browser, form: str, data: Path, tmp: Path, expect: int, shots: Path | None) -> dict:
    folder, path = _site(form, data, tmp)
    with harness.Server(folder, csp=POLICY) as server:
        tab = harness.Tab(browser, viewport=(1280, 800))
        try:
            tab.goto(server.origin + path)
            tab.wait_for(INFO, lambda i: bool(i and i["count"] == expect), timeout=120,
                         what="the real points")  # fmt: skip
            seen = {}
            for mode in MODES:
                assert tab.evaluate(f"() => {HANDLE}.setMode('{mode}')") is True, mode
                info = _wait_ready(tab, mode)
                tab.page.wait_for_timeout(2500)
                info = tab.evaluate(INFO)
                seen[mode] = {"status": info["status"], "message": info["message"],
                              "frames": info["frames"]}  # fmt: skip
                if shots:
                    shots.mkdir(parents=True, exist_ok=True)
                    (shots / f"{form}-{mode}.png").write_bytes(tab.page.screenshot())
            text = tab.evaluate("() => document.getElementById('space').innerText")
            return {
                "form": form,
                "page": path,
                "points": info["count"],
                "dimension": info["dimension"],
                "model": info["model"],
                "modes": seen,
                "requests": sorted({r["url"].replace(server.origin, "") for r in tab.requests}),
                "request_count": len(tab.requests),
                "foreign_requests": tab.foreign_requests(server.origin),
                "server_hits": len(server.hits),
                "console_errors": tab.console_errors(),
                "page_errors": list(tab.page_errors),
                "csp_violations": list(tab.csp),
                "states_model_in_page": info["model"] in text,
            }
        finally:
            tab.close()


def _frame_rate(browser, data: Path, tmp: Path, seconds: float, shots: Path | None) -> dict:
    folder, path = _site("standalone", data, tmp / "large")
    out: dict = {"page": path, "modes": {}}
    with harness.Server(folder, csp=POLICY) as server:
        tab = harness.Tab(browser, viewport=(1280, 800))
        try:
            started = time.monotonic()
            tab.goto(server.origin + path)
            info = tab.wait_for(INFO, lambda i: bool(i and i["count"] > 0 and i["ready"]),
                                timeout=300, what="the large file")  # fmt: skip
            out.update(points=info["count"], dimension=info["dimension"], model=info["model"],
                       rendering=info["rendering"],
                       load_to_ready_s=round(time.monotonic() - started, 2))  # fmt: skip
            out["webgl_renderer"] = tab.evaluate(harness.WEBGL_RENDERER)
            for mode in MODES:
                t0 = time.monotonic()
                tab.evaluate(f"() => {HANDLE}.setMode('{mode}')")
                _wait_ready(tab, mode, timeout=300)
                ready_s = time.monotonic() - t0
                tab.page.wait_for_timeout(2000)
                a = tab.evaluate(INFO)
                tab.page.wait_for_timeout(int(seconds * 1000))
                b = tab.evaluate(INFO)
                fps = (b["frames"] - a["frames"]) * 1000 / (b["now"] - a["now"])
                out["modes"][mode] = {"fps": round(fps, 1), "viewer_fps": round(b["fps"], 1),
                                      "switch_to_ready_s": round(ready_s, 2),
                                      "status": b["status"]}  # fmt: skip
                if shots:
                    shots.mkdir(parents=True, exist_ok=True)
                    (shots / f"large-{mode}.png").write_bytes(tab.page.screenshot())
            out["timing"] = b["timing"]
            out["foreign_requests"] = tab.foreign_requests(server.origin)
            out["console_errors"] = tab.console_errors()
        finally:
            tab.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("data", type=Path)
    ap.add_argument("--large", type=Path)
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--shots", type=Path)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    expect = json.loads(args.data.read_text(encoding="utf-8"))["count"]
    result: dict = {"renderer": harness.renderer(), "policy": POLICY, "forms": []}
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as pw:
        browser = harness.launch(pw)
        try:
            result["browser"] = "Chromium " + browser.version
            for form in ("script", "web-component", "standalone"):
                result["forms"].append(_visit(browser, form, args.data, Path(tmp), expect,
                                              args.shots))  # fmt: skip
            if args.large:
                result["frame_rate"] = _frame_rate(browser, args.large, Path(tmp), args.seconds,
                                                   args.shots)  # fmt: skip
        finally:
            browser.close()
    text = json.dumps(result, indent=2)
    if args.out:
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    bad = [f["form"] for f in result["forms"]
           if f["foreign_requests"] or f["console_errors"] or f["csp_violations"]]  # fmt: skip
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
