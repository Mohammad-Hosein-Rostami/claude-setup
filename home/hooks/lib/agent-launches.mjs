// The launch record of every agent of a session, read by the writer isolation gate. agent-model-guard.mjs records each Agent/Task
// launch it lets start (PreToolUse) as pending; agent-budget.mjs marks it started on SubagentStart and ends it on SubagentStop.
// Why a record of its own: agent-budget's counter file appears only after an agent's first tool call and holds no agent type, so agents
// launched in parallel in one message would all see none running, and the writer isolation rule needs the others.
// Exports: PENDING_MS, IDLE_MS, recordAgentLaunch(session, type, env, options), recordAgentStart(session, agentId, type,
// env), recordAgentStop(session, agentId, type, env), runningAgentsOf(session, env, now), readLaunchRecord(session, env, now).
// Store: ~/.claude/state/agent-writers/<session>.json through lib/session-store.mjs (lstat-checked, locked, 0600). The folder is called
// "writers" for historic reasons (it held writer launches only); it keeps its name, there is no migration:
// {"launches": [{"type", "at", "writer"?, "agent"?, "isolated"?, "readOnly"?, "unmatched"?}], "stoppedAt": {agent id: ms},
// "stoppedTypes": {agent id: type}, "open": [open writer launches, lib/open-writers.mjs]}.
// An older store may hold `stopped: [ids]` and a list of read-only agent ids (both ignored, dropped on the next write) and launches with no
// `writer` key (each counts as a writer, as before). The main-agent cap is agent-budget.mjs's, not this record's. Running means:
//   pending (no SubagentStart yet): for PENDING_MS after the launch: long enough for agents sent in one message to see each other and
//     for a permission dialog, short enough that a denied launch stops holding a slot within minutes (Claude Code 2.1.325: a launch a
//     sibling hook denies, or Esc cuts, gets no SubagentStart and no SubagentStop);
//   started: while its last sign of work is under IDLE_MS old: the later of its start and its last tool call (the mtime of the call
//     counter agent-budget.mjs appends to, callCounterPath); one that ended without SubagentStop stops counting after IDLE_MS;
//   resumed: a stopped agent whose call counter is newer than its stop (SendMessage continues it; the counter is removed at its stop)
//     and under IDLE_MS old (U3: whether SubagentStart fires again is not known, so the counter decides);
//   never: a launch dated more than CLOCK_SKEW_MS ahead of the clock (a clock step back or a planted record).
// A SubagentStart that matches no pending launch of its type (a fork, a nested launch, a launch older than PENDING_MS) is recorded as an
// `unmatched` started launch: it is listed as running and never counts for writer isolation (U4: over-count, never under-count).
// Writer isolation keeps its old rule: only a running launch of a writer with no `isolated` / `readOnly` flag (and not `unmatched`)
// makes a later plain writer bounce (`unlessRunning`); a stored launch with no `writer` key counts as a writer. A lane worktree is one
// writer's folder: a launch that claims `worktree` while an open record (lib/open-writers.mjs, closed only at its SubagentStop) already
// has that folder as its cwd is `held` and nothing is recorded, checked under the same lock, so parallel launches see each other.
// Limits: a stop another SubagentStop gate blocks still counts as the finish; one tool call longer than IDLE_MS makes the agent look idle.
// Invariants: never throws; an unusable store or a lock that stays taken is `unusable` (the guard denies, P3 fail closed), and a failed
// SubagentStart or SubagentStop record returns false. lib/writer-agents.mjs and this file import each other's functions, only called
// after both are loaded (callCounterPath and writersDirOf stay there for agent-budget.mjs and the board).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { addOpen, launchAbout, parseOpen, startOpen, stopOpen } from './open-writers.mjs';
import { withSessionLock } from './session-lock.mjs';
import { readSessionFile, writeSessionFile } from './session-store.mjs';
import { agentTypeOf, callCounterPath, writersDirOf } from './writer-agents.mjs';

export const PENDING_MS = 2 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const MAX_STORE_BYTES = 64 * 1024; // the writer trims to it and the reader refuses more (P6)
const LAUNCHES_KEPT = 100;
const STOPPED_IDS_KEPT = 200;
const SAFE_ID = /^[\w-]{1,128}$/;

/** The time of an agent's last tool call, or 0 when it has made none (or its counter cannot be read). */
function lastToolCall(session, agentId) {
  const path = callCounterPath(session, agentId);
  try {
    return path === null ? 0 : statSync(path).mtimeMs;
  } catch {
    return 0; // no tool call yet
  }
}

/** Whether a stored launch still counts as running (the rules in the header). */
function isRunning(launch, now, session) {
  if (launch.at > now + CLOCK_SKEW_MS) return false;
  if (typeof launch.agent !== 'string') return now - launch.at < PENDING_MS;
  return now - Math.max(launch.at, lastToolCall(session, launch.agent)) < IDLE_MS;
}

