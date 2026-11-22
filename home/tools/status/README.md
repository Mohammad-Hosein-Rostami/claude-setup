# status

Edits the `STATUS.md` of the current folder so nobody rewrites its rows by hand (a live session spent 78 python/sed edits on it).
Node 22, no dependencies. The times it writes are UTC to the minute, the form the `estimate` tool reads; it reads rows with the
estimate tool's own row reader, so a table it can edit is a table the estimator can read.

Run: `node ~/.claude/tools/status/status.mjs [--file STATUS.md] <command>`

| Command | What it does |
| ------- | ------------ |
| `add <id> <item> <size>` | New row at the end of the `## Work items` table (made when there is none); size `S`, `M` or `L`; `started` stays empty: list the job's rows first. An id that exists (any case) is refused, and so are an id and an item starting `deliver:` (reserved for hand-overs: such an item would make the row one). |
| `start <id>` | `started` = now, when work on the row begins. A row already started or done is refused. |
| `done <id> <evidence>` | `done` = now, evidence set (added after an existing one with `; `). A row never started gets `started` = now too, costs 0 minutes, and the message says to use `start`. A row whose `done` is set is refused: never clear or change a done cell, add a new row for a correction. |
| `deliver "<what>"` | A hand-over row: `deliver:N \| deliver: <what> \| S \| - \| <now> \| -`, N one above the highest `deliver:` number in the table. Use it to hand over a part while rows stay open. |
| `defect <id> "<conditions>"` | The owner reported row `<id>` broken (a done row too): `[defect <n>]` at the end of its item, n one above the last mark. The first report says to reproduce, fix the root cause and add a regression test; the second adds a `rootcause:<id>` row (once): reproduce under the owner's conditions, then `deep-debugger` before any fix (`defect.mjs`). |
| `deliver --auto` | The same row (item `deliver: turn ended with no open row`), written only when the table reads with no problem, no work row is open (listed or running) and at least one was done after the last `deliver:` row; otherwise nothing changes, exit 0, and the message says why. The Stop hook `hooks/status-deliver.mjs` runs it on the session's linked STATUS.md, so a hand-over is recorded by itself when a turn ends with nothing open. |
| `rule "<text>" [--scope job\|project\|always] [--supersedes R<n>]` | Bullet at the end of `## Standing rules`: the owner's words, then `{R<n> <date> <scope>}` (scope default `always`; a bullet already tagged `job` or `project` still reads). With `--supersedes R<m>` the new bullet says `supersedes R<m>` and R<m> is marked `superseded by R<n>`, never deleted. The same text as an active rule is added once. A bullet without the tag is an active rule with no id. |
| `decision "<text>"` | Dated bullet at the end of `## Owner decisions`. |
| `next <id> "<step>"` | The row's next step as `- <id>: <step>` under `## Next steps`, replaced in place by a newer one for the same row. |
| `show` | Where the job stands in at most 5 lines: rows done, running and not started, the open ids, and the finish time the estimate cache holds (`status-show.mjs`; it computes no time and writes nothing; a cache that does not match the file says so). |
| `log "<text>"` | One dated line in `STATUS.log.md` beside `STATUS.md` (`status-log.mjs`); `STATUS.md` is not touched. In a git repo the log file is put into `info/exclude` first; when `STATUS.md` itself is tracked the log is refused with exit 2. |

Several rows in one call (`status-batch.mjs`): `add a1 "item one" S + a2 "item two" M`, `start a1 a2 a3`, `done a1 "evidence" +
a2 "evidence"`. All or nothing: the first refused group stops the call before anything is written.

`done` takes predictor flags anywhere after the id: `--model`, `--effort`, `--files-planned`, `--suite-s`, `--review-rounds`,
`--writers` (`status-predictors.mjs`). Each done row then gets one line in `~/.claude/state/estimate/predictors/<table id>.jsonl`
with the flags and the files and lines git changed since the row started; a failure there never fails the edit.

After a changed `add`, `start` or `done` the estimate refresh starts at once (`refreshNow` in
`home/tools/estimate/lib/segment-cache.mjs`), so the status line does not lag the edit; a refresh already running is not doubled.

