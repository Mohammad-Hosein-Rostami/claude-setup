# ui-check/commands

- `batch.mjs` - `batch` - many states (locale, direction, colour scheme, opened controls) in one run; writes results.json and summary.md.
- `columns.mjs` - `columns` - check that body cells line up with their header cells in a table.
- `compare.mjs` - `compare` - element gate + pixel gate for one Figma frame vs the running page.
- `figma-frames.mjs` - `figma-frames` - list the frames under some Figma nodes into a frames file for `ui-coverage` (one REST call per node, depth 2).
- `figma-pull.mjs` - `figma-pull` - cache a Figma node's baseline PNG, flattened spec and meta (zero MCP tokens).
- `responsive.mjs` - `responsive` - layout invariants at several widths; screenshots go to disk, never to the caller.
