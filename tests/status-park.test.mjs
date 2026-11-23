// Tests for `status.mjs park` and `wait` (estimate-spec R3, R4): a row of a paused or other plan, or one waiting for the owner,
// gets `parked: <why>` or `waiting: <question>` at the head of its evidence so the estimate can leave it out; `start` clears it.
// Seen live: on the PC 26 of 27 open rows were a paused plan of another session, and the estimate counted all of them.
// Each test runs on a temp copy of a STATUS.md with a temp estimate store, never on a live file (P8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { runStatus } from '../home/tools/status/status.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/status/status.mjs', import.meta.url));
const ESTIMATE = fileURLToPath(new URL('../home/tools/estimate/estimate.mjs', import.meta.url));
const NOW = '2026-11-23T12:00Z';

const TABLE = `# STATUS

## Work items

| id | item | size | started | done | evidence |
| -- | ---- | ---- | ------- | ---- | -------- |
| 1 | own task | S | 2026-11-23T09:00Z | - | - |
| web.s1.ui | web lane | M | 2026-11-23T08:00Z | 2026-11-23T09:30Z | abc1234 |
| web.s1.check | web gate | S | - | - | - |
| web.s2.api | web api | M | 2026-11-23T10:00Z | - | notes kept |
| close:web.s2.review | review | S | - | - | - |
| webx.s1.a | another road | S | - | - | - |
| deliver:1 | deliver: first part | S | - | 2026-11-23T09:40Z | - |

## Owner decisions
- 2026-11-23 web phase later
`;

async function project(text = TABLE) {
  const cwd = makeTempDir('status-park-');
  const stateDir = makeTempDir('status-park-state-');
  await writeFile(join(cwd, 'STATUS.md'), text);
  const run = (...argv) => runStatus(argv, { cwd, now: new Date(NOW), stateDir, sessionId: '' });
  const read = () => readFile(join(cwd, 'STATUS.md'), 'utf8');
  return { cwd, run, read };
}

/** The parsed row with this id (the estimator's own reader), after asserting the table reads with no problem. */
function rowOf(text, id) {
  const { items, problems } = parseWorkItems(text, Date.parse(NOW));
  assert.deepEqual(problems, []);
  return items.find((item) => item.id === id);
}

test('park writes parked: <why> into an open row and changes nothing else; the estimator still reads it as an open row', async () => {
  const { run, read } = await project();
  const before = await read();
  assert.equal(run('park', '1', 'paused by the owner').code, 0);
  const text = await read();
  assert.equal(rowOf(text, '1').evidence, 'parked: paused by the owner');
  assert.equal(rowOf(text, '1').done, null);
  assert.equal(rowOf(text, '1').started, Date.parse('2026-11-23T09:00Z'));
  const changed = text.split('\n').filter((line, i) => line !== before.split('\n')[i]);
  assert.deepEqual(changed, ['| 1 | own task | S | 2026-11-23T09:00Z | - | parked: paused by the owner |']);
});

test('park <road> holds every open row of that road, all at once; done rows, a lookalike road and other rows stay as they were', async () => {
  const { run, read } = await project();
  const result = run('park', 'web', 'web phase later');
  assert.equal(result.code, 0);
  assert.match(result.message, /3 open rows of road web parked/);
  const text = await read();
  assert.equal(rowOf(text, 'web.s1.check').evidence, 'parked: web phase later');
  assert.equal(rowOf(text, 'close:web.s2.review').evidence, 'parked: web phase later');
  assert.equal(rowOf(text, 'web.s2.api').evidence, 'parked: web phase later; notes kept');
  assert.equal(rowOf(text, 'web.s1.ui').evidence, 'abc1234');
  assert.equal(rowOf(text, 'webx.s1.a').evidence, '');
  assert.equal(rowOf(text, '1').evidence, '');
});

