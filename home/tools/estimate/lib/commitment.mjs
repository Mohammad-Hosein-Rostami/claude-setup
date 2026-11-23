// The one committed time of a job and its record: whether a run keeps it or moves it (earlier or later, with one stored cause) or
// makes the first one; scoring each logged commitment at the hand-over; the widening factor, the past-jobs band and the track record
// learned from those scores.
// Exports: MODEL_ID, nextCommitment(commit, fresh, leftMin, context), firstCommitmentOf(commit), cappedLog(log),
// scoreLog(log, items, intervals), widening(log), band(log), trackRecord(log).
// Rules (backtest section 7, model c2b; hold band and pace model c3, spec R18 E2/E4): a commitment is a work budget,
// { at, budgetMin, ids, moved, first, laterCause }, of the forecast MEDIAN (the 85% time is the second clock). It is held while the
// fresh median is within the hold band of the budget left (moveToleranceMin), else it moves to the fresh median, earlier or later:
// the old never-earlier hold only ever moved later and was 245 min off per job. `first` keeps the job's first budget and
// `laterCause` the cause of its latest later move, so the status line can say how late the job runs against its first time and why.
// A commitment written before c3 has neither: `first` is taken from it while it never moved, else unknown (null).
// Every log entry carries the model id; widening, band and track record count only entries of the current model, so their counts
// restart at a model change (R69).
// Model s1 (estimate spec R9, R11; owner R22-E2, E3): PROMISE_MODEL, promiseOf(stored, fresh, nowMs), promiseDiff(promise, fresh,
// workedSinceMin, rowsNow, rowsAtPromise). The job's one finish promise, { model, job, atMs, p80Ms, workMin, rows }, is the 80%
// clock and the 80% work it stood for; only a recorded CLI run at the real clock makes it, once per job, and nothing moves it: it
// has no hold band. Later or earlier is measured in working minutes, so a pause never counts as late (the caller moves the shown
// clocks by the pauses). A stored record that is not a whole s1 promise of this job (a c3 `commit`, a torn or future one) is no
// promise. The c3 functions above stay for from-files.mjs and the c3 replay in backtest.mjs until s1 is wired in.
// Invariants: pure (no I/O, no clock); returns new objects and never changes its arguments. Times are ISO strings in the stored
// c3 objects, epoch ms in the s1 promise and epoch minutes in `context.nowMin`; work is in minutes.
import { nearestRank } from './forecast.mjs';
import { workedMinutes } from './worked.mjs';

/** Scored first commitments before the widening factor is used (design 3.9, U10). */
const WIDEN_MIN_JOBS = 10;
/** The widening factor is the p85 of the ratio over this many latest scored first commitments (design 3.9, U10). */
const WIDEN_WINDOW_JOBS = 20;
const WIDEN_SHARE = 0.85;
/** The track record counts this many latest scored first commitments: jobs, not runs (design 3.9). */
const TRACK_RECORD_JOBS = 10;
const MS_PER_MIN = 60_000;
/** The estimate model of this code; entries of another model are kept but not counted (R69: counts restart at a model change). */
export const MODEL_ID = 'c3';
/** The hold band: a fresh median within max(MOVE_TOLERANCE_MIN, MOVE_TOLERANCE_SHARE x the larger of it and the budget left) keeps
 *  the commitment. On the 14 replayed jobs the old 5-minute band made 160 commitments; this band makes 64 (57 with the pace) and
 *  the per-job median miss of the shown time falls from 32 to 28 min (22 with the pace) (spec R18 E2). */
const MOVE_TOLERANCE_MIN = 15;
const MOVE_TOLERANCE_SHARE = 0.25;
/** Scored first commitments of this model before the past-jobs band is shown (R69, research2/estimate.md P3). */
const BAND_MIN_JOBS = 20;
const BAND_LOW_SHARE = 0.1;
const BAND_HIGH_SHARE = 0.9;
/** Log entries kept per table besides every first commitment and every scored entry, which are always kept: 200 moves in one day
 *  once pushed out every first commitment of a table, so widening and the track record never learned (spec R18 E1). */
const MAX_LOG_ENTRIES = 200;

