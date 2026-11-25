// Purpose: `git-tidy check`: is the history one straight line, and which branches and worktrees are leftovers (merged, or copies of newer work).
// Exports: runCheck, UNLANDED_AFTER_HOURS.
// Invariants: reads only. A finding is a fact (merge commit, merged branch or worktree, stale worktree, a folder whose branch moved
//   under it, edits in the base folder, a branch folded into a lane that landed) and sets exit 1;
//   a hint (kind ends in `?`) is context and never does; an info item (a not-started lane in a locked worktree, the lane folder count)
//   is neither. Items are `{ kind, subject, detail }`. A git command that fails
//   throws (exit 2): a check that cannot read must never report clean.
import { copyFindings } from './copies.mjs';
import { gitFlag, gitText, runGit, UsageError } from './git.mjs';
import { foldedCandidates, inLaneHolders } from './folded.mjs';
import { readLandings } from './landed-log.mjs';
import { findLeftovers } from './leftovers.mjs';
import { isBackupTag } from './tags.mjs';
import { tangledRefs } from './tangled.mjs';
import { changedFileCount, currentBranch, ignoredFiles, inProgressOperation, listWorktrees } from './repo.mjs';
import { isNotStarted } from './reflog.mjs';
import { poolSlots } from './lane-slots.mjs';

const IGNORED_SHOWN = 5;
// earlier branch positions compared with a folder's index; the landing that moved a branch under its folder is recent
const BRANCH_POSITIONS_CHECKED = 50;
/** A lane with no commit for this long is waiting to land, not being worked on. */
export const UNLANDED_AFTER_HOURS = 2;
const MS_PER_HOUR = 60 * 60 * 1000;

const item = (kind, subject, detail) => ({ kind, subject, detail });

