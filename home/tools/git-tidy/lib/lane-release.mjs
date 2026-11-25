// Purpose: free and remove the lane pool's folders: `releaseLane` frees a folder whose lane landed (or a snapshot), land calls
//   `detachLandedSlot` after its fast-forward, `reclaimLanes` removes folders idle for RECLAIM_IDLE_MS. Also the facts and steps a
//   claim shares with them (lane-pool.mjs imports these): the base names, a branch tip, a slot's worktree entry and the job-made
//   record.
// Exports: RECLAIM_IDLE_MS, releaseLane, detachLandedSlot, reclaimLanes, baseNames, branchTip, slotTree, recordFolder (lane-pool.mjs
//   re-exports the first four, so callers import them from there).
// Invariants:
// - Release and reclaim run under the one pool lock of the repository (pool-lock.mjs), the lock a claim takes too.
// - Facts are read again right before each detach and removal (lane-slots.mjs readSlot), never trusted from an earlier read.
// - Release detaches, unlocks and deletes a landed branch (prune's compare-and-delete; kept when its reflog holds commits found nowhere
//   else); it never detaches or deletes a base branch and refuses a folder a claim is filling. Land detaches the landed folder and
//   prune deletes the branch. The folder stays a plain detached worktree that `git-tidy prune` keeps.
// - Release and land's detach delete the slot's fill file (lane-fill-state.mjs) before they switch or unlock: a fill file counts on a
//   detached, pool-locked slot (lane-slots.mjs), the state both pass through. Land's detach switches before it unlocks, so a failed
//   switch leaves the folder locked on its branch.
// - Reclaim removes a free folder with `git worktree remove` (never --force; it deletes ignored files too, such as a cloned `.env`)
//   only when its HEAD reflog holds no commit found nowhere else (prune's rule) and no ignored folder holds a git repository
//   (lane-slots.mjs removalLossWhy). Every removal writes a job-made record (disk-free/lib/job-made.mjs) when a session id is known.
// - Imports nothing from lane-pool.mjs, which imports this file.
import { gitText, runGit } from './git.mjs';
import { deleteBranch } from './prune.mjs';
import { reflogOnlyCommits } from './reflog.mjs';
import { listWorktrees } from './repo.mjs';
import { withPoolLock } from './pool-lock.mjs';
import { deleteFillFile } from './lane-fill-state.mjs';
import { commonDirOf, contentBusyWhy, isPoolSlot, lastUsedMs, LOCK_REASON_PREFIX, poolFolderOf, poolSlots, readSlot, removalLossWhy, slotKey } from './lane-slots.mjs';
import { recordJobMade } from '../../disk-free/lib/job-made.mjs';

export const RECLAIM_IDLE_MS = 24 * 60 * 60 * 1000; // fixes-spec revision 2 (U8): a folder unused for a day is reclaimed
const HEADS = 'refs/heads/';
const MS_PER_HOUR = 60 * 60 * 1000;
const SESSION_VARIABLES = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'];

/** The base branch and every other base candidate that exists here (main, master, develop): none of them is ever a lane. */
export const baseNames = (repo) => new Set([repo.base, ...repo.knownBases]);

/** The full sha `branch` points at, or null when there is no such branch. */
export const branchTip = (repo, branch) => {
  const read = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${branch}`]);
  return read.status === 0 ? read.stdout.trim() : null;
};

/** The worktree entry of the slot folder `folder` (real paths compared), or undefined when it is not a linked worktree here. */
export const slotTree = (repo, folder) => listWorktrees(repo).find((entry) => !entry.main && slotKey(entry.path) === slotKey(folder));

/** The session id the job-made record is filed under, or null. */
const sessionOf = (env) => SESSION_VARIABLES.map((name) => env[name]).find((value) => typeof value === 'string' && value !== '') ?? null;

/** Records a made or gone lane folder; returns the record's outcome ('recorded', 'refused' with no session id, ...). */
export function recordFolder(env, folder, op, by) {
  const session = sessionOf(env);
  return session === null ? 'no session id' : recordJobMade(env, session, { kind: 'lane-folder', key: folder, by, op });
}

/** Why the lane in `tree` may not be released (unfinished work, branch not landed), or null. */
function releaseRefusal(repo, tree) {
  if (tree.branch !== null && baseNames(repo).has(tree.branch)) return `it holds the base branch ${tree.branch}, which is never a lane (never released or deleted)`;
  if (tree.locked && !(tree.lockReason ?? '').startsWith(LOCK_REASON_PREFIX)) return `locked by someone else (${tree.lockReason || 'no reason'})`;
  if (tree.branch === null && !tree.detached) return 'its HEAD is neither a branch nor detached';
  const why = contentBusyWhy(repo, tree); // HEAD is the branch tip: "commits not on the base" is "not landed"
  return why === null ? null : `${tree.branch === null ? '' : `branch ${tree.branch}: `}${why}`;
}

/** Deletes the released lane's branch when nothing would be lost (prune's compare-and-delete and reflog rule); returns what happened. */
function deleteReleasedBranch(repo, branch) {
  const lost = reflogOnlyCommits(repo, [{ cwd: repo.dir, ref: `${HEADS}${branch}` }], branch);
  if (lost.unreadable || lost.truncated || lost.count > 0) return `branch ${branch} kept: its reflog holds commits found nowhere else`;
  const deleted = deleteBranch(repo, branch, branchTip(repo, branch));
  return deleted.action === 'deleted' ? `branch ${branch} deleted (${deleted.detail})` : `branch ${branch} kept: ${deleted.detail}`;
}

function releaseUnderLock(repo, folder) {
  const tree = slotTree(repo, folder);
  if (tree === undefined || tree.missing) return { released: false, why: 'not a present worktree of this repository' };
  const slot = readSlot(repo, folder);
  if (slot.state === 'filling') return { released: false, why: 'a claim is filling it: release it after that claim ends' };
  const refusal = releaseRefusal(repo, tree);
  if (refusal !== null) return { released: false, why: refusal };
  deleteFillFile(commonDirOf(repo), slot.slot); // first: once detached and still locked, a leftover would read broken
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
    deleteFillFile(commonDirOf(repo), readSlot(repo, tree.path, worktrees).slot); // first: see the header
    gitText(tree.path, ['switch', '--quiet', '--detach', landedSha]);
    if (tree.locked) gitText(repo.dir, ['worktree', 'unlock', '--', tree.path]); // after the switch: a failed one keeps the lock
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
