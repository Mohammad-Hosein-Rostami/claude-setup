// Purpose: the claim of the lane folder pool of a repository. `claimLane` hands a lane the lowest free folder
//   `<main>/.claude/worktrees/lane-<n>` (its caches stay warm, since the path is the same), or adds the lowest unused lane-<n> when
//   every folder is busy (no cap). Where the main checkout can be cloned (lane-fill.mjs cloneSupport), a claim fills the folder by
//   cloning it. A snapshot claim is a lane with no branch: it stays detached at its commit, locked as `cs-lane-pool snapshot <8>`,
//   until release. Release, land's `detachLandedSlot` and reclaim are in lane-release.mjs.
// Exports: KEPT_DEPENDENCY_FOLDERS, claimLane, checkBranchName (board tick checks a plan piece's branch with it) (and, from lane-slots.mjs, POOL_FOLDER, poolSlots; from lane-release.mjs, RECLAIM_IDLE_MS,
//   releaseLane, detachLandedSlot, reclaimLanes, so their callers import them from here).
// Invariants:
// - A claim runs under the one pool lock of the repository (pool-lock.mjs), the lock release and reclaim take too, so two sessions
//   never get one folder.
// - Clone mode is a claim in two steps under the lock, with the fill between them outside it (it can take minutes; the lock goes
//   stale at 120 s). The first step writes the slot's fill file (lane-fill-state.mjs), then locks the folder detached at the target:
//   a new one by one `worktree add --no-checkout --detach --lock`, a free one locked, then switched and cleaned, a broken one
//   relocked (the fill empties it). The fill clones the main checkout in (fillFresh), or after a reuse its ignored files except
//   what the clean kept (fillIgnored). The end step checks the fill file, the lock and HEAD are still this claim's, deletes the fill
//   file, then switches to the branch (the same commit: no file is written), which is the hand-out. A failed fill leaves the fill
//   file, so the slot reads broken (here at once, elsewhere when this process ends). A crash or a failed switch after the delete
//   leaves the slot detached and pool-locked with no fill file: busy, never emptied or handed out (a leak; a retry takes another).
// - The fill file counts only on a detached, pool-locked slot (lane-slots.mjs), so every step that changes a slot's lock or HEAD
//   writes or deletes it before its first change: a checkout-mode claim deletes it first, as release and land do.
// - Facts are read again right before each switch, clean and lock (lane-slots.mjs readSlot), never trusted from an earlier read. A
//   busy folder (locked, on a branch, untracked or uncommitted files, a commit not on the base, an unfinished operation, a git lock,
//   not a worktree of this repository) is never switched, cleaned or removed.
// - What a claim adds (the worktree, its `cs-lane-pool <branch>` lock, the branch) land or release removes (lane-release.mjs). No
//   `--force` and no reset anywhere.
// - A claim adds `/.claude/worktrees/` to the repository's local info/exclude when git does not ignore the pool yet (pool-ignore.mjs),
//   under the lock, so lane folders stay out of `git status` and `git add -A`.
// - A branch name passes `git check-ref-format --branch` unchanged, does not start with `-` or `refs/` and is no base branch
//   (`repo.baseBranches`), before anything is written.
// - A claim starts at the base's tip, or at `--base`, which must be on the base for a new branch. Under the lock, before any folder
//   is touched, a branch claim records its base (base-record.mjs; a failed write fails the claim) and refuses an existing branch
//   recorded on another base. A snapshot records nothing; openRepo marks the base (`baseMarkWarning`, printed by lane-cli.mjs).
// - The clean is `git clean -fdx` (one -f): a git repository inside an ignored folder stays. A stale entry is removed only when its
//   HEAD is on the base and its reflog holds nothing found nowhere else (lane-slots.mjs staleEntryLossWhy).
// - Every claim writes a job-made record (disk-free/lib/job-made.mjs) when a session id is known.
// - Imports lane-release.mjs, which imports nothing from this file (no import cycle).
import { gitFlag, gitText, runGit, UsageError } from './git.mjs';
import { LANE_BASE_KEY, readLaneBase, writeLaneBase } from './base-record.mjs';
import { listWorktrees } from './repo.mjs';
import { withPoolLock } from './pool-lock.mjs';
import { cloneSupport, FILL_ENV, fillFresh, fillIgnored } from './lane-fill.mjs';
import { deleteFillFile, emptyForRefill, readFillFile, removeStaleIndexLock, startFillFile } from './lane-fill-state.mjs';
import { commonDirOf, LOCK_REASON_PREFIX, poolFolderOf, poolSlots, readSlot, SNAPSHOT_LABEL, staleEntryLossWhy } from './lane-slots.mjs';
import { baseNames, branchTip, recordFolder, slotTree } from './lane-release.mjs';
import { ignorePool } from './pool-ignore.mjs';
import { shellWord } from './shell-word.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export { POOL_FOLDER, poolSlots } from './lane-slots.mjs';
export { detachLandedSlot, RECLAIM_IDLE_MS, reclaimLanes, releaseLane } from './lane-release.mjs';

