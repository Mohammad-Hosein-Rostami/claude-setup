// Tests for home/tools/estimate/lib/row-agents.mjs (R13 row -> agent, R5 quiet rows) and the active-minute side of
// home/tools/estimate/lib/transcript-facts.mjs (an agent's own minutes, read incrementally). Items, agents and transcripts are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdirSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { QUIET_MIN, STALL_FLOOR_MIN, quietRows, rowAgents } from '../home/tools/estimate/lib/row-agents.mjs';
import { readTranscriptFacts } from '../home/tools/estimate/lib/transcript-facts.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BASE_MS = Date.UTC(2026, 10, 23, 6, 0, 0);
const MIN_MS = 60_000;
const BASE_MIN = BASE_MS / MIN_MS;
const at = (min) => BASE_MS + min * MIN_MS;
const item = (id, fields = {}) => ({ id, kind: 'build', started: at(0), done: null, evidence: '', ...fields });
const agent = (id, fields = {}) => ({ id, name: '', row: null, startMs: at(0), ...fields });
const runs = (...pairs) => pairs.map(([from, to]) => [BASE_MIN + from, BASE_MIN + to]);
const always = (value) => () => value;

const ROWS = [
  item('polish.s3.cart'),
  item('polish.s3.menu'),
  item('polish.s3.done-lane', { done: at(30), evidence: 'abc1234' }),
  item('vm-qr-release'),
  item('uifix.s1.cart', { started: null }), // a paused road of another session: never started
];

test('a description naming one lane maps to that open row, with its active minutes and last activity', () => {
  const byRow = rowAgents(ROWS, [agent('a1', { name: 'Lane cart: fix the cart' })], always(runs([0, 20])));
  assert.deepEqual([...byRow], [['polish.s3.cart', { agentId: 'a1', activeMin: 20, lastActiveMs: at(20) }]]);
});

test('a description naming the row id maps to it; a plain id works too', () => {
  const byRow = rowAgents(ROWS, [agent('a1', { name: 'polish.s3.menu build' }), agent('a2', { name: 'vm-qr-release fix' })], always(runs([0, 5])));
  assert.deepEqual([...byRow.keys()].sort(), ['polish.s3.menu', 'vm-qr-release']);
});

test('the launch record row wins over the description; a record naming a row that is not open maps to none', () => {
  const agents = [agent('a1', { name: 'Lane cart', row: 'polish.s3.menu' }), agent('a2', { name: 'Lane cart', row: 'polish.s3.done-lane' })];
  const byRow = rowAgents(ROWS, agents, always(runs([0, 5])));
  assert.deepEqual([...byRow.keys()], ['polish.s3.menu']);
});

test('F1: a description naming two lanes, two ids, another road or a lane open in two roads maps to no row', () => {
  const twoRoads = [...ROWS, item('vm.s1.cart')];
  const cases = [
    [ROWS, 'Lane cart and lane menu'],
    [ROWS, 'polish.s3.cart polish.s3.menu'],
    [ROWS, 'Lane cart of road uifix'],
    [ROWS, 'uifix.s1.cart rework'],
    [ROWS, 'Lane cart polish.s2.cart'],
    [twoRoads, 'Lane cart'],
    [twoRoads, 'Lane cart road vm road polish'],
  ];
  for (const [items, name] of cases) {
    assert.equal(rowAgents(items, [agent('a1', { name })], always(runs([0, 5]))).size, 0, name);
  }
  assert.deepEqual([...rowAgents(twoRoads, [agent('a1', { name: 'Lane cart road vm' })], always(runs([0, 5]))).keys()], ['vm.s1.cart']);
});

test('only open, started, on-clock rows get an agent: not started, done, parked, waiting and deliver rows never do', () => {
  const items = [
    item('polish.s3.cart', { evidence: 'parked: owner later phase' }),
    item('polish.s3.menu', { evidence: 'waiting: which city?' }),
    item('deliver:1', { kind: 'deliver' }),
    item('uifix.s1.pay', { started: null }),
  ];
  const agents = [agent('a1', { name: 'Lane cart' }), agent('a2', { name: 'Lane menu' }), agent('a3', { name: 'deliver:1' }), agent('a4', { name: 'Lane pay' })];
  assert.equal(rowAgents(items, agents, always(runs([0, 5]))).size, 0);
});

test('active minutes start at the row start and bridge silences up to 10 min, not longer', () => {
  const rows = [item('polish.s3.cart', { started: at(10) })];
  const byRow = rowAgents(rows, [agent('a1', { name: 'Lane cart' })], always(runs([0, 15], [25, 30], [41, 45])));
  // [10,15) + gap 10 bridged + [25,30) = 20, then an 11-min silence not counted, then [41,45) = 4
  assert.deepEqual(byRow.get('polish.s3.cart'), { agentId: 'a1', activeMin: 24, lastActiveMs: at(45) });
});

test('two agents on one row (a restart) are joined; the agent active last is the row agent', () => {
  const runsOf = { a1: runs([0, 20]), a2: runs([18, 30]) };
  const agents = [agent('a2', { name: 'Lane cart' }), agent('a1', { name: 'Lane cart' })];
  const byRow = rowAgents(ROWS, agents, (id) => runsOf[id]);
  assert.deepEqual(byRow.get('polish.s3.cart'), { agentId: 'a2', activeMin: 30, lastActiveMs: at(30) });
});

test('unknown or malformed runs and malformed agents give no entry (the row falls to the fallback rule)', () => {
  const agents = [agent('a1', { name: 'Lane cart' }), agent('bad id', { name: 'Lane menu' }), null, agent('a3', { name: 'vm-qr-release' })];
  const runsOf = { a1: null, a3: [[5, 'x']] };
  assert.equal(rowAgents(ROWS, agents, (id) => runsOf[id]).size, 0);
});