const isoOfMinute = (minute) => new Date(minute * MS_PER_MIN).toISOString();
const minuteOfIso = (iso) => Date.parse(iso) / MS_PER_MIN;
const isCommitmentEntry = (entry) => typeof entry.first === 'boolean';
const scoredFirsts = (log) => log.filter((entry) => entry.first === true && entry.scored !== undefined && entry.model === MODEL_ID);
const moveToleranceMin = (leftMin, p50) => Math.max(MOVE_TOLERANCE_MIN, MOVE_TOLERANCE_SHARE * Math.max(leftMin, p50));
/**
 * @param {{ at: string, budgetMin: number, moved: object | null, first?: { at: string, budgetMin: number } | null }} commit a stored commitment
 * @returns {{ at: string, budgetMin: number } | null} the job's first commitment; for one written before c3 (no `first`), itself
 *   while it never moved, else null (unknown)
 */
export const firstCommitmentOf = (commit) => commit.first ?? (commit.moved === null ? { at: commit.at, budgetMin: commit.budgetMin } : null);

/**
 * Why a commitment had to move. Earlier: 'ahead' (rows finished sooner than usual or were dropped). Later, by precedence: rows added
 * since it was made; a running row slower than its class p85; pace.
 */
function moveCause(commit, { openIds, slowRowId }, earlier) {
  if (earlier) return { cause: 'ahead', ids: commit.ids.filter((id) => !openIds.includes(id)) };
  const added = openIds.filter((id) => !commit.ids.includes(id));
  if (added.length > 0) return { cause: 'rows-added', ids: added };
  if (slowRowId) return { cause: 'slow-row', ids: [slowRowId] };
  return { cause: 'pace', ids: [] };
}

/**
 * Decides this run's commitment: first, hold or move, earlier or later (see the header).
 * @param {{ at: string, budgetMin: number, ids: string[], moved: object | null } | null} commit the stored commitment of the
 *   current job (null when there is none; the caller passes null after a hand-over)
 * @param {{ p50: number, raw85: number, p85: number, p95: number, g: number, kappa: number }} fresh this run's forecast, p85 and
 *   p95 widened by kappa, raw85 before widening
 * @param {number | null} leftMin budgetMin minus the minutes worked since the commitment (ignored when commit is null)
 * @param {{ nowMin: number, openIds: string[], slowRowId: string | null }} context slowRowId: a running row whose elapsed share is
 *   above its class p85
 * @returns {{ commit: object, entry: object | null }} the commitment to store (the same object on a hold) and the log entry to add
 *   (null on a hold); a move keeps { at, wasClock, cause, ids } so a later run prints the same cause (cause 'ahead' for an earlier
 *   move), `first` ({ at, budgetMin } of the job's first commitment, null when unknown) and `laterCause` ({ cause, ids } of the
 *   latest later move, null before one)
 */
export function nextCommitment(commit, fresh, leftMin, context) {
  const at = isoOfMinute(context.nowMin);
  const { p50, raw85, p85, p95, g, kappa } = fresh;
  const entry = (first, cause) => ({ at, ids: [...context.openIds], p50, raw85, p85, p95, g, kappa, first, cause, model: MODEL_ID });
  if (commit === null) {
    return { commit: { at, budgetMin: p50, ids: [...context.openIds], moved: null, first: { at, budgetMin: p50 }, laterCause: null }, entry: entry(true, null) };
  }
  if (Math.abs(leftMin - p50) <= moveToleranceMin(leftMin, p50)) return { commit, entry: null };
  const earlier = p50 < leftMin;
  const { cause, ids } = moveCause(commit, context, earlier);
  const moved = { at, wasClock: isoOfMinute(context.nowMin + leftMin), cause, ids };
  const laterCause = earlier ? commit.laterCause ?? null : { cause, ids };
  return { commit: { at, budgetMin: p50, ids: [...context.openIds], moved, first: firstCommitmentOf(commit), laterCause }, entry: entry(false, cause) };
}

const isKeptForGood = (entry) => entry.first === true || entry.scored !== undefined;

/**
 * The log as stored: its newest MAX_LOG_ENTRIES entries and every older first commitment and scored entry, in order.
 * @param {object[]} log the table's log entries, oldest first
 * @returns {object[]} a new list
 */
export function cappedLog(log) {
  const firstNewest = log.length - MAX_LOG_ENTRIES;
  return log.filter((entry, index) => index >= firstNewest || isKeptForGood(entry));
}

/** The earliest hand-over (ms) at or after atMs by which every listed id still in the table is done; null when none yet. */
function scoringHandOver(entry, items) {
  const atMs = Date.parse(entry.at);
  const doneOf = new Map(items.map((item) => [item.id, item.done]));
  const inTable = entry.ids.filter((id) => doneOf.has(id));
  const handOvers = items.filter((item) => item.kind === 'deliver' && item.done !== null && item.done >= atMs).map((item) => item.done).sort((a, b) => a - b);
  return handOvers.find((handOver) => inTable.every((id) => doneOf.get(id) !== null && doneOf.get(id) <= handOver)) ?? null;
}

