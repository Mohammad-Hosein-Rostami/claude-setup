// Model s1, "runs on slots" (estimate-spec section 4, R5-R8): every open agent row is one agent run drawn from its kind's pool of
// working minutes; a road step ends when its slowest lane ends plus one review and one fix run, never before the step before it;
// and no work ends sooner than all of it spread over the measured agent slots.
// Exports: DEFAULT_SLOTS, MAX_SLOTS, RUNS, STEP_GATE_MIN, seededRandom(seedText), measuredSlots(items, nowMs),
// forecastRuns(items, context).
// Model, per seeded run: a not-started row draws any run of its pool; a started row draws a run longer than its elapsed working
// minutes, minus them; a stalled row (R5) counts its kind's median once, never a draw that grows with its age. Per road, from its
// current step on: lanes started now run now, lanes not started yet start when the lanes of the step before have ended (the lane
// chain); the step adds its review and fix (their rows when listed, else one expected run of each, R12) and STEP_GATE_MIN of lead
// time; its end is at least the work of the road so far over the slots and at least the previous step's end. The job is the
// latest of every road's ends, all work over the slots, and the longest single run. Lead rows (gate, land, deliver) draw nothing.
// Measured (spec 5, 5b; reference replay scripts/candidate.mjs, variant floor90): held-out current step 21 min median error
// against c3's 1,579, road 23 against 2,004.
// Invariants: pure (no I/O, no clock); minutes from now, not rounded (R10 rounds once, in the numbers); the same items, context and
// seedText give the same numbers (CLI and status line agree, F6); parked rows are out of every number, waiting rows out of the
// work clock (both listed); kindOf and rowState are applied here, so fields a caller put on an item are never trusted.
import { createHash } from 'node:crypto';
import { MAX_LANES_PER_STEP } from '../../road/lib/road-file.mjs';
import { nearestRank } from './forecast.mjs';
import { AGENT_KINDS, kindOf, rowState } from './kinds.mjs';
import { roadStepOf } from './road-steps.mjs';
import { workedMinutes } from './worked.mjs';

/** Slots before any agent row ran (R7): 4 lanes at once is the usual step (3.87 agents ran on average, spec section 3). */
export const DEFAULT_SLOTS = 4;
/** At most this many agents run at once: the road's lane cap per step (R7). */
export const MAX_SLOTS = MAX_LANES_PER_STEP;
/** Seeded runs per forecast; 5,000 rows times 1,000 runs stays under 300 ms (contract F2). */
export const RUNS = 1000;
/** Lead minutes per step for its gate and landing: not agent work, so no slot (R1). */
export const STEP_GATE_MIN = 3;
const SLOT_WINDOW_MIN = 120;
const SLOT_SAMPLE_MIN = 5;
/** R5 with no agent known: a row open longer than max(its kind's 95th percentile, 90) working minutes has stalled. The 90 min
 *  floor kept 3 real 52-86 min lanes from being flagged (spec U1). */
const STALL_SHARE = 0.95;
const STALL_FLOOR_MIN = 90;
/** R5 with its agent known (R13): an agent with no transcript entry for this many working minutes has stopped. */
const QUIET_MIN = 15;
const TAIL_KINDS = ['review', 'fix'];
const MEDIAN = 0.5;
const P80 = 0.8;
const MS_PER_MIN = 60_000;
const UINT32_RANGE = 2 ** 32;

/**
 * A seeded generator of numbers in [0, 1) (mulberry32, the generator of forecast.mjs, which does not export it).
 * @param {string} seedText the table state the numbers stand for
 * @returns {() => number}
 */
