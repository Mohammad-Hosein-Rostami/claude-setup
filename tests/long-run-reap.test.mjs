// Tests that a stopped or lost driver leaves no boss and no boss's grandchild running (audit H3, Job A4): a SIGTERM of the driver
// is a clean run-level pause that also ends the grandchild a subagent's Bash would be (its own process group); after a SIGKILL
// `status` warns that the boss still runs and `resume` ends it and its grandchild before it continues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KILL_AFTER } from '../home/tools/long-run/lib/claude-run.mjs';
import { isPidAlive, readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const GRACE_MS = KILL_AFTER.kill + 5000;

/** Starts a one-step job whose boss starts an agent and a grandchild; returns the run's paths and the grandchild's pid. */
async function startWithGrandchild(box, name) {
  box.script({ one: ['agent:a1b2c3', 'done'] });
  const started = cli(box, ['start', box.writeJob({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  const pidFile = join(box.fakeDir, 'grandchild-one.pid');
  const grandchild = await waitFor(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')), 30000, 'the grandchild started');
  await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running', 30000, 'one running');
  return { paths, grandchild, boss: readCalls(box)[0].pid };
}

test('SIGTERM of the driver: the boss and its grandchild (own process group) end within the grace period; status says paused', async () => {
  const box = makeSandbox();
  const { paths, grandchild, boss } = await startWithGrandchild(box, 'term');
  assert.ok(isPidAlive(grandchild), 'precondition: the grandchild runs');
  process.kill(readJson(paths.driver).pid, 'SIGTERM');
  await waitFor(() => !isPidAlive(boss) && !isPidAlive(grandchild), GRACE_MS, 'boss and grandchild gone');
  await waitFor(() => !isPidAlive(readJson(paths.driver).pid), GRACE_MS, 'driver exited');
  assert.match(cli(box, ['status']).stdout, new RegExp(`^${paths.runId} paused `, 'm'));
  assert.equal(readCalls(box)[0].ended, 'SIGINT');
});

test('SIGKILL of the driver: status warns the boss still runs; resume ends the boss and its grandchild, then continues', async () => {
  const box = makeSandbox();
  const { paths, grandchild, boss } = await startWithGrandchild(box, 'kill');
  const driverPid = readJson(paths.driver).pid;
  process.kill(driverPid, 'SIGKILL');
  await waitFor(() => !isPidAlive(driverPid), 10000, 'driver gone');
  const status = cli(box, ['status']).stdout;
  assert.match(status, new RegExp(`^${paths.runId} stale `, 'm'));
  assert.match(status, new RegExp(`warning: boss pid ${boss} of a lost driver is still running \\(step one\\); long-run resume ${paths.runId} ends it`));
  assert.ok(isPidAlive(grandchild), 'precondition: the grandchild outlived the driver');
  const resumed = cli(box, ['resume', paths.runId, '--foreground']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.ok(!isPidAlive(boss), 'the old boss was ended');
  assert.ok(!isPidAlive(grandchild), 'its grandchild was ended too');
  assert.equal(readJson(paths.driver).status, 'done');
  assert.doesNotMatch(cli(box, ['status']).stdout, /warning:/);
});
