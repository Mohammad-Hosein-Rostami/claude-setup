// Renders an estimate result as the text block the lead pastes as-is (estimator design 4.1) and a refusal as its reason and
// what to do (4.2). The exact lines are in ../README.md.
// Exports: formatEstimate(result, inputs) -> string (a finish block ends with the Progress line, before the Check lines; a refusal text too); formatRefusal(result) -> string; workText(minutes) -> '35 min' |
// '2 h 35'; hoursText(minutes) -> '99 h' from 10 hours up, else workText; plural, listed (shared with segment-text.mjs).
// Invariants: pure apart from reading the system time zone (`Intl`, so `TZ` is honoured) when none is given. Clock times are on
// the local clock, rounded up to CLOCK_STEP_MS; a refusal text never contains `Finish:` or a clock time. Rows are named by id,
// never by their text.
import { clockText, dayText, gridded, localDate, offsetText, systemTimeZone } from './local-clock.mjs';

const LISTED_ROWS = 5;
const MAX_CHECK_LINES = 3; // more stale rows than this are counted on one line (design 3.10)
const MIN_PER_HOUR = 60;
const WHOLE_HOURS_FROM_MIN = 10 * MIN_PER_HOUR; // from 10 hours of work up, minutes say nothing: `99 h`
const PAUSE_SHOWN_MIN = 5; // pauses since the commitment are named from 5 minutes up (design 4.1)
const PERCENT = 100;
const SIZES = ['S', 'M', 'L'];
const SMALLER_SIZE = { L: 'M', M: 'S' };
// Why a refusal shows no time, as the Progress line says it (the status line's shorter words are in segment-text.mjs).
const NO_TIME_CAUSE = { 'no-reference': 'too few finished rows', growth: 'too much unlisted work', horizon: 'job longer than any finished one' };
const EXCLUDES = 'Excludes: pauses (nights, usage limits, waiting for you) move the time hour for hour; rework after hand-over; new requests.';

export const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The first few names of a list, then how many more, so a line stays readable on a table of hundreds of rows. */
export const listed = (names) => (names.length <= LISTED_ROWS ? names.join(', ') : `${names.slice(0, LISTED_ROWS).join(', ')} and ${names.length - LISTED_ROWS} more`);

/** Work as `35 min` under an hour, else `2 h 35`. */
export function workText(minutes) {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < MIN_PER_HOUR) return `${whole} min`;
  return `${Math.floor(whole / MIN_PER_HOUR)} h ${String(whole % MIN_PER_HOUR).padStart(2, '0')}`;
}

/** Work as whole hours (`99 h`) from 10 hours up, else as workText. */
export const hoursText = (minutes) => (minutes >= WHOLE_HOURS_FROM_MIN ? `${Math.round(minutes / MIN_PER_HOUR)} h` : workText(minutes));

const percent = (share) => `${Math.round(share * PERCENT)}%`;
const day = (ms, timeZone) => `${dayText(ms, timeZone)} ${clockText(ms, timeZone)}`;
/** A clock, with its weekday when it falls on another local day than `sameDayAs`. */
const clockOn = (ms, sameDayAs, timeZone) => `${localDate(ms, timeZone) === localDate(sameDayAs, timeZone) ? '' : `${dayText(ms, timeZone).split(' ')[0]} `}${clockText(ms, timeZone)}`;

function finishLine(result, timeZone) {
  const up = (ms) => gridded(ms, timeZone, true);
  const clock = up(result.finish.clockMs);
  const where = `local ${offsetText(result.nowMs, timeZone)}, now ${clockText(result.nowMs, timeZone)}`;
  const likely = clockOn(up(result.finish.likelyMs), clock, timeZone);
  if (result.finish.ahead) return `Finish: ${day(clock, timeZone)} (likely ${likely}, ahead of the time given; ${where})`;
  return `Finish: ${day(clock, timeZone)} (85% sure; likely ${likely}, 95% by ${clockOn(up(result.finish.lateMs), clock, timeZone)}; ${where})`;
}

function coversLine({ covers, commit }) {
  const sizes = SIZES.filter((size) => covers.sizes[size] > 0).map((size) => `${covers.sizes[size]} ${size}`).join(', ');
  const rows = `${plural(covers.open, 'open row')} (${covers.running} running; ${sizes})`;
  return `Covers: ${rows} and work not listed yet (usually ${percent(covers.growth)} of what is left); ${workText(commit.leftMin)} of work left in this time.`;
}

function causeText(moved) {
  if (moved.cause === 'rows-added') return `because ${plural(moved.ids.length, 'row')} ${moved.ids.length === 1 ? 'was' : 'were'} added (${listed(moved.ids)})`;
  if (moved.cause === 'slow-row') return `because row ${moved.ids[0]} is taking longer than 85% of ${moved.size ?? 'its size\'s'} rows`;
  return 'because the open rows are taking longer than usual';
}

/** Held or Moved, built from the stored commitment so it reads the same in every run, plus the pauses since it was made. */
function commitLine({ commit, nowMs }, timeZone) {
  const pauses = commit.pausedMin >= PAUSE_SHOWN_MIN ? ` Pauses since then: ${workText(commit.pausedMin)}.` : '';
  if (commit.moved === null) return `Held: given ${day(commit.atMs, timeZone)}, unchanged since.${pauses}`;
  const { moved } = commit;
  const from = clockOn(gridded(moved.wasClockMs, timeZone, true), nowMs, timeZone);
  return `Moved: at ${clockOn(moved.atMs, nowMs, timeZone)} from ${from}, ${causeText(moved)}; unchanged since.${pauses}`;
}

