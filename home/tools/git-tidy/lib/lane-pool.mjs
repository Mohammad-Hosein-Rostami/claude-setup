// Purpose: the lane folder pool of a repository. `claimLane` hands a lane the lowest free folder `<main>/.claude/worktrees/lane-<n>`
//   (its caches stay warm, since the path is the same), or adds the lowest unused lane-<n> when every folder is busy (no cap);
//   `releaseLane` frees a folder whose lane landed; land calls `detachLandedSlot` after its fast-forward; `reclaimLanes` removes folders
//   idle for RECLAIM_IDLE_MS. Where the main checkout can be cloned (lane-fill.mjs cloneSupport), a claim fills the folder by cloning it.
// Exports: RECLAIM_IDLE_MS, KEPT_DEPENDENCY_FOLDERS, claimLane, releaseLane, detachLandedSlot, reclaimLanes (and, from lane-slots.mjs,
//   POOL_FOLDER, poolSlots).
// Invariants:
// - Claim, release and reclaim run under the one pool lock of the repository (pool-lock.mjs), so two sessions never get one folder.
// - Clone mode is a claim in two steps under the lock, with the fill between them outside it (it can take minutes; the lock goes
//   stale at 120 s). The first step writes the slot's fill file (lane-fill-state.mjs), puts the folder detached at the target (a new
//   one by `worktree add --no-checkout`, a free one switched and cleaned, a broken one detached and emptied) and locks it. The fill
//   clones the main checkout in (fillFresh), or after a reuse its ignored files except what the clean kept (fillIgnored). The end
//   step checks the fill file, the lock and HEAD are still this claim's, switches to the branch (the same commit: no file is
//   written) and deletes the fill file. Until then the folder holds no branch and no one hands it out; a failed fill leaves the fill
//   file, so the slot reads broken (here at once, elsewhere when this process ends). Checkout mode is the path from before, unchanged.
// - Facts are read again right before each switch, clean, lock, detach and removal (lane-slots.mjs readSlot), never trusted from an
//   earlier read. A busy folder (locked, on a branch, untracked or uncommitted files, a commit not on the base, an unfinished operation,
//   a git lock, not a worktree of this repository) is never switched, cleaned or removed.
// - What a claim adds (the worktree, its `cs-lane-pool <branch>` lock, the branch) land or release removes: land detaches the folder and
//   prune deletes the landed branch; release detaches, unlocks and deletes a landed branch. The folder stays a plain detached worktree
//   that `git-tidy prune` keeps and `reclaimLanes` (or `git worktree remove`) removes. No `--force` and no reset anywhere.
// - A branch name passes `git check-ref-format --branch` unchanged, does not start with `-` or `refs/` and is no base branch (the base,
//   main, master, develop), before anything is written; release never detaches or deletes a base branch.
// - The clean is `git clean -fdx` (one -f): a git repository inside an ignored folder stays. Reclaim removes a folder only when its HEAD
//   reflog holds no commit found nowhere else (prune's rule) and no ignored folder holds a git repository; a stale entry is removed
//   only when its HEAD is on the base and its reflog holds nothing found nowhere else (lane-slots.mjs removalLossWhy, staleEntryLossWhy).
// - Every claim and every removal by reclaim writes a job-made record (disk-free/lib/job-made.mjs) when a session id is known.
import { gitFlag, gitText, runGit, UsageError } from './git.mjs';
import { deleteBranch } from './prune.mjs';
import { isNotStarted, reflogOnlyCommits } from './reflog.mjs';
import { listWorktrees } from './repo.mjs';
import { withPoolLock } from './pool-lock.mjs';
import { cloneSupport, FILL_ENV, fillFresh, fillIgnored } from './lane-fill.mjs';
import { deleteFillFile, emptyForRefill, readFillFile, removeStaleIndexLock, startFillFile } from './lane-fill-state.mjs';
import { commonDirOf, contentBusyWhy, isPoolSlot, lastUsedMs, LOCK_REASON_PREFIX, poolFolderOf, poolSlots, readSlot, removalLossWhy, slotKey, staleEntryLossWhy } from './lane-slots.mjs';
import { recordJobMade } from '../../disk-free/lib/job-made.mjs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export { POOL_FOLDER, poolSlots } from './lane-slots.mjs';

