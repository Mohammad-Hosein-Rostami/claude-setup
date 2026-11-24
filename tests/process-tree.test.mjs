// Tests for signalProcessTree and endProcessTree (home/tools/long-run/lib/process-tree.mjs), the one way land, suite and long-run
// end a command's tree: SIGTERM to the whole group, SIGKILL to what is left after TERM_GRACE_MS, a group with nothing left is no
// error, any other kill error is; on Windows taskkill /T (with /F for SIGKILL, and at once for endProcessTree).
// The POSIX cases start real detached `sh` groups and SIGKILL them in a finally block; the error and Windows cases stand in for
// process.kill and spawnSync (or put a fake `taskkill` first on PATH), so no real process is signalled there.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { TERM_GRACE_MS, endProcessTree, signalProcessTree } from '../home/tools/long-run/lib/process-tree.mjs';
import { POSIX_ONLY, elapsedSince, groupExists, isAlive, killGroupQuietly, waitUntil } from './process-group-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

// The grace the change sets between SIGTERM and SIGKILL.
const EXPECTED_GRACE_MS = 3000;
// How early a timed end may come: timers and the 100 ms poll are not exact.
const TIMING_SLACK_MS = 200;
// A group that does not ignore SIGTERM ends within this.
const FAST_END_MS = 2000;
// A group that ignores SIGTERM ends by SIGKILL before this.
const SLOW_END_MS = 6000;
// How long a killed group's members may take to be reaped (an orphan is reaped by init) and the group to be gone.
const GONE_WAIT_MS = 2000;
// How long a started group may take to print its background pid.
const START_WAIT_MS = 5000;
// A pid no real process is signalled with: the cases that use it stand in for process.kill.
const FAKE_PID = 4242;
// Background processes live this long unless something ends them; every case ends them far sooner.
const SLEEP = 'sleep 30 >/dev/null 2>&1 &';

/** A detached `sh -c script` (its own process group) and the promise of its exit. */
function startDetached(script) {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, exited };
}

/** Starts `script`, which prints its background pid (`echo $!`) once its trap and background process are set up. */
async function startGroup(script) {
  const { child, exited } = startDetached(script);
  let printed = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { printed += chunk; });
  const ready = await waitUntil(() => printed.includes('\n'), START_WAIT_MS);
  if (!ready) killGroupQuietly(child.pid);
  assert.ok(ready, `the group printed its background pid within ${START_WAIT_MS} ms`);
  return { child, exited, background: Number(printed.trim()) };
}

/** A kill error as process.kill throws it. */
const killError = (code) => Object.assign(new Error(`kill ${code}`), { code });

/** Runs `body` with process.kill replaced by `fake`; the real one is back afterwards, also when `body` throws. */
async function withKill(fake, body) {
  const original = process.kill;
  process.kill = fake;
  try {
    return await body();
  } finally {
    process.kill = original;
  }
}

/** A process.kill stand-in that records each call and throws `error` (when given) instead of signalling. */
function recordingKill(calls, error = null) {
  return (pid, signal) => {
    calls.push([pid, signal]);
    if (error !== null) throw error;
    return true;
  };
}

test('the grace between SIGTERM and SIGKILL is 3 s', () => {
  assert.equal(TERM_GRACE_MS, EXPECTED_GRACE_MS);
});

test('endProcessTree ends a group that heeds SIGTERM within 2 s, its background process too', POSIX_ONLY, async () => {
  const { child, background } = await startGroup(`${SLEEP} echo $!; wait`);
  try {
    const startedAt = performance.now();
    await endProcessTree(child);
    const took = elapsedSince(startedAt);
    assert.ok(took < FAST_END_MS, `ended in ${took.toFixed(0)} ms, not after the grace`);
    assert.ok(await waitUntil(() => !groupExists(child.pid), GONE_WAIT_MS), 'the group is gone (ESRCH)');
    assert.equal(isAlive(background), false, 'the background sleep is gone');
  } finally {
    killGroupQuietly(child.pid);
  }
});

test('endProcessTree ends a group that ignores SIGTERM by SIGKILL after the grace', POSIX_ONLY, async () => {
  // `trap '' TERM` ignores SIGTERM in the shell, and the background sleep inherits the ignore.
  const { child, background } = await startGroup(`trap '' TERM; ${SLEEP} echo $!; wait`);
  try {
    const startedAt = performance.now();
    await endProcessTree(child);
    const took = elapsedSince(startedAt);
    assert.ok(took >= TERM_GRACE_MS - TIMING_SLACK_MS, `SIGKILL came after the grace, not at once (${took.toFixed(0)} ms)`);
    assert.ok(took < SLOW_END_MS, `SIGKILL came soon after the grace (${took.toFixed(0)} ms)`);
    assert.ok(await waitUntil(() => !groupExists(child.pid), GONE_WAIT_MS), 'the group is gone (ESRCH)');
    assert.equal(isAlive(background), false, 'the background sleep that ignored SIGTERM is gone');
  } finally {
    killGroupQuietly(child.pid);
  }
});

