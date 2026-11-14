# 20-contract.js: data contract loader and validator

Namespace `ET.contract` (reach it in tests as `api._internal.contract`). Pure
functions over already-parsed data: no file, network or DOM access, and none of
them throws on bad data. The authority is `docs/data-contract.md` (schema
version 1); this module implements all 15 refusal codes, in that document's
check order, reporting only the first failure, with its exact message
templates.

## Results

Every function returns (or, for `loadFile`, resolves to) one of:

```text
{ ok: true,  set }
{ ok: false, code, message, set }
```

- `code` is one of the 15 codes; `message` is the filled template (plain text,
  never markup; insert it with `textContent`).
- On a refusal `set` is the `base` argument unchanged (same reference), or
  `null` if none was given. The caller keeps showing `set`.

## The set

`set` is what the renderer, modes and viewer consume. A set is never mutated by
this module; an append returns a new one.

| Field | Type | Meaning |
|-------|------|---------|
| `schema_version` | number | `1` |
| `model` | string | model id |
| `dimension` | number | values per point, from the data |
| `count` | number | number of points |
| `text_included` | boolean | on append, true if either side is true |
| `provenance` | object | the base set's, as given (`source`, `producer`, `synthetic`, `seed`, `limitations`, `uncertain`, optional `created`, `endpoint`, `params`) |
| `reduction` | object | `{kind, source_dimension, directions_kept, variance_dropped}`; an absent record is exposed as `kind: "none"` with `source_dimension` = `directions_kept` = `dimension` and `variance_dropped` 0 |
| `vectors` | `Float32Array` | one flat array, length `count * dimension`, row-major (point `i`, coordinate `j` at `i * dimension + j`); never shares memory with the host's data, but may share an underlying buffer with other sets (below). **Read-only.** |
| `ids` | string[] | point ids in order |
| `points` | object[] | `{id, label, group, metadata}` per point, in the same order; `group` defaults to `""`, `metadata` to `{}`; copies, not the host's objects |

### Appends share one buffer

An append costs time proportional to the points added (amortised), not to the
size of the set. Successive sets of an append chain may share one underlying
`ArrayBuffer` with spare capacity: each set's `vectors` is a `Float32Array`
view of exactly `count * dimension` values (its `byteOffset` and length say
where), and `vectors.buffer.byteLength` can be larger than
`count * dimension * 4`. An append onto the newest set of a chain writes the new
rows into the spare capacity just after that set's rows and returns a longer
view over the same buffer; the older set's shorter view, and every value in it,
stays exactly as it was, so the older set stays valid. An append onto any other
set (two appends onto the same base, a set that is not the newest of its
buffer, or a set with no spare room) copies into a new buffer of twice the
needed length. So:

- Treat `set.vectors` as read-only (it always had to be): writing into one set's
  view could change what a later set reads.
- Never read past `set.vectors.length`, and never use `set.vectors.buffer`
  directly (for example `new Float32Array(set.vectors.buffer)`); copy with
  `set.vectors.slice()` or `new Float32Array(set.vectors)`, which copy the
  view's range only.
- A replace (`op` absent or `"replace"`) returns a set with its own exact-size
  buffer; the first append onto it copies once into a buffer with room to grow.

Measured in node (10,000 x 1024 base, 100-point appends): 1.3 ms median per
append onto the newest set (was 23 ms with a full copy); 100 successive appends
took 0.2 s in all (was 3.2 s). The slowest of those (about 20 ms) are the few
that grow the buffer. Appends that fork still copy (about 21 ms here). The
point records and ids are arrays of references rebuilt per append (about 0.1 ms
at 10,000 points); the duplicate-id check builds an index of the base's ids
(about 0.5 ms at 10,000 points).

## Functions

- `validate(data, base)`: the in-memory form (what `update(data)` receives).
  `data.vectors` is a `Float32Array` (values; its own range only) or an
  `ArrayBuffer` (little-endian float32 bytes whatever the platform). `base` is
  the set the view holds, or `null`/`undefined`. `op` `"replace"` (default)
  ignores `base` except to return it on refusal; `"append"` needs it.
- `checkRecords(records, base)`: file form, checks 1 to 7 only (no block
  needed). Returns `{ok: true, file}` where `file` is the block's file name, or
  a refusal. Use it to start fetching the block early.
- `finish(records, block, base)`: file form with the fetched block (an
  `ArrayBuffer` or `Float32Array`); runs every check. A block of any other type
  is `block-unreadable`.
- `loadFile(jsonUrl, fetchFn, base)`: file form, end to end. Returns a Promise
  that never rejects. `fetchFn(url)` is fetch-like: it returns a promise of
  `{ok, json(), arrayBuffer()}`. It is called with `jsonUrl`, then with the block
  name resolved against the JSON url's folder (query and fragment dropped, same
  origin and prefix, never another folder). A failed block fetch is
  `block-unreadable`. A data file that cannot be fetched or parsed is reported as
  `wrong-kind` (the contract defines no other code for it): this includes a
  data file that cannot be fetched and one that is not valid JSON.
  `provenance.endpoint`, when present, must match
  `^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$`, else `endpoint-is-address`.
- `supportedVersions`: `[1]`.
- `messages`: the code to template map (same text as
  `tests/fixtures/contract/index.json`).

## Notes for callers

- Unexpected exceptions while reading hostile data (for example a throwing
  getter) become `invalid-field` with the field `(unreadable data)`.
- Number placeholders print in decimal and strings as they are, so a message can
  contain text from the data; treat it as text.
- `ArrayBuffer` and `Float32Array` are recognised by their type tag, so values
  from another realm (an iframe) are accepted.
