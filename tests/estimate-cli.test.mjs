// Tests for home/tools/estimate/estimate.mjs: the CLI contract (exit 0 with the Finish block on stdout, 2 usage or table problem
// naming the line, 3 refusal on stderr without a clock time), its flags and what a --now run records. Runs the real CLI on temp
// files with synthetic transcripts; the pool is the repo seed, so numbers are checked by shape and by the CLI's own consistency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_ROW_LINE, SESSION, iso, plainDoc, row, statusDoc, writeTranscript } from './estimate-tables.mjs';

const CLI = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const NOW = iso(1);
const HEADER_ROWS = ['| id | item | size | started | done | evidence |', '| -- | ---- | ---- | ------- | ---- | -------- |'];
const OPEN_ROWS = [row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'O1', startedH: 0.5 }), row({ id: 'O2', size: 'M' })];

/** A folder with a STATUS.md, a projects folder holding an hour of the session's activity, and HOME inside it. */
async function workdir(doc) {
  const dir = await mkdtemp(join(tmpdir(), 'estimate-'));
  const status = join(dir, 'STATUS.md');
  await writeFile(status, doc);
  writeTranscript(join(dir, 'projects'), SESSION, 0, 1);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', HOME: join(dir, 'home'), USERPROFILE: join(dir, 'home'), CLAUDE_CODE_SESSION_ID: '' } });
    return { ...result, all: `${result.stdout}${result.stderr}` };
  };
  return { dir, status, run, projects: ['--projects', join(dir, 'projects'), '--session', SESSION] };
}

/** Nothing that looks like an estimate: no Finish line and no clock time. */
function assertNoEstimate(result) {
  assert.doesNotMatch(result.all, /Finish:/);
  assert.doesNotMatch(result.all, /\b\d\d:\d\d\b(?!Z)/);
}

test('open rows exit 0 with the Finish block on the local clock (TZ honoured), the same at the same instant', async () => {
  const { status, run, projects } = await workdir(statusDoc(OPEN_ROWS));
  const result = run(status, '--now', NOW, ...projects);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^Finish: \w{3} \d+ Nov \d\d:\d\d \(85% sure; likely (\w{3} )?\d\d:\d\d, 95% by (\w{3} )?\d\d:\d\d; local \+00:00, now 01:00\)$/);
  assert.match(lines[1], /^Covers: 2 open rows \(1 running; 1 S, 1 M\) and work not listed yet \(usually \d+% of what is left\); (\d+ min|\d+ h \d\d) of work left in this time\.$/);
  assert.equal(lines[2], 'Excludes: pauses (nights, usage limits, waiting for you) move the time hour for hour; rework after hand-over; new requests.');
  assert.equal(lines[3], 'Held: given Tue 10 Nov 01:00, unchanged since.');
  assert.match(lines[4], /^Track record: no job scored yet; learned from \d+ finished rows and \d+ jobs\.$/);
  assert.equal(result.stderr, '');
  assert.equal(run(status, '--now', NOW, ...projects).stdout, result.stdout);
});

test('a table without outer pipes (the setup repo\'s own STATUS.md style) gives the same block', async () => {
  // One path for both: the forecast's random draws are seeded by the table id, a hash of the STATUS.md path.
  const { status, run, projects } = await workdir(statusDoc(OPEN_ROWS));
  const expected = run(status, '--now', NOW, ...projects);
  await writeFile(status, plainDoc(OPEN_ROWS));
  const result = run(status, '--now', NOW, ...projects);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split('\n').slice(1).join('\n'), expected.stdout.split('\n').slice(1).join('\n'));
});

test('a --now run without --state-dir records nothing; with it the store holds the table, the link and the activity index', async () => {
  const { dir, status, run, projects } = await workdir(statusDoc(OPEN_ROWS));
  assert.equal(run(status, '--now', NOW, ...projects).status, 0);
  assert.equal(existsSync(join(dir, 'home')), false);
  const state = join(dir, 'state');
  assert.equal(run(status, '--now', NOW, '--state-dir', state, ...projects).status, 0);
  assert.deepEqual(readdirSync(state).sort(), ['activity', 'session', 'table']);
});

test('refusals exit 3 on stderr with No finish time and What to do, never a clock time', async () => {
  const { status, run, projects } = await workdir(statusDoc([]));
  const result = run(status, '--now', NOW, ...projects);
  assert.equal(result.status, 3);
  assert.equal(result.stderr, 'No finish time: the table has no work row.\nWhat to do: list the job\'s rows with `status.mjs add`.\n');
  assert.equal(result.stdout, '');
});

