// Stop-hook block counter (round 9, r9-stop-cap): Claude Code lets Stop hooks continue a turn STOP_BLOCK_CAP times in a row, then overrides
// the next block (the 9th) and ends the turn with a warning; nothing is saved (hooks.md, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). A Stop gate that
// crashes or times out also lets the turn end (`onFailure` has no effect on Stop). This module leaves a record of both, so no proof rests
// on a Stop block alone without anyone knowing it was overridden.
// Exports: STOP_BLOCK_CAP, CAP_ENV, countedGate(hook, input, run, env) (the one call each blocking Stop/SubagentStop gate makes),
// countBlock(hook, input, env), gateStarted(hook, input, env), gateFinished(mark), recordGateCrash(hook, input, env), markToolCall(input,
// env), sweepStaleMarks(env, nowMs), readRecords(env, {sinceMs, max}), recordsDir(env), recordsNotice(env, nowMs).
// Counting: one count per session, and per agent on SubagentStop (key: agent_id, else `lead`), shared by every gate that blocks. A Stop
// event with stop_hook_active false starts a new chain; a tool call since the chain's last block (the reset marker agent-budget.mjs writes
// on every PostToolUse) starts one too. Blocks of one event count once: gates of one event run in parallel and Claude Code counts the
// continuation, not the hooks; a block is of the same event as the chain's last one when it carries the same stop_hook_active and
// last_assistant_message and comes within SAME_EVENT_MS. The block that makes the count STOP_BLOCK_CAP + 1 appends
// `gate overridden: <hooks of the chain>` once per chain.
// Crashes: each gate run leaves a start mark and removes it when it returns. A mark of the same hook, session and agent found at the next
// run, or any mark older than STALE_MARK_MS at session start (sweepStaleMarks), appends `gate crashed or timed out: <hook>`; a crash the
// gate catches itself is appended by countedGate before it is rethrown.
// Store: ~/.claude/state/stop-blocks/ (0700): counts/<session>.json (lib/session-store.mjs, locked), runs/<session>--<agent>--<hook>
// (marks), resets/<session>--<agent> (the reset marker; its mtime is the last tool call), records.jsonl (append-only, at most
// MAX_RECORDS_BYTES; each line {at, session, agent, text}), records.shown (its mtime: the newest record the session-start notice showed).
// Invariants: never throws (every export catches; countedGate rethrows only the gate's own error); ids and hook names are checked before
// they become file names; fixed text plus hook names only, never prompt or reply text.
import { createHash } from 'node:crypto';
import { lstatSync, lutimesSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendPlainFile, readPlainFile } from './plain-file.mjs';
import { withSessionLock } from './session-lock.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './session-store.mjs';

/** The number of blocks in a row Claude Code lets continue the turn; settings/base.json sets CAP_ENV to it and doctor checks both. */
export const STOP_BLOCK_CAP = 8;
export const CAP_ENV = 'CLAUDE_CODE_STOP_HOOK_BLOCK_CAP';
const LEAD_KEY = 'lead';
const SAFE_ID = /^[\w-]{1,128}$/;
const HOOK_NAME = /^[\w-]{1,64}$/;
const STOP_EVENTS = new Set(['Stop', 'SubagentStop']);
const SAME_EVENT_MS = 10 * 60 * 1000; // above the longest Stop hook timeout: parallel gates of one event finish within it
const STALE_MARK_MS = 11 * 60 * 1000; // above the documented 600 s default hook timeout: a mark this old belongs to no running gate
const MAX_COUNTS_BYTES = 16 * 1024; // one entry per agent of a session
const AGENTS_KEPT = 100;
const MAX_RECORDS_BYTES = 256 * 1024; // years of records; past it new ones are dropped (doctor says so)
const RECORD_LINE_BYTES = 2048;
const DIR_MODE = 0o700;
const NOTICE_MAX = 5; // record lines one session-start notice shows (the newest)
const MARK_NAME_PARTS = 3; // runs/<session>--<agent>--<hook>

const baseDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'stop-blocks');
/** The folder of records.jsonl and records.shown (doctor reads it). */
export const recordsDir = baseDir;
const agentKey = (input) => (typeof input?.agent_id === 'string' && input.agent_id !== '' ? input.agent_id : LEAD_KEY);
const usableIds = (input) => isSessionId(input?.session_id) && SAFE_ID.test(agentKey(input));

/** A folder under the store, made owner-only when missing; null when it cannot be made or is not a folder. */
function folder(env, name) {
  try {
    const path = name === '' ? baseDir(env) : join(baseDir(env), name);
    mkdirSync(path, { recursive: true, mode: DIR_MODE });
    return lstatSync(path).isDirectory() ? path : null;
  } catch {
    return null; // no store: nothing is counted or recorded
  }
}

/** Sets a marker file's times to now, creating it when missing; never follows a link. */
function touch(path) {
  const now = new Date();
  try {
    lutimesSync(path, now, now);
  } catch {
    appendPlainFile(path, '\n', { maxBytes: 1 });
  }
}

