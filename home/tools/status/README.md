# status

Edits the `STATUS.md` of the current folder so nobody rewrites its rows by hand (a live session spent 78 python/sed edits on it).
Node 22, no dependencies. The times it writes are UTC to the minute, the form the `estimate` tool reads.

Run: `node ~/.claude/tools/status/status.mjs [--file STATUS.md] <command>`

| Command | What it does |
| ------- | ------------ |
| `add <id> <item> <size>` | New row at the end of the `## Work items` table (made when there is none); size `S`, `M` or `L`; `started` = now. An id that exists (any case) is refused. |
| `done <id> <evidence>` | `done` = now, evidence set (added after an existing one with `; `), `started` = now when it was empty. A row whose `done` is set is refused: never clear or change a done cell, add a new row for a correction. |
| `rule "<text>"` | Bullet at the end of `## Standing rules`; the same text twice is added once. |
| `decision "<text>"` | Dated bullet at the end of `## Owner decisions`. |

A missing section is created. The table may have outer pipes (`| a | b |`) or none (`a | b`); a new row copies the style of the header.
Exit 0 done, 1 refused (reason on stderr), 2 usage. `--now <ISO instant>` replaces the clock (tests).

Not covered: `deliver:` rows (edit by hand: only its done time), changing a row's size or item, deleting a row.
