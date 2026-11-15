// The text of the status line's estimate segment, decided by the refresh script (never by the render, which only reads the cache).
// Exports: resultSegment(result, timeZone?) -> segment; refusalSegment(refusal) -> segment; errorSegment(error) -> segment;
// MAX_SEGMENT_CHARS. A segment is {kind, text, highMs}: kind is one of SEGMENT_KINDS (segment-cache.mjs), text is what the status
// line shows, highMs (epoch ms or null) is the instant after which a range or not-before text no longer holds (the render then shows OVERDUE_TEXT, segment-cache.mjs).
// Forms: `done ~14:50-16:15` (range), `done >=17:10` (not before), `delivered 17:54` (`delivered 17:54?` when the delivery is
// provisional or guessed from a pause; `delivered Sun 17:54` when not today), `done ? <cause>` when the tool refuses or fails.
// Invariants: pure; every text is at most MAX_SEGMENT_CHARS characters; a cause is a word from a fixed list or a row id that matches
// ID_SHAPE, never free text from STATUS.md or from an exception message.
import { finishClock, printedBounds } from './report.mjs';
import { clockText, dayText, localDate, systemTimeZone } from './local-clock.mjs';

export const MAX_SEGMENT_CHARS = 28;
const UNKNOWN = 'done ? ';
const ROW_PREFIX = `${UNKNOWN}row `;
// Row ids are short names (F1, W8b, A17); 'done ? row ' + 17 characters is exactly MAX_SEGMENT_CHARS.
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,16}$/;
// Fixed causes of a refusal, each one or two words: what the refusal text says in full.
const CAUSE = { overrun: 'overrun', roundDone: 'no deliver row', noRows: 'no rows', fewRows: 'few rows', noStart: 'no start time', future: 'time ahead', noTime: 'no work time', table: 'table', tool: 'tool error' };

const segment = (kind, text, highMs = null) => ({ kind, text, highMs });

/** The first cause of a `reason: 'table'` refusal, in the order the refusal text lists them. */
function tableCause(refusal) {
  if (refusal.measured < refusal.needed) return refusal.measured === 0 ? CAUSE.noRows : CAUSE.fewRows;
  if (refusal.missing.length > 0) return CAUSE.noStart;
  if (refusal.future.length > 0) return CAUSE.future;
  return refusal.noTime.length > 0 ? CAUSE.noTime : CAUSE.table;
}

/** `done ? <cause>` for a refusal of computeEstimate (exit 3). */
export function refusalSegment(refusal) {
  const cause = { overrun: CAUSE.overrun, 'round-done': CAUSE.roundDone }[refusal.reason] ?? tableCause(refusal);
  return segment('refused', `${UNKNOWN}${cause}`);
}

/** `done ? row A17` for a table error that names a row with an id of the right shape, `done ? table` for any other table error, `done ? tool error` otherwise. */
export function errorSegment(error) {
  const problems = Array.isArray(error?.problems) ? error.problems : [];
  if (problems.length === 0) return segment('error', `${UNKNOWN}${CAUSE.tool}`);
  const id = problems.map((p) => p.id).find((name) => typeof name === 'string' && ID_SHAPE.test(name));
  return segment('error', id === undefined ? `${UNKNOWN}${CAUSE.table}` : `${ROW_PREFIX}${id}`);
}

/** The delivery's clock, with the weekday when it is not the day the estimate was computed. */
function deliveredClock(result, timeZone) {
  const today = localDate(result.delivered, timeZone) === localDate(result.computedAt, timeZone);
  return `${today ? '' : `${dayText(result.delivered, timeZone).split(' ')[0]} `}${clockText(result.delivered, timeZone)}`;
}

/**
 * The segment of a computed result (not a refusal), its finish already scaled by the calibration factors.
 * @param {object} result from computeEstimate (through applyFactors unless delivered).
 * @param {string} [timeZone] IANA zone; default the system zone.
 */
export function resultSegment(result, timeZone = systemTimeZone()) {
  if (result.state === 'delivered') {
    const unsure = result.guessed || result.provisionalUntil !== null;
    return segment('delivered', `delivered ${deliveredClock(result, timeZone)}${unsure ? '?' : ''}`);
  }
  const { low, high } = printedBounds(result, timeZone);
  // a not-before has no high end to expire on: its low end is the last instant the text says anything
  if (high === null) return segment('not-before', `done ${finishClock(result, timeZone)}`, low);
  return segment('range', `done ~${finishClock(result, timeZone)}`, high);
}
