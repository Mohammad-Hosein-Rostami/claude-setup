// Renders an estimate result as the text block the lead pastes as-is (see README.md for the exact lines).
// Exports: formatEstimate(result, inputs) -> string; formatRefusal(refusal, path) -> string.
// Invariants: pure; a refusal text never contains an estimate number (no "Agent-hours" line).
const DECIMAL_LIMIT = 10;
const PERCENT = 100;

/** Numbers under 10 keep one decimal (a trailing `.0` is dropped); larger ones round to whole numbers. */
function num(value) {
  if (value >= DECIMAL_LIMIT) return String(Math.round(value));
  return String(Number(value.toFixed(1)));
}

const range = (low, high) => `${num(low)}-${num(high)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const pct = (share) => `${Math.round(share * PERCENT)}%`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function limitSummary(result, inputs) {
  if (inputs.transcriptCount === 0) return { idle: `usage-limit idle: not measured (no transcripts at ${inputs.transcriptDir})`, windows: '' };
  const { count, hours } = result.windowsInSpan;
  return {
    idle: `usage-limit idle ${pct(result.limitIdle)}`,
    windows: `, ${plural(count, 'limit window')} (${num(hours)} h) in ${plural(inputs.transcriptCount, 'transcript')}`,
  };
}

/**
 * The estimate block.
 * @param {object} result from computeEstimate (not a refusal).
 * @param {{path: string, now: string, transcriptDir: string, transcriptCount: number}} inputs where the numbers came from.
 * @returns {string} the block, no trailing newline.
 */
export function formatEstimate(result, inputs) {
  const limits = limitSummary(result, inputs);
  const lines = [`Estimate (computed ${inputs.now} by estimate.mjs from ${inputs.path})`];
  const from = `From: ${plural(result.measured, 'done item')} ${day(result.first)}..${day(result.last)}, ${range(result.rate.p25, result.rate.p75)} h/point (p25-p75)${limits.windows}`;
  if (result.openItems === 0) return [...lines, 'Remaining: 0 items', from].join('\n');
  const capped = result.lanes < result.measuredLanes ? `measured ${result.measuredLanes.toFixed(1)}, capped by open items` : 'measured';
  lines.push(
    `Remaining: ${plural(result.openItems, 'item')}, ${plural(result.openPoints, 'point')} (${result.inFlight} in flight, counted whole)`,
    `Agent-hours: ${range(result.agentHours.low, result.agentHours.high)} (median ${num(result.agentHours.median)})`,
    `Running time: ${range(result.running.low, result.running.high)} h at ${result.lanes.toFixed(1)} lanes (${capped})`,
    `Calendar: ${range(result.calendarDays.low, result.calendarDays.high)} days (active ${pct(result.activeShare)} of elapsed; ${limits.idle})`,
    from,
  );
  return lines.join('\n');
}

/** The refusal text: what is missing, never a number to quote. */
export function formatRefusal(refusal) {
  const missing = refusal.missing.length > 0 ? ` Missing started on: ${refusal.missing.join(', ')}.` : '';
  return `No estimate: ${refusal.measured} done items with started, done and evidence; need ${refusal.needed}.${missing}`;
}
