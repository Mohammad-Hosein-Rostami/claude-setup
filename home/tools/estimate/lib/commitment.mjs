// The one committed time of a job and its record: whether a run keeps it, moves it later (with one stored cause) or makes the first
// one; scoring each logged commitment at the hand-over; the widening factor and the track record learned from those scores.
// Exports: nextCommitment(commit, fresh, leftMin, context), scoreLog(log, items, intervals), widening(log),
// trackRecord(log).
// Rules (estimator design 3.8-3.9): a commitment is a work budget, { at, budgetMin, ids, moved }; it is held while the budget left
// covers the fresh median and otherwise moves to the fresh p85 from now, which is always later. It never moves earlier: that gave
// 45 commitments against 14 on the measured jobs. A refusal leaves the commitment alone (the caller does not call this then).
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

const isoOfMinute = (minute) => new Date(minute * MS_PER_MIN).toISOString();
const minuteOfIso = (iso) => Date.parse(iso) / MS_PER_MIN;
const isCommitmentEntry = (entry) => typeof entry.first === 'boolean';
const scoredFirsts = (log) => log.filter((entry) => entry.first === true && entry.scored !== undefined);

/** Why a commitment had to move, by precedence: rows added since it was made; a running row slower than its class p85; pace. */
function moveCause(commit, { openIds, slowRowId }) {
  const added = openIds.filter((id) => !commit.ids.includes(id));
  if (added.length > 0) return { cause: 'rows-added', ids: added };
  if (slowRowId) return { cause: 'slow-row', ids: [slowRowId] };
  return { cause: 'pace', ids: [] };
}

/**
 * Decides this run's commitment: first, hold or move (see the header).
 * @param {{ at: string, budgetMin: number, ids: string[], moved: object | null } | null} commit the stored commitment of the
 *   current job (null when there is none; the caller passes null after a hand-over)
 * @param {{ p50: number, raw85: number, p85: number, p95: number, g: number, kappa: number }} fresh this run's forecast, p85 and
 *   p95 widened by kappa, raw85 before widening
 * @param {number | null} leftMin budgetMin minus the minutes worked since the commitment (ignored when commit is null)
 * @param {{ nowMin: number, openIds: string[], slowRowId: string | null }} context slowRowId: a running row whose elapsed share is
 *   above its class p85
 * @returns {{ commit: object, entry: object | null }} the commitment to store (the same object on a hold) and the log entry to add
 *   (null on a hold); a move keeps { at, wasClock, cause, ids } so a later run prints the same cause
 */
export function nextCommitment(commit, fresh, leftMin, context) {
  const at = isoOfMinute(context.nowMin);
  const { p50, raw85, p85, p95, g, kappa } = fresh;
  const entry = (first, cause) => ({ at, ids: [...context.openIds], p50, raw85, p85, p95, g, kappa, first, cause });
  if (commit === null) return { commit: { at, budgetMin: p85, ids: [...context.openIds], moved: null }, entry: entry(true, null) };
  if (leftMin >= p50) return { commit, entry: null };
  const { cause, ids } = moveCause(commit, context);
  const moved = { at, wasClock: isoOfMinute(context.nowMin + leftMin), cause, ids };
  return { commit: { at, budgetMin: p85, ids: [...context.openIds], moved }, entry: entry(false, cause) };
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
 * met = actualMin <= p85, ratio = actualMin / raw85. Refusal entries and scored entries are kept as they are.
 * @param {object[]} log the table's log entries
 * @param {object[]} items parser items (deliver rows give the hand-overs)
 * @param {[number, number][]} intervals working intervals
 * @returns {object[]} a new log; a scored entry gains `scored: { at, actualMin, met, ratio }`
 */
export function scoreLog(log, items, intervals) {
  return log.map((entry) => {
    if (!isCommitmentEntry(entry) || entry.scored !== undefined) return entry;
    const handOver = scoringHandOver(entry, items);
    if (handOver === null) return entry;
    const actualMin = workedMinutes(intervals, minuteOfIso(entry.at), handOver / MS_PER_MIN);
    return { ...entry, scored: { at: new Date(handOver).toISOString(), actualMin, met: actualMin <= entry.p85, ratio: actualMin / entry.raw85 } };
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

/** @returns {{ met: number, of: number } | null} met first commitments among the last TRACK_RECORD_JOBS scored; null when none is scored */
export function trackRecord(log) {
  const recent = scoredFirsts(log).slice(-TRACK_RECORD_JOBS);
  if (recent.length === 0) return null;
  return { met: recent.filter((entry) => entry.scored.met).length, of: recent.length };
}
