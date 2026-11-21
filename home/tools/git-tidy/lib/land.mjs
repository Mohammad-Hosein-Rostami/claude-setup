// Purpose: `git-tidy land`: put a lane on the base as one straight line: rebase it onto the base, require a full-suite PASS on the
//   rebased tip, fast-forward the base, then remove the lane's worktree and branch and every proven leftover.
// Exports: landLane.
// Invariants: the base must be checked out in a worktree (the base folder) with no tracked changes; untracked files there are never
//   touched, and an untracked path the lane would overwrite is refused before anything changes. The rebase runs in the worktree that
//   holds the lane, or in a temporary one that is removed again; a conflict aborts the rebase and leaves the lane where it was. The
//   base moves only by `merge --ff-only` run in the base folder, and only when `hasPass(<base folder>, <rebased tip>, { suite: true })`
//   is true, and the merge names that very commit (not the lane's branch, which may have moved since), so what lands is exactly the tree
//   the suite passed on. Cleanup is prune's (every safety it has); only the landed lane skips prune's 60-minute rule, and a cleanup
//   that prune refuses (an unfinished operation somewhere) is reported in `cleanupRefused` since the base has already moved.
//   Before the fast-forward (spec-p3 `r9-land-speed`): a lane whose UI files differ from the base needs `uiCheck` to pass for the rebased
//   tip (status `ui-proof`), and a file the lane adds over MAX_NEW_FILE_BYTES that its brief does not name stops it (`new-file-size`).
//   A landing reports `from`, the base tip just before the fast-forward (the reflog's value when another process moved the base between).
//   Before the suite lookup (`r9-git-line`): the base's upstream is fetched and compared (lib/upstream.mjs); upstream commits the base lacks
//   stop it (`upstream-moved`), and every result after that point carries `upstream` (published count, WARN of an offline fetch).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError, gitText, runGit } from './git.mjs';
import { patchIdsOf } from './copies.mjs';
import { landedFrom, oversizeAdded } from './land-checks.mjs';
import { runCheck } from './check.mjs';
import { upstreamState } from './upstream.mjs';
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

// The base folder has the base branch at `base`; a failed fast-forward is "the base moved" when `tip` no longer sits on top of it.
function fastForward(repo, baseFolder, tip) {
  const onTop = () => runGit(repo.dir, ['merge-base', '--is-ancestor', `refs/heads/${repo.base}`, tip]).status === 0;
  if (!onTop()) return { moved: true };
  const merged = runGit(baseFolder, ['merge', '--ff-only', '--quiet', tip]);
  if (merged.status === 0) return { moved: false };
  if (!onTop()) return { moved: true };
  throw new Error(`git merge --ff-only failed: ${merged.stderr.split('\n')[0]}`);
}

// Prune everything provable after the landing; a refusal (UsageError) is the answer, never an exit 2 for a base that already moved.
function cleanUp(atBase, branch) {
  try {
    // The landed lane's own worktree may be locked by the git-tidy-gate hook (r9-wt-lock): unlock it so prune can remove it; no other lock is touched.
    for (const tree of listWorktrees(atBase).filter((entry) => entry.locked && !entry.main && entry.branch === branch)) runGit(atBase.dir, ['worktree', 'unlock', '--', tree.path]);
    const items = pruneRepo(atBase, { apply: true, includeRecent: [branch] });
    return { removed: items.filter((entry) => REMOVED_ACTIONS.has(entry.action)).map((entry) => `${entry.kind} ${entry.subject}`), cleanupRefused: null };
  } catch (error) {
    if (error instanceof UsageError) return { removed: [], cleanupRefused: error.message };
    throw error;
  }
}

/**
 * Lands `branch` on the base of `repo` (from openRepo).
 * @param {object} repo the repository (openRepo)
 * @param {string} branch the lane, a local branch other than the base
 * @param {{ rebaseOnly?: boolean, hasPass: (repoDir: string, rev: string, options: { suite: boolean }) => boolean,
 *   uiCheck?: (repoDir: string, baseSha: string, tip: string) => string|null, briefText?: string|null }} options
 *   `rebaseOnly` stops after the rebase; `hasPass` is test-pass's lookup of a suite PASS for a commit; `uiCheck` returns null when the UI
 *   proof holds (or no UI file changed) and else the reason (the CLI always passes one, failing closed when ui-proof cannot be loaded);
 *   `briefText` is the lane's brief, whose named paths may add files over the size limit (null: none)
 * @returns {{ status: 'landed'|'rebased'|'conflict'|'no-pass'|'base-moved'|'ui-proof'|'new-file-size'|'upstream-moved', tip: string, upstream: object|null, from: string|null,
 *   patchesChanged: number, removed: string[], cleanupRefused: string|null, findings: object[], files: string[], why: string|null }} `tip`
 *   is the lane's tip after the rebase, `from` the base tip before the fast-forward (landed only), `files` the conflicting files (or the
 *   oversize ones), `removed` what cleanup removed (`<kind> <name or path>`), `findings` what `check` still reports on the base afterwards
 * @throws {UsageError} when the base folder is not ready (not checked out, tracked changes, an untracked path in the way), the lane
 *   is missing or is the base, or a rebase or merge is unfinished somewhere; any other git failure throws an Error
 */
export function landLane(repo, branch, { rebaseOnly = false, hasPass, uiCheck = () => null, briefText = null }) {
  const { baseFolder, laneFolder } = prepare(repo, branch);
  const before = patchIdsOf(repo, `refs/heads/${branch}`);
  const { conflict } = rebaseLane(repo, branch, laneFolder);
  const tip = tipOf(repo, branch); // read before cleanup removes the branch
  const result = (status, extra = {}) => ({ status, tip, from: null, patchesChanged: 0, removed: [], cleanupRefused: null, findings: [], files: [], why: null, upstream: null, ...extra });
  if (conflict !== null) return result('conflict', { files: conflict });
  const patchesChanged = changedPatches(before, patchIdsOf(repo, `refs/heads/${branch}`));
  if (rebaseOnly) return result('rebased', { patchesChanged });
  const upstream = upstreamState(repo);
  if (upstream.moved > 0) return result('upstream-moved', { patchesChanged, upstream, why: `${upstream.upstream} has ${upstream.moved} commit(s) the base lacks` });
  if (!hasPass(baseFolder, tip, { suite: true })) return result('no-pass', { patchesChanged, upstream });
  const baseSha = gitText(repo.dir, ['rev-parse', repo.baseRef]);
  const big = oversizeAdded(repo, baseSha, tip, briefText);
  if (big.length > 0) return result('new-file-size', { patchesChanged, files: big.map(({ path }) => path), why: big.map(({ path, bytes }) => `${path} (${bytes} bytes)`).join(', ') });
  const uiWhy = uiCheck(baseFolder, baseSha, tip);
  if (uiWhy !== null) return result('ui-proof', { patchesChanged, why: uiWhy });
  const readBefore = gitText(repo.dir, ['rev-parse', repo.baseRef]);
  if (fastForward(repo, baseFolder, tip).moved) return result('base-moved', { patchesChanged });
  const from = landedFrom(repo, readBefore);
  const atBase = openRepo(baseFolder, repo.base);
  const { removed, cleanupRefused } = cleanUp(atBase, branch);
  return result('landed', { from, patchesChanged, removed, cleanupRefused, findings: runCheck(atBase).findings, upstream });
}
