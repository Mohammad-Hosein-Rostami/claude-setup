// Tests for the Figma frame inventory of ui-coverage (lib/frames.mjs and its wiring): frame-source, frame-missing,
// frame-unmapped, frame-cell, no-compare, figma-section-missing, the `frames:` report line, `init --frames`, `expand`
// and `scaffold` with frames. `check` runs in process with an injected readText; init/expand/scaffold run the real CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';
import { formatReport } from '../home/tools/ui-coverage/lib/report.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/ui-coverage/ui-coverage.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const FRAMES_PATH = 'frames.json';
const SIGN_IN = { node: '12:40', name: 'Sign in', width: 1440, cells: [{ surface: 'signin', state: 'rest', locale: 'en' }] };
const framesFile = (...frames) => JSON.stringify({ file: 'KEY', source: 'test', frames: frames.map(({ node, name, width }) => ({ node, name, page: 'Hosted', width, height: 900 })) });
const BASE = {
  locales: [{ tag: 'en', dir: 'ltr' }],
  widths: [1440],
  searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [] },
  deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'grep -c authmock dist -> 0' },
  surfaces: [{ id: 'signin', kind: 'screen', source: 'src/signin.tsx', controls: 'none: text only, no controls here' }],
};
const withFigma = (frames, extra = {}) => ({ ...BASE, figma: { file: 'KEY', framesFile: FRAMES_PATH }, frames, cells: [{ surface: 'signin', state: 'rest', locale: 'en', width: 1440, status: 'todo', evidence: '', reason: '' }], ...extra });
const record = (extra = {}) => ({ surface: 'signin', state: 'rest', locale: 'en', width: 1440, status: 'pass', evidence: 'https://x/report', ...extra });
const COMPARE_PASS = record({ part: 'compare' });
const check = (matrix, records, text = framesFile(SIGN_IN)) => checkMatrix(matrix, records, { baseDir: '/m', readText: (path) => (path === `/m/${FRAMES_PATH}` ? text : null) });
const codes = (result) => result.problems.map((p) => p.code);

test('T2 frame-missing: an email frame and a dropdown sheet that are in the frames file but not in the matrix are named', () => {
  const email = { node: '20:1', name: 'Welcome email', width: 600 };
  const sheet = { node: '20:2', name: 'Language sheet', width: 390 };
  const result = check(withFigma([SIGN_IN]), [COMPARE_PASS], framesFile(SIGN_IN, email, sheet));
  const missing = result.problems.filter((p) => p.code === 'frame-missing').map((p) => p.message);
  assert.deepEqual(missing, [
    `frame 20:1 "Welcome email" is in ${FRAMES_PATH} but not in matrix frames: run expand, then map it or mark it notBuilt`,
    `frame 20:2 "Language sheet" is in ${FRAMES_PATH} but not in matrix frames: run expand, then map it or mark it notBuilt`,
  ]);
});

test('T3 frame-unmapped: a frame with no cells, and a frame whose notBuilt is shorter than 15 characters; a real notBuilt passes', () => {
  const empty = { node: '30:1', name: 'Hosted extra', width: 1440, cells: [] };
  const short = { node: '30:2', name: 'Helper', width: 1440, notBuilt: 'later' };
  const real = { node: '30:3', name: 'Old variant', width: 1440, notBuilt: 'dropped from the product, owner confirmed' };
  const result = check(withFigma([SIGN_IN, empty, short, real]), [COMPARE_PASS], framesFile(SIGN_IN, empty, short, real));
  assert.deepEqual(result.problems.filter((p) => p.code === 'frame-unmapped').map((p) => p.message), [
    'frame 30:1 "Hosted extra" maps to no cell: add cells [{surface,state,locale}] or notBuilt with a 15+ character reason',
    'frame 30:2 "Helper" maps to no cell: add cells [{surface,state,locale}] or notBuilt with a 15+ character reason',
  ]);
});

test('T4 no-compare: a pass from another probe, or a record without part, does not count for a cell that has a Figma frame', () => {
  const probe = check(withFigma([SIGN_IN]), [record({ part: 'responsive' }), record()]);
  assert.deepEqual(probe.problems.filter((p) => p.code === 'no-compare').map((p) => p.message), [
    'signin rest en @1440 has Figma frame 12:40 but no compare record; a pass from another probe does not count: run ui-check batch',
  ]);
  const compared = check(withFigma([SIGN_IN]), [COMPARE_PASS]);
  assert.deepEqual(compared.problems, []);
});

