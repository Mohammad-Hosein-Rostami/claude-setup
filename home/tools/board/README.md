# board

What runs in a session, what waits on the owner and the git state, in one small file the status line, `/where` and the
progress pane read (`~/.claude/state/board/<session>.json`, at most 16 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs [--session <id>] [--columns <n>]` prints the board (session default
`CLAUDE_CODE_SESSION_ID`, width default 80). `board.mjs refresh --session <id> [--force]` rewrites the file; `status.mjs add|start|done`
starts it detached after every changed edit. `board.mjs where [--columns <n>] [--project <dir>]` prints the `/where` tree
(`lib/tree.mjs`, display design 6.3): all work, the road and its steps (the current step with its likely and 85% clocks), the
runs, what waits on the owner, git, one limits line per account, and the session's cost figure from its last-seen file.

| Line | From |
| ---- | ---- |
| `needs you: 2 questions · default in 0:45` | the asking marker (`hooks/lib/asking-marker.mjs`) |
| `api-redo · phase 2/4 Review · 2 Build, 1 Review · run` | the run's journal (`estimate/lib/workflow-runs.mjs boardRuns`): lanes per phase, named counts |
| `... · quiet 5 min`, `... · stopped? 34 min` | the journal's last write: quiet from 2 min, `stopped?` from 30 min (a killed run writes no summary) |
| `+1 more run` | more than 4 runs |
| `git lane/x +2 -0 · 3 changed` | `git status --porcelain=v2 --branch` (250 ms timeout; `git-tidy check` never runs here) |
| `limits work: 5h 100% (resets 17:40), 7d 12%, seen 2 min ago` | each account's last-seen limits file (`estimate/lib/limits-store.mjs`); the board only shows them and never moves work to another account |
| `stale 40 s` | the last refresh ran over its 300 ms budget, so the old data stayed |

A refresh runs one at a time (a claim in the file), at most every 10 s while a run is live and every 60 s when idle. Journals and
transcripts are Claude Code's internal formats: an unreadable part shows nothing, never a wrong line, and never throws.

Not yet shown: `failed` and `done, not landed` (they need the launch records of the resume tool) and the tidy-gate verdict.

The status line claims a refresh in the file when one is due (`claimBoardRefresh`) and starts it with `--force`, so idle sessions
get a board too and renders never stack refreshes.

Files: `board.mjs` (the CLI and the lines), `lib/refresh.mjs` (build, refresh, the board file, the claim, the detached start),
`lib/render.mjs` (the status line rows: alert and session rows; `home/statusline.mjs` only reads and writes), `lib/work-row.mjs`
(the work row: the job against its estimate and the running work), `lib/cells.mjs` (look, glyphs, bars, durations, clocks, fitting
a row to a width; shared by every surface), `lib/tree.mjs` (the `/where` tree).
