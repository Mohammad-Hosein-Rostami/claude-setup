// Purpose: decide whether a local branch is already on the base, and how many commits it still has that are not.
// Exports: branchState, isMerged, lastCommitDate.
// Invariants: only `ancestor` and `patch-equal` mean "merged"; anything that cannot be proven is `unmerged` (fail closed).
//   A branch holding a merge commit is never `patch-equal`: `git cherry` skips merge commits, so hand-made changes in
//   one would go unseen.
import { runGit } from './git.mjs';

const IS_ANCESTOR = 0;
const NOT_ANCESTOR = 1;

function countCommits(dir, args) {
  const result = runGit(dir, ['rev-list', '--count', ...args]);
  return result.status === 0 ? Number(result.stdout) : 0;
}

/**
 * Compares local branch `name` with the base. Returns `{ state, tip, ahead }`: state is `ancestor` (tip is on the base),
 * `patch-equal` (every commit has an equal patch on the base, a rebase or cherry-pick that landed), `unmerged` (ahead =
 * commits the base lacks) or `missing`. `tip` is the full hash at the moment of the call.
 */
export function branchState(repo, name) {
  const ref = `refs/heads/${name}`;
  const tipResult = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', ref]);
  if (tipResult.status !== 0) return { state: 'missing', tip: null, ahead: 0 };
  const tip = tipResult.stdout.trim();
  const ancestor = runGit(repo.dir, ['merge-base', '--is-ancestor', ref, repo.baseRef]).status;
  if (ancestor === IS_ANCESTOR) return { state: 'ancestor', tip, ahead: 0 };
  const range = `${repo.baseRef}..${ref}`;
  const unmerged = (ahead) => ({ state: 'unmerged', tip, ahead });
  if (ancestor !== NOT_ANCESTOR || countCommits(repo.dir, ['--merges', range]) > 0) return unmerged(countCommits(repo.dir, [range]));
  const cherry = runGit(repo.dir, ['cherry', repo.baseRef, ref]);
  if (cherry.status !== 0) return unmerged(countCommits(repo.dir, [range]));
  const marks = cherry.stdout.split('\n').filter((line) => line !== '');
  const plus = marks.filter((line) => line.startsWith('+')).length;
  if (plus === 0 && marks.length > 0) return { state: 'patch-equal', tip, ahead: 0 };
  return unmerged(plus > 0 ? plus : countCommits(repo.dir, [range]));
}

/** True for the two states that mean the branch's work is on the base. */
export const isMerged = (state) => state === 'ancestor' || state === 'patch-equal';

/** The date (YYYY-MM-DD) of the last commit on local branch `name`. */
export function lastCommitDate(repo, name) {
  return runGit(repo.dir, ['log', '-1', '--format=%cs', `refs/heads/${name}`]).stdout.trim();
}