/** The mtime of a plain file, or 0 when it is missing or not a plain file. */
function mtimeOf(path) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() ? stats.mtimeMs : 0;
  } catch {
    return 0; // no marker
  }
}

/** Appends one record line: `text` names a fixed kind and hook names only. */
function appendRecord(env, input, text) {
  const dir = folder(env, '');
  if (dir === null) return false;
  const line = `${JSON.stringify({ at: Date.now(), session: String(input?.session_id ?? ''), agent: agentKey(input), text })}\n`;
  return Buffer.byteLength(line) <= RECORD_LINE_BYTES && appendPlainFile(join(dir, 'records.jsonl'), line, { maxBytes: MAX_RECORDS_BYTES });
}

/** The chain entry after one block (pure). */
function nextEntry(entry, { hook, key, now, resetAt, continued }) {
  const toolCallSince = resetAt > entry.at;
  const sameEvent = entry.n > 0 && !toolCallSince && entry.key === key && now - entry.at < SAME_EVENT_MS;
  const hooks = [...new Set([...entry.hooks, hook])];
  if (sameEvent) return { ...entry, at: now, hooks };
  if (!continued || toolCallSince || entry.n === 0) return { n: 1, at: now, key, hooks: [hook], recorded: false };
  return { n: entry.n + 1, at: now, key, hooks, recorded: entry.recorded };
}

/** Parses the counts store; a corrupt file reads as empty (a chain may then be undercounted once). */
function parseCounts(text) {
  try {
    const agents = text === null ? {} : JSON.parse(text)?.agents;
    return agents !== null && typeof agents === 'object' ? agents : {};
  } catch {
    return {};
  }
}

const emptyEntry = () => ({ n: 0, at: 0, key: '', hooks: [], recorded: false });
const entryOf = (value) => (Number.isFinite(value?.n) && Number.isFinite(value?.at) && Array.isArray(value?.hooks) ? value : emptyEntry());
const eventKey = (input) => createHash('sha256').update(`${input.stop_hook_active === true}\0${String(input.last_assistant_message ?? '')}`).digest('hex');

/**
 * Counts one block of a Stop or SubagentStop gate (see the header) and appends `gate overridden` at the first block past the cap.
 * @param {string} hook the gate's name (e.g. `commit-gate`)
 * @param {{session_id?: string, agent_id?: string, stop_hook_active?: boolean, last_assistant_message?: string}} input the hook JSON
 * @param {Record<string, string | undefined>} [env] HOME
 * @returns {{count: number, overridden: boolean} | null} the chain's count after this block, overridden true when this block is past
 *   STOP_BLOCK_CAP; null when nothing could be counted
 */
export function countBlock(hook, input, env = process.env) {
  try {
    if (!HOOK_NAME.test(hook) || !usableIds(input)) return null;
    const dir = folder(env, 'counts');
    const resetAt = mtimeOf(join(baseDir(env), 'resets', `${input.session_id}--${agentKey(input)}`));
    const facts = { hook, key: eventKey(input), now: Date.now(), resetAt, continued: input.stop_hook_active === true };
    const entry = dir === null ? undefined : withSessionLock(dir, input.session_id, () => {
      const agents = parseCounts(readSessionFile(dir, input.session_id, MAX_COUNTS_BYTES) ?? null);
      const next = nextEntry(entryOf(agents[agentKey(input)]), facts);
      const kept = Object.fromEntries(Object.entries({ ...agents, [agentKey(input)]: next }).slice(-AGENTS_KEPT));
      return writeSessionFile(dir, input.session_id, JSON.stringify({ agents: kept })) ? next : undefined;
    });
    if (entry === undefined) return null;
    const overridden = entry.n > STOP_BLOCK_CAP;
    if (overridden && !entry.recorded && appendRecord(env, input, `gate overridden: ${entry.hooks.join(', ')}`)) markRecorded(dir, input);
    return { count: entry.n, overridden };
  } catch {
    return null; // a counter must never trap a session
  }
}

/** Marks the chain's override as recorded, so it is appended once per chain. */
function markRecorded(dir, input) {
  withSessionLock(dir, input.session_id, () => {
    const agents = parseCounts(readSessionFile(dir, input.session_id, MAX_COUNTS_BYTES) ?? null);
    const entry = entryOf(agents[agentKey(input)]);
    return writeSessionFile(dir, input.session_id, JSON.stringify({ agents: { ...agents, [agentKey(input)]: { ...entry, recorded: true } } }));
  });
}

/**
 * Leaves the start mark of one gate run; a mark of the same hook, session and agent still there is an earlier run that never returned.
 * @returns {string | null} the mark's path for gateFinished; null when nothing could be marked
 */