export const RECLAIM_IDLE_MS = 24 * 60 * 60 * 1000; // fixes-spec revision 2 (U8): a folder unused for a day is reclaimed
/** Dependency folders a claim keeps (git clean -e) when none of their lockfiles differ between the folder's old HEAD and the new tip. */
export const KEPT_DEPENDENCY_FOLDERS = Object.freeze([
  Object.freeze({ folder: 'node_modules', lockfiles: Object.freeze(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb', 'package.json']) }),
  Object.freeze({ folder: '.venv', lockfiles: Object.freeze(['uv.lock', 'poetry.lock', 'Pipfile.lock', 'requirements*.txt', 'pyproject.toml']) }),
]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const HEADS = 'refs/heads/';
const MS_PER_HOUR = 60 * 60 * 1000;
const SESSION_VARIABLES = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'];
const CLONE_MODE = 'clone'; // cloneSupport's mode when the main checkout can be cloned into the pool

/** Refuses a branch name git would read as an option, a full ref or anything `check-ref-format --branch` rejects or rewrites. */
function checkBranchName(repo, branch) {
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

/** The base branch and every other base candidate that exists here (main, master, develop): none of them is ever a lane. */
const baseNames = (repo) => new Set([repo.base, ...repo.knownBases]);

/** Refuses the base branch as a lane: its commits would go to the base and release would delete it. */
function refuseBaseBranch(repo, branch) {
  if (baseNames(repo).has(branch)) throw new UsageError(`${branch} is a base branch of this repository, never a lane: claim a lane branch of its own (feat/..., fix/...)`);
}

const branchTip = (repo, branch) => {
  const read = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${branch}`]);
  return read.status === 0 ? read.stdout.trim() : null;
};

/** The session id the job-made record is filed under, or null. */
const sessionOf = (env) => SESSION_VARIABLES.map((name) => env[name]).find((value) => typeof value === 'string' && value !== '') ?? null;

/** Records a made or gone lane folder; returns the record's outcome ('recorded', 'refused' with no session id, ...). */
function recordFolder(env, folder, op, by) {
  const session = sessionOf(env);
  return session === null ? 'no session id' : recordJobMade(env, session, { kind: 'lane-folder', key: folder, by, op });
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

const slotTree = (repo, folder) => listWorktrees(repo).find((entry) => !entry.main && slotKey(entry.path) === slotKey(folder));

/** Locks the slot for `branch` after checking it is unlocked and holds `heldBranch` (null: detached, while a fill runs). */
function lockSlot(repo, folder, branch, heldBranch = branch) {
  const tree = slotTree(repo, folder);
  if (tree === undefined || tree.locked || tree.branch !== heldBranch) throw new Error(`${folder} changed before its lock (locked or on another branch)`);
  gitText(repo.dir, ['worktree', 'lock', '--reason', `${LOCK_REASON_PREFIX} ${branch}`, '--', folder]);
}

/** Reuses a free slot whose facts were just read again: switch, clean (keeping unchanged dependency folders), lock. */
function takeFreeSlot(repo, slot, lane) {
  const { keep, kept } = keptDependencies(repo, slot.folder, lane.target);
  switchTo(slot.folder, lane.branch, lane.base, lane.exists); // ends by reading HEAD again, right before the clean
  // one -f: git clean keeps a git repository inside an ignored folder (-ff would delete it with its commits)
  gitText(slot.folder, ['clean', '-fdxq', ...keep.flatMap((name) => ['-e', name])]);
  lockSlot(repo, slot.folder, lane.branch);
  return { folder: slot.folder, slot: slot.slot, created: false, kept };
}

/** Makes the slot folder `lane-<number>` (after removing its stale entry, if any), then switches and locks it. */
function createSlot(repo, folder, slotName, lane, staleEntry) {
  if (staleEntry) gitText(repo.dir, ['worktree', 'remove', '--', folder]); // a missing folder: only its entry goes
  gitText(repo.dir, ['worktree', 'add', '--quiet', '--detach', '--', folder, lane.target]);
  switchTo(folder, lane.branch, lane.base, lane.exists);
  lockSlot(repo, folder, lane.branch);
  return { folder, slot: slotName, created: true, kept: [] };
}

/** Clone mode: reuses a free slot as takeFreeSlot does, but detached at the target; the fill brings its ignored files back. */
function takeFreeSlotToFill(repo, slot, lane) {
  const { keep, kept } = keptDependencies(repo, slot.folder, lane.target);
  const fillFile = startFillFile(commonDirOf(repo), slot.slot, lane);
  gitText(slot.folder, ['switch', '--quiet', '--detach', lane.target]);
  gitText(slot.folder, ['clean', '-fdxq', ...keep.flatMap((name) => ['-e', name])]); // one -f, as in takeFreeSlot
  lockSlot(repo, slot.folder, lane.branch, null);
  // what the clean kept (the dependency folders, a git repository inside an ignored folder) is never cloned over
  const pending = { lane, fillFile, fill: 'ignored', except: ignoredEntries(slot.folder), notes: [] };
  return { folder: slot.folder, slot: slot.slot, created: false, kept, pending };
}

/** Clone mode: adds `lane-<number>` as an empty worktree detached at the target (`--no-checkout`), locked, for fillFresh. */
function createSlotToFill(repo, folder, slotName, lane, staleEntry) {
  const fillFile = startFillFile(commonDirOf(repo), slotName, lane);
  if (staleEntry) gitText(repo.dir, ['worktree', 'remove', '--', folder]); // a missing folder: only its entry goes
  gitText(repo.dir, ['worktree', 'add', '--quiet', '--no-checkout', '--detach', '--', folder, lane.target]);
  lockSlot(repo, folder, lane.branch, null);
  return { folder, slot: slotName, created: true, kept: [], pending: { lane, fillFile, fill: 'fresh', except: [], notes: [] } };
}

/**
 * Clone mode: takes a broken slot (the claim that filled it is gone and never handed it out). When that claim reached its switch, the
 * slot is detached (the same commit: no file is written) and the branch deleted if it has no commit of its own. The slot gets this
 * claim's fill file and lock; outside the lock it is emptied and filled again (lane-fill-state.mjs emptyForRefill).
 */
function takeBrokenSlot(repo, slot, lane) {
  const tree = slotTree(repo, slot.folder);
  const fillFile = startFillFile(commonDirOf(repo), slot.slot, lane);
  const notes = [`${slot.slot} was broken (${slot.why}): emptied and filled again`];
  removeStaleIndexLock(slot.folder); // the dead fill may have been killed inside a git command
  if (tree.branch !== null) {
    gitText(slot.folder, ['switch', '--quiet', '--detach', gitText(slot.folder, ['rev-parse', '--verify', 'HEAD^{commit}'])]);
    if (isNotStarted(repo, tree.branch)) notes.push(deleteReleasedBranch(repo, tree.branch));
  }
  if (tree.locked) gitText(repo.dir, ['worktree', 'unlock', '--', slot.folder]);
  lockSlot(repo, slot.folder, lane.branch, null);
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

function claimUnderLock(repo, branch, base, cloning) {
  const worktrees = listWorktrees(repo);
  const holder = worktrees.find((entry) => entry.branch === branch);
  if (holder !== undefined) throw new UsageError(`branch ${branch} is checked out in ${holder.path}: work there, or land or release it first`);
  const slots = poolSlots(repo);
  const filling = slots.find((slot) => slot.state === 'filling' && slot.fillFile.branch === branch);
  if (filling !== undefined) throw new UsageError(`branch ${branch} is being filled in ${filling.folder} (${filling.why}): wait for that claim to end`);
  const tip = branchTip(repo, branch);
  const lane = { branch, base, exists: tip !== null, target: tip ?? base };
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
    && tree?.lockReason === `${LOCK_REASON_PREFIX} ${lane.branch}` && tree.branch === null && head === lane.target;
  if (!unchanged) throw new Error(`${folder} changed during its fill (its fill file, lock, branch or HEAD), so it is not handed out`);
  switchTo(folder, lane.branch, lane.base, lane.exists); // the same commit: no file is written
  deleteFillFile(commonDir, slot);
}

/** Clone mode: the fill outside the lock, then the end step under it; returns the claim's `fill` field. */
function fillAndEnd(repo, claimed, pending, why) {
  const filled = runFill(repo, claimed.folder, pending);
  withPoolLock(commonDirOf(repo), `claim ${pending.lane.branch} end`, () => endFill(repo, claimed, pending));
  return { mode: filled.mode, entries: filled.entries, seconds: filled.seconds, repaired: filled.repaired, warnings: [...pending.notes, ...filled.warnings], why };
}

/** The claim's `fill` field when cloning is not possible: the checkout path, nothing cloned. */
const checkoutFill = ({ mode, why }) => ({ mode, entries: 0, seconds: 0, repaired: 0, warnings: [], why });

/**
 * Hands the lane `branch` a pool folder of `repo`, switched to the branch (made at `base` when new) and locked; in clone mode filled
 * by cloning the main checkout first (see the header).
 * @param {object} repo openRepo's result
 * @param {{ branch: string, base: string, env?: NodeJS.ProcessEnv }} lane `base`: full sha a new branch starts at; `env`: HOME and
 *   session id of the job-made record, and GIT_TIDY_LANE_FILL (lane-fill.mjs cloneSupport)
 * @returns {{ folder: string, slot: string, created: boolean, kept: string[], branch: string, base: string, fill: object, record: string }}
 *   `kept`: dependency folders left in place; `fill`: `{ mode: 'clone'|'checkout', entries, seconds, repaired, warnings, why }` (why:
 *   cloneSupport's reason; warnings: the fill's, and a broken slot's refill); `record`: the job-made outcome
 * @throws {UsageError} bad branch name or sha, branch checked out in another folder or being filled there (named), no main worktree;
 *   PoolBusy; Error when git or the fill fails (the folder is then not handed out)
 */
export function claimLane(repo, { branch, base, env = process.env }) {
  checkBranchName(repo, branch);
  refuseBaseBranch(repo, branch);
  checkBase(repo, base);
  const worktrees = listWorktrees(repo);
  const pool = poolFolderOf(repo, worktrees); // UsageError when there is no main worktree folder
  mkdirSync(pool, { recursive: true }); // cloneSupport reads the pool's volume; the first worktree add would make it anyway
  const support = cloneSupport(worktrees[0].path, pool, env);
  const cloning = support.mode === CLONE_MODE;
  const { pending, ...claimed } = withPoolLock(commonDirOf(repo), `claim ${branch}`, () => claimUnderLock(repo, branch, base, cloning));
  const fill = cloning ? fillAndEnd(repo, claimed, pending, support.why) : checkoutFill(support);
  return { ...claimed, branch, base, fill, record: recordFolder(env, claimed.folder, 'made', 'git-tidy lane claim') };
}

/** Why the lane in `tree` may not be released (unfinished work, branch not landed), or null. */
function releaseRefusal(repo, tree) {
  if (tree.branch !== null && baseNames(repo).has(tree.branch)) return `it holds the base branch ${tree.branch}, which is never a lane (never released or deleted)`;
  if (tree.locked && !(tree.lockReason ?? '').startsWith(LOCK_REASON_PREFIX)) return `locked by someone else (${tree.lockReason || 'no reason'})`;
  if (tree.branch === null && !tree.detached) return 'its HEAD is neither a branch nor detached';
  const why = contentBusyWhy(repo, tree); // HEAD is the branch tip: "commits not on the base" is "not landed"
  return why === null ? null : `${tree.branch === null ? '' : `branch ${tree.branch}: `}${why}`;
}

/** Deletes the released lane's branch when nothing would be lost (prune's compare-and-delete and reflog rule). */
function deleteReleasedBranch(repo, branch) {
  const lost = reflogOnlyCommits(repo, [{ cwd: repo.dir, ref: `${HEADS}${branch}` }], branch);
  if (lost.unreadable || lost.truncated || lost.count > 0) return `branch ${branch} kept: its reflog holds commits found nowhere else`;
  const deleted = deleteBranch(repo, branch, branchTip(repo, branch));
  return deleted.action === 'deleted' ? `branch ${branch} deleted (${deleted.detail})` : `branch ${branch} kept: ${deleted.detail}`;
}

function releaseUnderLock(repo, folder) {
  const tree = slotTree(repo, folder);
  if (tree === undefined || tree.missing) return { released: false, why: 'not a present worktree of this repository' };
  if (readSlot(repo, folder).state === 'filling') return { released: false, why: 'a claim is filling it: release it after that claim ends' };
  const refusal = releaseRefusal(repo, tree);
  if (refusal !== null) return { released: false, why: refusal };
  if (tree.branch !== null) gitText(tree.path, ['switch', '--quiet', '--detach', gitText(tree.path, ['rev-parse', '--verify', 'HEAD^{commit}'])]);
  if (tree.locked) gitText(repo.dir, ['worktree', 'unlock', '--', tree.path]);
  const branchLine = tree.branch === null ? null : deleteReleasedBranch(repo, tree.branch);
  return { released: true, why: tree.branch === null ? 'already detached' : 'detached', branch: branchLine };
}

/**
 * Frees the pool folder `folder`: detaches it, removes its claim lock and deletes its landed branch.
 * @param {object} repo openRepo's result
 * @param {string} folder the slot folder
 * @returns {{ released: boolean, why: string, branch?: string|null }} refused (released false) when it is not a pool folder of this
 *   repository, a claim is filling it, someone else's lock holds it, it has unfinished work, or its branch is not landed on the base
 */
export function releaseLane(repo, folder) {
  if (!isPoolSlot(repo, folder)) return { released: false, why: `not a lane folder of this repository (${poolFolderOf(repo)}/lane-<n>)` };
  return withPoolLock(commonDirOf(repo), `release ${folder}`, () => releaseUnderLock(repo, folder));
}

/**
 * After land's fast-forward: the pool folder holding `branch` is unlocked and detached at `landedSha`, so prune deletes the branch and
 * keeps the folder for the next lane. A folder that is not a pool slot, or no longer exactly at the landed sha with clean tracked files,
 * is left to prune as before.
 * @param {object} repo openRepo's result (opened in the base folder)
 * @param {string} branch the landed lane
 * @param {string} landedSha the full sha that landed
 * @returns {{ folder: string|null, why?: string }} never throws: the base already moved, so a failure is reported, not raised
 */
export function detachLandedSlot(repo, branch, landedSha) {
  try {
    const worktrees = listWorktrees(repo);
    const tree = worktrees.find((entry) => !entry.main && !entry.missing && entry.branch === branch);
    if (tree === undefined || !isPoolSlot(repo, tree.path, worktrees)) return { folder: null };
    const head = gitText(tree.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (head !== landedSha) return { folder: null, why: `${tree.path} is at ${head}, not at the landed ${landedSha}` };
    const tracked = gitText(tree.path, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
    if (tracked !== '') return { folder: null, why: `${tree.path} has tracked changes` };
    if (tree.locked) gitText(repo.dir, ['worktree', 'unlock', '--', tree.path]);
    gitText(tree.path, ['switch', '--quiet', '--detach', landedSha]);
    return { folder: tree.path };
  } catch (error) {
    return { folder: null, why: error.message };
  }
}

/** One reclaim decision for a free slot: remove when idle and not the kept lowest one, else keep with why. */
function reclaimVerdict(slot, keepNumber, now, idleMs) {
  if (slot.number === keepNumber) return `the lowest free folder of a repository used in the last ${idleMs / MS_PER_HOUR} h`;
  if (slot.lastUsed === null) return 'its last use cannot be read';
  const idle = now - slot.lastUsed;
  return idle < idleMs ? `used ${Math.floor(idle / MS_PER_HOUR)} h ago` : null;
}

function removeSlot(repo, slot, env) {
  const fresh = readSlot(repo, slot.folder);
  if (fresh.state !== 'free') return { slot: slot.slot, folder: slot.folder, action: 'kept', why: fresh.why };
  const loss = removalLossWhy(repo, slot.folder); // read right before the removal: what `git worktree remove` would destroy
  if (loss !== null) return { slot: slot.slot, folder: slot.folder, action: 'kept', why: loss };
  const removed = runGit(repo.dir, ['worktree', 'remove', '--', slot.folder]);
  if (removed.status !== 0) return { slot: slot.slot, folder: slot.folder, action: 'failed', why: removed.stderr.split('\n')[0] };
  return { slot: slot.slot, folder: slot.folder, action: 'removed', why: `idle, landed, clean`, record: recordFolder(env, slot.folder, 'gone', 'git-tidy lane reclaim') };
}

function reclaimUnderLock(repo, { now, idleMs, env }) {
  const slots = poolSlots(repo).map((slot) => ({ ...slot, lastUsed: slot.state === 'free' ? lastUsedMs(slot.folder) : null }));
  const recent = (slot) => slot.lastUsed === null || now - slot.lastUsed < idleMs;
  // used: a lane in flight (a folder holding a branch) or a free folder used within idleMs (a busy folder's admin files may not be its own)
  const repoUsed = slots.some((slot) => slot.branch !== null || (slot.state === 'free' && recent(slot)));
  const free = slots.filter((slot) => slot.state === 'free');
  const keepNumber = repoUsed && free.length > 0 ? free[0].number : null;
  return slots.map((slot) => {
    if (slot.state !== 'free') return { slot: slot.slot, folder: slot.folder, action: 'kept', why: `${slot.state}: ${slot.why}` };
    const why = reclaimVerdict(slot, keepNumber, now, idleMs);
    return why === null ? removeSlot(repo, slot, env) : { slot: slot.slot, folder: slot.folder, action: 'kept', why };
  });
}

/**
 * Removes the pool folders that are free (detached, clean, landed, unlocked) and idle for `idleMs`, with `git worktree remove` (never
 * --force); when the repository was used in that time (a busy folder, or a free one used), its lowest free folder stays.
 * @param {object} repo openRepo's result
 * @param {{ now?: number, idleMs?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Array<{ slot: string, folder: string, action: 'removed'|'kept'|'failed', why: string, record?: string }>}
 */
export function reclaimLanes(repo, { now = Date.now(), idleMs = RECLAIM_IDLE_MS, env = process.env } = {}) {
  return withPoolLock(commonDirOf(repo), 'reclaim', () => reclaimUnderLock(repo, { now, idleMs, env }));
}
