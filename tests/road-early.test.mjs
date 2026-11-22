// Tests of early lanes (owner FR2: fill up to 5 agents): road-state.mjs earlyLanes picks lanes of later steps that can start now, and
// `road.mjs next` prints them as `early` and `waiting` with `writers` = min(lanes + early, budget, 5). Rows are built in memory; the CLI
// case writes a road and a STATUS.md into a cs-test- temp folder and runs road.mjs in a child process with a private HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { earlyLanes, stepState } from '../home/tools/road/lib/road-state.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const ROAD_CLI = fileURLToPath(new URL('../home/tools/road/road.mjs', import.meta.url));
const START = 'a'.repeat(40);
const DAY = Date.parse('2026-11-22T10:00:00Z');
const NO_UI = () => false;
const IS_UI = (file) => file.endsWith('.tsx');

const lane = (name, extra = {}) => ({ name, item: `lane ${name}`, size: 'S', branch: `lane/${name}`, files: [`src/${name}.mjs`], implementer: { model: 'opus', effort: 'high' }, checkpoints: ['true'], ...extra });
const free = (name, extra = {}) => lane(name, { needs: [], ...extra });
const roadOf = (...steps) => ({ road: 'rd', goal: 'probe early lanes', spec: 'none', repo: '/repo', base: 'main', steps: steps.map((lanes) => (Array.isArray(lanes) ? { lanes } : lanes)) });
const openRow = (id, started = null) => ({ id, item: `build: ${id}`, size: 'S', started, done: null, evidence: '' });
const landedRow = (id) => ({ id, item: `build: ${id}`, size: 'S', started: DAY, done: DAY, evidence: `landed ${'b'.repeat(40)} on main from ${START}` });
const checkRow = (step, done = null) => ({ id: `rd.s${step}.check`, item: `close: step ${step} checkpoint${step === 1 ? `, base ${START}` : ''}`, size: 'S', started: null, done, evidence: done === null ? '' : 'PASS' });

/** Every row of the road: lanes open unless named in `landed` or `started`, check rows open unless their step is in `gated`. */
function rowsOf(road, { landed = [], started = [], gated = [] } = {}) {
  return road.steps.flatMap((step, at) => [
    ...step.lanes.map((one) => {
      const id = `rd.s${at + 1}.${one.name}`;
      return landed.includes(one.name) ? landedRow(id) : openRow(id, started.includes(one.name) ? DAY : null);
    }),
    checkRow(at + 1, gated.includes(at + 1) ? DAY : null),
  ]);
}

const early = (road, items, budget = 5, isUiPath = NO_UI) => earlyLanes(road, items, stepState(road, items), { budget, isUiPath });
const whyOf = (result, name) => result.waiting.find((entry) => entry.name === name)?.why;

test('needs [] + disjoint files fill up to budget minus current lanes', () => {
  const road = roadOf([lane('a'), lane('b')], [free('c'), free('d'), free('e'), free('f')]);
  const items = rowsOf(road);
  const five = early(road, items, 5);
  assert.deepEqual(five.early, ['c', 'd', 'e']);
  assert.deepEqual(five.waiting.map((entry) => entry.name), ['f']);
  assert.match(whyOf(five, 'f'), /^no free slot: budget 5, 2 current and 3 early lanes$/);
  assert.deepEqual(early(road, items, 3).early, ['c']);
  assert.deepEqual(early(road, items, 2).early, []);
  assert.deepEqual(early(road, items, 1).early, [], 'a budget below the current lanes gives no early lane');
});

test('omitted needs never early', () => {
  const road = roadOf([lane('a')], [lane('b'), free('c')]);
  const result = early(road, rowsOf(road));
  assert.deepEqual(result.early, ['c']);
  assert.equal(whyOf(result, 'b'), 'no needs list: it needs every earlier lane, so it waits for its step');
  const gate = early(road, rowsOf(road, { landed: ['a'] }));
  assert.equal(stepState(road, rowsOf(road, { landed: ['a'] })).state, 'gate');
  assert.deepEqual(gate.early, ['c'], 'even with every earlier lane landed, a lane without a needs list waits for its step');
});

