// Purpose: decide whether a local branch (or any commit) is already on the base, and how many commits it still has that are not.
// Exports: ancestorBranches, branchState, compareWithBase, isLanded, isMerged, mergeChangesNothing.
// Invariants: only `ancestor` and `patch-equal` mean "merged"; anything that cannot be proven is `unmerged` (fail closed).
//   `patch-equal` needs two proofs: no non-merge commit has an unequal patch (`git cherry` logic), and merging the branch into
//   the base must change nothing (`git merge-tree --write-tree` prints the base's own tree). The second one matters because
//   patch ids ignore whitespace and skip merge commits, so a hand-made change in a merge would go unseen by the first.
//   One git call per branch (a batch call for all ancestors first), so 300 branches stay fast.
import { gitText, runGit } from './git.mjs';

const HEADS = 'refs/heads/';

/**
 * Local branches whose tip is already on the base, as Map(name -> full tip hash), in one git call. With `name` only
 * that branch is looked up (the map is empty when it is not an ancestor).
 */
export function ancestorBranches(repo, name = null) {
  const pattern = name === null ? 'refs/heads' : `${HEADS}${name}`;
  const listed = gitText(repo.dir, ['for-each-ref', `--merged=${repo.baseRef}`, '--format=%(refname)%00%(objectname)', pattern]);
  const found = new Map();
  for (const line of listed.split('\n')) {
    const [ref, tip] = line.split('\0');
    if (ref?.startsWith(HEADS)) found.set(ref.slice(HEADS.length), tip);
  }
  return found;
}

// The base's tree is read once per run; if the base moves meanwhile the comparison fails, which keeps the branch (safe).
const baseTrees = new WeakMap();

// True when merging `ref` into the base would change nothing: exact content, where patch ids ignore whitespace.
export function mergeChangesNothing(repo, ref) {
  const merged = runGit(repo.dir, ['merge-tree', '--write-tree', repo.baseRef, ref]);
  if (!baseTrees.has(repo)) baseTrees.set(repo, runGit(repo.dir, ['rev-parse', `${repo.baseRef}^{tree}`]).stdout.trim());
  const baseTree = baseTrees.get(repo);
  return merged.status === 0 && baseTree !== '' && merged.stdout.split('\n')[0].trim() === baseTree;
}

// Commits of `ref` the base lacks, newest first, each marked `=` (an equal patch is on the base) or `+`, with parents.
/** Compares `ref` (a full ref or a commit hash) with the base: `{ state, tip, ahead }` as for branchState, when it is not an ancestor. */
export function compareWithBase(repo, ref) {
  const result = runGit(repo.dir, ['rev-list', '--right-only', '--cherry-mark', '--parents', '--topo-order', `${repo.baseRef}...${ref}`]);
  if (result.status !== 0) {
    const exists = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
    return { state: exists ? 'unmerged' : 'missing', tip: null, ahead: 0 };
  }
  const commits = result.stdout.split('\n').filter((line) => line !== '').map((line) => {
    const [hash, ...parents] = line.slice(1).split(' ');
    return { hash, equal: line[0] === '=', isMerge: parents.length > 1 };
  });
  const tip = commits[0]?.hash ?? null; // topological order: the tip comes before all of its ancestors
  const patchesLanded = commits.length > 0 && commits.filter((commit) => !commit.isMerge).every((commit) => commit.equal);
  if (patchesLanded && mergeChangesNothing(repo, ref)) return { state: 'patch-equal', tip, ahead: 0 };
  const unequal = commits.filter((commit) => !commit.isMerge && !commit.equal).length;
  return { state: 'unmerged', tip, ahead: unequal > 0 ? unequal : commits.length };
}

/**
 * Compares local branch `name` with the base. Returns `{ state, tip, ahead }`: state is `ancestor` (tip is on the base),
 * `patch-equal` (every commit has an equal patch on the base: a rebase or cherry-pick that landed), `unmerged` (ahead =
 * commits the base lacks) or `missing`. `ancestors` may carry the result of ancestorBranches(repo) to save a call.
 */
export function branchState(repo, name, ancestors = ancestorBranches(repo, name)) {
  const tip = ancestors.get(name);
  if (tip !== undefined) return { state: 'ancestor', tip, ahead: 0 };
  return compareWithBase(repo, `${HEADS}${name}`);
}

/** True when `commit` (any hash) is on the base, or all its commits landed there with the same content (a pre-rebase copy). */
export function isLanded(repo, commit) {
  if (runGit(repo.dir, ['merge-base', '--is-ancestor', commit, repo.baseRef]).status === 0) return true;
  return compareWithBase(repo, commit).state === 'patch-equal';
}

/** True for the two states that mean the branch's work is on the base. */
export const isMerged = (state) => state === 'ancestor' || state === 'patch-equal';
