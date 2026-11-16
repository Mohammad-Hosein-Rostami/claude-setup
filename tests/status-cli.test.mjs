// Tests for home/tools/status/status.mjs: add, start, done, deliver, rule and decision edits of a STATUS.md (seen live: the lead
// made 78 hand edits of STATUS.md rows with python/sed). The edited table must still be readable by the estimate tool, and every
// edit records the table for the estimator (noteTable) without ever failing because of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { linkedStatusPath, readAllTables } from '../home/tools/estimate/lib/table-store.mjs';
import { runStatus } from '../home/tools/status/status.mjs';
import { MAX_STATUS_BYTES } from '../home/tools/status/status-file.mjs';

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
  const stateDir = await mkdtemp(join(tmpdir(), 'status-state-'));
  if (text !== undefined) await writeFile(join(cwd, 'STATUS.md'), text);
  const run = (...argv) => runStatus(argv, { cwd, now: new Date(argv.includes('done') ? LATER : NOW), stateDir });
  const read = () => readFile(join(cwd, 'STATUS.md'), 'utf8');
  return { cwd, run, read, stateDir };
}

/** The CLI with its own home folder, so its noteTable writes land in a temp store and never in the real one. */
async function cliIn(cwd) {
  const home = await mkdtemp(join(tmpdir(), 'status-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return (...argv) => spawnSync('node', [CLI, ...argv], { cwd, encoding: 'utf8', env });
}

test('add puts a row with started empty after the last row of a piped table, and estimate still reads it', async () => {
  const { run, read } = await project(PIPED);
  assert.equal(run('add', '2', 'second item', 'M').code, 0);
  const text = await read();
  assert.match(text, /\| 1 \| first \| S \|.*\n\| 2 \| second item \| M \| - \| - \| - \|\n\n## Owner decisions/);
  const { items, problems } = parseWorkItems(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((item) => item.id), ['1', '2']);
});

test('add follows a table without outer pipes (empty cells stay empty) and goes after the last row, not after a bullet', async () => {
  const { run, read } = await project(PIPELESS);
  assert.equal(run('add', 'close:2', 'review | audit', 'S').code, 0);
  assert.match(await read(), /deliver: \| report \| S \| \| 2026-11-16T10:31Z \|\nclose:2 \| review \\\| audit \| S \| \| \|\n- a bullet between rows/);
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
  const cli = await cliIn(cwd);
  const added = cli('add', '7', 'from the cli', 'S');
  assert.equal(added.status, 0);
  assert.match(added.stdout, /add: ok/);
  const again = cli('add', '7', 'again', 'S');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /id 7 already exists/);
  assert.equal(cli().status, 2);
  assert.equal(cli('start', '7').status, 0);
  assert.match(await readFile(join(cwd, 'STATUS.md'), 'utf8'), /\| 7 \| from the cli \| S \| 20\d\d-\d\d-\d\dT\d\d:\d\dZ \| - \| - \|/);
});

test('a missing STATUS.md is refused with the reason', async () => {
  const { run } = await project(undefined);
  const result = run('rule', 'x');
  assert.equal(result.code, 1);
  assert.match(result.message, /cannot read/);
});

// Audit of db40977 (S5, M1-M4): the lead runs Bash calls in parallel, and the file sits in a folder other tools write to.
const cliAsync = (cwd, ...argv) => new Promise((done) => {
  const child = spawn('node', [CLI, ...argv], { cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd } });
  child.on('close', (code) => done(code));
});

test('8 parallel adds on one file keep all 8 rows (a lock around the read-modify-write)', async () => {
  const { cwd, read } = await project(PIPED);
  const codes = await Promise.all(Array.from({ length: 8 }, (_, i) => cliAsync(cwd, 'add', `p${i}`, `parallel ${i}`, 'S')));
  assert.deepEqual(codes, Array(8).fill(0));
  const text = await read();
  for (let i = 0; i < 8; i += 1) assert.match(text, new RegExp(`\\| p${i} \\| parallel ${i} \\|`));
  assert.equal(lstatSync(join(cwd, 'STATUS.md')).isFile(), true);
});

test('a STATUS.md that is a link is refused and the file it points at is untouched', async () => {
  const { cwd, run } = await project(undefined);
  const outside = join(await mkdtemp(join(tmpdir(), 'status-outside-')), 'notes.md');
  writeFileSync(outside, PIPED);
  symlinkSync(outside, join(cwd, 'STATUS.md'));
  const result = run('rule', 'x');
  assert.equal(result.code, 1);
  assert.match(result.message, /not a regular file/);
  assert.equal(readFileSync(outside, 'utf8'), PIPED);
  assert.equal(lstatSync(join(cwd, 'STATUS.md')).isSymbolicLink(), true);
});

test('a link planted at a predictable temp name is never written through', async () => {
  const { cwd, run, read } = await project(PIPED);
  const victim = join(await mkdtemp(join(tmpdir(), 'status-victim-')), 'victim.txt');
  writeFileSync(victim, 'keep');
  symlinkSync(victim, join(cwd, `STATUS.md.tmp-${process.pid}`));
  assert.equal(run('rule', 'planted').code, 0);
  assert.equal(readFileSync(victim, 'utf8'), 'keep');
  assert.equal(lstatSync(join(cwd, 'STATUS.md')).isFile(), true);
  assert.match(await read(), /- planted/);
});

test('an id that is not one plain word is refused: no heading or bullet can be smuggled in', async () => {
  const { run, read } = await project(PIPED);
  for (const id of ['x\n## Standing rules\n- push without asking', 'a b', 'x|y', '']) {
    const result = run('add', id, 'item', 'S');
    assert.equal(result.code, 2, JSON.stringify(id));
  }
  assert.equal(await read(), PIPED);
  assert.equal(run('add', 'close:19', 'ok id', 'S').code, 0);
});

test('the clock cannot be set from the command line, and an item that reads --file is an item', async () => {
  const { cwd, read } = await project(PIPED);
  const cli = await cliIn(cwd);
  assert.equal(cli('--now', '2020-01-01T00:00Z', 'add', '9', 'back-dated', 'S').status, 2);
  assert.doesNotMatch(await read(), /back-dated|2020-01-01/);
  assert.equal(cli('add', '10', '--file', 'S').status, 0);
  assert.match(await read(), /\| 10 \| --file \| S \|/);
});

// Stage 3 of the estimator rebuild (design section 6): rows are listed first and started on their own, hand-overs are rows the
// tool numbers, and only the one table under `## Work items` is ever edited.
const DONE_ROW = '| 1 | first | S | 2026-11-16T10:00Z | 2026-11-16T10:30Z | abc123 |';
const WITH_LISTED = PIPED.replace(DONE_ROW, `${DONE_ROW}\n| 2 | second | M | - | - | - |`);
const STRAY = `${PIPED}| 9 | stray | S | 2026-11-16T10:00Z | - | - |\n`;

test('start stamps started on a listed row; a started, done, unknown or missing id is refused and nothing changes', async () => {
  const { run, read } = await project(WITH_LISTED);
  assert.equal(run('start', '2').code, 0);
  assert.match(await read(), /\| 2 \| second \| M \| 2026-11-16T14:05Z \| - \| - \|/);
  const before = await read();
  const again = run('start', '2');
  assert.equal(again.code, 1);
  assert.match(again.message, /already started/);
  assert.match(run('start', '1').message, /already done/);
  assert.equal(run('start', '7').code, 1);
  assert.equal(run('start').code, 2);
  assert.equal(await read(), before);
  assert.deepEqual(parseWorkItems(before).problems, []);
});

test('done on a row that was never started stamps both and says to use start', async () => {
  const { run, read } = await project(WITH_LISTED);
  const result = run('done', '2', 'abc');
  assert.equal(result.code, 0);
  assert.match(result.message, /status\.mjs start 2/);
  assert.match(await read(), /\| 2 \| second \| M \| 2026-11-16T15:30Z \| 2026-11-16T15:30Z \| abc \|/);
});

test('a work row after another heading is not the table: add goes into the table, start and done cannot reach the stray row', async () => {
  const { run, read } = await project(STRAY);
  assert.equal(run('add', '2', 'listed', 'S').code, 0);
  assert.match(await read(), /\| 1 \| first .*\n\| 2 \| listed \| S \| - \| - \| - \|\n\n## Owner decisions/);
  assert.match(run('start', '9').message, /no row with id 9/);
  assert.match(run('done', '9', 'x').message, /no row with id 9/);
  const { problems } = parseWorkItems(await read());
  assert.deepEqual(problems.map((problem) => problem.line), [15]);
  assert.match(problems[0].reason, /outside the `## Work items` table/);
});

test('add refuses ids that start deliver: in any case; they are reserved for hand-overs', async () => {
  const { run, read } = await project(PIPED);
  for (const id of ['deliver:3', 'Deliver:x', 'deliver:']) {
    const result = run('add', id, 'report', 'S');
    assert.equal(result.code, 1, id);
    assert.match(result.message, /reserved.*status\.mjs deliver/);
  }
  assert.equal(await read(), PIPED);
});

test('deliver writes deliver:N rows numbered after the highest one, readable in either pipe style', async () => {
  const piped = await project(PIPED);
  assert.equal(piped.run('deliver', 'first part').code, 0);
  assert.equal(piped.run('deliver', 'second part').code, 0);
  const text = await piped.read();
  assert.match(text, /\| deliver:1 \| deliver: first part \| S \| - \| 2026-11-16T14:05Z \| - \|\n\| deliver:2 \| deliver: second part \| S \| - \| 2026-11-16T14:05Z \| - \|\n\n## Owner decisions/);
  assert.deepEqual(parseWorkItems(text).problems, []);
  assert.deepEqual(parseWorkItems(text).items.map((item) => item.kind), ['build', 'deliver', 'deliver']);
  const bare = await project(PIPELESS.replace('- a bullet between rows', 'deliver:3 | older | S | | 2026-11-16T11:00Z |'));
  assert.equal(bare.run('deliver', 'report').code, 0);
  const bareText = await bare.read();
  assert.match(bareText, /deliver:3 \| older \| S \| \| 2026-11-16T11:00Z \|\ndeliver:4 \| deliver: report \| S \| \| 2026-11-16T14:05Z \|\n/);
  assert.deepEqual(parseWorkItems(bareText).problems, []);
  assert.equal(piped.run('deliver').code, 2);
  assert.equal(piped.run('deliver', ' ').code, 2);
});

const AUTO_CASES = [
  ['a running row', PIPED.replace('2026-11-16T10:30Z | abc123 |', '- | - |'), /open/],
  ['a listed row not started', PIPED.replace('2026-11-16T10:30Z | abc123 |', '2026-11-16T10:30Z | abc123 |\n| 2 | next | S | - | - | - |'), /open/],
  ['no row done since the last hand-over', PIPED.replace('abc123 |', 'abc123 |\n| deliver:1 | deliver: report | S | - | 2026-11-16T10:30Z | - |'), /since the last hand-over/],
  ['no work row at all', '## Work items\n\n| id | item | size | started | done | evidence |\n| -- | -- | -- | -- | -- | -- |\n', /since the last hand-over/],
  ['a table with a problem', STRAY.replace('| 9 | stray | S | 2026-11-16T10:00Z | - | - |', '| 9 | stray | S | 2026-11-16T10:00Z | 2026-11-16T10:20Z | x9 |'), /line 14/],
];

for (const [name, text, reason] of AUTO_CASES) {
  test(`deliver --auto writes nothing with ${name}`, async () => {
    const { run, read } = await project(text);
    const result = run('deliver', '--auto');
    assert.equal(result.code, 0);
    assert.match(result.message, reason);
    assert.equal(await read(), text);
  });
}

test('deliver --auto writes one row when nothing is open and a row was done after the last hand-over, and only once', async () => {
  const text = PIPED.replace('abc123 |', 'abc123 |\n| deliver:1 | deliver: report | S | - | 2026-11-16T10:30Z | - |\n| 2 | more | S | 2026-11-16T11:00Z | 2026-11-16T12:00Z | def456 |');
  const { run, read } = await project(text);
  assert.equal(run('deliver', '--auto').code, 0);
  const written = await read();
  assert.match(written, /\| 2 \| more .*\n\| deliver:2 \| deliver: turn ended with no open row \| S \| - \| 2026-11-16T14:05Z \| - \|\n/);
  assert.deepEqual(parseWorkItems(written).problems, []);
  assert.match(run('deliver', '--auto').message, /since the last hand-over/);
  assert.equal(await read(), written);
  assert.equal(run('deliver', '--auto', 'extra').code, 2);
});

test('every edit records the table for the estimator and links the session to this STATUS.md', async () => {
  const { cwd, stateDir } = await project(PIPED);
  const result = runStatus(['add', '2', 'listed', 'S'], { cwd, now: new Date(NOW), stateDir, sessionId: 'session-a' });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.message, /not recorded/);
  assert.equal(linkedStatusPath(stateDir, 'session-a'), realpathSync(join(cwd, 'STATUS.md')));
  const [table] = readAllTables(stateDir);
  assert.deepEqual(table.sessions, ['session-a']);
  assert.deepEqual(Object.keys(table.added), ['1', '2']);
});

test('a store that cannot be written is a note in the message, never a failed edit', async () => {
  const { cwd, read } = await project(PIPED);
  const blocked = join(await mkdtemp(join(tmpdir(), 'status-blocked-')), 'not-a-folder');
  writeFileSync(blocked, 'a file where the store folder should be');
  const result = runStatus(['add', '2', 'listed', 'S'], { cwd, now: new Date(NOW), stateDir: blocked, sessionId: 'session-a' });
  assert.equal(result.code, 0);
  assert.match(result.message, /^add: ok .*not recorded for the estimate/);
  assert.match(await read(), /\| 2 \| listed \|/);
});

// Audit of 768f9aa (SF2, M2-M4): the tool sees the same table as the estimator, its lock never takes another tool's file name, an
// item cannot make a row a hand-over, and the file is read through one handle that is checked again.
const FENCED_EXAMPLE = `# STATUS

An example of the table:

\`\`\`
## Work items

| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| 1 | example | S | - | - | - |
\`\`\`

${PIPED.replace('# STATUS\n\n', '')}`;

test('a fenced example table above the real section: add, start, done and deliver change only the real table', async () => {
  const { run, read } = await project(FENCED_EXAMPLE);
  const fence = FENCED_EXAMPLE.slice(0, FENCED_EXAMPLE.indexOf('## Standing rules'));
  assert.equal(run('add', '2', 'listed', 'S').code, 0);
  assert.equal(run('start', '2').code, 0);
  assert.equal(run('done', '2', 'def456').code, 0);
  assert.equal(run('deliver', 'report').code, 0);
  assert.equal(run('done', '1', 'x').code, 1); // row 1 of the real table is done; the example's open row 1 is out of reach
  const text = await read();
  assert.ok(text.startsWith(fence), 'the fenced example is unchanged');
  const { items, problems } = parseWorkItems(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((item) => item.id), ['1', '2', 'deliver:1']);
});

test('rule and decision skip a fenced heading of the same name', async () => {
  const fenced = `\`\`\`\n## Standing rules\n## Owner decisions\n\`\`\`\n\n${PIPED}`;
  const { run, read } = await project(fenced);
  assert.equal(run('rule', 'new rule').code, 0);
  assert.equal(run('decision', 'new decision').code, 0);
  const text = await read();
  assert.ok(text.startsWith('```\n## Standing rules\n## Owner decisions\n```\n'));
  assert.match(text, /- keep it short\n- new rule\n/);
  assert.match(text, /- 2026-11-15 earlier decision\n- 2026-11-16 new decision\n/);
});

test('add refuses an item that starts deliver: (only deliver writes hand-overs) and an id that does not start with a letter or digit', async () => {
  const { run, read } = await project(PIPED);
  for (const item of ['deliver: report to owner', '  Deliver:x']) {
    const result = run('add', '7', item, 'S');
    assert.equal(result.code, 1, item);
    assert.match(result.message, /deliver:.*status\.mjs deliver/);
  }
  for (const id of ['-', '.x', ':a', '_a', '-7']) assert.equal(run('add', id, 'dash id', 'S').code, 2, id);
  assert.equal(await read(), PIPED);
  for (const id of ['close:22', 'rework:7', '21a', 'a_b.c-d']) assert.equal(run('add', id, `ok ${id}`, 'S').code, 0, id);
  assert.deepEqual(parseWorkItems(await read()).problems, []);
});

test('the lock never uses another tool\'s file name: an old uv.lock next to uv.md stays, and no lock is left behind', async () => {
  const { cwd, stateDir } = await project(undefined);
  writeFileSync(join(cwd, 'uv.md'), PIPED);
  writeFileSync(join(cwd, 'uv.lock'), 'version = 1\n');
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(join(cwd, 'uv.lock'), minuteAgo, minuteAgo);
  const result = runStatus(['--file', 'uv.md', 'add', '2', 'listed', 'S'], { cwd, now: new Date(NOW), stateDir });
  assert.equal(result.code, 0, result.message);
  assert.equal(readFileSync(join(cwd, 'uv.lock'), 'utf8'), 'version = 1\n');
  assert.deepEqual(readdirSync(cwd).sort(), ['uv.lock', 'uv.md']);
});

test('a STATUS.md over the size cap is refused and left as it is', async () => {
  const big = `${PIPED}${'x'.repeat(MAX_STATUS_BYTES)}\n`;
  const { run, read } = await project(big);
  const result = run('rule', 'x');
  assert.equal(result.code, 1);
  assert.match(result.message, /over/);
  assert.equal(await read(), big);
});

// Audit of 75af2e9 (S2): a fenced example INSIDE the real section, above its header, must not be taken for the table either.
const FENCE_IN_SECTION = PIPED.replace('## Work items\n\n', `## Work items

An example row:

\`\`\`
| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| 9 | example | S | - | - | - |
\`\`\`

`);

test('a fenced example inside the Work items section, above the header: add, start, done and deliver change only the real table', async () => {
  const { run, read } = await project(FENCE_IN_SECTION);
  const fence = FENCE_IN_SECTION.slice(0, FENCE_IN_SECTION.indexOf('```\n\n|') + 4);
  assert.equal(run('add', '2', 'listed', 'S').code, 0);
  assert.equal(run('start', '2').code, 0);
  assert.equal(run('done', '2', 'def456').code, 0);
  assert.equal(run('deliver', 'report').code, 0);
  assert.equal(run('start', '9').code, 1); // the example's row is out of reach
  const text = await read();
  assert.ok(text.startsWith(fence), 'the fenced example is unchanged');
  const { items, problems } = parseWorkItems(text);
  assert.deepEqual(problems, []);
  assert.deepEqual(items.map((item) => item.id), ['1', '2', 'deliver:1']);
});

// Audit of 75af2e9 (m2): with a code fence above the section that is never closed, the estimator sees no section; each add used to
// append a new `## Work items` at the end, inside the open fence, and print ok. A new section there would be hidden, so it is refused.
const UNCLOSED_FENCE = `# STATUS\n\n\`\`\`\nan example that was never closed\n\n${PIPED.replace('# STATUS\n\n', '')}`;

test('an unclosed code fence above the section: add, deliver, rule and decision are refused with its line, nothing written', async () => {
  const { run, read } = await project(UNCLOSED_FENCE);
  for (const argv of [['add', '2', 'listed', 'S'], ['deliver', 'report'], ['rule', 'x'], ['decision', 'y']]) {
    const result = run(...argv);
    assert.equal(result.code, 1, argv.join(' '));
    assert.match(result.message, /unclosed code fence at line 3/, argv.join(' '));
  }
  const auto = run('deliver', '--auto'); // the estimator finds no table, so no hand-over is due: a skip, as for any table problem
  assert.deepEqual([auto.code, /nothing recorded/.test(auto.message)], [0, true], auto.message);
  assert.equal(await read(), UNCLOSED_FENCE);
});

// Review of 75af2e9: the same-bullet check looked at every line, so a rule quoted in a code fence was never added to the section.
test('rule adds a bullet that only appears inside a code fence elsewhere in the file', async () => {
  const quoted = `\`\`\`\n- keep going\n\`\`\`\n\n${PIPED}`;
  const { run, read } = await project(quoted);
  assert.equal(run('rule', 'keep going').code, 0);
  assert.match(await read(), /## Standing rules\n- keep it short\n- keep going\n/);
});

test('add makes a new Work items section after one blank line and ends the file with a newline', async () => {
  const { run, read } = await project('# STATUS\n');
  assert.equal(run('add', '1', 'first', 'S').code, 0);
  assert.equal(await read(), '# STATUS\n\n## Work items\n\n| id | item | size | started | done | evidence |\n| -- | -- | -- | -- | -- | -- |\n| 1 | first | S | - | - | - |\n');
  const empty = await project('');
  assert.equal(empty.run('add', '1', 'first', 'S').code, 0);
  assert.ok((await empty.read()).startsWith('## Work items\n'), 'an empty file gets no leading blank line');
});
