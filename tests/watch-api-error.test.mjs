// Tests for the API_ERROR and LIMIT / LIMIT_RESET events (classify.mjs + actions.mjs): transcript entries written by Claude Code when
// a request fails. Synthetic entries only; the shape (isApiErrorMessage, error class) is the one seen in real transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { actionFor } from '../home/tools/watch/lib/actions.mjs';

const at = (minute, second = 0) => `2026-11-14T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const apiError = (timestamp, error, extra = {}) => ({
  type: 'assistant', timestamp, isApiErrorMessage: true, error,
  message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 500 secret-looking body sk-live-0123456789abcdef' }] }, ...extra,
});
const reply = (timestamp) => ({ type: 'assistant', timestamp, message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } });
const run = (entries) => {
  const classifier = createClassifier();
  return entries.flatMap((entry) => classifier.feed(JSON.stringify(entry))).map((event) => ({ ...event, action: actionFor(event) }));
};

test('an API error entry is one API_ERROR action that carries the class only, never the message text', () => {
  const [event] = run([apiError(at(37), 'server_error')]);
  assert.equal(event.kind, 'API_ERROR');
  assert.equal(event.line, `${at(37)} API_ERROR server_error`);
  assert.deepEqual(event.action, { cls: 'API_ERROR', text: `${at(37)} API_ERROR server_error` });
});

test('a missing or odd error class prints "unknown", so no free text can leak through the class', () => {
  for (const error of [undefined, null, 42, 'has space and text', 'x'.repeat(100), 'a\nb']) {
    const [event] = run([apiError(at(1), error)]);
    assert.equal(event.line, `${at(1)} API_ERROR unknown`, JSON.stringify(error));
  }
});

test('an API error that is the last line of the transcript is reported', () => {
  const events = run([reply(at(0)), apiError(at(5), 'server_error')]);
  assert.deepEqual(events.map((event) => event.action?.cls).filter(Boolean), ['API_ERROR']);
});

test('an API error followed by a normal reply seconds later is still exactly one event, and no limit reset', () => {
  const events = run([apiError(at(5), 'server_error'), reply(at(5, 4))]);
  assert.deepEqual(events.map((event) => event.action?.cls).filter(Boolean), ['API_ERROR']);
  assert.ok(!events.some((event) => event.kind === 'LIMIT_RESET'));
});

test('a compaction summary that talks about an API error is not an event', () => {
  const summary = { type: 'user', timestamp: at(9), isCompactSummary: true, message: { content: 'This session is being continued. Earlier: API Error: 500 and API_ERROR in the log' } };
  assert.deepEqual(run([summary]).map((event) => event.action), [undefined]);
});

test('ordinary assistant text and tool results that mention API Error are not API_ERROR events', () => {
  const talk = { type: 'assistant', timestamp: at(2), message: { model: 'm', content: [{ type: 'text', text: 'the API Error: 500 was retried' }] } };
  assert.equal(run([talk]).some((event) => event.kind === 'API_ERROR'), false);
});

test('a rate_limit API error is a LIMIT, and the next normal reply is LIMIT_RESET with the minutes it lasted', () => {
  const events = run([apiError(at(0), 'rate_limit'), apiError(at(18), 'rate_limit'), reply(at(30))]);
  assert.deepEqual(events.map((event) => [event.kind, event.action?.cls]), [['LIMIT', 'LIMIT'], ['LIMIT', 'LIMIT'], ['LIMIT_RESET', 'LIMIT_RESET']]);
  assert.equal(events[0].line, `${at(0)} LIMIT rate_limit`);
  assert.equal(events[2].line, `${at(30)} LIMIT_RESET resumed after 30 min`);
});

test('LIMIT_RESET is reported once per window and only after a LIMIT', () => {
  const events = run([reply(at(0)), apiError(at(1), 'rate_limit'), reply(at(20)), reply(at(21))]);
  assert.deepEqual(events.filter((event) => event.kind === 'LIMIT_RESET').map((event) => event.line), [`${at(20)} LIMIT_RESET resumed after 19 min`]);
});

test('an owner prompt or a plain API error inside a limit window does not end it', () => {
  const owner = { type: 'user', timestamp: at(5), message: { content: 'are you there' } };
  const events = run([apiError(at(1), 'rate_limit'), owner, apiError(at(6), 'server_error'), reply(at(10))]);
  assert.deepEqual(events.filter((event) => event.kind === 'LIMIT_RESET').map((event) => event.line), [`${at(10)} LIMIT_RESET resumed after 9 min`]);
});
