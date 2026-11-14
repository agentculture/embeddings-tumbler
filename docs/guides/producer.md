# Writing a data file for embeddings-tumbler: the producer guide

This guide is for you if you have embedding vectors (from any model, a vector
store, a notebook, a script) and want to look at them in the
`embeddings-tumbler` viewer. You write a **data file**: two plain files that
sit side by side. You do not need to read any other document or any code to do
it. Everything the viewer checks is written down here.

The authoritative statement of the format is
[`docs/data-contract.md`](../data-contract.md) (schema version 1). This guide
restates it so you can work from one page. If the two ever disagree, the
contract wins, and a test in this repository keeps the field list and the
refusal list below in step with it.

If you want to put the viewer on a web page instead, read the
[host guide](host.md).

## The short version

A data file is a pair of files in one folder:

- `NAME.json`: UTF-8 JSON. The model id, the dimension, the count, where the
  vectors came from, and one record (id, label, optional group and metadata)
  for each point.
- `NAME.f32`: the vectors. Every number as a little-endian 32-bit float, one
  point after another, with nothing else in the file.

The viewer reads the JSON, then fetches the `.f32` file named inside it. If
anything is wrong it refuses the whole file with a plain message. It never
draws a best guess.

Why two files, and why the vectors are not JSON numbers: at 1024 dimensions,
writing the numbers as JSON text takes about 2.6 times the space of the raw
numbers and has to be parsed number by number, while the binary block is copied
straight into memory. A set of 311 points at 1024 dimensions is 1.27 MB as raw
float32 and about 3.3 MB as JSON numbers. Two plain files can be written with
the standard library of any language, which is why there is no custom
container.

## What a data file carries, and how to leave text out

**A data file carries two things that can be sensitive: the text you attach to
each point, and the vectors.**

- The `label` of each point, its `group` and its `metadata` are written into the
  JSON file exactly as you give them. If a label is the sentence you embedded,
  the sentence is in the file.
- The vectors are in the `.f32` file. Anyone who can load the viewer page can
  fetch both files and read both. The viewer never hides them; it only shows
  them.
- **Vectors can leak information about the text they were made from, even when
  you leave every label out.** An embedding is built to preserve meaning, and
  there are published methods that recover much of a text from its embedding.
  Treat a vector file as being as sensitive as the text it came from.

If you do not want text in the file, leave it out:

