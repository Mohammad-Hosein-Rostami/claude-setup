// Tests for the lock around every read-change-write of accounts.json (home/tools/account/lib/registry-lock.mjs; review
// 1, R6: two adds at once lost an account): 2, 5 and 10 `claude-account add` processes started together all keep their
// name; a lock whose holder is gone or that is too old is taken over; a live lock makes a caller give up with an error
// that names the lock file; the lock is gone after the change, also after a change that throws. The store is the 0600
// file store under a temp HOME; K10: after each test the tokens are only in the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAccount } from '../home/tools/account/lib/accounts.mjs';
import { fileStore } from '../home/tools/account/lib/file-store.mjs';
import { AccountError } from '../home/tools/account/lib/names.mjs';
import { LOCK_FILE, LOCK_STALE_MS, withRegistryLock } from '../home/tools/account/lib/registry-lock.mjs';
import { readRegistry } from '../home/tools/account/lib/registry.mjs';
import { accountSandbox, assertNoLeak, fakeToken } from './account-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/account/account.mjs', import.meta.url));
const SHORT_WAIT_MS = 300; // a bound for the give-up case; nothing is measured
const tokens = [];

function sandbox(t) {
  const box = accountSandbox();
  t.after(() => assertNoLeak(box, tokens));
  mkdirSync(box.storeDir, { recursive: true, mode: 0o700 });
  return box;
}

/** Starts `add <name>` with the token on stdin; resolves to its exit code. */
function startAdd(box, name, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'add', name], { env: box.env, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, err }));
    child.stdin.end(`${token}\n`);
  });
}

for (const count of [2, 5, 10]) {
  test(`${count} adds started at once: every one is stored and listed`, async (t) => {
    const box = sandbox(t);
    const names = Array.from({ length: count }, (_, index) => `race-${index}`);
    const made = names.map((name) => fakeToken(`Race${count}${name}`));
    tokens.push(...made);
    const runs = await Promise.all(names.map((name, index) => startAdd(box, name, made[index])));
    assert.deepEqual(runs.map((run) => run.code), names.map(() => 0), runs.map((run) => run.err).join('\n').slice(0, 400));
    assert.deepEqual(Object.keys(readRegistry(box.env).accounts).sort(), names.sort());
    assert.ok(!existsSync(join(box.storeDir, LOCK_FILE)), 'the lock is gone afterwards');
  });
}

test('a lock whose holder is gone, or that is older than the stale bound, is taken over', (t) => {
  const box = sandbox(t);
  const lock = join(box.storeDir, LOCK_FILE);
  const gone = spawnSync(process.execPath, ['-e', '0']).pid;
  writeFileSync(lock, `${gone}\n`, { mode: 0o600 });
  const token = fakeToken('Stale');
  tokens.push(token);
  addAccount('work', token, { env: box.env, store: fileStore(box.storeDir) });
  assert.ok(readRegistry(box.env).accounts.work);
  writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
  utimesSync(lock, old, old);
  assert.equal(withRegistryLock(box.storeDir, () => 'ran'), 'ran');
  assert.ok(!existsSync(lock));
});

test('a live lock: the caller gives up within its bound, runs nothing, and the error names the lock file and the way out', (t) => {
  const box = sandbox(t);
  const lock = join(box.storeDir, LOCK_FILE);
  writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
  let ran = false;
  assert.throws(() => withRegistryLock(box.storeDir, () => { ran = true; }, { waitMs: SHORT_WAIT_MS }), (error) => {
    assert.ok(error instanceof AccountError && error.kind === 'locked');
    assert.ok(error.message.includes(lock) && /remove that file/.test(error.message), error.message);
    return true;
  });
  assert.equal(ran, false);
  assert.ok(existsSync(lock), 'a live lock is not removed');
});

test('the lock is released after a change that throws', (t) => {
  const box = sandbox(t);
  assert.throws(() => withRegistryLock(box.storeDir, () => { throw new Error('change failed'); }), /change failed/);
  assert.ok(!existsSync(join(box.storeDir, LOCK_FILE)));
});
