// Purpose: detached watchdog that stops the on-demand reranker server after it has been idle, so it holds no memory
// between searches. Run as `node rerank-watch.mjs <state-file> <pid>`; exports `watch` for tests.
// Exports: watch, idleLimitMs, ownsServer, DEFAULT_IDLE_MS.
// Invariants: it only ever signals the pid recorded in the state file it was started for, and only after checking that
// the pid still runs a llama-server on the recorded port (a state file that survived a reboot must never make it kill an
// unrelated process that reused the pid); it exits
// when the state file disappears, names another pid, or the server is gone; "idle" is now - lastUsed in that file,
// and every search touches lastUsed.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_IDLE_MS = 20 * 60 * 1000; // spec: the server stops after 20 minutes without a search
const KILL_GRACE_MS = 5000;
const MAX_POLL_MS = 30000;
const MIN_POLL_MS = 50;
const STARTUP_GRACE_MS = 15000; // a freshly forked child shows its parent's command line in `ps` until it execs

/** RECALL_RERANK_IDLE_MS (tests), else 20 minutes. */
export const idleLimitMs = (env = process.env) => Number(env.RECALL_RERANK_IDLE_MS) || DEFAULT_IDLE_MS;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/**
 * Whether the state file's pid is (still) the llama-server recall started: an integer pid > 1 whose command line names a
 * llama-server on the recorded port. A server younger than STARTUP_GRACE_MS is trusted (see above); where `ps` is
 * missing the answer is false, so nothing is ever signalled blind.
 * @param {{pid: unknown, port: unknown, startedAt?: number}} state parsed reranker state file.
 */
export function ownsServer(state) {
  const { pid, port } = state ?? {};
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  if (Date.now() - (state.startedAt ?? 0) < STARTUP_GRACE_MS) return true;
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return /(^|[/\s])llama-server(\s|$)/.test(command) && command.includes(`--port ${port}`);
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readState = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/**
 * Poll until the server named in `statePath` is idle for `idleMs`, then SIGTERM it (SIGKILL after a grace period) and
 * remove the state file.
 * @param {string} statePath reranker state file ({pid, lastUsed, ...}).
 * @param {number} pid the server pid this watcher belongs to.
 * @param {{idleMs: number}} options idle limit in ms.
 */
export async function watch(statePath, pid, { idleMs }) {
  const poll = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(idleMs / 4)));
  for (;;) {
    await sleep(poll);
    const state = readState(statePath);
    if (!state || state.pid !== pid) return;
    if (!ownsServer(state)) { rmSync(statePath, { force: true }); return; }
    if (Date.now() - state.lastUsed < idleMs) continue;
    process.kill(pid, 'SIGTERM');
    for (let waited = 0; alive(pid) && waited < KILL_GRACE_MS; waited += MIN_POLL_MS) await sleep(MIN_POLL_MS);
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(statePath, { force: true });
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [statePath, pidText] = process.argv.slice(2);
  await watch(statePath, Number(pidText), { idleMs: idleLimitMs() });
}
