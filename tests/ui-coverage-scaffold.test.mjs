// Tests for `ui-coverage scaffold` (lib/scaffold.mjs): which cells become entries, width grouping, keeping an existing
// --out file, exit codes; plus the case-insensitive duplicate locale rule. Runs the real CLI on temp files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';

const CLI = fileURLToPath(new URL('../home/tools/ui-coverage/ui-coverage.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const MATRIX = {
  locales: [{ tag: 'en', dir: 'ltr' }, { tag: 'fa', dir: 'rtl' }],
  widths: [320, 1024],
  searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [] },
  deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'grep -c authmock dist -> 0' },
  surfaces: [{
    id: 'login', kind: 'screen', source: 'src/login.tsx',
    controls: [{ id: 'save', class: 'dialog', component: 'src/Dialog.tsx', states: ['shown'], reference: 'none: no design reference exists' }],
  }],
};

async function workdir(matrix = MATRIX) {
  const dir = await mkdtemp(join(tmpdir(), 'ui-scaffold-'));
  const file = join(dir, 'matrix.json');
  await writeFile(file, JSON.stringify(matrix));
  return { dir, file, out: join(dir, 'states.json') };
}
const readStates = async (file) => JSON.parse(await readFile(file, 'utf8'));
const cell = (state, locale, width, status, extra = {}) => ({ surface: 'login', state, locale, width, status, evidence: '', reason: '', ...extra });

test('scaffold writes one entry per surface, state and locale with the widths grouped, empty url and steps, and empty defaults', async () => {
  const { file, out } = await workdir();
  const result = run('scaffold', file, '--out', out);
  assert.equal(result.status, 0, result.stderr);
  const states = await readStates(out);
  assert.deepEqual(states.defaults, {});
  assert.deepEqual(states.states.map((s) => [s.surface, s.state, s.locale]), [
    ['login', 'rest', 'en'], ['login', 'save:shown', 'en'], ['login', 'rest', 'fa'], ['login', 'save:shown', 'fa'],
  ]);
  assert.deepEqual(states.states[0], { surface: 'login', state: 'rest', locale: 'en', widths: [320, 1024], url: '', steps: [] });
});

test('scaffold skips cells that are pass, na or deferred, and lists only the widths still open', async () => {
  const cells = [
    cell('rest', 'en', 320, 'pass', { evidence: 'http://x/y' }),
    cell('rest', 'en', 1024, 'todo'),
    cell('save:shown', 'en', 320, 'na', { reason: 'not rendered at this width, shown by design' }),
    cell('save:shown', 'en', 1024, 'deferred', { reason: 'harness cannot open the dialog yet' }),
    cell('rest', 'fa', 320, 'fail', { evidence: 'out/r.md' }),
  ];
  const { file, out } = await workdir({ ...MATRIX, cells });
  assert.equal(run('scaffold', file, '--out', out).status, 0);
  const keys = (await readStates(out)).states.map((s) => `${s.state}|${s.locale}|${s.widths.join(',')}`);
  assert.deepEqual(keys, ['rest|en|1024', 'rest|fa|320,1024', 'save:shown|fa|320,1024']);
});

test('scaffold with an existing --out keeps its entries and defaults byte-for-byte and only adds the missing ones', async () => {
  const { file, out } = await workdir();
  const kept = { surface: 'login', state: 'rest', locale: 'EN', widths: [320], url: '/login', steps: [{ action: 'click', selector: '#x' }] };
  await writeFile(out, JSON.stringify({ defaults: { baseUrl: 'http://localhost:3000' }, states: [kept] }));
  assert.equal(run('scaffold', file, '--out', out).status, 0);
  const states = await readStates(out);
  assert.deepEqual(states.defaults, { baseUrl: 'http://localhost:3000' });
  assert.deepEqual(states.states[0], kept);
  assert.equal(states.states.filter((s) => s.state === 'rest' && s.locale.toLowerCase() === 'en').length, 1);
  assert.equal(states.states.length, 4);
  assert.equal(run('scaffold', file, '--out', out).status, 0);
  assert.deepEqual(await readStates(out), states);
});

test('scaffold reports usage errors (exit 2) and a broken matrix (exit 1, nothing written)', async () => {
  const { dir, file, out } = await workdir();
  assert.equal(run('scaffold').status, 2);
  assert.equal(run('scaffold', file, '--bogus').status, 2);
  await writeFile(out, '{not json');
  assert.equal(run('scaffold', file, '--out', out).status, 2);
  const broken = join(dir, 'broken.json');
  await writeFile(broken, JSON.stringify({ ...MATRIX, widths: [] }));
  const fresh = join(dir, 'fresh.json');
  const result = run('scaffold', broken, '--out', fresh);
  assert.equal(result.status, 1);
  await assert.rejects(readFile(fresh, 'utf8'));
});

test('two locale tags that differ only in letter case are a duplicate locale (they would be one cell)', () => {
  const matrix = { ...MATRIX, locales: [{ tag: 'fa', dir: 'rtl' }, { tag: 'FA', dir: 'rtl' }] };
  assert.ok(checkMatrix(matrix, []).problems.some((p) => p.code === 'shape' && /duplicate locale tag: FA/.test(p.message)));
});
