// The estimator's stored state: one file per STATUS.md (its sessions, first-seen times, finished rows and jobs, the commitment and
// its log), one link per session to the STATUS.md it last touched, and the seed shipped in the repo.
// Exports: stateDir(), tableId(statusPath), readAllTables(dir), updateTable(dir, statusPath, change), noteTable(dir, statusPath,
// { sessionId, ids, nowMs }), linkedStatusPath(dir, sessionId), readSeed(file).
// Layout under dir (default ~/.claude/state/estimate): table/<id>.json = { v: 2, path, sessions, added: { rowId: iso }, rows:
// [{ size, kind, done, cost }], jobs: [{ at, minutes, growthNum, growthDen }], commit, log }; session/<session-id>.json =
// { path, at }; activity/ belongs to activity.mjs. All files go through hooks/lib/session-store.mjs (no links followed, private
// files) and every write passes { sweep: false }: this is history, never expired.
// Invariants: the table lock is held only for one read-change-write of one table file (the lock is taken as abandoned after 0.5 s,
// so no scan or simulation may run inside it); a busy or unusable store records nothing and returns undefined or false. A file that
// is not a table is skipped, never trusted.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSessionId, readSessionFile, withSessionLock, writeSessionFile } from '../../../hooks/lib/session-store.mjs';

const TABLE_VERSION = 2;
const TABLE_FOLDER = 'table';
const SESSION_FOLDER = 'session';
const TABLE_ID_HEX = 32; // 128 bits of sha256: no two STATUS.md paths on one machine collide
const TABLE_FILE = /^([0-9a-f]{32})\.json$/;
const MAX_TABLE_BYTES = 1 << 20; // 1 MiB: 230 rows, 200 log entries and the first-seen map of the largest table take about 120 KB
const MAX_LINK_BYTES = 1 << 10; // 1 KiB: one path and one time
const SIZES = ['S', 'M', 'L'];
const DEFAULT_SEED = fileURLToPath(new URL('../seed.json', import.meta.url));
const NO_SEED = { rows: [], jobs: [] };
const STORE = { sweep: false };

/** @returns {string} the state root, ~/.claude/state/estimate */
export const stateDir = () => join(homedir(), '.claude', 'state', 'estimate');

/** The real path of a STATUS.md (links resolved); the absolute path when it does not exist. */
function realStatusPath(statusPath) {
  try {
    return realpathSync(statusPath);
  } catch (error) {
    if (error.code === 'ENOENT') return resolve(statusPath);
    throw error;
  }
}

/** @returns {string} the first 32 hex of sha256 of the STATUS.md's real path */
export const tableId = (statusPath) => createHash('sha256').update(realStatusPath(statusPath)).digest('hex').slice(0, TABLE_ID_HEX);

const emptyTable = (statusPath) => ({ v: TABLE_VERSION, path: realStatusPath(statusPath), sessions: [], added: {}, rows: [], jobs: [], commit: null, log: [] });
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTable = (value) => isPlainObject(value) && value.v === TABLE_VERSION && typeof value.path === 'string'
  && Array.isArray(value.sessions) && value.sessions.every(isSessionId)
  && isPlainObject(value.added) && Object.values(value.added).every((at) => typeof at === 'string')
  && Array.isArray(value.rows) && Array.isArray(value.jobs) && Array.isArray(value.log)
  && (value.commit === null || isPlainObject(value.commit));

