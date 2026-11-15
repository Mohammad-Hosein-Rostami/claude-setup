// Tests for home/tools/estimate/estimate.mjs: the CLI contract (exit 0 estimate, 2 usage/parse naming the line, 3 refusal
// without a number, transcript windows from --transcripts). Runs the real CLI on temp files with synthetic transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_ROW_LINE, LIMIT_TEXT, assistant, fiveDoneRows, jsonl, row, statusDoc, synthetic } from './estimate-fixtures.mjs';

const CLI = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const NOW = '2026-11-14T12:00:00Z';
const run = (...args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }); // fixed zone: clock lines are exact
  return { ...result, all: `${result.stdout}${result.stderr}` };
};

async function workdir(doc) {
  const dir = await mkdtemp(join(tmpdir(), 'estimate-'));
  const status = join(dir, 'STATUS.md');
  await writeFile(status, doc);
  return { dir, status };
}

test('five done items give exit 0 and the Finish block on the local clock (TZ honoured), starting with a weekday', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })])));
  const result = run(status, '--transcripts', dir, '--now', NOW); // a folder with no .jsonl file
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], 'Finish: Sat 14 Nov 17:20 - Sun 15 Nov 02:30 (local +00:00, now 12:00)'); // now + 4 + 1.4 .. now + 12 + 2.5 h
  assert.equal(lines[1], 'Includes: 1 open row (0 running); build 4-12 h (O1, 1 lane), then the closing phase 1.4-2.5 h in series (review, fix rounds, recheck, landing; default, not yet measured here)');
  assert.equal(lines[5], 'Agent-hours: 4.0-12.0 for the open build rows, counted whole');
  assert.match(result.stdout, /usage-limit windows not measured \(no transcripts at .*estimate-/);
  const tehran = spawnSync(process.execPath, [CLI, status, '--transcripts', dir, '--now', NOW], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Tehran' } });
  assert.equal(tehran.stdout.split('\n')[0], 'Finish: Sat 14 Nov 20:50 - Sun 15 Nov 06:00 (local +03:30, now 15:30)');
});

test('four done items refuse with exit 3, name the rows missing started and print no agent-hours', async () => {
  const rows = [row({ id: 'M1', doneH: 1 }), row({ id: 'M2', startedH: 1, doneH: 2 }), row({ id: 'M3', startedH: 2, doneH: 3 }), row({ id: 'M4', startedH: 3, doneH: 4 }), row({ id: 'O1' })];
  const { status } = await workdir(statusDoc(rows));
  const result = run(status, '--now', NOW);
  assert.equal(result.status, 3);
  assert.match(result.all, new RegExp(`No finish time: 3 done items with started, done and evidence; need 5\\. Missing started on: M1 \\(line ${FIRST_ROW_LINE}\\)\\.\nWhat to do: `));
  assert.doesNotMatch(result.all, /Agent-hours|Finish:/);
});

test('a done row without evidence, size XL and a time without offset each exit 2 naming the line', async () => {
  const cases = [
    [row({ id: 'A', startedH: 0, doneH: 1, evidence: '' }), /done without evidence/],
    [row({ id: 'A', size: 'XL' }), /size "XL"/],
    [row({ id: 'A', raw: { started: '10:45' } }), /started "10:45"/],
  ];
  for (const [bad, reason] of cases) {
    const { status } = await workdir(statusDoc([row({ id: 'OK', startedH: 0, doneH: 1 }), bad]));
    const result = run(status, '--now', NOW);
    assert.equal(result.status, 2, bad);
    assert.ok(result.stderr.includes(`${status}:${FIRST_ROW_LINE + 1}:`), result.stderr);
    assert.match(result.stderr, reason);
    assert.equal(result.stdout, '');
  }
});