/**
 * Scores every unscored commitment entry whose hand-over has come: actualMin = working minutes from the entry to the hand-over,
 * met = actualMin <= p85 (the 85% clock), ratio = actualMin / raw85, ratio50 = actualMin / p50 (the shown clock, for the band).
 * Refusal entries and scored entries are kept as they are.
 * @param {object[]} log the table's log entries
 * @param {object[]} items parser items (deliver rows give the hand-overs)
 * @param {[number, number][]} intervals working intervals
 * @returns {object[]} a new log; a scored entry gains `scored: { at, actualMin, met, ratio, ratio50 }`
 */
export function scoreLog(log, items, intervals) {
  return log.map((entry) => {
    if (!isCommitmentEntry(entry) || entry.scored !== undefined) return entry;
    const handOver = scoringHandOver(entry, items);
    if (handOver === null) return entry;
    const actualMin = workedMinutes(intervals, minuteOfIso(entry.at), handOver / MS_PER_MIN);
    const ratio50 = entry.p50 > 0 ? actualMin / entry.p50 : null;
    return { ...entry, scored: { at: new Date(handOver).toISOString(), actualMin, met: actualMin <= entry.p85, ratio: actualMin / entry.raw85, ratio50 } };
  });
}

/**
 * The widening factor kappa for p85 and p95: 1 until WIDEN_MIN_JOBS first commitments are scored, then the nearest-rank p85 of
 * their ratio over the last WIDEN_WINDOW_JOBS, never below 1. The plain percentile, not the conformal (n + 1) rank: at n = 10 that
 * rank is the maximum, so one re-scoped job would widen the next ten.
 * @returns {number} >= 1
 */
export function widening(log) {
  const scored = scoredFirsts(log);
  if (scored.length < WIDEN_MIN_JOBS) return 1;
  const ratios = scored.slice(-WIDEN_WINDOW_JOBS).map((entry) => entry.scored.ratio).sort((a, b) => a - b);
  return Math.max(1, nearestRank(ratios, WIDEN_SHARE));
}

/**
 * The band of past jobs for the shown time: the 10th and 90th percentile of actual / shown median over the scored first
 * commitments of this model, from BAND_MIN_JOBS of them; below that only the count ("range not yet measured").
 * @returns {{ count: number, needed: number, low: number | null, high: number | null }} low and high are ratios to the median work left
 */
export function band(log) {
  const ratios = scoredFirsts(log).map((entry) => entry.scored.ratio50).filter((ratio) => Number.isFinite(ratio)).sort((a, b) => a - b);
  if (ratios.length < BAND_MIN_JOBS) return { count: ratios.length, needed: BAND_MIN_JOBS, low: null, high: null };
  return { count: ratios.length, needed: BAND_MIN_JOBS, low: nearestRank(ratios, BAND_LOW_SHARE), high: nearestRank(ratios, BAND_HIGH_SHARE) };
}

/** @returns {{ met: number, of: number } | null} met (within the 85% clock) first commitments among the last TRACK_RECORD_JOBS scored; null when none is scored */
export function trackRecord(log) {
  const recent = scoredFirsts(log).slice(-TRACK_RECORD_JOBS);
  if (recent.length === 0) return null;
  return { met: recent.filter((entry) => entry.scored.met).length, of: recent.length };
}

/** The model of the promise record this code reads and writes; a record of any other model or shape is no promise (spec F3). */
export const PROMISE_MODEL = 's1';
/** A reason smaller than this share of the difference is not told (spec section 7). */
const REASON_MIN_SHARE = 0.1;
/** No promise time is older than this: the tool did not exist before it, so an earlier one is a torn or zeroed record. */
const EARLIEST_PROMISE_MS = Date.parse('2020-01-01T00:00Z');
/** The latest instant a Date can hold (ECMAScript time value range); past it toISOString throws. */
const MAX_DATE_MS = 8.64e15;
/** A promised clock at most this far past now (366 days in ms); a later one is a torn record, not a job. */
const MAX_PROMISE_AHEAD_MS = 366 * 24 * 60 * MS_PER_MIN;
/** The cap on promised work and on one row's likely minutes: a job that cannot end within MAX_PROMISE_AHEAD_MS has no promise. */
const MAX_PROMISE_WORK_MIN = MAX_PROMISE_AHEAD_MS / MS_PER_MIN;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
/** Working minutes a promise can hold: 0 up to MAX_PROMISE_WORK_MIN. */
const isWorkMinutes = (value) => isFiniteNumber(value) && value >= 0 && value <= MAX_PROMISE_WORK_MIN;
/** A row id as the table matches it: ignoring case (items.mjs refuses ids repeated ignoring case; its rule is not exported). */
const idKey = (id) => id.toLowerCase();
/** A real Date ms of the tool's era, so every clock of a promise prints. */
const isInstantMs = (value) => isFiniteNumber(value) && value >= EARLIEST_PROMISE_MS && value <= MAX_DATE_MS;
/** A promised clock for a promise made at atMs and read at nowMs: a real instant, not before atMs, at most MAX_PROMISE_AHEAD_MS past now. */
const isPromisedClock = (p80Ms, atMs, nowMs) => isInstantMs(p80Ms) && p80Ms >= atMs && p80Ms <= nowMs + MAX_PROMISE_AHEAD_MS;

