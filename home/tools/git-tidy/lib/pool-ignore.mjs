// Purpose: keep a repository's lane pool (`.claude/worktrees/`) out of its `git status`, land's checks and `git add -A` (which would
//   add each lane as an embedded repository): a claim appends POOL_EXCLUDE_LINE to the local info/exclude when git does not ignore the
//   pool yet. info/exclude is never committed, so the project's own files stay as they are.
// Exports: POOL_EXCLUDE_LINE, ignorePool.
// Invariants:
// - Runs under the pool lock (lane-pool.mjs claimLane), so two claims never append the line twice; a file that already holds the line
//   gets no second copy.
// - The file is opened O_APPEND|O_CREAT|O_NOFOLLOW, mode 0644: a link at its path is never followed (where the system has no
//   O_NOFOLLOW, an lstat check stands in).
// - Never throws: every failure is the `failed` outcome, and the claim goes on.
import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { gitText, runGit } from './git.mjs';

export const POOL_EXCLUDE_LINE = '/.claude/worktrees/';
const POOL_PATH = '.claude/worktrees/'; // the pool folder as check-ignore reads it, relative to the main worktree
const NOT_IGNORED = 1; // `git check-ignore -q` exits 0 when a rule ignores the path, 1 when none does
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const EXCLUDE_MODE = 0o644;

/** True when git ignores the pool folder in `mainDir`; throws when git cannot tell. */
function isPoolIgnored(mainDir) {
  const checked = runGit(mainDir, ['check-ignore', '-q', POOL_PATH]);
  if (checked.status === 0) return true;
  if (checked.status === NOT_IGNORED) return false;
  throw new Error(`git check-ignore failed: ${checked.stderr.split('\n')[0]}`);
}

/** Appends `line` to the plain file at `path` (made with its folder when missing) unless a line there already equals it. */
function appendLineOnce(path, line) {
  mkdirSync(dirname(path), { recursive: true });
  if (NO_FOLLOW === 0 && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path} is a link: not followed`);
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW, EXCLUDE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a plain file`);
    const text = readFileSync(fd, 'utf8');
    if (text.split(/\r?\n/).includes(line)) return;
    writeSync(fd, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes git ignore the lane pool of the repository whose main worktree is `mainDir`, through its local info/exclude.
 * @param {string} mainDir the main worktree folder (git names the common dir's info/exclude from it, also for a linked worktree)
 * @returns {{ outcome: 'already'|'added'|'failed', path: string|null, why?: string }} `path`: the info/exclude written, null when
 *   none was; `why`: what failed (a `.gitignore` negation that re-includes the pool, a link at the path, a git or file error)
 */
export function ignorePool(mainDir) {
  let path = null;
  try {
    if (isPoolIgnored(mainDir)) return { outcome: 'already', path };
    path = gitText(mainDir, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
    appendLineOnce(path, POOL_EXCLUDE_LINE);
    return isPoolIgnored(mainDir) ? { outcome: 'added', path } : { outcome: 'failed', path, why: '.gitignore re-includes it' };
  } catch (error) {
    return { outcome: 'failed', path, why: error.message };
  }
}
