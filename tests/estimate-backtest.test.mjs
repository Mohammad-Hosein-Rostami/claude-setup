// Tests for home/tools/estimate/backtest.mjs as a command: usage errors, the scanner and threshold report on a tiny synthetic
// setup (two tables, one session each), and the seed it writes (table hash, size, kind, done, cost; no ids, no text).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../home/tools/estimate/backtest.mjs', import.meta.url));
const SESSIONS = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'];
const HEADER = '## Work items\n\n| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n';

/** Two tables of two done S rows and one hand-over each; every minute of 10:00-10:40 is active in both sessions. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'est-backtest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = join(root, 'projects', '-Users-me-p');
  mkdirSync(folder, { recursive: true });
  const jobs = SESSIONS.map((session, k) => {
    const minutes = Array.from({ length: 41 }, (_, m) => `{"timestamp":"2026-11-16T10:${String(m).padStart(2, '0')}:00.000Z"}`);
    writeFileSync(join(folder, `${session}.jsonl`), `${minutes.join('\n')}\n`);
    const statusPath = join(root, `t${k}.STATUS.md`);
    writeFileSync(statusPath, `${HEADER}| r1 | secret text one | S | 2026-11-16T10:00Z | 2026-11-16T10:20Z | abc1234 |\n| r2 | close: secret two | S | 2026-11-16T10:20Z | 2026-11-16T10:40Z | abc1234 |\n| deliver:1 | deliver: done | S | - | 2026-11-16T10:40Z | - |\n`);
    return `${statusPath}=${session}`;
  });
  return { root, jobs, args: ['--now', '2026-11-16T12:00Z', '--projects', join(root, 'projects'), '--state-dir', join(root, 'state')] };
}

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('backtest: a missing --job or a job without a session id is a usage error (exit 2)', (t) => {
  const { root } = fixture(t);
  assert.equal(run(['--now', '2026-11-16T12:00Z']).status, 2);
  const bad = run(['--job', join(root, 't0.STATUS.md')]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /is not <STATUS\.md>=<session-id>/);
});

test('backtest prints the scanner numbers and every threshold row, and exits 1 when one fails', (t) => {
  const { jobs, args } = fixture(t);
  const result = run([...jobs.flatMap((job) => ['--job', job]), ...args]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /t0\.STATUS\.md: working time first to last stamp 0\.67 h; 2 done work rows, 2 with a cost; jobs \(rows, hours\): 2, 0\.67/);
  assert.match(result.stdout, /rows with a cost: 4/);
  assert.match(result.stdout, /Replay: 4 instants over 2 handed-over jobs/);
  assert.match(result.stdout, /\| instants with a time \| 0 of 4 \| >= 60 \| FAIL \|/); // two S rows per side: below the 5-row minimum
  assert.equal(result.stdout.match(/\| (PASS|FAIL) \|$/gm).length, 12);
  assert.doesNotMatch(result.stdout, /secret/);
});

test('backtest --write-seed writes every finished row and job with its table hash and no ids or text', (t) => {
  const { root, jobs, args } = fixture(t);
  const seedFile = join(root, 'seed.json');
  run([...jobs.flatMap((job) => ['--job', job]), ...args, '--write-seed', seedFile]);
  const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
  assert.equal(seed.v, 2);
  assert.equal(seed.rows.length, 4);
  assert.deepEqual(Object.keys(seed.rows[0]), ['table', 'size', 'kind', 'done', 'cost']);
  assert.deepEqual(seed.rows.slice(0, 2).map((row) => [row.size, row.kind, row.done, row.cost]), [['S', 'build', '2026-11-16T10:20:00.000Z', 20], ['S', 'close', '2026-11-16T10:40:00.000Z', 20]]);
  assert.match(seed.rows[0].table, /^[0-9a-f]{32}$/);
  assert.notEqual(seed.rows[0].table, seed.rows[2].table);
  assert.deepEqual(seed.jobs.map((job) => [job.at, job.minutes]), [['2026-11-16T10:40:00.000Z', 40], ['2026-11-16T10:40:00.000Z', 40]]);
  assert.doesNotMatch(readFileSync(seedFile, 'utf8'), /secret|r1|r2/);
});
