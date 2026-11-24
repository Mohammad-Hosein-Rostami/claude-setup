# home/tools/ui-coverage/lib

The parts of `ui-coverage`. `../ui-coverage.mjs` is the command; `../README.md` has the commands and the matrix format.
A matrix says which surfaces x locales x widths x states must be checked. These modules build it, check it and report.

- `shape.mjs`: checks the layout of `matrix.json` by hand (no schema library); returns problems and never throws.
- `states.mjs`: the one list of default states for each kind of control (hover, open, error, ...).
- `cells.mjs`: the set of cells the matrix demands, expanding it into `todo` cells, and merging `ui-check` results into it.
- `frames.mjs`: the Figma frame inventory of `check` (frames file, unmapped and missing frames, compare records) and the `frames:` report line.
- `accepted.mjs`: which failing compare cells an `accepted` entry with a reason covers, and the entries `ui-check attribute` classes pixels with.
- `reuse.mjs`: proves a control really uses the component the matrix names (the `mountedAt` line).
- `check.mjs`: the `check` command's logic: validate, merge results, list every reason the matrix is not done.
- `group.mjs`: groups failing cells by kind and cause, so many failures print as a few groups.
- `report.mjs`: the text `check` prints.
- `init.mjs`: writes the skeleton of a new matrix with TODO placeholders.
- `scaffold.mjs`: builds the skeleton of a `ui-check batch --states` file from a matrix.

## Test

From the repo root:

    node --test tests/ui-coverage*.test.mjs

## Watch out for

- A fresh matrix from `init.mjs` fails `check` on purpose until every TODO is replaced.
- Widths are normalised in `cells.mjs`; use its `normalizeWidth` rather than comparing raw strings.
