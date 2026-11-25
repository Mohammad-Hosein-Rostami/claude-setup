// Tests of the run lock's one holder rule (long-run lib/run-store.mjs, driverAlive and acquireLock): the table of what holds a run
// and what does not, four takers racing for one stale lock, and the start field a taker writes. Live pids are real processes, so
// the ps start in a lock is the real one; the no-ps rows run in a child process under tests/no-ps-hook.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processStarts } from '../home/tools/disk-free/lib/live-sessions.mjs';
import { RunBusy, acquireLock, driverAlive, ensureRunDirs, runPaths } from '../home/tools/long-run/lib/run-store.mjs';
import { makeTempDir, removeTempDir } from './temp-dir-helpers.mjs';

const RUN_ID = 'lock-rule-20261125-120000';
const OTHER_HOST = 'some-other-host';
const SECOND_MS = 1000;
// The rule's bound is 120 s (spec rule 4): one second inside and one outside it.
const INSIDE_BOUND_MS = 119 * SECOND_MS;
const OUTSIDE_BOUND_MS = 121 * SECOND_MS;
const FRESH_BEAT_MS = 10 * SECOND_MS;
const HOUR_MS = 60 * 60 * SECOND_MS;
const REPLY_WAIT_MS = 15000;
const RACE_TAKERS = 4;
const RACE_ROUNDS = 20;
const RACE_ALIGN_MS = 150; // all takers are waiting on stdin; this is the head start for the "go" line to reach each of them
const START_SLACK_MS = SECOND_MS;
const TAKER = fileURLToPath(new URL('./long-run-lock-rule-taker.mjs', import.meta.url));
const NO_PS_HOOK = pathToFileURL(fileURLToPath(new URL('./no-ps-hook.mjs', import.meta.url))).href;
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'no FIFO or mkfifo on Windows' : false };
const PS_SHOWS_STARTS = processStarts([process.pid]).has(process.pid);
const NEEDS_PS = { skip: PS_SHOWS_STARTS ? false : 'ps cannot tell a process start here' };

/** A run folder (with its lock and driver.json paths) in a temp state root, removed when the test ends. */
function runFolder(t) {
  const root = makeTempDir('lock-rule-');
  t.after(() => removeTempDir(root));
  const paths = runPaths(root, RUN_ID);
  ensureRunDirs(paths);
  return paths;
}

/** A live process other than the test (a node that sleeps), killed when the test ends. */
function liveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child.pid;
}

/** A pid no process has now: that of a process that has ended. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const psStartOf = (pid) => {
  const start = processStarts([pid]).get(pid);
  assert.notEqual(start, undefined, `setup: ps lists pid ${pid} with a start`);
  return start;
};
const lockLine = (pid, host, startMs) => `${[pid, host, startMs].filter((field) => field !== undefined).join(' ')}\n`;
const writeLock = (paths, text) => writeFileSync(paths.lock, text);
const writeDriver = (paths, { pid, host = hostname(), beatAgoMs }) =>
  writeFileSync(paths.driver, JSON.stringify({ pid, host, beatAt: new Date(Date.now() - beatAgoMs).toISOString() }));
const lockOwner = (paths) => Number(readFileSync(paths.lock, 'utf8').split(' ')[0]);

/** The run is held: the rule says so and acquireLock refuses it, leaving the lock as it was. */
function assertHeld(paths, why) {
  const before = readFileSync(paths.lock, 'utf8');
  assert.equal(driverAlive(paths), true, `driverAlive: ${why}`);
  assert.throws(() => acquireLock(paths), RunBusy, `acquireLock: ${why}`);
  assert.equal(readFileSync(paths.lock, 'utf8'), before, 'a refused taker leaves the lock alone');
}

/** The run is not held: the rule says so and acquireLock takes it for this process. */
function assertNotHeld(paths, why) {
  assert.equal(driverAlive(paths), false, `driverAlive: ${why}`);
  acquireLock(paths);
  assert.equal(lockOwner(paths), process.pid, `acquireLock: ${why}`);
}

