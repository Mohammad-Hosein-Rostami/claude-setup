// Purpose: detached watchdog that stops the on-demand reranker server after it has been idle, so it holds no memory
// between searches. Run as `node rerank-watch.mjs <state-file> <pid>`; exports `watch` for tests.
// Exports: watch, idleLimitMs, ownsServer, signalQuietly, DEFAULT_IDLE_MS.
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

/**
 * `process.kill` that ignores a pid that is already gone (ESRCH) and rethrows everything else (EPERM, a bad signal).
 * @param {number} pid process id.
 * @param {string} signal e.g. 'SIGTERM'.
 */
export function signalQuietly(pid, signal) {
  try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/**
 * Whether the state file's pid is (still) the llama-server recall started: an integer pid > 1 whose command line names a
 * llama-server on the recorded port. A server younger than STARTUP_GRACE_MS is trusted (see above). Where `ps` is missing
 * (Windows) the command line cannot be checked, so the pid counts as ours while it is alive and the state file is fresh
 * (used within twice the idle limit, which covers the idle stop itself); otherwise the answer is false, so nothing is
 * ever signalled blind.
 * @param {{pid: unknown, port: unknown, startedAt?: number, lastUsed?: number}} state parsed reranker state file.
 * @param {{platform?: string, env?: object}} [options] platform and env overrides (tests).
 */
export function ownsServer(state, { platform = process.platform, env = process.env } = {}) {
  const { pid, port } = state ?? {};
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  if (Date.now() - (state.startedAt ?? 0) < STARTUP_GRACE_MS) return true;
  if (platform === 'win32') return Date.now() - (state.lastUsed ?? state.startedAt ?? 0) < 2 * idleLimitMs(env);
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const argv = command.trim().split(/\s+/); // exact argv tokens: `--port 8012` must not match `--port 80123` or a path
    const flag = argv.indexOf('--port');
    return argv.slice(0, 2).some((token) => /(^|\/)llama-server$/.test(token)) && flag !== -1 && argv[flag + 1] === String(port);
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
 * @param {{idleMs: number, now?: () => number, pause?: (ms: number) => Promise<void>}} options idle limit in ms; `now` (the
 *   clock compared with `lastUsed`) and `pause` (the wait between polls) are injectable so tests drive time instead of
 *   sleeping; the SIGTERM grace wait always uses real time.
 */
export async function watch(statePath, pid, { idleMs, now = Date.now, pause = sleep }) {
  const poll = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.floor(idleMs / 4)));
  for (;;) {
    await pause(poll);
    const state = readState(statePath);
    if (!state || state.pid !== pid) return;
    if (!ownsServer(state)) { rmSync(statePath, { force: true }); return; }
    if (now() - state.lastUsed < idleMs) continue;
    signalQuietly(pid, 'SIGTERM');
    for (let waited = 0; alive(pid) && waited < KILL_GRACE_MS; waited += MIN_POLL_MS) await sleep(MIN_POLL_MS);
    if (alive(pid)) signalQuietly(pid, 'SIGKILL');
    rmSync(statePath, { force: true });
    return;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [statePath, pidText] = process.argv.slice(2);
  await watch(statePath, Number(pidText), { idleMs: idleLimitMs() });
}
