// Tests for the forms of the status line's estimate segment (lib/segment-text.mjs, written by statusline-cache.mjs, read by
// lib/segment-cache.mjs), estimator design 4.3: `done by 21:40`, `all rows done`, `handed over 17:54`, `work left ~99 h`, and
// `done ? <cause>` after a refusal or an error, so the segment never silently disappears. In the render tests the clock and the
// spawner are injected; the refresh script runs for real with HOME in a temp folder. Zone Asia/Tehran (+03:30).
// Then the job and now rows model s1's entries draw from `numbers.v2` (board/lib/range-rows.mjs, estimate-spec section 7): the
// Desap table at 09:50 local at COLUMNS 80, 100 and 150, and the lane's F questions: F1 every row fits without cutting a number,
// F2 an entry without v2 (or a malformed one) draws the R18 rows, F3 the time colour on both palettes and none under NO_COLOR,
// F4 the promise part is the last part dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookOf } from '../home/tools/board/lib/cells.mjs';
import { LATE_MIN as SHOWN_LATE_MIN } from '../home/tools/board/lib/range-rows.mjs';
import { jobRow, nowRow } from '../home/tools/board/lib/work-row.mjs';
import { LATE_MIN } from '../home/tools/estimate/lib/job-rows.mjs';
import { UsageError } from '../home/tools/estimate/lib/from-files.mjs';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { OVERDUE_TEXT, STALE_SHOW_MS, estimateSegment, readEntry, writeEntry } from '../home/tools/estimate/lib/segment-cache.mjs';
import { MAX_SEGMENT_CHARS, errorSegment, resultSegment } from '../home/tools/estimate/lib/segment-text.mjs';
import { HOUR_MS, iso, row, statusDoc } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const REFRESH_SCRIPT = fileURLToPath(new URL('../home/tools/estimate/statusline-cache.mjs', import.meta.url));
const TZ = 'Asia/Tehran';
const at = (hour, minute, day = 16) => Date.UTC(2026, 10, day, hour, minute);
const NOW = at(15, 35); // Mon 19:05 local
const finishAt = (clockMs) => ({ state: 'finish', nowMs: NOW, finish: { clockMs } });
const refused = (refusal) => ({ state: 'refused', nowMs: NOW, refusal, checks: [] });
const OPEN = statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]);
const TABLE_ERROR = statusDoc([row({ id: 'A17', size: 'XL' })]);

test('a finish is `done by` its committed clock rounded up, with the weekday on another day, and highMs is that clock', () => {
  assert.deepEqual(resultSegment(finishAt(at(18, 8)), TZ), { kind: 'finish', text: 'done by 21:40', highMs: at(18, 10), progress: null, numbers: null });
  assert.deepEqual(resultSegment(finishAt(at(20, 46)), TZ), { kind: 'finish', text: 'done by Tue 00:20', highMs: at(20, 50), progress: null, numbers: null });
  assert.equal(resultSegment(finishAt(at(18, 8)), 'UTC').text, 'done by 18:10');
});

test('all done, handed over (weekday when not today) and the work left of a long job', () => {
  assert.deepEqual(resultSegment({ state: 'all-done', nowMs: NOW, rows: 3 }, TZ), { kind: 'finish', text: 'all rows done', highMs: null, progress: null, numbers: null });
  assert.deepEqual(resultSegment({ state: 'handed-over', nowMs: NOW, handedOverMs: at(14, 24) }, TZ), { kind: 'handed-over', text: 'handed over 17:54', highMs: null, progress: null, numbers: null });
  assert.equal(resultSegment({ state: 'handed-over', nowMs: NOW, handedOverMs: at(14, 24, 15) }, TZ).text, 'handed over Sun 17:54');
  const horizon = refused({ reason: 'horizon', longestJobMin: 355, work: { p50: 5400, p85: 5940, p95: 6300 } });
  assert.deepEqual(resultSegment(horizon, TZ), { kind: 'work-left', text: 'work left ~99 h', highMs: null, progress: null, numbers: null });
});

