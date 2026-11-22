# ui-check/commands

- `batch.mjs` - `batch` - many states (locale, direction, colour scheme, opened controls) in one run; writes results.json and summary.md.
- `columns.mjs` - `columns` - check that body cells line up with their header cells in a table.
- `compare.mjs` - `compare` - element gate + pixel gate for one Figma frame vs the running page.
- `figma-frames.mjs` - `figma-frames` - list the frames under some Figma nodes into a frames file for `ui-coverage` (one REST call per node, depth 2).
- `figma-pull.mjs` - `figma-pull` - cache a Figma node's baseline PNG, flattened spec and meta (zero MCP tokens).
- `figma-pull.mjs` `--bulk` / `--from-export` - every frame and component-set variant under a page or section (one nodes call, one images call), or the same from a local export folder (no network): the nodes.json folder or Figma's own PNG export, matched by layer name (`lib/native-export.mjs`).
- `figma-refresh.mjs` - `figma-refresh` - re-fetch the frames under a node into a temp folder and print changed / unchanged / new / gone per frame; never writes the cache.
- `responsive.mjs` - `responsive` - layout invariants at several widths; screenshots go to disk, never to the caller.
- `first-paint.mjs` - `first-paint` - per state, the frames from navigation to settled with scripts held, then fonts held: blank or one neutral loader, then the final screen; no layout shift after the first visible frame.
- `run.mjs` - `run` - one call per UI round: ui-coverage scaffold + batch + ui-coverage check; numbers, failing rows with crops, `--prev`, `--no-worse`, `--self-test`, `--step`.
- `figma-diff.mjs` - `figma-diff` - per state with a `figma` part: built parts and texts not in Figma, Figma texts and drawings not built, wording differences; each row classed fix / keep / ask the owner.
- `attribute.mjs` - `attribute` - per compare record, each leftover colour-metric pixel to the topmost Figma node and a class (accepted, text anti-aliasing, flagged text, graphic, other); one row per class per state, crops baseline | actual | diff per cluster; a recount that differs from the record exits 2.
