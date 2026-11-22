// The job row of the status line (owner decision RC6, 2026-11-22: the bar and the time left count live work only): the live road's
// current step, else the started rows, with the whole backlog left to `/where`.
//   ALL    ███░░░░░░░  40 min left · by 11:10 · +1h10 later                       road final 2/4 · 2/5 lanes   (a live road)
//   ALL    ██░░░░░░░░  18%  1 h 26 left · by 11:10 · 2 rows started                                          (started rows)
//   ALL    nothing started · 30 rows open                                                                     (no live work)
// Exports: jobView(segment) -> view | null; liveWork(view, numbers, facts, nowMs) -> live | null; workRow({ segment, facts, nowMs,
// timeZone, trend, road }, look) -> string; WIDE_COLUMNS.
// Sources (all checked here, never trusted: they are printed): the estimate cache's shown entry (segment-cache.mjs estimateSegment:
// kind, text, highMs, progress with its numbers-only `road`, numbers with the open rows' expected minutes and starts) and the
// board's road facts (job-facts.mjs: `live` false when no row of the current step started or finished this session).
// Rules: a live road gives the step's rows done of all, its time left and clocks (no percent: a row count is not work done, audit
// case 8); else the started open rows (a hidden road's rows left out) give the share of their expected minutes earned (elapsed, at
// most RUNNING_CREDIT of each, the estimate's progress.mjs rule), the minutes left and `N min over plan` (yellow) past a row's
// expected minutes; else `nothing started` and the open rows as a dim count. A refusal, an error, a hand-over, a long job and all
// rows done keep their words (an error in red). The bar is in the default colour (RC5: colour only for a state); the `ALL` label
// and the clocks are dim; the finish clock's move (stat-rows.mjs trendPart) is yellow when later. No STATUS.md linked: `no job linked`.
// Invariants: pure (no I/O); every clock in the one zone given (case 12); the row fits look.columns (cells.mjs fitParts).
import { barText, clockOf, cleanText, durationText, fitParts, STATE } from './cells.mjs';
import { ROAD_ROW } from '../../estimate/lib/road-steps.mjs';

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
/** The label column every status line row starts with (`ALL`, `agents`, `git`) on a wide row, so the values line up; a narrower row
 * keeps the room for its values (the label and one blank). */
export const LABEL_COLUMNS = 6;
const ALL_LABEL = 'ALL';
/** An open row earns at most this share of its expected minutes (tools/estimate/lib/progress.mjs RUNNING_CREDIT, not exported there). */
const RUNNING_CREDIT = 0.9;

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
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** True when the board's facts say the road is idle this session (an old board without `live` counts as live). */
const idleRoad = (facts, name) => facts !== null && typeof facts === 'object' && facts.live === false && (name === undefined || facts.name === name);

/** The started open rows' share earned, minutes left and minutes over their expected time; null when none is started. */
function startedWork(numbers, hiddenRoad, nowMs) {
  const rows = (Array.isArray(numbers?.rows) ? numbers.rows : []).filter((row) => isNumber(row?.startedMs) && isNumber(row.expectMin)
    && row.expectMin > 0 && (hiddenRoad === null || ROAD_ROW.exec(String(row.id))?.[1]?.toLowerCase() !== hiddenRoad));
  if (rows.length === 0) return null;
  let expect = 0;
  let earned = 0;
  let overMin = 0;
  for (const row of rows) {
    const elapsed = Math.max(0, (nowMs - row.startedMs) / MS_PER_MIN);
    expect += row.expectMin;
    earned += Math.min(RUNNING_CREDIT * row.expectMin, elapsed);
    overMin += Math.max(0, elapsed - row.expectMin);
  }
  return { kind: 'started', count: rows.length, share: earned / expect, leftMin: expect - earned, overMin, clockMs: nowMs + (expect - earned) * MS_PER_MIN };
}

/**
 * The live work the row counts (RC6).
 * @param {ReturnType<typeof jobView>} view the job
 * @param {object | null} numbers the cache entry's numbers (open rows with expectMin and startedMs)
 * @param {object | null} facts board.road (job-facts.mjs), or null
 * @param {number} nowMs now
 * @returns {null | { kind: 'road', share: number, rowsDone: number, rowsTotal: number, leftMin: number | null, clockMs: number | null,
 *   p85Ms: number | null } | { kind: 'started', count: number, share: number, leftMin: number, overMin: number, clockMs: number }}
 *   the live road's step, else the started rows, else null
 */
export function liveWork(view, numbers, facts, nowMs) {
  const road = view?.road ?? null;
  const hidden = road !== null && idleRoad(facts, road.name);
  if (road !== null && !hidden && road.rowsTotal > 0) {
    return { kind: 'road', share: road.rowsDone / road.rowsTotal, rowsDone: road.rowsDone, rowsTotal: road.rowsTotal, leftMin: isNumber(road.leftMin) ? road.leftMin : null, clockMs: road.clockMs, p85Ms: road.p85Ms };
  }
  return startedWork(numbers, hidden ? String(road.name).toLowerCase() : null, nowMs);
}

