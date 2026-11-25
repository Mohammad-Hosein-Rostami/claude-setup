// Tests of the run lock on a machine where ps cannot tell a process start (Windows, Git Bash, or a failing ps): tests/no-ps-hook.mjs
// is loaded into every process of the tree through NODE_OPTIONS. A driver that has taken the run lock but not yet written
// driver.json must keep its lock against `resume --account`, as it does where ps shows starts; and a crashed run whose lock names
// a pid that an unrelated process now holds must still be taken over by a plain resume (the guard that a fix must not undo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPidAlive, readJson, runPaths, writeJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, killRunProcesses, makeSandbox, readCalls, waitFor } from './long-run-helpers.mjs';
import { removeTempDir } from './temp-dir-helpers.mjs';

const FROM = 'acct-a';
const TO = 'acct-b';
const STEP = 'one';
const EXIT_BUSY = 4;
const SETUP_WAIT_MS = 30000;
const CHILD_WAIT_MS = 10000;
const TAKEOVER_WAIT_MS = 15000;
const POLL_MS = 50;
// A start this old is past any tolerance of a clock or ps rounding, so a lock with it can only name another process.
const LOCK_START_AGE_MS = 10 * 60 * 1000;
const BEAT_AGE_MS = 10 * 60 * 1000;
const PS_PATHS = ['/bin/ps', '/usr/bin/ps'];
const SLEEP = '/bin/sleep';
const SLEEP_SECONDS = '300';
const HOOK_URL = pathToFileURL(fileURLToPath(new URL('./no-ps-hook.mjs', import.meta.url))).href;
const LIVE_SESSIONS_URL = pathToFileURL(fileURLToPath(new URL('../home/tools/disk-free/lib/live-sessions.mjs', import.meta.url))).href;
const LOCK_HOLDER = fileURLToPath(new URL('./long-run-account-switch-lock-driver.mjs', import.meta.url));
const PAUSE_FILE = 'PAUSE';
const BUSY_LINE = /is busy: pid \d+ holds its lock/;
const PROBE = `import(${JSON.stringify(LIVE_SESSIONS_URL)}).then((live) => console.log(live.processStarts([process.pid]).size))`;

