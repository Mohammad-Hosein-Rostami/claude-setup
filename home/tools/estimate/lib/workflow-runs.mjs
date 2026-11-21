// The workflow runs that are live in a session, for the status line's run lines. Read from the journals Claude Code writes (observed in
// 2.1.326, undocumented: a different shape shows nothing, never a wrong number).
// Exports: liveRuns(transcriptPath, nowMs) -> { runId, name, row, phase, phaseIndex, phaseTotal, started, done }[], newest journal first;
// readPart and metaOf (also used by tools/wf-resume/lib/run-state.mjs); eventsOf (the board's per-agent done marks, tools/board/lib/agents.mjs); boardRuns(transcriptPath, nowMs) -> the same runs with
// `quietMs` (since the journal was last written) and `lanes` (lanes per phase), over BOARD_WINDOW_MS, for the board (tools/board).
// Layout read, next to the transcript <proj>/<session>.jsonl: <session>/subagents/workflows/<runId>/journal.jsonl (one JSON line per
// agent event: { type: launched | started | result, agentId, ... }: `started` has label and phase, `result` only the agent id, `launched`
// nothing), <session>/workflows/<runId>.json (written when the run is over: its presence means not live), <session>/workflows/scripts/<name>-<runId>.js (a copy of the script: its `meta` gives the name and
// the phase titles, so the phase total).
// Rules: a run is live when its journal was written in the last LIVE_WINDOW_MS and it has no summary json. The current phase is the phase of
// the newest line's agent (a result takes the phase and label of its agent's `started` line); `started` = agents started in it, `done` = those
// with a result line; `row` = the newest agent's label text before its first `:` (null when it has no colon). Only the last MAX_JOURNAL_BYTES of a journal are read; if that tail cannot show where the current phase began
// (its first line is already of that phase) the run is left out, so a count is right or absent. phaseIndex is the phase's place in the script's
// phases (1-based), else its place among the phases seen (0 = unknown when the journal was cut); phaseTotal null without the script's phases.
// Invariants: never throws, reads only plain files (no links), caps every read, strips control characters and cuts every name that reaches the
// terminal (a label is script text, not trusted); a run id must be a plain name.
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

const MS_PER_MIN = 60_000;
const LIVE_WINDOW_MS = 30 * MS_PER_MIN;
/** The board also lists a run quiet for longer (`stopped? 34 min`), for up to this long after its journal was last written. */
const BOARD_WINDOW_MS = 6 * 60 * MS_PER_MIN;
const MAX_JOURNAL_BYTES = 256 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;
/** Newest journals read per render: the status line shows two runs, and a render must stay fast with many old live-looking runs. */
const MAX_RUNS_READ = 8;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_TYPES = ['started', 'result']; // `launched` lines name no agent: nothing to read from them
const MAX_NAME_CHARS = 16;
const MAX_ROW_CHARS = 24;
const MAX_PHASE_CHARS = 24;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const QUOTES = ['"', "'", '`'];

const clean = (text, max) => text.replace(CONTROL_CHARS, '').slice(0, max);

/** The first `max` bytes (head) or last `max` bytes (tail) of a plain file; null when it is not a plain file. `truncated`: the file was longer. */
export function readPart(file, max, fromEnd) {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) return null;
  const length = Math.min(info.size, max);
  const buffer = Buffer.alloc(length);
  const handle = openSync(file, 'r');
  try {
    readSync(handle, buffer, 0, length, fromEnd ? info.size - length : 0);
  } finally {
    closeSync(handle);
  }
  return { text: buffer.toString('utf8'), truncated: info.size > max };
}

/** The text from the bracket at `start` to its match, strings skipped; null when it does not close. */
function balanced(text, start) {
  if (start < 0) return null;
  const close = { '{': '}', '[': ']' }[text[start]];
  let depth = 0;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (QUOTES.includes(char)) {
      at = text.indexOf(char, at + 1);
      while (at > 0 && text[at - 1] === '\\') at = text.indexOf(char, at + 1);
      if (at < 0) return null;
    } else if (char === text[start]) {
      depth += 1;
    } else if (char === close && (depth -= 1) === 0) {
      return text.slice(start, at + 1);
    }
  }
  return null;
}

