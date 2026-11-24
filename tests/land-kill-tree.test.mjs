// Tests for how land's test runner (home/tools/land/run-test.mjs, runTestCommand) ends the test's process tree: SIGTERM first, so
// what the test left running can clean up, SIGKILL after the grace to what ignores it, and the result only once the tree is gone;
// a SIGINT to land while the tree of a passed test is being ended still fails the test.
// The commands are `sh` lines (POSIX only) that write their own pid and their background process's pid to a file in the case's
// temp folder; every case SIGKILLs that group in a finally block. The SIGINT cases run runTestCommand in a child node process, so
// a real signal reaches it without reaching the test runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { runTestCommand } from '../home/tools/land/run-test.mjs';
import { CLEAN_ENV } from './git-tidy-helpers.mjs';
import { POSIX_ONLY, elapsedSince, isAlive, killGroupQuietly, readPids, waitUntil } from './process-group-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const RUN_TEST = pathToFileURL(join(import.meta.dirname, '..', 'home', 'tools', 'land', 'run-test.mjs')).href;
// The grace process-tree.mjs gives a tree between SIGTERM and SIGKILL (land's README: SIGTERM, then SIGKILL after a grace).
const TERM_GRACE_MS = 3000;
// How early a timed end may come: timers and the 100 ms poll are not exact.
const TIMING_SLACK_MS = 200;
// A tree that ignores SIGTERM is gone before this, counted from its stop (or from the command's exit).
const SLOW_END_MS = 7000;
// A deadline far past every case's own end, for the cases that do not hit it.
const NO_DEADLINE_SECONDS = 60;
const HANG_DEADLINE_SECONDS = 1;
const MS_PER_SECOND = 1000;
// How long a command may take to write its pids, and a killed orphan to be reaped by init.
const START_WAIT_MS = 5000;
const GONE_WAIT_MS = 2000;
// The shell ignores SIGTERM, and so does the background sleep it starts (an ignored signal is inherited).
const IGNORE_TERM = "trap '' TERM;";
const BACKGROUND = 'sleep 30 >/dev/null 2>&1 &';
const SIGINT_REASON = 'stopped by SIGINT sent to land';

/** A fresh folder for the case: the test's working folder and its pid file. */
function makeCase() {
  const dir = makeTempDir('land-kill-tree-');
  return { dir, pidFile: join(dir, 'pids') };
}

/** The shell text that writes the shell's pid and its last background pid to `file`. */
const recordPids = (file) => `echo $$ $! > '${file}';`;

/** SIGKILLs the group the shell led (its pid is the group id, and its background sleep is in it), if any of it is left. */
function cleanUp(pidFile) {
  if (!existsSync(pidFile)) return;
  const [shell] = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number);
  killGroupQuietly(shell);
}

/** runTestCommand, and how long it took to resolve. */
async function timedRun(command, cwd, timeoutSeconds) {
  const startedAt = performance.now();
  const result = await runTestCommand(command, cwd, timeoutSeconds);
  return { result, took: elapsedSince(startedAt) };
}

test('a passing test that leaves a SIGTERM-ignoring process passes once that process is killed after the grace', POSIX_ONLY, async () => {
  const { dir, pidFile } = makeCase();
  try {
    const { result, took } = await timedRun(`${IGNORE_TERM} ${BACKGROUND} ${recordPids(pidFile)} exit 0`, dir, NO_DEADLINE_SECONDS);
    assert.equal(result.passed, true);
    assert.equal(result.reason, null);
    assert.ok(took >= TERM_GRACE_MS - TIMING_SLACK_MS, `SIGTERM first, SIGKILL only after the grace (${took.toFixed(0)} ms)`);
    assert.ok(took < SLOW_END_MS, `resolved soon after the grace (${took.toFixed(0)} ms)`);
    const [, background] = await readPids(pidFile, START_WAIT_MS);
    assert.ok(await waitUntil(() => !isAlive(background), GONE_WAIT_MS), 'the leftover is gone');
  } finally {
    cleanUp(pidFile);
  }
});

test('a test that hangs ignoring SIGTERM past its deadline fails, and its tree is killed after the grace', POSIX_ONLY, async () => {
  const { dir, pidFile } = makeCase();
  try {
    const { result, took } = await timedRun(`${IGNORE_TERM} ${BACKGROUND} ${recordPids(pidFile)} wait`, dir, HANG_DEADLINE_SECONDS);
    assert.equal(result.passed, false);
    assert.equal(result.reason, `did not finish within ${HANG_DEADLINE_SECONDS} s; its processes were killed`);
    const deadlineMs = HANG_DEADLINE_SECONDS * MS_PER_SECOND;
    assert.ok(took >= deadlineMs + TERM_GRACE_MS - TIMING_SLACK_MS, `the deadline, then the grace before SIGKILL (${took.toFixed(0)} ms)`);
    assert.ok(took < SLOW_END_MS, `resolved soon after the grace (${took.toFixed(0)} ms)`);
    const pids = await readPids(pidFile, START_WAIT_MS);
    assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid)), GONE_WAIT_MS), 'the shell and its background sleep are gone');
  } finally {
    cleanUp(pidFile);
  }
});