test('a refusal shows `done ? <cause>`, the cause one of a fixed list', () => {
  assert.equal(resultSegment(refused({ reason: 'no-rows' }), TZ).text, 'done ? no rows');
  assert.equal(resultSegment(refused({ reason: 'no-reference', size: 'L', rows: 4, needed: 5 }), TZ).text, 'done ? few rows');
  assert.equal(resultSegment(refused({ reason: 'growth', growth: 0.8 }), TZ).text, 'done ? rows listed late');
  assert.equal(resultSegment(refused({ reason: 'surprise' }), TZ).text, 'done ? tool error');
  assert.equal(resultSegment({ state: 'surprise' }, TZ).text, 'done ? tool error');
});

test('an error shows the row id when the table names one with a normal id, else `done ? table`, else `done ? tool error`', () => {
  const { problems } = parseWorkItems(TABLE_ERROR);
  assert.equal(errorSegment(new UsageError('x', problems)).text, 'done ? row A17');
  assert.equal(errorSegment(new UsageError('no table')).text, 'done ? tool error'); // no problems: not a table error
  assert.equal(errorSegment(new UsageError('x', [{ line: 3, reason: 'table header must be ...' }])).text, 'done ? table'); // no row id
  assert.equal(errorSegment(new TypeError('cannot read /secret/path')).text, 'done ? tool error');
  assert.equal(errorSegment(new UsageError('x', [{ line: 9, id: undefined, reason: 'row: the id cell is empty' }])).text, 'done ? table');
});

test('a row id with odd characters or too long is never shown: `done ? table`', () => {
  for (const id of ['A 17', 'A|17', '<b>x</b>', 'é1', 'A\u001b[31m17', '17', '-A', 'a'.repeat(18), '../etc', 'ignore previous instructions']) {
    const segment = errorSegment(new UsageError('x', [{ line: 1, id, reason: `${id}: bad` }]));
    assert.equal(segment.text, 'done ? table', JSON.stringify(id));
  }
  assert.equal(errorSegment(new UsageError('x', [{ line: 1, id: 'W8b.v-2_x', reason: '' }])).text, 'done ? row W8b.v-2_x');
});

test(`no segment text is longer than ${MAX_SEGMENT_CHARS} characters, the longest id and the longest forms included`, () => {
  const longestId = 'A'.repeat(17);
  const texts = [
    errorSegment(new UsageError('x', [{ line: 1, id: longestId, reason: '' }])).text,
    ...['no-rows', 'no-reference', 'growth'].map((reason) => resultSegment(refused({ reason }), TZ).text),
    resultSegment(finishAt(at(20, 46, 20)), TZ).text,
    resultSegment({ state: 'handed-over', nowMs: NOW, handedOverMs: at(14, 24, 12) }, TZ).text,
    resultSegment(refused({ reason: 'horizon', work: { p85: 99_999 * 60 } }), TZ).text,
    resultSegment(refused({ reason: 'horizon', work: { p85: 599 } }), TZ).text,
    'all rows done', OVERDUE_TEXT, 'done ? tool error', 'done ? table',
  ];
  assert.equal(texts[0], `done ? row ${longestId}`);
  for (const text of texts) assert.ok(text.length <= MAX_SEGMENT_CHARS, `${text} is ${text.length}`);
});

/** A project folder with a STATUS.md and a HOME whose cache folder and estimate store the refresh script writes. */
async function project(doc) {
  const root = makeTempDir('segment-forms-');
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  const statusPath = join(projectDir, 'STATUS.md');
  await writeFile(statusPath, doc);
  const home = join(root, 'home');
  const cacheDir = join(home, '.claude', 'state', 'estimate-segment');
  const refresh = () => {
    const run = spawnSync(process.execPath, [REFRESH_SCRIPT, statusPath], { cwd: projectDir, env: { ...process.env, HOME: home, USERPROFILE: home, TZ: 'UTC' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout + run.stderr, '');
    return readEntry(cacheDir, statusPath);
  };
  const render = (now) => estimateSegment({ projectDir }, { cacheDir, stateDir: join(home, '.claude', 'state', 'estimate'), now, spawnRefresh: () => {} });
  return { statusPath, cacheDir, refresh, render };
}

test('the refresh script caches each form with its kind', async () => {
  const forms = [
    [OPEN, 'finish', /^done by (\w{3} )?\d\d:\d\d$/],
    [statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 })]), 'finish', /^all rows done$/],
    [statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'deliver:1', item: 'report', raw: { done: iso(1) }, evidence: '-' })]), 'handed-over', /^handed over Tue 01:00$/],
    [statusDoc([]), 'refused', /^done \? no rows$/],
    [TABLE_ERROR, 'error', /^done \? row A17$/],
  ];
  for (const [doc, kind, text] of forms) {
    const entry = await project(doc).then((p) => p.refresh());
    assert.equal(entry.kind, kind);
    assert.match(entry.text, text);
  }
});

