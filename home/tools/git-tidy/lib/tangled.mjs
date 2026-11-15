// Purpose: find the local branches and tags from which a merge commit is still reachable that no remote has: they keep tangled
//   history visible in `git log --graph --all` even when the base is a straight line.
// Exports: tangledRefs.
// Invariants: reads only. "Not on a remote" means not reachable from any remote-tracking ref, or from the base when the
//   repository has no remote-tracking refs at all. Costs one git call per such merge commit, not per ref.
import { gitText } from './git.mjs';

/**
 * Returns `{ ref, count, newest }` for each branch or tag (full ref names, `skip` excluded) that reaches `count` such merge
 * commits; `newest` is the short hash of the newest one.
 */
export function tangledRefs(repo, skip) {
  const hasRemotes = gitText(repo.dir, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']) !== '';
  const stop = hasRemotes ? ['--remotes'] : [repo.baseRef];
  const log = gitText(repo.dir, ['log', '--merges', '--format=%H%x00%h', '--branches', '--tags', '--not', ...stop]);
  const found = new Map();
  for (const line of log === '' ? [] : log.split('\n')) {
    const [hash, short] = line.split('\0');
    const holders = gitText(repo.dir, ['for-each-ref', `--contains=${hash}`, '--format=%(refname)', 'refs/heads', 'refs/tags']);
    for (const ref of holders === '' ? [] : holders.split('\n')) {
      if (skip.has(ref)) continue;
      const entry = found.get(ref) ?? { ref, count: 0, newest: short }; // the log is newest first
      entry.count += 1;
      found.set(ref, entry);
    }
  }
  return [...found.values()];
}
