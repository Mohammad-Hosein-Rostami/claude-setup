// Test of `resume --account` landing while a driver is starting: drive() takes the run lock first and writes driver.json just
// after, so in that gap the driver does not count as alive yet. The switch must leave that driver its lock, refused or not; a
// stolen lock leaves the live driver lockless, shown as stale, and a plain resume then starts a second driver on the same step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resumeCommand } from '../home/tools/long-run/lib/cli-run.mjs';
import { RunBusy, driverAlive, isPidAlive, readJson, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';

const TO = 'acct-b';
const SETUP_WAIT_MS = 30000;
const CHILD_WAIT_MS = 10000;
const STARTING_DRIVER = fileURLToPath(new URL('./long-run-account-switch-lock-driver.mjs', import.meta.url));
const NO_LOCK = 'none';

class StopBeforeDriver extends Error {}

const lockHolder = (paths) => (existsSync(paths.lock) ? readFileSync(paths.lock, 'utf8').split(' ')[0] : NO_LOCK);

test('resume --account while a driver holds the lock but has not yet written driver.json leaves that driver its lock', async () => {
  const box = makeSandbox();
  box.script({ one: ['hang', 'done'] });
  const started = cli(box, ['start', box.writeJob({ name: 'steal', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  let helper = null;
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: step one running');
    assert.equal(cli(box, ['pause', paths.runId]).status, 0, 'setup: pause');
    const firstPid = readJson(paths.driver).pid;
    await waitFor(() => readJson(paths.driver)?.status === 'paused' && !isPidAlive(firstPid), SETUP_WAIT_MS, 'setup: the paused driver gone');
    assert.equal(existsSync(paths.lock), false, 'setup: the paused driver left no lock');

    // The starting driver: lock taken, driver.json still the paused driver's.
    helper = spawn(process.execPath, [STARTING_DRIVER, box.root, paths.runId], { env: box.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let said = '';
    helper.stdout.on('data', (chunk) => { said += chunk; });
    await waitFor(() => said.includes('locked'), CHILD_WAIT_MS, 'setup: the starting driver took the lock');
    assert.equal(lockHolder(paths), String(helper.pid), 'setup: the lock names the starting driver');

    // A switch that goes through stops at its `resuming` line, before startDriver would start a driver of its own.
    const write = (line) => {
      if (line.startsWith('resuming')) throw new StopBeforeDriver(line);
    };
    try {
      await resumeCommand({ runId: paths.runId, flags: { account: TO }, env: box.env, root: box.root, write });
    } catch (error) {
      if (!(error instanceof StopBeforeDriver || error instanceof RunBusy)) throw error;
    }

    helper.stdin.write('go\n');
    await waitFor(() => said.includes('live'), CHILD_WAIT_MS, 'setup: the starting driver wrote driver.json');
    assert.equal(lockHolder(paths), String(helper.pid), 'resume --account took the run lock from the starting driver: its lock is lost');
    assert.equal(driverAlive(paths), true, 'the starting driver runs but does not count as alive (driverAlive is false)');
  } finally {
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      helper.kill('SIGKILL');
      await once(helper, 'exit');
    }
    killRunProcesses(box, paths);
  }
});