function recordLine(result) {
  const { record, pool } = result;
  if (record === null) return `Track record: no job scored yet; learned from ${plural(pool.rows, 'finished row')} and ${plural(pool.jobs, 'job')}.`;
  return `Track record: ${record.met} of the last ${plural(record.of, 'job')} ${record.of === 1 ? 'was' : 'were'} done by the first time given.`;
}

/**
 * The Progress line (null when the result has no progress): the percent from the median, and why the clock may differ (it uses the 85% budget);
 * a refusal has no median, so its percent is approximate and says why there is no time.
 */
function progressLine(progress, refusal) {
  if (!progress) return [];
  const rows = `${progress.rowsDone} of ${plural(progress.rowsTotal, 'row')}`;
  if (progress.approx) return [`Progress: ~${progress.pct}% (${rows}; time n/a: ${NO_TIME_CAUSE[refusal?.reason] ?? 'no forecast'})`];
  return [`Progress: ${progress.pct}% (${rows}; median left ${workText(progress.leftMin)}; clock at 85%)`];
}

/** The Check lines: at most MAX_CHECK_LINES stale rows, longest first, then the count of the rest, then untracked work. */
function checkLines(checks) {
  const stale = checks.filter((check) => check.kind === 'stale');
  const lines = stale.slice(0, MAX_CHECK_LINES).map((check) => `Check: row ${check.id} (${check.size}) has taken ${workText(check.elapsedMin)} of work, longer than every finished ${check.size} row (${workText(check.longestMin)}): finish it, or close it with evidence "dropped: <why>".`);
  if (stale.length > MAX_CHECK_LINES) lines.push(`Check: and ${stale.length - MAX_CHECK_LINES} more.`);
  for (const check of checks.filter((item) => item.kind === 'untracked')) {
    lines.push(`Check: ${workText(check.minutes)} of work in this job ran with no started row: start rows with status.mjs start <id>.`);
  }
  return lines;
}

/**
 * The block to paste: the finish (design 4.1), or the one-line all-done block, or the hand-over and the track record.
 * @param {object} result estimateFile's result in the state finish, all-done or handed-over
 * @param {{ timeZone?: string }} [inputs] the zone for every clock time (default the system zone)
 * @returns {string} the block, no trailing newline
 */
export function formatEstimate(result, inputs = {}) {
  const timeZone = inputs.timeZone ?? systemTimeZone();
  switch (result.state) {
    case 'all-done': return `Finish: now (all ${plural(result.rows, 'row')} ${result.rows === 1 ? 'is' : 'are'} done; the hand-over is recorded when this turn ends)`;
    case 'handed-over': return [`Finish: handed over ${day(result.handedOverMs, timeZone)} (${plural(result.rows, 'row')}, ${workText(result.workedMin)} of work)`, recordLine(result)].join('\n');
    case 'finish': return [finishLine(result, timeZone), coversLine(result), EXCLUDES, commitLine(result, timeZone), recordLine(result), ...progressLine(result.progress), ...checkLines(result.checks)].join('\n');
    default: throw new Error(`no finish block for state ${result.state}`);
  }
}

function noReferenceAdvice(size) {
  const smaller = SMALLER_SIZE[size];
  return smaller === undefined ? 'finish rows of that size first.' : `finish rows of that size first, or split the ${size} rows into ${smaller} rows.`;
}

/** The No finish time and What to do lines of a refusal (design 4.2), plus the Work left line of a long job. */
function refusalLines(refusal) {
  switch (refusal.reason) {
    case 'no-rows': return ['No finish time: the table has no work row.', 'What to do: list the job\'s rows with `status.mjs add`.'];
    case 'no-reference': return [`No finish time: only ${refusal.rows} finished ${refusal.size} rows to learn from (${refusal.needed} needed).`, `What to do: ${noReferenceAdvice(refusal.size)}`];
    case 'growth': return [`No finish time: in the recent jobs ${percent(refusal.growth)} of the work was not in the table when it was estimated.`, 'What to do: list the job\'s rows first (`status.mjs add`), then `status.mjs start` each as its work begins.'];
    case 'horizon': return [
      `No finish time: this job is longer than any finished one (longest: ${workText(refusal.longestJobMin)} of work).`,
      `Work left: likely ${hoursText(refusal.work.p50)}, 85% sure within ${hoursText(refusal.work.p85)}, of work (not clock time).`,
      'What to do: quote the work left as hours of work; hand over in parts (`status.mjs deliver "<part>"`) so jobs of this length get scored.',
    ];
    default: throw new Error(`no refusal text for reason ${refusal.reason}`);
  }
}

/**
 * The refusal text: why there is no finish time and what to do, never a clock time; Check lines follow.
 * @param {object} result estimateFile's result in the state refused
 * @returns {string} the lines, no trailing newline
 */
export const formatRefusal = (result) => [...refusalLines(result.refusal), ...progressLine(result.progress, result.refusal), ...checkLines(result.checks ?? [])].join('\n');
