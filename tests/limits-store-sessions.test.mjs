// Tests for home/hooks/lib/limits-store.mjs when many sessions on one account write the limits (fixes-spec X12): a sample
// behind the newest is dropped (per window), each sample names its session, the log is appended, capped and trimmed and never
// written through a link, the account lock is tried once and never waited for, the status line passes its session id, and the
// token view reads the log within the same cap (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_KEEP_MS, MAX_LOG_BYTES, readLimits, recordSample } from '../home/hooks/lib/limits-store.mjs';
import { readLimitLogs } from '../home/tools/token-view/lib/limits.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const STORE_URL = new URL('../home/hooks/lib/limits-store.mjs', import.meta.url).href;
const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));
const ACCOUNT = 'acct';
const T0 = Date.UTC(2026, 10, 23, 10, 0, 0);
const RESETS = 1795429800;
const DAY_MS = 24 * 60 * 60 * 1000;
const APPENDS_PER_SESSION = 200;
const MAX_TRIES_PER_SAMPLE = 100000; // a child that cannot store one sample in this many tries is stuck: it exits 2
const WRITERS = 8;
const WRITE_MS = 1000; // how long the 8 writers store at once; without the lock they stepped back 2166 times in 3 s
const START_DELAY_MS = 500; // room for 8 node starts, so the writers overlap
const STALE_AGE_MS = 1000; // past session-lock's 0.5 s after which a lock of a gone pid is taken over
const LIVE_OLD_AGE_MS = 2000; // past those 0.5 s, below its 5 s for any lock: a lock its live holder must keep
const LOCK_TEXT = 'b'.repeat(32);
const NO_LINK_SKIP = { skip: process.platform === 'win32' ? 'no plain links on Windows' : false };

const win = (used, resets = RESETS) => ({ used_percentage: used, resets_at: resets });
const logPath = (dir) => join(dir, `${ACCOUNT}.jsonl`);
const lockPath = (dir) => join(dir, `${ACCOUNT}.lock`);
const logLines = (dir) => readFileSync(logPath(dir), 'utf8').split('\n').filter(Boolean);
const storedFive = (dir) => readLimits(ACCOUNT, { dir }).samples.map((s) => s.five_hour?.used_percentage ?? null);
const record = (dir, session, limits, t) => recordSample(ACCOUNT, limits, { dir, now: t, session });
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid; // exited: the pid is free
const renderStatusLine = (home, input) => spawnSync(process.execPath, [STATUSLINE], {
  input: JSON.stringify(input), env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', CLAUDE_ACCOUNT: ACCOUNT }, encoding: 'utf8',
});

/** Puts a lock at the account's lock name as session-lock writes it (`<pid> <token>`), dated ageMs ago. */
function holdLock(dir, pid, ageMs = 0) {
  writeFileSync(lockPath(dir), `${pid} ${LOCK_TEXT}`, { mode: 0o600 });
  const at = new Date(Date.now() - ageMs);
  utimesSync(lockPath(dir), at, at);
}

/** Runs an ES module text in a child node with args; resolves to its stdout, rejects on a non-zero exit. */
function runModule(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(out) : reject(new Error(`child exit ${status}`))));
  });
}

test('two sessions alternating 43% and 63% of one 5h window store only the rises, each with its session', () => {
  const dir = makeTempDir('limits-sawtooth-');
  const seven = win(50, RESETS + DAY_MS);
  const sent = [['a', 43, true], ['b', 63, true], ['a', 43, false], ['b', 63, false], ['a', 44, false], ['b', 64, true], ['a', 44, false]];
  sent.forEach(([session, used, stored], i) => {
    assert.equal(record(dir, `session-${session}`, { five_hour: win(used), seven_day: seven }, T0 + i * 1000), stored, `${session} ${used}`);
  });
  assert.deepEqual(storedFive(dir), [43, 63, 64]);
  assert.deepEqual(readLimits(ACCOUNT, { dir }).samples.map((s) => s.session), ['session-a', 'session-b', 'session-b']);
  assert.deepEqual(logLines(dir).map((line) => JSON.parse(line).five_hour.used_percentage), [43, 63, 64]);
});

test('a new window (later resets_at) with a lower percentage is stored; an older resets_at is dropped', () => {
  const dir = makeTempDir('limits-window-');
  assert.equal(record(dir, 's1', { five_hour: win(90) }, T0), true);
  assert.equal(record(dir, 's2', { five_hour: win(3, RESETS + 18000) }, T0 + 1000), true);
  assert.equal(record(dir, 's1', { five_hour: win(95) }, T0 + 2000), false);
  assert.deepEqual(storedFive(dir), [90, 3]);
});

