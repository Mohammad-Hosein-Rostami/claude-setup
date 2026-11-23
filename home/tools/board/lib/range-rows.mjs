// The job and now rows of model s1 (estimate-spec section 7), drawn from the cache's `numbers.v2` (estimate job-rows.mjs
// jobNumbers): the likely–80% ranges of the job's work and finish and of the current step, the job's one promise (on time, later
// or earlier, and why), how far pauses moved it, the rows waiting for the owner and the rows parked. At 100 columns (95 usable):
//   job     █████████░ 44/45 rows · 2 h 57–3 h 28 work left · done 12:50–13:20 if no pause · 42 parked
//   now     step 13 of 14 · █████ 5/5 lanes landed · 55 min–2 h 59 left · step done 10:45–12:50
// From 115 usable columns the long words (`44 of 45 rows done · 2 h 57–3 h 28 of work left · done 12:50–13:20 if nothing pauses ·
// 42 rows parked`), below 90 the short ones (`44/45 · 2 h 57–3 h 28 · 12:50–13:20`, `step 13/14 · 5/5 · 55 min–2 h 59 · 10:45–12:50`)
// without waits and parked. The job bar counts rows: the cache carries the job's rows done of all, not its lanes.
// Promise (E2, E3): ` · on time for 13:20`, ` · 25 min later than promised 13:20: 3 rows added`, ` · 30 min earlier than promised
// 13:50`, then ` · moved 1 h 20 by pauses: waiting for you 40 min, no activity 40 min` from 5 min of pauses; the promised clock is
// the one the pauses moved it to (the short words leave a later or earlier promise's clock out). Under LATE_MIN either way is on
// time (the CLI's rule).
// Fit (F1, F4): numbers are never cut at 80, 100 or 150 columns. Parked leaves first, then the waits, then the pauses' own
// reasons (they show only where the chosen words leave room); then the row's words get shorter (its own words without `if no
// pause`, then each shorter tier's) before any of the promise part leaves; of that part `moved 1 h 20 by pauses` leaves before the
// promise's reasons, and the promise itself goes only when even the short words leave it no room.
// Colour (cells.mjs): durations and clocks `time`, the bar and its count `bar`; later yellow, red once past the job's own 80 %
// margin (its 80 % work left less its likely); waits magenta (they need the owner); earlier, on time and parked default.
// Exports: rangeNumbers(numbers) -> v2 | null; rangeJobParts(counts, context, look); rangeStepParts(step, context, look);
// barPart(share, cells, count, look, gap); ROW_ID_CHARS, LATE_MIN.
// Invariants: pure (no I/O); v2 is checked here and never trusted (a part of the wrong shape makes the whole v2 unusable, and
// work-row.mjs draws the R18 fields instead); only counts, minutes, clocks, fixed words and row ids through cleanText are printed;
// every clock in the one zone given; no confidence the numbers do not carry (likely and 80 % only); light: it imports neither the
// forecast nor job-rows.mjs (which loads it), since every status line render loads this file.
import { barText, clockOf, cleanText, cutWords, durationText, partsWidth, STATE } from './cells.mjs';
import { clockText, localDate } from '../../estimate/lib/local-clock.mjs';

/** The most characters of a row id on a row (a reason or a running row). */
export const ROW_ID_CHARS = 16;
/** Minutes past (or before) the promise from which the job is later (earlier): job-rows.mjs LATE_MIN, the CLI's rule. Kept here,
 *  not imported, so the render stays light; a test pins the two equal. */
export const LATE_MIN = 10;
const MODEL = 's1';
const TIERS = ['wide', 'normal', 'narrow'];
const JOB_CELLS = { wide: 16, normal: 10, narrow: 6 };
const STEP_CELLS = { wide: 6, normal: 5, narrow: 3 };
/** E3: the clocks assume no pause; the short words leave the note out. */
const PAUSE_NOTE = { wide: ' if nothing pauses', normal: ' if no pause', narrow: '' };
/** Pauses are named from this many minutes, as on the CLI's Pauses line (report.mjs PAUSE_SHOWN_MIN). */
const PAUSE_SHOWN_MIN = 5;
const REASONS_SHOWN = 2;
const REASON_KINDS = ['rows-added', 'over-usual', 'faster'];
/** The pause reasons (pauses.mjs), in the order a tie is told. */
const PAUSE_REASONS = ['waiting for you', 'usage limit', 'no activity'];
const MIN_UNIT = ' min';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const isRange = (range) => isObject(range) && [range.p50Min, range.p80Min, range.p50Ms, range.p80Ms].every(isNumber)
  && range.p50Min >= 0 && range.p50Min <= range.p80Min && range.p50Ms <= range.p80Ms;
