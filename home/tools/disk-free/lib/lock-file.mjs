// A lock file for the disk-clean start hook and for `disk-clean --apply`. Exports: takeLock, releaseLock, breakStale (also used by
// long-run's run lock, long-run/lib/run-store.mjs).
// The lock is a file made with O_EXCL (O_NOFOLLOW, O_NONBLOCK: a link or FIFO is never followed or waited on). A lock older than `staleMs`
// belongs to a crashed process and is broken, but never by two processes at once: a breaker first creates a claim file named after the
// stale lock's inode and time with O_EXCL, so only one breaker works on that lock, looks at the lock again, removes it only if it is still
// that same file, and then creates a new lock like everyone else (whoever creates it first wins). A claim file left by a crashed
// breaker is removed once it is older than `staleMs` too. The one gap left: the stale lock's own owner finishing in the microseconds
// between the breaker's second look and its unlink (the owner would have to be hung for more than `staleMs` first).
import { closeSync, constants, lstatSync, openSync, unlinkSync } from 'node:fs';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // not defined on Windows
const NO_BLOCK = constants.O_NONBLOCK ?? 0;
const PRIVATE_FILE = 0o600;

function statOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeIfThere(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** Creates the file; false when it exists. */
function createExclusive(path) {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW | NO_BLOCK, PRIVATE_FILE));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

const sameFile = (a, b) => b !== null && a.ino === b.ino && a.mtimeMs === b.mtimeMs;

/** Removes the stale lock `seen` if this call is the only breaker of it and it is still that file; true when it is gone by this call. */
export function breakStale(lockPath, seen, nowMs, staleMs) {
  const claim = `${lockPath}.break-${seen.ino}-${seen.mtimeMs}`;
  if (!createExclusive(claim)) {
    const claimInfo = statOrNull(claim);
    if (claimInfo !== null && nowMs - claimInfo.mtimeMs >= staleMs) removeIfThere(claim); // its breaker crashed; the next start tries again
    return false;
  }
  try {
    if (!sameFile(seen, statOrNull(lockPath))) return false;
    removeIfThere(lockPath);
    return true;
  } finally {
    removeIfThere(claim);
  }
}

/**
 * @param {string} lockPath
 * @param {number} nowMs
 * @param {number} staleMs a lock older than this was left by a crashed process
 * @returns {boolean} true when this call now holds the lock (release it with releaseLock); false when someone else holds it
 */
export function takeLock(lockPath, nowMs, staleMs) {
  if (createExclusive(lockPath)) return true;
  const seen = statOrNull(lockPath);
  if (seen === null) return createExclusive(lockPath); // released between the two calls
  if (nowMs - seen.mtimeMs < staleMs) return false;
  return breakStale(lockPath, seen, nowMs, staleMs) && createExclusive(lockPath);
}

/** Removes the lock file; a lock a stale-lock breaker already removed is not an error. */
export const releaseLock = removeIfThere;
