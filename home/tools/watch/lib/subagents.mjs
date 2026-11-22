// Watches a session's subagent transcripts (<session dir>/subagents/**/agent-*.jsonl with a sibling .meta.json).
// Exports: createSubagentWatcher(dir, { judgeExisting, io }) -> { poll() -> { mtimeMs, agents }, anyUnfinished(fromMs, toMs) }, isModelMismatch(asked, ran), agentLine(agent).
// Why: a subagent's own turns never reach the main transcript, so their newest write is part of the stall check and the model they
// actually ran on (first assistant message) is compared with the model that was asked for in the meta file. Subagents write flat
// into subagents/; the walk below it also covers the run folders of older sessions (subagents/workflows/<run>/).
// Mismatch: a model was asked for and the one that ran does not contain it, or none was asked for and a Fable or Opus ran.
// Cost control (a session can have 1000+ agents): each poll only lists the directories; a file is stat-ed when it is new or was
// changed recently, and a dormant one (unchanged for DORMANT_POLLS polls) only every RECHECK_POLLS-th poll. A file is read only
// when it is new or grew, until its model is decided; the decision (a model, or "unknown" once the first HEAD_BYTES hold none)
// is cached for good. Each agent is judged once, after its first answer; agents present at start are not judged unless
// judgeExisting. An unreadable file is skipped, never fatal.
// anyUnfinished(fromMs, toMs): true when a known transcript last written in that window does not end in a finished reply (its last
// complete line, read from the last HEAD_BYTES of the file, is not an assistant end_turn or stop_sequence); a file that cannot be read
// or whose last line is cut counts as unfinished. The watcher asks only when it is about to call a silence idle.
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { endsInFinishedReply } from './classify.mjs';

const MAX_DEPTH = 4;
const HEAD_BYTES = 256 * 1024;
const DORMANT_POLLS = 40;
const RECHECK_POLLS = 20;
const MODEL_FIELD = /"model":"(claude-[a-z0-9-]+)"/;
const PREMIUM_MODEL = /fable|opus/;
const TRANSCRIPT_EXT = '.jsonl';
const META_EXT = '.meta.json';
const UNKNOWN = 'unknown';

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

async function readMeta(transcript) {
  try { return JSON.parse(await readFile(transcript.slice(0, -TRANSCRIPT_EXT.length) + META_EXT, 'utf8')) ?? {}; } catch { return {}; }
}

class SubagentWatcher {
  constructor(dir, judgeExisting, io) {
    this.dir = dir;
    this.judgeExisting = judgeExisting;
    this.stat = io?.stat ?? stat;
    this.open = io?.open ?? open;
    this.files = new Map(); // path -> { size, mtimeMs, idlePolls, decision, judged }
    this.polls = 0;
    this.first = true;
  }

  async head(path, size) {
    let handle;
    try {
      handle = await this.open(path, 'r');
      this.buffer ??= Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(this.buffer, 0, HEAD_BYTES, 0);
      const model = this.buffer.toString('utf8', 0, bytesRead).match(MODEL_FIELD)?.[1];
      return model ?? (size >= HEAD_BYTES ? UNKNOWN : undefined);
    } catch { return undefined; } finally { await handle?.close(); }
  }

  // Returns the file's record after refreshing it when it is due; `grew` says it changed since the last look.
  async refresh(path) {
    let file = this.files.get(path);
    const dormant = file && file.idlePolls >= DORMANT_POLLS && this.polls % RECHECK_POLLS !== 0;
    if (dormant) return { file, grew: false };
    let info;
    try { info = await this.stat(path); } catch { return { file, grew: false }; }
    if (!file) { file = { size: info.size, mtimeMs: info.mtimeMs, idlePolls: 0, judged: this.first && !this.judgeExisting }; this.files.set(path, file); return { file, grew: true }; }
    const grew = info.size !== file.size || info.mtimeMs !== file.mtimeMs;
    file.idlePolls = grew ? 0 : file.idlePolls + 1;
    Object.assign(file, { size: info.size, mtimeMs: info.mtimeMs });
    return { file, grew };
  }

  async judge(path, file) {
    file.decision ??= await this.head(path, file.size);
    if (file.decision === undefined) return undefined; // no answer yet: read again once the file grows
    file.judged = true;
    if (file.decision === UNKNOWN) return undefined;
    const meta = await readMeta(path);
    const asked = meta.model ?? undefined;
    return { type: meta.agentType ?? '-', asked: asked ?? 'none', depth: meta.spawnDepth ?? 1, ran: file.decision, mismatch: isModelMismatch(asked, file.decision) };
  }

  // The last complete line of the file (undefined when there is none, or the file ends in a half-written line).
  async lastLine(path) {
    let handle;
    try {
      handle = await this.open(path, 'r');
      const { size } = await handle.stat();
      const start = Math.max(0, size - HEAD_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8', 0, bytesRead);
      return text.endsWith('\n') ? text.trimEnd().split('\n').pop() : undefined;
    } catch { return undefined; } finally { await handle?.close(); }
  }

  async anyUnfinished(fromMs, toMs) {
    for (const [path, file] of this.files) {
      if (file.mtimeMs < fromMs || file.mtimeMs > toMs) continue;
      const last = await this.lastLine(path);
      if (last === undefined || !endsInFinishedReply(last)) return true;
    }
    return false;
  }

  async poll() {
    this.polls += 1;
    const agents = [];
    let newest;
    for (const path of await transcriptsUnder(this.dir)) {
      const { file, grew } = await this.refresh(path);
      if (!file) continue;
      if (newest === undefined || file.mtimeMs > newest) newest = file.mtimeMs;
      if (file.judged || !grew) continue;
      const agent = await this.judge(path, file);
      if (agent) agents.push(agent);
    }
    this.first = false;
    return { mtimeMs: newest, agents };
  }
}

/**
 * @param {string} dir the session's subagents directory (may not exist yet)
 * @param {{ judgeExisting: boolean, io?: { stat?: Function, open?: Function } }} options whether agents already there at the first poll are judged;
 *   io lets a test count or fake stat and open calls
 */
export const createSubagentWatcher = (dir, { judgeExisting, io }) => new SubagentWatcher(dir, judgeExisting, io);
