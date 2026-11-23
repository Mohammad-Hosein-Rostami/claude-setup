// Tests for home/tools/estimate/lib/limits-store.mjs when many sessions on one account write the limits (fixes-spec X12): a sample
// behind the newest is dropped, each sample names its session, the log is appended, capped and trimmed, and the status line passes
// its session id (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_KEEP_MS, MAX_LOG_BYTES, readLimits, recordSample } from '../home/tools/estimate/lib/limits-store.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const STORE_URL = new URL('../home/tools/estimate/lib/limits-store.mjs', import.meta.url).href;
const STATUSLINE = fileURLToPath(new URL('../home/statusline.mjs', import.meta.url));
const ACCOUNT = 'acct';
const T0 = Date.UTC(2026, 10, 23, 10, 0, 0);
const RESETS = 1795429800;
const DAY_MS = 24 * 60 * 60 * 1000;
const APPENDS_PER_SESSION = 200;

const win = (used, resets = RESETS) => ({ used_percentage: used, resets_at: resets });
const logPath = (dir) => join(dir, `${ACCOUNT}.jsonl`);
const logLines = (dir) => readFileSync(logPath(dir), 'utf8').split('\n').filter(Boolean);
const storedFive = (dir) => readLimits(ACCOUNT, { dir }).samples.map((s) => s.five_hour.used_percentage);
const record = (dir, session, limits, t) => recordSample(ACCOUNT, limits, { dir, now: t, session });

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
  assert.deepEqual(readLimits(ACCOUNT, { dir }).samples.map((s) => s.five_hour?.used_percentage ?? null), [10, null]);
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
  // Each session moves its own window to a later reset each time, so every one of its samples is news whatever the other wrote.
  const code = `import { recordSample } from ${JSON.stringify(STORE_URL)};
    const [dir, session, name] = process.argv.slice(1);
    let stored = 0;
    for (let i = 1; i <= ${APPENDS_PER_SESSION}; i += 1) {
      if (recordSample('${ACCOUNT}', { [name]: { used_percentage: 1, resets_at: i } }, { dir, now: ${T0} + i, session })) stored += 1;
    }
    process.stdout.write(String(stored));`;
  const run = (session, name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir, session, name], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve(out) : reject(new Error(`child exit ${status}`))));
  });
  const counts = await Promise.all([run('sess-a', 'five_hour'), run('sess-b', 'seven_day')]);
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

test('the status line stores its session id with the sample', () => {
  const home = makeTempDir('limits-statusline-');
  const input = JSON.stringify({ session_id: 'sess-line', model: { display_name: 'Opus 5.5' }, rate_limits: { five_hour: win(12) } });
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', CLAUDE_ACCOUNT: ACCOUNT };
  const result = spawnSync(process.execPath, [STATUSLINE], { input, env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const dir = join(home, '.claude', 'state', 'limits');
  assert.ok(existsSync(logPath(dir)));
  assert.deepEqual(readLimits(ACCOUNT, { dir }).samples.map((s) => s.session), ['sess-line']);
});
