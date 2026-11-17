// What a workflow run left on disk, read from its run folder: finished, ended early, lost, or unfinished with what is done and what is left.
// Exports: inspectRun(sessionFolder, record, nowMs) -> { state: 'finished' | 'ended' | 'gone' | 'lost' | 'unfinished', ... }, runFolderOf(sessionFolder, runId).
// Layout read (Claude Code 2.1.326, undocumented, see the round 5 resume probe): <session>/subagents/workflows/<runId>/journal.jsonl (one JSON
// line per agent event: `started` with agentId, label and phase; `result` with the agentId; `launched` with nothing), and
// <session>/workflows/<runId>.json, written when the run is over (its `status` is `completed` for a run that returned; any other status, for
// example one whose agents failed at a usage limit, is `ended`: it needs a relaunch). A run with no summary json and a journal is unfinished: there is no
// "finished" line in the journal, so a run that stopped between two agents looks the same as one that was killed.
// States: finished (summary json says completed, or cannot be read), ended { status } (summary json with another status; its journal is then looked at as for unfinished), gone (the session folder itself is not there any more: the retention sweep removed it, nothing to
// resume), lost (the session folder is there but the run's journal is not), unfinished: { ageMs (since the journal was last written), done
// (agents with a result), interrupted (labels of agents started and not finished), phase (of the newest started agent), notReached (script
// phases after it, from the script copy's `meta`) }.
// Invariants: reads plain files only (lstat, no links), caps every read, never throws (anything unreadable gives `lost`); labels are script
// text, so they are cut to MAX_LABEL_CHARS and lose control characters.
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { metaOf, readPart } from '../../estimate/lib/workflow-runs.mjs';

const MAX_JOURNAL_BYTES = 4 << 20;
const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_LABEL_CHARS = 40;
const MAX_INTERRUPTED_LISTED = 3;
const MAX_SUMMARY_BYTES = 4 << 20;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const ANGLE_BRACKETS = /[<>]/g; // script text reaches the lead inside a tag: it must not be able to close it
const clean = (text, max) => text.replace(CONTROL_CHARS, ' ').replace(ANGLE_BRACKETS, '').slice(0, max);

/** The folder Claude Code keeps one run in. */
export const runFolderOf = (sessionFolder, runId) => join(sessionFolder, 'subagents', 'workflows', runId);

/** The agent events of a journal text: started agents (label, phase) and the ids that have a result. Lines that are not JSON are skipped. */
function eventsOf(text) {
  const startedAgents = new Map();
  const finished = new Set();
  for (const line of text.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object' || typeof event.agentId !== 'string') continue;
    if (event.type === 'started') startedAgents.set(event.agentId, { label: typeof event.label === 'string' ? event.label : '', phase: typeof event.phase === 'string' ? event.phase : null });
    if (event.type === 'result') finished.add(event.agentId);
  }
  return { startedAgents, finished };
}

/** The phase titles of the script file named in the record; [] when it cannot be read. Only a `.js` plain file is read. */
function phaseTitles(scriptPath) {
  if (!scriptPath.endsWith('.js')) return [];
  try {
    return metaOf(readPart(scriptPath, MAX_SCRIPT_BYTES, false)?.text ?? '')?.titles ?? [];
  } catch {
    return [];
  }
}

/** The `status` of a run's summary json: a string, or null when the file cannot be read or has none (then the run counts as finished). */
function summaryStatus(summaryPath) {
  try {
    const status = JSON.parse(readPart(summaryPath, MAX_SUMMARY_BYTES, false)?.text ?? '').status;
    return typeof status === 'string' ? status : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} sessionFolder <projects>/<projectDir>/<sessionId>, rebuilt from names, never from a path in a state file
 * @param {{ runId: string, scriptPath: string }} record the registry record of the run
 * @param {number} nowMs the clock, epoch ms
 */
export function inspectRun(sessionFolder, record, nowMs) {
  try {
    const summaryPath = join(sessionFolder, 'workflows', `${record.runId}.json`);
    const endedWith = existsSync(summaryPath) ? summaryStatus(summaryPath) : undefined;
    if (endedWith === null || endedWith === 'completed') return { state: 'finished' };
    if (!existsSync(sessionFolder)) return { state: 'gone' };
    const journalPath = join(runFolderOf(sessionFolder, record.runId), 'journal.jsonl');
    const info = lstatSync(journalPath, { throwIfNoEntry: false });
    const journal = info?.isFile() ? readPart(journalPath, MAX_JOURNAL_BYTES, false) : null;
    if (journal === null) return { state: 'lost' };
    const { startedAgents, finished } = eventsOf(journal.text);
    const interrupted = [...startedAgents].filter(([agentId]) => !finished.has(agentId)).map(([, agent]) => clean(agent.label, MAX_LABEL_CHARS));
    const phase = [...startedAgents.values()].at(-1)?.phase ?? null;
    const titles = phaseTitles(record.scriptPath);
    const at = phase === null ? -1 : titles.indexOf(phase);
    return {
      state: endedWith === undefined ? 'unfinished' : 'ended',
      ...(endedWith === undefined ? {} : { status: clean(endedWith, MAX_LABEL_CHARS) }),
      ageMs: nowMs - info.mtimeMs,
      done: finished.size,
      interrupted: interrupted.slice(0, MAX_INTERRUPTED_LISTED),
      interruptedCount: interrupted.length,
      phase: phase === null ? null : clean(phase, MAX_LABEL_CHARS),
      notReached: at < 0 ? [] : titles.slice(at + 1),
    };
  } catch {
    return { state: 'lost' };
  }
}
