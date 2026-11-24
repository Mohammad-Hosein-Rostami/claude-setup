# git-tidy

Checks that a repository's history is one straight line, and finds (and, on request, removes) the branches and worktrees
whose work is already on the base, older copies of a re-done lane and the leftover branches of workflow agents; `land`
puts a lane on the base. The rule it enforces: rebase, never merge; no merge commits; a branch and its
worktree are removed once their work is on the base. Node 22 and git 2.38 or newer (`merge-tree --write-tree`), no dependencies. Git is run
without a shell, with an explicit folder, and `GIT_DIR`, `GIT_WORK_TREE` and the other variables that pick a repository
are removed from its environment, so only the folder you give is ever read or changed.

Run: `node ~/.claude/tools/git-tidy/git-tidy.mjs check [dir] [--base <branch>] [--json]`
and `node ~/.claude/tools/git-tidy/git-tidy.mjs prune [dir] [--base <branch>] [--apply] [--include-recent] [--json]`.
`land <branch> [dir] [--base <branch>] [--rebase-only] --tip <sha> [--brief <file>] [--json]` and `range <sha> [dir] [--base <branch>] [--landed <sha>] [--json]` are described under "land" below.
`check` and `prune` print `base: <branch> (from --base | from origin/HEAD | fallback)` first.
`dir` defaults to the current folder (any folder inside a repository, a linked worktree or a bare repository).

The base is `--base`, else the branch `origin/HEAD` points at, else the first that exists of `main`, `master`, `develop`.
It must be a local branch; when none is found the exit code is 2 and the message names `--base`. `prune --apply` also
exits 2, deleting nothing, when the base was not given with `--base` and more than one of `main`, `master`, `develop`
exists here: a wrong base would call work "merged" that is not on the branch you work against.

`land` has its own codes (0 landed and clean, 1 landed with findings, 2 not ready or no `--tip`, 3 conflict, 5 base moved, 6 ui-proof, 7 new-file-size, 8 upstream-moved, 9 tip-moved). Land through `land-lane` (`tools/land-lane/README.md`): it adds the disk check and the row close around this command. Landing has no test run and no review record; `--checks` and the old UI waiver flag are refused (exit 2).

| Code | `check` | `prune` |
| ---- | ------- | ------- |
| 0 | clean (hints never change it) | done, or nothing to do, or a plan without `--apply` |
| 1 | findings | `--apply` kept or could not remove something it planned to (the line says why) |
| 2 | usage error, not a git repository, base not found, any git command that fails | the same, and `--apply` while a rebase, merge, cherry-pick, revert or bisect is unfinished in any worktree, or with an ambiguous base |

## check

One line per item, `<kind> <subject> <detail>`, findings first, then hints (kind ends in `?`), then
`git-tidy: N findings, M hints (base <branch>), all local refs on one line: yes|no` (no when there is a `merge-commit`, `tangled-ref`, `merged-branch`, `merged-tag`, `superseded-copy` or `agent-leftover` finding; hints do not count). `--json` prints `{ base, findings, hints }` with items
`{ kind, subject, detail }` (a path with spaces is exact there).

