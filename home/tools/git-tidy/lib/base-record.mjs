// Purpose: the two git config keys that tie lanes to their base: the base a lane was claimed on
//   (`branch.<lane>.cs-lane-base = <base>`) and the mark of a branch that served as a base (`branch.<base>.cs-base = true`).
// Exports: LANE_BASE_KEY, BASE_MARK_KEY, readLaneBase, writeLaneBase, markBase, markedBases.
// Invariants: plumbing `git config` with argv only (no shell); the keys live in the branch's own config section, so git moves
//   them on `branch -m` and drops them on `branch -d`. A read that fails for any reason but "not set" throws (never read as
//   unset). A held `config.lock` fails a write at once (git does not wait), so writeLaneBase retries a few times.
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

const keyOf = (branch, key) => `${KEY_PREFIX}${branch}.${key}`;
const firstLine = (text) => text.split('\n')[0];

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
 * Marks `base` as a base branch, so prune never deletes it and no claim takes it as a lane.
 * @returns {string|null} null when it is marked (now or before), else a warning line for the caller to print
 */
export function markBase(dir, base) {
  const key = keyOf(base, BASE_MARK_KEY);
  try {
    if (readKey(dir, key) === MARK_VALUE) return null;
  } catch (error) {
    return `${base} not marked as a base: ${error.message}`;
  }
  const written = runGit(dir, ['config', key, MARK_VALUE]);
  return written.status === 0 ? null : `${base} not marked as a base: git config ${key} failed: ${firstLine(written.stderr)}`;
}

/**
 * The branch names marked as a base (`branch.<b>.cs-base = true`), whether or not the branch still exists.
 * @throws {Error} when git cannot read the config
 */
export function markedBases(dir) {
  const read = runGit(dir, ['config', '--null', '--get-regexp', MARK_PATTERN]);
  if (read.status === NOT_SET) return [];
  if (read.status !== 0) throw new Error(`git config --get-regexp ${MARK_PATTERN} failed: ${firstLine(read.stderr)}`);
  // --null: each entry is `<key>\n<value>\0`; git lowercases the section and the key, never the branch name between them.
  return read.stdout.split('\0').filter((entry) => entry !== '')
    .map((entry) => entry.split('\n'))
    .filter(([, value]) => value === MARK_VALUE)
    .map(([key]) => key.slice(KEY_PREFIX.length, -KEY_SUFFIX.length));
}
