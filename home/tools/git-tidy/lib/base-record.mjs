// Purpose: the two git config keys that tie lanes to their base: the base a lane was claimed on
//   (`branch.<lane>.cs-lane-base = <base>`) and the mark of a branch that served as a base (`branch.<base>.cs-base = true`).
// Exports: LANE_BASE_KEY, BASE_MARK_KEY, isWorkBranch, readLaneBase, writeLaneBase, markBase, markedBases.
// Invariants: plumbing `git config` with argv only (no shell); the keys live in the branch's own config section, so git moves
//   them on `branch -m` and drops them on `branch -d`. A read that fails for any reason but "not set" throws (never read as
//   unset). A held `config.lock` fails a write at once (git does not wait), so writeLaneBase retries a few times.
//   A work branch (isWorkBranch) is never a base: markBase never marks one and unsets a mark one got before, markedBases skips it.
import { runGit } from './git.mjs';

export const LANE_BASE_KEY = 'cs-lane-base'; // branch.<lane>.cs-lane-base = <base branch>
export const BASE_MARK_KEY = 'cs-base'; // branch.<base>.cs-base = true
const MARK_VALUE = 'true';
const NOT_SET = 1; // `git config --get` and `--get-regexp` exit 1 when nothing matches
const WRITE_RETRY_MS = [50, 100, 200]; // pauses between tries while another git holds config.lock
const PAUSE = new Int32Array(new SharedArrayBuffer(4)); // Atomics.wait on it is a synchronous sleep
const MARK_PATTERN = `^branch\\..*\\.${BASE_MARK_KEY}$`;
const KEY_PREFIX = 'branch.';
const KEY_SUFFIX = `.${BASE_MARK_KEY}`;
const UNSET_MISSING = 5; // `git config --unset-all` exits 5 when the key is not set (another run unset it first)
// A pool lane, tess-write's test branch, an agent's isolated worktree: work that lands on a base, never a base itself.
const WORK_BRANCH_PREFIXES = ['lane/', 'test/', 'worktree-agent-'];

const keyOf = (branch, key) => `${KEY_PREFIX}${branch}.${key}`;
const firstLine = (text) => text.split('\n')[0];

/** True for a work branch (`lane/*`, `test/*`, `worktree-agent-*`): never a base, so never marked as one. */
export const isWorkBranch = (branch) => WORK_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));

/** The value of config `key`, or null when it is not set; any other git failure throws. */
function readKey(dir, key) {
  const read = runGit(dir, ['config', '--get', key]);
  if (read.status === NOT_SET) return null;
  if (read.status !== 0) throw new Error(`git config --get ${key} failed: ${firstLine(read.stderr)}`);
  return read.stdout.trim();
}

/**
 * The base branch the lane `branch` was claimed on, or null when it has no record (an old lane, a hand-made branch).
 * @throws {Error} when git cannot read the config
 */
export const readLaneBase = (dir, branch) => readKey(dir, keyOf(branch, LANE_BASE_KEY));

/**
 * Records that the lane `branch` was claimed on `base`. Tries 1 + 3 times (50, 100, 200 ms apart) while config.lock is held.
 * @throws {Error} naming git's message when every try failed
 */
export function writeLaneBase(dir, branch, base) {
  const key = keyOf(branch, LANE_BASE_KEY);
  let written = runGit(dir, ['config', key, base]);
  for (const pauseMs of WRITE_RETRY_MS) {
    if (written.status === 0) return;
    Atomics.wait(PAUSE, 0, 0, pauseMs);
    written = runGit(dir, ['config', key, base]);
  }
  if (written.status !== 0) throw new Error(`git config ${key} failed: ${firstLine(written.stderr)}`);
}

/**
 * Marks `base` as a base branch, so prune never deletes it and no claim takes it as a lane. A work branch is never marked, and
 * the marks work branches got before this rule (a test branch once checked out in the main checkout) are unset, so prune and
 * claim treat them like any branch again.
 * @returns {string|null} null when all went well (a work branch `base` is left unmarked), else a warning line for the caller to print
 */
export function markBase(dir, base) {
  const warnings = [unmarkWorkBranches(dir), isWorkBranch(base) ? null : markOne(dir, base)].filter((line) => line !== null);
  return warnings.length > 0 ? warnings.join('; ') : null;
}

// Writes the mark of `base` unless it is set; null, or the warning line.
function markOne(dir, base) {
  const key = keyOf(base, BASE_MARK_KEY);
  try {
    if (readKey(dir, key) === MARK_VALUE) return null;
  } catch (error) {
    return `${base} not marked as a base: ${error.message}`;
  }
  const written = runGit(dir, ['config', key, MARK_VALUE]);
  return written.status === 0 ? null : `${base} not marked as a base: git config ${key} failed: ${firstLine(written.stderr)}`;
}

// Unsets every work branch's mark; null, or the warning line of the first that failed (markedBases skips such a mark anyway).
function unmarkWorkBranches(dir) {
  let marked;
  try {
    marked = readMarks(dir);
  } catch (error) {
    return `work branch marks not removed: ${error.message}`;
  }
  for (const branch of marked.filter(isWorkBranch)) {
    const key = keyOf(branch, BASE_MARK_KEY);
    const unset = runGit(dir, ['config', '--unset-all', key]);
    if (unset.status !== 0 && unset.status !== UNSET_MISSING) return `${branch} still marked as a base: git config --unset-all ${key} failed: ${firstLine(unset.stderr)}`;
  }
  return null;
}

/**
 * The branch names marked as a base (`branch.<b>.cs-base = true`), whether or not the branch still exists; a work branch's mark
 * is skipped (it is no base).
 * @throws {Error} when git cannot read the config
 */
export const markedBases = (dir) => readMarks(dir).filter((branch) => !isWorkBranch(branch));

// Every branch name with a mark, work branches included; throws when git cannot read the config.
function readMarks(dir) {
  const read = runGit(dir, ['config', '--null', '--get-regexp', MARK_PATTERN]);
  if (read.status === NOT_SET) return [];
  if (read.status !== 0) throw new Error(`git config --get-regexp ${MARK_PATTERN} failed: ${firstLine(read.stderr)}`);
  // --null: each entry is `<key>\n<value>\0`; git lowercases the section and the key, never the branch name between them.
  return read.stdout.split('\0').filter((entry) => entry !== '')
    .map((entry) => entry.split('\n'))
    .filter(([, value]) => value === MARK_VALUE)
    .map(([key]) => key.slice(KEY_PREFIX.length, -KEY_SUFFIX.length));
}
