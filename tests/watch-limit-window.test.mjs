// Tests for the limit window a watcher learns at start: tail.mjs `lookbackBytes` (history of the file as it was at start, never new
// lines) and classify.mjs `seed` (old lines tell whether a limit window is open, and print nothing), then the CLI: a watcher started
// inside an open window still reports LIMIT_RESET, `limit-reset` alone is reachable, a watcher started after the reset is not woken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTail } from '../home/tools/watch/lib/tail.mjs';
import { createClassifier } from '../home/tools/watch/lib/classify.mjs';
import { createSessionWatcher } from '../home/tools/watch/lib/watcher.mjs';
import { startWatcher } from './watch-follow-helpers.mjs';

const at = (minutes) => new Date(Date.parse('2026-11-14T10:00:00.000Z') + minutes * 60_000).toISOString();
const line = (value) => `${JSON.stringify(value)}\n`;
const limitEntry = (minutes) => line({ type: 'assistant', timestamp: at(minutes), isApiErrorMessage: true, error: 'rate_limit', message: { content: [] } });
const reply = (minutes) => line({ type: 'assistant', timestamp: at(minutes), message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } });
const ownerPrompt = (minutes) => line({ type: 'user', timestamp: at(minutes), message: { content: 'hello' } });

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-window-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('tail lookback: the first poll hands back the last lines as history and no new lines', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, 'one\ntwo\nthree\n');
  const tail = createTail(file, { fromStart: false, lookbackBytes: 1 << 20 });
  const first = await tail.poll();
  assert.deepEqual(first.history, ['one', 'two', 'three']);
  assert.deepEqual(first.lines, []);
  await appendFile(file, 'four\n');
  const second = await tail.poll();
  assert.deepEqual(second.lines, ['four']);
  assert.deepEqual(second.history, []);
});

test('tail lookback: a window that starts mid-line drops the cut line, and no lookback means no history', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, 'aaaaaaaa\nbbbb\ncccc\n');
  const history = (await createTail(file, { fromStart: false, lookbackBytes: 12 }).poll()).history;
  assert.deepEqual(history, ['bbbb', 'cccc']);
  assert.deepEqual((await createTail(file, { fromStart: false }).poll()).history, []);
});

test('classifier seed: a LIMIT in old lines opens the window silently, a later reply closes it', () => {
  const classifier = createClassifier();
  classifier.seed(limitEntry(0).trim());
  const [reset] = classifier.feed(reply(7).trim());
  assert.equal(reset.kind, 'LIMIT_RESET');
  assert.match(reset.line, /after 7 min$/);
  const closed = createClassifier();
  closed.seed(limitEntry(0).trim());
  closed.seed(reply(1).trim());
  assert.deepEqual(closed.feed(reply(2).trim()).map((event) => event.kind), []);
});

test('classifier seed: a line stamped after the watcher started is an event, one stamped before or at the start is not', () => {
  const since = Date.parse(at(10));
  const classifier = createClassifier();
  assert.deepEqual(classifier.seed(ownerPrompt(9).trim(), since), []);
  assert.deepEqual(classifier.seed(ownerPrompt(10).trim(), since), []);
  assert.deepEqual(classifier.seed(ownerPrompt(11).trim(), since).map((event) => event.kind), ['PROMPT']);
});

async function follow(t, classes, { initial, repeat, seconds }) {
  const watcher = await startWatcher(t, { transcript: initial, args: ['--exit-on-event', classes], settle: true });
  const code = await watcher.appendUntilExit(repeat, seconds * 1000);
  return { exited: code !== undefined, code, output: watcher.output() };
}

test('limit-reset alone: a watcher started inside an open limit window wakes when the session replies again', async (t) => {
  const result = await follow(t, 'limit-reset', { initial: ownerPrompt(0) + limitEntry(1) + ownerPrompt(2), repeat: reply(31), seconds: 15 });
  assert.equal(result.code, 0);
  assert.equal(result.output, `eeeeeeee: ${at(31)} LIMIT_RESET resumed after 30 min\n`);
});

test('limit-reset alone: a LIMIT that arrives while watching does not wake, the reset after it does', async (t) => {
  const result = await follow(t, 'limit-reset', { initial: '', repeat: limitEntry(5) + reply(65), seconds: 15 });
  assert.equal(result.code, 0);
  assert.equal(result.output, `eeeeeeee: ${at(65)} LIMIT_RESET resumed after 60 min\n`);
});

test('a watcher started after the window closed is not woken by old lines or by ordinary replies', async (t) => {
  const result = await follow(t, 'limit-reset', { initial: limitEntry(0) + reply(10), repeat: reply(20), seconds: 4 });
  assert.equal(result.exited, false);
  assert.equal(result.output, '');
});

test('limit alone wakes on the LIMIT line and never on the reset', async (t) => {
  const woke = await follow(t, 'limit', { initial: '', repeat: limitEntry(5), seconds: 15 });
  assert.equal(woke.output, `eeeeeeee: ${at(5)} LIMIT rate_limit\n`);
  const reset = await follow(t, 'limit', { initial: limitEntry(0), repeat: reply(9), seconds: 4 });
  assert.equal(reset.exited, false);
});

test('watcher: an event written between its start and its first look is reported, older lines are not', async (t) => {
  const dir = await scratch(t);
  const file = join(dir, 'abababab-1111-2222-3333-444444444444.jsonl');
  await writeFile(file, ownerPrompt(-5) + ownerPrompt(0) + line({ type: 'user', timestamp: at(1), message: { content: 'written after start' } }));
  const emitted = [];
  const watcher = createSessionWatcher({
    path: file, label: 'abababab', sessionId: 'abababab-1111-2222-3333-444444444444', once: false, stallMs: 99 * 60_000, sessionsDir: join(dir, 's'),
    now: () => Date.parse(at(0)), emit: (text) => emitted.push(text), record: () => {},
  });
  await watcher.poll();
  assert.deepEqual(emitted, ['abababab: OWNER written after start']);
});
