// Tests for "any max running makes outward asks click-only" (plan M2b, case 4): a max in any session of this machine (its record under
// HOME/.claude/state/main-agents) makes every outward ask anywhere run only after a click; a record that cannot be read fails closed;
// only the newest MAX_SESSION_FILES files are read; planted names, links and folders are skipped (lib/main-agents-store.mjs anyRunning).
// The store is written by hand under a temp HOME; the hook runs with a fake dialog tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anyRunning, MAX_SESSION_FILES } from '../home/hooks/lib/main-agents-store.mjs';
import { fakeDialog, hookAnswer, isolatedEnv, REAL_TIMEOUT, runGuard, runningMax, SESSION, stoppedMax, writeRecord } from './outward-deploy-helpers.mjs';

const OTHER_SESSION = 'session-87654321';
const DEPLOY = 'helm upgrade web chart';
const DEPLOY_REASON = 'helm upgrade deploys or changes live infrastructure; confirm with the owner';
const RUNNING_NOTE = 'a max agent is running: outward actions run only after a click on Allow';
const UNREADABLE_NOTE = 'the record of running max agents cannot be read: outward actions run only after a click on Allow';
const DEV = { agent_type: 'dev', agent_id: 'agentdev0001' };
const LOCAL_ASK = 'rm -rf /etc/zq-guard-test'; // a non-outward ask; the guard only reads the string
const STORE_BYTES_LIMIT = 64 * 1024; // MAX_STORE_BYTES of the store: a bigger file was not written by it
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'no uid or mode bits on Windows' : false };
const storeDir = (home) => join(home, '.claude', 'state', 'main-agents');

/** Writes raw text as a session file of the store (a corrupt or planted file). */
function writeRaw(home, name, text) {
  mkdirSync(storeDir(home), { recursive: true, mode: 0o700 });
  const file = join(storeDir(home), name);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

test('anyRunning: no store folder yet is "no"; a running max in one session is "yes"; a stopped max is "no"', () => {
  const env = isolatedEnv();
  assert.equal(anyRunning('max', env), 'no');
  writeRecord(env.HOME, OTHER_SESSION, stoppedMax());
  assert.equal(anyRunning('max', env), 'no');
  writeRecord(env.HOME, SESSION, runningMax(Date.now()));
  assert.equal(anyRunning('max', env), 'yes');
});

test('anyRunning: a running main agent of another type is not a max', () => {
  const env = isolatedEnv();
  writeRecord(env.HOME, SESSION, runningMax(Date.now(), 'dev'));
  assert.equal(anyRunning('max', env), 'no');
  assert.equal(anyRunning('dev', env), 'yes');
});

test('anyRunning fails closed: a file that is not JSON, not the store\'s shape or bigger than the store writes is "unusable"', () => {
  for (const text of ['not json', '[]', '{"launches":"x"}', '{"launches":[{"key":1}]}', '{"stopped":["bad id!"]}', `{"pad":"${'x'.repeat(STORE_BYTES_LIMIT)}"}`]) {
    const env = isolatedEnv();
    writeRaw(env.HOME, `${SESSION}.json`, text);
    assert.equal(anyRunning('max', env), 'unusable', text.slice(0, 40));
  }
});

test('anyRunning fails closed: a store folder that is a file or a link is "unusable"', () => {
  const asFile = isolatedEnv();
  mkdirSync(join(asFile.HOME, '.claude', 'state'), { recursive: true });
  writeFileSync(storeDir(asFile.HOME), 'x');
  assert.equal(anyRunning('max', asFile), 'unusable');
  const asLink = isolatedEnv();
  const real = join(asLink.HOME, 'real-store');
  mkdirSync(real, { mode: 0o700 });
  mkdirSync(join(asLink.HOME, '.claude', 'state'), { recursive: true });
  symlinkSync(real, storeDir(asLink.HOME), 'dir');
  assert.equal(anyRunning('max', asLink), 'unusable');
});

test('anyRunning fails closed: a session file it may not read is "unusable"', { skip: POSIX_ONLY.skip || (process.getuid?.() === 0 && 'root reads every file') }, () => {
  const env = isolatedEnv();
  chmodSync(writeRecord(env.HOME, SESSION, runningMax(Date.now())), 0o000);
  assert.equal(anyRunning('max', env), 'unusable');
});

test('anyRunning skips planted names: a name that is no session id is never read, even when it holds garbage or a max', () => {
  const env = isolatedEnv();
  writeRaw(env.HOME, '.hidden.json', 'not json');
  writeRaw(env.HOME, 'two words.json', 'not json');
  writeRaw(env.HOME, `${'a'.repeat(101)}.json`, 'not json');
  writeRaw(env.HOME, `${SESSION}.json.bak`, JSON.stringify(runningMax(Date.now())));
  writeRaw(env.HOME, 'notes.txt', JSON.stringify(runningMax(Date.now())));
  writeRaw(env.HOME, 'session.with.dots.json', JSON.stringify(runningMax(Date.now())));
  assert.equal(anyRunning('max', env), 'no');
});

test('anyRunning skips a folder and a link with a session name (only plain files are records, as the spec says)', () => {
  const env = isolatedEnv();
  mkdirSync(join(storeDir(env.HOME), `${SESSION}.json`), { recursive: true });
  const target = writeRaw(env.HOME, 'target.txt', JSON.stringify(runningMax(Date.now())));
  symlinkSync(target, join(storeDir(env.HOME), `${OTHER_SESSION}.json`));
  assert.equal(anyRunning('max', env), 'no');
});

/** MAX_SESSION_FILES + `extra` session files, the max record the oldest by mtime, every other file an empty record. */
function storeWithOldestMax(extra) {
  const env = isolatedEnv();
  const now = Date.now();
  const total = MAX_SESSION_FILES + extra;
  for (let i = 0; i < total; i++) {
    const file = i === 0 ? writeRecord(env.HOME, 'session-max', runningMax(now)) : writeRecord(env.HOME, `session-${String(i).padStart(4, '0')}`, stoppedMax());
    const seconds = (now - (total - i) * 60_000) / 1000; // file 0 (the max) is the oldest; one minute apart
    utimesSync(file, seconds, seconds);
  }
  return env;
}

test('anyRunning reads the newest MAX_SESSION_FILES files: a max among them counts, one older than all of them is not read', () => {
  assert.equal(MAX_SESSION_FILES, 64);
  assert.equal(anyRunning('max', storeWithOldestMax(0)), 'yes');
  assert.equal(anyRunning('max', storeWithOldestMax(1)), 'no');
});

test('anyRunning: a corrupt file older than the newest MAX_SESSION_FILES is not read, so it does not make the store unusable', () => {
  const env = storeWithOldestMax(1);
  const corrupt = writeRaw(env.HOME, 'session-corrupt.json', 'not json');
  const old = (Date.now() - 1000 * 60_000) / 1000;
  utimesSync(corrupt, old, old);
  assert.equal(anyRunning('max', env), 'no');
});

test('hook: a max running in another session makes a deploy from dev click-only (a full timeout denies)', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  writeRecord(dialog.env.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, DEV)), { decision: 'deny', reason: `no answer in 1 s; ${RUNNING_NOTE}, so it did not run (${DEPLOY_REASON})` });
});

