# JavaScript source layout

The viewer core is one dependency-free file,
`embeddings_tumbler/static/embeddings-tumbler.js`. It is **assembled** from the
small modules in `js/src/` by `scripts/assemble.py`, and the assembled file is
committed.

## Rebuilding

```bash
python3 scripts/assemble.py          # rewrite the assembled file
python3 scripts/assemble.py --check  # exit 1 if the committed file is stale (CI)
```

Re-run it and commit the result whenever anything in `js/src/` changes, or
whenever the version in `pyproject.toml` changes. A pytest test fails on a stale
file. Assembly is plain concatenation in sorted filename order behind a one-line
banner (project, version, source repository). The token `@@VERSION@@` in a
module is replaced by the `pyproject.toml` version. There is no transpiler and
no minifier.

## Module convention

Files are named `NN-name.js` (two digits, then a name) and are concatenated in
filename order **inside one function wrapper**:

- `00-header.js` opens the wrapper and declares the shared internal namespace
  `ET` (with `ET.version` and an empty public object `ET.api`).
- `10-...` to `89-...` are your modules. Their text sits inside the wrapper, so
  it must **not** open or close it, and it must not declare top-level
  `module`/`exports`. Everything in the wrapper runs in strict mode.
- `99-footer.js` exports `ET.api` and closes the wrapper.

Rules for a module:

1. Keep helpers private with local `function`/`var` declarations (names are
   shared across modules in the wrapper, so prefix or scope them to avoid
   clashes). Publish what later modules or tests need on a **sub-namespace of
   `ET`**, for example `ET.math = { mulberry32: mulberry32, ... };`. Read earlier
   modules' exports from `ET.<name>` at call time or after they load.
2. Only `50-viewer.js` fills the public API: `ET.api.mount = ...`,
   `ET.api.update = ...`, `ET.api.destroy = ...`.
3. Only touch the DOM or WebGL inside functions, never at load time, so that node
   can load the file.
4. The assembled file must contain none of: an `http://` or `https://` string,
   the word `eval`, `new Function`, the word `import`, or a `require(` call,
   **including in comments**. A static test fails otherwise. Word the comments
   accordingly.

Export mechanism: the footer sets `module.exports = api` when `module` exists
(node, tests), and otherwise sets one global, `window.EmbeddingsTumbler`, so a
classic `<script src>` works under `script-src 'self'`. The internal namespace
is reachable as the non-enumerable `api._internal` (the same object as `ET`) so
tests can call module functions directly.

## Tests

Tests live in `js/test/*.test.js` and run with `node --test` from the repo root,
using only node's built-in runner and assert. No dependency is installed.

`js/test/helpers/load.js` provides:

```js
const { loadAssembled, loadSources } = require("./helpers/load.js");

const api = loadAssembled();                 // the committed assembled file
const api2 = loadSources(["10-math.js"]);    // header + named modules + footer, via node:vm
const math = api2._internal.math;            // the shared namespace ET
```

`loadSources()` with no argument loads every module in order. Source modules are
evaluated in a fresh context each time, so tests do not leak state. (The static
ban applies to the assembled file, not to this helper.) A test that exercises
the whole viewer should use `loadAssembled()`.
