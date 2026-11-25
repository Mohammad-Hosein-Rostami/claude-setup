// Tests of plain `resume` around the run lock. A live driver whose beat looks old, as after a laptop sleep, keeps its lock against
// a plain resume (the plain twin of long-run-account-switch-wake.test.mjs): no second driver starts and no second boss runs. And a
// `resume --reload-job` that the folder claim refuses (another live run uses the folder) writes nothing: job.json, run.json and
// the owner's control files stay as they were, with and without `--account`.
// The driver of the first case is SIGSTOPped while its beat is dated back, so it cannot refresh the beat before the resume reads
// it; SIGSTOP and SIGCONT are POSIX only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { STALE_BEAT_MS, isPidAlive, readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { requestControl } from '../home/tools/long-run/lib/control.mjs';
import { cli, createRun, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { POSIX_ONLY } from './process-group-helpers.mjs';
import { removeTempDir } from './temp-dir-helpers.mjs';

const TO = 'acct-b';
const STEP = 'one';
const EXIT_BUSY = 4;
const SETUP_WAIT_MS = 30000;
// How old the beat and the lock look: past STALE_BEAT_MS, as after a sleep of a few minutes.
const LOOKS_ASLEEP_FOR_MS = STALE_BEAT_MS + 10000;
// How long the run is watched after the refused resume: a driver that resume started would take the lock and its first step
// within a second or two.
const WATCH_MS = 4000;
const WATCH_SLICE_MS = 100;
const CASE_TIMEOUT_MS = 90000;
const NO_LOCK = null;

const lockHolder = (paths) => (existsSync(paths.lock) ? Number(readFileSync(paths.lock, 'utf8').split(' ')[0]) : NO_LOCK);
const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });

/** SIGCONT first, so a driver still stopped ends too; a pid that ended already is fine. */
function killEvenIfStopped(pid) {
  for (const signal of ['SIGCONT', 'SIGKILL']) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

test('plain resume leaves its lock to a live driver whose beat looks old after a sleep: exit 4, one driver, no second boss', { ...POSIX_ONLY, timeout: CASE_TIMEOUT_MS }, async () => {
  const box = makeSandbox();
  box.script({ [STEP]: ['hang'] });
  const started = cli(box, ['start', box.writeJob({ name: 'wake-plain', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  let sleeper = null;
  const others = new Set(); // every other driver pid seen in driver.json or the lock
  try {
    await waitFor(() => readJson(paths.driver)?.live?.[STEP]?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: step one running');
    sleeper = readJson(paths.driver).pid;
    assert.equal(lockHolder(paths), sleeper, 'setup: the driver holds the lock');

    // The sleep: the driver stops, and its beat and lock are dated as they would be after a few minutes asleep.
    process.kill(sleeper, 'SIGSTOP');
    const asleepSince = new Date(Date.now() - LOOKS_ASLEEP_FOR_MS);
    writeJson(paths.driver, { ...readJson(paths.driver), beatAt: asleepSince.toISOString() });
    utimesSync(paths.lock, asleepSince, asleepSince);

    const resumed = cli(box, ['resume', paths.runId]);
    process.kill(sleeper, 'SIGCONT'); // the wake, right after the resume returned

    const watchEnd = Date.now() + WATCH_MS;
    while (Date.now() < watchEnd) {
      for (const pid of [readJson(paths.driver)?.pid, lockHolder(paths)]) if (pid && pid !== sleeper) others.add(pid);
      await pause(WATCH_SLICE_MS);
    }

    const answer = (resumed.stdout + resumed.stderr).trim();
    const seen = JSON.stringify({ resume: { status: resumed.status, said: answer }, otherDrivers: [...others], lockHolder: lockHolder(paths), sleeper, calls: readCalls(box).length });
    assert.equal(resumed.status, EXIT_BUSY, `plain resume did not refuse the live driver: ${seen}`);
    assert.deepEqual([...others], [], `a second driver showed up in driver.json or the lock: ${seen}`);
    assert.equal(lockHolder(paths), sleeper, `the lock left the live driver: ${seen}`);
    assert.equal(isPidAlive(sleeper), true, `the live driver ended: ${seen}`);
    assert.equal(readCalls(box).length, 1, `a second boss was started: ${seen}`);
  } finally {
    for (const pid of [sleeper, ...others]) if (pid) killEvenIfStopped(pid);
    killRunProcesses(box, paths);
    removeTempDir(box.dir);
  }
});

const controlEntries = (paths) => (existsSync(paths.control) ? readdirSync(paths.control).sort() : []);
const runSnapshot = (paths) => ({ job: readFileSync(paths.job, 'utf8'), run: readFileSync(paths.run, 'utf8'), control: controlEntries(paths), resumeFile: existsSync(join(paths.dir, 'resume.json')), driverFile: existsSync(paths.driver) });

/**
 * Run `other` is live in a folder; run `paused` (no driver, a pause waiting) is resumed with `--reload-job` and `extraFlags`.
 * The folder claim must refuse the resume, and nothing the resume could write may change.
 */
async function assertRefusedReloadWritesNothing(extraFlags) {
  const box = makeSandbox();
  box.script({ [STEP]: ['hang'] });
  const folder = box.work('shared');
  const other = cli(box, ['start', box.writeJob({ name: 'other', cwd: folder, steps: [{ id: STEP, prompt: 'Other.' }] }, 'other-job.json')]);
  assert.equal(other.status, 0, other.stderr);
  const otherPaths = runPaths(box.root, /^started (\S+)/m.exec(other.stdout)[1]);
  try {
    await waitFor(() => readJson(otherPaths.driver)?.live?.[STEP]?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: the other run is running');
    const job = { name: 'reloaded', cwd: folder, steps: [{ id: STEP, prompt: 'One.' }] };
    const paths = createRun(box, job);
    requestControl(paths, 'pause', null);
    const changedJob = box.writeJob({ ...job, steps: [{ id: STEP, prompt: 'One, changed.' }] }, 'changed-job.json');
    const before = runSnapshot(paths);
    assert.deepEqual(before.control, ['PAUSE'], 'setup: the pause waits in control/');

    const resumed = cli(box, ['resume', paths.runId, '--reload-job', changedJob, ...extraFlags]);
    const answer = (resumed.stdout + resumed.stderr).trim();
    assert.equal(resumed.status, EXIT_BUSY, `the folder claim refuses the resume: ${answer}`);
    assert.match(answer, new RegExp(`used by live run ${otherPaths.runId}`), 'the refusal is the folder claim');
    assert.deepEqual(runSnapshot(paths), before, `the refused resume wrote to the run (job.json reloaded, run.json switched, control/ cleared or a driver started): ${answer}`);
    assert.equal(readCalls(box).length, 1, `a second boss was started: ${answer}`);
  } finally {
    killRunProcesses(box, otherPaths);
    removeTempDir(box.dir);
  }
}

test('plain resume --reload-job that the folder claim refuses leaves job.json, run.json and control/ unchanged', { timeout: CASE_TIMEOUT_MS }, async () => {
  await assertRefusedReloadWritesNothing([]);
});

test(`resume --account ${TO} --reload-job that the folder claim refuses leaves job.json, run.json and control/ unchanged`, { timeout: CASE_TIMEOUT_MS }, async () => {
  await assertRefusedReloadWritesNothing(['--account', TO]);
});
