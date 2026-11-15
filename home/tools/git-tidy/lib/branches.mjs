// Purpose: decide whether a local branch is already on the base, and how many commits it still has that are not.
// Exports: ancestorBranches, branchState, isMerged.
// Invariants: only `ancestor` and `patch-equal` mean "merged"; anything that cannot be proven is `unmerged` (fail closed).
//   A branch holding a merge commit is never `patch-equal`: patch ids skip merge commits, so hand-made changes in one
//   would go unseen. One git call per branch (a batch call for all ancestors first), so 300 branches stay fast.
import { runGit } from './git.mjs';

const HEADS = 'refs/heads/';

/**
 * Local branches whose tip is already on the base, as Map(name -> full tip hash), in one git call. With `name` only
 * that branch is looked up (the map is empty when it is not an ancestor).
 */
export function ancestorBranches(repo, name = null) {
  const pattern = name === null ? 'refs/heads' : `${HEADS}${name}`;
  const result = runGit(repo.dir, ['for-each-ref', `--merged=${repo.baseRef}`, '--format=%(refname)%00%(objectname)', pattern]);
  const found = new Map();
  for (const line of result.status === 0 ? result.stdout.split('\n') : []) {
    const [ref, tip] = line.split('\0');
    if (ref?.startsWith(HEADS)) found.set(ref.slice(HEADS.length), tip);
  }
  return found;
}

// Commits of the branch the base lacks, newest first, each marked `=` (an equal patch is on the base) or `+`, with parents.
function compareWithBase(repo, name) {
  const ref = `${HEADS}${name}`;
  const result = runGit(repo.dir, ['rev-list', '--right-only', '--cherry-mark', '--parents', '--topo-order', `${repo.baseRef}...${ref}`]);
  if (result.status !== 0) {
    const exists = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', ref]).status === 0;
    return exists ? { state: 'unmerged', tip: null, ahead: 0 } : { state: 'missing', tip: null, ahead: 0 };
  }
  const commits = result.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [hash, ...parents] = line.slice(1).split(' ');
    return { hash, equal: line[0] === '=', isMerge: parents.length > 1 };
  });
  const tip = commits[0]?.hash ?? null; // topological order: the tip comes before all of its ancestors
  const proven = commits.length > 0 && commits.every((commit) => commit.equal && !commit.isMerge);
  if (proven) return { state: 'patch-equal', tip, ahead: 0 };
  const hasMerge = commits.some((commit) => commit.isMerge);
  return { state: 'unmerged', tip, ahead: hasMerge ? commits.length : commits.filter((commit) => !commit.equal).length };
}

/**
 * Compares local branch `name` with the base. Returns `{ state, tip, ahead }`: state is `ancestor` (tip is on the base),
 * `patch-equal` (every commit has an equal patch on the base: a rebase or cherry-pick that landed), `unmerged` (ahead =
 * commits the base lacks) or `missing`. `ancestors` may carry the result of ancestorBranches(repo) to save a call.
 */
export function branchState(repo, name, ancestors = ancestorBranches(repo, name)) {
  const tip = ancestors.get(name);
  if (tip !== undefined) return { state: 'ancestor', tip, ahead: 0 };
  return compareWithBase(repo, name);
}

/** True for the two states that mean the branch's work is on the base. */
export const isMerged = (state) => state === 'ancestor' || state === 'patch-equal';
