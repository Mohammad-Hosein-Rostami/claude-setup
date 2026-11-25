// Purpose: `git-tidy prune`: remove the worktrees and branches whose work is already on the base, the older copies of a re-done
//   lane and the leftover branches of workflow agents (lib/copies.mjs), and nothing else.
// Exports: pruneRepo, deleteBranch (exported so a test can move a branch between the check and the delete), refuseUnsafeApply (land asks it first).
// Invariants: the only writes are `git worktree prune`, `git worktree remove` (never --force), `git update-ref -d` with the
//   old value and the removal of the branch's config section, and only with apply. Principle: remove only what is provably
//   on the base AND leaves no only-copy behind (uncommitted, untracked or ignored files, commits that live in a reflog only).
//   Before EACH removal the facts are read again from git, so what was true when the candidates were found is never
//   trusted. A plan (no apply) trusts the candidates it was just given, which saves re-reading hundreds of branches.
//   Anything not proven is kept, with the reason. Order: stale entries, worktrees, branches (a branch is free once its
//   worktree is gone). Every branch is written to the deletion log (deletion-log.mjs) with its sha before it is deleted, so it
//   can be restored; one that cannot be written is kept. An apply whose log is unsafe (not a regular file) removes nothing.
//   With `onlyOnBase` (land's sweep) copies are never removed: their work is on another branch, not on the base.
//   An apply pins the base to the commit it points at once the candidates are found (pinBase): every proof compares with that
//   commit, each branch delete is one transaction that also checks the base still points there, and each worktree removal
//   checks it first. A base that moved stops the run: everything not yet removed is kept, with the reason.
import { branchState, isMerged } from './branches.mjs';
import { copyCandidates, isStillCopy } from './copies.mjs';
import { checkDeletionLog, recordDeletion } from './deletion-log.mjs';
import { UsageError, runGit } from './git.mjs';
import { findLeftovers } from './leftovers.mjs';
import { baseMovedReason, pinBase } from './pinned-base.mjs';
import { branchReflogs, isNotStarted, reflogOnlyCommits } from './reflog.mjs';
import { isBackupTag } from './tags.mjs';
import {
  HIDDEN_FILES_WHY, changedFileCount, contains, currentBranch, hiddenFileCount, ignoredFiles, inProgressOperation, listWorktrees,
  minutesSinceUse, samePath,
} from './repo.mjs';

const RECENT_MINUTES = 60;
const IGNORED_SHOWN = 5;
const NOT_STARTED = `not started yet (no commit of its own), used in the last ${RECENT_MINUTES} min`;
const NOT_A_COPY = 'it is no longer a copy of a newer branch';
const item = (action, kind, subject, detail) => ({ action, kind, subject, detail });
const HEADS = 'refs/heads/';
// Why the run stops (its pinned base moved), or null; once set it stays, so everything after it is kept for that reason.
const baseMoved = (ctx) => (ctx.stopped ??= baseMovedReason(ctx.repo));

// Where verdicts read their facts: with apply, git is asked again each time; a plan reads the worktree list once and
// takes branch states from the candidates it was given.
function makeContext(repo, { apply, includeRecent }, leftovers, copies) {
  const listed = apply ? null : listWorktrees(repo);
  const states = new Map(leftovers.mergedBranches.map((entry) => [entry.name, entry]));
  let reflogs = null;
  return {
    repo,
    apply,
    includeRecent,
    stopped: null, // why the run stopped (baseMoved), or null
    copies: new Map(copies.map((copy) => [copy.name, copy])),
    worktrees: () => listed ?? listWorktrees(repo),
    stateOf: (name) => states.get(name) ?? branchState(repo, name),
    // A plan reads every branch reflog in one call; an apply asks git per branch, right before acting.
    branchReflog: (name) => {
      if (apply) return { cwd: repo.dir, ref: `refs/heads/${name}` };
      reflogs ??= branchReflogs(repo);
      return { cwd: repo.dir, ref: `refs/heads/${name}`, hashes: reflogs.get(name) ?? [] };
    },
  };
}

