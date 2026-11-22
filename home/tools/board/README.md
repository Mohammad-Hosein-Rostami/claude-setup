# board

Which agent works on what and how far it is, what waits on the owner and the git state of every
worktree, in one small file the status line, `/where` and the progress pane read (`~/.claude/state/board/<session>.json`, at
most 48 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs [--session <id>] [--columns <n>]` prints the board (session default
`CLAUDE_CODE_SESSION_ID`, width default 80). `board.mjs refresh --session <id> [--force]` rewrites the file; `status.mjs add|start|done`
starts it detached after every changed edit. `board.mjs where [--columns <n>] [--project <dir>]` prints the `/where` tree
(`lib/tree.mjs`, display design 6.3): all work, the road and its steps (the current step with its likely and 85% clocks), the
status line's road, counts, checks, agent and git rows with nothing folded, what waits on the owner, one limits line per account,
and the session's cost figure from its last-seen file.

## The status line rows

`home/statusline.mjs` prints between 2 and 12 rows: `clamp(floor(LINES / 3), 3, 12)` (a 24-line terminal gives 8), each fitted
to `COLUMNS - 5` (Claude Code cuts a row there). From top to bottom:

| Row | Example (120 columns) | From |
| --- | --- | --- |
| alert, only when needed | `! WAITING FOR YOUR ANSWER: a question, recommended taken in 1:39` | the asking marker, an estimate error, the 5 h pace |
| road, when the job walks one | `road p8 · step 1/12 honest suite · 2/5 lanes · step 40 min left · by 21:10 · 85%: 21:35` | the estimate cache's road numbers, the board's road (`lib/job-facts.mjs`) |
| job | `ALL ████████░░░░░░░░  52% of work · 2 h 10 left · done by 17:45 · 85%: 18:20 · ↑ +1h10 later · 11/21 rows` | the estimate cache, the board's trend |
| counts, while work runs | `Σ 6 agents (6 run) · 1 over usual │ git 4 branches · 2 not landed` | the board |
| checks | `checks: types review ui probe · off: smart test │ suite 3628 · 222 fail` | the session's `/check` switch, the board's suite (`lib/repo-stats.mjs`) |
| agents header | `▸ agents · 2 run ▄▄` | the board's agents |
| agent | ` ├ ● Write road file…   architect   █████▒░░ ~70% · 8 min left · 16:03 · claude-setup:lane/road-p8 2↑ +1 dirty` | the board's agents and repositories |
| git, at least one row | `⎇ claude-setup:main ✓ · origin ↑0↓0 · landed today 6, last 12 min ago │ ● r9-a ↑2↓0 ●3 impl-a · ◆ old-x ✓ old 3 d ⚠`; one row each when they fit: `⎇ ● remove-modes · ↑7↓0 · last commit 10 min ago · implementer:opus` | the board's repo and repos |
| session | `Opus 5.5 high · ctx 99k of 400k (25%) · 5h 54% left, resets 17:40 · 7d 69% left · acct work` | the status input |

Every agent has its own row. Every agent row says where the agent works, never dropped: `repository:branch`, commits ahead of the base (`2↑`) and
uncommitted files (`+3 dirty`), from its own worktree (below 115 columns with one repository the branch alone, the git row names
the repository). An agent known only by its launch folder or cwd (one that works through Bash, or has not edited yet) may be on any
branch, so its row names no branch: `claude-setup · no edits yet` when that folder is in a trusted repository, else the folder's
name (`round4 · no edits yet`); `· read-only` for an agent that does not write, `· edits outside git` for one whose edits are all
outside the trusted worktrees; `no repo` / `read-only` when nothing is known. When the text does not fit, the folder name is cut
and the reason stays (`cla… · read-only`); with no room for the folder, the reason alone.

When rows run out (`lib/render.mjs` shares them, `lib/layout.mjs` packs the work rows): the alert, job and session rows always
show; then one git row (never none: branch, upstream ahead/behind, changed files, landed today; `git: no repository` when the
work is in none; with no room at all the session row carries the git part), the road row, the checks row
when the suite fails, the first three work rows, the checks row, the counts row, the rest of the work rows, more git rows. The
agents fold: the most urgent keep a row (quiet, over their usual time, writers, readers, then the soonest
finish) and the rest share one `+K more` row; with fewer rows still, one strip
row carries the agents. Finished agents show for 30 s, then only the counts row has them (10 min). From 150 columns two agents
share a row. On an error while drawing, the session row and one `status line error:` line still print. A row or field with
nothing to say hides: no road, no trend, no 5 h field when the status input has no 5 h window and no current sample.

### Colour (`lib/cells.mjs`)

Basic ANSI 16 colours, so the terminal theme maps them on dark and light themes; one meaning each: green done, passing, on track,
a sooner finish, landed today; cyan running now (bars of running agents, the active road step); yellow attention soon (a quiet
agent, over its usual time, a later finish, context or a limit 60-80 % used, behind the upstream); red needs action (a failing
suite, context or a limit over 80 % used, a passed finish clock); magenta waiting on the owner; dim for secondary text (clocks,
counts, `off:` categories). Of the states, bold marks only the one most urgent item: a question waiting, else a failing suite, else context over
80 %, else a limit over 80 %, else the longest-quiet agent (bold is also a plain label: `ALL`, main's git row, and two of the
16-colour identity looks). Every state also has its word (`quiet`, `over usual`, `fail`,
`later`, `waiting`), so `NO_COLOR` (any value) or `TERM=dumb` prints the same words with no escape codes. Descriptions,
step titles, agent and worktree names are cut at a word or `-` with `…`, never mid-word.

### Which is where: identity colours (`lib/identity.mjs`, spec-tui-3)

Each work item, an agent or a lane branch, has one hue and one marker shape (`●`, `◆`, `▲`;
`*`, `+`, `o` in ASCII), and keeps them while it stays on the board (an agent tied to a lane takes the lane's colour, so it changes when
its writer starts or ends). A name's home hue is a hash of it; a name seen for the first time takes
the first hue from its home that no live item uses (one whose marker shape no live item has first, so `NO_COLOR` still tells
three items apart), and that choice is remembered in `~/.claude/state/board-cache/<session>-hues.json` (`lib/hue-store.mjs`,
written by the status line and `/where` when an item joins, leaves or comes back, and every 2 minutes or so to refresh the
last-seen times, temp file and rename; a missing or bad file starts fresh). So a name's hue never changes when other items
join or leave. An item that comes back takes its old hue only when no live item has taken it meanwhile, and a newcomer avoids
the hue of an item gone under 5 minutes while another is free; an item gone for more than 30 minutes is forgotten and gets a
new hue when it returns. Only what the rows draw holds a hue: a finished agent holds none after 30 seconds. Up to six live items never share a hue; with more than six, the seventh and later keep their home hue and
so share with an earlier item (and three share a marker shape beyond three). An agent that works in a lane worktree
(the board's sure placement, never a guess from a folder) takes that branch's hue, so its row and the branch's git row match.
An agent that places nowhere (a read-only reviewer) has its own hue, named by its description. The hues are xterm 256-colour indexes 31 blue, 166 orange, 99 violet, 64
green, 197 pink and 133 orchid, none a state colour's code. Their contrast (dark `#1e1e1e` / white `#ffffff`) is 4.04 / 4.13,
4.39 / 3.80, 4.06 / 4.11, 3.93 / 4.24, 4.30 / 3.88 and 4.03 / 4.13, so 3.80 to 4.39 to 1: no cube colour reaches 4.5:1 on both
(the best reaches 4.06), so these are the most even. Each row kind leads with a label: `road` blue, `ALL` bold, a dim `Σ`
before the counts, the `/check` categories on green (`none` dim), `▸` and `⎇` and the branch in
its hue (main in the default colour, bold), the session row's `ctx`, `5h`, `7d` and `acct` labels dim. A terminal whose `TERM`
and `COLORTERM` name neither 256 nor true colour (Windows Terminal, which sets `WT_SESSION` instead, counts as 256) gets bold,
underline or plain in place of the hues (with the shape, six different looks); `NO_COLOR` prints no codes and the marker shape
tells items apart. A name that does not fit is cut at a word or `-` with `…` in every row (also the strip row).

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
  when the job walks a road, `road-<id>.json` beside it and the close rows (lanes landed); the finish clock's last move of 5 min
  or more is kept for an hour as the trend;
- the base branch (`lib/repo-stats.mjs`, every 60 s): its tip, the newest test-pass `suite` record of exactly that tip, and the
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
job row), `lib/layout.mjs` (row budget, counts row, packing), `lib/agent-rows.mjs` (agent rows), `lib/git-rows.mjs`
(git rows), `lib/stat-rows.mjs` (road and checks rows, the trend), `lib/identity.mjs` (identity hues and markers), `lib/hue-store.mjs` (the saved hues; read and written by the status line and `/where`), `lib/cells.mjs` (look, glyphs, bars, durations, clocks, fitting a row to a width; shared by every surface),
`lib/tree.mjs` (the `/where` tree).
