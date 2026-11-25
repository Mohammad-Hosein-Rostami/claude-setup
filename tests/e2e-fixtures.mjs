// Fixture transcripts for the e2e harness tests (not a test file): lines in the shape Claude Code writes them (tests/e2e/lib/
// transcripts.mjs header), and a projects folder on disk that holds a boss session with its subagents. Exports: FIXTURE_START,
// at(seconds), say(text, seconds, model), call(id, name, input, seconds), result(id, text, options), bash(id, command, options),
// agentCall(id, input, options), notice(taskId, status, seconds), briefLine(text, seconds), writeSession(projectsDir, cwd, spec),
// madeUpToken(kind).
// Why: every checker gets a pass and a fail case built from the same few line makers, so a fixture differs from its twin only in
// the one thing the check is about.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectKey } from './e2e/lib/transcripts.mjs';

/** The fixtures' clock: every line is this many seconds after it. */
export const FIXTURE_START = Date.parse('2026-11-20T10:00:00.000Z');
const FIXTURE_MODEL = 'claude-sonnet-5-5';

export const at = (seconds = 0) => new Date(FIXTURE_START + seconds * 1000).toISOString();

/** An assistant text block. */
export const say = (text, seconds = 0, model = FIXTURE_MODEL) => ({ type: 'assistant', timestamp: at(seconds), message: { model, content: [{ type: 'text', text }] } });

/** An assistant tool call. */
export const call = (id, name, input, seconds = 0, model = FIXTURE_MODEL) => ({
  type: 'assistant', timestamp: at(seconds), message: { model, content: [{ type: 'tool_use', id, name, input }] },
});

/** The tool result of call `id`. */
export const result = (id, text, { isError = false, meta = {}, seconds = 0 } = {}) => ({
  type: 'user', timestamp: at(seconds), toolUseResult: meta, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] },
});

/** A Bash call and its result; a background one returns its task id the way Claude Code does. */
export function bash(id, command, { background = false, seconds = 0, taskId = `task-${id}` } = {}) {
  const input = background ? { command, run_in_background: true } : { command };
  const meta = background ? { backgroundTaskId: taskId } : {};
  const text = background ? `Command running in background with ID: ${taskId}` : 'ok';
  return [call(id, 'Bash', input, seconds), result(id, text, { meta, seconds: seconds + 1 })];
}

/** An Agent call and its result: started (with an agent id) or denied (an error with the deny text). */
export function agentCall(id, input, { denied = false, denyText = 'denied', agentId = `a${id}`, seconds = 0, resolvedModel } = {}) {
  const meta = denied ? {} : { agentId, ...(resolvedModel ? { resolvedModel } : {}) };
  return [call(id, 'Agent', input, seconds), result(id, denied ? denyText : `started ${agentId}`, { isError: denied, meta, seconds: seconds + 1 })];
}

/** The notice Claude Code adds when a background task ends. */
export const notice = (taskId, status, seconds = 0) => briefLine(
  `<task-notification><task-id>${taskId}</task-id><status>${status}</status></task-notification>`, seconds);

/** A user text line (a brief or a notice). */
export const briefLine = (text, seconds = 0) => ({ type: 'user', timestamp: at(seconds), message: { content: text } });

const jsonl = (lines) => `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;

/**
 * Writes `<projectsDir>/<key of cwd>/<sessionId>.jsonl` and each subagent's transcript and meta file.
 * @param {{sessionId: string, lines: object[], agents?: {id: string, type: string, lines: object[]}[]}} spec
 * @returns {string} the session's project folder
 */
export function writeSession(projectsDir, cwd, { sessionId, lines, agents = [] }) {
  const folder = join(projectsDir, projectKey(cwd));
  const subagents = join(folder, sessionId, 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(folder, `${sessionId}.jsonl`), jsonl(lines));
  for (const agent of agents) {
    writeFileSync(join(subagents, `agent-${agent.id}.jsonl`), jsonl(agent.lines));
    writeFileSync(join(subagents, `agent-${agent.id}.meta.json`), JSON.stringify({ agentType: agent.type, description: agent.type }));
  }
  return folder;
}

/** A made-up token of the given kind, built from parts so no secret scanner reads a literal. */
export const madeUpToken = (kind = 'oat01') => ['sk', 'ant', kind, 'MadeUpE2eFixtureToken0000000000'].join('-');