/** Dependency folders a claim keeps (git clean -e) when none of their lockfiles differ between the folder's old HEAD and the new tip. */
export const KEPT_DEPENDENCY_FOLDERS = Object.freeze([
  Object.freeze({ folder: 'node_modules', lockfiles: Object.freeze(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb', 'package.json']) }),
  Object.freeze({ folder: '.venv', lockfiles: Object.freeze(['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements*.txt', 'pyproject.toml']) }),
]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const HEADS = 'refs/heads/';
const CLONE_MODE = 'clone'; // cloneSupport's mode when the main checkout can be cloned into the pool
const SHORT_SHA = 8;

/** Refuses a branch name git would read as an option, a full ref or anything `check-ref-format --branch` rejects or rewrites. */
export function checkBranchName(repo, branch) {
  const refused = typeof branch !== 'string' || branch === '' || branch.startsWith('-') || branch.startsWith('refs/');
  const checked = refused ? null : runGit(repo.dir, ['check-ref-format', '--branch', branch]);
  if (checked === null || checked.status !== 0 || checked.stdout.trim() !== branch) {
    throw new UsageError(`--branch ${JSON.stringify(branch)} is not a plain branch name (git check-ref-format --branch refuses it, or it starts with - or refs/)`);
  }
}

function checkBase(repo, base) {
  if (!FULL_SHA.test(base ?? '')) throw new UsageError(`--base needs a full 40-character sha, got ${JSON.stringify(base)}`);
  if (runGit(repo.dir, ['cat-file', '-e', `${base}^{commit}`]).status !== 0) throw new UsageError(`--base ${base} is not a commit in this repository`);
}

/** Refuses a new lane's start commit that is not on the base: landing the lane would bring that other line's commits along. */
function refuseOffBase(repo, base) {
  if (!gitFlag(repo.dir, ['merge-base', '--is-ancestor', base, repo.baseRef])) throw new UsageError(`--base ${base} is not on ${repo.base} (the branch checked out in the main checkout); a new lane starts from it`);
}

/**
 * Records that `branch` is claimed on the base. An existing branch recorded on another base is refused, so a claim never moves a
 * lane silently; a new branch's old record is one a failed claim left, and is written over.
 */
function recordLaneBase(repo, branch, exists) {
  const claimedOn = readLaneBase(repo.dir, branch);
  if (claimedOn === repo.base) return;
  if (exists && claimedOn !== null) throw new UsageError(`${branch} was claimed on ${claimedOn}, but the main checkout has ${repo.base} checked out: switch back to ${claimedOn} there, or move the lane on purpose (git config ${shellWord(`branch.${branch}.${LANE_BASE_KEY}`)} ${shellWord(repo.base)}) and claim again`);
  writeLaneBase(repo.dir, branch, repo.base); // throws when config.lock stays held: the claim fails before the folder is touched
}

/** Refuses the base branch as a lane: its commits would go to the base and release would delete it. */
function refuseBaseBranch(repo, branch) {
  if (baseNames(repo).has(branch)) throw new UsageError(`${branch} is a base branch of this repository, never a lane: claim a lane branch of its own (feat/..., fix/...)`);
}

/** `[{ folder, same }]`: per kept kind, whether its lockfiles are equal between the two commits (`git diff --quiet`). */
function lockfilesSame(repo, from, to) {
  return KEPT_DEPENDENCY_FOLDERS.map(({ folder, lockfiles }) => {
    if (from === to) return { folder, same: true };
    const pathspecs = lockfiles.map((name) => `:(glob)**/${name}`);
    return { folder, same: gitFlag(repo.dir, ['diff', '--quiet', from, to, '--', ...pathspecs]) }; // exit 0: no difference
  });
}

/** The ignored entries of `folder` (`--directory`: a wholly ignored folder is one entry), repo-relative, without a trailing `/`. */
const ignoredEntries = (folder) => gitText(folder, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])
  .split('\0').filter((entry) => entry !== '').map((entry) => entry.replace(/\/$/, ''));

/** Names of the kept kinds that exist in `folder` as ignored folders (any depth). */
function presentDependencyFolders(folder, names) {
  const ignored = ignoredEntries(folder);
  return names.filter((name) => ignored.some((entry) => entry.split('/').includes(name)));
}

/** The kept kinds whose lockfiles are equal between the slot's HEAD and `target` (`keep`, for git clean -e) and those present (`kept`). */
function keptDependencies(repo, folder, target) {
  const oldHead = gitText(folder, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const keep = lockfilesSame(repo, oldHead, target).filter(({ same }) => same).map((kind) => kind.folder);
  return { keep, kept: presentDependencyFolders(folder, keep) };
}

/** Re-reads that `folder` has `branch` checked out with no unfinished operation; throws when it does not (a race), before a write. */
function confirmOnBranch(folder, branch) {
  const head = runGit(folder, ['symbolic-ref', '-q', 'HEAD']).stdout.trim();
  if (head !== `${HEADS}${branch}`) throw new Error(`${folder} is not on ${branch} after the switch (it is on ${head || 'a detached HEAD'})`);
}

/** Switches `folder` to the lane's branch: a new one at `base`, an existing one as it is (no reset). */
function switchTo(folder, branch, base, exists) {
  const args = exists ? ['switch', '--quiet', '--no-guess', branch] : ['switch', '--quiet', '--no-track', '-c', branch, base];
  gitText(folder, args);
  confirmOnBranch(folder, branch);
}

/** Puts `folder` at the lane: on its branch (switchTo), or for a snapshot (no branch) detached at its target. */
function enterLane(folder, lane) {
  if (lane.branch === null) gitText(folder, ['switch', '--quiet', '--detach', lane.target]);
  else switchTo(folder, lane.branch, lane.base, lane.exists);
}

/** Locks the slot as `cs-lane-pool <label>` after checking it is unlocked and holds `heldBranch` (null: detached). */
function lockSlot(repo, folder, label, heldBranch) {
  const tree = slotTree(repo, folder);
  if (tree === undefined || tree.locked || tree.branch !== heldBranch) throw new Error(`${folder} changed before its lock (locked or on another branch)`);
  gitText(repo.dir, ['worktree', 'lock', '--reason', `${LOCK_REASON_PREFIX} ${label}`, '--', folder]);
}

/** Reuses a free slot whose facts were just read again: switch, clean (keeping unchanged dependency folders), lock. */
function takeFreeSlot(repo, slot, lane) {
  deleteFillFile(commonDirOf(repo), slot.slot); // a leftover would count again once the slot is detached and locked
  const { keep, kept } = keptDependencies(repo, slot.folder, lane.target);
  enterLane(slot.folder, lane); // a branch switch ends by reading HEAD again, right before the clean
  // one -f: git clean keeps a git repository inside an ignored folder (-ff would delete it with its commits)
  gitText(slot.folder, ['clean', '-fdxq', ...keep.flatMap((name) => ['-e', name])]);
  lockSlot(repo, slot.folder, lane.label, lane.branch);
  return { folder: slot.folder, slot: slot.slot, created: false, kept };
}

/** Makes the slot folder `lane-<number>` (after removing its stale entry, if any), then switches and locks it. */
function createSlot(repo, folder, slotName, lane, staleEntry) {
  deleteFillFile(commonDirOf(repo), slotName); // a leftover would count again once the slot is detached and locked
  if (staleEntry) gitText(repo.dir, ['worktree', 'remove', '--', folder]); // a missing folder: only its entry goes
  gitText(repo.dir, ['worktree', 'add', '--quiet', '--detach', '--', folder, lane.target]);
  enterLane(folder, lane);
  lockSlot(repo, folder, lane.label, lane.branch);
  return { folder, slot: slotName, created: true, kept: [] };
}

/** Writes the slot's fill file for the lane: its `branch` field holds the lane's label (a snapshot's `snapshot <8>`). */
const startFill = (repo, slotName, lane) => startFillFile(commonDirOf(repo), slotName, { branch: lane.label, target: lane.target });

/**
 * Clone mode: reuses a free slot as takeFreeSlot does, but detached at the target; the fill brings its ignored files back. The lock
 * comes before the switch and the clean, so a crash between them leaves a broken slot (holding only a free slot's ignored files).
 */
function takeFreeSlotToFill(repo, slot, lane) {
  const { keep, kept } = keptDependencies(repo, slot.folder, lane.target);
  const fillFile = startFill(repo, slot.slot, lane);
  lockSlot(repo, slot.folder, lane.label, null);
  gitText(slot.folder, ['switch', '--quiet', '--detach', lane.target]);
  gitText(slot.folder, ['clean', '-fdxq', ...keep.flatMap((name) => ['-e', name])]); // one -f, as in takeFreeSlot
  // what the clean kept (the dependency folders, a git repository inside an ignored folder) is never cloned over
  const pending = { lane, fillFile, fill: 'ignored', except: ignoredEntries(slot.folder), notes: [] };
  return { folder: slot.folder, slot: slot.slot, created: false, kept, pending };
}

/** Clone mode: adds `lane-<number>` as an empty worktree detached at the target (`--no-checkout`), locked in the same git call, for fillFresh. */
function createSlotToFill(repo, folder, slotName, lane, staleEntry) {
  const fillFile = startFill(repo, slotName, lane);
  if (staleEntry) gitText(repo.dir, ['worktree', 'remove', '--', folder]); // a missing folder: only its entry goes
  const lock = ['--lock', '--reason', `${LOCK_REASON_PREFIX} ${lane.label}`];
  gitText(repo.dir, ['worktree', 'add', '--quiet', '--no-checkout', '--detach', ...lock, '--', folder, lane.target]);
  return { folder, slot: slotName, created: true, kept: [], pending: { lane, fillFile, fill: 'fresh', except: [], notes: [] } };
}

/**
 * Clone mode: takes a broken slot (the claim that filled it is gone and never handed it out: broken means detached and pool-locked).
 * The slot gets this claim's fill file and lock; outside the lock it is emptied and filled again (lane-fill-state.mjs emptyForRefill).
 */
function takeBrokenSlot(repo, slot, lane) {
  const fillFile = startFill(repo, slot.slot, lane);
  const notes = [`${slot.slot} was broken (${slot.why}): emptied and filled again`];
  removeStaleIndexLock(slot.folder); // the dead fill may have been killed inside a git command
  gitText(repo.dir, ['worktree', 'unlock', '--', slot.folder]);
  lockSlot(repo, slot.folder, lane.label, null);
  return { folder: slot.folder, slot: slot.slot, created: false, kept: [], pending: { lane, fillFile, fill: 'refill', except: [], notes } };
}

const lowestUnused = (numbers) => {
  let number = 1;
  while (numbers.has(number)) number += 1;
  return number;
};

/** The first of `slots` in `state` that is still in it when read again now. */
function firstStillIn(repo, slots, state) {
  for (const candidate of slots.filter((slot) => slot.state === state)) {
    const fresh = readSlot(repo, candidate.folder);
    if (fresh.state === state) return fresh;
  }
  return null;
}

/** `lane`: `{ branch, base, label }`, branch null for a snapshot (several snapshots of one commit may fill at once). */
function claimUnderLock(repo, { branch, base, label }, cloning) {
  const worktrees = listWorktrees(repo);
  const holder = branch === null ? undefined : worktrees.find((entry) => entry.branch === branch);
  if (holder !== undefined) throw new UsageError(`branch ${branch} is checked out in ${holder.path}: work there, or land or release it first`);
  const slots = poolSlots(repo);
  const filling = branch === null ? undefined : slots.find((slot) => slot.state === 'filling' && slot.fillFile.branch === branch);
  if (filling !== undefined) throw new UsageError(`branch ${branch} is being filled in ${filling.folder} (${filling.why}): wait for that claim to end`);
  const tip = branch === null ? null : branchTip(repo, branch);
  if (branch !== null && tip === null) refuseOffBase(repo, base);
  if (branch !== null) recordLaneBase(repo, branch, tip !== null);
  const lane = { branch, base, label, exists: tip !== null, target: tip ?? base };
  const [reuse, create] = cloning ? [takeFreeSlotToFill, createSlotToFill] : [takeFreeSlot, createSlot];
  const free = firstStillIn(repo, slots, 'free');
  if (free !== null) return reuse(repo, free, lane);
  const broken = cloning ? firstStillIn(repo, slots, 'broken') : null; // checkout mode leaves a broken slot to a clone-mode claim
  if (broken !== null) return takeBrokenSlot(repo, broken, lane);
  const stale = slots.find((slot) => slot.state === 'missing');
  const staleSafe = stale !== undefined && readSlot(repo, stale.folder).state === 'missing' && staleEntryLossWhy(repo, stale.folder) === null;
  if (staleSafe) return create(repo, stale.folder, stale.slot, lane, true); // else its entry stays and a new number is used
  const number = lowestUnused(new Set(slots.map((slot) => slot.number)));
  return create(repo, join(poolFolderOf(repo), `lane-${number}`), `lane-${number}`, lane, false);
}

/** The fill between the claim's two steps, outside the pool lock; a failure says what becomes of the folder. */
function runFill(repo, folder, { fill, lane, except }) {
  try {
    if (fill === 'refill') emptyForRefill(folder, lane.target);
    return fill === 'ignored' ? fillIgnored(repo, { folder, except }) : fillFresh(repo, { folder, target: lane.target });
  } catch (error) {
    throw new Error(`the fill of ${folder} failed: ${error.message}. The folder is not handed out: it is broken, and the next claim empties and fills it again (${FILL_ENV}=checkout turns cloning off)`, { cause: error });
  }
}

/** The end step, under the pool lock: the slot must still be this claim's (fill file, lock, detached at the target); then the branch. */
function endFill(repo, { folder, slot }, { lane, fillFile }) {
  const commonDir = commonDirOf(repo);
  const found = readFillFile(commonDir, slot);
  const tree = slotTree(repo, folder);
  const head = gitText(folder, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const unchanged = found?.pid === fillFile.pid && found.startedAt === fillFile.startedAt
    && tree?.lockReason === `${LOCK_REASON_PREFIX} ${lane.label}` && tree.branch === null && head === lane.target;
  if (!unchanged) throw new Error(`${folder} changed during its fill (its fill file, lock, branch or HEAD), so it is not handed out`);
  // first: a fill file left on a handed-out lane makes it read broken once a rebase there detaches HEAD, and a refill would empty it
  deleteFillFile(commonDir, slot);
  try {
    enterLane(folder, lane); // the same commit: no file is written
  } catch (error) {
    throw new Error(`the switch of ${folder} to ${lane.label} failed: ${error.message}. The folder is not handed out: it stays locked and busy and is never emptied; claim again to get another folder`, { cause: error });
  }
}

/** Clone mode: the fill outside the lock, then the end step under it; returns the claim's `fill` field. */
function fillAndEnd(repo, claimed, pending, why) {
  const filled = runFill(repo, claimed.folder, pending);
  withPoolLock(commonDirOf(repo), `claim ${pending.lane.label} end`, () => endFill(repo, claimed, pending));
  return { mode: filled.mode, entries: filled.entries, seconds: filled.seconds, repaired: filled.repaired, warnings: [...pending.notes, ...filled.warnings], why };
}

/** The claim's `fill` field when cloning is not possible: the checkout path, nothing cloned. */
const checkoutFill = ({ mode, why }) => ({ mode, entries: 0, seconds: 0, repaired: 0, warnings: [], why });

/**
 * Hands the lane `branch` a pool folder of `repo`, switched to the branch (made at `base` when new) and locked; in clone mode filled
 * by cloning the main checkout first (see the header). A branch claim records `repo.base` as the base it is claimed on. A snapshot
 * gets a folder the same way but stays detached at `base`, with no branch, locked as `cs-lane-pool snapshot <8 of base>` until
 * `releaseLane` (a frozen copy of one commit, such as tess tests on).
 * @param {object} repo openRepo's result
 * @param {{ branch?: string|null, base?: string|null, env?: NodeJS.ProcessEnv, snapshot?: boolean }} lane `base`: full sha a new
 *   branch starts at (it must be on the base), or the snapshot's commit; null: the base's tip. `env`: HOME and session id of the
 *   job-made record, and GIT_TIDY_LANE_FILL (cloneSupport)
 * @returns {{ folder: string, slot: string, created: boolean, kept: string[], branch: string|null, base: string,
 *   baseBranch: string|null, snapshot: boolean, fill: object, record: string, poolIgnore: ReturnType<typeof ignorePool> }}
 *   `base`: the commit used; `baseBranch`: the base the lane is recorded on (null for a snapshot); `kept`: dependency folders left in place; `fill`:
 *   `{ mode: 'clone'|'checkout', entries, seconds, repaired, warnings, why }` (why: cloneSupport's reason; warnings: the fill's, and a
 *   broken slot's refill); `record`: job-made outcome; `poolIgnore`: whether git ignores the pool folder now (pool-ignore.mjs)
 * @throws {UsageError} bad branch name or sha, a new branch's `--base` not on the base, an existing branch recorded on another base, a snapshot
 *   with a branch, branch checked out in another folder or being filled there (named), no main worktree; PoolBusy; Error when git,
 *   the record or the fill fails (the folder is then not handed out)
 */
export function claimLane(repo, { branch = null, base = null, env = process.env, snapshot = false }) {
  if (snapshot && branch !== null) throw new UsageError('--snapshot takes no --branch: a snapshot stays detached at one commit, with no branch');
  if (!snapshot) checkBranchName(repo, branch);
  if (!snapshot) refuseBaseBranch(repo, branch);
  base ??= gitText(repo.dir, ['rev-parse', '--verify', `${repo.baseRef}^{commit}`]); // no --base: the base's tip
  checkBase(repo, base);
  const label = snapshot ? `${SNAPSHOT_LABEL} ${base.slice(0, SHORT_SHA)}` : branch;
  const worktrees = listWorktrees(repo);
  const pool = poolFolderOf(repo, worktrees); // UsageError when there is no main worktree folder
  mkdirSync(pool, { recursive: true }); // cloneSupport reads the pool's volume; the first worktree add would make it anyway
  const support = cloneSupport(worktrees[0].path, pool, env);
  const cloning = support.mode === CLONE_MODE;
  const { pending, ...claimed } = withPoolLock(commonDirOf(repo), `claim ${label}`, () => {
    const taken = claimUnderLock(repo, { branch, base, label }, cloning);
    return { ...taken, poolIgnore: ignorePool(worktrees[0].path) }; // under the lock: two claims never append the line twice
  });
  const fill = cloning ? fillAndEnd(repo, claimed, pending, support.why) : checkoutFill(support);
  return { ...claimed, branch, base, baseBranch: snapshot ? null : repo.base, snapshot, fill, record: recordFolder(env, claimed.folder, 'made', 'git-tidy lane claim') };
}
