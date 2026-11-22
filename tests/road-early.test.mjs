// Tests of early lanes (owner FR2: fill up to 5 agents): road-state.mjs earlyLanes picks lanes of later steps that can start now, and
// `road.mjs next` prints them as `early` and `waiting` with `writers` = min(lanes + early, budget, 5); and the gate lines an early lane
// meets (road-gate.mjs line 4 for a lane landed before its step's record, line 3 for lanes in flight). Rows are built in memory and git
// is a fake `run`; the CLI case writes a road and a STATUS.md into a cs-test- temp folder and runs road.mjs with a private HOME.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gateStep } from '../home/tools/road/lib/road-gate.mjs';
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

test('R2: started early lanes keep their slots, so lanes plus early stay at most 5', () => {
  const road = roadOf([lane('a'), lane('b')], ['c', 'd', 'e', 'f', 'g'].map((name) => free(name)), [free('x'), free('y'), free('z')]);
  const three = rowsOf(road, { landed: ['a', 'b'], gated: [1], started: ['x', 'y', 'z'] });
  assert.deepEqual([stepState(road, three).lanes.map((entry) => entry.lane.name), early(road, three).early], [['c', 'd'], ['x', 'y', 'z']]);
  const one = rowsOf(road, { landed: ['a', 'b'], gated: [1], started: ['x'] });
  assert.deepEqual([stepState(road, one).lanes.length, early(road, one).early], [4, ['x']]);
  assert.match(whyOf(early(road, one), 'y'), /^no free slot/);
});

test('R4 and F1: a forged landed row of a needed lane never makes a lane early; git must show the landing on the base', () => {
  const road = roadOf([lane('a')], [free('b', { needs: ['a'] })]);
  const items = rowsOf(road, { landed: ['a'] });
  const forged = early(road, items);
  assert.deepEqual(forged.early, []);
  assert.equal(whyOf(forged, 'b'), 'needs a landed on main in git first: git does not show the landing its row records');
  const asked = [];
  const real = earlyLanes(road, items, stepState(road, items), { budget: 5, isUiPath: NO_UI, isOnBase: (sha) => asked.push(sha) > 0 });
  assert.deepEqual([real.early, asked], [['b'], ['b'.repeat(40)]], 'the sha checked is the one the landing row records');
});

const sha = (char) => char.repeat(40);
const ORDER = ['a', 'b', 'c', 'd'].map(sha); // the base's first-parent line: road start, then three landings
const gateRow = (id, done, evidence = '') => ({ id, item: id.endsWith('s1.check') ? `close: step 1 checkpoint, base ${ORDER[0]}` : id, size: 'S', started: done ?? (evidence === 'started' ? DAY : null), done, evidence: evidence === 'started' ? '' : evidence });
const landing = (to, from) => `landed ${sha(to)} on main from ${sha(from)}`;

/** A fake git and tools: the base runs a..d, `ui-proof has` names the record `at`, `changed` reports UI files for the ranges in `uiFrom`. */
function fakeGit({ at = sha('c'), uiFrom = [], tidy = { exit: 0, out: '' } } = {}) {
  const index = (text) => ORDER.indexOf(text);
  return (file, argv) => {
    if (file === 'git-tidy') return tidy;
    if (file === 'ui-proof') return argv[0] === 'has' ? { exit: 0, out: `record rd.s2 at ${at}\n` } : { exit: argv[0] === 'changed' && uiFrom.includes(argv[2]) ? 1 : 0, out: '' };
    const [command, ...rest] = argv.slice(2);
    if (command === 'rev-parse') return { exit: 0, out: `${rest.at(-1).startsWith('refs/heads/') ? ORDER.at(-1) : rest.at(-1).replace('^{commit}', '')}\n` };
    if (command === 'rev-list') { const [from, to] = rest.at(-1).split('..'); return { exit: 0, out: ORDER.slice(index(from) + 1, index(to) + 1).reverse().join('\n') }; }
    if (command === 'merge-base') return { exit: index(rest[1]) <= index(rest[2]) ? 0 : 1, out: '' };
    return { exit: 0, out: '' };
  };
}

