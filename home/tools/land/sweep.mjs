// Purpose: the clean-up `land` runs once the lane has landed and its own branch is gone: git-tidy's `prune --apply` over the
//   whole repository (branches whose content is all on the base, with all of prune's safety checks; copies of another branch are
//   kept with the reason), then the `left:` block, one line per branch still there and why, and per stale worktree entry
//   prune kept. A fold that landed as patches and changed on the base since gets a label only when landedAt proves its whole
//   content at a base commit; the label advises looking first and never deletes.
// Exports: sweepRepo.
// Invariants: removes only what prune proves; a prune that refuses (an unfinished rebase or merge in some worktree) removes
//   nothing and prints `cleanup skipped: <reason>`; a deletion log that is not safe to write stops it before anything is removed
//   (prune throws, land prints it on stderr), and so does a git older than 2.40. Text from git (names, paths, messages) is
//   printed without control characters.
import { contentProofUnsupported, isMerged, landedAt } from '../git-tidy/lib/branches.mjs';
import { UNLANDED_AFTER_HOURS } from '../git-tidy/lib/check.mjs';
import { commitDates } from '../git-tidy/lib/copies.mjs';
import { checkDeletionLog } from '../git-tidy/lib/deletion-log.mjs';
import { inLaneHolders } from '../git-tidy/lib/in-lane.mjs';
import { UsageError } from '../git-tidy/lib/git.mjs';
import { findLeftovers } from '../git-tidy/lib/leftovers.mjs';
import { pruneRepo } from '../git-tidy/lib/prune.mjs';
import { listWorktrees, openRepo } from '../git-tidy/lib/repo.mjs';
import { shellWord } from '../git-tidy/lib/shell-word.mjs';

const MAX_LEFT_SHOWN = 20;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_SECOND = 1000;
const SHORT_HASH_LENGTH = 8;
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
    return { items: pruneRepo(repo, { apply: true, onlyOnBase: true }), skipped: null };
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return { items: [], skipped: error.message };
  }
}

// The `left:` reason for branch `name`, whose whole content landedAt proved at base commit `pairedBase`.
function landedLabel(repo, name, pairedBase) {
  const look = `git log -p ${shellWord(`${repo.base}..${name}`)}`;
  return plain(`landed in ${pairedBase.slice(0, SHORT_HASH_LENGTH)} (its content was on ${repo.base} there); ${repo.base} changed its files since: look (${look}), then git branch -D ${shellWord(name)}`);
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

// The `left:` block: every branch but the base, then each stale worktree entry prune kept, at most MAX_LEFT_SHOWN lines,
// then `+N more`.
function leftLines(repo, items, now) {
  const states = findLeftovers(repo).states;
  const staleRows = items.filter(({ action, kind }) => action === 'kept' && kind === 'stale-worktree')
    .map(({ subject, detail }) => `  ${plain(subject)} (stale worktree entry): kept: ${plain(detail)}`);
  if (states.length === 0 && staleRows.length === 0) return ['left: none'];
  const reasons = keptReasons(repo, items);
  const holders = inLaneHolders(repo, states.filter(({ state }) => state === 'unmerged').map(({ name }) => name), states);
  const dates = commitDates(repo);
  const why = ({ name, state, tip, ahead }) => {
    if (reasons.has(name)) return `kept: ${plain(reasons.get(name))}`;
    if (isMerged(state)) return `on ${repo.base} (${state}), not removed`;
    if (holders.has(name)) return `in ${holders.get(name)} (lands with it)`;
    const pairedBase = tip === null ? null : landedAt(repo, tip);
    if (pairedBase !== null) return landedLabel(repo, name, pairedBase);
    const hours = Math.floor((now - (dates.get(name) ?? 0) * MS_PER_SECOND) / MS_PER_HOUR);
    return hours >= UNLANDED_AFTER_HOURS ? `idle ${hours} h, ahead ${ahead}` : `active, ahead ${ahead}`;
  };
  // why runs git for each branch (landedAt), so only the branches shown get one.
  const rows = [...states.slice(0, MAX_LEFT_SHOWN).map((state) => `  ${state.name}: ${why(state)}`), ...staleRows];
  const hidden = states.length + staleRows.length - MAX_LEFT_SHOWN;
  const more = hidden > 0 ? [`  +${hidden} more`] : [];
  return ['left:', ...rows.slice(0, MAX_LEFT_SHOWN), ...more];
}

/**
 * Cleans the repository of the base checkout `{ dir, base }` after a landing and returns the lines to print: what prune
 * deleted, removed or kept (or `cleanup skipped: <reason>`), then the `left:` block. Copies are kept (`onlyOnBase`): only
 * branches whose content is on the base go. Throws, removing nothing, when git is older than 2.40 (no content proof), when
 * the deletion log is not safe to write, and when git fails unexpectedly.
 */
export function sweepRepo({ dir, base }, now = Date.now()) {
  const unsupported = contentProofUnsupported(dir);
  if (unsupported !== null) throw new Error(unsupported);
  const repo = openRepo(dir, base);
  checkDeletionLog(repo.dir);
  const { items, skipped } = pruneItems(repo);
  const lines = skipped === null ? items.flatMap(itemLine) : [`cleanup skipped: ${plain(skipped)}`];
  return [...lines, ...leftLines(repo, items, now)];
}
