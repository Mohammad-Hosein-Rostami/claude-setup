// Which agents write files, and which writing agents of a session still run. agent-model-guard.mjs records each writer launch it lets
// start (PreToolUse Agent/Task); agent-budget.mjs, which already ends an agent's call counter on SubagentStop, records the finish here too.
// Why a record of its own: agent-budget's counter file appears only after an agent's first tool call and holds no agent type, so writers
// launched in parallel in one message would all see none running.
// Exports: agentFileWrites(type, env), isWritingAgent(type, env), recordWriterLaunch(session, type, env, options), recordWriterStop(session,
// agentId, type, env), WRITER_STALE_MS.
// Store: ~/.claude/state/agent-writers/<session>.json through lib/session-store.mjs (lstat-checked, locked, 0600):
// {"launches": [{"type", "at"}], "stopped": [agent ids]}. A stop has an agent id and type but a launch has only a type, so a stop ends the
// oldest launch of its type; the id is kept so a stop that comes again (another gate blocked it) ends nothing more.
// Limits: a stop that another SubagentStop gate blocks still counts as the finish (the agent may run a little longer); an agent that ends
// with no SubagentStop at all counts as running until its launch is WRITER_STALE_MS old.
// Invariants: never throws; an unusable store or a lock that stays taken returns undefined and the caller lets the call run.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSessionFile, withSessionLock, writeSessionFile } from './session-store.mjs';

export const WRITER_STALE_MS = 4 * 60 * 60 * 1000; // 4 h: far past the ~120-call agent budget
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

/** Parses the store; a corrupt or odd file reads as empty (a running writer may then be missed once). */
function parseRecord(text, now) {
  try {
    const record = text === null ? {} : JSON.parse(text);
    const launches = (Array.isArray(record?.launches) ? record.launches : [])
      .filter((launch) => typeof launch?.type === 'string' && Number.isFinite(launch.at) && now - launch.at < WRITER_STALE_MS);
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
    const record = parseRecord(text, now);
    if (unlessRunning && record.launches.length > 0) return 'running';
    return store(env, session, { ...record, launches: [...record.launches, { type: typeOf(type), at: now }] }) ? 'recorded' : undefined;
  });
}

/**
 * Records that an agent stopped: ends the oldest running launch of its type, once per agent id.
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
    const record = parseRecord(text, Date.now());
    const index = record.launches.findIndex((launch) => launch.type === typeOf(type));
    if (record.stopped.includes(agentId) || index === -1) return false;
    const launches = record.launches.filter((_, at) => at !== index);
    return store(env, session, { launches, stopped: [...record.stopped, agentId] });
  }) === true;
}