/** Why a branch must never be removed whatever its state, or null. */
function protectedReason(repo, name, worktrees) {
  if (name === repo.base) return 'it is the base branch';
  const here = repo.topLevel === null ? undefined : worktrees.find((entry) => samePath(entry.path, repo.topLevel));
  if (name === (here ? here.branch : currentBranch(repo))) return 'it is the current branch';
  const [main] = worktrees;
  if (main && !main.bare && main.branch === name) return 'it is checked out in the main worktree';
  return null;
}

// A copy's commits are safe when they are on the branch that holds its work (as a landed branch's are when on the base).
const holderRepo = (repo, copy) => (copy?.by ? { ...repo, baseRef: `refs/heads/${copy.by}` } : repo);

/** Why a reflog forbids removal (commits that would be lost with it), or null. `reflogs` are `[{ cwd, ref }]`. */
function reflogReason(repo, reflogs, branch) {
  const found = reflogOnlyCommits(repo, reflogs, branch);
  if (found.unreadable) return 'a reflog cannot be read';
  if (found.truncated) return 'reflog has more than 200 entries, not checked';
  return found.count > 0 ? `reflog holds commits that are not on the base (${found.count})` : null;
}

function ignoredReason(path) {
  const ignored = ignoredFiles(path);
  if (ignored === null) return 'git cannot list its ignored files';
  if (ignored.length === 0) return null;
  const more = ignored.length > IGNORED_SHOWN ? `, +${ignored.length - IGNORED_SHOWN} more` : '';
  return `ignored files that exist only here (${ignored.slice(0, IGNORED_SHOWN).join(', ')}${more})`;
}

// `includeRecent` is true (every lane), or the names of the lanes that landed: only those skip the recent-use rule.
const liftsRecentRule = (includeRecent, branch) => (Array.isArray(includeRecent) ? includeRecent.includes(branch) : includeRecent === true);

// What the worktree holds that removal would destroy, or that says it is in use: unfinished operation, uncommitted or
// untracked files, files whose edits git status hides (assume-unchanged, skip-worktree), ignored files, commits only in a
// reflog, recent use. A copy's worktree may hold a live agent, so --include-recent never lifts the recent-use rule for it.
function contentReason(ctx, tree, copy) {
  const operation = inProgressOperation(tree.path);
  if (operation !== null) return `a ${operation} is not finished there`;
  const changed = changedFileCount(tree.path);
  if (changed === null) return 'git status failed there, treated as dirty';
  if (changed > 0) return `${changed} uncommitted or untracked files`;
  const hidden = hiddenFileCount(tree.path);
  if (hidden === null) return 'git cannot list its files, treated as hiding edits';
  if (hidden > 0) return `${hidden} files ${HIDDEN_FILES_WHY}`;
  const reasons = [ignoredReason(tree.path), reflogReason(holderRepo(ctx.repo, copy), [ctx.branchReflog(tree.branch), { cwd: tree.path, ref: 'HEAD' }], tree.branch)];
  const found = reasons.find((reason) => reason !== null);
  if (found) return found;
  if (liftsRecentRule(ctx.includeRecent, tree.branch) && !copy) {
    // --include-recent is for lanes that landed; a lane with no commit yet has not, so its recent use still protects it.
    return isNotStarted(ctx.repo, tree.branch) && minutesSinceUse(tree.path, RECENT_MINUTES) !== null ? NOT_STARTED : null;
  }
  const used = minutesSinceUse(tree.path, RECENT_MINUTES);
  if (used === null) return null;
  return copy ? `used ${used} min ago (an agent may still work there)` : `used ${used} min ago (add --include-recent if you landed this lane yourself)`;
}