const isStep = (step) => step === null || (isObject(step) && typeof step.road === 'string' && isCount(step.step) && isCount(step.steps)
  && step.step >= 1 && step.step <= step.steps && isCount(step.lanesDone) && isCount(step.lanesTotal) && step.lanesDone <= step.lanesTotal
  && isRange(step));
const isPromise = (promise) => promise === null || (isObject(promise) && isNumber(promise.atMs) && isNumber(promise.p80Ms)
  && (promise.movedMs === undefined || promise.movedMs === null || isNumber(promise.movedMs)));
const isReason = (reason) => isObject(reason) && REASON_KINDS.includes(reason.kind) && isNumber(reason.min) && Array.isArray(reason.ids)
  && reason.ids.every((id) => typeof id === 'string') && (reason.count === undefined || isCount(reason.count));
const isDiff = (diff) => diff === null || (isObject(diff) && isNumber(diff.min) && Array.isArray(diff.reasons) && diff.reasons.every(isReason));
const isPauses = (pauses) => isObject(pauses) && isNumber(pauses.min) && pauses.min >= 0 && isObject(pauses.byReason)
  && Object.values(pauses.byReason).every(isNumber);

/**
 * @param {object | null} numbers the shown cache entry's numbers (segment-cache.mjs checks the R18 fields, not v2)
 * @returns {object | null} numbers.v2 when it is model s1's shape (estimate-spec section 12), else null (missing: a rolled-back
 *   estimator or an old entry; malformed: never drawn)
 */
export function rangeNumbers(numbers) {
  const v2 = numbers?.v2;
  const ok = isObject(v2) && v2.model === MODEL && isRange(v2.job) && isStep(v2.step) && isCount(v2.waiting) && isCount(v2.parked)
    && isPromise(v2.promise) && isDiff(v2.diff) && isPauses(v2.pauses);
  return ok ? v2 : null;
}

/** A bar and its count, both in the bar colour, with the tier's gap between them. */
export const barPart = (share, cells, count, look, gap = ' ') => {
  const bar = barText({ done: share }, cells, look);
  return { text: `${bar}${gap}${count}`, spans: [{ text: bar, state: STATE.bar }, { text: gap }, { text: count, state: STATE.bar }] };
};

/** Words around one value in the time colour: `done ` `12:50–13:20` ` if no pause`. */
const timed = (before, value, after = '') => ({ text: `${before}${value}${after}`, spans: [{ text: before }, { text: value, state: STATE.time }, { text: after }] });
const dashOf = (look) => (look.ascii ? '-' : '–');

/** `2 h 57–3 h 28`, `25–40 min` (the unit once when both ends are minutes), one end when both are the same. */
function minutesRange(fromMin, toMin, look) {
  const [from, to] = [durationText(fromMin), durationText(toMin)];
  if (from === to) return from;
  const shared = from.endsWith(MIN_UNIT) && to.endsWith(MIN_UNIT);
  return `${shared ? from.slice(0, -MIN_UNIT.length) : from}${dashOf(look)}${to}`;
}

/** `12:50–13:20`, `Tue 12:50–13:20` on another day (the weekday once), `23:50–Tue 00:20` across midnight, one end when equal. */
function clockRange(fromMs, toMs, { nowMs, timeZone }, look) {
  const from = clockOf(fromMs, nowMs, timeZone);
  if (localDate(fromMs, timeZone) !== localDate(toMs, timeZone)) return `${from}${dashOf(look)}${clockOf(toMs, nowMs, timeZone)}`;
  const to = clockText(toMs, timeZone);
  return to === clockText(fromMs, timeZone) ? from : `${from}${dashOf(look)}${to}`;
}

/** The row's word forms, longest first from its own tier: each tier with the pause note, then without it. */
const formsFrom = (tier) => TIERS.slice(TIERS.indexOf(tier))
  .flatMap((each) => (PAUSE_NOTE[each] ? [{ tier: each, note: true }, { tier: each, note: false }] : [{ tier: each, note: false }]));
const fits = (parts, look) => partsWidth(parts, look) <= look.columns;

