# `<embeddings-tumbler>`: the web component (`js/shells/web-component.js`)

A custom element over the core file. It is a shell: it holds no rendering and no
projection code, and calls only the core's public API (`mount`, `update`,
`destroy`). Shipped as
`embeddings_tumbler/static/web-component.js` (copied by `scripts/sync_static.py`).

```html
<script src="embeddings-tumbler.js"></script>
<script src="web-component.js"></script>
<embeddings-tumbler src="data/my-set.json" mode="tumble" seed="7"></embeddings-tumbler>
```

Load the core first. Both are classic scripts from your own origin and run under
`script-src 'self'; style-src 'self'`. The file defines the element once; loading it
twice does nothing the second time. Without custom element support it does nothing.

## Attributes

| Attribute | Meaning |
|-----------|---------|
| `src` | URL of a data JSON file **on the page's own origin** (resolved against the page's base URL). The vector block named by `vectors.file` is fetched from the same folder. Changing `src` loads the new file as a replace. Removing `src` leaves what is shown. |
| `mode` | `tumble`, `lattice` or `wander`. Read at mount; changing it later switches the running viewer. |
| `seed` | The view seed, a number or a word. Read at mount; changing it later mounts a fresh viewer and reloads the data (points added with `update()` are lost). |

## Properties, methods, events

- `el.handle`: the viewer handle (see `js/api/50-viewer.md`), or `null` while not mounted.
- `el.update(data)`: forwards to the viewer and returns its result (never throws). This is how a host
  appends: `el.update({ ...meta, op: "append", vectors })`.
- `tumbler-load`: detail is the update result `{ ok: true, op, count, added }`. Fires for every
  successful load or `update()`.
- `tumbler-error`: detail is `{ code, message }`. Fires for every refusal, the viewer's own
  (`wrong-kind`, `dimension-mismatch`, ...) and the shell's:
  `core-missing`, `mount-failed`, `src-refused`, `src-unreadable`, `block-unreadable`.
- Both events bubble, so a host can listen on `document`.

## Lifecycle

- `connectedCallback` sets `display: block` through `el.style` (nothing else; no style element,
  attribute or shadow root) and mounts. `disconnectedCallback` destroys the viewer, so moving the
  element leaves exactly one viewer, and an element removed from the page holds nothing.
- **Core not loaded when the element connects:** the element shows a plain text message and does
  not retry on its own. Connecting it again (moving it, or re-adding it) is the retry.
- A fetch still in flight when the element is removed, or when `src` changes, is dropped: it never
  calls `update` on a destroyed viewer or on a newer `src`.
- The element needs a height from the host's CSS or the `--tumbler-stage-height` property
  (`js/api/50-viewer.md`, "Theming").

## Same origin only

Before any request, `src` is resolved against `document.baseURI` and refused unless its origin is
`location.origin` (an opaque origin such as `data:` or `file:` never matches). A refusal shows a
plain message inside the element, fires `tumbler-error` (`src-refused`) and makes no request. The
refused address is not echoed. Requests are `fetch(url, { credentials: "same-origin" })` with no
headers or other options; a reply that was redirected to another origin is not used. The
vector file name must be plain (as in `docs/data-contract.md`): a name that is not plain is never
fetched, and the JSON goes to the viewer, which refuses it with its own plain message. The
component reads nothing from the environment; keys and gateway addresses never reach the page.

## The built-in sample set

The element has no `sample` attribute (that would make the shell reach for more than
`mount`, `update` and `destroy`). A host that wants the sample set loads `sample-data.js` after
the core and does it in its own script:

```js
el.update(EmbeddingsTumbler.sample.generate())
```

## What the static test allows

`js/test/web-component-static.test.js` scans the file. On the core object it permits `mount`,
`update` and `destroy` and nothing else. It fails on any other member (`get`, `registerMode`,
`_internal`, bracket access), on any reference to `sample`, on any alias of the core object, and
on graphics, canvas, shader, matrix, projection, typed-array, animation-frame, markup-parsing
and style-attribute words.
