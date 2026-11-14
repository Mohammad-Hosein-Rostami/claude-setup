// Tests for home/tools/ui-coverage/ui-coverage.mjs: the CLI contract (expand writes todo cells, check exit codes 0/1/2,
// --results merging in the ui-check batch record format). Runs the real CLI on temp files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../home/tools/ui-coverage/ui-coverage.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const MATRIX = {
  locales: [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }],
  widths: [320],
  searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [] },
  deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'grep -c authmock dist -> 0' },
  surfaces: [{ id: 'home', kind: 'screen', source: 'src/home.tsx', controls: 'none: text only, no controls here' }],
};

async function workdir(matrix = MATRIX) {
  const dir = await mkdtemp(join(tmpdir(), 'ui-coverage-'));
  const file = join(dir, 'matrix.json');
  await writeFile(file, JSON.stringify(matrix));
  return { dir, file };
}

const passRecords = ['en', 'fa'].map((locale) => ({ surface: 'home', state: 'rest', locale, width: 320, status: 'pass', evidence: `out/${locale}.png` }));
// The evidence files of passRecords, relative to the matrix directory.
async function writeEvidence(dir) {
  await mkdir(join(dir, 'out'), { recursive: true });
  for (const record of passRecords) await writeFile(join(dir, record.evidence), 'x');
}

test('expand writes todo cells into the file and a second run changes nothing', async () => {
  const { file } = await workdir();
  const first = run('expand', file);
  assert.equal(first.status, 0, first.stderr);
  const cells = JSON.parse(await readFile(file, 'utf8')).cells;
  assert.equal(cells.length, 2);
  assert.ok(cells.every((c) => c.status === 'todo'));
  const before = await readFile(file, 'utf8');
  assert.equal(run('expand', file).status, 0);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('check exits 1 and names the todo cells; with passing results (two files) it exits 0 and prints the summary', async () => {
  const { dir, file } = await workdir();
  run('expand', file);
  const failing = run('check', file);
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /\[todo\] todo: home rest en @320/);
  assert.match(failing.stdout, /result: FAIL/);
  const [en, fa] = passRecords.map((r) => JSON.stringify([r]));
  await writeEvidence(dir);
  await writeFile(join(dir, 'a.json'), en);
  await writeFile(join(dir, 'b.json'), JSON.stringify({ results: JSON.parse(fa) }));
  const ok = run('check', file, '--results', join(dir, 'a.json'), '--results', join(dir, 'b.json'));
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^result: PASS\ncells: 2 \| pass 2 \| fail 0/);
  assert.match(ok.stdout, /result: PASS/);
});

test('check without expand reports missing cells; a failing record exits 1', async () => {
  const { dir, file } = await workdir();
  assert.match(run('check', file).stdout, /\[missing-cell\]/);
  await writeEvidence(dir);
  const results = join(dir, 'r.json');
  await writeFile(results, JSON.stringify([...passRecords.slice(1), { ...passRecords[0], status: 'fail' }]));
  const out = run('check', file, '--results', results);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /\[fail\] fail: home rest en @320/);
});

test('setup errors exit 2: no command, unknown command, missing or invalid files, unknown flag', async () => {
  const { dir, file } = await workdir();
  await writeFile(join(dir, 'bad.json'), '{not json');
  for (const args of [[], ['frobnicate'], ['check'], ['check', join(dir, 'none.json')], ['check', join(dir, 'bad.json')], ['check', file, '--results', join(dir, 'none.json')], ['check', file, '--wat']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /ui-coverage:/);
  }
});

test('expand on a structurally broken matrix exits 1 with shape problems and leaves the file alone', async () => {
  const { file } = await workdir({ ...MATRIX, widths: [] });
  const before = await readFile(file, 'utf8');
  const r = run('expand', file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\[shape\]/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('check fails on evidence files that do not exist and accepts them once they do (paths resolve from the matrix directory)', async () => {
  const { dir, file } = await workdir();
  const results = join(dir, 'r.json');
  await writeFile(results, JSON.stringify(passRecords));
  const missing = run('check', file, '--results', results);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /\[evidence-missing\].*out\/en\.png/);
  await writeEvidence(dir);
  assert.equal(run('check', file, '--results', results).status, 0);
  // the working directory does not matter: run from another directory
  const elsewhere = spawnSync(process.execPath, [CLI, 'check', file, '--results', results], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(elsewhere.status, 0, elsewhere.stdout);
});

test('states prints the default states per class from the single list', () => {
  const r = run('states');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /checkbox\|radio\|switch -> unchecked, checked, indeterminate, focus, disabled, error/);
  assert.match(r.stdout, /select\|dropdown\|menu\|autocomplete\|combobox -> rest, focus, open, option-hover, selected, disabled, error/);
  assert.equal(run('states', 'extra').status, 2);
});
