// The done-check ledger: what each run of the checks did, the owner's labels on it, and the numbers that tell whether a check is worth
// its noise (design section 3.7). One file, ~/.claude/state/done-check/ledger.jsonl, one JSON row per line, append only.
// Exports: appendRun(row, options) -> boolean, appendLabel(row, options) -> boolean, readLedger({ sinceMs, env }) -> { runs, labels },
//   lastRun({ repoId, session, agent, env }) -> row | null, stats({ runs, labels }) -> entry[], ledgerUsage({ env }) -> { bytes,
//   maxBytes, full }, ledgerFile(env) -> path, MAX_ROW_BYTES, MAX_NOTE_CHARS.
// Invariants:
// - The ledger holds kinds, counts, ms, a hashed repo id and ids: never a file name, a path, code or a secret. The writer copies only the
//   fields of the design's two row shapes, so a field a caller adds by mistake is not stored.
// - One row is one write (O_APPEND) of at most MAX_ROW_BYTES, so two sessions appending at once never interleave a line.
// - The writer and the reader share LEDGER_MAX_BYTES (contract.mjs): at the cap the writer refuses (returns false, the file is not
//   touched) and `ledgerUsage` says so; a file over the cap is read as empty rather than parsed whole. Both go through lib/plain-file.mjs,
//   so a link, a FIFO or a folder at the ledger path is never followed or waited on.
// - A crash can leave a half line without its line feed: the next append starts a new line first, so the half line is lost and the new
//   row is not. A line that is not JSON, not an object, or a row of another version `v` is skipped by the reader, never an error.
// - A row with a wrong shape is a bug in the caller: appendRun and appendLabel throw a TypeError. A file that cannot be written (no
//   permission, a link planted at the path, a FIFO) gives false.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendPlainFile, NOT_PLAIN_FILE, readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { CHECK_KINDS, LEDGER_MAX_BYTES } from './contract.mjs';

/** Most bytes one row may take, line feed included: a row is written with one call, which the OS never splits between two writers. */
export const MAX_ROW_BYTES = 16 * 1024;
/** Most characters of an owner's note. */
export const MAX_NOTE_CHARS = 200;

