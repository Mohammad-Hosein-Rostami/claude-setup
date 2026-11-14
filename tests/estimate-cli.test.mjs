// Tests for home/tools/estimate/estimate.mjs: the CLI contract (exit 0 estimate, 2 usage/parse naming the line, 3 refusal
// without a number, transcript windows from --transcripts). Runs the real CLI on temp files with synthetic transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIRST_ROW_LINE, LIMIT_TEXT, assistant, fiveDoneRows, jsonl, row, statusDoc, synthetic } from './estimate-fixtures.mjs';

const CLI = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const NOW = '2026-11-14T12:00:00Z';
const run = (...args) => {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { ...result, all: `${result.stdout}${result.stderr}` };
};

async function workdir(doc) {
  const dir = await mkdtemp(join(tmpdir(), 'estimate-'));
  const status = join(dir, 'STATUS.md');
  await writeFile(status, doc);
  return { dir, status };
}

test('five done items give exit 0 and the pasted block with nearest-rank hours', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })])));
  const result = run(status, '--transcripts', join(dir, 'none'), '--now', NOW);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines[0], `Estimate (computed ${NOW} by estimate.mjs from ${status})`);
  assert.equal(lines[1], 'Remaining: 1 item, 4 points (0 in flight, counted whole)');
  assert.equal(lines[2], 'Agent-hours: 4-8 (median 8)');
  assert.match(result.stdout, /usage-limit idle: not measured \(no transcripts at .*none\)/);
});

test('four done items refuse with exit 3, name the rows missing started and print no agent-hours', async () => {
  const rows = [row({ id: 'M1', doneH: 1 }), row({ id: 'M2', startedH: 1, doneH: 2 }), row({ id: 'M3', startedH: 2, doneH: 3 }), row({ id: 'M4', startedH: 3, doneH: 4 }), row({ id: 'O1' })];
  const { status } = await workdir(statusDoc(rows));
  const result = run(status, '--now', NOW);
  assert.equal(result.status, 3);
  assert.match(result.all, new RegExp(`No estimate: 3 done items with started, done and evidence; need 5\\. Missing started on: M1 \\(line ${FIRST_ROW_LINE}\\)\\.`));
  assert.doesNotMatch(result.all, /Agent-hours/);
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

test('limit windows from --transcripts reduce the hours and are counted in the From line', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows([row({ id: 'O1', size: 'L' })])));
  const projects = join(dir, 'transcripts');
  await mkdir(join(projects, 'sub', 'subagents'), { recursive: true });
  await writeFile(join(projects, 'one.jsonl'), jsonl([synthetic(11, LIMIT_TEXT), assistant(13)]));
  await writeFile(join(projects, 'two.jsonl'), jsonl([assistant(1)]));
  await writeFile(join(projects, 'sub', 'subagents', 'agent.jsonl'), jsonl([synthetic(2, LIMIT_TEXT), assistant(3)]));
  const result = run(status, '--transcripts', projects, '--now', NOW);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 limit window \(2 h\) in 2 transcripts/);
  assert.match(result.stdout, /usage-limit idle 15%/); // 2 h of a 13 h span
  assert.match(result.stdout, /^Agent-hours: 4-8 \(median 4\)$/m); // D5 loses 2 h: r = 1,1,1,2,2
});

test('nothing open prints Remaining: 0 items and exits 0', async () => {
  const { status, dir } = await workdir(statusDoc(fiveDoneRows()));
  const result = run(status, '--transcripts', dir, '--now', NOW);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Remaining: 0 items$/m);
  assert.doesNotMatch(result.stdout, /Agent-hours/);
});
