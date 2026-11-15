// Purpose: `git-tidy check`: is the history one straight line, and which branches and worktrees are leftovers.
// Exports: runCheck.
// Invariants: reads only. A finding is a fact (merge commit, merged branch or worktree, stale worktree) and sets exit 1;
//   a hint (kind ends in `?`) is context and never does. Items are `{ kind, subject, detail }`.
import { runGit } from './git.mjs';
import { findLeftovers } from './leftovers.mjs';
import { changedFileCount, currentBranch, inProgressOperation, listWorktrees } from './repo.mjs';

const item = (kind, subject, detail) => ({ kind, subject, detail });

function mergeCommitFindings(repo) {
  const hasHead = runGit(repo.dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).status === 0;
  const starts = hasHead ? [repo.baseRef, 'HEAD'] : [repo.baseRef];
  // With an upstream only merges it does not have yet count: rewriting those is free, published ones need the owner.
  const notPublished = repo.upstream ? [`^${repo.upstream.ref}`] : [];
  const log = runGit(repo.dir, ['log', '--merges', '--format=%h %s', ...starts, ...notPublished, '--']).stdout;
  return log.split('\n').filter((line) => line !== '').map((line) => {
    const space = line.indexOf(' ');
    return item('merge-commit', line.slice(0, space), line.slice(space + 1));
  });
}

function publishedMergeHint(repo) {
  if (!repo.upstream) return [];
  const count = Number(runGit(repo.dir, ['rev-list', '--merges', '--count', repo.upstream.ref]).stdout);
  return count > 0 ? [item('published-merge?', repo.upstream.name, `${count} merge commits already published`)] : [];
}

function mergedRemoteHints(repo) {
  if (!repo.upstream) return [];
  const listed = runGit(repo.dir, ['for-each-ref', `--merged=${repo.upstream.ref}`, '--format=%(refname)%00%(objectname:short)', 'refs/remotes/origin']).stdout;
  return listed.split('\n').filter((line) => line !== '').map((line) => line.split('\0'))
    .filter(([ref]) => ref !== repo.upstream.ref && ref !== 'refs/remotes/origin/HEAD')
    .map(([ref, hash]) => item('merged-remote-branch?', ref.replace(/^refs\/remotes\//, ''), hash));
}

function behindBaseHint(repo) {
  const contains = runGit(repo.dir, ['merge-base', '--is-ancestor', repo.baseRef, 'HEAD']).status;
  if (contains !== 1) return [];
  const behind = runGit(repo.dir, ['rev-list', '--count', `HEAD..${repo.baseRef}`]).stdout.trim();
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

function shallowHint(repo) {
  const shallow = runGit(repo.dir, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
  return shallow ? [item('shallow?', 'repository', 'history is cut, so branches may look unmerged')] : [];
}

/** Runs every check on `repo` (from openRepo). Returns `{ findings, hints }`. */
export function runCheck(repo) {
  const leftovers = findLeftovers(repo);
  const worktrees = listWorktrees(repo);
  const findings = [
    ...mergeCommitFindings(repo),
    ...leftovers.mergedBranches.map((b) => item('merged-branch', b.name, `${b.short} ${b.state}`)),
    ...leftovers.mergedWorktrees.map((w) => item('merged-worktree', w.path, `branch ${w.branch}`)),
    ...leftovers.staleWorktrees.map((w) => item('stale-worktree', w.path, 'folder missing')),
  ];
  const unmerged = leftovers.states.filter((b) => b.state === 'unmerged')
    .map((b) => item('unmerged-branch?', b.name, `ahead ${b.ahead}, last commit ${b.date}`));
  const hints = [
    ...publishedMergeHint(repo), ...unmerged, ...mergedRemoteHints(repo),
    ...(repo.bare ? [] : behindBaseHint(repo)), ...worktreeHints(worktrees), ...shallowHint(repo),
  ];
  return { findings, hints };
}