export function gateStarted(hook, input, env = process.env) {
  try {
    if (!HOOK_NAME.test(hook) || !usableIds(input)) return null;
    const dir = folder(env, 'runs');
    if (dir === null) return null;
    const mark = join(dir, `${input.session_id}--${agentKey(input)}--${hook}`);
    if (mtimeOf(mark) > 0) appendRecord(env, input, `gate crashed or timed out: ${hook}`);
    touch(mark);
    return mark;
  } catch {
    return null;
  }
}

/** Removes a start mark (the gate returned). */
export function gateFinished(mark) {
  try {
    if (typeof mark === 'string') unlinkSync(mark);
  } catch {
    // already gone: nothing to clear
  }
}

/** Appends `gate crashed or timed out: <hook>` for a crash the gate caught itself. @returns {boolean} true when appended */
export function recordGateCrash(hook, input, env = process.env) {
  try {
    return HOOK_NAME.test(hook) && appendRecord(env, input, `gate crashed or timed out: ${hook}`);
  } catch {
    return false;
  }
}

/**
 * Runs one gate decision with the start mark around it and counts it when it blocks; for any other event `run` only runs.
 * @param {string} hook the gate's name
 * @param {object} input the hook JSON (hook_event_name, session_id, agent_id, stop_hook_active, last_assistant_message)
 * @template T
 * @param {() => T | Promise<T>} run the decision: it blocks the stop when it returns true or an object with `block: true`
 * @param {Record<string, string | undefined>} [env] HOME
 * @returns {Promise<T>} what run returned
 * @throws what run throws, after recording it as a crash
 */
export async function countedGate(hook, input, run, env = process.env) {
  if (!STOP_EVENTS.has(input?.hook_event_name)) return run();
  const mark = gateStarted(hook, input, env);
  try {
    const outcome = await run();
    if (outcome === true || outcome?.block === true) countBlock(hook, input, env);
    return outcome;
  } catch (error) {
    recordGateCrash(hook, input, env);
    throw error;
  } finally {
    gateFinished(mark);
  }
}

/** Writes the reset marker of this session and agent (PostToolUse: Claude made a tool call, so Claude Code's count starts over). */
export function markToolCall(input, env = process.env) {
  try {
    if (!usableIds(input)) return;
    const dir = folder(env, 'resets');
    if (dir !== null) touch(join(dir, `${input.session_id}--${agentKey(input)}`));
  } catch {
    // no marker: a chain may be counted past a tool call once
  }
}

/**
 * At session start: every start mark older than STALE_MARK_MS is a gate run that never returned; each becomes a record and is removed.
 * @returns {number} the marks recorded
 */
export function sweepStaleMarks(env = process.env, nowMs = Date.now()) {
  try {
    const dir = join(baseDir(env), 'runs');
    let swept = 0;
    for (const name of readdirSync(dir)) {
      const parts = name.split('--');
      const path = join(dir, name);
      const at = mtimeOf(path);
      if (parts.length !== MARK_NAME_PARTS || at === 0 || nowMs - at < STALE_MARK_MS || !HOOK_NAME.test(parts[2])) continue;
      const input = { session_id: parts[0], agent_id: parts[1] === LEAD_KEY ? undefined : parts[1] };
      if (appendRecord(env, input, `gate crashed or timed out: ${parts[2]}`)) swept += 1;
      gateFinished(path);
    }
    return swept;
  } catch {
    return 0; // no runs folder yet
  }
}

/**
 * The records, oldest first.
 * @param {Record<string, string | undefined>} [env] HOME
 * @param {{sinceMs?: number, max?: number}} [options] only records after sinceMs; at most max (the newest)
 * @returns {{at: number, session: string, agent: string, text: string}[]}
 */
export function readRecords(env = process.env, { sinceMs = 0, max = Infinity } = {}) {
  let text = '';
  try {
    text = readPlainFile(join(baseDir(env), 'records.jsonl'), MAX_RECORDS_BYTES);
  } catch {
    return []; // no records yet
  }
  const records = text.split('\n').flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return Number.isFinite(record?.at) && typeof record.text === 'string' && record.at > sinceMs ? [record] : [];
    } catch {
      return []; // an empty or cut line
    }
  });
  return records.slice(-max);
}

/**
 * The session-start lines for records the last notice did not show (sweeping stale marks first), and marks them shown.
 * @returns {string} '' when there is nothing new
 */
export function recordsNotice(env = process.env, nowMs = Date.now()) {
  try {
    sweepStaleMarks(env, nowMs);
    const shown = join(baseDir(env), 'records.shown');
    const records = readRecords(env, { sinceMs: mtimeOf(shown), max: NOTICE_MAX });
    if (records.length === 0) return '';
    touch(shown);
    const lines = records.map((record) => `- ${new Date(record.at).toISOString()} ${record.agent}: ${record.text}`);
    return ['Stop gates since the last session start (no proof rests on a Stop block alone; check the work these turns ended on):', ...lines].join('\n');
  } catch {
    return '';
  }
}