/** The job's bar and rows, its work left and its finish, in one word form. */
function jobBase(v2, counts, { form, clock }, look) {
  const { tier, note } = form;
  const { rowsDone: done, rowsTotal: total } = counts;
  const count = { wide: `${done} of ${total} rows done`, normal: `${done}/${total} rows`, narrow: `${done}/${total}` }[tier];
  const work = timed('', minutesRange(v2.job.p50Min, v2.job.p80Min, look), { wide: ' of work left', normal: ' work left', narrow: '' }[tier]);
  const finish = v2.job.p80Ms < clock.nowMs
    ? { text: `was due ${clockOf(v2.job.p80Ms, clock.nowMs, clock.timeZone)}`, state: STATE.block }
    : timed(tier === 'narrow' ? '' : 'done ', clockRange(v2.job.p50Ms, v2.job.p80Ms, clock, look), note ? PAUSE_NOTE[tier] : '');
  return [barPart(total > 0 ? done / total : 0, JOB_CELLS[tier], count, look, tier === 'wide' ? '  ' : ' '), work, finish];
}

/** One reason of the promise's difference: `3 rows added`, `R18.git over usual`, `2 rows faster or dropped`. */
function reasonText(reason, look) {
  const count = reason.count ?? reason.ids.length;
  if (reason.kind === 'rows-added') return `${plural(count, 'row')} added`;
  if (reason.kind === 'faster') return `${plural(count, 'row')} faster or dropped`;
  const one = count === 1 && reason.ids.length > 0;
  return one ? `${cutWords(cleanText(reason.ids[0], look), ROW_ID_CHARS, look)} over usual` : `${plural(count, 'row')} over usual`;
}

/** The promise part with two, one or no reasons, richest first; [] without a promise. The short words leave out the promised
 *  clock of a later or earlier promise (`25 min later than promised`), so it fits 80 columns. */
function promiseVariants(v2, { clock, tier }, look) {
  const { promise, diff, pauses, job } = v2;
  if (promise === null) return [];
  const movedMs = pauses.min >= PAUSE_SHOWN_MIN && isNumber(promise.movedMs) ? promise.movedMs : promise.p80Ms;
  const at = clockOf(movedMs, clock.nowMs, clock.timeZone);
  const min = diff === null ? 0 : diff.min;
  if (Math.abs(min) < LATE_MIN) return [[timed('on time for ', at)]];
  const amount = durationText(Math.abs(min));
  const promised = tier === 'narrow' ? '' : at;
  const words = ` than promised${promised ? ' ' : ''}`;
  const state = min < 0 ? STATE.ok : min > job.p80Min - job.p50Min ? STATE.block : STATE.warn;
  const earlier = [{ text: amount, state: STATE.time }, { text: ` earlier${words}` }, { text: promised, state: STATE.time }];
  const status = min > 0 ? { text: `${amount} later${words}${promised}`, state } : { text: earlier.map((span) => span.text).join(''), spans: earlier };
  const reasons = diff.reasons.slice(0, REASONS_SHOWN).map((reason) => reasonText(reason, look));
  const told = reasons.map((_, cut) => [status, { text: `: ${reasons.slice(0, reasons.length - cut).join(', ')}`, state, join: '' }]);
  return [...told, [status]];
}

/** Every promise part a row may carry, richest first: its reasons before how far pauses moved it; [] without a promise. */
function promiseChoices(v2, context, look) {
  const moved = v2.pauses.min >= PAUSE_SHOWN_MIN ? [[{ ...timed('moved ', durationText(v2.pauses.min), ' by pauses'), pauses: true }], []] : [[]];
  return promiseVariants(v2, context, look).flatMap((told) => moved.map((more) => [...told, ...more]));
}

/** The pauses' reasons after `moved 1 h 20 by pauses`: `: waiting for you 40 min, no activity 40 min`, largest first; [] for none. */
function pauseReasons(v2) {
  const named = PAUSE_REASONS.map((reason) => [reason, v2.pauses.byReason[reason]])
    .filter(([, min]) => isNumber(min) && Math.round(min) >= 1).sort(([, a], [, b]) => b - a);
  const spans = named.flatMap(([reason, min], index) => [{ text: `${index === 0 ? ': ' : ', '}${reason} ` }, { text: durationText(min), state: STATE.time }]);
  return named.length === 0 ? [] : [{ text: spans.map((span) => span.text).join(''), spans, join: '' }];
}