test('the render shows a marker, a hand-over and an overdue finish instead of nothing; a hand-over only while the file is unchanged', async () => {
  const { statusPath, cacheDir, render } = await project(OPEN);
  const { mtimeMs, size } = await stat(statusPath);
  const now = 1_800_000_000_000;
  const entry = (fields) => ({ path: statusPath, kind: 'finish', text: 'done by 16:15', highMs: now + HOUR_MS, mtimeMs, size, computedAt: now - 1, refreshStartedAt: now - 1, ...fields });
  const shown = (fields, at2 = now) => (writeEntry(cacheDir, statusPath, entry(fields)), render(at2)?.text ?? null);
  assert.equal(shown({}), 'done by 16:15');
  assert.equal(shown({}, now + 2 * HOUR_MS), OVERDUE_TEXT); // its clock has passed
  assert.equal(shown({ kind: 'work-left', text: 'work left ~99 h', highMs: null }, now + 2 * HOUR_MS), 'work left ~99 h');
  assert.equal(shown({ kind: 'refused', text: 'done ? few rows', highMs: null }, now + 5 * HOUR_MS), 'done ? few rows'); // a marker does not expire
  assert.equal(shown({ kind: 'handed-over', text: 'handed over 17:30', highMs: null }, now + 5 * HOUR_MS), 'handed over 17:30');
  const changed = { mtimeMs: mtimeMs + 1, kind: 'handed-over', text: 'handed over 17:30', highMs: null };
  assert.equal(shown(changed), null); // the file changed: no longer the hand-over the text was about
  assert.equal(shown({ ...changed, kind: 'refused', text: 'done ? row A17' }), 'done ? row A17'); // a marker stays for STALE_SHOW_MS while the refresh runs
  assert.equal(shown({ ...changed, kind: 'refused', text: 'done ? row A17' }, now + STALE_SHOW_MS + 1), null);
});

test('an entry the old tool wrote (no kind, or an old kind) is no entry; a bad kind is ignored', async () => {
  const { statusPath, cacheDir, render } = await project(OPEN);
  const { mtimeMs, size } = await stat(statusPath);
  const now = 1_800_000_000_000;
  const old = { path: statusPath, text: 'done ~14:50-16:15', highMs: now + HOUR_MS, mtimeMs, size, computedAt: now - 1, refreshStartedAt: now - 1 };
  for (const kind of [undefined, 'range', 'not-before', 'delivered', 'surprise']) {
    writeEntry(cacheDir, statusPath, { ...old, kind });
    assert.equal(render(now), null, String(kind));
  }
});

test('refused, then the table fixed: the marker gives way to a finish at the next refresh', async () => {
  const { statusPath, refresh, render } = await project(statusDoc([]));
  const first = refresh();
  assert.equal(render(first.computedAt + 1000)?.text, 'done ? no rows');
  await writeFile(statusPath, OPEN);
  assert.equal(render(first.computedAt + 2000)?.text, 'done ? no rows'); // the file changed: the old marker still shows while the refresh runs
  const second = refresh();
  assert.equal(second.kind, 'finish');
  assert.match(render(second.computedAt + 1000)?.text, /^done by /);
});