test('a missing table, a missing file, a bad flag and a bad --now exit 2', async () => {
  const noTable = await workdir('# Status\n');
  assert.equal(run(noTable.status).status, 2);
  assert.equal(run(join(noTable.dir, 'absent.md')).status, 2);
  assert.equal(run().status, 2);
  assert.equal(run(noTable.status, '--bogus', 'x').status, 2);
  const ok = await workdir(statusDoc(fiveDoneRows()));
  assert.equal(run(ok.status, '--now', 'yesterday').status, 2);
});

test('limit windows from --transcripts reduce the hours and are counted in the Assumes line', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })])));
  const projects = join(dir, 'transcripts');
  await mkdir(join(projects, 'sub', 'subagents'), { recursive: true });
  await writeFile(join(projects, 'one.jsonl'), jsonl([synthetic(11, LIMIT_TEXT), assistant(13)]));
  await writeFile(join(projects, 'two.jsonl'), jsonl([assistant(1)]));
  await writeFile(join(projects, 'sub', 'subagents', 'agent.jsonl'), jsonl([synthetic(2, LIMIT_TEXT), assistant(3)]));
  const result = run(status, '--transcripts', projects, '--now', NOW);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 limit window \(2 h\) in 2 transcripts/);
  assert.match(result.stdout, /^Assumes: the table as it is now; 1-2 h\/point \(min-max of 5 done rows, 10 Nov\);/m); // D5 loses 2 h: r = 1,1,1,2,2
  assert.match(result.stdout, /^Agent-hours: 4\.0-8\.0 for the open build rows, counted whole$/m);
});

test('nothing open after a delivery prints when it was delivered and exits 0', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'C1', item: 'close: row', startedH: 13, doneH: 14 })])));
  const result = run(status, '--transcripts', dir, '--now', NOW);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n')[0], 'Finish: delivered Tue 10 Nov 14:00 (local +00:00)');
  assert.doesNotMatch(result.stdout, /Agent-hours/);
});

// ---- Review findings of round 3: refusals reach stderr with an exit code and nothing estimate-like on stdout ----

const HEADER_ROWS = ['| id | item | size | started | done | evidence |', '| -- | ---- | ---- | ------- | ---- | -------- |'];
const assertNoEstimate = (result) => {
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.all, /Agent-hours|Finish:|Includes:/);
};

test('B1: two Work items sections and a row after a text line exit 2 naming the lines, with nothing on stdout', async () => {
  const two = await workdir(`${statusDoc(fiveDoneRows())}\n## Work items\n\n${HEADER_ROWS.join('\n')}\n${row({ id: 'B1' })}\n`);
  const result = run(two.status, '--transcripts', two.dir, '--now', NOW);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /STATUS\.md:\d+: two Work items sections, lines 3 and \d+; keep one/);
  assertNoEstimate(result);
  const afterNote = await workdir(statusDoc([...fiveDoneRows(), 'Some note', row({ id: 'A6' })]));
  const second = run(afterNote.status, '--transcripts', afterNote.dir, '--now', NOW);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /STATUS\.md:13: table row after a break at line 12; keep one table/);
  assertNoEstimate(second);
});

test('B4: an impossible date exits 2 naming the id and the cell and the accepted format', async () => {
  const { status, dir } = await workdir(statusDoc([...fiveDoneRows(), row({ id: 'A9', raw: { started: '2026-02-30T08:00Z' } })]));
  const result = run(status, '--transcripts', dir, '--now', NOW);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /A9: started "2026-02-30T08:00Z" is not a real ISO 8601 instant; accepted: YYYY-MM-DDTHH:MM/);
  assertNoEstimate(result);
});

test('B3: a done later than --now exits 3 naming the row; a --now before all the data refuses too', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'F1', startedH: 1000 })])));
  const result = run(status, '--transcripts', dir, '--now', NOW);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /Later than now \(2026-11-14T12:00Z\): F1 \(line 12\) started 2026-12-21T16:00Z/);
  assertNoEstimate(result);
  const early = run(status, '--transcripts', dir, '--now', '2026-11-01T00:00:00Z');
  assert.equal(early.status, 3);
  assertNoEstimate(early);
});