const ROW_VERSION = 1;
const LABELS = ['false-alarm', 'real', 'missed'];
const WHERE = ['stop', 'land', 'manual'];
const CHECK_FIELDS = ['result', 'new', 'old', 'ms'];
const STATE_FOLDER_MODE = 0o700;
const P90 = 0.9;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const UNREADABLE_LEDGER_CODES = new Set(['ENOENT', 'ELOOP', NOT_PLAIN_FILE]); // nothing to read: the ledger is then empty
const UNWRITABLE_LEDGER_CODES = new Set(['ELOOP', 'ENXIO', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EISDIR', 'ENOTDIR']);

/** The ledger file of `env` (HOME or USERPROFILE decide, so a test or a probe with another HOME never touches the real one). */
export const ledgerFile = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'done-check', 'ledger.jsonl');

const isText = (value) => typeof value === 'string';
const isCount = (value) => Number.isFinite(value);
const fail = (what) => { throw new TypeError(`ledger: ${what}`); };

/** Copies the design's run row field by field; throws a TypeError for a missing or mistyped field. */
function cleanRunRow(row) {
  const ok = row?.v === ROW_VERSION && ['id', 'at', 'session', 'agent', 'repo', 'key', 'verdict'].every((name) => isText(row[name]))
    && WHERE.includes(row.where) && (row.base === null || isText(row.base)) && isCount(row.files) && isCount(row.ms)
    && Array.isArray(row.risk) && row.risk.every(isText) && row.checks !== null && typeof row.checks === 'object' && !Array.isArray(row.checks);
  if (!ok) fail('a run row needs v 1, id, at, where, session, agent, repo, base, key, files, checks, verdict, risk and ms');
  const checks = {};
  for (const [kind, check] of Object.entries(row.checks)) {
    if (!CHECK_KINDS.includes(kind) || !isText(check?.result) || !CHECK_FIELDS.slice(1).every((name) => isCount(check[name]))) fail(`bad check entry "${kind}"`);
    checks[kind] = { result: check.result, new: check.new, old: check.old, ms: check.ms, ...(isText(check.why) ? { why: check.why } : {}) };
  }
  const { v, id, at, where, session, agent, repo, base, key, files, verdict, risk, ms } = row;
  return { v, id, at, where, session, agent, repo, base, key, files, checks, verdict, risk: [...risk], ms };
}

/** A note cut to MAX_NOTE_CHARS, without a lone half of a surrogate pair at the cut. */
function shortNote(note) {
  const cut = note.slice(0, MAX_NOTE_CHARS);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Copies the design's label row; throws a TypeError for a missing or mistyped field. The note is cut to MAX_NOTE_CHARS. */
function cleanLabelRow(row) {
  const ok = row?.v === ROW_VERSION && LABELS.includes(row.label) && ['run', 'check', 'at', 'note'].every((name) => isText(row[name]));
  if (!ok) fail('a label row needs v 1, label (false-alarm, real or missed), run, check, at and note');
  return { v: row.v, label: row.label, run: row.run, check: row.check, at: row.at, note: shortNote(row.note) };
}

/** True when the file exists, is regular, is not empty and its last byte is not a line feed (a crash cut the last row). */
function endsInHalfLine(file) {
  let fd;
  try {
    fd = openSync(file, READ_FLAGS);
    const { size } = fstatSync(fd);
    const last = Buffer.alloc(1);
    return size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
  } catch {
    return false; // a missing file needs no repair; any other failure shows again, with its code, when the append opens the same path
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function appendLine(row, { env = process.env } = {}) {
  const line = `${JSON.stringify(row)}\n`;
  if (Buffer.byteLength(line) > MAX_ROW_BYTES) return false;
  const file = ledgerFile(env);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: STATE_FOLDER_MODE });
    return appendPlainFile(file, `${endsInHalfLine(file) ? '\n' : ''}${line}`, { maxBytes: LEDGER_MAX_BYTES });
  } catch (error) {
    if (UNWRITABLE_LEDGER_CODES.has(error?.code)) return false;
    throw error;
  }
}

/**
 * Appends the row of one run of the checks.
 * @param {import('./contract.mjs').RunRow} row the run row (design section 6); only its own fields are stored
 * @param {{ env?: NodeJS.ProcessEnv }} [options] env: where HOME points (default process.env)
 * @returns {boolean} true when written; false when the ledger is at its size cap, the row is over MAX_ROW_BYTES or the file cannot be written
 * @throws {TypeError} the row has a wrong shape
 */
export const appendRun = (row, options) => appendLine(cleanRunRow(row), options);

/**
 * Appends one owner label.
 * @param {import('./contract.mjs').LabelRow} row the label row; its note is cut to MAX_NOTE_CHARS
 * @param {{ env?: NodeJS.ProcessEnv }} [options] env: where HOME points (default process.env)
 * @returns {boolean} true when written; false for the same reasons as appendRun
 * @throws {TypeError} the row has a wrong shape
 */
export const appendLabel = (row, options) => appendLine(cleanLabelRow(row), options);

const isRunRow = (row) => isText(row.id) && Number.isFinite(Date.parse(row.at)) && row.checks !== null && typeof row.checks === 'object' && !Array.isArray(row.checks)
  && Object.values(row.checks).every((check) => check !== null && typeof check === 'object');
const isLabelRow = (row) => LABELS.includes(row.label) && isText(row.run) && isText(row.check) && Number.isFinite(Date.parse(row.at));

/**
 * Reads the ledger. A missing ledger, a link or FIFO at its path, and a file over LEDGER_MAX_BYTES all read as empty.
 * @param {{ sinceMs?: number, env?: NodeJS.ProcessEnv }} [options] sinceMs: keep rows whose `at` is at or after this epoch time (default all)
 * @returns {{ runs: object[], labels: object[] }} the valid rows of this version, in file order
 * @throws {Error} a read error that is not "nothing to read" (for example EACCES)
 */
export function readLedger({ sinceMs = -Infinity, env = process.env } = {}) {
  let text;
  try {
    text = readPlainFile(ledgerFile(env), LEDGER_MAX_BYTES);
  } catch (error) {
    if (UNREADABLE_LEDGER_CODES.has(error?.code)) return { runs: [], labels: [] };
    throw error;
  }
  const runs = [];
  const labels = [];
  for (const line of text.split('\n')) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a blank line, a half line left by a crash, or text that is not ours
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row) || row.v !== ROW_VERSION || !(Date.parse(row.at) >= sinceMs)) continue;
    if (isRunRow(row)) runs.push(row);
    else if (isLabelRow(row)) labels.push(row);
  }
  return { runs, labels };
}

/**
 * The newest run row that matches every given filter.
 * @param {{ repoId?: string, session?: string, agent?: string, env?: NodeJS.ProcessEnv }} [filter] repoId matches the row field `repo`
 * @returns {object|null} the row, or null when none matches
 */
export function lastRun({ repoId, session, agent, env } = {}) {
  const { runs } = readLedger({ env });
  const matches = (row) => (repoId === undefined || row.repo === repoId) && (session === undefined || row.session === session) && (agent === undefined || row.agent === agent);
  return runs.findLast(matches) ?? null;
}

