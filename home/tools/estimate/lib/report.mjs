// Renders an estimate result as the text block the lead pastes as-is (estimator design 4.1) and a refusal as its reason and
// what to do (4.2). The exact lines are in ../README.md.
// Exports: formatEstimate(result, inputs) -> string (a road's block starts `Finish: step N of M`, `Steps:`, `Total:`; a finish block ends with the Progress line, before the Check lines; a refusal text
// too; inputs.limits, the account's newest limits sample (limits-store.mjs), is named beside a long job); formatRefusal(result) -> string; stepLine(result, inputs) -> the road step line or null; workText(minutes) -> '35 min' |
// '2 h 35'; hoursText(minutes) -> '99 h' from 10 hours up, else workText; plural, listed (shared with segment-text.mjs).
// Model s1 results (`model: 's1'`) get its own labels: the likely and the 80% time, the Promise line (never "unchanged": the
// job's clock moves, the promise does not) and the record of promises; c3 results keep the 85% and 95% labels and Held or Moved.
// Invariants: pure apart from reading the system time zone (`Intl`, so `TZ` is honoured) when none is given. Clock times are on
// the local clock, rounded up to CLOCK_STEP_MS; a refusal text never contains `Finish:` or a clock time. Rows are named by id,
// never by their text.
import { clockText, dayText, gridded, localDate, offsetText, systemTimeZone } from './local-clock.mjs';
import { LATE_MIN } from './job-rows.mjs';
import { roadStepOf } from './road-steps.mjs';

const LISTED_ROWS = 5;
const MAX_CHECK_LINES = 3; // more stale rows than this are counted on one line (design 3.10)
const MIN_PER_HOUR = 60;
const MS_PER_MIN = 60_000;
const WHOLE_HOURS_FROM_MIN = 10 * MIN_PER_HOUR; // from 10 hours of work up, minutes say nothing: `99 h`
const PAUSE_SHOWN_MIN = 5; // pauses since the commitment are named from 5 minutes up (design 4.1)
const PERCENT = 100;
const SIZES = ['S', 'M', 'L'];
const SMALLER_SIZE = { L: 'M', M: 'S' };
const TOTAL_CLOCK_MAX_MIN = 6 * MIN_PER_HOUR; // a road's Total line gets a clock only at 6 h of work or less (spec-stages section 7)
const STEP_INDENT = ' '.repeat('Steps:  '.length);
// Why a refusal shows no time, as the Progress line says it (the status line's shorter words are in segment-text.mjs).
const NO_TIME_CAUSE = { 'no-reference': 'too few finished rows', growth: 'too much unlisted work', horizon: 'job longer than any finished one' };
/** Over this much median work left a job cannot be predicted closer than half a day (backtest section 7 items 3 and 5). */
const LONG_JOB_MIN = 6 * MIN_PER_HOUR;
const MS_PER_SEC = 1000;
const EXCLUDES = 'Excludes: pauses (nights, usage limits, waiting for you) move the time hour for hour; rework after hand-over; new requests.';

/** Model s1 gives a likely and an 80% time and a promise; a c3 result (older callers and tests) has 85% and 95% and a commitment. */
const isS1 = (result) => result.model === 's1';
/** The confidence of the upper time a result carries: never a number its model does not compute. */
const upperLabel = (result) => (isS1(result) ? '80%' : '85%');

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

/** The shown clock is the likely one; model s1 has one more, its 80% clock (c3 results: the 85% and 95% clocks follow it). */
function finishLine(result, timeZone) {
  const up = (ms) => gridded(ms, timeZone, true);
  const clock = up(result.finish.clockMs);
  const where = `local ${offsetText(result.nowMs, timeZone)}, now ${clockText(result.nowMs, timeZone)}`;
  if (isS1(result)) return `Finish: ${day(clock, timeZone)} (likely; 80% by ${clockOn(up(result.numbers.v2.job.p80Ms), clock, timeZone)}; ${where})`;
  return `Finish: ${day(clock, timeZone)} (likely; 85% by ${clockOn(up(result.finish.p85Ms), clock, timeZone)}, 95% by ${clockOn(up(result.finish.lateMs), clock, timeZone)}; ${where})`;
}

