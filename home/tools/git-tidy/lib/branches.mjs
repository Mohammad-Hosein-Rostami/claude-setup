// Purpose: decide whether a local branch (or any commit) is already on the base, and how many commits it still has that are not.
// Exports: ancestorBranches, branchState, compareBranch, compareWithBase, contentOnBase, withContentState, isLanded, isMerged,
//   mergeChangesNothing, CONTENT_EQUAL.
// Invariants: only `ancestor`, `patch-equal` and `content-equal` mean "merged"; anything that cannot be proven is `unmerged`
//   (fail closed). `content-equal` is the one content proof for every other branch: merging it into the base changes nothing
//   (`git merge-tree --write-tree` prints the base's own tree), so all its content is on the base already (a squash or a
//   rewritten fold that landed as it is). History (reflogs, patch ids) never makes a branch merged on its own.
//   `patch-equal` needs two proofs: no non-merge commit has an unequal patch (`git cherry` logic), and merging the branch into
//   the base must change nothing (`git merge-tree --write-tree` prints the base's own tree). The second one matters because
//   patch ids ignore whitespace and skip merge commits, so a hand-made change in a merge would go unseen by the first.
//   One git call per branch (a batch call for all ancestors first), so 300 branches stay fast.
import { gitText, runGit } from './git.mjs';

const HEADS = 'refs/heads/';
/** The state of a branch whose commits differ from the base's but whose content is all on the base. */
export const CONTENT_EQUAL = 'content-equal';
// Options of the content proof: names only for conflicts, no messages, and a branch with no history in common still merges
// (an orphan branch whose files are all on the base is content-equal; any other one is not).
const CONTENT_MERGE = ['merge-tree', '--stdin', '--name-only', '--no-messages', '--allow-unrelated-histories'];

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

// The base's tree, '' when git cannot read it (no proof then).
function baseTreeOf(repo) {
  if (!baseTrees.has(repo)) baseTrees.set(repo, runGit(repo.dir, ['rev-parse', `${repo.baseRef}^{tree}`]).stdout.trim());
  return baseTrees.get(repo);
}

// True when merging `ref` into the base would change nothing: exact content, where patch ids ignore whitespace.
export function mergeChangesNothing(repo, ref) {
  const merged = runGit(repo.dir, ['merge-tree', '--write-tree', repo.baseRef, ref]);
  const baseTree = baseTreeOf(repo);
  return merged.status === 0 && baseTree !== '' && merged.stdout.split('\n')[0].trim() === baseTree;
}

/**
 * The refs of `refs` (full refs or commit hashes) whose merge into the base changes nothing: a clean merge whose tree is the
 * base's own. One `git merge-tree --stdin` call for all of them; when git cannot complete it (a ref that went away, a broken
 * object) no ref is proven (fail closed).
 */
export function contentOnBase(repo, refs) {
  if (refs.length === 0) return new Set();
  const merged = runGit(repo.dir, CONTENT_MERGE, refs.map((ref) => `${repo.baseRef} ${ref}\n`).join(''));
  const baseTree = baseTreeOf(repo);
  if (merged.status !== 0 || baseTree === '') return new Set();
  // Per merge: `<1 clean | 0 conflict>\0<tree>\0`, the conflicted names each ending in \0, then an empty field.
  const fields = merged.stdout.split('\0');
  const proven = new Set();
  let at = 0;
  for (const ref of refs) {
    const [clean, tree] = [fields[at], fields[at + 1]];
    at += 2;
    while (at < fields.length && fields[at] !== '') at += 1;
    at += 1;
    if (clean === '1' && tree === baseTree) proven.add(ref);
  }
  return proven;
}

/** `states` (`[{ name, state, ... }]`) with each `unmerged` branch whose content is on the base (contentOnBase) as `content-equal`. */
export function withContentState(repo, states) {
  const onBase = contentOnBase(repo, states.filter(({ state }) => state === 'unmerged').map(({ name }) => `${HEADS}${name}`));
  return states.map((entry) => (entry.state === 'unmerged' && onBase.has(`${HEADS}${entry.name}`) ? { ...entry, state: CONTENT_EQUAL, ahead: 0 } : entry));
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
 * Compares local branch `name` with the base by history only. Returns `{ state, tip, ahead }`: state is `ancestor` (tip is on
 * the base), `patch-equal` (every commit has an equal patch on the base and merging changes nothing), `unmerged` (ahead =
 * commits the base lacks) or `missing`. `ancestors` may carry the result of ancestorBranches(repo) to save a call. Many
 * branches at once: compareBranch each, then withContentState once.
 */
export function compareBranch(repo, name, ancestors = ancestorBranches(repo, name)) {
  const tip = ancestors.get(name);
  if (tip !== undefined) return { state: 'ancestor', tip, ahead: 0 };
  return compareWithBase(repo, `${HEADS}${name}`);
}

/**
 * compareBranch, plus the content proof: an `unmerged` branch whose content is all on the base is `content-equal`. Returns
 * `{ name, state, tip, ahead }`.
 */
export function branchState(repo, name, ancestors = ancestorBranches(repo, name)) {
  return withContentState(repo, [{ ...compareBranch(repo, name, ancestors), name }])[0];
}

/** True when `commit` (any hash) is on the base, or merging it into the base changes nothing (its content is all there). */
export function isLanded(repo, commit) {
  if (runGit(repo.dir, ['merge-base', '--is-ancestor', commit, repo.baseRef]).status === 0) return true;
  return contentOnBase(repo, [commit]).has(commit);
}

/** True for the three states that mean the branch's work is on the base. */
export const isMerged = (state) => state === 'ancestor' || state === 'patch-equal' || state === CONTENT_EQUAL;
