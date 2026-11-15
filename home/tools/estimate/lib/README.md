# home/tools/estimate/lib

The parts of the `estimate` tool. `../estimate.mjs` is the command; it reads the files and calls these modules. See
`../README.md` for what the tool prints and the exact options.

- `items.mjs`: reads the `## Work items` table of a `STATUS.md` into work items (sizes S=1, M=2, L=4 points; kind `close`, `rework` or `build` from the item cell's prefix) and a list of row problems.
- `limits.mjs`: finds usage-limit windows in the lead session transcripts and works out which transcript folder belongs to a project.
- `history.mjs`: the table's job history: deliveries, the closing tail of each, the closing range, how long the open job's closing has run, and how often a delivery was reopened by a `rework:` row.
- `compute.mjs`: the formula. Work items plus limit windows give the finish range: the build part, then the closing phase in series.
- `report.mjs`: turns the result (or a refusal) into the text block the tool prints, on the local clock; `finishClock` is the short clock range the status line shows.
- `from-files.mjs`: reads a STATUS.md and the project's transcripts and runs the formula; used by the CLI and by `../statusline-cache.mjs`.
- `segment-cache.mjs`: the status line's read side: the cache file, the `est` segment text and the detached refresh start. It imports none of the modules above, so a status line render never reads a transcript.

## Test

From the repo root:

    node --test tests/estimate*.test.mjs tests/statusline-estimate.test.mjs

`tests/estimate-fixtures.mjs` builds the fake `STATUS.md` tables and transcript lines. They are synthetic; no real transcript is used.
`tests/estimate-replay-cases.mjs` holds two real tables as ids, sizes and times only (neutral item text).

## Watch out for

- `compute.mjs` refuses to give a number when too few items are done (`MIN_DONE_ITEMS`), a done row has no `started`, a time is later than now, an item has no working time left, or no build row is open and the closing has already run as long as its high end (`reason: 'overrun'`). That is on purpose, not a bug: a refusal is `{ refused: true, reason, ... }`.
- A replay case that prints another Finish line means the code no longer follows the formula in `../README.md`; fix the code, never a constant.
- `items.mjs` never skips a row it cannot read: it reports a problem with the line number, and the CLI turns any problem into exit 2.
- Transcript times are epoch milliseconds; the report converts them.
