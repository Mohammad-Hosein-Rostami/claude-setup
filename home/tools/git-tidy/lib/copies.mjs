// Purpose: find branches that only repeat work another branch holds: older copies of a re-done lane (`X`, `X-2`, `X-fixes`,
//   or any branches with the same tip) and the leftover branch a workflow agent's worktree started on. `check` reports them,
//   `prune` removes them.
// Exports: copyFindings, copyCandidates, isStillCopy, isAgentBranch, patchIdsOf, commitDates, familyStem.
// Invariants: reads only. A branch is a `superseded-copy` of B only when its tip is an ancestor of B or every `git patch-id --verbatim`
//   of `base..branch` is in `base..B` and merging the branch into B changes nothing (a branch with a merge commit only by the ancestor
//   proof, since patch ids skip merges), and B is not itself a copy. Between branches that cover each other the newest committer date stays (then the one checked out in a worktree,
//   then the name). Only branches in one family are compared (same name stem, or same tip), so cost stays linear in branches.
//   An `agent-leftover` is a `worktree-agent-*` or `worktree-wf_*` (workflow agent) branch whose every commit is on the base or on a branch that is not an agent
//   branch, and that no existing worktree has checked out.
import { mergeChangesNothing } from './branches.mjs';
import { gitText, runGit } from './git.mjs';
import { findLeftovers } from './leftovers.mjs';
import { listWorktrees } from './repo.mjs';

const HEADS = 'refs/heads/';
// a subagent's worktree branch, and a workflow agent's (`worktree-wf_<run>-<n>`)
const AGENT_BRANCH_PREFIXES = ['worktree-agent-', 'worktree-wf_'];
// `-2`, `-fix`, `-fixes`, `-v3`, `-redo` at the end of a name; the lookbehind keeps a name that is only a suffix whole
const FAMILY_SUFFIX = /(?<=.)-(?:\d+|fix|fixes|v\d+|redo)$/;
// Off: user config such as diff.external or a textconv filter would run a program while the patch is read.
const PLAIN_DIFF = ['--no-ext-diff', '--no-textconv', '--no-show-signature', '--no-color'];

/** True for the branch an agent's isolated worktree started on (`worktree-agent-<id>` or `worktree-wf_<run>-<n>`). */
export const isAgentBranch = (name) => AGENT_BRANCH_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The name without its re-do suffixes: `r2/cell-roll-pin-3` and `r2/cell-roll-pin-fixes` both give `r2/cell-roll-pin`. */
export function familyStem(name) {
  let stem = name;
  while (FAMILY_SUFFIX.test(stem)) stem = stem.replace(FAMILY_SUFFIX, '');
  return stem;
}

/** Patch ids (`git patch-id --verbatim`, so a whitespace change makes a different patch) of the non-merge commits of `ref` that the base lacks, one per commit that changes something. */
export function patchIdsOf(repo, ref) {
  const log = runGit(repo.dir, ['log', '-p', '--no-merges', ...PLAIN_DIFF, `^${repo.baseRef}`, ref, '--']);
  if (log.status !== 0) throw new Error(`git log failed for ${ref}: ${log.stderr.split('\n')[0]}`);
  const ids = runGit(repo.dir, ['patch-id', '--verbatim'], log.stdout);
  if (ids.status !== 0) throw new Error(`git patch-id failed for ${ref}: ${ids.stderr.split('\n')[0]}`);
  return ids.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ')[0]);
}

const hasMerges = (repo, ref) => gitText(repo.dir, ['rev-list', '--merges', '-n', '1', `^${repo.baseRef}`, ref, '--']) !== '';

/** Map(branch name -> committer date of its tip in unix seconds), for every local branch, in one git call. */
export function commitDates(repo) {
  const listed = gitText(repo.dir, ['for-each-ref', '--format=%(refname)%00%(committerdate:unix)', 'refs/heads']);
  return new Map(listed.split('\n').filter((line) => line !== '').map((line) => line.split('\0')).map(([ref, seconds]) => [ref.slice(HEADS.length), Number(seconds)]));
}

// Groups of two or more branches with the same name stem or the same tip.
function familiesOf(branches) {
  const parent = new Map(branches.map(({ name }) => [name, name]));
  const root = (name) => (parent.get(name) === name ? name : root(parent.get(name)));
  const join = (a, b) => parent.set(root(a), root(b));
  const firstWith = { stem: new Map(), tip: new Map() };
  for (const { name, tip } of branches) {
    for (const [kind, key] of [['stem', familyStem(name)], ['tip', tip]]) {
      if (firstWith[kind].has(key)) join(name, firstWith[kind].get(key));
      else firstWith[kind].set(key, name);
    }
  }
  const groups = new Map();
  for (const branch of branches) groups.set(root(branch.name), [...(groups.get(root(branch.name)) ?? []), branch]);
  return [...groups.values()].filter((group) => group.length > 1);
}

// What is needed to ask "does B hold all the work of A": patch ids, the branches B contains, and whether A has merge commits.
function proofFacts(repo, branch) {
  const ref = `${HEADS}${branch.name}`;
  const contained = gitText(repo.dir, ['for-each-ref', `--merged=${ref}`, '--format=%(refname)', 'refs/heads']);
  return { ...branch, ref, patches: new Set(patchIdsOf(repo, ref)), contains: new Set(contained.split('\n').map((name) => name.slice(HEADS.length))) };
}