/** The bar of the live work: in the default colour, red over its plan. */
const barOf = (share, look) => barText({ done: share }, cellsFor(look), look);

/** The parts of a live road step: its bar, its time left and clocks. */
function roadStepParts(live, clock, look) {
  const parts = [{ text: barOf(live.share, look) }];
  if (live.leftMin !== null) parts.push({ text: `${durationText(live.leftMin)} left`, join: '  ' });
  if (live.clockMs !== null) parts.push({ text: `by ${clockOf(live.clockMs, clock.nowMs, clock.timeZone)}`, state: STATE.dim });
  if (live.p85Ms !== null) parts.push({ text: `85% ${clockOf(live.p85Ms, clock.nowMs, clock.timeZone)}`, state: STATE.dim, drop: 5 });
  return parts;
}

/** The parts of the started rows: bar and percent of their expected minutes, time left, clock, over plan, how many. */
function startedParts(live, clock, look) {
  const pct = Math.min(CAP_WHILE_OPEN, Math.floor(PERCENT * live.share));
  return [
    { text: `${barOf(live.share, look)}  ${pct}%` }, { text: `${durationText(live.leftMin)} left`, join: '  ' },
    { text: `by ${clockOf(live.clockMs, clock.nowMs, clock.timeZone)}`, state: STATE.dim },
    ...(live.overMin >= 1 ? [{ text: `${durationText(live.overMin)} over plan`, state: STATE.warn, drop: 1 }] : []),
    { text: `${plural(live.count, 'row')} started`, state: STATE.dim, drop: 2 },
  ];
}

/** The words of an estimate error: `estimate: table error at row A17` (segment-text.mjs errorSegment), never a finish. */
function errorWords(cause, look) {
  const words = cause.startsWith('row ') ? `table error at ${cause}` : cause === 'table' ? 'table error' : cause || 'error';
  return { text: `estimate: ${cleanText(words, look)}`, state: STATE.block };
}

/** The job's own words when it has no live work to count, or a state that says more (an error, a refusal, all done). */
function jobWords(view, look) {
  if (view === null) return [{ text: 'no job linked' }];
  if (view.kind === 'handed-over') return [{ text: `idle${look.glyph.sep}last job ${cleanText(view.text, look)}` }];
  const cause = view.text.replace(/^done \? /, '');
  if (view.kind === 'error') return [errorWords(cause, look)];
  if (view.rowsTotal > 0 && view.rowsDone === view.rowsTotal) return [{ text: `all ${view.rowsTotal} rows done` }];
  if (view.kind === 'refused') return [{ text: `no time: ${REFUSAL_WHY[cause] ?? cleanText(cause, look)}` }];
  if (view.kind === 'work-left') return [{ text: `long job: ${cleanText(view.text, look)}` }];
  return null;
}

/**
 * @param {{ segment: object | null, facts?: object | null, nowMs: number, timeZone: string, trend?: object | null,
 *   road?: object | null }} input the shown cache entry, the board's road facts, now and the render's one zone; trend: the finish
 *   clock's move as a part (stat-rows.mjs trendPart); road: the compact road part (stat-rows.mjs roadPart), right-aligned
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string} the job row, fitted to look.columns
 */
export function workRow({ segment, facts = null, nowMs, timeZone, trend = null, road = null }, look) {
  const view = jobView(segment);
  const clock = { nowMs, timeZone };
  const live = view === null ? null : liveWork(view, segment?.numbers ?? null, facts, nowMs);
  const words = jobWords(view, look);
  let body;
  if (words !== null) body = words;
  else if (live?.kind === 'road') body = [...roadStepParts(live, clock, look), ...(trend ? [trend] : [])];
  else if (live?.kind === 'started') body = [...startedParts(live, clock, look), ...(trend ? [trend] : [])];
  else body = [{ text: 'nothing started' }, ...(view.rowsTotal > view.rowsDone ? [{ text: `${view.rowsTotal - view.rowsDone} rows open`, state: STATE.dim, drop: 2 }] : [])];
  const [first, ...rest] = body;
  return fitParts([labelled(ALL_LABEL, first, look), ...rest, ...(road ? [road] : [])], look);
}

/**
 * @param {string} label `ALL`, `agents` or `git`
 * @param {{ text: string, state?: string, drop?: number }} part the row's first value
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal (the label column only on a wide row)
 * @returns {object} the part with the dim label before it (LABEL_COLUMNS wide on a wide row, then a blank), its value in its own state
 */
export function labelled(label, part, look) {
  const head = `${wide(look) ? label.padEnd(LABEL_COLUMNS) : label} `;
  return { ...part, text: `${head}${part.text}`, spans: [{ text: head, state: STATE.dim }, { text: part.text, state: part.state }] };
}
