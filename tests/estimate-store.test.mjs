// Tests for home/tools/estimate/lib/table-store.mjs: table ids, the table file under its lock (two runs at once leave one
// commitment; a busy lock records nothing), first-seen times and session links, the seed, and that no write sweeps old files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { activeRuns } from '../home/tools/estimate/lib/activity.mjs';
import { linkedStatusPath, noteTable, readAllTables, readSeed, stateDir, tableId, updateTable } from '../home/tools/estimate/lib/table-store.mjs';

const STORE_URL = new URL('../home/tools/estimate/lib/table-store.mjs', import.meta.url).href;
const SESSION = '11111111-2222-3333-4444-555555555555';
const NOW_MS = Date.parse('2026-11-16T10:00Z');
const run = promisify(execFile);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'est-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statusPath = join(root, 'STATUS.md');
  writeFileSync(statusPath, '## Work items\n');
  return { root, statusPath, state: join(root, 'state') };
}

const tableFile = (state, statusPath) => join(state, 'table', `${tableId(statusPath)}.json`);

test('stateDir is ~/.claude/state/estimate and tableId is 32 hex of the real path', (t) => {
  const { root, statusPath } = fixture(t);
  assert.match(stateDir(), /[/\\]\.claude[/\\]state[/\\]estimate$/);
  assert.match(tableId(statusPath), /^[0-9a-f]{32}$/);
  symlinkSync(statusPath, join(root, 'link.md'));
  assert.equal(tableId(join(root, 'link.md')), tableId(statusPath));
  assert.notEqual(tableId(join(root, 'other.md')), tableId(statusPath));
});

test('updateTable starts from an empty table and stores what the change returns', (t) => {
  const { statusPath, state } = fixture(t);
  const stored = updateTable(state, statusPath, (table) => ({ ...table, commit: { at: '2026-11-16T10:00:00.000Z', budgetMin: 30, ids: ['a'], moved: null } }));
  assert.equal(stored.v, 2);
  assert.deepEqual([stored.sessions, stored.added, stored.rows, stored.jobs, stored.log], [[], {}, [], [], []]);
  assert.deepEqual(JSON.parse(readFileSync(tableFile(state, statusPath), 'utf8')), stored);
});

test('updateTable: two runs at once leave one commitment', async (t) => {
  const { statusPath, state } = fixture(t);
  const startAt = Date.now() + 300;
  const script = `
    import { updateTable } from ${JSON.stringify(STORE_URL)};
    while (Date.now() < ${startAt});
    const stored = updateTable(process.argv[1], process.argv[2], (table) => {
      const until = Date.now() + 100; // a slow change: without the lock both runs would read the empty table
      while (Date.now() < until);
      return table.commit !== null ? table
        : { ...table, commit: { at: new Date().toISOString(), budgetMin: process.pid, ids: [], moved: null }, log: [...table.log, { pid: process.pid }] };
    });
    process.stdout.write(stored === undefined ? 'busy' : String(stored.commit.budgetMin));`;
  const runs = await Promise.all([1, 2].map(() => run(process.execPath, ['--input-type=module', '-e', script, state, statusPath])));
  const table = JSON.parse(readFileSync(tableFile(state, statusPath), 'utf8'));
  assert.deepEqual(runs.map((result) => result.stdout), [String(table.commit.budgetMin), String(table.commit.budgetMin)]);
  assert.equal(table.log.length, 1);
  assert.equal(table.commit.budgetMin, table.log[0].pid);
});

test('updateTable records nothing while another run holds the lock', (t) => {
  const { statusPath, state } = fixture(t);
  mkdirSync(join(state, 'table'), { recursive: true });
  const lock = join(state, 'table', `${tableId(statusPath)}.lock`);
  writeFileSync(lock, '');
  const heldUntil = (Date.now() + 900) / 1000; // a live holder's lock: not stale before the 1 s wait ends
  utimesSync(lock, heldUntil, heldUntil);
  let called = false;
  const stored = updateTable(state, statusPath, (table) => { called = true; return table; });
  assert.equal(stored, undefined);
  assert.equal(called, false);
  assert.equal(existsSync(tableFile(state, statusPath)), false);
});

