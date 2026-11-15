// Renders a finish result as the text block the lead pastes as-is (see README.md for the exact lines), and the short clock
// text of the status line segment.
// Exports: formatEstimate(result, inputs) -> string; formatRefusal(refusal, timeZone?) -> string; finishClock(result, timeZone?) -> string;
// printedBounds(result, timeZone?) -> {low, high} (the printed ends, epoch ms, for the calibration log).
// Invariants: pure apart from reading the system time zone (`Intl`, so `TZ` is honoured) when none is given. Line 1 is always
// `Finish: <weekday> <day> <month> <low>-<high> (local <offset>, now <clock>)` with the low end floored and the high end ceiled
// to CLOCK_STEP_MS on the local clock; a refusal text never contains `Finish:` or a clock range, only the reason and what to do.
// Never prints item text or transcript content: rows are named by id.
import { MIN_SCORED, TARGET_INSIDE } from './calibration.mjs';
import { STALE_AFTER_MS } from './compute.mjs';

const DECIMAL_LIMIT = 10;
const HOURS_PER_DAY = 24;
const HOUR_MS = 3_600_000;
const DAYS_ABOVE_HOURS = 48;
const LISTED_ROWS = 5;
const MIN_MEASURED_TAILS = 2;
const CLOSING_WORK = 'review, fix rounds, recheck, landing';
const EXCLUDES = 'Excludes: your review and any rework it starts (next line); usage-limit pauses from now on; steps only you do (push, deploy); requests that are not rows';
const NO_DELIVERY = 'After your review: not measured here yet (no earlier delivery in this table)';
const OVERRUN_ADVICE = 'What to do: tell the owner the job is past its usual closing; this ends at delivery, whose length then joins the history. Work not in the table: add it as a row first.';

/** Numbers under 10 keep one decimal (a trailing `.0` is dropped); larger ones round to whole numbers. */
function num(value) {
  if (value >= DECIMAL_LIMIT) return String(Math.round(value));
  return String(Number(value.toFixed(1)));
}

const range = (low, high) => `${num(low)}-${num(high)}`;
const rate = (value) => String(Number(value.toFixed(2)));
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The first few names of a list, then how many more, so a line stays readable on a table of thousands of rows. */
const listed = (names) => (names.length <= LISTED_ROWS ? names.join(', ') : `${names.slice(0, LISTED_ROWS).join(', ')} and ${names.length - LISTED_ROWS} more`);
const instant = (ms) => new Date(ms).toISOString().replace(/(:00)?\.000Z$/, 'Z');

// ---- Local clock (Intl with an IANA zone: the system zone by default, so `TZ` is honoured, Windows included) ----
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const MINUTES_PER_HOUR = 60;
const CLOCK_STEP_MS = 5 * MINUTE_MS; // finish ends are rounded to 5 minutes: finer would claim a precision the data does not have
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WALL_FIELDS = { hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
const pad = (value) => String(value).padStart(2, '0');
const systemTimeZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The wall clock of an instant in a zone: numeric fields, the short weekday, and the zone's offset from UTC in ms. */
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { ...WALL_FIELDS, timeZone }).formatToParts(new Date(ms));
  const field = (type) => parts.find((part) => part.type === type).value;
  const [year, month, day, hour, minute, second] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((type) => Number(field(type)));
  const offsetMs = Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(ms / SECOND_MS) * SECOND_MS;
  return { year, month, day, hour, minute, weekday: field('weekday'), offsetMs };
}

const clockText = (ms, timeZone) => {
  const wall = wallClock(ms, timeZone);
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
};
const dayText = (ms, timeZone) => {
  const wall = wallClock(ms, timeZone);
  return `${wall.weekday} ${wall.day} ${MONTHS[wall.month - 1]}`;
};
const localDate = (ms, timeZone) => {
  const wall = wallClock(ms, timeZone);
  return `${wall.year}-${wall.month}-${wall.day}`;
};

