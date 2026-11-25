// Repro test of `resume --account` against a live driver that only looks stale, as right after a laptop wakes: its driver.json
// beat and its lock file are both older than STALE_BEAT_MS, so driverAlive and the fresh-lock check both pass it by. The switch
// must leave that driver its lock, refused or not; a broken lock lets the driver that resume starts take the run while the old one
// wakes and keeps running, so two drivers run one step on two accounts.
// The driver is SIGSTOPped for one BEAT_MS (a fixed 30 s in driver.mjs), so its beat timer is due the moment it runs again, as
// after a real sleep; this case takes about 40 s. SIGSTOP and SIGCONT are POSIX only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, utimesSync } from 'node:fs';
import { BEAT_MS } from '../home/tools/long-run/lib/driver.mjs';
import { STALE_BEAT_MS, isPidAlive, readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { POSIX_ONLY } from './process-group-helpers.mjs';
import { removeTempDir } from './temp-dir-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const SETUP_WAIT_MS = 30000;
// Past one beat interval, so the stopped driver's beat timer is due when it gets SIGCONT.
const ASLEEP_MS = BEAT_MS + 1000;
// How old the beat and the lock look: past STALE_BEAT_MS, as after a sleep of a few minutes.
const LOOKS_ASLEEP_FOR_MS = STALE_BEAT_MS + 10000;
// How long the run is watched after the wake: the driver resume starts takes the lock and its first step within a second or two.
const WATCH_MS = 5000;
const WATCH_SLICE_MS = 100;
const CASE_TIMEOUT_MS = 90000;
const NO_LOCK = null;

const lockHolder = (paths) => (existsSync(paths.lock) ? Number(readFileSync(paths.lock, 'utf8').split(' ')[0]) : NO_LOCK);

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

test('resume --account leaves its lock to a live driver whose beat and lock look stale after a sleep: one driver runs the step', { ...POSIX_ONLY, timeout: CASE_TIMEOUT_MS }, async () => {
  const box = makeSandbox();
  box.script({ one: ['hang'] });
  const started = cli(box, ['start', box.writeJob({ name: 'wake', cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] })]);
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  let sleeper = null;
  const others = new Set(); // every other driver pid seen in driver.json or the lock
  try {
    await waitFor(() => readJson(paths.driver)?.live?.one?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: step one running');
    sleeper = readJson(paths.driver).pid;
    assert.equal(lockHolder(paths), sleeper, 'setup: the driver holds the lock');

    // The sleep: the driver stops, and its beat and lock are dated as they would be after a few minutes asleep.
    process.kill(sleeper, 'SIGSTOP');
    await new Promise((done) => { setTimeout(done, ASLEEP_MS); });
    const asleepSince = new Date(Date.now() - LOOKS_ASLEEP_FOR_MS);
    writeJson(paths.driver, { ...readJson(paths.driver), beatAt: asleepSince.toISOString() });
    utimesSync(paths.lock, asleepSince, asleepSince);

    const resumed = cli(box, ['resume', paths.runId, '--account', TO]);
    process.kill(sleeper, 'SIGCONT'); // the wake, right after the resume returned

    const watchEnd = Date.now() + WATCH_MS;
    while (Date.now() < watchEnd) {
      for (const pid of [readJson(paths.driver)?.pid, lockHolder(paths)]) if (pid && pid !== sleeper) others.add(pid);
      await new Promise((done) => { setTimeout(done, WATCH_SLICE_MS); });
    }

    const liveDrivers = [sleeper, ...others].filter((pid) => isPidAlive(pid));
    const seen = {
      resume: { status: resumed.status, said: (resumed.stdout + resumed.stderr).trim() },
      liveDrivers, lockHolder: lockHolder(paths), sleeper,
      calls: readCalls(box).map((call) => `${call.account}/${call.end === null ? 'running' : `ended (${call.ended})`}`),
    };
    assert.deepEqual(liveDrivers, [seen.lockHolder], `resume --account broke the lock of a live driver: ${liveDrivers.length} live drivers of the run, the lock held by ${seen.lockHolder}: ${JSON.stringify(seen)}`);
    if (isPidAlive(sleeper)) {
      const endedOnFrom = readCalls(box).filter((call) => call.account === FROM && call.end !== null);
      assert.deepEqual(endedOnFrom, [], `the switch ended the live driver's ${FROM} session: ${JSON.stringify(seen)}`);
    }
  } finally {
    for (const pid of [sleeper, ...others]) if (pid) killEvenIfStopped(pid);
    killRunProcesses(box, paths);
    for (const call of readCalls(box)) if (isPidAlive(call.pid)) killEvenIfStopped(call.pid);
    removeTempDir(box.dir);
  }
});
