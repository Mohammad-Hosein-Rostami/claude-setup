// Tests for the forms of the status line's estimate segment (lib/segment-text.mjs, written by statusline-cache.mjs, read by
// lib/segment-cache.mjs): a finish range, `done >=` (not before), `delivered HH:MM`, and `done ? <cause>` after a refusal or an
// error, so the segment never silently disappears. In the render tests the clock and the spawner are injected; the refresh script
// runs for real with HOME in a temp folder. Zone Asia/Tehran (+03:30); BASE_MS = Tue 10 Nov 00:00Z = 03:30 local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeEstimate } from '../home/tools/estimate/lib/compute.mjs';
import { UsageError } from '../home/tools/estimate/lib/from-files.mjs';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { OVERDUE_TEXT, STALE_SHOW_MS, estimateSegment, readEntry, writeEntry } from '../home/tools/estimate/lib/segment-cache.mjs';
import { MAX_SEGMENT_CHARS, errorSegment, refusalSegment, resultSegment } from '../home/tools/estimate/lib/segment-text.mjs';
import { BASE_MS, HOUR_MS, fiveDoneRows, row, statusDoc } from './estimate-fixtures.mjs';

const REFRESH_SCRIPT = fileURLToPath(new URL('../home/tools/estimate/statusline-cache.mjs', import.meta.url));
const TZ = 'Asia/Tehran';
const at = (hours) => Math.round(BASE_MS + hours * HOUR_MS);
const close = (spec) => row({ ...spec, item: 'close: row' });
const deliverRow = (id, doneH) => row({ id, item: 'deliver: row', raw: { done: new Date(at(doneH)).toISOString().replace(':00.000Z', 'Z') }, evidence: '-' });
const FIRST_JOB = [...[0, 0.2, 0.4, 0.6, 0.8].map((h, i) => row({ id: `D${i + 1}`, startedH: h, doneH: h + 0.1 })), close({ id: 'C1', startedH: 1, doneH: 1.5 })];
const USABLE = statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })]));
const FEW_ROWS = statusDoc([row({ id: 'D1', startedH: 0, doneH: 1 }), row({ id: 'O1' })]);
const TABLE_ERROR = statusDoc([...fiveDoneRows(), row({ id: 'A17', size: 'XL' })]);
const OUTRAN = statusDoc([...FIRST_JOB, close({ id: 'V1', startedH: 2 }), close({ id: 'V2' })]); // far past the 2.6 h round
const estimate = (rows, nowH, windows = []) => computeEstimate(parseWorkItems(statusDoc(rows)).items, windows, at(nowH));

test('delivered: `delivered HH:MM`, the weekday when it is not today, a ? when guessed from a pause or provisional', () => {
  const byRow = [...fiveDoneRows(), deliverRow('X1', 14)]; // delivered 14 h = 17:30 local
  assert.equal(resultSegment(estimate(byRow, 20), TZ).text, 'delivered 17:30');
  assert.equal(resultSegment(estimate(byRow, 30), TZ).text, 'delivered Tue 17:30'); // computed on Wed 11 Nov
  const guessed = [...fiveDoneRows(), close({ id: 'C1', startedH: 13, doneH: 14 })];
  assert.equal(resultSegment(estimate(guessed, 20), TZ).text, 'delivered 17:30?'); // the pause rule only guesses
  assert.equal(resultSegment(estimate(guessed, 14 + 5 / 60), TZ).text, 'delivered 17:30?'); // provisional for 10 minutes
  assert.equal(resultSegment(estimate(byRow, 20), TZ).kind, 'delivered');
  assert.equal(resultSegment(estimate(byRow, 20), TZ).highMs, null);
});

test('a range is `done ~a-b` and a not-before is `done >=a`; both expire at their last instant', () => {
  const range = resultSegment(estimate(fiveDoneRows([row({ id: 'O1' })]), 14), TZ);
  assert.deepEqual([range.kind, range.text], ['range', 'done ~19:50-23:00']);
  assert.ok(range.highMs > at(14));
  const notBefore = resultSegment(computeEstimate(parseWorkItems(OUTRAN).items, [], at(5)), TZ);
  assert.deepEqual([notBefore.kind, notBefore.text, notBefore.highMs === null], ['not-before', 'done >=08:35', false]);
});

