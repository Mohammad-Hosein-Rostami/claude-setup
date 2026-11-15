// Purpose: `git-tidy prune`: remove the worktrees and branches whose work is already on the base, and nothing else.
// Exports: pruneRepo.
// Invariants: the only writes are `git worktree prune`, `git worktree remove` (never --force) and `git branch -D`, and only
//   with apply. Before EACH removal the facts are read again from git (worktree list, branch state, dirty status), so
//   what was true when the candidates were found is never trusted. Anything not proven is kept, with the reason.
//   Order: stale entries, then worktrees, then branches (a branch is free once its worktree is gone).
import { branchState, isMerged } from './branches.mjs';
import { UsageError, runGit } from './git.mjs';
import { findLeftovers } from './leftovers.mjs';
import { changedFileCount, currentBranch, inProgressOperation, listWorktrees, samePath } from './repo.mjs';

const item = (action, kind, subject, detail) => ({ action, kind, subject, detail });

/** Why a branch must never be removed whatever its state, or null. */
function protectedReason(repo, name, worktrees) {
  if (name === repo.base) return 'it is the base branch';
  if (name === currentBranch(repo)) return 'it is the current branch';
  const [main] = worktrees;
  if (main && !main.bare && main.branch === name) return 'it is checked out in the main worktree';
  return null;
}

/** Re-reads one linked worktree and decides. Returns `{ remove: true }` or `{ remove: false, reason }`. */
function worktreeVerdict(repo, candidate) {
  const worktrees = listWorktrees(repo);
  const tree = worktrees.find((entry) => entry.path === candidate.path && !entry.main);
  const keep = (reason) => ({ remove: false, reason });
  if (!tree) return keep('no longer a linked worktree');
  if (tree.missing) return keep('its folder is gone (stale, not merged)');
  if (tree.locked) return keep('locked; unlock it with `git worktree unlock` first');
  if (tree.branch === null) return keep('detached HEAD');
  if (repo.topLevel !== null && samePath(tree.path, repo.topLevel)) return keep('the command runs from this folder');
  const protection = protectedReason(repo, tree.branch, worktrees);
  if (protection) return keep(protection);
  const state = branchState(repo, tree.branch);
  if (!isMerged(state.state)) return keep(`branch ${tree.branch} is not on ${repo.base} (${state.ahead} commits ahead)`);
  const operation = inProgressOperation(tree.path);
  if (operation !== null) return keep(`a ${operation} is not finished there`);
  const changed = changedFileCount(tree.path);
  if (changed === null) return keep('git status failed there, treated as dirty');
  if (changed > 0) return keep(`${changed} uncommitted or untracked files`);
  return { remove: true };
}

/** Re-reads one branch and decides; `gone` holds worktree paths a dry run assumes are already removed. */
function branchVerdict(repo, name, gone) {
  const worktrees = listWorktrees(repo);
  const keep = (reason) => ({ remove: false, reason });
  const protection = protectedReason(repo, name, worktrees);
  if (protection) return keep(protection);
  const state = branchState(repo, name);
  if (state.state === 'missing') return keep('it is already gone');
  if (!isMerged(state.state)) return keep(`${state.ahead} commits are not on ${repo.base}`);
  const holder = worktrees.find((entry) => entry.branch === name && !gone.has(entry.path));
  if (holder) return keep(`checked out in ${holder.path}`);
  return { remove: true, tip: state.tip, state: state.state };
}

function pruneStale(repo, candidates, apply, gone) {
  const items = [];
  const removable = [];
  for (const candidate of candidates) {
    const tree = listWorktrees(repo).find((entry) => entry.path === candidate.path && !entry.main);
    if (!tree) continue;
    if (!tree.missing) items.push(item('keep', 'stale-worktree', tree.path, 'its folder is back'));
    else if (tree.locked) items.push(item('keep', 'stale-worktree', tree.path, 'locked; unlock it with `git worktree unlock` first'));
    else removable.push(tree.path);
  }
  if (apply && removable.length > 0) runGit(repo.dir, ['worktree', 'prune']);
  const stillListed = new Set(listWorktrees(repo).map((entry) => entry.path));
  for (const path of removable) {
    if (!apply) {
      gone.add(path); // a plan must predict that its branch becomes free once the entry is pruned
      items.push(item('remove', 'stale-worktree', path, 'folder missing'));
    }
    else if (stillListed.has(path)) items.push(item('failed', 'stale-worktree', path, 'git worktree prune left it listed'));
    else items.push(item('removed', 'stale-worktree', path, 'folder missing'));
  }
  return items;
}

function pruneWorktree(repo, candidate, apply, gone) {
  const verdict = worktreeVerdict(repo, candidate);
  const detail = `branch ${candidate.branch}`;
  if (!verdict.remove) return item('keep', 'merged-worktree', candidate.path, verdict.reason);
  if (!apply) {
    gone.add(candidate.path);
    return item('remove', 'merged-worktree', candidate.path, detail);
  }
  const result = runGit(repo.dir, ['worktree', 'remove', '--', candidate.path]);
  return result.status === 0 ? item('removed', 'merged-worktree', candidate.path, detail) : item('failed', 'merged-worktree', candidate.path, result.stderr);
}

function pruneBranch(repo, candidate, apply, gone) {
  const verdict = branchVerdict(repo, candidate.name, gone);
  if (!verdict.remove) return item('keep', 'merged-branch', candidate.name, verdict.reason);
  if (!apply) return item('remove', 'merged-branch', candidate.name, `${candidate.short} ${verdict.state}`);
  const result = runGit(repo.dir, ['branch', '-D', '--', candidate.name]);
  return result.status === 0 ? item('deleted', 'merged-branch', candidate.name, `was ${verdict.tip}`) : item('failed', 'merged-branch', candidate.name, result.stderr);
}

function detachedWorktrees(repo) {
  return listWorktrees(repo).filter((tree) => !tree.main && !tree.missing && tree.detached)
    .map((tree) => item('keep', 'detached-worktree', tree.path, 'detached HEAD, not touched'));
}

function refuseWhileUnfinished(repo) {
  for (const tree of listWorktrees(repo).filter((entry) => !entry.missing && !entry.bare)) {
    const operation = inProgressOperation(tree.path);
    if (operation !== null) throw new UsageError(`a ${operation} is not finished in ${tree.path}; finish or abort it before --apply`);
  }
}

/**
 * Plans (apply false) or performs (apply true) the removal of stale and merged worktrees and merged branches.
 * `leftovers` are the candidates (from findLeftovers); each is re-checked right before it is acted on, so candidates
 * found earlier may be out of date. Returns items `{ action, kind, subject, detail }` with action `remove`/`keep` for a
 * plan and `removed`/`deleted`/`kept`/`failed` for an apply. Throws UsageError when apply meets an unfinished operation.
 */
export function pruneRepo(repo, { apply, leftovers = findLeftovers(repo) }) {
  if (apply) refuseWhileUnfinished(repo);
  const gone = new Set();
  const items = pruneStale(repo, leftovers.staleWorktrees, apply, gone);
  for (const candidate of leftovers.mergedWorktrees) items.push(pruneWorktree(repo, candidate, apply, gone));
  for (const candidate of leftovers.mergedBranches) items.push(pruneBranch(repo, candidate, apply, gone));
  items.push(...detachedWorktrees(repo));
  return apply ? items.map((entry) => (entry.action === 'keep' ? { ...entry, action: 'kept' } : entry)) : items;
}