Only the one table under `## Work items` is read and edited: its header `id | item | size | started | done | evidence` and the
rows right below its separator. A work row anywhere else (for example after `## Owner decisions`) is never found by `start` or
`done`; the estimate tool reports it as a problem that names its line, so move it into the table by hand once. Headings and
tables inside code fences (an example table in ```` ``` ```` ) are skipped, as the estimate tool skips them: both use
`findSection` from `home/tools/estimate/lib/items.mjs`, so they always see the same table and the same `## Standing rules` and
`## Owner decisions` sections.

A missing section is created, except below a code fence that is never closed: everything after it is hidden from the estimate tool,
so the edit is refused (`unclosed code fence at line N`) and the fence must be closed first. The table may have outer pipes (`| a | b |`) or none (`a | b`); a new row copies the style of the header.
Exit 0 done, 1 refused (reason on stderr), 2 usage. `--file` goes before the command; the clock is always the system's (no flag
back-dates a row). An id is one word of letters, digits and `_ . : -` that starts with a letter or digit (`7`, `21a`, `close:5`,
`rework:12`); a leading `-` would make the row read as a bullet.

The usage text and every `add` print the row rules (`ROW_RULES` in `status.mjs`). One of them: a lane of work is one row, and its landing
is that row's done evidence (`land-lane --close-row <the lane's row>` writes `landed <to> on <base> from <from>`); there is no `close:` twin
row to land it, so the row's time is the lane's real duration. Review and fix rows (`close:`, `rework:`) stay rows of their own.

After every edit that changed the file it records the table for the estimator (`noteTable` in `home/tools/estimate/lib/table-store.mjs`:
the rows' first-seen times, and the link from the session in `CLAUDE_CODE_SESSION_ID` to this STATUS.md, under
`~/.claude/state/estimate/`). When that store is busy or unusable the edit still stands and the message ends with
`not recorded for the estimate (...)`; the next estimate run records it.

Parallel runs are safe: each edit takes a lock file (`.STATUS.status-lock` next to the file, `.<name>.status-lock` for `--file
<name>.md`, a name no other tool uses; gone after the edit). The lock holds the run's pid and a random token: a run removes it only
while it still holds its own token, and one left by a killed run (pid gone, or no token) is removed after 0.5 s, one of a live pid
only after 5 s (one waiter at a time removes it, behind `<lock>.break` next to it). A run that waits over a second for the lock is refused with exit 1: run it again. A link, FIFO or folder at the lock's name (or its `.break` file) is refused at once with the path to remove. `status-file.mjs` reads the file
through one handle that never follows a link or waits on a FIFO and writes a new temp file renamed over the old one. A `STATUS.md`
that is a link, not a regular file, or over 4 MiB is refused.

Files: `status.mjs` (the commands and the lock), `status-table.mjs` (finding and writing rows of the one table),
`status-file.mjs` (the checked read and the temp-file write), and the four files above.

Not covered: changing a row's size or item, deleting a row.

`status-bullets.mjs` holds the rule, decision and next-step formats (writer and reader). `status-digest.mjs` builds the
STATUS.md half of the digest that `hooks/recall-digest.mjs --part rules|state` prints, in two strings: the rules on every
SessionStart (startup, compact, resume) and on PreCompact, the state on SessionStart (compact, resume) and on PreCompact. The
rules string never passes `RULES_CAP` (9,000 chars, room for the frame under the hook's 10,000-char cap): the always and project
rules (a bullet without a tag counts as always) in file order, then the job rules newest first, then one line counting the
replaced rules. When that is too long, the rules that do not fit are left out from the end of that order and the last line says
`<n> job rules not shown: read <path>`, or, when always or project rules are left out too,
`<n> always or project rules and <m> job rules not shown (the rules pass the 9000-char bound): read the full list in <path>`.
A rule is never cut mid-text. The other string holds the open rows with next steps, the "Don't redo" list of the HANDOFF.md
beside it, the latest decisions and git facts, trimmed to stay under 10,000 chars. The STATUS.md is the one linked to the
session, else the project's, else the cwd's.

`rules-size.mjs` (`rulesDigestBudget(stateDir)`) measures that rules string for every STATUS.md the estimate store points to
(each session link and each table): `hooks/token-audit.mjs --budget` prints one line per file, `fail` when always or project
rules are left out (owner instructions lost), `warn` when only job rules are, else `ok`
(`rules digest <n> chars (bound 9000)...: <path>`), or `ok\trules digest: no linked STATUS.md`, and `scripts/doctor.sh` shows
them under "token budget". A STATUS.md that no longer exists is skipped.
