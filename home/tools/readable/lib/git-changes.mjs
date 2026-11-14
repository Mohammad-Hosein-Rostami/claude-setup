// Purpose: ask git what a change added, so `--changed` can report only the findings the change caused.
// Exports: parseDiff(diffText), resolveBase(root, explicitBase), changesSince(root, base).
// Invariants: parseDiff is pure and reads `git diff --unified=0` output. The rest runs git read-only in `root`, with git's
//   repo-local environment variables (GIT_DIR, GIT_INDEX_FILE ...) removed so a surrounding hook cannot redirect it, and throws
//   GitError (never a guess) when root is not inside a git work tree or the base does not exist. Paths are relative to
//   `root`. Untracked files count as added; deleted files are left out.
import { spawnSync } from 'node:child_process';
import { GitError } from './errors.mjs';

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DEFAULT_BRANCH_CANDIDATES = ['main', 'master'];
const FALLBACK_LOCAL_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR'];
const GIT_BUFFER_BYTES = 64 * 1024 * 1024;

function run(args, options) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { encoding: 'utf8', maxBuffer: GIT_BUFFER_BYTES, ...options });
  if (result.error) throw new GitError(`cannot run git: ${result.error.message}`);
  return result;
}

/** The environment without the variables that point git at one particular repository. */
function cleanEnvironment() {
  const listed = run(['rev-parse', '--local-env-vars'], { env: process.env });
  const names = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean) : FALLBACK_LOCAL_VARS;
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name) && !FALLBACK_LOCAL_VARS.includes(name)));
}

const git = (root, args) => run(args, { cwd: root, env: cleanEnvironment() });

/**
 * @param {string} diffText output of `git diff --unified=0`
 * @returns {Map<string, {lines: Set<number>, removed: string[]}>} added or changed line numbers and deleted line texts per file
 */
export function parseDiff(diffText) {
  const byFile = new Map();
  let current = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).split('\t')[0];
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current !== null && !byFile.has(current)) byFile.set(current, { lines: new Set(), removed: [] });
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('-') && !line.startsWith('--- ')) byFile.get(current).removed.push(line.slice(1));
    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let n = start; n < start + count; n++) byFile.get(current).lines.add(n);
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

const lines = (result) => result.stdout.split('\n').filter(Boolean);

/**
 * What the working tree changed against `base`.
 * @returns {{changed: Map<string, {lines: Set<number>|null, removed: string[]}>, added: Set<string>, baseFiles: Set<string>}}
 *   `changed`: every changed file (lines null = the whole file is new); `added`: files that did not exist at the base;
 *   `baseFiles`: every file that existed at the base, under `root`
 */
export function changesSince(root, base) {
  const diff = git(root, ['diff', '--relative', '--diff-filter=d', '--unified=0', base, '--', '.']);
  if (diff.status !== 0) throw new GitError(`git diff failed: ${diff.stderr.trim()}`);
  const changed = parseDiff(diff.stdout);
  const added = new Set(lines(git(root, ['diff', '--relative', '--diff-filter=A', '--name-only', base, '--', '.'])));
  for (const path of lines(git(root, ['ls-files', '--others', '--exclude-standard']))) added.add(path);
  for (const path of added) changed.set(path, { lines: null, removed: [] });
  const baseFiles = new Set(lines(git(root, ['ls-tree', '-r', '--name-only', base])));
  return { changed, added, baseFiles };
}