export function seededRandom(seedText) {
  let state = createHash('sha256').update(String(seedText)).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

const isAgentKind = (kind) => AGENT_KINDS.includes(kind);

/** Work rows (no deliver row) with their kind, state and road step, from parser items. */
function classified(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array of parser items');
  return items
    .map((item) => ({ id: String(item.id), k: kindOf(item), state: rowState(item), at: roadStepOf(item.id), started: item.started ?? null, done: item.done ?? null, evidence: String(item.evidence ?? '') }))
    .filter((row) => row.k !== 'deliver');
}

/**
 * R7: the mean number of started, unfinished agent rows over the last 120 min, sampled every 5 min; samples with no row running
 * (a night, a restart) are left out, so a pause does not read as one slot. Parked and waiting rows are not running.
 * @param {object[]} items parser items
 * @param {number} nowMs epoch ms of now
 * @returns {number | null} at most MAX_SLOTS; null when no agent row ran in the window (use DEFAULT_SLOTS)
 */
export function measuredSlots(items, nowMs) {
  const running = classified(items).filter((row) => isAgentKind(row.k) && (row.state === 'open' || row.state === 'done') && row.started !== null);
  let sum = 0;
  let samples = 0;
  for (let t = nowMs - SLOT_WINDOW_MIN * MS_PER_MIN; t <= nowMs; t += SLOT_SAMPLE_MIN * MS_PER_MIN) {
    const count = running.filter((row) => row.started <= t && (row.done === null || row.done > t)).length;
    if (count > 0) {
      sum += count;
      samples += 1;
    }
  }
  return samples === 0 ? null : Math.min(MAX_SLOTS, sum / samples);
}

/** The kind's pool, else the pooled `agent` one (kindPools fills both; a caller's empty pool must not draw undefined). */
function poolOf(pools, kind) {
  const pool = pools[kind]?.length > 0 ? pools[kind] : pools.agent;
  if (!(pool?.length > 0)) throw new TypeError(`no pool for kind ${kind} and no agent pool; build pools with kindPools`);
  return pool;
}

/** One open row's draw: { values, offset } (a value minus offset per run) or a fixed value; stalled rows are named. */
function drawOf(row, context, stalled) {
  const pool = poolOf(context.pools, row.k);
  if (row.started === null) return { values: pool, offset: 0 };
  const nowMin = Math.floor(context.nowMs / MS_PER_MIN);
  const agent = context.rowAgents?.get(row.id);
  const elapsed = agent ? agent.activeMin : workedMinutes(context.intervals, Math.floor(row.started / MS_PER_MIN), nowMin);
  const quiet = agent
    ? workedMinutes(context.intervals, Math.floor(agent.lastActiveMs / MS_PER_MIN), nowMin) >= QUIET_MIN
    : elapsed > Math.max(nearestRank(pool, STALL_SHARE), STALL_FLOOR_MIN);
  const longer = pool.filter((value) => value > elapsed);
  if (quiet || longer.length === 0) {
    stalled.push(row.id);
    return { fixed: nearestRank(pool, MEDIAN) };
  }
  return { values: longer, offset: elapsed };
}

/** Indices (into the open rows) of `rows` that are open. */
const openIndices = (rows, indexOf) => rows.filter((row) => indexOf.has(row.id)).map((row) => indexOf.get(row.id));

/** A road step's plan: its lanes (started now or not yet), each tail kind's listed open rows (null: expected) and all open rows. */
function stepPlan(step, rows, indexOf) {
  const agentRows = rows.filter((row) => isAgentKind(row.k));
  const lanes = agentRows.filter((row) => row.k === 'lane');
  const listed = Object.fromEntries(TAIL_KINDS.map((kind) => {
    const ofKind = agentRows.filter((row) => row.k === kind);
    return [kind, ofKind.length === 0 ? null : openIndices(ofKind, indexOf)];
  }));
  return {
    step,
    startedLanes: openIndices(lanes.filter((row) => row.started !== null), indexOf),
    freshLanes: openIndices(lanes.filter((row) => row.started === null), indexOf),
    listed,
    open: openIndices(agentRows, indexOf),
  };
}

/**
 * Each road's steps from its current one (R6): rows of one road only; a step is closed when its gate rows are done, or, with no
 * gate row, when all its rows are; parked rows neither close nor hold a step, a waiting row holds it (it is still open).
 * @returns {{ road: string, current: number, steps: ReturnType<typeof stepPlan>[] }[]}
 */
function roadPlans(rows, indexOf) {
  const byRoad = new Map();
  for (const row of rows.filter((candidate) => candidate.at !== null)) {
    if (!byRoad.has(row.at.road)) byRoad.set(row.at.road, []);
    byRoad.get(row.at.road).push(row);
  }
  const plans = [];
  for (const [road, roadRows] of byRoad) {
    const counted = roadRows.filter((row) => row.state !== 'parked');
    const numbers = [...new Set(counted.map((row) => row.at.step))].sort((a, b) => a - b);
    const ofStep = (step) => counted.filter((row) => row.at.step === step);
    const closed = (step) => {
      const gates = ofStep(step).filter((row) => row.k === 'gate');
      return (gates.length > 0 ? gates : ofStep(step)).every((row) => row.state === 'done');
    };
    const current = numbers.find((step) => !closed(step));
    if (current === undefined) continue;
    const steps = numbers.filter((step) => step >= current).map((step) => stepPlan(step, roadRows.filter((row) => row.at.step === step), indexOf));
    plans.push({ road, current, steps });
  }
  return plans;
}

const maxOf = (left, indices) => indices.reduce((max, index) => Math.max(max, left[index]), 0);
const sumOf = (left, indices) => indices.reduce((sum, index) => sum + left[index], 0);

/** One seeded run: fills each road step's end (minutes from now) at `run` and returns the job's end. */
function runOnce(run, { draws, plans, ends, tailPools, slots, random }) {
  const left = draws.map((draw) => draw.fixed ?? draw.values[Math.floor(random() * draw.values.length)] - draw.offset);
  let totalWork = left.reduce((sum, value) => sum + value, 0);
  let latest = Math.max(0, ...left);
  plans.forEach((plan, roadIndex) => {
    let chain = 0;
    let work = 0;
    let previousEnd = 0;
    plan.steps.forEach((step, stepIndex) => {
      chain = Math.max(chain + maxOf(left, step.freshLanes), maxOf(left, step.startedLanes));
      let tail = 0;
      let expected = 0;
      for (const kind of TAIL_KINDS) {
        const listed = step.listed[kind];
        const value = listed === null ? tailPools[kind][Math.floor(random() * tailPools[kind].length)] : maxOf(left, listed);
        tail += value;
        if (listed === null) expected += value;
      }
      work += sumOf(left, step.open) + expected;
      totalWork += expected;
      previousEnd = Math.max(chain + tail, work / slots, previousEnd);
      ends[roadIndex][stepIndex][run] = previousEnd + STEP_GATE_MIN;
      latest = Math.max(latest, previousEnd + STEP_GATE_MIN);
    });
  });
  return Math.max(latest, totalWork / slots);
}

const percentiles = (values) => {
  values.sort();
  return { p50: nearestRank(values, MEDIAN), p80: nearestRank(values, P80) };
};

function checkedContext(context) {
  const { pools, nowMs, intervals, slots, seedText } = context ?? {};
  if (pools === null || typeof pools !== 'object') throw new TypeError('context.pools must be kindPools output');
  if (!Number.isFinite(nowMs)) throw new TypeError('context.nowMs must be epoch ms');
  if (!Array.isArray(intervals)) throw new TypeError('context.intervals must be working intervals [startMin, endMin)');
  if (!Number.isFinite(slots)) throw new TypeError('context.slots must be a number (measuredSlots ?? DEFAULT_SLOTS)');
  if (typeof seedText !== 'string') throw new TypeError('context.seedText must be a string');
  if (context.rowAgents !== undefined && !(context.rowAgents instanceof Map)) throw new TypeError('context.rowAgents must be a Map (rowAgents)');
  return { ...context, slots: Math.min(MAX_SLOTS, Math.max(1, slots)) };
}

/**
 * The s1 forecast of the open rows (see the header).
 * @param {object[]} items parser items (items.mjs); kindOf and rowState are applied here
 * @param {{ pools: Record<string, number[]>, nowMs: number, intervals: [number, number][], slots: number, seedText: string,
 *   rowAgents?: Map<string, { agentId: string, activeMin: number, lastActiveMs: number }> }} context pools from kindPools;
 *   intervals from worked.mjs workingIntervals; slots = measuredSlots(...) ?? DEFAULT_SLOTS (kept in 1..MAX_SLOTS); rowAgents
 *   (row-agents.mjs, R13) gives a started row's active minutes and last activity, else its working minutes since started count
 * @returns {{ job: { p50: number, p80: number }, roads: Record<string, { current: number, currentRows: number,
 *   steps: Record<number, { p50: number, p80: number }> }>, stalled: string[], parked: string[],
 *   waiting: { id: string, sinceMs: number | null, question: string }[], followups: { rows: number } }} minutes from now;
 *   currentRows = the agent rows left in the current step, the expected review and fix included (throughputForecast's count);
 *   waiting.sinceMs is the row's started stamp (the cell holds no time), null when it never started
 * @throws {TypeError} on a malformed items list or context
 */
export function forecastRuns(items, context) {
  const checked = checkedContext(context);
  const rows = classified(items);
  const open = rows.filter((row) => row.state === 'open' && isAgentKind(row.k));
  const stalled = [];
  const draws = open.map((row) => drawOf(row, checked, stalled));
  const plans = roadPlans(rows, new Map(open.map((row, index) => [row.id, index])));
  const ends = plans.map((plan) => plan.steps.map(() => new Float64Array(RUNS)));
  const tailPools = Object.fromEntries(TAIL_KINDS.map((kind) => [kind, poolOf(checked.pools, kind)]));
  const state = { draws, plans, ends, tailPools, slots: checked.slots, random: seededRandom(checked.seedText) };
  const job = new Float64Array(RUNS).map((_, run) => runOnce(run, state));
  const roads = Object.fromEntries(plans.map((plan, roadIndex) => {
    const first = plan.steps[0];
    const expected = TAIL_KINDS.filter((kind) => first.listed[kind] === null).length;
    const steps = Object.fromEntries(plan.steps.map((step, stepIndex) => [step.step, percentiles(ends[roadIndex][stepIndex])]));
    return [plan.road, { current: plan.current, currentRows: first.open.length + expected, steps }];
  }));
  const waiting = rows.filter((row) => row.state === 'waiting')
    .map((row) => ({ id: row.id, sinceMs: row.started, question: row.evidence.replace(/^\s*waiting:\s*/i, '') }));
  return {
    job: percentiles(job),
    roads,
    stalled,
    parked: rows.filter((row) => row.state === 'parked').map((row) => row.id),
    waiting,
    followups: { rows: open.filter((row) => row.k === 'followup').length },
  };
}
