// Purpose: read a step's stream log as plain lines: `log` (a step's whole log, or its last N lines) and `watch` (follow the live
//   logs of a run as they grow).
// Exports: LOG_TAIL_DEFAULT, readableLines, logLines, watchRun.
// Invariants: reads only; a readable line is assistant text, a tool name, a tool result mark or the result, each cut to one short
//   line; the raw stream is printed only on `--raw`; `watch` stops only when its signal aborts (Ctrl-C ends the watching, not the run).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { units } from './job.mjs';
import { readJournal, readJson, readRunJob } from './run-store.mjs';

/** `log --tail` prints this many readable lines unless told otherwise (spec 19.4). */
export const LOG_TAIL_DEFAULT = 20;
const LINE_MAX_CHARS = 200;
const POLL_MS = 500;

const short = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, LINE_MAX_CHARS);

function assistantLines(event) {
  return (event.message?.content ?? []).flatMap((part) => {
    if (part?.type === 'text' && part.text?.trim()) return part.text.trim().split('\n').filter((line) => line.trim()).map(short);
    if (part?.type === 'tool_use') return [`tool: ${short(part.name)}`];
    return [];
  });
}

/** The readable lines of one stream-json line (none for the lines that say nothing to a reader). */
function readableOf(event) {
  switch (event?.type) {
    case 'system': return event.subtype === 'init' ? [`session ${short(event.session_id)} (${short(event.model)})`] : [];
    case 'assistant': return assistantLines(event);
    case 'user': return (event.message?.content ?? []).some((part) => part?.type === 'tool_result') ? ['tool result'] : [];
    case 'result': return [`result: ${short(event.subtype)}${event.is_error ? ' (error)' : ''}: ${short(String(event.result ?? '').split('\n').at(-1))}`];
    case 'long-run': return [`(${short(event.note)})`];
    default: return [];
  }
}

/** The readable lines of a stream log's text. */
export function readableLines(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return readableOf(JSON.parse(line));
    } catch {
      return [short(line)]; // not JSON: a plain line of the child, shown as it is
    }
  });
}

function logFiles(paths, unitId) {
  const journal = readJournal(paths, unitId);
  return (journal?.startsLog ?? []).map((entry) => join(paths.dir, entry.log)).filter((path) => existsSync(path));
}

/**
 * The lines `log` prints.
 * @param {Record<string, string>} paths runPaths().
 * @param {{step: string | null, raw: boolean, tail: number | null}} options no step: every step in job order, each line prefixed.
 * @returns {string[]}
 */
export function logLines(paths, { step, raw, tail }) {
  const ids = step ? [step] : units(readRunJob(paths)).map((unit) => unit.id);
  const lines = ids.flatMap((unitId) => logFiles(paths, unitId).flatMap((path) => {
    const text = readFileSync(path, 'utf8');
    const out = raw ? text.split('\n').filter(Boolean) : readableLines(text);
    return step ? out : out.map((line) => `[${unitId}] ${line}`);
  }));
  return tail ? lines.slice(-tail) : lines;
}

function liveLogs(paths, step) {
  const driver = readJson(paths.driver);
  const ids = step ? [step] : Object.keys(driver?.live ?? {});
  return ids.flatMap((unitId) => {
    const log = readJournal(paths, unitId)?.startsLog.at(-1)?.log;
    return log ? [{ unitId, path: join(paths.dir, log) }] : [];
  });
}

/**
 * Follows the live logs of a run (or one step) and writes new readable lines until `signal` aborts.
 * @param {{paths: Record<string, string>, step: string | null, write: (line: string) => void, signal: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>}} options
 * @returns {Promise<void>}
 */
export async function watchRun({ paths, step, write, signal, sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }) }) {
  const offsets = new Map();
  for (const { path } of liveLogs(paths, step)) offsets.set(path, existsSync(path) ? statSync(path).size : 0);
  while (!signal.aborted) {
    for (const { unitId, path } of liveLogs(paths, step)) {
      const size = existsSync(path) ? statSync(path).size : 0;
      const from = offsets.get(path) ?? 0;
      if (size <= from) continue;
      const text = readFileSync(path).subarray(from, size).toString('utf8');
      const complete = text.lastIndexOf('\n') + 1; // a half-written last line waits for the next round
      offsets.set(path, from + Buffer.byteLength(text.slice(0, complete)));
      for (const line of readableLines(text.slice(0, complete))) write(step ? line : `[${unitId}] ${line}`);
    }
    await sleep(POLL_MS);
  }
}