test('start clears the hold: an unstarted row gets started now, a started row keeps its started cell; other evidence stays', async () => {
  const { run, read } = await project();
  assert.equal(run('park', 'web', 'later').code, 0);
  const restarted = run('start', 'web.s1.check');
  assert.equal(restarted.code, 0);
  assert.match(restarted.message, /web\.s1\.check is no longer parked/);
  assert.equal(run('start', 'web.s2.api').code, 0);
  const text = await read();
  assert.equal(rowOf(text, 'web.s1.check').evidence, '');
  assert.equal(rowOf(text, 'web.s1.check').started, Date.parse(NOW));
  assert.equal(rowOf(text, 'web.s2.api').evidence, 'notes kept');
  assert.equal(rowOf(text, 'web.s2.api').started, Date.parse('2026-11-23T10:00Z'));
  const again = run('start', 'web.s2.api');
  assert.equal(again.code, 1, 'a started row with no hold is still refused');
  assert.match(again.message, /already started/);
});

test('wait writes waiting: <question> on one row and start clears it; wait never takes a road', async () => {
  const { run, read } = await project();
  assert.equal(run('wait', '1', 'which brand name?').code, 0);
  assert.equal(rowOf(await read(), '1').evidence, 'waiting: which brand name?');
  const before = await read();
  assert.equal(run('wait', 'web', 'a road').code, 2);
  assert.equal(await read(), before);
  assert.equal(run('start', '1').code, 0);
  assert.equal(rowOf(await read(), '1').evidence, '');
});

test('a new hold replaces the old one, and park of a road keeps no waiting: text in front of it', async () => {
  const { run, read } = await project();
  assert.equal(run('wait', 'web.s2.api', 'which port?').code, 0);
  assert.equal(run('park', 'web', 'later').code, 0);
  assert.equal(run('park', '1', 'first').code, 0);
  assert.equal(run('park', '1', 'second').code, 0);
  const text = await read();
  assert.equal(rowOf(text, 'web.s2.api').evidence, 'parked: later; notes kept');
  assert.equal(rowOf(text, '1').evidence, 'parked: second');
});

test('done on a held row drops the hold, so a done row never reads as parked or waiting (F1)', async () => {
  const { run, read } = await project();
  assert.equal(run('park', 'web', 'later').code, 0);
  assert.equal(run('wait', '1', 'ok?').code, 0);
  assert.equal(run('done', 'web.s2.api', 'def5678').code, 0);
  assert.equal(run('done', '1', 'ghi9012').code, 0);
  const text = await read();
  assert.equal(rowOf(text, 'web.s2.api').evidence, 'notes kept; def5678');
  assert.equal(rowOf(text, '1').evidence, 'ghi9012');
  assert.doesNotMatch(text, /\| 20\d\d-[^|]*Z \| (parked|waiting):/, 'no row with a done stamp starts its evidence with a hold');
});

// F4: a missing or finished target exits 2 and leaves the file byte for byte.
for (const [name, argv] of [
  ['an unknown id', ['park', 'nope', 'why']],
  ['a done row', ['park', 'web.s1.ui', 'why']],
  ['a done row (wait)', ['wait', 'web.s1.ui', 'why']],
  ['a road whose rows are all done', ['park', 'old', 'why']],
  ['a hand-over row', ['park', 'deliver:1', 'why']],
  ['no why', ['park', '1']],
  ['a blank why', ['park', '1', '  \u0007 ']],
  ['no target', ['wait']],
]) {
  test(`park and wait refuse ${name} with exit 2 and change nothing`, async () => {
    const { run, read } = await project(TABLE.replace('| deliver:1', '| old.s1.a | done road | S | 2026-11-23T08:00Z | 2026-11-23T08:30Z | aaa1111 |\n| deliver:1'));
    const before = await read();
    assert.equal(run(...argv).code, 2);
    assert.equal(await read(), before);
  });
}

