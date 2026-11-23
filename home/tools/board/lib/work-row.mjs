// The job and now rows of the status line (spec R18, owner decisions RC16 and RC18 of 2026-11-22: one row for the whole job, one
// for the current step or the running rows; every number says what it is for), at 100 columns (95 usable):
//   job     ████░░░░ 6/10 rows done · 2 h 10 work left · done by 21:40, 25 min late: 3 rows added
//   now     step 2 of 4 git rows · ██░░░░ 1/3 lanes landed · 40 min work left · step done by 19:55      (a live road)
//   now     2 rows running · 25 min work left · by 20:05 · R18.git 25 min over usual                      (no live road)
// From 115 usable columns the long words (`6 of 10 rows done · about 2 h 10 of work left · done by 21:40 · late by 25 min (3 rows
// added)`), below 90 the short ones (`2 h 10 left`, `step 2/4`, `1/3 lanes`, `step by`) and no label column.
// Exports: jobView(segment) -> view | null; jobRow(view, look) -> string | null; nowRow(view, look) -> string | null;
// labelled(label, part, look); WIDE_COLUMNS, LABEL_FROM_COLUMNS, LABEL_COLUMNS.
// Sources (all checked here, never trusted: they are printed): the estimate cache's shown entry (segment-cache.mjs estimateSegment:
// kind, text, highMs, progress with its numbers-only `road`, numbers: rowsDone, rowsTotal, leftMin, finishMs, p85Ms, lateMin,
// lateCause and the open rows with expectMin, leftMin and startedMs) and the board's road facts (job-facts.mjs: title, lanes landed
// of all, `live` false when no row of the current step started or finished this session).
// Rules (spec R18 "Estimate semantics"): the job row shows only with live work (a started row or a live road), an estimate error or
// a refusal; `nothing started` and the open rows are `/where`'s. Its bar is the job's rows done of all, its time the median work
// left on the open rows (not clock time), its clock the committed finish. `late` only from numbers.lateMin (10 min or more over
// the first budget) with the latest later cause; red once the overrun is past the job's 85 % margin (the minutes between the
// median finish and the 85 % one), else yellow. The now row is the live road's current step (its lanes landed of all, else its
// rows, its work left and clock), else the started rows (each row's own median minutes left, E3; a row past its size's median is
// `over usual`, yellow). A road whose facts say `live: false` is hidden and its rows are not counted; an old board without `live`
// counts as live. Old cache entries without the R18 fields still draw (finish from highMs, a row's left from its expected minutes).
// Model s1 (estimate-spec section 7): an entry whose numbers carry a valid `v2` (range-rows.mjs rangeNumbers) draws the job row
// and the step's now row from it (likely–80% ranges, the promise, pauses, waits, parked: range-rows.mjs); without v2 (a rolled-back
// estimator, an old entry) or with a malformed one the R18 rows above are drawn (F2). The running-rows now row is the same for
// both: v2 carries no per-row range. In an s1 entry the R18 `p85Ms` holds the 80% clock; no row prints a confidence.
// Colour (cells.mjs, RC14): bars and their counts `bar`, durations and clocks `time`, labels and separators dim, words default.
// Invariants: pure (no I/O); every clock in the one zone given (case 12); every row fits look.columns (cells.mjs fitParts).
import { clockOf, cleanText, cutWords, durationText, fitParts, STATE } from './cells.mjs';
import { barPart, rangeJobParts, rangeNumbers, rangeStepParts, ROW_ID_CHARS } from './range-rows.mjs';
import { ROAD_ROW } from '../../estimate/lib/road-steps.mjs';

