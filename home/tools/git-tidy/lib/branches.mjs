// Purpose: decide whether a local branch (or any commit) is already on the base, and how many commits it still has that are not.
// Exports: ancestorBranches, branchState, changesOnBase, compareBranch, compareWithBase, contentOnBase,
//   contentProofUnsupported, withContentState, isLanded, isMerged, landedAt, mergeChangesNothing, CONTENT_EQUAL.
// Invariants: only `ancestor`, `patch-equal` and `content-equal` mean "merged"; anything that cannot be proven is `unmerged`
//   (fail closed). `content-equal` is the one content proof for every other branch: merging it into the base changes nothing
//   (`git merge-tree --write-tree` prints the base's own tree), so all its content is on the base already (a squash or a
//   rewritten fold that landed as it is). History (reflogs, patch ids) never makes a branch merged on its own.
//   A merge runs the repository's merge drivers and attributes (`merge=ours`, `union`), which can drop the branch's change and
//   still give the base's tree; so every merge proof also needs changesOnBase, which compares blobs and merges nothing.
//   `patch-equal` needs two proofs: no non-merge commit has an unequal patch (`git cherry` logic), and merging the branch into
//   the base must change nothing (`git merge-tree --write-tree` prints the base's own tree). The second one matters because
//   patch ids ignore whitespace and skip merge commits, so a hand-made change in a merge would go unseen by the first.
//   A proof is about the tip commit that was read, never a ref read again later. One git call per branch (a batch call for
//   all ancestors first), plus two for each branch a merge proves, so 300 branches stay fast.
//   landedAt only names a base commit for a label; no deletion and no state uses it.
import { gitText, runGit } from './git.mjs';

const HEADS = 'refs/heads/';
/** The state of a branch whose commits differ from the base's but whose content is all on the base. */
export const CONTENT_EQUAL = 'content-equal';
// Options of the content proof: names only for conflicts, no messages, and a branch with no history in common still merges,
// so an orphan branch does not abort the batch (changesOnBase never proves an orphan: it has no merge base).
const CONTENT_MERGE = ['merge-tree', '--stdin', '--name-only', '--no-messages', '--allow-unrelated-histories'];
const MIN_GIT = { major: 2, minor: 40 }; // the first git whose merge-tree reads --stdin
const GIT_VERSION = /^git version (\d+)\.(\d+)/;

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

// The base's tree is read once per run. A base that moves meanwhile can make a stale tree match, so changesOnBase (which reads
// the base again) must hold too, and prune pins the base to one commit before it removes anything.
const baseTrees = new WeakMap();
// Per repo: Map(tip -> whether mergeChangesNothing holds for it), so branches that share a tip are proven once.
const mergeProofs = new WeakMap();
// The second content proof: plumbing diff-tree runs no merge driver, attribute or textconv; the explicit flags keep the
// user's diff config (renames, ignored submodules) out of it.
const CHANGED_PATHS = ['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--ignore-submodules=none'];

// The base's tree, '' when git cannot read it (no proof then).
function baseTreeOf(repo) {
  if (!baseTrees.has(repo)) baseTrees.set(repo, runGit(repo.dir, ['rev-parse', `${repo.baseRef}^{tree}`]).stdout.trim());
  return baseTrees.get(repo);
}

// The paths diff-tree lists for `args` (two commits, or `--merge-base` and two commits), or null when git cannot say.
function changedPaths(repo, args) {
  const result = runGit(repo.dir, [...CHANGED_PATHS, ...args, '--']);
  return result.status === 0 ? result.stdout.split('\0').filter((path) => path !== '') : null;
}

/**
 * True when every path `commit` changed since its merge base with the base has the same mode and blob on the base as on
 * `commit`: all the branch's own changes are on the base. It merges nothing, so no merge driver or attribute can make it pass.
 * No merge base (an orphan branch) or more than one (criss-cross merges) proves nothing; so does a git error.
 */
export function changesOnBase(repo, commit) {
  const changed = changedPaths(repo, ['--merge-base', repo.baseRef, commit]);
  const differs = changedPaths(repo, [repo.baseRef, commit]);
  if (changed === null || differs === null) return false;
  const differing = new Set(differs);
  return !changed.some((path) => differing.has(path));
}

/**
 * True when merging `commit` into the base would change nothing (exact content, where patch ids ignore whitespace) and
 * changesOnBase holds (no merge driver made the merge pass). Each commit is proven once per repo object.
 */
