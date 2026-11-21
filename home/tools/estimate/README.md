# estimate

Turns the `## Work items` table of a `STATUS.md` and the working time in the session transcripts into one committed local
time when the whole job is finished. The lead pastes that `Finish:` block and never quotes an estimate from intuition. The
status line shows the same time. Node 22, no dependencies.

Run: `node ~/.claude/tools/estimate/estimate.mjs STATUS.md [--session <id>] [--now <iso>] [--state-dir <dir>] [--projects <dir>]`
and paste the output as-is. If it refuses (exit 3), give its reason, do its `What to do:` and any `Check:` line first.

- `--session`: the session whose transcripts count (default `$CLAUDE_CODE_SESSION_ID`); sessions that touched the table before
  count too.
- `--now`: estimate at this instant (default the clock). A `--now` run without `--state-dir` neither reads nor writes the store.
- `--state-dir`: the store (default `~/.claude/state/estimate`). `--projects`: Claude Code's projects folder (default
  `~/.claude/projects`).

## Record (in STATUS.md)

Heading `## Work items`, then one table, with or without outer pipes (the header row is checked):

```
id | item | size | started | done | evidence
---|---|---|---|---|---
M1 | parse the table | M | 2026-11-14T08:10Z | 2026-11-14T09:40Z | commit 1a2b3c4
close:2 | fix review findings | S | 2026-11-14T09:45Z | |
deliver:1 | report to owner | S | | 2026-11-14T10:30Z |
```

- size: S, M or L. S: one agent step, fix or review. M: one spec step with tests. L: a whole lane. Bigger: split it.
- started / done: a real ISO 8601 instant (`YYYY-MM-DDTHH:MM[:SS[.fff]]` with `Z` or `+HH:MM`), empty or `-` when not set.
  From the clock, never from memory: a stamp later than now is an error. A done work row needs a started.
- Done = `done` set and real evidence (commit sha, file path or `check: <cmd> PASS`; `x`, `n/a`, `tbd` are refused). A row
  that will not be done: close it with evidence `dropped: <why>` (it then teaches the pool nothing).
- Kind, from the prefix of the item cell, else of the id cell: `close:` (review, fixes, landing), `rework:` (an owner
  correction), `deliver:` (a hand-over: done alone is enough; its done time ends a job). Anything else is build work.
- List the job's rows first, start each when its work begins. Rows listed late show up as growth (below).
- One `## Work items` section and one unbroken table in it; a row of the table's shape anywhere else in the file, a second
  section, a row after a blank or text line, a bad header, a wrong cell count or a repeated id (ignoring case) is an error
  naming its line (exit 2). Write a pipe inside a cell as `\|`. CRLF, a BOM and backticks are fine; fenced code is ignored.

## Model (estimator design section 3)

- Working time: a minute is active when a transcript of the table's sessions (main file, subagents, workflows) has an entry
  stamped in it; silences of up to 10 minutes are bridged. Nights, usage limits and waiting for the owner are silences.
- Cost: every working minute is split evenly among the done rows running in it; a row's cost is its share. An open row's
  elapsed share is its share among all started rows. Costs add up to the job's working time, so no lane count is needed.
- Jobs: the rows done between two hand-overs. Growth: for each finished job, the cost-weighted share of the remaining work
  that was not in the table yet, pooled over the newest jobs holding 20 hours of work (0.416 on the measured tables).
- Pool: the finished rows of the same size in every table file on this machine plus `seed.json` (the 200 newest per size;
  a seed entry whose table has a file here is skipped, and so is one a table here holds under another id: a row with the same
  size and done time, a job with the same hand-over time, as on the PC, where the same STATUS.md has another path).
- Forecast: 2000 seeded runs; each open row draws a finished cost of its size longer than its elapsed share (minus that
  share), or any cost of its size when it has run longer than all of them. Growth is not in the total (it added work that never
  came, +92 min per job on 15 replayed jobs); it is stated on its own line. Same table state, same numbers, in the CLI and the
  status line. The changes of round 9 are model `c2b` of the backtest (`certainty/estimate-backtest.md` section 7).
- Carried rows: an open row first seen before the last hand-over and not started since is left out of every count and named
  in a `Check:` line (such rows added +89 min per job). Without a first-seen record (no store) no row is carried.
- Commitment: the first run of a job commits the **median** as a work budget. Later runs hold it while the fresh median is
  within 5 minutes of the budget left, else move it, earlier or later, to the fresh median, storing the cause (rows added, a
  slow row, pace, or `ahead`). The shown time is now + budget left, rounded up to 5 minutes; the 85% and 95% clocks keep their
  offset from it. Work does not move it, a pause moves it hour for hour.
- Scoring: each first or moved commitment is scored in working minutes at the hand-over that finishes its rows; after 10
  scored jobs the 85th percentile of actual / committed-85% over the last 20 widens the 85% and 95% clocks (never narrows).
  From 20 scored jobs a `Range:` line shows the 10th to 90th percentile of actual / shown median, with its count; below that it
  says `not yet measured`. Every log entry carries the model id (`c2b`); widening, range and track record count only entries
  of the current model, so their counts restart at a model change.
