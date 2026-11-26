// Purpose: prune's step for stale worktree entries (a linked worktree whose folder is gone, or was moved): keep an entry
//   while it is all that holds some work, else remove that entry alone; land's sweep only lists them.
// Exports: pruneStale.
// Invariants: writes only with apply and `removes`, and only `git worktree remove -- <path>` (one entry at a time; never
//   `git worktree prune`, which drops every stale entry, checked or not) and the creation of a branch `stale-head/<entry id>`
//   (never moved). An entry stays when its folder is back, it is locked, it cannot be found, its HEAD reflog holds commits
//   found nowhere else, or its index differs from its HEAD (staged content; the folder may only have moved). When no branch
//   holds its HEAD commit, that commit becomes the branch `stale-head/<entry id>` first, so it stays reachable. Without
//   `removes` (land's sweep) every entry stays, with the reason.
import { runGit } from './git.mjs';
import { LOCK_REASON_PREFIX, entryIdOf, staleIndexWhy } from './lane-slots.mjs';
import { baseMoved } from './pinned-base.mjs';
import { reflogOnlyCommits } from './reflog.mjs';

const KIND = 'stale-worktree';
const HEADS = 'refs/heads/';
const RESCUE_PREFIX = 'stale-head/';
const NO_BRANCH_REMOVED = 'HEAD'; // no branch goes with an entry, and `HEAD` is never a branch name
const item = (action, subject, detail) => ({ action, kind: KIND, subject, detail });
// Why land's sweep keeps an entry that holds nothing: a person decides about stale entries.
const NOT_REMOVED_BY_LAND = 'land never removes a stale worktree entry; `git-tidy prune --apply` removes it once nothing is lost';
const POOL_LOCK = `${LOCK_REASON_PREFIX} `; // a pool claim's lock reason: `cs-lane-pool <branch>` or `cs-lane-pool snapshot <8>`

// Why a locked stale entry stays. A pool entry is never "unlock it": the pool owns its lock, and `lane list` shows the folder.
const lockedReason = (tree) => (tree.lockReason.startsWith(POOL_LOCK)
  ? `a pool folder entry (${tree.lockReason}); git-tidy lane list shows it`
  : 'locked; unlock it with `git worktree unlock` first');

// The facts of one stale entry: `{ keep: <why it stays> }`, or `{ head, isHeld, rescue }` (rescue: the branch its HEAD
// becomes when no branch holds it).
function readEntry(repo, tree) {
  if (!tree.missing) return { keep: 'its folder is back' };
  if (tree.locked) return { keep: lockedReason(tree) };
  const id = entryIdOf(repo, tree.path);
  if (id === null) return { keep: 'its worktree entry cannot be found' };
  const ref = `worktrees/${id}/HEAD`;
  const head = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).stdout.trim();
  if (head === '') return { keep: 'its HEAD cannot be read' };
  const lost = reflogOnlyCommits(repo, [{ cwd: repo.dir, ref }], NO_BRANCH_REMOVED);
  if (lost.unreadable) return { keep: 'its HEAD reflog cannot be read' };
  if (lost.truncated) return { keep: 'its HEAD reflog has more than 200 entries, not checked' };
  if (lost.count > 0) return { keep: `its HEAD reflog holds ${lost.count} commits found nowhere else` };
  const staged = staleIndexWhy(repo, id);
  if (staged !== null) return { keep: staged };
  const held = runGit(repo.dir, ['for-each-ref', '--count=1', '--contains', head, HEADS]);
  if (held.status !== 0) return { keep: 'git cannot tell whether a branch holds its HEAD' };
  return { head, isHeld: held.stdout.trim() !== '', rescue: `${RESCUE_PREFIX}${id}` };
}

// What the removal of the entry says: `folder missing`, and the branch its HEAD is (or would be) kept on.
const removalDetail = (entry, verb) => (entry.isHeld ? 'folder missing' : `folder missing; its HEAD ${entry.head} ${verb} kept as branch ${entry.rescue}`);

// Removes one entry; when no branch holds its HEAD, that commit first becomes the branch entry.rescue (create only).
function removeEntry(repo, tree, entry) {
  if (!entry.isHeld) {
    const made = runGit(repo.dir, ['update-ref', `${HEADS}${entry.rescue}`, entry.head, '']);
    if (made.status !== 0) return item('keep', tree.path, `its HEAD ${entry.head} is on no branch, and branch ${entry.rescue} cannot be created: ${made.stderr}`);
  }
  const removed = runGit(repo.dir, ['worktree', 'remove', '--', tree.path]);
  return removed.status === 0 ? item('removed', tree.path, removalDetail(entry, 'is')) : item('failed', tree.path, removed.stderr);
}

/**
 * Plans or (ctx.apply) performs the removal of the stale entries among `candidates` (findLeftovers' staleWorktrees), each read
 * again first. `gone` gets the paths a plan expects to remove, so their branches count as free. With `removes` false (land's
 * sweep) every entry is kept, with what it holds or NOT_REMOVED_BY_LAND. Returns prune items.
 */
export function pruneStale(ctx, candidates, gone, { removes }) {
  const items = [];
  for (const candidate of candidates) {
    const tree = ctx.worktrees().find((entry) => entry.path === candidate.path && !entry.main);
    if (!tree) continue;
    const entry = readEntry(ctx.repo, tree);
    const keep = entry.keep ?? (removes ? null : NOT_REMOVED_BY_LAND) ?? (ctx.apply ? baseMoved(ctx) : null);
    if (keep !== null) items.push(item('keep', tree.path, keep));
    else if (ctx.apply) items.push(removeEntry(ctx.repo, tree, entry));
    else {
      gone.add(tree.path);
      items.push(item('remove', tree.path, removalDetail(entry, 'would be')));
    }
  }
  return items;
}