export function mergeChangesNothing(repo, commit) {
  if (!mergeProofs.has(repo)) mergeProofs.set(repo, new Map());
  const proofs = mergeProofs.get(repo);
  if (!proofs.has(commit)) {
    const merged = runGit(repo.dir, ['merge-tree', '--write-tree', repo.baseRef, commit]);
    const baseTree = baseTreeOf(repo);
    const isBaseTree = merged.status === 0 && baseTree !== '' && merged.stdout.split('\n')[0].trim() === baseTree;
    proofs.set(commit, isBaseTree && changesOnBase(repo, commit));
  }
  return proofs.get(commit);
}

/**
 * The refs of `refs` (full refs or commit hashes) whose merge into the base changes nothing: a clean merge whose tree is the
 * base's own, and changesOnBase holds. One `git merge-tree --stdin` call for all of them, then changesOnBase for each one the
 * merge proved; when git cannot complete the merges (a ref that went away, a broken object) no ref is proven (fail closed).
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
    if (clean === '1' && tree === baseTree && changesOnBase(repo, ref)) proven.add(ref);
  }
  return proven;
}

/**
 * Null when the git in `dir` can run the content proof (`git merge-tree --stdin`, git 2.40 or newer), else why not. An older
 * git only makes contentOnBase prove nothing (safe); land's sweep asks first so it can say so instead.
 */
export function contentProofUnsupported(dir) {
  const version = runGit(dir, ['version']).stdout.trim();
  const [, major, minor] = (GIT_VERSION.exec(version) ?? []).map(Number);
  const isNewEnough = major > MIN_GIT.major || (major === MIN_GIT.major && minor >= MIN_GIT.minor);
  return isNewEnough ? null : `${version || 'an unknown git'} is older than ${MIN_GIT.major}.${MIN_GIT.minor}, which the content proof needs (git merge-tree --stdin)`;
}

/**
 * `states` (`[{ name, state, tip, ... }]`) with each `unmerged` branch whose tip's content is on the base (contentOnBase) as
 * `content-equal`. The tip that was read is proven, not the branch read again, so the proof is about the commit a caller deletes.
 */
export function withContentState(repo, states) {
  const isCandidate = ({ state, tip }) => state === 'unmerged' && tip !== null;
  const onBase = contentOnBase(repo, states.filter(isCandidate).map(({ tip }) => tip));
  return states.map((entry) => (isCandidate(entry) && onBase.has(entry.tip) ? { ...entry, state: CONTENT_EQUAL, ahead: 0 } : entry));
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
  if (patchesLanded && mergeChangesNothing(repo, tip)) return { state: 'patch-equal', tip, ahead: 0 };
  const unequal = commits.filter((commit) => !commit.isMerge && !commit.equal).length;
  return { state: 'unmerged', tip, ahead: unequal > 0 ? unequal : commits.length };
}

/**
 * The full hash of a base commit where all of `ref`'s content is proven, else null. Why: a fold that landed as patches and that
 * the base changed later is neither merged nor plainly unlanded, so land's `left:` names that commit for a person to look at.
 * Patch ids leave out line numbers, so a pairing alone proves nothing (the same line added at another place pairs too): the
 * commit is the newest base commit a patch of `ref` pairs with, and mergeChangesNothing must hold with it as the base.
 * @param repo the repository from openRepo
 * @param ref a full ref or a commit hash
 * @returns the base commit's full hash; null when `ref` has no commit the base lacks, holds a merge, has a commit with no
 *   equal patch on the base, or fails the content proof there, and on any git error
 */
export function landedAt(repo, ref) {
  const range = `${repo.baseRef}...${ref}`;
  const own = runGit(repo.dir, ['rev-list', '--right-only', '--cherry-mark', '--parents', range]);
  const commits = own.stdout.split('\n').filter((line) => line !== '');
  const isPairedNonMerge = (line) => line[0] === '=' && line.split(' ').length <= 2; // a mark and hash, then at most one parent
  if (own.status !== 0 || commits.length === 0 || !commits.every(isPairedNonMerge)) return null;
  const based = runGit(repo.dir, ['rev-list', '--left-only', '--cherry-mark', '--topo-order', range]);
  const newestPaired = based.status === 0 ? based.stdout.split('\n').find((line) => line[0] === '=') : undefined;
  if (newestPaired === undefined) return null;
  const pairedBase = newestPaired.slice(1);
  return mergeChangesNothing({ ...repo, baseRef: pairedBase }, ref) ? pairedBase : null;
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

/** True when `commit` (any hash) is on the base, or its content is all there (contentOnBase). */
export function isLanded(repo, commit) {
  if (runGit(repo.dir, ['merge-base', '--is-ancestor', commit, repo.baseRef]).status === 0) return true;
  return contentOnBase(repo, [commit]).has(commit);
}

/** True for the three states that mean the branch's work is on the base. */
export const isMerged = (state) => state === 'ancestor' || state === 'patch-equal' || state === CONTENT_EQUAL;
