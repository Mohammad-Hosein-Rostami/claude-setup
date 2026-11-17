// Purpose: `git-tidy land`: put a lane on the base as one straight line: rebase it onto the base, require a full-suite PASS on the
//   rebased tip, fast-forward the base, then remove the lane's worktree and branch and every proven leftover.
// Exports: landLane.
// Invariants: the base must be checked out in a worktree (the base folder) with no tracked changes; untracked files there are never
//   touched, and an untracked path the lane would overwrite is refused before anything changes. The rebase runs in the worktree that
//   holds the lane, or in a temporary one that is removed again; a conflict aborts the rebase and leaves the lane where it was. The
//   base moves only by `merge --ff-only` run in the base folder, and only when `hasPass(<base folder>, <rebased tip>, { suite: true })`
//   is true, so the tip that lands is the exact tree the suite passed on. Cleanup is prune's (every safety it has), nothing extra.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError, gitText, runGit } from './git.mjs';
import { patchIdsOf } from './copies.mjs';
import { runCheck } from './check.mjs';
import { pruneRepo, refuseUnsafeApply } from './prune.mjs';
import { inProgressOperation, listWorktrees, openRepo } from './repo.mjs';

const PATHS_PER_LOOKUP = 200; // paths given to one `git ls-files` call, so a big lane never exceeds the argument limit
const REMOVED_ACTIONS = new Set(['removed', 'deleted']);

const lines = (text) => text.split('\n').filter((line) => line !== '');

