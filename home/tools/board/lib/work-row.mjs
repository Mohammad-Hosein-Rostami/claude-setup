// The job row of the status line (display design direction B, spec-tui row 1): the session's job against its estimate, and, when
// the road row has no room. `ALL █████░░░░░  36%  3 h 40 left · step 2/3 by 16:05` at 80 columns; at 120 `36% of work`, `step 2 of 3`,
// `total by 18:35` and `10/21 rows` join when they fit.
// Exports: jobView(segment) -> view | null; workRow({ segment, nowMs, timeZone, trend, roadShown }, look) -> string; WIDE_COLUMNS.
// Sources (all checked here, never trusted: they are printed): the estimate cache's shown entry (segment-cache.mjs estimateSegment:
// kind, text, highMs, progress with its numbers-only `road`, numbers).
// Rules: the percent is work done against all work in minutes (`of work`, never a row count: audit case 8); once the committed
// clock (highMs) has passed, the time text is `over by N min · M min left (new)` and the over share is drawn ▓, both from highMs at
// render time (case 7); a refusal or error counts rows and says in words why there is no time (cases 13 and design 4.2); a count
// never shows 100% while a row is open; no STATUS.md linked: `no job linked`. Spec-tui-2: the bar is green while on track and red
// once over; clocks are dim; the estimate's bare `moved` tag is not shown (it says nothing): the caller passes the finish clock's
// move as a trend part (stat-rows.mjs trendPart, `↑ +1h10 later`); with the road row shown (`roadShown`) the step parts stay off
// this row.
// Spec-tui-3: the row's `ALL` label is bold.
// Invariants: pure (no I/O); every clock in the one zone given (case 12); the row fits look.columns (cells.mjs fitParts).
import { barText, clockOf, cleanText, durationText, fitParts, STATE } from './cells.mjs';

/** From this usable width the rows take their long form: a 120-column terminal gives 115 (COLUMNS - 5, research-tui 1.1). */
export const WIDE_COLUMNS = 115;
const WIDE_CELLS = 16;
const NARROW_CELLS = 10;
const TINY_COLUMNS = 60;
const TINY_CELLS = 6;
const PERCENT = 100;
const MS_PER_MIN = 60_000;
const CAP_WHILE_OPEN = 99;
const REFUSAL_WHY = { 'no rows': 'no rows yet', 'few rows': 'too few finished rows', 'rows listed late': 'rows listed late' };
const TAG_WORDS = { '+rows': 'rows added' };
const ALL_LABEL = 'ALL';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

/** The road numbers of progress.road (road-steps.mjs withRoad), or null when absent or not that shape. */
function roadOf(road) {
  const ok = road !== null && typeof road === 'object' && isCount(road.step) && isCount(road.steps) && road.step >= 1
    && road.step <= road.steps && isCount(road.rowsDone) && isCount(road.rowsTotal);
  if (!ok) return null;
  return { ...road, clockMs: isNumber(road.clockMs) ? road.clockMs : null, p85Ms: isNumber(road.p85Ms) ? road.p85Ms : null };
}

/**
 * The job as the row needs it, from the cache's numbers when they are there, else from the stored progress.
 * @param {{ kind: string | null, text: string | null, highMs: number | null, progress: object | null, numbers: object | null } | null} segment
 * @returns {null | { kind: string, text: string, pct: number | null, rowsDone: number, rowsTotal: number, leftMin: number | null,
 *   workedMin: number | null, highMs: number | null, p85Ms: number | null, tag: string | null, road: object | null }} null when no
 *   job is linked; p85Ms is the job's 85% finish clock (job-rows.mjs numbers)
 */
export function jobView(segment) {
  if (segment === null || typeof segment !== 'object') return null;
  const { numbers, progress } = segment;
  const counts = numbers ?? progress;
  const rowsDone = isCount(counts?.rowsDone) ? counts.rowsDone : 0;
  const rowsTotal = isCount(counts?.rowsTotal) ? counts.rowsTotal : 0;
  const leftMin = isNumber(numbers?.leftMin) ? numbers.leftMin : isNumber(progress?.leftMin) ? progress.leftMin : null;
  const workedMin = isNumber(numbers?.workedMin) ? numbers.workedMin : null;
  let pct = isCount(progress?.pct) ? progress.pct : null;
  if (workedMin !== null && leftMin !== null && workedMin + leftMin > 0) pct = Math.floor((PERCENT * workedMin) / (workedMin + leftMin));
  if (pct !== null && rowsTotal > 0 && rowsDone < rowsTotal) pct = Math.min(CAP_WHILE_OPEN, pct);
  return {
    kind: segment.kind ?? 'finish', text: typeof segment.text === 'string' ? segment.text : '', pct, rowsDone, rowsTotal, leftMin, workedMin,
    highMs: isNumber(segment.highMs) ? segment.highMs : null, p85Ms: isNumber(numbers?.p85Ms) ? numbers.p85Ms : null,
    tag: progress?.tag ?? null, road: roadOf(progress?.road),
  };
}

const cellsFor = (look) => (look.columns >= WIDE_COLUMNS ? WIDE_CELLS : look.columns >= TINY_COLUMNS ? NARROW_CELLS : TINY_CELLS);
const wide = (look) => look.columns >= WIDE_COLUMNS;
const rowsText = (view) => `${view.rowsDone}/${view.rowsTotal} rows`;

