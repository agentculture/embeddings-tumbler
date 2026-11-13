# Data contract, schema version 1

This document is the contract between anything that produces embedding data
for `embeddings-tumbler` and the viewer that shows it. It fixes the on-disk
file form, the in-memory form that `update()` accepts, how a full replace and
an incremental append are expressed, and exactly what is refused and with
which message.

Status: **frozen for the first version.** A change that an existing reader
could misread needs a new schema version (see [Versioning](#versioning)).
Where an illustrative sketch (`docs/workforce/examples/`) disagrees with this
document, this document wins.

The words **must**, **must not** and **may** are used in their ordinary
strict sense. "The viewer" means the core file's loader and validator; the
loader, the viewer API, the web component and the standalone page all apply the
same rules.

The fixtures under `tests/fixtures/contract/` are worked examples of every rule
below. They are written by `scripts/gen_contract_fixtures.py` (standard
library only) and listed, with the expected outcome of each, in
`tests/fixtures/contract/index.json`.

## Overview

A data set is one embedding model's vectors for a list of points, plus what a
reader needs to judge them: where they came from, what was done to them, and
what is not known.

It has two parts:

1. **The record part:** one JSON object holding the version, the model id, the
   dimension, the item count, provenance, an optional reduction record, and
   one record per point (id, label, group, metadata).
2. **The vector block:** every vector as little-endian float32, row after row,
   with no header and no padding. Its length is exactly
   **count × dimension × 4 bytes**.

Vectors are never JSON numbers. At 1024 dimensions a JSON decimal encoding is
about 2.6 times the raw size and has to be parsed number by number; the binary
block is copied straight into a typed array.

There are two forms of the same data set:

| Form | Record part | Vector block | Used by |
|------|-------------|--------------|---------|
| File form | `<name>.json`, UTF-8 | `<name>.f32` beside it, named by `vectors.file` | producers, the standalone page, the web component's `src`, the Python CLI |
| In-memory form | a JavaScript object | `vectors` is a `Float32Array` or an `ArrayBuffer` | `update(data)` |

The loader turns the file form into the in-memory form; `update()` validates the
in-memory form with the same rules.

## The file form

### Decision: the vector block is a sibling file

The block lives in its own file next to the JSON file, not embedded in it.
Reasons: embedding it as base64 adds a third to its size and needs decoding;
a combined binary container needs a custom reader in every producer; two plain
files can be written by a few lines of any language's standard library, and
the block can be fetched straight into an `ArrayBuffer`.

Rules:

- `vectors.file` **must** be a plain file name: it matches
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`: it contains no folder separator (`/` or
  `\`), no colon and so no URL, and does not start with a dot. With no
  separator the whole name is a single path segment, and since it cannot start
  with a dot that segment can never be `.` or `..`, so the name cannot leave the
  folder. Dots inside the name (`a..b.f32`) are allowed. Anything else is
  refused with `vector-file-path` before any attempt to read it.
- If the named file cannot be fetched or read (it does not exist, the server
  answers with an HTTP error, or the read fails), the set is refused with
  `block-unreadable` and the view is left unchanged.
- The loader resolves `vectors.file` against the location of the JSON file
  (the same folder; for a URL, the same origin and path prefix). It never
  follows a name to another folder or origin.
- The `.f32` extension is a convention for producers, not a rule the viewer
  checks.
- Several JSON files **may** name the same block file.

### The JSON file

The JSON file is one UTF-8 JSON object. Fields not named in this document are
ignored by the viewer; producers must not rely on them being read, shown or
kept.

#### Types used in the tables

- **integer**: a JSON number with no fractional part and an absolute value of at
  most 2^53 − 1 (`9007199254740991`). `3.0` is accepted as `3`; `true` is not
  an integer.
- **number**: a finite JSON number.
- **string**: a JSON string. "non-empty string" means at least one character.
- **list of strings**: a JSON array whose every element is a string; may be
  empty.
- **object**: a JSON object (not an array, not `null`).

#### Top-level fields

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `schema_version` | integer | yes | The contract version this data was written under. Version 1 is this document. |
| `kind` | string, exactly `"embeddings-tumbler/data"` | yes | Marks the object as viewer data. |
| `op` | `"replace"` or `"append"` | no, default `"replace"` | Whether this set replaces what the view holds or is added to it. See [Replace and append](#replace-and-append). |
| `model` | non-empty string | yes | The embedding model id exactly as the producer used it, for example `Qwen/Qwen3-Embedding-0.6B`. One view shows one model. |
| `dimension` | integer ≥ 1 | yes | The number of float32 values per point **in the block**. With a `top-k` reduction this is the number of directions kept, not the model's native dimension. Nothing in the viewer assumes a particular value. |
| `count` | integer ≥ 0 | yes | The number of points; must equal the length of `points`. |
| `text_included` | boolean | yes | `true` if labels or metadata may carry corpus text; `false` for a labels-only set. See [Labels-only sets](#labels-only-sets). |
| `provenance` | object | yes for `replace`; optional for `append` | Where the vectors came from. See [Provenance](#provenance). |
| `reduction` | object | no; absent means `kind: "none"` | What was done to the vectors before export. See [Reduction record](#reduction-record). |
| `vectors` | object (file form) | yes | Describes the vector block. See [Vector block](#vector-block). |
| `points` | array of objects | yes | One record per point, in block row order. See [Point records](#point-records). |

#### Provenance

Mirrors the `embeddings-cli` Atlas manifest (`AtlasManifest`): a set that does
not say what it does not know is an assertion, not evidence, so `limitations`
and `uncertain` are required, as they are in an Atlas.

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `source` | non-empty string | yes | What the vectors are of, for example `atlas: docs/studies/atlas-plain` or `synthetic: built-in sample`. Shown on the page. |
| `producer` | non-empty string | yes | The tool and version that wrote the file, for example `embeddings-cli 0.9.0`. |
| `synthetic` | boolean | yes | `true` if the vectors were generated rather than produced by the named model. |
| `seed` | integer or `null` | yes (the key must be present) | The seed the source was produced under (an Atlas's survey seed); `null` when no seed applies. This is not the viewer's tour seed, which the viewer chooses and shows separately. |
| `limitations` | list of strings | yes | Known limitations, copied from the Atlas's `limitations`. `[]` is a deliberate claim that none are known. |
| `uncertain` | list of strings | yes | Interpretations the source is not confident in, copied from the Atlas's `uncertain`. `[]` is a deliberate claim. |
| `created` | string | no | When the file was written, as an RFC 3339 UTC timestamp, for example `2026-11-13T19:00:00Z`. The viewer shows it as text and does not parse it. |
| `endpoint` | non-empty string | no | A **name** for the route the vectors were embedded through, for example `lobes gateway`. It must not be a network address; see below. |
| `params` | object | no | Free measurement parameters (for example an Atlas's `params`). The viewer may show them as text and otherwise ignores them. |

**The endpoint is a name, not an address.** The viewer's rule is that the
embedding gateway's address and key never reach a page. An Atlas records the
endpoint as a URL; a producer copying it into a data file must replace the URL
with a name for the route (for example `lobes gateway`). The viewer refuses,
with `endpoint-is-address`, any `endpoint` that matches this pattern
(case-insensitive):

```text
://|localhost|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|:[0-9]+
```

That is: anything with a scheme separator, the word `localhost`, a dotted IPv4
address, or a colon followed by a port number.

#### Reduction record

Vectors may be rotated onto the data's own principal directions before export.
An exact rotation loses nothing. Keeping only the top k directions is an
approximation and must say how much variance it dropped.

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `kind` | `"none"`, `"rotation"` or `"top-k"` | yes | What was done. |
| `source_dimension` | integer ≥ 1 | yes | The model's native dimension before any reduction. |
| `directions_kept` | integer ≥ 1 | yes | How many directions the block holds. |
| `variance_dropped` | number, 0 to 1 inclusive | yes | The fraction of the set's total variance that is not in the kept directions. |

Consistency rules, all checked; a failure is `invalid-field` on `reduction`:

- Always: `directions_kept` = `dimension`.
- `none`: vectors are as the model produced them; `source_dimension` =
  `dimension` and `variance_dropped` = 0.
- `rotation`: vectors were multiplied by an orthogonal matrix (optionally after
  subtracting the set's mean), so all pairwise distances are unchanged;
  `source_dimension` = `dimension` and `variance_dropped` = 0.
- `top-k`: as `rotation`, then only the first `directions_kept` coordinates are
  kept; `dimension` < `source_dimension` and `variance_dropped` < 1.

For `rotation` and `top-k`, coordinate 0 is the direction of greatest variance
in the set the producer measured, coordinate 1 the next, and so on in
decreasing order. The viewer shows the kind, and for `top-k` the directions kept
and the variance dropped, and labels a `top-k` view an approximation of the
space.

#### Vector block

In the file form, `vectors` describes the sibling block file:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `file` | non-empty string, a plain file name | yes | The block file's name, resolved beside the JSON file. |
| `dtype` | string, exactly `"float32"` | yes | Value type. |
| `byte_order` | string, exactly `"little"` | yes | Byte order: little-endian. |
| `byte_length` | integer | yes | Must equal `count` × `dimension` × 4. |

The block itself:

- IEEE 754 binary32 (float32) values, **little-endian**, regardless of the
  producing machine.
- Row-major: point `i`'s value on coordinate `j` is at byte offset
  `(i × dimension + j) × 4`. Row `i` belongs to `points[i]`.
- No header, no footer, no padding, no compression. Its length is exactly
  **count × dimension × 4** bytes; any other length is refused with
  `block-length`. A set with `count` 0 has an empty block (0 bytes), and its
  block file must exist and be empty.
- Every value must be finite. NaN and ±Infinity are refused with `non-finite`.
- Vectors are not required to be normalised; the viewer does not assume they
  are.

#### Point records

Each element of `points`:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `id` | non-empty string | yes | Unique within the view. Used to match appends and to name a point in messages. |
| `label` | string, may be empty | yes | Short text shown for the point. In a labels-only set it carries no corpus text. |
| `group` | string | no, default `""` | A grouping name used for colour and for group-separation measures. `""` means ungrouped. |
| `metadata` | object | no, default `{}` | Free key/value pairs. Values may be any JSON. Shown as text only. |

**Untrusted text is text.** Every string from a data set (labels, groups,
metadata keys and values, ids, provenance strings, and the `{placeholders}` in
refusal messages) is inserted into the page as text, never as markup.
`valid-384.json` carries a label made of HTML tags to test this.

#### Labels-only sets

Vectors can leak the text they were made from, and labels often are that text.
A producer can leave the text out:

- `text_included` is `false`.
- No `label`, `group` or `metadata` value carries corpus text. The fixture
  convention, and the recommended producer behaviour, is `label` = `id` and no
  `metadata`.

The viewer cannot check that a string is not corpus text; `text_included` is the
producer's statement, and the viewer shows it in the provenance block.

### A minimal file

`example.json`:

```json
{
  "schema_version": 1,
  "kind": "embeddings-tumbler/data",
  "model": "Qwen/Qwen3-Embedding-0.6B",
  "dimension": 1024,
  "count": 2,
  "text_included": true,
  "provenance": {
    "source": "atlas: docs/studies/atlas-plain",
    "producer": "embeddings-cli 0.9.0",
    "synthetic": false,
    "seed": 0,
    "limitations": ["vectors were embedded live, not served from cache"],
    "uncertain": [],
    "endpoint": "lobes gateway"
  },
  "vectors": {
    "file": "example.f32",
    "dtype": "float32",
    "byte_order": "little",
    "byte_length": 8192
  },
  "points": [
    {"id": "v01-base", "label": "the gateway listens on port 8001", "group": "value"},
    {"id": "v01-para", "label": "the gateway runs on port 8001", "group": "value"}
  ]
}
```

`example.f32`: 2 × 1024 × 4 = 8192 bytes. In Python, with the standard library
only:

```python
import struct
block = b"".join(struct.pack(f"<{len(v)}f", *v) for v in vectors)
assert len(block) == count * dimension * 4
```

## The in-memory form

`update(data)` takes a plain JavaScript object with **the same fields and the
same rules as the JSON file**, except `vectors`:

| `vectors` is | Read as |
|--------------|---------|
| a `Float32Array` | values in the array's order; its `length` must be `count` × `dimension` (its `byteLength` must be `count` × `dimension` × 4). Endianness does not arise: these are values, not bytes. |
| an `ArrayBuffer` | raw bytes of the block, interpreted as **little-endian** float32 whatever the platform's byte order; its `byteLength` must be `count` × `dimension` × 4. |
| anything else (including the file form's descriptor object) | refused with `invalid-field` on `vectors`. |

In the in-memory form there is no `file`, `dtype`, `byte_order` or
`byte_length`, so `vector-file-path`, `block-unreadable` and the `vectors.*`
field checks do not apply. A `Float32Array` that is a view into a larger buffer is read from its own
offset and length only.

The loader turns a file pair into this form: it validates the JSON part,
fetches the block named by `vectors.file` into an `ArrayBuffer`, and puts that
`ArrayBuffer` in `vectors`. A host that builds data in the page passes the
in-memory form to `update()` directly.

The viewer does not keep a reference to the host's object or array after
`update()` returns; it copies what it needs. A host may reuse or change its
buffers afterwards.

## Replace and append

`op` says how a set combines with what the view already holds.

### `replace` (the default)

- The set becomes the whole view. Whatever the view held before is discarded,
  including a different model or dimension.
- `provenance` is required.
- A `replace` with `count` 0 is valid: an empty view (for example a
  conversation that has not started).
- The viewer may reset the camera on a replace.

### `append`

An append adds points to the set the view holds, without resetting the camera
or dropping existing points. It is how a live source (a conversation) adds
points as they arrive.

- It has every required field of a set **except** `provenance`, which is
  optional. If `provenance` is present it must be valid, but the view keeps
  showing the base set's provenance (with the new item count). An append cannot
  change a view's source, producer, seed, limitations or uncertainty.
- It is refused unless the view already holds a set (`append-without-base`).
- Its `model` must equal the view's model (`model-mismatch`), its `dimension`
  must equal the view's dimension (`dimension-mismatch`), and its reduction kind
  (absent means `none`) must equal the view's reduction kind
  (`reduction-mismatch`). The viewer can only compare the kind; a producer that
  rotated the base set must apply the **same** rotation and the same mean to
  appended vectors, or their coordinates mean something else.
- Its ids must be new: an id already in the view is refused (`id-exists`).
  There is no update-in-place of an existing point in version 1.
- On success the new points follow the existing ones, in the append's order;
  existing points keep their ids, order and vectors. The view's count is the
  sum. Its `text_included` is `true` if either the view or the append says
  `true` (logical OR), and `false` only when both say `false`: a view that
  holds any corpus text never claims to be labels-only. The view's model, dimension, reduction record and provenance
  are those of the base set.
- An append with `count` 0 is valid and changes nothing.
- A refused append leaves the view exactly as it was.

**In a file**, an append is a file pair whose JSON has `"op": "append"`; a
sequence of append files can be applied in order after a full set. The
standalone page and the web component load one file, so an append file given
to them alone is refused with `append-without-base`.

**Through `update()`**, an append is an in-memory object with
`op: "append"`; `update()` applies it to the set the viewer holds. A host
streaming a conversation calls `update()` once with a `replace` (possibly
empty) and then once per batch of new points with an `append`.

## Refusals

The viewer refuses a set it cannot show faithfully instead of drawing a best
guess. A refusal:

- does not throw into the host; it is returned by the loader and shown by the
  viewer as a plain message inside its element;
- leaves the data the view holds unchanged (for a refused `replace` too: the
  previous set, or nothing, is kept, and the message is shown);
- reports **one** code and message: the first failure in the check order below.

### Check order

Checks run in this order; the first failure is the refusal.

1. The value is an object whose `kind` is exactly `"embeddings-tumbler/data"`
   → otherwise `wrong-kind`.
2. `schema_version` is an integer in the supported list (version 1 only)
   → otherwise `schema-version`.
3. Every field in the tables above has its stated type and value, checked in
   this order: `op`, `model`, `dimension`, `count`, `text_included`,
   `provenance` (if required or present) and its fields in table order,
   `reduction` (if present) and its fields in table order, then its
   consistency rules, `vectors` and its fields in table order (in the file form
   this includes `byte_length` = `count` × `dimension` × 4), then `points` and
   each point's fields in table order → otherwise `invalid-field`, naming the
   first offending field.
4. File form only: `vectors.file` is a plain file name → otherwise
   `vector-file-path`. The block is not read.
5. `provenance.endpoint`, if present, is not a network address → otherwise
   `endpoint-is-address`.
6. `count` equals the length of `points` → otherwise `count-mismatch`.
7. Every `id` in `points` is unique within the set → otherwise `duplicate-id`
   (naming the first repeated id).
8. File form only: the block file named by `vectors.file` can be fetched and
   read in full → otherwise `block-unreadable` (a missing file, an HTTP error
   status, or a failed read). The view is left unchanged. A loader may start
   fetching the block earlier, but it reports this code only if checks 1 to 7
   all passed.
9. The block's actual length is `count` × `dimension` × 4 bytes → otherwise
   `block-length`.
10. Every value in the block is finite → otherwise `non-finite` (naming the
    first point whose row has a non-finite value).
11. For an append, in this order: the view holds a set
    (`append-without-base`), the models are equal (`model-mismatch`), the
    dimensions are equal (`dimension-mismatch`), the reduction kinds are equal
    (`reduction-mismatch`), every id is new (`id-exists`, naming the first id
    already in the view).

Field paths in `invalid-field` messages use dots for object fields and
`[n]` for array positions, counting from 0: `model`, `provenance.limitations`,
`reduction.kind`, `reduction`, `vectors.byte_length`, `points[3].id`. A
problem inside a list of strings names the list (`provenance.limitations`). A
point that is not an object is named `points[n]`.

### Codes and messages

Codes are stable identifiers for tests and hosts. Messages are the plain text
shown to the person, with each `{placeholder}` replaced by the value described
(numbers in decimal, strings as they are, without added quotes). Hosts and
tests may match on the code; the message text is also fixed for version 1.

| Code | When | Message template |
|------|------|------------------|
| `wrong-kind` | Not an object, or `kind` is missing or different. | `Not an embeddings-tumbler data set: "kind" must be "embeddings-tumbler/data".` |
| `schema-version` | `schema_version` is missing, not an integer, or not supported (unknown or newer). | `Data schema version {found} is not supported; this viewer reads schema version {supported}.` |
| `invalid-field` | A field is missing, has the wrong type, or breaks a value rule. | `Field "{field}" is missing or not valid.` |
| `vector-file-path` | `vectors.file` is not a plain file name. | `Vector file "{file}" must be a plain file name in the same folder as the data file.` |
| `endpoint-is-address` | `provenance.endpoint` looks like a network address. | `"provenance.endpoint" must name the embedding route, not give a network address.` |
| `count-mismatch` | `count` differs from the number of point records. | `"count" is {count} but the data has {found} point records.` |
| `duplicate-id` | An id appears twice in one set. | `Point id "{id}" appears more than once.` |
| `block-unreadable` | File form: the block file cannot be fetched or read. | `Vector file "{file}" could not be read.` |
| `block-length` | The vector block's actual length is wrong. | `Vector block is {found} bytes; expected {count} points x {dimension} dimensions x 4 bytes = {expected} bytes.` |
| `non-finite` | A vector holds NaN or ±Infinity. | `Vector of point "{id}" contains a value that is not a finite number.` |
| `append-without-base` | An append arrives when the view holds no set. | `Cannot append: the view holds no data set yet. Send a full set first.` |
| `model-mismatch` | An append's model differs from the view's. | `Cannot append: model "{found}" differs from the view's model "{expected}". One view shows one model.` |
| `dimension-mismatch` | An append's dimension differs from the view's. | `Cannot append: dimension {found} differs from the view's dimension {expected}.` |
| `reduction-mismatch` | An append's reduction kind differs from the view's. | `Cannot append: reduction "{found}" differs from the view's reduction "{expected}".` |
| `id-exists` | An append reuses an id the view already holds. | `Cannot append: point id "{id}" is already in the view.` |

Placeholder values:

- `schema-version`: `{found}` is the value written as JSON text (`2`, `"1"`,
  `null`), or the word `missing` if the key is absent; `{supported}` is the
  supported versions in increasing order, separated by a comma and a space
  (in this version, `1`).
- `invalid-field`: `{field}` is the field path described above.
- `count-mismatch`: `{count}` is the `count` field; `{found}` the number of
  point records.
- `block-length`: `{found}` is the block's actual length in bytes (an
  `ArrayBuffer`'s or `Float32Array`'s `byteLength`); `{expected}` is
  `count` × `dimension` × 4.
- `model-mismatch`, `dimension-mismatch`, `reduction-mismatch`: `{found}` is the
  append's value, `{expected}` the view's.

**Mixed dimension and mixed model.** Because `model` and `dimension` are set
once per set, a single set cannot mix them: a vector of another length shows up
as `block-length`. Mixing happens when an append meets a view, and is refused
there with `dimension-mismatch` or `model-mismatch`. A `replace` may change
model and dimension, because it discards the previous set.

## Versioning

- This document is schema version **1**. The viewer supports exactly the
  versions it lists; version 1 viewers support `[1]`.
- A data set with any other `schema_version` (newer, older-unknown, missing, or
  not an integer) is refused with `schema-version`, naming the version found and
  the versions supported. The viewer never draws a best-effort guess.
- Adding an optional field that a version 1 viewer may safely ignore does not
  need a new version. Any change that a version 1 viewer would misread
  (a new required field, a changed meaning, a different block encoding, a new
  `op`, a new reduction `kind`) needs version 2.
- The core file states its own version and source at the top, so a vendored
  copy can be traced to the contract versions it supports.

## Fixtures

`tests/fixtures/contract/index.json` lists every case. Each case says which
file to apply (`file`), which valid set to load first as a full set (`base`,
`null` for an empty view), and either the expected view (`expect`: ids in
order, count, model, dimension, reduction kind, `text_included`) or the
expected refusal (`refusal`: `code` and exact `message`). It also carries the
message templates (`messages`). The JavaScript loader's tests should be driven
from it.

| Case | Outcome | What it exercises |
|------|---------|-------------------|
| `valid-384` | accepted | 384-d, no reduction record, groups, metadata, an empty label, an ungrouped point, Unicode, a label made of HTML tags |
| `valid-1024` | accepted | 1024-d, `rotation` reduction, non-empty `limitations` and `uncertain`, an `endpoint` name, `params` |
| `labels-only` | accepted | `text_included: false`, labels equal ids, explicit `none` reduction, `seed: null` |
| `top-k-16` | accepted | `top-k` reduction: 16 of 1024 directions, 0.42 of the variance dropped |
| `empty-set` | accepted | `count` 0 and an empty block |
| `append-onto-384` | accepted | an append onto `valid-384`; existing ids keep their order |
| `labels-only-append-onto-text` | accepted | a labels-only append onto the text-bearing `valid-384`; the view's `text_included` stays `true` |
| `append-without-base` | `append-without-base` | the same append with no base |
| `bumped-version` | `schema-version` | `schema_version` 2 |
| `wrong-block-length` | `block-length` | a block 4 bytes short |
| `mixed-dimension` | `dimension-mismatch` | a 768-d append onto the 384-d set |
| `second-model` | `model-mismatch` | an append from another model id |
| `reduction-mismatch` | `reduction-mismatch` | a rotated append onto an unrotated set |
| `id-exists` | `id-exists` | an append reusing an id |
| `duplicate-id` | `duplicate-id` | one set with a repeated id |
| `count-mismatch` | `count-mismatch` | `count` 6 with 5 records |
| `block-unreadable` | `block-unreadable` | `vectors.file` names `no-such-block.f32`, which does not exist |
| `non-finite` | `non-finite` | a NaN in one row |
| `endpoint-address` | `endpoint-is-address` | a URL in `provenance.endpoint` |
| `wrong-kind` | `wrong-kind` | another tool's `kind` |
| `vector-file-path` | `vector-file-path` | `vectors.file` = `../valid-384.f32` |
| `missing-limitations` | `invalid-field` | `provenance.limitations` absent |
| `byte-length-declared` | `invalid-field` | `vectors.byte_length` 4 more than `count` × `dimension` × 4 |

Each refused fixture has exactly one fault; `tests/test_data_contract.py`
checks this with a reference validator written from this document. Refused
fixtures that are copies of `valid-384` share its block file. Regenerate with
`python3 scripts/gen_contract_fixtures.py`; a test checks that regenerating
gives byte-identical files.

## Mapping from an Atlas (for producers)

An `embeddings-cli` Atlas directory (`atlas.json`, `records.jsonl`,
`vectors.npy`) maps as follows:

| Atlas | Data set |
|-------|----------|
| `atlas.json` `model` | `model` |
| vector width | `dimension` (after any reduction) |
| number of records | `count` |
| `atlas.json` `seed` | `provenance.seed` |
| `atlas.json` `limitations`, `uncertain` | `provenance.limitations`, `provenance.uncertain` (copied, never dropped) |
| `atlas.json` `params` | `provenance.params` |
| `atlas.json` `endpoint` | `provenance.endpoint` as a **name** for the route, never the URL |
| record `id` | point `id` |
| record `text` | point `label` (or the id, in a labels-only set) |
| record `metadata` | point `metadata` (left out in a labels-only set) |
| `vectors.npy` row `vector_index` | block row with the point's position in `points` |

The `.npy` file's dtype and byte order are the producer's to convert; the block
is always little-endian float32.
