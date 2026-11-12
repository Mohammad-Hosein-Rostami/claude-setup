# ui-check/lib

- `args.mjs` - strict CLI flag parsing that reports mistakes as UsageError.
- `audit.mjs` - in-page responsive audit (serialised into the browser by Playwright).
- `browser.mjs` - resolve Playwright from the target project and open deterministic pages.
- `cache.mjs` - locate and read the per-node Figma cache (baseline.png, spec.json, meta.json).
- `elements.mjs` - compare measured DOM boxes/styles to the flattened Figma spec (the element gate).
- `errors.mjs` - one error type for usage and setup problems (exit code 2).
- `figma-api.mjs` - minimal Figma REST client (node tree + PNG export). Never logs or returns the token.
- `image.mjs` - PNG read/write, padding to a common size and diff-region scan.
- `measure.mjs` - in-page measurement of mapped elements (serialised into the browser by Playwright).
- `pixels.mjs` - the pixel gate - odiff (threshold 0.1, anti-aliasing ignored) with size-mismatch padding.
- `report.mjs` - write report.json and a report.md capped at 40 lines.
- `spec.mjs` - flatten a Figma REST node tree into a list of boxes relative to the frame root.
- `tolerances.mjs` - the single tolerance table used by the element check. Documented in standards/figma.md.
