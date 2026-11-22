// The state files of the session-notes hook in ~/.claude/state/modes (the folder keeps its name from the removed modes): the
// compaction counts (compact-notes.mjs), the owner's check switch (checks-on.mjs) and their prune.
// Exports: readStateText(file, what), writeStateText(dir, name, text), removeStateFile(dir, name), pruneState(dir, timeLeft, nowMs),
// isStale(mtimeMs, nowMs), STATE_FILE_MAX_BYTES, MAX_PRUNED_ENTRIES. Used by session-notes.mjs, compact-notes.mjs, checks-on.mjs and
// smart-check/ledger.mjs (moved out of the hook in round 9, lane r9-mode-fix, fix round 1: security review 1, S4 and S5). The stderr
// lines keep their "mode hook:" prefix, which tests pin.
// Why: the files were opened by name. Whoever can write the state folder (the same user, or a program run as that user) could
// plant a FIFO, which hung the hook until Claude Code dropped its whole output, or a link, which the hook wrote a state through;
// a large file was read whole; the prune had no bound and ended at the first entry it could not handle.
// Invariants: no call waits and none follows a link at the file's own name. A read (lib/plain-file.mjs: O_NOFOLLOW, O_NONBLOCK,
// fstat) returns text only from a regular file of at most STATE_FILE_MAX_BYTES; anything else is "no state", reported on stderr
// unless the file is just missing. A write goes to a new temp file in the same folder (its name starts with a dot, which no state
// key does: keys are built from ids of `[\w-]+`; opened with O_EXCL, so never through a link) and is renamed over the name: a
// link, a FIFO or an old file there is replaced as a whole, never written through, and a reader sees the old text or the new one.
// A failed write removes its temp file and throws. A removal unlinks the name itself (a link there is removed, never its
// target). The prune reads at most MAX_PRUNED_ENTRIES names per run and stops when the
// hook's budget is used up; each entry is judged by itself from an lstat (a stale link is removed, never what it leads to), and
// one that cannot be removed (a folder) is reported on stderr and does not end the run. Never throws, except writeStateText.
// Not covered: the folders on the way to the state folder (a link there is followed), and Windows, which has neither open flag.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, opendirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlainFile } from './plain-file.mjs';

export const STATE_FILE_MAX_BYTES = 64; // a count and a line feed; a longer file is not one of the hook's own
// Names read per prune run. The folder holds a few files per session of the last 14 days (267 entries seen); a folder with more
// is worked off over the next runs: stale entries among the names read are removed, so later runs read further ones.
export const MAX_PRUNED_ENTRIES = 2000;
const STATE_MAX_AGE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TEMP_PREFIX = '.tmp-';
const EXCLUSIVE_WRITE = 'wx'; // O_CREAT | O_EXCL: fails on a name that exists, and never opens through a link

/**
 * Whether a state file is older than the retention window.
 * @param {number} mtimeMs - file modification time.
 * @param {number} nowMs - current time.
 * @returns {boolean} true when it should be deleted.
 */
export function isStale(mtimeMs, nowMs) {
  return nowMs - mtimeMs > STATE_MAX_AGE_DAYS * MS_PER_DAY;
}

/**
 * The text of one state file.
 * @param {string} file - its path.
 * @param {string} [what] - what the file holds, for the stderr line.
 * @returns {string | undefined} the text; undefined when the file is missing, or is a link, a FIFO, a folder or longer than
 *   STATE_FILE_MAX_BYTES (reported on stderr; a missing file is not). Never throws, never waits.
 */
export function readStateText(file, what = 'state') {
  try {
    return readPlainFile(file, STATE_FILE_MAX_BYTES);
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: cannot read ${what}: ${error.message}\n`);
    return undefined;
  }
}

/**
 * Writes one state file as a whole: a temp file in the same folder, renamed over the name.
 * @param {string} dir - the state folder (made when missing).
 * @param {string} name - the file's name in it.
 * @param {string} text - what it holds from now on.
 * @throws {Error} when the folder cannot be made or the file cannot be written or renamed (a folder stands in its place); the
 *   temp file is removed first.
 */
export function writeStateText(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `${TEMP_PREFIX}${process.pid}-${randomUUID()}`); // unique per write: two hooks never share one
  try {
    writeFileSync(temp, text, { flag: EXCLUSIVE_WRITE });
    renameSync(temp, join(dir, name));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Removes one state file, so that nothing reads its old text again.
 * @param {string} dir - the state folder.
 * @param {string | undefined} name - the file's name in it; nothing to do without one.
 * @returns {void} never throws: a missing file is fine, any other failure (a folder in its place) is reported on stderr.
 */
export function removeStateFile(dir, name) {
  if (!name) return;
  try {
    unlinkSync(join(dir, name)); // of a link itself, never what it leads to
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: cannot remove state: ${error.message}\n`);
  }
}

/** Up to MAX_PRUNED_ENTRIES names of a folder, in the order the disk lists them; none when it is missing. */
function someNames(dir) {
  const names = [];
  let folder;
  try {
    folder = opendirSync(dir);
    for (let entry = folder.readSync(); entry !== null && names.length < MAX_PRUNED_ENTRIES; entry = folder.readSync()) names.push(entry.name);
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: prune failed: ${error.message}\n`);
  } finally {
    folder?.closeSync();
  }
  return names;
}

/** Removes one entry when it is stale; an entry that is gone already is fine, any other failure (a folder) is reported. */
function removeIfStale(path, nowMs) {
  try {
    const entry = lstatSync(path); // of a link itself: its target is never looked at or removed
    if (isStale(entry.mtimeMs, nowMs)) unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`mode hook: prune failed: ${error.message}\n`);
  }
}

/**
 * Removes the stale entries among the first MAX_PRUNED_ENTRIES of the state folder, while the hook's budget lasts.
 * @param {string} dir - the state folder; a missing one is nothing to do.
 * @param {() => number} timeLeft - milliseconds left of the hook's budget, asked before the listing and before every entry.
 * @param {number} [nowMs] - the current time.
 */
export function pruneState(dir, timeLeft, nowMs = Date.now()) {
  if (!(timeLeft() > 0)) return;
  for (const name of someNames(dir)) {
    if (!(timeLeft() > 0)) return;
    removeIfStale(join(dir, name), nowMs);
  }
}
