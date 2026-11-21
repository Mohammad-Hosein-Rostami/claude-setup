// The subagents of a session for the board (spec-tui rows 3 and 4): every plain agent and every agent of a live workflow run, each
// with its type, what it is on, its folder (for the git rows), its progress (progress.mjs) and what it does now; and per workflow run
// its purpose, agents done of all, the bar and the finish.
// Exports: sessionAgents({ session, sessionFolder, runs, cursors, pools, env, nowMs }) -> { agents, runs, cursors, launchDirs }.
// An agent's `places` ({ worktree: its meta.worktreePath, else the folder its launch record names; changed: the folders of the files
// it edited (agent-transcript.mjs); isolated: whether worktree is meta.worktreePath; cwd }) only match it to a trusted worktree by path
// prefix (repos.mjs placeAgents); `launchDirs` are the folders writers were launched in (the launch records): they only choose among
// the trusted repositories, they never make one trusted.
// Sources (Claude Code internal, observed 2.1.329; every parser fails soft): <session>/subagents/agent-<id>.jsonl and .meta.json
// (plain agents), <session>/subagents/workflows/<run>/agent-<id>.* and the run's journal.jsonl (`started` label and phase, `result`
// = done), the writer launch records (hooks/lib/writer-agents.mjs `open[]`: the STATUS row of a writer) and the workflow registry
// (tools/wf-resume/lib/registry.mjs: the run's row or args label = what it is for).
// Rules: a plain agent is done when its transcript's last answer ended the turn with no call after it; a workflow agent when the
// journal has its result. Done agents stay DONE_KEEP_MS (counted as "done last 10 min"), running ones until their transcript has been
// silent LIVE_MS. `quiet N min` from QUIET_MS of silence with no call waiting for its result.
// Invariants: never throws; reads only plain files, capped; every name kept is stripped of control characters and cut.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isWritingAgent, openWritersOf } from '../../../hooks/lib/writer-agents.mjs';
import { eventsOf, readPart } from '../../estimate/lib/workflow-runs.mjs';
import { defaultRegistryDir, runsOfSession } from '../../wf-resume/lib/registry.mjs';
import { advanceCursor } from './agent-transcript.mjs';
import { agentProgress } from './progress.mjs';

const MS_PER_MIN = 60_000;
const LIVE_MS = 30 * MS_PER_MIN;
const DONE_KEEP_MS = 10 * MS_PER_MIN;
const QUIET_MS = 3 * MS_PER_MIN;
const MAX_AGENTS = 40;
const MAX_JOURNAL_BYTES = 256 * 1024;
const META_BYTES = 4096;
const MAX_NAME_CHARS = 24;
const MAX_LABEL_CHARS = 60; // the description whole enough for the render to cut it at a word (cells.mjs cutWords), not mid-word here
const MAX_PURPOSE_CHARS = 40;
const TRANSCRIPT = /^agent-([A-Za-z0-9]{1,40})\.jsonl$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const PURPOSE_KEYS = ['row', 'label', 'lane', 'task', 'title', 'name'];

const clean = (text, max) => String(text ?? '').replace(CONTROL_CHARS, ' ').trim().slice(0, max);
const namesIn = (folder) => { try { return readdirSync(folder); } catch { return []; } };
const minutes = (ms) => Math.max(0, Math.floor(ms / MS_PER_MIN));
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

/** The journal of a run: labels and phases by agent id, the ids with a result, the started count. */
function journalOf(sessionFolder, runId) {
  const tail = readPart(join(sessionFolder, 'subagents', 'workflows', runId, 'journal.jsonl'), MAX_JOURNAL_BYTES, true);
  const events = tail === null ? [] : eventsOf(tail);
  const started = new Map(events.filter((event) => event.type === 'started').map((event) => [event.agentId, event]));
  return { started, results: new Set(events.filter((event) => event.type === 'result').map((event) => event.agentId)) };
}

/** What a workflow run is for: its registry row, else a label among its args. */
function purposeOf(record) {
  if (typeof record?.row === 'string' && record.row) return clean(record.row, MAX_PURPOSE_CHARS);
  const args = record?.args;
  const key = args !== null && typeof args === 'object' ? PURPOSE_KEYS.find((name) => typeof args[name] === 'string' && args[name]) : undefined;
  return key === undefined ? (typeof args === 'string' ? clean(args, MAX_PURPOSE_CHARS) : null) : clean(args[key], MAX_PURPOSE_CHARS);
}