// A regression guard: the old code killed the leftover too (at once, by SIGKILL), and failed the test the same way.
test('a failing test (exit 3) that leaves a SIGTERM-ignoring process fails, and the leftover is killed', POSIX_ONLY, async () => {
  const { dir, pidFile } = makeCase();
  try {
    const { result } = await timedRun(`${IGNORE_TERM} ${BACKGROUND} ${recordPids(pidFile)} exit 3`, dir, NO_DEADLINE_SECONDS);
    assert.equal(result.passed, false);
    assert.equal(result.reason, 'exit 3');
    const [, background] = await readPids(pidFile, START_WAIT_MS);
    assert.ok(await waitUntil(() => !isAlive(background), GONE_WAIT_MS), 'the leftover is gone');
  } finally {
    cleanUp(pidFile);
  }
});

// The leftover is a node process in the test's group that, on SIGTERM, writes a marker (as a runner removes its temporary files)
// and exits; its parent exits 0 only once the leftover's handler is set up.
const CLEANS_UP_ON_TERM = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [marker, pidFile] = process.argv.slice(2);
const onTerm = "process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'SIGTERM'); process.exit(0); });";
const leftover = spawn(process.execPath, ['-e', onTerm + " setInterval(() => {}, 1000); console.log('ready');", marker], { stdio: ['ignore', 'pipe', 'ignore'] });
leftover.stdout.once('data', () => {
  writeFileSync(pidFile, String(leftover.pid));
  process.exit(0);
});
`;

test('what a passing test leaves running gets SIGTERM first, so it can clean up before it ends', POSIX_ONLY, async () => {
  const { dir, pidFile } = makeCase();
  const script = join(dir, 'cleans-up-on-term.mjs');
  const marker = join(dir, 'marker');
  writeFileSync(script, CLEANS_UP_ON_TERM);
  try {
    const { result } = await timedRun(`"${process.execPath}" "${script}" "${marker}" "${pidFile}"`, dir, NO_DEADLINE_SECONDS);
    assert.equal(result.passed, true, result.reason);
    assert.ok(existsSync(marker), 'the leftover ran its SIGTERM handler');
    assert.equal(readFileSync(marker, 'utf8'), 'SIGTERM');
  } finally {
    if (existsSync(pidFile)) killGroupQuietly(Number(readFileSync(pidFile, 'utf8')));
  }
});

// Runs runTestCommand in its own node process and prints the result as JSON, so a real SIGINT can be sent to it.
const DRIVER = `import { runTestCommand } from ${JSON.stringify(RUN_TEST)};
const [command, cwd, timeoutSeconds] = process.argv.slice(2);
process.stdout.write(JSON.stringify(await runTestCommand(command, cwd, Number(timeoutSeconds))));
`;

/** Starts the driver on `command`; `closed` resolves to `{ status, signal, stdout, stderr, closedAt }`. */
function startDriver(dir, command) {
  const script = join(dir, 'driver.mjs');
  writeFileSync(script, DRIVER);
  const driver = spawn(process.execPath, [script, command, dir, String(NO_DEADLINE_SECONDS)], { env: CLEAN_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  let [stdout, stderr] = ['', ''];
  driver.stdout.on('data', (chunk) => { stdout += chunk; });
  driver.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    driver.on('close', (status, signal) => resolve({ status, signal, stdout, stderr, closedAt: performance.now() }));
  });
  return { driver, closed };
}

/** The driver's printed result; fails the test with what it printed when it printed none. */
function driverResult(end) {
  assert.equal(end.status, 0, `the driver exited by itself (signal ${end.signal}): ${end.stdout}${end.stderr}`);
  return JSON.parse(end.stdout);
}

test('a SIGINT to land while the test hangs ignoring SIGTERM: it fails as stopped, its tree killed after the grace', POSIX_ONLY, async () => {
  const { dir, pidFile } = makeCase();
  const { driver, closed } = startDriver(dir, `${IGNORE_TERM} ${BACKGROUND} ${recordPids(pidFile)} wait`);
  try {
    const pids = await readPids(pidFile, START_WAIT_MS);
    const sentAt = performance.now();
    driver.kill('SIGINT');
    const end = await closed;
    const result = driverResult(end);
    assert.equal(result.passed, false);
    assert.equal(result.reason, SIGINT_REASON);
    const took = end.closedAt - sentAt;
    assert.ok(took >= TERM_GRACE_MS - TIMING_SLACK_MS, `SIGTERM first, SIGKILL only after the grace (${took.toFixed(0)} ms)`);
    assert.ok(took < SLOW_END_MS, `resolved soon after the grace (${took.toFixed(0)} ms)`);
    assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid)), GONE_WAIT_MS), 'the shell and its background sleep are gone');
  } finally {
    driver.kill('SIGKILL');
    cleanUp(pidFile);
  }
});

test('a SIGINT to land while the tree of a passed test is being ended fails the test: the stop wins', POSIX_ONLY, async () => {
  const { dir, pidFile } = makeCase();
  const { driver, closed } = startDriver(dir, `${IGNORE_TERM} ${BACKGROUND} ${recordPids(pidFile)} exit 0`);
  try {
    const [shell, background] = await readPids(pidFile, START_WAIT_MS);
    // The shell has exited 0; its SIGTERM-ignoring leftover keeps the tree being ended for the grace.
    assert.ok(await waitUntil(() => !isAlive(shell), START_WAIT_MS), 'precondition: the test command exited');
    assert.equal(isAlive(background), true, 'precondition: its leftover still runs');
    driver.kill('SIGINT');
    const result = driverResult(await closed);
    assert.equal(result.passed, false);
    assert.equal(result.reason, SIGINT_REASON);
    assert.ok(await waitUntil(() => !isAlive(background), GONE_WAIT_MS), 'the leftover is gone');
  } finally {
    driver.kill('SIGKILL');
    cleanUp(pidFile);
  }
});