/** The entries of a stored {agent id: value} map whose key is a safe id and whose value passes `valid`. */
function idMap(value, valid) {
  const entries = value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  return Object.fromEntries(entries.filter(([id, item]) => SAFE_ID.test(id) && valid(item)));
}

/** Parses the store, keeping the launches that still run; a corrupt or odd file reads as empty (a running agent may then be missed once). */
function parseRecord(text, now, session) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const launches = (Array.isArray(record?.launches) ? record.launches : [])
      .filter((launch) => typeof launch?.type === 'string' && Number.isFinite(launch.at) && isRunning(launch, now, session));
    return {
      launches,
      stoppedAt: idMap(record?.stoppedAt, Number.isFinite),
      stoppedTypes: idMap(record?.stoppedTypes, (type) => typeof type === 'string'),
      open: parseOpen(record?.open, now),
    };
  } catch {
    return { launches: [], stoppedAt: {}, stoppedTypes: {}, open: [] };
  }
}

/** The stored text: the newest launches and stopped ids; the oldest open records go first when it would pass MAX_STORE_BYTES. */
function serialized(record) {
  const kept = Object.entries(record.stoppedAt).sort(([, first], [, second]) => first - second).slice(-STOPPED_IDS_KEPT).map(([id]) => id);
  const pick = (map) => Object.fromEntries(kept.filter((id) => id in map).map((id) => [id, map[id]]));
  const text = JSON.stringify({
    launches: record.launches.slice(-LAUNCHES_KEPT),
    stoppedAt: pick(record.stoppedAt),
    stoppedTypes: pick(record.stoppedTypes),
    open: record.open,
  });
  return Buffer.byteLength(text) <= MAX_STORE_BYTES || record.open.length === 0 ? text : serialized({ ...record, open: record.open.slice(1) });
}

const store = (env, session, record) => writeSessionFile(writersDirOf(env), session, serialized(record));

/** The running agents of a parsed record: its running launches, and the stopped agents that made a tool call after their stop. */
function runningOf(record, session, now) {
  const started = new Set(record.launches.map((launch) => launch.agent));
  const resumed = Object.entries(record.stoppedAt)
    .filter(([agent]) => !started.has(agent))
    .map(([agent, stoppedAt]) => ({ agent, at: lastToolCall(session, agent), stoppedAt }))
    .filter(({ at, stoppedAt }) => at > stoppedAt && at <= now + CLOCK_SKEW_MS && now - at < IDLE_MS)
    .map(({ agent, at }) => ({ type: record.stoppedTypes[agent] ?? 'agent', agent, at }));
  const launched = record.launches.map(({ type, agent, at }) => ({ type, ...(typeof agent === 'string' ? { agent } : {}), at }));
  return [...launched, ...resumed];
}

/** A launch that makes a later plain writer bounce: a writer's, with neither flag, that this hook let start. */
const isPlainWriter = (launch) => launch.writer !== false && launch.unmatched !== true && launch.isolated !== true && launch.readOnly !== true;

/** The stored launch: its type and time, `writer`, and each flag only when set. */
const newLaunch = (type, at, { writer, isolated, readOnly }) => ({
  type: agentTypeOf(type), at, writer, ...(isolated ? { isolated: true } : {}), ...(readOnly ? { readOnly: true } : {}),
});

/**
 * Records one agent launch, read and written under the session's lock, so agents launched in parallel see each other.
 * @param {unknown} session hook input session_id
 * @param {unknown} type tool_input.subagent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @param {{writer?: boolean, unlessRunning?: boolean, isolated?: boolean, readOnly?: boolean, worktree?: string | null, about?: {cwd?: unknown, description?: unknown, prompt?: unknown}}} [options]
 *   writer: the agent type writes files (it also gets an open record for the resume notice); unlessRunning: record nothing when a plain
 *   writer still runs; isolated / readOnly: the flags this launch is recorded with; worktree: the lane worktree this launch is isolated
 *   by (record nothing when an open record holds it); about: the call's cwd, description and brief, kept (cwd, description, the row the
 *   brief names) in the open record
 * @returns {{state: 'recorded' | 'held' | 'running' | 'unusable', running: Array<{type: string, agent?: string, at: number}>, storePath: string}}
 *   `running` lists the agents running (with the new one when recorded; empty when unusable); 'held' when another open record has
 *   `worktree` as its cwd; 'unusable' when the store cannot be read or written or the lock stays taken
 */
