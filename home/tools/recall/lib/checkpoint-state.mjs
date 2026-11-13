// Purpose: per-session checkpoint state, the trigger rule, and the per-session lock that keeps two checkpoint jobs from
// overlapping. Light on purpose (node builtins only): the PostToolUse hook imports it and must return in well under 50 ms.
// Exports: checkpointDir, readCheckpoint, writeCheckpoint, listCheckpoints, decideCheckpoint, acquireLock, lockHeld,
// releaseLock, TRIGGER_TOKENS, CHARS_PER_TOKEN.
// Invariants: state is one JSON file per session in <state>/checkpoints ({session, transcript, offset, ts, notes,
// lines, error, warn}); `offset` is the first transcript byte not yet summarised; the lock is a file created with
// O_EXCL holding the job pid, stale when that pid is dead (a lock that never got a pid is stale after STALE_LOCK_MS; a live
// job keeps its lock however long it runs); state files are written atomically with mode 0600; a failed job backs off for
// ERROR_BACKOFF_MS so a broken `claude` is not retried on every tool call; the session id is never used as a path
// unless it is a plain id.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './paths.mjs';
import { PRIVATE_FILE_MODE, ensurePrivateDir, writeFileAtomic } from './private-fs.mjs';

export const CHARS_PER_TOKEN = 3.5;
export const TRIGGER_TOKENS = 40000; // spec: checkpoint when the transcript grew by about 40k tokens
const MIN_TAIL_TOKENS = 300; // PreCompact: a tail smaller than this is not worth a Haiku call
const STALE_LOCK_MS = 15 * 60 * 1000;
const ERROR_BACKOFF_MS = 10 * 60 * 1000;
const PLAIN_ID = /^[\w.-]{1,80}$/;

/** <state>/checkpoints. */
export const checkpointDir = (env = process.env) => join(stateDir(env), 'checkpoints');

function fileFor(session, env, suffix) {
  if (!PLAIN_ID.test(session) || session.includes('..')) throw new Error('unsafe session id');
  return join(checkpointDir(env), `${session}${suffix}`);
}

/** The saved state of a session, or null. */
export function readCheckpoint(session, env = process.env) {
  try { return JSON.parse(readFileSync(fileFor(session, env, '.json'), 'utf8')); } catch { return null; }
}

/** Save (replace) a session's state. */
export function writeCheckpoint(session, state, env = process.env) {
  ensurePrivateDir(checkpointDir(env));
  writeFileAtomic(fileFor(session, env, '.json'), JSON.stringify(state));
}

/** Every saved state, newest checkpoint first (used by `recall status` and doctor). */
export function listCheckpoints(env = process.env) {
  let names = [];
  try { names = readdirSync(checkpointDir(env)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const states = names.flatMap((n) => { try { return [JSON.parse(readFileSync(join(checkpointDir(env), n), 'utf8'))]; } catch { return []; } });
  return states.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
}

/**
 * Whether a hook event should start a checkpoint job.
 * @param {{event: string, size: number, state: object | null, now?: number}} input `event` is the hook event name;
 *   `size` the transcript size in bytes.
 * @returns {boolean} true when the transcript grew by >= TRIGGER_TOKENS since the last checkpoint (any event), or on
 *   PreCompact when a small tail remains. Never inside the error back-off window.
 */
export function decideCheckpoint({ event, size, state, now = Date.now() }) {
  if (state?.error && now - Date.parse(state.error.ts) < ERROR_BACKOFF_MS) return false;
  const tokens = (size - (state?.offset ?? 0)) / CHARS_PER_TOKEN;
  return tokens >= (event === 'PreCompact' ? MIN_TAIL_TOKENS : TRIGGER_TOKENS);
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** True while a live checkpoint job holds the session's lock. */
export function lockHeld(session, env = process.env) {
  const path = fileFor(session, env, '.lock');
  if (!existsSync(path)) return false;
  let holder = null;
  try { holder = JSON.parse(readFileSync(path, 'utf8')); } catch { /* being written */ }
  const age = Date.now() - statSync(path).mtimeMs;
  const stale = holder?.pid ? !pidAlive(holder.pid) : age > STALE_LOCK_MS;
  if (stale) { rmSync(path, { force: true }); return false; }
  return true;
}

/**
 * Take the session lock. Returns `setPid(pid)` (records the job pid) or null when another job holds it.
 * Atomic: two callers racing for the same session never both succeed.
 */
export function acquireLock(session, env = process.env) {
  ensurePrivateDir(checkpointDir(env));
  if (lockHeld(session, env)) return null;
  const path = fileFor(session, env, '.lock');
  try {
    closeSync(openSync(path, 'wx', PRIVATE_FILE_MODE));
  } catch (error) {
    if (error.code === 'EEXIST') return null;
    throw error;
  }
  return (pid) => writeFileAtomic(path, JSON.stringify({ pid }));
}

/** Release the session lock (no-op when it is not held). */
export function releaseLock(session, env = process.env) {
  rmSync(fileFor(session, env, '.lock'), { force: true });
}
