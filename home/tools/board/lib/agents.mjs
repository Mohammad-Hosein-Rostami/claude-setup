// The subagents of a session for the board (spec-tui rows 3 and 4): every agent, each with its type, what it is on, its folder (for
// the git rows), its progress (progress.mjs) and what it does now.
// Exports: sessionAgents({ session, sessionFolder, cursors, pools, env, nowMs }) -> { agents, cursors, launchDirs }.
// An agent's `places` ({ worktree: its meta.worktreePath, else the folder its launch record names; changed: the folders of the files
// it edited (agent-transcript.mjs); isolated: whether worktree is meta.worktreePath; cwd }) only match it to a trusted worktree by path
// prefix (repos.mjs placeAgents); `launchDirs` are the folders writers were launched in (the launch records): they only choose among
// the trusted repositories, they never make one trusted.
// Sources (Claude Code internal, observed 2.1.329; every parser fails soft): <session>/subagents/agent-<id>.jsonl and .meta.json
// (a `subagents/workflows/` folder left by an old session is not read), the writer launch records (hooks/lib/writer-agents.mjs
// `open[]`: the STATUS row of a writer).
// Rules: an agent is done when its transcript's last answer ended the turn with no call after it. Done agents stay DONE_KEEP_MS (counted
// as "done last 10 min"), running ones until their transcript has been silent LIVE_MS. `quiet N min` from QUIET_MS of silence with no
// call waiting for its result.
// An entry's `name` is the shown label (the description cut to MAX_LABEL_CHARS); `description` is the whole description for the
// estimate's row matching, or null when it is over MAX_DESCRIPTION_CHARS (never shown).
// Invariants: never throws; reads only plain files, capped; every name kept is stripped of control characters and cut.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isWritingAgent, openWritersOf } from '../../../hooks/lib/writer-agents.mjs';
import { advanceCursor } from './agent-transcript.mjs';
import { agentProgress } from './progress.mjs';
import { readPart } from './read-part.mjs';

const MS_PER_MIN = 60_000;
const LIVE_MS = 30 * MS_PER_MIN;
const DONE_KEEP_MS = 10 * MS_PER_MIN;
const QUIET_MS = 3 * MS_PER_MIN;
const MAX_AGENTS = 40;
const META_BYTES = 4096;
const MAX_NAME_CHARS = 24;
const MAX_LABEL_CHARS = 60; // the description whole enough for the render to cut it at a word (cells.mjs cutWords), not mid-word here
// The estimate matches an agent to its row by every lane its description names (estimate/lib/row-agents.mjs, F1), so it needs the
// description whole: longer ones (the Agent tool asks for a few words) give null, never a cut text that hides a second lane.
const MAX_DESCRIPTION_CHARS = 200;
const TRANSCRIPT = /^agent-([A-Za-z0-9]{1,40})\.jsonl$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const clean = (text, max) => String(text ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, max);
const namesIn = (folder) => { try { return readdirSync(folder); } catch { return []; } };
const minutes = (ms) => Math.max(0, Math.floor(ms / MS_PER_MIN));
/** @returns {string | null} the description cleaned and whole, or null when there is none or it is over MAX_DESCRIPTION_CHARS */
function wholeDescription(meta) {
  const text = clean(meta.description, Infinity);
  return text !== '' && text.length <= MAX_DESCRIPTION_CHARS ? text : null;
}
const tenths = (value) => (value === null ? null : Math.round(value * 10) / 10); // board bytes: 0.1 min is finer than any row shows

function metaOf(file) {
  try {
    const meta = JSON.parse(readPart(file, META_BYTES, false)?.text ?? 'null');
    return meta !== null && typeof meta === 'object' ? meta : {};
  } catch {
    return {};
  }
}

/** The agent transcripts of one folder changed in LIVE_MS, or already in the cursors (to see them finish). */
function transcriptsIn(folder, cursors, nowMs) {
  return namesIn(folder).flatMap((name) => {
    const id = TRANSCRIPT.exec(name)?.[1];
    if (id === undefined) return [];
    const info = lstatSync(join(folder, name), { throwIfNoEntry: false });
    const recent = info?.isFile() && nowMs - info.mtimeMs < LIVE_MS;
    return recent || cursors[id] !== undefined ? [{ id, file: join(folder, name), meta: join(folder, `agent-${id}.meta.json`) }] : [];
  });
}

