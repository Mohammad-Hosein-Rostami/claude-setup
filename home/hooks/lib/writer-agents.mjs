// Which agents write files, and which writing agents of a session still run. agent-model-guard.mjs records each writer launch it lets
// start (PreToolUse Agent/Task) as pending; agent-budget.mjs marks it started on SubagentStart and ends it on SubagentStop.
// Why a record of its own: agent-budget's counter file appears only after an agent's first tool call and holds no agent type, so writers
// launched in parallel in one message would all see none running.
// Exports: agentFileWrites(type, env), isWritingAgent(type, env), recordWriterLaunch(session, type, env, options), recordWriterStart(session,
// agentId, type, env), recordWriterStop(session, agentId, type, env), callCounterPath(session, agentId), PENDING_MS, IDLE_MS.
// Store: ~/.claude/state/agent-writers/<session>.json through lib/session-store.mjs (lstat-checked, locked, 0600):
// {"launches": [{"type", "at", "agent"?}], "stopped": [agent ids]}. SubagentStart has the agent id and type but no tool_use_id, so it
// marks the oldest pending launch of its type started (agent = its id, at = the start); a stop ends the launch of its id, else the oldest
// of its type; stopped ids are kept so a stop that comes again (another gate blocked it) ends nothing more.
// When a launch counts as running (Claude Code 2.1.325: a launch the owner or a sibling hook denies, or Esc cuts before it starts, gets no
// SubagentStart and no SubagentStop, so a launch alone proves nothing):
//   pending (no SubagentStart yet): for PENDING_MS after the launch: long enough for writers sent in one message to see each other and
//     for a permission dialog, short enough that a denied launch stops blocking others within minutes;
//   started: while its last sign of work is under IDLE_MS old: the later of its start and its last tool call (the mtime of the call
//     counter agent-budget.mjs appends to on each tool call, callCounterPath). A working agent makes a tool call far more often than
//     that; one that ended without SubagentStop stops counting after IDLE_MS;
//   never: a launch dated more than CLOCK_SKEW_MS ahead of the clock (a clock step back or a planted record).
// Limits: a stop that another SubagentStop gate blocks still counts as the finish (the agent may run a little longer); a single tool call
// that runs longer than IDLE_MS (a long build) lets one more writer start without the advice.
// Invariants: never throws; an unusable store or a lock that stays taken returns undefined and the caller lets the call run.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkedTempRoot } from './edit-log.mjs';
import { withSessionLock } from './session-lock.mjs';
import { readSessionFile, writeSessionFile } from './session-store.mjs';

export const PENDING_MS = 2 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const SAFE_ID = /^[\w-]{1,128}$/;
const MAX_STORE_BYTES = 64 * 1024;
const LAUNCHES_KEPT = 100;
const STOPPED_IDS_KEPT = 200;
const AGENT_FILE_BYTES = 64 * 1024;
const AGENT_TYPE = /^[\w-]{1,64}$/; // a name that can be a file name part; plugin agents (`plugin:name`) have no file here
const WRITING_TOOLS = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;
const DEFAULT_TYPE = 'general-purpose'; // what an Agent call with no subagent_type runs
const WRITER_TYPES = new Set(['implementer', 'ui-implementer', 'test-writer', 'general-purpose', 'claude']);
const READ_ONLY_TYPES = new Set(['scout', 'runner', 'reviewer', 'security-auditor', 'Explore', 'Plan', 'architect']);

const writersDir = (env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'agent-writers');
const typeOf = (type) => (typeof type === 'string' && type !== '' ? type : DEFAULT_TYPE);

/** The first `maxBytes` of a regular file as text; null when it is missing, not a regular file or unreadable. */
function readHead(path, maxBytes) {
  try {
    if (!statSync(path).isFile()) return null;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, maxBytes, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // no file means no answer
  }
}

/**
 * Whether the agent file of `type` lets it write: the project's `.claude/agents/<type>.md` wins over the user's.
 * @param {unknown} type the agent type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE and CLAUDE_PROJECT_DIR
 * @returns {boolean | undefined} true when its `tools:` line names Write/Edit/MultiEdit/NotebookEdit or is missing (all tools), false
 *   when it names none of them, undefined when there is no such file or the type is no file name
 */
export function agentFileWrites(type, env) {
  if (typeof type !== 'string' || !AGENT_TYPE.test(type)) return undefined;
  const home = env.HOME || env.USERPROFILE || homedir();
  const folders = [env.CLAUDE_PROJECT_DIR, home].filter(Boolean).map((root) => join(root, '.claude', 'agents'));
  const text = folders.map((folder) => readHead(join(folder, `${type}.md`), AGENT_FILE_BYTES)).find((found) => found !== null);
  if (text === undefined) return undefined;
  const tools = text.match(/^tools:(.*)$/m);
  return !tools || WRITING_TOOLS.test(tools[1]);
}

/**
 * Whether an Agent call of `type` launches a writing agent: the read-only set never does, the writer set (and no type) always does,
 * any other type only when its agent file lets it write (a fork or a plugin agent with no file does not count).
 * @param {unknown} type tool_input.subagent_type
 * @param {Record<string, string | undefined>} env as for agentFileWrites
 * @returns {boolean}
 */
