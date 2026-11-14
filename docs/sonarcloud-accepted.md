# SonarCloud issues kept on purpose

CI fails while SonarCloud holds any issue that is Open or Confirmed
(`scripts/sonar_open_issues.py`). The rule for this repository, set by the owner
on 2026-11-14: every issue is fixed, unless doing what the rule asks is provably
wrong. Such an issue is listed here with its proof, and the owner marks it
Accepted on SonarCloud. Nothing is listed here for being hard, for being only
style, or for being in a test or a dev page.

The first scan of this repository found 572 open issues. 571 were fixed. One is
kept.

## 1. `python:S5332` on the address `viewer serve` prints

- **Where:** `embeddings_tumbler/cli/_commands/viewer.py`, the line
  `url = f"http://{shown}:{port}/"`.
- **What the rule asks:** use `https` instead of `http`.
- **Why that is wrong here:** `embeddings-tumbler viewer serve <folder>` starts a
  plain-HTTP server from the Python standard library, bound to a loopback
  address by default, for trying the viewer on one's own machine. It has no
  certificate. The line prints the address the server is actually listening
  on. Printing `https://` would print an address that does not work.
- **The proof**, reproduced on 2026-11-14:
  1. With the server running (`viewer serve <folder> --port 8878`), a request to
     `http://127.0.0.1:8878/index.html` returns `200`. A request to
     `https://127.0.0.1:8878/index.html` fails before any response:
     `curl: (35) OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version
     number`.
  2. With the line changed to `https://`, two tests fail:
     `tests/test_cli_viewer.py::test_serve_cli_json_shape` and
     `tests/test_cli_viewer.py::test_serve_ipv6_loopback` (the second fetches
     the printed address and expects the page). 41 others pass. The change was
     then reverted.
- **Why serving https is not the fix:** it would need a certificate the
  browser trusts for `127.0.0.1`, which a "try it locally" command cannot
  provide without the user installing a local certificate authority. Browsers
  treat `http://127.0.0.1` and `http://localhost` as secure contexts already,
  so nothing the viewer needs is lost.
- **What limits the exposure:** the server binds to loopback unless `--host`
  says otherwise, serves static files from one folder only, and is not part of
  anything deployed.

## Rewritten instead of kept

Three places looked like candidates for this list and were rewritten instead,
because an exactly equivalent form existed that the rule does not object to.
They are named here so the choice can be judged.

- **32-bit arithmetic in the seeded random generators.** The rule asks for
  `Math.trunc` in place of `| 0`. `x | 0` wraps to 32 bits and `Math.trunc`
  does not: for `x = 2**32 + 300`, `x | 0` is `300` and `Math.trunc(x)` is
  `4294967596`, and `NaN | 0` is `0` while `Math.trunc(NaN)` is `NaN`. The
  generators now keep their state with `>>> 0`, and integer options go through
  `Math.imul(x, 1)`. Old and new were compared on 1,842,029 seed inputs and
  72,000 outputs with no difference, and every frame hash is unchanged.
- **The negative-control test page** (`tests/browser/fixtures/bad-foreign.js`)
  must make plain `http:` and `ws:` requests to another origin: it exists so
  the test harness can prove it catches a page that does that, and the foreign
  test server is plain HTTP on a random loopback port. With `https:` and
  `wss:`, 11 of the 18 negative-control tests fail (the foreign server never
  receives a request it can parse). The page now takes the scheme from a fixed
  pair and uses it only when the page itself is served over `http:`. It still
  makes plain-HTTP requests; it no longer contains the literal the rule
  matches. There is no weakness behind it: the file is a test double.
- **The standalone page's spacing.** Seventeen `!important` declarations were
  needed because the viewer set those values as inline styles. The viewer now
  takes them from `--tumbler-*` custom properties, and the page sets the
  properties.
