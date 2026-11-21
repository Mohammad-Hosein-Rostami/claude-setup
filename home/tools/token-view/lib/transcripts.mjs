// Reads Claude Code transcripts into one record per agent run (the lead's session file, or one subagent file with its
// `.meta.json`). The transcript fields are undocumented and change between CLI builds; the ones read here were seen on 2.1.323
// to 2.1.329: assistant lines `message.{id,model,usage,stop_reason}`, `timestamp`, `gitBranch`, `cwd`, `promptCacheRequested`,
// `attributionAgent`; `system` lines with subtype `compact_boundary` and `compactMetadata.preTokens`; `tool_result` blocks with
// `is_error`; the subagent `.meta.json` fields `agentType`, `description`, `toolUseId`.
// Exports: listRuns(projectsDir, sinceMs) -> [{ file, meta, project, session }], readRun(run) -> Promise<AgentRun>, CACHE_TTL_MS.
// Invariants: read-only; never throws for one odd line or file (a line that is not JSON is skipped, an unreadable file gives an
// empty run); an API message split over several lines counts once (keyed by `message.id`).
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const CACHE_TTL_MS = { '5m': 5 * 60 * 1000, '1h': 60 * 60 * 1000 }; // the two prompt-cache lifetimes Claude Code requests
const DEFAULT_TTL = '5m'; // a line without `promptCacheRequested` used the default 5-minute cache
const WANTED = /"usage"|compact_boundary|"is_error":true/; // the only lines worth parsing; the rest are skipped unparsed

/** @returns {string[]} the entries of a folder, or [] when it cannot be read. */
const entries = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** @returns {object} the parsed `.meta.json` beside a subagent transcript, or {} when it is missing or not JSON. */
function metaOf(file) {
  const path = file.replace(/\.jsonl$/, '.meta.json');
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** Subagent transcripts under `<session>/subagents`, at any depth (workflow agents nest one level down). */
function subagentFiles(dir) {
  const out = [];
  for (const name of entries(dir)) {
    const path = join(dir, name);
    if (name.startsWith('agent-') && name.endsWith('.jsonl')) out.push(path);
    else if (!name.includes('.')) out.push(...subagentFiles(path));
  }
  return out;
}

/**
 * Every agent run whose transcript changed since `sinceMs`.
 * @param {string} projectsDir - `~/.claude/projects`, or a fixture folder of the same layout.
 * @param {number} sinceMs - epoch ms; older files are left out by their modification time.
 * @returns {{file: string, meta: object|null, project: string, session: string}[]} meta is null for the lead's own file.
 */
export function listRuns(projectsDir, sinceMs) {
  const runs = [];
  const fresh = (file) => {
    try {
      return statSync(file).mtimeMs >= sinceMs;
    } catch {
      return false;
    }
  };
  for (const project of entries(projectsDir)) {
    const dir = join(projectsDir, project);
    for (const name of entries(dir).filter((entry) => entry.endsWith('.jsonl'))) {
      const session = basename(name, '.jsonl');
      const file = join(dir, name);
      if (fresh(file)) runs.push({ file, meta: null, project, session });
      for (const sub of subagentFiles(join(dir, session, 'subagents')).filter(fresh)) runs.push({ file: sub, meta: metaOf(sub), project, session });
    }
  }
  return runs;
}

/** One assistant message's usage, or null when the line carries none. */
function messageOf(line) {
  const usage = line.message?.usage;
  if (line.type !== 'assistant' || !usage || !line.message.id) return null;
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return {
    id: line.message.id, t: Date.parse(line.timestamp) || 0, model: line.message.model ?? '', stop: line.message.stop_reason ?? '',
    input, cacheRead, cacheWrite, output: usage.output_tokens ?? 0, context: input + cacheRead + cacheWrite,
    ttl: line.promptCacheRequested ?? DEFAULT_TTL, branch: line.gitBranch ?? '', cwd: line.cwd ?? '', agent: line.attributionAgent ?? '',
  };
}

/** Folds one parsed line into the run state: a message, a compaction or failed tool results. */
function take(state, line) {
  const message = messageOf(line);
  if (message) state.messages.set(message.id, message);
  if (line.type === 'system' && line.subtype === 'compact_boundary') state.compactions.push(line.compactMetadata?.preTokens ?? 0);
  const blocks = Array.isArray(line.message?.content) ? line.message.content : [];
  for (const block of blocks) if (block?.type === 'tool_result' && block.is_error === true && block.tool_use_id) state.failedCalls.add(block.tool_use_id);
}

/**
 * Reads one transcript.
 * @param {{file: string, meta: object|null, project: string, session: string}} run - one entry of listRuns.
 * @returns {Promise<object>} the run with `messages` (time order), `compactions` (preTokens each) and `failedCalls` (tool_use ids
 *   whose result was an error: in the lead's file these are the failed Agent calls).
 */
export async function readRun(run) {
  const state = { messages: new Map(), compactions: [], failedCalls: new Set() };
  try {
    const lines = createInterface({ input: createReadStream(run.file, 'utf8'), crlfDelay: Infinity });
    for await (const text of lines) {
      if (!WANTED.test(text)) continue;
      try {
        take(state, JSON.parse(text));
      } catch {
        // a line cut mid-write (the live session appends) is skipped; the rest of the file still counts
      }
    }
  } catch (error) {
    process.stderr.write(`token-view: cannot read ${run.file}: ${error.message}\n`);
  }
  const messages = [...state.messages.values()].sort((a, b) => a.t - b.t);
  return { ...run, messages, compactions: state.compactions, failedCalls: state.failedCalls };
}

export { CACHE_TTL_MS };
