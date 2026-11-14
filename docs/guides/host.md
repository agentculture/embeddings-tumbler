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

The viewer shows four views of the same data, which you can switch between:
**Tumble** (the viewing window drifts through the space on a guided tour),
**Lattice** (points are wired to their true nearest neighbours, measured in the
full space), **Wander** (the camera flies from point to neighbouring point) and
**Focus** (the view is fitted to what was searched for). All four use linear
projections only, so what you see is always a shadow of the real space (see
[What the viewer tells your visitors](#what-the-viewer-tells-your-visitors)).

The viewer can also **search** the points it shows: a visitor types text and
the nearest points are lit and listed. That works with no code from you; what
you can add is in [Search](#search).

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

The npm package `@culture.dev/embeddings-tumbler` carries the same unmodified
file.

Copy only the files you need into your site. Nothing needs to be edited.

### Trying things out locally

```text
embeddings-tumbler viewer serve my-site/viewer
```

serves the folder as static files on `http://127.0.0.1:8000/` (add
`--port 8080` to change the port). It binds to your own machine only; it warns
if you ask for another address. Open the printed address in a browser. A page
opened straight from disk with a `file://` address cannot fetch its data
file, so always serve the folder. With `--embed` the same command also lets the
standalone page search by meaning; see
[Search in the standalone page, and the local helper](#search-in-the-standalone-page-and-the-local-helper).

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

`mode` also accepts `"focus"`. The options for search are listed under
[Search options at mount](#search-options-at-mount).

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
| `mode` | `tumble`, `lattice`, `wander` or `focus`. Changing it switches the view in place. |
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

## Search

The viewer can search the points it shows. A visitor types text, or several
texts, and the viewer lights the points nearest to each and lists them. You get
this without writing anything: every viewer has a search panel under the
picture. This section says what you can add, and how to drive search from your
own code. What each control in the panel does is in the
[search guide](search.md), which is written for the person using the page.

A few words used below, each with one meaning:

- A **search** is one query and the points found for it. Up to four can be
  shown at once. They are lettered A to D in the order given.
- **Distance** is always cosine distance (1 minus cosine similarity), measured
  over every dimension of the data. It is never a length in the picture.
- A **named point** is a point with text a person can read: a label or a
  `metadata.text` that is not just its id. In a real data file that is usually
  every point.
- The **results** of a search are the named points nearest to its query: 8 by
  default.
- The **result radius** is the distance of the farthest result. Every point at
  most that far from the query is **lit**, named or not. Every other point is
  dimmed.

There are four kinds of search, and they differ in where the query comes from:

| Kind | The query is | Needs | Where the typed text goes |
|------|--------------|-------|---------------------------|
| `words` | The typed words, matched against the labels and texts of the loaded points. The query is the mean of the vectors of the points that matched. | Nothing. | Nowhere. |
| `point` | A loaded point's own vector, chosen by its id. | Nothing. | There is no typed text. |
| `vector` | A vector your code already has. | Your code. | There is no typed text. |
| `embedded` | The typed text, turned into a vector by an embedding model. | An `embed` callback that you supply. | To your `embed` callback, and nowhere else. |

So with no code from you, search works among the loaded points: a visitor can
find points by the words in their labels and texts. To let a visitor search by
meaning with free text, you supply an `embed` callback. You may also supply a
`rerank` callback, which lets a second model reorder the nearest candidates.
With reranking on, the query text and the candidate texts go to that callback,
for every kind of search that has a query text.

**The viewer still makes no network request.** It calls your callbacks; what
they do is yours to decide. The address and the key of your embedding service
belong on your server, never in a page or a data file.

### Search in the script form

The folder `examples/script-search/` is a complete page that uses everything in
this section: both callbacks, every search method of the handle, and the report
the viewer gives back. First the HTML. The buttons carry a `data-action` name
that the script acts on.

<!-- file: examples/script-search/example.html -->

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Embeddings viewer: script form with search</title>
  <link rel="stylesheet" href="host.css">
</head>
<body>
  <main>
    <h1>My vectors, with search</h1>
    <p class="row">
      <label for="query">Text</label>
      <input id="query" type="text" value="alpha" autocomplete="off">
      <button type="button" data-action="words">Match words</button>
      <button type="button" data-action="embed">Embed and search</button>
    </p>
    <p class="row">
      <button type="button" data-action="two">Two searches</button>
      <button type="button" data-action="point">From point p0007</button>
      <button type="button" data-action="vector">From a vector</button>
      <button type="button" data-action="settings">12 results, lit by closeness</button>
      <button type="button" data-action="rerank">Reranker on or off</button>
      <button type="button" data-action="face">Face the searches</button>
      <button type="button" data-action="clear">Clear</button>
    </p>
    <p><output id="note">Loading.</output></p>
    <pre id="report"></pre>
    <div id="space" class="space"></div>
  </main>
  <script src="embeddings-tumbler.js"></script>
  <script src="host.js"></script>
</body>
</html>
```

The script. Read it from the top: the two callbacks, the function that turns
the viewer's report into text, the `mount` call, and one action per button.

<!-- file: examples/script-search/host.js -->

```js
(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");
  const report = document.getElementById("report");
  const field = document.getElementById("query");
  let known = null; // what this page loaded: { model, byName: lower-case id or label -> vector }

  function say(text) {
    note.textContent = text;
  }

  // ---------- the two callbacks ----------

  // THE EMBED CALLBACK. The viewer calls it with the typed text and nothing else. It answers
  // { vector, model, queryForm? }: a vector of the data's dimension, the id of the model that
  // made it (required, and it must equal the data's model), and optionally which input form
  // the model was given ("query", "plain", ...).
  //
  // This example has no model, so it stands in for one: it knows the ids and labels of its own
  // points and answers with that point's vector. Nothing leaves the page. A real host calls its
  // OWN server here and returns its answer; that server holds the address and the key of the
  // embedding service, which must never reach a page.
  async function embed(text) {
    const vector = known.byName.get(text.trim().toLowerCase());
    if (!vector) throw new Error("This stand-in embedder only knows this page's ids and labels.");
    return { vector: vector, model: known.model, queryForm: "plain" };
  }

  // THE RERANK CALLBACK. The viewer calls it with the query text and the candidate texts (the
  // nearest named points, nearest first). It answers { scores, model }: one finite number per
  // candidate, in the order given, higher meaning more relevant, and the reranker's own id.
  //
  // This stand-in counts the words a candidate shares with the query. A real host sends both
  // to its own server, as for embed.
  async function rerank(query, candidates) {
    const wanted = new Set(query.toLowerCase().match(/[a-z0-9]+/g) || []);
    const scores = candidates.map(function (candidate) {
      const words = new Set(candidate.toLowerCase().match(/[a-z0-9]+/g) || []);
      let shared = 0;
      for (const word of wanted) if (words.has(word)) shared += 1;
      return shared;
    });
    return { scores: scores, model: "example/shared-words" };
  }

  // ---------- what a search reports ----------

  // onSearchChange gets info().search each time it changes. Everything the picture shows is
  // in it as numbers and text, so a host (or a test) never has to read pixels.
  function describe(search) {
    if (search.waiting) return "Working out the search.";
    if (!search.active) return "No search: every point is shown.";
    const lines = [search.litCount + " points lit. Distances are " + search.measure + "."];
    for (const one of search.searches) {
      lines.push(
        one.letter + ": " + one.kind + ' search for "' + one.text + '", text sent to ' + one.sentTo +
          (one.reranker ? ", reranked by " + one.reranker : "") + ". " + one.results.length +
          " results, " + one.insideCount + " points within " + one.radius.toFixed(3) + "."
      );
      for (const hit of one.results.slice(0, 3)) {
        lines.push("   " + hit.rank + ". " + hit.text + " (" + hit.distance.toFixed(3) + ")");
      }
    }
    for (const pair of search.pairs) {
      lines.push(pair.a + " and " + pair.b + ": " + pair.shared + " points inside both, " +
        pair.common + " results in common.");
    }
    return lines.join("\n");
  }

  // ---------- the viewer ----------

  const viewer = EmbeddingsTumbler.mount(el, {
    seed: 7,
    title: "My vectors",
    embed: embed, // without it, typed text is matched among the loaded points
    rerank: rerank, // without it, there is no reranking and no Reranker control
    searchK: 8, // results per search, 3 to 100
    onSearchChange: function (search) {
      report.textContent = describe(search);
    },
  });

  // The host does the fetching. The viewer never makes a request of its own.
  async function loadData(jsonUrl) {
    const meta = await (await fetch(jsonUrl)).json();
    const file = meta?.vectors?.file;
    if (typeof file !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) return { ...meta };
    const block = await (await fetch(new URL(file, new URL(jsonUrl, location.href)))).arrayBuffer();
    return { ...meta, vectors: { ...meta.vectors, data: block } };
  }

  function remember(data) {
    const flat = new Float32Array(data.vectors.data);
    const byName = new Map();
    data.points.forEach(function (point, i) {
      const vector = flat.slice(i * data.dimension, (i + 1) * data.dimension);
      byName.set(point.id.toLowerCase(), vector);
      byName.set(String(point.label).toLowerCase(), vector);
    });
    known = { model: data.model, byName: byName };
  }

  // A vector the host already has: here, the middle of two loaded points.
  function between(a, b) {
    const one = known.byName.get(a);
    const two = known.byName.get(b);
    return one.map(function (value, i) {
      return (value + two[i]) / 2;
    });
  }

  // ---------- the handle's search methods ----------

  const actions = {
    // Typed text matched among the labels and texts of the loaded points. Nothing is sent.
    words: function () {
      return viewer.setSearches([{ text: field.value, via: "words" }]);
    },
    // Typed text through the embed callback. A plain string does the same when a callback is set.
    embed: function () {
      return viewer.setSearches([{ text: field.value, via: "embed" }]);
    },
    // Up to four searches at once. They get the letters A to D in the order given.
    two: function () {
      return viewer.setSearches([{ text: "alpha", via: "words" }, { text: "beta", via: "words" }]);
    },
    // From a loaded point, by its id.
    point: function () {
      return viewer.setSearches([{ point: "p0007" }]);
    },
    // From a vector the host has. The model id is required and is checked against the data's.
    vector: function () {
      return viewer.setSearches([
        { vector: between("p0000", "p0001"), model: known.model, label: "between p0000 and p0001" },
      ]);
    },
    // Settings work the searches out again from the query vectors held: no new embed call.
    settings: function () {
      return viewer.setSearchSettings({ k: 12, lit: "close", distances: true });
    },
    rerank: function () {
      return viewer.setSearchSettings({ rerank: !viewer.searchSettings().rerank });
    },
    // The next two answer at once with true or false.
    face: function () {
      return { ok: viewer.faceSearches(), code: "not-faced", message: "There is no search to face." };
    },
    clear: function () {
      return { ok: viewer.clearSearches(), code: "nothing-to-clear", message: "There was no search." };
    },
  };

  // setSearches and setSearchSettings return promises that never reject. They resolve to
  // { ok: true, search } or { ok: false, code, message }, and a refusal changes nothing.
  document.addEventListener("click", async function (event) {
    const action = actions[event.target.dataset?.action];
    if (!action || !known) return;
    const result = await action();
    if (result.ok) say("Done: " + event.target.textContent + ".");
    else if (result.code !== "superseded") say("Refused (" + result.code + "): " + result.message);
  });

  loadData("space.json")
    .then(function (data) {
      const result = viewer.update(data);
      if (result.ok) {
        remember(data);
        say("Showing " + result.count + " points.");
      } else {
        say("The viewer refused the data (" + result.code + "): " + result.message);
      }
    })
    .catch(function (error) {
      say("Could not load the data: " + error.message);
    });
})();
```

The stylesheet sets the colours of the first two searches. The property names
are in [Theming](#theming).

<!-- file: examples/script-search/host.css -->

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

button,
input {
  font: inherit;
  padding: 6px 12px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

pre {
  min-height: 6em;
  margin: 0 0 16px;
  white-space: pre-wrap;
  font: 13px/1.5 ui-monospace, monospace;
}

.space {
  --tumbler-stage-height: 420px;
  /* The colours of searches A and B: ring, links, letters and list numbers. */
  --tumbler-search-1: #ffd27a;
  --tumbler-search-2: #7ad7ff;
}
```

What to notice:

- The callbacks are **mount options**: `embed` and `rerank`. You can also set
  or remove them later with `viewer.setSearchCallbacks({ embed, rerank })`.
- This example has no embedding model, so its callbacks stand in for one, and
  they answer from data the page already has. Yours will call your own server.
- A search is started with `viewer.setSearches([...])`, which replaces every
  search shown. The same call is what the panel makes when a visitor types.
- Nothing here reads the picture. Everything the picture shows is in
  `viewer.info().search` as numbers and text.

### The callback contracts

**`embed(text)`** is called with one argument, the query text as a string. It
returns, or returns a promise of, an object:

| Field | Required | Meaning |
|-------|----------|---------|
| `vector` | yes | An array of numbers, a `Float32Array` or a `Float64Array`, as long as the data's dimension. |
| `model` | yes | The id of the model that made the vector. It must equal the data's `model` exactly. An answer with no model is refused, not assumed to match. |
| `queryForm` | no | A word for how the text was given to the model, for models that treat queries and documents differently (for example `"query"`, `"prefixed"` or `"plain"`). It is shown beside the search. |

The viewer checks the answer before using it: the model, the dimension, that
every value is a finite number, and that the vector is not all zeros. If any
check fails, the search is refused with a plain message and the earlier
searches stay.

**`rerank(query, candidates)`** is called with the query text and an array of
candidate texts, nearest first. It returns, or returns a promise of, an object:

| Field | Required | Meaning |
|-------|----------|---------|
| `scores` | yes | One finite number per candidate, in the order given. Higher means more relevant. |
| `model` | yes | The reranker's id. It is shown as the reranker in use. |

The reranker is used only while the `rerank` setting is on. It is sent the
nearest named points as candidates (50 by default, 3 to 100) and the best of
them by its scores are kept as the results (20 by default). A data file with
`text_included: false` has no texts to send, so it is never reranked.

Rules for both callbacks:

- Either may be a plain function or an `async` function.
- If one throws, rejects or takes longer than 15 seconds (the `searchTimeoutMs`
  option), the viewer carries on. A failed `embed` refuses that search
  (`embed-failed`, `embed-timeout`) and the earlier searches stay. A failed
  `rerank` is not a refusal: the search keeps its order by distance and says so
  in its `note`.
- The message of an error your callback throws is never shown on the page,
  because it could carry an address or a key. You see your own error in your
  own code.
- The typed text is passed to `embed` and to nothing else. The viewer does not
  log it, store it or send it.

### The handle's search methods

| Method | Returns | What it does |
|--------|---------|--------------|
| `setSearches(list)` | a promise | Replaces every search with the 0 to 4 entries of `list`. |
| `clearSearches()` | `true` or `false` | Removes every search. `false` when there was none. |
| `setSearchSettings(patch)` | a promise | Changes settings and works the searches out again from the queries held. `embed` is not called again. |
| `searchSettings()` | an object | A copy of the current settings. |
| `faceSearches()` | `true` or `false` | Turns the view toward the searches again. `false` with no search, and always in Focus. |
| `setSearchCallbacks({ embed, rerank })` | `{ embedder, reranker }` | Sets or replaces a callback after mount. `null` removes one. A key you leave out is kept. |

An entry of `setSearches` is one of:

| Entry | Kind of search |
|-------|----------------|
| `"some text"` or `{ text: "some text" }` | `embedded` when an `embed` callback is set, otherwise `words`. |
| `{ text: "some text", via: "words" }` | `words`, even when a callback is set. |
| `{ text: "some text", via: "embed" }` | `embedded`. Refused with `no-embedder` when no callback is set. |
| `{ point: "an-id" }` | `point`. |
| `{ vector: [...], model: "the-model-id", label: "a name" }` | `vector`. `label` is optional; it names the search in the panel and is the query text for a reranker. |

The promises of `setSearches` and `setSearchSettings` never reject. They
resolve to `{ ok: true, search }`, where `search` is the report described
below, or to `{ ok: false, code, message }`.

- **A refusal changes nothing.** If any entry is refused, none takes effect and
  the earlier searches and the view stay as they were.
- **The latest call wins.** A call still waiting when a newer one arrives
  resolves with the code `superseded`, and its late answers are dropped. The
  example ignores that code for this reason.
- **Words that match nothing are not an error** unless nothing at all matched.
  A `words` entry with no match is left out and its words are listed in
  `search.unmatched`. If every entry is left out, the result is `words-none`.

The settings that `setSearchSettings` accepts:

| Setting | Values | Default | Meaning |
|---------|--------|---------|---------|
| `k` | 3 to 100 | 8 | Results per search when no reranker runs. |
| `candidates` | 3 to 100 | 50 | Nearest named points sent to the reranker. |
| `top` | 3 to `candidates` | 20 | Reranked candidates kept as the results. |
| `lit` | `"even"`, `"close"`, `"named"` | `"even"` | What is lit: every point within the result radius, evenly; the same with nearer points lit more strongly; or the results only. |
| `distances` | `true`, `false` | `false` | Show each result's distance, and how much farther it is than the nearest. |
| `rerank` | `true`, `false` | `false` | Use the `rerank` callback. Stays `false` when there is no callback or the data carries no text. |
| `pointOfView` | `"A"` to `"D"`, or `null` | `null` | Measure one search from its own point of view: every dimension is scaled by the size of that search's query there. |
| `onlyResults` | `true`, `false` | `false` | In Focus only: hide the points that are not lit, where the other views dim them. |

Unknown keys and values out of range are ignored or brought into range. The
starting values of `k`, `candidates`, `top` and `lit` can be given at mount.

### Search options at mount

| Option | Default | Meaning |
|--------|---------|---------|
| `embed` | none | The `embed` callback. |
| `rerank` | none | The `rerank` callback. |
| `searchTimeoutMs` | `15000` | How long a callback may take. |
| `searchPanel` | `true` | `false` leaves the search panel out. The handle still does everything. |
| `searchK` | `8` | The starting `k`. |
| `searchCandidates` | `50` | The starting `candidates`. |
| `searchTop` | `20` | The starting `top`. |
| `searchLit` | `"even"` | The starting `lit`. |
| `onSearchChange(search)` | none | Called with the report each time it changes. |

### What `info()` reports about search

`viewer.info().search` is always present. With no search it has
`active: false` and empty lists. The same object is passed to
`onSearchChange` and is the `search` of a successful `setSearches`.

| Field | Meaning |
|-------|---------|
| `active` | `true` while at least one search is shown. |
| `waiting` | `true` while a callback has not answered or a search is still being worked out. |
| `stale`, `staleBy` | `true` when points were appended after the results were worked out, and how many. The viewer works the searches out again by itself. |
| `code`, `message` | The latest refusal or note, or `null`. |
| `measure` | The name of the distance: `cosine distance (1 minus cosine similarity)`. |
| `settings` | The settings, as `searchSettings()` gives them. |
| `embedder.available` | Whether an `embed` callback is set. |
| `reranker.available`, `reranker.offered` | Whether a `rerank` callback is set, and whether it can be used on this data (the data carries text). |
| `sameSpace.ok` | Whether a query vector can be compared with this data. `false` for a reduced data file; see [What search does not do](#what-search-does-not-do). |
| `litCount`, `sharedCount` | How many points are lit, and how many lie within the result radius of two or more searches. |
| `unmatched` | Words that matched nothing. |
| `facing`, `faceable` | Whether the view is turning toward the searches now, and whether the current view can (`false` in Focus). |
| `searches` | One entry per search, described next. |
| `pairs` | One entry per pair of searches: `a` and `b` (letters), `shared` (points within both radii), `common` and `commonIds` (results the two have in common), `closest` (the nearest two different results, one from each, and their distance). |

Each entry of `searches`:

| Field | Meaning |
|-------|---------|
| `letter` | `"A"` to `"D"`. |
| `kind` | `"embedded"`, `"vector"`, `"words"` or `"point"`. |
| `text` | The typed text, the vector's label, or the point's id. |
| `model`, `queryForm` | The model the query vector came from, and the query form your `embed` callback reported (or `null`). |
| `sentTo` | `"embedder"` when the typed text went to your `embed` callback, otherwise `"nowhere"`. |
| `reranker` | The reranker's id when this search was reranked, otherwise `null`. |
| `sent` | How many candidate texts went to the reranker for this search (0 when none). |
| `words`, `point` | For a `words` search, which words were used and how many points each matched. For a `point` search, the id. |
| `k`, `candidates`, `top`, `available`, `counts` | The counts this search used, how many points could be results, and a sentence when a count had to be cut to what there is. |
| `note` | A message about this search, or `null`: for example that the reranker failed. |
| `radius`, `insideCount` | The result radius, and how many points are within it. |
| `pointOfView` | Whether this search is the one measured from its own point of view. |
| `results` | The results in order. Each has `id`, `index`, `rank`, `distance`, `gap` (how much farther than the nearest), `text`, and, after reranking, `score`, `embeddingRank` and `moved`. |

A test can check a search without looking at the picture: the results are
`searches[i].results`, and the points lit by search `i` (with the `"even"`
setting) are those whose distance to its query is at most `searches[i].radius`.

### Search in the web component

The `<embeddings-tumbler>` element has two **properties**, `embed` and
`rerank`, which take the same callbacks. One assignment adds search by
embedding. They are properties and never attributes: an `embed="..."` attribute
in markup does nothing, so markup cannot supply code. Everything else goes
through `el.handle`, which has the methods above. The folder
`examples/web-component-search/` is a complete page:

<!-- file: examples/web-component-search/example.html -->

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Embeddings viewer: web component with search</title>
  <link rel="stylesheet" href="host.css">
</head>
<body>
  <main>
    <h1>My vectors, with search</h1>
    <form id="ask">
      <label for="query">Point id to search from (for example p0007)</label>
      <input id="query" name="query" type="text" value="p0007" autocomplete="off">
      <button type="submit">Search</button>
    </form>
    <p><output id="note">Loading.</output></p>
    <embeddings-tumbler id="space" src="space.json" mode="tumble" seed="7"></embeddings-tumbler>
  </main>
  <script src="embeddings-tumbler.js"></script>
  <script src="web-component.js"></script>
  <script src="host.js"></script>
</body>
</html>
```

<!-- file: examples/web-component-search/host.js -->

```js
(function () {
  "use strict";

  const el = document.getElementById("space");
  const note = document.getElementById("note");

  // The vectors this page already has, read once from its own files, by point id.
  const table = fetch("space.json")
    .then((res) => res.json())
    .then(async (data) => {
      const block = await (await fetch(data.vectors.file)).arrayBuffer();
      const flat = new Float32Array(block);
      const byId = new Map();
      data.points.forEach((p, i) => {
        byId.set(p.id, flat.slice(i * data.dimension, (i + 1) * data.dimension));
      });
      return { model: data.model, byId: byId };
    });

  // THE ONE ASSIGNMENT THAT ADDS SEARCH. The viewer calls this with the typed text, and
  // wants back { vector, model }: a vector of the data's dimension and the id of the model
  // that made it.
  //
  // This example answers from vectors already in the page: it looks the text up among the
  // point ids and returns that point's own vector. Nothing leaves the page. A real host
  // would call its OWN server here (for example fetch("/my/embed", { method: "POST", ... })
  // and return its answer), and that server would hold the key to the embedding model. The
  // viewer itself never makes a request, and the key must never reach the page.
  el.embed = async function (text) {
    const known = await table;
    const vector = known.byId.get(text.trim());
    if (!vector) throw new Error("This example only knows its own point ids.");
    return { vector: vector, model: known.model };
  };

  document.addEventListener("tumbler-load", function (event) {
    note.textContent = "Showing " + event.detail.count + " points.";
  });
  document.addEventListener("tumbler-error", function (event) {
    note.textContent = "The viewer refused the data (" + event.detail.code + "): " + event.detail.message;
  });

  document.getElementById("ask").addEventListener("submit", async function (event) {
    event.preventDefault();
    const viewer = el.handle; // null until the element has mounted
    if (!viewer) return;
    const result = await viewer.setSearches([document.getElementById("query").value]);
    if (result.ok) note.textContent = "Searched for " + result.search.searches[0].text + ".";
    else note.textContent = "No search (" + result.code + "): " + result.message;
  });
})();
```

You can assign the property at any time: before the element is in the page,
before its data has loaded, or afterwards. Assigning `null` removes the
callback, and typed text is then matched among the loaded points again. The
element's `mode` attribute also accepts `focus`.

### Search in the standalone page, and the local helper

The standalone page needs no code for search either. Served as plain static
files, it searches among the loaded points. To search by meaning, the page
needs something that can embed the typed text, and a static file server cannot.
The package brings a local helper for this:

```text
embeddings-tumbler viewer serve my-site/viewer --embed
```

With `--embed` the server also answers one route on its own origin,
`POST /_tumbler/search`. The standalone page asks its own origin whether that
route is there. When it is, the page gives the viewer `embed` and `rerank`
callbacks that post to it. The page never asks any other address, and no query
parameter or data file can change that.

The helper is where the embedding service's address and key live. They are read
from the **environment of the server process**, and only when `--embed` is
given:

| Variable | Meaning |
|----------|---------|
| `EMBEDDINGS_EMBED_URL` | The base address of an OpenAI-compatible embedding service, including `/v1`. Default `http://localhost:8001/v1`. |
| `EMBEDDINGS_API_KEY`, or else `COLLEAGUE_API_KEY` | The key. With neither set, the command stops with exit code 2 and a message that names the variables. |
| `EMBEDDINGS_EMBED_MODEL` | The embedding model, unless `--embed-model` names one. Default `Qwen/Qwen3-Embedding-0.6B`. |

Neither the address nor the key is ever sent to a page: not in an answer, not
in a header, not in a log line, and not in the command's `--json` output. The
helper answers with the vector, the model id and the query form, and nothing
else about the service.

| Flag | Meaning |
|------|---------|
| `--embed` | Turn the route on. Without it the server is static only and reads no variable. |
| `--embed-model MODEL` | The embedding model to ask for. It must be the model that made your data, or every search is refused with `query-model-mismatch`. |
| `--rerank-model MODEL` | Also offer reranking, with this model. Without it there is no Reranker control. |
| `--query-prefix TEXT` | Text put before every query before it is embedded, for models that expect one. The query form is then reported as `prefixed`, otherwise `plain`. |
| `--embed-allow-remote` | Allow `--embed` together with a `--host` that is not your own machine. |

**The route stays on loopback** (your own machine) unless you pass
`--embed-allow-remote`. `--embed` with any other `--host` is refused with exit
code 1 before anything is served, because whoever can reach the route can spend
your key. The route also answers only a `POST` with a JSON body from a page of
its own origin, limits the length of a text (8,000 characters), the number of
candidates (100) and the number of requests (120 a minute), and sends no
cross-origin headers.

The helper is for trying things on your own machine. On a real site, write the
same small route on your own server and call it from your `embed` callback.

The standalone page's default data is a real set, so that search has something
to find: 999 articles from English Wikipedia's list of vital articles
(Level 3), each embedded from the first sentences of its introduction by
`Qwen/Qwen3-Embedding-0.6B`, which is also the helper's default model. The
titles and texts are Wikipedia's, under the Creative Commons
Attribution-ShareAlike 4.0 licence (CC BY-SA 4.0), not this package's licence;
the package's `NOTICE` file gives the source, the revision and the changes
made. If you publish the page with that data, the licence's terms apply to you
too. The generated set is at `index.html?sample=synthetic`.

### Search refusals

A search that cannot be made faithfully is refused with a code and a plain
message. The message is shown in the search panel, returned by the promise, and
passed to `onError`. A refused search changes nothing on screen.

| Code | Meaning | What a host should do |
|------|---------|-----------------------|
| `no-data` | There are no points to search yet. | Search after `update`. |
| `bad-search` | The list is not an array, or an entry is none of the forms above. | Fix the call. |
| `too-many-searches` | More than four entries. | Send at most four. |
| `empty-query` | The text has no letter or digit. | Nothing; the visitor typed no word. |
| `words-none` | No word matched a label or text among the loaded points. | Nothing; the message names the words. |
| `point-unknown` | No point has that id. | Check the id. |
| `no-embedder` | `via: "embed"` with no `embed` callback. | Supply the callback, or leave `via` out. |
| `embed-failed` | The `embed` callback threw or rejected. | Look at your own error. |
| `embed-timeout` | The `embed` callback did not answer in time. | Answer faster, or raise `searchTimeoutMs`. |
| `embed-malformed` | The answer is not an object with a `vector`. | Fix the callback. |
| `query-model-missing` | The answer has no `model`. | Return the model id. |
| `query-model-mismatch` | The query was embedded by another model than the data. | Embed queries with the model that made the data. |
| `query-not-vector` | The vector is not a list of numbers. | Fix the callback or the vector. |
| `query-dimension-mismatch` | The vector's length is not the data's dimension. | Use the same model and settings as the data. |
| `query-non-finite` | The vector holds NaN or an infinity. | Fix the callback or the vector. |
| `query-zero` | The vector is all zeros, so it has no direction. | Fix the callback or the vector. |
| `reduction-not-searchable` | The data file's vectors were rotated or cut after embedding, so a query vector cannot be compared with them. | Use a file with the vectors as the model made them; see below. |
| `superseded` | A newer call replaced this one. Not sent to `onError`. | Ignore it. |

Four more codes are notes on a search that still stands, in its `note`:
`rerank-failed`, `rerank-timeout` and `rerank-malformed` (the reranker threw,
was late, or did not return one score per candidate; the results stay in order
of distance) and `rerank-no-text` (a `vector` search with no `label` has no
text to send to a reranker).

### What search does not do

- **Reduced data files cannot be searched by embedding.** A data file may
  carry vectors that were rotated or cut to their strongest directions after
  embedding (the producer guide calls these reductions). A fresh query vector
  is not in that changed space, and the file does not carry what would be
  needed to change the query the same way. So on such a file an `embedded` or
  `vector` search is refused with `reduction-not-searchable`, and plain typed
  text falls back to matching words, with a note that says why. `words` and
  `point` searches work on every file, because their queries are made from the
  file's own vectors.
- **It is an exact scan, not an index.** Each search compares the query with
  every loaded point. It runs in small slices so the picture keeps moving. On
  a development machine, one search over 10,000 points of 1,024 dimensions
  took about 8 ms in all.
- **It does not answer questions.** It finds near points. There is no
  generated answer and no chat.
- **Only Chromium has been tested automatically**, as for the rest of the
  viewer.

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

Search adds one thing that can leave the page, and only if you supply the
callbacks. Text that a visitor types goes to your `embed` callback, and with
reranking on, the query text and the texts of the candidates go to your
`rerank` callback. Where they go from there is your code's decision; say so to
your visitors if it matters. The viewer itself states it beside the picture
whenever a search is shown: either that the text was sent to the host's
embedder, or that the search was made among the loaded points and nothing was
sent. With no callbacks, nothing a visitor types leaves the page.
