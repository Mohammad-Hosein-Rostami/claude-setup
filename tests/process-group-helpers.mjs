// Shared helpers for the tests that start real process groups (process-tree, land and suite kill-tree tests): whether a process
// or a group still exists, a short wait for one to be gone, reading the pids a shell command wrote, and the cleanup kill.
// Exports: POSIX_ONLY, isAlive, groupExists, waitUntil, readPids, killGroupQuietly, elapsedSince.
// Invariants: POSIX only (every caller skips on Windows); a killed orphan is reaped by init a moment after its SIGKILL, so a
//   test waits for it to be gone instead of checking once.
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** The test option that skips a case on Windows, which has no process groups or POSIX signals. */
export const POSIX_ONLY = { skip: process.platform === 'win32' && 'no POSIX signals or process groups on Windows' };
// How often waitUntil checks again.
const POLL_MS = 20;
// Signal 0 delivers nothing: it only asks whether the target exists.
const EXISTS_SIGNAL = 0;

/** True while a process with `pid` exists (EPERM: it exists, but is not ours to signal). */
export function isAlive(pid) {
  try {
    process.kill(pid, EXISTS_SIGNAL);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/**
 * True while the process group `groupId` has any member. Only ESRCH counts as gone: macOS answers EPERM for a group whose
 * members have exited but are not reaped yet.
 */
export function groupExists(groupId) {
  try {
    process.kill(-groupId, EXISTS_SIGNAL);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

/** Waits until `check()` is true or `limitMs` passed; @returns {Promise<boolean>} the last value of `check()`. */
export async function waitUntil(check, limitMs) {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

/**
 * The pids a command wrote to `file` as one line (`echo $$ $! > file`), once the whole line is there.
 * @returns {Promise<number[]>} rejects when the line did not come within `limitMs`.
 */
export async function readPids(file, limitMs) {
  const whole = () => existsSync(file) && readFileSync(file, 'utf8').endsWith('\n');
  if (!(await waitUntil(whole, limitMs))) throw new Error(`no pid line in ${file} within ${limitMs} ms`);
  return readFileSync(file, 'utf8').trim().split(/\s+/).map(Number);
}

/** Cleanup: SIGKILL to the group `groupId`; a group that is already gone (ESRCH, or EPERM on macOS) is fine. */
export function killGroupQuietly(groupId) {
  try {
    process.kill(-groupId, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
  }
}

/** Milliseconds since `startedAt` (a performance.now() value). */
export const elapsedSince = (startedAt) => performance.now() - startedAt;
