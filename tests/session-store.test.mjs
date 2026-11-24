// Tests for lib/session-store.mjs and lib/session-lock.mjs, the guard store that uses it (guard-bounced: lib/bounce-once.mjs; the folder of the old
// guard-allowed store, lib/allowed-literals.mjs, is still planted on) and the guard log (lib/guard-log.mjs): a link, FIFO, socket, folder or file planted where a store or the log
// lives is never followed, never waited on and never cleaned up, and the guard then asks as if nothing were stored. Everything is planted
// inside a fresh temp folder made here; command strings are only passed to decide() or the hook, nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, lstatSync, lutimesSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedLiteralsDir } from '../home/hooks/lib/allowed-literals.mjs';
import { adviceOnce, bouncedDir, bounceOnce } from '../home/hooks/lib/bounce-once.mjs';
import { logDecision } from '../home/hooks/lib/guard-log.mjs';
import { withSessionLock } from '../home/hooks/lib/session-lock.mjs';
import { readSessionFile, writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const posix = { skip: process.platform === 'win32' }; // links need extra rights on Windows, and it has no FIFOs or owner ids
const PROJECT = resolve('/work/proj');
const VARIABLE_COMMAND = '$CMD --version';
const ADVICE_COMMAND = 'sed -i s/a/b/ pnpm-lock.yaml';
const SECRET_COMMAND = `KEY='${['i6IW', 'fakefilekey', '0123'].join('')}' ./fetch-figma.sh`;
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
const HOOK_TIMEOUT_MS = 20_000; // far above a normal run (about 0.2 s): reaching it means the hook hung

const tempDir = (prefix) => makeTempDir(prefix);
function privateEnv() {
  const home = tempDir('store-home-');
  return { HOME: home, USERPROFILE: home, CLAUDE_GUARD_LOG: join(home, 'guard.jsonl') };
}

// The bounce store through its public functions (the old guard-allowed store has no reader or writer left). use(env) makes one request
// and returns true when the store worked: a bounce or an advice was stored.
const STORES = [
  ['guard-bounced', bouncedDir, (env) => bounceOnce(decide(VARIABLE_COMMAND, { cwd: PROJECT }), { command: VARIABLE_COMMAND, cwd: PROJECT, input: { session_id: 'sess-1' } }, env) !== undefined],
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
    const home = makeTempDir('ss-', '/tmp'); // a unix socket path must stay short (about 100 bytes), and the launcher's TMPDIR is long
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
  // a literal secret alone runs since owner G1; next to a variable command word the bounce store is needed, and unusable it asks
  assert.equal(runHook(home, SECRET_COMMAND).decision, 'allow', 'G1: the secret alone runs, whatever the stores');
  assert.equal(runHook(home, `${SECRET_COMMAND}; $CMD --version`).decision, 'ask', 'both stores unusable: today\'s ask');
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

// Audit of 768f9aa (M1, M3): a slow holder's lock was stolen after 0.5 s and its release then deleted the next holder's lock, so
// three writers each "won"; and status.mjs's `<stem>.lock` deleted a package manager's lock file. The lock now holds `<pid> <token>`.
const LOCK_TOKEN = /^(\d+) [0-9a-f]{32}$/;
const OTHER_TOKEN = `${process.pid} ${'f'.repeat(32)}`;
function agedLock(dir, text, ageMs) {
  const lock = join(dir, 'sess-1.lock');
  writeFileSync(lock, text);
  const then = new Date(Date.now() - ageMs);
  utimesSync(lock, then, then);
  return lock;
}
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // the child has exited when spawnSync returns

test('withSessionLock holds a lock naming this process with a random token, and removes it after the turn', () => {
  const dir = tempDir('lock-');
  const seen = withSessionLock(dir, 'sess-1', () => readFileSync(join(dir, 'sess-1.lock'), 'utf8'));
  assert.equal(LOCK_TOKEN.exec(seen)?.[1], String(process.pid));
  assert.deepEqual(readdirSync(dir), []);
});

test('a release removes only its own lock: a lock that now holds another token stays', () => {
  const dir = tempDir('lock-');
  const outcome = withSessionLock(dir, 'sess-1', () => {
    writeFileSync(join(dir, 'sess-1.lock'), OTHER_TOKEN); // another caller took the lock over meanwhile
    return 'ran';
  });
  assert.equal(outcome, 'ran');
  assert.equal(readFileSync(join(dir, 'sess-1.lock'), 'utf8'), OTHER_TOKEN);
});

test('a live process\'s lock older than 0.5 s but younger than the held limit is not taken: the caller gives up, the lock stays', () => {
  const dir = tempDir('lock-');
  const lock = agedLock(dir, OTHER_TOKEN, 900);
  let ran = false;
  assert.equal(withSessionLock(dir, 'sess-1', () => { ran = true; }), undefined);
  assert.equal(ran, false);
  assert.equal(readFileSync(lock, 'utf8'), OTHER_TOKEN);
});

test('a stale lock is taken when its process is gone, its owner is unknown (empty file), or it is far older than any turn', () => {
  for (const [text, ageMs] of [[`${deadPid()} ${'a'.repeat(32)}`, 600], ['', 600], [OTHER_TOKEN, 10_000]]) {
    const dir = tempDir('lock-');
    agedLock(dir, text, ageMs);
    assert.equal(withSessionLock(dir, 'sess-1', () => 'ran'), 'ran', JSON.stringify(text));
    assert.deepEqual(readdirSync(dir), [], 'our lock is gone after the turn');
  }
});

test('lockFile names the lock instead of <session>.lock; a name with a path or no extension is refused before any work', () => {
  const dir = tempDir('lock-');
  const names = withSessionLock(dir, 'STATUS', () => readdirSync(dir), { lockFile: '.STATUS.status-lock' });
  assert.deepEqual(names, ['.STATUS.status-lock']);
  for (const lockFile of ['../x.lock', 'a/b.lock', 'plain', '..', '.lock']) {
    assert.equal(withSessionLock(dir, 'STATUS', () => 'ran', { lockFile }), undefined, lockFile);
  }
  assert.deepEqual(readdirSync(dir), []);
});

// Audit of 75af2e9 (m1): a waiter that judged a lock stale and paused right before deleting it removed the lock another waiter had
// taken meanwhile, so both ran. The other waiter's take-over is put right before this caller's first change at the lock's name.
test('a lock another waiter takes just before the stale one is removed stays, and this caller does not run over it', () => {
  const dir = tempDir('lock-');
  const lock = agedLock(dir, `${deadPid()} ${'a'.repeat(32)}`, 600);
  const { rmSync: realRm, renameSync: realRename } = fs;
  let raced = false;
  const otherWaiterTakesOver = (path) => {
    if (raced || path !== lock) return;
    raced = true;
    realRm(lock); // the other waiter removed the stale lock ...
    fs.writeFileSync(lock, OTHER_TOKEN); // ... and took a new one: a live pid, fresh
  };
  fs.rmSync = (path, ...rest) => { otherWaiterTakesOver(path); return realRm(path, ...rest); };
  fs.renameSync = (from, ...rest) => { otherWaiterTakesOver(from); return realRename(from, ...rest); };
  syncBuiltinESMExports();
  let outcome;
  try {
    outcome = withSessionLock(dir, 'sess-1', () => 'ran');
  } finally {
    Object.assign(fs, { rmSync: realRm, renameSync: realRename });
    syncBuiltinESMExports();
  }
  assert.equal(raced, true, 'the take-over happened');
  assert.equal(outcome, undefined, 'the live lock is waited on, not run over');
  assert.equal(readFileSync(lock, 'utf8'), OTHER_TOKEN);
  assert.deepEqual(readdirSync(dir), ['sess-1.lock'], 'nothing moved aside is left');
});

test('when a third caller takes the free name before the moved lock is put back, its lock stays and nothing moved aside is left', () => {
  const dir = tempDir('lock-');
  const lock = agedLock(dir, `${deadPid()} ${'a'.repeat(32)}`, 600);
  const third = `${process.pid} ${'e'.repeat(32)}`;
  const { renameSync: realRename, linkSync: realLink } = fs;
  fs.renameSync = (from, ...rest) => {
    if (from === lock && readFileSync(lock, 'utf8') !== OTHER_TOKEN) {
      fs.rmSync(lock); // a second waiter removed the stale lock and took a new one, just before this caller's rename
      fs.writeFileSync(lock, OTHER_TOKEN);
    }
    return realRename(from, ...rest);
  };
  fs.linkSync = (from, to) => {
    fs.writeFileSync(to, third); // a third caller took the free name first
    return realLink(from, to);
  };
  syncBuiltinESMExports();
  let outcome;
  try {
    outcome = withSessionLock(dir, 'sess-1', () => 'ran');
  } finally {
    Object.assign(fs, { renameSync: realRename, linkSync: realLink });
    syncBuiltinESMExports();
  }
  assert.equal(outcome, undefined, 'the third caller\'s live lock is waited on');
  assert.equal(readFileSync(lock, 'utf8'), third);
  assert.deepEqual(readdirSync(dir), ['sess-1.lock']);
});

// Audit of 2ca5bb1 (S1): taking over a stale lock by renaming it aside freed the lock's name, so with several waiters a third caller took
// it, ran inside the live holder's turn, and the put-back then failed or deleted that holder's lock. Now one waiter at a time breaks a
// stale lock, behind an O_EXCL `<lock>.break` file.
const BREAKER_NAME = 'sess-1.lock.break';
const STALE_LOCK_AGE_MS = 600; // above the 0.5 s a dead holder's lock needs to count as stale
const WAITERS = 8;
const STALE_ROUNDS = 40; // each round is its own folder with its own stale lock; the old code overlapped in about 1 round in 8
const ROUND_MS = 120; // all waiters start a round together: the whole race happens in the first few ms
const FIRST_ROUND_DELAY_MS = 600; // node start-up of the waiter processes, before round 0
const TURN_MS = 3; // a turn long enough that an overlapping caller finds the other still inside
const SESSION_LOCK_URL = new URL('../home/hooks/lib/session-lock.mjs', import.meta.url).href;
const WAITER_SCRIPT = `
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { withSessionLock } from ${JSON.stringify(SESSION_LOCK_URL)};
const [root, startAt, rounds, roundMs, turnMs] = process.argv.slice(1);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const tally = { ran: 0, overlapped: 0 };
for (let round = 0; round < Number(rounds); round++) {
  pause(Math.max(0, Number(startAt) + round * Number(roundMs) - Date.now()));
  const dir = join(root, 'round-' + round);
  const inside = join(dir, 'inside');
  withSessionLock(dir, 'sess-1', () => {
    try {
      closeSync(openSync(inside, 'wx')); // exists while a turn runs: a second turn at the same time finds it
    } catch {
      tally.overlapped++;
      return;
    }
    pause(Number(turnMs));
    unlinkSync(inside);
    tally.ran++;
  });
}
console.log(JSON.stringify(tally));
`;

function runWaiters(root) {
  const startAt = Date.now() + FIRST_ROUND_DELAY_MS;
  const args = ['--input-type=module', '-e', WAITER_SCRIPT, root, String(startAt), String(STALE_ROUNDS), String(ROUND_MS), String(TURN_MS)];
  return Promise.all(Array.from({ length: WAITERS }, () => new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? done(JSON.parse(out)) : fail(new Error(`waiter exited ${code}`))));
  })));
}

