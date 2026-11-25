// A lock file that makes hooks take turns on the files of one store folder, built on lib/session-store.mjs.
// Exports: withSessionLock(dir, session, work, { lockFile, waitMs }?) -> work's result | undefined; BREAKER_SUFFIX (the breaker file's suffix, for
// a caller that names a file that blocks the lock).
// Why: two hooks that read and write one session file at the same moment must not drop each other's change, and a hook killed
// mid-turn must not block the store for good.
// Invariants:
// - The lock is a new file <session>.lock (or the caller's lockFile name; O_EXCL, O_NOFOLLOW, 0600) in the checked folder holding `<pid> <random token>`.
//   After the turn it is removed only while it still holds that token. A lock is left behind, and removed, when it is dated more than
//   LOCK_CLOCK_SKEW_MS ahead (a clock change, a planted file), older than HELD_LOCK_MAX_MS, or older than STALE_LOCK_MS with its pid
//   gone or no `<pid> <token>` text (a killed holder, an older version's empty lock). One waiter at a time removes such a lock: it
//   first creates `<lock>.break` (O_EXCL, `<pid> <token>` text); a waiter that cannot create it treats the lock as busy, and the
//   breaker deletes that file when done (a `.break` file that is stale by the same rule is removed by the next waiter). Under it the
//   lock is read again and renamed aside only if it is still the one judged stale, so many waiters on one stale lock never delete a
//   lock another took. Left over: if the stale lock's own holder releases in the instant before the rename and two callers then take
//   the name, the lock moved aside is deleted (a lost mutual exclusion, not a crash). Worst wait a caller sees: LOCK_WAIT_MS (1 s),
//   after which it stores nothing; after a killed holder the next caller waits until that lock is STALE_LOCK_MS old (about 0.5 s).
//   A caller that must not wait (the status line render) passes waitMs 0: one try, one stale check (a stale lock is removed for the
//   next call), then nothing is stored.
//   A link, FIFO or folder at the lock's or the breaker's name makes the store unusable.
// - Nothing here throws.
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CREATE_FLAGS, FILE_MODE, isPrivateFile, isSessionId, lstatOrNull, privateFolder, READ_FLAGS, sameNode, TEMP_NAME_BYTES } from './session-store.mjs';

const LOCK_WAIT_MS = 1000; // the longest a hook waits for its turn; a turn (one read, one write) takes about 1 ms
const LOCK_PAUSE_MS = 2; // between two tries for the lock
const STALE_LOCK_MS = 500; // no turn takes this long: such a lock was left by a hook killed during its turn
const LOCK_CLOCK_SKEW_MS = 1000; // a lock's time may run this far ahead of the clock; further ahead, no running hook made it
// A lock whose process still runs is taken only past this age: the slowest turn measured was 185 ms (the status tool, removed
// 2026-11-24, on a 4 MiB file), so a live pid on an older lock is a reused pid, not a holder.
const HELD_LOCK_MAX_MS = 5000;
export const BREAKER_SUFFIX = '.break'; // `<lock>.break`: held by the one waiter that is removing a stale lock
const LOCK_TOKEN_BYTES = 16; // the random half of the lock's text `<pid> <32 hex>`: release compares it, so it never removes another's lock
const LOCK_TEXT_MAX_BYTES = 64; // `<pid> <32 hex>` is at most 43 bytes
const LOCK_OWNER = /^(\d{1,10}) [0-9a-f]{32}$/;
const LOCK_FILE_NAME = /^\.?[A-Za-z0-9_-]{1,100}\.[a-z-]{1,20}$/; // `<session>.lock`, `.<name>.status-lock`: one name, no path
const PAUSE = new Int32Array(new SharedArrayBuffer(4)); // Atomics.wait on it is a synchronous sleep

/**
 * Runs work while this caller alone holds the lock dir/<session>.lock (see the header), so a read and a write of the session file
 * inside work never drop a change another hook makes at the same moment.
 * @template T
 * @param {string} dir the store folder (made 0700 when missing)
 * @param {string} session the session id (see isSessionId)
 * @param {() => T} work the read and the write; it runs at most once
 * @param {{lockFile?: string, waitMs?: number}} [options] lockFile: the lock's file name in dir instead of `<session>.lock`, for a folder other tools
 *   write lock files into; one name with an extension, no path (LOCK_FILE_NAME); waitMs:
 *   how long to wait for a taken lock, 0 to LOCK_WAIT_MS (the default); 0 tries once
 * @returns {T | undefined} what work returned; undefined when the id, lock name or waitMs is bad, the store is unusable, the lock
 *   stayed taken for waitMs, or anything failed
 */
export function withSessionLock(dir, session, work, { lockFile = `${session}.lock`, waitMs = LOCK_WAIT_MS } = {}) {
  try {
    const usable = isSessionId(session) && LOCK_FILE_NAME.test(lockFile) && waitMs >= 0 && waitMs <= LOCK_WAIT_MS;
    const folder = usable ? privateFolder(dir) : undefined;
    if (folder === undefined) return undefined;
    const lock = join(dir, lockFile);
    const token = `${process.pid} ${randomBytes(LOCK_TOKEN_BYTES).toString('hex')}`;
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (takeLock(lock, token)) return runAndRelease(work, { dir, folder, lock, token });
      // still taken at the deadline: nothing is stored, as for any other unusable store
      if (!clearStaleLock(dir, folder, lock) || Date.now() >= deadline) return undefined;
      Atomics.wait(PAUSE, 0, 0, LOCK_PAUSE_MS);
    }
  } catch {
    return undefined;
  }
}

