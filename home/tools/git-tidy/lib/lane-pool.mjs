// Purpose: the lane folder pool of a repository. `claimLane` hands a lane the lowest free folder `<main>/.claude/worktrees/lane-<n>`
//   (its caches stay warm, since the path is the same), or adds the lowest unused lane-<n> when every folder is busy (no cap);
//   `releaseLane` frees a folder whose lane landed; land calls `detachLandedSlot` after its fast-forward; `reclaimLanes` removes folders
//   idle for RECLAIM_IDLE_MS.
// Exports: RECLAIM_IDLE_MS, KEPT_DEPENDENCY_FOLDERS, claimLane, releaseLane, detachLandedSlot, reclaimLanes (and, from lane-slots.mjs,
//   POOL_FOLDER, poolSlots).
// Invariants:
// - Claim, release and reclaim run under the one pool lock of the repository (pool-lock.mjs), so two sessions never get one folder.
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
import { reflogOnlyCommits } from './reflog.mjs';
import { listWorktrees } from './repo.mjs';
import { withPoolLock } from './pool-lock.mjs';
import { commonDirOf, contentBusyWhy, isPoolSlot, lastUsedMs, LOCK_REASON_PREFIX, poolFolderOf, poolSlots, readSlot, removalLossWhy, slotKey, staleEntryLossWhy } from './lane-slots.mjs';
import { recordJobMade } from '../../disk-free/lib/job-made.mjs';
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

/** Names of the kept kinds that exist in `folder` as ignored folders (any depth). */
function presentDependencyFolders(folder, names) {
  const ignored = gitText(folder, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).split('\0');
  return names.filter((name) => ignored.some((entry) => entry.split('/').includes(name)));
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

function lockSlot(repo, folder, branch) {
  const tree = listWorktrees(repo).find((entry) => !entry.main && slotKey(entry.path) === slotKey(folder));
  if (tree === undefined || tree.locked || tree.branch !== branch) throw new Error(`${folder} changed before its lock (locked or on another branch)`);
  gitText(repo.dir, ['worktree', 'lock', '--reason', `${LOCK_REASON_PREFIX} ${branch}`, '--', folder]);
}

/** Reuses a free slot whose facts were just read again: switch, clean (keeping unchanged dependency folders), lock. */
function takeFreeSlot(repo, slot, lane) {
  const oldHead = gitText(slot.folder, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const keep = lockfilesSame(repo, oldHead, lane.target).filter(({ same }) => same).map(({ folder }) => folder);
  const kept = presentDependencyFolders(slot.folder, keep);
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

const lowestUnused = (numbers) => {
  let number = 1;
  while (numbers.has(number)) number += 1;
  return number;
};

function claimUnderLock(repo, branch, base) {
  const worktrees = listWorktrees(repo);
  const holder = worktrees.find((entry) => entry.branch === branch);
  if (holder !== undefined) throw new UsageError(`branch ${branch} is checked out in ${holder.path}: work there, or land or release it first`);
  const tip = branchTip(repo, branch);
  const lane = { branch, base, exists: tip !== null, target: tip ?? base };
  const slots = poolSlots(repo);
  for (const candidate of slots.filter((slot) => slot.state === 'free')) {
    const fresh = readSlot(repo, candidate.folder);
    if (fresh.state === 'free') return takeFreeSlot(repo, fresh, lane);
  }
  const stale = slots.find((slot) => slot.state === 'missing');
  const staleSafe = stale !== undefined && readSlot(repo, stale.folder).state === 'missing' && staleEntryLossWhy(repo, stale.folder) === null;
  if (staleSafe) return createSlot(repo, stale.folder, stale.slot, lane, true); // else its entry stays and a new number is used
  const number = lowestUnused(new Set(slots.map((slot) => slot.number)));
  return createSlot(repo, join(poolFolderOf(repo), `lane-${number}`), `lane-${number}`, lane, false);
}

/**
 * Hands the lane `branch` a pool folder of `repo`, switched to the branch (made at `base` when new) and locked.
 * @param {object} repo openRepo's result
 * @param {{ branch: string, base: string, env?: NodeJS.ProcessEnv }} lane `base`: full sha a new branch starts at; `env`: HOME and session id of the job-made record
 * @returns {{ folder: string, slot: string, created: boolean, kept: string[], branch: string, base: string, record: string }}
 *   `kept`: dependency folders left in place; `record`: the job-made outcome
 * @throws {UsageError} bad branch name or sha, branch checked out in another folder (named), no main worktree; PoolBusy; Error when git fails
 */
export function claimLane(repo, { branch, base, env = process.env }) {
  checkBranchName(repo, branch);
  refuseBaseBranch(repo, branch);
  checkBase(repo, base);
  const claimed = withPoolLock(commonDirOf(repo), `claim ${branch}`, () => claimUnderLock(repo, branch, base));
  return { ...claimed, branch, base, record: recordFolder(env, claimed.folder, 'made', 'git-tidy lane claim') };
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
  const tree = listWorktrees(repo).find((entry) => !entry.main && slotKey(entry.path) === slotKey(folder));
  if (tree === undefined || tree.missing) return { released: false, why: 'not a present worktree of this repository' };
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
 *   repository, someone else's lock holds it, it has unfinished work, or its branch is not landed on the base
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