test('R5: an agent silent for 15 working minutes is quiet, 14 is not, and an idle session never makes it quiet', () => {
  const rows = [item('polish.s3.cart')];
  const byRow = new Map([['polish.s3.cart', { agentId: 'a1', activeMin: 20, lastActiveMs: at(20) }]]);
  const context = (intervals, nowMin) => ({ poolOf: always([]), intervals: runs(...intervals), nowMs: at(nowMin) });
  assert.deepEqual(quietRows(rows, byRow, context([[0, 20 + QUIET_MIN]], 20 + QUIET_MIN)), [{ id: 'polish.s3.cart', agentId: 'a1', sinceMs: at(20) }]);
  assert.deepEqual(quietRows(rows, byRow, context([[0, 20 + QUIET_MIN - 1]], 20 + QUIET_MIN - 1)), []);
  assert.deepEqual(quietRows(rows, byRow, context([[0, 20]], 120)), [], 'the job worked no minute since: a pause, not a quiet agent');
});

test('F2: with no agent a row is quiet once open longer than max(its pool 95th percentile, 90) working minutes', () => {
  const rows = [item('polish.s3.cart')];
  const pool = Array.from({ length: 20 }, (_, k) => (k + 1) * 6); // 6..120, 95th percentile 114
  const quiet = (openMin, poolOf) => quietRows(rows, new Map(), { poolOf, intervals: runs([0, openMin]), nowMs: at(openMin) });
  assert.deepEqual(quiet(114, always(pool)), []);
  assert.deepEqual(quiet(115, always(pool)), [{ id: 'polish.s3.cart', agentId: null, sinceMs: at(0) }]);
  assert.deepEqual(quiet(STALL_FLOOR_MIN, always([5, 10])), [], 'a short pool never sets the bar under the floor');
  assert.equal(quiet(STALL_FLOOR_MIN + 1, always([])).length, 1);
});

function transcriptFixture(t) {
  const root = makeTempDir('est-row-agents-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'subagents'));
  return { root, file: join(root, 'subagents', 'agent-a1.jsonl') };
}

const entry = (min, text = 'hi') => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] }, timestamp: new Date(at(min)).toISOString() })}\n`;

test('an agent transcript gives its active-minute runs; each read takes only the appended bytes (F5)', (t) => {
  const { file } = transcriptFixture(t);
  writeFileSync(file, entry(0) + entry(1) + entry(5));
  const first = readTranscriptFacts(file, null);
  assert.deepEqual(first.runs, runs([0, 2], [5, 6]));
  // Same-length garbage over the bytes already read: a reader that read the file whole again would lose minutes 0, 1 and 5.
  const fd = openSync(file, 'r+');
  writeSync(fd, 'x'.repeat(first.offset - 1), 0);
  closeSync(fd);
  appendFileSync(file, entry(6) + entry(30));
  const second = readTranscriptFacts(file, first);
  assert.deepEqual(second.runs, runs([0, 2], [5, 7], [30, 31]));
  // [0,7) with the 3-min silence bridged, then [30,31) after a 23-min silence: 8 active minutes
  assert.equal(rowAgents(ROWS, [agent('a1', { name: 'Lane cart' })], always(second.runs)).get('polish.s3.cart').activeMin, 8);
});

test('a line over 1 MiB gives its timestamp, across read pieces, and a half-written last line waits for the next read', (t) => {
  const { file } = transcriptFixture(t);
  const huge = `${JSON.stringify({ type: 'user', message: { content: 'y'.repeat(3 * 1024 * 1024) }, timestamp: new Date(at(9)).toISOString() })}\n`;
  // Cut inside the last line's timestamp value: only a reader that reads the line again whole sees minute 10.
  const cut = entry(10).length - 10;
  writeFileSync(file, entry(0) + huge + entry(10).slice(0, cut));
  const facts = readTranscriptFacts(file, null);
  assert.deepEqual(facts.runs, runs([0, 1], [9, 10]));
  appendFileSync(file, entry(10).slice(cut));
  assert.deepEqual(readTranscriptFacts(file, facts).runs, runs([0, 1], [9, 11]));
});

test('a line over 1 MiB is never held whole or decoded: an ask inside it is not read, its timestamp still counts', (t) => {
  const { file } = transcriptFixture(t);
  const block = { type: 'tool_use', id: 'toolu_big', name: 'AskUserQuestion', input: { note: 'q'.repeat(3 * 1024 * 1024) } };
  writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(at(4)).toISOString(), message: { content: [block] } })}\n`);
  const facts = readTranscriptFacts(file, null);
  assert.deepEqual(facts.open, []);
  assert.deepEqual(facts.runs, runs([4, 5]));
});

test('a link, a hard-linked file or a missing file reads as no transcript; a shorter file or a foreign cursor starts over', (t) => {
  const { root, file } = transcriptFixture(t);
  writeFileSync(file, entry(0) + entry(1));
  symlinkSync(file, join(root, 'link.jsonl'));
  assert.equal(readTranscriptFacts(join(root, 'link.jsonl'), null), null);
  assert.equal(readTranscriptFacts(join(root, 'missing.jsonl'), null), null);
  const facts = readTranscriptFacts(file, null);
  writeFileSync(file, entry(3));
  assert.deepEqual(readTranscriptFacts(file, facts).runs, runs([3, 4]), 'a shorter file is read from 0 with a new cursor');
  assert.deepEqual(readTranscriptFacts(file, { v: 1, offset: 'x' }).runs, runs([3, 4]));
  linkSync(file, join(root, 'second-name.jsonl'));
  assert.equal(readTranscriptFacts(file, null), null);
});