function mergeCommitFindings(repo) {
  const hasHead = gitFlag(repo.dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const starts = hasHead ? [repo.baseRef, 'HEAD'] : [repo.baseRef];
  // With an upstream only merges it does not have yet count: rewriting those is free, published ones need the owner.
  const notPublished = repo.upstream ? [`^${repo.upstream.ref}`] : [];
  const log = gitText(repo.dir, ['log', '--merges', '--format=%h %s', ...starts, ...notPublished, '--']);
  return log.split('\n').filter((line) => line !== '').map((line) => {
    const space = line.indexOf(' ');
    return item('merge-commit', line.slice(0, space), line.slice(space + 1));
  });
}

const TAG_PREFIX = 'refs/tags/';
const isPlainTag = (ref) => ref.startsWith(TAG_PREFIX) && !isBackupTag(ref.slice(TAG_PREFIX.length));

// The base and the current branch are covered by `merge-commit`; every other branch and `backup/` tag is a `tangled-ref`
// finding, any other tag only the hint `tangled-tag?` (it may be a published release tag).
function tangledRefItems(repo) {
  const current = currentBranch(repo);
  const skip = new Set([repo.baseRef, ...(current === null ? [] : [`refs/heads/${current}`])]);
  const refs = tangledRefs(repo, skip);
  const detail = ({ count, newest }) => `${count} merge commits not on any remote, newest ${newest}`;
  return {
    findings: refs.filter(({ ref }) => !isPlainTag(ref)).map((entry) => item('tangled-ref', entry.ref, detail(entry))),
    hints: refs.filter(({ ref }) => isPlainTag(ref)).map((entry) => item('tangled-tag?', entry.ref, detail(entry))),
  };
}

function publishedMergeHint(repo) {
  if (!repo.upstream) return [];
  const count = Number(gitText(repo.dir, ['rev-list', '--merges', '--count', repo.upstream.ref]));
  return count > 0 ? [item('published-merge?', repo.upstream.name, `${count} merge commits already published`)] : [];
}

function mergedRemoteHints(repo) {
  if (!repo.upstream) return [];
  const listed = gitText(repo.dir, ['for-each-ref', `--merged=${repo.upstream.ref}`, '--format=%(refname)%00%(objectname:short)', 'refs/remotes/origin']);
  return listed.split('\n').filter((line) => line !== '').map((line) => line.split('\0'))
    .filter(([ref]) => ref !== repo.upstream.ref && ref !== 'refs/remotes/origin/HEAD')
    .map(([ref, hash]) => item('merged-remote-branch?', ref.replace(/^refs\/remotes\//, ''), hash));
}

function behindBaseHint(repo) {
  if (!gitFlag(repo.dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) || gitFlag(repo.dir, ['merge-base', '--is-ancestor', repo.baseRef, 'HEAD'])) return [];
  const behind = gitText(repo.dir, ['rev-list', '--count', `HEAD..${repo.baseRef}`]);
  return [item('behind-base?', currentBranch(repo) ?? 'HEAD', `behind ${repo.base} by ${behind}`)];
}

const STALE_LOCK_MS = 24 * 60 * 60 * 1000; // a lane lock older than a day is shown: its agent or session may be gone (r9-wt-lock)
const HOUR_MS = 60 * 60 * 1000;

function worktreeHints(worktrees, now) {
  const hints = [];
  for (const tree of worktrees.filter((entry) => !entry.missing && !entry.bare)) {
    if (tree.locked && tree.lockedAtMs != null && now - tree.lockedAtMs > STALE_LOCK_MS) {
      hints.push(item('stale-lock?', tree.path, `locked ${Math.floor((now - tree.lockedAtMs) / HOUR_MS)} h ago${tree.lockReason ? ` (${tree.lockReason})` : ''}: git worktree unlock it if no agent or session works there`));
    }
    const changed = tree.main ? 0 : changedFileCount(tree.path);
    if (changed === null) hints.push(item('dirty-worktree?', tree.path, 'git status failed, treated as dirty'));
    else if (changed > 0) hints.push(item('dirty-worktree?', tree.path, `changed ${changed}`));
    const operation = inProgressOperation(tree.path);
    if (operation !== null) hints.push(item('in-progress?', tree.path, `${operation} not finished`));
  }
  return hints;
}

function ignoredFileHints(mergedWorktrees) {
  return mergedWorktrees.flatMap((tree) => {
    const ignored = ignoredFiles(tree.path);
    if (ignored === null || ignored.length === 0) return [];
    const more = ignored.length > IGNORED_SHOWN ? `, +${ignored.length - IGNORED_SHOWN} more` : '';
    return [item('ignored-files?', tree.path, `exist only here, prune keeps this worktree (${ignored.slice(0, IGNORED_SHOWN).join(', ')}${more})`)];
  });
}

function shallowHint(repo) {
  const shallow = gitText(repo.dir, ['rev-parse', '--is-shallow-repository']) === 'true';
  return shallow ? [item('shallow?', 'repository', 'history is cut, so branches may look unmerged')] : [];
}

// plumbing (diff-index), not `diff`: `diff` runs a textconv program the repository config names, plumbing never does
const succeeds = (path, args) => runGit(path, args).status === 0; // a missing commit or reflog reads as "no", never as an error

/** Earlier positions of `branch` from its reflog, newest first, without `tip`; [] when the branch has no reflog. */
function earlierPositions(path, branch, tip) {
  const { status, stdout } = runGit(path, ['reflog', 'show', '--format=%H', '-n', String(BRANCH_POSITIONS_CHECKED), `refs/heads/${branch}`]);
  if (status !== 0) return [];
  return [...new Set(stdout.split('\n').filter((hash) => hash !== '' && hash !== tip))];
}

// `stale-checkout`: the branch of a folder moved forward without it (git update-ref, branch -f or push/fetch to `.` from another
// worktree), so its index still holds an earlier position of the branch and every change since shows as staged. Found when the index
// differs from the tip, equals an earlier reflog position exactly, and that position is behind the tip (a soft reset leaves the index
// ahead of the tip instead).
function staleCheckoutFindings(worktrees) {
  return worktrees.filter((tree) => !tree.missing && !tree.bare && tree.branch !== null).flatMap((tree) => {
    const { path, branch } = tree;
    if (!succeeds(path, ['rev-parse', '--verify', '--quiet', 'HEAD']) || succeeds(path, ['diff-index', '--cached', '--quiet', 'HEAD'])) return [];
    const tip = gitText(path, ['rev-parse', 'HEAD']);
    const indexAt = earlierPositions(path, branch, tip)
      .find((hash) => succeeds(path, ['merge-base', '--is-ancestor', hash, tip]) && succeeds(path, ['diff-index', '--cached', '--quiet', hash]));
    if (indexAt === undefined) return [];
    const [from, to] = [indexAt, tip].map((hash) => gitText(path, ['rev-parse', '--short', hash]));
    const behind = gitText(path, ['rev-list', '--count', `${indexAt}..${tip}`]);
    // never commit or stash them: both re-apply the gap as changes and revert the landed commits
    const advice = 'never commit or stash these staged changes (they undo landed work); sync with '
      + `git -C ${path} reset --soft ${from} && git -C ${path} merge --ff-only ${to} (unstaged edits stay)`;
    return [item('stale-checkout', path, `index is at ${from}, branch ${branch} moved to ${to} under it (${behind} commits): ${advice}`)];
  });
}

// `unlanded-lane?`: a branch with work the base lacks and no commit for UNLANDED_AFTER_HOURS: land it or say why it waits.
function unlandedLaneHints(repo, unmergedStates, now) {
  const listed = gitText(repo.dir, ['for-each-ref', '--format=%(refname)%00%(committerdate:unix)', 'refs/heads']); // one git call for all
  const committedAt = new Map(listed.split('\n').map((line) => line.split('\0')).map(([ref, seconds]) => [ref.slice('refs/heads/'.length), Number(seconds)]));
  return unmergedStates.filter(({ name }) => committedAt.has(name)).flatMap(({ name, ahead }) => {
    const hours = Math.floor((now - committedAt.get(name) * 1000) / MS_PER_HOUR);
    if (hours < UNLANDED_AFTER_HOURS) return [];
    return [item('unlanded-lane?', name, `ahead ${ahead}, no commit for ${hours} h: land it (rebase, merge --ff-only) or say why it waits`)];
  });
}

// `dirty-base`: the folder where the base is checked out has uncommitted changes to tracked files; edits belong in a lane worktree.
function dirtyBaseFindings(repo, worktrees) {
  return worktrees.filter((tree) => !tree.missing && !tree.bare && tree.branch === repo.base).flatMap((tree) => {
    const changed = gitText(tree.path, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none']);
    if (changed === '') return [];
    const count = changed.split('\n').length;
    return [item('dirty-base', tree.path, `${count} changed tracked files: commit them in a lane worktree, the base folder holds no edits`)];
  });
}

// A lane in flight: a merged (so: at the base) branch checked out in a locked linked worktree that has no commit of its own yet
// (reflog.mjs isNotStarted). A fresh lane is not a leftover, so it is info, never `merged-branch` or `merged-worktree`. An unlocked
// fresh worktree stays a finding: nothing says anyone works there.
function notStartedLanes(repo, leftovers, worktrees) {
  const merged = new Set(leftovers.mergedBranches.map((entry) => entry.name));
  const held = worktrees.filter((tree) => !tree.main && !tree.missing && tree.locked && tree.branch !== null && merged.has(tree.branch));
  return new Map(held.filter((tree) => isNotStarted(repo, tree.branch)).map((tree) => [tree.branch, tree.path]));
}

const notStartedInfo = (notStarted) => [...notStarted].map(([branch, path]) => item('not-started-lane', branch, `in ${path} (locked, no commit of its own yet)`));

// `lane folders: <n> free[, <m> busy][, <k> missing]`: one info line for the pool (lane-slots.mjs); idle folders are neither findings
// nor hints. A repository without a main worktree folder has no pool.
function laneFolderInfo(repo) {
  if (repo.bare) return [];
  let slots;
  try {
    slots = poolSlots(repo);
  } catch (error) {
    if (error instanceof UsageError) return [];
    throw error;
  }
  if (slots.length === 0) return [];
  const counts = ['free', 'busy', 'missing'].map((state) => [state, slots.filter((slot) => slot.state === state).length]);
  const [[, free], ...rest] = counts;
  return [item('lane-folders', [`${free} free`, ...rest.filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`)].join(', '), '')];
}

// `folded-branch` findings for the branches folded into a lane that landed, and `in-lane?` hints for the unmerged `lanes` whose
// commits are all in a live branch's history (a stacked lane, a folded test branch): both are named instead of `unmerged-branch?`.
function foldItems(repo, leftovers, notLanes) {
  const folded = foldedCandidates(repo, readLandings(repo.dir), leftovers).filter(({ name }) => !notLanes.has(name));
  const findings = folded.map(({ name, tip, by, landing }) => item('folded-branch', name, `${tip.slice(0, 7)} folded into ${by} (landed ${new Date(landing.landedAt).toISOString()})`));
  const foldedNames = new Set(folded.map(({ name }) => name));
  const lanes = leftovers.states.filter((b) => b.state === 'unmerged' && !notLanes.has(b.name) && !foldedNames.has(b.name)).map(({ name }) => name);
  const hints = [...inLaneHolders(repo, lanes, leftovers.states)].map(([name, holder]) => item('in-lane?', name, `all its commits are in ${holder}; it goes when ${holder} lands`));
  return { findings, hints, named: new Set([...foldedNames, ...hints.map(({ subject }) => subject)]) };
}

/** Runs every check on `repo` (from openRepo). Returns `{ findings, hints, info }`; info items never count as findings or hints. */
export function runCheck(repo, now = Date.now()) {
  const leftovers = findLeftovers(repo);
  const worktrees = listWorktrees(repo);
  const notStarted = notStartedLanes(repo, leftovers, worktrees);
  const tangled = tangledRefItems(repo);
  const mergedTags = leftovers.tags.filter((t) => t.state === 'patch-equal');
  const copies = copyFindings(repo, leftovers);
  const reportedAsCopy = new Set(copies.map((copy) => copy.subject)); // an agent branch on the base is one finding, the more specific one
  const fold = foldItems(repo, leftovers, reportedAsCopy);
  const findings = [
    ...mergeCommitFindings(repo),
    ...tangled.findings,
    ...copies,
    ...fold.findings,
    ...leftovers.mergedBranches.filter((b) => !reportedAsCopy.has(b.name) && !notStarted.has(b.name)).map((b) => item('merged-branch', b.name, `${b.short} ${b.state}`)),
    ...mergedTags.filter((t) => isBackupTag(t.name)).map((t) => item('merged-tag', t.name, `${t.short} ${t.state}`)),
    ...leftovers.mergedWorktrees.filter((w) => !notStarted.has(w.branch)).map((w) => item('merged-worktree', w.path, `branch ${w.branch}`)),
    ...leftovers.staleWorktrees.map((w) => item('stale-worktree', w.path, 'folder missing')),
    ...staleCheckoutFindings(worktrees),
    ...dirtyBaseFindings(repo, worktrees),
  ];
  const unmerged = leftovers.states.filter((b) => b.state === 'unmerged' && !fold.named.has(b.name))
    .map((b) => item('unmerged-branch?', b.name, `ahead ${b.ahead}, last commit ${b.date}`));
  const unmergedTags = leftovers.tags.filter((t) => t.state === 'unmerged')
    .map((t) => item('unmerged-tag?', t.name, `ahead ${t.ahead}, last commit ${t.date}`));
  const hints = [
    ...publishedMergeHint(repo), ...unmerged, ...fold.hints,
    ...unlandedLaneHints(repo, leftovers.states.filter((b) => b.state === 'unmerged' && !reportedAsCopy.has(b.name) && !fold.named.has(b.name)), now), ...unmergedTags,
    ...mergedTags.filter((t) => !isBackupTag(t.name)).map((t) => item('merged-tag?', t.name, `${t.short} ${t.state}`)), ...tangled.hints, ...mergedRemoteHints(repo),
    ...(repo.bare ? [] : behindBaseHint(repo)), ...worktreeHints(worktrees, now), ...ignoredFileHints(leftovers.mergedWorktrees.filter((w) => !notStarted.has(w.branch))), ...shallowHint(repo),
  ];
  return { findings, hints, info: [...notStartedInfo(notStarted), ...laneFolderInfo(repo)] };
}
