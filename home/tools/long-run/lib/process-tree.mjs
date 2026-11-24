// Purpose: end a boss and everything it started. A `claude -p` boss runs in its own process group, but a subagent's Bash runs in
//   a group of its own (live test 2026-11-24), so a group signal alone can leave it running: the tree is read before each signal
//   and whatever of it outlives the boss is ended afterwards.
// Exports: SWEEP_GRACE_MS, killTree, listDescendants, sweepDescendants.
// Invariants: POSIX only reads the tree (`ps -A -o pid=,ppid=,pgid=`); on Windows `taskkill /T` already walks the tree, so the
//   tree is empty there; a pid is ended only while it still has the process group it had when it was seen (a reused pid has
//   another), and the driver's own pid is never in a tree it reads.
import { spawnSync } from 'node:child_process';

/** How long the descendants left after a boss ended get between SIGTERM and SIGKILL. */
export const SWEEP_GRACE_MS = 3 * 1000;
const SWEEP_POLL_MS = 100;
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid='];

/**
 * Sends `signal` to the process group of `pid` (POSIX) or runs `taskkill /T` (Windows, `/F` for SIGKILL).
 * @param {{pid: number}} child the group leader.
 * @param {string} platform process.platform.
 * @param {'SIGINT' | 'SIGTERM' | 'SIGKILL'} signal
 * @param {Function} runner stands in for spawnSync.
 * @throws {Error} for a kill error other than ESRCH (the group is already gone).
 */
export function killTree(child, platform, signal, runner) {
  if (platform === 'win32') {
    runner('taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
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
 * @param {{platform?: string, runner?: Function, graceMs?: number}} options
 * @returns {Promise<number[]>} the pids that were still running.
 */
export async function sweepDescendants(seen, { platform = process.platform, runner = spawnSync, graceMs = SWEEP_GRACE_MS } = {}) {
  if (platform === 'win32' || seen.size === 0) return [];
  const survivors = survivorsOf(seen, runner);
  signalEach(survivors, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  let left = survivors;
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, SWEEP_POLL_MS); });
    left = survivorsOf(seen, runner).filter((pid) => survivors.includes(pid));
  }
  signalEach(left, 'SIGKILL');
  return survivors;
}
