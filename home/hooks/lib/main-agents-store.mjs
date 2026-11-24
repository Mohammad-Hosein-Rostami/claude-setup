// The main-agent record of agent-budget.mjs (the cap): one JSON file per session, read and written under the session's lock.
// Store: ~/.claude/state/main-agents/<session>.json through lib/session-store.mjs under lib/session-lock.mjs (0600, at most
// MAX_STORE_BYTES for writer and reader): {"launches": [{"key", "type", "at", "agent"?}], "stopped": [agent ids],
// "stoppedTypes": {agent id: type}}. `stoppedTypes` (added 2026-11-24, so an older file has none) holds the type of each stopped
// main agent, which caps its resume by SendMessage. A corrupt file (not JSON, not that shape, or an entry outside it), an unusable
// store or a lock that stays taken is `unusable` (NO_STORE), and the guard denies (the owner's cap fails closed) until the file is
// fixed or deleted.
// Running: a pending launch (no SubagentStart yet) for PENDING_MS, so a denied or cut launch frees its slot; a started one until its
// stop, or until STALE_MS passes with no tool call of its own (an agent that ended unseen). Only running launches are kept on a
// write. Clock (H16): the order of `launches` is the order of the launches (each is appended), never their times; a launch dated
// ahead of the clock (the clock stepped back, or a planted record) is re-dated to now and stored so, so it keeps its slot and ages
// from now instead of being dropped.
// Across sessions (plan M2b): anyRunning(type) reads every session's record without the lock, by the same running rules, so a
// max that died unseen counts only until STALE_MS passes with no tool call of its own (never for good). It reads all of them, in no
// order a file's name or time could game; more than MAX_SESSION_FILES files (old ones are pruned after 7 days, so only a flood of
// planted files gets there) is `unusable`, which the callers treat as a running max.
// Exports: PENDING_MS, STALE_MS, SAFE_ID, NO_STORE, MAX_SESSION_FILES, mainAgentsDir(env), withRecord(session, env, change),
// peekRecord(session, env, now), anyRunning(type, env, now).
// Invariants: every write of the file goes through withRecord, under the lock (peekRecord and anyRunning only read, and a caller of
// peekRecord decides again under the lock); stopped ids are kept to STOPPED_KEPT.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from './session-lock.mjs';
import { isSessionId, lstatOrNull, readSessionFile, writeSessionFile } from './session-store.mjs';
import { callCounterPath } from './writer-agents.mjs';

export const PENDING_MS = 2 * 60 * 1000; // a launch the permission dialog, Esc or another hook stops gets no SubagentStart
export const STALE_MS = 3 * 60 * 60 * 1000; // 3 h with no tool call: longer than a main agent waits on its helpers
/** An agent id as Claude Code writes it (hex), with room for test ids; anything else is not stored. */
export const SAFE_ID = /^[\w-]{1,128}$/;
/** withRecord's answer when the store cannot be read, parsed or written. */
export const NO_STORE = { state: 'unusable', running: [] };
const MAX_STORE_BYTES = 64 * 1024;
const STOPPED_KEPT = 200; // stopped main agent ids kept for a resume
/** Session files anyRunning reads at most (a hook has a 5 s budget); a store with more is `unusable`, never read in part. */
export const MAX_SESSION_FILES = 1024;
const SESSION_FILE = /^(.+)\.json$/;

/** The folder of the main-agent records, one file per session. */
export const mainAgentsDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'main-agents');

/** The time of an agent's last tool call (its call counter's mtime), or 0 when it has made none. */
function lastToolCall(session, agentId) {
  const path = callCounterPath(session, agentId);
  try {
    return path === null ? 0 : statSync(path).mtimeMs;
  } catch {
    return 0; // no tool call yet
  }
}

/** Whether a stored launch (dated no later than now) still holds a slot (the rules in the header). */
function isRunning(launch, now, session) {
  if (typeof launch.agent !== 'string') return now - launch.at < PENDING_MS;
  return now - Math.max(launch.at, lastToolCall(session, launch.agent)) < STALE_MS;
}

const isLaunch = (launch) => typeof launch?.key === 'string' && typeof launch.type === 'string' && Number.isFinite(launch.at)
  && (launch.agent === undefined || SAFE_ID.test(launch.agent));

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isListOrMissing = (value) => value === undefined || Array.isArray(value);
const isTypeMapOrMissing = (value) => value === undefined
  || (isPlainObject(value) && Object.entries(value).every(([id, type]) => SAFE_ID.test(id) && typeof type === 'string'));

/**
 * The store's running launches, stopped ids and their types (a missing file is an empty record).
 * @returns {{ record: {launches: object[], stopped: string[], stoppedTypes: object}, redated: boolean } | null} `redated`: a launch dated ahead of `now`
 *   was re-dated to now; null for a corrupt file (not JSON, not the store's shape, or an entry outside it)
 */