1. Set `"text_included": false` at the top of the JSON. This is your statement
   that no label, group or metadata value carries the corpus text. The viewer
   shows it in the provenance block ("point ids only: this data carries no
   corpus text").
2. Make every `label` equal to its `id`, and give a `group` only if the group
   name is not itself text from the corpus.
3. Write no `metadata`.

`provenance.source`, `limitations` and `uncertain` are descriptions of your
data, not corpus text, so they stay. A labels-only picture has no point names
drawn on it (a label equal to the id is not drawn), so it can show shape and
groups but cannot name individual points.

The viewer cannot check any of this: it cannot tell whether a string is corpus
text. `text_included` is your claim, so make it true. (When the viewer appends
a set onto another, `text_included` becomes true if either side is true, so one
text-bearing set makes the whole view "includes text".)

If you export from `embeddings-cli` (the sibling project that measures
embedding spaces; its `embeddings export` command is planned and not merged
yet), `embeddings export --labels-only` does steps 1 to 3 for you.

Leaving text out does not make the vectors safe to publish. It only stops the
file from carrying the text directly.

## The JSON file, field by field

The JSON file is one UTF-8 object. The words **must** and **may** are meant
strictly. Fields not named in this guide are ignored by the viewer; do not rely
on them being read, shown or kept.

Types used below:

- **integer**: a JSON number with no fractional part and an absolute value of at
  most 9007199254740991. `3.0` is accepted as `3`. `true` and `false` are not
  integers.
- **number**: a finite JSON number.
- **string**: a JSON string. "Non-empty string" means at least one character.
- **list of strings**: a JSON array whose every element is a string. It may be
  empty.
- **object**: a JSON object (not an array, not `null`).

### Top-level fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `schema_version` | integer | yes | The contract version this data was written under. Write `1`. |
| `kind` | string, exactly `"embeddings-tumbler/data"` | yes | Marks the object as viewer data. |
| `op` | `"replace"` or `"append"` | no, default `"replace"` | Whether this set replaces what the view holds or is added to it. See [Replace and append files](#replace-and-append-files). |
| `model` | non-empty string | yes | The embedding model id exactly as you used it, for example `Qwen/Qwen3-Embedding-0.6B`. One view shows one model. |
| `dimension` | integer ≥ 1 | yes | The number of float32 values per point in the `.f32` file. With a top-k reduction this is the number of directions kept, not the model's native dimension. |
| `count` | integer ≥ 0 | yes | The number of points. It must equal the length of `points`. |
| `text_included` | boolean | yes | `true` if labels or metadata may carry corpus text; `false` for a labels-only set. |
| `provenance` | object | yes for `replace`; optional for `append` | Where the vectors came from. See [Provenance](#provenance). |
| `reduction` | object | no; absent means no reduction | What was done to the vectors before export. See [Reduction record](#reduction-record). |
| `vectors` | object | yes | Describes the `.f32` file. See [Vector block](#vector-block). |
| `points` | array of objects | yes | One record per point, in the same order as the rows of the `.f32` file. See [Point records](#point-records). |

### Provenance

A set that does not say what it does not know is an assertion, not evidence.
That is why `limitations` and `uncertain` are required, even when empty.

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `source` | non-empty string | yes | What the vectors are of, for example `product reviews, 2026 sample`. Shown on the page. |
| `producer` | non-empty string | yes | The tool and version that wrote the file, for example `my-exporter 0.1.0`. |
| `synthetic` | boolean | yes | `true` if the vectors were generated rather than produced by the named model. |
| `seed` | integer or `null` | yes (the key must be present) | The seed your source was produced under, for example the random seed of a sampling step. Write `null` when no seed applies. This is not the viewer's own tour seed, which the viewer chooses and shows separately. |
| `limitations` | list of strings | yes | Known limitations of the data. `[]` is a deliberate claim that none are known. |
| `uncertain` | list of strings | yes | Interpretations you are not confident in. `[]` is a deliberate claim. |
| `created` | string | no | When the file was written, as an RFC 3339 UTC timestamp, for example `2026-11-13T19:00:00Z`. Shown as text; not parsed. |
| `endpoint` | non-empty string | no | A **name** for the route the vectors were embedded through, for example `lobes gateway`. See the rule below. |
| `params` | object | no | Free measurement parameters. May be shown as text; otherwise ignored. |

**`endpoint` is a name, never an address.** Embedding gateways have addresses
and keys, and they must never reach a web page or a data file that a page can
load. So the viewer accepts only a short descriptive name for the route:

```text
^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$
```

That is ASCII letters, digits, spaces, underscores and hyphens only, 1 to 64
characters, starting with a letter or digit. There are no dots, colons or
slashes, so a URL, a dotted host name, an IP address and a `name:port` are all
refused with `endpoint-is-address`. If you have an address, replace it with a
name such as `lobes gateway` or `local ollama`. If you do not want to say, leave
`endpoint` out. A value that is not a string, or is empty, is refused as an
invalid field instead. Two limits: a single-word name such as `gateway` cannot
be told from a one-label host name and is accepted; and names are ASCII only.

Never put an API key, token or password anywhere in a data file. `params` is
shown as text, so do not put one there either.

### Reduction record

Optional. Without it, the vectors are taken to be as the model produced them.

Vectors may be rotated onto the data's own principal directions before export.
An exact rotation loses nothing. Keeping only the top k directions is an
approximation, and the record must say how much variance it dropped.

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `kind` | `"none"`, `"rotation"` or `"top-k"` | yes | What was done. |
| `source_dimension` | integer ≥ 1 | yes | The model's native dimension before any reduction. |
| `directions_kept` | integer ≥ 1 | yes | How many directions the block holds. |
| `variance_dropped` | number, 0 to 1 inclusive | yes | The fraction of the set's total variance that is not in the kept directions. |

Consistency rules, all checked. A failure is refused as an invalid
`reduction` field:

- Always: `directions_kept` equals the top-level `dimension`.
- `none`: the vectors are as the model produced them. `source_dimension` equals
  `dimension`, and `variance_dropped` is 0.
- `rotation`: the vectors were multiplied by an orthogonal matrix (optionally
  after subtracting the set's mean), so all distances between points are
  unchanged. `source_dimension` equals `dimension`, and `variance_dropped` is 0.
- `top-k`: as `rotation`, then only the first `directions_kept` coordinates are
  kept. `dimension` is smaller than `source_dimension`, and `variance_dropped` is
  below 1.

For `rotation` and `top-k`, coordinate 0 must be the direction of greatest
variance in your set, coordinate 1 the next, and so on in decreasing order.

What each costs in honesty:

- **No reduction record** (or `none`): nothing to explain. This is the right
  default. The viewer finds its own strongest directions.
- **`rotation`**: exact. You gain nothing visible; the viewer already finds
  principal directions itself. Use it only if your pipeline already rotates.
- **`top-k`**: smaller files (k instead of the full dimension), but the picture
  is of an approximation. The viewer shows the directions kept and the variance
  dropped, and labels the view "an approximation of the space". Report
  `variance_dropped` truthfully (the share of total variance in the discarded
  coordinates). Distances in the kept space are not distances in the real
  space.

### Vector block

`vectors` describes the `.f32` file:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `file` | non-empty string, a plain file name | yes | The name of the `.f32` file, which sits beside the JSON file. |
| `dtype` | string, exactly `"float32"` | yes | Value type. |
| `byte_order` | string, exactly `"little"` | yes | Byte order: little-endian. |
| `byte_length` | integer | yes | Must equal `count` × `dimension` × 4. |

`vectors.file` must be a plain file name matching
`^[A-Za-z0-9][A-Za-z0-9._-]*$`: no folder separator (`/` or `\`), no colon (so no
URL), and it must not start with a dot. Dots inside the name are fine. The
reason is that the viewer may be loading your file from the web, and a name must
never be able to point outside the folder or to another site. The `.f32`
extension is a habit, not a rule. Several JSON files may name the same `.f32`
file.

The `.f32` file itself:

- IEEE 754 binary32 (float32) values, **little-endian**, whatever machine wrote
  them.
- Row-major: the value of point `i` on coordinate `j` is at byte offset
  `(i × dimension + j) × 4`. Row `i` belongs to `points[i]`.
- No header, no footer, no padding, no compression.
- Its length is exactly **count × dimension × 4** bytes. Any other length is
  refused. With `count` 0 the file must still exist and be empty.
- Every value must be finite. NaN and infinities are refused.
- The vectors do not need to be unit length.

Writing it with only the Python standard library:

```python
import struct

block = b"".join(struct.pack(f"<{len(v)}f", *v) for v in vectors)
assert len(block) == count * dimension * 4
```

Values are rounded to float32 when packed. A number too large for float32
makes `struct.pack` raise an error (in other languages it silently becomes an
infinity, which the viewer refuses), so check that every value is finite after
packing. The `<` is what makes it little-endian on every machine. With NumPy,
`np.asarray(vectors, dtype="<f4").tofile(path)` does the same.

When you write the JSON, write real UTF-8 and refuse NaN: in Python,
`json.dumps(obj, allow_nan=False, ensure_ascii=False)` written with
`encoding="utf-8"`. A `NaN` or `Infinity` in a JSON file is not valid JSON.

### Point records

Each element of `points`:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `id` | non-empty string | yes | Unique within the view. Used to match appends and to name a point in messages. |
| `label` | string, may be empty | yes | Short text shown for the point. In a labels-only set it carries no corpus text. |
| `group` | string | no, default `""` | A grouping name, used for colour. `""` means ungrouped. |
| `metadata` | object | no, default `{}` | Free key/value pairs. Values may be any JSON. Shown as text only. |

Notes:

- Row `i` of the `.f32` file belongs to `points[i]`. Keep them in the same
  order.
- Every string from your file is shown as text, never as markup. A label such as
  `<b>hi</b>` appears as those characters, so you do not need to escape
  anything.
- Labels longer than 40 characters are cut when drawn. A point whose label is
  empty or equal to its id is drawn without a label. Give a point a short label
  only if you want it named in the picture; with thousands of points, label a
  few hundred at most.
- A `group` colours the points. Groups are coloured in the order they first
  appear in the file; keep the number of groups modest (a dozen or two) so the
  colours stay distinguishable.

### A complete minimal file

Two points, four dimensions. This file and its `.f32` are shipped in this
repository and tested against the loader, so this is a file the viewer accepts.

<!-- file: examples/producer/minimal.json -->

```json
{
  "schema_version": 1,
  "kind": "embeddings-tumbler/data",
  "model": "example/tiny-model",
  "dimension": 4,
  "count": 2,
  "text_included": true,
  "provenance": {
    "source": "two example sentences typed by hand",
    "producer": "my-exporter 0.1.0",
    "synthetic": true,
    "seed": null,
    "limitations": ["the vectors are made up, not produced by the named model"],
    "uncertain": []
  },
  "vectors": {
    "file": "minimal.f32",
    "dtype": "float32",
    "byte_order": "little",
    "byte_length": 32
  },
  "points": [
    {"id": "a", "label": "the cat sat on the mat", "group": "animals"},
    {"id": "b", "label": "interest rates rose again", "group": "money"}
  ]
}
```

The `.f32` file next to it is 2 × 4 × 4 = 32 bytes.

## Choices you make

### The model id

`model` is a string you choose. Use the id the model is known by, exactly as you
used it: `Qwen/Qwen3-Embedding-0.6B`, `text-embedding-3-small`,
`all-MiniLM-L6-v2`. It is shown on the page and it is how the viewer tells
whether an append belongs to the same view, so do not change the spelling
between files that belong together. For made-up vectors write a name that cannot
be mistaken for a real model (`synthetic/my-test-set`) and set
`provenance.synthetic` to `true`.

### One model and one dimension per file

A file holds one model's vectors at one dimension. Vectors from two models, or
of two lengths, are never comparable, so they cannot share a file or a view. If
you have two models, write two files. (The viewer will refuse a mix: a row of
the wrong length makes the block the wrong length; an append of another model or
dimension is refused.) Nothing in the viewer assumes a particular dimension:
384, 768, 1024 and 2560 have all been seen, and the format accepts any
dimension of 1 or more, but the viewer's views need at least 3 (the Lattice
view needs at least 4). A file with `count` 0 still needs a `dimension` of at
least 1, which you must supply since there are no vectors to measure.

### Where the seed comes from

`provenance.seed` is the seed of whatever produced your data: a random seed used
when sampling the texts, shuffling, or generating synthetic vectors. If you used
no randomness, write `null`. It is a record for the reader; the viewer does not
use it. The seed that makes a *view* reproducible is the viewer's own (a `seed`
option or URL parameter), shown on the page as "Seed (view)".

### `limitations` and `uncertain`

Write down what a reader needs to judge the picture. `limitations` are known
weaknesses of the data ("only English texts", "300 of 40,000 documents, taken
from the front of the file", "vectors came from a cache"). `uncertain` lists
readings you are not sure about ("the cluster labelled `finance` may be mostly
one source"). Empty lists are allowed but are a claim that you know of none, so
only write them when that is true.

### How big a file gets

The `.f32` file is points × dimension × 4 bytes. The JSON adds a record per
point (roughly the length of your labels plus 60 to 100 bytes).

| Points | Dimension | `.f32` size |
|--------|-----------|-------------|
| 311 | 1024 | 1.27 MB |
| 1,000 | 768 | 3.1 MB |
| 10,000 | 1024 | 41 MB |
| 10,000 | 2560 | 102 MB |

The same 311 × 1024 set as JSON numbers would be about 3.3 MB. The viewer holds
the vectors in memory (twice: once for the page, once on the graphics card),
so very large sets are limited by memory more than by anything in the format.
Thousands of points is comfortable; tens of thousands has been measured on a
desktop and is the practical edge today (see the host guide for what has and has
not been measured).

## Replace and append files

`op` says how a file combines with what the view already holds.

- **`"replace"`** (the default): the file becomes the whole view. Whatever was
  shown before is discarded. `provenance` is required. A replace with `count` 0
  is valid and shows an empty view.
- **`"append"`**: the file adds points to the view without resetting the
  camera. It is how a live source (a conversation) adds points as they arrive.
  It has every required field of a set **except** `provenance`, which is
  optional (if present it must be valid, but the view keeps the base set's
  provenance).

An append is refused unless all of these hold:

- the view already holds a set (otherwise `append-without-base`);
- its `model` equals the view's model, character for character
  (`model-mismatch`);
- its `dimension` equals the view's (`dimension-mismatch`);
- its reduction kind equals the view's, with no record counting as `none`
  (`reduction-mismatch`). The viewer can only compare the kind. If you rotated
  the base set, you must apply the **same** rotation and the same mean to the
  appended vectors, or their coordinates mean something else and nothing will
  tell you;
- every id is new (`id-exists`). There is no way in this version to change an
  existing point.

The standalone page and the web component each load a single file, so an append
file given to them on its own is refused with `append-without-base`. Appends are
normally applied by a host page calling the viewer from script (see the host
guide), which passes the same fields with the vectors as an in-memory array.

## What the viewer refuses, and why

The viewer refuses a file it cannot show faithfully instead of drawing a best
guess. It reports **one** problem: the first it finds, checking in the order
below. A refused `replace` leaves what was on screen as it was.

1. Not an object with `kind` equal to `"embeddings-tumbler/data"`:
   `wrong-kind`. (A file that cannot be fetched, or is not valid JSON, is also
   reported as `wrong-kind`.)
2. `schema_version` not 1: `schema-version`. A newer or unknown version is never
   guessed at.
3. Any field in the tables above missing, of the wrong type, or breaking its
   value rule, checked in table order: `invalid-field`, naming the first
   offender by path (`model`, `provenance.limitations`, `reduction.kind`,
   `vectors.byte_length`, `points[3].id`).
4. `vectors.file` not a plain file name: `vector-file-path`.
5. `provenance.endpoint` present but not a route name: `endpoint-is-address`.
6. `count` differing from the number of points: `count-mismatch`.
7. A repeated id: `duplicate-id`.
8. The `.f32` file missing or unreadable: `block-unreadable`.
9. The `.f32` file the wrong length: `block-length`.
10. A NaN or infinity in the vectors: `non-finite`.
11. For an append, the checks listed above: `append-without-base`,
    `model-mismatch`, `dimension-mismatch`, `reduction-mismatch`, `id-exists`.

| Code | When | What to do |
|------|------|------------|
| `wrong-kind` | Not an object, `kind` missing or different, or the file could not be fetched or parsed. | Set `kind` to `"embeddings-tumbler/data"`; check the file is valid JSON and is reachable at the address you gave. |
| `schema-version` | `schema_version` is missing, not an integer, or not 1. | Write `"schema_version": 1`. |
| `invalid-field` | A field is missing, has the wrong type, or breaks a value rule. The message names the field. | Fix the field named; compare with the tables above. |
| `vector-file-path` | `vectors.file` is not a plain file name. | Use a bare file name in the same folder, such as `set.f32`. |
| `endpoint-is-address` | `provenance.endpoint` does not match the route-name pattern. | Replace any address with a name, or leave `endpoint` out. |
| `count-mismatch` | `count` differs from the number of point records. | Make `count` equal the length of `points`. |
| `duplicate-id` | An id appears twice in one set. | Make ids unique. |
| `block-unreadable` | The `.f32` file could not be fetched or read. | Put it next to the JSON file, with the name in `vectors.file`. |
| `block-length` | The `.f32` file is not count × dimension × 4 bytes. | Check `count`, `dimension`, that every vector has `dimension` values, and that nothing but values is in the file. |
| `non-finite` | A vector holds NaN or an infinity. | Remove or fix the point. |
| `append-without-base` | An append arrives when the view holds no set. | Load a full set first. |
| `model-mismatch` | An append's model differs from the view's. | Use the identical `model` string, or write a separate file. |
| `dimension-mismatch` | An append's dimension differs from the view's. | Appends must have the view's dimension. |
| `reduction-mismatch` | An append's reduction kind differs from the view's. | Use the same reduction kind, with the same rotation. |
| `id-exists` | An append reuses an id the view already holds. | Give new points new ids. |

The messages shown to a person are plain text with the offending value filled
in (for example `Vector block is 1000 bytes; expected 311 points x 1024
dimensions x 4 bytes = 1273856 bytes.`). The exact message templates are in the
contract.

## Checking your file

Put the two files in a folder, write the viewer files beside them with
`embeddings-tumbler viewer write <folder> --apply`, serve the folder with
`embeddings-tumbler viewer serve <folder>`, and open
`http://127.0.0.1:8000/index.html?data=NAME.json`. If the file is wrong, the page
shows the refusal message instead of a picture. The
[host guide](host.md) describes these commands.

A short checklist before you look:

- `count` equals `len(points)`, and the `.f32` file is exactly
  `count × dimension × 4` bytes.
- `byte_length` says the same number.
- Every vector has exactly `dimension` values and all are finite.
- Ids are strings and unique.
- `provenance` has `source`, `producer`, `synthetic`, `seed` (even if `null`),
  `limitations` and `uncertain`.
- `endpoint`, if present, is a name, not an address.
- `text_included` tells the truth.

## The existing producer

`embeddings export` in
[`agentculture/embeddings-cli`](https://github.com/agentculture/embeddings-cli)
(planned; not merged yet) writes this format from an `embeddings-cli` Atlas, the
directory that tool produces with `atlas.json`, `records.jsonl` and
`vectors.npy`. This is how an Atlas maps onto a data file, for anyone writing
their own converter:

| Atlas | Data file |
|-------|-----------|
| `atlas.json` `model` | `model` |
| vector width | `dimension` (after any reduction) |
| number of records | `count` |
| `atlas.json` `seed` | `provenance.seed` |
| `atlas.json` `limitations`, `uncertain` | `provenance.limitations`, `provenance.uncertain` (copied, never dropped) |
| `atlas.json` `params` | `provenance.params` |
| `atlas.json` `endpoint` | `provenance.endpoint`, as a **name** for the route, never the URL |
| record `id` | point `id` |
| record `text` | point `label` (or the id, in a labels-only set) |
| record `metadata` | point `metadata` (left out in a labels-only set) |
| `vectors.npy` row `vector_index` | the row with the point's position in `points` |

You do not need that tool. Any program that writes the two files described here
produces a valid data file.