/** JSON text parsed, or undefined when it is not JSON (a damaged file is treated like any file that is not ours). */
function parsedOrUndefined(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @returns {object | null | undefined} the stored table; null when there is none or it is not a table; undefined when the store is unusable */
function readTable(folder, id) {
  const text = readSessionFile(folder, id, MAX_TABLE_BYTES);
  if (typeof text !== 'string') return text;
  const table = parsedOrUndefined(text);
  return isTable(table) ? table : null;
}

/**
 * Every table file in the store (other tables' rows and jobs make the reference pool).
 * @param {string} dir the state root
 * @returns {object[]} tables with their `id`; [] without a store; files that are not tables are skipped
 */
export function readAllTables(dir) {
  const folder = join(dir, TABLE_FOLDER);
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.flatMap((name) => {
    const id = TABLE_FILE.exec(name)?.[1];
    const table = id === undefined ? null : readTable(folder, id);
    return table ? [{ ...table, id }] : [];
  });
}

/**
 * Reads, changes and writes one table file while holding its lock, so two runs at once never drop each other's change.
 * @param {string} dir the state root
 * @param {string} statusPath the STATUS.md
 * @param {(table: object) => object} change gets the stored table (an empty one when there is none) and returns the table to
 *   store; it must be quick (no scan, no simulation)
 * @returns {object | undefined} the stored table; undefined when the lock stayed busy, the store is unusable or the write failed
 */
export function updateTable(dir, statusPath, change) {
  const folder = join(dir, TABLE_FOLDER);
  const id = tableId(statusPath);
  return withSessionLock(folder, id, () => {
    const current = readTable(folder, id);
    if (current === undefined) return undefined;
    const next = change(current ?? emptyTable(statusPath));
    return writeSessionFile(folder, id, JSON.stringify(next), STORE) ? next : undefined;
  });
}

/** The first-seen map for the ids now in the table: earlier times kept, new ids at nowIso, ids no longer listed dropped. */
const firstSeen = (added, ids, nowIso) => Object.fromEntries(ids.map((id) => [id, Object.hasOwn(added, id) ? added[id] : nowIso]));

/**
 * Records that a session touched a table: the session joins the table's sessions, each row id gets its first-seen time, and the
 * session's link points at this STATUS.md.
 * @param {string} dir the state root
 * @param {string} statusPath the STATUS.md
 * @param {{ sessionId?: string, ids: string[], nowMs: number }} note sessionId: the session (an unsafe or missing id links nothing);
 *   ids: every row id now in the table
 * @returns {boolean} true when everything was recorded
 */
export function noteTable(dir, statusPath, { sessionId, ids, nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const linked = isSessionId(sessionId);
  const stored = updateTable(dir, statusPath, (table) => ({
    ...table,
    sessions: linked && !table.sessions.includes(sessionId) ? [...table.sessions, sessionId] : table.sessions,
    added: firstSeen(table.added, ids, nowIso),
  }));
  if (stored === undefined) return false;
  if (!linked) return true;
  return writeSessionFile(join(dir, SESSION_FOLDER), sessionId, JSON.stringify({ path: stored.path, at: nowIso }), STORE);
}

/**
 * @param {string} dir the state root
 * @param {string} sessionId the session
 * @returns {string | null} the absolute STATUS.md path the session last touched; null when there is no usable link
 */
export function linkedStatusPath(dir, sessionId) {
  const text = readSessionFile(join(dir, SESSION_FOLDER), sessionId, MAX_LINK_BYTES);
  if (typeof text !== 'string') return null;
  const link = parsedOrUndefined(text);
  return isPlainObject(link) && typeof link.path === 'string' && isAbsolute(link.path) ? link.path : null;
}

const isStamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isTableRef = (value) => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isSeedRow = (row) => isPlainObject(row) && isTableRef(row.table) && SIZES.includes(row.size) && typeof row.kind === 'string'
  && isStamp(row.done) && isCount(row.cost);
const isSeedJob = (job) => isPlainObject(job) && isTableRef(job.table) && isStamp(job.at) && isCount(job.minutes)
  && isCount(job.growthNum) && isCount(job.growthDen);

/**
 * The seed shipped in the repo: finished rows and jobs of other machines' tables, so a new machine can forecast at once.
 * @param {string} [file] default: seed.json beside the tool
 * @returns {{ rows: object[], jobs: object[] }} only well-formed entries; no rows when the file does not exist
 * @throws {Error} naming the file when it exists but is not a version-2 seed (a broken repo file must be seen, not ignored)
 */
export function readSeed(file = DEFAULT_SEED) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return NO_SEED;
    throw error;
  }
  const seed = parsedOrUndefined(text);
  if (!isPlainObject(seed) || seed.v !== TABLE_VERSION || !Array.isArray(seed.rows) || !Array.isArray(seed.jobs)) {
    throw new Error(`${file} is not a version ${TABLE_VERSION} estimate seed`);
  }
  return { rows: seed.rows.filter(isSeedRow), jobs: seed.jobs.filter(isSeedJob) };
}