test('the CLI exits 2 with the reason on stderr for an unknown id, and 0 for a park', async () => {
  const { cwd, read } = await project();
  const home = makeTempDir('status-park-home-');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: '' };
  const cli = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { cwd, encoding: 'utf8', env });
  const unknown = cli('park', 'nope', 'why');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no row or road nope/);
  assert.equal(cli('park', '1', 'later').status, 0);
  assert.equal(rowOf(await read(), '1').evidence, 'parked: later');
});

// F3: hostile names and text never break the table.
test('a target with a pipe, backtick or space is refused; a name that is a row id and a road is refused, nothing written', async () => {
  const { run, read } = await project(TABLE.replace('| deliver:1', '| web | a row named like the road | S | - | - | - |\n| deliver:1'));
  const before = await read();
  for (const target of ['1|x', '`1`', '1 2', '-1']) assert.equal(run('park', target, 'why').code, 2, target);
  const both = run('park', 'web', 'why');
  assert.equal(both.code, 2);
  assert.match(both.message, /a row id and also a road/);
  assert.equal(await read(), before);
});

test('a why with pipes, a semicolon, a newline and control characters stays inside one cell and start clears all of it', async () => {
  const { run, read } = await project();
  assert.equal(run('park', 'web.s2.api', 'a | b; c\n## Heading \u001b[31m`x`').code, 0);
  const text = await read();
  assert.equal(rowOf(text, 'web.s2.api').evidence, 'parked: a | b, c ## Heading [31m`x`; notes kept');
  assert.doesNotMatch(text, /\u001b/);
  assert.equal(parseWorkItems(text).items.length, parseWorkItems(TABLE).items.length);
  assert.equal(run('start', 'web.s2.api').code, 0);
  assert.equal(rowOf(await read(), 'web.s2.api').evidence, 'notes kept');
});

test('a table without outer pipes keeps its style when a row is parked', async () => {
  const pipeless = `## Work items

id | item | size | started | done | evidence
---|---|---|---|---|---
7 | pipeless row | S | | |
`;
  const { run, read } = await project(pipeless);
  assert.equal(run('park', '7', 'later').code, 0);
  assert.match(await read(), /\n7 \| pipeless row \| S \| \| \| parked: later\n/);
});

// F2: park takes the same table lock as every other edit, so a park beside parallel adds loses no row and no hold.
const cliAsync = (cwd, home, ...argv) => new Promise((done) => {
  const child = spawn(process.execPath, [CLI, ...argv], { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: '' } });
  child.on('close', (code) => done(code));
});

test('a road park and 6 adds at the same time: every add and every hold is in the file', async () => {
  const { cwd, read } = await project();
  const home = makeTempDir('status-park-home-');
  const runs = [cliAsync(cwd, home, 'park', 'web', 'later'), ...Array.from({ length: 6 }, (_, i) => cliAsync(cwd, home, 'add', `p${i}`, `parallel ${i}`, 'S'))];
  assert.deepEqual(await Promise.all(runs), Array(7).fill(0));
  const text = await read();
  for (const id of ['web.s1.check', 'web.s2.api', 'close:web.s2.review']) assert.match(rowOf(text, id).evidence, /^parked: later/);
  for (let i = 0; i < 6; i += 1) assert.ok(rowOf(text, `p${i}`), `p${i}`);
});

test('the estimate CLI reads a parked and waiting table and exits 0 (rollback: holds are plain open-row evidence)', async () => {
  const { cwd, run } = await project();
  assert.equal(run('park', 'web', 'later').code, 0);
  assert.equal(run('wait', '1', 'which name?').code, 0);
  const home = makeTempDir('status-park-home-');
  const env = { ...process.env, TZ: 'UTC', HOME: home, USERPROFILE: home, CLAUDE_CODE_SESSION_ID: '' };
  const result = spawnSync(process.execPath, [ESTIMATE, join(cwd, 'STATUS.md'), '--now', NOW], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
});