export function isWritingAgent(type, env) {
  const name = typeOf(type);
  if (READ_ONLY_TYPES.has(name)) return false;
  return WRITER_TYPES.has(name) || agentFileWrites(name, env) === true;
}

/**
 * The file agent-budget.mjs appends one byte to on each tool call of a subagent (its mtime is the agent's last tool call).
 * @returns {string | null} the path; null when an id is not a safe file name part or the hook temp root is refused (lib/edit-log.mjs)
 */
export function callCounterPath(session, agentId) {
  if (!SAFE_ID.test(session ?? '') || !SAFE_ID.test(agentId ?? '')) return null;
  const root = checkedTempRoot();
  return root === null ? null : join(root, 'budget', `${session}--${agentId}`);
}

/** The time of an agent's last tool call, or 0 when it has made none (or its counter cannot be read). */
function lastToolCall(session, agentId) {
  const path = callCounterPath(session, agentId);
  try {
    return path === null ? 0 : statSync(path).mtimeMs;
  } catch {
    return 0; // no tool call yet
  }
}

/** Whether a stored launch still counts as a running writer (the rules in the header). */
function isRunning(launch, now, session) {
  if (launch.at > now + CLOCK_SKEW_MS) return false;
  if (typeof launch.agent !== 'string') return now - launch.at < PENDING_MS;
  return now - Math.max(launch.at, lastToolCall(session, launch.agent)) < IDLE_MS;
}

/** Parses the store, keeping the launches that still run; a corrupt or odd file reads as empty (a running writer may then be missed once). */
function parseRecord(text, now, session) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const launches = (Array.isArray(record?.launches) ? record.launches : [])
      .filter((launch) => typeof launch?.type === 'string' && Number.isFinite(launch.at) && isRunning(launch, now, session));
    const stopped = (Array.isArray(record?.stopped) ? record.stopped : []).filter((id) => typeof id === 'string');
    return { launches, stopped };
  } catch {
    return { launches: [], stopped: [] };
  }
}

const store = (env, session, record) => writeSessionFile(writersDir(env), session, JSON.stringify({
  launches: record.launches.slice(-LAUNCHES_KEPT), stopped: record.stopped.slice(-STOPPED_IDS_KEPT),
}));

/**
 * Records one writer launch, read and written under the session's lock, so writers launched in parallel see each other.
 * @param {unknown} session hook input session_id
 * @param {unknown} type tool_input.subagent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @param {{unlessRunning?: boolean}} [options] unlessRunning: record nothing when another writer still runs
 * @returns {'recorded' | 'running' | undefined} 'running' when unlessRunning found a running writer (nothing recorded); undefined when
 *   the store is unusable, still locked or the write failed
 */
export function recordWriterLaunch(session, type, env, { unlessRunning = false } = {}) {
  const dir = writersDir(env);
  return withSessionLock(dir, session, () => {
    const now = Date.now();
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined) return undefined;
    const record = parseRecord(text, now, session);
    if (unlessRunning && record.launches.length > 0) return 'running';
    return store(env, session, { ...record, launches: [...record.launches, { type: typeOf(type), at: now }] }) ? 'recorded' : undefined;
  });
}

/**
 * Records that an agent started (SubagentStart): the oldest pending launch of its type becomes its launch, dated now.
 * @param {unknown} session hook input session_id
 * @param {unknown} agentId hook input agent_id
 * @param {unknown} type hook input agent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} true when a pending launch was marked started (false for no such launch: not a writer this hook let start)
 */
export function recordWriterStart(session, agentId, type, env) {
  if (typeof agentId !== 'string' || agentId === '') return false;
  const dir = writersDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined || text === null) return false;
    const now = Date.now();
    const record = parseRecord(text, now, session);
    const index = record.launches.findIndex((launch) => launch.type === typeOf(type) && typeof launch.agent !== 'string');
    if (index === -1) return false;
    const launches = record.launches.map((launch, at) => (at === index ? { type: launch.type, at: now, agent: agentId } : launch));
    return store(env, session, { ...record, launches });
  }) === true;
}

/**
 * Records that an agent stopped: ends the launch of its agent id, else the oldest running launch of its type, once per agent id.
 * @param {unknown} session hook input session_id
 * @param {unknown} agentId hook input agent_id
 * @param {unknown} type hook input agent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} true when a launch was ended
 */
export function recordWriterStop(session, agentId, type, env) {
  if (typeof agentId !== 'string' || agentId === '') return false;
  const dir = writersDir(env);
  return withSessionLock(dir, session, () => {
    const text = readSessionFile(dir, session, MAX_STORE_BYTES);
    if (text === undefined || text === null) return false;
    const record = parseRecord(text, Date.now(), session);
    const own = record.launches.findIndex((launch) => launch.agent === agentId);
    const index = own !== -1 ? own : record.launches.findIndex((launch) => launch.type === typeOf(type));
    if (record.stopped.includes(agentId) || index === -1) return false;
    const launches = record.launches.filter((_, at) => at !== index);
    return store(env, session, { launches, stopped: [...record.stopped, agentId] });
  }) === true;
}
