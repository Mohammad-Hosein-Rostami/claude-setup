// Tests for home/tools/disk-free/lib/lock-file.mjs: one holder at a time, a stale lock is broken by exactly one process (16 racers), a crashed
// breaker's claim file does not block for ever, a FIFO or link at the lock path is never waited on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLock, takeLock } from '../home/tools/disk-free/lib/lock-file.mjs';
import { posix } from './disk-clean-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const STALE_MS = 60_000;
const RACERS = 16;
const RACE_ROUNDS = Number(process.env.DISK_CLEAN_LOCK_ROUNDS ?? 10);
const LIB = new URL('../home/tools/disk-free/lib/lock-file.mjs', import.meta.url).href;
const setAge = (path, ms) => utimesSync(path, new Date(Date.now() - ms), new Date(Date.now() - ms));
const lockIn = () => join(makeTempDir('lock-'), 'the.lock');

test('one holder at a time; released, the next call gets it', () => {
  const lock = lockIn();
  assert.equal(takeLock(lock, Date.now(), STALE_MS), true);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), false);
  releaseLock(lock);
  releaseLock(lock); // a lock a breaker removed already is not an error
  assert.equal(takeLock(lock, Date.now(), STALE_MS), true);
});

test('a lock younger than the limit is kept; an older one is broken and the claim file does not stay', () => {
  const lock = lockIn();
  takeLock(lock, Date.now(), STALE_MS);
  setAge(lock, STALE_MS - 5000);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), false);
  setAge(lock, STALE_MS + 5000);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), true);
  assert.equal(lstatSync(lock).mtimeMs > Date.now() - STALE_MS, true, 'a new lock, not the old file');
  assert.deepEqual(readdirSync(join(lock, '..')), ['the.lock']);
});

test('a claim file left by a crashed breaker blocks while it is young and is removed once it is old; then the next call breaks the lock', () => {
  const lock = lockIn();
  takeLock(lock, Date.now(), STALE_MS);
  setAge(lock, 2 * STALE_MS);
  const info = lstatSync(lock);
  const claim = `${lock}.break-${info.ino}-${info.mtimeMs}`;
  writeFileSync(claim, '');
  assert.equal(takeLock(lock, Date.now(), STALE_MS), false);
  assert.equal(existsSync(claim), true);
  setAge(claim, 2 * STALE_MS);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), false, 'this call only clears the old claim');
  assert.equal(existsSync(claim), false);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), true);
});

test('a lock that is a FIFO is not waited on: young means held, old is replaced', posix, () => {
  const lock = lockIn();
  assert.equal(spawnSync('mkfifo', [lock]).status, 0);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), false);
  setAge(lock, 2 * STALE_MS);
  assert.equal(takeLock(lock, Date.now(), STALE_MS), true);
  assert.equal(lstatSync(lock).isFile(), true);
});

/** Starts RACERS processes that all call takeLock at one instant on a stale lock; returns how many got the lock. */
async function racedTakes(lock) {
  const barrier = Date.now() + 700;
  const script = `import { appendFileSync } from 'node:fs';
import { takeLock } from ${JSON.stringify(LIB)};
while (Date.now() < ${barrier}) {}
if (takeLock(${JSON.stringify(lock)}, Date.now(), ${STALE_MS})) appendFileSync(${JSON.stringify(`${lock}.winners`)}, 'x');`;
  await Promise.all(Array.from({ length: RACERS }, () => new Promise((resolve) => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' }).on('close', resolve))));
  return existsSync(`${lock}.winners`) ? readFileSync(`${lock}.winners`, 'utf8').length : 0;
}

test(`${RACERS} processes taking a stale lock at the same instant: exactly one gets it (${RACE_ROUNDS} rounds)`, async () => {
  for (let round = 0; round < RACE_ROUNDS; round += 1) {
    const lock = lockIn();
    mkdirSync(join(lock, '..'), { recursive: true });
    writeFileSync(lock, '');
    setAge(lock, 2 * STALE_MS);
    assert.equal(await racedTakes(lock), 1, `round ${round}`);
  }
});