test('updateTable leaves a table file it cannot read (too big) untouched and records nothing', (t) => {
  const { statusPath, state } = fixture(t);
  mkdirSync(join(state, 'table'), { recursive: true });
  const tooBig = `${'x'.repeat(1 << 20)}!`;
  writeFileSync(tableFile(state, statusPath), tooBig);
  assert.equal(updateTable(state, statusPath, (table) => table), undefined);
  assert.equal(readFileSync(tableFile(state, statusPath), 'utf8'), tooBig);
});

test('noteTable keeps the first-seen time of each id, drops ids no longer in the table and links the session', (t) => {
  const { statusPath, state } = fixture(t);
  assert.equal(noteTable(state, statusPath, { sessionId: SESSION, ids: ['a', 'b'], nowMs: NOW_MS }), true);
  assert.equal(noteTable(state, statusPath, { sessionId: SESSION, ids: ['b', 'c'], nowMs: NOW_MS + 60_000 }), true);
  const [table] = readAllTables(state);
  assert.equal(table.id, tableId(statusPath));
  assert.deepEqual(table.added, { b: '2026-11-16T10:00:00.000Z', c: '2026-11-16T10:01:00.000Z' });
  assert.deepEqual(table.sessions, [SESSION]);
  assert.equal(linkedStatusPath(state, SESSION), table.path);
  assert.equal(linkedStatusPath(state, '99999999-0000-0000-0000-000000000000'), null);
});

test('noteTable without a session id records first-seen times and links nothing', (t) => {
  const { statusPath, state } = fixture(t);
  assert.equal(noteTable(state, statusPath, { sessionId: undefined, ids: ['a'], nowMs: NOW_MS }), true);
  assert.deepEqual(readAllTables(state)[0].sessions, []);
  assert.equal(existsSync(join(state, 'session')), false);
});

test('readAllTables skips a file that is not a table and returns [] without a store', (t) => {
  const { statusPath, state } = fixture(t);
  assert.deepEqual(readAllTables(state), []);
  noteTable(state, statusPath, { sessionId: SESSION, ids: ['a'], nowMs: NOW_MS });
  writeFileSync(join(state, 'table', `${'f'.repeat(32)}.json`), '{"v":1}');
  writeFileSync(join(state, 'table', `${'e'.repeat(32)}.json`), 'not json');
  assert.deepEqual(readAllTables(state).map((table) => table.id), [tableId(statusPath)]);
});

test('no write sweeps an old file of the table, session or activity folders', (t) => {
  const { root, statusPath, state } = fixture(t);
  const old = (NOW_MS - 30 * 24 * 3_600_000) / 1000;
  const oldFiles = ['table', 'session', 'activity'].map((folder) => {
    mkdirSync(join(state, folder), { recursive: true });
    const path = join(state, folder, `${'a'.repeat(32)}.json`);
    writeFileSync(path, '{}');
    utimesSync(path, old, old);
    return path;
  });
  noteTable(state, statusPath, { sessionId: SESSION, ids: ['a'], nowMs: NOW_MS });
  updateTable(state, statusPath, (table) => table);
  mkdirSync(join(root, 'projects'));
  activeRuns([SESSION], { projectsDir: join(root, 'projects'), stateDir: state });
  assert.ok(existsSync(join(state, 'activity', `${SESSION}.json`)));
  assert.deepEqual(oldFiles.filter((path) => !existsSync(path)), []);
});

test('readSeed returns no rows for a missing file and keeps only well-formed entries', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(readSeed(join(root, 'none.json')), { rows: [], jobs: [] });
  const table = 'c'.repeat(32);
  const good = { table, size: 'M', kind: 'build', done: '2026-11-15T10:00:00.000Z', cost: 12.5 };
  const job = { table, at: '2026-11-15T11:00:00.000Z', minutes: 90, growthNum: 10, growthDen: 100 };
  const file = join(root, 'seed.json');
  writeFileSync(file, JSON.stringify({ v: 2, rows: [good, { ...good, size: 'XL' }, { ...good, cost: 'x' }], jobs: [job, { ...job, minutes: null }] }));
  assert.deepEqual(readSeed(file), { rows: [good], jobs: [job] });
  writeFileSync(file, '{"v":2,');
  assert.throws(() => readSeed(file), /seed\.json/);
});
