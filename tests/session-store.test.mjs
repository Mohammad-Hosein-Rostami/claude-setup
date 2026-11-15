// Tests for lib/session-store.mjs, the two guard stores that use it (guard-bounced: lib/bounce-once.mjs, guard-allowed:
// lib/allowed-literals.mjs) and the guard log (lib/guard-log.mjs): a link, FIFO, socket, folder or file planted where a store or the log
// lives is never followed, never waited on and never cleaned up, and the guard then asks as if nothing were stored. Everything is planted
// inside a fresh temp folder made here; command strings are only passed to decide() or the hook, nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedLiteralsDir, isRemembered, remember } from '../home/hooks/lib/allowed-literals.mjs';
import { adviceOnce, bouncedDir, bounceOnce } from '../home/hooks/lib/bounce-once.mjs';
import { logDecision } from '../home/hooks/lib/guard-log.mjs';
import { readSessionFile, writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' }; // links need extra rights on Windows, and it has no FIFOs or owner ids
const PROJECT = resolve('/work/proj');
const VARIABLE_COMMAND = '$CMD --version';
const ADVICE_COMMAND = 'sed -i s/a/b/ pnpm-lock.yaml';
const SECRET_COMMAND = `KEY='${['i6IW', 'fakefilekey', '0123'].join('')}' ./fetch-figma.sh`;
const VALUE = 'alpha-value-123';
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const HOOK_TIMEOUT_MS = 20_000; // far above a normal run (about 0.2 s): reaching it means the hook hung

const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));
function privateEnv() {
  const home = tempDir('store-home-');
  return { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: join(home, 'guard.jsonl') };
}

// The two stores through their public functions. use(env) makes one request and returns true when the store worked: a bounce was stored,
// or the value counts as remembered after remember().
const STORES = [
  ['guard-bounced', bouncedDir, (env) => bounceOnce(decide(VARIABLE_COMMAND, { cwd: PROJECT }), { command: VARIABLE_COMMAND, cwd: PROJECT, input: { session_id: 'sess-1' } }, env) !== undefined],
  ['guard-allowed', allowedLiteralsDir, (env) => {
    remember('sess-1', [VALUE], env);
    return isRemembered('sess-1', [VALUE], env);
  }],
  // advice shares the bounce store: it worked when the first send was denied (an unusable store lets the command run instead)
  ['guard-bounced (advice)', bouncedDir, (env) => adviceOnce(decide(ADVICE_COMMAND, { cwd: PROJECT }).advice, { command: ADVICE_COMMAND, cwd: PROJECT, input: { session_id: 'sess-1' } }, env) !== ''],
];

const makeOld = (path) => utimesSync(path, EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);
const mkfifo = (path) => assert.equal(spawnSync('mkfifo', [path]).status, 0, `mkfifo ${path}`);

/** Every entry of a folder: what it is (file text, folder, link target), its mode and mtime. */
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    const stats = lstatSync(path);
    const what = stats.isFile() ? readFileSync(path, 'utf8') : stats.isDirectory() ? 'folder' : `special ${stats.mode}`;
    return [name, `${what} | ${stats.mode} | ${stats.mtimeMs}`];
  }));
}

/** A folder of old files, some named like the stores' own files: nothing in it may change. */
function oldFilesFolder() {
  const dir = tempDir('store-target-');
  for (const name of ['other-session.json', 'abc.json.1234.tmp', 'notes.txt', 'keep.json.bak']) {
    writeFileSync(join(dir, name), `{"digests": []} ${name}`);
    makeOld(join(dir, name));
  }
  return dir;
}

test('a store folder that is a link (to a folder of old files named like store files) is not used: no bounce, nothing remembered, the target untouched', posix, () => {
  for (const [name, dirOf, use] of STORES) {
    const env = privateEnv();
    const target = oldFilesFolder();
    const before = snapshot(target);
    const targetMode = statSync(target).mode;
    mkdirSync(dirname(dirOf(env)), { recursive: true });
    symlinkSync(target, dirOf(env));
    for (const send of [1, 2, 3]) assert.equal(use(env), false, `${name}, send ${send}`);
    assert.deepEqual(snapshot(target), before, `${name}: every file in the target is still there, unchanged`);
    assert.equal(statSync(target).mode, targetMode, `${name}: the target's mode is unchanged`);
  }
});

// Each plants something other than a regular file of this user at <store>/sess-1.json; the store is then not used and the plant stays.
const BAD_SESSION_FILES = [
  ['a link to a JSON file', (path) => {
    const outside = join(tempDir('store-outside-'), 'victim.json');
    writeFileSync(outside, '{"digests": []}');
    symlinkSync(outside, path);
    return () => readFileSync(outside, 'utf8') === '{"digests": []}';
  }],
  ['a dangling link', (path) => {
    const missing = join(tempDir('store-outside-'), 'created-through-the-link.json');
    symlinkSync(missing, path);
    return () => readdirSync(dirname(missing)).length === 0;
  }],
  ['a folder', (path) => {
    mkdirSync(path);
    return () => lstatSync(path).isDirectory();
  }],
]; // a FIFO is tested through the hook process below: a read that blocks here would hang the whole test file