/** The rows waiting for the owner and the rows parked, in the tier's words (none in the short words). */
function holdParts(v2, tier) {
  if (tier === 'narrow') return [];
  const verb = v2.waiting === 1 ? 'waits' : 'wait';
  const waits = { text: tier === 'wide' ? `${plural(v2.waiting, 'row')} ${verb} for you` : `${v2.waiting} ${verb} for you`, state: STATE.wait };
  const parked = { text: tier === 'wide' ? `${plural(v2.parked, 'row')} parked` : `${v2.parked} parked` };
  return [...(v2.waiting > 0 ? [waits] : []), ...(v2.parked > 0 ? [parked] : [])];
}

/**
 * The job row's parts after its label, every one fitting look.columns (see the header's Fit).
 * @param {{ rowsDone: number, rowsTotal: number }} counts the job's rows done of all (the cache's R18 counts)
 * @param {{ v2: object, clock: { nowMs: number, timeZone: string }, tier: 'wide' | 'normal' | 'narrow' }} context rangeNumbers'
 *   v2, now and the render's zone, the row's own word tier
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal, its columns the room after the label
 * @returns {object[]} the parts in display order: bar, work left, finish, waits, parked, the promise, the pauses' move
 */
export function rangeJobParts(counts, { v2, clock, tier }, look) {
  const forms = formsFrom(tier).map((form) => ({
    form, base: jobBase(v2, counts, { form, clock }, look), choices: promiseChoices(v2, { clock, tier: form.tier }, look),
  }));
  const choiceCount = forms[0].choices.length; // the same in every form: only the words differ
  let chosen = null;
  for (let rank = 0; rank < choiceCount && chosen === null; rank += 1) {
    const form = forms.find(({ base, choices }) => fits([...base, ...choices[rank]], look));
    if (form !== undefined) chosen = { ...form, promise: form.choices[rank] };
  }
  const { form, base, promise } = chosen ?? { ...(forms.find((each) => fits(each.base, look)) ?? forms.at(-1)), promise: [] };
  const moved = promise.some((part) => part.pauses === true) ? pauseReasons(v2) : [];
  const why = fits([...base, ...promise, ...moved], look) ? moved : [];
  const holds = [];
  for (const part of holdParts(v2, form.tier)) if (fits([...base, ...promise, ...why, ...holds, part], look)) holds.push(part);
  return [...base, ...holds, ...promise, ...why];
}

/** The step, its lanes landed (else its rows done), its time left and its finish, in one tier's words. */
function stepForm(step, { rows, clock }, tier, look) {
  const head = { text: tier === 'narrow' ? `step ${step.step}/${step.steps}` : `step ${step.step} of ${step.steps}` };
  const lanes = step.lanesTotal > 0;
  const [done, total, words] = lanes ? [step.lanesDone, step.lanesTotal, 'lanes landed'] : [rows?.done ?? 0, rows?.total ?? 0, 'rows done'];
  const count = { wide: `${done} of ${total} ${words}`, normal: `${done}/${total} ${words}`, narrow: `${done}/${total}` }[tier];
  const left = timed('', minutesRange(step.p50Min, step.p80Min, look), tier === 'narrow' ? '' : ' left');
  const end = step.p80Ms < clock.nowMs
    ? { text: `step was due ${clockOf(step.p80Ms, clock.nowMs, clock.timeZone)}`, state: STATE.block }
    : timed(tier === 'narrow' ? '' : 'step done ', clockRange(step.p50Ms, step.p80Ms, clock, look));
  return [head, ...(total > 0 ? [barPart(done / total, STEP_CELLS[tier], count, look)] : []), left, end];
}

/**
 * The now row's parts after its label for the live road's current step: the first tier's words, from the row's own, that fit.
 * @param {object} step rangeNumbers' v2.step
 * @param {{ title: string, rows: { done: number, total: number } | null, clock: { nowMs: number, timeZone: string },
 *   tier: 'wide' | 'normal' | 'narrow' }} context the step's title (cleaned and cut, '' for none; dropped first), the step's rows
 *   when it has no lanes, now and the zone, the row's own tier
 * @param {ReturnType<import('./cells.mjs').lookOf>} look the terminal, its columns the room after the label
 * @returns {object[]} the parts in display order
 */
export function rangeStepParts(step, { title, rows, clock, tier }, look) {
  const forms = TIERS.slice(TIERS.indexOf(tier)).map((each) => stepForm(step, { rows, clock }, each, look));
  const [head, ...rest] = forms.find((form) => fits(form, look)) ?? forms.at(-1);
  return [head, { text: title, join: ' ', drop: 1 }, ...rest];
}