/** One step line of a road: done with its rows, the current one with its share left and rows, a next one with its share. */
function stepText({ step, state, leftMin, rowsDone, rowsTotal }) {
  if (state === 'done') return `${step} done  ${plural(rowsTotal, 'row')}`;
  if (state === 'now') return `${step} now   ${workText(leftMin)} left, ${rowsDone} of ${rowsTotal} rows`;
  return `${step} next  ${workText(leftMin)}`;
}

/** The head of a road's block (display design 7.4): one clock per line; the step lines are shares of the Total, not step medians. */
function roadLines({ road, nowMs }, timeZone) {
  const at = (ms) => clockOn(gridded(ms, timeZone, true), nowMs, timeZone);
  const totalClock = road.totalMin <= TOTAL_CLOCK_MAX_MIN ? `, by ${at(nowMs + road.totalMin * MS_PER_MIN)} if nothing pauses` : '';
  return [
    `Finish: step ${road.step} of ${road.steps} by ${at(road.stepClockMs)} (now ${clockText(nowMs, timeZone)}; pauses move it hour for hour)`,
    ...road.lines.map((line, k) => `${k === 0 ? 'Steps:  ' : STEP_INDENT}${stepText(line)}`),
    `Total:  ${workText(road.totalMin)} of work left in ${plural(road.stepsLeft, 'step')}${totalClock}`,
  ];
}

/**
 * The step line of `/where` and the per-step update: `step 2 by 15:40 (85%: 16:30) · last 10 steps: 7 by the 85% time`.
 * @param {object} result a finish result with `road`
 * @param {{ timeZone?: string }} [inputs] the zone (default the system zone)
 * @returns {string | null} the line, or null for a result with no road
 */
export function stepLine(result, inputs = {}) {
  if (!result?.road) return null;
  const timeZone = inputs.timeZone ?? systemTimeZone();
  const at = (ms) => clockOn(gridded(ms, timeZone, true), result.nowMs, timeZone);
  // Model s1's record counts jobs done by their promise, not steps.
  const recordText = isS1(result) ? `${plural(result.record?.of, 'job')}: ${result.record?.met} by the promise` : `${plural(result.record?.of, 'step')}: ${result.record?.met} by the 85% time`;
  const record = result.record ? ` · last ${recordText}` : '';
  return `step ${result.road.step} by ${at(result.road.stepClockMs)} (${upperLabel(result)}: ${at(result.road.stepP85Ms)})${record}`;
}

/** The range of past jobs around the shown time, from 20 scored jobs of this model; below that it says so with the count. */
function rangeLine({ band, commit, finish }, timeZone) {
  if (!band) return [];
  if (band.low === null) return [`Range: not yet measured (${band.count} of ${band.needed} scored jobs).`];
  const startMs = finish.clockMs - commit.leftMin * MS_PER_MIN;
  const at = (ratio) => clockOn(gridded(startMs + ratio * commit.leftMin * MS_PER_MIN, timeZone, true), finish.clockMs, timeZone);
  return [`Range: ${at(band.low)} to ${at(band.high)} (10th to 90th percentile of ${plural(band.count, 'past job')}).`];
}

function coversLine({ covers, commit }) {
  const sizes = SIZES.filter((size) => covers.sizes[size] > 0).map((size) => `${covers.sizes[size]} ${size}`).join(', ');
  const rows = `${plural(covers.open, 'open row')} (${covers.running} running; ${sizes})`;
  return `Covers: ${rows}; ${workText(commit.leftMin)} of work left in this time.`;
}

/** Work not listed yet is no longer inside the time (it added work that never came): stated apart, from the pool's growth. */
function unlistedLine({ covers, work }) {
  if (!(covers.growth > 0) || covers.growth >= 1) return [];
  return [`Not in this time: work not listed yet, usually about ${workText((work.p50 * covers.growth) / (1 - covers.growth))} more (${percent(covers.growth)} of the work left in past jobs).`];
}

/** A reset clock of the limits sample (epoch seconds), with its weekday when not today. */
const resetText = (window, nowMs, timeZone) => (Number.isFinite(window?.resets_at) ? clockOn(window.resets_at * MS_PER_SEC, nowMs, timeZone) : '?');

