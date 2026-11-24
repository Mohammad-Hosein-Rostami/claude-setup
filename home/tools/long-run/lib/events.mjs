// Purpose: the events of every run (spec 19.3, 19.6): each event goes to the run's `events.jsonl` and, as one short numbered line,
//   to the global `events.log` a controller session follows; `events` reads, follows (`--follow --after <n>`) or waits for the next
//   lines (`--wait-next`), and reports a dead driver once as `driver-lost`.
// Exports: EVENT_LINE_MAX_CHARS, EVENTS_ROTATE_BYTES, recordEvent, readEventLines, followEvents, waitNextEvents, reportLostDrivers.
// Invariants: a global line is `#<n> <HH:MM> <run-id> <step|-> <event> <detail>`, one line, at most EVENT_LINE_MAX_CHARS; n grows
//   by one per line across rotation (events.seq) under a lock (hooks/lib/session-lock.mjs), and a line is written even when the
//   lock stays taken (its number may then repeat; it is never lost); details are built by callers from ids, status words, times and
//   counts only, never a prompt, question, path of a log line or token; the log is rotated to events.log.1 past EVENTS_ROTATE_BYTES;
//   followers read files only (Node, no `tail`), so they work on macOS and Windows alike.
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withSessionLock } from '../../../hooks/lib/session-lock.mjs';
import { PRIVATE_FILE_MODE, ensurePrivateDir } from '../../account/lib/private-fs.mjs';
import { appendJsonLine, driverAlive, listRunIds, readJson, runPaths } from './run-store.mjs';

/** The most characters of one global events line (spec 19.3). */
export const EVENT_LINE_MAX_CHARS = 160;
/** events.log is rotated to events.log.1 past this size. */
export const EVENTS_ROTATE_BYTES = 1024 * 1024;
const LOCK_TRIES = 10;
const POLL_MS = 500;
const LOST_CHECK_MS = 60 * 1000;
const BATCH_MS = 2000;
const LINE_SEQ = /^#(\d+) /;
// A driver in one of these states should be alive; a dead one is `driver-lost`.
const LIVE_DRIVER_STATES = new Set(['running']);

const files = (root) => ({ log: join(root, 'events.log'), old: join(root, 'events.log.1'), seq: join(root, 'events.seq'), locks: join(root, 'locks') });
const hhmm = (at) => `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
const oneLine = (text) => String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();

function nextSeq(paths) {
  const last = existsSync(paths.seq) ? Number(readFileSync(paths.seq, 'utf8').trim()) : 0;
  const next = Number.isFinite(last) ? last + 1 : 1;
  writeFileSync(paths.seq, `${next}\n`, { mode: PRIVATE_FILE_MODE });
  return next;
}

function appendGlobal(root, body) {
  const paths = files(root);
  const write = () => {
    const line = `#${nextSeq(paths)} ${body}`.slice(0, EVENT_LINE_MAX_CHARS);
    const size = existsSync(paths.log) ? statSync(paths.log).size : 0;
    if (size + Buffer.byteLength(line) + 1 > EVENTS_ROTATE_BYTES) renameSync(paths.log, paths.old);
    appendFileSync(paths.log, `${line}\n`, { mode: PRIVATE_FILE_MODE });
    return line;
  };
  ensurePrivateDir(paths.locks);
  for (let tries = 0; tries < LOCK_TRIES; tries += 1) {
    const line = withSessionLock(paths.locks, 'events', write);
    if (line !== undefined) return line;
  }
  return write(); // the lock stayed taken ~10 s: write anyway, a repeated number beats a lost event
}

/**
 * Records one event of a run.
 * @param {Record<string, string>} paths runPaths() of the run.
 * @param {{event: string, step?: string | null, detail?: string, at?: Date, data?: object}} entry `data`: extra fields for
 *   events.jsonl only (ids, numbers, session ids; never a prompt, question text or token).
 * @returns {string} the global line written.
 */
export function recordEvent(paths, { event, step = null, detail = '', at = new Date(), data = {} }) {
  appendJsonLine(paths.events, { t: at.toISOString(), event, step, detail: oneLine(detail), ...data });
  return appendGlobal(paths.root, `${hhmm(at)} ${paths.runId} ${step ?? '-'} ${event} ${oneLine(detail)}`.trimEnd());
}

