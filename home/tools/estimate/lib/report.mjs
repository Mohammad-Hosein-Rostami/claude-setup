// Renders a finish result as the text block the lead pastes as-is (see README.md for the exact lines), and the short clock
// text of the status line segment.
// Exports: formatEstimate(result, inputs) -> string; formatRefusal(refusal, timeZone?) -> string; finishClock(result, timeZone?) -> string;
// printedBounds(result, timeZone?) -> {low, high} (the printed ends, epoch ms, for the calibration log; high is null for a notBefore result).
// Invariants: pure apart from reading the system time zone (`Intl`, so `TZ` is honoured) when none is given. Line 1 is
// `Finish: <weekday> <day> <month> <low>-<high> (local <offset>, now <clock>)` with the low end floored and the high end ceiled
// to CLOCK_STEP_MS on the local clock, or, for a result with `notBefore` (a round or closing phase past its range: no upper
// end), `Finish: not before <weekday> <day> <month> <low> (local <offset>, now <clock>)`; a refusal text never contains
// `Finish:` or a clock range, only the reason and what to do.
// Never prints item text or transcript content: rows are named by id.
import { MIN_SCORED, TARGET_INSIDE } from './calibration.mjs';
import { STALE_AFTER_MS } from './compute.mjs';
import { MIN_MEASURED_RANGE } from './history.mjs';
import { CLOCK_STEP_MS, clockText, dayText, gridded, localDate, offsetText, systemTimeZone } from './local-clock.mjs';

const DECIMAL_LIMIT = 10;
const HOURS_PER_DAY = 24;
const HOUR_MS = 3_600_000;
const DAYS_ABOVE_HOURS = 48;
const LISTED_ROWS = 5;
const CLOSING_WORK = 'review, fix rounds, recheck, landing';
// A table has one first cycle, so its closing phase is always the default (compute.mjs firstCycleResult).
const CLOSING_SOURCE = 'default, not yet measured here';
const EXCLUDES = 'Excludes: your review and any rework it starts (next line); usage-limit pauses from now on; steps only you do (push, deploy); requests that are not rows';
const NO_DELIVERY = 'After your review: not measured here yet (no earlier delivery in this table)';
const OVERRUN_ADVICE = 'What to do: tell the owner the job is past its usual closing; this ends at delivery, whose length then joins the history. Work not in the table: add it as a row first.';
const GUESSED_NOTE = 'delivery guessed from a pause: add a deliver: row when you hand over';
const ROUND_DONE_ADVICE = 'What to do: if you handed the job over, add a deliver: row with its done time; if work remains, add it as rows.';
const ROUND_ADVICE = 'What to do: tell the owner the follow-up round is past its usual length; this ends at delivery, whose round length then joins the history. Work not in the table: add it as a row first.';

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

/**
 * The finish range as printed: on the local grid, low floored, high ceiled, at least one step apart.
 * @param {object} result from computeEstimate with a `finish`.
 * @param {string} [timeZone] IANA zone; default the system zone.
 * @returns {{low: number, high: number | null}} epoch ms; high is null when the result is `notBefore`.
 */
export function printedBounds(result, timeZone = systemTimeZone()) {
  const low = Math.max(gridded(result.finish.lowMs, timeZone, false), gridded(result.computedAt, timeZone, true));
  if (result.notBefore) return { low, high: null };
  return { low, high: Math.max(gridded(result.finish.highMs, timeZone, true), low + CLOCK_STEP_MS) };
}

/**
 * The status line's clock text: `14:50-16:15` when both ends are today, `Sun 00:50-02:25` when both are on another day, and
 * `Sun 23:20 - Mon 01:10` when the ends are on different days; `>=17:10` (`>=Sun 17:10` on another day) for a `notBefore` result.
 * @param {object} result from computeEstimate with a `finish` (not a refusal or a delivered result).
 * @param {string} [timeZone] IANA zone; default the system zone.
 * @returns {string}
 */