/** The workflow name and phase titles of a script copy's `export const meta = {...}` (a literal: it is read, never run); null when not found. */
export function metaOf(scriptText) {
  const at = scriptText.indexOf('export const meta');
  const literal = at < 0 ? null : balanced(scriptText, scriptText.indexOf('{', at));
  if (literal === null) return null;
  const name = /\bname\s*:\s*(['"])((?:(?!\1).)*)\1/.exec(literal)?.[2];
  const phases = /\bphases\s*:\s*\[/.exec(literal);
  const list = phases === null ? '' : (balanced(literal, phases.index + phases[0].length - 1) ?? '');
  const titles = [...list.matchAll(/\btitle\s*:\s*(['"])((?:(?!\1).)*)\1/g)].map((match) => clean(match[2], MAX_PHASE_CHARS));
  return { name: name === undefined ? null : clean(name, MAX_NAME_CHARS), titles };
}

/** The names in a folder; [] when it does not exist yet (a run has its journal before anything else). */
function namesIn(folder) {
  try {
    return readdirSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** The script copy of a run: its name (from the meta, else from the file name) and phase titles. */
function scriptOf(sessionFolder, runId) {
  const folder = join(sessionFolder, 'workflows', 'scripts');
  const suffix = `-${runId}.js`;
  const file = namesIn(folder).find((name) => name.endsWith(suffix));
  if (file === undefined) return { name: 'workflow', titles: [] };
  const meta = metaOf(readPart(join(folder, file), MAX_SCRIPT_BYTES, false)?.text ?? '');
  return { name: meta?.name || clean(file.slice(0, -suffix.length), MAX_NAME_CHARS) || 'workflow', titles: meta?.titles ?? [] };
}

/** One journal line as an event; [] for anything else. A `started` line carries label and phase, a `result` line only the agent id. */
const parsedEvent = (line) => {
  try {
    const event = JSON.parse(line);
    const usable = event !== null && typeof event === 'object' && EVENT_TYPES.includes(event.type) && typeof event.agentId === 'string';
    return usable ? [{ type: event.type, agentId: event.agentId, label: typeof event.label === 'string' ? event.label : '', phase: typeof event.phase === 'string' ? clean(event.phase, MAX_PHASE_CHARS) : null }] : [];
  } catch {
    return []; // a line that is not JSON (cut at the tail's start, or garbage): skipped
  }
};

/**
 * The usable events of a journal's tail, oldest first, each with its agent's label and phase (the ones on its `started` line). A line cut by
 * the tail's start is not JSON and is skipped like any other garbage; a result whose `started` line is not in view has no phase and is left out.
 */
export function eventsOf({ text }) {
  const raw = text.split('\n').flatMap(parsedEvent);
  const startedBy = new Map(raw.filter((event) => event.type === 'started').map((event) => [event.agentId, event]));
  return raw.flatMap((event) => {
    const start = startedBy.get(event.agentId);
    return start === undefined ? [] : [{ type: event.type, agentId: event.agentId, label: start.label, phase: start.phase }];
  });
}

function runOf(sessionFolder, runId, journal) {
  const events = eventsOf(journal);
  const last = events.at(-1);
  if (last === undefined) return null;
  if (journal.truncated && events[0].phase === last.phase) return null;
  const inPhase = events.filter((event) => event.phase === last.phase);
  const script = scriptOf(sessionFolder, runId);
  const seenPhases = [...new Set(events.map((event) => event.phase).filter((phase) => phase !== null))];
  const inScript = script.titles.indexOf(last.phase) + 1;
  const seenIndex = journal.truncated ? 0 : seenPhases.indexOf(last.phase) + 1;
  const colon = last.label.indexOf(':');
  return {
    runId,
    lanes: laneCounts(events),
    name: script.name,
    row: colon > 0 ? clean(last.label.slice(0, colon), MAX_ROW_CHARS) || null : null,
    phase: last.phase,
    phaseIndex: inScript > 0 ? inScript : seenIndex,
    phaseTotal: script.titles.length > 0 ? script.titles.length : null,
    started: new Set(inPhase.map((event) => event.agentId)).size,
    done: new Set(inPhase.filter((event) => event.type === 'result').map((event) => event.agentId)).size,
  };
}

/** Lanes per phase: a lane is a label's text before its first `:`; each lane counts in the phase of its newest event. */
function laneCounts(events) {
  const phaseOf = new Map();
  for (const event of events) {
    const colon = event.label.indexOf(':');
    if (colon > 0 && event.phase !== null) phaseOf.set(clean(event.label.slice(0, colon), MAX_ROW_CHARS), event.phase);
  }
  const counts = {};
  for (const phase of phaseOf.values()) counts[phase] = (counts[phase] ?? 0) + 1;
  return counts;
}

/** The run folders with a journal written in the window and no summary json, newest first. */
function liveJournals(sessionFolder, nowMs, windowMs = LIVE_WINDOW_MS) {
  const root = join(sessionFolder, 'subagents', 'workflows');
  return namesIn(root).filter((name) => RUN_ID.test(name) && !existsSync(join(sessionFolder, 'workflows', `${name}.json`)))
    .flatMap((runId) => {
      const info = lstatSync(join(root, runId, 'journal.jsonl'), { throwIfNoEntry: false });
      return info?.isFile() && nowMs - info.mtimeMs < windowMs ? [{ runId, mtimeMs: info.mtimeMs }] : [];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RUNS_READ);
}

/**
 * The live workflow runs of a session (see the header).
 * @param {unknown} transcriptPath the session transcript's path from the status line's input (<project>/<session>.jsonl)
 * @param {number} nowMs the clock, epoch ms
 * @returns {{ runId: string, name: string, row: string | null, phase: string | null, phaseIndex: number, phaseTotal: number | null,
 *   started: number, done: number }[]} newest journal first; [] when there is none or anything is unreadable
 */
export function liveRuns(transcriptPath, nowMs) {
  return runsIn(transcriptPath, nowMs, LIVE_WINDOW_MS).map(({ quietMs, lanes, ...run }) => run);
}

/**
 * The board's runs: as liveRuns, over BOARD_WINDOW_MS, each with `quietMs` and `lanes` ({ [phase]: lanes }).
 * @param {unknown} transcriptPath the session transcript's path
 * @param {number} nowMs the clock, epoch ms
 * @returns {object[]} newest journal first; [] when there is none or anything is unreadable
 */
export const boardRuns = (transcriptPath, nowMs) => runsIn(transcriptPath, nowMs, BOARD_WINDOW_MS);

function runsIn(transcriptPath, nowMs, windowMs) {
  if (typeof transcriptPath !== 'string' || !isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) return [];
  const sessionFolder = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'));
  try {
    return liveJournals(sessionFolder, nowMs, windowMs).flatMap(({ runId, mtimeMs }) => {
      const journal = readPart(join(sessionFolder, 'subagents', 'workflows', runId, 'journal.jsonl'), MAX_JOURNAL_BYTES, true);
      const run = journal === null ? null : runOf(sessionFolder, runId, journal);
      return run === null ? [] : [{ ...run, quietMs: Math.max(0, nowMs - mtimeMs) }];
    });
  } catch {
    return []; // no folder yet, a file gone while reading, or a permission error: the status line shows no run line
  }
}