// The Desap table of estimate-spec section 7 at 06:20 (09:50 local, Mon 23 Nov): the job 2 h 57–3 h 28 (12:50–13:20), step 13 of
// 14 with 5/5 lanes landed 55 min–2 h 59 (10:45–12:50), 42 rows parked.
const DESAP_NOW = at(6, 20, 23);
const S1_JOB = { p50Min: 177, p80Min: 208, p50Ms: at(9, 20, 23), p80Ms: at(9, 50, 23) };
const S1_STEP = { road: 'iceplat', step: 13, steps: 14, lanesDone: 5, lanesTotal: 5, p50Min: 55, p80Min: 179, p50Ms: at(7, 15, 23), p80Ms: at(9, 20, 23) };
const PROMISE = { atMs: at(1, 0, 23), p80Ms: at(9, 50, 23), movedMs: at(9, 50, 23) };
const LATE = { min: 25, reasons: [{ kind: 'rows-added', min: 25, ids: ['a', 'b', 'c'], count: 3 }] };
const PAUSED = { promise: { ...PROMISE, movedMs: at(11, 10, 23) }, pauses: { min: 80, byReason: { 'no activity': 40, 'waiting for you': 40, 'usage limit': 0 } } };
const v2Of = (fields = {}) => ({
  model: 's1', job: S1_JOB, step: S1_STEP, waiting: 0, parked: 42, stalled: [], stalledCount: 0, promise: null, diff: null,
  pauses: { min: 0, byReason: {} }, ...fields,
});
/** An s1 cache entry: the R18 fields as wire-s1 fills them (an old reader draws those) and v2 beside them. */
const s1Entry = (v2 = v2Of()) => ({
  kind: 'finish', text: 'done by 12:50', highMs: at(9, 20, 23),
  progress: { pct: 90, approx: false, rowsDone: 44, rowsTotal: 45, leftMin: 177, tag: null, road: { name: 'iceplat', step: 13, steps: 14, rowsDone: 5, rowsTotal: 6, leftMin: 55, clockMs: at(7, 15, 23), p85Ms: at(9, 20, 23) } },
  numbers: { finishMs: at(9, 20, 23), p85Ms: at(9, 50, 23), leftMin: 177, workedMin: 600, rowsDone: 44, rowsTotal: 45, rows: [], v2 },
});
const rowsAt = (columns, segment, env = { NO_COLOR: '1' }, board = null) => {
  const look = lookOf({ LANG: 'en_US.UTF-8', ...env }, 'darwin', columns - 5);
  const view = { segment, board, nowMs: DESAP_NOW, timeZone: TZ };
  return [jobRow(view, look), nowRow(view, look)];
};
const jobAt = (columns, fields, env) => rowsAt(columns, s1Entry(v2Of({ promise: PROMISE, ...fields })), env)[0];

test('s1 rows at COLUMNS 150, 100 and 80 are the section 7 rows; the job bar counts rows (the cache carries no job lanes)', () => {
  assert.deepEqual(rowsAt(150, s1Entry()), [
    'job     ███████████████░  44 of 45 rows done · 2 h 57–3 h 28 of work left · done 12:50–13:20 if nothing pauses · 42 rows parked',
    'now     step 13 of 14 · ██████ 5 of 5 lanes landed · 55 min–2 h 59 left · step done 10:45–12:50',
  ]);
  assert.deepEqual(rowsAt(100, s1Entry()), [
    'job     █████████░ 44/45 rows · 2 h 57–3 h 28 work left · done 12:50–13:20 if no pause',
    'now     step 13 of 14 · █████ 5/5 lanes landed · 55 min–2 h 59 left · step done 10:45–12:50',
  ]);
  assert.equal(rowsAt(104, s1Entry())[0], 'job     █████████░ 44/45 rows · 2 h 57–3 h 28 work left · done 12:50–13:20 if no pause · 42 parked', '`parked` is the first part dropped');
  assert.deepEqual(rowsAt(80, s1Entry()), ['job █████░ 44/45 · 2 h 57–3 h 28 · 12:50–13:20', 'now step 13/14 · ███ 5/5 · 55 min–2 h 59 · 10:45–12:50']);
});