/** Beside a job over LONG_JOB_MIN of work: why one clock is not to be trusted, the work left and the limit resets last seen. */
function longJobLines(result, limits, timeZone) {
  const { work, nowMs } = result;
  if (work.p50 <= LONG_JOB_MIN) return [];
  const lines = [`Long job: ${hoursText(work.p50)} of work left (${upperLabel(result)}: ${hoursText(work.p85)});a job over about 6 h of work cannot be predicted closer than half a day: new requests and limit stops decide it.`];
  if (!limits) return [...lines, 'Limits: no limit sample seen for this account yet.'];
  const age = workText((nowMs - limits.t) / MS_PER_MIN);
  return [...lines, `Limits: 5h resets ${resetText(limits.five_hour, nowMs, timeZone)}, 7d resets ${resetText(limits.seven_day, nowMs, timeZone)} (seen ${age} ago).`];
}

function causeText(moved, road) {
  const grew = road && moved.ids.some((id) => roadStepOf(id)?.road === road.name) ? ' (road grew)' : '';
  if (moved.cause === 'rows-added') return `because ${plural(moved.ids.length, 'row')} ${moved.ids.length === 1 ? 'was' : 'were'} added (${listed(moved.ids)})${grew}`;
  if (moved.cause === 'ahead') return 'because the open rows are going faster than usual or rows were dropped';
  if (moved.cause === 'slow-row') return `because row ${moved.ids[0]} is taking longer than 85% of ${moved.size ?? 'its size\'s'} rows`;
  return 'because the open rows are taking longer than usual';
}

/** Held or Moved, built from the stored commitment so it reads the same in every run, plus the pauses since it was made. */
function commitLine({ commit, nowMs, road }, timeZone) {
  const pauses = commit.pausedMin >= PAUSE_SHOWN_MIN ? ` Pauses since then: ${workText(commit.pausedMin)}.` : '';
  if (commit.moved === null) return `Held: given ${day(commit.atMs, timeZone)}, unchanged since.${pauses}`;
  const { moved } = commit;
  const from = clockOn(gridded(moved.wasClockMs, timeZone, true), nowMs, timeZone);
  return `Moved: at ${clockOn(moved.atMs, nowMs, timeZone)} from ${from}, ${causeText(moved, road)}; unchanged since.${pauses}`;
}

/** A later reason of the promise's difference as the c3 cause texts name it (over usual has no single row, so it reads as the pace). */
const S1_CAUSE = { 'rows-added': 'rows-added', 'over-usual': 'pace', faster: 'ahead' };

/** Where the job stands against its promise, in working minutes (a pause is never lateness); under LATE_MIN either way is on time. */
function diffText(diff, road) {
  if (diff === null || Math.abs(diff.min) < LATE_MIN) return 'on time';
  if (diff.min < 0) return `${workText(-diff.min)} of work earlier`;
  const reason = diff.reasons.find((each) => each.min > 0);
  return `${workText(diff.min)} of work later${reason === undefined ? '' : `, ${causeText({ cause: S1_CAUSE[reason.kind], ids: reason.ids }, road)}`}`;
}

/**
 * Model s1's promise line: when it was given, its 80% clock, the clock the pauses since then moved it to, and the difference now.
 * It never says the time is unchanged: the promise is fixed, the job's own clock is line 1. No promise yet: no line.
 */
function promiseLines({ promise, diff, pauses, numbers, nowMs, road }, timeZone) {
  if (promise === null) return [];
  const at = (ms) => clockOn(gridded(ms, timeZone, true), nowMs, timeZone);
  const moved = pauses.min >= PAUSE_SHOWN_MIN ? `, ${at(numbers.v2.promise.movedMs)} with the ${workText(pauses.min)} of pauses since` : '';
  return [`Promise: given ${day(promise.atMs, timeZone)}: 80% by ${at(promise.p80Ms)}${moved}; now ${diffText(diff, road)}.`];
}

function recordLine(result) {
  const { record, pool } = result;
  if (record === null) return `Track record: no job scored yet; learned from ${plural(pool.rows, 'finished row')} and ${plural(pool.jobs, 'job')}.`;
  const by = isS1(result) ? 'done by the promise given' : 'done by the first 85% time given';
  return `Track record: ${record.met} of the last ${plural(record.of, 'job')} ${record.of === 1 ? 'was' : 'were'} ${by}.`;
}