test('B2: five done items inside one usage-limit window exit 3 naming the items', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1' })])));
  const projects = join(dir, 'transcripts');
  await mkdir(projects);
  await writeFile(join(projects, 'one.jsonl'), jsonl([synthetic(-1, LIMIT_TEXT), assistant(30)]));
  const result = run(status, '--transcripts', projects, '--now', NOW);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /No working time left after removing usage-limit windows: D1 \(line 7\)/);
  assertNoEstimate(result);
});

test('S1/S2/S3: the block names the rate, the range basis with N and a note for an old table', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })])));
  const result = run(status, '--transcripts', dir, '--now', NOW);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Assumes: the table as it is now; /m);
  assert.match(result.stdout, /min-max of 5 done rows/);
  assert.match(result.stdout, /^Note: the newest started or done in the table is 4 days old \(2026-11-10T13:00Z\)/m);
});

test('S6: --transcripts that is missing, a file, or holds an unreadable or directory .jsonl exits 2 with the path and no stack trace', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1' })])));
  const missing = run(status, '--transcripts', join(dir, 'typo'), '--now', NOW);
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes(join(dir, 'typo')));
  const aFile = run(status, '--transcripts', status, '--now', NOW);
  assert.equal(aFile.status, 2);
  assert.ok(aFile.stderr.includes(status));

  const projects = join(dir, 'transcripts');
  await mkdir(join(projects, 'd.jsonl'), { recursive: true });
  const isDir = run(status, '--transcripts', projects, '--now', NOW);
  assert.equal(isDir.status, 2);
  assert.match(isDir.stderr, /cannot read transcript .*d\.jsonl: EISDIR/);
  assert.doesNotMatch(isDir.all, /\n\s+at /);

  const locked = join(dir, 'locked');
  await mkdir(locked);
  await writeFile(join(locked, 'secret.jsonl'), 'PRIVATE-TRANSCRIPT-TEXT hit your limit\n');
  await chmod(join(locked, 'secret.jsonl'), 0o000);
  const denied = run(status, '--transcripts', locked, '--now', NOW);
  if (process.getuid?.() !== 0) {
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /cannot read transcript .*secret\.jsonl: EACCES/);
  }
  assert.doesNotMatch(denied.all, /PRIVATE-TRANSCRIPT-TEXT/);
  assert.doesNotMatch(denied.all, /\n\s+at /);
  assert.equal(denied.stdout, '');
});

test('everything done with only build rows long ago exits 3 (closing overrun); no items at all exits 3', async () => {
  const done = await workdir(statusDoc(fiveDoneRows()));
  const result = run(done.status, '--transcripts', done.dir, '--now', NOW);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /^No finish time: the closing phase has run 95 h since the last build row was done \(D5, 13:00\)/);
  assert.match(result.stderr, /\nWhat to do: tell the owner the job is past its usual closing;/);
  assertNoEstimate(result);
  const empty = await workdir(statusDoc([]));
  const refused = run(empty.status, '--transcripts', empty.dir, '--now', NOW);
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /^No finish time: 0 done items with started, done and evidence; need 5\.\nWhat to do: finish and record more rows\.$/m);
  assertNoEstimate(refused);
});

test('a table of 5000 rows with a UTF-8 BOM and CRLF line ends is parsed in well under 5 s', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => row({ id: `R${i}`, startedH: i, doneH: i + 0.5 }));
  const doc = `\uFEFF${statusDoc([...rows, row({ id: 'O1' })])}`.replace(/\n/g, '\r\n');
  const { status, dir } = await workdir(doc);
  const began = Date.now();
  const result = run(status, '--transcripts', dir, '--now', '2035-01-01T00:00:00Z');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /p25-p75 of 5000 done rows/);
  assert.ok(Date.now() - began < 5000);
});
