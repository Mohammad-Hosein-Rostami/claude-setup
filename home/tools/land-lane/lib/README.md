# land-lane/lib

Parts of `../land-lane.mjs`; the tool's own README is `../README.md`.

- `args.mjs`: reads and validates the command line (`parseArgs`, `isAbsolutePath`); a bad value is a `UsageError` (exit 2) before any command runs.
- `tools.mjs`: `git(...)` and `tool(name, script, args, ...)` run one subprocess with no shell, a timeout and no `GIT_*` variables of the caller.

Run the tests with `node --test tests/land-lane.test.mjs tests/land-lane-units.test.mjs`.