export function finishClock(result, timeZone = systemTimeZone()) {
  const { low, high } = printedBounds(result, timeZone);
  const weekday = (ms) => dayText(ms, timeZone).split(' ')[0];
  if (high === null) return `>=${localDate(low, timeZone) === localDate(result.computedAt, timeZone) ? '' : `${weekday(low)} `}${clockText(low, timeZone)}`;
  if (localDate(low, timeZone) !== localDate(high, timeZone)) return `${weekday(low)} ${clockText(low, timeZone)} - ${weekday(high)} ${clockText(high, timeZone)}`;
  const today = localDate(low, timeZone) === localDate(result.computedAt, timeZone);
  return `${today ? '' : `${weekday(low)} `}${clockText(low, timeZone)}-${clockText(high, timeZone)}`;
}

function finishLine(result, timeZone) {
  const { low, high } = printedBounds(result, timeZone);
  const where = `(local ${offsetText(result.computedAt, timeZone)}, now ${clockText(result.computedAt, timeZone)})`;
  if (high === null) return `Finish: not before ${dayText(low, timeZone)} ${clockText(low, timeZone)} ${where}`;
  if (dayText(low, timeZone) === dayText(high, timeZone)) return `Finish: ${dayText(low, timeZone)} ${clockText(low, timeZone)}-${clockText(high, timeZone)} ${where}`;
  return `Finish: ${dayText(low, timeZone)} ${clockText(low, timeZone)} - ${dayText(high, timeZone)} ${clockText(high, timeZone)} ${where}`;
}

/** Where a follow-up round's range comes from, for the Includes line and the round refusal. */
function roundSource(range) {
  if (range.measured >= MIN_MEASURED_RANGE) return `measured from ${range.measured} finished rounds here`;
  return range.measured === 1 ? 'default, widened by the 1 finished round here' : 'default, not yet measured here';
}

const laneCount = (build) => (build.lanes === 1 ? '1 lane' : `${num(build.lanes)} lanes`);

/** Why a round or closing phase that outran its range has no upper end (a `notBefore` result). */
function overrunReason({ overrun }) {
  const { kind, hours, closing } = overrun;
  const [what, longest, source] = kind === 'round' ? ['round', 'every measured round', roundSource(closing)] : ['closing phase', 'every measured closing', CLOSING_SOURCE];
  return `this ${what} has run ${num(hours)} h, longer than ${longest} (${range(closing.low, closing.high)} h; ${source}): no upper end can be supported`;
}

const sizesText = (build) => `the open rows need at least ${range(build.low, build.high)} h by size (${listed(build.ids)}, ${laneCount(build)})`;

function followUpIncludes(result, timeZone) {
  const { build, closing, followUp } = result;
  const started = followUp.startRow === null ? 'no row started yet' : `started ${clockText(followUp.start, timeZone)} (${followUp.startRow})`;
  const rows = `${plural(result.openItems, 'open row')} (${result.inFlight} running)`;
  const took = result.notBefore ? overrunReason(result) : `such rounds took ${range(closing.low, closing.high)} h here (${roundSource(closing)})`;
  return `Includes: follow-up round after the delivery at ${clockText(followUp.deliveryAt, timeZone)}, ${started}: ${rows}; ${took}; ${sizesText(build)}`;
}

const inRound = (result) => result.state === 'round-open';
/** True when the open rows are counted by size whatever their kind (a round, or an overrun closing phase): the words say `open row`. */
const countsAllRows = (result) => inRound(result) || result.notBefore === true;

/** The deliver rows that were not deliveries, as `deliver row X1 ignored: 1 row was still running at 14:30`. */
const ignoredNotes = (ignored, timeZone) => ignored.map((d) => `deliver row ${d.id} ignored: ${plural(d.running, 'row')} ${d.running === 1 ? 'was' : 'were'} still running at ${clockText(d.at, timeZone)}`);