- Long jobs: over 6 h of median work a `Long job:` line says it cannot be predicted closer than half a day and a `Limits:` line
  names the 5 h and 7 d resets last seen for this terminal's account (`CLAUDE_ACCOUNT`, `lib/limits-store.mjs`).

## Output (exit 0, stdout)

```
Finish: Mon 16 Nov 20:50 (likely; 85% by 21:40, 95% by 23:10; local +03:30, now 19:05)
Range: not yet measured (3 of 20 scored jobs).
Covers: 9 open rows (2 running; 5 S, 3 M, 1 L); 1 h 45 of work left in this time.
Not in this time: work not listed yet, usually about 40 min more (42% of the work left in past jobs).
Excludes: pauses (nights, usage limits, waiting for you) move the time hour for hour; rework after hand-over; new requests.
Held: given Mon 16 Nov 18:10, unchanged since.
Track record: 7 of the last 10 jobs were done by the first 85% time given.
Progress: 54% (5 of 9 rows; median left 30 min)
Check: row b12 (M) has taken 3 h 10 of work, longer than every finished M row (2 h 19): finish it, or close it with evidence "dropped: <why>".
```

- An `85% by` or `95% by` clock on another day than the finish gets its weekday.
- Line 4 after a move: `Moved: at 19:40 from 21:05, because 6 rows were added (c7, c8, c9, c10, c11 and 1 more); unchanged
  since.` (or `because row b12 is taking longer than 85% of M rows`, `because the open rows are taking longer than usual`,
  `because the open rows are going faster than usual or rows were dropped` for an earlier move),
  then ` Pauses since then: 1 h 20.` when pauses since the commitment reach 5 minutes (also after `Held:`).
- Line 5 before any score: `Track record: no job scored yet; learned from 146 finished rows and 10 jobs.`
- `Check:` lines: at most 3 stale rows, longest first, then `Check: and N more.`; and `Check: 45 min of work in this job ran
  with no started row: start rows with status.mjs start <id>.` from 30 untracked minutes up; `Check: 3 rows carried from the last
  hand-over (a1, a2, a3), not counted: close them or drop them.` (also after a refusal, an all-done or a hand-over block).
- No open row: `Finish: now (all 12 rows are done; the hand-over is recorded when this turn ends)`; after a `deliver:` row:
  `Finish: handed over Mon 16 Nov 17:54 (12 rows, 3 h 05 of work)` and the track record line.
- Work is `35 min` under an hour, else `2 h 35`.

## Progress

The `Progress:` line (after the track record, before the `Check:` lines) says how far the job is: the rows done of the job's
rows (the work rows open or done after the last hand-over) and a percent.

- With a forecast: `floor(100 x worked / (worked + median left))`, `worked` being the working minutes since the job's first
  started row. The percent and the clock use the same median.
- Without a forecast (a refusal): `Progress: ~31% (2 of 4 rows; time n/a: too few finished rows)`. Each row weighs its size's pool
  median (when the size has 5 finished rows), else S 3 / M 9 / L 40 minutes; done rows count fully, an open row counts its
  elapsed minutes up to 90% of its weight. The `~` marks it as approximate. No work row, no progress line.
- The percent is this run's alone and may fall when rows are added (audit case 8; the old held percent is gone, so a figure
  always matches its own row counts). 99 until every row is done, 100 only then (`all rows done`). A hand-over shows no progress.
- Tags on the status line's bar: `moved` (the committed time moved), `+rows` (rows were added), `overdue` (the committed
  work budget is used up).

## Refusals (exit 3, stderr; never a clock time)

| Reason | No finish time: | What to do: |
| ------ | --------------- | ----------- |
| no work row | the table has no work row. | list the job's rows with `status.mjs add`. |
| a size with under 5 pool rows | only 4 finished L rows to learn from (5 needed). | finish rows of that size first, or split the L rows into M rows (S: finish rows of that size first). |
| growth at 75% or more | in the recent jobs 78% of the work was not in the table when it was estimated. | list the job's rows first (`status.mjs add`), then `status.mjs start` each as its work begins. |
| median above twice the longest finished job | this job is longer than any finished one (longest: 5 h 55 of work). Then `Work left: likely 90 h, 85% sure within 99 h, of work (not clock time).` | quote the work left as hours of work; hand over in parts (`status.mjs deliver "<part>"`) so jobs of this length get scored. |

`Check:` lines follow a refusal too. A refusal shows no time but keeps the commitment. Exit 2 (stderr `estimate: ...`): a flag,
`--now`, the file or a table line cannot be used; the message names the line.

## Status line segment

