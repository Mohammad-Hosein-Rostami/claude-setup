# estimate

Turns the `## Work items` table of a `STATUS.md` plus the project's lead transcripts into the local clock time when the
whole job is finished: the open build rows, then the closing phase (review, fix rounds, recheck, landing) measured from
this table's earlier deliveries, always in series. The lead pastes that `Finish:` block and never quotes an estimate from
intuition. Node 22, no dependencies.

Run: `node ~/.claude/tools/estimate/estimate.mjs STATUS.md [--transcripts <dir>] [--now <iso>] [--log-dir <dir>]` and paste the output as-is.
If it refuses (exit 3), give its reason and its `What to do:`; never give a number of your own.

## Record (in STATUS.md)

Heading `## Work items`, then the table (the header row is checked):

```
| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| M1 | parse the table | M | 2026-11-14T08:10Z | 2026-11-14T09:40Z | commit 1a2b3c4 |
| M2 | cli exit codes | S | 2026-11-14T09:45Z | - | - |
```

- size: S = 1, M = 2, L = 4 points. S: one agent step, fix or review. M: one spec step with tests. L: a whole lane or
  spec including review and merge. Anything bigger: split it. Sizes are relative and measured per project, so a
  consistent mis-sizing cancels out. Set the size when the row is added and never change it after `started`.
- started / done: a real ISO 8601 instant: `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by `Z` or an offset `+HH:MM` / `-HH:MM`,
  e.g. `2026-11-14T10:45Z`; `-` when empty. Set them when they happen, from the clock (`date -u +%Y-%m-%dT%H:%MZ`),
  never from memory: a time ahead of the clock is refused. A bare date, `10:45` without a date, `2026-02-30`, month 13
  and `T24:00` are errors (checked by a strict pattern plus a calendar round trip, never shifted to another day).
  `done` must be after `started`, and neither may be later than `--now` (default: the real clock).
- Done = `done` set and evidence non-empty (commit sha, file path or `check: <cmd> PASS`). A dropped open item: delete the row.
  Never clear a done cell: a correction of delivered work is a new row.
- Kind, from the start of the item cell (case-insensitive): `close:` for review, fixes from a review, recheck, gate,
  landing; `rework:` for an owner correction; `deliver:` for handing the job to the owner, an event: done alone is
  enough (started is then the done time, evidence may be empty); anything else is build work. Without `deliver:` rows, start the next `close:` row when one
  ends: a closing chain that pauses 10 minutes or more with nothing running reads as a delivery.
  Close rows may also be left out; the tool's closing phase covers them.
- Rows without `done` are the remaining work; for in-flight rows (`started`, no `done`) the time already run is subtracted.
- Exactly one `## Work items` section, and in it one contiguous table: the header (the six names in order, case and
  spaces ignored), the separator line, then the rows with no blank or text line between them. Anything that cannot be
  read is an error naming the line; no row is skipped. Ids are unique ignoring case. Write a pipe inside a cell as `\|`
  (a pipe inside backticks still splits the cell). Backticks, CRLF line ends and a UTF-8 BOM are fine.
  Tables inside code fences are ignored; the table section ends at the next heading.

## Formula

All durations are wall-clock time minus the usage-limit windows found in the transcripts (waiting and nights stay in).