/** Re-reads one linked worktree and decides. Returns `{ remove: true }` or `{ remove: false, reason }`. */
function worktreeVerdict(ctx, candidate) {
  const { repo } = ctx;
  const worktrees = ctx.worktrees();
  const tree = worktrees.find((entry) => entry.path === candidate.path && !entry.main);
  const keep = (reason) => ({ remove: false, reason });
  if (!tree) return keep('no longer a linked worktree');
  if (tree.missing) return keep('its folder is gone (stale, not merged)');
  if (tree.locked) return keep('locked; unlock it with `git worktree unlock` first');
  if (tree.branch === null) return keep('detached HEAD');
  const runsFromHere = [repo.dir, process.cwd()].some((folder) => contains(tree.path, folder));
  if (runsFromHere) return keep('the command runs from this folder');
  const protection = protectedReason(repo, tree.branch, worktrees);
  if (protection) return keep(protection);
  const copy = ctx.copies.get(tree.branch);
  if (copy) {
    if (ctx.apply && !isStillCopy(repo, copy)) return keep(NOT_A_COPY);
  } else {
    const state = ctx.apply ? branchState(repo, tree.branch) : ctx.stateOf(tree.branch);
    if (!isMerged(state.state)) return keep(`branch ${tree.branch} is not on ${repo.base} (${state.ahead} commits ahead)`);
  }
  const reason = contentReason(ctx, tree, copy);
  return reason === null ? { remove: true } : keep(reason);
}

/** Re-reads one branch and decides; `gone` holds worktree paths a dry run assumes are already removed. */
function branchVerdict(ctx, candidate, gone) {
  const { repo } = ctx;
  const name = candidate.name;
  const worktrees = ctx.worktrees();
  const keep = (reason) => ({ remove: false, reason });
  const protection = protectedReason(repo, name, worktrees);
  if (protection) return keep(protection);
  const copy = ctx.copies.get(name);
  const state = copy ? { state: copy.kind, tip: copy.tip } : ctx.apply ? branchState(repo, name) : candidate;
  if (copy) {
    if (ctx.apply && !isStillCopy(repo, copy)) return keep(NOT_A_COPY);
  } else {
    if (state.state === 'missing') return keep('it is already gone');
    if (!isMerged(state.state)) return keep(`${state.ahead} commits are not on ${repo.base}`);
  }
  const holder = worktrees.find((entry) => entry.branch === name && !gone.has(entry.path));
  if (holder) return keep(`checked out in ${holder.path}`);
  const lost = reflogReason(holderRepo(repo, copy), [ctx.branchReflog(name)], name);
  if (lost) return keep(lost);
  return { remove: true, tip: state.tip, state: state.state };
}

function pruneStale(ctx, candidates, gone) {
  const { repo, apply } = ctx;
  const items = [];
  const removable = [];
  for (const candidate of candidates) {
    const tree = ctx.worktrees().find((entry) => entry.path === candidate.path && !entry.main);
    if (!tree) continue;
    if (!tree.missing) items.push(item('keep', 'stale-worktree', tree.path, 'its folder is back'));
    else if (tree.locked) items.push(item('keep', 'stale-worktree', tree.path, 'locked; unlock it with `git worktree unlock` first'));
    else removable.push(tree.path);
  }
  if (apply && removable.length > 0) runGit(repo.dir, ['worktree', 'prune']);
  const stillListed = new Set(ctx.worktrees().map((entry) => entry.path));
  for (const path of removable) {
    if (!apply) {
      gone.add(path); // a plan must predict that its branch becomes free once the entry is pruned
      items.push(item('remove', 'stale-worktree', path, 'folder missing'));
    } else if (stillListed.has(path)) items.push(item('failed', 'stale-worktree', path, 'git worktree prune left it listed'));
    else items.push(item('removed', 'stale-worktree', path, 'folder missing'));
  }
  return items;
}

