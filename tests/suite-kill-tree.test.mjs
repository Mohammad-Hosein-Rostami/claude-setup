// Tests for how `suite run` (home/tools/suite/suite.mjs) ends its command when SIGTERM, SIGINT or SIGHUP stops it: the command's
// group gets SIGTERM, then SIGKILL after the grace, and suite exits with 128 + the signal's number only once the group is gone;
// a stopped run prints no verdict and caches nothing.
// Every case has its own state folder (CLAUDE_CONFIG_DIR) and its own throw-away repo in the OS temp folder. The commands are
// `sh` lines (POSIX only) that write their pid and their background process's pid to a file outside the repo; every case
// SIGKILLs that group in a finally block.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, makeRepo } from './git-tidy-helpers.mjs';
import { POSIX_ONLY, isAlive, killGroupQuietly, readPids, waitUntil } from './process-group-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SUITE = fileURLToPath(new URL('../home/tools/suite/suite.mjs', import.meta.url));
// The grace process-tree.mjs gives a group between SIGTERM and SIGKILL (suite's README: SIGTERM, then SIGKILL after a grace).
const TERM_GRACE_MS = 3000;
// How early a timed end may come: timers and the 100 ms poll are not exact.
const TIMING_SLACK_MS = 200;
// A group that ignores SIGTERM is gone, and suite has exited, before this after the stop signal.
const SLOW_END_MS = 8000;
// A group that heeds SIGTERM: suite has exited before this.
const FAST_END_MS = 2000;
// How long the command may take to start and write its pids, and a killed orphan to be reaped by init.
const START_WAIT_MS = 10_000;
const GONE_WAIT_MS = 2000;
const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
// sh's script: $1 is the pid file. The background sleep inherits the shell's ignore of SIGTERM when there is one.
const IGNORING_TERM = "trap '' TERM; sleep 60 >/dev/null 2>&1 & echo $$ $! > \"$1\"; wait";
const HEEDING_TERM = 'sleep 60 >/dev/null 2>&1 & echo $$ $! > "$1"; wait';
const VERDICT_LINE = /^(?:cached )?(?:PASS|FAIL)\b/m;

// With the hang flag present it waits for a signal and, on SIGTERM, exits 0 (as a runner that cleans up and exits); without
// it, it passes at once. So the stopped run and the later run are the same command, with one cache key.
const PASSES_OR_WAITS = `import { existsSync, writeFileSync } from 'node:fs';
const [hangFlag, readyFile] = process.argv.slice(2);
if (existsSync(hangFlag)) {
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
  writeFileSync(readyFile, process.pid + ' ' + process.pid + '\\n');
}
`;

/** A fresh case: a repo, a state folder, a folder outside the repo for the pid file and fakes, and the env for suite. */
function makeCase() {
  const repo = makeRepo();
  const work = makeTempDir('suite-kill-tree-');
  const env = { ...CLEAN_ENV, CLAUDE_CONFIG_DIR: join(work, 'config') };
  return { repo, work, env, pidFile: join(work, 'pids') };
}

/** Starts `suite run` with `flags` on `command`; `closed` resolves to `{ status, stdout, stderr, closedAt }`. */
function startSuite({ repo, env }, flags, command) {
  const child = spawn(process.execPath, [SUITE, 'run', '--repo', repo, '--slots', '1', ...flags, '--', ...command], { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  let [stdout, stderr] = ['', ''];
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr, closedAt: performance.now() }));
  });
  return { child, closed };
}

/** Starts suite on `sh -c script`, waits for the command's pids, sends `signal`; @returns the end, the pids and the time taken. */
async function stopRun(testCase, script, signal, flags = []) {
  const { child, closed } = startSuite(testCase, flags, ['sh', '-c', script, 'sh', testCase.pidFile]);
  try {
    const pids = await readPids(testCase.pidFile, START_WAIT_MS);
    const sentAt = performance.now();
    child.kill(signal);
    const end = await closed;
    return { end, pids, took: end.closedAt - sentAt };
  } finally {
    child.kill('SIGKILL');
  }
}

/** SIGKILLs the group the command's shell led (its pid is the group id), if any of it is left. */
function cleanUp({ pidFile }) {
  if (existsSync(pidFile)) killGroupQuietly(Number(readFileSync(pidFile, 'utf8').trim().split(/\s+/)[0]));
}

for (const signal of STOP_SIGNALS) {
  test(`${signal} to suite run with a command that ignores SIGTERM: its group is killed after the grace, then exit ${128 + constants.signals[signal]}`, POSIX_ONLY, async () => {
    const testCase = makeCase();
    try {
      const { end, pids, took } = await stopRun(testCase, IGNORING_TERM, signal);
      assert.equal(end.status, 128 + constants.signals[signal], end.stderr);
      assert.ok(took >= TERM_GRACE_MS - TIMING_SLACK_MS, `SIGTERM first, SIGKILL only after the grace (${took.toFixed(0)} ms)`);
      assert.ok(took < SLOW_END_MS, `exited soon after the grace (${took.toFixed(0)} ms)`);
      assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid)), GONE_WAIT_MS), 'the shell and its background sleep are gone');
      assert.doesNotMatch(end.stdout, VERDICT_LINE, 'a stopped run prints no verdict');
    } finally {
      cleanUp(testCase);
    }
  });
}

// A regression guard: the old code ended such a command at once too (its exit handler sent the group SIGTERM).
test('SIGTERM to suite run with a command that heeds SIGTERM: exit 143 within 2 s, its group gone', POSIX_ONLY, async () => {
  const testCase = makeCase();
  try {
    const { end, pids, took } = await stopRun(testCase, HEEDING_TERM, 'SIGTERM');
    assert.equal(end.status, 128 + constants.signals.SIGTERM, end.stderr);
    assert.ok(took < FAST_END_MS, `exited without waiting out the grace (${took.toFixed(0)} ms)`);
    assert.ok(await waitUntil(() => pids.every((pid) => !isAlive(pid)), GONE_WAIT_MS), 'the shell and its background sleep are gone');
  } finally {
    cleanUp(testCase);
  }
});

// A regression guard: the old code exited in the signal handler at once, so it never reached the cache either. The command
// exits 0 on the SIGTERM suite sends it, the one way a stopped run could look like a pass.
test('a run stopped by SIGTERM whose command then exits 0 is not cached: the next --cache run runs it again', POSIX_ONLY, async () => {
  const testCase = makeCase();
  const script = join(testCase.work, 'passes-or-waits.mjs');
  const hangFlag = join(testCase.work, 'hang');
  writeFileSync(script, PASSES_OR_WAITS);
  writeFileSync(hangFlag, '');
  const command = [process.execPath, script, hangFlag, testCase.pidFile];
  try {
    const { child, closed } = startSuite(testCase, ['--cache'], command);
    try {
      await readPids(testCase.pidFile, START_WAIT_MS);
      child.kill('SIGTERM');
      const stopped = await closed;
      assert.equal(stopped.status, 128 + constants.signals.SIGTERM, stopped.stderr);
      assert.doesNotMatch(stopped.stdout, VERDICT_LINE, 'a stopped run prints no verdict');
    } finally {
      child.kill('SIGKILL');
    }
    rmSync(hangFlag);
    const next = await startSuite(testCase, ['--cache'], command).closed;
    assert.equal(next.status, 0, next.stderr);
    assert.match(next.stdout, /^PASS /, 'the command ran again: the stopped run left no cached pass');
  } finally {
    cleanUp(testCase);
  }
});
