// Tests for ui-coverage v2: proven reuse (mountedAt + mention), proven reference (searched.reference), `init`, grouped
// `check` output with the verdict first, `--verbose`, and hand-set fails. Lib-level tests inject `readText`; the CLI tests
// run the real tool on temp files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';
import { expandMatrix } from '../home/tools/ui-coverage/lib/cells.mjs';
import { formatReport } from '../home/tools/ui-coverage/lib/report.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/ui-coverage/ui-coverage.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const CHECKBOX_STATES = ['unchecked', 'checked', 'indeterminate', 'focus', 'disabled', 'error'];
const FILES = {
  '/p/web/page.html': '<input type="checkbox" id="remember" class="remember__input">\n<script src="app.js"></script>\n',
  '/p/web/app.js': "import { createCheckbox } from '../ds/Checkbox.js';\ncreateCheckbox({ id: 'terms' });\n",
  '/p/web/wc.html': '<x-check></x-check>\n',
};
const readText = (path) => FILES[path] ?? null;

function matrixWith(control, extra = {}) {
  return expandMatrix({
    locales: [{ tag: 'en', dir: 'ltr' }],
    widths: [320],
    searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [], reference: ['rg -il validate ../ref -> 0 hits'] },
    deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'grep -c authmock dist -> 0' },
    surfaces: [{ id: 'login', kind: 'screen', source: 'web/page.html', controls: [{ id: 'remember', class: 'checkbox', states: CHECKBOX_STATES, reference: 'none: a boolean field has no rule', ...control }] }],
    ...extra,
  });
}
const passing = (matrix) => ({ ...matrix, cells: matrix.cells.map((cell) => ({ ...cell, status: 'pass', evidence: 'http://x/y' })) });
const problemsOf = (matrix, code, options = { baseDir: '/p', readText }) => checkMatrix(passing(matrix), [], options).problems.filter((p) => p.code === code);
const DS_CHECKBOX = 'ds/Checkbox.js';