`home/statusline.mjs` shows, for the STATUS.md the session last edited with `status.mjs` (its link in the store), else
`<project dir>/STATUS.md`: `done by 21:40` (`done by Tue 21:40` on another day), `all rows done`, `handed over 17:54`,
`work left ~99 h`, `done ? overdue` once the shown time has passed, or `done ? <cause>`: `no rows`, `few rows`,
`rows listed late`, `table`, `row <id>`, `tool error`. At most 28 characters. Under that line (from `COLUMNS`, default 80; plain
ASCII `#`/`-` and no colour when `NO_COLOR` is set) it prints, when there is something to show, line 2 the job bar from the
cached progress (`██████░░░░░░ 54% · 5/9 rows · 30 min left · moved`: 12 cells from 100 columns, 8 from 70, text only below;
green, yellow for `moved` and `+rows`, red for `overdue`) and then one line per live workflow run, at most two
(`wf build impl-a · Review (3/4) · 5/7 agents`), read from the session's workflow journals under
`<session>/subagents/workflows/<run>/journal.jsonl` (a journal written in the last 30 minutes, with no
`<session>/workflows/<run>.json` summary yet; at most 256 KB of its tail; the phase total from the script copy's `meta`).
Claude Code writes those journals without documenting them: a shape this reads wrongly shows no run line, never a wrong count. The render only reads a small cache
(`~/.claude/state/estimate-segment/`); when it is missing, no longer matches the file or is 5 minutes old it starts
`statusline-cache.mjs <STATUS.md> [<session-id>]` detached, at most once per 2 minutes per file. That script runs the CLI's
own function (recording the commitment like a CLI run), so both show the same committed time. Neither run links the
session to the table: only `status.mjs` edits do, so a session that only looks at a table never counts as working on it.
A recorded CLI run at the real clock (no `--now`) also writes the cache entry from its own result, so a time the CLI just made
or moved is what the status line shows next. A hand-over text is shown only while the file
is unchanged; any other text for 15 more minutes while a refresh runs.

Numbers in the cache entry (`numbers`, beside the text, which `r9-statusline` drops later): `{ finishMs, p85Ms, leftMin,
workedMin, rowsDone, rowsTotal, rows: [{ id, expectMin, startedMs }] }`, the open rows (started first, at most 64) with their
expected minutes (the size's pool median, else S 3 / M 9 / L 40). The render formats clocks from them in its own time zone.

## Store

`~/.claude/state/estimate/`: `table/<32 hex of sha256 of the real STATUS.md path>.json` (sessions, first-seen time of each
row id, finished rows and jobs without ids or text, the commitment and its log, at most 200 entries, the held progress percent of the
current job), `activity/<session>.json`
(bytes read per transcript and the active minutes, so each run reads only appended bytes), `session/<session>.json` (the
STATUS.md the session last edited with `status.mjs`). Written through `hooks/lib/session-store.mjs` and `session-lock.mjs`, never swept. The table file's lock is held
only for its read-change-write; a busy lock or an unusable file records nothing (`estimate: this run recorded nothing (the store
was busy or a store file could not be used)`). Table and activity files are capped at 16 MiB (the largest real ones are
about 120 KB and 234 KB); the tool never writes a bigger one, and a bigger file is kept as it is, not used, and named in one
stderr line.
The old `~/.claude/state/estimate-log/` is no longer read; it can be deleted by hand.

## Backtest and seed

`node backtest.mjs --job <STATUS.md>=<session-id> ... [--now <iso>] [--write-seed <file>]` replays every handed-over job at
20-minute steps with the tool's own steps (leave-one-table-out pool, no seed, no store) and checks the numbers against the
thresholds in `backtest.mjs` (exit 1 on a miss). One threshold differs from the design: a time at 58 or more of the 64
instants, not 60, because the 5-row minimum per size refuses 5 instants honestly (the design's checker had no minimum). `seed.json` was written by it at the cut-over from the setup and
bill-and-ben tables and two finished tables (147 rows, 10 jobs): size, kind, done time and cost only, keyed by table hash.
A `Scores` block follows the thresholds (`lib/backtest-scores.mjs`, never failing the run): the per-job median miss of the
shown (median) time and the jobs within 60 min or 30%, a naive baseline (the median work of the other tables' jobs of the same
size class, a job's class being its largest row size), the signed bias (median log(shown/actual), all jobs and jobs over 6 h),
the 85% clock's hit rate, the first estimate of each job apart from the later updates, and review and judge rows by effort when
the tables have an effort column. No constant is fitted on these before about 40 scored jobs.

## Layout

`estimate.mjs` (CLI) and `statusline-cache.mjs` (status line refresh) call `lib/from-files.mjs` `estimateFile`; see
`lib/README.md` for the parts. Tests: `tests/estimate*.test.mjs`, `tests/statusline-estimate.test.mjs`,
`tests/statusline-segment-forms.test.mjs`, `tests/workflow-runs.test.mjs`, with `tests/estimate-tables.mjs` (synthetic tables, transcripts and seeds).
