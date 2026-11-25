// Purpose: the git worktrees a step made (audit Job A2, A5): the list of a folder's worktrees, the ones that appeared since the
//   step's first start, how much work each holds, and the end-of-run removal of the ones that hold none.
// Exports: WORKTREES_MAX, listWorktrees, newWorktrees, worktreeState, commitsSince, removeIfEmpty.
// Invariants: reads git only (`worktree list --porcelain`, `status --porcelain`, `rev-list`), except removeIfEmpty, which removes
//   a worktree only when it has no uncommitted, untracked or ignored file, no file marked assume-unchanged or skip-worktree on
//   disk, and no commit that is not on the step folder's HEAD or a remote, and only with a plain `git worktree remove` (git
//   itself refuses a dirty one); a branch is never deleted; worktrees that existed before the step's first start and the run's own lane worktrees (`long-run/<run>/...`) are never listed as made by a step.
import { spawnSync } from 'node:child_process';
import { HIDDEN_FILES_WHY, hiddenFileCount } from '../../git-tidy/lib/repo.mjs';

/** At most this many worktrees are kept per step journal. */
export const WORKTREES_MAX = 50;
const BRANCH_PREFIX = 'refs/heads/';

const git = (folder, args) => spawnSync('git', ['-C', folder, ...args], { encoding: 'utf8' });

/**
 * The worktrees of the repository `folder` belongs to.
 * @param {string} folder any folder of the repository.
 * @returns {{path: string, branch: string | null, head: string | null, locked: boolean}[] | null} null when it is no git folder.
 */
export function listWorktrees(folder) {
  const run = git(folder, ['worktree', 'list', '--porcelain']);
  if (run.status !== 0) return null;
  return run.stdout.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const lines = block.split('\n');
    const value = (key) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
    const branch = value('branch');
    return { path: value('worktree'), branch: branch?.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : branch, head: value('HEAD'), locked: lines.some((line) => line === 'locked' || line.startsWith('locked ')) };
  });
}

/**
 * The worktrees that are not in `basePaths` (those that existed before the step's first start, its own folder among them),
 * without the run's lane worktrees (a parallel group's items, made by the runner, not by a boss).
 * @param {ReturnType<typeof listWorktrees>} now listWorktrees() of the step folder.
 * @param {{basePaths: string[], runId: string}} step
 * @returns {{path: string, branch: string | null, head: string | null}[]}
 */
export function newWorktrees(now, { basePaths, runId }) {
  const lanePrefix = `long-run/${runId}/`;
  return (now ?? []).filter((one) => !basePaths.includes(one.path) && !one.branch?.startsWith(lanePrefix))
    .map(({ path, branch, head }) => ({ path, branch, head }));
}

/**
 * How much work a worktree holds.
 * @param {string} path the worktree.
 * @param {string | null} base the commit its new commits are counted from (the step's HEAD before it started), or null.
 * @returns {{exists: boolean, changes: number, ahead: number | null}} `changes`: lines of `git status --porcelain`; `ahead`:
 *   commits on its HEAD that are not on `base` (null without a base or when git cannot tell).
 */
export function worktreeState(path, base) {
  const status = git(path, ['status', '--porcelain']);
  if (status.status !== 0) return { exists: false, changes: 0, ahead: null };
  const changes = status.stdout.split('\n').filter((line) => line.trim() !== '').length;
  return { exists: true, changes, ahead: commitsSince(path, base) };
}

/** The commits on HEAD of `folder` since `base` (the step's HEAD before its first start), or null when git cannot tell. */
export function commitsSince(folder, base) {
  if (!base) return null;
  const count = git(folder, ['rev-list', '--count', `${base}..HEAD`]);
  return count.status === 0 ? Number(count.stdout.trim()) : null;
}

/**
 * Removes a worktree a step made when it holds no work of its own: no uncommitted, untracked or ignored file, no file marked
 * assume-unchanged or skip-worktree on disk (repo.mjs hiddenFileCount), and no commit
 * that is not on the step folder's HEAD or a remote-tracking branch. Unlocks it first when it is locked (Claude Code locks agent worktrees).
 * @param {{path: string}} worktree
 * @param {string} folder the step folder (its HEAD is where finished work lands).
 * @returns {string} `removed`, `gone` (no longer a worktree) or `kept: <why>`, for the summary.
 */
export function removeIfEmpty(worktree, folder) {
  // Untracked and ignored files too: `git worktree remove` deletes them, and status.showUntrackedFiles=no would hide them.
  const status = git(worktree.path, ['status', '--porcelain', '--untracked-files=all', '--ignored']);
  if (status.status !== 0) return 'gone';
  if (status.stdout.trim() !== '') return 'kept: uncommitted, untracked or ignored files';
  const hidden = hiddenFileCount(worktree.path); // edits git status skips
  if (hidden === null) return 'kept: git ls-files failed';
  if (hidden > 0) return `kept: ${hidden} files ${HIDDEN_FILES_WHY}`;
  const folderHead = git(folder, ['rev-parse', '--verify', 'HEAD']);
  const landed = folderHead.status === 0 ? [folderHead.stdout.trim()] : [];
  const own = git(worktree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes', ...landed]);
  if (own.status !== 0) return `kept: git rev-list failed (${own.stderr.trim().slice(0, 120)})`;
  if (Number(own.stdout.trim()) > 0) return `kept: ${own.stdout.trim()} commit(s) not on ${folder} or a remote`;
  const locked = listWorktrees(folder)?.find((one) => one.path === worktree.path)?.locked;
  if (locked) git(folder, ['worktree', 'unlock', worktree.path]);
  const removed = git(folder, ['worktree', 'remove', worktree.path]);
  return removed.status === 0 ? 'removed' : `kept: git worktree remove failed (${removed.stderr.trim().slice(0, 120)})`;
}
