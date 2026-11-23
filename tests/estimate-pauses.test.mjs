// Tests for home/tools/estimate/lib/pauses.mjs (R11 pauses and their reasons, owner decision E3) and the owner-question side of
// home/tools/estimate/lib/transcript-facts.mjs (AskUserQuestion tool_use to tool_result, F3, F5). All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIMIT_END_SLACK_MIN, PAUSE_REASONS, pausesOf } from '../home/tools/estimate/lib/pauses.mjs';
import { asksOf, readTranscriptFacts } from '../home/tools/estimate/lib/transcript-facts.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BASE_MS = Date.UTC(2026, 10, 23, 6, 0, 0);
const MIN_MS = 60_000;
const BASE_MIN = BASE_MS / MIN_MS;
const at = (min) => BASE_MS + min * MIN_MS;
const runs = (...pairs) => pairs.map(([from, to]) => [BASE_MIN + from, BASE_MIN + to]);
const NO_LIMITS = { account: 'me', records: [] };
const [WAITING, LIMIT, IDLE] = PAUSE_REASONS;
const fullAt = (sampleMin, resetMin) => ({ t: at(sampleMin), five_hour: { used_percentage: 100, resets_at: at(resetMin) / 1000 }, seven_day: null });

test('a silence over 10 min is a pause, 10 min is working time, and a silence still going on runs to now', () => {
  assert.deepEqual(pausesOf(runs([0, 10], [20, 30]), [], NO_LIMITS, at(0), at(30)), [], '10 min is bridged');
  assert.deepEqual(pausesOf(runs([0, 10], [21, 30]), [], NO_LIMITS, at(0), at(30)), [{ fromMs: at(10), toMs: at(21), reason: IDLE }]);
  assert.deepEqual(pausesOf(runs([0, 10]), [], NO_LIMITS, at(0), at(45)), [{ fromMs: at(10), toMs: at(45), reason: IDLE }]);
  assert.deepEqual(pausesOf(runs([0, 10]), [], NO_LIMITS, at(0), at(20)), []);
});

test('no activity at all claims no pause; a pause is clipped to [sinceMs, now] but qualifies by its whole length', () => {
  assert.deepEqual(pausesOf([], [], NO_LIMITS, at(0), at(600)), []);
  assert.deepEqual(pausesOf(runs([0, 10], [40, 50]), [], NO_LIMITS, at(35), at(50)), [{ fromMs: at(35), toMs: at(40), reason: IDLE }]);
  assert.deepEqual(pausesOf(runs([0, 10], [40, 50]), [], NO_LIMITS, at(45), at(50)), [], 'a pause before sinceMs moves nothing');
});

test('an owner wait over the silence makes it "waiting for you"; one answered before it does not', () => {
  const intervals = runs([0, 10], [50, 60]);
  assert.equal(pausesOf(intervals, [{ fromMs: at(9.5), toMs: at(50.2) }], NO_LIMITS, at(0), at(60))[0].reason, WAITING);
  assert.equal(pausesOf(intervals, [{ fromMs: at(5), toMs: at(9.8) }], NO_LIMITS, at(0), at(60))[0].reason, IDLE);
  assert.equal(pausesOf(intervals, [{ fromMs: 'x' }, null], NO_LIMITS, at(0), at(60))[0].reason, IDLE, 'malformed waits are skipped');
});

test('usage limit: the silence ends within 10 min after a recorded 5-hour reset at 100 %, or is still going on before it', () => {
  const intervals = runs([0, 10], [65, 70]);
  const limits = (samples, account = 'me') => ({ account: 'me', records: [{ account, samples }] });
  const reason = (samples, list = intervals, nowMin = 70) => pausesOf(list, [], limits(samples), at(0), at(nowMin))[0].reason;
  assert.equal(reason([fullAt(9, 60)]), LIMIT);
  assert.equal(reason([fullAt(9, 65 - LIMIT_END_SLACK_MIN)]), LIMIT);
  assert.equal(reason([fullAt(9, 65 - LIMIT_END_SLACK_MIN - 1)]), IDLE, 'ended too long after the reset');
  assert.equal(reason([{ ...fullAt(9, 60), five_hour: { used_percentage: 99, resets_at: at(60) / 1000 } }]), IDLE);
  assert.equal(reason([fullAt(9, 90)], runs([0, 10]), 40), LIMIT, 'still limited now');
  assert.equal(reason([fullAt(9, 90)]), IDLE, 'an ended silence must end after the reset');
  assert.equal(reason([fullAt(61, 60)]), IDLE, 'a sample written after its own reset proves no limit');
});