test('all rows done prints Finish: now; a deliver row after them prints the hand-over', async () => {
  const done = [row({ id: 'D1', startedH: 0, doneH: 0.5 }), row({ id: 'D2', startedH: 0.5, doneH: 0.9 })];
  const allDone = await workdir(statusDoc(done));
  assert.equal(allDone.run(allDone.status, '--now', NOW, ...allDone.projects).stdout, 'Finish: now (all 2 rows are done; the hand-over is recorded when this turn ends)\n');
  const handed = await workdir(statusDoc([...done, row({ id: 'deliver:1', item: 'report', raw: { done: iso(0.95) }, evidence: '-' })]));
  const result = handed.run(handed.status, '--now', NOW, ...handed.projects);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Finish: handed over Tue 10 Nov 00:57 \(2 rows, 54 min of work\)\nTrack record: /);
});

test('a done row without evidence or started, size XL, a time without offset or later than now each exit 2 naming the line', async () => {
  const cases = [
    [row({ id: 'A', startedH: 0, doneH: 0.5, evidence: '' }), /done without evidence/],
    [row({ id: 'A', doneH: 0.5 }), /done without started/],
    [row({ id: 'A', size: 'XL' }), /size "XL"/],
    [row({ id: 'A', raw: { started: '10:45' } }), /started "10:45"/],
    [row({ id: 'A', startedH: 2 }), /started 2026-11-10T02:00Z is later than now \(2026-11-10T01:00Z\)/],
  ];
  for (const [bad, reason] of cases) {
    const { status, run, projects } = await workdir(statusDoc([row({ id: 'OK', startedH: 0, doneH: 0.5 }), bad]));
    const result = run(status, '--now', NOW, ...projects);
    assert.equal(result.status, 2, bad);
    assert.ok(result.stderr.includes(`${status}:${FIRST_ROW_LINE + 1}:`), result.stderr);
    assert.match(result.stderr, reason);
    assert.equal(result.stdout, '');
  }
});

test('a missing table, a missing file, a bad flag, a bad session and a bad --now exit 2', async () => {
  const { dir, status, run } = await workdir('# Status\n');
  assert.equal(run(status, '--now', NOW).status, 2);
  assert.equal(run(join(dir, 'absent.md'), '--now', NOW).status, 2);
  assert.equal(run().status, 2);
  assert.equal(run(status, '--bogus', 'x').status, 2);
  assert.equal(run(status, '--transcripts', dir).status, 2, 'the old flag is gone');
  assert.match(run(status, '--session', '../x', '--now', NOW).stderr, /--session "\.\.\/x" is not a session id/);
  const ok = await workdir(statusDoc(OPEN_ROWS));
  assert.equal(ok.run(ok.status, '--now', 'yesterday').status, 2);
});

test('B1: two Work items sections, a row after a text line and a work row under another heading exit 2 naming the lines', async () => {
  const two = await workdir(`${statusDoc(OPEN_ROWS)}\n## Work items\n\n${HEADER_ROWS.join('\n')}\n${row({ id: 'B1' })}\n`);
  const result = two.run(two.status, '--now', NOW);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /STATUS\.md:\d+: two Work items sections, lines 3 and \d+; keep one/);
  assertNoEstimate(result);
  const afterNote = await workdir(statusDoc([...OPEN_ROWS, 'Some note', row({ id: 'A6' })]));
  assert.match(afterNote.run(afterNote.status, '--now', NOW).stderr, /STATUS\.md:11: table row after a break at line 10; keep one table/);
  const stray = await workdir(statusDoc(OPEN_ROWS, '\n## Owner decisions\n29 | stray | M | | |\n'));
  const strayRun = stray.run(stray.status, '--now', NOW);
  assert.equal(strayRun.status, 2);
  assert.match(strayRun.stderr, /STATUS\.md:12: a work row outside the `## Work items` table; move it into the table/);
});

test('B4: an impossible date exits 2 naming the id and the cell and the accepted format', async () => {
  const { status, run } = await workdir(statusDoc([...OPEN_ROWS, row({ id: 'A9', raw: { started: '2026-02-30T08:00Z' } })]));
  const result = run(status, '--now', NOW);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /A9: started "2026-02-30T08:00Z" is not a real ISO 8601 instant; accepted: YYYY-MM-DDTHH:MM/);
  assertNoEstimate(result);
});

test('a table of 5000 rows with a UTF-8 BOM and CRLF line ends is estimated in well under 5 s', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => row({ id: `R${i}`, startedH: -i - 1, doneH: -i - 0.5 }));
  const { status, run, projects } = await workdir(`\uFEFF${statusDoc([...rows, row({ id: 'O1' })])}`.replace(/\n/g, '\r\n'));
  const began = Date.now();
  const result = run(status, '--now', NOW, ...projects);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Covers: 1 open row \(0 running; 1 S\)/m);
  assert.ok(Date.now() - began < 5000);
});
