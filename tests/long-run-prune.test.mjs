// Tests of `prune [--older-than <days>]` (audit H14): a finished run's folder (with its checkpoints) is removed once it is old
// enough; a running, held or younger run is never pruned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, driveRun, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

// The run's end time must be real: prune compares it with the real clock of the CLI.
const realClock = { now: () => new Date(), sleep: async () => {}, slept: [] };
const oneStep = (box, name, folder) => ({ name, cwd: box.work(folder), steps: [{ id: 'one', prompt: 'One.' }] });

test('prune --older-than 0 removes a done run\'s folder; a held run and a running run stay', async () => {
  const box = makeSandbox();
  box.script({ one: ['done'], held: ['blocked'] });
  const done = createRun(box, oneStep(box, 'finished', 'a'));
  assert.equal(await driveRun(box, done, { clock: realClock }), 'done');
  const held = createRun(box, { name: 'waiting', cwd: box.work('b'), steps: [{ id: 'held', prompt: 'Held.' }] });
  assert.equal(await driveRun(box, held), 'held');
  box.script({ one: ['hang'], held: ['blocked'] });
  const started = cli(box, ['start', box.writeJob(oneStep(box, 'busy', 'c'))]);
  const running = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  await waitFor(() => readJson(running.driver)?.live?.one?.state === 'running' && readCalls(box).some((call) => call.mode === 'hang'), 30000, 'running');
  const result = cli(box, ['prune', '--older-than', '0']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [`pruned ${done.runId}`]);
  assert.ok(!existsSync(done.dir));
  assert.ok(existsSync(held.checkpoints), 'the held run keeps its checkpoints');
  assert.ok(existsSync(running.dir), 'the running run stays');
  assert.equal(cli(box, ['stop', running.runId]).status, 0);
  await waitFor(() => readJson(running.driver)?.status === 'stopped', 30000, 'stopped');
});

test('prune keeps a done run younger than --older-than (default 30 days) and refuses a bad number', async () => {
  const box = makeSandbox();
  const done = createRun(box, oneStep(box, 'recent', 'a'));
  await driveRun(box, done, { clock: realClock });
  assert.equal(cli(box, ['prune']).stdout.trim(), 'no finished run older than 30 day(s)');
  assert.ok(existsSync(done.dir));
  assert.equal(cli(box, ['prune', '--older-than', 'ten']).status, 2);
});
