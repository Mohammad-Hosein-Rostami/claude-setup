// Reads the logs a scenario's checks judge by, besides transcripts. Exports: guardLines(file), guardOutcomes(lines, sessionIds),
// dialogCalls(file), toolLogCalls(file), eventsInOrder(events, expected).
// Sources: the guard's decision log (`<home>/.claude/logs/guard.jsonl`, hooks/lib/guard-log.mjs: one JSON line per ask with ts,
// hook, tool, decision, outcome, reason, command, cwd, session); the scripted dialog's argv log (shims.mjs: one line per call of the
// dialog tool; a desktop note goes through the same tool, so only dialog calls count); the quiet tools' log (`<tool> <args>`, one
// line per call, clean-env.mjs and shims.mjs); long-run's per-run `events.jsonl` ({t, event, step, detail}).
// Invariants: a missing log is an empty one (a check that needs a line then FAILs); nothing here throws.
import { readFileSync } from 'node:fs';
import { readJsonl } from './transcripts.mjs';

const DIALOG_CALL = /display dialog|--question|MessageBox/; // osascript, zenity and PowerShell dialogs; a note is none of these

/** @returns {object[]} the guard log's decision lines */
export const guardLines = (file) => readJsonl(file);

/**
 * @param {object[]} lines guard log lines
 * @param {Iterable<string>} sessionIds the sessions of interest
 * @returns {object[]} the lines of those sessions, in order
 */
export function guardOutcomes(lines, sessionIds) {
  const ids = new Set(sessionIds);
  return lines.filter((line) => ids.has(line.session));
}

const linesOf = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
};

/** @returns {string[]} the calls of the scripted dialog that opened a dialog (notes left out) */
export const dialogCalls = (file) => linesOf(file).filter((line) => DIALOG_CALL.test(line));

/** @returns {{tool: string, args: string}[]} the calls a shim or quiet tool logged */
export const toolLogCalls = (file) => linesOf(file).map((line) => {
  const space = line.indexOf(' ');
  return space === -1 ? { tool: line, args: '' } : { tool: line.slice(0, space), args: line.slice(space + 1) };
});

/**
 * Whether the events hold the expected kinds in this order (other events may come between).
 * @param {{event: string}[]} events in the order they were written
 * @param {(string | string[])[]} expected one kind per step, or a list of kinds any of which fits that step
 * @returns {{ok: boolean, seen: string[], missing: string | null}} `missing`: the first step not found after the ones before
 */
export function eventsInOrder(events, expected) {
  const seen = events.map((event) => String(event.event ?? ''));
  let at = 0;
  for (const step of expected) {
    const kinds = Array.isArray(step) ? step : [step];
    const found = seen.findIndex((kind, index) => index >= at && kinds.includes(kind));
    if (found === -1) return { ok: false, seen, missing: kinds.join(' or ') };
    at = found + 1;
  }
  return { ok: true, seen, missing: null };
}