function pruneWorktree(ctx, candidate, gone) {
  const { repo, apply } = ctx;
  const kind = ctx.copies.has(candidate.branch) ? 'copy-worktree' : 'merged-worktree';
  if (ctx.stopped !== null) return item('keep', kind, candidate.path, ctx.stopped);
  const verdict = worktreeVerdict(ctx, candidate);
  const detail = `branch ${candidate.branch}`;
  if (!verdict.remove) return item('keep', kind, candidate.path, verdict.reason);
  if (!apply) {
    gone.add(candidate.path);
    return item('remove', kind, candidate.path, detail);
  }
  if (baseMoved(ctx) !== null) return item('keep', kind, candidate.path, ctx.stopped);
  const result = runGit(repo.dir, ['worktree', 'remove', '--', candidate.path]);
  return result.status === 0 ? item('removed', kind, candidate.path, detail) : item('failed', kind, candidate.path, result.stderr);
}

// Compare-and-delete: update-ref fails when the branch no longer points at the tip the verdict was made for, and, with a
// pinned base (pinBase), when the base no longer points at the commit the proofs compared with (one transaction, so
// nothing is deleted then). A branch's config section (`branch.<name>.*`, set by upstream tracking) is removed too, as
// `git branch -D` would.
export function deleteBranch(repo, name, tip) {
  const ref = `${HEADS}${name}`;
  const deleted = repo.baseSha === undefined
    ? runGit(repo.dir, ['update-ref', '-d', ref, tip])
    : runGit(repo.dir, ['update-ref', '--stdin'], `verify ${HEADS}${repo.base} ${repo.baseSha}\ndelete ${ref} ${tip}\n`);
  if (deleted.status !== 0) {
    const now = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', ref]).stdout.trim();
    return now !== '' && now !== tip ? item('keep', 'merged-branch', name, `it moved since the check (was ${tip}, now ${now})`) : item('failed', 'merged-branch', name, deleted.stderr);
  }
  const config = runGit(repo.dir, ['config', '--remove-section', `branch.${name}`]);
  const configFailed = config.status !== 0 && !config.stderr.includes('no such section');
  return item('deleted', 'merged-branch', name, `was ${tip}${configFailed ? `; its config section could not be removed: ${config.stderr}` : ''}`);
}

// Why `onlyOnBase` keeps a copy: its work is on another branch, not on the base.
const notOnBaseReason = (repo, copy) => `${copy.by ? `its work is in ${copy.by}` : 'its commits are on other branches'}, not all on ${repo.base}; land removes only what is on the base`;

// Writes the branch about to be deleted to the deletion log; returns null, or why it must be kept (the record failed).
function unloggedReason(repo, name, verdict, copy) {
  const reason = copy ? `${copy.kind}${copy.by ? ` of ${copy.by}` : ''}` : verdict.state;
  try {
    recordDeletion(repo.dir, { branch: name, sha: verdict.tip, reason });
    return null;
  } catch (error) {
    return `not written to the deletion log, so not deleted: ${error.message}`;
  }
}

function pruneBranch(ctx, candidate, gone) {
  const copy = ctx.copies.get(candidate.name);
  const kind = copy?.kind ?? 'merged-branch';
  if (ctx.stopped !== null) return item('keep', kind, candidate.name, ctx.stopped);
  const verdict = branchVerdict(ctx, candidate, gone);
  if (!verdict.remove) return item('keep', kind, candidate.name, verdict.reason);
  if (!ctx.apply) return item('remove', kind, candidate.name, `${candidate.short} ${verdict.state}`);
  const unlogged = unloggedReason(ctx.repo, candidate.name, verdict, copy);
  if (unlogged) return item('keep', kind, candidate.name, unlogged);
  const done = deleteBranch(ctx.repo, candidate.name, verdict.tip);
  // A delete the base check refused: the base moved, so the run stops here.
  return done.action === 'deleted' || baseMoved(ctx) === null ? done : item('keep', kind, candidate.name, ctx.stopped);
}

