// The text of the status line's estimate segment, decided by the refresh script (never by the render, which only reads the cache).
// Exports: resultSegment(result, timeZone?) -> segment; errorSegment(error) -> segment; MAX_SEGMENT_CHARS. A segment is
// {kind, text, highMs, progress, numbers}: numbers is the result's job numbers (job-rows.mjs jobNumbers: finishMs, leftMin, workedMin,
// row counts, per open row expectMin and startedMs) or null; with them the status line renders every clock in its own time zone
// (audit case 12: the text's clock is in this refresh process's zone, which can differ when TZ differs between the two); kind is one of SEGMENT_KINDS (segment-cache.mjs), text is what the status line shows, highMs (epoch ms
// or null) is the shown clock of a finish, after which the render shows OVERDUE_TEXT (segment-cache.mjs); null for every other kind;
// progress is the result's job progress (progress.mjs), null when the result has none (no rows, a hand-over, an error).
// Forms (estimator design 4.3): `done by 21:40` (`done by Tue 21:40` on another day), `all rows done`, `handed over 17:54`,
// `work left ~99 h` (a job longer than any finished one), `done ? <cause>` when the tool refuses or fails.
// Invariants: pure; every text is at most MAX_SEGMENT_CHARS characters; a cause is a word from a fixed list or a row id that matches
// ID_SHAPE, never free text from STATUS.md or from an exception message. The clock is the CLI's: the same committed time, rounded up.
import { clockText, dayText, gridded, localDate, systemTimeZone } from './local-clock.mjs';
import { hoursText } from './report.mjs';

export const MAX_SEGMENT_CHARS = 28;
const UNKNOWN = 'done ? ';
const ROW_PREFIX = `${UNKNOWN}row `;
// Row ids are short names (F1, W8b, A17); 'done ? row ' + 17 characters is exactly MAX_SEGMENT_CHARS.
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_.-]{0,16}$/;
// Fixed causes of a refusal, each one to three words: what the refusal text says in full.
const CAUSE = { 'no-rows': 'no rows', 'no-reference': 'few rows', growth: 'rows listed late', table: 'table', tool: 'tool error' };

const segment = (kind, text, highMs = null, progress = null, numbers = null) => ({ kind, text, highMs, progress, numbers });

/** `done ? row A17` for a table error that names a row with an id of the right shape, `done ? table` for any other table error, `done ? tool error` otherwise. */
export function errorSegment(error) {
  const problems = Array.isArray(error?.problems) ? error.problems : [];
  if (problems.length === 0) return segment('error', `${UNKNOWN}${CAUSE.tool}`);
  const id = problems.map((p) => p.id).find((name) => typeof name === 'string' && ID_SHAPE.test(name));
  return segment('error', id === undefined ? `${UNKNOWN}${CAUSE.table}` : `${ROW_PREFIX}${id}`);
}

/** A clock with its weekday when it is not on the local day of now. */
const clockOfDay = (ms, nowMs, timeZone) => `${localDate(ms, timeZone) === localDate(nowMs, timeZone) ? '' : `${dayText(ms, timeZone).split(' ')[0]} `}${clockText(ms, timeZone)}`;

/**
 * The segment of an estimate result, in any state.
 * @param {object} result estimateFile's result
 * @param {string} [timeZone] IANA zone; default the system zone
 * @returns {{ kind: string, text: string, highMs: number | null, progress: object | null, numbers: object | null }}
 */
export function resultSegment(result, timeZone = systemTimeZone()) {
  switch (result.state) {
    case 'finish': {
      const clock = gridded(result.finish.clockMs, timeZone, true);
      return segment('finish', `done by ${clockOfDay(clock, result.nowMs, timeZone)}`, clock, result.progress, result.numbers ?? null);
    }
    case 'all-done': return segment('finish', 'all rows done', null, result.progress);
    case 'handed-over': return segment('handed-over', `handed over ${clockOfDay(result.handedOverMs, result.nowMs, timeZone)}`);
    case 'refused': {
      if (result.refusal.reason === 'horizon') return segment('work-left', `work left ~${hoursText(result.refusal.work.p85)}`, null, result.progress, result.numbers ?? null);
      return segment('refused', `${UNKNOWN}${CAUSE[result.refusal.reason] ?? CAUSE.tool}`, null, result.progress, result.numbers ?? null);
    }
    default: return segment('error', `${UNKNOWN}${CAUSE.tool}`);
  }
}