test('F4: the promise (on time, later, earlier, moved by pauses) stays while shorter words make room for it', () => {
  assert.equal(jobAt(150, { diff: LATE }), 'job     ███████████████░  44 of 45 rows done · 2 h 57–3 h 28 of work left · done 12:50–13:20 · 25 min later than promised 13:20: 3 rows added');
  assert.equal(jobAt(100, { diff: LATE }), 'job     █████░ 44/45 · 2 h 57–3 h 28 · 12:50–13:20 · 25 min later than promised: 3 rows added');
  assert.equal(jobAt(80, { diff: LATE }), 'job █████░ 44/45 · 2 h 57–3 h 28 · 12:50–13:20 · 25 min later than promised');
  assert.equal(jobAt(100, {}), 'job     █████████░ 44/45 rows · 2 h 57–3 h 28 work left · done 12:50–13:20 · on time for 13:20', 'parked and the pause note leave first');
  assert.equal(SHOWN_LATE_MIN, LATE_MIN, 'the row and the numbers share one late threshold');
  assert.equal(jobAt(100, { diff: { min: LATE_MIN - 1, reasons: [] } }), jobAt(100, {}), 'under LATE_MIN either way is on time');
  assert.match(jobAt(150, { diff: { min: -30, reasons: [] } }), / · done 12:50–13:20 · 30 min earlier than promised 13:20$/);
  assert.match(jobAt(150, PAUSED), / · done 12:50–13:20 · on time for 14:40 · moved 1 h 20 by pauses$/, 'the promise the pauses moved');
  assert.match(jobAt(220, PAUSED), / · on time for 14:40 · moved 1 h 20 by pauses: waiting for you 40 min, no activity 40 min$/);
  const unequal = { ...PAUSED, pauses: { min: 80, byReason: { 'waiting for you': 10, 'no activity': 70 } } };
  assert.match(jobAt(220, unequal), /moved 1 h 20 by pauses: no activity 1 h 10, waiting for you 10 min$/, 'largest first');
});

test('F1: at COLUMNS 80, 100 and 150 every s1 row fits COLUMNS - 5 and keeps its counts, ranges and clocks whole', () => {
  for (const columns of [80, 100, 150]) {
    for (const fields of [{ promise: null }, {}, { diff: LATE }, { diff: { min: -30, reasons: [] } }, { waiting: 2 }, PAUSED]) {
      const [job, now] = rowsAt(columns, s1Entry(v2Of({ promise: PROMISE, ...fields })));
      for (const row of [job, now]) assert.ok([...row].length <= columns - 5 && !row.includes('…'), `${columns}: ${row}`);
      assert.match(job, /44(\/| of )45.* · 2 h 57–3 h 28.* · (done )?12:50–13:20/, `${columns}: ${job}`);
      assert.match(now, /step 13( of |\/)14 · \S+ 5(\/| of )5.* · 55 min–2 h 59.* · (step done )?10:45–12:50$/, `${columns}: ${now}`);
    }
  }
});

test('F3: durations and clocks keep the time colour on the dark and the light palette; late is yellow, red past the margin', () => {
  const dark = rowsAt(100, s1Entry(), { TERM: 'xterm-256color' });
  assert.ok(dark[0].includes('\u001b[38;5;33m2 h 57–3 h 28\u001b[0m work left') && dark[0].includes('done \u001b[38;5;33m12:50–13:20\u001b[0m'), dark[0]);
  const light = rowsAt(100, s1Entry(), { TERM: 'xterm-256color', CLAUDE_STATUS_THEME: 'light' });
  assert.ok(light[1].includes('\u001b[38;5;25m55 min–2 h 59\u001b[0m left') && light[1].includes('step done \u001b[38;5;25m10:45–12:50\u001b[0m'), light[1]);
  assert.ok(jobAt(100, { diff: LATE }, { TERM: 'xterm-256color' }).includes('\u001b[33m25 min later than promised'), 'margin 31 min: yellow');
  assert.ok(jobAt(100, { diff: { ...LATE, min: 40 } }, { TERM: 'xterm-256color' }).includes('\u001b[31m40 min later than promised'), 'past it: red');
  assert.ok(jobAt(150, { diff: { min: -30, reasons: [] } }, { TERM: 'xterm-256color' }).includes('\u001b[38;5;33m30 min\u001b[0m earlier than promised \u001b[38;5;33m13:20'));
  for (const row of [...rowsAt(150, s1Entry(v2Of({ promise: PROMISE, diff: LATE }))), jobAt(150, PAUSED, { NO_COLOR: '1', TERM: 'xterm-256color' })]) assert.ok(!row.includes('\u001b'), row);
  const ascii = rowsAt(100, s1Entry(), { NO_COLOR: '1', CLAUDE_STATUS_ASCII: '1' });
  assert.equal(ascii[1], 'now     step 13 of 14 - ##### 5/5 lanes landed - 55 min-2 h 59 left - step done 10:45-12:50');
  assert.doesNotMatch(ascii.join(''), /[^ -~]/);
});

