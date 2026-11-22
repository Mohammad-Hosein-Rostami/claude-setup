// Tests of the one landed rule of a road (road-state.mjs laneLanded and landingRowId) and of its readers, in both row forms. Old form:
// the lane has a `<lane row>-land` close row in STATUS.md, and that row decides. New form (one row per lane): no close row, the lane
// row's done cell decides and its evidence holds the landed line. Readers: stepState, gate lines 1 and 2 (git faked, as in
// road-gate.test.mjs), `road.mjs rows` and the board's job facts (both in a child process with a private HOME, so nothing of the
// owner's state is touched), and the estimate's step reading.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseWorkItems } from '../home/tools/estimate/lib/items.mjs';
import { roadOf } from '../home/tools/estimate/lib/road-steps.mjs';
import { gateStep } from '../home/tools/road/lib/road-gate.mjs';
import { laneLanded, landingRowId, stepState } from '../home/tools/road/lib/road-state.mjs';
import { CLEAN_ENV, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROAD_CLI = fileURLToPath(new URL('../home/tools/road/road.mjs', import.meta.url));
const JOB_FACTS = pathToFileURL(fileURLToPath(new URL('../home/tools/board/lib/job-facts.mjs', import.meta.url))).href;
const START = 'a'.repeat(40);
const TO = 'b'.repeat(40);
const OTHER_TO = 'c'.repeat(40);
const DAY = Date.parse('2026-11-20T10:00:00Z');
const landedText = (to, from = START) => `landed ${to} on main from ${from}`;
const row = (id, evidence, done = DAY) => ({ id, item: `build: ${id}`, started: DAY, done, evidence });
const byId = (items) => new Map(items.map((item) => [item.id.toLowerCase(), item]));
const lane = (name, extra = {}) => ({ name, item: `lane ${name}`, size: 'S', branch: `lane/${name}`, files: [`${name}.mjs`], implementer: { model: 'opus', effort: 'high' }, checkpoints: ['true'], ...extra });
const ROAD = { road: 'rd', goal: 'probe the landed rule', spec: 'none', repo: '/repo', base: 'main', steps: [{ lanes: [lane('a'), lane('b')] }, { lanes: [lane('c')] }] };
const startRow = { ...row('rd.s1.check', 'x', null), item: `close: step 1 checkpoint, base ${START}` };

test('laneLanded: the close row decides when STATUS.md holds it (old form), else the lane row (new form); a missing row is not landed', () => {
  const old = byId([row('rd.s1.a', 'built'), row('rd.s1.a-land', 'x', null)]);
  assert.equal(laneLanded(old, 'rd', 1, 'a'), false, 'an open close row wins over a done lane row');
  assert.equal(landingRowId(old, 'rd', 1, 'a'), 'rd.s1.a-land');
  const fresh = byId([row('RD.S1.A', landedText(TO))]);
  assert.equal(laneLanded(fresh, 'rd', 1, 'a'), true, 'a lane row in other case is found');
  assert.equal(landingRowId(fresh, 'rd', 1, 'a'), 'rd.s1.a');
  assert.equal(laneLanded(byId([row('rd.s1.a', 'x', null)]), 'rd', 1, 'a'), false);
  assert.equal(laneLanded(new Map(), 'rd', 1, 'a'), false);
});

test('R2: a new-form lane row done without a landed line has not landed; its .landed correction row can carry the line', () => {
  assert.equal(laneLanded(byId([row('rd.s1.a', 'built, tests green')]), 'rd', 1, 'a'), false);
  assert.equal(laneLanded(byId([row('rd.s1.a', 'built'), row('rd.s1.a.landed', landedText(TO))]), 'rd', 1, 'a'), true);
  assert.equal(laneLanded(byId([row('rd.s1.a', 'built'), row('rd.s1.a-land.landed', landedText(TO))]), 'rd', 1, 'a'), false, 'the -land.landed id is not a new-form row\'s own');
});

test('R3: in an old-form road (a -land close row in STATUS.md) a lane without its close row has not landed', () => {
  const rows = byId([row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.b', landedText(OTHER_TO, TO))]);
  assert.deepEqual([laneLanded(rows, 'rd', 1, 'a'), laneLanded(rows, 'rd', 1, 'b'), landingRowId(rows, 'rd', 1, 'b')], [true, false, 'rd.s1.b-land']);
});

test('R1: a rework row whose id equals a lane\'s close id never lands that lane', () => {
  const rows = byId([row('rd.s1.fix', 'x', null), { ...row('rd.s1.fix-land', landedText(TO)), item: 'rework: land' }]);
  assert.deepEqual([laneLanded(rows, 'rd', 1, 'fix'), landingRowId(rows, 'rd', 1, 'fix')], [false, 'rd.s1.fix']);
  const road = { ...ROAD, steps: [{ lanes: [lane('fix'), lane('b')] }] };
  const items = [startRow, row('rd.s1.fix', 'x', null), { ...row('rd.s1.fix-land', landedText(TO)), item: 'rework: land' }, row('rd.s1.b', landedText(OTHER_TO, TO))];
  const result = gateStep(road, items, 1, fakeRun([TO, OTHER_TO]), { isUiPath: () => false });
  assert.ok(result.lines.includes('PASS 1 rows: 1 landed') && result.lines.includes('INFO 1 rows: carried: fix'), result.lines.join('\n'));
});

test('stepState reads both forms alike: landed lanes, carried lanes and the gate state', () => {
  const newForm = [startRow, row('rd.s1.a', landedText(TO)), row('rd.s1.b', landedText(OTHER_TO, TO))];
  assert.equal(stepState(ROAD, newForm).state, 'gate');
  const oldForm = [startRow, row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.b', 'x'), row('rd.s1.b-land', landedText(OTHER_TO, TO))];
  assert.equal(stepState(ROAD, oldForm).state, 'gate');
  const halfOld = [startRow, row('rd.s1.a', 'built'), row('rd.s1.a-land', 'x', null), row('rd.s1.b', landedText(TO))];
  const state = stepState(ROAD, halfOld);
  assert.deepEqual([state.state, state.lanes.map((entry) => entry.lane.name)], ['build', ['a', 'b']], 'an old-form road: b has no close row, so it is open (R3)');
  const carried = stepState(ROAD, [{ ...startRow, done: DAY }, row('rd.s1.a', landedText(TO)), row('rd.s1.b', 'x', null)]);
  assert.deepEqual([carried.step, carried.carried, carried.held.map((held) => held.name)], [2, ['b'], ['c']]);
});

/** A fake run (see road-gate.test.mjs): every sha in `onBase` is a clean, new, first-parent commit of the base; others are not. */
function fakeRun(onBase) {
  return (file, argv) => {
    if (file !== 'git') return { exit: 0, out: '' };
    const [command, ...rest] = argv.slice(2);
    if (command === 'rev-parse') {
      const text = rest.at(-1).replace('^{commit}', '');
      if (text.startsWith('refs/heads/')) return { exit: 0, out: `${onBase.at(-1)}\n` };
      return text.length === 40 ? { exit: 0, out: `${text}\n` } : { exit: 1, out: '' };
    }
    if (command === 'rev-list') return { exit: 0, out: rest.at(-1).startsWith(START) && rest.at(-1).endsWith(`..${onBase.at(-1)}`) ? onBase.join('\n') : `${rest.at(-1).split('..')[1]}\n` };
    if (command === 'merge-base') return { exit: rest[2] === START ? 1 : 0, out: '' };
    return { exit: 0, out: '' };
  };
}
const ONE_STEP = { ...ROAD, steps: [ROAD.steps[0]] };
const gate = (items, onBase = [TO, OTHER_TO]) => gateStep(ONE_STEP, [startRow, ...items], 1, fakeRun(onBase), { isUiPath: () => false });
const linesOf = (result, n) => result.lines.filter((line) => new RegExp(`^\\w+ ${n} `).test(line));

test('gate, new form: lane rows carrying their landed lines pass lines 1 and 2', () => {
  const result = gate([row('rd.s1.a', landedText(TO)), row('rd.s1.b', landedText(OTHER_TO, TO))]);
  assert.deepEqual([...linesOf(result, 1), ...linesOf(result, 2)], ['PASS 1 rows: 2 landed', 'PASS 2 range: 2 close rows, every commit in one range']);
  assert.equal(result.pass, true, result.lines.join('\n'));
});

test('gate, F1: a landed line typed into a lane row is still resolved and checked: a sha off the base is a FAIL', () => {
  const typed = gate([row('rd.s1.a', landedText(TO)), row('rd.s1.b', landedText('d'.repeat(40), TO))], [TO]);
  assert.equal(typed.pass, false);
  assert.ok(linesOf(typed, 2).some((line) => /^FAIL 2 range: rd\.s1\.b: .* is not on the base's first-parent line/.test(line)), typed.lines.join('\n'));
  const oldForm = gate([row('rd.s1.a', landedText(TO)), row('rd.s1.a-land', 'x', null), row('rd.s1.b', landedText(OTHER_TO, TO)), row('rd.s1.b-land', 'x', null)]);
  assert.deepEqual(linesOf(oldForm, 1), ['FAIL 1 rows: no lane of the step landed'], 'an old-form lane row line is never its landing');
  assert.ok(linesOf(oldForm, 2).some((line) => /lies in no close row's range/.test(line)), oldForm.lines.join('\n'));
});

test('gate, F4: a lane row done with empty or "obsolete" evidence is a line 2 FAIL; no rows or no table fail without a throw', () => {
  for (const evidence of ['', 'obsolete']) {
    const result = gate([row('rd.s1.a', landedText(TO)), row('rd.s1.b', evidence)], [TO]);
    assert.ok(linesOf(result, 2).includes('FAIL 2 range: rd.s1.b has no "landed <to> on <base> from <from>" evidence'), result.lines.join('\n'));
  }
  for (const items of [[], parseWorkItems('# STATUS\n\nno table here\n').items]) {
    const result = gateStep(ONE_STEP, items, 1, fakeRun([TO]), { isUiPath: () => false });
    assert.deepEqual([result.pass, result.lines.length], [false, 1]);
    assert.match(result.lines[0], /^FAIL road start tip or base tip unreadable/);
  }
});

test('gate, F5: a lane row id in other case reads; a .landed correction under both ids is the same FAIL as for a close row', () => {
  assert.equal(gate([row('RD.S1.A', landedText(TO)), row('rd.s1.B', landedText(OTHER_TO, TO))]).pass, true);
  const both = [row('rd.s1.a', landedText(TO)), row('rd.s1.b', 'by hand'), row('rd.s1.b.landed', landedText(OTHER_TO, TO)), row('rd.s1.b-land.landed', landedText(OTHER_TO, TO))];
  const result = gate(both);
  assert.ok(linesOf(result, 2).includes('FAIL 2 range: rd.s1.b has a correction row under both ids (rd.s1.b-land.landed and rd.s1.b.landed); keep one'), result.lines.join('\n'));
  const one = gate([row('rd.s1.a', landedText(TO)), row('rd.s1.b', 'by hand'), row('rd.s1.b.landed', landedText(OTHER_TO, TO))]);
  assert.equal(one.pass, true, one.lines.join('\n'));
});

test('gate: a new-form fix row lands by its own line; an old-form rework row with a -land twin is never read as a landing', () => {
  const lanes = [row('rd.s1.a', landedText(TO)), row('rd.s1.b', landedText(OTHER_TO, TO))];
  const D = 'd'.repeat(40);
  assert.equal(gate([...lanes, row('rd.s1.fix-x', landedText(D, OTHER_TO))], [TO, OTHER_TO, D]).pass, true);
  const oldLanes = [row('rd.s1.a', 'x'), row('rd.s1.a-land', landedText(TO)), row('rd.s1.b', 'x'), row('rd.s1.b-land', landedText(OTHER_TO, TO))];
  const old = gate([...oldLanes, row('rd.s1.fix-x', 'rework done'), row('rd.s1.fix-x-land', landedText(D, OTHER_TO))], [TO, OTHER_TO, D]);
  assert.match(linesOf(old, 2)[0], /^PASS 2 range: 3 close rows/, old.lines.join('\n'));
  const fixLane = { ...ONE_STEP, steps: [{ lanes: [lane('a'), lane('fix-b')] }] };
  const named = gateStep(fixLane, [startRow, row('rd.s1.a', landedText(TO)), row('rd.s1.fix-b', landedText(OTHER_TO, TO))], 1, fakeRun([TO, OTHER_TO]), { isUiPath: () => false });
  assert.equal(named.pass, true, `a lane named fix-... is one range, not two\n${named.lines.join('\n')}`);
});

test('the estimate reads new-form rows: one row per lane, the step from the check row', () => {
  const items = [startRow, row('rd.s1.a', landedText(TO)), row('rd.s1.b', 'x', null), row('rd.s2.c', 'x', null), row('rd.s2.check', 'x', null)];
  const road = roadOf(items);
  assert.deepEqual([road.road, road.steps, road.current], ['rd', 2, 1]);
  assert.deepEqual(road.rowsOf.get(1), [{ id: 'rd.s1.check', done: false }, { id: 'rd.s1.a', done: true }, { id: 'rd.s1.b', done: false }]);
});

// ---- CLI and board: child processes with a private HOME ----

/** A repo with a road file beside an empty folder for STATUS.md; the env gives the children a private HOME. */
function roadWorld(road = ROAD) {
  const repo = makeRepo();
  const folder = makeTempDir('road-state-');
  const home = makeTempDir('road-state-home-');
  const roadFile = join(folder, `road-${road.road}.json`);
  writeFileSync(roadFile, `${JSON.stringify({ ...road, repo })}\n`);
  const env = { ...CLEAN_ENV, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return { repo, folder, home, roadFile, env, statusFile: join(folder, 'STATUS.md') };
}
const rowsRun = (world, ...extra) => spawnSync(process.execPath, [ROAD_CLI, 'rows', world.roadFile, ...extra], { encoding: 'utf8', env: world.env });
const ids = (world) => parseWorkItems(readFileSync(world.statusFile, 'utf8')).items.map((item) => item.id);

test('road.mjs rows: one row per lane and one check row per step, no -land row; a second run adds 0', () => {
  const world = roadWorld();
  const first = rowsRun(world);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /road rd: 5 rows added/);
  assert.deepEqual(ids(world), ['rd.s1.a', 'rd.s1.b', 'rd.s1.check', 'rd.s2.c', 'rd.s2.check']);
  const again = rowsRun(world);
  assert.deepEqual([again.status, again.stdout.trim()], [0, 'road rd: 0 rows added']);
});

test('road.mjs rows --fix adds one rework row; a fix name ending -land is refused', () => {
  const world = roadWorld();
  rowsRun(world);
  const fix = rowsRun(world, '--fix', '1', 'tidy');
  assert.equal(fix.status, 0, fix.stderr);
  assert.match(readFileSync(world.statusFile, 'utf8'), /\| rd\.s1\.fix-tidy \| rework: tidy \| S \|/);
  assert.ok(!ids(world).some((id) => id.endsWith('-land')), ids(world).join(' '));
  assert.equal(rowsRun(world, '--fix', '1', 'tidy-land').status, 2);
});

test('R1: --fix 1 land is refused when a lane is named fix (its id would be that lane\'s close id), and always for the name land', () => {
  const world = roadWorld({ ...ROAD, steps: [{ lanes: [lane('fix'), lane('b')] }] });
  rowsRun(world);
  const refused = rowsRun(world, '--fix', '1', 'land');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  assert.ok(!ids(world).includes('rd.s1.fix-land'));
});

test('R3: rows on an old-form road keeps its form: a missing close row and a fix pair are added the old way', () => {
  const world = roadWorld();
  writeFileSync(world.statusFile, `${STATUS_HEAD}| rd.s1.a | build: lane a | S | - | - | - |\n| rd.s1.a-land | close: review and land a | M | - | - | - |\n`);
  assert.equal(rowsRun(world).status, 0);
  assert.equal(rowsRun(world, '--fix', '1', 'tidy').status, 0);
  assert.deepEqual(ids(world), ['rd.s1.a', 'rd.s1.a-land', 'rd.s1.b', 'rd.s1.b-land', 'rd.s1.check', 'rd.s2.c', 'rd.s2.c-land', 'rd.s2.check', 'rd.s1.fix-tidy', 'rd.s1.fix-tidy-land']);
});

/** `road.mjs rows <file>` in a child, started now; resolves to its exit and output. */
const rowsAsync = (world, file = world.roadFile) => new Promise((resolve) => {
  const child = spawn(process.execPath, [ROAD_CLI, 'rows', file], { env: world.env });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('close', (status) => resolve({ status, out }));
});

test('road.mjs rows, F2 and R4: two runs at once write every row once; the second adds none and exits 0', async () => {
  const world = roadWorld();
  const runs = await Promise.all([rowsAsync(world), rowsAsync(world)]);
  const added = runs.map((run) => (run.out.match(/^added /gm) ?? []).length).sort();
  assert.deepEqual(added, [0, 5], runs.map((run) => run.out).join('\n'));
  assert.deepEqual(runs.map((run) => run.status), [0, 0], runs.map((run) => run.out).join('\n'));
  assert.deepEqual(ids(world), ['rd.s1.a', 'rd.s1.b', 'rd.s1.check', 'rd.s2.c', 'rd.s2.check']);
});

test('road.mjs rows, R4: two roads started at once in one STATUS.md: only one of them gets rows', async () => {
  for (let round = 0; round < 3; round += 1) {
    const world = roadWorld();
    const other = join(world.folder, 'road-ot.json');
    writeFileSync(other, readFileSync(world.roadFile, 'utf8').replace('"road":"rd"', '"road":"ot"'));
    const runs = await Promise.all([rowsAsync(world), rowsAsync(world, other)]);
    const roads = new Set(ids(world).map((id) => id.split('.')[0]));
    assert.equal(roads.size, 1, `${[...roads].join(' ')}\n${runs.map((run) => run.out).join('\n')}`);
  }
});

const STATUS_HEAD = '# STATUS\n\n## Work items\n\n| id | item | size | started | done | evidence |\n| -- | ---- | ---- | ------- | ---- | -------- |\n';
const statusLine = (id, done, evidence = landedText(TO)) => `| ${id} | build: ${id} | S | 2026-11-20T10:00Z | ${done ? '2026-11-20T11:00Z' : '-'} | ${done ? evidence : '-'} |`;

/** jobFacts in a child with the world's HOME, its estimate cache entry pointing at step 1 of the road. */
function boardLanded(world, rows) {
  writeFileSync(world.statusFile, `${STATUS_HEAD}${rows.map(([id, done, evidence]) => statusLine(id, done, evidence)).join('\n')}\n`);
  const cache = join(world.home, '.claude', 'state', 'estimate-segment');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const entry = { path: world.statusFile, text: null, highMs: null, kind: null, mtimeMs: 0, size: 0, computedAt: 0, refreshStartedAt: 0,
    progress: { pct: 0, approx: false, rowsDone: 0, rowsTotal: 1, leftMin: null, tag: null, road: { name: 'rd', step: 1, steps: 2 } } };
  const name = createHash('sha256').update(world.statusFile).digest('hex').slice(0, 32);
  writeFileSync(join(cache, `${name}.json`), JSON.stringify(entry), { mode: 0o600 });
  const script = `import { jobFacts } from ${JSON.stringify(JOB_FACTS)}; process.stdout.write(JSON.stringify(jobFacts({ session: 'no-such-session', cwd: ${JSON.stringify(world.folder)}, cache: null, nowMs: Date.now() }).road));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: world.env });
  const road = JSON.parse(child.stdout || 'null');
  return road === null ? null : [road.lanesDone, road.lanesTotal];
}

test('the board counts landed lanes in both forms (F8)', () => {
  const world = roadWorld();
  assert.deepEqual(boardLanded(world, [['rd.s1.a', true], ['rd.s1.a-land', false], ['rd.s1.b', false], ['rd.s1.b-land', true]]), [1, 2], 'old form');
  assert.deepEqual(boardLanded(world, [['rd.s1.a', true], ['rd.s1.b', false]]), [1, 2], 'new form');
  assert.deepEqual(boardLanded(world, [['rd.s1.a', true], ['rd.s1.b', true], ['rd.s1.b-land', false]]), [0, 2], 'an old-form road: a has no close row (R3)');
  assert.deepEqual(boardLanded(world, [['rd.s1.a', true], ['rd.s1.b', true, 'built, tests green']]), [1, 2], 'a done lane row without a landed line (R2)');
});
