# 0011: Virtual lanes: pool folders filled by cloning the main checkout

- Status: accepted. Date: 2026-11-25 (the owner's decisions: clone file by file, copy local secret files). Builds on 0010 (the
  lane pool and the round loop).

## Context

Each dev works in a pool lane (0010). A lane made by `git worktree add` holds only the tracked files: `node_modules`, `.env`,
build output and generated hook folders (`.husky/_`) are missing, so each new lane needs an install, and husky's commit hooks
silently do not run there. On a large pnpm project (104,657 entries, 1.1 GB of them in `node_modules`) a plain copy of the
folder costs about 1.2 GB per lane.

On APFS, `cp -c` makes a clone: the copy shares the disk blocks with its source until a file changes. A lane folder can then
hold the whole project at almost no disk cost, and stay a git worktree.

## Drivers

1. Speed to a ready lane, install included.
2. Disk per lane, on big projects and on many at once.
3. Safety: main and the parallel devs stay apart, the commit hooks run, nothing is lost.
4. The dev sees and can run the whole project.
5. Simple to build and to keep.

## Options

| Option | 1 Speed | 2 Disk (large project) | 3 Safety | 4 Whole project | 5 Simple |
|---|---|---|---|---|---|
| A. A copy without git, a home-made diff, `git merge-file` to apply | good | good: about 29 MB | bad: no hooks until the end, renames lost, needs a frozen base copy to diff against | good | bad: a second rebase engine |
| B. Virtual lane: a git worktree filled by cloning the main checkout | good: 18.6 s new, about 3 to 4 s reused | good: 29 MB plus the changed files | good: own folder and index, the hooks run (husky's too), main moves only by `land` | good | ok: one new module and a two-step claim |
| C. Simplest: today's lanes, plus `node_modules` cloned | ok: 3.7 s plus 17 s | ok: tracked files at full size | good, but `.env`, `.husky/_` and generated files are missing | bad | good |

One shared folder, GitButler and sparse folders that hold only a piece's files were rejected earlier (0010, and the dev could
not run the project in a sparse folder).

## Decision

B.

- A new lane is added without a checkout and filled with `/bin/cp -c`, one file at a time (the way Apple advises; a one-call
  folder clone blocks all changes to the source tree while it runs). The fill runs outside the pool lock.
- It skips `.git`, `.claude/worktrees`, every folder that holds a `.git` entry (nested repos and worktrees), every folder that
  holds `pyvenv.cfg`, and `HANDOFF*.md` at the root.
- Local secret files such as `.env` are copied, so a lane can run the app; they are deleted when the lane is reclaimed.
- git builds the index (`read-tree`), a repair makes the tracked files equal the base, and the claim fails unless
  `git status --porcelain` is empty.
- A reused lane gets the main checkout's ignored files cloned back in. Deps are trusted only when their marker matches the
  lane's lockfile; else they come from a deps cache keyed on the lockfile, Node ABI, platform and CPU, or from an install.
- git stays the diff step and `land` the apply step: its rebase follows renames, deletes, modes and binary files.
- Where cloning is not possible (a non-APFS or different volume on macOS, Linux without reflink, Windows), a lane is made as
  before. `GIT_TIDY_LANE_FILL=checkout` turns cloning off.

A loses to B on safety and simplicity with no gain: git's diff already is the reconcile step. C loses on driver 4: the lane is
not the whole project, and husky's hooks do not run.

## Consequences

- Good: lanes cost a few hundred MB for 3 devs on 3 projects, not tens of GB; a reused lane skips the install; a lane's commit
  hooks run.
- Bad: the first fill of a large project takes about 18 s (a one-call folder clone would take 2.6 s); `du` cannot see clones
  and counts a lane at full size; an absolute link into the main checkout still points there (the claim warns); a new file
  that `.gitignore` hides never lands.
- Assumption: the main checkout and the pool sit on the same APFS volume.
- Reversal signal: a claim fills wrong more than once (a lane's status not clean after the repair), or new lanes stay over
  60 s on real projects. Then set `GIT_TIDY_LANE_FILL=checkout` and look again.

## Sources

- macOS `cp(1)` man page; Apple file_cmds `cp/utils.c` and `cp.c` (one `clonefileat` per file, a full copy on EXDEV or ENOTSUP);
  https://developer.apple.com/forums/thread/784446 (a folder clone blocks changes to the source); `clonefile(2)`.
- https://nodejs.org/docs/latest-v26.x/api/fs.html and libuv `src/unix/fs.c`: Node's `COPYFILE_FICLONE` makes a full copy on
  macOS, so the tool calls `/bin/cp -c`.
- GNU coreutils NEWS and `cp(1)` (`--reflink=always`); https://git-scm.com/docs/git-worktree.
- Local probes on macOS (APFS, git 2.54.0, Node 26.5.0), all in scratch folders and a test disk image, read 2026-11-25: fill
  times, disk use, clone metadata, the repair after a dirty main, a rename across a rebase, and `cp -c` onto HFS+ (a silent
  full copy).
