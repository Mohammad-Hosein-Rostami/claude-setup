// Repro tests of `resume` around the run lock. A `resume --account` that the lock refuses must change nothing: the owner's pause
// and stop files and the frozen job stay as they were (spec acceptance 1e). And a lock that names a live pid in the old
// "<pid> <host>" form, without the start field every driver before the start check wrote, must not keep a crashed run from a
// plain resume when that pid now belongs to an unrelated process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isPidAlive, readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { removeTempDir } from './temp-dir-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP = 'one';
const EXIT_BUSY = 4;
const SETUP_WAIT_MS = 30000;
const CHILD_WAIT_MS = 10000;
// A beat this old is past STALE_BEAT_MS, as for a live driver just woken from a sleep of some minutes or a driver that crashed.
const BEAT_AGE_MS = 10 * 60 * 1000;
// The driver that a plain resume starts takes the lock and starts the step's boss within a second or two.
const TAKEOVER_WAIT_MS = 15000;
const POLL_MS = 50;
const LOCK_HOLDER = fileURLToPath(new URL('./long-run-account-switch-lock-driver.mjs', import.meta.url));
const SLEEP = '/bin/sleep';
// Longer than the case, so the stand-in process lives until the cleanup kills it.
const SLEEP_SECONDS = '300';
const BUSY_LINE = /is busy: pid \d+ holds its lock/;

const controlEntries = (paths) => (existsSync(paths.control) ? readdirSync(paths.control).sort() : []);
const runSnapshot = (paths) => ({ control: controlEntries(paths), job: readFileSync(paths.job, 'utf8'), account: readJson(paths.run).account });
const beatAgo = (ms) => new Date(Date.now() - ms).toISOString();

/** True once `check()` holds within `ms`, false when the time runs out (unlike waitFor, which throws). */
async function becomes(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() <= deadline) {
    if (check()) return true;
    await new Promise((done) => { setTimeout(done, POLL_MS); });
  }
  return check();
}

async function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('resume --account that the run lock refuses leaves control/, job.json and the run account unchanged', async () => {
  const box = makeSandbox();
  const job = { name: 'refused', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] };
  const paths = createRun(box, job, { account: FROM });
  const changedJob = box.writeJob({ ...job, steps: [{ id: STEP, prompt: 'One, changed.' }] }, 'changed-job.json');
  let holder = null;
  try {
    // A live driver: it holds the run lock, and driver.json names it on this host with a fresh beat.
    holder = spawn(process.execPath, [LOCK_HOLDER, box.root, paths.runId], { env: box.env, stdio: ['pipe', 'pipe', 'inherit'] });
    let said = '';
    holder.stdout.on('data', (chunk) => { said += chunk; });
    await waitFor(() => said.includes('locked'), CHILD_WAIT_MS, 'setup: the lock holder took the lock');
    const driver = { startedAt: new Date().toISOString(), live: {}, status: 'running', pid: holder.pid, host: hostname() };
    writeJson(paths.driver, { ...driver, beatAt: new Date().toISOString() });

    // The owner pauses the run and stops its step while the driver counts as alive, so both land in control/ for it to read.
    assert.equal(cli(box, ['pause', paths.runId]).status, 0, 'setup: pause');
    assert.equal(cli(box, ['stop', paths.runId, STEP]).status, 0, 'setup: stop the step');
    // The machine sleeps before the driver reads them: its beat is now old, so driverAlive misses it, but it still holds the lock.
    writeJson(paths.driver, { ...driver, beatAt: beatAgo(BEAT_AGE_MS) });
    const before = runSnapshot(paths);
    assert.deepEqual(before.control, ['PAUSE', `${STEP}.stop`], 'setup: the pause and the stop wait in control/');

    const resumed = cli(box, ['resume', paths.runId, '--account', TO, '--reload-job', changedJob]);
    const answer = (resumed.stdout + resumed.stderr).trim();
    assert.equal(resumed.status, EXIT_BUSY, `the run lock refuses the switch: ${answer}`);
    assert.equal(isPidAlive(holder.pid), true, 'setup: the lock holder still runs');
    assert.deepEqual(runSnapshot(paths), before, `the refused switch changed the run (control/ cleared or job.json reloaded): ${answer}`);
  } finally {
    await killChild(holder);
    removeTempDir(box.dir);
  }
});

// On Windows there is no /bin/ps, so no lock there shows a start and every lock takes this path; the case needs /bin/sleep as the
// unrelated process, so it skips only where that is missing.
test('plain resume takes over a crashed run whose old-format lock names a pid now reused by an unrelated live process', { skip: process.platform === 'win32' && !existsSync(SLEEP) && `no ${SLEEP}` }, async () => {
  const box = makeSandbox();
  box.script({ [STEP]: ['hang', 'done'] });
  const started = cli(box, ['start', box.writeJob({ name: 'reused', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  const unrelated = spawn(SLEEP, [SLEEP_SECONDS], { stdio: 'ignore' });
  try {
    await waitFor(() => readJson(paths.driver)?.live?.[STEP]?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: step one running');
    // The crash: driver and boss killed at once (power loss, kill -9), so nothing released the lock.
    const crashed = readJson(paths.driver).pid;
    killRunProcesses(box, paths);
    await waitFor(() => !isPidAlive(crashed), CHILD_WAIT_MS, 'setup: the crashed driver gone');

    // Later the lock's pid belongs to the unrelated process; the lock has no start field, and the beat is minutes old.
    writeFileSync(paths.lock, `${unrelated.pid} ${hostname()}\n`);
    writeJson(paths.driver, { ...readJson(paths.driver), pid: unrelated.pid, beatAt: beatAgo(BEAT_AGE_MS) });

    const resumed = cli(box, ['resume', paths.runId]);
    assert.equal(resumed.status, 0, `setup: resume starts a driver: ${resumed.stdout}${resumed.stderr}`);
    await becomes(() => readCalls(box).length >= 2, TAKEOVER_WAIT_MS);
    const log = existsSync(paths.driverLog) ? readFileSync(paths.driverLog, 'utf8') : '';
    const busy = log.split('\n').filter((line) => BUSY_LINE.test(line)).at(-1) ?? '(no busy line)';
    assert.equal(readCalls(box).length, 2, `plain resume did not take over the run: driver.log says "${busy}" (the unrelated pid ${unrelated.pid} kept the lock)`);
  } finally {
    await killChild(unrelated);
    killRunProcesses(box, paths);
    removeTempDir(box.dir);
  }
});
