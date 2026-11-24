# board

The engine behind the status line: which agents run, what waits on the owner and the git state of the session's worktrees, in
one small file the status line reads (`~/.claude/state/board/<session>.json`, at most 48 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs refresh --session <id> [--force]` rewrites the board file. You rarely run it by
hand: `home/statusline.mjs` starts it detached when the file is older than its refresh interval, and draws only what the file
holds, so a slow git or transcript scan never delays a render.

## The status line rows

`home/statusline.mjs` prints 2 rows when idle (git and session) and at most 5 when busy (spec R18, owner decisions RC14 to RC20
of 2026-11-22); the row budget is 6 rows from 20 terminal lines, 4 on 12 to 19 lines and 2 below 12. Each row is fitted to
`COLUMNS - 5` (Claude Code cuts a row there); from 90 usable columns each row leads with an 8-character dim label. From top to
bottom, at 100 columns:

| Row | Example (100 columns) | From |
| --- | --- | --- |
| alert, only while something waits on the owner | `? ANSWER NEEDED · 1 question · recommended answer taken in 1:40` | the asking marker |
| agents, only while an agent runs | `agents  5 running · 1 done · ! tess-review quiet 6 min` | the board's agents (`lib/layout.mjs`) |
| git | `git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1` | the board's repositories (`lib/git-rows.mjs` gitLineRows) |
| git row 2: lanes or a second repository | `lanes   r18-git ↑2 ~3 dev · r18-est ↑4 ready to land · r17-col ↓5 needs rebase · +2 more` | the same |
| session | `session Opus 5.5 high · context 29% · 5h 90% left, empty ~22:32 · 7d 47% left · acct mine` | the status input, the account's limit samples |

The agents row (RC8) is one summary whatever the number of agents: running counts the quiet ones, done is finished in the last
10 min, and only the agents that need a look are named (quiet ones), as many as fit and then `+K more`.

The git rows (RC15, RC19) come from the board's detached refresh only (render under 50 ms). In the session's repository: its name
(bold), the current branch, what to push and to pull (yellow), conflicts (red), an operation (`rebase 3/7`, yellow), staged,
changed and new files (`changes ?` where the refresh had refs only; `changes unknown` while git has not answered for that
worktree yet, with the reason in the board file's `unknown`), the stash and the last commit's age; then a `lanes` row of
its other active branches (checked out where an agent works, with changes, ahead of the base with a commit in the last 24 h, or
the base while not level with its upstream), at most 4 and then `+K more`, each with `↑2` ahead, `~3` changed, its agents,
`ready to land` or `↓5 needs rebase` (yellow). Outside a repository, or with a second one, one row per used repository (at most
2, then `+K more repos`) with its lanes after ` │ `. `git     loading` before the board's first refresh,
`git     no repository used in this session yet (~ is not one)`.
The session row: model and effort, context against the auto-compact window (`context 29%`, `context ?` after /compact until the
next call, `/clear` from 150k tokens), 5 h and 7 d left (`<1% left`; from 60 % used `, resets 22:10` rounded up, weekday when not
today; with no live 5 h window this account's last sample with its age), the 5 h pace `, empty ~22:32` (yellow) when it comes
before the reset, and the account (`CLAUDE_ACCOUNT`).

When a row does not fit, its parts drop by priority, never a value cut mid-token where a whole part can go: the git row's last
commit age first, then the stash (never the branch, conflicts, an operation, to pull or needs rebase); lanes are counted in
`+K more`; the session row's account, then 7 d, then the 5 h clock. Over the row budget the rows kept are, in order: session,
git, alert, agents, git row 2 (git row 1 then counts what row 2 held: `3 lanes`, `+1 more repo`). On an error while drawing,
the session row and one `status line error:` line still print.

### Colour (`lib/cells.mjs`)

Colour by kind (RC14, "dont over do"): three kinds have a colour of their own and nothing else has it: branch names green
(38;5;35), durations and clocks blue (38;5;33), the session's model, effort, context and limit values grey-violet (38;5;103).
Three states are reserved and stay basic ANSI, so the terminal theme maps them: yellow needs a look (to pull, needs rebase, an
operation, a quiet agent, 60-80 % used, the 5 h pace), red a problem (conflicts, over 80 % used), magenta needs you (the alert,
bold label). Labels, ages and the ` · ` between parts are dim (SGR 2), counts and words are in the default colour, repository
names bold. The 256-colour codes go out when `TERM` has `256color` or `COLORTERM` is `truecolor` or `24bit`, else the basic 16
of the same kinds. A light palette (RC20, at least 4.36:1 on white) when `CLAUDE_STATUS_THEME=light` or `COLORFGBG` ends in
`;7` or `;15`; `CLAUDE_STATUS_THEME=dark` forces the dark one. Every state also has its word (`to pull`, `needs rebase`,
`quiet`, `ANSWER NEEDED`), so `NO_COLOR` (any value), `TERM=dumb` or the old Windows console (no Windows Terminal, no
`TERM_PROGRAM`) prints the same words with no escape code. Names from outside are cleaned of control characters and cut at a
word or `-` with `…`, never mid-word.

## The refresh

A refresh runs one at a time (a claim in the file), at most every 5 s while an agent is live and every 60 s when idle
(the status line's `refreshInterval` is 5 s). It reads, and keeps its cursors in `~/.claude/state/board-cache/<session>.json`:

- the subagent transcripts (`<session>/subagents/agent-<id>.jsonl`; an old `subagents/workflows/` folder is not read), only their new
  bytes since the last refresh, with their `.meta.json` (type, description, worktree) (`lib/agent-transcript.mjs`, `lib/agents.mjs`);
- the writer launch records (`hooks/lib/writer-agents.mjs`);
- each agent's tokens (the last call's usage: its context so far) and the folder of the last file it read or changed, which
  places it in a worktree when its own folder is the lead's;
- the base branch (`lib/repo-stats.mjs`, every 60 s): its tip and the commits on its first-parent line since local midnight;
- git (`lib/repos.mjs`, `lib/trusted-repos.mjs`, `lib/git-state.mjs`) only in trusted repositories, worked out again on every
  refresh (never read back from the cache): the session folder's and the setup's own (the repository holding the running board
  code, from this code's real path: `~/.claude/tools` links into it). Claude Code's folder-trust record is not used: the owner runs
  with bypass permissions, so it is unreliable. Of those, up to 3 with work: the session's own and each one a registered worktree
  of which holds a folder this session used (an agent's edited files, its launch worktree, its cwd, the lead's edits). Git runs
  only on what the trusted repository records itself, read fresh on every refresh and never from the cache: its shared git folder
  (`--git-dir=<common>` for the refs and the base-branch facts) and each worktree it records (the main checkout, and
  `<common>/worktrees/<name>` whose `gitdir` names `<path>/.git` and whose `commondir` leads back to `<common>`; a main `.git`
  holding a `commondir` file is no main checkout), as `--git-dir=<that git folder> --work-tree=<path>`, so git
  never reads a worktree's own `.git` (a rewritten or racing `.git` cannot point it elsewhere) and `--ignore-submodules=dirty` keeps
  it out of nested repositories. Paths are compared as real paths in the disk's letter case. Every call has
  `-c core.fsmonitor=false -c safe.bareRepository=explicit`, no inherited `GIT_*` variable and `GIT_COMMON_DIR=<common>` (git
  would otherwise follow a git folder's `commondir` file even under `--git-dir=`), and one git budget per refresh. When git runs
  out of time (a loaded machine), a repository keeps its last good state for up to 60 s and its row says `stale`. Agents are
  matched to those worktrees by path prefix: the folders of the files they edited, newest first (Edit, Write, MultiEdit,
  NotebookEdit, counted only after the call succeeded; a Bash call's cwd says nothing of where it writes), then their isolation
  worktree (`meta.worktreePath`); the launch folder (launch record) and the cwd only say the repository. One refresh per session
  at a time (an O_EXCL lock file from `tools/disk-free/lib/lock-file.mjs`, broken after 20 s): one `for-each-ref` with
  `%(ahead-behind:main)` every 15 s, and `--no-optional-locks status --untracked-files=no` per worktree only when its index or
  HEAD changed (15 s at most); 1.5 s timeout per call and 3 s of git per refresh (sized for a loaded machine: a call takes
  up to ~0.3 s there), past which the old values stay with their age, or `unknown` with the reason where there are none.

A refresh over its budget (git's 4.5 s at most plus 300 ms) keeps the old board and marks it `stale N s` (the cursors it read are kept, so the next one
reads only new bytes). Journals, transcripts and meta files are Claude Code's internal formats: an unreadable part shows
nothing, never a wrong line, and never throws.

Not yet shown: the tidy-gate verdict, and which agent a question comes from (the asking marker holds no agent).

Files: `board.mjs` (the `refresh` command), `lib/` (see `lib/README.md`).
