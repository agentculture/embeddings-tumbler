# Putting the viewer on your own page: the host guide

This guide is for you if you build a web page and want to show a set of
embedding vectors on it with `embeddings-tumbler`, a viewer that shows an
embedding space (hundreds or thousands of dimensions) as a moving
three-dimensional window onto the data. You do not need to know anything else
about this project.

If you want to know how to *make* a data file from your vectors, read the
[producer guide](producer.md) instead. The exact shape of the data is fixed in
[`docs/data-contract.md`](../data-contract.md); the viewer's full interface is
in `js/api/50-viewer.md`.

## What you get

The viewer comes as one JavaScript file, `embeddings-tumbler.js`. It has no
dependencies, needs no build step, and makes no network request of its own. You
can use it in three ways, which all run the same file:

1. **The script form.** You load the file, call `EmbeddingsTumbler.mount(...)`
   on an element, fetch your data yourself and call `update(...)`. Most control.
2. **The web component.** You load a second small file and write
   `<embeddings-tumbler src="space.json">`. Least code.
3. **The standalone page.** A ready-made `index.html` that shows a data file you
   name in the address (`index.html?data=space.json`). No code at all.

All three work from any folder you copy the files into, because every reference
between the files is relative and in the same folder.

The viewer shows three views of the same data, which you can switch between:
**Tumble** (the viewing window drifts through the space on a guided tour),
**Lattice** (points are wired to their true nearest neighbours, measured in the
full space) and **Wander** (the camera flies from point to neighbouring point).
All three use linear projections only, so what you see is always a shadow of the
real space (see [What the viewer tells your visitors](#what-the-viewer-tells-your-visitors)).

## Getting the files

The Python package writes the files into a folder you choose:

```text
pip install embeddings-tumbler
embeddings-tumbler viewer write my-site/viewer
embeddings-tumbler viewer write my-site/viewer --apply
```

The first `viewer write` is a preview: it lists what it would write and writes
nothing. Add `--apply` to write. It refuses to overwrite files that are already
there unless you also pass `--force`. It writes these files, all from the same
package, side by side:

| File | What it is |
|------|------------|
| `embeddings-tumbler.js` | The core. Always needed. |
| `sample-data.js` | A built-in generated sample set, for demos. Optional. |
| `demo-wikipedia.json`, `demo-wikipedia.f32` | The standalone page's default data: about a thousand Wikipedia articles embedded by a real model. Text under CC BY-SA 4.0 (see the package's `NOTICE`). Only for the standalone page; optional. |
| `web-component.js` | The `<embeddings-tumbler>` element. Only for the web component form. |
| `index.html`, `page.css`, `page.js` | The standalone page. Only for that form. |

The npm package `@culture.dev/embeddings-tumbler` (planned; not published yet)
will carry the same unmodified file.

Copy only the files you need into your site. Nothing needs to be edited.

### Trying things out locally

```text
embeddings-tumbler viewer serve my-site/viewer
```

serves the folder as static files on `http://127.0.0.1:8000/` (add
`--port 8080` to change the port). It binds to your own machine only; it warns
if you ask for another address. Open the printed address in a browser. A page
opened straight from disk with a `file://` address cannot fetch its data
file, so always serve the folder.

## The example pages

Every example in this guide is a real folder under
[`docs/guides/examples/`](examples/) that is tested in a real browser under the
strict policy described below. Each is a complete page, named `example.html`
(so that it does not clash with the standalone page's `index.html`): run
`embeddings-tumbler viewer write <folder> --apply` on the example folder to add
the viewer files next to it, serve the folder, and open `example.html`. They all use the
same small data file, `space.json` with `space.f32` beside it (320 points of 12
dimensions in four groups, made by the example script described in the producer
guide).

## The strict-policy story

All three forms work under the strictest ordinary Content-Security-Policy:

```text
Content-Security-Policy: default-src 'self'
```

That policy forbids inline scripts, inline `<style>` and `style` attributes,
and anything fetched from another origin. The viewer was written to need none
of those:

- It is a classic script from your own origin, with no `eval`, no dynamic code
  and no web fonts. Nothing is loaded from a CDN. (Fonts are system fonts by
  default. To use your own, see [Theming](#theming).)
- It never writes a `style` attribute in markup, a `<style>` element or a
  stylesheet; it sets styles from script, which a policy of `style-src 'self'`
  allows.
- **The viewer itself makes no network request.** Not `fetch`, not a socket, not
  an image. Your page fetches its own data, from its own origin, and hands it
  over. That is why the example pages contain their own small fetch code.
- Text from your data (labels, group names, provenance) is only ever inserted as
  text, never as markup, so a label like `<img src=x onerror=alert(1)>` is
  displayed literally.
- **The embedding gateway's address and key never belong in a page or a data
  file.** The viewer accepts only a *name* for the route the vectors were
  embedded through (for example `lobes gateway`), and refuses an address. Embed
  your text on your server, not in the visitor's browser, and write only the
  results to the data file.

Your own page has to obey the same rules, and the examples below do: no inline
script, no inline style, no handlers in attributes, only same-folder relative
references. Your server sets the header; to try the policy without a server,
put it in a meta tag in the page head:

```text
<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
```

## The script form

The most direct way. Here is a complete page. First the HTML: the viewer will
draw inside the `div` with the id `space`, and the script files are loaded from
the same folder.

<!-- file: examples/script/example.html -->

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Embeddings viewer: script form</title>
  <link rel="stylesheet" href="host.css">
</head>
<body>
  <main>
    <h1>My vectors</h1>
    <p>
      <button id="add" type="button">Add a point</button>
      <button id="toggle" type="button">Remove the viewer</button>
    </p>
    <p><output id="note">Loading.</output></p>
    <div id="space" class="space"></div>
  </main>
  <script src="embeddings-tumbler.js"></script>
  <script src="host.js"></script>
</body>
</html>
```

The page's own styles live in a file (an inline `<style>` would break the
policy). The viewer's height comes from the custom property
`--tumbler-stage-height`; the accent colour is set the same way. Both are
explained under [Theming](#theming).

<!-- file: examples/script/host.css -->

```css
body {
  margin: 0;
  padding: 16px;
  background: #0b0f1a;
  color: #e9eef6;
  font: 16px/1.5 system-ui, sans-serif;
}

main {
  max-width: 960px;
  margin: 0 auto;
}

button {
  font: inherit;
  padding: 6px 12px;
}

.space {
  --tumbler-stage-height: 420px;
  --tumbler-accent: #7fd1b9;
}
```

And the script. It mounts the viewer, fetches the data file and its `.f32`
block, hands them over with `update`, appends a point when the button is
pressed, and destroys the viewer when told to.

<!-- file: examples/script/host.js -->

```js
(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");
  const addButton = document.getElementById("add");
  const toggleButton = document.getElementById("toggle");
  let viewer = null;
  let added = 0;

  function say(text) {
    note.textContent = text;
  }

  function show(result) {
    if (result.ok) {
      say("Showing " + result.count + " points.");
    } else {
      say("The viewer refused the data (" + result.code + "): " + result.message);
    }
  }

  // The host does the fetching. The viewer never makes a request of its own.
  async function loadData(jsonUrl) {
    const response = await fetch(jsonUrl);
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + jsonUrl);
    const meta = await response.json();
    const file = meta?.vectors?.file;
    // Only fetch a plain file name from the data's own folder.
    if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) {
      return { ...meta }; // the viewer will refuse it with a plain message
    }
    const blockResponse = await fetch(new URL(file, new URL(jsonUrl, location.href)));
    if (!blockResponse.ok) throw new Error("HTTP " + blockResponse.status + " for " + file);
    const block = await blockResponse.arrayBuffer();
    // The block goes beside the file-form descriptor, so the viewer checks
    // the descriptor's dtype, byte order and length against it.
    return { ...meta, vectors: { ...meta.vectors, data: block } };
  }

  function start() {
    // mount once per element; options are read now and cannot change later.
    viewer = EmbeddingsTumbler.mount(el, { mode: "tumble", seed: 7, title: "My vectors" });
    toggleButton.textContent = "Remove the viewer";
    addButton.disabled = false;
    loadData("space.json")
      .then(function (data) {
        show(viewer.update(data));
      })
      .catch(function (error) {
        say("Could not load the data: " + error.message);
      });
  }

  function addPoint() {
    if (!viewer) return;
    const info = viewer.info();
    const vector = new Float32Array(info.dimension);
    for (let i = 0; i < vector.length; i++) vector[i] = Math.sin((added + 1) * (i + 1)) * 0.5;
    added += 1;
    // An append: same model and dimension as the view, new ids, no provenance needed.
    show(
      viewer.update({
        schema_version: 1,
        kind: "embeddings-tumbler/data",
        op: "append",
        model: info.model,
        dimension: info.dimension,
        count: 1,
        text_included: true,
        points: [{ id: "added-" + added, label: "added point " + added, group: "added" }],
        vectors: vector,
      })
    );
  }

  function toggle() {
    if (viewer) {
      EmbeddingsTumbler.destroy(el); // releases the canvas, the listeners and the GPU context
      viewer = null;
      toggleButton.textContent = "Bring the viewer back";
      addButton.disabled = true;
      say("The viewer was removed.");
    } else {
      start();
    }
  }

  addButton.addEventListener("click", addPoint);
  toggleButton.addEventListener("click", toggle);
  start();
})();
```

What to notice:

- `EmbeddingsTumbler.mount(el, options)` builds the viewer inside the element
  and returns a handle. The options are read once, here. Calling `mount` again
  on an element that already has a viewer returns the same handle and ignores the
  new options.
- The data goes in with `viewer.update(data)`. `data` is the same object as the
  JSON file, except `vectors`, which is the contents of the `.f32` file as an
  `ArrayBuffer` (or a `Float32Array`), not the description of the file. Fetch
  the block only after checking that `vectors.file` is a plain file name, as the
  example does: the name comes from the data, and you should not let data choose
  a URL.
- `update` never throws for bad data. It returns `{ ok: true, op, count, added }`
  or `{ ok: false, code, message }`, and the viewer also shows the message inside
  its element. See [Refusals](#refusals).
- **Appending while it runs.** A second `update` with `"op": "append"` adds
  points without resetting the camera or dropping any. It needs the same model
  and dimension as what is on screen, ids that are new, and no `provenance` (the
  view keeps the original). Here the example reads the model and dimension from
  `viewer.info()`. A stream of appends is fine: the viewer does not redo its
  expensive work for each one. A call without `op` (or with `op: "replace"`)
  instead replaces everything and restarts the camera.
- `EmbeddingsTumbler.destroy(el)` removes the viewer from the page and releases
  its animation loop, its observers, its listeners and its graphics context. It
  returns `true` when it released a viewer and `false` when there was none.

The result codes are easy to act on. A fragment:

<!-- file: examples/snippets/handle-results.js -->

```js
// update() never throws for bad data. It returns a result and the viewer shows the message.
const result = viewer.update(data);
if (result.ok) {
  console.log(result.op, "now showing", result.count, "points,", result.added, "added");
} else {
  switch (result.code) {
    case "append-without-base":
    case "model-mismatch":
    case "dimension-mismatch":
      // The append does not belong to this view: send a full set (a replace) instead.
      break;
    default:
      console.warn(result.code, result.message);
  }
}
```

### Options

All options are optional and are read once at `mount`:

<!-- file: examples/snippets/mount-options.js -->

```js
// Every option is optional. Options are read once, when the viewer is mounted.
const viewer = EmbeddingsTumbler.mount(document.getElementById("space"), {
  mode: "wander",          // "tumble" (default), "lattice" or "wander"
  seed: 20261113,          // makes the tour reproducible; shown on the page as "Seed (view)"
  speed: 1,                // motion speed multiplier
  paused: null,            // null: start paused only when the visitor prefers reduced motion
  title: "Support tickets",
  controls: true,          // false hides the play, zoom, speed and label controls
  provenanceOpen: false,   // start the provenance block collapsed (it cannot be removed)
  onError: function (result) {
    console.warn("refused:", result.code, result.message);
  }
});
```

Other options: `speed`, `labels`, `trails`, `readout`, `masthead`,
`maxPixelRatio`, `modeOptions`, `prepareBudgetMs`, `refitQuietSeconds`,
`refitShare`, `preserveDrawingBuffer`, `onModeChange`, `onPauseChange`. They
and the whole handle (`pause`, `resume`, `setMode`, `seek`, `zoom`, `info` and
more) are documented in `js/api/50-viewer.md`.

## The web component form

The least code. Load the core, then the component file, then write the element.
`src` is the address of a data file on your own origin; the component fetches
the JSON and the `.f32` block beside it with the browser's own `fetch` and
hands them to the viewer.

<!-- file: examples/web-component/example.html -->

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Embeddings viewer: web component</title>
  <link rel="stylesheet" href="host.css">
</head>
<body>
  <main>
    <h1>My vectors</h1>
    <p>
      <button id="add" type="button">Add a point</button>
    </p>
    <p><output id="note">Loading.</output></p>
    <embeddings-tumbler id="space" src="space.json" mode="lattice" seed="7"></embeddings-tumbler>
  </main>
  <script src="embeddings-tumbler.js"></script>
  <script src="web-component.js"></script>
  <script src="host.js"></script>
</body>
</html>
```

Attributes:

| Attribute | Meaning |
|-----------|---------|
| `src` | URL of a data JSON file on your own origin. Changing it loads the new file as a replace. Removing it keeps what is on screen. An address on another origin is refused before any request is made. |
| `mode` | `tumble`, `lattice` or `wander`. Changing it switches the view in place. |
| `seed` | The view's seed (see [Reproducible views](#reproducible-views)). Changing it re-mounts the viewer and reloads `src`, so points added through `update()` are lost. |

On the element: `el.update(data)` forwards to the viewer (this is how you
append), and `el.handle` is the viewer's handle, or `null` before there is one.
The component fires two events that bubble, so you can listen on the document:
`tumbler-load` (its `detail` is the result of the update) and `tumbler-error`
(its `detail` is `{ code, message }`). Besides the viewer's codes (see
[Refusals](#refusals)), the component's own error codes are `core-missing` (the
core file was not loaded before the component), `mount-failed`, `src-refused`
(the `src` is on another origin), `src-unreadable` (the JSON could not be
fetched or parsed) and `block-unreadable` (the `.f32` file could not be read).

The element has no attribute for the built-in sample set. To show it, load
`sample-data.js` after the core file and hand the sample to the element:

<!-- file: examples/snippets/component-sample.js -->

```js
// The built-in sample set with the web component. Load sample-data.js after the core file,
// leave out the src attribute, and hand the sample to the element from your own script.
const el = document.getElementById("space");
el.update(EmbeddingsTumbler.sample.generate({ count: 2000, dimension: 384, seed: 7 }));
```

Give the element its size through your own stylesheet (the component sets
`display: block` itself, since a policy forbids a style element). The viewer's
height is set with `--tumbler-stage-height`, and this example also shows a light
page, which is why it sets `--tumbler-background`:

<!-- file: examples/web-component/host.css -->

```css
body {
  margin: 0;
  padding: 16px;
  background: #f6f3ec;
  color: #1b2130;
  font: 16px/1.5 system-ui, sans-serif;
}

main {
  max-width: 960px;
  margin: 0 auto;
}

button {
  font: inherit;
  padding: 6px 12px;
}

/* A light page: tell the viewer so, and it draws the points as soft coloured ink. */
embeddings-tumbler {
  --tumbler-background: #f6f3ec;
  --tumbler-stage-height: 420px;
}
```

And the script that listens for the events and appends a point:

<!-- file: examples/web-component/host.js -->

```js
(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");
  const addButton = document.getElementById("add");
  let added = 0;

  // The component reports through events that bubble: no callbacks to wire up.
  document.addEventListener("tumbler-load", function (event) {
    const result = event.detail;
    note.textContent = "Showing " + result.count + " points.";
  });
  document.addEventListener("tumbler-error", function (event) {
    note.textContent = "The viewer refused the data (" + event.detail.code + "): " + event.detail.message;
  });

  addButton.addEventListener("click", function () {
    const viewer = el.handle; // null until the first data has been handed over
    if (!viewer) return;
    const info = viewer.info();
    const vector = new Float32Array(info.dimension);
    for (let i = 0; i < vector.length; i++) vector[i] = Math.sin((added + 1) * (i + 1)) * 0.5;
    added += 1;
    // An append goes through the element's update(): same model and dimension, new ids.
    const result = el.update({
      schema_version: 1,
      kind: "embeddings-tumbler/data",
      op: "append",
      model: info.model,
      dimension: info.dimension,
      count: 1,
      text_included: true,
      points: [{ id: "added-" + added, label: "added point " + added, group: "added" }],
      vectors: vector,
    });
    if (result?.ok) note.textContent = "Showing " + result.count + " points.";
  });
})();
```

Because the component loads a single file, an append file given to `src` is
refused with `append-without-base`; appends come through `el.update(...)` in
script.

## The standalone page form

No code. Write the viewer files into a folder, put your data file pair next to
them, serve the folder, and open the page with the data named in the address:

```text
embeddings-tumbler viewer write my-site/viewer --apply
cp space.json space.f32 my-site/viewer/
embeddings-tumbler viewer serve my-site/viewer
```

Then open `http://127.0.0.1:8000/index.html?data=space.json`.

| Address | Shows |
|---------|-------|
| `index.html` | The Wikipedia pair beside the page (`demo-wikipedia.json`); the synthetic sample set, with a line saying why, if the pair is missing, the viewer refuses it, or the page is opened as a file. |
| `index.html?sample=synthetic` | The built-in synthetic sample set (the page also links to it). |
| `index.html?data=space.json` | That data file (a relative path, or an address on the same origin). |
| `index.html?data=space.json&mode=lattice&seed=7` | The same, starting in a given mode and with a given seed. |

A `data` value that points at another origin is refused with a plain message on
the page, so a link cannot make the page load somebody else's data. The page
mounts one viewer through the script API described above. The example folder
`docs/guides/examples/standalone/` is just the data pair; run `viewer write`
on a copy of it, serve it, and open `index.html?data=space.json`.

This is also the quickest way to check a data file you have just produced.

## Theming

The viewer brings no stylesheet. You theme it with CSS custom properties on the
element it is mounted in, or any ancestor. It reads them at mount, on every
`update`, and when you call `viewer.refreshTheme()`; it never polls.

| Property | Default (dark) | Default when the background is light | Used for |
|----------|----------------|--------------------------------------|----------|
| `--tumbler-background` | `#04060b` | none | panel background, the sky's edge, text halos |
| `--tumbler-sky` | `#0b1430` | `#ffffff` | the sky's centre |
| `--tumbler-foreground` | `#e9eef6` | `#1b2130` | text, labels |
| `--tumbler-muted` | `#8a96ab` | `#5b6578` | secondary text |
| `--tumbler-line` | `#1b2436` | `#d6dae2` | rules and button borders |
| `--tumbler-accent` | `#ffc56b` | `#a35f00` | status line, selected mode, checkboxes |
| `--tumbler-ungrouped` | `#8cadff` | `#8cadff` | points with no group |
| `--tumbler-search-1` .. `--tumbler-search-4` | `#ffc56b` `#6be0ff` `#ff8fb3` `#b6ff8a` | `#a35f00` `#00708a` `#b0245a` `#3d7a00` | searches A to D: query ring, links, letters and ranks |
| `--tumbler-shared` | `#ffffff` | `#1b2130` | the mark for a point found by several searches, in the panel |
| `--tumbler-group-1` to `--tumbler-group-24` | hues `hsl(h 90% 62%)` | same | group colours, in order of first appearance in the data |
| `--tumbler-font` | system UI sans-serif | same | body text |
| `--tumbler-font-data` | system monospace | same | status, labels, controls, provenance |
| `--tumbler-font-display` | an old-style serif stack | same | title, mode names |
| `--tumbler-stage-height` | `clamp(300px, 62vh, 860px)` | same | height of the picture (any CSS length) |

Colours accept hex, `rgb()`, `hsl()` and anything else the browser understands.
Fonts: nothing is loaded from anywhere. Name a font you already have (your own
`@font-face` from your own origin, or a system font). A font or length value
that contains `url(`, `image-set`, a backslash or any of `; { } < >` is
ignored and the default is used, so a theme cannot make the viewer fetch
anything.

A dark theme:

<!-- file: examples/snippets/theme-dark.css -->

```css
/* Set the properties on the element the viewer is mounted in, or on any ancestor. */
.space {
  --tumbler-background: #101418;
  --tumbler-sky: #16202c;
  --tumbler-foreground: #e6edf3;
  --tumbler-muted: #8b98a5;
  --tumbler-line: #26313d;
  --tumbler-accent: #7fd1b9;
  --tumbler-ungrouped: #8cadff;
  --tumbler-group-1: #ffb86b;
  --tumbler-group-2: #7fd1b9;
  --tumbler-font: "Helvetica Neue", Arial, sans-serif;
  --tumbler-stage-height: clamp(320px, 55vh, 640px);
}
```

**Light backgrounds.** The viewer draws light points on black, with a glow,
which would wash out on a light page. When `--tumbler-background` is light
(luminance above one half), it switches its unset colours to the light column
above and draws the picture as soft coloured ink: the picture sits on a light
sky, each group is drawn as ink of its own colour laid on lightly, the hues
kept, and group names are darkened. There is nothing to choose. Two other
treatments (a dark panel for the picture, and stronger coloured ink) were tried
during development and removed at the project owner's decision on 2026-11-14.

<!-- file: examples/snippets/theme-light.css -->

```css
/* A light page. The viewer notices the light background, switches to its light defaults
   and draws the points as soft coloured ink. */
.space {
  --tumbler-background: #fbfaf6;
}
```

If you change a property from script, for instance when your page switches
between light and dark, ask the viewer to read it again:

<!-- file: examples/snippets/refresh-theme.js -->

```js
// The viewer reads the --tumbler-* properties when it mounts, on every update() and on
// refreshTheme(). It never polls. After changing a property, for example when the page
// switches between light and dark, ask it to read them again.
document.getElementById("space").style.setProperty("--tumbler-accent", "#ff8a65");
viewer.refreshTheme();
```

### Spacing

The viewer also takes its main spacing and sizes from custom properties, so you
can adjust them from your stylesheet without `!important`. Unlike the colours,
these are used by the browser directly: a change takes effect at once, with no
`refreshTheme()`, and never clears the picture. Leave a property unset and the
viewer uses its own value. Two have a smaller value of the viewer's own when the
viewer is under 600 px wide; a value you set is used at every width, so set it
again in your own media query if you want a narrow one.

| Property | Default | Under 600 px wide | Sets |
|----------|---------|-------------------|------|
| `--tumbler-masthead-top` | `14px` | same | the title block's distance from the top of the picture |
| `--tumbler-masthead-left` | `16px` | same | the title block's left inset |
| `--tumbler-masthead-right` | `16px` | same | the title block's right inset |
| `--tumbler-title-size` | `clamp(28px, 6vw, 56px)` | same | the title's font size |
| `--tumbler-title-margin` | `0 0 6px` | same | the margin around the title |
| `--tumbler-status-left` | `16px` | same | the status line's left inset |
| `--tumbler-status-right` | `16px` | same | the status line's right inset |
| `--tumbler-status-bottom` | `10px` | same | the status line's distance from the bottom of the picture |
| `--tumbler-panel-padding` | `6px 16px 16px` | `6px 12px 14px` | the padding of the panel below the picture |
| `--tumbler-panel-gap` | `14px` | same | the space between the panel's parts |
| `--tumbler-mode-padding` | `10px 12px 8px 0` | same | the padding of each mode button |
| `--tumbler-mode-title-size` | `24px` | `20px` | the font size of the mode names |
| `--tumbler-mode-summary-size` | `12.5px` | same (the summaries are hidden) | the font size of the mode summaries |
| `--tumbler-readout-caption-size` | `11.5px` | same | the font size of the caption under the readout strip |
| `--tumbler-controls-gap` | `10px 18px` | same | the row and column gaps between the controls |

<!-- file: examples/snippets/spacing.css -->

```css
/* Roomier spacing. The viewer uses each property where it is set, at every width, and its
   own value where it is not; nothing needs to outrank the viewer's inline styles. */
.space {
  --tumbler-masthead-top: 22px;
  --tumbler-title-size: clamp(34px, 6vw, 64px);
  --tumbler-panel-gap: 20px;
  --tumbler-mode-title-size: 28px;
  --tumbler-controls-gap: 10px 22px;
}

/* A narrow value of your own: set the property again in your own media query. */
@media (max-width: 600px) {
  .space {
    --tumbler-mode-title-size: 24px;
  }
}
```

## Lifecycle

- **Mount once per element.** One element holds one viewer. `mount` on an element
  that already has one returns the existing viewer and ignores the options you
  passed. To change options, destroy and mount again.
- **`update` replaces or appends.** A plain data object replaces the whole view
  and restarts the camera (the visitor's zoom is kept). With `op: "append"` it
  adds points and the camera carries on. A different model or dimension is
  allowed on a replace and refused on an append. A refused call leaves the view
  as it was.
- **`destroy` releases everything.** It stops the animation, disconnects its
  observers, removes its listeners, deletes its graphics resources, releases the
  graphics context at once and removes its markup from your element. Your
  element's own attributes and styles are never touched. Call it when your
  framework removes the element. It is safe to call twice.
- **It pauses itself.** While the browser tab is hidden or the element is
  scrolled out of view, the viewer asks for no animation frames at all, so a
  page with viewers below the fold costs nothing until they are seen. Motion
  carries on from where it stopped. A visitor who prefers reduced motion gets a
  viewer that starts paused, with a Play button; `paused: true` or `false`
  overrides that.
- **Several viewers on one page** are independent. They share nothing but the
  list of views and a registry keyed by element.

<!-- file: examples/snippets/two-viewers.js -->

```js
// Several viewers on one page are independent: one element, one viewer, each with its own
// options. Mounting an element that already has a viewer returns the existing viewer and
// ignores the new options; to change options, destroy the element's viewer and mount again.
const left = EmbeddingsTumbler.mount(document.getElementById("left"), { mode: "tumble", seed: 1 });
const right = EmbeddingsTumbler.mount(document.getElementById("right"), { mode: "lattice", seed: 2 });

console.log(EmbeddingsTumbler.mount(document.getElementById("left"), { mode: "wander" }) === left); // true

EmbeddingsTumbler.destroy(document.getElementById("left"));   // true: released
EmbeddingsTumbler.destroy(document.getElementById("left"));   // false: nothing to release
```

## What the viewer tells your visitors

Beside the picture, the viewer always shows a provenance block (it can start
collapsed, but it cannot be removed, and its summary line stays visible). It
lists, as plain text taken from the data file:

- the source and the model;
- the dimension (and, for a top-k reduction, what it was reduced from), and the
  number of items;
- the view's seed and the data's own seed;
- whether the vectors are synthetic;
- what was done to the vectors (nothing, an exact rotation, or a top-k
  approximation with the variance dropped);
- the producer, the name of the embedding route, and when the file was created;
- when `text_included` is false: "point ids only: this data carries no corpus
  text";
- the producer's limitations and uncertainties, or "none known".

It then always adds: **a projection is a shadow of the space, not the space.**
Each view shows three linear directions out of hundreds, so points that look
close may be far apart and points that look apart may be close. Distances in the
picture are not distances in the data. The reason it is always shown, and always
reports where the data came from, is that a picture that looks like a finding
should never be mistaken for one: the facts a reader needs to judge it are
printed next to it, and a host page cannot switch them off. There is no
non-linear reduction (no UMAP, no t-SNE) in the viewer, so it cannot invent
clusters.

## Reproducible views

The tour takes a seed (the `seed` option, the `seed` attribute, or `seed=` in
the standalone address). The same data, the same seed, the same mode and the
same elapsed view time give the same frame: a fresh viewer with `seed: 7`
followed by `viewer.seek(12)` shows the frame you saw 12 seconds into the same
view. The seed in the data file (`provenance.seed`) is a different thing: the
seed of whatever produced the vectors. Both are shown.

## Refusals

The viewer refuses data it cannot show faithfully rather than drawing a best
guess. It never throws into your page: the result is returned, shown inside the
viewer, and passed to `onError` if you gave one. A refused call leaves the view
as it was. The 15 codes from the data contract:

| Code | Meaning | What a host should do |
|------|---------|-----------------------|
| `wrong-kind` | Not viewer data, or the file could not be fetched or parsed. | Check the address and that the file is a data file. |
| `schema-version` | A schema version this viewer does not read. | Use a viewer that supports it, or regenerate the data. |
| `invalid-field` | A field is missing or not valid; the message names it. | Fix the data (see the producer guide). |
| `vector-file-path` | `vectors.file` is not a plain file name. | Fix the data; do not fetch it. |
| `endpoint-is-address` | `provenance.endpoint` looks like an address. | Fix the data: a name, never an address. |
| `count-mismatch` | `count` differs from the number of points. | Fix the data. |
| `duplicate-id` | An id appears twice. | Fix the data. |
| `block-unreadable` | The `.f32` file could not be read. | Check it sits next to the JSON file and your server serves it. |
| `block-length` | The block is the wrong length. | Fix the data; also check your server does not compress or transform the file. |
| `non-finite` | A vector holds NaN or an infinity. | Fix the data. |
| `append-without-base` | An append arrived with nothing on screen. | Send a full set first. |
| `model-mismatch` | An append from another model. | Send a replace, or use one model. |
| `dimension-mismatch` | An append of another dimension. | Send a replace. |
| `reduction-mismatch` | An append with another reduction kind. | Send a replace. |
| `id-exists` | An append reused an id. | Give new points new ids. |

The viewer has its own codes too:

| Code | Meaning | What a host should do |
|------|---------|-----------------------|
| `not-mounted` | The module `update` was called on an element with no viewer. | Mount first. |
| `destroyed` | `update` after `destroy`. | Mount a new viewer. |
| `mode-failed` | A mode could not start, or no mode can show the set (for example it has fewer than 3 dimensions). | Check the data; the previous view keeps running. |
| `gpu-failed` | The graphics layer failed taking the points; the previous view is restored. | Try again or fall back to a message. |
| `internal` | An unexpected fault inside the viewer. | Report it; it is never bad data. |

And after a replace was accepted, the graphics card may still be unable to draw
it: `too-many-points`, `dimension-too-large` or `shader-failed`. The data and
provenance stand, and a message over the picture says this GPU cannot draw
them. Without WebGL 2 the viewer shows a plain message and still validates and
shows the provenance.

## Sizes and speed: what has been measured

What follows are measurements, not promises.

- **Frame rate.** With 12,288 points in Chromium on a desktop with an AMD Radeon
  760M graphics chip, the viewer held the display's 60 frames per second in all
  three views at 384 and 1024 dimensions. On a software renderer (SwiftShader,
  no GPU) the same sets ran at 22 to 34 frames per second. (This table was taken
  before a later performance pass and was not repeated; the GPU still held 60 in
  every later run.)
- **Loading.** On that desktop the sample set of 12,288 points took about 150
  ms to the first frame and about 1.3 seconds until Tumble was moving at 1024
  dimensions (about 0.55 seconds at 384). The viewer prepares in slices of a few
  milliseconds per frame, so the page does not freeze; the cloud keeps its slow
  spin and a progress line shows meanwhile.
- **Appends.** One append of 100 points onto 10,000 points of 1024 dimensions
  took 2 to 6 ms, apart from the first, which takes about 100 ms because the
  graphics buffers double in size.
- **Memory.** The vectors are held twice, once for the page and once on the
  graphics card: points times dimension times 4 bytes each. 10,000 points at 1024
  dimensions is about 41 MB each. The page's memory with 12,288 points of 1024
  dimensions was measured at 231 to 284 MB before the latest performance pass
  and not re-measured.
- **Limits.** The card limits the number of points: roughly 262,000 at 1024
  dimensions and 98,000 at 2560 on the desktop measured (a software renderer:
  131,000 and 49,000 at the default row width). Memory comes first in practice.
  Lattice measures neighbours for the first 1,000 points only.

**What has not been measured.** Automated tests cover desktop Chromium only.
Firefox and desktop Safari have not been tested. The author has run it by hand
on an iPhone 13 in Chrome and in Safari and on a small ARM board in Chrome and
saw it work, but there are no measurements from those, no frame rates, and no
tests. Treat other browsers and low-powered devices as unmeasured, and try your
own data on the devices you care about.

## Accessibility

Be aware of what the viewer cannot do yet. The picture is a moving WebGL canvas
with no full text alternative: a screen reader is told its label (the model,
dimension and number of points) and can read the provenance block, the status
line and the controls, which are real buttons and inputs that work from the
keyboard, but the shape of the data itself is not described. Do not make the
viewer the only way to reach a fact. The viewer starts paused for visitors who
prefer reduced motion. Keys work while the viewer has focus: `Escape` dismisses
a notice, `1` to `9` pick a mode, space pauses or plays, `+` and `-` zoom and
`0` resets the zoom. A vertical swipe on a phone scrolls the page; a horizontal
drag turns the cloud.

## Where the data goes

A data file carries the labels and the vectors, and anyone who can load your
page can fetch both. If the texts are private, leave them out when you write the
file; the producer guide says how, and why the vectors can still reveal the
texts. The viewer sends your text, labels and vectors nowhere, and your page
fetches the files from your own origin.