test('several waiters on one stale lock never run two turns at once', posix, async () => {
  const root = tempDir('lock-race-');
  for (let round = 0; round < STALE_ROUNDS; round++) {
    const dir = join(root, `round-${round}`);
    mkdirSync(dir, { mode: 0o700 });
    agedLock(dir, `${deadPid()} ${'a'.repeat(32)}`, STALE_LOCK_AGE_MS);
  }
  const tallies = await runWaiters(root);
  const total = (key) => tallies.reduce((sum, tally) => sum + tally[key], 0);
  assert.equal(total('overlapped'), 0, 'two turns ran at the same time');
  assert.ok(total('ran') >= STALE_ROUNDS, 'every round was taken over by someone');
});

test('a waiter that cannot create <lock>.break treats a stale lock as busy and leaves it where it is', () => {
  const dir = tempDir('lock-');
  const lock = agedLock(dir, `${deadPid()} ${'a'.repeat(32)}`, STALE_LOCK_AGE_MS);
  const breaker = join(dir, BREAKER_NAME);
  writeFileSync(breaker, OTHER_TOKEN); // another waiter is breaking this lock right now
  assert.equal(withSessionLock(dir, 'sess-1', () => 'ran'), undefined);
  assert.deepEqual(readdirSync(dir).sort(), ['sess-1.lock', BREAKER_NAME]);
  assert.equal(readFileSync(lock, 'utf8').endsWith('a'.repeat(32)), true, 'the stale lock was not touched');
});

test('a .break file left by a killed waiter is removed once it is stale, and the lock is then taken over', () => {
  const dir = tempDir('lock-');
  agedLock(dir, `${deadPid()} ${'a'.repeat(32)}`, STALE_LOCK_AGE_MS);
  const breaker = join(dir, BREAKER_NAME);
  writeFileSync(breaker, `${deadPid()} ${'b'.repeat(32)}`);
  const then = new Date(Date.now() - STALE_LOCK_AGE_MS);
  utimesSync(breaker, then, then);
  assert.equal(withSessionLock(dir, 'sess-1', () => 'ran'), 'ran');
  assert.deepEqual(readdirSync(dir), [], 'neither the lock nor the breaker file is left');
});

test('a link planted at the .break name is never followed: the store is unusable and the link target is untouched', posix, () => {
  const dir = tempDir('lock-');
  agedLock(dir, `${deadPid()} ${'a'.repeat(32)}`, STALE_LOCK_AGE_MS);
  const victim = join(tempDir('lock-outside-'), 'victim.txt');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(dir, BREAKER_NAME));
  assert.equal(withSessionLock(dir, 'sess-1', () => 'ran'), undefined);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
});