test('a window the input lacks is no news: it neither stores a sample nor clears the stored value', () => {
  const dir = makeTempDir('limits-null-');
  const seven = win(71, RESETS + DAY_MS);
  assert.equal(record(dir, 's1', { five_hour: win(10), seven_day: seven }, T0), true);
  assert.equal(record(dir, 's2', { five_hour: null, seven_day: seven }, T0 + 1000), false);
  assert.equal(record(dir, 's2', { seven_day: win(72, RESETS + DAY_MS) }, T0 + 2000), true);
  assert.deepEqual(storedFive(dir), [10, null]);
});

test('each window is compared with the newest stored sample that has it: a stale 43% after a sample without 5h is dropped', () => {
  const dir = makeTempDir('limits-per-window-');
  assert.equal(record(dir, 'b', { five_hour: win(63), seven_day: win(71, RESETS + DAY_MS) }, T0), true);
  assert.equal(record(dir, 'c', { seven_day: win(72, RESETS + DAY_MS) }, T0 + 1000), true);
  assert.equal(record(dir, 'a', { five_hour: win(43), seven_day: win(72, RESETS + DAY_MS) }, T0 + 2000), false);
  assert.deepEqual(storedFive(dir), [63, null]);
});

test('old samples without a session field still read, and a new one is stored after them', () => {
  const dir = makeTempDir('limits-old-');
  const old = { t: T0, five_hour: win(20), seven_day: null };
  writeFileSync(join(dir, `${ACCOUNT}.json`), JSON.stringify({ account: ACCOUNT, samples: [old] }), { mode: 0o600 });
  writeFileSync(logPath(dir), `${JSON.stringify(old)}\n`, { mode: 0o600 });
  assert.deepEqual(readLimits(ACCOUNT, { dir }).samples, [old]);
  assert.equal(record(dir, 's1', { five_hour: win(21) }, T0 + 1000), true);
  assert.deepEqual(storedFive(dir), [20, 21]);
  assert.deepEqual(logLines(dir).map((line) => JSON.parse(line).session ?? null), [null, 's1']);
});

test('two sessions writing at once lose no line and tear none: 2 x 200 appends make 400 whole lines', async () => {
  const dir = makeTempDir('limits-parallel-');
  // Each session moves its own window to a later reset each time, so every one of its samples is news whatever the other wrote;
  // a sample dropped because the other session held the lock (false) is sent again, as that session's next render would.
  const code = `import { recordSample } from ${JSON.stringify(STORE_URL)};
    const [dir, session, name] = process.argv.slice(1);
    let stored = 0;
    for (let i = 1; i <= ${APPENDS_PER_SESSION}; i += 1) {
      const send = () => recordSample('${ACCOUNT}', { [name]: { used_percentage: 1, resets_at: i } }, { dir, now: ${T0} + i, session });
      let tries = 1;
      while (!send()) if (++tries > ${MAX_TRIES_PER_SAMPLE}) process.exit(2);
      stored += 1;
    }
    process.stdout.write(String(stored));`;
  const counts = await Promise.all([runModule(code, [dir, 'sess-a', 'five_hour']), runModule(code, [dir, 'sess-b', 'seven_day'])]);
  assert.deepEqual(counts, [String(APPENDS_PER_SESSION), String(APPENDS_PER_SESSION)]);
  const samples = logLines(dir).map((line) => JSON.parse(line));
  assert.equal(samples.length, 2 * APPENDS_PER_SESSION);
  assert.equal(samples.filter((s) => s.session === 'sess-a').length, APPENDS_PER_SESSION);
  assert.equal(readLimits(ACCOUNT, { dir }).samples.length, 12);
});