// Step 1 lane a; step 2 lane e (needs [], landed early, before the record at c) and UI lane u (a matrix, landed after the record).
const gateRoad = roadOf([lane('a')], [free('e'), lane('u', { needs: ['a'], matrix: 'm.json', files: ['src/u.tsx'] })], [free('l')]);
const gateItems = (extra = []) => [gateRow('rd.s1.a', DAY, landing('b', 'a')), gateRow('rd.s1.check', DAY, 'PASS'), gateRow('rd.s2.e', DAY, landing('c', 'b')),
  gateRow('rd.s2.u', DAY, landing('d', 'c')), gateRow('rd.s2.check', null), ...extra];
const gateOf = (options, items = gateItems(), otherRoads = []) => gateStep(gateRoad, items, 2, fakeGit(options), { isUiPath: IS_UI, otherRoads });
const lineOf = (result, n) => result.lines.filter((line) => new RegExp(`^[A-Z]+ ${n} `).test(line)).join('\n');

test('R1: a non-UI lane that landed early, before its step\'s record, never fails line 4; a UI file it changed still does', () => {
  assert.deepEqual([early(gateRoad, [gateRow('rd.s1.a', null), gateRow('rd.s1.check', null), gateRow('rd.s2.e', null), gateRow('rd.s2.u', null)], 5, IS_UI).early], [['e']]);
  const clean = gateOf({});
  assert.match(lineOf(clean, 4), /^PASS 4 ui: visual-qa PASS/);
  assert.equal(clean.pass, true, clean.lines.join('\n'));
  assert.match(lineOf(gateOf({ uiFrom: [sha('b')] }), 4), /^FAIL 4 ui: the step-start record rd\.s2 was not taken at or before every from/);
  assert.match(lineOf(gateOf({ at: sha('d') }), 4), /^FAIL 4 ui/, 'the UI lane u still needs the record at or before its from');
});

const tidyFindings = (...findings) => ({ exit: 1, out: JSON.stringify({ base: 'main', findings, hints: [] }) });
const finding = (kind, subject, detail = '') => ({ kind, subject, detail });

test('R6: line 3 shows git-tidy findings of lanes in flight (any road) as INFO; this step\'s landed lanes and anything else FAIL', () => {
  const other = { ...roadOf([lane('o')]), road: 'ot' };
  const flying = gateItems([gateRow('rd.s3.l', null, 'started'), gateRow('ot.s1.o', null, 'started')]);
  const info = gateOf({ tidy: tidyFindings(finding('merged-branch', 'lane/l', 'dddddd0 merged'), finding('merged-worktree', '/wt/o', 'branch lane/o')) }, flying, [other]);
  assert.match(lineOf(info, 3), /^PASS 3 one git line: git-tidy check clean but for lanes in flight\nINFO 3 one git line: in flight \(rd\.s3\.l started\)/);
  assert.match(lineOf(info, 3), /INFO 3 one git line: in flight \(ot\.s1\.o started\): merged-worktree \/wt\/o branch lane\/o/);
  assert.equal(info.pass, true, info.lines.join('\n'));
  const cases = [finding('merged-branch', 'lane/e', 'cccccc0 merged'), finding('merge-commit', 'abc1234', 'Merge x'), finding('merged-branch', 'lane/o', 'x')];
  for (const one of cases) assert.match(lineOf(gateOf({ tidy: tidyFindings(one) }, flying), 3), /^FAIL 3 one git line: /, `${one.kind} ${one.subject}`);
  assert.match(lineOf(gateOf({ tidy: { exit: 1, out: 'not json' } }, flying), 3), /^FAIL 3 one git line: exit 1: not json$/);
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