const seqOf = (line) => Number(LINE_SEQ.exec(line)?.[1] ?? 0);
const lineRun = (line) => line.split(' ')[2] ?? '';

/**
 * @param {string} root stateRoot().
 * @param {{run?: string | null}} filter only lines of this run.
 * @returns {string[]} every global line still kept (events.log.1, then events.log), oldest first.
 */
export function readEventLines(root, { run = null } = {}) {
  const paths = files(root);
  const lines = [paths.old, paths.log].filter((path) => existsSync(path))
    .flatMap((path) => readFileSync(path, 'utf8').split('\n')).filter((line) => LINE_SEQ.test(line));
  return run ? lines.filter((line) => lineRun(line) === run) : lines;
}

const lastSeq = (root) => {
  const path = files(root).seq;
  return existsSync(path) ? Number(readFileSync(path, 'utf8').trim()) || 0 : 0;
};

/**
 * Writes one `driver-lost` event for each run whose driver should run but is gone; a marker file per driver pid makes it once.
 * @param {string} root stateRoot().
 * @param {Date} now the current time.
 * @returns {number} how many were reported now.
 */
export function reportLostDrivers(root, now = new Date()) {
  let count = 0;
  for (const runId of listRunIds(root)) {
    const paths = runPaths(root, runId);
    const driver = readJson(paths.driver);
    if (!driver || !LIVE_DRIVER_STATES.has(driver.status) || driverAlive(paths, now)) continue;
    try {
      writeFileSync(join(paths.dir, `driver-lost.${driver.pid}`), now.toISOString(), { flag: 'wx', mode: PRIVATE_FILE_MODE });
    } catch (error) {
      if (error.code === 'EEXIST') continue; // reported before, by this or another follower
      throw error;
    }
    recordEvent(paths, { event: 'driver-lost', detail: `driver pid ${driver.pid} is gone; resume with: long-run resume ${runId}`, at: now });
    count += 1;
  }
  return count;
}

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Prints lines above `after`, then every new line, until `signal` aborts. Once a minute it reports lost drivers.
 * @param {{root: string, after?: number | null, run?: string | null, write: (line: string) => void, signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>, now?: () => Date}} options `after` null: start at the newest line.
 * @returns {Promise<void>} when aborted.
 */
export async function followEvents({ root, after = null, run = null, write, signal, sleep = realSleep, now = () => new Date() }) {
  let seen = after ?? lastSeq(root);
  let lostCheckAt = 0;
  while (!signal?.aborted) {
    if (now().getTime() - lostCheckAt >= LOST_CHECK_MS) {
      lostCheckAt = now().getTime();
      reportLostDrivers(root, now());
    }
    for (const line of readEventLines(root, { run }).filter((one) => seqOf(one) > seen)) {
      write(line);
      seen = Math.max(seen, seqOf(line));
    }
    await sleep(POLL_MS);
  }
}

/**
 * Waits for the next line(s) above `after`, lines within BATCH_MS together, or gives up after `maxWaitMs` with `#<n> idle`.
 * @param {{root: string, after?: number | null, run?: string | null, maxWaitMs: number, write: (line: string) => void,
 *   sleep?: (ms: number) => Promise<void>, now?: () => Date}} options
 * @returns {Promise<'lines' | 'idle'>}
 */
export async function waitNextEvents({ root, after = null, run = null, maxWaitMs, write, sleep = realSleep, now = () => new Date() }) {
  const from = after ?? lastSeq(root);
  const deadline = now().getTime() + maxWaitMs;
  let lostCheckAt = 0;
  const fresh = () => readEventLines(root, { run }).filter((line) => seqOf(line) > from);
  while (now().getTime() < deadline) {
    if (now().getTime() - lostCheckAt >= LOST_CHECK_MS) {
      lostCheckAt = now().getTime();
      reportLostDrivers(root, now());
    }
    if (fresh().length > 0) {
      await sleep(BATCH_MS);
      for (const line of fresh()) write(line);
      return 'lines';
    }
    await sleep(POLL_MS);
  }
  write(`#${from} idle`);
  return 'idle';
}