test('a file or folder shared with an open lower-step lane (carried included) waits with why naming lane and file', () => {
  const road = roadOf(
    [lane('a', { files: ['src/tools/'] }), lane('b')],
    [lane('c'), free('d', { files: ['src/tools/x.mjs'] })],
    [free('e', { files: ['src/c.mjs'] }), free('f', { files: ['docs/a.md'] })],
  );
  const result = early(road, rowsOf(road));
  assert.equal(whyOf(result, 'd'), 'shares src/tools/x.mjs with open lane a (step 1, not landed)');
  assert.equal(whyOf(result, 'e'), 'shares src/c.mjs with open lane c (step 2, not landed)');
  assert.deepEqual(result.early, ['f']);
  // Step 1 gated with b open: b is carried into step 2 and still holds its file against a later lane.
  const carriedRoad = roadOf([lane('a'), lane('b')], [free('c', { files: ['src/b.mjs'] })], [free('d', { files: ['src/b.mjs/'] })]);
  const items = rowsOf(carriedRoad, { landed: ['a'], gated: [1] });
  assert.deepEqual(stepState(carriedRoad, items).carried, ['b']);
  const carried = early(carriedRoad, items);
  assert.equal(whyOf(carried, 'd'), 'shares src/b.mjs/ with open lane b (step 1, not landed)');
});

test('a shared appendOnly file exempts only lanes of the same step, never a lower step', () => {
  const road = roadOf(
    [lane('a', { files: ['src/a.mjs', 'docs/catalog.md'] })],
    { appendOnly: ['docs/catalog.md'], lanes: [free('b', { files: ['src/b.mjs', 'docs/catalog.md'] })] },
    { appendOnly: ['docs/catalog.md'], lanes: [free('c', { files: ['src/c.mjs', 'docs/catalog.md'] }), free('d', { files: ['src/d.mjs', 'docs/catalog.md'] })] },
  );
  const open = early(road, rowsOf(road));
  assert.equal(whyOf(open, 'b'), 'shares docs/catalog.md with open lane a (step 1, not landed)');
  const onlyA = early(road, rowsOf(road, { landed: ['a'], gated: [1] }));
  assert.equal(whyOf(onlyA, 'c'), 'shares docs/catalog.md with open lane b (step 2, not landed)', 'appendOnly of step 3 does not exempt step 2');
  const lowerLanded = rowsOf(road, { landed: ['a', 'b'], gated: [1] });
  assert.deepEqual([stepState(road, lowerLanded).step, stepState(road, lowerLanded).state], [2, 'gate']);
  assert.deepEqual(early(road, lowerLanded).early, ['c', 'd'], 'c and d share the file only with each other, in the step that lists it');
});

test('a UI lane (matrix or UI file) waits', () => {
  const road = roadOf([lane('a')], [free('b', { files: ['src/b.tsx'] }), free('c', { matrix: 'ui/matrix.md' }), free('d')]);
  const result = early(road, rowsOf(road), 5, IS_UI);
  assert.deepEqual(result.early, ['d']);
  for (const name of ['b', 'c']) assert.equal(whyOf(result, name), 'a UI lane (matrix or UI file) waits for its step');
});

test('a started early lane comes first', () => {
  const road = roadOf([lane('a'), lane('b')], [free('c'), free('d'), free('e')], [free('f')]);
  const result = early(road, rowsOf(road, { started: ['f'] }));
  assert.deepEqual(result.early, ['f', 'c', 'd']);
  assert.match(whyOf(result, 'e'), /^no free slot/);
});

