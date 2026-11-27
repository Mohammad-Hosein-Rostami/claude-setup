# board

The status line's engine: a detached refresh writes each session's board file, `show` prints it as plain lines, and `tick` is
the boss's sync of the base (the branch checked out in the main checkout), its lanes and the plan.

The engine behind the status line: which agents run and the git state of the session's worktrees, in one small file the
status line reads (`~/.claude/state/board/<session>.json`, at most 48 KB). Node 22, no dependencies.

Run: `node ~/.claude/tools/board/board.mjs refresh --session <id> [--force]` rewrites the board file. You rarely run it by
hand: `home/statusline.mjs` starts it detached when the file is older than its refresh interval, and draws only what the file
holds, so a slow git or transcript scan never delays a render.

## The show command

`node ~/.claude/tools/board/board.mjs show [--session <id>] [--refresh] [--json]` prints the session's board file as plain
lines and writes nothing (session default `CLAUDE_CODE_SESSION_ID`). `--refresh` runs one forced refresh first (the same as
`refresh --force`); `--json` prints the board file's JSON instead of the lines. The lines (`lib/show.mjs`), every name and text
cleaned of control characters as on the status line:

```text
board <session> at <ISO time of the board's last write> <fresh|stale N s>
agent <id> <type> <running|done|quiet N min> branch <branch|-> folder <worktree|-> <doing|->
```