test('frame-cell: a frame mapped to a surface, state or width the matrix lacks says what to change (the advice of a result record)', () => {
  const wrongSurface = { ...SIGN_IN, cells: [{ surface: 'nope', state: 'rest', locale: 'en' }] };
  const wrongWidth = { node: '12:41', name: 'Narrow', width: 390, cells: [{ surface: 'signin', state: 'rest', locale: 'en' }] };
  const result = check(withFigma([wrongSurface, wrongWidth]), [COMPARE_PASS], framesFile(wrongSurface, wrongWidth));
  const messages = result.problems.filter((p) => p.code === 'frame-cell').map((p) => p.message);
  assert.equal(messages.length, 2);
  assert.match(messages[0], /^frame 12:40 maps to nope rest en @1440, which is not a matrix cell: unknown surface "nope"/);
  assert.match(messages[1], /^frame 12:41 maps to signin rest en @390, which is not a matrix cell: width 390 is not in widths: add the design frame width 390/);
});

test('frame-source: a missing, non-JSON or wrongly shaped frames file is a problem line, never a crash; an empty frames list is a problem too', () => {
  for (const text of [null, 'not json {', '[]', '{"file":"K"}', '{"file":"K","frames":[{"name":"no node"}]}']) {
    const result = check(withFigma([SIGN_IN]), [COMPARE_PASS], text);
    assert.deepEqual(result.problems.map((p) => [p.code, p.message]), [['frame-source', `figma.framesFile ${FRAMES_PATH} cannot be read or is not a frames file: write it with ui-check figma-frames`]], String(text));
  }
  assert.deepEqual(check(withFigma([SIGN_IN]), [COMPARE_PASS], '{"file":"KEY","frames":[]}').problems.map((p) => p.message), [`figma.framesFile ${FRAMES_PATH} lists no frame: write it with ui-check figma-frames`]);
});

test('a frame listed twice, or with both cells and notBuilt, is a shape problem that stops the check', () => {
  const twice = check(withFigma([SIGN_IN, SIGN_IN]), [COMPARE_PASS]);
  assert.deepEqual(twice.problems.map((p) => [p.code, p.message]), [['shape', 'duplicate frame node: 12:40']]);
  const both = check(withFigma([{ ...SIGN_IN, notBuilt: 'not part of this release at all' }]), [COMPARE_PASS]);
  assert.deepEqual(both.problems.map((p) => [p.code, p.message]), [['shape', 'frame 12:40 has both cells and notBuilt: keep one']]);
  assert.equal(both.frames, undefined);
});

test('T7 figma-section-missing: compare records in the results but no figma section in the matrix; no compare records, no problem', () => {
  const noFigma = { ...BASE, cells: [{ surface: 'signin', state: 'rest', locale: 'en', width: 1440, status: 'todo', evidence: '', reason: '' }] };
  assert.deepEqual(check(noFigma, [COMPARE_PASS, record({ part: 'compare', status: 'fail' })]).problems.filter((p) => p.code === 'figma-section-missing').map((p) => p.message), [
    'results hold 2 compare records but the matrix has no figma section: add figma.file and figma.framesFile',
  ]);
  assert.deepEqual(codes(check(noFigma, [record({ part: 'responsive' }), record()])), []);
});

test('T6 the frames line is the third line: on a pass, on a fail, and off when the matrix has no figma section', () => {
  const pass = formatReport(check(withFigma([SIGN_IN, { node: '30:3', name: 'Old', width: 1, notBuilt: 'dropped from the product, owner confirmed' }]), [COMPARE_PASS], framesFile(SIGN_IN, { node: '30:3', name: 'Old', width: 1 })));
  assert.deepEqual(pass.split('\n').slice(0, 3), ['result: PASS', 'cells: 1 | pass 1 | fail 0 | na 0 | deferred 0 | todo 0 | missing 0', 'frames: 1/2 compared and passing, 0 accepted by the owner, 1 not built']);
  const fail = formatReport(check(withFigma([SIGN_IN]), [record({ part: 'compare', status: 'fail', findings: [{ check: 'pixel', element: 'body', detail: 'd', percent: 3 }] })]));
  assert.match(fail.split('\n')[0], /^result: FAIL/);
  assert.equal(fail.split('\n')[2], 'frames: 0/1 compared and passing, 0 accepted by the owner, 0 not built');
  const off = formatReport(check({ ...BASE, cells: [{ surface: 'signin', state: 'rest', locale: 'en', width: 1440, status: 'pass', evidence: 'https://x' }] }, []));
  assert.equal(off.split('\n')[2], 'frames: inventory off (no figma section; add figma.file and figma.framesFile, then run expand)');
});

async function workdir(files) {
  const dir = makeTempDir('ui-frames-');
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}
const INIT_ARGS = ['--locales', 'en:ltr', '--widths', '1440', '--surfaces', 'signin'];