/** From this usable width the rows take their long words: a 120-column terminal gives 115 (COLUMNS - 5, research-tui 1.1). */
export const WIDE_COLUMNS = 115;
/** From this usable width every row leads with a LABEL_COLUMNS-wide dim label (100 columns give 95); below it the label and a blank. */
export const LABEL_FROM_COLUMNS = 90;
export const LABEL_COLUMNS = 8;
const JOB_CELLS = { wide: 16, normal: 8, narrow: 6 };
const STEP_CELLS = { wide: 6, normal: 6, narrow: 3 };
const TITLE_CHARS = { wide: 40, normal: 24, narrow: 16 };
const NAMES_SHOWN = 2;
const MS_PER_MIN = 60_000;
const OVER_SHOWN_MIN = 1;
const REFUSAL_WHY = { 'no rows': 'no rows yet', 'few rows': 'too few finished rows', 'rows listed late': 'rows listed late' };

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** @returns {'wide' | 'normal' | 'narrow'} the word form of a row at this width */
const tierOf = (look) => (look.columns >= WIDE_COLUMNS ? 'wide' : look.columns >= LABEL_FROM_COLUMNS ? 'normal' : 'narrow');

/** The road numbers of progress.road (road-steps.mjs withRoad), or null when absent or not that shape. */
function roadOf(road) {
  const ok = road !== null && typeof road === 'object' && isCount(road.step) && isCount(road.steps) && road.step >= 1
    && road.step <= road.steps && isCount(road.rowsDone) && isCount(road.rowsTotal);
  if (!ok) return null;
  return { ...road, clockMs: isNumber(road.clockMs) ? road.clockMs : null, p85Ms: isNumber(road.p85Ms) ? road.p85Ms : null };
}

/** The late cause as the cache stores it ({ cause, ids, count }), or null when absent or not that shape. */
const causeOf = (cause) => (cause !== null && typeof cause === 'object' && typeof cause.cause === 'string' && Array.isArray(cause.ids) ? cause : null);

/**
 * The job as the rows need it, from the cache's numbers when they are there, else from the stored progress.
 * @param {{ kind: string | null, text: string | null, highMs: number | null, progress: object | null, numbers: object | null } | null} segment
 * @returns {null | { kind: string, text: string, pct: number | null, rowsDone: number, rowsTotal: number, leftMin: number | null,
 *   workedMin: number | null, highMs: number | null, finishMs: number | null, p85Ms: number | null, lateMin: number | null,
 *   lateCause: object | null, tag: string | null, road: object | null }} null when no job is linked; finishMs the committed finish
 *   (numbers.finishMs, else the entry's highMs), p85Ms the job's 85 % finish clock (job-rows.mjs numbers)
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
  if (workedMin !== null && leftMin !== null && workedMin + leftMin > 0) pct = Math.floor((100 * workedMin) / (workedMin + leftMin));
  if (pct !== null && rowsTotal > 0 && rowsDone < rowsTotal) pct = Math.min(99, pct);
  const highMs = isNumber(segment.highMs) ? segment.highMs : null;
  return {
    kind: segment.kind ?? 'finish', text: typeof segment.text === 'string' ? segment.text : '', pct, rowsDone, rowsTotal, leftMin, workedMin,
    highMs, finishMs: isNumber(numbers?.finishMs) ? numbers.finishMs : highMs, p85Ms: isNumber(numbers?.p85Ms) ? numbers.p85Ms : null,
    lateMin: isNumber(numbers?.lateMin) ? numbers.lateMin : null, lateCause: causeOf(numbers?.lateCause ?? null),
    tag: progress?.tag ?? null, road: roadOf(progress?.road),
  };
}

/** True when the board's facts say the road is idle this session (an old board without `live` counts as live). */
const idleRoad = (facts, name) => facts !== null && typeof facts === 'object' && facts.live === false && (name === undefined || facts.name === name);

/** The started open rows (a hidden road's rows left out), each with its median minutes left and its minutes past its size's median. */
function startedRows(numbers, hiddenRoad, nowMs) {
  return (Array.isArray(numbers?.rows) ? numbers.rows : []).filter((row) => isNumber(row?.startedMs) && isNumber(row.expectMin)
    && row.expectMin > 0 && (hiddenRoad === null || ROAD_ROW.exec(String(row.id))?.[1]?.toLowerCase() !== hiddenRoad))
    .map((row) => {
      const elapsed = Math.max(0, (nowMs - row.startedMs) / MS_PER_MIN);
      // an old cache entry has no leftMin per row: its expected minutes less the elapsed ones
      const leftMin = isNumber(row.leftMin) && row.leftMin >= 0 ? row.leftMin : Math.max(0, row.expectMin - elapsed);
      return { id: String(row.id ?? '?'), leftMin, overMin: Math.max(0, elapsed - row.expectMin) };
    });
}

