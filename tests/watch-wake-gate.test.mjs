// Tests for `--delay-sec` and `--skip` of `--exit-on-event`: the wake gate (lib/wake.mjs) with a fake clock and a fake reply counter,
// then the real CLI. The gate is the rule: skip counts events as they arrive, a retry of one failure is one event, an api-error or
// stall is held and dropped when the session replies meanwhile, anything else wakes at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../home/tools/watch/lib/args.mjs';
import { EVENT_CLASS, internalClasses } from '../home/tools/watch/lib/events.mjs';
import { createWakeGate } from '../home/tools/watch/lib/wake.mjs';
import { STAMP, entry, startWatcher } from './watch-follow-helpers.mjs';

const HOLD_MS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { API_ERROR, STALL, OWNER } = EVENT_CLASS;

function gateWith(options = {}) {
  const state = { now: 0, replies: 0, woken: [] };
  const emit = createWakeGate({
    wanted: internalClasses(['owner', 'api-error', 'stall']), skip: 0, delayMs: 0, replies: () => state.replies, now: () => state.now,
    wake: (text, cls) => state.woken.push(`${cls}:${text}`), ...options,
  });
  return { state, emit };
}

test('gate: only wanted classes wake, and only once', () => {
  const { state, emit } = gateWith();
  emit('compact line', EVENT_CLASS.COMPACT);
  emit('first', API_ERROR);
  emit('second', OWNER);
  assert.deepEqual(state.woken, ['API_ERROR:first']);
});

test('gate: skip ignores the first events as they arrive, whatever happens after', () => {
  const { state, emit } = gateWith({ skip: 1 });
  emit('one', OWNER);
  state.replies += 5; // the lead worked after the first event: the backup must still skip it and still catch the next one
  state.now += 120_000;
  emit('two', OWNER);
  assert.deepEqual(state.woken, ['OWNER:two']);
});

test('gate: five retries of one error within a minute are one event; a minute later it is a new one', () => {
  const { state, emit } = gateWith({ skip: 1 });
  for (let retry = 0; retry < 5; retry += 1) { emit(`retry ${retry}`, API_ERROR); state.now += 10_000; }
  assert.deepEqual(state.woken, [], 'all five count as the one skipped event');
  state.now += 60_000;
  emit('later', API_ERROR);
  assert.deepEqual(state.woken, ['API_ERROR:later']);
});

test('gate: an api-error is held and wakes when the session did not reply meanwhile', async () => {
  const { state, emit } = gateWith({ delayMs: HOLD_MS });
  emit('down', API_ERROR);
  emit('retry while held', API_ERROR);
  assert.deepEqual(state.woken, [], 'held, not woken yet');
  await sleep(HOLD_MS * 3);
  assert.deepEqual(state.woken, ['API_ERROR:down']);
});

test('gate: a reply during the hold drops the event, and the next failure counts again at once', async () => {
  const { state, emit } = gateWith({ delayMs: HOLD_MS });
  emit('blip', STALL);
  state.replies += 1;
  await sleep(HOLD_MS * 3);
  assert.deepEqual(state.woken, [], 'recovered on its own');
  state.now += 1000; // far inside the retry window of the dropped event: it must not hide a new failure
  emit('real outage', STALL);
  await sleep(HOLD_MS * 3);
  assert.deepEqual(state.woken, ['STALL:real outage']);
});

test('gate: a reply written before the event does not count as recovery, and an owner prompt is never held', async () => {
  const { state, emit } = gateWith({ delayMs: HOLD_MS });
  state.replies = 7;
  emit('down', API_ERROR);
  emit('owner typed', OWNER);
  assert.deepEqual(state.woken, ['OWNER:owner typed']);
  await sleep(HOLD_MS * 3);
  assert.deepEqual(state.woken, ['OWNER:owner typed'], 'the held line is dropped once something woke');
});

test('gate: skip then delay, the backup case: first failure skipped, the second is held and wakes', async () => {
  const { state, emit } = gateWith({ skip: 1, delayMs: HOLD_MS });
  emit('first failure', API_ERROR);
  state.replies += 3; // the woken lead works, then hits the outage again
  state.now += 100_000;
  emit('second failure', API_ERROR);
  await sleep(HOLD_MS * 3);
  assert.deepEqual(state.woken, ['API_ERROR:second failure']);
});

test('parseArgs: --delay-sec and --skip are validated and need --exit-on-event', () => {
  const ok = parseArgs(['abcdef', '--exit-on-event', 'api-error', '--delay-sec', '90', '--skip', '1']);
  assert.equal(ok.delaySec, 90);
  assert.equal(ok.skip, 1);
  assert.equal(parseArgs(['abcdef', '--exit-on-event', '--delay-sec', '1.5']).delaySec, 1.5);
  assert.equal(parseArgs(['abcdef', '--exit-on-event']).skip, undefined);
  for (const bad of [['--delay-sec', '-1'], ['--delay-sec', 'x'], ['--delay-sec', ''], ['--skip', '1.5'], ['--skip', '-1'], ['--skip', 'x'], ['--skip']]) {
    assert.throws(() => parseArgs(['abcdef', '--exit-on-event', ...bad]), UsageError, bad.join(' '));
  }
  assert.throws(() => parseArgs(['abcdef', '--delay-sec', '5']), /only work with --exit-on-event/);
  assert.throws(() => parseArgs(['abcdef', '--skip', '1']), /only work with --exit-on-event/);
});

const apiError = entry({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { content: [] } });
const reply = entry({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } });
const ownerPrompt = entry({ type: 'user', message: { content: 'hello' } });
const FAIL_LINE = `eeeeeeee: ${STAMP} API_ERROR server_error\n`;

test('cli --delay-sec: a reply within the delay drops the api error and the watcher keeps running', async (t) => {
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'api-error', '--delay-sec', '3'], settle: true });
  await watcher.append(apiError);
  await sleep(500);
  await watcher.append(reply);
  assert.equal(await watcher.waitForExit(7_000), undefined, 'recovered, so no wake');
  assert.equal(watcher.output(), '');
});

test('cli --delay-sec: with no reply the api error wakes, but not before the delay', async (t) => {
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'api-error', '--delay-sec', '2'], settle: true });
  const sentAt = Date.now();
  await watcher.append(apiError);
  assert.equal(await watcher.waitForExit(15_000), 0);
  assert.ok(Date.now() - sentAt >= 1_900, 'held for the delay');
  assert.equal(watcher.output(), FAIL_LINE);
});

test('cli --skip 1: one event is ignored, a second event of another class wakes', async (t) => {
  const watcher = await startWatcher(t, { args: ['--exit-on-event', 'api-error,owner', '--skip', '1'], settle: true });
  await watcher.append(apiError);
  assert.equal(await watcher.waitForExit(4_000), undefined, 'one event: skipped');
  assert.equal(await watcher.appendUntilExit(ownerPrompt, 15_000), 0);
  assert.equal(watcher.output(), 'eeeeeeee: OWNER hello\n');
});