| Finding | Meaning |
| ------- | ------- |
| `merge-commit <hash> <subject>` | a merge commit reachable from `HEAD` or the base that the base's upstream does not have; with no upstream, every merge commit on the base and on `base..HEAD` |
| `merged-branch <name> <hash> ancestor` | the branch tip is on the base (a branch created and never committed to also lands here) |
| `tangled-ref <ref> <n> merge commits ...` | a local branch or a `backup/` tag (full ref name; not the base, not the current branch) that still reaches a merge commit no remote-tracking ref has (with no remote: that the base lacks). Old tangled history stays visible in `git log --graph --all` through such refs |
| `merged-branch <name> <hash> patch-equal` | every non-merge commit has an equal patch on the base (a rebase or cherry-pick that landed) AND merging the branch into the base would change nothing (`git merge-tree --write-tree` gives the base's own tree). Patch ids ignore whitespace and skip merge commits, so the second proof is what keeps a branch that differs only in indentation, or holds a hand-made change in a merge, from being called merged |
| `merged-tag <tag> <hash> patch-equal` | a `backup/` tag that is not on the base's history but whose work is all on the base by the same test: a temporary backup made before a history clean-up. A tag that is an ancestor of the base (a release tag) is never reported |
| `superseded-copy <name> <hash> all its work is in <B>` | an older copy of a re-done lane: it is in a family with B (same name once `-<n>`, `-fix`, `-fixes`, `-v<n>`, `-redo` are cut off, or the same tip) and its tip is an ancestor of B, or every `git patch-id --verbatim` of `base..<name>` is in `base..B` (`--verbatim`: a whitespace-only change is a different patch) and merging `<name>` into B changes nothing (`git merge-tree --write-tree` gives B's own tree); a branch with a merge commit only by the ancestor proof. B is never itself a copy; between branches that cover each other the newest committer date stays, then the one checked out in a worktree, then the name. The newest of the family is named by `unlanded-lane?` |
| `agent-leftover <name> ...` | a `worktree-agent-*` (subagent) or `worktree-wf_*` (workflow agent) branch every commit of which is on the base or on a branch that is not an agent branch, and that no existing worktree has checked out (the Agent tool leaves one behind). It replaces the `merged-branch` line of the same branch |
| `merged-worktree <path> branch <name>` | a linked worktree whose branch is a `merged-branch` |
| `stale-worktree <path> folder missing` | a registered worktree whose folder is gone |
| `dirty-base <path> <n> changed tracked files: ...` | the folder where the base is checked out has uncommitted changes to tracked files (untracked and ignored files do not count); edits belong in a lane worktree |
| `stale-checkout <path> index is at <old>, branch <b> moved to <new> under it (<n> commits): ...` | the branch checked out there moved forward without the folder (`git update-ref`, `branch -f` or `push/fetch .` from another worktree): the index still equals an earlier position of the branch from its reflog (last 50), behind the tip, so every landed change shows as staged. Fix: `git -C <path> reset --soft <old> && git -C <path> merge --ff-only <new>` (unstaged edits stay; the merge refuses rather than overwrite one). Never commit or stash those staged changes: a commit, or stash + `reset --hard` + `stash pop`, re-applies them and reverts the landed commits. A soft reset is not reported (it leaves the index ahead of the tip); a folder that also has real staged edits on top is not found |

The base and the branch checked out in the main worktree are never reported as merged.

| Hint | Meaning |
| ---- | ------- |
| `published-merge?` | merge commits already on the base's upstream; rewriting them needs the owner |
| `merged-tag?`, `tangled-tag?` | the same two checks for a tag NOT named `backup/`. Whether a tag is published cannot be known without the network (a release tag on a backport branch is normal), so only `backup/` tags, the name the clean-up procedure gives its temporary tags, are findings |
| `unmerged-branch?`, `unmerged-tag?` | a local branch or tag with commits the base lacks: how many, and the date of its last commit |
| `unlanded-lane? <name> ahead <n>, no commit for <h> h: ...` | such a branch whose last commit is over 2 hours old: land it or say why it waits |
| `ignored-files?` | a merged worktree holds ignored files that exist only there (`prune` keeps it) |
| `merged-remote-branch?` | an `origin/*` branch fully contained in the base's upstream; deleting it is the owner's call |
| `behind-base?` | the current branch does not contain the base tip (rebase needed) |
| `dirty-worktree?` | a linked worktree with uncommitted or untracked files |
| `stale-lock?` | a linked worktree locked over a day ago (the age is the mtime of its `locked` file; the reason is shown): unlock it with `git worktree unlock` if no agent or session works there. Prune and the in-work check never touch a locked worktree |
| `in-progress?` | a rebase, merge, cherry-pick, revert or bisect is unfinished in that worktree |
| `shallow?` | a shallow clone: history is cut, so a branch may look unmerged (never the other way round) |

## prune

Without `--apply` it prints the plan and changes nothing (it may add unreferenced tree objects through `merge-tree`, which
`git gc` removes): `remove` lines for each stale worktree, merged worktree and merged branch it would remove, `keep` lines
with the reason for each it would not, a `tags (...)` line naming merged tags, and a summary. A merged branch whose only
holders are worktrees in the plan is planned for removal too.

Principle: it removes only what is provably on the base AND leaves no only-copy of anything behind. When in doubt it keeps
and prints why. With `--apply`, in this order, each fact read again from git right before it is acted on:

1. `git worktree prune`, for stale entries (a locked one is kept).
2. Each merged worktree is kept (`kept ...: <reason>`) when any of these holds, else `git worktree remove` (never `--force`):
   it is locked; it is the folder the command runs from or contains the shell's current folder; its branch is no longer
   merged; it has any `git status --porcelain` output (untracked files included, whatever `status.showUntrackedFiles` says)
   or git status fails; it holds ignored files (not OS clutter: `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`) outside `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`,
   `.turbo`, `.cache`, `.nx`, `test-results`, `playwright-report`, `.vite` (up to 5 paths are printed, `+N more`);
   its branch reflog or its HEAD reflog holds commits that are on no other ref (branch, tag, remote-tracking), not on the base
   and not landed there (a pre-rebase copy of a landed commit does not count, nor a commit of another branch the worktree
   once visited); more than 200 reflog entries (not checked); or any tracked file, its index or its HEAD
   reflog changed in the last 60 minutes (`used <n> min ago`; `--include-recent` lifts only this rule).
   A lane with no commit of its own yet (its branch reflog records no commit, cherry-pick, revert, am or pull, and every entry is on the base; a rebase or
   fast-forward onto a moved base does not count) keeps this rule even with `--include-recent`, printed as `not started yet (no commit of its own), used in
   the last 60 min`; a missing or unreadable reflog counts as started. That rule reads file and reflog times, so `touch` can defeat it: it is a
   courtesy guard, not a lock.
3. Each merged branch that is not checked out in any remaining worktree and whose reflog holds nothing that is not on the
   base: deleted with `git update-ref -d refs/heads/<name> <tip read a moment ago>`, so a branch that moved since is kept,
   printing `deleted <name> (was <full hash>)`. Its `branch.<name>.*` config section goes too. A branch name is always passed
   as a full ref, so a tag with the same name is never confused with it.

4. Copies (`superseded-copy`, `agent-leftover`) go the same way (their worktree first, then the branch) with the same safeties, and these
   differences: the proof is "all its work is in B" (read again right before the removal) instead of "on the base"; the reflog check
   counts a commit as safe when it is on B; and a copy's worktree used in the last 60 minutes is always kept
   (`used <n> min ago (an agent may still work there)`), `--include-recent` does not lift it, because an agent may still be working there.
   An `agent-leftover` that is on the base is a merged branch for prune.

A failure of one item does not stop the others; the run ends with exit code 1 if anything was kept or failed.

## land

`git-tidy land <branch> [dir] [--base <branch>] [--rebase-only] --tip <sha> [--brief <file>] [--matrix <abs lane matrix>] [--json]`
puts a lane on the base as one straight line:

0. `--tip <full 40-hex sha>` is the sha the caller expects the lane to be at. A full land without it exits 2 (`land needs --tip <full sha of the lane's tip>`),
   `--rebase-only` takes it as an option. Before anything else `refs/heads/<branch>` is compared with it; a branch that is anywhere else exits 9
   (`tip-moved`, JSON `status`) and nothing is changed. A missing branch is the usual exit 2.

1. The base branch must be checked out in a worktree (the base folder) with no tracked changes, else exit 2 naming the files.
   Untracked files there never block and are never touched, except an untracked path the lane would write over: exit 2 naming it, before any change.
2. The lane is rebased onto the base in the worktree that holds it, or in a temporary worktree that is removed afterwards. A conflict aborts the rebase,
   leaves the lane where it was and exits 3 naming the files. `patches-changed` counts the lane's commits whose `git patch-id --stable` differs after the rebase.
   `--rebase-only` stops here and prints `tip <sha>` and `patches-changed <n>`. A full land lands only the `--tip` sha, the commit the caller checked:
   when the rebase rewrites it (the base moved after it was rebased), nothing lands and it exits 5 (`base-moved`) with the new tip; land again with
   `--tip <new tip>` after checking that tip. A lane that is behind the base therefore lands in two runs: `--rebase-only`, then `--tip <rebased tip>`.
3. Checks on the rebased tip (there is no test run and no review record):
   - A file the lane adds (`<base>..<tip>`, renames counted as adds) over the commit gate's `MAX_NEW_FILE_BYTES` (5 MB, imported from
     `hooks/lib/new-file-size.mjs`) whose path the `--brief <file>` text does not name (the commit gate's `namesPath`) stops it: exit 7
     (`new-file-size`). No `--brief` names no path; a file already on the base never counts.
   - The UI check plan of the rebased diff must be proved (`lib/ui-plan-check.mjs`): `ui-proof check --plan --base <base> --tip <tip>`
     with `--request <brief>` and `--matrix <lane matrix>` recomputes the plan (rules: `home/standards/ui-checks.md`) and checks its proof
     on the records: none needs nothing, same and render need dev-run or pixel-qa runs at both ends, visual and pixel a pixel-qa PASS for
     the tree (today's check, its line word for word). Not proved: exit 6 (`ui-proof`) with the failing states and the reason. A plan other
     than none with no `--brief` is exit 6 too (the request would be unread). Always on, no waiver; when the ui-proof tool cannot be loaded
     every landing exits 6 with that reason. A proved plan other than pixel prints `ui plan <depth>: proved` and its `follow-up:` lines
     (JSON `uiPlan: { depth, followUps }`); none does so only when a UI file changed (a docs page), so a lane with no UI file prints what
     it printed before. The old UI waiver flag was removed (exit 2, owner 2026-11-23: no waivers).
4. The base moves with `git merge --ff-only <the rebased tip sha>` run in the base folder (the sha, not the lane's branch, so a commit added to the lane after the checks is never landed unchecked and stays on the lane). When the base moved since the rebase: exit 5, rerun the landing.
   The base tip read right before the merge is printed as `from <sha>` (JSON `from`); when the base's reflog entry before the new tip is
   another commit (another process moved it in between), the reflog's value is printed, so that commit falls in no landed range.
5. Cleanup is `prune --apply` (all its safeties), with the 60-minute rule lifted for the landed lane's worktree only: the lane worktree and branch, helper branches and older copies whose work is on the base, agent
   leftovers. Another lane's recently used worktree stays. When prune refuses (a rebase, merge or similar is unfinished in some worktree) the base has already moved: the landing
   is reported with `cleanup skipped: <reason>` (JSON `cleanupRefused`) and exit 1. Then `check` runs. Exit 0 when it is clean (`check: clean` is printed), 1 when findings are left (printed).

`git-tidy range <sha>` reads the base's reflog (newest 200 entries) for the step `from..to` that holds every patch of the
sha not on the base (or, for a sha on the base, that sha itself); `--landed <sha>` also requires that commit in the
range. It prints `from <sha>` and `to <sha>` (exit 0) or exits 1, so a landing a killed run made can be found again.

### What `prune --apply` never touches

The base, the current branch, a branch with commits the base lacks (`unmerged-branch?`), the branch checked out in the
main worktree, the main worktree, a linked worktree with uncommitted, untracked or ignored files, a locked worktree, a
detached-HEAD worktree (listed as kept), a worktree used in the last hour (unless `--include-recent`, which does not apply to a lane with no commit of its own yet, nor to the worktree of a copy), anything whose reflog
holds commits that exist nowhere else, remote branches and tags. Nothing is removed while any worktree has an unfinished
rebase, merge, cherry-pick, revert or bisect.

### Tags are never deleted by this tool

A tag may be the only backup of a history clean-up, so `prune` lists the `backup/` ones that are merged and leaves them. Delete one by
hand after you have verified your backup bundle: `git bundle verify <file>` (is it complete and valid) and
`git bundle list-heads <file>` (does it hold the refs you expect).

### Restoring after a deletion

A deleted branch can be recreated with `git branch <name> <hash>` from the hash printed on its `deleted` line, but only
while its commits are still in the object store (not yet garbage-collected). The branch's reflog and, for a removed
worktree, its HEAD reflog, its ignored files and its untracked files are NOT recoverable. That is why a worktree or
branch whose reflog holds only-copy commits, and a worktree holding ignored or untracked files, are kept instead.

## Notes

- Merged detection is by commit, or by patch plus an exact content check. A squash merge, or a branch whose commits were edited
  while rebasing, does not match and shows as `unmerged-branch?`; the tool leaves it for the owner.
- Submodules are not looked into. A worktree that holds an initialised submodule is refused by `git worktree remove`
  itself and shows up as `failed` with git's message.
- Speed: `check` and the plan cost about one git call per branch not already on the base, plus one per unpublished merge
  commit (300 branches take about 4 s each); `--apply` re-reads each branch, its reflog and the worktree list before every
  removal (about 7 git calls, 0.1 s per branch).

## Layout

`git-tidy.mjs` (arguments, printing, exit code) over `lib/`; see `lib/README.md`. Tests: `tests/git-tidy-*.test.mjs`. The Stop gate that runs `check --json`
at the end of a session is `home/hooks/git-tidy-gate.mjs`.

## Worktree locks

A live lane worktree made by Bash or kept by a workflow is locked (`git worktree lock --reason <lane> <session>`), so prune and
the in-work check leave it alone; agent worktrees are locked by Claude Code itself while the agent runs. `land` unlocks the
landed lane's own worktree before its cleanup removes it (no other lock is touched). A lock over a day old is the hint
`stale-lock?`.

## lane (the lane folder pool)

Lanes reuse folders instead of making a new worktree each time, so a folder's caches (the Go build cache keys on the path,
node_modules) stay warm, and no folder is left behind:

- `lane claim --repo <abs> --branch <name> --base <40-hex sha> [--json]` takes the pool lock, then hands out the lowest free
  `<main worktree>/.claude/worktrees/lane-<n>`: it switches the folder to the branch (a new branch at `--base`; an existing one as
  it is, never reset), runs `git clean -fdx` (one -f: a git repository inside an ignored folder stays) but keeps `node_modules` (any depth) when none of `pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json`, `bun.lock`, `bun.lockb`, `package.json` differ between the folder's old HEAD and the new tip (`.venv` the
  same for `uv.lock`, `poetry.lock`, `Pipfile.lock`, `requirements*.txt`, `pyproject.toml`), and locks the worktree with
  `cs-lane-pool <branch>`. When every folder is busy it adds the lowest unused `lane-<n>` (no cap); a stale entry whose folder is
  gone is removed and made again, unless its HEAD is off the base or its reflog holds commits found nowhere else (then it stays
  and a new number is used). Then it installs what the tip needs (`lib/lane-prep.mjs`, below). Output: `lane: <folder>`,
  `kept: node_modules` or `kept: none`, `installed: <command> in <folder>, ...` or `installed: none`. Exit 0 ready, 1 an install
  failed (`lane not ready: ...`, the worktree, `to finish:` and `to release:` lines on stderr; the folder stays claimed and is not
  handed out), 2 usage (a short or unknown sha, a branch name `git check-ref-format --branch` refuses or that starts with `-` or
  `refs/`, a base branch (the base, main, master or develop: never a lane), a branch already checked out in another folder: named), 4 the pool lock stayed held by another live claim for 60 s,
  14 a git command failed. `--json` prints `{ folder, slot, created, kept, branch, base, record, ready, installs }`.
- `lane list --repo <abs> [--json]`: one line per folder, `lane-<n> free|busy|missing <why>`.
- `lane release --repo <abs> --folder <abs> [--json]`: frees a folder whose branch is landed and whose tree is clean: detach,
  remove its `cs-lane-pool` lock, delete the branch (prune's compare-and-delete; kept when its reflog holds commits found nowhere
  else). Exit 0 released, 3 refused with why (not a pool folder, a base branch, someone else's lock, unfinished work, not landed).
- `lane reclaim --repo <abs> [--json]`: removes, with `git worktree remove` (never `--force`), each free folder unused for 24 hours
  (`RECLAIM_IDLE_MS`; use = its HEAD reflog, HEAD or index changed). When the repository was used in that time (a folder holds a
  branch, or a free one was used), its lowest free folder stays. A folder whose HEAD reflog holds commits found nowhere else
  (prune's rule), or with a git repository inside an ignored folder, is kept. Exit 0, 1 when a removal failed.
- `land` detaches the landed lane's pool folder at the landed sha right after the fast-forward (and unlocks it), so its cleanup
  deletes the branch and keeps the folder (`lane folder <path> detached at <sha> (kept for the next lane)`, JSON `detached`).

Free means: a linked worktree of this repository, unlocked, HEAD detached at a commit on the base, no unfinished operation, no
`index.lock` or `HEAD.lock`, `git status` (untracked files included) empty. Everything else is busy and is never switched,
cleaned or removed: untracked or uncommitted files, a commit not on the base, a rebase in progress, a git lock, a folder holding a
branch (also one a crashed claim switched but did not lock), and a folder at `lane-<n>` that is not a worktree of this repository.
Folder paths are compared as real paths, case-folded on Windows and macOS.

The pool lock is `<git common dir>/cs-lane-pool.lock` (one per repository, `<pid> <random> <what>` inside). It is stale only when
its pid is gone or it is over 120 s old; one breaker at a time removes a stale lock and never one that changed since it looked.
Installs run after the lock is released.

Installs (`lib/lane-prep.mjs`): for each tracked lockfile of the claimed tip, in that lockfile's folder: `package-lock.json` →
`npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --immutable` (one per folder, in that
order). The command comes from the lockfile's name only, runs as argv with no shell, and the program is taken from an absolute
PATH folder outside the lane folder (on Windows the package manager's JavaScript entry beside its `.cmd` runs under node). A
folder whose `node_modules/.cs-lane-prep.json` names the same lockfile sha256 is skipped. The lockfile's own lifecycle scripts run
as the package manager runs them in any checkout.

Each claim records the folder as made, and each reclaim removal as gone, in the job-made record
(`tools/disk-free/lib/job-made.mjs`, under the session id of `CLAUDE_CODE_SESSION_ID`); with no session id a stderr line says the
record was not written, so the job-leftover sweep leaves that folder alone.

`check` prints `lane folders: <n> free[, <m> busy][, <k> missing]` as an info line (JSON `info`), never a finding or a hint, and a
branch at the base with no commit of its own (`isNotStarted`) in a locked linked worktree as `not started: <branch> in <path> ...`
instead of `merged-branch` and `merged-worktree`. An unlocked fresh worktree stays a finding.

Uninstall: the pool folders are plain detached worktrees; `git worktree remove <folder>` or `lane reclaim` removes them.