/**
 * The live work of the job: the live road's current step (s1's v2.step when `range` is given, else progress.road), else the
 * started rows, else null.
 * @returns {null | { kind: 'road', road: object } | { kind: 'started', rows: { id: string, leftMin: number, overMin: number }[] }}
 */
function liveWork(job, range, numbers, facts, nowMs) {
  const road = range === null ? job.road : range.step;
  const name = range === null ? road?.name : road?.road;
  const hidden = road !== null && idleRoad(facts, name);
  if (road !== null && !hidden && (range !== null || road.rowsTotal > 0)) return { kind: 'road', road };
  const rows = startedRows(numbers, hidden ? String(name).toLowerCase() : null, nowMs);
  return rows.length > 0 ? { kind: 'started', rows } : null;
}

/** A part of a duration and its words: `2 h 10` in the time colour, then ` work left` (or the tier's words) in the default colour. */
function leftPart(minutes, tier) {
  const amount = durationText(minutes);
  const before = tier === 'wide' ? 'about ' : '';
  const after = { wide: ' of work left', normal: ' work left', narrow: ' left' }[tier];
  return { text: `${before}${amount}${after}`, spans: [{ text: before }, { text: amount, state: STATE.time }, { text: after }] };
}

/** A clock with its words before it: `done by ` then `21:40` in the time colour. */
const clockPart = (words, ms, clock, state = STATE.ok) => {
  const at = clockOf(ms, clock.nowMs, clock.timeZone);
  return { text: `${words}${at}`, spans: [{ text: words, state }, { text: at, state: state === STATE.ok ? STATE.time : state }] };
};

/** The words of the late cause: `3 rows added`, `R18.git slow`, `slower pace`; '' when unknown. */
function causeText(cause, look) {
  if (cause === null) return '';
  const count = isCount(cause.count) ? cause.count : cause.ids.length;
  if (cause.cause === 'rows-added') return `${plural(count, 'row')} added`;
  if (cause.cause === 'slow-row' && cause.ids.length > 0) return `${cutWords(cleanText(cause.ids[0], look), ROW_ID_CHARS, look)} slow`;
  return cause.cause === 'pace' ? 'slower pace' : '';
}

/** The late parts: `, 25 min late` and `: 3 rows added` (wide: ` · late by 25 min (3 rows added)`); red past the 85 % margin. */
function lateParts(job, clock, tier, look) {
  if (job.lateMin === null || job.lateMin <= 0) return [];
  const marginMin = job.p85Ms !== null && job.leftMin !== null ? (job.p85Ms - clock.nowMs) / MS_PER_MIN - job.leftMin : null;
  const state = marginMin !== null && job.lateMin > marginMin ? STATE.block : STATE.warn;
  const late = durationText(job.lateMin);
  const why = causeText(job.lateCause, look);
  if (tier === 'wide') {
    return [{ text: `late by ${late}`, state }, ...(why ? [{ text: `(${why})`, state, join: ' ', drop: 1 }] : [])];
  }
  return [{ text: `, ${late} late`, state, join: '' }, ...(why ? [{ text: `: ${why}`, state, join: '', drop: 1 }] : [])];
}

/** The job's own words for an error or a refusal; null for any other kind. */
function jobWords(job, look) {
  const cause = job.text.replace(/^done \? /, '');
  if (job.kind === 'error') {
    const words = cause.startsWith('row ') ? `table error at ${cause}` : cause === 'table' ? 'table error' : cause || 'error';
    return { text: `estimate: ${cleanText(words, look)}`, state: STATE.block };
  }
  if (job.kind === 'refused') return { text: `no time: ${REFUSAL_WHY[cause] ?? cleanText(cause, look)}` };
  if (job.kind === 'work-left') return { text: `long job, ${cleanText(job.text, look)}` };
  return null;
}