/** Bar and percent: time-based when the job has a percent, else a row count (`3/9 rows`). */
function barPart(view, overShare, look) {
  if (view.pct === null || view.kind !== 'finish') {
    if (view.rowsTotal === 0) return { text: '' };
    const share = view.rowsTotal > 0 ? view.rowsDone / view.rowsTotal : 0;
    return { text: `ALL ${barText({ done: share }, cellsFor(look), look)}  ${rowsText(view)}` };
  }
  const label = wide(look) ? `${view.pct}% of work` : `${view.pct}%`;
  return { text: `ALL ${barText({ done: view.pct / PERCENT, over: overShare }, cellsFor(look), look)}  ${label}`, state: overShare > 0 ? STATE.block : STATE.done };
}

/** The time parts of a finish: left or over, the step and its clocks, the total. */
function finishParts(view, { nowMs, timeZone, roadShown }, look) {
  const overMin = view.highMs !== null && nowMs > view.highMs ? (nowMs - view.highMs) / MS_PER_MIN : 0;
  const left = view.leftMin === null ? '' : `${durationText(view.leftMin)} left`;
  const time = overMin > 0
    ? { text: `over by ${durationText(overMin)}${left ? `${look.glyph.sep}${left} (new)` : ''}`, state: STATE.block }
    : { text: left };
  const parts = [time];
  const road = roadShown ? null : view.road;
  if (road !== null) {
    const step = wide(look) ? `step ${road.step} of ${road.steps}` : `step ${road.step}/${road.steps}`;
    parts.push({ text: road.clockMs === null ? step : `${step} by ${clockOf(road.clockMs, nowMs, timeZone)}` });
    if (road.p85Ms !== null) parts.push({ text: `85%: ${clockOf(road.p85Ms, nowMs, timeZone)}`, drop: 4 });
    if (view.highMs !== null && overMin === 0) parts.push({ text: `total by ${clockOf(view.highMs, nowMs, timeZone)}`, drop: 2 });
  } else if (view.highMs !== null) {
    parts.push({ text: `done by ${clockOf(view.highMs, nowMs, timeZone)}`, state: STATE.dim });
    if (view.p85Ms !== null && view.p85Ms > view.highMs && overMin === 0) parts.push({ text: `85%: ${clockOf(view.p85Ms, nowMs, timeZone)}`, state: STATE.dim, drop: 4 });
  }
  else if (view.text) parts.push({ text: cleanText(view.text, look) });
  return { parts, overMin };
}

/** The job parts of row 1. */
function jobParts(view, clock, look, trend) {
  if (view === null) return [{ text: 'ALL no job linked' }];
  if (view.kind === 'handed-over') return [{ text: `ALL idle${look.glyph.sep}last job ${cleanText(view.text, look)}` }];
  if (view.pct === PERCENT && view.rowsTotal > 0 && view.rowsDone === view.rowsTotal) {
    return [barPart(view, 0, look), { text: `all ${view.rowsTotal} rows done` }];
  }
  if (view.kind === 'refused') {
    const cause = view.text.replace(/^done \? /, '');
    return [barPart(view, 0, look), { text: `no time: ${REFUSAL_WHY[cause] ?? cleanText(cause, look)}` }];
  }
  if (view.kind === 'work-left') return [barPart(view, 0, look), { text: `long job: ${cleanText(view.text, look)}` }];
  if (view.kind === 'error') return [barPart(view, 0, look), { text: 'no time: estimate error', state: STATE.block }];
  const { parts, overMin } = finishParts(view, clock, look);
  const total = (view.workedMin ?? 0) + (view.leftMin ?? 0) + overMin;
  const tag = TAG_WORDS[view.tag];
  return [
    barPart(view, total > 0 ? overMin / total : 0, look), ...parts,
    ...(trend ? [trend] : []), ...(view.rowsTotal > 0 ? [{ text: rowsText(view), state: STATE.dim, drop: 2 }] : []),
    ...(tag ? [{ text: tag, state: STATE.warn, drop: 1 }] : []),
  ];
}

/**
 * @param {{ segment: object | null, nowMs: number, timeZone: string, trend?: object | null,
 *   roadShown?: boolean }} view the shown cache entry, now and the render's one zone; trend: the finish clock's
 *   move as a part (stat-rows.mjs trendPart); roadShown: the road row carries the step, so this row does not
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} row 1, fitted to look.columns
 */
export function workRow({ segment, nowMs, timeZone, trend = null, roadShown = false }, look) {
  const [first, ...rest] = jobParts(jobView(segment), { nowMs, timeZone, roadShown }, look, trend).filter((part) => part.text !== '');
  return fitParts([...(first ? [boldAll(first)] : []), ...rest], look);
}

/** The row's first part with its `ALL` label in bold (spec-tui-3: each row kind leads with its label) and the rest in its state. */
function boldAll(part) {
  if (!part.text.startsWith(ALL_LABEL)) return part;
  return { ...part, spans: [{ text: ALL_LABEL, state: STATE.strong }, { text: part.text.slice(ALL_LABEL.length), state: part.state }] };
}
