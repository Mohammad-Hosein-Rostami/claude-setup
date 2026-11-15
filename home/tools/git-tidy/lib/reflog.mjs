// Purpose: find commits that exist only in a reflog. `git worktree remove` deletes the worktree's HEAD reflog and deleting
//   a branch deletes its reflog, so a commit dropped with `reset --hard` would become unrecoverable.
// Exports: branchReflogs, reflogOnlyCommits.
// Invariants: reads only; the newest MAX_ENTRIES entries of each reflog are read, more than that is reported as truncated
//   (callers keep the item). A commit is safe when it is on the base, still reachable from another ref (a worktree that once
//   visited another branch), or all its work landed on the base (a pre-rebase copy).
import { isLanded } from './branches.mjs';
import { gitText, runGit } from './git.mjs';

const MAX_ENTRIES = 200;

/** The reflogs of all local branches in one git call, as Map(name -> commit hashes, newest first); a plan uses this instead of one call per branch. */
export function branchReflogs(repo) {
  const found = new Map();
  for (const line of gitText(repo.dir, ['reflog', 'show', '--all', '--format=%gD%x00%H']).split('\n')) {
    const [selector, hash] = line.split('\0');
    const name = selector?.startsWith('refs/heads/') ? selector.slice('refs/heads/'.length).replace(/@\{\d+\}$/, '') : null;
    if (name !== null) found.set(name, [...(found.get(name) ?? []), hash]);
  }
  return found;
}

/**
 * Looks at the reflogs given as `[{ cwd, ref, hashes? }]` (a branch reflog from the repo folder, a worktree's `HEAD` from
 * its own folder; `hashes` when already read, e.g. by branchReflogs). `removedBranch` is the branch about to go: its own ref does not make a commit safe. Returns `{ count, truncated, unreadable }`:
 * how many distinct commits are not reachable from the base or from any other ref (branch, tag, remote-tracking) and not landed on the base,
 * whether a reflog has more than 200 entries, and whether one could not be read. Any of them non-zero means keep.
 */
export function reflogOnlyCommits(repo, reflogs, removedBranch) {
  const commits = new Set();
  const outcome = { count: 0, truncated: false, unreadable: false };
  for (const { cwd, ref, hashes: known } of reflogs) {
    const result = known ? null : runGit(cwd, ['reflog', 'show', '--format=%H', '-n', String(MAX_ENTRIES + 1), ref]);
    if (result && result.status !== 0) outcome.unreadable = true;
    const hashes = known ?? result.stdout.split('\n').filter((line) => line !== '');
    if (hashes.length > MAX_ENTRIES) outcome.truncated = true;
    hashes.forEach((hash) => commits.add(hash));
  }
  const all = [...commits];
  if (all.length === 0) return outcome;
  // Commits the walk still reaches are on no other ref and not on the base; an unreadable walk (a missing object) distrusts all.
  const walk = runGit(repo.dir, ['rev-list', ...all, '--not', `--exclude=refs/heads/${removedBranch}`, '--all', repo.baseRef]);
  const reachableOnlyHere = walk.status === 0 ? new Set(walk.stdout.split('\n')) : new Set(all);
  outcome.count = all.filter((hash) => reachableOnlyHere.has(hash) && !isLanded(repo, hash)).length;
  return outcome;
}
