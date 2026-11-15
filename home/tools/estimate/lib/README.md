# home/tools/estimate/lib

The parts of the `estimate` tool. `../estimate.mjs` is the command; it reads the files and calls these modules. See
`../README.md` for what the tool prints and the exact options.

- `items.mjs`: reads the `## Work items` table of a `STATUS.md` into work items (sizes S=1, M=2, L=4 points) and a list of row problems.
- `limits.mjs`: finds usage-limit windows in the lead session transcripts and works out which transcript folder belongs to a project.
- `compute.mjs`: the formula. Work items plus limit windows give a range of agent-hours, running time and calendar days.
- `report.mjs`: turns the result (or a refusal) into the text block the tool prints; `runningRange` is the running-time range the status line also shows.
- `from-files.mjs`: reads a STATUS.md and the project's transcripts and runs the formula; used by the CLI and by `../statusline-cache.mjs`.
- `segment-cache.mjs`: the status line's read side: the cache file, the `est` segment text and the detached refresh start. It imports none of the modules above, so a status line render never reads a transcript.

## Test

From the repo root:

    node --test tests/estimate.test.mjs tests/estimate-cli.test.mjs tests/statusline-estimate.test.mjs

`tests/estimate-fixtures.mjs` builds the fake `STATUS.md` tables and transcript lines. They are synthetic; no real transcript is used.

## Watch out for

- `compute.mjs` refuses to give a number when too few items are done (`MIN_DONE_ITEMS`), a done row has no `started`, a time is later than now, or an item has no working time left. That is on purpose, not a bug: a refusal is `{ refused: true, ... }`.
- `items.mjs` never skips a row it cannot read: it reports a problem with the line number, and the CLI turns any problem into exit 2.
- Transcript times are epoch milliseconds; the report converts them.
