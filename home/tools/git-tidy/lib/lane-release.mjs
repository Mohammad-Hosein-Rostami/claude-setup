// Purpose: free and remove the lane pool's folders: `releaseLane` frees a folder whose lane landed (or a snapshot), land calls
//   `detachLandedSlot` after its fast-forward, `reclaimLanes` removes folders idle for RECLAIM_IDLE_MS. Also the facts and steps a
//   claim shares with them (lane-pool.mjs imports these): the base names, a branch tip, a slot's worktree entry and the job-made
//   record.
// Exports: RECLAIM_IDLE_MS, releaseLane, detachLandedSlot, reclaimLanes, baseNames, branchTip, slotTree, recordFolder (lane-pool.mjs
//   re-exports the first four, so callers import them from there).
// Invariants:
// - Release, reclaim and land's detach run under the one pool lock of the repository (pool-lock.mjs), the lock a claim takes too.
// - Facts are read again right before each detach and removal (lane-slots.mjs readSlot), never trusted from an earlier read.
// - Release detaches, unlocks and deletes a landed branch (prune's compare-and-delete; kept when its reflog holds commits found nowhere
//   else); it never detaches or deletes a base branch and refuses a folder a claim is filling. Land detaches the landed folder and
//   prune deletes the branch. The folder stays a plain detached worktree that `git-tidy prune` keeps.
// - Release and land's detach delete the slot's fill file (lane-fill-state.mjs) before they switch or unlock: a fill file counts on a
//   detached, pool-locked slot (lane-slots.mjs), the state both pass through.
// - Land's detach runs under the pool lock and reads the slot inside it; it frees only the pool slot that holds the landed branch at
//   the landed sha with clean tracked files (fill file, switch, unlock, in that order); any other pool slot holding it is kept as it
//   is, locked, and the result says why and the `lane release` step. Neither land unlocks or removes a pool slot.
// - Reclaim removes a free folder with `git worktree remove` (never --force; it deletes ignored files too, such as a cloned `.env`)
//   only when its HEAD reflog holds no commit found nowhere else (prune's rule) and no ignored folder holds a git repository
//   (lane-slots.mjs removalLossWhy). Every removal writes a job-made record (disk-free/lib/job-made.mjs) when a session id is known.
// - Imports nothing from lane-pool.mjs, which imports this file.
import { gitText, runGit } from './git.mjs';
import { deleteBranch } from './prune.mjs';
import { reflogOnlyCommits } from './reflog.mjs';
import { listWorktrees } from './repo.mjs';
import { shellWord } from './shell-word.mjs';
import { withPoolLock } from './pool-lock.mjs';
import { deleteFillFile } from './lane-fill-state.mjs';
import { commonDirOf, contentBusyWhy, isPoolSlot, lastUsedMs, LOCK_REASON_PREFIX, poolFolderOf, poolSlots, readSlot, removalLossWhy, slotKey } from './lane-slots.mjs';
import { recordJobMade } from '../../disk-free/lib/job-made.mjs';

export const RECLAIM_IDLE_MS = 24 * 60 * 60 * 1000; // fixes-spec revision 2 (U8): a folder unused for a day is reclaimed
const HEADS = 'refs/heads/';
const MS_PER_HOUR = 60 * 60 * 1000;
const SESSION_VARIABLES = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'];
const RELEASE_COMMAND = 'node ~/.claude/tools/git-tidy/git-tidy.mjs lane release'; // ~ unquoted: the shell expands it

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

/** git's first non-empty message line (a local copy: git-tidy imports nothing from home/tools/land). */
const firstLine = (text) => text.split(/[\r\n]+/).find((line) => line.trim() !== '')?.trim() ?? '';

/** The result for a pool slot land could not free: it stays as it is (locked), and `why` ends with the `lane release` step. */
const keptSlot = (repo, folder, why) => ({
  folder: null,
  kept: folder,
  other: null,
  why: `${why}; deal with that, then free it with: ${RELEASE_COMMAND} --repo ${shellWord(repo.dir)} --folder ${shellWord(folder)}`,
});

// Every fact is read here, under the pool lock, so no claim, release or reclaim can change the slot between the read and the act.
function detachUnderLock(repo, branch, landedSha) {
  const worktrees = listWorktrees(repo);
  const tree = worktrees.find((entry) => !entry.main && !entry.missing && entry.branch === branch);
  if (tree === undefined) return { folder: null, kept: null, other: null };
  if (!isPoolSlot(repo, tree.path, worktrees)) return { folder: null, kept: null, other: tree };
  const head = gitText(tree.path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head !== landedSha) return keptSlot(repo, tree.path, `its HEAD is at ${head}, not at the landed ${landedSha}`);
  const tracked = gitText(tree.path, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
  if (tracked !== '') return keptSlot(repo, tree.path, 'it has tracked changes');
  deleteFillFile(commonDirOf(repo), readSlot(repo, tree.path, worktrees).slot); // first: see the header
  const switched = runGit(tree.path, ['switch', '--quiet', '--detach', landedSha]);
  if (switched.status !== 0) return keptSlot(repo, tree.path, `git switch failed: ${firstLine(switched.stderr)}`);
  if (tree.locked) {
    const unlocked = runGit(repo.dir, ['worktree', 'unlock', '--', tree.path]); // after the switch: a failed one keeps the lock
    if (unlocked.status !== 0) return keptSlot(repo, tree.path, `git worktree unlock failed: ${firstLine(unlocked.stderr)}`);
  }
  return { folder: tree.path, kept: null, other: null };
}

/**
 * After land's fast-forward, under the pool lock: the pool folder holding `branch` is detached at `landedSha` and unlocked, so prune
 * deletes the branch and keeps the folder for the next lane. A pool folder that is not exactly at the landed sha with clean tracked
 * files, or whose switch or unlock fails, is kept as it is (locked); land never unlocks or removes it any other way.
 * @param {object} repo openRepo's result (opened in the base folder)
 * @param {string} branch the landed lane
 * @param {string} landedSha the full sha that landed
 * @returns {{ folder: string|null, kept: string|null, other: object|null, why?: string }}
 *   folder: the pool folder now free; kept: the pool folder that holds or held `branch` and is not free (why says what stopped it
 *   and the release step); other: the listWorktrees entry of a worktree outside the pool that holds `branch` (the caller's to
 *   remove); all null: no worktree holds it (why set: the detach could not run, nothing was touched). Never throws: the base
 *   already moved, so a failure is reported, not raised. The caller must not hold the pool lock (withPoolLock is not re-entrant).
 */
export function detachLandedSlot(repo, branch, landedSha) {
  try {
    return withPoolLock(commonDirOf(repo), `land ${branch}`, () => detachUnderLock(repo, branch, landedSha));
  } catch (error) {
    return { folder: null, kept: null, other: null, why: error.message };
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
