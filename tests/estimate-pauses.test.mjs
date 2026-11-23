// Tests for home/tools/estimate/lib/pauses.mjs (R11 pauses and their reasons, owner decision E3) and the owner-question side of
// home/tools/estimate/lib/transcript-facts.mjs (AskUserQuestion tool_use to tool_result, F3, F5). All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_LOG_BYTES, readLimits, recordSample } from '../home/tools/estimate/lib/limits-store.mjs';
import { LIMIT_END_SLACK_MIN, PAUSE_REASONS, pausesOf, readLimitRecord } from '../home/tools/estimate/lib/pauses.mjs';
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

/** A limits folder written by the real writer: a 100 % sample at minute 9, then 14 later samples after work resumed. */
function limitsFixture(t) {
  const root = makeTempDir('est-pauses-limits-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'limits');
  mkdirSync(dir);
  const resetS = at(60) / 1000;
  assert.equal(recordSample('me', { five_hour: { used_percentage: 100, resets_at: resetS }, seven_day: null }, { dir, now: at(9) }), true);
  for (let k = 1; k <= 14; k += 1) {
    recordSample('me', { five_hour: { used_percentage: k * 3, resets_at: resetS + 5 * 3600 }, seven_day: null }, { dir, now: at(65 + 5 * k) });
  }
  return dir;
}

test('R3: the reason of a usage-limit pause still holds once its sample has left the 12-sample file (read from the 7-day log)', (t) => {
  const dir = limitsFixture(t);
  const intervals = runs([0, 10], [65, 140]);
  const reasonWith = (record) => pausesOf(intervals, [], { account: 'me', records: [record] }, at(0), at(140))[0].reason;
  assert.equal(reasonWith(readLimits('me', { dir })), IDLE, 'the file alone has lost the 100 % sample');
  assert.equal(reasonWith(readLimitRecord('me', { dir })), LIMIT);
  assert.equal(readLimitRecord('../me', { dir }), null);
  assert.equal(readLimitRecord('nobody', { dir }), null);
});

test('R3: a log with a second hard link, a linked log or a torn line is not trusted; the file still counts', (t) => {
  const dir = limitsFixture(t);
  const log = join(dir, 'me.jsonl');
  appendFileSync(log, '{"t":17954');
  assert.equal(readLimitRecord('me', { dir }).samples.length, 15, 'the torn line is skipped');
  linkSync(log, join(dir, 'second-name'));
  assert.equal(readLimitRecord('me', { dir }).samples.length, 12, 'only the file: the hard-linked log is refused');
  rmSync(join(dir, 'second-name'));
  renameSync(log, join(dir, 'elsewhere.jsonl'));
  symlinkSync(join(dir, 'elsewhere.jsonl'), log);
  assert.equal(readLimitRecord('me', { dir }).samples.length, 12, 'a link at the log name is not followed');
  rmSync(log);
  writeFileSync(log, `${JSON.stringify(fullAt(1, 60))}\n${' '.repeat(MAX_LOG_BYTES)}\n`);
  assert.equal(readLimitRecord('me', { dir }).samples.length, 12, 'a log over its writer\'s cap is not read');
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
