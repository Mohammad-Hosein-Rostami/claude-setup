// Tests for the estimate's calibration (L30 stage 3): scoring logged estimates against deliveries, the range factors, the
// Track record line (lib/calibration.mjs, lib/report.mjs), the log store (lib/estimate-log.mjs) and the CLI and status line
// cache around them. Clocks are injected (`--now`, epoch ms); HOME points at a temp folder so no real log is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { writeSessionFile } from '../home/hooks/lib/session-store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { applyFactors, calibrationFactors, scoreEntries, trackRecord } from '../home/tools/estimate/lib/calibration.mjs';
import { readLog, writeLog } from '../home/tools/estimate/lib/estimate-log.mjs';
import { estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { finishClock, formatEstimate } from '../home/tools/estimate/lib/report.mjs';
import { readEntry } from '../home/tools/estimate/lib/segment-cache.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const CLI = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const REFRESH_SCRIPT = fileURLToPath(new URL('../home/tools/estimate/statusline-cache.mjs', import.meta.url));
const at = (hours) => BASE_MS + hours * HOUR_MS;
const isoAt = (hours) => new Date(at(hours)).toISOString().replace(/\.000Z$/, 'Z');
const itemsOf = (rows) => parseWorkItems(statusDoc(rows)).items;
const SECRET = 'PRIVATE-ITEM-TEXT-7f3a';
const STATUS = '/project/STATUS.md';
/** A logged estimate made at 13.5 h with O1 open, raw 1-2 h, printed 14:45-16:00 (UTC). */
const entry = (fields = {}) => ({ v: 1, at: isoAt(13.5), status: STATUS, open: ['O1'], points: 1, closing: 'default', raw: [1, 2], printed: [isoAt(14.75), isoAt(16)], ...fields });
const scored = (ratio, fields = {}) => entry({ actual: isoAt(15.5), inside: true, ratio, ...fields });
/** fiveDone, O1 done at 14 h, then a close row done at 15.5 h: a delivery at 15.5 h. */
const DELIVERED_ROWS = fiveDoneRows([row({ id: 'O1', startedH: 13, doneH: 14 }), row({ id: 'C1', item: 'close: row', startedH: 14, doneH: 15.5 })]);
const UTC_INPUTS = { transcriptDir: '/t', transcriptCount: 1, timeZone: 'UTC' };

test('scoreEntries scores an entry at the first delivery after it with its open ids done: actual, inside, ratio of the raw range', () => {
  const [result] = scoreEntries([entry()], itemsOf(DELIVERED_ROWS), at(20));
  assert.deepEqual({ actual: result.actual, inside: result.inside, ratio: result.ratio }, { actual: isoAt(15.5), inside: true, ratio: [2, 1] }); // 2 h after
  const [late] = scoreEntries([entry({ printed: [isoAt(14), isoAt(15)] })], itemsOf(DELIVERED_ROWS), at(20));
  assert.equal(late.inside, false);
  const [zero] = scoreEntries([entry({ raw: [0, 4] })], itemsOf(DELIVERED_ROWS), at(20));
  assert.deepEqual(zero.ratio, [null, 0.5]);
});

test('scoreEntries leaves an entry unscored before its delivery, drops ids gone from the table, voids an entry whose ids are all gone', () => {
  const open = fiveDoneRows([row({ id: 'O1', startedH: 13, doneH: 14 }), row({ id: 'C1', item: 'close: row', startedH: 14 })]);
  assert.deepEqual(scoreEntries([entry()], itemsOf(open), at(15)), [entry()]);
  const [dropped] = scoreEntries([entry({ open: ['O1', 'GONE'] })], itemsOf(DELIVERED_ROWS), at(20));
  assert.equal(dropped.actual, isoAt(15.5));
  const [gone] = scoreEntries([entry({ open: ['GONE'] })], itemsOf(DELIVERED_ROWS), at(20));
  assert.equal(gone.actual, 'void');
  const already = scored([1, 1], { actual: isoAt(14) });
  assert.equal(scoreEntries([already], itemsOf(DELIVERED_ROWS), at(20))[0], already);
});

test('calibrationFactors: below 5 scored entries the range is not adjusted; from 5 it is', () => {
  const four = Array.from({ length: 4 }, () => scored([0.5, 2]));
  assert.deepEqual(calibrationFactors(four), { low: 1, high: 1, scored: 4 });
  assert.deepEqual(calibrationFactors([...four, scored([0.5, 2]), entry(), entry({ actual: 'void' })]), { low: 0.5, high: 2, scored: 5 });
});

test('calibrationFactors: high = max(1, p90 of ratio high), low = min(1, p10 of ratio low), nearest rank over the last 10 scored', () => {
  const highs = [0.5, 0.8, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2];
  const lows = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5];
  const old = [scored([0.1, 9]), scored([0.1, 9])]; // outside the window of the last 10
  const entries = [...old, ...highs.map((high, i) => scored([lows[i], high]))];
  assert.deepEqual(calibrationFactors(entries), { low: 0.6, high: 1.6, scored: 12 }); // ranks ceil(1) = 1st and ceil(9) = 9th
  const early = Array.from({ length: 5 }, () => scored([1.5, 0.5]));
  assert.deepEqual(calibrationFactors(early), { low: 1, high: 1, scored: 5 }); // never narrows the range
  assert.deepEqual(calibrationFactors(Array.from({ length: 5 }, () => scored([null, 2]))), { low: 1, high: 2, scored: 5 });
});

