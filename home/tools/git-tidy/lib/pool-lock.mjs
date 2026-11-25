// Purpose: the one lock of a repository's lane folder pool, so two sessions that claim, release or reclaim at the same moment take turns
//   and never hand out the same folder.
// Exports: POOL_LOCK_NAME, STALE_POOL_LOCK_MS, POOL_LOCK_WAIT_MS, PoolBusy, withPoolLock.
// Invariants:
// - One lock file per repository, `<git common dir>/cs-lane-pool.lock` (shared by every worktree of the repo), made with O_EXCL and
//   O_NOFOLLOW, 0600, holding `<pid> <32 random hex> <label>`: the holder text is unique, and release removes the file only while it
//   still holds that text, so a holder never removes another's lock. Every open of it goes through hooks/lib/plain-file.mjs
//   openPlainFile (no link followed, no wait, a plain file by fstat of the open descriptor).
// - A lock is stale only when its pid is dead or the file is over STALE_POOL_LOCK_MS old (a live pid on an older lock is a reused pid
//   or a hung holder). One breaker at a time removes a stale lock: it first creates `<lock>.break-<inode>-<mtime>` with O_EXCL, looks
//   again and unlinks the lock only if it is still the very file it judged (same inode and mtime), so a fresh lock someone else took
//   in between is never removed. A breaker file left by a crashed breaker is removed once it is stale by age; until then a waiter
//   treats the lock as held: it pauses between tries and gives up at its deadline like any other wait.
// - A link, FIFO or folder at the lock path is never followed or waited on: the call fails at once (Error), never treated as free.
// - The caller waits at most `waitMs` for a live holder, then PoolBusy (the CLI exits 4); it never waits forever.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { NOT_PLAIN_FILE, openPlainFile } from '../../../hooks/lib/plain-file.mjs';

export const POOL_LOCK_NAME = 'cs-lane-pool.lock';
export const STALE_POOL_LOCK_MS = 120_000; // a claim (worktree add, switch, clean, lock) takes seconds; installs run after the lock
export const POOL_LOCK_WAIT_MS = 60_000; // the longest a claim waits for another session's claim before it gives up (exit 4)
const RETRY_PAUSE_MS = 50;
const TOKEN_BYTES = 16;
const MAX_LOCK_TEXT_BYTES = 512;
const MAX_LABEL_CHARS = 200;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
const PRIVATE_FILE = 0o600;
const HOLDER_PID = /^(\d{1,10}) [0-9a-f]{32}(?: |$)/;
const PAUSE = new Int32Array(new SharedArrayBuffer(4)); // Atomics.wait on it is a synchronous sleep

/** Another live claim, release or reclaim held the pool lock for the whole wait. */
export class PoolBusy extends Error {}

/** Creates the lock holding `text`; false when a lock is already there. */
function createLock(path, text) {
  let fd;
  try {
    ({ fd } = openPlainFile(path, CREATE_FLAGS, PRIVATE_FILE));
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** The lock as `{ text, ino, mtimeMs }`, or null when it is gone; a non-regular file at the path throws. */
function readLock(path) {
  let opened;
  try {
    opened = openPlainFile(path, constants.O_RDONLY);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    const why = error.code === NOT_PLAIN_FILE ? 'is not a plain file' : `cannot be opened (${error.code})`;
    throw new Error(`pool lock ${path} ${why}: remove it by hand if no claim runs`);
  }
  const { fd, stat } = opened;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_LOCK_TEXT_BYTES));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8', 0, read), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** True unless signal 0 says the process is gone (EPERM: it runs under another user). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Why the lock is stale (`pid <n> is gone`, `<n> s old`), or null while its holder may still work. */
function staleWhy(lock, nowMs) {
  const pid = Number(HOLDER_PID.exec(lock.text)?.[1] ?? NaN);
  if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return `pid ${pid} is gone`;
  const ageMs = nowMs - lock.mtimeMs;
  return ageMs > STALE_POOL_LOCK_MS ? `${Math.floor(ageMs / 1000)} s old` : null;
}

function removeIfThere(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Removes the stale lock `seen` when this call is its only breaker and it is still that file.
 * @returns {boolean} true when this call removed it or found it gone or replaced (try to create the lock again at once); false when
 *   another breaker holds the breaker file (the caller pauses and checks its deadline, so a crashed breaker never makes it spin)
 */
function breakStale(path, seen, nowMs) {
  const claim = `${path}.break-${seen.ino}-${Math.trunc(seen.mtimeMs)}`;
  if (!createLock(claim, `${process.pid}`)) {
    const claimStats = lstatSync(claim, { throwIfNoEntry: false });
    if (claimStats !== undefined && nowMs - claimStats.mtimeMs > STALE_POOL_LOCK_MS) removeIfThere(claim); // its breaker crashed
    return false;
  }
  try {
    const now = lstatSync(path, { throwIfNoEntry: false });
    if (now !== undefined && now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) removeIfThere(path);
    return true;
  } finally {
    removeIfThere(claim);
  }
}

/** Removes the lock only while it still holds this holder's text (a breaker may have taken it after a hang). */
function releaseLock(path, text) {
  const lock = readLock(path);
  if (lock !== null && lock.text === text) removeIfThere(path);
}

/**
 * Runs `work` while this process alone holds the pool lock of the repository whose git common dir is `commonDir`.
 * Why: two claims at once must never hand out one folder (F1), and a claim killed midway must not block the pool for good (P7).
 * @template T
 * @param {string} commonDir the absolute git common dir (`git rev-parse --path-format=absolute --git-common-dir`)
 * @param {string} label what the holder does, such as `claim feat/x` (kept in the lock text for a person reading it)
 * @param {() => T} work the claim, release or reclaim; it runs at most once
 * @param {{ waitMs?: number, now?: () => number }} [options] how long to wait for a live holder; the clock (tests)
 * @returns {T} what work returned
 * @throws {PoolBusy} when a live holder kept the lock for `waitMs`; Error when the lock path is not a plain file; whatever work throws
 */
export function withPoolLock(commonDir, label, work, { waitMs = POOL_LOCK_WAIT_MS, now = Date.now } = {}) {
  const path = join(commonDir, POOL_LOCK_NAME);
  const plainLabel = String(label).replace(/[^\w./ -]/g, '_').slice(0, MAX_LABEL_CHARS);
  const text = `${process.pid} ${randomBytes(TOKEN_BYTES).toString('hex')} ${plainLabel}`;
  const deadline = now() + waitMs;
  while (!createLock(path, text)) {
    const seen = readLock(path);
    if (seen === null) continue; // released between the two calls: try to create it again at once
    const stale = staleWhy(seen, now());
    if (stale !== null && breakStale(path, seen, now())) continue; // gone now: try to create it again at once
    // a live holder, or a stale lock another breaker (maybe a crashed one) is working on: wait, but never past the deadline
    const holder = stale === null ? seen.text.trim() || 'no holder text yet' : `stale: ${stale}, another breaker is removing it`;
    if (now() >= deadline) throw new PoolBusy(`the lane pool lock ${path} is held (${holder}); try again when that claim ends`);
    Atomics.wait(PAUSE, 0, 0, RETRY_PAUSE_MS);
  }
  try {
    return work();
  } finally {
    releaseLock(path, text);
  }
}
