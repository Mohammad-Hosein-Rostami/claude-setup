# board

What runs in a session, which agent works on what and how far it is, what waits on the owner and the git state of every
worktree, in one small file the status line, `/where` and the progress pane read (`~/.claude/state/board/<session>.json`, at
most 48 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs [--session <id>] [--columns <n>]` prints the board (session default
`CLAUDE_CODE_SESSION_ID`, width default 80). `board.mjs refresh --session <id> [--force]` rewrites the file; `status.mjs add|start|done`
starts it detached after every changed edit. `board.mjs where [--columns <n>] [--project <dir>]` prints the `/where` tree
(`lib/tree.mjs`, display design 6.3): all work, the road and its steps (the current step with its likely and 85% clocks), the
status line's road, counts, checks, workflow, agent and git rows with nothing folded (each workflow's agents listed under it), what waits on the owner, one limits line per account,
and the session's cost figure from its last-seen file.

## The status line rows

`home/statusline.mjs` prints between 2 and 12 rows: `clamp(floor(LINES / 3), 3, 12)` (a 24-line terminal gives 8), each fitted
to `COLUMNS - 5` (Claude Code cuts a row there). From top to bottom:

| Row | Example (120 columns) | From |
| --- | --- | --- |
| alert, only when needed | `! WAITING FOR YOUR ANSWER: a question, recommended taken in 1:39` | the asking marker, an estimate error, the 5 h pace |
| road, when the job walks one | `road p8 · step 1/12 honest suite · 2/5 lanes · step 40 min left · by 21:10 · 85%: 21:35` | the estimate cache's road numbers, the board's road (`lib/job-facts.mjs`) |
| job | `ALL ████████░░░░░░░░  52% of work · 2 h 10 left · done by 17:45 · 85%: 18:20 · ↑ +1h10 later · 11/21 rows` | the estimate cache, the board's trend |
| counts, while work runs | `2 workflows (2 run, 0 paused) · 6 agents (6 run) · 1 over usual │ git 4 branches · 2 not landed` | the board |
| checks | `checks: types review ui probe · off: smart test │ suite 3628 · 222 fail` | the session's `/check` switch, the board's suite (`lib/repo-stats.mjs`) |
| workflow, one row each | `▸ build · for R2 terminal UI · phase 2/4 Build · ████░░░░░░ 0/4 done · 4 run ▆▄·· · ~40 min left · 16:35` | the board's runs |
| agent | ` ├ Write road file for…   architect   █████▒░░ ~70% · 8 min left · 16:03 · claude-setup:lane/road-p8 2↑ +1 dirty` | the board's agents and repositories |
| git, at least one row | `git claude-setup:main ✓ · origin ↑0↓0 · landed today 6, last 12 min ago │ r9-a ↑2↓0 ●3 impl-a · old-x ✓ old 3 d ⚠` | the board's repo and repos |
| session | `Opus 5.5 high · ctx 99k of 400k (25%) · 5h 54% left, resets 17:40 · 7d 69% left · acct work` | the status input |

A workflow is one row: its bar is its agents done of all, then the phase, how many run with a spark of their progress, the time
left and the finish; its agents get no rows of their own in the status line (owner, 2026-11-22), only in `/where`. Agents outside
a workflow keep their own rows. Every agent row says where the agent works, never dropped: `repository:branch`, commits ahead of the base (`2↑`) and
uncommitted files (`+3 dirty`), from its own worktree, or `read-only` / `no repo` (below 115 columns with one repository the
branch alone, the git row names the repository).

When rows run out (`lib/render.mjs` shares them, `lib/layout.mjs` packs the work rows): the alert, job and session rows always
show; then one git row (never none: branch, upstream ahead/behind, changed files, landed today; `git: no repository` when the
work is in none; with no room at all the session row carries the git part), the road row, the checks row
when the suite fails, the first three work rows, the checks row, the counts row, the rest of the work rows, more git rows. The
agents outside workflows fold: the most urgent keep a row (quiet, over their usual time, writers, readers, then the soonest
finish) and the rest share one `+K more` row; with fewer rows still, one strip
row carries every group. Finished agents show for 30 s, then only the counts row has them (10 min). From 150 columns two agents
share a row. On an error while drawing, the session row and one `status line error:` line still print. A row or field with
nothing to say hides: no road, no trend, no 5 h field when the status input has no 5 h window and no current sample.

### Colour (`lib/cells.mjs`)

Basic ANSI 16 colours, so the terminal theme maps them on dark and light themes; one meaning each: green done, passing, on track,
a sooner finish, landed today; cyan running now (bars of running agents, the active road step); yellow attention soon (a quiet
agent, over its usual time, a later finish, context or a limit 60-80 % used, behind the upstream); red needs action (a failing
suite, context or a limit over 80 % used, a passed finish clock); magenta waiting on the owner; dim for secondary text (clocks,
counts, `off:` categories). Bold marks only the one most urgent item: a question waiting, else a failing suite, else context over
80 %, else a limit over 80 %, else the longest-quiet agent. Every state also has its word (`quiet`, `over usual`, `fail`,
`later`, `waiting`), so `NO_COLOR` (any value) or `TERM=dumb` prints the same words with no escape codes. Descriptions,
step titles and worktree names are cut at a word with `…`, never mid-word.

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
- each agent's tokens (the last call's usage: its context so far) and the folder of the last file it read or changed, which
  places it in a worktree when its own folder is the lead's;
- the job (`lib/job-facts.mjs`): the session's linked STATUS.md (else the one in its folder), its estimate cache entry, and,
  when the job walks a road, `road-<id>.json` beside it and the close rows (lanes landed); the finish clock's last move of 5 min
  or more is kept for an hour as the trend;
- the base branch (`lib/repo-stats.mjs`, every 60 s): its tip, the newest test-pass `suite` record of exactly that tip, and the
  commits on its first-parent line since local midnight;
- git (`lib/repos.mjs`, `lib/git-state.mjs`) only in repositories the setup vouches for, up to 3: the session's folder, each
  agent's `meta.worktreePath` and the writers' launch folders, with the worktrees their own `worktree list --porcelain -z` names;
  the STATUS.md folder and the road's `repo` only choose which of those is shown first (a STATUS.md or road file can name any
  folder, so it never adds a repository) (git runs a repository's own config, so never where a tool call points); `-c core.fsmonitor=false`
  and one git budget per refresh. Agents are matched to those worktrees by path prefix: the folder of the file they edited last
  (Edit, Write, MultiEdit, NotebookEdit, counted only after the call succeeded; a Bash call's cwd says nothing of where it
  writes), then the worktree they were launched in (`meta.worktreePath` or the launch record), then older edited folders, then
  their cwd. One refresh per session at a time (an O_EXCL lock file from `tools/disk-free/lib/lock-file.mjs`, broken after 2 min): `worktree list` when the worktree folder changed, one `for-each-ref` with `%(ahead-behind:main)`
  every 15 s, and `--no-optional-locks status --untracked-files=no` per worktree only when its index or HEAD changed (15 s at
  most); 250 ms timeout per call and 250 ms of git per refresh, past which the old values stay with their age.

A refresh over its 300 ms budget keeps the old board and marks it `stale N s` (the cursors it read are kept, so the next one
reads only new bytes). After the write, the agent-type pools are rebuilt when an hour old (`~/.claude/state/board-cache/pools.json`,
at most 4 s of scanning). Journals, transcripts and meta files are Claude Code's internal formats: an unreadable part shows
nothing, never a wrong line, and never throws.

Not yet shown: `failed` and `done, not landed` runs, the tidy-gate verdict, and which agent a question comes from (the asking
marker holds no agent).

Files: `board.mjs` (the CLI and the lines), `lib/refresh.mjs` (build, refresh, the board file, the claim, the detached start),
`lib/agents.mjs`, `lib/agent-transcript.mjs`, `lib/progress.mjs`, `lib/pools.mjs`, `lib/git-state.mjs`, `lib/job-facts.mjs`,
`lib/repo-stats.mjs`, `lib/repos.mjs`, `lib/cache-file.mjs` (what the refresh reads), `lib/render.mjs` (the status line rows; `home/statusline.mjs` only reads and writes), `lib/work-row.mjs` (the
job row), `lib/layout.mjs` (row budget, counts row, packing), `lib/agent-rows.mjs` (workflow and agent rows), `lib/git-rows.mjs`
(git rows), `lib/stat-rows.mjs` (road and checks rows, the trend), `lib/cells.mjs` (look, glyphs, bars, durations, clocks, fitting a row to a width; shared by every surface),
`lib/tree.mjs` (the `/where` tree).
