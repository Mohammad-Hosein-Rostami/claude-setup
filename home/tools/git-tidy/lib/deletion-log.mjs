// Purpose: the deletion log `<git common dir>/cs-tidy-log.jsonl`. `prune --apply` (and so land's sweep) writes each branch it
//   is about to delete, with its sha, so it can be restored (`git branch <name> <sha>`) while git still keeps the commit
//   (`gc.pruneExpire`, 2 weeks by default).
// Exports: recordDeletion, checkDeletionLog, LOG_FILE.
// Invariants: one JSON object per line, appended (`{"deleted": {branch, sha, reason, at}}`); a record after a torn last line
//   (no newline) starts a line of its own. The log is opened only as a regular file (hooks/lib/plain-file.mjs openPlainFile:
//   checked by fstat on the open descriptor): never through a symbolic link (it would write outside .git), never blocking (a
//   FIFO in its place); anything else in its place is refused with a UsageError that names the path, so prune refuses the apply.
//   Nothing reads the log to decide anything: it is a restore record for people.
import { closeSync, constants, fstatSync, lstatSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { NOT_PLAIN_FILE, openPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { UsageError, gitText } from './git.mjs';

export const LOG_FILE = 'cs-tidy-log.jsonl';
const APPEND_FLAGS = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT;
const OWNER_ONLY = 0o600;
const NEWLINE = 0x0a;

// The log's path per folder, read once: prune records each deletion, and one git call per deleted branch would add up.
const logPaths = new Map();
function logPath(dir) {
  if (!logPaths.has(dir)) logPaths.set(dir, join(gitText(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']), LOG_FILE));
  return logPaths.get(dir);
}

// Opens the log for appending, creating it; throws, naming the path, for anything but a regular file.
function openLog(path) {
  const unsafe = (why) => new UsageError(`the deletion log ${path} ${why}; move it away to delete branches again`);
  // The lstat names a link plainly, and is the only link check where O_NOFOLLOW is missing (Windows).
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw unsafe('is a symbolic link');
  try {
    return openPlainFile(path, APPEND_FLAGS, OWNER_ONLY).fd;
  } catch (error) {
    throw unsafe(error.code === NOT_PLAIN_FILE ? 'is not a regular file' : `cannot be opened (${error.code ?? error.message})`);
  }
}

// True when the open log `fd` is empty or ends with a newline, so the next record starts a line of its own.
function endsWithNewline(fd) {
  const { size } = fstatSync(fd);
  if (size === 0) return true;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last[0] === NEWLINE;
}

/** Throws UsageError (naming the path) unless the deletion log of the repository at `dir` is safe to write; creates it if missing. */
export function checkDeletionLog(dir) {
  closeSync(openLog(logPath(dir)));
}

/**
 * Appends that `branch` at `sha` is deleted and why, at `at` (ms), before the delete, so it can be restored. Throws when the
 * record cannot be written: the caller then keeps the branch.
 */
export function recordDeletion(dir, { branch, sha, reason, at = Date.now() }) {
  const fd = openLog(logPath(dir));
  try {
    const start = endsWithNewline(fd) ? '' : '\n';
    writeSync(fd, `${start}${JSON.stringify({ deleted: { branch, sha, reason, at } })}\n`);
  } finally {
    closeSync(fd);
  }
}
