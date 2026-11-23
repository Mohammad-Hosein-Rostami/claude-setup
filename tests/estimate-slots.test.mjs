// Tests for the s1 estimate parts: home/tools/estimate/lib/kinds.mjs (row kinds R1, states R3/R4, pools R2/R14), slots.mjs
// (measured slots R7, runs on slots) and throughput.mjs (throughput Monte Carlo, the current step's range, the conformal margin).
// Contract F1-F8 of estimate-spec road step `kinds-slots`, plus the PC case of old-form `-land` twin rows. Tables go through the
// real parser (items.mjs) so the items are the shape the tool reads; all rows are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { holdsOf, kindOf, kindPools, rowState } from '../home/tools/estimate/lib/kinds.mjs';
import { DEFAULT_SLOTS, STEP_GATE_MIN, forecastRuns, measuredSlots } from '../home/tools/estimate/lib/slots.mjs';
import { DEFAULT_MARGIN_MIN, conformalMargin, stepRange, throughputForecast } from '../home/tools/estimate/lib/throughput.mjs';
import { BASE_MS, MIN_MS, row, statusDoc } from './estimate-tables.mjs';

const NOW_MIN = 12 * 60; // now is 12:00 on the synthetic day
const NOW_MS = BASE_MS + NOW_MIN * MIN_MS;
const at = (min) => new Date(BASE_MS + min * MIN_MS).toISOString().replace(':00.000Z', 'Z');
/** A row; started/done are minutes after BASE_MS (undefined: `-`). */
const line = ({ id, item, size = 'M', started, done, evidence = done === undefined ? '-' : 'abc1234' }) => row({
  id, item: item ?? `item ${id}`, size, evidence, raw: { started: started === undefined ? '-' : at(started), done: done === undefined ? '-' : at(done) },
});
function itemsOf(rows) {
  const { items, problems } = parseWorkItems(statusDoc(rows.map(line)), NOW_MS);
  assert.deepEqual(problems, []);
  return items;
}
const runs = (k, minutes) => minutes.map((runMin) => ({ k, runMin }));
/** The same runs for every agent kind. */
const AGENT_KINDS_RUNS = (minutes) => ['lane', 'review', 'fix', 'followup', 'plan', 'task'].flatMap((k) => runs(k, minutes));
const flat = (minutes, count = 12) => AGENT_KINDS_RUNS(Array(count).fill(minutes));
const BASE_INTERVALS = [[BASE_MS / MIN_MS, BASE_MS / MIN_MS + NOW_MIN]]; // worked all day up to now
const context = (overrides = {}) => ({ pools: kindPools(flat(20)), nowMs: NOW_MS, intervals: BASE_INTERVALS, slots: DEFAULT_SLOTS, seedText: 't|a', ...overrides });
const item = (id, text = `item ${id}`, kind = 'build') => ({ id, item: text, kind });

test('kindOf follows R1 in order, first match wins', () => {
  const cases = [
    [item('deliver:1', 'deliver: job'), 'deliver'], [item('x', 'hand over', 'deliver'), 'deliver'],
    [item('polish.s3.check', 'close: gate'), 'gate'], [item('polish.s3.check', 'build: x'), 'gate'],
    [item('polish.s3.kinds-land', 'close: land kinds'), 'land'], [item('close:polish.s2.web-land'), 'land'],
    [item('polish.s3.review'), 'review'], [item('polish.s3.r1', 'review: lane r1'), 'review'],
    [item('polish.s3.fix-a', 'rework: a'), 'fix'], [item('polish.s3.x', 'close: findings'), 'fix'], [item('polish.s3.y', 'rework: owner'), 'fix'],
    [item('polish.s3.kinds-slots', 'build: lib files'), 'lane'], [item('s1.s2.lane'), 'lane'],
    // lanes whose names start like a gate, review or fix row (road.mjs writes only the exact `.check`; a fix is told by `rework:`)
    [item('polish.s3.check-age', 'build: x'), 'lane'], [item('polish.s3.check-2'), 'lane'], [item('polish.s3.review-times', 'build: x'), 'lane'],
    [item('polish.s3.fix-cv-find-job-skill', 'build: x'), 'lane'], [item('polish.s3.fix'), 'lane'],
    [item('F3'), 'followup'], [item('polish.f2.doc'), 'followup'], [item('fu.sync'), 'followup'], [item('z', 'follow-up: tidy'), 'followup'],
    [item('P17'), 'plan'], [item('q', 'plan: road'), 'plan'],
    [item('r', 'review: diff'), 'review'], [item('u', 'fix: typo'), 'fix'], [item('close:5'), 'fix'],
    [item('a|b', 'build: x'), 'task'], [item('P17a'), 'task'], [item('polish.s0.x'), 'task'],
  ];
  for (const [given, kind] of cases) assert.equal(kindOf(given), kind, given.id);
});

