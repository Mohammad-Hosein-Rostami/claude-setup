# home/tools/estimate/lib

The parts of the `estimate` tool. `../estimate.mjs` (the CLI) and `../statusline-cache.mjs` (the status line refresh) both call
`from-files.mjs` `estimateFile`; `../backtest.mjs` replays jobs with the same steps. See `../README.md` for what the tool prints.

- `items.mjs`: the one table reader: `parseWorkItems` (rows with or without outer pipes, kind from the item or id cell, every
  problem with its line), `rowCells` and `isTableRow` (shared with `tools/status/status.mjs`), `parseInstant`.
- `activity.mjs`: a session's transcript files and the active minutes in them, kept in a per-session index.
- `worked.mjs` (pure): working intervals, row costs, open rows' elapsed shares, handed-over jobs and their growth parts.
- `forecast.mjs` (pure): the reference pool, the seeded runs, the refusal reasons.
- `progress.mjs` (pure): the job's progress percent (`progressOf`): from the forecast's median, or from row weights when the tool refuses;
  this run's alone (it may fall when rows are added), 99 until every row is done; `expectedMinutes` per row.
- `commitment.mjs` (pure): first, hold or move (earlier or later) the committed median budget; scoring, widening, range, track
  record, counted per model id.
- `job-rows.mjs` (pure): the rows carried over the last hand-over and the cache numbers (per open row `expectMin`).
- `road-steps.mjs` (pure): a road's steps from row ids `<road>.s<N>.`, the current step, the step shares of the Total (rounded to add up; a share is not the step's own median) and `result.road` / `progress.road`.
- `limits-store.mjs`: the last-seen usage limits per account (`~/.claude/state/limits/<account>.json` and its 7-day `.jsonl`);
  the status line writes them, the estimate, the board and the pane read them.
- `backtest-scores.mjs` (pure): the backtest's scores (per-job miss, bias, 85% hit rate, naive baseline, first estimate apart).
- `table-store.mjs`: the store files (table, session link, seed) under a short lock; `isScratchStatusPath` keeps temp and scratchpad STATUS.md files out of the owner's store.
- `from-files.mjs`: `estimateFile`, the one function of the design: parse, activity, costs, pool, state, commitment (it never links a session).
- `report.mjs`: the printed block and the refusal text. `local-clock.mjs`: local clock text and the 5-minute grid.
- `segment-text.mjs`: the status line text of a result. `segment-cache.mjs`: the status line's read side (the cache, the
  session link, the detached refresh); it imports none of the forecast, parser or transcript code, so a render never reads a transcript.

## Test

From the repo root:

    node --test tests/estimate*.test.mjs tests/statusline-estimate.test.mjs tests/statusline-segment-forms.test.mjs

`tests/estimate-tables.mjs` builds synthetic tables, transcripts and seeds; no real transcript is used.

## Watch out for

- The pure modules take epoch minutes; items carry epoch-ms stamps. `from-files.mjs` floors now to the minute so the CLI and
  the status line agree within a minute.
- Never hold the table lock around a scan or the simulation: the lock is taken as abandoned after 0.5 s.
- A backtest threshold that fails means the model changed; report it, never tune a constant to pass.
- `items.mjs` never skips a row it cannot read: it reports a problem with the line number, and the CLI turns any problem into exit 2.
