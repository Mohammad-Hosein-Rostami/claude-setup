// Tests of the road's use of the check plan (ui-kinds-spec.md section 3, lane road-plan): `road.mjs next` asks the step-start record
// only for a step a lane of which has a coverage matrix with Figma frames (road-gate-ui.mjs stepNeedsBaseline), and gate line 4 PASSes a
// step whose UI landings were all proved by their plan (land-lane's ` (ui plan <depth>: proved)` suffix), while pixel landings, UI
// landings with no suffix and the old waiver suffix take the web path. The ui-proof tool and git are faked; `next` runs in process
// (runRoad with a fake run) on a road, a STATUS.md and matrix files in a cs-test- temp folder.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { uiLine } from '../home/tools/road/lib/road-gate-ui.mjs';
import { runRoad } from '../home/tools/road/road.mjs';
import { planEvidence } from '../home/tools/ui-proof/lib/ui-evidence.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const sha = (char) => char.repeat(40);
const START = sha('a');
const OLD_WAIVER = ' (ui-proof waived: owner decision)'; // the suffix land-lane --owner-waive-ui wrote before the waiver was removed

// ---- next: the baseline ----

const lane = (name, extra = {}) => ({ name, item: `lane ${name}`, size: 'S', branch: `lane/${name}`, files: [`src/${name}.tsx`],
  implementer: { model: 'opus', effort: 'high' }, checkpoints: ['true'], matrix: 'none: api wiring only, the plan renders it', ...extra });
const FIGMA_MATRIX = { surfaces: [], figma: { file: 'KEY', framesFile: 'frames.json' } };
const PLAIN_MATRIX = { surfaces: [{ id: 'home' }], cells: [] };

/** A road of one step with `lanes` in a temp repo folder holding `matrices` (name -> JSON or raw text), its STATUS.md beside the road. */
function world(lanes, matrices = {}) {
  const repo = makeTempDir('road-plan-repo-');
  for (const [name, body] of Object.entries(matrices)) writeFileSync(join(repo, name), typeof body === 'string' ? body : JSON.stringify(body));
  const folder = makeTempDir('road-plan-job-');
  const road = { road: 'rd', goal: 'probe the plan baseline', spec: 'none', repo, base: 'main', steps: [{ lanes }] };
  const roadFile = join(folder, 'road-rd.json');
  writeFileSync(roadFile, `${JSON.stringify(road)}\n`);
  const rows = [...lanes.map((one) => `| rd.s1.${one.name} | build: ${one.name} | S | - | - | - |`), `| rd.s1.check | close: step 1 checkpoint, base ${START} | S | - | - | - |`];
  writeFileSync(join(folder, 'STATUS.md'), ['# STATUS', '', '## Work items', '', '| id | item | size | started | done | evidence |', '| -- | -- | -- | -- | -- | -- |', ...rows, ''].join('\n'));
  return roadFile;
}

/** `next` with a fake run: git answers nothing useful (no early lane needs it), `ui-proof has` finds no step-start record. */
async function next(roadFile) {
  const asked = [];
  const run = (file, argv) => {
    if (file === 'ui-proof') asked.push(argv);
    return { exit: 1, out: '' };
  };
  const result = await runRoad(['next', roadFile, '--budget', '5'], { run, isUiPath: (file) => file.endsWith('.tsx') });
  return { ...result, asked };
}

test('next asks no baseline for a step whose matrices have no figma section (UI files with none: matrices or a plain matrix)', async () => {
  for (const lanes of [[lane('a'), lane('b')], [lane('a', { matrix: 'plain.json' })]]) {
    const result = await next(world(lanes, { 'plain.json': PLAIN_MATRIX }));
    assert.equal(result.code, 0, result.out);
    assert.equal(JSON.parse(result.out).baseline, 'no');
    assert.deepEqual(result.asked, [], 'ui-proof has is never asked');
  }
});

test('next asks the baseline when one lane matrix has a figma section or Figma frames', async () => {
  const frames = { surfaces: [], frames: [{ node: '1:2', width: 390, cells: [] }] };
  for (const matrix of [FIGMA_MATRIX, frames]) {
    const result = await next(world([lane('a'), lane('b', { matrix: 'figma.json' })], { 'figma.json': matrix }));
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /"baseline":"yes"/);
    assert.match(result.out, /\nbaseline needed: rd\.s1$/);
    assert.deepEqual(result.asked.map((argv) => argv.slice(0, 3)), [['has', '--step', 'rd.s1']]);
  }
});

test('next asks the baseline for a matrix path it cannot read as JSON (fail closed)', async () => {
  for (const name of ['missing.json', 'broken.json']) {
    const result = await next(world([lane('a', { matrix: name })], { 'broken.json': '{ not json' }));
    assert.match(result.out, /\nbaseline needed: rd\.s1$/, name);
  }
});

// ---- gate line 4: the plan proof ----

const ROAD = { road: 'rd', repo: '/repo', base: 'main', steps: [{ lanes: [lane('x'), lane('y')] }] };
const landing = (to, from) => `landed ${sha(to)} on main from ${sha(from)}`;
const row = (id, evidence) => ({ id, item: `build: ${id}`, started: 1, done: 2, evidence });
const range = (id, from, to) => ({ step: 1, row: id, entry: null, unknown: [], landed: { from: sha(from), to: sha(to) } });
const RANGES = [range('rd.s1.x', 'a', 'b'), range('rd.s1.y', 'b', 'c')];
const proved = (depth) => planEvidence(depth);