/** True for a list of { id, likelyMin } with non-empty ids unique ignoring case and likely minutes within MAX_PROMISE_WORK_MIN. */
function isRowList(rows) {
  if (!Array.isArray(rows)) return false;
  const keys = new Set();
  for (const row of rows) {
    if (!isPlainObject(row) || typeof row.id !== 'string' || row.id === '' || keys.has(idKey(row.id)) || !isWorkMinutes(row.likelyMin)) return false;
    keys.add(idKey(row.id));
  }
  return true;
}

const copyRows = (rows) => rows.map(({ id, likelyMin }) => ({ id, likelyMin }));

/** The stored record as a promise of this job made by nowMs, or null when it is anything else: missing, torn, c3, another job's,
 *  from the future, a time outside the tool's era or minutes over MAX_PROMISE_WORK_MIN. */
function storedPromiseOf(stored, job, nowMs) {
  if (!isPlainObject(stored) || stored.model !== PROMISE_MODEL || stored.job !== job) return null;
  const { atMs, p80Ms, workMin, rows } = stored;
  if (!isInstantMs(atMs) || atMs > nowMs || !isPromisedClock(p80Ms, atMs, nowMs) || !isWorkMinutes(workMin) || !isRowList(rows)) return null;
  return { model: PROMISE_MODEL, job, atMs, p80Ms, workMin, rows: copyRows(rows) };
}

/** Only a recorded CLI run at the real clock may make the promise (spec F1): never a status-line refresh, a `--now` run or a run that could not take the table lock. */
const mayPromise = (run) => isPlainObject(run) && run.cli === true && run.realClock === true && run.recorded === true;

/** Throws a TypeError when this run's own numbers are malformed (from the forecast, so a bug, not data); the same bounds as a
 *  stored promise, so a promise made here reads back as kept and is never made again. */
function assertFresh(fresh, nowMs) {
  if (!isInstantMs(nowMs)) throw new TypeError('promiseOf: nowMs must be an epoch ms from 2020 on');
  if (!isPlainObject(fresh) || typeof fresh.job !== 'string' || fresh.job === '') throw new TypeError('promiseOf: fresh.job must be a non-empty string');
  if (!isPromisedClock(fresh.p80Ms, nowMs, nowMs)) throw new TypeError('promiseOf: fresh.p80Ms must be an epoch ms from now to 366 days on');
  if (!isWorkMinutes(fresh.workLeftMin)) throw new TypeError('promiseOf: fresh.workLeftMin must be minutes from 0 to MAX_PROMISE_WORK_MIN');
  if (!isRowList(fresh.rows)) throw new TypeError('promiseOf: fresh.rows must be unique { id, likelyMin } rows');
}

/**
 * The job's one promise (spec R9, owner R22-E2): the stored one while it is a whole s1 promise of this job, else a new one when
 * this run may make it, else none. Pure and idempotent, so two runs under the caller's table lock keep the first run's promise.
 * @param {unknown} stored the stored promise record, read from the store as data (anything that is not one reads as none)
 * @param {{ job: string, p80Ms: number, workLeftMin: number, rows: { id: string, likelyMin: number }[],
 *   run: { cli: boolean, realClock: boolean, recorded: boolean } }} fresh this run: the caller's key of the current job, its 80%
 *   clock and 80% working minutes left, every row of the job with its likely working minutes (a done row its own), and how it ran
 * @param {number} nowMs this run's clock, epoch ms
 * @returns {{ model: 's1', job: string, atMs: number, p80Ms: number, workMin: number, rows: { id: string, likelyMin: number }[] } | null}
 *   the promise to store and show (a new object), null when there is none
 * @throws {TypeError} when nowMs or fresh is malformed
 */
