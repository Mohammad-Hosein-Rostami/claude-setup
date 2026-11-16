# status

Edits the `STATUS.md` of the current folder so nobody rewrites its rows by hand (a live session spent 78 python/sed edits on it).
Node 22, no dependencies. The times it writes are UTC to the minute, the form the `estimate` tool reads; it reads rows with the
estimate tool's own row reader, so a table it can edit is a table the estimator can read.

Run: `node ~/.claude/tools/status/status.mjs [--file STATUS.md] <command>`

| Command | What it does |
| ------- | ------------ |
| `add <id> <item> <size>` | New row at the end of the `## Work items` table (made when there is none); size `S`, `M` or `L`; `started` stays empty: list the job's rows first. An id that exists (any case) is refused, and so is an id starting `deliver:` (reserved for hand-overs). |
| `start <id>` | `started` = now, when work on the row begins. A row already started or done is refused. |
| `done <id> <evidence>` | `done` = now, evidence set (added after an existing one with `; `). A row never started gets `started` = now too, costs 0 minutes, and the message says to use `start`. A row whose `done` is set is refused: never clear or change a done cell, add a new row for a correction. |
| `deliver "<what>"` | A hand-over row: `deliver:N \| deliver: <what> \| S \| - \| <now> \| -`, N one above the highest `deliver:` number in the table. Use it to hand over a part while rows stay open. |
| `deliver --auto` | The same row (item `deliver: turn ended with no open row`), written only when the table reads with no problem, no work row is open (listed or running) and at least one was done after the last `deliver:` row; otherwise nothing changes, exit 0, and the message says why. The Stop hook `hooks/status-deliver.mjs` runs it on the session's linked STATUS.md, so a hand-over is recorded by itself when a turn ends with nothing open. |
| `rule "<text>"` | Bullet at the end of `## Standing rules`; the same text twice is added once. |
| `decision "<text>"` | Dated bullet at the end of `## Owner decisions`. |

Only the one table under `## Work items` is read and edited: its header `id | item | size | started | done | evidence` and the
rows right below its separator. A work row anywhere else (for example after `## Owner decisions`) is never found by `start` or
`done`; the estimate tool reports it as a problem that names its line, so move it into the table by hand once.

A missing section is created. The table may have outer pipes (`| a | b |`) or none (`a | b`); a new row copies the style of the header.
Exit 0 done, 1 refused (reason on stderr), 2 usage. `--file` goes before the command; the clock is always the system's (no flag
back-dates a row). An id is one word of letters, digits and `_ . : -` (`7`, `close:5`, `rework:12`).

After every edit that changed the file it records the table for the estimator (`noteTable` in `home/tools/estimate/lib/table-store.mjs`:
the rows' first-seen times, and the link from the session in `CLAUDE_CODE_SESSION_ID` to this STATUS.md, under
`~/.claude/state/estimate/`). When that store is busy or unusable the edit still stands and the message ends with
`not recorded for the estimate (...)`; the next estimate run records it.

Parallel runs are safe: each edit takes a lock file (`STATUS.lock` next to the file, gone after the edit; one left by a killed run is
removed after 0.5 s) and writes a new temp file renamed over the old one. A run that waits over a second for the lock is refused with
exit 1: run it again. A `STATUS.md` that is a link or not a regular file is refused.

Not covered: changing a row's size or item, deleting a row.
