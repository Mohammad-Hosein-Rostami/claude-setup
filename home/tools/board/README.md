# board

Which agent works on what and how far it is, what waits on the owner and the git state of every
worktree, in one small file the status line, `/where` and the progress pane read (`~/.claude/state/board/<session>.json`, at
most 48 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs [--session <id>] [--columns <n>]` prints the board (session default
`CLAUDE_CODE_SESSION_ID`, width default 80). `board.mjs refresh --session <id> [--force]` rewrites the file; `status.mjs add|start|done`
starts it detached after every changed edit. `board.mjs where [--columns <n>] [--project <dir>]` prints the `/where` tree
(`lib/tree.mjs`, display design 6.3): all work, the road and its steps (the current step with its likely and 85% clocks), the
road (`idle` when nobody moved it this session), the counts, every agent and git row with nothing folded, what waits on the owner, one limits line per account,
and the session's cost figure from its last-seen file.

## The status line rows

`home/statusline.mjs` prints 2 rows when nothing waits and no agent runs, and at most 4 when busy (owner decisions RC5, RC6 and
RC8 of 2026-11-22); on a terminal of fewer than 12 lines only 2. Each row is fitted to `COLUMNS - 5` (Claude Code cuts a row
there); from 115 usable columns each row leads with a 6-character dim label column (`ALL`, `agents`, `git`). From top to bottom:

| Row | Example (120 columns) | From |
| --- | --- | --- |
| alert, only while something waits on the owner | `? ANSWER NEEDED · 1 question · recommended answer taken in 1:40` | the asking marker |
| job | `ALL    ██████░░░░░░░░░░  40 min left · by 09:40 · 85% 10:05 · ↑ +1h10 later        road final 2/4 · 2/5 lanes` | the estimate cache, the board's road and trend (`lib/work-row.mjs`, `lib/stat-rows.mjs`) |
| agents, only while an agent runs | `agents 6 · 5 running · 1 done · ! reviewer quiet 6 min · implementer over 12 min        all by 09:10` | the board's agents (`lib/layout.mjs`) |
| git and session | `git    main ✓ ↑44 · 3 lanes open · 1 dirty        Opus 5.5 high · ctx 25% · 5h 54% left · 7d 69% left · acct work` | the board's repo (`lib/git-rows.mjs`), the status input |

The job row counts live work only (RC6): the live road's current step (its rows done of all as the bar, its time left and
clocks; no percent, since a row count is not work done), else the started open rows (the share of their expected minutes
earned, each row earning its elapsed minutes up to 90 % of its expected minutes, the estimate's own rule; the minutes left, the
clock they end at, `N min over plan` in yellow past a row's expected minutes), else `nothing started · N rows open`. A refusal,
an estimate error (`estimate: table error at row A17`, red), a hand-over, a long job and `all N rows done` keep their words;
`no job linked` unless the session linked a STATUS.md or the project's changed during the session. The whole job (all open rows,
the committed finish clock, the steps of the road) is in `/where`. A road is on the line only while it is live: a row of its
current step was started or finished since the session's first board refresh (`lib/job-facts.mjs`); a road nobody moved this
session (a stale one) is hidden on the line and reads `idle` in `/where`. A board file written before this rule (no `live`)
counts as live.

The agents row (RC8) is one summary whatever the number of agents: the parts add up to the total (running counts the quiet ones;
done is finished in the last 10 min), only the agents that need a look are named (quiet first, then over their usual time),
as many as fit and then `+K more`, and `all by` when every running agent has a time left. Every agent's own row (bar, time left,
task, where it works, tokens) is in `/where`, and Claude Code's own agent panel lists them too. The git part is one summary
whatever the number of worktrees: the main checkout's branch and state, its commits ahead of and behind its upstream when not
level (`↓2 behind` turns it yellow, as does an operation in progress), how many lane worktrees are open and how many have
uncommitted files; `git: loading` before the board's first refresh, `git: no repository` when the work is in none. The session
block: model and effort, context against the auto-compact window (`ctx 25%`, `ctx ?` after /compact until the next call,
`/clear` from 150k tokens), 5 h and 7 d left (`<1% left`; from 60 % used the reset clock, rounded up, weekday when not today;
with no live 5 h window this account's last sample with its age), the 5 h pace `5h out ~16:10` when it comes before the reset,
and the account (`CLAUDE_ACCOUNT`).

When a row does not fit, its parts drop by priority, never a value cut mid-token where a whole part can go: the job row's 85 %
clock and rows count first, then the road part, the trend; the agents row's `all by`, then names (counted in `+K more`); the
last row's account, 7 d, then 5 h. The rows drop in this order when the terminal is short: agents, job, alert; the git and
session row always prints. On an error while drawing, that row and one `status line error:` line still print.

### Colour (`lib/cells.mjs`)
### Colour (`lib/cells.mjs`)

Colour only for a state (RC5), basic ANSI 16 so the terminal theme maps them on dark and light themes: yellow needs a look (a
quiet agent, one over its usual time, a later finish, a row over its plan, context or a limit 60-80 % used, behind the
upstream), red error or act now (context or a limit over 80 % used, an estimate error), magenta waiting on the owner (the
alert, bold label). Labels, clocks and secondary counts are dim; every healthy value is in the default colour, so a line with
nothing to look at shows no colour. No green, no blue, no cyan and no colour for an agent or a branch (the identity hues of
spec-tui-3 and their saved file `~/.claude/state/board-cache/<session>-hues.json` were removed with RC5; a file left by an
older release is read by nothing and goes with the board cache's 7-day sweep). Every state also has its word (`quiet`, `over`,
`later`, `over plan`, `ANSWER NEEDED`, `behind`), so `NO_COLOR` (any value) or `TERM=dumb` prints the same words with no escape
codes. Names are cut at a word or `-` with `…`, never mid-word.

### `/where` is plain text (`lib/tree.mjs`)

`/where` holds every detail the line leaves out (RC8) and prints it with no colour code at all, whatever `TERM`, `COLORTERM`
or `NO_COLOR` say: the skill puts the tree into the reply, where an escape code would show raw. Each row kind leads with a
label: `ALL`, `road`, `Σ` before the counts (`=` in ASCII), `▸ agents`, and `⎇` (`git` in ASCII) before each worktree, main
first. An agent placed in a lane worktree names its branch on its own row, so its row and the branch's git row match by name.
Names from outside are cleaned of control characters (an escape code in a branch name prints as plain text) and cut at a word
or `-` with `…`.

### An agent's progress (`lib/progress.mjs`)

The bar is evidence, never the agent's own words: the brief's numbered steps done by commits (3 or more steps), else milestones
(writers: first Read, Edit, check run, commit, report written; readers: calls past the type's usual first quarter, a file
written, a long answer), blended with the elapsed time against finished agents of its type that ran longer than this one so far
(`lib/pools.mjs`, rebuilt hourly from this machine's transcripts). The form says how sure it is: `62%` (steps and a pool of 20
or more), `~60%` (a steady pool or 2 milestones), `est…` with a moving ▒ and the usual time otherwise and in the first minute.
It never goes down unless steps were added (`+steps`), shows 100% only when the agent is done, and `over usual by 9 min` (▓)
past the type's 85th percentile. `quiet 4 min` after 3 min without a write and no call waiting for its result.

## The refresh

A refresh runs one at a time (a claim in the file), at most every 5 s while an agent is live and every 60 s when idle
(the status line's `refreshInterval` is 5 s). It reads, and keeps its cursors in `~/.claude/state/board-cache/<session>.json`:

- the subagent transcripts (`<session>/subagents/agent-<id>.jsonl`; an old `subagents/workflows/` folder is not read), only their new
  bytes since the last refresh, with their `.meta.json` (type, description, worktree) (`lib/agent-transcript.mjs`, `lib/agents.mjs`);
- the writer launch records (`hooks/lib/writer-agents.mjs`: an agent's STATUS row);
- each agent's tokens (the last call's usage: its context so far) and the folder of the last file it read or changed, which
  places it in a worktree when its own folder is the lead's;
- the job (`lib/job-facts.mjs`): the session's linked STATUS.md (else the one in its folder), its estimate cache entry, and,
  when the job walks a road, `road-<id>.json` beside it and the rows that land its lanes (the lane row `<road>.s<N>.<lane>`, one
  row per lane; an older road's close row `<road>.s<N>.<lane>-land` when STATUS.md holds one), and whether a row of the current
  step was started or finished since the session's first refresh (`live`); the finish clock's last move of 5 min or more is kept
  for an hour as the trend;
- the base branch (`lib/repo-stats.mjs`, every 60 s): its tip and the
  commits on its first-parent line since local midnight;
- git (`lib/repos.mjs`, `lib/trusted-repos.mjs`, `lib/git-state.mjs`) only in trusted repositories, worked out again on every
  refresh (never read back from the cache): the session folder's and the setup's own (the repository holding the running board
  code, from this code's real path: `~/.claude/tools` links into it). Claude Code's folder-trust record is not used: the owner runs
  with bypass permissions, so it is unreliable. Of those, up to 3 with work: the session's own and each one a registered worktree
  of which holds a live agent's folder (its edited files, its launch worktree, its cwd), else the one holding the STATUS.md folder
  or the road's `repo`; the STATUS.md folder and the road only order and choose, they never add a repository. Git runs only on
  what the trusted repository records itself, read fresh on every refresh and never from the cache: its shared git folder
  (`--git-dir=<common>` for the refs and the base-branch facts) and each worktree it records (the main checkout, and
  `<common>/worktrees/<name>` whose `gitdir` names `<path>/.git` and whose `commondir` leads back to `<common>`; a main `.git`
  holding a `commondir` file is no main checkout), as `--git-dir=<that git folder> --work-tree=<path>`, so git
  never reads a worktree's own `.git` (a rewritten or racing `.git` cannot point it elsewhere) and `--ignore-submodules=dirty` keeps
  it out of nested repositories. Paths are compared as real paths in the disk's letter case. Every call has
  `-c core.fsmonitor=false -c safe.bareRepository=explicit`, no inherited `GIT_*` variable and `GIT_COMMON_DIR=<common>` (git
  would otherwise follow a git folder's `commondir` file even under `--git-dir=`), and one git budget per refresh. With no trusted
  repository holding the work the git row says `git: no repository`. When git runs out of time (a loaded machine), a repository
  keeps its last good state for up to 60 s and its row says `stale`. Agents are matched to those worktrees by path prefix: the folders of the files they edited, newest
  first (Edit, Write, MultiEdit, NotebookEdit, counted only after the call succeeded; a Bash call's cwd says nothing of where it
  writes), then their isolation worktree (`meta.worktreePath`); the launch folder (launch record) and the cwd only say the repository. One refresh per session at a time (an O_EXCL lock file from `tools/disk-free/lib/lock-file.mjs`, broken after 20 s): one `for-each-ref` with `%(ahead-behind:main)`
  every 15 s, and `--no-optional-locks status --untracked-files=no` per worktree only when its index or HEAD changed (15 s at
  most); 250 ms timeout per call and 250 ms of git per refresh, past which the old values stay with their age.

A refresh over its 300 ms budget keeps the old board and marks it `stale N s` (the cursors it read are kept, so the next one
reads only new bytes). After the write, the agent-type pools are rebuilt when an hour old (`~/.claude/state/board-cache/pools.json`,
at most 4 s of scanning). Journals, transcripts and meta files are Claude Code's internal formats: an unreadable part shows
nothing, never a wrong line, and never throws.

Not yet shown: the tidy-gate verdict, and which agent a question comes from (the asking
marker holds no agent).

Files: `board.mjs` (the CLI and the lines), `lib/refresh.mjs` (build, refresh, the board file, the claim, the detached start),
`lib/agents.mjs`, `lib/read-part.mjs` (a bounded read of a plain file), `lib/agent-transcript.mjs`, `lib/progress.mjs`, `lib/pools.mjs`, `lib/git-state.mjs`, `lib/job-facts.mjs`,
`lib/repo-stats.mjs`, `lib/repos.mjs`, `lib/trusted-repos.mjs`, `lib/cache-file.mjs` (what the refresh reads), `lib/render.mjs` (the status line rows; `home/statusline.mjs` only reads and writes), `lib/work-row.mjs` (the
job row, live work), `lib/layout.mjs` (row budget, agents summary row, `/where` counts row and packing), `lib/agent-rows.mjs` (agent rows), `lib/git-rows.mjs`
(git summary and `/where` git rows), `lib/stat-rows.mjs` (the road part and row, the trend), `lib/cells.mjs` (look, glyphs, bars, durations, clocks, fitting a row to a width; shared by every surface),
`lib/tree.mjs` (the `/where` tree, plain text).