- Rate band (hours per point): every done row's (done - started) / points, plus every running row's (now - started) /
  points when it is above the lowest done rate (a lower bound on that row's rate, so it can only raise the band). Needs at least 5 done items with started, done and evidence. The band is min..max below 10
  values, from 10 the nearest-rank p25..p75 (rank = ceil(p x n)).
- Build part B(r) over the open build and rework rows: remaining = max(0, points x r - time already run); B = the larger of
  (sum of remaining / lanes) and the largest single remaining, so a long row is never split across lanes. Low end at the
  band's low rate, high end at its high rate. Lanes = sum of the durations of all done rows (close rows included) / their
  union (measured), clamped to 1..the number of open build and rework rows, so open close rows never add lanes. A running
  row that has already run as long as the band's slowest rate allows is named in the Includes line: `O1 past every
  measured rate, its remaining time is not known` (its remaining time counts as 0).
- State: one function (`lib/history.mjs` tableState) classifies the table as first-cycle-building, first-cycle-closing,
  round-open, round-done-not-delivered or delivered; every output switches on it. With nothing open only
  first-cycle-closing (the build is done, the review is not in rows yet, and the Includes line says so) prints a future
  finish; round-done-not-delivered is refused and asks for the `deliver:` row.
- Delivery: the done time D of a `deliver:` row when no other row was running at D (else the row is ignored and the
  Includes line says `deliver row X1 ignored: 1 row was still running at 14:30`); a table with one has no other deliveries. Without them it is guessed
  from a pause, and the Includes line ends `delivery guessed from a pause: add a deliver: row when you hand over`: the
  done time D of a `close:` row when every row started before D is done by D, no row starts in the 10 minutes after D,
  and those 10 minutes have passed (the real deliveries measured were followed by 19 and 470 quiet minutes, other quiet moments by 0-1).
- Closing phase C: the default 1.4-2.5 h (the closing tails 1.48, 2.40 and 2.43 h of two projects, 14-15 Nov, rounded
  outward; a tail = D minus the latest done of a non-close row before it). A table has one first cycle (work after a
  delivery is a follow-up round), so its closing range stays this default until the tool learns across jobs; the output
  always says `default, not yet measured here`.
- Elapsed E: 0 while a build or rework row is open; else the time since the latest non-close done after the last
  delivery (else the first start after it).
- Finish = now + [B(low) + max(0, C low - E), B(high) + max(0, C high - E)], on the local clock: the low end floored
  and the high end ceiled to 5 minutes, at least 5 minutes apart; line 1 never starts before now (a low end that would
  floor before now is rounded up instead). This holds for every kind of result.
- Follow-up round: rows started after a delivery (fixes after a verification, owner corrections, new requests, of any
  kind) form a round, from the first row started after the delivery (now, if none has started) to the next delivery. It is
  not a new closing phase, also when all its rows are done and the last is not a `close:` row. While one is open, every open row counts by size (close and rework rows too) and Finish =
  [max(S + R low, now + B(low)), max(S + R high, now + B(high))] (so never before now), S = the round's start. R = min..max of the last 5
  finished rounds here once 2 exist; before that the default 0.4-2.6 h, widened to include a single round. The default
  is the spread of the only three rounds measured, rounded outward like the closing default: a restructure round of
  0.48 h (11:25Z-11:54Z, 15 Nov, live table), an auth round of 1.83 h (06:20Z-08:10Z) and an auth rework round still
  open at 2.57 h (08:29Z-11:03Z), both from the 14-15 Nov analysis. It is wide because only three rounds were measured. A round past S + R high whose open rows are all past their measured rates is
  refused (exit 3). The first cycle (no delivery yet) is the build part and closing phase above.
- Reopened: a delivery counts as reopened when a `rework:` row starts after it (up to the next delivery, or now); the
  rework time runs from that first start to the next delivery, or to now: `so far (still open)` while a rework row is
  open, `so far (not delivered again yet)` once they are done.

Usage-limit windows come from the lead transcripts (`<dir>/*.jsonl`, subagent folders are not read): a window starts at
an assistant entry with `message.model == "<synthetic>"` whose text matches `/hit your .*limit/i` (so a synthetic
`No response requested.` is not one) and ends at the next entry containing `usage limit has reset`, else at the next
non-synthetic assistant entry, else at the transcript's last timestamp. Repeated hits inside one window do not start a
new one; windows of several sessions are merged. If Claude Code changes that text the windows are not found; the output
then says `0 limit windows` (or `not measured` when no transcripts exist) instead of failing silently.

Default transcript folder: `~/.claude/projects/<slug>` where slug = the working directory with every
non-alphanumeric character replaced by `-`; when that folder is absent the parent directories are tried in turn (a
project run from a subfolder; the home folder's own slug is never used, it holds unrelated work). `--transcripts`
overrides and must exist. Transcripts are read line by line. The slug rule is unverified on Windows (drive letters and
backslashes); pass `--transcripts` there.

## Output

```
Finish: Sun 15 Nov 14:45-16:15 (local +03:30, now 13:21)
Includes: 2 open rows (1 running); build 0-0.4 h (H2, 1 lane), then the closing phase 1.4-2.5 h in series (review, fix rounds, recheck, landing; default, not yet measured here)
Excludes: your review and any rework it starts (next line); usage-limit pauses from now on; steps only you do (push, deploy); requests that are not rows
After your review: not measured here yet (no earlier delivery in this table)
Track record (first cycles): no scored estimate yet; the range is adjusted once 5 are scored (target: 8 of 10 inside)
Assumes: the table as it is now; 0.14-0.25 h/point (p25-p75 of 33 done + 1 running rows, 14..15 Nov); 1.0 lanes (measured 2.2, capped by 1 open build row); no limit windows in the transcripts
Agent-hours: 0.6-1.0 for the open build rows, counted whole
```

- Local = the system time zone (`TZ` is honoured). A range across midnight reads `Sat 14 Nov 23:50 - Sun 15 Nov 01:10`.
- With only close rows open: `no open build row: the closing phase ... has run 1.5 h`; with no row open: `no open row: the
  build is done and the closing phase ... is not in rows yet; it has run 1.5 h`. After a delivery the After line counts
  reopened deliveries: `1 of 2 earlier deliveries here were reopened by your corrections; that rework took 1.4 h so far (still open)`.
- In a follow-up round the Includes line reads `follow-up round after the delivery at 14:25, started 14:55 (V1): 6 open
  rows (1 running); such rounds took 0.4-2.6 h here (default, not yet measured here); the open rows need at least
  0.5-2.8 h by size (V1, V2, V3, V4, V5 and 1 more, 1 lane)`; with finished rounds `widened by the 1 finished round
  here` or `measured from 2 finished rounds here`.
- No delivery in the table yet: `After your review: not measured here yet (no earlier delivery in this table)`.
- No open row and the last done row a `deliver:` row: `Finish: delivered Sun 15 Nov 15:24 (local +03:30)`, an Includes
  line saying there is no open row, and the After line. A table without `deliver:` rows uses its last `close:` row and,
  within 10 minutes of it, reads `(local +03:30; provisional
  until 15:34: no open row)`. With no open row the tool never predicts a future finish; it is not a delivery in the
  history (closing tails, scoring) until the 10 minutes have passed. No status line segment, no log line. No open row
  but the last done row a build row: in the first cycle the closing phase still applies (the review and fix rounds are
  not rows yet); after a delivery the follow-up round does.
- Track record (see Calibration), for the phase of this estimate: `Track record (first cycles): 9 of 13 inside, 3 late
  (median x1.4 of the printed time), 1 early; adjusted high x1.3, low x0.9 (target 8 of 10)`, below 5 scored `...; adjusted
  once 5 are scored`; inside a follow-up round `Track record (follow-up rounds): ...`; `; 2 dropped (table rewritten)` when
  entries were dropped. A `--now` run without `--log-dir` keeps no log and prints no
  Track record line.
- The `Note:` line (last) appears only when the newest `started` or `done` is more than 24 h before `--now` and rows remain open.
- No transcripts: the Assumes line ends `usage-limit windows not measured (no transcripts at <dir>)`.

## Calibration

Each run that prints a finish range appends one line to its log, unless it repeats the last line: the same phase and the
same open rows (ids, sizes, started) less than 60 minutes after it (`RELOG_AFTER_MS`), so runs that differ only because
the clock moved count once:
`~/.claude/state/estimate-log/<first 32 hex of sha256(absolute STATUS.md path)>.json` (outside every repo; `--log-dir` moves it):
`{"v":1,"at":"2026-11-15T09:51:44Z","status":"/abs/STATUS.md","open":["H2","H3"],"started":["2026-11-15T09:40Z",null],"sizes":["M","L"],"points":6,"closing":"measured","phase":"job","raw":[1.49,2.84],"printed":["2026-11-15T11:20Z","2026-11-15T12:45Z"]}`.
Ids and numbers only: never item text, prompts or transcript content. The file is 0600, never written through a link,
replaced whole through a temp file (two racing runs may lose a line, never the file), trimmed to the newest 200 entries
(`MAX_LOG_ENTRIES`) and 128 KiB; it never expires by age (a project paused for weeks keeps its track record). A refusal writes nothing; a `--now` run without
`--log-dir` neither reads nor writes it; the status line cache only reads it.

- Scoring (every run, written back): an entry is scored at the first delivery at or after it with all its open rows done by
  then, adding `actual`, `inside` (printed low <=
  delivery <= printed high) and `ratio` = [hours to the delivery / raw low, ... / raw high] (null where raw is 0). An id gone from the table is dropped
  and the rest scored (all gone: `"actual": "void"`). Ids are reused and the log never expires, so a kept row must still
  have the started the entry saw, to the minute (a row unstarted then may have started since); else the entry is
  `"actual": "rewritten"`. Void and rewritten entries stay in the log and are counted in the Track record line. Entries
  written before `started` existed are scored by id. Provisional and ignored deliveries score nothing.
- Factors, from 5 scored entries on, over the last 10: high = max(1, p90 of ratio high), low = min(1, p10 of ratio low),
  nearest rank. Printed range = now + [raw low x low, raw high x high], then rounded on the clock as above. The factors use
  the raw ratios and the track record the printed ranges, so the adjustment never feeds on itself. Target: 8 of 10 inside.
  The 5 and the 10 are judgment, not measured: 13 scored estimates over two projects cannot pick them.
- Two factor sets, by `phase`: `job` (first cycle) and `round` (follow-up round), each with its own Track record counts;
  an entry without `phase` is a job. One shared set would let each kind move the other's ends: in the
  14-15 Nov replay the lowest raw low ratio was a round's (0.77; first cycles 1.68 and up) and the rounds' high ratios
  (0.11-0.66) sat far below the first cycles' (0.87-1.03).

## Exit codes

2 means the file, a cell or a flag is wrong (fix it); 3 means the table reads fine but cannot support a number. Both write
to stderr only: no estimate figure ever reaches stdout. Transcript text is never printed.

| Code | Meaning |
| ---- | ------- |
| 0 | estimate printed on stdout |
| 2 | usage or parse error, one `<file>:<line>: <reason>` per problem (below), unreadable file, bad flag, bad `--now`, bad `--transcripts` |
| 3 | refusal: `No finish time: ...` then `What to do: ...` (below) |

Exit 2 messages and what to do:

| Message | Add or fix |
| ------- | ---------- |
| `no "## Work items" table found` / `no table header under "## Work items"` | add the heading and the table |
| `two Work items sections, lines N and M; keep one` | merge the sections into one |
| `table row after a break at line N; keep one table` | remove the blank or text line N inside the table, or move the row up |
| `this looks like a table row but does not start with \`\|\`` | start the row with `\|` and keep it inside the table |
| `table header must be \| id \| item \| size \| started \| done \| evidence \|` | use the six columns in that order (no extra column) |
| `the line under the header must be the separator` | add `\| -- \| ---- \| ... \|` under the header |
| `row has N cells, expected 6` | one cell per column; write a pipe inside a cell as `\|` |
| `<id>: the id cell is empty`, `<id>: id repeated (ignoring case), first on line N` | give each row its own id |
| `<id>: size "X" is not S, M or L` | use S, M or L (upper case) |
| `<id>: started "X" is not a real ISO 8601 instant; accepted: ...` (same for `done`) | write e.g. `2026-11-14T10:45Z` |
| `<id>: done is not after started` | correct the two times |
| `<id>: done without evidence ...`, `<id>: evidence "x" is a placeholder ...` | add a commit sha, file path or `check: <cmd> PASS` |
| `--now "X" is not a real ISO 8601 instant` | pass an instant like `2026-11-14T12:00Z` |
| `--transcripts <path> is not a folder that exists`, `cannot read transcript <file>: EACCES ...` | fix the path or the permissions, or drop the flag |

Exit 3 message: `No finish time: <sentences>` then `What to do: <sentences>`, each only when it applies:

| Reason | What to do |
| -------- | ---------- |
| `N done items with started, done and evidence; need 5.` | finish and record more rows |
| `Missing started on: M1 (line 41), ...` | fill started of those rows with the real start, or delete the row |
| `Later than now (<now>): F1 (line 12) started <time>, ...` | correct the time from the clock (`date -u +%Y-%m-%dT%H:%MZ`), never from memory, or pass the right `--now` |
| `No working time left after removing usage-limit windows: D1 (line 7), ...` | correct started and done of those rows: they lie inside usage-limit windows |
| `the closing phase has run 2.5 h since the last build row was done (H2, 14:13), longer than the default closing (1.4-2.5 h, not yet measured here).` | tell the owner the job is past its usual closing; this ends at delivery, whose length then joins the history. Work not in the table: add it as a row first |
| `the follow-up round has run 4 h since it started (V1, 05:30), longer than the default round (0.4-2.6 h, not yet measured here), and its open rows are past their measured rates.` | tell the owner the follow-up round is past its usual length; this ends at delivery, whose round length then joins the history. Work not in the table: add it as a row first |
| `every row of the follow-up round after the delivery at 05:00 (started 05:30, R1) is done, and no deliver: row marks its hand-over.` | if you handed the job over, add a deliver: row with its done time; if work remains, add it as rows |

Long lists show the first five rows and `and N more`.

## Status line segment

The status line shows `done ~14:50-16:15` (the Finish range on the local clock; `done ~Sun 00:50-02:25` when both ends are
on another day, `done ~Sun 23:20 - Mon 01:10` when they are on different days) for the project whose `<project dir>/STATUS.md` the tool accepts. Nothing is shown when there is no STATUS.md,
the tool refuses (exit 3) or fails (exit 2), or the job is delivered. The status line never computes it: it reads one cache file,
`~/.claude/state/estimate-segment/<sha256 of the STATUS.md path>.json`
(`{path, text, highMs, mtimeMs, size, computedAt, refreshStartedAt}`; `text` and `highMs` are null after a refusal), and shows
the text while the file's mtime and size still match, or for 15 minutes (`STALE_SHOW_MS`) after a change while a refresh runs,
never after the printed high end (`highMs`) has passed. On a daylight-saving fall-back night, when both ends fall on the
same local date, the segment shows the two clock times as they are, so the high end can read earlier than the low end
(`01:50-01:05`); line 1 of the CLI has the same limit. When the cache is missing, no longer matches or is 5 minutes old
(`RECOMPUTE_AFTER_MS`: the finish moves with the clock even when the table does not), the render stamps `refreshStartedAt` and starts `statusline-cache.mjs <STATUS.md>` detached, at
most once per 2 minutes (`REFRESH_INTERVAL_MS`) per file; that script runs the same lib as the CLI (transcripts included) and
writes the cache atomically (0600, never through a link). The constants are in `lib/segment-cache.mjs`.

## Layout

`estimate.mjs` (CLI: arguments, file reads, exit codes) over `lib/items.mjs` (table parser, row kinds), `lib/limits.mjs` (windows,
slug), `lib/history.mjs` (deliveries, closing tails, reopened deliveries), `lib/compute.mjs` (formula), `lib/calibration.mjs` (scoring,
factors, track record), `lib/estimate-log.mjs` (the log file) and `lib/report.mjs` (text, local clock); `lib/from-files.mjs` reads the files for the CLI and for `statusline-cache.mjs`
(refreshes the status line cache), `lib/segment-cache.mjs` is the status line's read side. Tests: `tests/estimate.test.mjs`,
`tests/estimate-finish.test.mjs`, `tests/estimate-calibration.test.mjs`, `tests/estimate-replay.test.mjs` (with `tests/estimate-replay-cases.mjs`: two real tables of
14-15 Nov as ids, sizes and times only, and the exact Finish line each request must print; replay V9 is in-sample, since
its round is one of the three the round default comes from, so it shows consistency, not predictive accuracy), `tests/estimate-cli.test.mjs`,
`tests/statusline-estimate.test.mjs`.