test('a session file that is a link, a dangling link or a folder is not used, and it is left as it was', posix, () => {
  for (const [store, dirOf, use] of STORES) {
    for (const [name, plant] of BAD_SESSION_FILES) {
      const env = privateEnv();
      mkdirSync(dirOf(env), { recursive: true, mode: 0o700 });
      const unchanged = plant(join(dirOf(env), 'sess-1.json'));
      for (const send of [1, 2]) assert.equal(use(env), false, `${store}, ${name}, send ${send}`);
      assert.ok(unchanged(), `${store}, ${name}: left as it was`);
    }
  }
});

/** Hard-links a root-owned file to target (macOS allows it; Linux with protected_hardlinks does not); true when target is another owner's. */
function linkRootOwnedFile(target) {
  for (const source of ['/private/etc/hosts', '/etc/hosts']) {
    try {
      linkSync(source, target);
      return lstatSync(target).uid !== process.getuid();
    } catch {
      // not linkable here (another volume, or not allowed): try the next one
    }
  }
  return false;
}

test('a session file of another owner (a hard link to a root-owned file) is not used and stays as it is', posix, (t) => {
  for (const [store, dirOf, use] of STORES) {
    const env = privateEnv();
    mkdirSync(dirOf(env), { recursive: true, mode: 0o700 });
    const file = join(dirOf(env), 'sess-1.json');
    if (!linkRootOwnedFile(file)) return t.skip('no root-owned file can be hard-linked here (Linux protected_hardlinks, or root)');
    const before = lstatSync(file);
    for (const send of [1, 2]) assert.equal(use(env), false, `${store}, send ${send}`);
    assert.deepEqual([lstatSync(file).ino, lstatSync(file).uid], [before.ino, before.uid], `${store}: the link is left in place`);
  }
});

test('a socket at the session file is not used either', posix, async () => {
  for (const [store, dirOf, use] of STORES) {
    const home = mkdtempSync('/tmp/ss-'); // a socket path must stay short (about 100 bytes)
    const env = { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: join(home, 'g.jsonl') };
    mkdirSync(dirOf(env), { recursive: true, mode: 0o700 });
    const server = createServer();
    await new Promise((listening) => server.listen(join(dirOf(env), 'sess-1.json'), listening));
    try {
      assert.equal(use(env), false, store);
      assert.ok(lstatSync(join(dirOf(env), 'sess-1.json')).isSocket(), store);
    } finally {
      server.close();
    }
  }
});

test('a store folder that is a file, or that this user cannot write, is not used on any send', posix, () => {
  const permissionsApply = process.getuid() !== 0; // root writes anyway
  for (const [name, dirOf, use] of STORES) {
    const asFile = privateEnv();
    mkdirSync(dirname(dirOf(asFile)), { recursive: true });
    writeFileSync(dirOf(asFile), 'not a folder');
    for (const send of [1, 2]) assert.equal(use(asFile), false, `${name}: a file, send ${send}`);
    assert.equal(readFileSync(dirOf(asFile), 'utf8'), 'not a folder');
    const readOnly = privateEnv();
    mkdirSync(dirname(dirOf(readOnly)), { recursive: true });
    mkdirSync(dirOf(readOnly), { mode: 0o500 }); // recursive would make the parents 0500 too
    try {
      if (permissionsApply) for (const send of [1, 2]) assert.equal(use(readOnly), false, `${name}: read-only, send ${send}`);
      assert.equal(statSync(dirOf(readOnly)).mode & 0o777, 0o500, `${name}: an existing folder keeps its mode`);
    } finally {
      chmodSync(dirOf(readOnly), 0o700);
    }
  }
});

