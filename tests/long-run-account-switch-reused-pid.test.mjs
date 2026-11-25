// Test of `resume --account` on a crashed run whose lock names a pid that an unrelated live process now holds, where ps shows the
// process starts (macOS, Linux). The run's old account is gone from the store, so a plain resume refuses it and says to switch with
// `resume --account`; the switch must then not refuse it with "run a plain resume first": the two refusals would point to each other
// and no command could move the run while that process lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { removeAccount } from '../home/tools/account/lib/accounts.mjs';
import { isPidAlive, readJson, readJsonLines, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { removeTempDir } from './temp-dir-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP = 'one';
const SETUP_WAIT_MS = 30000;
const CHILD_WAIT_MS = 10000;
const PS_PATHS = ['/bin/ps', '/usr/bin/ps'];
const SLEEP = '/bin/sleep';
const SLEEP_SECONDS = '300';
// A start this old is past any tolerance of a clock or ps rounding, so a lock with it can only name another process.
const LOCK_START_AGE_MS = 10 * 60 * 1000;
const BEAT_AGE_MS = 10 * 60 * 1000;
const missingTool = (!existsSync(SLEEP) && `no ${SLEEP} on this machine`) || (!PS_PATHS.some((path) => existsSync(path)) && 'no ps on this machine');

test('with ps starts, resume --account switches a crashed run whose lock names a reused pid and whose old account is gone', { skip: missingTool }, async () => {
  const box = makeSandbox();
  box.script({ [STEP]: ['hang', 'done'] }); // the driver the switch starts hangs at its step, so cleanup finds a live boss to end
  const started = cli(box, ['start', box.writeJob({ name: 'reused-pid', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  const unrelated = spawn(SLEEP, [SLEEP_SECONDS], { stdio: 'ignore' });
  let switched = null;
  try {
    await waitFor(() => readJson(paths.driver)?.live?.[STEP]?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: step one running');
    // The crash: driver and boss killed at once (power loss, kill -9), so nothing released the lock.
    const crashed = readJson(paths.driver).pid;
    killRunProcesses(box, paths);
    await waitFor(() => !isPidAlive(crashed), CHILD_WAIT_MS, 'setup: the crashed driver gone');

    // Later the lock's pid belongs to the unrelated process; the lock records a start long before it, so ps shows the reuse, and the beat is old.
    writeFileSync(paths.lock, `${unrelated.pid} ${hostname()} ${Date.now() - LOCK_START_AGE_MS}\n`);
    writeJson(paths.driver, { ...readJson(paths.driver), pid: unrelated.pid, beatAt: new Date(Date.now() - BEAT_AGE_MS).toISOString() });
    removeAccount(FROM, { env: box.env });

    switched = cli(box, ['resume', paths.runId, '--account', TO]);
    const answer = (switched.stdout + switched.stderr).trim();
    assert.equal(switched.status, 0, `resume --account refused the crashed run (exit ${switched.status}): ${answer}`);
    assert.equal(readJson(paths.run).account, TO, `the run was not switched: ${answer}`);
    assert.equal(readJsonLines(paths.events).some((event) => event.event === 'account-switched'), true, 'no account-switched event');
  } finally {
    unrelated.kill('SIGKILL');
    if (unrelated.exitCode === null && unrelated.signalCode === null) await once(unrelated, 'exit');
    // The switch starts a driver, which writes driver.json and starts its boss a moment later: wait for the boss so killRunProcesses finds both.
    if (switched?.status === 0) await waitFor(() => readCalls(box).length > 1, CHILD_WAIT_MS, 'a boss start after the switch');
    killRunProcesses(box, paths);
    removeTempDir(box.dir);
  }
});