One `agent` line per agent, in the board's order; with no agents only the `board` line prints. `stale N s` is the board's own
mark: its last refresh went over its budget and kept data N seconds old (see [The refresh](#the-refresh)); anything else is
`fresh`, so read the time for the age. The lanes are `tick`'s (below).
Exit 0 shown, 1 no board file for the session (it prints the `refresh --force` command that writes one), 2 usage (a missing or
malformed session id, an unknown command).

## The tick command

The boss runs `tick` after every agent report and after every land; nothing runs it by itself. It reads only, apart from one
forced refresh of the session's board (for the agents) and `--mark-tess`:

```sh
node ~/.claude/tools/board/board.mjs tick --repo <abs main checkout> [--plan <abs pieces.json>] [--session <id>] [--json]
node ~/.claude/tools/board/board.mjs tick --repo <abs> --plan <abs> --mark-tess <feature> --sha <40-hex>
```

The lines (`lib/tick.mjs`), every branch name, path and agent name cleaned of control characters; `queue` and `features` print
only with `--plan`, `tests not landed` only when a test branch is left, `ledger` only when the land ledger has lines it cannot
parse or cannot be read at all:

```text
base <name> <sha> <clean|dirty>, <one line|not one line> (git-tidy check 0|1: <count> <kind>, ...)[, <n> landed since tess round at <sha>]
tidy <n> <kind> (<subject>[, +<n> more]), ... -> node ~/.claude/tools/git-tidy/git-tidy.mjs prune <repo>
folders <n> <state>, ...[ (oldest <n> h)]
lane <branch> <type> <agent id> <running|done|quiet N min>|no agent +<n> commits <clean|~<n> changed|changes ?> [claimed on <base>: lands only there|ready to land|ready to land (behind <name>; land rebases it)|behind <name>] [folder <state>]
tests not landed: <branch> +<n>[ (piece <piece>)][ (<type> <running|done|quiet N min>)], <branch> no commit (in <folder>), ..., +<n> more
overlap <lane or piece> x <lane>: <file>, <file>, <file>, +<n> more
stray <lane>: <files> (not in its files)
queue <piece> startable | <piece> after <piece>, ... | <piece> overlaps <lane>
features landed, not checked: <feature> <landed>/<pieces> (risk <risk>), ... -> tess due at 3 (now <n>)|tess due now (<why>)
ledger <n> bad lines skipped
ledger unreadable (<why>): no piece counts as landed
next: land <lane>; claim <piece>[ (branch <branch>)]; test branches <branch>, ...: land each one tess passed (land <branch> --repo <repo>), a failing repro gets a Fix: piece on its branch; tess on <feature>; dev <n>/3, tess <n>/3
```

- **base**: the branch checked out in the main checkout of `--repo`, by its own name (`git-tidy`'s base, never assumed to be
  `main`), with `git-tidy check`'s findings about it by kind: `dirty-base`, `merge-commit`, `stale-checkout`, and any kind not
  on the `tidy` line. `dirty` is a `dirty-base` finding, `not one line` a merge commit. Any finding is exit 1. With `--plan` it ends with the plan's pieces
  landed since the newest tess mark (`<n> landed and no tess round yet` before the first).
- **tidy**: only when `git-tidy check` finds leftovers beside the base: `tangled-ref`, `merged-branch`, `merged-tag`,
  `merged-worktree`, `stale-worktree`, `superseded-copy`, `agent-leftover`, each kind with its count and first subject. The
  command prints what `prune` would remove and changes nothing (`--apply` removes); it takes the same base as the tick. These
  findings are exit 1 but never block `next:`.
- **folders**: the pool's folders by state, as `git-tidy lane list` gives it, with a snapshot claim counted as `snapshot` and
  the age of the oldest snapshot lock in whole hours (left out when git cannot say); `folders none` with no pool folder.
- **lane**: each lane pool folder that holds a branch. Its files are `git diff --name-only <base>...<branch>` (as
  plumbing) plus the changed and untracked files in its folder; its agent is the board agent on that branch. `ready to land`: the agent is done (or none is on the board),
  the lane has commits and its folder is clean; `(behind <name>; land rebases it)` when the base has moved since it started.
  `behind <name>`: the base moved and the lane is not ready yet. `claimed on <base>: lands only there`: `lane claim` recorded
  another base for it (`branch.<lane>.cs-lane-base`) than the one checked out now; it is never ready here (land refuses it),
  so `next:` never lands it. A lane with no record counts as on the base. A lane outside the pool is not shown.
- **tests not landed**: every `test/*` branch (tess-write's) not landed on the base, at most 5, then `+<n> more`: its commits
  beyond the base, the plan piece whose `branch` it is and the board agent on it; one with no commit of its own shows the folder
  that holds it (a tess-write folder outside the pool). Left out: a branch a pool lane holds (it is on its `lane` line), a
  `tidy` subject, and one with no commit that no folder holds (merged: `prune` removes it). Only shown: the tick never lands
  or deletes one, and it is no finding (exit unchanged).
- **overlap**: two lanes share a file, or a piece whose `after` pieces have all landed declares a file a lane changed (that piece
  is not startable). **stray**: a lane on a piece's branch changed a file its piece does not declare. Either is exit 1; such a lane
  lands after the other one, with `land --test`.
- **queue**: the plan's pieces not landed and not in a lane. A piece is landed when the land ledger
  (`~/.claude/tools/land/ledger.mjs`) holds a land of its branch: its `branch`, else `lane/<piece id>`.
- **features**: the features fully landed and not checked, and every risky one (`risk` not `none`) with a landed piece and no
  tess mark since: no new piece should touch its files until tess returns. A feature is checked when its tess mark is newer than
  its newest land. tess (its quick look; `full` only when the owner asks) is due when a risky feature is listed, when 3
  features are fully landed and not checked, or when the plan's last piece has landed.
- **next**: only a suggestion: land one ready lane, claim startable pieces while fewer than 3 lanes are in flight (a piece
  with a `branch` as `claim <piece> (branch <branch>)`: claim that branch), land the test branches with commits and no plan
  piece or live agent (at most 3 named; land each one tess's report passed, and a failing repro gets a `Fix:` piece on its
  branch), start tess when it is due. While the base has a finding of its own it says `fix <name> first` and to start no new piece; a `tidy` finding never
  does.

`--mark-tess <feature> --sha <40-hex>` records that tess was started on that feature at that sha (it must be on the base), and
prints `marked <feature> for tess at <sha>`. The marks are in `~/.claude/state/board/jobs/<job>.json` as
`{ "<feature>": { "sha": "<40-hex>", "at": "<ISO>" } }`, written through a temp file and a rename; delete the file to forget
them. `--json` prints every fact as one JSON object (lanes with their files, folders with why and `lockedAtMs`, features, tess
status); `main` is the base (`branch` its name, `sha` its tip); `main.findings` holds the base's findings only and `tidy` the
side ones, each `{ "kind", "subject" }`; `lanes[].claimedOn` is the base a lane was claimed on (null with no record); `tests` holds the
test branches, each `{ "branch", "commits", "folder", "piece", "agent" }` (`folder`, `piece` and `agent` null when none).

Exit 0 shown; 1 findings (an overlap, a stray, a `git-tidy check` finding on the base or on the `tidy` line); 2 usage: a bad flag, a `--repo` that is not
a git repository, a missing or bad plan or marks file (the message names what is wrong), or a git failure.

### pieces.json

lex writes it next to the plan; the tick reads it with `--plan`. Ids (`job`, features, pieces) are letters, digits, `-` and `_`
(at most 64, starting with a letter or digit); `files` are repository-relative paths; `after` and `branch` are optional:

```json
{ "job": "<slug>", "repo": "<abs>", "base": "<40-hex>",
  "features": [{ "id": "login", "risk": "none | security,data,...", "spec": "<plan path>#<section>" }],
  "pieces": [{ "id": "login-1", "feature": "login", "files": ["<repo-relative path>"], "after": ["<piece id>"], "branch": "test/<topic>" }] }
```

A piece's branch is its `branch`, else `lane/<piece id>`. A `Fix:` piece names tess-write's repro branch (`test/<topic>`), so
it lands under that name and the tick counts it. A `branch` must be a name `lane claim --branch` takes and no base branch, and
no two pieces may share a branch: else the tick exits 2 and names the piece. No two pieces that can run at the same time share a file; the tick shows it when they do.

## The status line rows

`home/statusline.mjs` prints 2 rows when idle (git and session) and at most 4 when busy (spec R18, owner decisions RC14 to RC20
of 2026-11-22); the row budget is 6 rows from 20 terminal lines, 4 on 12 to 19 lines and 2 below 12. Each row is fitted to
`COLUMNS - 5` (Claude Code cuts a row there); from 90 usable columns each row leads with an 8-character dim label. From top to
bottom, at 100 columns:

| Row | Example (100 columns) | From |
| --- | --- | --- |
| agents, only while an agent runs | `agents  5 running · 1 done · ! tess-review quiet 6 min` | the board's agents (`lib/layout.mjs`) |
| git | `git     claude-setup  main  ↑2 to push · 1 staged · 3 changed · 1 new · stash 1` | the board's repositories (`lib/git-rows.mjs` gitLineRows) |
| git row 2: lanes or a second repository | `lanes   r18-git ↑2 ~3 dev · r18-est ↑4 ready to land · r17-col ↓5 behind · +2 more` | the same |
| session | `session Opus 5.5 high · context 29% · 5h 90% left, empty ~22:32 · 7d 47% left · acct mine` | the status input, the account's limit samples |

The agents row (RC8) is one summary whatever the number of agents: running counts the quiet ones, done is finished in the last
10 min, and only the agents that need a look are named (quiet ones), as many as fit and then `+K more`.

The git rows (RC15, RC19) come from the board's detached refresh only (render under 50 ms). In the session's repository: its name
(bold), the current branch, what to push and to pull (yellow), conflicts (red), an operation (`rebase 3/7`, yellow), staged,
changed and new files (`changes ?` where the refresh had refs only; `changes unknown` while git has not answered for that
worktree yet, with the reason in the board file's `unknown`; never null; new files are counted only on the session's own
worktree, at most every 60 s), the stash and the last commit's age (`branches unknown`, never
`✓ clean`, while git has given no branch refs and none are cached, with the reason in `refsUnknown`); then a `lanes` row of
its other active branches (checked out in the session folder or where a live agent works, with changes, ahead of the base
with a commit in the last 24 h, or
the base while not level with its upstream), at most 4 and then `+K more`, each with `↑2` ahead, `~3` changed, its agents,
`ready to land` or `↓5 behind` (normal colour: land rebases it). Outside a repository, or with a second one, one row per used repository (at most
2, then `+K more repos`) with its lanes after ` │ `. `git     loading` before the board's first refresh,
`git     no repository used in this session yet (~ is not one)`.
The session row: model and effort, context against the auto-compact window (`context 29%`, `context ?` after /compact until the
next call, `/clear` from 150k tokens), 5 h and 7 d left (`<1% left`; from 60 % used `, resets 22:10` rounded up, weekday when not
today; with no live 5 h window this account's last sample with its age), the 5 h pace `, empty ~22:32` (yellow) when it comes
before the reset, and the account (`CLAUDE_ACCOUNT`).

When a row does not fit, its parts drop by priority, never a value cut mid-token where a whole part can go: the git row's last
commit age first, then the stash (never the branch, conflicts, an operation, to pull or behind); lanes are counted in
`+K more`; the session row's account, then 7 d, then the 5 h clock. Over the row budget the rows kept are, in order: session,
git, agents, git row 2 (git row 1 then counts what row 2 held: `3 lanes`, `+1 more repo`). On an error while drawing,
the session row and one `status line error:` line still print.

### Colour (`lib/cells.mjs`)

Colour by kind (RC14, "dont over do"): three kinds have a colour of their own and nothing else has it: branch names green
(38;5;35), durations and clocks blue (38;5;33), the session's model, effort, context and limit values grey-violet (38;5;103).
Three states are reserved and stay basic ANSI, so the terminal theme maps them: yellow needs a look (to pull, an
operation, a quiet agent, 60-80 % used, the 5 h pace), red a problem (conflicts, over 80 % used), magenta needs you (no row
uses it since the alert row went with the question popup, 2026-11-25). Labels, ages and the ` · ` between parts are dim
(SGR 2), counts and words are in the default colour, repository names bold. The 256-colour codes go out when `TERM` has `256color` or `COLORTERM` is `truecolor` or `24bit`, else the basic 16
of the same kinds. A light palette (RC20, at least 4.36:1 on white) when `CLAUDE_STATUS_THEME=light` or `COLORFGBG` ends in
`;7` or `;15`; `CLAUDE_STATUS_THEME=dark` forces the dark one. Every state also has its word (`to pull`, `conflicts`,
`quiet`), so `NO_COLOR` (any value), `TERM=dumb` or the old Windows console (no Windows Terminal, no
`TERM_PROGRAM`) prints the same words with no escape code. Names from outside are cleaned of control characters and cut at a
word or `-` with `…`, never mid-word.

## The refresh

A refresh runs one at a time (a claim in the file), at most every 5 s while an agent is live and every 60 s when idle
(the status line's `refreshInterval` is 5 s). It reads, and keeps its cursors in `~/.claude/state/board-cache/<session>.json`:

- the subagent transcripts (`<session>/subagents/agent-<id>.jsonl`; an old `subagents/workflows/` folder is not read), only their new
  bytes since the last refresh, with their `.meta.json` (type, description, worktree) (`lib/agent-transcript.mjs`, `lib/agents.mjs`);
- each agent's tokens (the last call's usage: its context so far) and the folder of the last file it read or changed, which
  places it in a worktree when its own folder is the lead's;
- the base branch (`lib/repo-stats.mjs`, every 60 s): its tip and the commits on its first-parent line since local midnight;
- git (`lib/repos.mjs`, `lib/trusted-repos.mjs`, `lib/git-state.mjs`) only in trusted repositories, worked out again on every
  refresh (never read back from the cache): the session folder's and the setup's own (the repository holding the running board
  code, from this code's real path: `~/.claude/tools` links into it). Claude Code's folder-trust record is not used: the owner runs
  with bypass permissions, so it is unreliable. Of those, up to 3 with work: the session's own and each one a registered worktree
  of which holds a folder this session used (an agent's edited files, its isolation worktree, its cwd, live or done, and the
  lead's Edit/Write folders, read from the new bytes of the main transcript), newest use first. Git runs
  only on what the trusted repository records itself, read fresh on every refresh and never from the cache: its shared git folder
  (`--git-dir=<common>` for the refs and the base-branch facts) and each worktree it records (the main checkout, and
  `<common>/worktrees/<name>` whose `gitdir` names `<path>/.git` and whose `commondir` leads back to `<common>`; a main `.git`
  holding a `commondir` file is no main checkout), as `--git-dir=<that git folder> --work-tree=<path>`, so git
  never reads a worktree's own `.git` (a rewritten or racing `.git` cannot point it elsewhere) and `--ignore-submodules=dirty` keeps
  it out of nested repositories. Paths are compared as real paths in the disk's letter case. Every call has
  `-c core.fsmonitor=false -c safe.bareRepository=explicit -c core.hooksPath=/dev/null -c log.showSignature=false` (the null
  device on Windows), `GIT_NO_LAZY_FETCH=1` (a partial clone never fetches) and `GIT_OPTIONAL_LOCKS=0`, no inherited `GIT_*`
  variable and `GIT_COMMON_DIR=<common>` (git
  would otherwise follow a git folder's `commondir` file even under `--git-dir=`), and one git budget per refresh. When git runs
  out of time (a loaded machine), a repository keeps its last good state for up to 60 s and its row says `stale`. Agents are
  matched to those worktrees by path prefix: the folders of the files they edited, newest first (Edit, Write, MultiEdit,
  NotebookEdit, counted only after the call succeeded; a Bash call's cwd says nothing of where it writes), then their isolation
  worktree (`meta.worktreePath`); the cwd only says the repository. One refresh per session
  at a time (an O_EXCL lock file from `tools/disk-free/lib/lock-file.mjs`, broken after 20 s): one `for-each-ref` with
  `%(ahead-behind:<base>)` (the branch checked out in the main checkout) every 15 s, and `--no-optional-locks status --untracked-files=no` per worktree only when its index or
  HEAD changed (15 s at most); 1.5 s timeout per call and 3 s of git per refresh (sized for a loaded machine: a call takes
  up to ~0.3 s there), past which the old values stay with their age, or `unknown` with the reason where there are none.
  Before `status`, `config --list --name-only --show-scope` looks for a filter in the repository's own config (`status` would run
  it, and no flag turns filters off): such a worktree gets refs only (`trust: refs`, no counts).

A refresh over its budget (git's 4.5 s at most plus 300 ms) keeps the old board and marks it `stale N s` (the cursors it read are kept, so the next one
reads only new bytes). Journals, transcripts and meta files are Claude Code's internal formats: an unreadable part shows
nothing, never a wrong line, and never throws.

The board holds no job, step or estimate facts and no `where` tree (plan 2026-11-24).

Not yet shown: the tidy-gate verdict.

Files: `board.mjs` (the `refresh`, `show` and `tick` commands), `lib/` (see `lib/README.md`).