/** The Includes line of the table's state, then the ignored deliver rows and GUESSED_NOTE when a delivery was guessed from a pause. */
function includesLine(result, timeZone) {
  const notes = [...ignoredNotes(result.ignored, timeZone), ...(result.deliveryGuessed ? [GUESSED_NOTE] : [])];
  switch (result.state) {
    case 'first-cycle-building':
    case 'first-cycle-closing': return [firstCycleIncludes(result), ...notes].join('; ');
    case 'round-open': return [followUpIncludes(result, timeZone), ...notes].join('; ');
    default: throw new Error(`no Includes line for state ${result.state}`);
  }
}

function firstCycleIncludes(result) {
  const { build, closing } = result;
  const rows = `${plural(result.openItems, 'open row')} (${result.inFlight} running)`;
  const phase = `the closing phase ${range(closing.low, closing.high)} h`;
  const about = `(${CLOSING_WORK}; ${CLOSING_SOURCE})`;
  const elapsed = `has run ${num(result.closingElapsed)} h`;
  if (result.notBefore) return `Includes: ${rows}; ${overrunReason(result)}; ${sizesText(build)}`;
  if (result.openItems === 0) return `Includes: no open row: the build is done and ${phase} ${about} is not in rows yet; it ${elapsed}`;
  if (build.ids.length === 0) return `Includes: ${rows}; no open build row: ${phase} ${about} ${elapsed}`;
  const lanes = laneCount(build);
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

/** How earlier printed ranges of this phase did and how the range is adjusted (see calibration.mjs: one set per phase). */
function trackLine({ record, factors }, round) {
  const [target, label] = [`${TARGET_INSIDE.inside} of ${TARGET_INSIDE.of}`, `Track record (${round ? 'follow-up rounds' : 'first cycles'}):`];
  const lowOnly = record.lowOnly > 0 ? `; ${record.lowOnlyInside} of ${record.lowOnly} not-before estimates held (delivered no earlier than printed)` : '';
  const dropped = `${record.rewritten > 0 ? `; ${record.rewritten} dropped (table rewritten)` : ''}${lowOnly}`;
  const once = `adjusted once ${MIN_SCORED} deliveries are scored`;
  if (record.scored === 0) return `${label} no scored estimate yet${dropped}; the range is ${once} (target: ${target} inside)`;
  const late = record.late > 0 ? ` (median x${num(record.medianLate)} of the printed time)` : '';
  const over = record.deliveries === record.scored ? '' : ` (${record.scored} predictions over ${record.deliveries} ${record.deliveries === 1 ? 'delivery' : 'deliveries'})`;
  const counts = `${label} ${record.inside} of ${record.scored} inside${over}, ${record.late} late${late}, ${record.early} early${dropped}`;
  if (factors.deliveries < MIN_SCORED) return `${counts}; ${once}`;
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
  const counted = countsAllRows(result) ? 'open row' : 'open build row';
  if (result.lanes < result.measuredLanes) return `${result.lanes.toFixed(1)} lanes (measured ${measured}, capped by ${plural(result.build.ids.length, counted)})`;
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
  const brief = result.underMinute.length === 0 ? '' : `; ${listed(result.underMinute)} took under a minute and ${result.underMinute.length === 1 ? 'is' : 'are'} left out of the rates`;
  return `Assumes: the table as it is now; ${rates}${brief}; ${laneText(result)}; ${limitText(result, inputs)}`;
}

function staleNote(result) {
  const ageMs = result.computedAt - result.newestEntry;
  if (result.openItems === 0 || ageMs <= STALE_AFTER_MS) return [];
  const hours = ageMs / HOUR_MS;
  const age = hours >= DAYS_ABOVE_HOURS ? `${num(hours / HOURS_PER_DAY)} days` : `${num(hours)} hours`;
  return [`Note: the newest started or done in the table is ${age} old (${instant(result.newestEntry)}); update STATUS.md if work happened since.`];
}

/** The delivered block: when, provisional while its quiet gap runs, no open row, and the After line. */
function deliveredBlock(result, timeZone) {
  const at = result.delivered;
  const provisional = result.provisionalUntil === null ? '' : `; provisional until ${clockText(result.provisionalUntil, timeZone)}: no open row`;
  return [
    `Finish: delivered ${dayText(at, timeZone)} ${clockText(at, timeZone)} (local ${offsetText(at, timeZone)}${provisional})`,
    [`Includes: no open row; the last done row (${result.closingRow}) is a ${result.closingKind} row`, ...(result.guessed ? [GUESSED_NOTE] : [])].join('; '),
    afterLine(result.reopen),
  ];
}

/**
 * The finish block (or the three-line delivered block).
 * @param {object} result from computeEstimate (not a refusal), its finish already scaled by the calibration factors.
 * @param {{transcriptDir: string, transcriptCount: number, timeZone?: string, calibration?: {record: object, factors: object}}} inputs
 *   where the windows came from; the zone for every clock time (default the system zone); the track record and factors
 *   (no Track record line without them, e.g. a --now run that keeps no log).
 * @returns {string} the block, no trailing newline.
 */
export function formatEstimate(result, inputs) {
  const timeZone = inputs.timeZone ?? systemTimeZone();
  if (result.state === 'delivered') return deliveredBlock(result, timeZone).join('\n');
  const counted = countsAllRows(result) ? 'open rows' : 'open build rows';
  const agentHours = result.build.ids.length === 0 ? 'Agent-hours: 0 (no open build row)'
    : `Agent-hours: ${result.agentHours.low.toFixed(1)}-${result.agentHours.high.toFixed(1)} for the ${counted}, counted whole`;
  const track = inputs.calibration === undefined ? [] : [trackLine(inputs.calibration, inRound(result))];
  return [finishLine(result, timeZone), includesLine(result, timeZone), EXCLUDES, afterLine(result.reopen), ...track, assumesLine(result, inputs, timeZone), agentHours, ...staleNote(result)].join('\n');
}

function roundOverrunText({ overrun }, timeZone) {
  const { round, closing } = overrun;
  const since = round.startRow === null ? '' : ` since it started (${round.startRow}, ${clockText(round.start, timeZone)})`;
  const than = closing.measured >= MIN_MEASURED_RANGE ? `every round measured here (${range(closing.low, closing.high)} h, ${closing.measured} rounds)`
    : `the default round (${range(closing.low, closing.high)} h, ${closing.measured === 1 ? 'widened by 1 finished round here' : 'not yet measured here'})`;
  return `No finish time: the follow-up round has run ${num(overrun.hours)} h${since}, longer than ${than}, and its open rows are past their measured rates.\n${ROUND_ADVICE}`;
}

function roundDoneText({ round }, timeZone) {
  const since = round.startRow === null ? '' : ` (started ${clockText(round.start, timeZone)}, ${round.startRow})`;
  return `No finish time: every row of the follow-up round after the delivery at ${clockText(round.deliveryAt, timeZone)}${since} is done, and no deliver: row marks its hand-over.\n${ROUND_DONE_ADVICE}`;
}

function overrunText({ overrun }, timeZone) {
  const { start, closing } = overrun;
  const since = start.how === 'done' ? 'the last build row was done' : 'the first closing row started';
  const closings = range(closing.low, closing.high);
  return `No finish time: the closing phase has run ${num(overrun.hours)} h since ${since} (${start.item.id}, ${clockText(start.at, timeZone)}), longer than the default closing (${closings} h, not yet measured here).\n${OVERRUN_ADVICE}`;
}

/** The refusal text: why there is no finish time and what to do, never a time to quote. */
export function formatRefusal(refusal, timeZone = systemTimeZone()) {
  if (refusal.reason === 'round-done') return roundDoneText(refusal, timeZone);
  if (refusal.reason === 'overrun') return refusal.overrun.kind === 'closing' ? overrunText(refusal, timeZone) : roundOverrunText(refusal, timeZone);
  const reasons = [];
  const advice = [];
  if (refusal.measured < refusal.needed) {
    const brief = refusal.underMinute.length === 0 ? '' : ` (${listed(refusal.underMinute)} took under a minute and ${refusal.underMinute.length === 1 ? 'is' : 'are'} not counted)`;
    reasons.push(`${refusal.measured} done items with started, done and evidence; need ${refusal.needed}${brief}.`);
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
