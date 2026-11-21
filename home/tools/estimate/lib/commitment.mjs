// The one committed time of a job and its record: whether a run keeps it or moves it (earlier or later, with one stored cause) or
// makes the first one; scoring each logged commitment at the hand-over; the widening factor, the past-jobs band and the track record
// learned from those scores.
// Exports: MODEL_ID, nextCommitment(commit, fresh, leftMin, context), scoreLog(log, items, intervals), widening(log), band(log),
// trackRecord(log).
// Rules (backtest section 7, model c2b): a commitment is a work budget, { at, budgetMin, ids, moved }, of the forecast MEDIAN (the
// 85% time is the second clock). It is held while the fresh median is within MOVE_TOLERANCE_MIN of the budget left, else it moves to
// the fresh median, earlier or later: the old never-earlier hold only ever moved later and was 245 min off per job.
// Every log entry carries the model id; widening, band and track record count only entries of the current model, so their counts
// restart at a model change (R69).
// Invariants: pure (no I/O, no clock); returns new objects and never changes its arguments. Times are ISO strings in the stored
// objects and epoch minutes in `context.nowMin`; work is in minutes.
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
export const MODEL_ID = 'c2b';
/** A fresh median this close to the budget left keeps the commitment: the shown clock is rounded to 5 minutes, so a smaller move
 *  would not change it (report.mjs CLOCK_STEP). */
const MOVE_TOLERANCE_MIN = 5;
/** Scored first commitments of this model before the past-jobs band is shown (R69, research2/estimate.md P3). */
const BAND_MIN_JOBS = 20;
const BAND_LOW_SHARE = 0.1;
const BAND_HIGH_SHARE = 0.9;

const isoOfMinute = (minute) => new Date(minute * MS_PER_MIN).toISOString();
const minuteOfIso = (iso) => Date.parse(iso) / MS_PER_MIN;
const isCommitmentEntry = (entry) => typeof entry.first === 'boolean';
const scoredFirsts = (log) => log.filter((entry) => entry.first === true && entry.scored !== undefined && entry.model === MODEL_ID);

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
 *   (null on a hold); a move keeps { at, wasClock, cause, ids } so a later run prints the same cause (cause 'ahead' for an earlier move)
 */
export function nextCommitment(commit, fresh, leftMin, context) {
  const at = isoOfMinute(context.nowMin);
  const { p50, raw85, p85, p95, g, kappa } = fresh;
  const entry = (first, cause) => ({ at, ids: [...context.openIds], p50, raw85, p85, p95, g, kappa, first, cause, model: MODEL_ID });
  if (commit === null) return { commit: { at, budgetMin: p50, ids: [...context.openIds], moved: null }, entry: entry(true, null) };
  if (Math.abs(leftMin - p50) <= MOVE_TOLERANCE_MIN) return { commit, entry: null };
  const { cause, ids } = moveCause(commit, context, p50 < leftMin);
  const moved = { at, wasClock: isoOfMinute(context.nowMin + leftMin), cause, ids };
  return { commit: { at, budgetMin: p50, ids: [...context.openIds], moved }, entry: entry(false, cause) };
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