/**
 * The Progress line (null when the result has no progress): the percent from the median, and why the clock may differ (it uses the 85% budget);
 * a refusal has no median, so its percent is approximate and says why there is no time.
 */
function progressLine(progress, refusal) {
  if (!progress) return [];
  const rows = `${progress.rowsDone} of ${plural(progress.rowsTotal, 'row')}`;
  if (progress.approx) return [`Progress: ~${progress.pct}% (${rows}; time n/a: ${NO_TIME_CAUSE[refusal?.reason] ?? 'no forecast'})`];
  return [`Progress: ${progress.pct}% (${rows}; median left ${workText(progress.leftMin)})`];
}

/** The Check lines: at most MAX_CHECK_LINES stale rows, longest first, then the count of the rest, then untracked work, then carried rows. */
function checkLines(checks) {
  const stale = checks.filter((check) => check.kind === 'stale');
  const lines = stale.slice(0, MAX_CHECK_LINES).map((check) => `Check: row ${check.id} (${check.size}) has taken ${workText(check.elapsedMin)} of work, longer than every finished ${check.size} row (${workText(check.longestMin)}): finish it, or close it with evidence "dropped: <why>".`);
  if (stale.length > MAX_CHECK_LINES) lines.push(`Check: and ${stale.length - MAX_CHECK_LINES} more.`);
  for (const check of checks.filter((item) => item.kind === 'untracked')) {
    lines.push(`Check: ${workText(check.minutes)} of work in this job ran with no started row: start rows with status.mjs start <id>.`);
  }
  for (const check of checks.filter((item) => item.kind === 'carried')) {
    lines.push(`Check: ${plural(check.ids.length, 'row')} carried from the last hand-over (${listed(check.ids)}), not counted: close them or drop them.`);
  }
  // Model s1 (estimate-spec R5, R15): a stalled row counts as one fresh run of its kind; a queued road is out of the job.
  for (const check of checks.filter((item) => item.kind === 'stalled')) {
    const why = check.agentQuietSinceMs === null ? `is still open after ${workText(check.elapsedMin)} of work` : 'has an agent that stopped';
    lines.push(`Check: row ${check.id} ${why}: done, park or drop it (counted as one fresh ${check.rowKind}, ${workText(check.countedMin)}).`);
  }
  for (const check of checks.filter((item) => item.kind === 'queued')) lines.push(`Queued: road ${check.road}: ${plural(check.rows, 'row')}, not started`);
  for (const check of checks.filter((item) => item.kind === 'unstepped')) {
    lines.push(`Check: ${plural(check.ids.length, 'open row')} with no step of the road (${listed(check.ids)}) counted in step ${check.step}: give each a road id.`);
  }
  return lines;
}

/**
 * The block to paste: the finish (design 4.1), or the one-line all-done block, or the hand-over and the track record.
 * @param {object} result estimateFile's result in the state finish, all-done or handed-over
 * @param {{ timeZone?: string, limits?: object | null }} [inputs] the zone for every clock time (default the system zone); the account's
 *   newest limits sample, named beside a long job
 * @returns {string} the block, no trailing newline
 */
export function formatEstimate(result, inputs = {}) {
  const timeZone = inputs.timeZone ?? systemTimeZone();
  switch (result.state) {
    case 'all-done': return [`Finish: now (all ${plural(result.rows, 'row')} ${result.rows === 1 ? 'is' : 'are'} done; the hand-over is recorded when this turn ends)`, ...checkLines(result.checks ?? [])].join('\n');
    case 'handed-over': return [`Finish: handed over ${day(result.handedOverMs, timeZone)} (${plural(result.rows, 'row')}, ${workText(result.workedMin)} of work)`, recordLine(result), ...checkLines(result.checks ?? [])].join('\n');
    case 'finish': return [
      ...(result.road ? roadLines(result, timeZone) : [finishLine(result, timeZone)]), ...rangeLine(result, timeZone), ...longJobLines(result, inputs.limits ?? null, timeZone), coversLine(result),
      ...unlistedLine(result), EXCLUDES, ...(isS1(result) ? promiseLines(result, timeZone) : [commitLine(result, timeZone)]), recordLine(result), ...progressLine(result.progress), ...checkLines(result.checks),
    ].join('\n');
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
