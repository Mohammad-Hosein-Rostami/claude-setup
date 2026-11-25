// Reads the session transcripts a scenario's `claude` runs left under `<home>/.claude/projects/`. Exports: projectKey(dir),
// readJsonl(file), findSessionFile(projectsDir, sessionId), loadSession(projectsDir, sessionId), toolCalls(lines),
// sessionsInFolder(projectsDir, dir), assistantTexts(lines), finalText(lines), userTexts(lines), agentStarts(calls).
// Format (Claude Code 2.1.330, internal, observed; the board's agent-transcript.mjs reads the same lines incrementally): one JSON
// object per line, `type` user | assistant | system, `timestamp`, `message.content` (a string, or blocks `text`, `tool_use` {id,
// name, input}, `tool_result` {tool_use_id, is_error, content}), and on a user line `toolUseResult` (Bash: `backgroundTaskId`;
// Agent: `agentId`, `resolvedModel`, `status`). A session is `<key>/<session>.jsonl`; its subagents are
// `<key>/<session>/subagents/agent-<id>.jsonl` with `agent-<id>.meta.json` ({agentType, description}).
// Invariants: never throws on a missing or bad file (an empty list; the checks then FAIL on "none seen", never PASS); reads whole
// files (a finished run's transcripts are small enough); the key is found by the session id, so a key rule change cannot hide one.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_FILE = /^agent-([A-Za-z0-9]+)\.jsonl$/;

/** @returns {string} Claude Code's project folder name for a working folder: the real path with every non-alphanumeric as `-` */
export function projectKey(dir) {
  let real = dir;
  try { real = realpathSync(dir); } catch { /* not made yet (dry run): the path as given */ }
  return real.replace(/[^A-Za-z0-9]/g, '-');
}

/** @returns {object[]} the JSON lines of a file; none when it is missing or unreadable */
export function readJsonl(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => {
    try {
      const value = line.trim() ? JSON.parse(line) : null;
      return value !== null && typeof value === 'object' ? [value] : [];
    } catch {
      return [];
    }
  });
}

const namesIn = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const timeOf = (line) => { const ms = Date.parse(line?.timestamp ?? ''); return Number.isFinite(ms) ? ms : null; };

/** @returns {{key: string, file: string} | null} the main transcript of a session, in whichever project folder holds it */
export function findSessionFile(projectsDir, sessionId) {
  for (const key of namesIn(projectsDir)) {
    const file = join(projectsDir, key, `${sessionId}.jsonl`);
    if (existsSync(file)) return { key, file };
  }
  return null;
}

/**
 * @param {string} projectsDir `<home>/.claude/projects`
 * @param {string} sessionId the run's session id (from the stream)
 * @returns {{id: string, key: string | null, lines: object[], agents: {id: string, type: string, description: string,
 *   lines: object[]}[]}} the session; empty lists when its transcript is missing
 */
export function loadSession(projectsDir, sessionId) {
  const found = findSessionFile(projectsDir, sessionId);
  if (found === null) return { id: sessionId, key: null, lines: [], agents: [] };
  const folder = join(projectsDir, found.key, sessionId, 'subagents');
  const agents = namesIn(folder).flatMap((name) => {
    const id = AGENT_FILE.exec(name)?.[1];
    if (id === undefined) return [];
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(folder, `agent-${id}.meta.json`), 'utf8')) ?? {}; } catch { /* no meta: type unknown */ }
    return [{ id, type: String(meta.agentType ?? '?'), description: String(meta.description ?? ''), lines: readJsonl(join(folder, name)) }];
  });
  return { id: sessionId, key: found.key, lines: readJsonl(found.file), agents };
}

/**
 * Every session Claude Code kept for one working folder (E9: the sessions a long-run driver started, whose ids no stream of
 * the runner names).
 * @returns {ReturnType<typeof loadSession>[]}
 */
export function sessionsInFolder(projectsDir, dir) {
  return namesIn(join(projectsDir, projectKey(dir))).flatMap((name) => (name.endsWith('.jsonl') ? [loadSession(projectsDir, name.slice(0, -'.jsonl'.length))] : []));
}

const blocksOf = (line) => (Array.isArray(line?.message?.content) ? line.message.content : []);
const textOfResult = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n') : '');

/**
 * @param {object[]} lines a transcript
 * @returns {{id: string, name: string, input: object, atMs: number | null, result: {isError: boolean, text: string, meta: object,
 *   atMs: number | null} | null}[]} every tool call in order, each with its result once one came back
 */
export function toolCalls(lines) {
  const calls = [];
  const byId = new Map();
  for (const line of lines) {
    for (const block of blocksOf(line)) {
      if (line.type === 'assistant' && block?.type === 'tool_use') {
        const call = { id: String(block.id ?? ''), name: String(block.name ?? ''), input: block.input ?? {}, atMs: timeOf(line), result: null };
        calls.push(call);
        byId.set(call.id, call);
      }
      if (line.type === 'user' && block?.type === 'tool_result' && byId.has(block.tool_use_id)) {
        byId.get(block.tool_use_id).result = { isError: block.is_error === true, text: textOfResult(block.content),
          meta: line.toolUseResult !== null && typeof line.toolUseResult === 'object' ? line.toolUseResult : {}, atMs: timeOf(line) };
      }
    }
  }
  return calls;
}

/** @returns {{text: string, atMs: number | null}[]} every text block the agent wrote, in order */
export const assistantTexts = (lines) => lines.filter((line) => line.type === 'assistant')
  .flatMap((line) => blocksOf(line).filter((block) => block?.type === 'text').map((block) => ({ text: String(block.text ?? ''), atMs: timeOf(line) })));

/** @returns {{text: string, atMs: number | null} | null} the agent's last text (its report), or null when it wrote none */
export const finalText = (lines) => assistantTexts(lines).at(-1) ?? null;

/** @returns {{text: string, atMs: number | null}[]} the user-side texts: the brief, notices (task-notification), not tool results */
export const userTexts = (lines) => lines.filter((line) => line.type === 'user').flatMap((line) => {
  const content = line.message?.content;
  if (typeof content === 'string') return [{ text: content, atMs: timeOf(line) }];
  return blocksOf(line).filter((block) => block?.type === 'text').map((block) => ({ text: String(block.text ?? ''), atMs: timeOf(line) }));
});

/**
 * @param {ReturnType<typeof toolCalls>} calls one agent's calls
 * @returns {{type: string, prompt: string, model: string | null, agentId: string | null, denied: boolean, denyText: string,
 *   atMs: number | null}[]} its Agent (or Task) calls
 */
export const agentStarts = (calls) => calls.filter((call) => call.name === 'Agent' || call.name === 'Task').map((call) => ({
  type: String(call.input.subagent_type ?? 'general-purpose'), prompt: String(call.input.prompt ?? ''),
  model: typeof call.input.model === 'string' ? call.input.model : null,
  agentId: typeof call.result?.meta?.agentId === 'string' ? call.result.meta.agentId : null,
  denied: call.result?.isError === true, denyText: call.result?.isError === true ? call.result.text : '', atMs: call.atMs,
}));
