// Purpose: browser-free tests for the v2 `batch` machinery: --jobs parsing, the parallel/serial split (figma states never run in parallel), the
// worker pool, the progress line, and --resume (which states are skipped, what is read back from disk). Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPriorRecords, writePartialResults } from '../lib/batch-records.mjs';
import { parseJobs, partitionStates, progressLine, resumeFilter, runPool } from '../lib/batch-schedule.mjs';
import { UsageError } from '../lib/errors.mjs';

const state = (index, extra = {}) => ({ index, surface: 'signup', state: `s${index}`, locale: 'fa', widths: [320], figma: null, ...extra });
const rec = (st, status = 'pass', width = 320) => ({ surface: st.surface, state: st.state, locale: st.locale, width, status, evidence: 'e', findings: [] });

test('--jobs: default 4, a positive integer, anything else is a UsageError naming the flag', () => {
  assert.equal(parseJobs(undefined), 4);
  assert.equal(parseJobs('1'), 1);
  assert.equal(parseJobs('8'), 8);
  for (const bad of ['0', '-1', '2.5', 'many', '']) assert.throws(() => parseJobs(bad), (e) => e instanceof UsageError && /--jobs/.test(e.message), bad);
});

test('states with a figma part run serially after the rest; the rest keeps the file order', () => {
  const states = [state(0), state(1, { figma: { cache: 'c' } }), state(2), state(3, { figma: { cache: 'c' } })];
  const { parallel, serial } = partitionStates(states);
  assert.deepEqual(parallel.map((s) => s.index), [0, 2]);
  assert.deepEqual(serial.map((s) => s.index), [1, 3]);
});

test('runPool never runs more than N at once, runs every item once, and passes the item', async () => {
  let running = 0;
  let peak = 0;
  const seen = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(item);
    running -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.toSorted(), [1, 2, 3, 4, 5, 6, 7]);
  await runPool([], 4, async () => assert.fail('nothing to run'));
});

test('runPool with one job is sequential, and a throwing worker rejects the pool', async () => {
  const order = [];
  await runPool([1, 2, 3], 1, async (item) => { await new Promise((resolve) => setTimeout(resolve, 3 - item)); order.push(item); });
  assert.deepEqual(order, [1, 2, 3]);
  await assert.rejects(runPool([1, 2], 2, async () => { throw new Error('boom'); }), /boom/);
});

test('progress line: [done/total] surface state locale widths status seconds', () => {
  const st = state(11, { surface: 'signup', state: 'role:open', locale: 'fa' });
  assert.equal(progressLine({ done: 12, total: 201, state: st, records: [rec(st, 'fail', 320)], ms: 1400 }), '[12/201] signup role:open fa 320 fail 1.4s');
  const multi = state(0, { locale: null });
  assert.equal(progressLine({ done: 1, total: 2, state: multi, records: [rec(multi, 'pass', 320), rec(multi, 'fail', 1280), rec(multi, 'pass', 320)], ms: 20 }), '[1/2] signup s0 - 320,1280 fail 0.0s');
});

test('resume: a state whose records all pass is skipped and its old records are reused; failing or missing ones are re-run', () => {
  const [a, b, c, d] = [state(0), state(1), state(2), state(3, { widths: [320, 390] })];
  const prior = [rec(a), rec(b, 'fail'), rec(d, 'pass', 320)];
  const { todo, reused } = resumeFilter([a, b, c, d], prior);
  assert.deepEqual(todo.map((s) => s.index), [1, 2, 3], 'b failed, c has no records, d lacks its 390 record');
  assert.deepEqual([...reused.keys()], [0]);
  assert.deepEqual(reused.get(0), [rec(a)]);
});

test('resume: one failing record among passing ones of a state re-runs the whole state', () => {
  const a = state(0, { widths: [320, 390] });
  const { todo } = resumeFilter([a], [rec(a, 'pass', 320), rec(a, 'fail', 390)]);
  assert.equal(todo.length, 1);
});

test('readPriorRecords merges results.json with results.partial.json (the partial one is newer), nothing on disk gives []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-prior-'));
  assert.deepEqual(readPriorRecords(dir), []);
  const a = state(0);
  const b = state(1);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify([rec(a, 'fail'), rec(b)]));
  writePartialResults(dir, [rec(a, 'pass')]);
  const merged = readPriorRecords(dir);
  assert.deepEqual(merged.map((r) => [r.state, r.status]), [['s1', 'pass'], ['s0', 'pass']]);
  fs.writeFileSync(path.join(dir, 'results.json'), '{nope');
  assert.throws(() => readPriorRecords(dir), (e) => e instanceof UsageError && /results\.json/.test(e.message));
});
