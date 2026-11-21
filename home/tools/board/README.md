# board

What runs in a session, which agent works on what and how far it is, what waits on the owner and the git state of every
worktree, in one small file the status line, `/where` and the progress pane read (`~/.claude/state/board/<session>.json`, at
most 48 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs [--session <id>] [--columns <n>]` prints the board (session default
`CLAUDE_CODE_SESSION_ID`, width default 80). `board.mjs refresh --session <id> [--force]` rewrites the file; `status.mjs add|start|done`
starts it detached after every changed edit. `board.mjs where [--columns <n>] [--project <dir>]` prints the `/where` tree
(`lib/tree.mjs`, display design 6.3): all work, the road and its steps (the current step with its likely and 85% clocks), the
status line's counts, workflow, agent and git rows with nothing folded, what waits on the owner, one limits line per account,
and the session's cost figure from its last-seen file.

## The status line rows

`home/statusline.mjs` prints between 2 and 12 rows: `clamp(floor(LINES / 3), 3, 12)` (a 24-line terminal gives 8), each fitted
to `COLUMNS - 5` (Claude Code cuts a row there). From top to bottom:

| Row | Example (120 columns) | From |
| --- | --- | --- |
| alert, only when needed | `! WAITING FOR YOUR ANSWER: a question, recommended taken in 1:39` | the asking marker, an estimate error, the 5 h pace |
| job | `ALL ████████░░░░░░░░  52% of work · 2 h 10 left · done by 17:45 · 85%: 18:20 · 11/21 rows` | the estimate cache |
| counts | `2 workflows (2 run, 0 paused) · 6 agents (6 run) · 1 over usual │ git 4 branches · 2 not landed` | the board |
| workflow | `▸ build · for R2 terminal UI · phase 2/4 Build · ████░░░░░░ 0/4 done · 4 run · ~40 min left · 16:35` | the board's runs |
| agent | ` ├ impl-a  implementer  █████▒░░ ~70% · 8 min left · 16:03 · Edit tree.mjs · r9-a ↑2 ●3 · 31 calls` | the board's agents |
| git | `git main ✓ │ r9-a ↑2↓0 ●3 impl-a,tests-a · r9-b ↑1↓0 ●3 impl-b · old-x ✓ old 3 d ⚠` | the board's repo |
| session | `Opus 5.5 high · ctx 99k of 400k (25%) · 5h 54% left, resets 17:40 · 7d 69% left · acct work` | the status input |

When rows run out (`lib/layout.mjs`): the counts row goes first; each workflow folds into its header with a spark strip of its
agents (`▇▆▄·`), the most urgent agents keep a row (quiet, over their usual time, writers, readers, then the soonest finish) and
the rest share one `+K more` row; with fewer rows still, one strip row carries every group. Finished agents show for 30 s,
then only the counts row has them (10 min). From 150 columns two agents share a row. Work rows come before git rows; the
session row is always last. On an error while drawing, the session row and one `status line error:` line still print.

### An agent's progress (`lib/progress.mjs`)

The bar is evidence, never the agent's own words: the brief's numbered steps done by commits (3 or more steps), else milestones
(writers: first Read, Edit, check run, commit, report written; readers: calls past the type's usual first quarter, a file
written, a long answer), blended with the elapsed time against finished agents of its type that ran longer than this one so far
(`lib/pools.mjs`, rebuilt hourly from this machine's transcripts). The form says how sure it is: `62%` (steps and a pool of 20
or more), `~60%` (a steady pool or 2 milestones), `est…` with a moving ▒ and the usual time otherwise and in the first minute.
It never goes down unless steps were added (`+steps`), shows 100% only when the agent is done, and `over usual by 9 min` (▓)
past the type's 85th percentile. `quiet 4 min` after 3 min without a write and no call waiting for its result.

## The refresh

A refresh runs one at a time (a claim in the file), at most every 5 s while a run or an agent is live and every 60 s when idle
(the status line's `refreshInterval` is 5 s). It reads, and keeps its cursors in `~/.claude/state/board-cache/<session>.json`:

- the subagent transcripts (`<session>/subagents/agent-<id>.jsonl` and `workflows/<run>/agent-<id>.jsonl`), only their new
  bytes since the last refresh, with their `.meta.json` (type, description, worktree) (`lib/agent-transcript.mjs`, `lib/agents.mjs`);
- each workflow run's journal (`estimate/lib/workflow-runs.mjs`) and the workflow registry (what the run is for);
- the writer launch records (`hooks/lib/writer-agents.mjs`: an agent's STATUS row);
- git (`lib/git-state.mjs`): `worktree list` when the worktree folder changed, one `for-each-ref` with `%(ahead-behind:main)`
  every 15 s, and `--no-optional-locks status --untracked-files=no` per worktree only when its index or HEAD changed (15 s at
  most); 250 ms timeout per call and 250 ms of git per refresh, past which the old values stay with their age.

A refresh over its 300 ms budget keeps the old board and marks it `stale N s` (the cursors it read are kept, so the next one
reads only new bytes). After the write, the agent-type pools are rebuilt when an hour old (`~/.claude/state/board-cache/pools.json`,
at most 4 s of scanning). Journals, transcripts and meta files are Claude Code's internal formats: an unreadable part shows
nothing, never a wrong line, and never throws.

Not yet shown: `failed` and `done, not landed` runs, the tidy-gate verdict, and which agent a question comes from (the asking
marker holds no agent).

Files: `board.mjs` (the CLI and the lines), `lib/refresh.mjs` (build, refresh, the board file, the claim, the detached start),
`lib/agents.mjs`, `lib/agent-transcript.mjs`, `lib/progress.mjs`, `lib/pools.mjs`, `lib/git-state.mjs`, `lib/cache-file.mjs` (what
the refresh reads), `lib/render.mjs` (the status line rows; `home/statusline.mjs` only reads and writes), `lib/work-row.mjs` (the
job row), `lib/layout.mjs` (row budget, counts row, packing), `lib/agent-rows.mjs` (workflow and agent rows), `lib/git-rows.mjs`
(git rows), `lib/cells.mjs` (look, glyphs, bars, durations, clocks, fitting a row to a width; shared by every surface),
`lib/tree.mjs` (the `/where` tree).
