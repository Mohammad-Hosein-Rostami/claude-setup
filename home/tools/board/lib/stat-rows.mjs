// The road and trend parts of the status line and `/where` (spec-tui-2 stats 1, 2 and 4, and the trend of "Seen in the screenshot"):
//   road p8 · step 1/12 unhook settings · 2/5 lanes · step 40 min left · by 21:10          (roadRow: `/where`'s road row)
//   road final 2/4 · 2/5 lanes                                                           (roadPart: the status line's job row, right)
//   ↑ +1h10 later / ↓ -20m sooner                                                       (trendPart: the finish clock's last move)
// Exports: roadRow(numbers, facts, clock, look) -> string | null; roadPart(numbers, facts, clock, look) -> part | null;
// trendPart(trend, look) -> part | null; shortDuration(minutes).
// Sources: numbers = work-row.mjs jobView(...).road (the estimate cache's progress.road: id, step, steps, rows, leftMin, clocks);
// facts = board.road (job-facts.mjs: goal, the step's title, lanes landed of all, `live`).
// Stale roads (F7): a road whose facts say `live: false` (no row of its current step started or finished this session) is not on the
// status line (roadPart null) and reads `idle` in `/where`; facts without `live` (an old board file) count as live.
// Colour (cells.mjs, RC5): the `road` label dim on the line; the active step cyan in `/where`; a later finish yellow; landed lanes
// and a sooner finish in the default colour; every state has its word (`later`, `sooner`, `idle`).
// Invariants: pure (no I/O); every outside text goes through cleanText; every row fits look.columns; a row with nothing to say is null.
import { clockOf, cleanText, cutWords, durationText, fitParts, STATE } from './cells.mjs';
import { WIDE_COLUMNS } from './work-row.mjs';

const MIN_PER_HOUR = 60;
const TITLE_CHARS = 24;
const WIDE_TITLE_CHARS = 40;
const GOAL_CHARS = 40;
const ROAD_NAME_CHARS = 16;
const ARROWS = { later: '↑', sooner: '↓' };
const ASCII_ARROWS = { later: '^', sooner: 'v' };

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const wide = (look) => look.columns >= WIDE_COLUMNS;

/** @returns {string} `20m`, `1h10`: the short form of a duration (the trend and narrow rows) */
export function shortDuration(minutes) {
  const min = Math.max(0, Math.round(Math.abs(minutes)));
  return min < MIN_PER_HOUR ? `${min}m` : `${Math.floor(min / MIN_PER_HOUR)}h${String(min % MIN_PER_HOUR).padStart(2, '0')}`;
}

/**
 * @param {{ deltaMin: number } | null} trend the finish clock's last move (board.trend)
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {{ text: string, state: string, drop: number } | null} `↑ +1h10 later` (yellow) or `↓ -20m sooner` (no colour); null for none
 */
export function trendPart(trend, look) {
  if (!isNumber(trend?.deltaMin) || trend.deltaMin === 0) return null;
  const arrows = look.ascii ? ASCII_ARROWS : ARROWS;
  const later = trend.deltaMin > 0;
  const amount = `${later ? '+' : '-'}${shortDuration(trend.deltaMin)}`;
  return { text: `${later ? arrows.later : arrows.sooner} ${amount} ${later ? 'later' : 'sooner'}`, state: later ? STATE.warn : STATE.done, drop: 1 };
}

/** The step part: `step 1/12 unhook settings`. */
function stepText(step, steps, title, look) {
  const of = isCount(steps) && steps > 0 ? `/${steps}` : '';
  const named = title ? ` ${cutWords(cleanText(title, look), wide(look) ? WIDE_TITLE_CHARS : TITLE_CHARS, look)}` : '';
  return `step ${step}${of}${named}`;
}

/** Lanes landed of all from the road file, else the step's rows done of all from the estimate. */
function lanesPart(numbers, facts) {
  if (isCount(facts?.lanesTotal) && facts.lanesTotal > 0 && isCount(facts.lanesDone)) {
    return { text: `${facts.lanesDone}/${facts.lanesTotal} lanes`, state: facts.lanesDone >= facts.lanesTotal ? STATE.done : STATE.ok, drop: 1 };
  }
  if (isCount(numbers?.rowsTotal) && numbers.rowsTotal > 0 && isCount(numbers.rowsDone)) return { text: `${numbers.rowsDone}/${numbers.rowsTotal} rows`, drop: 1 };
  return null;
}

