// Watches a session's subagent transcripts (<session dir>/subagents/**/agent-*.jsonl with a sibling .meta.json).
// Exports: createSubagentWatcher(dir, { judgeExisting }) -> { poll() -> { mtimeMs, agents } }, isModelMismatch(asked, ran), agentLine(agent).
// Why: workflow agents never reach the main transcript, so their newest write is part of the stall check and the model they
// actually ran on (first assistant message) is compared with the model that was asked for in the meta file.
// Mismatch: a model was asked for and the one that ran does not contain it, or none was asked for and a Fable or Opus ran.
// Invariants: each agent is judged once, after its first answer; agents present at start are not judged unless judgeExisting
// (follow mode starts from "now"); an unreadable file is skipped, never fatal.
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_DEPTH = 4;
const HEAD_BYTES = 256 * 1024;
const MODEL_FIELD = /"model":"(claude-[a-z0-9-]+)"/;
const PREMIUM_MODEL = /fable|opus/;
const TRANSCRIPT_EXT = '.jsonl';
const META_EXT = '.meta.json';

/**
 * @param {string | undefined} asked model alias from the meta file (e.g. "opus"), if any
 * @param {string} ran model id of the first assistant message
 * @returns {boolean} true when the agent did not run on what was asked for
 */
export function isModelMismatch(asked, ran) {
  return asked ? !ran.includes(asked) : PREMIUM_MODEL.test(ran);
}

/** @param {{ type: string, asked: string, depth: number|string, ran: string }} agent @returns {string} the verbose log line body */
export const agentLine = (agent) => `AGENT_RAN type=${agent.type} asked=${agent.asked} depth=${agent.depth} ran=${agent.ran}`;

async function transcriptsUnder(dir, depth = 0) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < MAX_DEPTH) found.push(...(await transcriptsUnder(path, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith(TRANSCRIPT_EXT)) found.push(path);
  }
  return found;
}

async function firstModel(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead).match(MODEL_FIELD)?.[1];
  } catch { return undefined; } finally { await handle?.close(); }
}

async function readMeta(transcript) {
  try { return JSON.parse(await readFile(transcript.slice(0, -TRANSCRIPT_EXT.length) + META_EXT, 'utf8')) ?? {}; } catch { return {}; }
}

/**
 * @param {string} dir the session's subagents directory (may not exist yet)
 * @param {{ judgeExisting: boolean }} options whether agents already there at the first poll are judged
 */
export function createSubagentWatcher(dir, { judgeExisting }) {
  const judged = new Set();
  let first = true;
  return {
    async poll() {
      const agents = [];
      let newest;
      for (const path of await transcriptsUnder(dir)) {
        try { const { mtimeMs } = await stat(path); if (newest === undefined || mtimeMs > newest) newest = mtimeMs; } catch { continue; }
        if (judged.has(path)) continue;
        if (first && !judgeExisting) { judged.add(path); continue; }
        const ran = await firstModel(path);
        if (ran === undefined) continue; // no answer yet: look again next poll
        judged.add(path);
        const meta = await readMeta(path);
        const asked = meta.model ?? undefined;
        agents.push({ type: meta.agentType ?? '-', asked: asked ?? 'none', depth: meta.spawnDepth ?? 1, ran, mismatch: isModelMismatch(asked, ran) });
      }
      first = false;
      return { mtimeMs: newest, agents };
    },
  };
}