/** One agent's board entry from its cursor, meta and run. */
function agentEntry({ id, cursor, meta, run, journal, launches, pools, env, nowMs }) {
  const label = clean(run ? (journal.started.get(id)?.label ?? meta.description) : meta.description, MAX_LABEL_CHARS + MAX_NAME_CHARS);
  const colon = run ? label.indexOf(':') : -1; // a workflow label is `<lane>:<agent>`; a plain agent's description is kept whole
  const type = clean(meta.agentType ?? '?', MAX_NAME_CHARS);
  const done = run ? journal.results.has(id) : cursor.endedMs !== null && !cursor.pending;
  const doneMs = done ? (cursor.endedMs ?? cursor.lastMs ?? cursor.mtimeMs) : null;
  const writer = cursor.edits > 0 || isWritingAgent(meta.agentType, env);
  const progress = agentProgress({ ...cursor, type, writer, done, doneMs }, pools?.types?.[type], nowMs);
  const silentMs = nowMs - cursor.mtimeMs;
  const state = done ? 'done' : silentMs >= QUIET_MS && !cursor.pending ? 'quiet' : 'run';
  return {
    entry: {
      id, name: clean(colon > 0 ? label.slice(colon + 1) : label, MAX_LABEL_CHARS) || type, lane: colon > 0 ? clean(label.slice(0, colon), MAX_NAME_CHARS) : null,
      type, runId: run?.runId ?? null, phase: run ? (journal.started.get(id)?.phase ?? meta.workflowPhase ?? null) : null,
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

/** A run's summary from its agents: done of all, the share done, the latest finish of its running agents. */
function runSummary(run, journal, entries, record) {
  const mine = entries.filter((entry) => entry.runId === run.runId);
  const running = mine.filter((entry) => entry.state !== 'done');
  const known = running.filter((entry) => entry.leftMin !== null);
  const inPhase = mine.filter((entry) => entry.phase === run.phase);
  return {
    ...run, purpose: purposeOf(record), agentsTotal: Math.max(journal.started.size, mine.length), agentsDone: journal.results.size,
    pct: inPhase.length > 0 ? Math.round(inPhase.reduce((sum, entry) => sum + entry.pct, 0) / inPhase.length) : null,
    leftMin: known.length > 0 ? Math.max(...known.map((entry) => entry.leftMin)) : null,
    running: running.length, quiet: running.filter((entry) => entry.state === 'quiet').length,
  };
}

/**
 * @param {{ session: string, sessionFolder: string, runs: object[], cursors: Record<string, object>, pools: object | null, env: object,
 *   nowMs: number }} source the board's runs (refresh.mjs) and the stored cursors
 * @returns {{ agents: object[], runs: object[], cursors: Record<string, object> }} agents running first, then newest; the runs with
 *   their summaries; the cursors of the agents still shown (the rest are dropped)
 */
export function sessionAgents({ session, sessionFolder, runs, cursors, pools, env, nowMs }) {
  try {
    const open = openWritersOf(session, env, nowMs);
    const launches = new Map(open.filter((entry) => typeof entry?.agent === 'string')
      .map((entry) => [entry.agent, { row: clean(entry.row, MAX_NAME_CHARS) || null, cwd: typeof entry.cwd === 'string' ? entry.cwd : null }]));
    const launchDirs = [...new Set(open.map((entry) => entry?.cwd).filter((dir) => typeof dir === 'string'))];
    const records = new Map(runsOfSession(defaultRegistryDir(), session).map((record) => [record.runId, record]));
    const groups = [{ run: null, folder: join(sessionFolder, 'subagents'), journal: null },
      ...runs.map((run) => ({ run, folder: join(sessionFolder, 'subagents', 'workflows', run.runId), journal: journalOf(sessionFolder, run.runId) }))];
    const entries = [];
    const nextCursors = {};
    for (const { run, folder, journal } of groups) {
      for (const { id, file, meta } of transcriptsIn(folder, cursors, nowMs)) {
        const cursor = advanceCursor(cursors[id], file);
        if (cursor === null || cursor.startMs === null) continue;
        const built = agentEntry({ id, cursor, meta: metaOf(meta), run, journal, launches, pools, env, nowMs });
        if (!kept(built.entry, nowMs, cursor.mtimeMs)) continue;
        entries.push(built.entry);
        nextCursors[id] = built.cursor;
      }
    }
    entries.sort((a, b) => (a.state === 'done') - (b.state === 'done') || b.startMs - a.startMs);
    const summaries = groups.filter((group) => group.run !== null).map(({ run, journal }) => runSummary(run, journal, entries, records.get(run.runId)));
    return { agents: entries.slice(0, MAX_AGENTS), runs: summaries, cursors: nextCursors, launchDirs };
  } catch {
    return { agents: [], runs, cursors, launchDirs: [] }; // an unreadable folder: no agent rows this time, the cursors stay
  }
}
