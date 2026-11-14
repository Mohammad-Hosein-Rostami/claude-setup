// Tests for home/tools/watch/lib/stall.mjs (injected clock) and lib/tail.mjs (real temp files): the stall detector fires once
// then reports RESUMED, and the tail keeps a partial last line until its newline arrives, survives truncation and late files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStallDetector } from '../home/tools/watch/lib/stall.mjs';
import { createTail } from '../home/tools/watch/lib/tail.mjs';

const MIN = 60_000;

test('stall: silent until the limit, STALL once, RESUMED when a write lands', () => {
  const detector = createStallDetector(20 * MIN);
  assert.equal(detector.check(0, 19 * MIN), undefined);
  assert.deepEqual(detector.check(0, 21 * MIN), { type: 'STALL', idleMs: 21 * MIN });
  assert.equal(detector.check(0, 40 * MIN), undefined, 'one STALL per stall');
  assert.equal(detector.check(0, 90 * MIN), undefined);
  assert.deepEqual(detector.check(95 * MIN, 96 * MIN), { type: 'RESUMED', idleMs: MIN });
  assert.equal(detector.check(95 * MIN, 97 * MIN), undefined);
  assert.deepEqual(detector.check(95 * MIN, 116 * MIN), { type: 'STALL', idleMs: 21 * MIN }, 'a second stall fires again');
});

test('stall: an unknown last write (no file yet) never stalls', () => {
  assert.equal(createStallDetector(MIN).check(undefined, 99 * MIN), undefined);
});

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-tail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('tail: from the end skips old content and returns only new complete lines', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, 'old1\nold2\n');
  const tail = createTail(file, { fromStart: false });
  assert.deepEqual((await tail.poll()).lines, []);
  await appendFile(file, 'new1\nnew2\n');
  assert.deepEqual((await tail.poll()).lines, ['new1', 'new2']);
});

test('tail: a partial last line is kept until its newline arrives', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, '');
  const tail = createTail(file, { fromStart: false });
  await tail.poll();
  await appendFile(file, 'first\nsec');
  assert.deepEqual((await tail.poll()).lines, ['first']);
  await appendFile(file, 'ond\nthird');
  assert.deepEqual((await tail.poll()).lines, ['second']);
  await appendFile(file, '\n');
  assert.deepEqual((await tail.poll()).lines, ['third']);
});

test('tail: a multi-byte character split across two reads is not corrupted', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, '');
  const tail = createTail(file, { fromStart: false });
  await tail.poll();
  const bytes = Buffer.from('café\n');
  await appendFile(file, bytes.subarray(0, 4));
  assert.deepEqual((await tail.poll()).lines, []);
  await appendFile(file, bytes.subarray(4));
  assert.deepEqual((await tail.poll()).lines, ['café']);
});

test('tail: truncation restarts from the beginning', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, 'aaaa\nbbbb\n');
  const tail = createTail(file, { fromStart: false });
  await tail.poll();
  await truncate(file, 0);
  await appendFile(file, 'c\n');
  assert.deepEqual((await tail.poll()).lines, ['c']);
});

test('tail: a file that appears later is read from its first byte', async (t) => {
  const file = join(await scratch(t), 'later.jsonl');
  const tail = createTail(file, { fromStart: false });
  const missing = await tail.poll();
  assert.deepEqual(missing.lines, []);
  assert.equal(missing.mtimeMs, undefined);
  await writeFile(file, 'hello\n');
  const found = await tail.poll();
  assert.deepEqual(found.lines, ['hello']);
  assert.equal(typeof found.mtimeMs, 'number');
});

test('tail: fromStart reads existing content, and finish() flushes an unterminated last line', async (t) => {
  const file = join(await scratch(t), 't.jsonl');
  await writeFile(file, 'one\ntwo');
  const tail = createTail(file, { fromStart: true });
  assert.deepEqual((await tail.poll()).lines, ['one']);
  assert.deepEqual(tail.finish(), ['two']);
  assert.deepEqual(tail.finish(), []);
});
