// Purpose: ask git which files and lines changed against a base, so `--changed` can ignore legacy code.
// Exports: parseDiffAddedLines(diffText), resolveBase(root, explicitBase), changedSince(root, base).
// Invariants: parseDiffAddedLines is pure and reads `git diff --unified=0` output; the rest runs git in `root` and throws
//   GitError (never returns a guess) when root is not inside a git work tree or the base does not exist. Paths are
//   relative to `root`; untracked files count as fully changed; deleted files are left out.
import { spawnSync } from 'node:child_process';

export class GitError extends Error {}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DEFAULT_BRANCH_CANDIDATES = ['main', 'master'];

function git(root, args) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new GitError(`cannot run git: ${result.error.message}`);
  return result;
}

/**
 * @param {string} diffText output of `git diff --unified=0`
 * @returns {Map<string, Set<number>>} added or changed line numbers per file
 */
export function parseDiffAddedLines(diffText) {
  const byFile = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).split('\t')[0];
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current !== null && !byFile.has(current)) byFile.set(current, new Set());
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk || current === null) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n++) byFile.get(current).add(n);
  }
  return byFile;
}

/** The commit to compare with: `explicitBase` if given, else the merge-base with the default branch, else HEAD. */
export function resolveBase(root, explicitBase) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']).status !== 0) throw new GitError(`${root} is not inside a git work tree; --changed needs git.`);
  if (explicitBase) {
    if (git(root, ['rev-parse', '--verify', `${explicitBase}^{commit}`]).status !== 0) throw new GitError(`unknown base "${explicitBase}".`);
    return explicitBase;
  }
  if (git(root, ['rev-parse', '--verify', 'HEAD']).status !== 0) return git(root, ['hash-object', '-t', 'tree', '/dev/null']).stdout.trim();
  const remoteHead = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).stdout.trim();
  for (const branch of [remoteHead, ...DEFAULT_BRANCH_CANDIDATES].filter(Boolean)) {
    const mergeBase = git(root, ['merge-base', 'HEAD', branch]);
    if (mergeBase.status === 0) return mergeBase.stdout.trim();
  }
  return 'HEAD';
}

/**
 * @returns {Map<string, Set<number>|null>} every changed file mapped to its changed lines (null = the whole file)
 */
export function changedSince(root, base) {
  const diff = git(root, ['diff', '--relative', '--diff-filter=d', '--unified=0', base, '--', '.']);
  if (diff.status !== 0) throw new GitError(`git diff failed: ${diff.stderr.trim()}`);
  const changed = new Map(parseDiffAddedLines(diff.stdout));
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  for (const path of untracked.stdout.split('\n').filter(Boolean)) changed.set(path, null);
  return changed;
}