export function recordAgentLaunch(session, type, env, { writer = false, unlessRunning = false, isolated = false, readOnly = false, worktree = null, about = undefined } = {}) {
  const dir = writersDirOf(env);
  const done = withSessionLock(dir, session, () => {
    const now = Date.now();
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return { state: 'unusable', running: [] };
    const record = parseRecord(text, now, session);
    const running = runningOf(record, session, now);
    // compared as stored: launchAbout cuts and cleans the cwd, so a long or odd path still matches its own record
    const heldCwd = typeof worktree === 'string' ? launchAbout({ cwd: worktree }).cwd : undefined;
    if (heldCwd !== undefined && record.open.some((entry) => entry.cwd === heldCwd)) return { state: 'held', running };
    if (unlessRunning && record.launches.some(isPlainWriter)) return { state: 'running', running };
    const launches = [...record.launches, newLaunch(type, now, { writer, isolated, readOnly })];
    const entry = { type: agentTypeOf(type), at: now, ...launchAbout(about), ...(isolated ? { isolated: true } : {}) };
    const open = writer ? addOpen(record.open, entry, now) : record.open;
    const saved = store(env, session, { ...record, launches, open });
    return saved ? { state: 'recorded', running: [...running, { type: agentTypeOf(type), at: now }] } : { state: 'unusable', running: [] };
  });
  return { ...(done ?? { state: 'unusable', running: [] }), storePath: join(dir, `${session}.json`) };
}

/**
 * Records that an agent started (SubagentStart): the oldest pending launch of its type becomes its launch, dated now; with none, the
 * agent is recorded as an unmatched started launch. A stopped agent that starts again is no longer stopped.
 * @param {unknown} session hook input session_id
 * @param {unknown} agentId hook input agent_id
 * @param {unknown} type hook input agent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} true when the start was recorded (false for no agent id, an agent already started, or an unusable store)
 */
export function recordAgentStart(session, agentId, type, env) {
  if (typeof agentId !== 'string' || agentId === '') return false;
  const dir = writersDirOf(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return false;
    const now = Date.now();
    const record = parseRecord(text, now, session);
    if (record.launches.some((launch) => launch.agent === agentId)) return false;
    const name = agentTypeOf(type);
    const index = record.launches.findIndex((launch) => launch.type === name && typeof launch.agent !== 'string');
    const launches = index === -1
      ? [...record.launches, { type: name, at: now, agent: agentId, unmatched: true }]
      : record.launches.map((launch, at) => (at === index ? { ...launch, at: now, agent: agentId } : launch));
    const { [agentId]: _stoppedAt, ...stoppedAt } = record.stoppedAt;
    const { [agentId]: _stoppedType, ...stoppedTypes } = record.stoppedTypes;
    return store(env, session, { ...record, launches, stoppedAt, stoppedTypes, open: startOpen(record.open, agentId, name) });
  }) === true;
}

/**
 * Records that an agent stopped: ends the launch of its agent id (else the oldest pending launch of its type) and stores
 * stoppedAt[agentId]. A stop that comes again ends nothing more, unless the agent made a tool call since its stop (a SendMessage resume).
 * @param {unknown} session hook input session_id
 * @param {unknown} agentId hook input agent_id
 * @param {unknown} type hook input agent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} true when a launch or a resumed agent was ended
 */
export function recordAgentStop(session, agentId, type, env) {
  if (typeof agentId !== 'string' || agentId === '') return false;
  const dir = writersDirOf(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined || text === null) return false;
    const now = Date.now();
    const record = parseRecord(text, now, session);
    const name = agentTypeOf(type);
    const stopped = (launches, open) => store(env, session, {
      ...record, launches, open, stoppedAt: { ...record.stoppedAt, [agentId]: now }, stoppedTypes: { ...record.stoppedTypes, [agentId]: name },
    });
    if (Object.hasOwn(record.stoppedAt, agentId)) {
      return lastToolCall(session, agentId) > record.stoppedAt[agentId] && stopped(record.launches, record.open); // resumed, stops again
    }
    const own = record.launches.findIndex((launch) => launch.agent === agentId);
    const index = own !== -1 ? own : record.launches.findIndex((launch) => launch.type === name && typeof launch.agent !== 'string');
    const open = stopOpen(record.open, agentId, name); // the open record closes even when the running launch aged out
    return stopped(record.launches.filter((_, at) => at !== index), open) && index !== -1;
  }) === true;
}

/**
 * The parsed launch record of a session (running launches only), read without the lock (a read).
 * @param {unknown} session a session id
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @param {number} now epoch ms
 * @returns {{launches: object[], stoppedAt: object, stoppedTypes: object, open: object[]} | null} null when the store is missing or unreadable
 */
export function readLaunchRecord(session, env, now) {
  const text = readSessionFile(writersDirOf(env), session, MAX_STORE_BYTES);
  return typeof text === 'string' ? parseRecord(text, now, session) : null;
}

/**
 * The agents running at `now`: pending launches, started agents not idle, and resumed agents (the rules in the header).
 * @returns {Array<{type: string, agent?: string, at: number}>} [] when the store is missing or unreadable
 */
export function runningAgentsOf(session, env, now) {
  const record = readLaunchRecord(session, env, now);
  return record === null ? [] : runningOf(record, session, now);
}
