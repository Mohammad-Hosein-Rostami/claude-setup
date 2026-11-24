// Tests of the CLI surface (spec 7.9, 19.4): exit codes, the short `status` lines and `--json`, `log --tail` and `--raw`, `summary`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { RUN_STATES } from '../home/tools/long-run/lib/view.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeModuleError, assertInstallStamp } from '../home/tools/long-run/lib/driver.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { cli, createRun, driveRun, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

test('exit codes: 2 for usage, 3 for no such run or step, 4 for a run whose driver runs', async () => {
  const box = makeSandbox();
  assert.equal(cli(box, ['frobnicate']).status, 2);
  assert.equal(cli(box, ['resume', 'x', '--answer']).status, 2);
  assert.equal(cli(box, ['status', 'nope-20260101-000000']).status, 3);
  assert.equal(cli(box, ['status', '../../etc']).status, 3);
  box.script({ one: ['hang', 'done'] });
  const started = cli(box, ['start', box.writeJob({ name: 'busy', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] })]);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  await waitFor(() => readJson(paths.driver)?.live?.one, 20000, 'one running');
  // live.one is set at spawn; the fake records its call only after it boots and reads stdin, and a stop before that kills it unrecorded.
  await waitFor(() => readCalls(box).length === 1, 20000, 'the fake claude recorded its call');
  assert.equal(cli(box, ['pause', paths.runId, 'nostep']).status, 3);
  const busy = cli(box, ['resume', paths.runId]);
  assert.equal(busy.status, 4);
  assert.match(busy.stderr, /is running; pause or stop it first/);
  const second = cli(box, ['start', box.writeJob({ name: 'busy', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] }, 'again.json')]);
  assert.equal(second.status, 4, 'one live run per folder');
  assert.match(second.stderr, new RegExp(`is used by live run ${paths.runId}`));
  assert.equal(cli(box, ['stop', paths.runId]).status, 0);
  await waitFor(() => readJson(paths.driver)?.status === 'stopped', 30000, 'stopped');
  assert.equal(readCalls(box).length, 1);
});

test('status: one line per run; status <run>: a line per step; --json gives the same as data', async () => {
  const box = makeSandbox();
  box.script({ two: ['needs-owner'] });
  const paths = createRun(box, { name: 'lines', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }, { id: 'two', prompt: 'Two.' }] });
  await driveRun(box, paths);
  const all = cli(box, ['status']).stdout.trim().split('\n');
  assert.deepEqual(all, [`${paths.runId} held account=acct-a done=1/2`]);
  const one = cli(box, ['status', paths.runId]).stdout.trim().split('\n');
  assert.equal(one[0], `${paths.runId} held account=acct-a`);
  assert.match(one[1], /^ {2}one done starts=1$/);
  assert.match(one[2], /^ {2}two needs-owner starts=1 question: Which colour should the button be\?$/);
  assert.match(one.at(-1), /^ {2}held at two: needs-owner - Which colour/);
  const json = JSON.parse(cli(box, ['status', paths.runId, '--json']).stdout);
  assert.ok(RUN_STATES.includes(json.state));
  assert.deepEqual(json.steps.map((step) => [step.id, step.status]), [['one', 'done'], ['two', 'needs-owner']]);
});

test('log --tail N prints the last N readable lines (default 20), --raw the stream lines; summary prints summary.md', async () => {
  const box = makeSandbox();
  const paths = createRun(box, { name: 'logs', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });
  await driveRun(box, paths);
  const readable = cli(box, ['log', paths.runId, 'one']).stdout.trim().split('\n');
  assert.deepEqual(readable, [`session ${readJson(`${paths.steps}/one.json`).sessionId} (claude-opus-5-5)`, 'Working on one.', 'result: success: STEP-RESULT: done']);
  assert.deepEqual(cli(box, ['log', paths.runId, 'one', '--tail', '1']).stdout.trim().split('\n'), ['result: success: STEP-RESULT: done']);
  const raw = cli(box, ['log', paths.runId, 'one', '--raw', '--tail', '1']).stdout.trim();
  assert.equal(JSON.parse(raw).type, 'result');
  const summary = cli(box, ['summary', paths.runId]);
  assert.match(summary.stdout, /^# long-run logs-/);
  assert.match(summary.stdout, /\| one \| done \| 1 \| 0 \|/);
});

test('install stamp of another Node ABI: refused with both ABIs and the install fix; same ABI, an old stamp or none pass', () => {
  const dir = makeTempDir('long-run-stamp-');
  const stampPath = join(dir, '.lock-sha256');
  writeFileSync(stampPath, `${'a'.repeat(64)}:137`);
  assert.throws(() => assertInstallStamp({ stampPath, abi: '147' }), (error) => error instanceof NativeModuleError
    && /installed for Node ABI 137, this Node .* has ABI 147: run scripts\/install\.sh in the setup repo \(Windows: scripts\/install\.ps1\)$/.test(error.message));
  assert.doesNotThrow(() => assertInstallStamp({ stampPath, abi: '137' }));
  writeFileSync(stampPath, 'a'.repeat(64));
  assert.doesNotThrow(() => assertInstallStamp({ stampPath, abi: '147' }), 'a stamp from before the ABI was stamped');
  assert.doesNotThrow(() => assertInstallStamp({ stampPath: join(dir, 'none'), abi: '147' }));
});
