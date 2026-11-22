// Tests of the road file schema and of `road.mjs check`: every lane needs a non-empty `checkpoints` list (its Done means); the guidance
// fields (threatModel, principles, keepGreen) are optional notes that only need their plain shape; appendOnly and the UI-lane matrix rule still bind. Roads are written to temp files and read through readRoad / runRoad.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readRoad } from '../home/tools/road/lib/road-file.mjs';
import { runRoad } from '../home/tools/road/road.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const THREAT = 'single owner on his own machines; agents are semi-trusted; every gate input is hash-checked';
const PRINCIPLES = [{ id: 'P3', question: 'does a missing input fail closed?' }, { id: 'F1', question: 'do two runs on one folder clash?' }];
const CHECKPOINT = { id: 'c1', run: 'node --test tests/a.test.mjs', exit: 0, files: ['tests/a.test.mjs'], kind: 'red-first' };
const lane = (name, extra = {}) => ({ name, item: `build ${name}`, size: 'S', branch: `lane/${name}`, files: [`src/${name}.mjs`], acceptanceTests: false,
  implementer: { model: 'opus', effort: 'high' }, principles: PRINCIPLES, checkpoints: [CHECKPOINT], ...extra });
const road = (lanes = [lane('a')], extra = {}) => ({ road: 'tr', goal: 'g', repo: '/repo', base: 'main', suite: 'npm test', spec: '/spec.md', threatModel: THREAT,
  steps: [{ goal: 's1', lanes }], ...extra });
const dir = makeTempDir('road-file-');
let counter = 0;
const write = (value) => {
  const file = join(dir, `road-${(counter += 1)}.json`);
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const problemsOf = (value) => readRoad(write(value)).problems;
const has = (problems, pattern) => problems.some((problem) => pattern.test(problem));

test('a complete road is accepted and readRoad returns the sha256 of the bytes it parsed', () => {
  const file = write(road([lane('a', { checkpoints: [CHECKPOINT], keepGreen: 'node --test tests/a.test.mjs' })]));
  const read = readRoad(file);
  assert.deepEqual(read.problems, []);
  assert.equal(read.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
});

test('threatModel is optional plain text: missing is accepted, a non-text value is refused', () => {
  const { threatModel, ...without } = road();
  assert.deepEqual(problemsOf(without), []);
  assert.ok(has(problemsOf(road([lane('a')], { threatModel: 7 })), /threatModel/));
  assert.ok(has(problemsOf(road([lane('a')], { threatModel: '' })), /threatModel/));
});

test('road.mjs check accepts a road without threatModel or principles (the shape of road-p8.json)', async () => {
  const { threatModel, ...without } = road([lane('a', { principles: undefined })]);
  const result = await runRoad(['check', write(without)]);
  assert.equal(result.code, 0);
});

test('principles are optional notes: ids are P<n> or F<n>, a question has 10+ characters, ids are unique, and no F is required', () => {
  assert.deepEqual(problemsOf(road([lane('a', { principles: [{ id: 'P1', question: 'a long enough question' }] })])), []);
  assert.deepEqual(problemsOf(road([lane('a', { principles: undefined })])), []);
  assert.ok(has(problemsOf(road([lane('a', { principles: 'not a list' })])), /principles must be a list/));
  assert.ok(has(problemsOf(road([lane('a', { principles: [...PRINCIPLES, { id: 'X1', question: 'a long enough question' }] })])), /X1/));
  assert.ok(has(problemsOf(road([lane('a', { principles: [{ id: 'F1', question: 'too short' }] })])), /10/));
  assert.ok(has(problemsOf(road([lane('a', { principles: [...PRINCIPLES, PRINCIPLES[1]] })])), /F1.*twice|twice.*F1/));
  assert.deepEqual(problemsOf(road([lane('a', { principles: [{ id: 'F12', question: 'ten chars!' }] })])), []);
});

test('checkpoints are the Done means: any non-empty list reads (the old object shape too), a missing, empty or non-list one is refused', async () => {
  const withCheckpoints = (checkpoints) => problemsOf(road([lane('a', { checkpoints })]));
  for (const checkpoints of [undefined, []]) assert.ok(has(withCheckpoints(checkpoints), /checkpoints must be a non-empty list/), JSON.stringify(checkpoints));
  assert.equal((await runRoad(['check', write(road([lane('a', { checkpoints: undefined })]))])).code, 1, 'road.mjs check refuses a lane without Done means');
  assert.deepEqual(withCheckpoints([CHECKPOINT]), []);
  assert.deepEqual(withCheckpoints(['the join prints joined']), []);
  assert.deepEqual(withCheckpoints([CHECKPOINT, CHECKPOINT]), []);
  assert.deepEqual(problemsOf(road([lane('a', { files: ['src/'], checkpoints: [{ ...CHECKPOINT, files: ['src/a.mjs'] }] })])), []);
  for (const checkpoints of ['text', 7, { id: 'c1' }]) assert.ok(has(withCheckpoints(checkpoints), /checkpoints must be a non-empty list/), JSON.stringify(checkpoints));
});

test('keepGreen is an optional text note: a text reads, an empty or non-text value is refused', () => {
  assert.deepEqual(problemsOf(road([lane('a', { keepGreen: 'node --test tests/road*.test.mjs' })])), []);
  assert.deepEqual(problemsOf(road([lane('a', { keepGreen: undefined })])), []);
  for (const keepGreen of ['', 7, ['x']]) assert.ok(has(problemsOf(road([lane('a', { keepGreen })])), /keepGreen/), JSON.stringify(keepGreen));
});

test('appendOnly holds repo-relative paths', () => {
  const value = { ...road(), steps: [{ goal: 's', appendOnly: ['../x'], lanes: [lane('a')] }] };
  assert.ok(has(problemsOf(value), /appendOnly/));
});

test('check: a lane with a UI file needs a matrix (a path, or "none:" and 15+ characters); a ui-implementer needs one too', async () => {
  const isUiPath = (file) => file.endsWith('.tsx');
  const check = (extra, files = ['src/x.tsx']) => runRoad(['check', write(road([lane('a', { files, ...extra })]))], { isUiPath });
  assert.equal((await check({})).code, 1);
  assert.match((await check({})).out, /matrix/);
  assert.equal((await check({ matrix: 'none: short' })).code, 1);
  assert.equal((await check({ matrix: 'none: no screens, a type-only change' })).code, 0);
  assert.equal((await check({ matrix: '/m/matrix.json' })).code, 0);
  assert.equal((await check({}, ['src/x.mjs'])).code, 0);
  assert.equal((await check({ implementer: { model: 'opus', effort: 'high', agentType: 'ui-implementer' } }, ['src/x.mjs'])).code, 1);
});
