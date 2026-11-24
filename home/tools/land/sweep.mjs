// Purpose: the clean-up `land` runs once the lane has landed and its own branch is gone: git-tidy's `prune --apply` over the
//   whole repository (branches folded into a landed lane, merged branches, copies, with all of prune's safety checks), then the
//   `left:` block, one line per branch still there and why.
// Exports: sweepRepo.
// Invariants: removes only what prune proves; a prune that refuses (an unfinished rebase or merge in some worktree) removes
//   nothing and prints `cleanup skipped: <reason>`, and the landing record stays, so a later prune still has the proof. Text from
//   git (names, paths, messages) is printed without control characters.
import { UNLANDED_AFTER_HOURS } from '../git-tidy/lib/check.mjs';
import { commitDates } from '../git-tidy/lib/copies.mjs';
import { inLaneHolders } from '../git-tidy/lib/folded.mjs';
import { UsageError } from '../git-tidy/lib/git.mjs';
import { findLeftovers } from '../git-tidy/lib/leftovers.mjs';
import { pruneRepo } from '../git-tidy/lib/prune.mjs';
import { listWorktrees, openRepo } from '../git-tidy/lib/repo.mjs';

const MAX_LEFT_SHOWN = 20;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_SECOND = 1000;
// Kinds that are not a branch or its worktree: a detached folder (a pool folder, a scratch checkout) and the merged-tag note.
const NOT_LISTED = new Set(['detached-worktree', 'tags']);

const plain = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ');

// One output line for a prune item; a kept item says why.
function itemLine({ action, kind, subject, detail }) {
  if (NOT_LISTED.has(kind) || action === 'note') return [];
  if (action === 'deleted') return [`deleted ${subject} (${plain(detail)})`];
  if (action === 'removed') return [`removed ${kind === 'stale-worktree' ? 'stale worktree entry' : 'worktree'} ${plain(subject)}`];
  if (action === 'failed') return [`failed to remove ${plain(subject)}: ${plain(detail)}`];
  return [`kept ${plain(subject)}: ${plain(detail)}`];
}

// Prune's items, or none with the reason it refused.
function pruneItems(repo) {
  try {
    return { items: pruneRepo(repo, { apply: true }), skipped: null };
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return { items: [], skipped: error.message };
  }
}

// Map(branch -> why prune kept it): the reason of its worktree first (the branch only says it is checked out there).
function keptReasons(repo, items) {
  const branchAt = new Map(listWorktrees(repo).map(({ path, branch }) => [path, branch]));
  const reasons = new Map();
  for (const { action, kind, subject, detail } of items.filter((entry) => entry.action === 'kept' && !NOT_LISTED.has(entry.kind))) {
    const branch = kind.endsWith('worktree') ? branchAt.get(subject) : subject;
    if (branch && !reasons.has(branch)) reasons.set(branch, detail);
  }
  return reasons;
}

// The `left:` block: every branch but the base, at most MAX_LEFT_SHOWN lines, then `+N more`.
function leftLines(repo, items, now) {
  const states = findLeftovers(repo).states;
  if (states.length === 0) return ['left: none'];
  const reasons = keptReasons(repo, items);
  const holders = inLaneHolders(repo, states.filter(({ state }) => state === 'unmerged').map(({ name }) => name));
  const dates = commitDates(repo);
  const why = ({ name, ahead }) => {
    if (reasons.has(name)) return `kept: ${plain(reasons.get(name))}`;
    if (holders.has(name)) return `in ${holders.get(name)} (lands with it)`;
    const hours = Math.floor((now - (dates.get(name) ?? 0) * MS_PER_SECOND) / MS_PER_HOUR);
    return hours >= UNLANDED_AFTER_HOURS ? `idle ${hours} h, ahead ${ahead}` : `active, ahead ${ahead}`;
  };
  const shown = states.slice(0, MAX_LEFT_SHOWN).map((state) => `  ${state.name}: ${why(state)}`);
  const more = states.length > MAX_LEFT_SHOWN ? [`  +${states.length - MAX_LEFT_SHOWN} more`] : [];
  return ['left:', ...shown, ...more];
}

/**
 * Cleans the repository of the base checkout `{ dir, base }` after a landing and returns the lines to print: what prune
 * deleted, removed or kept (or `cleanup skipped: <reason>`), then the `left:` block. Throws when git fails unexpectedly.
 */
export function sweepRepo({ dir, base }, now = Date.now()) {
  const repo = openRepo(dir, base);
  const { items, skipped } = pruneItems(repo);
  const lines = skipped === null ? items.flatMap(itemLine) : [`cleanup skipped: ${plain(skipped)}`];
  return [...lines, ...leftLines(repo, items, now)];
}