test('a refusal shows `done ? <cause>`, the cause one of a fixed list', () => {
  const causes = {
    'no rows': estimate([], 20),
    'few rows': estimate([row({ id: 'D1', startedH: 0, doneH: 1 })], 20),
    'no start time': estimate([...fiveDoneRows(), row({ id: 'M1', doneH: 1 })], 20),
    'time ahead': estimate([...fiveDoneRows(), row({ id: 'F1', startedH: 500 })], 20),
    'no work time': estimate(fiveDoneRows([row({ id: 'O1' })]), 20, [{ start: BASE_MS, end: at(20) }]),
    overrun: estimate(fiveDoneRows(), 16),
    'no deliver row': estimate([...FIRST_JOB, row({ id: 'R1', item: 'rework: row', startedH: 2, doneH: 2.5 })], 2.6),
  };
  for (const [cause, refusal] of Object.entries(causes)) {
    assert.equal(refusal.refused, true, cause);
    assert.deepEqual([refusalSegment(refusal).kind, refusalSegment(refusal).text], ['refused', `done ? ${cause}`]);
  }
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

test(`no segment text is longer than ${MAX_SEGMENT_CHARS} characters, the longest id included`, () => {
  const longestId = 'A'.repeat(17);
  const texts = [
    errorSegment(new UsageError('x', [{ line: 1, id: longestId, reason: '' }])).text,
    ...['no rows', 'few rows', 'no start time', 'time ahead', 'no work time', 'overrun', 'no deliver row', 'table', 'tool error'].map((cause) => `done ? ${cause}`),
    OVERDUE_TEXT, 'delivered Wed 23:59?', 'done >=Wed 23:55', 'done ~Wed 23:50 - Thu 01:10',
  ];
  assert.equal(texts[0], `done ? row ${longestId}`);
  for (const text of texts) assert.ok(text.length <= MAX_SEGMENT_CHARS, `${text} is ${text.length}`);
});

/** A project folder with a STATUS.md and a HOME whose cache folder the refresh script writes. */
async function project(doc) {
  const root = await mkdtemp(join(tmpdir(), 'segment-forms-'));
  const projectDir = join(root, 'project');
  await mkdir(projectDir);
  const statusPath = join(projectDir, 'STATUS.md');
  await writeFile(statusPath, doc);
  const home = join(root, 'home');
  const cacheDir = join(home, '.claude', 'state', 'estimate-segment');
  const refresh = () => {
    const run = spawnSync(process.execPath, [REFRESH_SCRIPT, statusPath], { cwd: projectDir, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readEntry(cacheDir, statusPath);
  };
  const render = (now) => estimateSegment(projectDir, { cacheDir, now, spawnRefresh: () => {} });
  return { statusPath, cacheDir, refresh, render };
}

test('the refresh script caches each form with its kind', async () => {
  const forms = [
    [USABLE, 'range', /^done ~(\w{3} )?\d\d:\d\d( - \w{3} |-)\d\d:\d\d$/],
    [OUTRAN, 'not-before', /^done >=(\w{3} )?\d\d:\d\d$/],
    [statusDoc([...fiveDoneRows(), deliverRow('X1', 14)]), 'delivered', /^delivered (\w{3} )?\d\d:\d\d$/],
    [FEW_ROWS, 'refused', /^done \? few rows$/],
    [TABLE_ERROR, 'error', /^done \? row A17$/],
  ];
  for (const [doc, kind, text] of forms) {
    const entry = await project(doc).then((p) => p.refresh());
    assert.equal(entry.kind, kind);
    assert.match(entry.text, text);
  }
});

test('the render shows a marker, a delivery and an overdue range instead of nothing; a delivery only while the file is unchanged', async () => {
  const { statusPath, cacheDir, render } = await project(USABLE);
  const { mtimeMs, size } = await stat(statusPath);
  const now = 1_800_000_000_000;
  const entry = (fields) => ({ path: statusPath, kind: 'range', text: 'done ~14:50-16:15', highMs: now + HOUR_MS, mtimeMs, size, computedAt: now - 1, refreshStartedAt: now - 1, ...fields });
  const shown = (fields, at2 = now) => (writeEntry(cacheDir, statusPath, entry(fields)), render(at2));
  assert.equal(shown({}), 'done ~14:50-16:15');
  assert.equal(shown({}, now + 2 * HOUR_MS), OVERDUE_TEXT); // its high end has passed
  assert.equal(shown({ kind: 'not-before', text: 'done >=17:10' }, now + 2 * HOUR_MS), OVERDUE_TEXT);
  assert.equal(shown({ kind: 'refused', text: 'done ? overrun', highMs: null }, now + 5 * HOUR_MS), 'done ? overrun'); // a marker does not expire
  assert.equal(shown({ kind: 'delivered', text: 'delivered 17:30', highMs: null }, now + 5 * HOUR_MS), 'delivered 17:30');
  const changed = { mtimeMs: mtimeMs + 1, kind: 'delivered', text: 'delivered 17:30', highMs: null };
  assert.equal(shown(changed), null); // the file changed: no longer the delivery the text was about
  assert.equal(shown({ ...changed, kind: 'refused', text: 'done ? row A17' }), 'done ? row A17'); // a marker stays for STALE_SHOW_MS while the refresh runs
  assert.equal(shown({ ...changed, kind: 'refused', text: 'done ? row A17' }, now + STALE_SHOW_MS + 1), null);
});

test('a cache file from before `kind` existed is read as it always was, and a bad kind is ignored', async () => {
  const { statusPath, cacheDir, render } = await project(USABLE);
  const { mtimeMs, size } = await stat(statusPath);
  const now = 1_800_000_000_000;
  const old = { path: statusPath, text: 'done ~14:50-16:15', highMs: now + HOUR_MS, mtimeMs, size, computedAt: now - 1, refreshStartedAt: now - 1 };
  writeEntry(cacheDir, statusPath, old);
  assert.equal(render(now), 'done ~14:50-16:15');
  assert.equal(render(now + 2 * HOUR_MS), null); // as before: hidden once the high end has passed (no kind, no overdue text)
  writeEntry(cacheDir, statusPath, { ...old, text: null, highMs: null });
  assert.equal(render(now), null);
  writeEntry(cacheDir, statusPath, { ...old, kind: 'surprise' });
  assert.equal(render(now), null); // foreign entry: ignored
});

test('refused, then the table fixed: the marker gives way to a range at the next refresh', async () => {
  const { statusPath, refresh, render } = await project(FEW_ROWS);
  const first = refresh();
  assert.equal(render(first.computedAt + 1000), 'done ? few rows');
  await writeFile(statusPath, USABLE);
  const stale = render(first.computedAt + 2000); // the file changed: the old marker still shows while the refresh runs
  assert.equal(stale, 'done ? few rows');
  const second = refresh();
  assert.equal(second.kind, 'range');
  assert.match(render(second.computedAt + 1000), /^done ~/);
});