/** The parts of the job row with a finish: the bar and rows done, the work left, the committed clock and how late. */
function finishParts(job, clock, tier, look) {
  const count = tier === 'wide' ? `${job.rowsDone} of ${job.rowsTotal} rows done` : `${job.rowsDone}/${job.rowsTotal} rows done`;
  const parts = [barPart(job.rowsTotal > 0 ? job.rowsDone / job.rowsTotal : 0, JOB_CELLS[tier], count, look, tier === 'wide' ? '  ' : ' ')];
  if (job.leftMin !== null) parts.push(leftPart(job.leftMin, tier));
  if (job.finishMs !== null) {
    parts.push(job.finishMs < clock.nowMs ? clockPart('was due ', job.finishMs, clock, STATE.block) : clockPart('done by ', job.finishMs, clock));
  }
  return [...parts, ...lateParts(job, clock, tier, look)];
}

/**
 * The job row: the whole job's rows done, work left and committed finish, and how late it runs and why.
 * @param {{ segment: object | null, board?: object | null, nowMs: number, timeZone: string }} view the shown cache entry, the
 *   board (its road facts), now and the render's one zone
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string | null} the row; null without live work, an error or a refusal (the open rows are `/where`'s)
 */
export function jobRow({ segment, board = null, nowMs, timeZone }, look) {
  const job = jobView(segment);
  if (job === null) return null;
  const clock = { nowMs, timeZone };
  const tier = tierOf(look);
  const words = jobWords(job, look);
  if (job.kind === 'error') return fitParts([labelled('job', words, look)], look);
  if (words !== null) {
    const count = `${job.rowsDone}/${job.rowsTotal} rows done`;
    return fitParts([labelled('job', barPart(job.rowsTotal > 0 ? job.rowsDone / job.rowsTotal : 0, JOB_CELLS[tier], count, look), look), words], look);
  }
  const range = rangeNumbers(segment.numbers);
  if (liveWork(job, range, segment.numbers ?? null, board?.road ?? null, nowMs) === null) return null;
  const [first, ...rest] = range === null ? finishParts(job, clock, tier, look) : rangeJobParts(job, { v2: range, clock, tier }, afterLabel('job', look));
  return fitParts([labelled('job', first, look), ...rest], look);
}

/** The facts of the road the numbers name, or null. */
const factsOf = (road, facts) => (facts !== null && typeof facts === 'object' && (facts.name === undefined || facts.name === road.name) ? facts : null);

/** The now row of a live road: the step and its title, lanes landed (else rows done) of the step, its work left and clock. */
function stepParts(road, facts, clock, tier, look) {
  const own = factsOf(road, facts);
  const step = tier === 'narrow' ? `step ${road.step}/${road.steps}` : `step ${road.step} of ${road.steps}`;
  const title = own?.title ? cutWords(cleanText(own.title, look), TITLE_CHARS[tier], look) : '';
  const lanes = isCount(own?.lanesTotal) && own.lanesTotal > 0 && isCount(own.lanesDone);
  const [done, total, what] = lanes ? [own.lanesDone, own.lanesTotal, 'lanes'] : [road.rowsDone, road.rowsTotal, 'rows'];
  const verb = lanes ? 'landed' : 'done';
  const count = tier === 'wide' ? `${done} of ${total} ${what} ${verb}` : tier === 'normal' ? `${done}/${total} ${what} ${verb}` : `${done}/${total} ${what}`;
  return [
    { text: step }, { text: title, join: ' ', drop: 3 }, barPart(total > 0 ? done / total : 0, STEP_CELLS[tier], count, look),
    isNumber(road.leftMin) ? leftPart(road.leftMin, tier) : { text: '' },
    road.clockMs !== null ? clockPart(tier === 'narrow' ? 'step by ' : 'step done by ', road.clockMs, clock) : { text: '' },
  ];
}