/** The step's time left and its clocks. */
function stepTimeParts(numbers, clock, look) {
  if (!isNumber(numbers?.leftMin)) return [];
  const parts = [{ text: `step ${wide(look) ? durationText(numbers.leftMin) : shortDuration(numbers.leftMin)} left` }];
  if (isNumber(numbers.clockMs)) parts.push({ text: `by ${clockOf(numbers.clockMs, clock.nowMs, clock.timeZone)}`, state: STATE.dim, drop: 2 });
  if (isNumber(numbers.p85Ms) && wide(look)) parts.push({ text: `85%: ${clockOf(numbers.p85Ms, clock.nowMs, clock.timeZone)}`, state: STATE.dim, drop: 4 });
  return parts;
}

/** The facts of the road the numbers name (facts naming another road are not this road's), or null. */
const factsOf = (numbers, facts) => (facts !== null && typeof facts === 'object' && (numbers === null || numbers?.name === undefined || facts.name === numbers.name) ? facts : null);

/**
 * The compact road part of the status line's job row: `road final 2/4 · 2/5 lanes`, right-aligned, the label dim.
 * @param {object | null} numbers jobView(segment).road (the estimate's numbers), or null
 * @param {object | null} facts board.road (job-facts.mjs), or null
 * @param {{ nowMs: number, timeZone: string }} clock now and the render's one zone (unused: the job row carries the clocks)
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {{ text: string, spans: object[], right: true, drop: number } | null} null without a road or for an idle one
 */
export function roadPart(numbers, facts, clock, look) {
  const own = factsOf(numbers, facts);
  if (own?.live === false) return null;
  const name = typeof numbers?.name === 'string' ? numbers.name : own?.name;
  const step = isCount(numbers?.step) ? numbers.step : own?.step;
  if (typeof name !== 'string' || !isCount(step) || step < 1) return null;
  const steps = numbers?.steps ?? own?.steps;
  const lanes = lanesPart(numbers, own);
  const rest = ` ${cleanText(name, look).slice(0, ROAD_NAME_CHARS)} ${step}${isCount(steps) && steps > 0 ? `/${steps}` : ''}${lanes ? `${look.glyph.sep}${lanes.text}` : ''}`;
  return { text: `road${rest}`, spans: [{ text: 'road', state: STATE.dim }, { text: rest }], right: true, drop: 3 };
}

/**
 * The road row: the road, its current step with its title, lanes landed of all, the step's time left and finish clock.
 * @param {object | null} numbers jobView(segment).road (the estimate's numbers), or null
 * @param {object | null} facts board.road (job-facts.mjs), or null; used only when it names the same road
 * @param {{ nowMs: number, timeZone: string }} clock now and the render's one zone
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string | null} the row (`idle` after the name when facts say no row of the step moved this session), or null when the
 *   job walks no road
 */
export function roadRow(numbers, facts, clock, look) {
  const own = factsOf(numbers, facts);
  const name = typeof numbers?.name === 'string' ? numbers.name : own?.name;
  const step = isCount(numbers?.step) ? numbers.step : own?.step;
  if (typeof name !== 'string' || !isCount(step) || step < 1) return null;
  return fitParts([
    { text: `road ${cleanText(name, look).slice(0, ROAD_NAME_CHARS)}`, state: STATE.road },
    own?.live === false ? { text: 'idle', state: STATE.dim } : null,
    { text: stepText(step, numbers?.steps ?? own?.steps, own?.title, look), state: own?.live === false ? STATE.ok : STATE.run },
    lanesPart(numbers, own), ...stepTimeParts(numbers, clock, look),
    own?.goal && wide(look) ? { text: cutWords(cleanText(own.goal, look), GOAL_CHARS, look), state: STATE.dim, drop: 6 } : null,
  ].filter(Boolean), look);
}
