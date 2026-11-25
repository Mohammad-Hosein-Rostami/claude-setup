// Purpose: keep a repository's lane pool (`.claude/worktrees/`) out of its `git status`, land's checks and `git add -A` (which would
//   add each lane as an embedded repository): a claim appends POOL_EXCLUDE_LINE to the local info/exclude when git does not ignore the
//   pool yet. info/exclude is never committed, so the project's own files stay as they are.
// Exports: POOL_EXCLUDE_LINE, ignorePool.
// Invariants:
// - Runs under the pool lock (lane-pool.mjs claimLane), so two claims never append the line twice; a file that already holds the line
//   gets no second copy.
// - Only a plain file (or a missing one, then made with mode 0644) is written: a link at info/ or info/exclude, or anything but a
//   plain file at info/exclude, is never followed or written, and the outcome is `failed`. The path is built from the common dir
//   (git gives it with links resolved), never from `--git-path`, which resolves a link below it too. lstat checks refuse a link
//   up front (so nothing is made through one); the open (hooks/lib/plain-file.mjs openPlainFile: O_NOFOLLOW where the system has
//   it, fstat of the open descriptor) refuses a link or non-plain file swapped in at info/exclude after that check; and before a
//   byte is written, info/ must still be no link and the open file the very one at info/exclude (same device and inode), so a
//   link swapped in at info/ for the open is never written through.
// - Never throws: every failure is the `failed` outcome, and the claim goes on.
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { gitText, runGit } from './git.mjs';

export const POOL_EXCLUDE_LINE = '/.claude/worktrees/';
const POOL_PATH = '.claude/worktrees/'; // the pool folder as check-ignore reads it, relative to the main worktree
const NOT_IGNORED = 1; // `git check-ignore -q` exits 0 when a rule ignores the path, 1 when none does
const APPEND_FLAGS = fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT;
const EXCLUDE_MODE = 0o644;

const isLink = (path) => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/** True when git ignores the pool folder in `mainDir`; throws when git cannot tell. */
function isPoolIgnored(mainDir) {
  const checked = runGit(mainDir, ['check-ignore', '-q', POOL_PATH]);
  if (checked.status === 0) return true;
  if (checked.status === NOT_IGNORED) return false;
  throw new Error(`git check-ignore failed: ${checked.stderr.split('\n')[0]}`);
}

/**
 * Appends `line` to the plain file at `path` (made with its folder when missing) unless a line there already equals it.
 * @throws {Error} when `path` or its folder is a link (also one swapped in while the file was opened), or `path` is anything but
 *   a plain file: nothing is written, and the message says why
 */
function appendLineOnce(path, line) {
  const folder = dirname(path);
  const linked = [folder, path].find(isLink);
  if (linked !== undefined) throw new Error(`not added to ${path}: ${linked} is a link, never followed`);
  mkdirSync(folder, { recursive: true });
  const { fd, stat } = openPlainFile(path, APPEND_FLAGS, EXCLUDE_MODE);
  try {
    // Node has no openat, so a link swapped in at info/ just before the open sends it elsewhere: write only when info/ is still no
    // link and the open file is the one at the path now (a file found through a link has another inode).
    const atPath = lstatSync(path, { throwIfNoEntry: false });
    if (isLink(folder) || atPath?.dev !== stat.dev || atPath?.ino !== stat.ino) {
      throw new Error(`not added to ${path}: ${folder} or the file changed while it was opened, never written through`);
    }
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
    path = join(gitText(mainDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'info', 'exclude');
    appendLineOnce(path, POOL_EXCLUDE_LINE);
    return isPoolIgnored(mainDir) ? { outcome: 'added', path } : { outcome: 'failed', path, why: '.gitignore re-includes it' };
  } catch (error) {
    return { outcome: 'failed', path, why: error.message };
  }
}