/** One agent's board entry from its cursor and meta. */
function agentEntry({ id, cursor, meta, launches, pools, env, nowMs }) {
  const type = clean(meta.agentType ?? '?', MAX_NAME_CHARS);
  const done = cursor.endedMs !== null && !cursor.pending;
  const doneMs = done ? (cursor.endedMs ?? cursor.lastMs ?? cursor.mtimeMs) : null;
  const writer = cursor.edits > 0 || isWritingAgent(meta.agentType, env);
  const progress = agentProgress({ ...cursor, type, writer, done, doneMs }, pools?.types?.[type], nowMs);
  const silentMs = nowMs - cursor.mtimeMs;
  const state = done ? 'done' : silentMs >= QUIET_MS && !cursor.pending ? 'quiet' : 'run';
  return {
    entry: {
      id, name: clean(meta.description, MAX_LABEL_CHARS) || type, description: wholeDescription(meta), type,
      places: { worktree: typeof meta.worktreePath === 'string' ? meta.worktreePath : (launches.get(id)?.cwd ?? null),
        isolated: typeof meta.worktreePath === 'string', changed: cursor.changedDirs ?? [], cwd: cursor.cwd },
      row: launches.get(id)?.row ?? null, state, writer,
      pct: progress.pct, conf: progress.conf, elapsedMin: tenths(progress.elapsedMin), leftMin: tenths(progress.leftMin),
      highLeftMin: tenths(progress.highLeftMin), overMin: tenths(progress.overMin), usual: progress.usual, tag: progress.tag, doing: cursor.lastTool?.text ?? null, calls: cursor.calls,
      tokens: Number.isFinite(cursor.tokens) && cursor.tokens > 0 ? cursor.tokens : null,
      quietMin: state === 'quiet' ? minutes(silentMs) : 0, pendingMin: cursor.pending && cursor.lastTool ? minutes(nowMs - cursor.lastTool.atMs) : 0,
      doneMs, startMs: cursor.startMs,
    },
    cursor: { ...cursor, shownPct: progress.shownPct, stepsSeen: progress.stepsSeen },
  };
}

const kept = (entry, nowMs, mtimeMs) => (entry.state === 'done' ? nowMs - entry.doneMs < DONE_KEEP_MS : nowMs - mtimeMs < LIVE_MS);

/**
 * @param {{ session: string, sessionFolder: string, cursors: Record<string, object>, pools: object | null, env: object,
 *   nowMs: number }} source the session's folder (refresh.mjs) and the stored cursors
 * @returns {{ agents: object[], cursors: Record<string, object>, launchDirs: string[] }} agents running first, then newest; the cursors
 *   of the agents still shown (the rest are dropped); the folders writers were launched in
 */
export function sessionAgents({ session, sessionFolder, cursors, pools, env, nowMs }) {
  try {
    const open = openWritersOf(session, env, nowMs);
    const launches = new Map(open.filter((entry) => typeof entry?.agent === 'string')
      .map((entry) => [entry.agent, { row: clean(entry.row, MAX_NAME_CHARS) || null, cwd: typeof entry.cwd === 'string' ? entry.cwd : null }]));
    const launchDirs = [...new Set(open.map((entry) => entry?.cwd).filter((dir) => typeof dir === 'string'))];
    const entries = [];
    const nextCursors = {};
    for (const { id, file, meta } of transcriptsIn(join(sessionFolder, 'subagents'), cursors, nowMs)) {
      const cursor = advanceCursor(cursors[id], file);
      if (cursor === null || cursor.startMs === null) continue;
      const built = agentEntry({ id, cursor, meta: metaOf(meta), launches, pools, env, nowMs });
      if (!kept(built.entry, nowMs, cursor.mtimeMs)) continue;
      entries.push(built.entry);
      nextCursors[id] = built.cursor;
    }
    entries.sort((a, b) => (a.state === 'done') - (b.state === 'done') || b.startMs - a.startMs);
    return { agents: entries.slice(0, MAX_AGENTS), cursors: nextCursors, launchDirs };
  } catch {
    return { agents: [], cursors, launchDirs: [] }; // an unreadable folder: no agent rows this time, the cursors stay
  }
}
