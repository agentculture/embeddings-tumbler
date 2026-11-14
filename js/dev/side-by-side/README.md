# Side-by-side page (development only)

The reference demo and the built standalone page next to each other (stacked on
a narrow screen), with one row of buttons that switches both to Tumble,
Lattice or Wander, and the list of intended differences beside them to check
off. It is for the user's comparison before the first release. It is not
shipped in the wheel or the npm package.

It is plain HTML, one stylesheet and one script, with no inline script or
style, under a policy that allows only the page's own origin.

## Run

From the repository root:

```bash
uv run embeddings-tumbler viewer serve . --port 8791
```

Then open `/js/dev/side-by-side/`, for example
<http://127.0.0.1:8791/js/dev/side-by-side/>. The frames point at
`/docs/specs/reference/embedding-tumbler-demo.html` and
`/embeddings_tumbler/static/index.html`, so the repository root must be what is
served. Run `python3 scripts/assemble.py` and `python3 scripts/sync_static.py`
first if you changed anything under `js/`.

## What the buttons do

- **Tumble, Lattice, Wander** switch both pages. The reference can be driven
  from outside: its mode lives in the URL fragment and it listens for changes,
  so the page sets the fragment inside the frame (both are on one origin). The
  build reads `?mode=` once at load, so its frame is reloaded with the new
  query. If the reference's frame cannot be reached (for example the page was
  opened from another origin), it is reloaded instead and the status line says
  so.
- **Restart both** reloads both frames in the current mode, so the two start
  from the same moment.

## Notes

- The reference loads Google Fonts from another origin. Online, you see its real
  fonts; offline, it falls back, as the build does. The build loads nothing from
  another origin. In the headless check the font request was blocked, which the
  reference logs as one failed resource.
- The reference's Tumble is unseeded and its Wander route is random, so the two
  sides never show the same frame. Compare look and layout, not frames.
- Each frame is about half the page wide, so the layout inside it is the
  responsive one for that width, not the 1280 px one. Open each page on its own
  for a full-width look.
- The list is `checklist.json`, one entry per `###` heading of
  `docs/reference-differences.md`. A test keeps the two in step. Ticks are kept
  in this browser only. Ticking is not the sign-off; the sign-off is recorded in
  the document's last section.
