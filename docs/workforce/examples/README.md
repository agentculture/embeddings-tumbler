# Illustrative examples

These files are **sketches** written during planning. They show the shape the
spec implies so that task agents start from something concrete. None of them
is binding and none of them runs against real code yet:

- Task `t2` writes the authoritative data contract in `docs/data-contract.md`.
  Where it differs from `data-file.example.json`, the contract wins and this
  example should be updated or removed.
- Task `t8` fixes the real `mount` / `update` / `destroy` signatures.
- Task `t7` fixes the real mode interface.

| File | Shows |
|------|-------|
| `data-file.example.json` | A data file's JSON part: version, provenance, points, and a pointer to the binary vector block. |
| `write_data_file.py` | A producer in standard-library Python: writes the JSON part and the float32 block. |
| `host-script.html` | A host page that calls `mount` and `update`. |
| `host-web-component.html` | A host page that uses the custom element under `script-src 'self'`. |
| `mode-interface.js` | The interface a mode implements, with a do-nothing fourth mode. |