test('applyFactors scales the raw range from now; trackRecord counts inside, late (median of actual / printed time) and early', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1' })])), [], at(20)); // raw 2.4-5.5 h
  const scaled = applyFactors(result, { low: 0.5, high: 2, scored: 5 });
  assert.deepEqual(scaled.finish, { lowMs: at(21.2), highMs: at(31) });
  assert.deepEqual(scaled.raw, result.raw);
  const record = trackRecord([
    scored([1, 1]),
    scored([1, 1], { actual: isoAt(17), inside: false }), // printed time 13.5..16 h = 2.5 h, took 3.5 h: x1.4
    scored([1, 1], { actual: isoAt(18.5), inside: false }), // took 5 h: x2
    scored([1, 1], { actual: isoAt(14.5), inside: false }), // before the printed low end
    entry(), entry({ actual: 'void' }),
  ]);
  assert.deepEqual(record, { scored: 4, inside: 1, late: 2, early: 1, medianLate: 1.4 });
});

test('the Track record line: none yet, below 5 scored, and adjusted from 5', () => {
  const result = computeEstimate(itemsOf(fiveDoneRows([row({ id: 'O1' })])), [], at(20));
  const lineOf = (record, factors) => formatEstimate(result, { ...UTC_INPUTS, calibration: { record, factors } }).split('\n')[4];
  assert.equal(lineOf({ scored: 0, inside: 0, late: 0, early: 0, medianLate: null }, { low: 1, high: 1, scored: 0 }),
    'Track record: no scored estimate yet; the range is adjusted once 5 are scored (target: 8 of 10 inside)');
  assert.equal(lineOf({ scored: 3, inside: 2, late: 1, early: 0, medianLate: 1.24 }, { low: 1, high: 1, scored: 3 }),
    'Track record: 2 of 3 inside, 1 late (median x1.2 of the printed time), 0 early; adjusted once 5 are scored');
  assert.equal(lineOf({ scored: 13, inside: 9, late: 3, early: 1, medianLate: 1.4 }, { low: 0.9, high: 1.3, scored: 13 }),
    'Track record: 9 of 13 inside, 3 late (median x1.4 of the printed time), 1 early; adjusted high x1.3, low x0.9 (target 8 of 10)');
  assert.equal(formatEstimate(result, UTC_INPUTS).split('\n')[4].startsWith('Assumes:'), true); // no calibration given: no line
});

test('the log store keeps valid entries of this STATUS.md only, the last 200, in a 0600 file', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'estimate-log-')), 'log');
  assert.deepEqual(readLog(STATUS, dir), []);
  const many = Array.from({ length: 205 }, (_, i) => entry({ points: i }));
  assert.equal(writeLog(STATUS, many, dir), true);
  const back = readLog(STATUS, dir);
  assert.deepEqual(back.map((e) => e.points), many.slice(-200).map((e) => e.points));
  const [file] = await readdir(dir);
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
  await writeFile(join(dir, file), `${JSON.stringify(entry())}\nnot json\n${JSON.stringify(entry({ status: '/other/STATUS.md' }))}\n${JSON.stringify({ v: 1 })}\n`);
  assert.deepEqual(readLog(STATUS, dir), [entry()]);
});

// ---- The CLI and the status line cache around the log ----

const runCli = (args, home, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, TZ: 'UTC', ...extraEnv } });
const secretRows = (rows) => rows.map((text) => text.replace(/\| item (\w+) \|/, `| ${SECRET} $1 |`).replace(/\| close: row \|/, `| close: ${SECRET} |`));

async function project(rows) {
  const root = await mkdtemp(join(tmpdir(), 'estimate-cal-'));
  const status = join(root, 'STATUS.md');
  await writeFile(status, statusDoc(secretRows(rows)));
  return { root, status, home: join(root, 'home'), logDir: join(root, 'log') };
}

const logLines = async (dir) => {
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  return (await readFile(join(dir, files[0]), 'utf8')).trim().split('\n');
};

test('CLI: a --now run without --log-dir writes no log; with --log-dir it appends one line of ids and numbers, never item text', async () => {
  const { root, status, home, logDir } = await project(fiveDoneRows([row({ id: 'O1', startedH: 13 })]));
  const plain = runCli([status, '--transcripts', root, '--now', isoAt(13.5)], home);
  assert.equal(plain.status, 0, plain.stderr);
  await assert.rejects(stat(join(home, '.claude', 'state', 'estimate-log')));
  assert.doesNotMatch(plain.stdout, /Track record/);
  const logged = runCli([status, '--transcripts', root, '--now', isoAt(13.5), '--log-dir', logDir], home);
  assert.equal(logged.status, 0, logged.stderr);
  const [line] = await logLines(logDir);
  assert.deepEqual(JSON.parse(line), { v: 1, at: isoAt(13.5), status, open: ['O1'], points: 1, closing: 'default', raw: [1.9, 5], printed: ['2026-11-10T15:20Z', '2026-11-10T18:30Z'] }); // O1's 0.5 h/point so far is below every done rate: band 1-3
  assert.ok(!line.includes(SECRET));
  assert.match(logged.stdout, /^Track record: no scored estimate yet;/m);
});

