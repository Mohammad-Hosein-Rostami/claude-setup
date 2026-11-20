// The `claude` process that owns a hook, found by walking up the process tree with `ps`, inside the hook's time budget.
// Exports: findOwnerPid(startPid, lookup, timeLeft), lazyProcessKey(timeLeft, lookup), psLookup(pid, timeoutMs), PS_TIMEOUT_MS,
// MAX_ANCESTOR_DEPTH. Used by mode.mjs, which keys a session's mode by this process so that it survives /clear (moved out of
// mode.mjs in round 9, lane r9-mode-fix, together with the budget).
// Time (reviews of p0-0.1: review4 R4-1, security4 R4-3): a walk that meets no `claude` process makes up to MAX_ANCESTOR_DEPTH
// lookups of up to PS_TIMEOUT_MS each, 6,000 ms against a hook timeout of 5,000 ms, and Claude Code drops the whole output of a
// hook that passes its timeout. So every lookup gets min(PS_TIMEOUT_MS, what is left of the caller's budget), and with nothing
// left the walk stops: the owner is unknown and the caller keeps session-id state only, as on Windows, which has no `ps`.
// Hostile input: `ps` is found through PATH, which a project's settings `env` can set; a planted `ps` gets nothing a project
// hook in the same trusted settings could not run already. Its output is used only when it is one line `<ppid> <command>`, so
// only digits reach a state key; it can still name any pid as the owner, and so pick the process key a mode is saved under.
// At its timeout a lookup is ended with SIGKILL: a `ps` that ignores SIGTERM held the hook 9 s (security review 1, S3).
// Invariants: never throws; a lookup that fails or times out ends the walk (reported on stderr); the result is cached.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export const MAX_ANCESTOR_DEPTH = 6; // hook -> shell -> claude is 2 levels; leave room for wrappers
export const PS_TIMEOUT_MS = 1000;
const MIN_PS_TIMEOUT_MS = 1; // execFileSync reads a timeout of 0 as "no timeout", so a lookup never gets less than this
const INIT_PID = 1;
const CLAUDE_COMMAND = /^claude/;
const PS_LINE = /^(\d+)\s+(.+)$/; // one line only: `.` matches no line feed
const NO_LIMIT = () => Infinity;

/**
 * Walk up the process tree to the `claude` process that owns this hook.
 * @param {number} startPid - first pid to inspect (the hook's parent).
 * @param {(pid: number, timeoutMs: number) => {ppid: number, command: string} | undefined} lookup - process info for a pid,
 *   found within `timeoutMs`.
 * @param {() => number} [timeLeft] - milliseconds left of the hook's budget; the default sets no limit.
 * @returns {number | undefined} the owner pid, or undefined when none is found within MAX_ANCESTOR_DEPTH lookups or the budget.
 */
export function findOwnerPid(startPid, lookup, timeLeft = NO_LIMIT) {
  let pid = startPid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && pid > INIT_PID; depth += 1) {
    const timeoutMs = Math.floor(Math.min(PS_TIMEOUT_MS, timeLeft()));
    if (!(timeoutMs >= MIN_PS_TIMEOUT_MS)) return undefined; // the budget is used up (or is not a number): owner unknown
    const info = lookup(pid, timeoutMs);
    if (!info) return undefined;
    if (CLAUDE_COMMAND.test(basename(info.command))) return pid;
    pid = info.ppid;
  }
  return undefined;
}

/**
 * One `ps` call for a pid.
 * @param {number} pid - the process to look up.
 * @param {number} timeoutMs - `ps` is killed (SIGKILL) after this long.
 * @returns {{ppid: number, command: string} | undefined} its parent and command; undefined when `ps` fails, times out or prints
 *   anything but one line of that form.
 */
export function psLookup(pid, timeoutMs) {
  try {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' }).trim();
    const match = PS_LINE.exec(line);
    return match ? { ppid: Number(match[1]), command: match[2] } : undefined;
  } catch (error) {
    process.stderr.write(`mode hook: ps failed, mode will not survive /clear: ${error.message}\n`);
    return undefined;
  }
}

/**
 * Lazy state key for the owning claude process: the walk runs only when the key is first asked for (so never when the
 * session file answers) and the result is cached. Windows has no `ps`: the key is undefined (session id only).
 * @param {() => number} [timeLeft] - milliseconds left of the hook's budget when the walk runs; the default sets no limit.
 * @param {(pid: number, timeoutMs: number) => {ppid: number, command: string} | undefined} [lookup] - for tests: a fake `ps`.
 * @returns {() => string | undefined} getter for `pid-<n>`, or undefined when there is no owner process.
 */
export function lazyProcessKey(timeLeft = NO_LIMIT, lookup = psLookup) {
  let computed = false;
  let key;
  return () => {
    if (!computed) {
      computed = true;
      if (process.platform !== 'win32') {
        const pid = findOwnerPid(process.ppid, lookup, timeLeft);
        key = pid === undefined ? undefined : `pid-${pid}`;
      }
    }
    return key;
  };
}