/**
 * Line 4 with `changed` exits per landing (1 = UI files changed), `ui-proof check` exiting `check`, the step-start record at `at`
 * (isAncestor answers by letter order on the base line a..c).
 */
function line4(suffixes, { changed = [1, 1], check = 0, at = 'a', road = ROAD, rows } = {}) {
  const calls = [];
  const uiProof = (argv) => {
    calls.push(argv[0]);
    if (argv[0] === 'changed') return { exit: changed[RANGES.findIndex((one) => one.landed.from === argv[2])], out: '' };
    if (argv[0] === 'has') return { exit: 0, out: `record rd.s1 at ${sha(at)}\n` };
    return { exit: check, out: '' };
  };
  const isAncestor = (a, b) => (a[0] <= b[0] ? 0 : 1);
  const own = rows ?? [row('rd.s1.x', `${landing('b', 'a')}${suffixes[0]}`), row('rd.s1.y', `${landing('c', 'b')}${suffixes[1]}`)];
  const ctx = { tip: sha('c'), repo: '/repo', isUiPath: (file) => file.endsWith('.tsx'), uiProof, isAncestor, statusText: '' };
  return { line: uiLine(road, new Map(own.map((one) => [one.id, one])), RANGES, 1, ctx), calls };
}

test('gate PASS "4 ui: <n> landing(s) proved by their plan" for render landings with the suffix, and ui-proof check is not asked', () => {
  const { line, calls } = line4([proved('render'), proved('render')], { check: 1 });
  assert.equal(line, 'PASS 4 ui: 2 landing(s) proved by their plan');
  assert.deepEqual(calls, ['changed', 'changed']);
  for (const depth of ['none', 'same', 'visual']) assert.equal(line4([proved(depth), proved('render')], { check: 1 }).line, 'PASS 4 ui: 2 landing(s) proved by their plan', depth);
  assert.equal(line4([proved('render'), ''], { changed: [1, 0], check: 1 }).line, 'PASS 4 ui: 1 landing(s) proved by their plan', 'a landing with no UI file needs no suffix');
});

test('a landing with the old waiver suffix is not proved: the web path decides', () => {
  assert.equal(line4([OLD_WAIVER, OLD_WAIVER], { check: 1 }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1');
  assert.equal(line4([proved('render'), OLD_WAIVER], { check: 1 }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1');
});

test('P3: a UI landing without the plan suffix, or with it inside the text, takes the web path', () => {
  assert.equal(line4([proved('render'), ''], { check: 1 }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1');
  assert.equal(line4([proved('render'), `${proved('render')} later text`], { check: 1 }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1');
  assert.equal(line4(['', ''], { at: 'a' }).line, `PASS 4 ui: visual-qa PASS at ${sha('c')}, no state worse than rd.s1`, 'old landings: today\'s web path');
});

test('F2: a mixed step (one pixel landing, one render landing) needs the visual-qa step proof and counts the render suffix', () => {
  assert.equal(line4([proved('pixel'), proved('render')], { check: 1 }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1');
  assert.equal(line4([proved('pixel'), proved('pixel')], { check: 1 }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1', 'pixel alone never passes by plan');
  // The record at b: after x's from (a), at y's from (b). The render landing x needs no record; the pixel landing y does.
  assert.equal(line4([proved('render'), proved('pixel')], { at: 'b' }).line, `PASS 4 ui: visual-qa PASS at ${sha('c')}, no state worse than rd.s1; 1 landing(s) proved by their plan`);
  assert.equal(line4([proved('pixel'), proved('render')], { at: 'b' }).line, 'FAIL 4 ui: the step-start record rd.s1 was not taken at or before every from');
});

test('F3: zero landings that changed a UI file is never proved; a step with no UI change and no matrix passes as today', () => {
  const matrixRoad = { ...ROAD, steps: [{ lanes: [lane('x', { matrix: 'coverage/m.json' }), lane('y')] }] };
  assert.equal(line4([proved('render'), proved('render')], { changed: [0, 0], check: 1, road: matrixRoad }).line, 'FAIL 4 ui: ui-proof check --against-step rd.s1 exited 1');
  const plainRoad = { ...ROAD, steps: [{ lanes: [{ name: 'x', files: ['src/x.mjs'] }, { name: 'y', files: ['src/y.mjs'] }] }] };
  assert.equal(line4(['', ''], { changed: [0, 0], road: plainRoad }).line, 'PASS 4 ui: no UI file changed in the step');
  assert.match(line4([proved('render'), proved('render')], { changed: [0, 0] }).line, /^FAIL 4 ui: terminal UI step/, 'none: matrices: the terminal path');
});

test('P14: the suffix counts from the landing row or its one done correction row (land-lane\'s printed evidence), nothing else', () => {
  const corrected = [row('rd.s1.x', 'build done'), row('rd.s1.x.landed', `${landing('b', 'a')}${proved('render')}`), row('rd.s1.y', `${landing('c', 'b')}${proved('same')}`)];
  assert.equal(line4([], { rows: corrected, check: 1 }).line, 'PASS 4 ui: 2 landing(s) proved by their plan');
  const openCorrection = [row('rd.s1.x', 'build done'), { ...row('rd.s1.x.landed', `${landing('b', 'a')}${proved('render')}`), done: null }, corrected[2]];
  assert.match(line4([], { rows: openCorrection, check: 1 }).line, /^FAIL 4 ui: ui-proof check/, 'an open correction row holds no landing');
});
