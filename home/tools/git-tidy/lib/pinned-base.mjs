// Purpose: pin the base of one prune run to a commit, and tell when the base branch has moved away from it since.
// Exports: pinBase, baseMovedReason, baseMoved.
// Invariants: reads only. A pinned repo's `baseRef` and `baseSha` are that commit, so every proof of the run compares with the
//   same commit even if the base branch is reset or moved meanwhile; prune checks baseMovedReason before each worktree removal,
//   and deleteBranch (prune.mjs) puts the same check into its delete transaction.
import { gitText, runGit } from './git.mjs';

const HEADS = 'refs/heads/';

/** `repo` (openRepo's result) with `baseRef` and `baseSha` set to the commit its base branch points at now. */
export function pinBase(repo) {
  const baseSha = gitText(repo.dir, ['rev-parse', '--verify', `${HEADS}${repo.base}^{commit}`]);
  return { ...repo, baseRef: baseSha, baseSha };
}

/** Null while the base branch of the pinned `repo` still points at `repo.baseSha` (or nothing is pinned), else why to stop. */
export function baseMovedReason(repo) {
  if (repo.baseSha === undefined) return null;
  const now = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${repo.base}`]).stdout.trim();
  return now === repo.baseSha ? null : `${repo.base} moved during the clean-up (from ${repo.baseSha} to ${now || 'nothing'}); stopped, nothing more removed`;
}

/**
 * Why the run of `ctx` (`{ repo, stopped }`, prune's context) stops: once its pinned base moved, that reason, kept in
 * ctx.stopped so everything after it is kept for the same reason; else null.
 */
export const baseMoved = (ctx) => (ctx.stopped ??= baseMovedReason(ctx.repo));
