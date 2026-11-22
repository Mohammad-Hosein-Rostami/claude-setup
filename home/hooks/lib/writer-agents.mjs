// Which agent types write files, and the checks that read a session's launch record for a writer. The record itself (every agent's
// launch, start and stop, and the cap of agents running at once) lives in lib/agent-launches.mjs; this file keeps the questions about
// writers that commit-gate.mjs, read-only-hold.mjs, copy-branch-brief.mjs, gated-folder.mjs, agent-budget.mjs and the board ask.
// Exports: agentFileWrites(type, env), isWritingAgent(type, env), isReadOnlyBrief(prompt), agentTypeOf(type), callCounterPath(session,
// agentId), readOnlyLaunchOpen(session, agentId, type, env), openWritersOf(session, env, now), writersDirOf(env).
// Store: ~/.claude/state/agent-writers/<session>.json (a historic name: it held writer launches only; there is no migration), written
// through lib/agent-launches.mjs. `open` (spec-p3 r9-resume, lib/open-writers.mjs) is the launch record the resume notice reads: written
// before the agent starts, closed only at its SubagentStop, never dropped for idleness, so a writer cut off by an exit or a usage-limit
// stop is still listed in the next session. readOnlyAgents keeps the ids of started read-only launches after their stop, because
// commit-gate's read-only hold runs on the same SubagentStop as the stop record (hooks of one event run in parallel).
// Flags (round 9, r9-writer-gate): `isolated` (launched with isolation "worktree") and `readOnly` (a read-only brief, isReadOnlyBrief).
// Invariants: never throws; the read functions answer false or [] for a store that is missing or unusable. callCounterPath and
// agentTypeOf are called by lib/agent-launches.mjs, which imports this file (each file calls the other's functions only after loading).
import { readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkedTempRoot } from './edit-log.mjs';
import { readLaunchRecord } from './agent-launches.mjs';
import { readPlainFileWith } from './plain-file.mjs';

const SAFE_ID = /^[\w-]{1,128}$/;
const AGENT_FILE_BYTES = 64 * 1024;
const AGENT_TYPE = /^[\w-]{1,64}$/; // a name that can be a file name part; plugin agents (`plugin:name`) have no file here
const WRITING_TOOLS = /\b(?:Write|Edit|MultiEdit|NotebookEdit)\b/;
const DEFAULT_TYPE = 'general-purpose'; // what an Agent call with no subagent_type runs
// A brief line that declares the agent read-only; exact case, at the start of a trimmed line (commit-gate holds the agent to it at its stop)
const READ_ONLY_BRIEF_PREFIXES = ['read-only:', 'scratchpad-only:'];
const WRITER_TYPES = new Set(['implementer', 'ui-implementer', 'general-purpose', 'claude']);
const READ_ONLY_TYPES = new Set(['scout', 'runner', 'Explore', 'Plan', 'architect']);

/** The folder of the launch stores (one `<session>.json` each). */
export function writersDirOf(env) {
  return join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'agent-writers');
}

/** The type an Agent call runs: its subagent_type, or general-purpose when it names none. */
export function agentTypeOf(type) {
  return typeof type === 'string' && type !== '' ? type : DEFAULT_TYPE;
}

/**
 * The first `maxBytes` of a regular file as text; null when it is missing, not a regular file or unreadable. A link (an installed or
 * personal agent file) is followed once by realpath; the open itself follows no link and never waits (lib/plain-file.mjs), so a FIFO
 * at the path, or behind a link, even one swapped in after a check, never holds the hook.
 */
function readHead(path, maxBytes) {
  try {
    return readPlainFileWith(realpathSync(path), (fd) => {
      const buffer = Buffer.alloc(maxBytes);
      return buffer.toString('utf8', 0, readSync(fd, buffer, 0, maxBytes, 0));
    });
  } catch {
    return null; // no file means no answer
  }
}

/**
 * Whether the agent file of `type` lets it write: the project's `.claude/agents/<type>.md` wins over the user's.
 * @param {unknown} type the agent type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE and CLAUDE_PROJECT_DIR
 * @returns {boolean | undefined} true when its `tools:` line names Write/Edit/MultiEdit/NotebookEdit or is missing (all tools), false
 *   when it names none of them or its `disallowedTools:` line names both Write and Edit (road-cap 14a: visual-qa takes no writer slot),
 *   undefined when there is no such file or the type is no file name
 */
export function agentFileWrites(type, env) {
  if (typeof type !== 'string' || !AGENT_TYPE.test(type)) return undefined;
  const home = env.HOME || env.USERPROFILE || homedir();
  const folders = [env.CLAUDE_PROJECT_DIR, home].filter(Boolean).map((root) => join(root, '.claude', 'agents'));
  const text = folders.map((folder) => readHead(join(folder, `${type}.md`), AGENT_FILE_BYTES)).find((found) => found !== null);
  if (text === undefined) return undefined;
  const denied = text.match(/^disallowedTools:(.*)$/m);
  if (denied && /\bWrite\b/.test(denied[1]) && /\bEdit\b/.test(denied[1])) return false;
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
  const name = agentTypeOf(type);
  if (READ_ONLY_TYPES.has(name)) return false;
  return WRITER_TYPES.has(name) || agentFileWrites(name, env) === true;
}

/**
 * Whether a brief declares its agent read-only: one of its lines, split on CR LF or LF and trimmed, starts with `read-only:` or
 * `scratchpad-only:` in exactly that case. A mention inside a sentence or another case does not count.
 * @param {unknown} prompt tool_input.prompt (or the brief read back from the agent's transcript)
 * @returns {boolean} false for anything that is not a string
 */
export function isReadOnlyBrief(prompt) {
  if (typeof prompt !== 'string') return false;
  return prompt.split(/\r?\n/).some((line) => READ_ONLY_BRIEF_PREFIXES.some((prefix) => line.trim().startsWith(prefix)));
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

/**
 * Whether a stopping agent was launched read-only, for commit-gate's hold when the agent's brief cannot be read: a started read-only
 * launch with this agent id (kept after its stop), or a read-only launch of its type that has not ended. Read without the lock (a read).
 * @param {unknown} session hook input session_id
 * @param {unknown} agentId hook input agent_id
 * @param {unknown} type hook input agent_type
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @returns {boolean} false when there is no such launch or the store cannot be read
 */
export function readOnlyLaunchOpen(session, agentId, type, env) {
  if (typeof agentId !== 'string' || agentId === '') return false;
  const record = readLaunchRecord(session, env, Date.now());
  if (record === null) return false;
  if (record.readOnlyAgents.includes(agentId)) return true;
  return record.launches.some((launch) => launch.readOnly === true && (launch.agent === agentId || launch.type === agentTypeOf(type)));
}

/**
 * The open launch records of a session (no finish recorded yet), oldest first; read without the lock (a read).
 * @param {unknown} session a session id
 * @param {Record<string, string | undefined>} env HOME / USERPROFILE
 * @param {number} now epoch ms
 * @returns {object[]} [] when the store is missing or unreadable
 */
export function openWritersOf(session, env, now) {
  return readLaunchRecord(session, env, now)?.open ?? [];
}