/** True when `holder` has all the work of `copy`; both are proofFacts. */
function covers(repo, holder, copy) {
  if (holder.contains.has(copy.name)) return true;
  if (copy.patches.size === 0 || ![...copy.patches].every((id) => holder.patches.has(id))) return false;
  copy.merges ??= hasMerges(repo, copy.ref);
  return !copy.merges && mergeChangesNothing({ ...repo, baseRef: holder.ref }, copy.ref);
}

function supersededIn(repo, family, dates, checkedOut) {
  const rankOf = (a, b) => (dates.get(b.name) - dates.get(a.name)) || (checkedOut.has(b.name) - checkedOut.has(a.name)) || (a.name < b.name ? -1 : 1);
  // Branches with one tip repeat each other without any proof to read: the best ranked of them speaks for the group.
  const groups = new Map();
  for (const branch of family) groups.set(branch.tip, [...(groups.get(branch.tip) ?? []), branch].sort(rankOf));
  const speakers = [...groups.values()].map((group) => group[0]).sort(rankOf);
  const kept = new Set(speakers.map(({ name }) => name));
  const holderOf = new Map(speakers.map(({ name }) => [name, name]));
  if (speakers.length > 1) {
    const members = speakers.map((branch) => proofFacts(repo, branch));
    const rank = new Map(members.map(({ name }, index) => [name, index]));
    const copies = members.filter((copy) => members.some((holder) => holder !== copy && covers(repo, holder, copy)
      && (!covers(repo, copy, holder) || rank.get(holder.name) < rank.get(copy.name))));
    for (const copy of copies) kept.delete(copy.name);
    for (const copy of copies) holderOf.set(copy.name, members.find((holder) => kept.has(holder.name) && covers(repo, holder, copy)).name);
  }
  return family.filter(({ name }) => !kept.has(name))
    .map((copy) => ({ kind: 'superseded-copy', name: copy.name, tip: copy.tip, by: holderOf.get(groups.get(copy.tip)[0].name) }));
}

// An agent branch has no commit of its own when every commit is on the base or on a branch that is not an agent branch.
function ownCommitFree(repo, name) {
  const otherAgents = AGENT_BRANCH_PREFIXES.map((prefix) => `--exclude=${prefix}*`);
  const walk = runGit(repo.dir, ['rev-list', '-n', '1', `${HEADS}${name}`, '--not', ...otherAgents, '--branches']);
  return walk.status === 0 && walk.stdout.trim() === '';
}

const checkedOutNames = (repo) => new Set(listWorktrees(repo).filter((tree) => !tree.missing && tree.branch !== null).map((tree) => tree.branch));

const isAgentLeftover = (repo, name, checkedOut) => isAgentBranch(name) && !checkedOut.has(name) && ownCommitFree(repo, name);

/**
 * The copies in the repository as candidates `{ kind, name, tip, by }` (`by` is the branch that holds the work, null for an
 * agent-leftover). `leftovers` may carry findLeftovers(repo) to save a read.
 */
export function copyCandidates(repo, leftovers = findLeftovers(repo)) {
  const states = leftovers.states ?? []; // candidates handed in by a caller may name no branch states: then there are no copies to find
  const checkedOut = checkedOutNames(repo);
  const agents = states.filter(({ name }) => isAgentLeftover(repo, name, checkedOut))
    .map(({ name, tip }) => ({ kind: 'agent-leftover', name, tip, by: null }));
  const dates = commitDates(repo);
  const lanes = states.filter(({ state, name }) => state === 'unmerged' && !isAgentBranch(name));
  return [...agents, ...familiesOf(lanes).flatMap((family) => supersededIn(repo, family, dates, checkedOut))];
}

/** True when `candidate` (from copyCandidates) is still a copy right now: its branch has not moved and the branch that holds its work still does. */
export function isStillCopy(repo, candidate) {
  const current = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${candidate.name}`]);
  if (current.status !== 0 || current.stdout.trim() !== candidate.tip) return false;
  if (candidate.kind === 'agent-leftover') return isAgentLeftover(repo, candidate.name, checkedOutNames(repo));
  const [holder, copy] = [candidate.by, candidate.name].map((name) => {
    const tip = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${HEADS}${name}`]).stdout.trim();
    return tip === '' ? null : proofFacts(repo, { name, tip });
  });
  return holder !== null && covers(repo, holder, copy);
}

/** `check` findings `{ kind, subject, detail }` for every copy: `superseded-copy` (older copy of a branch that holds all its work) and `agent-leftover`. */
export function copyFindings(repo, leftovers = findLeftovers(repo)) {
  const worktrees = listWorktrees(repo);
  return copyCandidates(repo, leftovers).map(({ kind, name, tip, by }) => {
    const folder = worktrees.find((tree) => tree.branch === name && !tree.missing && !tree.main)?.path;
    const where = folder ? `; its worktree ${folder} goes with it` : '';
    const detail = kind === 'agent-leftover'
      ? `${tip.slice(0, 7)} no commit of its own, no worktree on it: delete it with git branch -d ${name}`
      : `${tip.slice(0, 7)} all its work is in ${by}${where}`;
    return { kind, subject: name, detail };
  });
}