test('at the byte cap the oldest half of the log is dropped and writing goes on; the log never passes the cap', () => {
  const dir = makeTempDir('limits-cap-');
  // Short filler lines up to 30 bytes below the cap, so the next sample line (about 100 bytes) would pass it.
  const lines = [];
  for (let i = 0, size = 0; ; i += 1) {
    const line = `${JSON.stringify({ t: T0 + i })}\n`;
    if (size + line.length > MAX_LOG_BYTES - 30) break;
    lines.push(line);
    size += line.length;
  }
  writeFileSync(logPath(dir), lines.join(''), { mode: 0o600 });
  const firstOld = JSON.parse(lines[0]).t;
  assert.equal(record(dir, 's1', { five_hour: win(5) }, T0 + DAY_MS), true);
  assert.ok(statSync(logPath(dir)).size <= MAX_LOG_BYTES / 2 + 1024, 'the first line over the cap rewrote the log');
  assert.equal(record(dir, 's1', { five_hour: win(6) }, T0 + DAY_MS + 1), true);
  const size = statSync(logPath(dir)).size;
  assert.ok(size <= MAX_LOG_BYTES / 2 + 1024, `size ${size}`);
  const samples = logLines(dir).map((entry) => JSON.parse(entry));
  assert.ok(samples[0].t > firstOld, 'the oldest lines went');
  assert.deepEqual(samples.slice(-2).map((s) => s.five_hour.used_percentage), [5, 6]);
});

test('a log whose first line is past 7 days and a day is rewritten without the old lines; a younger one is only appended', () => {
  const dir = makeTempDir('limits-age-');
  const now = T0 + 10 * DAY_MS;
  const lineAt = (t) => `${JSON.stringify({ t, five_hour: win(1, t), seven_day: null })}\n`;
  writeFileSync(logPath(dir), lineAt(now - LOG_KEEP_MS - DAY_MS / 2) + lineAt(now - DAY_MS), { mode: 0o600 });
  assert.equal(record(dir, 's1', { five_hour: win(2) }, now), true);
  assert.equal(logLines(dir).length, 3, 'half a day past the 7 days: appended, no rewrite');
  writeFileSync(logPath(dir), lineAt(now - LOG_KEEP_MS - 2 * DAY_MS) + lineAt(now - DAY_MS), { mode: 0o600 });
  assert.equal(record(dir, 's1', { five_hour: win(3) }, now + 1), true);
  assert.deepEqual(logLines(dir).map((entry) => JSON.parse(entry).t), [now - DAY_MS, now + 1]);
});

test('a torn last line stays apart: the next sample is a whole line of its own', () => {
  const dir = makeTempDir('limits-torn-');
  writeFileSync(logPath(dir), `${JSON.stringify({ t: T0, five_hour: win(1), seven_day: null })}\n{"t":${T0 + 1},"five_ho`, { mode: 0o600 });
  assert.equal(record(dir, 's1', { five_hour: win(2) }, T0 + 2), true);
  const lines = logLines(dir);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).five_hour.used_percentage, 2);
});

test('a link at the log is not followed: nothing is written through it', { skip: process.platform === 'win32' ? 'no plain symlinks on Windows' : false }, () => {
  const dir = makeTempDir('limits-link-');
  const target = join(makeTempDir('limits-link-target-'), 'elsewhere.jsonl');
  writeFileSync(target, 'theirs\n');
  symlinkSync(target, logPath(dir));
  assert.equal(record(dir, 's1', { five_hour: win(2) }, T0), false);
  assert.equal(readFileSync(target, 'utf8'), 'theirs\n');
});

test('a hard link at the log is never written through: the append refuses it and a rewrite leaves the linked file as it was', NO_LINK_SKIP, () => {
  const dir = makeTempDir('limits-hardlink-');
  const victim = join(makeTempDir('limits-hardlink-victim-'), 'victim.txt');
  writeFileSync(victim, '', { mode: 0o600 });
  linkSync(victim, logPath(dir));
  assert.equal(record(dir, 's1', { five_hour: win(5) }, T0), false);
  assert.equal(readFileSync(victim, 'utf8'), '');
  const old = `${JSON.stringify({ t: T0 - LOG_KEEP_MS - 2 * DAY_MS, five_hour: win(1), seven_day: null })}\n`;
  writeFileSync(victim, old); // a first line past the 7 days and a day: the next sample rewrites the log
  assert.equal(record(dir, 's1', { five_hour: win(6) }, T0 + 1), true);
  assert.equal(readFileSync(victim, 'utf8'), old);
  assert.equal(statSync(logPath(dir)).nlink, 1, 'the rewrite put a file of its own at the name');
});

test('a lock left by a killed holder never stops the samples: while fresh the sample is dropped, once stale it is cleared', () => {
  const dir = makeTempDir('limits-killed-');
  holdLock(dir, deadPid());
  // Tried once: the old render waited until this lock was 0.5 s old, took it and stored the sample.
  assert.equal(record(dir, 's1', { five_hour: win(5) }, T0), false);
  assert.equal(readLimits(ACCOUNT, { dir }), null);
  holdLock(dir, deadPid(), STALE_AGE_MS);
  const renders = [T0 + 5000, T0 + 10000].map((t) => record(dir, 's1', { five_hour: win(5) }, t));
  assert.ok(renders.includes(true), `renders ${renders}`);
  assert.equal(existsSync(lockPath(dir)), false);
  assert.deepEqual(storedFive(dir), [5]);
});