function detachedWorktrees(ctx) {
  return ctx.worktrees().filter((tree) => !tree.main && !tree.missing && tree.detached)
    .map((tree) => item('keep', 'detached-worktree', tree.path, 'detached HEAD, not touched'));
}

/** Throws UsageError when an operation is unfinished in any worktree or the base is ambiguous: nothing may be removed then. */
export function refuseUnsafeApply(repo) {
  for (const tree of listWorktrees(repo).filter((entry) => !entry.missing && !entry.bare)) {
    const operation = inProgressOperation(tree.path);
    if (operation !== null) throw new UsageError(`a ${operation} is not finished in ${tree.path}; finish or abort it before --apply`);
  }
  if (repo.baseSource !== 'from --base' && repo.knownBases.length > 1) {
    throw new UsageError(`${repo.knownBases.join(', ')} all exist here and the base (${repo.base}) was not given; pass the one you work against with --base <branch>`);
  }
}

/**
 * Plans (apply false) or performs (apply true) the removal of stale and merged worktrees and merged branches.
 * `leftovers` are the candidates (from findLeftovers); each is re-checked right before it is acted on, so candidates
 * found earlier may be out of date. `includeRecent` (true, or an array of lane names that it applies to) lifts only the "used in the last 60 minutes" rule, and not for a lane with no commit of
 * its own yet (see isNotStarted): that one stays protected while its worktree was used. `onlyOnBase` (land's sweep) keeps every
 * copy (superseded-copy, agent-leftover not on the base) with the reason, so only branches whose content is on the base go. Returns items
 * `{ action, kind, subject, detail }` with action `remove`/`keep` for a plan and `removed`/`deleted`/`kept`/`failed` for an
 * apply. An apply pins the base (pinBase) and stops, keeping the rest, once the base moves. Throws UsageError when apply meets
 * an unfinished operation, an ambiguous base or a deletion log that is not safe to write.
 */
export function pruneRepo(unpinned, { apply, includeRecent = false, onlyOnBase = false, leftovers = findLeftovers(unpinned) }) {
  if (apply) {
    refuseUnsafeApply(unpinned);
    checkDeletionLog(unpinned.dir); // without a safe log no branch may go, so nothing is removed
  }
  const repo = apply ? pinBase(unpinned) : unpinned;
  const gone = new Set();
  const mergedNames = new Set(leftovers.mergedBranches.map((entry) => entry.name));
  // A copy on the base is already a merged branch; only the others go through the copy path.
  const allCopies = copyCandidates(repo, leftovers).filter((copy) => !mergedNames.has(copy.name));
  const copies = onlyOnBase ? [] : allCopies;
  const ctx = makeContext(repo, { apply, includeRecent }, leftovers, copies);
  const copyBranches = copies.map((copy) => ({ name: copy.name, short: copy.tip.slice(0, 7) }));
  const copyWorktrees = listWorktrees(repo).filter((tree) => !tree.main && !tree.missing && ctx.copies.has(tree.branch)).map(({ path, branch }) => ({ path, branch }));
  const items = pruneStale(ctx, leftovers.staleWorktrees, gone);
  if (onlyOnBase) items.push(...allCopies.map((copy) => item('keep', copy.kind, copy.name, notOnBaseReason(repo, copy))));
  for (const candidate of [...leftovers.mergedWorktrees, ...copyWorktrees]) items.push(pruneWorktree(ctx, candidate, gone));
  for (const candidate of [...leftovers.mergedBranches, ...copyBranches]) items.push(pruneBranch(ctx, candidate, gone));
  items.push(...detachedWorktrees(ctx));
  const tagNames = leftovers.tags.filter((tag) => tag.state === 'patch-equal' && isBackupTag(tag.name)).map((tag) => tag.name);
  if (tagNames.length > 0) items.push(item('note', 'tags', tagNames.join(' '), 'not removed by this tool')); // a tag may be the only backup
  return apply ? items.map((entry) => (entry.action === 'keep' ? { ...entry, action: 'kept' } : entry)) : items;
}
