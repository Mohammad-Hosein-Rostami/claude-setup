# land-lane/lib

Parts of `../land-lane.mjs`; the tool's own README is `../README.md`.

- `args.mjs`: reads and validates the command line (`parseArgs`, `isAbsolutePath`); a bad value is a `UsageError` (exit 2) before any command runs.
- `tools.mjs`: `git(...)` and `tool(name, script, args, ...)` run one subprocess with no shell, a timeout and no `GIT_*` variables of the caller.
- `suite-step.mjs`: step 5, a full-suite PASS for the rebased tip (`suiteStep`) and the reader of a failing `node --test` log (`failuresIn`).

Run the tests with `node --test tests/land-lane.test.mjs tests/land-lane-units.test.mjs`.