test('cleanup removes only the store\'s own old regular files: 500 old session and temp files go, 5 foreign entries and a fresh file stay', posix, () => {
  for (const [name, dirOf, use] of STORES) {
    const env = privateEnv();
    const dir = dirOf(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 500; i++) {
      const file = join(dir, i % 2 === 0 ? `old-${i}.json` : `old-${i}.json.${i.toString(16)}.tmp`);
      writeFileSync(file, '{}');
      makeOld(file);
    }
    const victim = join(tempDir('store-outside-'), 'victim.json');
    writeFileSync(victim, 'keep');
    makeOld(victim);
    for (const foreign of ['notes.txt', 'old-x.json.bak', 'UPPER.JSON']) {
      writeFileSync(join(dir, foreign), 'keep');
      makeOld(join(dir, foreign));
    }
    mkdirSync(join(dir, 'old-folder.json'));
    makeOld(join(dir, 'old-folder.json'));
    symlinkSync(victim, join(dir, 'old-link.json'));
    lutimesSync(join(dir, 'old-link.json'), EIGHT_DAYS_AGO, EIGHT_DAYS_AGO);
    writeFileSync(join(dir, 'fresh.json'), '{}');
    assert.equal(use(env), true, name);
    const left = ['UPPER.JSON', 'fresh.json', 'notes.txt', 'old-folder.json', 'old-link.json', 'old-x.json.bak', 'sess-1.json'];
    assert.deepEqual(readdirSync(dir).sort(), left.sort(), name);
    assert.equal(readFileSync(victim, 'utf8'), 'keep', `${name}: the link's target is untouched`);
  }
});

test('readSessionFile and writeSessionFile: null before the first write, a bad id never touches a path, an oversized file is not trusted', () => {
  const dir = join(privateEnv().HOME, 'store');
  assert.equal(readSessionFile(dir, 'sess-1', 100), null, 'no folder yet');
  assert.equal(writeSessionFile(dir, 'sess-1', 'x'.repeat(50)), true);
  assert.equal(readSessionFile(dir, 'sess-1', 100), 'x'.repeat(50));
  assert.equal(readSessionFile(dir, 'sess-1', 49), undefined, 'over maxBytes');
  assert.equal(readSessionFile(dir, 'sess-2', 100), null, 'no file yet');
  for (const bad of ['../escape', 'a/b', '', 'x'.repeat(101), 42, undefined]) {
    assert.equal(writeSessionFile(dir, bad, 'x'), false, String(bad));
    assert.equal(readSessionFile(dir, bad, 100), undefined, String(bad));
  }
  assert.deepEqual(readdirSync(dirname(dir)), ['store'], 'nothing was written next to the store');
  assert.deepEqual(readdirSync(dir), ['sess-1.json'], 'no temp file is left behind');
  if (process.platform !== 'win32') assert.deepEqual([statSync(dir).mode & 0o777, statSync(join(dir, 'sess-1.json')).mode & 0o777], [0o700, 0o600]);
});

/** Runs the guard hook once with this HOME and log; returns how long it took and what it answered. */
function runHook(home, command, log = join(home, 'guard.jsonl')) {
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_GUARD_LOG: log });
  const input = JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_input: { command } });
  const started = Date.now();
  const result = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env, timeout: HOOK_TIMEOUT_MS });
  assert.equal(result.error, undefined, 'the hook returned in time');
  assert.equal(result.status, 0, result.stderr);
  return { ms: Date.now() - started, decision: result.stdout === '' ? 'allow' : JSON.parse(result.stdout).hookSpecificOutput.permissionDecision };
}

test('a FIFO at both session files or at the guard log never makes the hook wait: it answers at once', posix, () => {
  const home = privateEnv().HOME;
  for (const dirOf of [bouncedDir, allowedLiteralsDir]) {
    mkdirSync(dirOf({ HOME: home }), { recursive: true, mode: 0o700 });
    mkfifo(join(dirOf({ HOME: home }), 'sess-1.json'));
  }
  assert.equal(runHook(home, SECRET_COMMAND).decision, 'ask', 'both stores unusable: today\'s ask');
  const advice = runHook(home, ADVICE_COMMAND);
  assert.equal(advice.decision, 'allow', 'advice with an unusable store: the command runs, no deny that repeats, no owner');
  assert.ok(advice.ms < HOOK_TIMEOUT_MS / 4, `advice answered at once (${advice.ms} ms)`);
  const logHome = privateEnv().HOME;
  mkfifo(join(logHome, 'guard.jsonl'));
  assert.equal(runHook(logHome, VARIABLE_COMMAND).decision, 'deny', 'the bounce works; only the log line is skipped');
  assert.equal(runHook(logHome, VARIABLE_COMMAND).decision, 'ask');
  assert.ok(lstatSync(join(logHome, 'guard.jsonl')).isFIFO());
});

test('a link at the guard log is not followed: its target keeps its text and mode', posix, () => {
  const victim = join(tempDir('log-outside-'), 'victim.txt');
  writeFileSync(victim, 'keep', { mode: 0o644 });
  chmodSync(victim, 0o644);
  const log = join(tempDir('log-'), 'guard.jsonl');
  symlinkSync(victim, log);
  logDecision({ hook: 'h', tool: 'Bash', decision: 'ask', outcome: 'no-gui', reason: 'r', command: 'ls' }, { CLAUDE_GUARD_LOG: log });
  assert.deepEqual([readFileSync(victim, 'utf8'), statSync(victim).mode & 0o777], ['keep', 0o644]);
});