test('F2: without v2 (a rolled-back estimator) or with a malformed one the same entry draws the R18 rows', () => {
  const r18 = rowsAt(100, { ...s1Entry(), numbers: { ...s1Entry().numbers, v2: undefined } });
  assert.deepEqual(r18, ['job     ███████░ 44/45 rows done · 2 h 57 work left · done by 12:50', 'now     step 13 of 14 · █████░ 5/6 rows done · 55 min work left · step done by 10:45']);
  const bad = [
    null, [], 'v2', { ...v2Of(), model: 'c3' }, { ...v2Of(), job: { ...S1_JOB, p50Min: 300 } }, { ...v2Of(), step: { ...S1_STEP, step: 0 } },
    { ...v2Of(), waiting: -1 }, { ...v2Of(), parked: 1.5 }, { ...v2Of(), promise: { ...PROMISE, p80Ms: 'soon' } },
    { ...v2Of(), diff: { min: 25, reasons: [{ kind: 'evil', min: 25, ids: [] }] } }, { ...v2Of(), diff: { min: 25, reasons: [{ kind: 'rows-added', min: 25, ids: [7] }] } },
    { ...v2Of(), pauses: { min: 10, byReason: { 'no activity': 'x' } } }, { ...v2Of(), pauses: null },
  ];
  for (const v2 of bad) assert.deepEqual(rowsAt(100, s1Entry(v2)), r18, JSON.stringify(v2));
});

test('the s1 rows stay light: range-rows.mjs imports neither the forecast nor job-rows.mjs (every render loads it)', async () => {
  const source = await readFile(fileURLToPath(new URL('../home/tools/board/lib/range-rows.mjs', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/^import .* from '(.+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ['./cells.mjs', '../../estimate/lib/local-clock.mjs']);
});

test('waits come before parked and need you (magenta); an idle road hides the rows; a reason\'s row id is cleaned', () => {
  assert.match(rowsAt(150, s1Entry(v2Of({ waiting: 1, parked: 0 })))[0], / · done 12:50–13:20 if nothing pauses · 1 row waits for you$/);
  assert.match(rowsAt(110, s1Entry(v2Of({ waiting: 2 })))[0], / · done 12:50–13:20 if no pause · 2 wait for you$/, 'parked leaves before the waits');
  assert.ok(rowsAt(110, s1Entry(v2Of({ waiting: 2 })), { TERM: 'xterm-256color' })[0].includes('\u001b[35m2 wait for you\u001b[0m'));
  assert.deepEqual(rowsAt(100, s1Entry(), { NO_COLOR: '1' }, { road: { name: 'iceplat', live: false } }), [null, null]);
  const slow = { min: 25, reasons: [{ kind: 'over-usual', min: 25, ids: ['R18.\u001b[31mgit'], count: 1 }] };
  assert.match(jobAt(150, { diff: slow }), /later than promised 13:20: R18\. \[31mgit over usual$/);
});

test('a range on another day names its weekday once, across midnight on its second end; equal ends and a shared unit print once', () => {
  const jobWith = (job) => rowsAt(150, s1Entry(v2Of({ job, parked: 0 })))[0];
  assert.match(jobWith({ ...S1_JOB, p50Ms: at(9, 20, 24), p80Ms: at(9, 50, 24) }), / · done Tue 12:50–13:20 if nothing pauses$/);
  assert.match(jobWith({ ...S1_JOB, p50Ms: at(20, 20, 23), p80Ms: at(20, 50, 23) }), / · done 23:50–Tue 00:20 if nothing pauses$/);
  assert.match(jobWith({ p50Min: 30, p80Min: 30, p50Ms: at(7, 0, 23), p80Ms: at(7, 0, 23) }), / · 30 min of work left · done 10:30 if nothing pauses$/);
  assert.match(jobWith({ p50Min: 25, p80Min: 40, p50Ms: at(6, 45, 23), p80Ms: at(7, 0, 23) }), / · 25–40 min of work left · done 10:15–10:30 /);
});
