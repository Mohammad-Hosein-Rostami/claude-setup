// Gap tests for home/tools/suite's queue: a slot's holder.json with no valid pid or no valid start time (`{}`, a planted or foreign
// file) is stale, so the next waiter removes it instead of the slot staying held for good; a live, fresh holder still keeps it.
// Every case has its own state folder (CLAUDE_CONFIG_DIR) and its own throw-away folder in the OS temp folder, and runs the real
// CLI as a child process, so cases can run at any concurrency.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

// SUITE_HOLDER_TOOL points the cases at another copy of suite.mjs (an older queue.mjs), to show that they fail there.
const SUITE = process.env.SUITE_HOLDER_TOOL ?? fileURLToPath(new URL('../home/tools/suite/suite.mjs', import.meta.url));
// The waiter checks at once, then every 2 s: a stale holder is gone at the first check, so a run ends well within this.
const RUN_LIMIT_MS = 5000;
// Past the first check and the one 2 s later: a run still waiting then is held back by the holder, not by a slow start.
const HELD_OBSERVE_MS = 3000;
const PASSING_COMMAND = [process.execPath, '-e', 'process.exit(0)'];
const NOT_A_DATE = 'not a date';
const STALE_MARK = '(stale';

/** A fresh case: a state folder, a folder to run in, and the env that points the tool at the state folder. */
function makeCase() {
  const root = makeTempDir('suite-holder-');
  const configDir = join(root, 'config');
  const stateDir = join(configDir, 'state', 'suite');
  const work = join(root, 'work');
  mkdirSync(work);
  return { stateDir, work, env: { ...CLEAN_ENV, CLAUDE_CONFIG_DIR: configDir } };
}

/** Writes `text` as slots/0/holder.json, as a crashed run or a foreign file would leave it; returns the file's path. */
function plantHolderText(stateDir, text) {
  const slotDir = join(stateDir, 'slots', '0');
  mkdirSync(slotDir, { recursive: true });
  const path = join(slotDir, 'holder.json');
  writeFileSync(path, text);
  return path;
}

/**
 * Runs the CLI; when it has not exited after `limitMs`, kills it. Resolves to `{ status, stdout, stderr, timedOut }`, where
 * timedOut tells that the kill ended it.
 */
function suiteWithin(args, { env, cwd, limitMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SUITE, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let [stdout, stderr, timedOut] = ['', '', false];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, limitMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
  });
}

const runOneSlot = (work, env, limitMs) => suiteWithin(['run', '--repo', work, '--slots', '1', '--', ...PASSING_COMMAND], { env, cwd: work, limitMs });

const output = (result) => `exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;

// `null` is left out on purpose: readJson reads it as "being written", stale only after a 10 s grace, like a missing file.
// The fresh-start variants keep the age check out of it: an old start time alone already made a holder stale before the fix.
// pid 0 is the edge of "no valid pid": kill(0, 0) reaches this process group, so a liveness check alone calls it alive.
const ODD_HOLDERS = [
  { what: 'an empty object', text: () => '{}' },
  { what: 'a pid that is not a number', text: () => JSON.stringify({ pid: 'abc', startedAt: '2026-01-01T00:00:00Z' }) },
  { what: 'a pid that is not a number and a fresh start time', text: () => JSON.stringify({ pid: 'abc', startedAt: new Date().toISOString() }) },
  { what: 'a negative pid', text: () => JSON.stringify({ pid: -5, startedAt: new Date().toISOString() }) },
  { what: 'pid 0 and a fresh start time', text: () => JSON.stringify({ pid: 0, startedAt: new Date().toISOString() }) },
  { what: 'a live pid with a start time that is not a date', text: () => JSON.stringify({ pid: process.pid, startedAt: NOT_A_DATE }) },
  { what: 'a JSON array', text: () => '[]' },
];

for (const { what, text } of ODD_HOLDERS) {
  test(`a holder.json with ${what} is stale: a run with --slots 1 takes the slot at once and passes`, async () => {
    const { stateDir, work, env } = makeCase();
    plantHolderText(stateDir, text());
    const result = await runOneSlot(work, env, RUN_LIMIT_MS);
    assert.equal(result.timedOut, false, `the odd holder still holds the slot\n${output(result)}`);
    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /^PASS /);
  });
}

test('suite status marks a holder.json of {} as stale', async () => {
  const { stateDir, work, env } = makeCase();
  plantHolderText(stateDir, '{}');
  const result = await suiteWithin(['status'], { env, cwd: work, limitMs: RUN_LIMIT_MS });
  assert.equal(result.status, 0, output(result));
  const slotLine = result.stdout.split('\n').find((line) => line.startsWith('slot 0: '));
  assert.ok(slotLine?.includes(STALE_MARK), `slot 0 is shown as stale\n${output(result)}`);
});

test('suite status does not show a holder.json of {} as pid undefined', async () => {
  const { stateDir, work, env } = makeCase();
  plantHolderText(stateDir, '{}');
  const result = await suiteWithin(['status'], { env, cwd: work, limitMs: RUN_LIMIT_MS });
  assert.equal(result.status, 0, output(result));
  const slotLine = result.stdout.split('\n').find((line) => line.startsWith('slot 0: '));
  assert.ok(slotLine !== undefined, `status lists slot 0\n${output(result)}`);
  assert.doesNotMatch(slotLine, /pid undefined/);
});

// Guards the other side: the new check must not make a real holder stale, or two suites would run in one slot.
test('a holder with a live pid and a fresh start time keeps its slot: a run with --slots 1 is still waiting after 3 s', async () => {
  const { stateDir, work, env } = makeCase();
  const holderText = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), repo: work, command: 'held', token: 'other' });
  const holderPath = plantHolderText(stateDir, holderText);
  const result = await runOneSlot(work, env, HELD_OBSERVE_MS);
  assert.equal(result.timedOut, true, `the run did not wait for the live holder\n${output(result)}`);
  assert.equal(existsSync(holderPath), true, 'the live holder.json is still there');
  assert.equal(readFileSync(holderPath, 'utf8'), holderText, 'the live holder.json is unchanged');
});