test('hook: a max running makes a deploy from a new session with no agent (a claude -p max started) click-only', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  writeRecord(dialog.env.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.equal(hookAnswer(runGuard(DEPLOY, dialog.env, { session_id: 'session-new00001' })).decision, 'deny');
  assert.match(dialog.shown().args.join('\n'), new RegExp(`it does not run \\(${RUNNING_NOTE}\\)\\.`));
});

test('hook: a max running, a click on Allow still lets a deploy from dev run', () => {
  const dialog = fakeDialog('allow');
  writeRecord(dialog.env.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, DEV)), { decision: 'allow', reason: '' });
});

test('hook: an unreadable record makes a deploy from dev click-only, with the unreadable note', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  writeRaw(dialog.env.HOME, `${OTHER_SESSION}.json`, 'not json');
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, DEV)), { decision: 'deny', reason: `no answer in 1 s; ${UNREADABLE_NOTE}, so it did not run (${DEPLOY_REASON})` });
});

test('hook: an unreadable record with no GUI denies a deploy instead of handing it to Claude Code\'s prompt', () => {
  const env = isolatedEnv({ SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' });
  writeRaw(env.HOME, `${OTHER_SESSION}.json`, 'not json');
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, env, DEV)), { decision: 'deny', reason: `no dialog can be shown here; ${UNREADABLE_NOTE}, so it did not run (${DEPLOY_REASON})` });
});

test('hook: after the max stopped, a deploy from dev keeps the timed allow again', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  writeRecord(dialog.env.HOME, OTHER_SESSION, stoppedMax());
  assert.deepEqual(hookAnswer(runGuard(DEPLOY, dialog.env, DEV)), { decision: 'allow', reason: '' });
});

test('hook: a max running does not change a non-outward ask from dev (a full timeout still goes ahead)', () => {
  const dialog = fakeDialog('timeout', REAL_TIMEOUT);
  writeRecord(dialog.env.HOME, OTHER_SESSION, runningMax(Date.now()));
  assert.deepEqual(hookAnswer(runGuard(LOCAL_ASK, dialog.env, DEV)), { decision: 'allow', reason: '' });
});
