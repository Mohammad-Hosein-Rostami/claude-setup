// Purpose: run the reranker as an on-demand llama.cpp server: start it when a search needs it, reuse it while warm, swap
// models for `--deep`, and let a detached watchdog stop it after 20 idle minutes (no memory use between searches).
// Exports: ensureServer, readServer, stopServer, touchServer, rerankModelPath, RERANK_FILES, RERANK_STATE_FILE.
// Invariants: at most one server at a time (a different tier stops the running one first; another llama-server that
// recall did not start blocks the start, so two big models are never loaded together); it listens on 127.0.0.1 only;
// state (pid, port, tier, lastUsed) is one JSON file in the state dir; every failure is a thrown Error whose message is
// the reason shown in `recall: skipped <stage> (<reason>)`; nothing here ever raises iogpu.wired_limit_mb.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './paths.mjs';
import { PRIVATE_FILE_MODE, ensurePrivateDir, writeFileAtomic } from './private-fs.mjs';
import { idleLimitMs, ownsServer } from './rerank-watch.mjs';

export const RERANK_FILES = { fast: 'qwen3-reranker-0.6b-q8_0.gguf', deep: 'qwen3-reranker-4b-q8_0.gguf' };
export const RERANK_STATE_FILE = 'rerank-server.json';
const DEFAULT_PORT = 8012;
const START_TIMEOUT_MS = 90000; // a cold 4B load from disk takes tens of seconds
const HEALTH_TIMEOUT_MS = 1000;
const POLL_MS = 150;
const STOP_WAIT_MS = 8000;
const START_LOCK_STALE_MS = 120000;
const WATCH_SCRIPT = fileURLToPath(new URL('./rerank-watch.mjs', import.meta.url));
const SERVER_ARGS = ['--reranking', '--embedding', '--pooling', 'rank', '-ngl', '99', '-c', '8192'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const statePath = (env) => join(stateDir(env), RERANK_STATE_FILE);
const portOf = (env) => Number(env.RECALL_RERANK_PORT) || DEFAULT_PORT;
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Absolute path of the GGUF for a tier ('fast' = 0.6B, 'deep' = 4B); RECALL_RERANK_MODEL_DIR, else ~/.cache/recall-models. */
export const rerankModelPath = (tier, env = process.env) => join(env.RECALL_RERANK_MODEL_DIR || join(homedir(), '.cache', 'recall-models'), RERANK_FILES[tier]);

/** The running server's state {pid, port, tier, startedAt, lastUsed}, or null (a state file of a dead pid is removed). */
export function readServer(env = process.env) {
  let state;
  try { state = JSON.parse(readFileSync(statePath(env), 'utf8')); } catch { return null; }
  if (!state || !ownsServer(state)) { rmSync(statePath(env), { force: true }); return null; }
  return state;
}

/** Record that a search used the server just now (resets the idle clock). */
export function touchServer(env = process.env) {
  const state = readServer(env);
  if (state) writeFileAtomic(statePath(env), JSON.stringify({ ...state, lastUsed: Date.now() }));
}

async function healthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Stop the server in `state`: SIGTERM, then SIGKILL after STOP_WAIT_MS; the state file goes away. */
export async function stopServer(state, env = process.env) {
  if (ownsServer(state)) { // a recycled pid is never signalled
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let waited = 0; pidAlive(state.pid) && waited < STOP_WAIT_MS; waited += POLL_MS) await sleep(POLL_MS);
    if (pidAlive(state.pid)) process.kill(state.pid, 'SIGKILL');
  }
  rmSync(statePath(env), { force: true });
}

/**
 * pids of llama-server processes that neither recall nor Ollama started (Ollama runs its own `llama-server` runners for
 * embeddings; those are small and expected). Empty where `ps` is missing or the check is off (RECALL_RERANK_FOREIGN_CHECK=off).
 */
function foreignServers(env) {
  if (env.RECALL_RERANK_FOREIGN_CHECK === 'off' || process.platform === 'win32') return [];
  try {
    return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').flatMap((line) => {
      const [pid, command = ''] = [line.trim().split(/\s+/, 1)[0], line.trim().replace(/^\d+\s+/, '')];
      const isServer = command.split(/\s+/, 2).some((token) => /(^|\/)llama-server$/.test(token)) && !/ollama/i.test(command) && (!env.RECALL_RERANK_FOREIGN_MATCH || command.includes(env.RECALL_RERANK_FOREIGN_MATCH)); // 2 tokens: also `node llama-server` wrappers; _MATCH narrows the scan (tests)
      return isServer && Number(pid) !== process.pid ? [Number(pid)] : [];
    });
  } catch {
    return [];
  }
}

