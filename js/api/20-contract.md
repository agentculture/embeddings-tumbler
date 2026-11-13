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
| `vectors` | `Float32Array` | one flat array, length `count * dimension`, row-major (point `i`, coordinate `j` at `i * dimension + j`), always a fresh copy |
| `ids` | string[] | point ids in order |
| `points` | object[] | `{id, label, group, metadata}` per point, in the same order; `group` defaults to `""`, `metadata` to `{}`; copies, not the host's objects |

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
