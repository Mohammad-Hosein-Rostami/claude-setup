// Purpose: `git-tidy check`: is the history one straight line, and which branches and worktrees are leftovers.
// Exports: runCheck.
// Invariants: reads only. A finding is a fact (merge commit, merged branch or worktree, stale worktree) and sets exit 1;
//   a hint (kind ends in `?`) is context and never does. Items are `{ kind, subject, detail }`. A git command that fails
//   throws (exit 2): a check that cannot read must never report clean.
import { gitFlag, gitText } from './git.mjs';
import { findLeftovers } from './leftovers.mjs';
import { isBackupTag } from './tags.mjs';
import { tangledRefs } from './tangled.mjs';
import { changedFileCount, currentBranch, ignoredFiles, inProgressOperation, listWorktrees } from './repo.mjs';

const IGNORED_SHOWN = 5;

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

function worktreeHints(worktrees) {
  const hints = [];
  for (const tree of worktrees.filter((entry) => !entry.missing && !entry.bare)) {
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

/** Runs every check on `repo` (from openRepo). Returns `{ findings, hints }`. */
export function runCheck(repo) {
  const leftovers = findLeftovers(repo);
  const worktrees = listWorktrees(repo);
  const tangled = tangledRefItems(repo);
  const mergedTags = leftovers.tags.filter((t) => t.state === 'patch-equal');
  const findings = [
    ...mergeCommitFindings(repo),
    ...tangled.findings,
    ...leftovers.mergedBranches.map((b) => item('merged-branch', b.name, `${b.short} ${b.state}`)),
    ...mergedTags.filter((t) => isBackupTag(t.name)).map((t) => item('merged-tag', t.name, `${t.short} ${t.state}`)),
    ...leftovers.mergedWorktrees.map((w) => item('merged-worktree', w.path, `branch ${w.branch}`)),
    ...leftovers.staleWorktrees.map((w) => item('stale-worktree', w.path, 'folder missing')),
  ];
  const unmerged = leftovers.states.filter((b) => b.state === 'unmerged')
    .map((b) => item('unmerged-branch?', b.name, `ahead ${b.ahead}, last commit ${b.date}`));
  const unmergedTags = leftovers.tags.filter((t) => t.state === 'unmerged')
    .map((t) => item('unmerged-tag?', t.name, `ahead ${t.ahead}, last commit ${t.date}`));
  const hints = [
    ...publishedMergeHint(repo), ...unmerged, ...unmergedTags,
    ...mergedTags.filter((t) => !isBackupTag(t.name)).map((t) => item('merged-tag?', t.name, `${t.short} ${t.state}`)), ...tangled.hints, ...mergedRemoteHints(repo),
    ...(repo.bare ? [] : behindBaseHint(repo)), ...worktreeHints(worktrees), ...ignoredFileHints(leftovers.mergedWorktrees), ...shallowHint(repo),
  ];
  return { findings, hints };
}
