// Renders an estimate result as the text block the lead pastes as-is (see README.md for the exact lines).
// Exports: formatEstimate(result, inputs) -> string; formatRefusal(refusal) -> string; runningRange(result) -> string.
// Invariants: pure; a refusal text never contains an estimate number (no "Agent-hours" line); every hours figure is
// printed with its range and the number of finished items it comes from.
import { STALE_AFTER_MS } from './compute.mjs';

const DECIMAL_LIMIT = 10;
const PERCENT = 100;
const HOURS_PER_DAY = 24;
const HOUR_MS = 3_600_000;
const DAYS_ABOVE_HOURS = 48;
const LISTED_ROWS = 5;

/** Numbers under 10 keep one decimal (a trailing `.0` is dropped); larger ones round to whole numbers. */
function num(value) {
  if (value >= DECIMAL_LIMIT) return String(Math.round(value));
  return String(Number(value.toFixed(1)));
}

const range = (low, high) => `${num(low)}-${num(high)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const pct = (share) => `${Math.round(share * PERCENT)}%`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The first few names of a list, then how many more, so a refusal stays readable on a table of thousands of rows. */
const listed = (names) => (names.length <= LISTED_ROWS ? names.join(', ') : `${names.slice(0, LISTED_ROWS).join(', ')} and ${names.length - LISTED_ROWS} more`);
const instant = (ms) => new Date(ms).toISOString().replace(/(:00)?\.000Z$/, 'Z');

function limitSummary(result, inputs) {
  if (inputs.transcriptCount === 0) return { idle: `usage-limit idle: not measured (no transcripts at ${inputs.transcriptDir})`, windows: '' };
  const { count, hours } = result.windowsInSpan;
  return {
    idle: `usage-limit idle ${pct(result.limitIdle)}`,
    windows: `, ${plural(count, 'limit window')} (${num(hours)} h) in ${plural(inputs.transcriptCount, 'transcript')}`,
  };
}

/** What the h/point range is made of, with N; says so when every rate is equal (no spread was measured). */
function rangeLabel(result) {
  const finished = plural(result.measured, 'finished item');
  const label = result.rate.band === 'p25-p75' ? `p25-p75 band of ${finished}` : `range from the slowest and fastest of ${finished}`;
  return result.rate.low === result.rate.high ? `${label}; all rates equal, real spread unknown` : label;
}

function rateMeaning(inputs) {
  const limits = inputs.transcriptCount === 0 ? 'usage-limit pauses are included (no transcripts)' : 'only usage-limit windows found in the transcripts are taken out';
  return `Rate: wall-clock time from started to done, so it includes waiting and nights; ${limits}.`;
}

function staleNote(result) {
  const ageMs = result.computedAt - result.newestEntry;
  if (result.openItems === 0 || ageMs <= STALE_AFTER_MS) return [];
  const hours = ageMs / HOUR_MS;
  const age = hours >= DAYS_ABOVE_HOURS ? `${num(hours / HOURS_PER_DAY)} days` : `${num(hours)} hours`;
  return [`Note: the newest started or done in the table is ${age} old (${instant(result.newestEntry)}); update STATUS.md if work happened since.`];
}

/**
 * The running-time range as the report prints it ("5-8", hours): the one source for the status line segment too.
 * @param {object} result from computeEstimate (not a refusal, with open items).
 * @returns {string} low-high in hours, in the report's own rounding.
 */
export const runningRange = (result) => range(result.running.low, result.running.high);

/**
 * The estimate block.
 * @param {object} result from computeEstimate (not a refusal).
 * @param {{path: string, now: string, transcriptDir: string, transcriptCount: number}} inputs where the numbers came from.
 * @returns {string} the block, no trailing newline.
 */
export function formatEstimate(result, inputs) {
  const limits = limitSummary(result, inputs);
  const lines = [`Estimate (computed ${inputs.now} by estimate.mjs from ${inputs.path})`];
  const basis = result.rate.band === 'p25-p75' ? 'p25-p75' : 'fastest-slowest';
  const from = `From: ${plural(result.measured, 'done item')} ${day(result.first)}..${day(result.last)}, ${range(result.rate.low, result.rate.high)} h/point (${basis})${limits.windows}`;
  if (result.openItems === 0) return [...lines, 'Remaining: 0 items', 'Nothing remaining: every item in the table is done, so there are no hours to estimate.', rateMeaning(inputs), from].join('\n');
  const capped = result.lanes < result.measuredLanes ? `measured ${result.measuredLanes.toFixed(1)}, capped by open items` : 'measured';
  lines.push(
    `Remaining: ${plural(result.openItems, 'item')}, ${plural(result.openPoints, 'point')} (${result.inFlight} in flight, counted whole)`,
    `Agent-hours: ${range(result.agentHours.low, result.agentHours.high)} (median ${num(result.agentHours.median)}; ${rangeLabel(result)})`,
    `Running time: ${runningRange(result)} h at ${result.lanes.toFixed(1)} lanes (${capped})`,
    `Calendar: ${range(result.calendarDays.low, result.calendarDays.high)} days (active ${pct(result.activeShare)} of elapsed; ${limits.idle})`,
    rateMeaning(inputs),
    from,
    ...staleNote(result),
  );
  return lines.join('\n');
}

/** The refusal text: what is missing or wrong, never a number to quote. */
export function formatRefusal(refusal) {
  const parts = [];
  if (refusal.measured < refusal.needed) parts.push(`${refusal.measured} done items with started, done and evidence; need ${refusal.needed}.`);
  if (refusal.missing.length > 0) parts.push(`Missing started on: ${listed(refusal.missing)}.`);
  if (refusal.future.length > 0) {
    const later = listed(refusal.future.map((f) => `${f.row} ${f.cell} ${instant(f.at)}`));
    parts.push(`Later than now (${instant(refusal.now)}): ${later}.`);
  }
  if (refusal.noTime.length > 0) parts.push(`No working time left after removing usage-limit windows: ${listed(refusal.noTime)}.`);
  return `No estimate: ${parts.join(' ')}`;
}
