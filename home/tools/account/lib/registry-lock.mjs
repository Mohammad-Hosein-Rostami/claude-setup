// Purpose: one writer at a time for accounts.json: every read-change-write of the list runs while this process holds
// the lock file `accounts.json.lock` in the accounts folder (review 1, R6: two adds at once lost an account).
// Exports: withRegistryLock, LOCK_FILE, LOCK_STALE_MS, LOCK_WAIT_MS.
// Invariants: the lock is created with O_EXCL (flag `wx`, mode 0600) in the 0700 folder, so only one process can hold
// it; it holds the holder's pid. A lock whose holder is gone, or that is older than LOCK_STALE_MS (more than the
// longest step done under it: one Keychain call, 20 s), is stale and taken over. A waiter sleeps between tries (no busy
// loop) and gives up after LOCK_WAIT_MS with an error that names the file and the way out. The lock is removed in
// `finally`. Left open: two waiters that find the same stale lock at the same moment may both take it (a stale lock
// needs a crash first; accepted).
import { closeSync, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from './private-fs.mjs';
import { AccountError } from './names.mjs';
import { assertPrivateDir, readPrivateFile } from './private-file.mjs';

export const LOCK_FILE = 'accounts.json.lock';
/** A lock older than this is stale (ms): above the 20 s timeout of the one Keychain call made under the lock. */
export const LOCK_STALE_MS = 30000;
/** How long a caller waits for the lock before it gives up (ms): above LOCK_STALE_MS, so a stale lock is taken over first. */
export const LOCK_WAIT_MS = 40000;
const RETRY_MIN_MS = 10;
const RETRY_MAX_MS = 100;
const PID_MAX_BYTES = 32;
const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const sleep = (ms) => Atomics.wait(pause, 0, 0, ms);

function holderAlive(path) {
  let pid;
  try {
    pid = Number(readPrivateFile(path, PID_MAX_BYTES));
  } catch {
    return true; // unreadable (being written, or not ours): only its age can make it stale
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** True when the lock at `path` was taken over (removed) because its holder is gone or it is too old. */
function takeOverStale(path, now, staleMs) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return true;
  if (now - stat.mtimeMs <= staleMs && holderAlive(path)) return false;
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return true;
}

function tryLock(path) {
  try {
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Runs `change` while this process holds the lock of the accounts folder.
 * @param {string} dir the accounts folder (made 0700 when missing).
 * @param {() => any} change the read-change-write; its value is returned.
 * @param {{waitMs?: number, staleMs?: number}} options shorter bounds for tests.
 * @throws {AccountError} kind `locked` when the lock cannot be had within `waitMs`; `unsafe-file` for a folder open to others.
 */
export function withRegistryLock(dir, change, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  ensurePrivateDir(dir);
  assertPrivateDir(dir);
  const path = join(dir, LOCK_FILE);
  const deadline = Date.now() + waitMs;
  while (!tryLock(path)) {
    if (takeOverStale(path, Date.now(), staleMs)) continue;
    if (Date.now() >= deadline) throw new AccountError('locked', `the account list is in use by another claude-account run (lock file ${path}); try again. If no claude-account is running, remove that file.`);
    sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS)));
  }
  try {
    return change();
  } finally {
    unlinkSync(path);
  }
}
