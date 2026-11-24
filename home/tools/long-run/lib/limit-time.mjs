// Purpose: when a usage limit resets, from the text `claude` prints (`You've hit your session limit · resets 3:45pm`, weekly
//   `... · resets Mon 12:00am`), else from the newest limit sample the status line stored for the account.
// Exports: LIMIT_TEXT, RESUME_MARGIN_MS, FALLBACK_WAIT_MS, parseResetTime, resetFromSamples, limitWaitUntil.
// Invariants: the printed time is a local wall-clock time with no date and no zone, so it means its next local occurrence after
//   `now`; days are added as calendar days (DST-safe), never as 24 h; a time that the local clock skips (a DST spring-forward hour)
//   is read as JavaScript's Date reads it (moved forward by the skipped hour). The result is RESUME_MARGIN_MS after the reset.
import { latestSample, readLimits } from '../../../hooks/lib/limits-store.mjs';

/** Text that marks a usage-limit stop in a result, an error list or stderr (spec U1: the shape is not confirmed; this is broad). */
export const LIMIT_TEXT = /hit your (?:session |weekly |usage |opus |sonnet )?limit|usage limit (?:reached|hit)|limit reached[^.\n]{0,40}resets/i;
/** The runner resumes this long after the printed reset time (spec 5: next local occurrence + 120 s). */
export const RESUME_MARGIN_MS = 120 * 1000;
/** With no readable time and no stored sample: try again after an hour (default taken; the summary shows the time). */
export const FALLBACK_WAIT_MS = 60 * 60 * 1000;

const RESET_AT = /resets?\s+(?:at\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HOURS_HALF_DAY = 12;
const DAYS_IN_WEEK = 7;
const MS_PER_SECOND = 1000;
const FULL_PERCENT = 100;

function hour24(hour, meridiem) {
  if (!meridiem) return hour;
  const base = hour % HOURS_HALF_DAY;
  return meridiem.toLowerCase() === 'pm' ? base + HOURS_HALF_DAY : base;
}

/** The local date `days` calendar days after `from`, at hour:minute. */
const atLocal = (from, days, hour, minute) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, hour, minute, 0, 0);

/**
 * @param {string} text the limit text.
 * @param {Date} now the current time.
 * @returns {Date | null} the next local occurrence after `now` of the printed reset time (no margin), or null with no readable time.
 */
export function parseResetTime(text, now) {
  const match = RESET_AT.exec(String(text ?? ''));
  if (!match) return null;
  const hour = hour24(Number(match[2]), match[4]);
  const minute = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59) return null;
  const weekday = match[1] ? DAY_NAMES.indexOf(match[1].toLowerCase()) : null;
  for (let days = 0; days <= DAYS_IN_WEEK; days += 1) {
    const candidate = atLocal(now, days, hour, minute);
    if (candidate <= now) continue;
    if (weekday === null || candidate.getDay() === weekday) return candidate;
  }
  return null;
}

/**
 * The reset of the newest stored limit sample: the latest reset of a full window, else the soonest future reset.
 * @param {{five_hour?: object | null, seven_day?: object | null} | null} sample a sample of limits-store.mjs.
 * @param {Date} now the current time.
 * @returns {Date | null}
 */
export function resetFromSamples(sample, now) {
  const windows = [sample?.five_hour, sample?.seven_day].filter((one) => one && Number.isFinite(one.resets_at));
  const future = windows.filter((one) => one.resets_at * MS_PER_SECOND > now.getTime());
  const full = future.filter((one) => one.used_percentage >= FULL_PERCENT).map((one) => one.resets_at);
  const pick = full.length > 0 ? Math.max(...full) : future.length > 0 ? Math.min(...future.map((one) => one.resets_at)) : null;
  return pick === null ? null : new Date(pick * MS_PER_SECOND);
}

/**
 * When to resume after a usage limit.
 * @param {string} text the limit text (result, errors and stderr joined).
 * @param {{now: Date, account: string, limitsDir?: string}} context `limitsDir` overrides the samples folder (tests).
 * @returns {{until: Date, source: 'text' | 'sample' | 'fallback'}}
 */
export function limitWaitUntil(text, { now, account, limitsDir }) {
  const printed = parseResetTime(text, now);
  if (printed) return { until: new Date(printed.getTime() + RESUME_MARGIN_MS), source: 'text' };
  const sample = latestSample(readLimits(account, limitsDir ? { dir: limitsDir } : undefined));
  const stored = resetFromSamples(sample, now);
  if (stored) return { until: new Date(stored.getTime() + RESUME_MARGIN_MS), source: 'sample' };
  return { until: new Date(now.getTime() + FALLBACK_WAIT_MS), source: 'fallback' };
}
