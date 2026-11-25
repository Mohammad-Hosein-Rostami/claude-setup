// Purpose: end a process and everything it started. Every tool that runs a command ends it here, so they all end a tree the
//   same way: `land` (the lane's test), `suite` (a test command) and `long-run` (a boss, a step check).
//   A `claude -p` boss runs in its own process group, but a subagent's Bash runs in a group of its own (live test 2026-11-24),
//   so for a boss a group signal alone can leave it running: long-run reads the tree before each signal (listDescendants) and
//   ends whatever of it outlives the boss afterwards (sweepDescendants).
// Exports: TERM_GRACE_MS, signalProcessTree, endProcessTree, listDescendants, sweepDescendants.
// Invariants:
// - POSIX: the child was spawned `detached`, so it leads a process group whose id is its pid, and the negative pid reaches the
//   whole group. A group with nothing left to signal is not an error: ESRCH (every member has exited) or EPERM (what macOS
//   says for a group left with only exited, zombie, members).
// - Windows has no process groups or signals: `taskkill /T` walks the tree, with `/F` (forced) for SIGKILL.
// - The tree is read on POSIX only (`ps -A -o pid=,ppid=,pgid=`); on Windows `taskkill /T` already walks it, so it is empty
//   there. A pid is ended only while it still has the process group it had when it was seen (a reused pid has another), and
//   the caller's own pid is never in a tree it reads.
import { spawnSync } from 'node:child_process';
import { msFromEnv } from './env-ms.mjs';

/** How long a tree gets between SIGTERM and SIGKILL: time for a test runner or a shell to clean up, short enough for a stop. */
export const TERM_GRACE_MS = 3 * 1000;
// The grace sweepDescendants gives a boss's leftovers: TERM_GRACE_MS, or its knob (env-ms.mjs, tests; `land` and `suite`
// never sweep, so their grace stays TERM_GRACE_MS).
const SWEEP_GRACE_MS = msFromEnv('CLAUDE_LONG_RUN_SWEEP_GRACE_MS', TERM_GRACE_MS);
// How often a tree that got SIGTERM is checked for whether it is gone.
const POLL_MS = 100;
// Signal 0 delivers nothing: it only asks whether the target still exists.
const EXISTS_SIGNAL = 0;
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid='];

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Sends `signal` to the process group `groupId` (POSIX).
 * @returns {boolean} false when the group has nothing left to signal (ESRCH or EPERM, see the header).
 * @throws {Error} for any other kill error.
 */
function signalGroup(groupId, signal) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EPERM') return false;
    throw error;
  }
}

/**
 * Sends one signal to `child` and everything in its process group (POSIX), or runs `taskkill /T` on its tree (Windows, with
 * `/F` for SIGKILL). It is synchronous, so it also works in an `exit` handler, where nothing can be awaited.
 * Why: a caller with its own ladder of signals (long-run's SIGINT, SIGTERM, SIGKILL) sends each step with it.
 * @param {{pid: number}} child the group leader, spawned `detached` on POSIX.
 * @param {'SIGINT' | 'SIGTERM' | 'SIGKILL'} signal
 * @param {{platform?: string, runner?: Function}} [options] stand-ins for process.platform and spawnSync.
 * @returns {boolean} false when the group had nothing left to signal (POSIX); always true on Windows, where taskkill's result
 *   is not read.
 * @throws {Error} for a kill error other than ESRCH or EPERM.
 */
export function signalProcessTree(child, signal, { platform = process.platform, runner = spawnSync } = {}) {
  if (platform !== 'win32') return signalGroup(child.pid, signal);
  const forced = signal === 'SIGKILL' ? ['/F'] : [];
  runner('taskkill', ['/PID', String(child.pid), '/T', ...forced], { stdio: 'ignore', windowsHide: true });
  return true;
}

/**
 * Ends `child` and everything in its process group: SIGTERM, then SIGKILL to whatever is left after TERM_GRACE_MS. On Windows
 * `taskkill /T /F` at once, since a console program there gets no signal it could clean up on.
 * Why: SIGTERM lets a test runner or a shell stop its own children and remove its temporary files; SIGKILL makes sure that
 * nothing outlives the caller's deadline or the caller itself.
 * It may be called after `child` itself has exited, to end what it left running: a group id is not given to a new process
 * while any member of the group lives.
 * @param {{pid: number}} child the group leader, spawned `detached` on POSIX.
 * @param {{platform?: string}} [options] a stand-in for process.platform.
 * @returns {Promise<void>} resolves once the group is gone, or right after SIGKILL was sent to it.
 * @throws {Error} (as a rejection) for a kill error other than ESRCH or EPERM.
 */
export async function endProcessTree(child, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    signalProcessTree(child, 'SIGKILL', { platform });
    return;
  }
  if (!signalGroup(child.pid, 'SIGTERM')) return;
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline) {
    await pause(POLL_MS);
    if (!signalGroup(child.pid, EXISTS_SIGNAL)) return;
  }
  signalGroup(child.pid, 'SIGKILL');
}

function processTable(runner) {
  const run = runner('ps', PS_ARGS, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`ps ${PS_ARGS.join(' ')} exited ${run.status}: ${String(run.stderr ?? '').trim().slice(0, 200)}`);
  return String(run.stdout).split('\n').flatMap((line) => {
    const fields = line.trim().split(/\s+/).map(Number);
    return fields.length === 3 && fields.every(Number.isInteger) ? [{ pid: fields[0], ppid: fields[1], pgid: fields[2] }] : [];
  });
}

/**
 * Every descendant of `pid` that runs now, with its process group.
 * @param {number} pid the root (not listed itself).
 * @param {{platform?: string, runner?: Function}} options `runner` stands in for spawnSync.
 * @returns {Map<number, number>} pid -> pgid; empty on Windows.
 * @throws {Error} when `ps` fails.
 */
export function listDescendants(pid, { platform = process.platform, runner = spawnSync } = {}) {
  const found = new Map();
  if (platform === 'win32') return found;
  const table = processTable(runner);
  let frontier = [pid];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    const children = table.filter((row) => parents.has(row.ppid) && row.pid !== process.pid && !found.has(row.pid));
    for (const row of children) found.set(row.pid, row.pgid);
    frontier = children.map((row) => row.pid);
  }
  return found;
}

const survivorsOf = (seen, runner) => processTable(runner).filter((row) => seen.get(row.pid) === row.pgid).map((row) => row.pid);

function signalEach(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error; // ESRCH: it ended between the read and the signal
    }
  }
}

/**
 * Ends the processes of `seen` that still run with the same process group: SIGTERM, then SIGKILL after `graceMs`.
 * @param {Map<number, number>} seen pid -> pgid, from listDescendants.
 * @param {{platform?: string, runner?: Function, graceMs?: number}} options `graceMs` defaults to SWEEP_GRACE_MS.
 * @returns {Promise<number[]>} the pids that were still running.
 */
export async function sweepDescendants(seen, { platform = process.platform, runner = spawnSync, graceMs = SWEEP_GRACE_MS } = {}) {
  if (platform === 'win32' || seen.size === 0) return [];
  const survivors = survivorsOf(seen, runner);
  signalEach(survivors, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let left = survivors;
  while (left.length > 0 && Date.now() < deadline) {
    await pause(POLL_MS);
    left = survivorsOf(seen, runner).filter((pid) => survivors.includes(pid));
  }
  signalEach(left, 'SIGKILL');
  return survivors;
}