/** A taker child (tests/long-run-lock-rule-taker.mjs): `ask(line)` sends one line and resolves with its JSON answer. */
async function startTaker(t, paths, { noPs = false } = {}) {
  const execArgv = noPs ? ['--import', NO_PS_HOOK] : [];
  const child = spawn(process.execPath, [...execArgv, TAKER, paths.root, paths.runId], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const gone = once(child, 'exit');
      const killer = setTimeout(() => child.kill('SIGKILL'), REPLY_WAIT_MS);
      await gone;
      clearTimeout(killer);
    }
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (what) => {
    let timer;
    const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer to ${what} within ${REPLY_WAIT_MS} ms`)), REPLY_WAIT_MS); });
    try {
      const { value, done } = await Promise.race([lines.next(), timedOut]);
      assert.equal(done, false, `the taker ended before it answered ${what}`);
      return JSON.parse(value);
    } finally {
      clearTimeout(timer);
    }
  };
  const ready = await next('start');
  return {
    pid: ready.pid,
    ask: (line) => {
      child.stdin.write(`${line}\n`);
      return next(line);
    },
  };
}

// The rule-4 table, one row each.

test('a fresh beat of a live driver on this host holds the run', (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  writeLock(paths, lockLine(pid, hostname()));
  writeDriver(paths, { pid, beatAgoMs: FRESH_BEAT_MS });
  assertHeld(paths, 'beat 10 s old');
});

test('a beat 121 s old holds nothing when the lock has no start for ps to check', (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  writeLock(paths, lockLine(pid, hostname()));
  writeDriver(paths, { pid, beatAgoMs: OUTSIDE_BOUND_MS });
  assertNotHeld(paths, 'beat 121 s old');
});

test('a taker that ps proves (same start) holds the run however old its beat is', NEEDS_PS, (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  writeLock(paths, lockLine(pid, hostname(), psStartOf(pid)));
  writeDriver(paths, { pid, beatAgoMs: HOUR_MS });
  assertHeld(paths, 'ps start equals the lock start, beat an hour old');
});

test('a pid that ps shows started at another time (a reused pid) holds nothing', NEEDS_PS, (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  writeLock(paths, lockLine(pid, hostname(), psStartOf(pid) - HOUR_MS));
  writeDriver(paths, { pid, beatAgoMs: HOUR_MS });
  assertNotHeld(paths, 'ps start an hour after the lock start, beat an hour old');
});

test('with no ps, a taker that started 119 s ago holds the run', async (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  const taker = await startTaker(t, paths, { noPs: true });
  writeLock(paths, lockLine(pid, hostname(), Date.now() - INSIDE_BOUND_MS));
  assert.deepEqual(await taker.ask('alive'), { alive: true }, 'driverAlive');
  const before = readFileSync(paths.lock, 'utf8');
  assert.equal((await taker.ask('take 0')).busy?.includes('is busy'), true, 'acquireLock refuses with RunBusy');
  assert.equal(readFileSync(paths.lock, 'utf8'), before);
});

test('with no ps, a taker that started 121 s ago holds nothing', async (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  const taker = await startTaker(t, paths, { noPs: true });
  writeLock(paths, lockLine(pid, hostname(), Date.now() - OUTSIDE_BOUND_MS));
  assert.deepEqual(await taker.ask('alive'), { alive: false }, 'driverAlive');
  assert.deepEqual(await taker.ask('take 0'), { took: true }, 'acquireLock');
  assert.equal(lockOwner(paths), taker.pid);
});

test('a lock of two fields (no start) with no driver beat holds nothing', (t) => {
  const paths = runFolder(t);
  writeLock(paths, lockLine(liveProcess(t), hostname()));
  assertNotHeld(paths, 'a live pid, no start, no driver.json');
});

test('an empty lock younger than 120 s holds the run (a taker is writing it)', (t) => {
  const paths = runFolder(t);
  writeLock(paths, '');
  assertHeld(paths, 'an empty lock just made');
});

test('an empty lock older than 120 s holds nothing', (t) => {
  const paths = runFolder(t);
  writeLock(paths, '');
  const old = new Date(Date.now() - OUTSIDE_BOUND_MS);
  utimesSync(paths.lock, old, old);
  assertNotHeld(paths, 'an empty lock 121 s old');
});

test('a lock holding `{}` is no lock and holds nothing', (t) => {
  const paths = runFolder(t);
  writeLock(paths, '{}\n');
  assertNotHeld(paths, 'lock text {}');
});

test('a FIFO in place of the lock returns at once and holds nothing', POSIX_ONLY, async (t) => {
  const paths = runFolder(t);
  assert.equal(spawnSync('mkfifo', [paths.lock]).status, 0, 'setup: mkfifo');
  // In a child: a read that waited on the FIFO would block this process's own timers, so nothing here could time it out.
  const taker = await startTaker(t, paths);
  assert.deepEqual(await taker.ask('alive'), { alive: false }, 'driverAlive');
  assert.deepEqual(await taker.ask('take 0'), { took: true }, 'acquireLock');
  assert.equal(lockOwner(paths), taker.pid);
});

test('a driver.json from another host holds nothing, whatever its beat and pid', (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  writeLock(paths, lockLine(pid, hostname()));
  writeDriver(paths, { pid, host: OTHER_HOST, beatAgoMs: FRESH_BEAT_MS });
  assertNotHeld(paths, 'a fresh beat from another host');
});

test('a lock written on another host holds nothing, though its pid lives here with the same start', NEEDS_PS, (t) => {
  const paths = runFolder(t);
  const pid = liveProcess(t);
  writeLock(paths, lockLine(pid, OTHER_HOST, psStartOf(pid)));
  assertNotHeld(paths, 'a lock of another host');
});

test('a dead pid holds nothing, fresh beat and young start included', (t) => {
  const paths = runFolder(t);
  const pid = deadPid();
  writeLock(paths, lockLine(pid, hostname(), Date.now() - SECOND_MS));
  writeDriver(paths, { pid, beatAgoMs: FRESH_BEAT_MS });
  assertNotHeld(paths, 'a pid that has ended');
});

// The one breaker.

test('four takers racing for one stale lock: exactly one wins each round and the others get RunBusy', async (t) => {
  const paths = runFolder(t);
  const takers = [];
  for (let i = 0; i < RACE_TAKERS; i += 1) takers.push(await startTaker(t, paths));
  for (let round = 1; round <= RACE_ROUNDS; round += 1) {
    rmSync(paths.lock, { force: true });
    writeLock(paths, lockLine(process.pid, hostname())); // no start: nobody holds it
    const at = Date.now() + RACE_ALIGN_MS;
    const answers = await Promise.all(takers.map((taker) => taker.ask(`take ${at}`)));
    const winners = takers.filter((_, i) => answers[i].took === true);
    const busy = answers.filter((answer) => typeof answer.busy === 'string' && answer.busy.includes('is busy'));
    const state = `round ${round}: ${JSON.stringify(answers)}`;
    assert.equal(winners.length, 1, `one winner: ${state}`);
    assert.equal(busy.length, RACE_TAKERS - 1, `the others get RunBusy: ${state}`);
    assert.equal(lockOwner(paths), winners[0].pid, `the lock names the winner: ${state}`);
    assert.deepEqual(readdirSync(paths.dir).filter((name) => name.startsWith('driver.lock.')), [], `no claim file is left: ${state}`);
  }
});

// The start field.

test('the lock start of a taker is its ps start', NEEDS_PS, async (t) => {
  const paths = runFolder(t);
  const taker = await startTaker(t, paths);
  assert.deepEqual(await taker.ask('take 0'), { took: true });
  const [pid, host, start] = readFileSync(paths.lock, 'utf8').trim().split(' ');
  assert.equal(Number(pid), taker.pid);
  assert.equal(host, hostname());
  assert.equal(Number(start), psStartOf(taker.pid));
});

test('with no ps the lock start of a taker is its own start by the clock', async (t) => {
  const paths = runFolder(t);
  const spawnedAt = Date.now();
  const taker = await startTaker(t, paths, { noPs: true });
  assert.deepEqual(await taker.ask('take 0'), { took: true });
  const start = Number(readFileSync(paths.lock, 'utf8').trim().split(' ')[2]);
  assert.ok(start >= spawnedAt - START_SLACK_MS && start <= Date.now(), `start ${start} between ${spawnedAt} and now`);
});
