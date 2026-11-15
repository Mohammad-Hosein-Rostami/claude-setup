// Purpose: find the branches and worktrees whose work is already on the base. `check` reports them, `prune` removes them.
// Exports: findLeftovers.
// Invariants: the base and the branch checked out in the main worktree are never leftovers; only linked worktrees are
//   (the main worktree is never one); a worktree whose folder is gone is stale, never merged.
import { ancestorBranches, branchState, isMerged } from './branches.mjs';
import { currentBranch, listBranches, listWorktrees } from './repo.mjs';
import { classifyTags } from './tags.mjs';

/**
 * Reads the repository once. Returns `{ states, mergedBranches, mergedWorktrees, staleWorktrees, tags }`: `states` has every
 * local branch except the base as `{ name, short, date, state, tip, ahead }`; `mergedBranches` are those whose work is on the base;
 * `mergedWorktrees` are linked worktrees on one of them (`{ path, branch, ... }`); `staleWorktrees` are linked
 * worktrees whose folder is missing; `tags` are the tags off the base's history (see classifyTags).
 */
export function findLeftovers(repo) {
  const worktrees = listWorktrees(repo);
  const [main, ...linked] = worktrees;
  const mainBranch = main?.bare ? currentBranch(repo) : main?.branch ?? null;
  const ancestors = ancestorBranches(repo);
  const states = listBranches(repo)
    .filter(({ name }) => name !== repo.base)
    .map(({ name, short, date }) => ({ name, short, date, ...branchState(repo, name, ancestors) }));
  const mergedBranches = states.filter((entry) => isMerged(entry.state) && entry.name !== mainBranch);
  const mergedNames = new Set(mergedBranches.map((entry) => entry.name));
  return {
    states,
    mergedBranches,
    mergedWorktrees: linked.filter((tree) => !tree.missing && tree.branch !== null && mergedNames.has(tree.branch)),
    staleWorktrees: linked.filter((tree) => tree.missing),
    tags: classifyTags(repo),
  };
}