/**
 * How full the ledger file is, for `stats` to say when the writer has started to refuse rows.
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ bytes: number, maxBytes: number, full: boolean }} full: fewer than MAX_ROW_BYTES left, so a normal row is refused
 */
export function ledgerUsage({ env = process.env } = {}) {
  let bytes = 0;
  let fd;
  try {
    fd = openSync(ledgerFile(env), READ_FLAGS);
    bytes = fstatSync(fd).size;
  } catch {
    bytes = 0; // no readable ledger file: nothing is stored, nothing is full
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return { bytes, maxBytes: LEDGER_MAX_BYTES, full: bytes > LEDGER_MAX_BYTES - MAX_ROW_BYTES };
}

const middleOf = (sorted) => (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2));
const nearestRank = (sorted, fraction) => sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];

/** The last label per (run, check): a later label replaces an earlier one, so the owner can change their mind. */
function latestLabels(labels) {
  const latest = new Map();
  for (const label of [...labels].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) latest.set(`${label.run}\u0000${label.check}`, label);
  return latest;
}

/** For each run row, the next run of the same repo, session and agent (null for the last one). Rows are in time order. */
function nextRunOf(runs) {
  const next = new Map();
  const pending = new Map();
  for (const row of runs) {
    const owner = [row.repo, row.session, row.agent].join('\u0000');
    if (pending.has(owner)) next.set(pending.get(owner), row);
    pending.set(owner, row);
  }
  return next;
}

/** The numbers of one check kind over `runs` (only rows that have that kind), or null when no row has it. */
function statsOfKind(kind, runs, nextOf, labelOf) {
  const rows = runs.filter((row) => row.checks[kind]);
  if (rows.length === 0) return null;
  const entry = { kind, runs: rows.length, blocks: 0, actedOn: 0, ignored: 0, falseAlarmRate: 0, labels: { falseAlarm: 0, real: 0, missed: 0 }, medianMs: 0, p90Ms: 0, notRun: {} };
  let falseAlarms = 0;
  const times = [];
  for (const row of rows) {
    const check = row.checks[kind];
    if (check.result === 'not-run') entry.notRun[check.why ?? 'unknown'] = (entry.notRun[check.why ?? 'unknown'] ?? 0) + 1;
    else times.push(check.ms);
    const label = labelOf.get(`${row.id}\u0000${kind}`)?.label;
    if (label) entry.labels[label === 'false-alarm' ? 'falseAlarm' : label] += 1;
    if (row.verdict !== 'block' || !(check.new > 0)) continue;
    entry.blocks += 1;
    const next = nextOf.get(row);
    const ignored = next !== undefined && next.key === row.key;
    const actedOn = next !== undefined && next.key !== row.key && next.checks[kind]?.new === 0 && next.checks[kind]?.result !== 'fail';
    entry.ignored += ignored ? 1 : 0;
    entry.actedOn += actedOn ? 1 : 0;
    if ((ignored || label === 'false-alarm') && label !== 'real') falseAlarms += 1;
  }
  entry.falseAlarmRate = entry.blocks === 0 ? 0 : falseAlarms / entry.blocks;
  const sorted = times.sort((a, b) => a - b);
  if (sorted.length > 0) Object.assign(entry, { medianMs: middleOf(sorted), p90Ms: nearestRank(sorted, P90) });
  return entry;
}

/**
 * What the ledger says about each check: how often it blocked, how often the agent acted on that or ignored it, how often the owner
 * called it a false alarm, how long it takes, and why it did not run.
 * A block is a run with verdict `block` whose check of that kind found something new. It is acted on when the agent's next run (same
 * repo, session and agent) has another change key and that kind passes, and ignored when the next run has the same key. The false-alarm
 * rate is the share of blocks that were ignored or labelled false-alarm, minus those labelled real.
 * @param {{ runs: object[], labels: object[] }} ledger what readLedger returned (a label of a run not in `runs` changes nothing)
 * @returns {{ kind: string, runs: number, blocks: number, actedOn: number, ignored: number, falseAlarmRate: number,
 *   labels: { falseAlarm: number, real: number, missed: number }, medianMs: number, p90Ms: number, notRun: Record<string, number> }[]}
 *   one entry per check kind that has runs, in CHECK_KINDS order; [] for an empty ledger
 */
export function stats({ runs, labels }) {
  const inTimeOrder = [...runs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const nextOf = nextRunOf(inTimeOrder);
  const labelOf = latestLabels(labels);
  return CHECK_KINDS.map((kind) => statsOfKind(kind, inTimeOrder, nextOf, labelOf)).filter((entry) => entry !== null);
}
