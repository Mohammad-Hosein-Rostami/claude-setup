// Tests of the road file schema (plan.md C6) and of `road.mjs check`: threat model, F ids, the checkpoint schema, unique ids, locked
// checkpoint files, keepGreen and the UI-lane matrix rule. Roads are written to temp files and read through readRoad / runRoad.
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
  implementer: { model: 'opus', effort: 'high' }, principles: PRINCIPLES, ...extra });
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

test('threatModel is required and needs 40 or more characters', () => {
  const { threatModel, ...without } = road();
  assert.ok(has(problemsOf(without), /threatModel missing/));
  assert.ok(has(problemsOf(road([lane('a')], { threatModel: 'x'.repeat(39) })), /threatModel/));
  assert.deepEqual(problemsOf(road([lane('a')], { threatModel: 'x'.repeat(40) })), []);
});

test('road.mjs check refuses a road without threatModel with "threatModel missing" (the shape of road-p8.json)', async () => {
  const { threatModel, ...without } = road([lane('a', { principles: undefined })]);
  const result = await runRoad(['check', write(without)]);
  assert.equal(result.code, 1);
  assert.match(result.out, /threatModel missing/);
});

test('principles: ids are P<n> or F<n>, a question has 10+ characters, ids are unique, and every lane has one F', () => {
  assert.ok(has(problemsOf(road([lane('a', { principles: [{ id: 'P1', question: 'a long enough question' }] })])), /at least one F/));
  assert.ok(has(problemsOf(road([lane('a', { principles: undefined })])), /principles/));
  assert.ok(has(problemsOf(road([lane('a', { principles: [...PRINCIPLES, { id: 'X1', question: 'a long enough question' }] })])), /X1/));
  assert.ok(has(problemsOf(road([lane('a', { principles: [{ id: 'F1', question: 'too short' }] })])), /10/));
  assert.ok(has(problemsOf(road([lane('a', { principles: [...PRINCIPLES, PRINCIPLES[1]] })])), /F1.*twice|twice.*F1/));
  assert.deepEqual(problemsOf(road([lane('a', { principles: [{ id: 'F12', question: 'ten chars!' }] })])), []);
});

test('a checkpoint is {id, run, exit 0-255, files (may be empty), kind}', () => {
  const bad = (change) => problemsOf(road([lane('a', { checkpoints: [{ ...CHECKPOINT, ...change }] })]));
  for (const change of [{ kind: 'sometimes' }, { exit: 256 }, { exit: -1 }, { exit: 1.5 }, { exit: '0' }, { run: '' }, { run: 'a\nb' }, { id: 'bad id' }, { files: 'x' }, { files: ['../x'] }]) {
    assert.ok(bad(change).length > 0, JSON.stringify(change));
  }
  assert.deepEqual(bad({ files: [], exit: 255, kind: 'keeps-working' }), []);
});

test('checkpoint ids are unique in the whole road, not only in a lane', () => {
  const twice = road([lane('a', { checkpoints: [CHECKPOINT] }), lane('b', { files: ['src/b.mjs'], checkpoints: [CHECKPOINT] })]);
  assert.ok(has(problemsOf(twice), /c1.*twice|twice.*c1/));
  const inLane = road([lane('a', { checkpoints: [CHECKPOINT, CHECKPOINT] })]);
  assert.ok(has(problemsOf(inLane), /c1.*twice|twice.*c1/));
});

test('checkpoint files are locked: none is a lane file or inside a lane folder, in either direction', () => {
  for (const [files, locked] of [[['src/a.mjs'], 'src/a.mjs'], [['src/'], 'src/a.mjs'], [['src/a.mjs'], 'src/']]) {
    const problems = problemsOf(road([lane('a', { files, checkpoints: [{ ...CHECKPOINT, files: [locked] }] })]));
    assert.ok(has(problems, /locked|lane file/), `${files} vs ${locked}`);
  }
  assert.ok(has(problemsOf(road([lane('a', { files: ['tests\\'], checkpoints: [{ ...CHECKPOINT, files: ['tests/a.test.mjs'] }] })])), /locked|lane file/));
});

test('keepGreen is optional and holds one command', () => {
  assert.deepEqual(problemsOf(road([lane('a', { keepGreen: 'node --test tests/road*.test.mjs' })])), []);
  for (const keepGreen of ['', 'a\nb', 7, ['x']]) assert.ok(has(problemsOf(road([lane('a', { keepGreen })])), /keepGreen/), JSON.stringify(keepGreen));
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
