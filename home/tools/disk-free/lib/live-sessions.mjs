// Which Claude Code sessions are running right now. Exports: liveSessionIds, startTimeOf (tests).
// Claude Code writes ~/.claude/sessions/<pid>.json ({ pid, sessionId, procStart, ... }) for each running session. A session whose process is
// alive owns its scratchpad folder, however old its transcript is (a resumed session writes into a folder the transcript no longer shows).
// A pid alone is no identity (P16): a finished session's pid may now be another process's. When the record's procStart has the shape of
// `ps -o lstart=` in UTC (what Claude Code writes on macOS: `Tue Nov 24 15:37:01 2026`), one `ps` call per look reads the start time of
// every live pid, and a pid whose process started at another time is a reused pid: that session is not running. Anything this cannot
// tell (no procStart or another shape, Windows, ps failing or not listing the pid) keeps the pid-only answer, so a running session is
// never taken for a finished one (the safe side: at worst a reused pid keeps a finished session's folder a while longer).
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { entriesOf } from './clean-scan.mjs';

const MAX_SESSION_FILE_BYTES = 1 << 16;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0; // not defined on Windows
const NO_BLOCK = constants.O_NONBLOCK ?? 0;
const PS_TIMEOUT_MS = 2000; // one ps call for a handful of pids takes milliseconds
const START_TOLERANCE_MS = 2000; // Linux derives lstart from boot time and clock ticks, so two reads of one process can differ by a second
// The system's ps by full path: the clean-up child gets no PATH (disk-clean-start cleanEnv), and a PATH could name another ps.
const PS_PATHS = ['/bin/ps', '/usr/bin/ps'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// `ps -o lstart=` with LC_ALL=C: weekday, month, day, hh:mm:ss, year (the day may be space-padded)
const LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests that the process exists
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists, owned by someone else: still alive
  }
}

/** The text of a plain file of at most MAX_SESSION_FILE_BYTES; null for a link, FIFO, device or bigger file (never followed, never waited on). */
function readPlainFile(file) {
  const fd = openSync(file, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(MAX_SESSION_FILE_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > MAX_SESSION_FILE_BYTES ? null : buffer.toString('utf8', 0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * The UTC instant of an lstart text (`Tue Nov 24 15:37:01 2026`), parsed field by field (never through Date's own text parser).
 * @param {unknown} text a record's procStart or one ps line's start
 * @returns {number | null} epoch ms; null when the text is not in that shape
 */
export function startTimeOf(text) {
  const match = typeof text === 'string' ? LSTART.exec(text.trim()) : null;
  const month = match === null ? -1 : MONTHS.indexOf(match[1]);
  if (month === -1) return null;
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number);
  return Date.UTC(year, month, day, hours, minutes, seconds);
}

/** The record of a running session's process: { pid, sessionId, startMs } (startMs null when procStart cannot be compared), or null. */
function sessionOf(file) {
  try {
    const text = readPlainFile(file);
    if (text === null) return null;
    const { pid, sessionId, procStart } = JSON.parse(text);
    if (!(Number.isInteger(pid) && pid > 0 && typeof sessionId === 'string' && isAlive(pid))) return null;
    return { pid, sessionId, startMs: startTimeOf(procStart) };
  } catch {
    return null; // unreadable or half-written: another file or the next look will tell
  }
}

/**
 * Map pid -> start (epoch ms) of the given processes from one `ps` call in UTC; empty where ps cannot tell (see the header).
 * Also used by long-run's run lock (long-run/lib/run-store.mjs) to tell a lock's taker from a reused pid.
 * @param {number[]} pids live pids.
 * @returns {Map<number, number>} the pids ps listed with a start time in lstart shape.
 */
export function processStarts(pids) {
  const starts = new Map();
  const ps = PS_PATHS.find((path) => existsSync(path)); // none on Windows
  if (pids.length === 0 || ps === undefined) return starts;
  let out;
  try {
    out = execFileSync(ps, ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: { TZ: 'UTC', LC_ALL: 'C' } });
  } catch (error) {
    out = typeof error.stdout === 'string' ? error.stdout : ''; // ps exits 1 when one pid is gone; the lines it printed still count
  }
  for (const line of out.split('\n')) {
    const [, pid, start] = /^\s*(\d+)\s+(.+)$/.exec(line) ?? [];
    const startMs = startTimeOf(start);
    if (startMs !== null) starts.set(Number(pid), startMs);
  }
  return starts;
}

/** True unless ps names another start time for this pid than the record does (a reused pid). */
const isSameProcess = (record, starts) =>
  record.startMs === null || !starts.has(record.pid) || Math.abs(starts.get(record.pid) - record.startMs) <= START_TOLERANCE_MS;

/**
 * @param {string | undefined} sessionsFolder usually ~/.claude/sessions; undefined means none are known
 * @returns {Promise<Set<string>>} the ids of the sessions whose process is alive and, where it can be told, still the same process
 */
export async function liveSessionIds(sessionsFolder) {
  const records = [];
  if (sessionsFolder === undefined) return new Set();
  for await (const entry of entriesOf(sessionsFolder)) {
    const record = entry.name.endsWith('.json') ? sessionOf(join(sessionsFolder, entry.name)) : null;
    if (record !== null) records.push(record);
  }
  const starts = processStarts(records.filter((record) => record.startMs !== null).map((record) => record.pid));
  return new Set(records.filter((record) => isSameProcess(record, starts)).map((record) => record.sessionId));
}