test('F6: a started early lane whose writer died is never dropped when the budget shrinks', () => {
  const road = roadOf([lane('a'), lane('b')], [free('c'), free('d'), free('e')]);
  const items = rowsOf(road, { started: ['d', 'e'] });
  assert.deepEqual(early(road, items, 5).early, ['d', 'e', 'c']);
  assert.deepEqual(early(road, items, 3).early, ['d', 'e'], 'the started lanes stay; no new lane is added');
  assert.deepEqual(early(road, items, 1).early, ['d', 'e']);
});

test('state done gives early []', () => {
  const road = roadOf([lane('a')], [free('b')]);
  const items = rowsOf(road, { landed: ['a', 'b'], gated: [1, 2] });
  assert.equal(stepState(road, items).state, 'done');
  assert.deepEqual(early(road, items), { early: [], waiting: [] });
  const one = roadOf([lane('a'), lane('b')]);
  assert.deepEqual(early(one, rowsOf(one)), { early: [], waiting: [] }, 'a one-step road has no later lane');
});

test('P3 and F1: a missing row, a bad needs entry, an unlanded need or a started row never makes a lane early', () => {
  const road = roadOf([lane('a'), lane('b')], [free('c', { needs: ['a'] }), free('d', { needs: ['ghost'] }), free('e'), free('g', { needs: 'a' })]);
  const items = rowsOf(road, { landed: ['b'], started: ['c', 'd'] }).filter((row) => row.id !== 'rd.s2.e');
  const result = early(road, items);
  assert.deepEqual(result.early, []);
  assert.equal(whyOf(result, 'c'), 'needs a landed first');
  assert.equal(whyOf(result, 'd'), 'needs ghost: not a lane of an earlier step');
  assert.equal(whyOf(result, 'e'), 'no row rd.s2.e in STATUS.md: run rows first');
  assert.equal(whyOf(result, 'g'), 'no needs list: it needs every earlier lane, so it waits for its step');
  const sameStep = roadOf([lane('a')], [free('b'), free('c', { needs: ['b'] })]);
  assert.equal(whyOf(early(sameStep, rowsOf(sameStep)), 'c'), 'needs b: not a lane of an earlier step', 'a need in the same step is refused');
  const stray = [...rowsOf(road, { landed: ['b'] }), { ...landedRow('rd.s1.ghost') }];
  assert.equal(whyOf(early(road, stray), 'd'), 'needs ghost: not a lane of an earlier step', 'a row a writer added is no lane');
});

test('F1: a forged started row on a lane that shares a file blocks, never skips the file check', () => {
  const road = roadOf([lane('a')], [free('b', { files: ['src/x.mjs'] })], [free('c', { files: ['src/X.mjs'] }), free('d')]);
  const result = early(road, rowsOf(road, { started: ['b', 'c'] }));
  assert.deepEqual(result.early, ['d']);
  assert.equal(whyOf(result, 'b'), 'shares src/x.mjs with started lane c (step 3, not landed)');
  assert.equal(whyOf(result, 'c'), 'shares src/X.mjs with open lane b (step 2, not landed)');
});

test('F4: a folder entry, a trailing slash, a backslash path, odd parts and case all count as a share; a path leaving the repo shares everything', () => {
  const cases = [
    ['home/tools/', 'home/tools/road/x.mjs'],
    ['home/tools', 'home/tools/'],
    ['home\\tools\\road.mjs', 'home/tools/road.mjs'],
    ['./home//tools/./road.mjs', 'home/tools/road.mjs'],
    ['Home/Tools/Road.mjs', 'home/tools/road.mjs'],
    ['../outside.mjs', 'src/anything.mjs'],
    ['/abs/path.mjs', 'src/anything.mjs'],
    ['C:\\repo\\x.mjs', 'src/anything.mjs'],
    ['.', 'src/anything.mjs'],
  ];
  for (const [lower, upper] of cases) {
    const road = roadOf([lane('a', { files: [lower] })], [free('b', { files: [upper] })]);
    assert.match(whyOf(early(road, rowsOf(road)), 'b') ?? 'early', /^shares /, `${lower} against ${upper}`);
  }
  const apart = roadOf([lane('a', { files: ['home/tools.mjs'] })], [free('b', { files: ['home/tools/x.mjs', 'home/tool'] })]);
  assert.deepEqual(early(apart, rowsOf(apart)).early, ['b'], 'a name that only starts like another is no share');
});

