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
- started / done: ISO 8601 with `Z` or a `+HH:MM` offset (`date -u +%FT%RZ`); `-` when empty. `10:45` without a date
  and offset is an error.
- Done = `done` set and evidence non-empty (commit sha, file path or `check: <cmd> PASS`). A dropped open item: delete the row.
- Rows without `done` are the remaining work; in-flight rows (`started`, no `done`) count whole.
- Tables inside code fences are ignored; the table ends at the next heading or the first non-table line.

## Formula

- Per done item: d = (done - started) minus its overlap with usage-limit windows; r = d / points (hours per point).
- R = nearest-rank p25 / p50 / p75 of r (rank = ceil(p x n)), needs at least 5 done items with started, done and evidence.
- Agent-hours = open points x R.
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
project run from a subfolder). `--transcripts` overrides. The slug rule is unverified on Windows (drive letters and
backslashes); pass `--transcripts` there.

## Output

```
Estimate (computed <now> by estimate.mjs from <path>)
Remaining: 9 items, 17 points (3 in flight, counted whole)
Agent-hours: 14-24 (median 18)
Running time: 5-8 h at 2.9 lanes (measured)
Calendar: 0.4-0.7 days (active 46% of elapsed; usage-limit idle 21%)
From: 14 done items <first>..<last>, 1.1-1.9 h/point (p25-p75), 2 limit windows (5.9 h) in 3 transcripts
```

No transcripts: the limit part says `usage-limit idle: not measured (no transcripts at <dir>)`, durations are not reduced,
the calendar line is still printed. Nothing open: `Remaining: 0 items` (and no hours lines). When open rows cap the lanes
the running line says `(measured 2.0, capped by open items)`.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | estimate printed on stdout |
| 2 | usage or parse error on stderr, one `<file>:<line>: <reason>` per bad row (no table, unknown size, bad timestamp, done before started, done without evidence), unreadable file, bad flag or `--now` |
| 3 | refusal on stderr: `No estimate: 3 done items with started, done and evidence; need 5. Missing started on: M1 (line 41).` No estimate number is printed |

## Layout

`estimate.mjs` (CLI: arguments, file reads, exit codes) over `lib/items.mjs` (table parser), `lib/limits.mjs` (windows,
slug), `lib/compute.mjs` (formula) and `lib/report.mjs` (text). Tests: `tests/estimate.test.mjs`, `tests/estimate-cli.test.mjs`.