/** @returns {boolean} true when this call created the lock (holding token); false when it exists already (any other error throws) */
function takeLock(lock, token) {
  try {
    writeFileSync(lock, token, { flag: CREATE_FLAGS, mode: FILE_MODE }); // a write cut short leaves a lock without a token: stale at 0.5 s
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/** @returns {{stats: import('node:fs').Stats, text: string} | null} the lock read through one checked handle; null when it is gone */
function readLock(lock) {
  let fd;
  try {
    fd = openSync(lock, READ_FLAGS);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { stats, text: '' }; // never read a FIFO or device that was swapped in
    const buffer = Buffer.alloc(LOCK_TEXT_MAX_BYTES);
    return { stats, text: buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0)) };
  } finally {
    closeSync(fd);
  }
}

/** @returns {boolean} true when the lock still holds token; false when it is gone, changed or cannot be read (then it is not ours) */
function holdsToken(lock, token) {
  try {
    return readLock(lock)?.text === token;
  } catch {
    return false; // a link or special file now at the lock's name: not our lock, so it is left alone
  }
}

/** @returns {boolean} false only when the process is known to be gone (ESRCH); EPERM means it runs under another user */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/** Whether a held lock was left behind: see the header for the three cases. */
function isStale(held, nowMs) {
  const age = nowMs - held.stats.mtimeMs;
  if (age < -LOCK_CLOCK_SKEW_MS || age > HELD_LOCK_MAX_MS) return true;
  if (age <= STALE_LOCK_MS) return false;
  const owner = LOCK_OWNER.exec(held.text);
  return owner === null || !isAlive(Number(owner[1]));
}

/**
 * Removes a lock that was left behind (see isStale), one waiter at a time (breakStaleLock).
 * @returns {boolean} false when something other than this user's regular file holds the lock's or its breaker's name
 */
function clearStaleLock(dir, folder, lock) {
  const seen = lstatOrNull(lock);
  if (seen === null) return true; // released meanwhile: the next try takes it
  if (!isPrivateFile(seen)) return false;
  const held = readLock(lock);
  if (held === null) return true;
  if (!isPrivateFile(held.stats)) return false; // swapped after the lstat
  if (!isStale(held, Date.now())) return true;
  return !sameNode(lstatSync(dir), folder) || breakStaleLock(lock, held);
}

/**
 * Removes the lock judged stale (held) while holding `<lock>.break`, so no other waiter renames anything at the lock's name at the
 * same time. A waiter that cannot take the breaker file leaves the lock for its holder (a busy lock for it); a breaker file that is
 * stale itself (a waiter killed here) is removed.
 * @returns {boolean} false when something other than this user's regular file sits at the breaker's name
 */
function breakStaleLock(lock, held) {
  const breaker = `${lock}${BREAKER_SUFFIX}`;
  const token = `${process.pid} ${randomBytes(LOCK_TOKEN_BYTES).toString('hex')}`;
  if (!takeLock(breaker, token)) return clearStaleBreaker(breaker);
  try {
    const again = readLock(lock); // another waiter may have replaced the stale lock before this one got the breaker
    if (again !== null && sameNode(again.stats, held.stats) && again.text === held.text) removeStaleLock(lock, held);
  } finally {
    if (holdsToken(breaker, token)) rmSync(breaker, { force: true });
  }
  return true;
}

/** @returns {boolean} false when something other than this user's regular file sits at the breaker's name; a stale breaker is removed */
function clearStaleBreaker(breaker) {
  const seen = readLock(breaker);
  if (seen === null) return true;
  if (!isPrivateFile(seen.stats)) return false;
  if (!isStale(seen, Date.now())) return true;
  const again = readLock(breaker); // not removed if another waiter replaced it since
  if (again !== null && sameNode(again.stats, seen.stats) && again.text === seen.text) rmSync(breaker, { force: true });
  return true;
}

/**
 * Removes the lock judged stale (held) with no gap between the check and the delete: it is renamed to a unique name first (one
 * atomic step), then checked and deleted. Only the holder of the breaker file calls this. When the renamed file is not the one judged
 * stale (its holder released and a new caller took the lock in the instant since breakStaleLock read it), it is linked back at once.
 * @throws EEXIST when a third caller took the free name meanwhile (the moved lock is then gone); any other error of the rename (but
 *   ENOENT), the read or the link
 */
function removeStaleLock(lock, held) {
  const aside = `${lock}.${randomBytes(TEMP_NAME_BYTES).toString('hex')}.stale`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return; // released or cleared meanwhile: the next try takes it
    throw error;
  }
  try {
    const moved = readLock(aside);
    const judged = moved !== null && sameNode(moved.stats, held.stats) && moved.text === held.text;
    // a live lock moved by mistake: back under its name (same file, same mtime); EEXIST (a third caller took the name) throws, and
    // withSessionLock then gives up as for a busy lock
    if (!judged) linkSync(aside, lock);
  } finally {
    rmSync(aside, { force: true }); // the stale lock itself, or the extra name of the lock put back
  }
}

/** Runs work, then removes the lock while dir is still the checked folder and the lock still holds this caller's token. */
function runAndRelease(work, { dir, folder, lock, token }) {
  try {
    return work();
  } finally {
    if (holdsToken(lock, token) && sameNode(lstatSync(dir), folder)) rmSync(lock, { force: true });
  }
}
