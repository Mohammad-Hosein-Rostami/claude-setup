// The live facts model s1 reads beside the table and the activity (estimate-spec R11, R13): which subagent of this session works on
// which open row (row-agents.mjs rowAgents over board/lib/agents.mjs sessionAgents), the owner waits of the job's sessions
// (AskUserQuestion intervals, the live asking marker), and the usage-limit record of the job's account (pauses.mjs
// readLimitRecord: the limits file and its 7-day log, not readLimits' newest 12 samples, so a usage-limit pause is still seen
// an hour after work resumed).
// Exports: MAX_FACTS_BYTES, jobInputs(source) -> { rowAgents, asks, limits }.
// Cursors: each transcript's facts (transcript-facts.mjs) are read from a cursor kept in <stateDir>/facts/<m-session|a-agent>.json
// (hooks/lib/session-store.mjs: no link followed, private file, temp file and rename), so a run reads only the bytes appended
// since the last one. A missing, foreign or stale cursor starts over from byte 0 (one full scan, never a wrong fact); two runs at
// once may both write, and the later cursor wins (both describe the same file). Without a stateDir nothing is kept: every run reads
// whole. A cursor over MAX_FACTS_BYTES is not written (the writer's cap is the reader's).
// Invariants: never prints; only this session's agents are matched (row-agents.mjs F1: never another session's); the live marker
// counts only at the real clock (a --now run describes another instant); every unreadable source gives no fact, which can only
// turn `waiting for you` or `usage limit` into `no activity` and a matched row into the open-time rule, never invent a pause.
import { basename, dirname, join } from 'node:path';
import { readAsking } from '../../../hooks/lib/asking-marker.mjs';
import { readSessionFile, writeSessionFile } from '../../../hooks/lib/session-store.mjs';
import { sessionAgents } from '../../board/lib/agents.mjs';
import { sessionTranscripts } from './activity.mjs';
import { readLimitRecord } from './pauses.mjs';
import { rowAgents } from './row-agents.mjs';
import { asksOf, readTranscriptFacts } from './transcript-facts.mjs';

/** 1 MiB per cursor: 10,000 runs (transcript-facts.mjs MAX_RUNS) and 500 asks take about 250 KB. */
export const MAX_FACTS_BYTES = 1 << 20;
const FACTS_FOLDER = 'facts';
const STORE = { sweep: false };
const TRANSCRIPT_SUFFIX = '.jsonl';

/** The cursor stored under `key`, or null (none, unusable, not JSON). */
function storedCursor(folder, key) {
  if (folder === null) return null;
  const text = readSessionFile(folder, key, MAX_FACTS_BYTES);
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null; // a torn or foreign file: transcript-facts starts over from byte 0
  }
}

/** One transcript's facts from its stored cursor, the new cursor kept when it fits the cap; null when the file is unreadable. */
function factsOf(folder, key, file) {
  const cursor = readTranscriptFacts(file, storedCursor(folder, key));
  if (cursor === null || folder === null) return cursor;
  const text = JSON.stringify(cursor);
  if (Buffer.byteLength(text) <= MAX_FACTS_BYTES) writeSessionFile(folder, key, text, STORE);
  return cursor;
}

/** The session's main transcripts (one per project folder that holds it). */
const mainTranscripts = (projectsDir, sessionId) => sessionTranscripts(projectsDir, sessionId)
  .filter((file) => basename(file) === `${sessionId}${TRANSCRIPT_SUFFIX}`);

/** This session's open rows and their agents (R13): the board's agents of each of its folders, their own active minutes. */
function agentsOf(items, { sessionId, projectsDir, folder, env, nowMs }) {
  const byRow = new Map();
  for (const main of mainTranscripts(projectsDir, sessionId)) {
    const sessionFolder = join(dirname(main), sessionId);
    const { agents } = sessionAgents({ session: sessionId, sessionFolder, cursors: {}, pools: null, env, nowMs });
    const intervalsOf = (agentId) => factsOf(folder, `a-${agentId}`, join(sessionFolder, 'subagents', `agent-${agentId}${TRANSCRIPT_SUFFIX}`))?.runs ?? null;
    for (const [id, entry] of rowAgents(items, agents, intervalsOf)) byRow.set(id, entry);
  }
  return byRow;
}

/** The owner waits of the job's sessions: answered and closed asks of each main transcript, and the open marker at the real clock. */
function asksOfSessions({ sessions, projectsDir, folder, env, nowMs, realClock }) {
  const asks = [];
  for (const session of sessions) {
    for (const main of mainTranscripts(projectsDir, session)) asks.push(...asksOf(factsOf(folder, `m-${session}`, main)));
    const marker = realClock ? readAsking(session, env, nowMs) : null;
    if (marker !== null && marker.kind === 'question') asks.push({ fromMs: marker.openedAt, toMs: nowMs });
  }
  return asks;
}

/**
 * The live facts of one run.
 * @param {{ items: object[], sessions: string[], sessionId?: string, projectsDir: string, stateDir: string | null,
 *   account?: string, limitsDir?: string, env?: object, nowMs: number, realClock: boolean }} source the table's parser items, its
 *   sessions (this run's included), the session whose agents are matched (none: no agent), the stores, the job's account
 *   (CLAUDE_ACCOUNT) and its limits folder (default ~/.claude/state/limits), and whether this run is at the real clock
 * @returns {{ rowAgents: Map<string, object>, asks: { fromMs: number, toMs: number }[], limits: { account: string | null, records: object[] } }}
 */
export function jobInputs({ items, sessions, sessionId, projectsDir, stateDir, account, limitsDir, env = process.env, nowMs, realClock }) {
  const folder = stateDir === null ? null : join(stateDir, FACTS_FOLDER);
  const byRow = sessionId === undefined ? new Map() : agentsOf(items, { sessionId, projectsDir, folder, env, nowMs });
  const asks = asksOfSessions({ sessions, projectsDir, folder, env, nowMs, realClock });
  const record = account === undefined ? null : readLimitRecord(account, limitsDir === undefined ? {} : { dir: limitsDir });
  return { rowAgents: byRow, asks, limits: { account: record === null ? null : account, records: record === null ? [] : [record] } };
}
