# ui-check/test

- `smoke.test.mjs` - end-to-end smoke test of compare and responsive against static fixtures.
- `spec.test.mjs` - unit checks for flattenSpec, compareElements, alignColumns and the report cap (no browser needed).
- `units.test.mjs` - browser-free unit tests for colour parsing, measurement, pixel gate, cache/args validation and CLI exit-2 mapping.
- `steps.test.mjs` - browser-free tests for steps validation/runner, the `--steps`/`--bypass-csp` flags and the openPage bypass wiring (default off).
- `fixtures/` - static HTML and JSON inputs (card, wide, frame, map) used by the smoke test.
