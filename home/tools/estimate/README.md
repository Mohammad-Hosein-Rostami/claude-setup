# estimate

Turns the `## Work items` table of a `STATUS.md` plus the project's lead transcripts into a range of agent-hours,
running time and calendar days, so the lead never quotes an estimate from intuition. Node 22, no dependencies.

Run: `node ~/.claude/tools/estimate/estimate.mjs STATUS.md [--transcripts <dir>] [--now <iso>]` and paste the output as-is.
If it refuses (exit 3), say what is missing; never give a number of your own.

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
- started / done: a real ISO 8601 instant: `YYYY-MM-DDTHH:MM[:SS[.fff]]` followed by `Z` or an offset `+HH:MM` / `-HH:MM`
  (`date -u +%FT%RZ`), e.g. `2026-11-14T10:45Z`; `-` when empty. A bare date, `10:45` without a date, `2026-02-30`, month 13
  and `T24:00` are errors (checked by a strict pattern plus a calendar round trip, never shifted to another day).
  `done` must be after `started`, and neither may be later than `--now` (default: the real clock).
- Done = `done` set and evidence non-empty (commit sha, file path or `check: <cmd> PASS`). A dropped open item: delete the row.
- Rows without `done` are the remaining work; in-flight rows (`started`, no `done`) count whole.
- Exactly one `## Work items` section, and in it one contiguous table: the header (the six names in order, case and
  spaces ignored), the separator line, then the rows with no blank or text line between them. Anything that cannot be
  read is an error naming the line; no row is skipped. Ids are unique ignoring case. Write a pipe inside a cell as `\|`
  (a pipe inside backticks still splits the cell). Backticks, CRLF line ends and a UTF-8 BOM are fine.
  Tables inside code fences are ignored; the table section ends at the next heading.

## Formula

- Per done item: d = (done - started) minus its overlap with usage-limit windows; r = d / points (hours per point).
- Needs at least 5 done items with started, done and evidence. The range of r is the slowest and fastest item while there
  are fewer than 10 done items; from 10 it is the nearest-rank p25..p75 band (rank = ceil(p x n)). The median (p50) is
  printed beside it.
- Agent-hours = open points x that range.
- The rate is wall-clock time from started to done: waiting and nights inside an item stay in it. Only usage-limit windows
  found in the transcripts are taken out.
- L = sum(d) / length of the union of the done intervals minus limit windows (measured lanes); lanes used = min(L, open rows).
  Running time = agent-hours / lanes used.
- a = that union / span (first started .. last done). Calendar days = running time / a / 24. The usage-limit idle share
  (limit time inside the span / span) is printed; it is already inside a.

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
Estimate (computed <now> by estimate.mjs from <path>)
Remaining: 9 items, 17 points (3 in flight, counted whole)
Agent-hours: 14-24 (median 18; range from the slowest and fastest of 8 finished items)
Running time: 5-8 h at 2.9 lanes (measured)
Calendar: 0.4-0.7 days (active 46% of elapsed; usage-limit idle 21%)
Rate: wall-clock time from started to done, so it includes waiting and nights; only usage-limit windows found in the transcripts are taken out.
From: 8 done items <first>..<last>, 1.1-1.9 h/point (fastest-slowest), 2 limit windows (5.9 h) in 3 transcripts
Note: the newest started or done in the table is 3.9 days old (2026-11-10T13:00Z); update STATUS.md if work happened since.
```

- With 10 or more done items the label reads `p25-p75 band of N finished items` and the From line `(p25-p75)`. When every rate is
  equal the label adds `all rates equal, real spread unknown`.
- The `Note:` line appears only when the newest `started` or `done` is more than 24 h before `--now` and rows remain open.
- No transcripts: the limit part says `usage-limit idle: not measured (no transcripts at <dir>)`, durations are not reduced,
  the Rate line says so, the calendar line is still printed.
- Nothing open: `Remaining: 0 items` and `Nothing remaining: ...`, no hours lines (exit 0).
- When open rows cap the lanes the running line says `(measured 2.0, capped by open items)`.

## Exit codes

2 means the file, a cell or a flag is wrong (fix it); 3 means the table reads fine but cannot support a number. Both write
to stderr only: no estimate figure ever reaches stdout. Transcript text is never printed.

| Code | Meaning |
| ---- | ------- |
| 0 | estimate printed on stdout |
| 2 | usage or parse error, one `<file>:<line>: <reason>` per problem (below), unreadable file, bad flag, bad `--now`, bad `--transcripts` |
| 3 | refusal: `No estimate: ...` (below) |

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

Exit 3 message: `No estimate: <sentences>`, each sentence only when it applies:

| Sentence | Add or fix |
| -------- | ---------- |
| `N done items with started, done and evidence; need 5.` | finish and record more items |
| `Missing started on: M1 (line 41), ...` | fill `started` of those rows (the real start, or delete the row) |
| `Later than now (<now>): F1 (line 12) started <time>, ...` | correct the time, or pass the right `--now` |
| `No working time left after removing usage-limit windows: D1 (line 7), ...` | correct `started`/`done` of those rows: they lie inside limit windows |

Long lists show the first five rows and `and N more`.

## Status line segment

The status line shows `est 3-5h left` (the running-time range of the open work, in the report's own rounding) for the project
whose `<project dir>/STATUS.md` the tool accepts. Nothing is shown when there is no STATUS.md, the tool refuses (exit 3) or
fails (exit 2), or nothing is left. The status line never computes it: it reads one cache file,
`~/.claude/state/estimate-segment/<sha256 of the STATUS.md path>.json`
(`{path, text, mtimeMs, size, computedAt, refreshStartedAt}`; `text` is null after a refusal), and shows the text while the
file's mtime and size still match, or for 15 minutes (`STALE_SHOW_MS`) after a change while a refresh runs. When the cache is
missing or no longer matches, the render stamps `refreshStartedAt` and starts `statusline-cache.mjs <STATUS.md>` detached, at
most once per 2 minutes (`REFRESH_INTERVAL_MS`) per file; that script runs the same lib as the CLI (transcripts included) and
writes the cache atomically (0600, never through a link). Both constants are in `lib/segment-cache.mjs`.

## Layout

`estimate.mjs` (CLI: arguments, file reads, exit codes) over `lib/items.mjs` (table parser), `lib/limits.mjs` (windows,
slug), `lib/compute.mjs` (formula) and `lib/report.mjs` (text); `lib/from-files.mjs` reads the files for the CLI and for `statusline-cache.mjs`
(refreshes the status line cache), `lib/segment-cache.mjs` is the status line's read side. Tests: `tests/estimate.test.mjs`,
`tests/estimate-cli.test.mjs`, `tests/statusline-estimate.test.mjs`.
