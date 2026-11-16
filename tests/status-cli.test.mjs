// Tests for home/tools/status/status.mjs: add, done, rule and decision edits of a STATUS.md (seen live: the lead made 78 hand
// edits of STATUS.md rows with python/sed). The edited table must still be readable by the estimate tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { runStatus } from '../home/tools/status/status.mjs';

const CLI = fileURLToPath(new URL('../home/tools/status/status.mjs', import.meta.url));
const NOW = '2026-11-16T14:05Z';
const LATER = '2026-11-16T15:30Z';

const PIPED = `# STATUS

## Standing rules
- keep it short

## Work items

| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| 1 | first | S | 2026-11-16T10:00Z | 2026-11-16T10:30Z | abc123 |

## Owner decisions
- 2026-11-15 earlier decision
`;

const PIPELESS = `## Work items

id | item | size | started | done | evidence
---|---|---|---|---|---
1 | first | S | 2026-11-16T10:00Z | 2026-11-16T10:30Z | abc123
deliver: | report | S | | 2026-11-16T10:31Z |
- a bullet between rows

## Owner decisions
- old
`;

async function project(text) {
  const cwd = await mkdtemp(join(tmpdir(), 'status-'));
  if (text !== undefined) await writeFile(join(cwd, 'STATUS.md'), text);
  const run = (...argv) => runStatus([...argv, '--now', argv.includes('done') ? LATER : NOW], { cwd });
  const read = () => readFile(join(cwd, 'STATUS.md'), 'utf8');
  return { cwd, run, read };
}

test('add puts a row with started = now after the last row of a piped table, and estimate still reads it', async () => {
  const { run, read } = await project(PIPED);
  assert.equal(run('add', '2', 'second item', 'M').code, 0);
  const text = await read();
  assert.match(text, /\| 1 \| first \| S \|.*\n\| 2 \| second item \| M \| 2026-11-16T14:05Z \| - \| - \|\n\n## Owner decisions/);
  const { items, problems } = parseWorkItems(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((item) => item.id), ['1', '2']);
});

test('add follows a table without outer pipes (empty cells stay empty) and goes after the last row, not after a bullet', async () => {
  const { run, read } = await project(PIPELESS);
  assert.equal(run('add', 'close:2', 'review | audit', 'S').code, 0);
  assert.match(await read(), /deliver: \| report \| S \| \| 2026-11-16T10:31Z \|\nclose:2 \| review \\\| audit \| S \| 2026-11-16T14:05Z \| \|\n- a bullet between rows/);
});

test('add refuses a repeated id (ignoring case), a bad size and missing words, and writes nothing', async () => {
  const { run, read } = await project(PIPED);
  assert.equal(run('add', '1', 'again', 'S').code, 1);
  assert.equal(run('add', '2', 'x', 'XL').code, 2);
  assert.equal(run('add', '2').code, 2);
  assert.equal(await read(), PIPED);
});

test('add creates the Work items table when the file has none', async () => {
  const { run, read } = await project('# STATUS\n');
  assert.equal(run('add', '1', 'first', 'S').code, 0);
  const { items, problems } = parseWorkItems(await read());
  assert.deepEqual(problems, []);
  assert.equal(items.length, 1);
});

test('done sets done from the clock plus evidence, and fills an empty started', async () => {
  const { run, read } = await project(PIPELESS.replace('deliver: | report | S | | 2026-11-16T10:31Z |', 'rework:3 | fix | M | | |'));
  assert.equal(run('done', 'rework:3', 'check: node --test PASS').code, 0);
  assert.match(await read(), /rework:3 \| fix \| M \| 2026-11-16T15:30Z \| 2026-11-16T15:30Z \| check: node --test PASS/);
});

test('done finds a row of a pipeless table that ends with an extra pipe (seen in a real STATUS.md)', async () => {
  const { run, read } = await project(PIPELESS.replace('- a bullet between rows', '17b | lane | M | 2026-11-16T13:06Z | | |'));
  assert.equal(run('done', '17b', 'landed').code, 0);
  assert.match(await read(), /17b \| lane \| M \| 2026-11-16T13:06Z \| 2026-11-16T15:30Z \| landed/);
});

test('done keeps the started time of a running row', async () => {
  const { run, read } = await project(PIPED.replace('| 1 | first | S | 2026-11-16T10:00Z | 2026-11-16T10:30Z | abc123 |', '| 1 | first | S | 2026-11-16T10:00Z | - | - |'));
  assert.equal(run('done', '1', 'commit', 'abc').code, 0);
  assert.match(await read(), /\| 1 \| first \| S \| 2026-11-16T10:00Z \| 2026-11-16T15:30Z \| commit abc \|/);
  assert.deepEqual(parseWorkItems(await read()).problems, []);
});

test('done never changes a done cell and refuses an unknown id or missing evidence', async () => {
  const { run, read } = await project(PIPED);
  const refused = run('done', '1', 'new evidence');
  assert.equal(refused.code, 1);
  assert.match(refused.message, /already done.*never changed/);
  assert.equal(run('done', '9', 'x').code, 1);
  assert.equal(run('done', '1').code, 2);
  assert.equal(await read(), PIPED);
});

test('rule adds a bullet at the end of Standing rules; the same rule twice is added once', async () => {
  const { run, read } = await project(PIPED);
  assert.equal(run('rule', '"no maxTurns" (owner, 2026-11-16)').code, 0);
  run('rule', '"no maxTurns" (owner, 2026-11-16)');
  assert.match(await read(), /## Standing rules\n- keep it short\n- "no maxTurns" \(owner, 2026-11-16\)\n\n## Work items/);
  assert.equal((await read()).split('no maxTurns').length, 2);
});

test('decision adds a dated bullet under Owner decisions, and both sections are created when missing', async () => {
  const { run, read } = await project(PIPED);
  assert.equal(run('decision', 'run on the PC').code, 0);
  assert.match(await read(), /- 2026-11-15 earlier decision\n- 2026-11-16 run on the PC\n$/);
  const bare = await project('# STATUS\n\n## Work items\n\n| id | item | size | started | done | evidence |\n| -- | -- | -- | -- | -- | -- |\n');
  bare.run('rule', 'a rule');
  bare.run('decision', 'a decision');
  assert.match(await bare.read(), /## Standing rules\n- a rule\n\n## Owner decisions\n- 2026-11-16 a decision\n\n## Work items/);
});

test('the CLI prints ok and exits 0, prints the refusal on stderr and exits 1, usage exits 2', async () => {
  const { cwd } = await project(PIPED);
  const cli = (...argv) => spawnSync('node', [CLI, ...argv], { cwd, encoding: 'utf8' });
  const added = cli('add', '7', 'from the cli', 'S');
  assert.equal(added.status, 0);
  assert.match(added.stdout, /add: ok/);
  const again = cli('add', '7', 'again', 'S');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /id 7 already exists/);
  assert.equal(cli().status, 2);
  assert.match(await readFile(join(cwd, 'STATUS.md'), 'utf8'), /\| 7 \| from the cli \| S \| 20\d\d-\d\d-\d\dT\d\d:\d\dZ \| - \| - \|/);
});

test('a missing STATUS.md is refused with the reason', async () => {
  const { run } = await project(undefined);
  const result = run('rule', 'x');
  assert.equal(result.code, 1);
  assert.match(result.message, /cannot read/);
});