export function promiseOf(stored, fresh, nowMs) {
  assertFresh(fresh, nowMs);
  const kept = storedPromiseOf(stored, fresh.job, nowMs);
  if (kept !== null || !mayPromise(fresh.run)) return kept;
  return { model: PROMISE_MODEL, job: fresh.job, atMs: nowMs, p80Ms: fresh.p80Ms, workMin: fresh.workLeftMin, rows: copyRows(fresh.rows) };
}

/** Each row's share of the difference, ids matched ignoring case: an added row its likely minutes, a dropped one minus its promised, a kept one its change. */
function rowParts(rowsNow, rowsAtPromise) {
  const promisedMin = new Map(rowsAtPromise.map((row) => [idKey(row.id), row.likelyMin]));
  const nowKeys = new Set(rowsNow.map((row) => idKey(row.id)));
  const kept = rowsNow.map(({ id, likelyMin }) => {
    if (!promisedMin.has(idKey(id))) return { kind: 'rows-added', id, min: likelyMin };
    const changeMin = likelyMin - promisedMin.get(idKey(id));
    return { kind: changeMin > 0 ? 'over-usual' : 'faster', id, min: changeMin };
  });
  const dropped = rowsAtPromise.filter((row) => !nowKeys.has(idKey(row.id))).map((row) => ({ kind: 'faster', id: row.id, min: -row.likelyMin }));
  return [...kept, ...dropped];
}

const largestFirst = (a, b) => Math.abs(b.min) - Math.abs(a.min) || (a.id ?? a.kind).localeCompare(b.id ?? b.kind);

/** The parts on the difference's side summed per kind, none under REASON_MIN_SHARE of it; at most two (spec section 7): a later side has two kinds, an earlier one. */
function toldReasons(diffMin, parts) {
  const side = Math.sign(diffMin);
  const byKind = new Map();
  for (const part of parts.filter((each) => side !== 0 && Math.sign(each.min) === side).sort(largestFirst)) {
    const reason = byKind.get(part.kind) ?? { kind: part.kind, min: 0, ids: [] };
    reason.min += part.min; // the reasons are this call's own objects: added to in place, so 5,000 rows stay linear
    reason.ids.push(part.id);
    byKind.set(part.kind, reason);
  }
  const floorMin = REASON_MIN_SHARE * Math.abs(diffMin);
  return [...byKind.values()].filter((reason) => Math.abs(reason.min) >= floorMin).sort(largestFirst);
}

/**
 * How much later (+) or earlier (-) than promised the job now runs, and why (spec R9, section 7): (worked since the promise + the
 * fresh 80% work left) - the promised work, in working minutes, so a pause never counts as late (spec F2; it moves the clocks,
 * R11). Reasons are on the difference's side only: rows added (their likely minutes), rows over usual (minutes past what was
 * promised for them), rows faster or dropped (negative); unrounded, the numbers round once (R10).
 * @param {{ workMin: number }} promise the job's promise (promiseOf)
 * @param {{ workLeftMin: number }} fresh this run's 80% working minutes left
 * @param {number} workedSinceMin working minutes since the promise (pauses excluded)
 * @param {{ id: string, likelyMin: number }[]} rowsNow every row of the job now, done ones with their own minutes
 * @param {{ id: string, likelyMin: number }[]} rowsAtPromise the promise's rows
 * @returns {{ min: number, reasons: { kind: 'rows-added'|'over-usual'|'faster', min: number, ids: string[] }[] }} ids largest first
 * @throws {TypeError} when an argument is malformed
 */
export function promiseDiff(promise, fresh, workedSinceMin, rowsNow, rowsAtPromise) {
  if (!isPlainObject(promise) || !isWorkMinutes(promise.workMin)) throw new TypeError('promiseDiff: promise.workMin must be minutes from 0 to MAX_PROMISE_WORK_MIN');
  if (!isPlainObject(fresh) || !isWorkMinutes(fresh.workLeftMin)) throw new TypeError('promiseDiff: fresh.workLeftMin must be minutes from 0 to MAX_PROMISE_WORK_MIN');
  if (!isWorkMinutes(workedSinceMin)) throw new TypeError('promiseDiff: workedSinceMin must be minutes from 0 to MAX_PROMISE_WORK_MIN');
  if (!isRowList(rowsNow) || !isRowList(rowsAtPromise)) throw new TypeError('promiseDiff: rows must be unique { id, likelyMin } rows');
  const min = workedSinceMin + fresh.workLeftMin - promise.workMin;
  return { min, reasons: toldReasons(min, rowParts(rowsNow, rowsAtPromise)) };
}