/** The now row of the started rows: how many (names when room), their work left, the clock it ends at, the row most over usual. */
function runningParts(rows, clock, tier, look) {
  const leftMin = rows.reduce((sum, row) => sum + row.leftMin, 0);
  const names = rows.slice(0, NAMES_SHOWN).map((row) => cutWords(cleanText(row.id, look), ROW_ID_CHARS, look));
  const more = rows.length > NAMES_SHOWN ? `, +${rows.length - NAMES_SHOWN}` : '';
  const over = rows.filter((row) => row.overMin >= OVER_SHOWN_MIN).sort((a, b) => b.overMin - a.overMin);
  const worst = over[0];
  return [
    { text: `${plural(rows.length, 'row')} running` }, { text: `: ${names.join(', ')}${more}`, join: '', drop: 2 },
    leftPart(leftMin, tier), clockPart('by ', clock.nowMs + leftMin * MS_PER_MIN, clock),
    ...(worst ? [{ text: `${cutWords(cleanText(worst.id, look), ROW_ID_CHARS, look)} ${durationText(worst.overMin)} over usual`, state: STATE.warn }] : []),
    ...(over.length > 1 ? [{ text: `+${over.length - 1} more over usual`, state: STATE.warn, drop: 1 }] : []),
  ];
}

/**
 * The now row: the live road's current step, else the started rows.
 * @param {{ segment: object | null, board?: object | null, nowMs: number, timeZone: string }} view as jobRow takes it
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal
 * @returns {string | null} the row; null without live work
 */
export function nowRow({ segment, board = null, nowMs, timeZone }, look) {
  const job = jobView(segment);
  if (job === null || job.kind === 'error') return null;
  const range = rangeNumbers(segment.numbers);
  const live = liveWork(job, range, segment.numbers ?? null, board?.road ?? null, nowMs);
  if (live === null) return null;
  // every open row running and none over usual: the job row already says it all (spec R18 mockup `outside a repo`)
  const sameAsJob = live.kind === 'started' && live.rows.length === job.rowsTotal - job.rowsDone && live.rows.every((row) => row.overMin < OVER_SHOWN_MIN);
  if (sameAsJob) return null;
  const clock = { nowMs, timeZone };
  const tier = tierOf(look);
  const facts = board?.road ?? null;
  const road = () => (range === null ? stepParts(live.road, facts, clock, tier, look) : rangeNow(live.road, { job, facts, clock, tier }, look));
  const [first, ...rest] = live.kind === 'road' ? road() : runningParts(live.rows, clock, tier, look);
  return fitParts([labelled('now', first, look), ...rest], look);
}

/** The now row's parts for s1's current step: its title from the board's facts, its rows when it has no lanes (progress.road). */
function rangeNow(step, { job, facts, clock, tier }, look) {
  const own = factsOf({ name: step.road }, facts);
  const title = own?.title ? cutWords(cleanText(own.title, look), TITLE_CHARS[tier], look) : '';
  const rows = job.road?.name === step.road ? { done: job.road.rowsDone, total: job.road.rowsTotal } : null;
  return rangeStepParts(step, { title, rows, clock, tier }, afterLabel('now', look));
}

/** The label column a row starts with: LABEL_COLUMNS wide from LABEL_FROM_COLUMNS, else the label and a blank. */
const labelHead = (label, look) => (look.columns >= LABEL_FROM_COLUMNS ? label.padEnd(LABEL_COLUMNS) : `${label} `);
/** The look with the columns left after a row's label (range-rows.mjs fits its parts to them). */
const afterLabel = (label, look) => ({ ...look, columns: look.columns - labelHead(label, look).length });

/**
 * @param {string} label `job`, `now`, `agents`, `git`, `lanes` or `session`
 * @param {{ text: string, state?: string, drop?: number, spans?: object[] }} part the row's first value
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal (the label column from LABEL_FROM_COLUMNS)
 * @returns {object} the part with the dim label before it (LABEL_COLUMNS wide from LABEL_FROM_COLUMNS, else the label and a blank),
 *   its value keeping its own spans or state
 */
export function labelled(label, part, look) {
  const head = labelHead(label, look);
  const value = Array.isArray(part.spans) ? part.spans : [{ text: part.text, state: part.state }];
  return { ...part, text: `${head}${part.text}`, spans: [{ text: head, state: STATE.dim }, ...value] };
}
