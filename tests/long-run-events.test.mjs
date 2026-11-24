// Tests of the events (spec 19.3, 19.6; acceptance 14): one numbered line per event in the global events.log and one in the run's
// events.jsonl, rotation at 1 MB with the number kept, `events --follow [--after n]`, `--wait-next` (next lines or idle), one
// `driver-lost` per dead driver, and no prompt, question or token in any line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_LINE_MAX_CHARS, EVENTS_ROTATE_BYTES, readEventLines, recordEvent, reportLostDrivers } from '../home/tools/long-run/lib/events.mjs';
import { readJsonLines, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, driveRun, makeSandbox, startCli, waitFor } from './long-run-helpers.mjs';

const KINDS = ['run-started', 'step-started', 'step-done', 'step-failed', 'waiting-limit', 'waiting-retry', 'needs-owner', 'blocked', 'paused',
  'taken-over', 'told', 'resumed', 'run-done', 'run-stopped', 'run-abandoned', 'driver-lost'];

test('each event kind is one global line of at most 160 characters, numbered in order, and one events.jsonl line', () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'kinds', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  for (const event of KINDS) recordEvent(paths, { event, step: 'one', detail: `${'long detail '.repeat(30)}\nsecond line` });
  const lines = readEventLines(box.root);
  assert.equal(lines.length, KINDS.length);
  lines.forEach((line, index) => {
    assert.ok(line.length <= EVENT_LINE_MAX_CHARS, line);
    assert.match(line, new RegExp(`^#${index + 1} \\d{2}:\\d{2} ${paths.runId} one ${KINDS[index]} long detail`));
    assert.ok(!line.includes('\n'));
  });
  assert.deepEqual(readJsonLines(paths.events).map((entry) => entry.event), KINDS);
});

test('rotation past 1 MB moves the log to events.log.1 and the numbers go on', () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'rotate', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  const shortestLine = 120; // every line here is longer, so this many lines pass the cap
  const count = Math.ceil(EVENTS_ROTATE_BYTES / shortestLine) + 10;
  for (let n = 0; n < count; n += 1) recordEvent(paths, { event: 'told', step: 'one', detail: 'x'.repeat(100) });
  assert.ok(existsSync(join(box.root, 'events.log.1')));
  assert.ok(statSync(join(box.root, 'events.log')).size < EVENTS_ROTATE_BYTES);
  const lines = readEventLines(box.root);
  assert.equal(lines.at(-1).split(' ')[0], `#${count}`);
  assert.equal(readFileSync(join(box.root, 'events.seq'), 'utf8').trim(), String(count));
});

test('a real run writes run-started, step-started, needs-owner lines with no prompt, question or token in them', async () => {
  const box = makeSandbox();
  box.script({ one: ['done'], two: ['needs-owner'] });
  const paths = createRun(box, { name: 'real', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'SECRET-PROMPT one.' }, { id: 'two', prompt: 'SECRET-PROMPT two.' }] });
  await driveRun(box, paths);
  const text = readFileSync(join(box.root, 'events.log'), 'utf8');
  for (const event of ['run-started', 'step-started', 'step-done', 'needs-owner']) assert.match(text, new RegExp(` ${event}( |$)`, 'm'));
  for (const banned of ['SECRET-PROMPT', 'colour', 'sk-ant-']) assert.ok(!text.includes(banned), banned);
  assert.ok(!readFileSync(paths.events, 'utf8').includes('colour'));
});

test('events --follow prints a line appended after it started within 2 s; --after 3 first prints lines 4 and up', async () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'follow', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  for (let n = 1; n <= 5; n += 1) recordEvent(paths, { event: 'told', step: 'one', detail: `old ${n}` });
  const follower = startCli(box, ['events', '--follow', '--after', '3']);
  await waitFor(() => follower.output.includes('old 5'), 10000, 'old lines above 3');
  assert.ok(!follower.output.includes('old 3') && follower.output.includes('old 4'));
  const appendedAt = Date.now();
  recordEvent(paths, { event: 'step-done', step: 'one', detail: 'fresh' });
  await waitFor(() => follower.output.includes('step-done fresh'), 2000, 'the new line within 2 s');
  assert.ok(Date.now() - appendedAt <= 2000);
  follower.kill('SIGINT');
  assert.equal(await new Promise((resolve) => { follower.once('close', resolve); }), 0);
  const plain = cli(box, ['events', '--since', '2']);
  assert.deepEqual(plain.stdout.trim().split('\n').map((line) => line.split(' ')[0]), ['#5', '#6']);
});

test('events --wait-next exits 0 after the next line(s), and after its wait cap with "#<n> idle"', async () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'next', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  recordEvent(paths, { event: 'told', step: 'one', detail: 'first' });
  const waiter = startCli(box, ['events', '--wait-next', '--after', '1']);
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  recordEvent(paths, { event: 'step-done', step: 'one', detail: 'second' });
  recordEvent(paths, { event: 'run-done', detail: 'third' });
  assert.equal(await new Promise((resolve) => { waiter.once('close', resolve); }), 0);
  assert.deepEqual(waiter.output.trim().split('\n').map((line) => line.split(' ')[0]), ['#2', '#3'], 'lines within 2 s come together');
  const idle = cli(box, ['events', '--wait-next', '--after', '3', '--max-wait', '1']);
  assert.equal(idle.status, 0);
  assert.equal(idle.stdout.trim(), '#3 idle');
});

test('driver-lost is written once for a run whose driver died', () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'lost', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  writeJson(paths.driver, { pid: 999999, host: 'gone', status: 'running', beatAt: '2026-01-01T00:00:00.000Z', live: {} });
  writeJson(paths.lock, {});
  assert.equal(reportLostDrivers(box.root), 1);
  assert.equal(reportLostDrivers(box.root), 0);
  const lost = readEventLines(box.root).filter((line) => line.includes(' driver-lost '));
  assert.equal(lost.length, 1);
  assert.match(lost[0], new RegExp(`${paths.runId} - driver-lost driver pid 999999 is gone; resume with: long-run resume ${paths.runId}`));
});