test('a lock whose holder still runs is never taken, also past the 0.5 s of a killed holder', () => {
  const dir = makeTempDir('limits-live-');
  holdLock(dir, process.pid, LIVE_OLD_AGE_MS);
  assert.equal(record(dir, 's1', { five_hour: win(5) }, T0), false);
  assert.equal(readFileSync(lockPath(dir), 'utf8'), `${process.pid} ${LOCK_TEXT}`);
  assert.equal(readLimits(ACCOUNT, { dir }), null);
});

test('8 sessions storing at once: under the lock the log never steps back and the file holds its last 12 lines', async () => {
  const dir = makeTempDir('limits-lock-');
  // Every writer's sample is news against what it read first (a later reset each time), so only the lock orders them.
  const code = `import { recordSample } from ${JSON.stringify(STORE_URL)};
    const [dir, id, start] = process.argv.slice(1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, Number(start) - Date.now()));
    for (const end = Number(start) + ${WRITE_MS}; Date.now() < end;) {
      const t = Date.now();
      recordSample('${ACCOUNT}', { five_hour: { used_percentage: 1, resets_at: t * 1000 + Number(id) } }, { dir, now: t, session: 'w' + id });
    }`;
  const start = String(Date.now() + START_DELAY_MS);
  await Promise.all(Array.from({ length: WRITERS }, (_, id) => runModule(code, [dir, String(id), start])));
  const lines = logLines(dir).map((line) => JSON.parse(line));
  const resets = lines.map((s) => s.five_hour.resets_at);
  assert.ok(lines.length > 12, `${lines.length} lines`);
  assert.equal(resets.filter((value, i) => i > 0 && value < resets[i - 1]).length, 0, 'steps back in the log');
  const key = (s) => `${s.t}:${s.session}`;
  assert.deepEqual(readLimits(ACCOUNT, { dir }).samples.map(key), lines.slice(-12).map(key));
});

test('the token view reads a log only within MAX_LOG_BYTES and never through a link', NO_LINK_SKIP, () => {
  const dir = makeTempDir('limits-reader-');
  const lineAt = (t) => `${JSON.stringify({ t, five_hour: win(1), seven_day: null })}\n`;
  let big = '';
  for (let t = T0; Buffer.byteLength(big) <= MAX_LOG_BYTES; t += 1) big += lineAt(t);
  writeFileSync(join(dir, 'big.jsonl'), big, { mode: 0o600 });
  writeFileSync(join(dir, 'small.jsonl'), lineAt(T0) + lineAt(T0 + 1), { mode: 0o600 });
  const elsewhere = join(makeTempDir('limits-reader-target-'), 'elsewhere.jsonl');
  writeFileSync(elsewhere, lineAt(T0), { mode: 0o600 });
  symlinkSync(elsewhere, join(dir, 'link.jsonl'));
  const counts = Object.fromEntries(readLimitLogs(dir, 0).map((log) => [log.account, log.samples.length]));
  assert.deepEqual(counts, { big: 0, link: 0, small: 2 });
});

test('the status line stores its session id with the sample', () => {
  const home = makeTempDir('limits-statusline-');
  const result = renderStatusLine(home, { session_id: 'sess-line', model: { display_name: 'Opus 5.5' }, rate_limits: { five_hour: win(12) } });
  assert.equal(result.status, 0);
  const dir = join(home, '.claude', 'state', 'limits');
  assert.ok(existsSync(logPath(dir)));
  assert.deepEqual(readLimits(ACCOUNT, { dir }).samples.map((s) => s.session), ['sess-line']);
});

test('the status line render never waits on the account lock: a held lock drops the sample and the render goes on', () => {
  const home = makeTempDir('limits-render-');
  const dir = join(home, '.claude', 'state', 'limits');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  holdLock(dir, deadPid()); // fresh: the old render waited the 0.5 s until it was stale, then stored
  const result = renderStatusLine(home, { session_id: 'sess-x', model: { display_name: 'M' }, rate_limits: { five_hour: win(12) } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /5h/);
  assert.equal(readLimits(ACCOUNT, { dir }), null);
  assert.ok(existsSync(lockPath(dir)), 'the lock is left to its 0.5 s');
});