test('F4: limits of another account, or no job account, are never used', () => {
  const intervals = runs([0, 10], [65, 70]);
  const other = { account: 'me', records: [{ account: 'pc-account', samples: [fullAt(9, 60)] }] };
  const noAccount = { account: null, records: [{ account: 'me', samples: [fullAt(9, 60)] }] };
  assert.equal(pausesOf(intervals, [], other, at(0), at(70))[0].reason, IDLE);
  assert.equal(pausesOf(intervals, [], noAccount, at(0), at(70))[0].reason, IDLE);
  assert.equal(pausesOf(intervals, [], null, at(0), at(70))[0].reason, IDLE);
});

test('waiting for you is tried before usage limit; a wrong call shape throws', () => {
  const limits = { account: 'me', records: [{ account: 'me', samples: [fullAt(9, 60)] }] };
  assert.equal(pausesOf(runs([0, 10], [65, 70]), [{ fromMs: at(9), toMs: at(65) }], limits, at(0), at(70))[0].reason, WAITING);
  assert.throws(() => pausesOf(null, [], NO_LIMITS, at(0), at(1)), TypeError);
  assert.throws(() => pausesOf([], [], NO_LIMITS, Number.NaN, at(1)), TypeError);
});

const iso = (min) => new Date(at(min)).toISOString();
const askLine = (min, id) => `${JSON.stringify({ type: 'assistant', timestamp: iso(min), message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: [] } }] } })}\n`;
const answerLine = (min, id) => `${JSON.stringify({ type: 'user', timestamp: iso(min), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })}\n`;
const textLine = (min) => `${JSON.stringify({ type: 'assistant', timestamp: iso(min), message: { content: [{ type: 'text', text: 'hi' }] } })}\n`;

function mainTranscript(t) {
  const root = makeTempDir('est-pauses-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'session.jsonl');
}

test('the main transcript gives each AskUserQuestion from tool_use to its tool_result, and the pause reads as waiting', (t) => {
  const file = mainTranscript(t);
  writeFileSync(file, textLine(0) + askLine(9, 'toolu_1') + answerLine(40, 'toolu_1') + textLine(41) + answerLine(42, 'toolu_other'));
  const facts = readTranscriptFacts(file, null);
  assert.deepEqual(asksOf(facts), [{ fromMs: at(9), toMs: at(40) }]);
  assert.deepEqual(pausesOf(facts.runs, asksOf(facts), NO_LIMITS, at(0), at(42)), [{ fromMs: at(10), toMs: at(40), reason: WAITING }]);
});

test('F3: an ask with no tool_result (the session ended) closes at the transcript end, never an endless wait', (t) => {
  const file = mainTranscript(t);
  writeFileSync(file, textLine(0) + askLine(9, 'toolu_1') + textLine(9.5));
  const facts = readTranscriptFacts(file, null);
  assert.deepEqual(asksOf(facts), [{ fromMs: at(9), toMs: at(9.5) }]);
  assert.deepEqual(pausesOf(facts.runs, asksOf(facts), NO_LIMITS, at(0), at(600)), [{ fromMs: at(10), toMs: at(600), reason: IDLE }]);
});

test('F5: an ask past a 3 MiB line and an answer appended later are found; only new bytes are read', (t) => {
  const file = mainTranscript(t);
  const filler = `${JSON.stringify({ type: 'user', timestamp: iso(1), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'z'.repeat(3 * 1024 * 1024) }] } })}\n`;
  writeFileSync(file, textLine(0) + filler + askLine(9, 'toolu_1'));
  const first = readTranscriptFacts(file, null);
  assert.deepEqual(first.open.map((ask) => ask.id), ['toolu_1']);
  const notAnAnswer = answerLine(20, 'toolu_1').replace('"type":"user"', '"type":"assistant"'); // only a user line answers
  appendFileSync(file, notAnAnswer + answerLine(30, 'toolu_1'));
  const second = readTranscriptFacts(file, first);
  assert.deepEqual(asksOf(second), [{ fromMs: at(9), toMs: at(30) }]);
  assert.equal(second.offset > first.offset, true);
  assert.deepEqual(readTranscriptFacts(file, second), second, 'nothing new: the same facts');
});