/** The sandbox's env, with the no-ps hook added to NODE_OPTIONS so each node process the CLI starts loads it. */
const noPsEnv = (box) => ({ ...box.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import ${HOOK_URL}`].filter(Boolean).join(' ') });

const startsSeenBy = (env) => spawnSync(process.execPath, ['-e', PROBE], { env, encoding: 'utf8', timeout: CHILD_WAIT_MS }).stdout.trim();
const lockText = (paths) => (existsSync(paths.lock) ? readFileSync(paths.lock, 'utf8').trim() : 'none');
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
    child.kill('SIGKILL'); // also ends a SIGSTOPped child
    await once(child, 'exit');
  }
}

test('the no-ps hook leaves processStarts without a start for a live pid', () => {
  const box = makeSandbox();
  try {
    assert.equal(startsSeenBy(noPsEnv(box)), '0', 'processStarts([pid]) under the hook is not empty');
  } finally {
    removeTempDir(box.dir);
  }
});

// Control for the case above: where ps exists, the same probe without the hook sees the start, so the hook is what empties it.
test('without the hook, processStarts shows the start of a live pid where ps exists', { skip: !PS_PATHS.some((path) => existsSync(path)) && 'no ps on this machine' }, () => {
  const box = makeSandbox();
  try {
    assert.equal(startsSeenBy(box.env), '1', 'ps shows no start for this process even without the hook');
  } finally {
    removeTempDir(box.dir);
  }
});

test('with no ps start, resume --account leaves a starting driver (lock held, no driver.json yet) its lock and the run unchanged', async () => {
  const box = makeSandbox();
  box.script({ [STEP]: ['hang', 'done'] }); // a driver that a wrongly allowed switch starts hangs at its step instead of looping
  const env = noPsEnv(box);
  const paths = createRun(box, { name: 'nops-hold', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] }, { account: FROM });
  let holder = null;
  let resumed = null;
  try {
    // The starting driver: it holds the lock in the "<pid> <host> <start>" form and has not written driver.json.
    holder = spawn(process.execPath, [LOCK_HOLDER, box.root, paths.runId], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    let said = '';
    holder.stdout.on('data', (chunk) => { said += chunk; });
    await waitFor(() => said.includes('locked'), CHILD_WAIT_MS, 'setup: the starting driver took the lock');
    assert.equal(lockText(paths).split(' ')[0], String(holder.pid), 'setup: the lock names the starting driver');
    assert.equal(lockText(paths).split(' ').length, 3, 'setup: the lock is in the "<pid> <host> <start>" form');
    assert.equal(existsSync(paths.driver), false, 'setup: no driver.json yet');
    assert.equal(startsSeenBy(env), '0', 'setup: the processes of the tree see no ps start');

    // The owner's pause waits in control/ for the driver to read it.
    mkdirSync(paths.control, { recursive: true });
    writeFileSync(join(paths.control, PAUSE_FILE), '');
    const lockBefore = lockText(paths);
    const before = runSnapshot(paths);
    assert.deepEqual(before.control, [PAUSE_FILE], 'setup: the pause waits in control/');

    resumed = cli(box, ['resume', paths.runId, '--account', TO], { env });
    const answer = (resumed.stdout + resumed.stderr).trim();
    assert.equal(isPidAlive(holder.pid), true, 'setup: the starting driver still runs');
    assert.equal(resumed.status, EXIT_BUSY, `the starting driver's lock refuses the switch (exit ${resumed.status}): ${answer}`);
    assert.equal(lockText(paths), lockBefore, 'resume --account took the run lock from the starting driver');
    assert.deepEqual(runSnapshot(paths), before, `the switch changed the run (control/ cleared or account switched): ${answer}`);
  } finally {
    await killChild(holder);
    // A switch that went ahead started a driver, which writes driver.json and starts its boss a moment later: wait for the boss so
    // killRunProcesses can find both.
    if (resumed?.status === 0) await becomes(() => readCalls(box).length > 0, TAKEOVER_WAIT_MS);
    killRunProcesses(box, paths);
    removeTempDir(box.dir);
  }
});

// Guard of the other side: with no ps a lock cannot be told from a reused pid, so only driverAlive's beat rule decides, and an old beat
// means a crashed run. A fix that kept every live pid's lock where ps gives no start would leave this run stuck for good.
test('with no ps start, plain resume takes over a crashed run whose lock names a pid now reused by an unrelated live process', { skip: !existsSync(SLEEP) && `no ${SLEEP}` }, async () => {
  const box = makeSandbox();
  box.script({ [STEP]: ['hang', 'done'] });
  const env = noPsEnv(box);
  const started = cli(box, ['start', box.writeJob({ name: 'nops-reused', cwd: box.work('repo'), steps: [{ id: STEP, prompt: 'One.' }] })], { env });
  assert.equal(started.status, 0, started.stderr);
  const paths = runPaths(box.root, /^started (\S+)/m.exec(started.stdout)[1]);
  const unrelated = spawn(SLEEP, [SLEEP_SECONDS], { stdio: 'ignore' });
  try {
    await waitFor(() => readJson(paths.driver)?.live?.[STEP]?.state === 'running' && readCalls(box).length === 1, SETUP_WAIT_MS, 'setup: step one running');
    // The crash: driver and boss killed at once (power loss, kill -9), so nothing released the lock.
    const crashed = readJson(paths.driver).pid;
    killRunProcesses(box, paths);
    await waitFor(() => !isPidAlive(crashed), CHILD_WAIT_MS, 'setup: the crashed driver gone');

    // Later the lock's pid belongs to the unrelated process; the lock records a start long before it, and the beat is minutes old.
    writeFileSync(paths.lock, `${unrelated.pid} ${hostname()} ${Date.now() - LOCK_START_AGE_MS}\n`);
    writeJson(paths.driver, { ...readJson(paths.driver), pid: unrelated.pid, beatAt: beatAgo(BEAT_AGE_MS) });

    const resumed = cli(box, ['resume', paths.runId], { env });
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