/** The zone's offset at an instant as `+03:30` / `-05:00` / `+00:00`. */
function offsetText(ms, timeZone) {
  const minutes = Math.round(wallClock(ms, timeZone).offsetMs / MINUTE_MS);
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / MINUTES_PER_HOUR))}:${pad(Math.abs(minutes) % MINUTES_PER_HOUR)}`;
}

/** An instant rounded down (or up) to CLOCK_STEP_MS on the zone's local clock. */
function gridded(ms, timeZone, up) {
  const { offsetMs } = wallClock(ms, timeZone);
  const steps = (ms + offsetMs) / CLOCK_STEP_MS;
  return (up ? Math.ceil(steps) : Math.floor(steps)) * CLOCK_STEP_MS - offsetMs;
}

/**
 * The finish range as printed: on the local grid, low floored, high ceiled, at least one step apart.
 * @param {object} result from computeEstimate with a `finish`.
 * @param {string} [timeZone] IANA zone; default the system zone.
 * @returns {{low: number, high: number}} epoch ms.
 */
export function printedBounds(result, timeZone = systemTimeZone()) {
  const low = gridded(Math.max(result.finish.lowMs, result.computedAt), timeZone, false);
  return { low, high: Math.max(gridded(result.finish.highMs, timeZone, true), low + CLOCK_STEP_MS) };
}

/**
 * The status line's clock text: `14:50-16:15` when both ends are today, `Sun 00:50-02:25` when both are on another day, and
 * `Sun 23:20 - Mon 01:10` when the ends are on different days.
 * @param {object} result from computeEstimate with a `finish` (not a refusal or a delivered result).
 * @param {string} [timeZone] IANA zone; default the system zone.
 * @returns {string}
 */
export function finishClock(result, timeZone = systemTimeZone()) {
  const { low, high } = printedBounds(result, timeZone);
  const weekday = (ms) => dayText(ms, timeZone).split(' ')[0];
  if (localDate(low, timeZone) !== localDate(high, timeZone)) return `${weekday(low)} ${clockText(low, timeZone)} - ${weekday(high)} ${clockText(high, timeZone)}`;
  const today = localDate(low, timeZone) === localDate(result.computedAt, timeZone);
  return `${today ? '' : `${weekday(low)} `}${clockText(low, timeZone)}-${clockText(high, timeZone)}`;
}

function finishLine(result, timeZone) {
  const { low, high } = printedBounds(result, timeZone);
  const where = `(local ${offsetText(result.computedAt, timeZone)}, now ${clockText(result.computedAt, timeZone)})`;
  if (dayText(low, timeZone) === dayText(high, timeZone)) return `Finish: ${dayText(low, timeZone)} ${clockText(low, timeZone)}-${clockText(high, timeZone)} ${where}`;
  return `Finish: ${dayText(low, timeZone)} ${clockText(low, timeZone)} - ${dayText(high, timeZone)} ${clockText(high, timeZone)} ${where}`;
}

function closingSource(closing) {
  if (closing.measured >= MIN_MEASURED_TAILS) return `measured from ${closing.measured} finished jobs here`;
  return closing.measured === 1 ? 'default, widened by the 1 finished job here' : 'default, not yet measured here';
}

function includesLine(result) {
  const { build, closing } = result;
  const rows = `${plural(result.openItems, 'open row')} (${result.inFlight} running)`;
  const phase = `the closing phase ${range(closing.low, closing.high)} h`;
  const about = `(${CLOSING_WORK}; ${closingSource(closing)})`;
  if (build.ids.length === 0) return `Includes: ${rows}; no open build row: ${phase} ${about} has run ${num(result.closingElapsed)} h`;
  const lanes = build.lanes === 1 ? '1 lane' : `${num(build.lanes)} lanes`;
  const past = build.pastRate.length === 0 ? '' : `; ${listed(build.pastRate)} past every measured rate, ${build.pastRate.length === 1 ? 'its' : 'their'} remaining time is not known`;
  return `Includes: ${rows}; build ${range(build.low, build.high)} h (${listed(build.ids)}, ${lanes}${past}), then ${phase} in series ${about}`;
}

/** The latest rework's state when it is counted to now: '' once delivered again. */
const reworkState = (reopen) => (!reopen.open ? '' : reopen.reworkOpen ? 'still open' : 'not delivered again yet');

function afterLine(reopen) {
  if (reopen === null) return NO_DELIVERY;
  const counted = `After your review: ${reopen.reopened} of ${reopen.deliveries} earlier deliveries here were reopened by your corrections`;
  if (reopen.reopened === 0) return counted;
  const state = reworkState(reopen);
  if (reopen.reopened === 1) return `${counted}; that rework took ${num(reopen.highHours)} h${state ? ` so far (${state})` : ''}`;
  return `${counted}; those reworks took ${range(reopen.lowHours, reopen.highHours)} h${state ? ` (the latest ${state}, counted so far)` : ''}`;
}

/** How earlier printed ranges did and how the range is adjusted (see calibration.mjs). */
function trackLine({ record, factors }) {
  const target = `${TARGET_INSIDE.inside} of ${TARGET_INSIDE.of}`;
  if (record.scored === 0) return `Track record: no scored estimate yet; the range is adjusted once ${MIN_SCORED} are scored (target: ${target} inside)`;
  const late = record.late > 0 ? ` (median x${num(record.medianLate)} of the printed time)` : '';
  const counts = `Track record: ${record.inside} of ${record.scored} inside, ${record.late} late${late}, ${record.early} early`;
  if (factors.scored < MIN_SCORED) return `${counts}; adjusted once ${MIN_SCORED} are scored`;
  return `${counts}; adjusted high x${num(factors.high)}, low x${num(factors.low)} (target ${target})`;
}

function dateSpan(first, last, timeZone) {
  const [a, b] = [dayText(first, timeZone).split(' ').slice(1), dayText(last, timeZone).split(' ').slice(1)];
  if (a.join(' ') === b.join(' ')) return a.join(' ');
  return a[1] === b[1] ? `${a[0]}..${b.join(' ')}` : `${a.join(' ')}..${b.join(' ')}`;
}

function laneText(result) {
  const measured = result.measuredLanes.toFixed(1);
  if (result.build.ids.length === 0) return `${result.lanes.toFixed(1)} lanes (measured ${measured}; no open build row)`;
  if (result.lanes < result.measuredLanes) return `${result.lanes.toFixed(1)} lanes (measured ${measured}, capped by ${plural(result.build.ids.length, 'open build row')})`;
  return result.lanes > result.measuredLanes ? `1.0 lanes (measured ${measured}, raised to 1)` : `${result.lanes.toFixed(1)} lanes (measured)`;
}

function limitText(result, inputs) {
  if (inputs.transcriptCount === 0) return `usage-limit windows not measured (no transcripts at ${inputs.transcriptDir})`;
  const { count, hours } = result.windowsInSpan;
  if (count === 0) return 'no limit windows in the transcripts';
  return `${plural(count, 'limit window')} (${num(hours)} h) in ${plural(inputs.transcriptCount, 'transcript')} taken out`;
}

function assumesLine(result, inputs, timeZone) {
  const { rate: band } = result;
  const rows = band.running > 0 ? `${band.done} done + ${band.running} running rows` : plural(band.done, 'done row');
  const equal = band.low === band.high ? '; all rates equal, real spread unknown' : '';
  const rates = `${rate(band.low)}-${rate(band.high)} h/point (${band.band} of ${rows}, ${dateSpan(result.first, result.last, timeZone)}${equal})`;
  return `Assumes: the table as it is now; ${rates}; ${laneText(result)}; ${limitText(result, inputs)}`;
}

function staleNote(result) {
  const ageMs = result.computedAt - result.newestEntry;
  if (result.openItems === 0 || ageMs <= STALE_AFTER_MS) return [];
  const hours = ageMs / HOUR_MS;
  const age = hours >= DAYS_ABOVE_HOURS ? `${num(hours / HOURS_PER_DAY)} days` : `${num(hours)} hours`;
  return [`Note: the newest started or done in the table is ${age} old (${instant(result.newestEntry)}); update STATUS.md if work happened since.`];
}

/**
 * The finish block (or the two-line delivered block).
 * @param {object} result from computeEstimate (not a refusal), its finish already scaled by the calibration factors.
 * @param {{transcriptDir: string, transcriptCount: number, timeZone?: string, calibration?: {record: object, factors: object}}} inputs
 *   where the windows came from; the zone for every clock time (default the system zone); the track record and factors
 *   (no Track record line without them, e.g. a --now run that keeps no log).
 * @returns {string} the block, no trailing newline.
 */
export function formatEstimate(result, inputs) {
  const timeZone = inputs.timeZone ?? systemTimeZone();
  if (result.delivered !== undefined) {
    const at = result.delivered;
    return [`Finish: delivered ${dayText(at, timeZone)} ${clockText(at, timeZone)} (local ${offsetText(at, timeZone)})`, afterLine(result.reopen)].join('\n');
  }
  const agentHours = result.build.ids.length === 0 ? 'Agent-hours: 0 (no open build row)'
    : `Agent-hours: ${result.agentHours.low.toFixed(1)}-${result.agentHours.high.toFixed(1)} for the open build rows, counted whole`;
  const track = inputs.calibration === undefined ? [] : [trackLine(inputs.calibration)];
  return [finishLine(result, timeZone), includesLine(result), EXCLUDES, afterLine(result.reopen), ...track, assumesLine(result, inputs, timeZone), agentHours, ...staleNote(result)].join('\n');
}

function overrunText({ overrun }, timeZone) {
  const { start, closing } = overrun;
  const since = start.how === 'done' ? 'the last build row was done' : 'the first closing row started';
  const closings = range(closing.low, closing.high);
  const than = closing.measured >= MIN_MEASURED_TAILS ? `every closing measured here (${closings} h, ${closing.measured} jobs)`
    : `the default closing (${closings} h, ${closing.measured === 1 ? 'widened by 1 finished job here' : 'not yet measured here'})`;
  return `No finish time: the closing phase has run ${num(overrun.hours)} h since ${since} (${start.item.id}, ${clockText(start.at, timeZone)}), longer than ${than}.\n${OVERRUN_ADVICE}`;
}

/** The refusal text: why there is no finish time and what to do, never a time to quote. */
export function formatRefusal(refusal, timeZone = systemTimeZone()) {
  if (refusal.reason === 'overrun') return overrunText(refusal, timeZone);
  const reasons = [];
  const advice = [];
  if (refusal.measured < refusal.needed) {
    reasons.push(`${refusal.measured} done items with started, done and evidence; need ${refusal.needed}.`);
    advice.push('finish and record more rows.');
  }
  if (refusal.missing.length > 0) {
    reasons.push(`Missing started on: ${listed(refusal.missing)}.`);
    advice.push('fill started of those rows with the real start, or delete the row.');
  }
  if (refusal.future.length > 0) {
    reasons.push(`Later than now (${instant(refusal.now)}): ${listed(refusal.future.map((f) => `${f.row} ${f.cell} ${instant(f.at)}`))}.`);
    advice.push('correct the time from the clock (`date -u +%Y-%m-%dT%H:%MZ`), never from memory, or pass the right --now.');
  }
  if (refusal.noTime.length > 0) {
    reasons.push(`No working time left after removing usage-limit windows: ${listed(refusal.noTime)}.`);
    advice.push('correct started and done of those rows: they lie inside usage-limit windows.');
  }
  const sentences = advice.map((text, i) => (i === 0 ? text : text[0].toUpperCase() + text.slice(1)));
  return `No finish time: ${reasons.join(' ')}\nWhat to do: ${sentences.join(' ')}`;
}
