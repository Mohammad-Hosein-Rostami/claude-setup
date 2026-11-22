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

`home/statusline.mjs` prints 2 rows when idle (git and session) and at most 6 when busy (spec R18, owner decisions RC14 to RC20
of 2026-11-22); 4 on a terminal of 12 to 19 lines, 2 below 12. Each row is fitted to `COLUMNS - 5` (Claude Code cuts a row
there); from 90 usable columns each row leads with an 8-character dim label. From top to bottom, at 100 columns:

| Row | Example (100 columns) | From |
| --- | --- | --- |
| alert, only while something waits on the owner | `? ANSWER NEEDED · 1 question · recommended answer taken in 1:40` | the asking marker |
| job, the whole job | `job     ████░░░░ 6/10 rows done · 2 h 10 work left · done by 21:40, 25 min late: 3 rows added` | the estimate cache (`lib/work-row.mjs` jobRow) |
| now, the current step or the running rows | `now     step 2 of 4 git rows · ██░░░░ 1/3 lanes landed · 40 min work left · step done by 19:55` | the estimate cache and the board's road (`lib/work-row.mjs` nowRow) |
| agents, only while an agent runs | `agents  5 running · 1 done · ! reviewer quiet 6 min` | the board's agents (`lib/layout.mjs`) |
| git | `git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1 · check ok` | the board's repositories (`lib/git-rows.mjs` gitLineRows) |
| git row 2: lanes or a second repository | `lanes   r18-git ↑2 ~3 implementer · r18-est ↑4 ready to land · r17-col ↓5 needs rebase · +2 more` | the same |
| session | `session Opus 5.5 high · context 29% · 5h 90% left, empty ~22:32 · 7d 47% left · acct mine` | the status input, the account's limit samples |

Every number says what it is for. The job row shows only with live work (a started row or a live road), an estimate error
(`estimate: table error at row A17`, red) or a refusal: the bar is the job's rows done of all, `2 h 10 work left` the median
working time left on its open rows (not clock time), `done by 21:40` the committed finish (now plus the budget left, rounded up
to 5 min; pauses move it). `25 min late: 3 rows added` shows only when the job runs 10 min or more over its first budget, with
the latest cause (`3 rows added`, `R18.git slow`, `slower pace`), yellow, and red once the overrun is past the job's 85 % margin
(the minutes between its median and its 85 % finish). The now row is the live road's current step (its lanes landed of all, else
its rows done, its share of the work left, its clock), else the running rows (each row's own median time left; a row past its
size's median reads `25 min over usual`, yellow). The now row is left out while every open row runs and none is over usual: the
job row says it all. From 115 usable columns the words are longer (`6 of 10 rows done · about 2 h 10 of work left · done by 21:40
· late by 25 min (3 rows added)`), below 90 shorter (`2 h 10 left`, `step 2/4`, `1/3 lanes`, `step by`). A road is on the line only
while it is live: a row of its current step was started or finished since the session's first board refresh (`lib/job-facts.mjs`);
a stale road is hidden and reads `idle` in `/where`; a board file written before this rule (no `live`) counts as live. `nothing
started`, the open rows, the finish trend and the road's steps are in `/where`.

The agents row (RC8) is one summary whatever the number of agents: running counts the quiet ones, done is finished in the last
10 min, only the agents that need a look are named (quiet first, then over their usual time), as many as fit and then `+K more`,
and `all done ~19:49` only when no job or now row shows a clock.

The git rows (RC15, RC19) come from the board's detached refresh only (render under 50 ms). In the session's repository: its name
(bold), the current branch, what to push and to pull (yellow), conflicts (red), an operation (`rebase 3/7`, yellow), staged,
changed and new files (`changes ?` where the refresh had refs only), the stash, the last commit's age and the last done-check
verdict (`check ok`, `check failed: tests` red); then a `lanes` row of its other active branches (checked out where an agent
works, with changes, ahead of the base with a commit in the last 24 h, or the base while not level with its upstream), at most 4
and then `+K more`, each with `↑2` ahead, `~3` changed, its agents, `ready to land` or `↓5 needs rebase` (yellow). Outside a
repository, or with a second one, one row per used repository (at most 2, then `+K more repos in /where`) with its lanes after
` │ `. `git     loading` before the board's first refresh, `git     no repository used in this session yet (~ is not one)`.
The session row: model and effort, context against the auto-compact window (`context 29%`, `context ?` after /compact until the
next call, `/clear` from 150k tokens), 5 h and 7 d left (`<1% left`; from 60 % used `, resets 22:10` rounded up, weekday when not
today; with no live 5 h window this account's last sample with its age), the 5 h pace `, empty ~22:32` (yellow) when it comes
before the reset, and the account (`CLAUDE_ACCOUNT`).

When a row does not fit, its parts drop by priority, never a value cut mid-token where a whole part can go: the git row's last
commit age first, then `check ok`, then the stash (never the branch, conflicts, an operation, to pull, needs rebase or check
failed); lanes are counted in `+K more`; the job row's late cause before the late amount; the now row's step title and row names;
the session row's account, then 7 d, then the 5 h clock. Over the row budget the rows kept are, in order: session, git, alert,
job, now, agents, git row 2 (git row 1 then counts what row 2 held: `3 lanes in /where`, `+1 more repo in /where`). On an error
while drawing, the session row and one `status line error:` line still print.

### Colour (`lib/cells.mjs`)

Colour by kind (RC14, "dont over do"): four kinds have a colour of their own and nothing else has it: branch names green
(38;5;35), bars and their counts cyan (38;5;37), durations and clocks blue (38;5;33), the session's model, effort, context and
limit values grey-violet (38;5;103). Three states are reserved and stay basic ANSI, so the terminal theme maps them: yellow needs
a look (late, to pull, needs rebase, an operation, a quiet or slow agent, 60-80 % used, the 5 h pace), red a problem (conflicts,
a failed check, an estimate error, over 80 % used, a job past its 85 % margin), magenta needs you (the alert, bold label). Labels,
ages and the ` · ` between parts are dim (SGR 2), counts and words are in the default colour, repository names bold. The 256-colour
codes go out when `TERM` has `256color` or `COLORTERM` is `truecolor` or `24bit`, else the basic 16 of the same kinds (green,
cyan, blue, white). A light palette (RC20: 38;5;28, 30, 25 and 60, at least 4.36:1 on white) when `CLAUDE_STATUS_THEME=light` or
`COLORFGBG` ends in `;7` or `;15`; `CLAUDE_STATUS_THEME=dark` forces the dark one. Every state also has its word (`late`, `to
pull`, `needs rebase`, `quiet`, `over usual`, `check failed`, `ANSWER NEEDED`), so `NO_COLOR` (any value), `TERM=dumb` or the old
Windows console (no Windows Terminal, no `TERM_PROGRAM`) prints the same words with no escape code. Names are cut at a word or `-`
with `…`, never mid-word. The identity hues of spec-tui-3 and their saved file `~/.claude/state/board-cache/<session>-hues.json`
were removed with RC5; a file left by an older release is read by nothing and goes with the board cache's 7-day sweep.

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
job and now rows), `lib/layout.mjs` (row budget, agents summary row, `/where` counts row and packing), `lib/agent-rows.mjs` (agent rows), `lib/git-rows.mjs`
(the status line git rows and `/where` git rows), `lib/stat-rows.mjs` (`/where`: the road row, the trend), `lib/cells.mjs` (look and palette, glyphs, bars, durations, clocks, fitting a row to a width; shared by every surface),
`lib/tree.mjs` (the `/where` tree, plain text).