test('endProcessTree after the leader exited still ends the background process it left in its group', POSIX_ONLY, async () => {
  const { child, exited, background } = await startGroup(`${SLEEP} echo $!; exit 0`);
  try {
    await exited;
    assert.equal(isAlive(background), true, 'precondition: the leader is gone but its background sleep runs');
    await endProcessTree(child);
    assert.ok(await waitUntil(() => !isAlive(background), GONE_WAIT_MS), 'the background sleep is gone');
    assert.ok(await waitUntil(() => !groupExists(child.pid), GONE_WAIT_MS), 'the group is gone (ESRCH)');
  } finally {
    killGroupQuietly(child.pid);
  }
});

test('a group that is already gone: endProcessTree resolves and signalProcessTree returns false', POSIX_ONLY, async () => {
  const { child, exited } = startDetached('exit 0');
  try {
    await exited;
    assert.equal(groupExists(child.pid), false, 'precondition: nothing of the group is left');
    assert.equal(await endProcessTree(child), undefined);
    assert.equal(signalProcessTree(child, 'SIGTERM'), false);
  } finally {
    killGroupQuietly(child.pid);
  }
});

test('signalProcessTree returns true while the group has a member', POSIX_ONLY, async () => {
  const { child, background } = await startGroup(`${SLEEP} echo $!; wait`);
  try {
    assert.equal(signalProcessTree(child, 'SIGTERM'), true);
    assert.ok(await waitUntil(() => !isAlive(background), GONE_WAIT_MS), 'the SIGTERM reached the background sleep');
  } finally {
    killGroupQuietly(child.pid);
  }
});

test('signalProcessTree signals the whole group (negative pid) and takes EPERM as nothing left', async () => {
  const calls = [];
  const result = await withKill(recordingKill(calls, killError('EPERM')), () => signalProcessTree({ pid: FAKE_PID }, 'SIGTERM', { platform: 'linux' }));
  assert.equal(result, false);
  assert.deepEqual(calls, [[-FAKE_PID, 'SIGTERM']]);
});

test('signalProcessTree rethrows a kill error other than ESRCH or EPERM', async () => {
  const error = killError('EINVAL');
  await withKill(recordingKill([], error), () => {
    assert.throws(() => signalProcessTree({ pid: FAKE_PID }, 'SIGKILL', { platform: 'linux' }), (thrown) => thrown === error);
  });
});

test('endProcessTree rejects with a kill error other than ESRCH or EPERM', async () => {
  const error = killError('EINVAL');
  const calls = [];
  await withKill(recordingKill(calls, error), async () => {
    await assert.rejects(endProcessTree({ pid: FAKE_PID }, { platform: 'linux' }), (thrown) => thrown === error);
  });
  assert.deepEqual(calls, [[-FAKE_PID, 'SIGTERM']], 'it stopped at the first failed signal');
});

test('signalProcessTree on Windows runs taskkill /T, with /F only for SIGKILL, hidden and without output', async () => {
  const runs = [];
  const runner = (...args) => { runs.push(args); };
  const kills = [];
  const results = await withKill(recordingKill(kills), () => ['SIGTERM', 'SIGKILL'].map((signal) => signalProcessTree({ pid: FAKE_PID }, signal, { platform: 'win32', runner })));
  assert.deepEqual(results, [true, true]);
  const hidden = { stdio: 'ignore', windowsHide: true };
  assert.deepEqual(runs, [
    ['taskkill', ['/PID', String(FAKE_PID), '/T'], hidden],
    ['taskkill', ['/PID', String(FAKE_PID), '/T', '/F'], hidden],
  ]);
  assert.deepEqual(kills, [], 'no POSIX signal on Windows');
});

// endProcessTree takes no runner, so a fake `taskkill` first on PATH records its argv; a sh script, hence POSIX only (on real
// Windows the real taskkill would run). No process.kill call means no SIGTERM step and no grace either.
test('endProcessTree on Windows runs taskkill /T /F at once and sends no POSIX signal', POSIX_ONLY, async () => {
  const bin = makeTempDir('process-tree-bin-');
  const argvFile = join(bin, 'taskkill-argv');
  const fake = join(bin, 'taskkill');
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\n`);
  chmodSync(fake, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath}`;
  const kills = [];
  try {
    await withKill(recordingKill(kills), () => endProcessTree({ pid: FAKE_PID }, { platform: 'win32' }));
  } finally {
    process.env.PATH = originalPath;
  }
  assert.deepEqual(readFileSync(argvFile, 'utf8').split('\n').filter(Boolean), ['/PID', String(FAKE_PID), '/T', '/F']);
  assert.deepEqual(kills, [], 'no POSIX signal on Windows');
});