test('T8 init --frames writes figma and every frame with empty cells; without it init says the inventory is off', async () => {
  const dir = await workdir({ 'frames.json': framesFile(SIGN_IN, { node: '1:2', name: 'Email', width: 600 }) });
  const matrixFile = join(dir, 'matrix.json');
  const withFrames = run('init', matrixFile, ...INIT_ARGS, '--frames', join(dir, 'frames.json'));
  assert.equal(withFrames.status, 0, withFrames.stderr);
  const matrix = JSON.parse(await readFile(matrixFile, 'utf8'));
  assert.deepEqual(matrix.figma, { file: 'KEY', framesFile: 'frames.json' });
  assert.deepEqual(matrix.frames, [{ node: '12:40', name: 'Sign in', width: 1440, cells: [] }, { node: '1:2', name: 'Email', width: 600, cells: [] }]);
  const plain = run('init', join(dir, 'plain.json'), ...INIT_ARGS);
  assert.match(plain.stdout, /no Figma source: frame inventory off/);
  assert.equal('figma' in JSON.parse(await readFile(join(dir, 'plain.json'), 'utf8')), false);
  assert.equal(run('init', join(dir, 'bad.json'), ...INIT_ARGS, '--frames', join(dir, 'missing.json')).status, 2);
});

test('T8 expand appends the frames the frames file has and the matrix lacks, never edits one, and a second run changes nothing', async () => {
  const email = { node: '1:2', name: 'Email', width: 600 };
  const dir = await workdir({ 'frames.json': framesFile(SIGN_IN, email), 'matrix.json': withFigma([{ ...SIGN_IN, name: 'Renamed by hand' }]) });
  const matrixFile = join(dir, 'matrix.json');
  assert.equal(run('expand', matrixFile).status, 0);
  const frames = JSON.parse(await readFile(matrixFile, 'utf8')).frames;
  assert.deepEqual(frames, [{ ...SIGN_IN, name: 'Renamed by hand' }, { node: '1:2', name: 'Email', width: 600, cells: [] }]);
  const before = await readFile(matrixFile, 'utf8');
  assert.equal(run('expand', matrixFile).status, 0);
  assert.equal(await readFile(matrixFile, 'utf8'), before);
  await writeFile(join(dir, 'frames.json'), 'oops');
  const broken = run('expand', matrixFile);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /\[frame-source\]/);
});

test('T10 scaffold gives the entry of a mapped frame figma {file, node}; entries without a frame, and an existing entry, stay as they were', async () => {
  const matrix = { ...withFigma([SIGN_IN]), widths: [320, 1440], cells: [] };
  matrix.surfaces = [...BASE.surfaces, { id: 'other', kind: 'screen', source: 'src/o.tsx', controls: 'none: text only, no controls here' }];
  const dir = await workdir({ 'matrix.json': matrix });
  const out = join(dir, 'states.json');
  assert.equal(run('scaffold', join(dir, 'matrix.json'), '--out', out).status, 0);
  const states = JSON.parse(await readFile(out, 'utf8')).states;
  assert.deepEqual(states[0], { surface: 'signin', state: 'rest', locale: 'en', widths: [320, 1440], url: '', steps: [], figma: { file: 'KEY', node: '12:40' } });
  assert.equal('figma' in states[1], false);
  await writeFile(out, JSON.stringify({ defaults: {}, states: [{ surface: 'signin', state: 'rest', locale: 'en', url: 'http://x', widths: [1440] }] }));
  run('scaffold', join(dir, 'matrix.json'), '--out', out);
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')).states[0], { surface: 'signin', state: 'rest', locale: 'en', url: 'http://x', widths: [1440] });
});

test('frame-source: figma.file and the file key of the frames file must be the same Figma file', () => {
  const other = JSON.stringify({ file: 'OTHER', frames: [{ node: '12:40', name: 'Sign in', width: 1440 }] });
  assert.deepEqual(check(withFigma([SIGN_IN]), [COMPARE_PASS], other).problems.map((p) => p.message), [`figma.file KEY does not match file OTHER in ${FRAMES_PATH}: use one Figma file`]);
});

test('node ids in the URL form (12-40) and the API form (12:40) are one frame: no frame-missing, no duplicate, one in the total', () => {
  const urlForm = { node: '12-40', name: 'Sign in', width: 1440 };
  const result = check(withFigma([SIGN_IN]), [COMPARE_PASS], framesFile(urlForm));
  assert.deepEqual(result.problems, []);
  assert.equal(result.frames.total, 1);
  assert.deepEqual(check(withFigma([SIGN_IN, { ...SIGN_IN, node: '12-40' }]), [COMPARE_PASS]).problems.map((p) => p.message), ['duplicate frame node: 12-40']);
});
