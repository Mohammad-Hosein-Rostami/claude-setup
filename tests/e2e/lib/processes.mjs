// Every process the e2e runner starts, so none outlives the run. Exports: KILL_GRACE_MS, TREE_POLL_MS, ProcessRegistry.
// Why: a `claude -p` boss starts subagents whose Bash runs in process groups of their own (long-run's live test 2026-11-24), so
// a group signal alone can leave a background shell running. The runner starts each child detached (a new group led by the
// child), reads the child's process tree every TREE_POLL_MS while it runs (an orphan is re-parented to init once its parent ends,
// so it must be seen before), and at the end, on a timeout, on a usage limit and on SIGINT/SIGTERM ends every group it started
// and every descendant it saw (SIGTERM, then SIGKILL), then checks that none is left.
// Invariants: only processes this registry started or saw descend from them are signalled (never a pid read from a file or a
// transcript); a seen pid is signalled only while it still has the group it had when seen (a reused pid has another, long-run's
// process-tree.mjs rule); on Windows `taskkill /T /F` ends the child's tree and no tree is read.
import { spawnSync } from 'node:child_process';
import { listDescendants, sweepDescendants } from '../../../home/tools/long-run/lib/process-tree.mjs';

/** How long a group gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** How often a running child's tree is read. */
export const TREE_POLL_MS = 1_000;
const POLL_MS = 200;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** @returns {boolean} true while any process of the group led by `pid` runs */
function groupAlive(pid) {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // it exists but is not ours to signal: still counts as alive
  }
}

function signalGroup(pid, signal) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

/** @returns {boolean} true while the process `pid` runs in group `pgid` */
function stillSame(pid, pgid) {
  const out = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  return out.status === 0 && Number(out.stdout.trim()) === pgid;
}

export class ProcessRegistry {
  constructor() {
    /** @type {Set<number>} the group leaders this run started */
    this.groups = new Set();
    /** @type {Map<number, number>} every descendant seen: pid -> pgid */
    this.seen = new Map();
    this.timers = new Map();
  }

  /** Remembers the group of a child started with `detached: true` and starts reading its tree. */
  add(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    this.groups.add(pid);
    if (process.platform === 'win32') return;
    const timer = setInterval(() => this.snapshot(pid), TREE_POLL_MS);
    timer.unref();
    this.timers.set(pid, timer);
  }

  /** Reads the tree of `pid` once (also right before a signal). */
  snapshot(pid) {
    try {
      for (const [child, pgid] of listDescendants(pid)) this.seen.set(child, pgid);
    } catch {
      // ps failed once: the next poll reads it again
    }
  }

  /** Stops reading the tree of a child that ended. */
  settle(pid) {
    clearInterval(this.timers.get(pid));
    this.timers.delete(pid);
  }

  /** @returns {number[]} the groups still running and the seen descendants still running in their group */
  alive() {
    const groups = [...this.groups].filter(groupAlive);
    const descendants = [...this.seen].filter(([pid, pgid]) => !this.groups.has(pid) && stillSame(pid, pgid)).map(([pid]) => pid);
    return [...new Set([...groups, ...descendants])];
  }

  /**
   * Ends one group and what was seen under it: SIGTERM, then SIGKILL after the grace time.
   * @returns {Promise<boolean>} true when the group is gone
   */
  async end(pid, graceMs = KILL_GRACE_MS) {
    this.snapshot(pid);
    signalGroup(pid, 'SIGTERM');
    for (let waited = 0; waited < graceMs && groupAlive(pid); waited += POLL_MS) await pause(POLL_MS);
    if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    for (let waited = 0; waited < graceMs && groupAlive(pid); waited += POLL_MS) await pause(POLL_MS);
    this.settle(pid);
    return !groupAlive(pid);
  }

  /**
   * Kills one child and its tree at once with SIGKILL, so it cannot clean up (E9: a driver that is lost, not paused).
   * @returns {number[]} the descendants that were signalled
   */
  killTree(pid) {
    if (process.platform === 'win32') {
      signalGroup(pid, 'SIGKILL');
      return [];
    }
    let tree = new Map();
    try { tree = listDescendants(pid); } catch { /* ps failed: the group signal below still ends the child's own group */ }
    for (const [child, pgid] of tree) this.seen.set(child, pgid);
    signalGroup(pid, 'SIGKILL');
    for (const [child, pgid] of tree) if (stillSame(child, pgid)) try { process.kill(child, 'SIGKILL'); } catch { /* gone */ }
    return [...tree.keys()];
  }

  /**
   * Ends every group this run started and every descendant it saw.
   * @returns {Promise<number[]>} the processes still alive afterwards (empty when none is left)
   */
  async endAll(graceMs = KILL_GRACE_MS) {
    await Promise.all([...this.groups].filter(groupAlive).map((pid) => this.end(pid, graceMs)));
    await sweepDescendants(this.seen, { graceMs });
    for (const pid of this.timers.keys()) this.settle(pid);
    return this.alive();
  }

  /**
   * The descendants of ended children still running now (a background shell an agent left), then ended.
   * @returns {Promise<number[]>} the pids that were still running
   */
  async sweepLeftovers(graceMs = KILL_GRACE_MS) {
    const leftovers = [...this.seen].filter(([pid]) => !this.groups.has(pid));
    return sweepDescendants(new Map(leftovers), { graceMs });
  }

  /** The synchronous last resort of an exit handler: SIGKILL to every group and seen process still running. */
  killAllNow() {
    for (const pid of this.alive()) {
      if (this.groups.has(pid)) signalGroup(pid, 'SIGKILL');
      else try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}