test('F5: lanes that all landed early leave their step to the gate once it is current; 40 lanes in 8 steps stay at 5 writers', () => {
  const road = roadOf([lane('a')], [free('b'), free('c')]);
  assert.deepEqual(early(road, rowsOf(road)).early, ['b', 'c']);
  const items = rowsOf(road, { landed: ['a', 'b', 'c'], gated: [1] });
  assert.deepEqual([stepState(road, items).step, stepState(road, items).state], [2, 'gate']);
  const big = roadOf(...Array.from({ length: 8 }, (_, step) => Array.from({ length: 5 }, (__, at) => free(`l${step}-${at}`))));
  const bigItems = rowsOf(big);
  const result = early(big, bigItems);
  assert.equal(stepState(big, bigItems).lanes.length, 5);
  assert.deepEqual([result.early.length, result.waiting.length], [0, 35]);
  const half = early(big, bigItems.filter((row) => !/^rd\.s1\.l0-[0-2]$/.test(row.id)).concat(['l0-0', 'l0-1', 'l0-2'].map((name) => landedRow(`rd.s1.${name}`))));
  assert.deepEqual(half.early, ['l1-0', 'l1-1', 'l1-2']);
});

test('F2 and F3: earlyLanes is pure and stepState keeps its exact return shape', () => {
  const road = roadOf([lane('a'), lane('b')], [free('c')]);
  const items = rowsOf(road);
  const frozen = structuredClone(items);
  const first = early(road, items);
  assert.deepEqual(early(road, items), first);
  assert.deepEqual(items, frozen, 'the rows are not changed');
  assert.deepEqual(Object.keys(stepState(road, items)), ['step', 'of', 'state', 'form', 'lanes', 'held', 'carried', 'started']);
});

/** A road file and its STATUS.md in a temp folder, written as the tools write them. */
function writeWorld(road, items) {
  const folder = makeTempDir('road-early-');
  const roadFile = join(folder, `road-${road.road}.json`);
  writeFileSync(roadFile, `${JSON.stringify(road)}\n`);
  const cell = (value) => (value === null ? '-' : typeof value === 'number' ? new Date(value).toISOString().slice(0, 16) + 'Z' : value || '-');
  const table = items.map((row) => `| ${row.id} | ${row.item} | ${row.size} | ${cell(row.started)} | ${cell(row.done)} | ${cell(row.evidence)} |`);
  writeFileSync(join(folder, 'STATUS.md'), ['# STATUS', '', '## Work items', '', '| id | item | size | started | done | evidence |', '| -- | -- | -- | -- | -- | -- |', ...table, ''].join('\n'));
  return { roadFile, home: makeTempDir('road-early-home-') };
}

test('road.mjs next: 2 open step-1 lanes and 4 independent step-2 lanes give 3 early and 5 writers; old keys stay', () => {
  const road = roadOf([lane('a'), lane('b')], [free('c'), free('d'), free('e'), free('f')]);
  const world = writeWorld(road, rowsOf(road));
  const run = spawnSync(process.execPath, [ROAD_CLI, 'next', world.roadFile, '--budget', '5'], { encoding: 'utf8', env: { ...process.env, HOME: world.home, USERPROFILE: world.home } });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual([result.lanes, result.early, result.writers, result.baseline], [['a', 'b'], ['c', 'd', 'e'], 5, 'no']);
  assert.deepEqual(result.waiting, [{ name: 'f', why: 'no free slot: budget 5, 2 current and 3 early lanes' }]);
  for (const key of ['road', 'step', 'of', 'state', 'form', 'held', 'carried']) assert.ok(key in result, key);
});