test('reuse: a component path whose mount file never mentions it is unproven-reuse; a real mention passes', () => {
  const fake = problemsOf(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/page.html:1' }), 'unproven-reuse');
  assert.equal(fake.length, 1);
  assert.match(fake[0].message, /no mention of "Checkbox" within 5 lines of web\/page\.html:1/);
  assert.deepEqual(problemsOf(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/app.js:2' }), 'unproven-reuse'), []);
  assert.deepEqual(checkMatrix(passing(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/app.js:2' })), [], { baseDir: '/p', readText }).problems, []);
});

test('reuse: a missing mountedAt, a bad format, a missing file and a line past the end are each unproven-reuse', () => {
  for (const mountedAt of [undefined, '', 'web/app.js', 'web/app.js:0', 'web/app.js:x', 'web/gone.js:1', 'web/app.js:99']) {
    assert.equal(problemsOf(matrixWith({ component: DS_CHECKBOX, mountedAt }), 'unproven-reuse').length, 1, String(mountedAt));
  }
  // without a file reader only the missing-field test runs
  assert.equal(problemsOf(matrixWith({ component: DS_CHECKBOX }), 'unproven-reuse', {}).length, 1);
  assert.equal(problemsOf(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/gone.js:1' }), 'unproven-reuse', {}).length, 0);
});

test('reuse: componentMarker replaces the file-name mention; a {new} control needs a mount site but no mention', () => {
  const marker = (componentMarker) => matrixWith({ component: 'ds/CheckBox.js', componentMarker, mountedAt: 'web/wc.html:1' });
  assert.equal(problemsOf(marker(undefined), 'unproven-reuse').length, 1);
  assert.deepEqual(problemsOf(marker('x-check'), 'unproven-reuse'), []);
  const fresh = (mountedAt) => problemsOf(matrixWith({ component: { new: 'no checkbox exists in the design system' }, mountedAt }), 'unproven-mount');
  assert.equal(fresh(undefined).length, 1);
  assert.equal(fresh('web/gone.js:1').length, 1);
  assert.deepEqual(fresh('web/page.html:1'), []);
});

const lineFile = (mentions) => Array.from({ length: 100 }, (_, i) => (mentions.includes(i + 1) ? 'createCheckbox({ id: "x" });' : '<div></div>')).join('\n');

test('reuse: the mention must be within 5 lines of mountedAt; the real component elsewhere in the file does not count', () => {
  const reader = (mentions) => (path) => (path === '/p/web/big.js' ? lineFile(mentions) : null);
  const check = (mountedAt, mentions) => problemsOf(matrixWith({ component: DS_CHECKBOX, mountedAt }), 'unproven-reuse', { baseDir: '/p', readText: reader(mentions) });
  const handRolled = check('web/big.js:80', [10]);
  assert.equal(handRolled.length, 1);
  assert.match(handRolled[0].message, /no mention of "Checkbox" within 5 lines of web\/big\.js:80/);
  assert.deepEqual(check('web/big.js:80', [83]), [], 'mention at line+3');
  assert.deepEqual(check('web/big.js:80', [75]), [], 'mention at line-5');
  assert.deepEqual(check('web/big.js:80', [85]), [], 'mention at line+5');
  assert.equal(check('web/big.js:80', [74]).length, 1, 'line-6 is outside');
  assert.equal(check('web/big.js:80', [86]).length, 1, 'line+6 is outside');
  assert.deepEqual(check('web/big.js:1', [6]), [], 'window at the top of the file');
});

test('duplicate-mount: two controls may not share one mountedAt file:line', () => {
  const two = (secondAt) => {
    const matrix = matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/app.js:2' });
    matrix.surfaces[0].controls.push({ id: 'terms', class: 'checkbox', component: DS_CHECKBOX, mountedAt: secondAt, states: CHECKBOX_STATES, reference: 'none: a boolean field has no rule' });
    return expandMatrix(matrix);
  };
  const dup = problemsOf(two('web/app.js:2'), 'duplicate-mount');
  assert.equal(dup.length, 1);
  assert.match(dup[0].message, /login terms: mountedAt web\/app\.js:2 is also the mount line of login remember/);
  assert.deepEqual(problemsOf(two('web/app.js:1'), 'duplicate-mount'), []);
  assert.equal(problemsOf(two('web/app.js:2'), 'duplicate-mount', {}).length, 1, 'also without a file reader');
});

test('reuse: paths resolve from the matrix directory, or from root relative to it', () => {
  const seen = [];
  const reader = (path) => { seen.push(path); return 'Checkbox'; };
  checkMatrix(passing(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/app.js:1' })), [], { baseDir: '/p/coverage', readText: reader });
  checkMatrix(passing(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/app.js:1' }, { root: '..' })), [], { baseDir: '/p/coverage', readText: reader });
  assert.deepEqual(seen, ['/p/coverage/web/app.js', '/p/web/app.js']);
});

test('reference: "none:" is accepted only when searched.reference lists a search; the message says the 15 characters exclude the prefix', () => {
  const control = { component: DS_CHECKBOX, mountedAt: 'web/app.js:1' };
  const without = matrixWith(control, { searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [] } });
  assert.equal(problemsOf(without, 'unproven-reference').length, 1);
  for (const reference of [[], [''], undefined]) {
    assert.equal(problemsOf({ ...without, searched: { ...without.searched, reference } }, 'unproven-reference').length, 1, JSON.stringify(reference));
  }
  assert.deepEqual(problemsOf(matrixWith(control), 'unproven-reference'), []);
  const path = matrixWith({ ...control, reference: 'ref/validators.js' }, { searched: { backend: ['rg x -> 1 hit'], siblings: [] } });
  assert.deepEqual(problemsOf(path, 'unproven-reference'), [], 'a reference path needs no search record');
  const short = checkMatrix(passing(matrixWith({ ...control, reference: 'none: unknown' })), [], { baseDir: '/p', readText });
  assert.match(short.problems.find((p) => p.code === 'control-reference').message, /after the "none:" prefix \(the prefix does not count\)/);
});

async function project(files) {
  const dir = makeTempDir('ui-coverage-v2-');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

test('CLI: the proof-run mistake (component path, mount file never mentions it) exits 1 with unproven-reuse; a real mount passes that check', async () => {
  const dir = await project({ 'web/page.html': '<input type="checkbox">\n', 'web/app.js': "import { Checkbox } from './ds/Checkbox.js';\n", 'results.json': '[]', 'out/e.png': 'x' });
  const write = async (mountedAt) => {
    const matrix = passing(matrixWith({ component: DS_CHECKBOX, mountedAt }));
    matrix.cells = matrix.cells.map((cell) => ({ ...cell, evidence: 'out/e.png' }));
    await writeFile(join(dir, 'matrix.json'), JSON.stringify(matrix));
  };
  await write('web/page.html:1');
  const bad = run('check', join(dir, 'matrix.json'));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^result: FAIL, 1 cause\n/);
  assert.match(bad.stdout, /\[unproven-reuse\] login remember: no mention of "Checkbox" within 5 lines of web\/page\.html:1/);
  await write('web/app.js:1');
  const good = run('check', join(dir, 'matrix.json'));
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /^result: PASS/);
});

test('init writes a skeleton that check rejects with todo problems only, and refuses to overwrite', async () => {
  const dir = makeTempDir('ui-coverage-init-');
  const file = join(dir, 'matrix.json');
  const first = run('init', file, '--locales', 'en:ltr,fa:rtl', '--widths', '320,768,1280', '--surfaces', 'login,signup');
  assert.equal(first.status, 0, first.stderr);
  const matrix = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(matrix.locales, [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }]);
  assert.deepEqual(matrix.widths, [320, 768, 1280]);
  assert.deepEqual(matrix.surfaces.map((s) => [s.id, s.controls]), [['login', []], ['signup', []]]);
  assert.match(matrix.surfaces[0].source, /^TODO/);
  const checked = run('check', file, '--verbose');
  assert.equal(checked.status, 1);
  const codes = new Set([...checked.stdout.matchAll(/^ {2}\[([a-z-]+)\]/gm)].map((m) => m[1]));
  assert.deepEqual([...codes], ['todo']);
  assert.match(checked.stdout, /login: controls is empty/);
  assert.match(checked.stdout, /surface login: source is still a TODO placeholder/);
  assert.match(checked.stdout, /deliverable\.reviewUrl is still a TODO placeholder/);
  const before = await readFile(file, 'utf8');
  const second = run('init', file, '--locales', 'en:ltr', '--widths', '320', '--surfaces', 'x');
  assert.equal(second.status, 2);
  assert.match(second.stderr, /already exists/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('init rejects bad arguments with exit 2 and writes nothing', async () => {
  const dir = makeTempDir('ui-coverage-init-');
  const file = join(dir, 'm.json');
  const good = ['--locales', 'en:ltr', '--widths', '320', '--surfaces', 'a'];
  const swap = (flag, value) => good.map((part, i) => (good[i - 1] === flag ? value : part));
  for (const args of [[], swap('--locales', 'en:up'), swap('--locales', 'en'), swap('--widths', '0'), swap('--widths', 'wide'), swap('--surfaces', 'a,a'), good.slice(2)]) {
    assert.equal(run('init', file, ...args).status, 2, args.join(' '));
  }
  await assert.rejects(readFile(file, 'utf8'));
});

const SAME_FINDING = [{ check: 'bidi-field', element: 'input#email', detail: 'the value computes direction rtl' }];
async function failingProject(count, { recordFindings = SAME_FINDING } = {}) {
  const widths = Array.from({ length: count }, (_, i) => 300 + i);
  const matrix = {
    locales: [{ tag: 'en', dir: 'ltr' }],
    widths,
    searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [] },
    deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'grep -c authmock dist -> 0' },
    surfaces: [{ id: 'home', kind: 'screen', source: 'src/home.tsx', controls: 'none: text only, no controls here' }],
  };
  const dir = await project({ 'matrix.json': JSON.stringify(matrix) });
  const records = widths.map((width) => ({ surface: 'home', state: 'rest', locale: 'en', width, status: 'fail', evidence: `r/${width}.md`, findings: recordFindings }));
  await writeFile(join(dir, 'results.json'), JSON.stringify(records));
  return { matrix: join(dir, 'matrix.json'), results: join(dir, 'results.json') };
}

test('check groups 20 cells that fail for one reason: verdict first, one group with count 20 and three examples; --verbose prints 20 lines', async () => {
  const { matrix, results } = await failingProject(20);
  const grouped = run('check', matrix, '--results', results);
  assert.equal(grouped.status, 1);
  const lines = grouped.stdout.split('\n');
  assert.equal(lines[0], 'result: FAIL, 20 cells, 1 cause');
  assert.equal(lines.filter((l) => /^ {2}\[fail\] 20 cells: bidi-field input#email: the value computes direction rtl/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /^ {4}\[fail\] fail: home rest en @30\d/.test(l)).length, 3);
  assert.match(grouped.stdout, /and 17 more \(--verbose lists every one\)/);
  const verbose = run('check', matrix, '--results', results, '--verbose');
  assert.equal(verbose.status, 1);
  assert.equal(verbose.stdout.split('\n')[0], 'result: FAIL, 20 cells, 1 cause');
  assert.equal(verbose.stdout.split('\n').filter((l) => /^ {2}\[fail\] fail: home rest en @/.test(l)).length, 20);
});

test('different findings are different causes', async () => {
  const { matrix, results } = await failingProject(4);
  const records = JSON.parse(await readFile(results, 'utf8')).map((r, i) => ({ ...r, findings: [{ check: 'overflow', element: `div#d${i % 2}`, detail: 'clipped' }] }));
  await writeFile(results, JSON.stringify(records));
  assert.equal(run('check', matrix, '--results', results).stdout.split('\n')[0], 'result: FAIL, 4 cells, 2 causes');
});

test('hand-set fail cells (fail in the matrix, no result record) are listed under their own heading; recorded fails are not', () => {
  const matrix = passing(matrixWith({ component: DS_CHECKBOX, mountedAt: 'web/app.js:1' }));
  const handSet = { ...matrix, cells: matrix.cells.map((c) => (c.state === 'remember:error' ? { ...c, status: 'fail', evidence: '', reason: 'the error state is not rendered by the page' } : c)) };
  const result = checkMatrix(handSet, [], { baseDir: '/p', readText });
  assert.equal(result.handSet.length, 1);
  const text = formatReport(result);
  assert.match(text, /hand-set fails, found by eye, no tool result \(1\):\n {2}fail: login remember:error en @320 - the error state is not rendered by the page/);
  const record = [{ surface: 'login', state: 'remember:error', locale: 'en', width: 320, status: 'fail', evidence: 'r.md', findings: [] }];
  assert.equal(checkMatrix({ ...handSet }, record, { baseDir: '/p', readText }).handSet.length, 0);
  assert.doesNotMatch(formatReport(checkMatrix(matrix, [], { baseDir: '/p', readText })), /hand-set/);
});