test('CLI: a later run scores the logged estimate at the delivery and prints the track record; a refusal writes nothing', async () => {
  const { root, status, home, logDir } = await project(fiveDoneRows([row({ id: 'O1', startedH: 13 })]));
  assert.equal(runCli([status, '--transcripts', root, '--now', isoAt(13.5), '--log-dir', logDir], home).status, 0);
  await writeFile(status, statusDoc(secretRows([...DELIVERED_ROWS, row({ id: 'O2' })])));
  const later = runCli([status, '--transcripts', root, '--now', isoAt(20), '--log-dir', logDir], home);
  assert.equal(later.status, 0, later.stderr);
  assert.match(later.stdout, /^Track record: 1 of 1 inside, 0 late, 0 early; adjusted once 5 are scored$/m);
  const lines = await logLines(logDir);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).actual, isoAt(15.5));
  const refused = await project([row({ id: 'D1', startedH: 0, doneH: 1 }), row({ id: 'O1' })]);
  const run = runCli([refused.status, '--transcripts', refused.root, '--now', isoAt(13.5), '--log-dir', refused.logDir], refused.home);
  assert.equal(run.status, 3);
  await assert.rejects(stat(refused.logDir));
});

test('CLI: two runs racing on one log leave a whole file of valid lines', async () => {
  const { root, status, home, logDir } = await project(fiveDoneRows([row({ id: 'O1', startedH: 13 })]));
  const runAsync = () => new Promise((done) => {
    const child = spawn(process.execPath, [CLI, status, '--transcripts', root, '--now', isoAt(13.5), '--log-dir', logDir], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'ignore' });
    child.on('close', done);
  });
  for (let round = 0; round < 5; round += 1) assert.deepEqual(await Promise.all([runAsync(), runAsync()]), [0, 0]);
  const lines = await logLines(logDir);
  assert.ok(lines.length >= 5 && lines.length <= 10, `${lines.length} lines`); // a race may lose a line, never the file
  for (const line of lines) assert.equal(JSON.parse(line).status, status);
});

test('the status line cache applies the log\'s factors and never writes the log', async () => {
  const { root, status, home } = await project(fiveDoneRows([row({ id: 'O1', size: 'L' })]));
  const projectDir = join(root);
  const logDir = join(home, '.claude', 'state', 'estimate-log');
  await mkdir(logDir, { recursive: true });
  const fiveScored = Array.from({ length: 5 }, () => scored([0.5, 2], { status }));
  assert.equal(writeLog(status, fiveScored, logDir), true);
  const [logFile] = await readdir(logDir);
  const before = await stat(join(logDir, logFile));
  const startedAt = Date.now();
  const run = spawnSync(process.execPath, [REFRESH_SCRIPT, status], { cwd: projectDir, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  const endedAt = Date.now();
  assert.equal(run.status, 0, run.stderr);
  const text = readEntry(join(home, '.claude', 'state', 'estimate-segment'), status).text;
  const expected = [startedAt, endedAt].map((now) => {
    const { result } = estimateFile(status, { cwd: projectDir, transcripts: root, now: new Date(now).toISOString() });
    return `done ~${finishClock(applyFactors(result, { low: 0.5, high: 2, scored: 5 }))}`;
  });
  assert.ok(expected.includes(text), `${text} not in ${expected}`);
  const after = await stat(join(logDir, logFile));
  assert.deepEqual([after.mtimeMs, after.size], [before.mtimeMs, before.size]);
});

test('a log untouched for 30 days is still read and scored, and a write to the log folder does not sweep it', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'estimate-log-age-')), 'log');
  assert.equal(writeLog(STATUS, [entry()], dir), true);
  const [file] = await readdir(dir);
  const monthAgo = new Date(Date.now() - 30 * 24 * HOUR_MS);
  await utimes(join(dir, file), monthAgo, monthAgo);
  assert.equal(writeLog('/other/STATUS.md', [entry({ status: '/other/STATUS.md' })], dir), true); // a write in the same folder
  assert.ok((await readdir(dir)).includes(file), 'the 30-day-old log is kept');
  const [scoredEntry] = scoreEntries(readLog(STATUS, dir), itemsOf(DELIVERED_ROWS), at(20));
  assert.equal(scoredEntry.actual, isoAt(15.5));
});

test('the other state stores still sweep their own files older than 7 days', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'state-sweep-')), 'store');
  assert.equal(writeSessionFile(dir, 'old-session', '{}'), true);
  const monthAgo = new Date(Date.now() - 30 * 24 * HOUR_MS);
  await utimes(join(dir, 'old-session.json'), monthAgo, monthAgo);
  assert.equal(writeSessionFile(dir, 'new-session', '{}'), true);
  assert.deepEqual(await readdir(dir), ['new-session.json']);
});
