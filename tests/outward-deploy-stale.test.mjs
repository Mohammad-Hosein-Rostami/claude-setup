// Tests for when a max stops counting as running (plan M2b, case 5; lib/main-agents-store.mjs anyRunning(type, env, now)): a launch
// with no agent id yet counts for PENDING_MS, a started max until STALE_MS passes with no tool call of its own (its call counter's
// mtime), and a launch dated ahead of the clock is re-dated to now. The clock is passed in; the counter lives in a temp TMPDIR.
import { makeTempDir } from './temp-dir-helpers.mjs';

// The call counters live under os.tmpdir() (lib/edit-log.mjs checkedTempRoot), read at call time: point it at a private temp folder
// before any counter is made, and the guard log too, so a refused temp root is never logged to the real one.
const TEMP = makeTempDir('od-stale-tmp-');
process.env.TMPDIR = TEMP;
process.env.TEMP = TEMP;
process.env.TMP = TEMP;
process.env.CLAUDE_GUARD_LOG = `${makeTempDir('od-stale-log-')}/guard.jsonl`;

const { default: test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { mkdirSync, utimesSync, writeFileSync } = await import('node:fs');
const { dirname } = await import('node:path');
const { anyRunning, PENDING_MS, STALE_MS } = await import('../home/hooks/lib/main-agents-store.mjs');
const { callCounterPath } = await import('../home/hooks/lib/writer-agents.mjs');
const { isolatedEnv, MAX_AGENT, pendingMax, runningMax, SESSION, writeRecord } = await import('./outward-deploy-helpers.mjs');

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0); // a fixed clock, ms
const COUNTER_SLACK_MS = 1000; // file mtimes are set through seconds; stay a second away from the boundary
const HOUR_MS = 60 * 60 * 1000;

/** The record of one launch under a fresh temp HOME, and anyRunning('max') at NOW. */
function runningAt(record) {
  const env = isolatedEnv();
  writeRecord(env.HOME, SESSION, record);
  return anyRunning('max', env, NOW);
}

/** Sets max's last tool call (the mtime of its call counter) to `at`. */
function lastToolCallAt(at) {
  const counter = callCounterPath(SESSION, MAX_AGENT);
  assert.ok(counter?.startsWith(TEMP), `counter in the temp folder: ${counter}`);
  mkdirSync(dirname(counter), { recursive: true });
  writeFileSync(counter, 'x');
  utimesSync(counter, at / 1000, at / 1000);
}

test('the limits are the ones the plan names: 2 min for a launch with no agent yet, 3 h with no tool call', () => {
  assert.equal(PENDING_MS, 2 * 60 * 1000);
  assert.equal(STALE_MS, 3 * HOUR_MS);
});

test('a launch with no agent id counts until PENDING_MS has passed, not at PENDING_MS', () => {
  assert.equal(runningAt(pendingMax(NOW)), 'yes');
  assert.equal(runningAt(pendingMax(NOW - PENDING_MS + 1)), 'yes');
  assert.equal(runningAt(pendingMax(NOW - PENDING_MS)), 'no');
  assert.equal(runningAt(pendingMax(NOW - PENDING_MS - 1)), 'no');
});

test('a started max with no tool call counts from its launch until STALE_MS has passed', () => {
  assert.equal(runningAt(runningMax(NOW - PENDING_MS - 1)), 'yes'); // past the pending limit: the agent id keeps it
  assert.equal(runningAt(runningMax(NOW - STALE_MS + 1)), 'yes');
  assert.equal(runningAt(runningMax(NOW - STALE_MS)), 'no');
});

test('a tool call of max keeps it running: STALE_MS counts from its last tool call when that is later than the launch', () => {
  const launchedLongAgo = runningMax(NOW - 10 * HOUR_MS);
  lastToolCallAt(NOW - STALE_MS + COUNTER_SLACK_MS);
  assert.equal(runningAt(launchedLongAgo), 'yes');
  lastToolCallAt(NOW - STALE_MS - COUNTER_SLACK_MS);
  assert.equal(runningAt(launchedLongAgo), 'no');
});

test('a tool call older than the launch does not shorten it: the later of the two counts', () => {
  lastToolCallAt(NOW - 10 * HOUR_MS);
  assert.equal(runningAt(runningMax(NOW - HOUR_MS)), 'yes');
});

test('a launch dated ahead of the clock is re-dated to now, so it counts as running (never as stale)', () => {
  assert.equal(runningAt(pendingMax(NOW + 10 * HOUR_MS)), 'yes');
  assert.equal(runningAt(runningMax(NOW + 100 * HOUR_MS)), 'yes');
});

test('a stale max next to a running one in another session: the running one counts', () => {
  const env = isolatedEnv();
  writeRecord(env.HOME, SESSION, runningMax(NOW - STALE_MS - 1));
  assert.equal(anyRunning('max', env, NOW), 'no');
  writeRecord(env.HOME, 'session-other001', pendingMax(NOW));
  assert.equal(anyRunning('max', env, NOW), 'yes');
});
