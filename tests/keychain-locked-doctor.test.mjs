// Tests for the Keychain lock check of scripts/doctor-accounts.mjs: a locked Keychain (security exit 36, as in an ssh
// session) is named even when no account is named (CLAUDE_ACCOUNT unset and no default), once, with one Keychain call
// and no token read. The macOS `security` program is never started and the real Keychain is never read: each case runs
// doctor in a child process with the Keychain store of keychain-store.mjs given a stand-in `run` that logs the command
// lines it is asked to run and answers one made-up exit status. HOME and the accounts folder are temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addAccount } from '../home/tools/account/lib/accounts.mjs';
import { fakeToken, memoryStore } from './account-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const KEYCHAIN_STORE_URL = pathToFileURL(join(REPO, 'home/tools/account/lib/keychain-store.mjs')).href;
const DOCTOR_URL = pathToFileURL(join(REPO, 'scripts/doctor-accounts.mjs')).href;
const EXIT_LOCKED = 36;
const LOCK_PROBE = 'show-keychain-info';

// Runs doctor's main with a Keychain-kind store whose `security` runner is the stand-in (FAKE_SECURITY_STATUS: a number
// or `null` for "did not answer"; FAKE_STORE_KIND `file` gives a store of another kind, for which no call may be made).
const DRIVER = `
import { appendFileSync } from 'node:fs';
import { keychainStore } from '${KEYCHAIN_STORE_URL}';
import { main } from '${DOCTOR_URL}';
const status = process.env.FAKE_SECURITY_STATUS === 'null' ? null : Number(process.env.FAKE_SECURITY_STATUS);
const run = (line) => { appendFileSync(process.env.FAKE_SECURITY_LOG, line + '\\n'); return { status, stdout: '', stderr: '' }; };
const store = process.env.FAKE_STORE_KIND === 'file' ? { kind: 'file', get: () => null, put() {}, remove: () => false } : keychainStore({ run });
process.exitCode = await main(process.argv.slice(2), process.env, { store, run });
`;

/** A temp HOME with the driver; `accounts` are stored in its registry (names only; the tokens go to a memory store). */
function sandbox({ accounts = [] } = {}) {
  const dir = makeTempDir('keychain-doctor-');
  const home = join(dir, 'home');
  const claudeDir = join(home, '.claude');
  const project = join(dir, 'project');
  for (const path of [home, claudeDir, project]) mkdirSync(path);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SHELL: '/bin/zsh', CLAUDE_ACCOUNT_DIR: join(home, 'accounts'), CLAUDE_ACCOUNT_STORE: 'file' };
  for (const name of accounts) addAccount(name, fakeToken(`Doctor${name}`), { env, store: memoryStore() });
  const driver = join(dir, 'driver.mjs');
  writeFileSync(driver, DRIVER);
  const securityLog = join(dir, 'security.log');
  /** Runs doctor; `status` is the exit the stand-in `security` answers with. */
  const run = (status, extra = {}) => {
    const done = spawnSync(process.execPath, [driver, claudeDir, REPO, project], { env: { ...env, FAKE_SECURITY_STATUS: String(status), FAKE_SECURITY_LOG: securityLog, ...extra }, encoding: 'utf8' });
    const calls = existsSync(securityLog) ? readFileSync(securityLog, 'utf8').split('\n').filter(Boolean) : [];
    return { code: done.status, lines: done.stdout.split('\n').filter(Boolean), stderr: done.stderr, calls };
  };
  return { run, claudeDir };
}

const lockLines = (lines) => lines.filter((line) => /Keychain is locked/.test(line));

test('a locked Keychain with no account at all: one WARN naming it, exit 0, one Keychain call that reads no item', () => {
  const { run } = sandbox();
  const { code, lines, stderr, calls } = run(EXIT_LOCKED);
  assert.deepEqual([code, stderr], [0, '']);
  assert.equal(lockLines(lines).length, 1, lines.join('\n'));
  assert.match(lockLines(lines)[0], /^WARN {2}the Keychain is locked/);
  assert.deepEqual(calls, [LOCK_PROBE], 'one call, and not a find-generic-password (no token is read)');
  assert.ok(!lines.some((line) => /login check: no account found/.test(line)), 'the login check does not claim "no account" while the Keychain is the reason');
});

test('a locked Keychain with accounts stored but none named: named once, the account checks still print', () => {
  const { run } = sandbox({ accounts: ['work'] });
  const { code, lines, calls } = run(EXIT_LOCKED);
  assert.equal(code, 0);
  assert.equal(lockLines(lines).length, 1, lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('account work: plan unknown')), 'the registry is a file: its checks do not need the Keychain');
  assert.deepEqual(calls, [LOCK_PROBE]);
});

test('a locked Keychain with an account named: still one lock line and one Keychain call (one deadline, no token read)', () => {
  const { run } = sandbox({ accounts: ['work'] });
  const { lines, calls } = run(EXIT_LOCKED, { CLAUDE_ACCOUNT: 'work' });
  assert.equal(lockLines(lines).length, 1, lines.join('\n'));
  assert.deepEqual(calls, [LOCK_PROBE]);
});

test('a Keychain that does not answer in time is one WARN and the only call', () => {
  const { run } = sandbox({ accounts: ['work'] });
  const { code, lines, calls } = run('null', { CLAUDE_ACCOUNT: 'work' });
  assert.equal(code, 0);
  assert.equal(lines.filter((line) => /Keychain did not answer/.test(line)).length, 1, lines.join('\n'));
  assert.deepEqual(calls, [LOCK_PROBE]);
});

test('an open Keychain and no account: no lock line, the old "no account found" line stays', () => {
  const { run } = sandbox();
  const { code, lines, calls } = run(0);
  assert.equal(code, 0);
  assert.equal(lockLines(lines).length, 0);
  assert.ok(lines.some((line) => /login check: no account found/.test(line)), lines.join('\n'));
  assert.deepEqual(calls, [LOCK_PROBE]);
});

test('a store that is not the Keychain is never asked about the lock', () => {
  const { run } = sandbox();
  const { code, lines, calls } = run(EXIT_LOCKED, { FAKE_STORE_KIND: 'file' });
  assert.equal(code, 0);
  assert.equal(lockLines(lines).length, 0);
  assert.deepEqual(calls, []);
});

test('the Keychain is locked and Claude Code left its own login file: both are named', () => {
  const { run, claudeDir } = sandbox();
  writeFileSync(join(claudeDir, '.credentials.json'), '{}');
  const { lines } = run(EXIT_LOCKED);
  assert.equal(lockLines(lines).length, 1);
  assert.ok(lines.some((line) => line.includes('.credentials.json exists')), lines.join('\n'));
});
