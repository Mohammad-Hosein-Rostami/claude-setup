// Purpose: tests for `ui-check run --same <base run>` (lib/same-run.mjs) and the ledger fields it reads: `captures` (per responsive
// width: file, sha256, finding ids, page errors) and `root`. Browser-free cases use PNGs written with pngjs; the browser case (two runs
// of fixtures/card.html through the CLI, then an edited copy) needs UI_CHECK_PROJECT and skips without it. Exports: none.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pngjs from 'pngjs';
import { responsiveRecords } from '../lib/batch-records.mjs';
import { buildLedger, compareReference, compareRounds, readLedger, readLedgerFile, writeLedger } from '../lib/ledger.mjs';
import { compareSame, formatSame, SAME_VERDICTS } from '../lib/same-run.mjs';
import { runRoot } from '../commands/run.mjs';
import { watchPageErrors } from '../commands/responsive.mjs';

const { PNG } = pngjs;
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli.mjs');
const COVERAGE_CLI = path.join(here, '..', '..', 'ui-coverage', 'ui-coverage.mjs');
const RENDERER = { platform: 'darwin-arm64', chromium: '151.0.7922.34' };
const project = process.env.UI_CHECK_PROJECT;

const made = [];
/** A new cs-test temp folder, removed when the file's tests end. */
const tempDir = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-test-same-${label}-`));
  made.push(dir);
  return dir;
};
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** A 4x4 PNG of one grey level; `dot` paints one pixel red; `bytes` picks the encoder settings, so equal pixels can have other bytes. */
function png({ dot = false, bytes = 'small', grey = 200 } = {}) {
  const image = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < image.data.length; i += 4) image.data.set([grey, grey, grey, 255], i);
  if (dot) image.data.set([255, 0, 0, 255], 0);
  return PNG.sync.write(image, bytes === 'small' ? { deflateLevel: 9, filterType: 4 } : { deflateLevel: 1, filterType: 0 });
}

/**
 * A run folder as `run` leaves it: the captures under `<state>/responsive/w<width>.png` and ledger.json from buildLedger.
 * @param {string} dir run folder
 * @param {{state: string, image?: Buffer|null, findings?: object[], pageErrors?: string[]}[]} shots image null = no capture written
 * @param {string} head the git head the ledger records (default: a sha of the folder path, so two folders never share one)
 * @returns {object} the ledger
 */
function runFolder(dir, shots, renderer = RENDERER, head = crypto.createHash('sha1').update(dir).digest('hex')) {
  fs.mkdirSync(dir, { recursive: true });
  const records = shots.map(({ state, image = null, findings = [], pageErrors = [] }) => {
    const file = path.join(dir, state, 'responsive', 'w320.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (image) fs.writeFileSync(file, image);
    return { part: 'responsive', surface: 'card', state, locale: 'en', width: 320, status: 'pass', findings, capture: file, pageErrors };
  });
  const ledger = buildLedger(records, { renderer, head, root: '/repo', runDir: dir });
  writeLedger(dir, ledger);
  return ledger;
}

/** Compare a tip folder with a base folder the way `run --same` does; returns rows by state name. */
async function same(baseShots, tipShots, { baseRenderer = RENDERER } = {}) {
  const root = tempDir('pair');
  runFolder(path.join(root, 'base'), baseShots, baseRenderer);
  const tip = runFolder(path.join(root, 'tip'), tipShots);
  const result = await compareSame(tip, readLedgerFile(path.join(root, 'base'), 'same'), path.join(root, 'tip'));
  const byState = Object.fromEntries(result.rows.map((row) => [row.key.split(' / ')[1], row]));
  return { result, byState, root };
}

const error = (check, element) => ({ check, element, detail: 'measured 3 px' });

test('identical: the same capture bytes give identical (same sha256), with no new finding or page error', async () => {
  const { result, byState } = await same([{ state: 'rest', image: png() }], [{ state: 'rest', image: png() }]);
  assert.deepEqual(byState.rest, { key: 'card / rest / en @320', verdict: 'identical', newFindings: [], newPageErrors: [], detail: null });
  assert.deepEqual(formatSame(result), ['same: 1 identical, 0 equal, 0 changed, 0 new, 0 missing']);
});

test('equal: other bytes but the same decoded pixels on fixture PNGs', async () => {
  assert.notEqual(png({ bytes: 'small' }).toString('hex'), png({ bytes: 'fast' }).toString('hex'));
  const { byState } = await same([{ state: 'rest', image: png({ bytes: 'small' }) }], [{ state: 'rest', image: png({ bytes: 'fast' }) }]);
  assert.equal(byState.rest.verdict, 'equal');
});

test('changed: one differing pixel is changed, its diff image lands under the tip run folder only', async () => {
  const { result, byState, root } = await same([{ state: 'rest', image: png() }], [{ state: 'rest', image: png({ dot: true }) }]);
  assert.equal(byState.rest.verdict, 'changed');
  assert.match(byState.rest.detail, /1 px \(odiff\)/);
  assert.ok(fs.existsSync(path.join(root, 'tip', 'same', '0-card---rest---en--320', 'diff.png')));
  assert.equal(fs.existsSync(path.join(root, 'base', 'same')), false);
  assert.match(formatSame(result)[1], /^ {2}card \/ rest \/ en @320: changed; 1 px differ \(exact\), 1 px \(odiff\)/);
});

test('equal is pixel-identical: grey 200 to 201, 202 or 210 on every pixel is changed, with no tolerance (odiff and the colour metric see none)', async () => {
  for (const grey of [201, 202, 210]) {
    const { byState } = await same([{ state: 'rest', image: png() }], [{ state: 'rest', image: png({ grey }) }]);
    assert.equal(byState.rest.verdict, 'changed', `grey ${grey}`);
    assert.match(byState.rest.detail, /^16 px differ \(exact\), /, `grey ${grey}`);
  }
});

/** A base run whose capture really differs from the tip's (a red dot) and a tip run, for tampering with either afterwards. */
function tamperPair(label) {
  const root = tempDir(label);
  const pair = { base: path.join(root, 'base'), tipDir: path.join(root, 'tip') };
  runFolder(pair.base, [{ state: 'rest', image: png({ dot: true }) }]);
  const tip = runFolder(pair.tipDir, [{ state: 'rest', image: png() }]);
  const capture = (dir) => path.join(dir, 'rest', 'responsive', 'w320.png');
  return { ...pair, tip, ledgerFile: path.join(pair.base, 'ledger.json'), baseCapture: capture(pair.base), tipCapture: capture(pair.tipDir) };
}

/** Rewrite a ledger file through `edit`, as a hand edit would. */
function editLedger(file, edit) {
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(ledger);
  fs.writeFileSync(file, JSON.stringify(ledger));
}

test('a capture counts only when its bytes, read now from a plain file inside its run folder, hash to the recorded sha256', async () => {
  const edited = tamperPair('edit');
  editLedger(edited.ledgerFile, (ledger) => { ledger.captures[0].sha256 = edited.tip.captures[0].sha256; });
  const relative = tamperPair('relpath');
  editLedger(relative.ledgerFile, (ledger) => { ledger.captures[0].file = path.join('..', 'tip', 'rest', 'responsive', 'w320.png'); });
  const fileLink = tamperPair('link');
  fs.rmSync(fileLink.baseCapture);
  fs.symlinkSync(fileLink.tipCapture, fileLink.baseCapture);
  const folderLink = tamperPair('dirlink');
  fs.rmSync(path.join(folderLink.base, 'rest'), { recursive: true });
  fs.symlinkSync(path.join(folderLink.tipDir, 'rest'), path.join(folderLink.base, 'rest'));
  const swapped = tamperPair('swap');
  fs.writeFileSync(swapped.baseCapture, png());
  const tipSwapped = tamperPair('tipswap');
  fs.writeFileSync(tipSwapped.tipCapture, png({ dot: true }));
  const cases = [[edited, /^the base run's capture .* does not hash to its recorded sha256$/], [relative, /^the base run's capture .* is outside its run folder$/],
    [fileLink, /^the base run's capture .* is not a plain file/], [folderLink, /^the base run's capture .* is outside its run folder$/],
    [swapped, /^the base run's capture .* does not hash/], [tipSwapped, /^this run's capture .* does not hash/]];
  for (const [pair, why] of cases) {
    const [row] = (await compareSame(pair.tip, readLedgerFile(pair.base, 'same'), pair.tipDir)).rows;
    assert.deepEqual([row.verdict, why.test(row.detail)], ['missing', true], `${pair.base}: ${row.detail}`);
  }
});

test('a base run with no recorded head, or this run\'s own head, is refused: every row, never compared', async () => {
  const root = tempDir('refused');
  const shots = [{ state: 'rest', image: png() }];
  const head = 'c'.repeat(40);
  runFolder(path.join(root, 'nohead'), [...shots, { state: 'only-base', image: png() }], RENDERER, null);
  runFolder(path.join(root, 'own'), shots, RENDERER, head);
  const tip = runFolder(path.join(root, 'tip'), shots, RENDERER, head);
  const noHead = await compareSame(tip, readLedgerFile(path.join(root, 'nohead'), 'same'), path.join(root, 'tip'));
  assert.deepEqual(noHead.rows.map((row) => row.verdict), ['refused', 'refused']);
  assert.match(noHead.refused, /^the base run recorded no git head/);
  assert.deepEqual(formatSame(noHead).slice(0, 2), ['same: 0 identical, 0 equal, 0 changed, 0 new, 0 missing, 2 refused', `  refused: ${noHead.refused}`]);
  const own = await compareSame(tip, readLedgerFile(path.join(root, 'own'), 'same'), path.join(root, 'tip'));
  assert.deepEqual(own.rows.map((row) => row.verdict), ['refused']);
  assert.match(own.refused, new RegExp(`^the base run's head ${head} is this run's own head`));
});

test('ledger states: a hand-edited sha256 with other counts is not identical; --no-worse judges the counts, --prev the gain', () => {
  const comparator = buildLedger([], { renderer: RENDERER }).comparator;
  const ledger = (states) => ({ comparator, renderer: RENDERER, states });
  const row = { key: 'k', sha256: 's', pixels: 5, drift: 0, rows: 0, status: 'fail', scale: 1 };
  const noWorse = compareReference(ledger([{ ...row }]), ledger([{ ...row, pixels: 2 }]));
  assert.deepEqual([noWorse.ok, noWorse.rows[0].verdict], [false, 'worse']);
  assert.equal(compareRounds(ledger([{ ...row, pixels: 2 }]), ledger([{ ...row }]))[0].verdict, 'gain');
  assert.equal(compareReference(ledger([{ ...row }]), ledger([{ ...row }])).rows[0].verdict, 'identical');
});

test('new and missing: a tip state without a base row is new, a base state the tip lacks is missing', async () => {
  const { result, byState } = await same([{ state: 'old', image: png() }], [{ state: 'added', image: png(), findings: [error('hscroll', 'html')] }]);
  assert.equal(byState.added.verdict, 'new');
  assert.deepEqual(byState.added.newFindings, ['hscroll html']);
  assert.deepEqual(byState.old, { key: 'card / old / en @320', verdict: 'missing', newFindings: [], newPageErrors: [], detail: 'not captured in this run' });
  assert.equal(formatSame(result)[0], 'same: 0 identical, 0 equal, 0 changed, 1 new, 1 missing');
});

test('a capture that is absent or unreadable on either side is missing, never identical (P3)', async () => {
  const absent = await same([{ state: 'rest', image: null }], [{ state: 'rest', image: null }]);
  assert.equal(absent.byState.rest.verdict, 'missing');
  assert.match(absent.byState.rest.detail, /no readable capture/);
  const root = tempDir('gone');
  runFolder(path.join(root, 'base'), [{ state: 'rest', image: png() }]);
  const tip = runFolder(path.join(root, 'tip'), [{ state: 'rest', image: png({ dot: true }) }]);
  fs.rmSync(path.join(root, 'base', 'rest'), { recursive: true });
  const result = await compareSame(tip, readLedgerFile(path.join(root, 'base'), 'same'), path.join(root, 'tip'));
  assert.equal(result.rows[0].verdict, 'missing');
  const broken = tempDir('broken');
  runFolder(path.join(broken, 'base'), [{ state: 'rest', image: Buffer.from('not a png') }]);
  const tipBroken = runFolder(path.join(broken, 'tip'), [{ state: 'rest', image: png() }]);
  const notPng = await compareSame(tipBroken, readLedgerFile(path.join(broken, 'base'), 'same'), path.join(broken, 'tip'));
  assert.equal(notPng.rows[0].verdict, 'missing');
  assert.match(notPng.rows[0].detail, /not comparable/);
});

test('new finding id: a finding (check and element) the base row lacks is listed; hints and moved numbers are not', async () => {
  const base = [{ state: 'rest', image: png(), findings: [error('overlap', '#a')] }];
  const tip = [{ state: 'rest', image: png(), findings: [{ ...error('overlap', '#a'), detail: 'measured 9 px' }, error('hscroll', 'html'), error('bidi-field?', 'input')] }];
  const { result, byState } = await same(base, tip);
  assert.equal(byState.rest.verdict, 'identical');
  assert.deepEqual(byState.rest.newFindings, ['hscroll html']);
  assert.match(formatSame(result)[1], /identical; new findings: hscroll html$/);
});

test('more page errors: errors beyond the base row are new, counted per message', async () => {
  const base = [{ state: 'rest', image: png(), pageErrors: ['boom'] }];
  const tip = [{ state: 'rest', image: png(), pageErrors: ['boom', 'boom', 'other'] }];
  const { byState } = await same(base, tip);
  assert.deepEqual(byState.rest.newPageErrors, ['boom', 'other']);
  const fewer = await same(tip, base);
  assert.deepEqual(fewer.byState.rest.newPageErrors, []);
});

test('other renderer or comparator: every row is other-renderer, never identical (F4)', async () => {
  const shots = [{ state: 'rest', image: png() }];
  const { result } = await same([...shots, { state: 'only-base', image: png() }], shots, { baseRenderer: { platform: 'linux-x64', chromium: '120.0' } });
  assert.deepEqual(result.rows.map((row) => row.verdict), ['other-renderer', 'other-renderer']);
  assert.match(formatSame(result).join('\n'), /^same: 0 identical, 0 equal, 0 changed, 0 new, 0 missing, 2 other-renderer\n {2}other-renderer: different renderer/);
  const root = tempDir('comparator');
  runFolder(path.join(root, 'base'), shots);
  const ledgerFile = path.join(root, 'base', 'ledger.json');
  fs.writeFileSync(ledgerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(ledgerFile, 'utf8')), comparator: { name: 'odiff', version: '0.0.1', options: {} } }));
  const tip = runFolder(path.join(root, 'tip'), shots);
  const other = await compareSame(tip, readLedgerFile(ledgerFile, 'same'), path.join(root, 'tip'));
  assert.deepEqual(other.rows.map((row) => row.verdict), ['other-renderer']);
  assert.ok(SAME_VERDICTS.includes('other-renderer'));
});

test('empty: zero captures print same: 0 rows and give rows: [] (F3)', async () => {
  const { result } = await same([], []);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(formatSame(result), ['same: 0 rows']);
});

test('the same section names the base ledger it read: file, sha256 of its bytes, head, createdAt', async () => {
  const { result, root } = await same([{ state: 'rest', image: png() }], [{ state: 'rest', image: png() }]);
  const file = path.join(root, 'base', 'ledger.json');
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(result.ref, { file, sha256: readLedgerFile(file, 'same').sha256, head: base.head, createdAt: base.createdAt });
  assert.match(result.ref.sha256, /^[0-9a-f]{64}$/);
});

test('ledger captures: one row per responsive width with a relative path, sha256, finding ids and page errors; diagnostic and compare records stay out', () => {
  const dir = tempDir('ledger');
  const file = path.join(dir, '0-card', 'responsive', 'w320.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'bytes');
  const state = { surface: 'card', state: 'rest', locale: undefined, url: 'http://x' };
  const records = responsiveRecords(state, [320, 768], { md: path.join(dir, 'report.md'), findings: [{ width: 320, check: 'hscroll', element: 'html', detail: 'd' }], captures: [{ width: 320, file, pageErrors: ['boom'] }] })
    .map((r) => ({ ...r, part: 'responsive' }));
  assert.deepEqual([records[0].capture, records[0].pageErrors, 'capture' in records[1]], [file, ['boom'], false]);
  const diagnostic = { ...records[0], diagnostic: true };
  const compare = { ...records[0], part: 'compare', images: null };
  const ledger = buildLedger([...records, diagnostic, compare], { renderer: RENDERER, root: dir, runDir: dir });
  assert.equal(ledger.root, dir);
  assert.deepEqual(ledger.states, []);
  assert.deepEqual(ledger.captures, [
    { key: 'card / rest / default @320', file: path.join('0-card', 'responsive', 'w320.png'), sha256: crypto.createHash('sha256').update('bytes').digest('hex'), findings: ['hscroll html'], pageErrors: ['boom'] },
    { key: 'card / rest / default @768', file: null, sha256: null, findings: [], pageErrors: [] },
  ]);
});

test('old readers: a ledger without root, captures or same still reads and compares (F6); as a --same base every row is new', async () => {
  const dir = tempDir('old');
  const old = { comparator: buildLedger([], { renderer: RENDERER }).comparator, renderer: RENDERER, step: null, rule: 'default', conditions: null, head: 'abc', createdAt: '2026-11-01T00:00:00.000Z', states: [{ key: 'k', sha256: 's', pixels: 0, drift: 0, rows: 0, status: 'pass', scale: 1 }] };
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(old));
  const read = readLedger(dir, 'prev');
  assert.deepEqual(read, old);
  const current = { ...buildLedger([], { renderer: RENDERER }), states: [{ ...old.states[0] }] };
  assert.equal(compareRounds(current, read)[0].verdict, 'identical');
  assert.equal(compareReference(current, read).ok, true);
  const tipDir = tempDir('old-tip');
  const tip = runFolder(tipDir, [{ state: 'rest', image: png() }]);
  const result = await compareSame(tip, readLedgerFile(dir, 'same'), tipDir);
  assert.deepEqual(result.rows.map((row) => row.verdict), ['new']);
});

test('watchPageErrors: a context page listener collects uncaught errors, capped in count and length', async () => {
  const contexts = [];
  const browser = { newContext: async () => { const context = new EventEmitter(); contexts.push(context); return context; } };
  const watched = watchPageErrors(browser, 2);
  await watched.browser.newContext({});
  const page = new EventEmitter();
  contexts[0].emit('page', page);
  page.emit('pageerror', new Error('x'.repeat(1000)));
  page.emit('pageerror', new Error('second'));
  page.emit('pageerror', new Error('third'));
  assert.deepEqual(watched.errors.map((m) => m.length), [300, 6]);
});

test('runRoot: the git top-level of the folder a run starts in, a second worktree included; null outside git', () => {
  const root = fs.realpathSync.native(tempDir('root'));
  const git = (cwd, ...args) => {
    const child = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  };
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'x');
  git(main, 'worktree', 'add', '-q', path.join(root, 'other'));
  fs.mkdirSync(path.join(root, 'other', 'sub'));
  assert.equal(runRoot(path.join(root, 'other', 'sub')), path.join(root, 'other'));
  assert.equal(runRoot(main), main);
  assert.equal(runRoot(path.join(root)), null);
});

test('cli: run with a bad --same path exits 2 with a usage line naming --same', () => {
  const child = spawnSync(process.execPath, [CLI, 'run', '--matrix', path.join(tempDir('cli'), 'm.json'), '--same', path.join(os.tmpdir(), 'cs-test-no-such-run')], { encoding: 'utf8' });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /^usage\/setup error: --same .*cs-test-no-such-run: cannot read/m);
});

/** A git repo with a second worktree holding a matrix (ui-coverage init) and a states file for one state of `page` at 320 px. */
function browserProject(page) {
  const root = fs.realpathSync.native(tempDir('browser'));
  const git = (cwd, ...args) => assert.equal(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd }).status, 0);
  fs.mkdirSync(path.join(root, 'main'));
  git(path.join(root, 'main'), 'init', '-q');
  git(path.join(root, 'main'), 'commit', '-q', '--allow-empty', '-m', 'x');
  const wt = path.join(root, 'wt');
  git(path.join(root, 'main'), 'worktree', 'add', '-q', wt);
  const env = { ...process.env, UI_COVERAGE_STATE_DIR: path.join(root, 'state') };
  assert.equal(spawnSync(process.execPath, [COVERAGE_CLI, 'init', path.join(wt, 'm.json'), '--locales', 'en:ltr', '--widths', '320', '--surfaces', 'card'], { env }).status, 0);
  const states = (file) => ({ defaults: {}, states: [{ surface: 'card', state: 'rest', locale: 'en', widths: [320], url: pathToFileURL(file).href, steps: [] }] });
  fs.writeFileSync(path.join(wt, 'states.json'), JSON.stringify(states(page)));
  return { root, wt, env, states };
}

test('cli: --same naming this run\'s own --out folder, directly, through a folder or ledger link or in other letter case, exits 2 before anything runs (F2)', () => {
  const { root, wt, env } = browserProject(path.join(here, 'fixtures', 'card.html'));
  const out = path.join(root, 'out');
  runFolder(out, [{ state: 'rest', image: png() }]);
  fs.symlinkSync(out, path.join(root, 'outlink'));
  fs.symlinkSync(path.join(out, 'ledger.json'), path.join(root, 'ledger-link.json'));
  const before = fs.readFileSync(path.join(out, 'ledger.json'), 'utf8');
  const caseBlind = ['darwin', 'win32'].includes(process.platform); // APFS and NTFS by default
  const aliases = [out, path.join(root, 'outlink'), path.join(root, 'ledger-link.json'), ...(caseBlind ? [path.join(root, 'OUT')] : [])];
  for (const same of aliases) {
    const child = spawnSync(process.execPath, [CLI, 'run', '--matrix', path.join(wt, 'm.json'), '--out', out, '--same', same, '--project', path.join(root, 'none')], { cwd: wt, env, encoding: 'utf8' });
    assert.equal(child.status, 2, same);
    assert.match(child.stderr, /^usage\/setup error: --same .*: names this run's own --out folder/m, same);
    assert.equal(fs.readFileSync(path.join(out, 'ledger.json'), 'utf8'), before);
  }
});

test('cli: a --same base with no recorded head or with this run\'s own head exits 2 before anything runs', () => {
  const { root, wt, env } = browserProject(path.join(here, 'fixtures', 'card.html'));
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: wt, encoding: 'utf8' }).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  for (const [name, baseHead, why] of [['nohead', null, /the base run recorded no git head/], ['own', head, new RegExp(`the base run's head ${head} is this run's own head`)]]) {
    runFolder(path.join(root, name), [{ state: 'rest', image: png() }], RENDERER, baseHead);
    const out = path.join(root, `out-${name}`);
    const child = spawnSync(process.execPath, [CLI, 'run', '--matrix', path.join(wt, 'm.json'), '--out', out, '--same', path.join(root, name), '--project', path.join(root, 'none')], { cwd: wt, env, encoding: 'utf8' });
    assert.equal(child.status, 2, name);
    assert.match(child.stderr, new RegExp(`^usage/setup error: --same .*${name}: ${why.source}`, 'm'), child.stderr);
    assert.equal(fs.existsSync(out), false, name);
  }
});

test('browser: two runs of fixtures/card.html are identical, an edited copy that throws is changed with a new page error, the ledger root is the worktree', { skip: project ? false : 'set UI_CHECK_PROJECT to a folder whose node_modules has Playwright' }, (t) => {
  const started = Date.now();
  const { root, wt, env, states } = browserProject(path.join(here, 'fixtures', 'card.html'));
  const run = (out, ...extra) => spawnSync(process.execPath, [CLI, 'run', '--matrix', path.join(wt, 'm.json'), '--out', path.join(root, out), '--project', project, ...extra], { cwd: wt, env, encoding: 'utf8' });
  const base = run('base');
  assert.ok(fs.existsSync(path.join(root, 'base', 'ledger.json')), base.stderr);
  assert.equal(readLedger(path.join(root, 'base'), 'same').root, wt);
  // The tip is a later commit: a base run of this run's own head is refused (baseRefusal).
  assert.equal(spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'tip'], { cwd: wt }).status, 0);
  const tip = run('tip', '--same', path.join(root, 'base'));
  assert.match(tip.stdout, /^same: 1 identical, 0 equal, 0 changed, 0 new, 0 missing$/m, tip.stdout);
  assert.equal(tip.status, base.status);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tip', 'ledger.json'), 'utf8')).same.rows.map((row) => row.verdict), ['identical']);
  const edited = path.join(root, 'card-edited.html');
  fs.writeFileSync(edited, fs.readFileSync(path.join(here, 'fixtures', 'card.html'), 'utf8').replace('>Hello<', '>Hallo<').concat('<script>throw new Error("edited boom")</script>'));
  fs.writeFileSync(path.join(root, 'edited-states.json'), JSON.stringify(states(edited)));
  const changed = run('edited', '--states', path.join(root, 'edited-states.json'), '--same', path.join(root, 'base'));
  assert.match(changed.stdout, /^same: 0 identical, 0 equal, 1 changed, 0 new, 0 missing$/m, changed.stdout);
  assert.match(changed.stdout, /^ {2}card \/ rest \/ en @320: changed; .*; 1 new page error\(s\): edited boom$/m, changed.stdout);
  t.diagnostic(`wall time: 3 runs ${Date.now() - started} ms`);
});
