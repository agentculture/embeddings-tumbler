# Web component demo (development only)

A plain host page for trying `<embeddings-tumbler>` (`js/shells/web-component.js`)
by hand. It is not shipped in the wheel or the npm package. The page contains
only the element in its markup; the buttons remove it, add it back and change
its `src` (a 384-d file, a 1024-d file, another origin, a missing file). A log
shows the `tumbler-load` and `tumbler-error` events, and a counter shows
Content-Security-Policy violations (it should stay at 0). The page runs under
`default-src 'self'; script-src 'self'; style-src 'self'`.

It loads the shipped core and shell from `embeddings_tumbler/static/`, so run
`python3 scripts/assemble.py` and `python3 scripts/sync_static.py` first if you
changed the sources. The data comes from the contract fixtures in
`tests/fixtures/contract/`.

## Run

From the repository root:

```bash
uv run embeddings-tumbler viewer serve . --port 8791
```

Then open <http://127.0.0.1:8791/js/dev/web-component-demo/>.

## Things to try

- Remove the element, wait, add it back: it mounts again and loads again.
- Press "src: another origin": a plain message appears and the browser's
  network panel shows no request to that origin.
- Press "src: missing file": a plain message and a `tumbler-error` event (the
  browser also logs its own 404 line).