const trackedChanges = (folder) => lines(gitText(folder, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']));

/** Untracked paths in `folder` that the lane's changes would write over (ignored files count: git overwrites those silently). */
function untrackedInTheWay(repo, baseFolder, branch) {
  const changed = gitText(repo.dir, ['diff', '--name-only', '-z', '--no-renames', `${repo.baseRef}...refs/heads/${branch}`]).split('\0').filter((path) => path !== '');
  const inTheWay = [];
  for (let start = 0; start < changed.length; start += PATHS_PER_LOOKUP) {
    const chunk = changed.slice(start, start + PATHS_PER_LOOKUP).map((path) => `:(literal)${path}`);
    inTheWay.push(...gitText(baseFolder, ['ls-files', '--others', '-z', '--', ...chunk]).split('\0').filter((path) => path !== ''));
  }
  return inTheWay;
}

/** The base folder and the lane's folder (null when no worktree holds the lane); throws UsageError when the landing cannot start. */
function prepare(repo, branch) {
  refuseUnsafeApply(repo);
  if (branch === repo.base) throw new UsageError(`${branch} is the base branch, there is nothing to land`);
  if (runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status !== 0) throw new UsageError(`branch "${branch}" does not exist here`);
  const trees = listWorktrees(repo).filter((tree) => !tree.missing && !tree.bare);
  const baseFolder = trees.find((tree) => tree.branch === repo.base)?.path;
  if (baseFolder === undefined) throw new UsageError(`${repo.base} is not checked out in any worktree: land needs the base folder to fast-forward`);
  const changed = trackedChanges(baseFolder);
  if (changed.length > 0) throw new UsageError(`${baseFolder} has tracked changes, commit or stash them first:\n${changed.join('\n')}`);
  const overwritten = untrackedInTheWay(repo, baseFolder, branch);
  if (overwritten.length > 0) throw new UsageError(`untracked files in ${baseFolder} that landing ${branch} would overwrite: ${overwritten.join(', ')}`);
  const laneFolder = trees.find((tree) => tree.branch === branch)?.path ?? null;
  if (laneFolder !== null && trackedChanges(laneFolder).length > 0) throw new UsageError(`${laneFolder} (the lane) has tracked changes, commit them first`);
  return { baseFolder, laneFolder };
}

/** Rebases the lane in `folder`; returns `{ conflict: string[] }` after aborting a conflicting rebase, or `{ conflict: null }`. */
function rebaseIn(folder, repo, branch) {
  const result = runGit(folder, ['rebase', `refs/heads/${repo.base}`]);
  if (result.status === 0) return { conflict: null };
  if (inProgressOperation(folder) !== 'rebase') throw new Error(`git rebase failed: ${result.stderr.split('\n')[0]}`);
  const files = lines(gitText(folder, ['diff', '--name-only', '--diff-filter=U']));
  gitText(folder, ['rebase', '--abort']);
  return { conflict: files };
}

// The lane's folder is its worktree, or a temporary one that exists only for the rebase.
function rebaseLane(repo, branch, laneFolder) {
  if (laneFolder !== null) return rebaseIn(laneFolder, repo, branch);
  const parent = mkdtempSync(join(tmpdir(), 'git-tidy-land-'));
  const folder = join(parent, 'lane');
  try {
    gitText(repo.dir, ['worktree', 'add', '--quiet', '--', folder, branch]);
    try {
      return rebaseIn(folder, repo, branch);
    } finally {
      runGit(repo.dir, ['worktree', 'remove', '--force', '--', folder]);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    runGit(repo.dir, ['worktree', 'prune']);
  }
}

/** Number of patch ids in `before` that `after` lacks (each id counted as often as it occurs). */
function changedPatches(before, after) {
  const left = new Map();
  for (const id of after) left.set(id, (left.get(id) ?? 0) + 1);
  return before.filter((id) => (left.get(id) > 0 ? (left.set(id, left.get(id) - 1), false) : true)).length;
}

const tipOf = (repo, branch) => gitText(repo.dir, ['rev-parse', `refs/heads/${branch}`]);

// The base folder has the base branch at `base`; a failed fast-forward is "the base moved" when the lane no longer sits on top of it.
function fastForward(repo, baseFolder, branch) {
  const onTop = () => runGit(repo.dir, ['merge-base', '--is-ancestor', `refs/heads/${repo.base}`, `refs/heads/${branch}`]).status === 0;
  if (!onTop()) return { moved: true };
  const merged = runGit(baseFolder, ['merge', '--ff-only', '--quiet', `refs/heads/${branch}`]);
  if (merged.status === 0) return { moved: false };
  if (!onTop()) return { moved: true };
  throw new Error(`git merge --ff-only failed: ${merged.stderr.split('\n')[0]}`);
}

/**
 * Lands `branch` on the base of `repo` (from openRepo).
 * @param {object} repo the repository (openRepo)
 * @param {string} branch the lane, a local branch other than the base
 * @param {{ rebaseOnly?: boolean, hasPass: (repoDir: string, rev: string, options: { suite: boolean }) => boolean }} options
 *   `rebaseOnly` stops after the rebase; `hasPass` is test-pass's lookup of a suite PASS for a commit
 * @returns {{ status: 'landed'|'rebased'|'conflict'|'no-pass'|'base-moved', tip: string, patchesChanged: number, removed: string[],
 *   findings: object[], files: string[] }} `tip` is the lane's tip after the rebase, `files` the conflicting files, `removed` what
 *   cleanup removed (`<kind> <name or path>`), `findings` what `check` still reports on the base afterwards
 * @throws {UsageError} when the base folder is not ready (not checked out, tracked changes, an untracked path in the way), the lane
 *   is missing or is the base, or a rebase or merge is unfinished somewhere; any other git failure throws an Error
 */
export function landLane(repo, branch, { rebaseOnly = false, hasPass }) {
  const { baseFolder, laneFolder } = prepare(repo, branch);
  const before = patchIdsOf(repo, `refs/heads/${branch}`);
  const { conflict } = rebaseLane(repo, branch, laneFolder);
  const tip = tipOf(repo, branch); // read before cleanup removes the branch
  const result = (status, extra = {}) => ({ status, tip, patchesChanged: 0, removed: [], findings: [], files: [], ...extra });
  if (conflict !== null) return result('conflict', { files: conflict });
  const patchesChanged = changedPatches(before, patchIdsOf(repo, `refs/heads/${branch}`));
  if (rebaseOnly) return result('rebased', { patchesChanged });
  if (!hasPass(baseFolder, tip, { suite: true })) return result('no-pass', { patchesChanged });
  if (fastForward(repo, baseFolder, branch).moved) return result('base-moved', { patchesChanged });
  const atBase = openRepo(baseFolder, repo.base);
  const removed = pruneRepo(atBase, { apply: true, includeRecent: true }).filter((entry) => REMOVED_ACTIONS.has(entry.action)).map((entry) => `${entry.kind} ${entry.subject}`);
  return result('landed', { patchesChanged, removed, findings: runCheck(atBase).findings });
}