function acquireStartLock(env) {
  const path = join(stateDir(env), 'rerank-server.lock');
  try {
    writeFileSync(path, String(Date.now()), { flag: 'wx', mode: PRIVATE_FILE_MODE });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let age = Infinity;
    try { age = Date.now() - Number(readFileSync(path, 'utf8')); } catch { /* released meanwhile */ }
    if (age < START_LOCK_STALE_MS) return null;
    rmSync(path, { force: true });
    return acquireStartLock(env);
  }
  return () => rmSync(path, { force: true });
}

function launch(tier, env) {
  const port = portOf(env);
  const file = rerankModelPath(tier, env);
  ensurePrivateDir(stateDir(env));
  const log = openSync(join(stateDir(env), 'rerank-server.log'), 'a', PRIVATE_FILE_MODE);
  const child = spawn('llama-server', ['-m', file, ...SERVER_ARGS, '--host', '127.0.0.1', '--port', String(port)], { detached: true, stdio: ['ignore', log, log], env });
  const failed = new Promise((resolve) => {
    child.once('error', (error) => resolve(error.code === 'ENOENT' ? 'llama-server is not installed (brew install llama.cpp)' : error.message));
    child.once('exit', (code) => resolve(`llama-server exited with code ${code} while starting (see ${join(stateDir(env), 'rerank-server.log')})`));
  });
  child.unref();
  return { child, port, failed };
}

async function waitHealthy(port, failed) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const early = await Promise.race([failed, sleep(POLL_MS).then(() => null)]);
    if (early) throw new Error(early);
    if (await healthy(port)) return;
  }
  throw new Error(`llama-server did not become ready within ${START_TIMEOUT_MS / 1000}s`);
}

async function startServer(tier, env) {
  const file = rerankModelPath(tier, env);
  if (!existsSync(file)) throw new Error(`model file missing: ${file}`);
  const other = foreignServers(env);
  if (other.length) throw new Error(`another llama-server is running (pid ${other[0]}); not loading a second big model`);
  const { child, port, failed } = launch(tier, env);
  const state = { pid: child.pid, port, tier, startedAt: Date.now(), lastUsed: Date.now() };
  writeFileAtomic(statePath(env), JSON.stringify(state));
  try {
    await waitHealthy(port, failed);
  } catch (error) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(statePath(env), { force: true });
    throw error;
  }
  spawn(process.execPath, [WATCH_SCRIPT, statePath(env), String(child.pid)], { detached: true, stdio: 'ignore', env: { ...process.env, RECALL_RERANK_IDLE_MS: String(idleLimitMs(env)) } }).unref();
  return state;
}

async function reuse(tier, env) {
  const current = readServer(env);
  if (current?.tier !== tier || !(await healthy(current.port))) return null;
  touchServer(env);
  return { base: `http://127.0.0.1:${current.port}`, tier };
}

/** Another recall process holds the start lock: wait for the server it is starting. */
async function awaitOtherStart(tier, env) {
  for (const deadline = Date.now() + START_TIMEOUT_MS; Date.now() < deadline; await sleep(POLL_MS)) {
    const server = await reuse(tier, env);
    if (server) return server;
  }
  throw new Error('another recall process is starting the reranker and it was not ready in time');
}

/**
 * A reranker server for `tier` ('fast' or 'deep'), started if needed.
 * @param {{deep?: boolean, env?: object}} [options]
 * @returns {Promise<{base: string, tier: string}>} the loopback origin to send /v1/rerank to.
 * @throws {Error} with a short reason when the server cannot be used (model missing, llama-server missing or busy
 *   with a foreign model, not ready in time); the caller falls back to the next cheaper stage.
 */
export async function ensureServer({ deep = false, env = process.env } = {}) {
  const tier = deep ? 'deep' : 'fast';
  ensurePrivateDir(stateDir(env));
  const warm = await reuse(tier, env);
  if (warm) return warm;
  const release = acquireStartLock(env);
  if (!release) return awaitOtherStart(tier, env);
  try {
    const current = readServer(env);
    if (current) await stopServer(current, env); // the other tier, or a hung one: one server at a time
    const state = await startServer(tier, env);
    return { base: `http://127.0.0.1:${state.port}`, tier };
  } finally {
    release();
  }
}
