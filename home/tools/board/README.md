# board

The status line's engine: a detached refresh writes each session's board file, `show` prints it as plain lines, `tick` is
the boss's sync of the base (the branch checked out in the main checkout), its lanes and the plan, `done` is tess's record
that it returned, and `start` claims a piece's lane or a tess snapshot and prints the brief to send.

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
forced refresh of the session's board (for the agents), the list of remembered plans and `--mark-tess`:

```sh
node ~/.claude/tools/board/board.mjs tick --repo <abs main checkout> [--plan <abs pieces.json>]... [--session <id>] [--json]
node ~/.claude/tools/board/board.mjs tick --repo <abs> --plan <abs> --mark-tess <feature> --sha <40-hex>
node ~/.claude/tools/board/board.mjs tick --repo <abs> --forget-plan <abs pieces.json>
```

**Remembered plans** (`lib/tick-jobs.mjs`): the tick remembers every plan (job) of the repository, so the boss passes a plan's
`--plan` once and later ticks read it without one. Each `--plan` (it may repeat) is read first (a bad one is exit 2 and is not
remembered) and then added to the list in `~/.claude/state/board/repos/<repo-key>.json` (`{ "plans": ["<abs>", ...] }`;
`<repo-key>` is the land ledger's, so every worktree of a repository shares one list and another repository never sees it). A
change of the list runs under a lock file beside it and writes a temp file and a rename, so two ticks that add plans at once
keep both. A job leaves the list when every piece has landed and every feature is checked (`job <slug> done (forgotten)`,
printed once), or by `--forget-plan <abs>` (`forgot <path>`, or `<path> was not remembered`; it goes with `--repo` alone).

The lines (`lib/tick.mjs`), every branch name, path and agent name cleaned of control characters; `queue` and `features` print
for each job the tick reads (none before the first `--plan`), `tests not landed` only when a test branch is left, `ledger` only
when the land ledger has lines it cannot parse or cannot be read at all, `hold` only for a held feature, `sync` only in the
setup's own repository; `agents` always, and one `job` line per job (`lib/tick-pace.mjs`). With two or more jobs, each job's
`queue`, `features`, `commits` and `hold` lines and its part of the `base` line start with `<job>: ` (a `job` line names its job
itself). The tick ends with the `next:` header and its numbered `do` lines (`lib/tick-do.mjs`):

```text
base <name> <sha> <clean|dirty>, <one line|not one line> (git-tidy check 0|1: <count> <kind>, ...)[, <n> landed since tess round at <sha>]
tidy <n> <kind> (<subject>[, +<n> more]), ... -> node ~/.claude/tools/git-tidy/git-tidy.mjs prune <repo>
folders <n> <state>, ...[ (oldest <n> h)]
lane <branch> <type> <agent id> <running|done|quiet N min>|no agent +<n> commits <clean|~<n> changed|changes ?> [claimed on <base>: lands only there|held by <feature>, ...|ready to land|ready to land (behind <name>; land rebases it)|behind <name>] [folder <state>]
tests not landed: <branch> +<n>[ (piece <piece>)][ (<type> <running|done|quiet N min>)], <branch> no commit (in <folder>), ..., +<n> more
overlap <lane or piece> x <lane or piece>: <file>, <file>, <file>, +<n> more
stray <lane>: <files> (not in its files)
clash <branch>: piece <a> of <job1>, piece <b> of <job2>
plan <path>: <problem> (forget it: node ~/.claude/tools/board/board.mjs tick --repo <repo> --forget-plan <path>)
plans list: <file> <problem>; delete it to start the list again
[<job>: ]queue <piece> startable | <piece> clash; after <piece>, ...; waits <branch>, ...; overlaps <lane or piece>, ...; held by <feature>, ... | ...
[<job>: ]features landed, not checked: <feature> <landed>/<pieces> (risk <risk>[ -> <classes>][, tess on it|, must-fix]), ... -> tess due at 3 (now <n>)|tess due now (<why>)
[<job>: ]commits <feature>: <from>..<to> ...
[<job>: ]hold <feature> until tess returns (tess not started|landed since its tess mark|tess on it at <sha>): <file>, <file>, <file>, +<n> more
job <slug> done (forgotten|not forgotten: <why>)
ledger <n> bad lines skipped
ledger unreadable (<why>): no piece counts as landed
agents <n> running: <type> <n> (<name>[ <n> min]|<name> quiet N min, ...), ...[; +<n> more]|agents none running
job <slug> (<abs pieces.json>): <n>/<n> landed, <n> in lanes, <n> waiting; <n>/<n> features checked; about <n> min per land (last <n>) -> about <n> h for <n> left|pace unknown (fewer than 2 lands)
sync running|never|ok at <sha>|failed[ at <sha>]: <first problem> (<n> times since <HH:MM>)|incomplete at <sha>: <machine> behind, ...|incomplete at <sha>: <machine> unreachable, ... (wake it and turn on Remote Login, then sync)|record unreadable (<why>)|state unknown (<why>)
next: <n> steps (dev <n>/3, tess <n>/3; these replace every earlier do line)
next: nothing to do now; <n> agents running (dev <n>/3, tess <n>/3)
next: fix <name> first (node ~/.claude/tools/git-tidy/git-tidy.mjs check <repo>), start no new piece; dev <n>/3, tess <n>/3[; <n> steps, these replace every earlier do line]
next: the land ledger cannot be read, so every hold is hidden: land nothing and start no new piece until it reads; dev <n>/3, tess <n>/3[; <n> steps, ...]
do <n>: land <lane> (<type> <id> done|no agent, +<n> commits) if its report says done, or partial with safe to land: yes (re-queue its open lines as a piece); never a blocked one: node ~/.claude/tools/land/land.mjs <lane> --repo <repo>
do <n>: land <lane> last (...; in an overlap or a stray: put the repository's whole test command for <suite>) if its report says done, ...: node ~/.claude/tools/land/land.mjs <lane> --repo <repo> --test '<suite>'
do <n>: resume <type> <id> (done; <lane> ~<n> changed|+0 commits): SendMessage it to finish and report
do <n>: release lane-<n> (snapshot <sha>, <n> h, no tess on it): node ~/.claude/tools/git-tidy/git-tidy.mjs lane release --repo <repo> --folder <folder> --expect '<lock reason>'
do <n>: start dev on <piece> (job <slug>[, branch <branch>]): node ~/.claude/tools/board/board.mjs start --repo <repo> --piece <piece>[ --job <slug>]
do <n>: start tess on <feature> (job <slug>; <why tess is due>): node ~/.claude/tools/board/board.mjs start --repo <repo> --tess <feature>[ --job <slug>]
do <n>: land <test branch> if tess passed it (a failing repro gets a Fix: piece on its branch): node ~/.claude/tools/land/land.mjs <test branch> --repo <repo>
do <n>: sync in the background (base <sha>, synced <sha>|never|unknown[; <machine> behind, ...]): node <repo>/scripts/sync-machines.mjs --repo <repo>
do <n>: sync failed <n> times since <HH:MM> (<first problem>): tell the owner once, then a Fix piece; retry: node <repo>/scripts/sync-machines.mjs --repo <repo>
```

- **base**: the branch checked out in the main checkout of `--repo`, by its own name (`git-tidy`'s base, never assumed to be
  `main`), with `git-tidy check`'s findings about it by kind: `dirty-base`, `merge-commit`, `stale-checkout`, and any kind not
  on the `tidy` line. `dirty` is a `dirty-base` finding, `not one line` a merge commit. Any finding is exit 1. With a job it ends with the job's pieces
  landed since its newest tess mark (`<n> landed and no tess round yet` before the first), one part per job.
- **tidy**: only when `git-tidy check` finds leftovers beside the base: `tangled-ref`, `merged-branch`, `merged-tag`,
  `merged-worktree`, `stale-worktree`, `superseded-copy`, `agent-leftover`, each kind with its count and first subject. The
  command prints what `prune` would remove and changes nothing (`--apply` removes); it takes the same base as the tick. These
  findings are exit 1 but never block `next:`.
- **folders**: the pool's folders by state, as `git-tidy lane list` gives it, with a snapshot claim counted as `snapshot` and
  the age of the oldest snapshot lock in whole hours (left out when git cannot say); `folders none` with no pool folder.
- **lane**: each lane pool folder that holds a branch. Its files are `git diff --name-only <base>...<branch>` (as
  plumbing) plus the changed and untracked files in its folder, plus the declared `files` of the plan piece (of any job) on its
  branch, so a lane with no commit yet already counts its piece's files; its agent is the board agent on that branch. `ready to land`: the agent is done (or none is on the board),
  the lane has commits and its folder is clean; `(behind <name>; land rebases it)` when the base has moved since it started.
  `behind <name>`: the base moved and the lane is not ready yet. `claimed on <base>: lands only there`: `lane claim` recorded
  another base for it (`branch.<lane>.cs-lane-base`) than the one checked out now; it is never ready here (land refuses it),
  so `next:` never lands it. `held by <feature>`: a **hold** is on one of its files; it is not ready either. A lane with no
  record counts as on the base. A lane outside the pool is not shown.
- **tests not landed**: every `test/*` branch (tess-write's) not landed on the base, at most 5, then `+<n> more`: its commits
  beyond the base, the plan piece whose `branch` it is and the board agent on it; one with no commit of its own shows the folder
  that holds it (a tess-write folder outside the pool). Left out: a branch a pool lane holds (it is on its `lane` line), a
  `tidy` subject, and one with no commit that no folder holds (merged: `prune` removes it). Only shown: the tick never lands
  or deletes one, and it is no finding (exit unchanged).
- **overlap**: two lanes share a file, a piece whose `after` pieces and `waits` branches have all landed declares a file of a
  lane (that piece is not startable), or two pieces that could both start now share a file (across every job, in plan order,
  then piece order: only the first starts, the other shows `overlaps <piece>`). **stray**: a lane on a piece's branch changed a file its piece does not declare. Either is exit 1; such a lane
  lands after the other one, with `land --test`.
- **clash**: two plans name one branch (two jobs reuse a piece id, or give the same `branch`): neither piece is startable
  (`clash` in its queue) until one plan changes. Exit 1.
- **plan**, **plans list**: a remembered plan that cannot be read (gone, not JSON, not the format) is skipped, with the command
  that forgets it; a list file that cannot be read (torn, a link, too big) is never overwritten: delete it. Either is exit 1,
  and the rest of the tick still prints.
- **queue**: the job's pieces not landed and not in a lane. A piece is landed when the land ledger
  (`~/.claude/tools/land/ledger.mjs`) holds a land of its branch (its `branch`, else `lane/<piece id>`) made after the plan's
  `base`: a land whose commit the base already holds belongs to an older job that used the same branch name. A piece is
  `startable` when nothing holds it back; else it shows each thing that does, joined by `; `: `clash`, `after <piece>` (not
  landed yet), `waits <branch>` (no land of that branch in the ledger yet), `overlaps <lane or piece>`, `held by <feature>`.
- **features**: the features fully landed and not checked, and every risky one with a landed piece that is not checked: the tick
  holds its files (see **hold**). A feature is risky when its `risk` is not `none`, or when the risk tool
  (`~/.claude/tools/risk/risk.mjs --base <from> --tip <to>`, on each land while tess has not returned on it) finds a class on
  one of its lands, shown as `risk none -> <classes>` (`unknown` when the tool fails: risky too). A feature is checked when its tess mark's sha holds every
  land of its pieces and tess recorded `done` with verdict `ok` on that mark ([The done command](#the-done-command)); a mark
  with no `done` (tess still running, or one that died) checks nothing: while a tess agent runs such a feature is listed with
  `, tess on it` and is not due again; with no tess running that tess died, and the feature is due again. A feature whose verdict on such
  a mark is `must-fix` is listed with `, must-fix` and is not due again until its fix lands: a piece of it after the mark, or
  any commit on the base since the mark's sha that touches the feature's files (its landed pieces' declared files and every
  file its lands changed), so a fix made on a branch that is no plan piece is re-checked too.
  tess (its quick look; `full` only when the owner asks) is due when a risky feature is listed without `must-fix`, when 3
  features are fully landed and not checked, or when the plan's last piece has landed.
- **hold**: a risky feature with a land holds its files until tess returns: the declared `files` of its landed pieces and
  every file its lands changed (`git diff-tree` of each ledger range, so a stray landed with `land --test` is held too). It is
  `tess not started` (no mark), `landed since its tess mark` (a land the mark does not hold) or `tess on it at <sha>` (the
  mark holds every land and tess has not recorded `done`). It ends when tess records `done` on a mark that holds every land,
  with either verdict: a `must-fix` frees the files for the fix, whose land (a plan piece or any commit on those files) holds them again. Holds count across every
  job the tick reads: a piece on a held file shows `held by <feature>` and is not startable, a lane on one is not ready. A hold
  is no finding (the exit is unchanged); a land whose files git cannot list is exit 2.
- **agents**: the session's agents that run (quiet ones included; done ones are not counted), by type in the board's order,
  each type with its count and its agents' names (the description they were started with), each with the minutes since it
  started (left out when the board does not know its start), or `quiet N min` while it is quiet; at most 6 names in all, then
  `; +<n> more`.
- **job**: each job the tick reads, with its plan file: its pieces landed, in a lane and waiting (in the queue), its features
  checked by tess, and its measured pace: the median gap between the job's consecutive lands in the land ledger (the newest 6
  gaps, `last <n>` says how many) times the pieces not landed yet (those in lanes included), in minutes, from an hour on in
  hours (`under 1 min` below a minute; `none left` once every piece landed). Under 2 lands it says
  `pace unknown (fewer than 2 lands)`; it never guesses. No finding (the exit is unchanged).
- **sync**: only in the setup's own repository (the one holding the running board code; a path lookup that fails counts as
  another repository, so the rest of the tick still prints) with `scripts/sync-machines.mjs`: the
  sync record `sync-machines.mjs` writes after each run (`lib/sync-record.mjs`), so a failed sync stays on screen. A machine is
  synced only at the base's tip by a base run, never by a `--tag` run. `incomplete` names each machine `unreachable`, with
  what to do, when every machine left behind was one ssh did not reach; else each one `behind`. No finding (the exit is
  unchanged).
- **next** and **do**: only suggestions: the boss runs each `do` line in order, as printed, and keeps every judgement; the
  lines of a new tick replace every earlier one (a land prints the next tick). The order is land, resume, release, start dev,
  start tess, test branches, sync. `dev <n>/3` counts the lanes not on `test/*`. **land**: each ready lane not on `test/*`
  (never a held one), one in an overlap or a stray last, with the repository's suite as `--test` (copied as printed,
  `'<suite>'` fails and nothing lands). **resume**: a lane whose agent is done but left changes or no commit. **release**: a
  snapshot whose lock is at least 1 h old, while every live tess of this session names its own folder (`lane-<n>`, as
  `board start --tess` names it) and none names this one: a live tess whose name names no folder holds every release back. The
  release passes the lock reason as `--expect`, so a folder claimed again since the tick is never freed. **start dev**: the
  startable pieces of every job in plan order (none share a file, none is held or in a clash) while fewer than 3 dev lanes are
  in flight; `--job` when the tick reads two or more jobs. **start tess**: each feature listed for tess in a job with tess due,
  while fewer than 3 tess run; `board start --tess` claims the snapshot and writes the mark. **test branches**: a ready pool
  lane on `test/*` (it never gets a plain land line), then each `test/*` branch with commits and no plan piece or live agent,
  at most 3. **sync**: in the setup's own repository, when its path is one sync takes, no sync runs and not every machine is
  at the base's tip; `sync failed` instead while the last runs failed. No sync `do` line while the last run was at the base's tip
  and every machine it left behind was out of ssh's reach (its problem starts with `unreachable:`): the `sync` status line
  says `unreachable` and to wake it, since a sync again would only fail on it again. While the base has a finding of its own the header says
  `fix <name> first`, and while the land ledger cannot be read (it hides every land, so every hold) it says to land nothing
  and start no new piece: then only resume, release and sync lines print. A `tidy` finding never holds a step back.

`--mark-tess <feature> --sha <40-hex>` (with exactly one `--plan`, which it does not add to the list) records that tess was
started on that feature at that sha (it must be on the base), and prints `marked <feature> for tess at <sha>`. The marks are per
repository and job, in `~/.claude/state/board/repos/<repo-key>/marks-<job>.json` as
`{ "<feature>": { "sha": "<40-hex>", "at": "<ISO>", "qa": "<level>", "done": { "verdict": "ok|must-fix", "at": "<ISO>" } } }`
(`qa` only when the mark was given one, `done` only once tess recorded its verdict; a new mark of a feature replaces its old one,
`done` included), written through a temp file and a rename under a lock file; delete the file to forget them. An older
`~/.claude/state/board/jobs/<job>.json` is read while the new file is not there yet, and never written: the next mark copies its
marks into the new file. `--json` prints every fact as one JSON object (lanes with their
files and `held`, folders with why and `lockedAtMs`, `agents` (the session board's agents), `jobs`: each with `job`, `path`,
`lands` (the plan's lands in the land ledger, each its ledger line), `queue` (each piece with its `files`,
`after`, `waits`, `overlaps`, `held`, `isClash` and `isStartable`), `features` (each with tess's `verdict` on a mark holding all
its lands, or null, `isChecked`, `riskFound` and `tessOn`, the sha of that mark while tess has not returned on it), `tess`
status (`features` listed, `underTess` tess is on, `fixing` waiting for a fix), `holds` (each `{ "feature", "why", "sha",
"files" }`), `isDone`; `clashes`,
`planProblems`, `listProblem`, `forgotten`); `main` is the base (`branch` its name, `sha` its tip); `main.findings` holds the base's findings only and `tidy` the
side ones, each `{ "kind", "subject" }`; `lanes[].claimedOn` is the base a lane was claimed on (null with no record); `tests` holds the
test branches, each `{ "branch", "commits", "folder", "piece", "agent" }` (`folder`, `piece` and `agent` null when none).

Exit 0 shown; 1 findings (an overlap, a stray, a clash, a `git-tidy check` finding on the base or on the `tidy` line, a remembered
plan or the list that cannot be read, a done job that could not be forgotten); 2 usage: a bad flag, a `--repo` that is not a git
repository, a missing or bad `--plan` or marks file (the message names what is wrong), or a git failure.

### pieces.json

lex writes it next to the plan; the tick reads it with `--plan` and remembers it. Ids (`job`, features, pieces) are letters,
digits, `-` and `_` (at most 64, starting with a letter or digit); `base` is the full sha of the base when the plan was written (a
commit of the repository); `files` is a non-empty list of repository-relative paths; `after`, `branch` and `waits` are optional,
and so are the texts a brief takes: a feature's `spec`, `qa` and `acceptance`, a piece's `acceptance` (strings):

```json
{ "job": "<slug>", "repo": "<abs>", "base": "<40-hex>",
  "features": [{ "id": "login", "risk": "none | security,data,...", "spec": "<plan path>#<section>", "qa": "quick look", "acceptance": "<text>" }],
  "pieces": [{ "id": "login-1", "feature": "login", "files": ["<repo-relative path>"], "after": ["<piece id>"], "branch": "test/<topic>",
    "waits": ["<branch of another job>"], "acceptance": "<text>" }] }
```

The tick knows these fields: `job`, `repo`, `base`; a feature's `id`, `risk`, `qa`, `spec` and `acceptance`; a piece's `id`,
`feature`, `files`, `after`, `branch`, `waits` and `acceptance`. It ignores any other field (`test` included), so a plan may
carry notes for lex or dev.

A piece's branch is its `branch`, else `lane/<piece id>`. A `Fix:` piece names tess-write's repro branch (`test/<topic>`), so
it lands under that name and the tick counts it. A `branch` must be a name `lane claim --branch` takes and no base branch, and
no two pieces may share a branch: else the tick exits 2 and names the piece. It does the same for an empty `files`, an `after`
cycle of any length (`a` after `b` after `a`: neither could ever start) and a bad `waits`. A piece's `waits` lists the branches
of another job that must land before it (at most 16, each a name `lane claim --branch` takes); the piece is not startable
until each has a land in the ledger (`waits <branch>` in its queue). Two plans may reuse a piece id, but not a branch (the tick shows a `clash`). No two pieces
that can run at the same time share a file; the tick shows it when they do.

## The done command

tess runs `done` when it returns, before it releases its folder, so the board knows it returned and with which verdict:

```sh
node ~/.claude/tools/board/board.mjs done --repo <abs main checkout> --job <slug> --tess <feature> --sha <40-hex> --verdict ok|must-fix
```

It writes `done: { verdict, at }` into the job's tess mark of that feature, under the same lock as `--mark-tess`, and prints
`done <feature> at <sha8>: <verdict>`. Only the mark at that exact sha takes it: a tess started on an older mark cannot check a
feature marked again since. `ok` checks the feature (when the mark's sha holds all its lands); `must-fix` keeps it unchecked and
not due until its fix lands (a piece of it, or any commit on its files since that sha). A second `done` on the same mark replaces the first.
Exit 0 recorded; 1 no tess mark of that feature at that sha in the job (`no tess mark for <feature> at <sha8>`, nothing
written); 2 usage: a `--repo` that is not an absolute path or a git repository, a job or feature that
is not a name, a sha that is not 40 hex characters, another verdict, marks that cannot be read or written, or the lock busy.

## The start command

The boss runs `start` for a step the tick names, so no claim, tess mark or brief is written by hand:

```sh
node ~/.claude/tools/board/board.mjs start --repo <abs main checkout> --piece <id> [--job <slug>] [--session <id>]
node ~/.claude/tools/board/board.mjs start --repo <abs main checkout> --tess <feature> [--job <slug>] [--qa <level>] [--session <id>]
```

It first runs `tick --json` (`lib/start.mjs`), so it judges a piece or feature by the facts the tick prints: the remembered
plans, the queue, the holds, the lanes and their agents. The piece or feature is looked up in every remembered plan; an id two
plans share needs `--job`. Neither takes `--base`: the base is the branch checked out in the main checkout. The claim is
`git-tidy lane claim`'s own (claim, then the deps prep), under its pool lock, so two starts of one piece make one claim.

`--piece` claims the piece's branch (its `branch`, else `lane/<id>`) at the base's tip and prints dev's brief:

```text
started lane/<id> in lane-<n> at <sha8> (job <slug>)
start dev with description "dev <id>" and this brief, whole:
worktree: <abs lane folder>
BRANCH: lane/<id>
BASE: <40-hex>
repo: <abs main checkout>
piece: <id> (feature <feature>, risk <risk>, job <slug>)
spec: <feature spec>#<id>|none in the plan
files: <file>, <file>, ...
tests: none (owner rule): write and run no tests; where your change alters text a test pins, update only that expectation, by reading, and name it as a stale pin
report: starts with `verdict:` (dev.md, Report)
```

`spec` is the feature's `spec`, with `#<id>` added when it names no section. It refuses (exit 1, `start refused: <why>`) a
piece that has landed, any piece while the base has a finding of its own or the land ledger cannot be read, and a piece the
queue does not call `startable`, with its queue state as the reason (`<id> after <piece>`, `held by <feature>`, `overlaps
<lane>`, `clash`, `waits <branch>`): a held piece is never started. A piece whose branch a pool lane already holds gets no
second claim: with no live agent on it and no hold on its files it prints `already claimed in lane-<n>; brief again:` and the
brief (exit 0, `BASE:` the commit the lane's branch is on: its fork point from the base, the claim's sha until dev rebases,
never the base's tip now); a live agent is `<type> <id7> is on it (lane-<n>)`, a hold `held by <feature>`
(exit 1).

`--tess` claims a snapshot at the tick's base sha, then marks the feature for tess at that sha (the `qa` level is kept in the
mark), and prints tess's brief:

```text
snapshot lane-<n> at <sha8>; marked <feature> for tess (job <slug>)
start tess with description "tess lane-<n> <feature>" and this brief, whole:
qa: <level>
repo: <abs main checkout>
main: <40-hex>
worktree: <abs snapshot folder>
feature: <feature>
commits: <from8>..<to8> ...
suite: yes|no
spec: <feature spec>|none in the plan
acceptance: <feature acceptance>|<piece>: <piece acceptance>; the spec's lines of pieces <piece>, ...|none in the plan
risk: <risk>[ -> <classes the risk tool found>]
job: <slug>
done: node ~/.claude/tools/board/board.mjs done --repo <abs> --job <slug> --tess <feature> --sha <40-hex> --verdict <ok|must-fix>
release: node ~/.claude/tools/git-tidy/git-tidy.mjs lane release --repo <abs> --folder <abs snapshot folder>
```

`acceptance` is the feature's own `acceptance` when the plan gives one; else, for the pieces that have landed, each piece's own
`acceptance` and `the spec's lines of pieces <ids>` for those with none (when the feature has a `spec`); `none in the plan` when
neither is there. Two `--tess` starts of one feature at the same moment can both claim a snapshot and mark it: the due check
and the mark are not under one lock.

`--qa` takes tess's levels (`quick`, the default, `smoke`, `checks`, `full`, `review`, `tests`, `edge`, `deps`, `ui`,
`repro`, `e2e`; several with spaces or commas), only on the owner's ask. `suite: yes` only for the first `full` tess at that
sha (no mark at it has `full`), so one full suite runs per sha. A feature with no land is refused; with the quick look, so is
one the tick does not list for tess: `<feature> is checked at <sha8>`, `waits for its fix` (no commit on its files has landed
since the must-fix), `tess is on <feature>`, or `not due yet`. A mark that cannot be written after the claim is refused with the command that releases the spare snapshot.

Every name and path is cleaned of control characters; the folder, repository and file paths and every word of a printed command
are shell-quoted when they hold a space or a quote. Exit 0
started or brief again; 1 refused, or the claim failed (`start refused: lane claim exit <n>: <line>`, the claim's exit codes,
or its `lane not ready` lines); 2 usage: a bad flag, an unknown id, an id in two plans with no `--job`, no remembered plan
(tick once with `--plan`), or a tick that failed.

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
  places it in a worktree when its own folder is the boss's;
- the base branch (`lib/repo-stats.mjs`, every 60 s): its tip and the commits on its first-parent line since local midnight;
- git (`lib/repos.mjs`, `lib/trusted-repos.mjs`, `lib/git-state.mjs`) only in trusted repositories, worked out again on every
  refresh (never read back from the cache): the session folder's and the setup's own (the repository holding the running board
  code, from this code's real path: `~/.claude/tools` links into it). Claude Code's folder-trust record is not used: the owner runs
  with bypass permissions, so it is unreliable. Of those, up to 3 with work: the session's own and each one a registered worktree
  of which holds a folder this session used (an agent's edited files, its isolation worktree, its cwd, live or done, and the
  boss's Edit/Write folders, read from the new bytes of the main transcript), newest use first. Git runs
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
