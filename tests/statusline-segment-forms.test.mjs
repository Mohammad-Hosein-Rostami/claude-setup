// Tests for the forms of the status line's estimate segment (lib/segment-text.mjs, written by statusline-cache.mjs, read by
// lib/segment-cache.mjs), estimator design 4.3: `done by 21:40`, `all rows done`, `handed over 17:54`, `work left ~99 h`, and
// `done ? <cause>` after a refusal or an error, so the segment never silently disappears. In the render tests the clock and the
// spawner are injected; the refresh script runs for real with HOME in a temp folder. Zone Asia/Tehran (+03:30).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  assert.deepEqual(resultSegment(finishAt(at(18, 8)), TZ), { kind: 'finish', text: 'done by 21:40', highMs: at(18, 10), progress: null });
  assert.deepEqual(resultSegment(finishAt(at(20, 46)), TZ), { kind: 'finish', text: 'done by Tue 00:20', highMs: at(20, 50), progress: null });
  assert.equal(resultSegment(finishAt(at(18, 8)), 'UTC').text, 'done by 18:10');
});

test('all done, handed over (weekday when not today) and the work left of a long job', () => {
  assert.deepEqual(resultSegment({ state: 'all-done', nowMs: NOW, rows: 3 }, TZ), { kind: 'finish', text: 'all rows done', highMs: null, progress: null });
  assert.deepEqual(resultSegment({ state: 'handed-over', nowMs: NOW, handedOverMs: at(14, 24) }, TZ), { kind: 'handed-over', text: 'handed over 17:54', highMs: null, progress: null });
  assert.equal(resultSegment({ state: 'handed-over', nowMs: NOW, handedOverMs: at(14, 24, 15) }, TZ).text, 'handed over Sun 17:54');
  const horizon = refused({ reason: 'horizon', longestJobMin: 355, work: { p50: 5400, p85: 5940, p95: 6300 } });
  assert.deepEqual(resultSegment(horizon, TZ), { kind: 'work-left', text: 'work left ~99 h', highMs: null, progress: null });
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