function parseRecord(text, now, session) {
  let stored;
  try {
    stored = text === null ? {} : JSON.parse(text);
  } catch {
    return null; // corrupt: the caller answers `unusable`
  }
  if (!isPlainObject(stored) || !isListOrMissing(stored.launches) || !isListOrMissing(stored.stopped)) return null;
  if (!isTypeMapOrMissing(stored.stoppedTypes)) return null;
  const launches = stored.launches ?? [];
  const stopped = stored.stopped ?? [];
  if (!launches.every(isLaunch) || !stopped.every((id) => typeof id === 'string' && SAFE_ID.test(id))) return null;
  const dated = launches.map((launch) => (launch.at > now ? { ...launch, at: now } : launch));
  const redated = dated.some((launch, at) => launch !== launches[at]);
  const running = dated.filter((launch) => isRunning(launch, now, session));
  return { record: { launches: running, stopped, stoppedTypes: stored.stoppedTypes ?? {} }, redated };
}

/** The record as stored: the last STOPPED_KEPT stopped ids, and the types of those only. */
function storedText({ launches, stopped, stoppedTypes }) {
  const kept = stopped.slice(-STOPPED_KEPT);
  const types = Object.fromEntries(kept.filter((id) => Object.hasOwn(stoppedTypes, id)).map((id) => [id, stoppedTypes[id]]));
  return JSON.stringify({ launches, stopped: kept, stoppedTypes: types });
}


/**
 * Runs change(record, now) on the session's record under its lock and stores what it returns as `record` (or the re-dated record
 * when it returns none).
 * @returns {object | undefined} change's answer; NO_STORE when the store cannot be read, parsed or written; undefined when the lock
 *   stays taken
 */
export function withRecord(session, env, change) {
  const dir = mainAgentsDir(env);
  return withSessionLock(dir, session, () => {
    const now = Date.now();
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return NO_STORE;
    const parsed = parseRecord(text, now, session);
    if (parsed === null) return NO_STORE;
    const answer = change(parsed.record, now);
    const record = answer.record ?? (parsed.redated ? parsed.record : undefined);
    if (record === undefined) return answer;
    return writeSessionFile(dir, session, storedText(record)) ? answer : NO_STORE;
  });
}

/**
 * The record read without the lock, for a caller that must do a slow read (the lead's transcript) before it takes the lock and
 * decides again under it: the lock waits only 1 s (lib/session-lock.mjs), so no slow read happens while it is held.
 * @returns {{launches: object[], stopped: string[], stoppedTypes: object} | null} null when the store cannot be read or parsed
 */
export function peekRecord(session, env, now = Date.now()) {
  const text = readSessionFile(mainAgentsDir(env), session, MAX_STORE_BYTES);
  return text === undefined ? null : (parseRecord(text, now, session)?.record ?? null);
}

/**
 * The session ids of the store's plain `<session>.json` files. A name that is no session id (a planted or hostile name) is skipped; a
 * link or a folder is no plain file, so it is skipped too.
 * @returns {string[] | null} the ids ([] when the store folder does not exist yet); null when the folder is no real folder or holds
 *   more than MAX_SESSION_FILES of them (reading only some would let planted files hide a record)
 */
function allSessions(dir) {
  const folder = lstatOrNull(dir);
  if (folder === null) return [];
  if (!folder.isDirectory()) return null;
  const sessions = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => SESSION_FILE.exec(entry.name)?.[1])
    .filter(isSessionId);
  return sessions.length > MAX_SESSION_FILES ? null : sessions;
}

/**
 * Whether a main agent of `type` runs in any session on this machine (the record of every session, read without the lock).
 * Why: max's outward rule (lib/click-only.mjs) and the guard's Claude-start deny must see a max of another session, and a helper of
 * max has its own agent_type, so the record of the cap is the one place that knows a max runs.
 * @param {string} type the main agent type ('max')
 * @param {Record<string, string | undefined>} env process environment (HOME, USERPROFILE)
 * @param {number} now clock in epoch ms (a test passes its own)
 * @returns {'yes' | 'no' | 'unusable'} 'unusable' when the folder or any file cannot be read or parsed, or the folder holds more than
 *   MAX_SESSION_FILES session files: the caller fails closed
 */
export function anyRunning(type, env, now = Date.now()) {
  const dir = mainAgentsDir(env);
  try {
    const sessions = allSessions(dir);
    if (sessions === null) return 'unusable';
    for (const session of sessions) {
      const record = peekRecord(session, env, now);
      if (record === null) return 'unusable';
      if (record.launches.some((launch) => launch.type === type)) return 'yes';
    }
    return 'no';
  } catch {
    return 'unusable'; // the folder changed under the listing, or a file went away: fail closed
  }
}