test('rowState: done wins over a parked: or waiting: text; open rows read their evidence prefix', () => {
  assert.equal(rowState({ done: 5, evidence: 'parked: later' }), 'done');
  assert.equal(rowState({ done: null, evidence: 'parked: web phase later' }), 'parked');
  assert.equal(rowState({ done: null, evidence: '  waiting: which name?' }), 'waiting');
  assert.equal(rowState({ done: null, evidence: 'see parked: later' }), 'open');
  assert.equal(rowState({ done: null, evidence: '' }), 'open');
  // the hold format of status.mjs: any case, several holds at the head, each ended by `;`
  assert.equal(rowState({ done: null, evidence: 'PARKED: later' }), 'parked');
  assert.equal(rowState({ done: null, evidence: 'Waiting: name?; abc1234' }), 'waiting');
  assert.equal(rowState({ done: null, evidence: 'waiting: q2; parked: later; abc1234' }), 'parked');
  assert.equal(rowState({ done: null, evidence: 'abc1234; parked: later' }), 'open');
  assert.deepEqual(holdsOf('waiting: q2; Waiting: q1 ; abc'), [{ kind: 'waiting', text: 'q2' }, { kind: 'waiting', text: 'q1' }]);
});

test('kindPools keeps runs of 1..240 per agent kind, pools kinds under 10 runs, and falls back with no run at all (F1)', () => {
  const pools = kindPools([...runs('lane', [30, 10, 20, 40, 50, 60, 70, 80, 90, 100]), ...runs('fix', [5, 0, 241, 0.5]), { size: 'M', cost: 9 }, ...runs('gate', [3])]);
  assert.deepEqual(pools.lane, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(pools.agent, [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.deepEqual(pools.fix, pools.agent);
  assert.equal(pools.gate, undefined);
  assert.deepEqual(kindPools([]).agent, [22, 46]);
  assert.deepEqual(kindPools([]).review, [22, 46]);
  assert.throws(() => kindPools(null), TypeError);
});

/** Every listed row has a live agent (active a minute ago), so the stall rule never ends its run. */
const liveAgents = (ids) => context({ rowAgents: new Map(ids.map((id) => [id, { agentId: `a-${id}`, activeMin: 5, lastActiveMs: NOW_MS - MIN_MS }])) });

test('measuredSlots: null before any agent row ran (F1); the mean of the running samples, lead and held rows left out, at most 5', () => {
  assert.equal(measuredSlots([], NOW_MS, context()), null);
  const landOnly = itemsOf([{ id: 'r.s1.a-land', started: NOW_MIN - 60 }, { id: 'r.s1.check', started: NOW_MIN - 60 }]);
  assert.equal(measuredSlots(landOnly, NOW_MS, liveAgents(['r.s1.a-land', 'r.s1.check'])), null);
  const two = itemsOf([
    { id: 'r.s1.a', started: NOW_MIN - 200 }, { id: 'r.s1.b', started: NOW_MIN - 60 },
    { id: 'r.s1.c', started: NOW_MIN - 60, evidence: 'parked: later' }, { id: 'r.s1.d', started: NOW_MIN - 60, evidence: 'waiting: name?' },
  ]);
  // a runs all 25 samples, b the last 13: (25 + 13) / 25
  assert.equal(measuredSlots(two, NOW_MS, liveAgents(['r.s1.a', 'r.s1.b', 'r.s1.c', 'r.s1.d'])), 38 / 25);
  // samples with nothing running (a pause) are left out: one row for the last 60 min is one slot, not 13 / 25
  assert.equal(measuredSlots(itemsOf([{ id: 'T1', started: NOW_MIN - 60 }]), NOW_MS, context()), 1);
  const ids = Array.from({ length: 7 }, (_, k) => `t${k}`);
  assert.equal(measuredSlots(itemsOf(ids.map((id) => ({ id, started: NOW_MIN - 130 }))), NOW_MS, liveAgents(ids)), 5);
  assert.throws(() => measuredSlots([], NOW_MS, { pools: {} }), TypeError);
});

test('R4: a stalled row is not a slot: 5 rows open for 10 h with no agent, or with agents gone quiet, run nowhere', () => {
  const ids = ['T1', 'T2', 'T3', 'T4', 'T5'];
  const stale = itemsOf(ids.map((id) => ({ id, started: NOW_MIN - 600 })));
  assert.equal(measuredSlots(stale, NOW_MS, context()), null);
  const quiet = new Map(ids.map((id) => [id, { agentId: id, activeMin: 40, lastActiveMs: NOW_MS - 60 * MIN_MS }]));
  // each agent ran until 60 min ago and counts until 15 quiet working minutes have passed: samples -120..-50, 15 of 25
  assert.equal(measuredSlots(stale, NOW_MS, context({ rowAgents: quiet })), 5);
  const oneQuiet = new Map([...quiet].map(([id, agent], k) => [id, k === 0 ? agent : { ...agent, lastActiveMs: NOW_MS }]));
  assert.equal(measuredSlots(stale, NOW_MS, context({ rowAgents: oneQuiet })), (15 * 5 + 10 * 4) / 25);
});

test('F1 empty: no open row and pools from no run give a zero job, no throw', () => {
  const result = forecastRuns([], context({ pools: kindPools([]) }));
  assert.deepEqual(result.job, { p50: 0, p80: 0 });
  assert.deepEqual(result.roads, {});
});

test('F3: five parallel lanes of 20 min end near 20 + review + fix + gate, never their sum', () => {
  const lanes = itemsOf([...['a', 'b', 'c', 'd', 'e'].map((lane) => ({ id: `r.s1.${lane}` })), { id: 'r.s1.check' }]);
  const result = forecastRuns(lanes, context());
  const step = result.roads.r.steps[1];
  assert.equal(step.p50, 20 + 20 + 20 + STEP_GATE_MIN);
  assert.ok(step.p80 < 5 * 20);
  assert.equal(result.roads.r.current, 1);
  assert.equal(result.roads.r.currentRows, 5 + 2);
  assert.equal(result.job.p50, step.p50);
});

test('F4: a step never ends before the step before it; parked and waiting rows add 0', () => {
  const pools = kindPools(AGENT_KINDS_RUNS([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]));
  const rows = [
    { id: 'r.s1.a', started: NOW_MIN - 5 }, { id: 'r.s1.check' },
    { id: 'r.s2.b' }, { id: 'r.s2.review', started: NOW_MIN - 5 }, { id: 'r.s2.fix' }, { id: 'r.s2.check' },
  ];
  const base = forecastRuns(itemsOf(rows), context({ pools }));
  assert.ok(base.roads.r.steps[2].p50 >= base.roads.r.steps[1].p50);
  assert.ok(base.roads.r.steps[2].p80 >= base.roads.r.steps[1].p80);
  const extra = [
    { id: 'r.s2.c', evidence: 'parked: later' }, { id: 'r.s1.d', started: NOW_MIN - 30, evidence: 'waiting: which name?' },
    { id: 'T9', started: NOW_MIN - 30, evidence: 'parked: web' },
  ];
  const withExtra = forecastRuns(itemsOf([...rows, ...extra]), context({ pools }));
  assert.deepEqual(withExtra.roads, base.roads);
  assert.deepEqual(withExtra.job, base.job);
  assert.deepEqual(withExtra.parked, ['r.s2.c', 'T9']);
  assert.deepEqual(withExtra.waiting, [{ id: 'r.s1.d', sinceMs: null, question: 'which name?' }]);
});

test('F4: a step whose own rows are all done still ends after the step before it', () => {
  const rows = itemsOf([
    { id: 'r.s1.a' }, { id: 'r.s1.check' },
    ...['b', 'review', 'fix'].map((rest) => ({ id: `r.s2.${rest}`, started: 0, done: 30 })), { id: 'r.s2.check' },
  ]);
  const { steps } = forecastRuns(rows, context()).roads.r;
  assert.deepEqual(steps[1], { p50: 63, p80: 63 });
  assert.deepEqual(steps[2], { p50: 63, p80: 63 }); // its lanes ended long ago: it ends with step 1, not at 20 + gate
});

test('F4: a waiting gate row keeps its step current (it is still open)', () => {
  const rows = itemsOf([{ id: 'r.s1.a', started: 0, done: 30 }, { id: 'r.s1.check', evidence: 'waiting: land it?' }, { id: 'r.s2.b' }, { id: 'r.s2.check' }]);
  assert.equal(forecastRuns(rows, context()).roads.r.current, 1);
});

test('F5: a stalled row counts its kind median once, the same at 6 h and at 12 h, and is named', () => {
  const pools = kindPools(AGENT_KINDS_RUNS([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]));
  const sixHours = forecastRuns(itemsOf([{ id: 'T1', started: NOW_MIN - 360 }]), context({ pools }));
  const twelveHours = forecastRuns(itemsOf([{ id: 'T1', started: 0 }]), context({ pools }));
  assert.deepEqual(sixHours.stalled, ['T1']);
  assert.deepEqual(sixHours.job, { p50: 50, p80: 50 });
  assert.deepEqual(twelveHours.job, sixHours.job);
  // 85 working min is under the 90 min floor: a running row, drawing a longer run minus its 85 min (90 or 100 -> 5 or 15)
  const running = forecastRuns(itemsOf([{ id: 'T1', started: NOW_MIN - 85 }]), context({ pools }));
  assert.deepEqual(running.stalled, []);
  assert.ok([5, 15].includes(running.job.p50) && running.job.p80 === 15);
  // the 90 min floor (U1): a kind whose 95th percentile is 30 does not stall a 60 min row that a longer run still covers
  const short = kindPools(AGENT_KINDS_RUNS([...Array(19).fill(30), 120]));
  const sixty = forecastRuns(itemsOf([{ id: 'T1', started: NOW_MIN - 60 }]), context({ pools: short }));
  assert.deepEqual(sixty.stalled, []);
  assert.deepEqual(sixty.job, { p50: 60, p80: 60 });
});

test('R5 with its agent known: active minutes are its elapsed time; 15 quiet working minutes stall it', () => {
  const pools = kindPools(AGENT_KINDS_RUNS([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]));
  const items = itemsOf([{ id: 'T1', started: NOW_MIN - 300 }]);
  const live = new Map([['T1', { agentId: 'a1', activeMin: 75, lastActiveMs: NOW_MS - 2 * MIN_MS }]]);
  const active = forecastRuns(items, context({ pools, rowAgents: live }));
  assert.deepEqual(active.stalled, []);
  assert.ok(active.job.p80 <= 25); // a run longer than 75 (80..100) minus 75
  const quiet = new Map([['T1', { agentId: 'a1', activeMin: 20, lastActiveMs: NOW_MS - 15 * MIN_MS }]]);
  assert.deepEqual(forecastRuns(items, context({ pools, rowAgents: quiet })).stalled, ['T1']);
});

test('F6: the same table state and seed give the same numbers', () => {
  const pools = kindPools(AGENT_KINDS_RUNS([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]));
  const items = itemsOf([{ id: 'r.s1.a' }, { id: 'r.s1.b', started: NOW_MIN - 10 }, { id: 'r.s1.check' }, { id: 'F1' }]);
  assert.deepEqual(forecastRuns(items, context({ pools })), forecastRuns(items, context({ pools })));
  assert.deepEqual(throughputForecast(itemsOf([{ id: 'T1', started: NOW_MIN - 40, done: NOW_MIN - 5 }]), 3, NOW_MS, 's'),
    throughputForecast(itemsOf([{ id: 'T1', started: NOW_MIN - 40, done: NOW_MIN - 5 }]), 3, NOW_MS, 's'));
});

test('E1: open follow-ups are in the job time and counted, with no estimate of their own', () => {
  const lane = [{ id: 'r.s1.a' }, { id: 'r.s1.check' }];
  const without = forecastRuns(itemsOf(lane), context({ slots: 1 }));
  const withFollowups = forecastRuns(itemsOf([...lane, { id: 'F1' }, { id: 'r.f1.docs' }]), context({ slots: 1 }));
  assert.equal(withFollowups.followups.rows, 2);
  assert.equal(without.job.p50, 20 * 3 + STEP_GATE_MIN); // lane, expected review and fix, gate
  assert.equal(withFollowups.job.p50, 20 * 5); // one slot: all five runs one after another
  assert.deepEqual(withFollowups.roads, without.roads);
});

test('PC case: 11 old-form -land M rows, .check rows and close: items are land/gate: no slot, no build minutes', () => {
  const lanes = Array.from({ length: 11 }, (_, k) => ({ step: Math.floor(k / 4) + 1, lane: `l${k}` }));
  const work = lanes.map(({ step, lane }) => ({ id: `pc.s${step}.${lane}`, started: 0, done: 30 }));
  const checks = [1, 2, 3].map((step) => ({ id: `pc.s${step}.check`, item: `close: gate step ${step}` }));
  const twins = lanes.map(({ step, lane }) => ({ id: `pc.s${step}.${lane}-land`, item: `close: land ${lane}`, size: 'M', started: NOW_MIN - 100 }));
  for (const twin of [...twins, ...checks]) assert.match(kindOf(itemsOf([twin])[0]), /^(land|gate)$/);
  const without = forecastRuns(itemsOf([...work, ...checks]), context());
  const withTwins = forecastRuns(itemsOf([...work, ...checks, ...twins]), context());
  assert.deepEqual(withTwins, without);
  assert.equal(measuredSlots(itemsOf(twins), NOW_MS, liveAgents(twins.map((twin) => twin.id))), null);
  // only the step's expected review and fix plus its gate are left: 20 + 20 + 3
  assert.deepEqual(without.roads.pc.steps[1], { p50: 43, p80: 43 });
});

test('F2 huge: 5,000 rows over many roads run with no throw and finite numbers', () => {
  const rows = Array.from({ length: 5000 }, (_, k) => (k % 5 === 4
    ? { id: `rd${Math.floor(k / 50)}.s${Math.floor(k / 5) % 10 + 1}.check` }
    : { id: `rd${Math.floor(k / 50)}.s${Math.floor(k / 5) % 10 + 1}.l${k}`, started: k % 3 === 0 ? NOW_MIN - 10 : undefined }));
  const result = forecastRuns(itemsOf(rows), context({ pools: kindPools(AGENT_KINDS_RUNS([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])) }));
  assert.equal(Object.keys(result.roads).length, 100);
  assert.ok(Number.isFinite(result.job.p80) && result.job.p80 >= result.job.p50 && result.job.p50 > 0);
});

test('forecastRuns refuses a malformed context instead of drawing nothing', () => {
  assert.throws(() => forecastRuns([], { ...context(), intervals: null }), TypeError);
  assert.throws(() => forecastRuns([], { ...context(), slots: Number.NaN }), TypeError);
  assert.throws(() => forecastRuns(itemsOf([{ id: 'T1' }]), context({ pools: {} })), TypeError);
  assert.throws(() => forecastRuns(null, context()), TypeError);
});

test('throughputForecast: rows per 10-min bin over the last 180 min; lead rows are not throughput', () => {
  const doneRows = Array.from({ length: 18 }, (_, k) => ({ id: `T${k}`, started: NOW_MIN - 10 * k - 9, done: NOW_MIN - 10 * k }));
  const landed = Array.from({ length: 18 }, (_, k) => ({ id: `r.s1.l${k}-land`, started: NOW_MIN - 10 * k - 2, done: NOW_MIN - 10 * k - 1 }));
  assert.deepEqual(throughputForecast(itemsOf([...doneRows, ...landed]), 3, NOW_MS, 's'), { p50: 30, p80: 30 });
  assert.deepEqual(throughputForecast(itemsOf(doneRows), 0, NOW_MS, 's'), { p50: 0, p80: 0 });
});

test('F7: with no agent row done in the last 3 h, throughput is null and the step range is s1 alone', () => {
  const old = itemsOf([{ id: 'T1', started: NOW_MIN - 300, done: NOW_MIN - 181 }, { id: 'r.s1.a-land', started: NOW_MIN - 6, done: NOW_MIN - 5 }]);
  assert.equal(throughputForecast(old, 3, NOW_MS, 's'), null);
  assert.deepEqual(stepRange({ p50: 77, p80: 152 }, null, DEFAULT_MARGIN_MIN), { p50: 77, p80: 179 });
});

test('stepRange: the mean of the two likely times, s1 80% plus the margin, never below the likely time or with a negative margin', () => {
  assert.deepEqual(stepRange({ p50: 77, p80: 152 }, { p50: 33, p80: 40 }, 27), { p50: 55, p80: 179 });
  assert.deepEqual(stepRange({ p50: 20, p80: 30 }, { p50: 200, p80: 250 }, 0), { p50: 110, p80: 110 });
  assert.deepEqual(stepRange({ p50: 20, p80: 30 }, null, -10), { p50: 20, p80: 30 });
  assert.throws(() => stepRange({ p50: 20 }, null, 27), TypeError);
  assert.throws(() => stepRange({ p50: 20, p80: 30 }, { p50: Number.NaN, p80: 1 }, 27), TypeError);
});

test('F8: conformalMargin is 27 below 20 scored steps, the 80th percentile of the misses from 20, never negative', () => {
  const scored = (misses) => misses.map((miss) => ({ truthMin: 100 + miss, p80Min: 100 }));
  assert.equal(conformalMargin([]), 27);
  assert.equal(conformalMargin(scored(Array(19).fill(90))), 27);
  assert.equal(conformalMargin(scored(Array.from({ length: 20 }, (_, k) => k + 1))), 16);
  assert.equal(conformalMargin(scored(Array(20).fill(-30))), 0);
  assert.equal(conformalMargin([...scored(Array(19).fill(5)), { truthMin: 'x', p80Min: 1 }]), 27);
  assert.throws(() => conformalMargin(null), TypeError);
});

test('R2: a parked or waiting review or fix row leaves the step as if it were absent (the expected one still counts)', () => {
  const lane = [{ id: 'r.s1.a' }, { id: 'r.s1.check' }];
  const held = [{ id: 'r.s1.review', evidence: 'parked: later' }, { id: 'r.s1.fix', item: 'rework: x', evidence: 'Waiting: which?' }];
  const absent = forecastRuns(itemsOf(lane), context());
  const withHeld = forecastRuns(itemsOf([...lane, ...held]), context());
  assert.deepEqual({ roads: withHeld.roads, job: withHeld.job }, { roads: absent.roads, job: absent.job });
  assert.equal(absent.roads.r.currentRows, 3);
});

test('forecastRuns keeps the slots in 1..5', () => {
  const rows = itemsOf([{ id: 'r.s1.a' }, { id: 'r.s1.check' }, { id: 'F1' }, { id: 'F2' }]);
  assert.deepEqual(forecastRuns(rows, context({ slots: 0.25 })).job, forecastRuns(rows, context({ slots: 1 })).job);
  assert.deepEqual(forecastRuns(rows, context({ slots: 1 })).job, { p50: 100, p80: 100 });
  const wide = itemsOf(Array.from({ length: 12 }, (_, k) => ({ id: `T${k}` })));
  assert.deepEqual(forecastRuns(wide, context({ slots: 50 })).job, { p50: 12 * 20 / 5, p80: 12 * 20 / 5 });
});

test('R3: a table of 130,000 open rows draws with no stack overflow', () => {
  const rows = Array.from({ length: 130_000 }, (_, k) => ({ id: `T${k}`, item: 'x', kind: 'build', started: null, done: null, evidence: '' }));
  assert.equal(forecastRuns(rows, context()).job.p50, 130_000 * 20 / DEFAULT_SLOTS);
});

test('throughputForecast: the 180 min window ends exactly 180 min back; a row started and done in one minute is no run (R8)', () => {
  const doneAgo = (ago, run = 5) => itemsOf([{ id: 'T1', started: NOW_MIN - ago - run, done: NOW_MIN - ago }]);
  assert.equal(throughputForecast(doneAgo(180), 1, NOW_MS, 's'), null);
  assert.notEqual(throughputForecast(doneAgo(179), 1, NOW_MS, 's'), null);
  assert.equal(throughputForecast(doneAgo(20, 0), 1, NOW_MS, 's'), null);
  // a bin is (end - 10 min, end]: rows done exactly 10, 20 ... 170 min ago and one 175 min ago put one row in each of the 18 bins,
  // so 18 rows take exactly 18 bins in every run (a row on an edge in the next bin would leave bin 0 empty)
  const edges = [...Array.from({ length: 17 }, (_, k) => 10 * (k + 1)), 175];
  const onEdges = itemsOf(edges.map((ago, k) => ({ id: `T${k}`, started: NOW_MIN - ago - 5, done: NOW_MIN - ago })));
  assert.deepEqual(throughputForecast(onEdges, 18, NOW_MS, 's'), { p50: 180, p80: 180 });
});
