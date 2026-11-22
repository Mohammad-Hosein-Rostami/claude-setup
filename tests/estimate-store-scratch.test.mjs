// Tests for the scratch rule of the estimate store (home/tools/estimate/lib/table-store.mjs): a STATUS.md in a temp folder or a
// `scratchpad` folder is neither written to nor pooled from the owner's store (stateDir()), so probe jobs never skew a forecast.
// Cases: the path rule on macOS, Linux and Windows paths and the look-alike `scratchpad-notes` folder (F1, F2); noteTable, updateTable and
// estimateFile write nothing for a scratch table; a real job's table is still written; readAllTables leaves a scratch table out of the pool;
// another store (`--state-dir`, a test's) keeps scratch tables, so the other estimate tests are unchanged.
// HOME is a private temp folder for the whole file, so stateDir() is a temp store and nothing of the owner's is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { estimateFile } from '../home/tools/estimate/lib/from-files.mjs';
import { isScratchStatusPath, noteTable, readAllTables, stateDir, tableId, updateTable } from '../home/tools/estimate/lib/table-store.mjs';
import { SESSION, iso, row, seedRows, statusDoc, writeSeed, writeTranscript } from './estimate-tables.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const NOW_MS = Date.parse('2026-11-16T10:00Z');
const privateHome = makeTempDir('estimate-scratch-home-');
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = privateHome;
process.env.USERPROFILE = privateHome;
test.after(() => {
  for (const [name, value] of Object.entries(realHome)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A STATUS.md path that is no scratch place and does not exist (nothing reads it): a real job of the owner's. */
const realJobPath = () => resolve('/estimate-scratch-test-job', 'STATUS.md');
const tableFiles = () => (existsSync(join(stateDir(), 'table')) ? readdirSync(join(stateDir(), 'table')) : []);

test('the path rule: temp folders of macOS, Linux and Windows and a scratchpad folder are scratch; look-alikes and real jobs are not', () => {
  const scratch = [
    join(realpathSync(tmpdir()), 'job', 'STATUS.md'),
    '/private/var/folders/ab/cd1234/T/job/STATUS.md',
    '/tmp/job/STATUS.md',
    '/private/tmp/claude-501/session/scratchpad/STATUS.md',
    '/Users/x/project/scratchpad/STATUS.md',
    'C:\\Users\\x\\AppData\\Local\\Temp\\job\\STATUS.md',
    'c:/users/X/appdata/local/temp/job/STATUS.md',
  ];
  const real = [
    '/Users/x/project/scratchpad-notes/STATUS.md',
    '/Users/x/project/STATUS.md',
    '/Users/x/tmpfiles/STATUS.md',
    '/Users/x/temp/STATUS.md',
    'C:\\Users\\x\\Documents\\STATUS.md',
    'C:\\Users\\x\\AppData\\Roaming\\STATUS.md',
  ];
  for (const path of scratch) assert.equal(isScratchStatusPath(path), true, path);
  for (const path of real) assert.equal(isScratchStatusPath(path), false, path);
});

test('noteTable and updateTable write nothing for a scratch table in the owner\'s store, and report no failure', () => {
  const root = makeTempDir('estimate-scratch-job-');
  const statusPath = join(root, 'STATUS.md');
  writeFileSync(statusPath, '## Work items\n');
  assert.equal(noteTable(stateDir(), statusPath, { sessionId: SESSION, ids: ['a'], nowMs: NOW_MS }), true);
  assert.equal(updateTable(stateDir(), statusPath, (table) => table), undefined);
  assert.deepEqual(tableFiles(), []);
  assert.equal(existsSync(join(stateDir(), 'session')), false, 'no session link either');
});

test('a real job\'s table is still written and read', () => {
  const statusPath = realJobPath();
  assert.equal(noteTable(stateDir(), statusPath, { sessionId: SESSION, ids: ['a'], nowMs: NOW_MS }), true);
  assert.deepEqual(tableFiles(), [`${tableId(statusPath)}.json`]);
  assert.equal(readAllTables(stateDir()).length, 1);
});

test('readAllTables leaves a scratch table out of the pool and keeps the real one', () => {
  const root = makeTempDir('estimate-scratch-pool-');
  const scratchStatus = join(root, 'STATUS.md');
  writeFileSync(scratchStatus, '## Work items\n');
  const other = join(root, 'other-store'); // not the owner's store: it keeps the scratch table when it writes it
  noteTable(other, scratchStatus, { sessionId: undefined, ids: ['s'], nowMs: NOW_MS });
  const name = `${tableId(scratchStatus)}.json`;
  mkdirSync(join(stateDir(), 'table'), { recursive: true });
  writeFileSync(join(stateDir(), 'table', name), readFileSync(join(other, 'table', name)));
  assert.deepEqual(readAllTables(other).map((table) => table.id), [tableId(scratchStatus)], 'another store keeps it');
  assert.deepEqual(readAllTables(stateDir()).map((table) => table.id), [tableId(realJobPath())], 'the owner\'s store does not pool it');
});

test('estimateFile of a scratch STATUS.md stores nothing in the owner\'s store and is not reported busy', () => {
  const root = makeTempDir('estimate-scratch-run-');
  const statusPath = join(root, 'STATUS.md');
  const seedFile = join(root, 'seed.json');
  const filesBefore = tableFiles();
  writeFileSync(statusPath, statusDoc([row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 })]));
  writeTranscript(join(root, 'projects'), SESSION, 0, 1);
  writeSeed(seedFile, seedRows('S', 5, 30));
  const { result, inputs } = estimateFile(statusPath, { now: iso(1), stateDir: stateDir(), projectsDir: join(root, 'projects'), sessionId: SESSION, record: true, seedFile });
  assert.equal(result.state, 'finish');
  assert.deepEqual(tableFiles(), filesBefore);
  assert.deepEqual([inputs.recorded, inputs.busy], [true, false], 'counts as recorded (the status-line cache may still be written), never as busy');
  assert.equal(homedir(), privateHome);
});
