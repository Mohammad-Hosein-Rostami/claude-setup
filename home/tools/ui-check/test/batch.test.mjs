// Purpose: browser-free tests for `batch`: states-file schema validation (errors name the state index and field), --only selection,
// the result records (field names are consumed by `ui-coverage check --results`), and the results.json / summary.md writer. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { parse } from '../lib/args.mjs';
import { compareRecords, errorRecords, exitCodeFor, responsiveRecords, summaryMarkdown, writeBatchResults } from '../lib/batch-records.mjs';
import { isHint } from '../lib/bidi.mjs';
import { UsageError } from '../lib/errors.mjs';
import { loadStatesFile, parseStates, selectSurfaces } from '../lib/states.mjs';
import { guarded, options as batchOptions, run as runBatch, runState } from '../commands/batch.mjs';

const usage = (pattern) => (error) => error instanceof UsageError && pattern.test(error.message);
const BASE = '/tmp/states';
const good = () => ({
  defaults: { baseUrl: 'http://localhost:3000', locale: 'en', colorScheme: 'dark', widths: [320, 1024], storage: { lang: 'en' }, cookies: { sid: 'x' } },
  states: [
    { surface: 'login', state: 'rtl-dropdown', locale: 'fa-ir', url: '/login', expectDir: 'rtl', storage: { lang: 'fa', extra: '1' }, steps: [{ action: 'click', selector: '#menu' }] },
    { surface: 'home', state: 'default', url: 'http://localhost:4000/', widths: [390], figma: { file: 'F:1', node: '2:3', map: 'map.json', root: '#card' } },
  ],
});
const bad = (mutate, pattern) => {
  const raw = good();
  mutate(raw);
  assert.throws(() => parseStates(raw, BASE), usage(pattern));
};

test('a valid file is normalised: urls joined, defaults merged, locale canonical, figma resolved against the file', () => {
  const [first, second] = parseStates(good(), BASE);
  assert.equal(first.url, 'http://localhost:3000/login');
  assert.deepEqual(first.widths, [320, 1024]);
  assert.equal(first.locale, 'fa-IR');
  assert.equal(first.figma, null);
  assert.deepEqual(first.context, {
    locale: 'fa-IR', colorScheme: 'dark', expectDir: 'rtl',
    storage: [{ name: 'lang', value: 'fa' }, { name: 'extra', value: '1' }], cookies: [{ name: 'sid', value: 'x' }],
  });
  assert.equal(second.url, 'http://localhost:4000/');
  assert.deepEqual(second.widths, [390]);
  assert.equal(second.locale, 'en');
  assert.equal(second.figma.map, path.join(BASE, 'map.json'));
  assert.equal(second.figma.root, '#card');
  assert.match(second.figma.cache, /\.cache.figma.F-1.2-3$/);
});

test('schema errors name the state index and the field', () => {
  bad((r) => { delete r.states[1].url; }, /states\[1\]\.url/);
  bad((r) => { r.states[0].locale = 'not a tag'; }, /states\[0\]\.locale/);
  bad((r) => { r.states[1].expectDir = 'up'; }, /states\[1\]\.expectDir/);
  bad((r) => { r.states[0].surface = ''; }, /states\[0\]\.surface/);
  bad((r) => { r.states[1].widths = [100]; }, /states\[1\]\.widths/);
  bad((r) => { r.states[0].storage = { a: 1 }; }, /states\[0\]\.storage\.a/);
  bad((r) => { r.states[0].cookies = { 'bad name': 'v' }; }, /states\[0\]\.cookies/);
  bad((r) => { delete r.states[1].figma.node; }, /states\[1\]\.figma\.node/);
  bad((r) => { r.states[0].steps = [{ action: 'dance' }]; }, /states\[0\]\.steps.*step 1/);
  bad((r) => { r.states[0].colour = 'x'; }, /states\[0\].*unknown field "colour"/);
  bad((r) => { r.states[0].url = 'http://[bad'; }, /states\[0\]\.url/);
});

test('top-level and defaults errors; a state with neither figma nor widths; a duplicate state', () => {
  assert.throws(() => parseStates([], BASE), usage(/object/));
  assert.throws(() => parseStates({ states: 'x' }, BASE), usage(/states.*array/));
  assert.deepEqual(parseStates({ states: [] }, BASE), []);
  assert.throws(() => parseStates({ states: [{}], extra: 1 }, BASE), usage(/unknown field "extra"/));
  bad((r) => { r.defaults.colorScheme = 'blue'; }, /defaults\.colorScheme/);
  bad((r) => { r.defaults.widths = []; }, /defaults\.widths/);
  bad((r) => { delete r.defaults.widths; }, /states\[0\].*figma or widths/);
  bad((r) => { r.states[1] = { ...r.states[0] }; }, /states\[1\].*duplicate.*login.*rtl-dropdown/);
  bad((r) => { delete r.defaults.baseUrl; }, /states\[0\]\.url/);
});

test('loadStatesFile reports unreadable files and bad JSON as usage errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  assert.throws(() => loadStatesFile(path.join(dir, 'missing.json')), usage(/--states/));
  fs.writeFileSync(path.join(dir, 'bad.json'), '{nope');
  assert.throws(() => loadStatesFile(path.join(dir, 'bad.json')), usage(/--states/));
  fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify(good()));
  assert.equal(loadStatesFile(path.join(dir, 'ok.json')).length, 2);
});

test('steps may be a path (relative to the states file) to a steps JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'states-'));
  fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify([{ action: 'blur' }]));
  const raw = good();
  raw.states[0].steps = 's.json';
  assert.deepEqual(parseStates(raw, dir)[0].steps, [{ action: 'blur' }]);
});

test('--only keeps the listed surfaces; a partly unknown list is rejected, a fully unknown one selects nothing', () => {
  const states = parseStates(good(), BASE);
  assert.deepEqual(selectSurfaces(states, 'home').map((s) => s.surface), ['home']);
  assert.equal(selectSurfaces(states, 'home,login').length, 2);
  assert.equal(selectSurfaces(states, undefined).length, 2);
  assert.deepEqual(selectSurfaces(states, 'nope'), [], 'nothing matches: the run reports it, selection does not throw');
  assert.throws(() => selectSurfaces(states, 'home,nope'), usage(/--only.*nope/));
});

test('batch flags: --states required elsewhere, --only and --out parse, unknown flags rejected', () => {
  const values = parse(['--states', 's.json', '--only', 'a,b', '--out', 'o'], batchOptions);
  assert.deepEqual([values.states, values.only, values.out], ['s.json', 'a,b', 'o']);
  assert.throws(() => parse(['--bogus'], batchOptions), UsageError);
});

const state = parseStates(good(), BASE)[0];

test('compareRecords: a pass has no findings; element rows and a pixel miss become findings; width is null', () => {
  const pixels = { pass: false, diffPercent: 1.5, diffCount: 30, sizeMismatch: null };
  const elementRows = [{ element: 'Title', prop: 'font-size', is: 16, should: 18, delta: 2 }];
  const [fail] = compareRecords(state, { pass: false, md: '/o/report.md', pixels, elementRows }, { root: '#card', maxDiff: 0.5 });
  assert.deepEqual([fail.surface, fail.state, fail.locale, fail.width, fail.status, fail.evidence], ['login', 'rtl-dropdown', 'fa-IR', null, 'fail', '/o/report.md']);
  assert.deepEqual(fail.findings.map((f) => f.check), ['element', 'pixel']);
  const [pass] = compareRecords(state, { pass: true, md: '/o/report.md', pixels: { ...pixels, pass: true }, elementRows: [] }, { root: '#card', maxDiff: 0.5 });
  assert.deepEqual([pass.status, pass.findings], ['pass', []]);
});

test('responsiveRecords: one record per width, findings split by width, status per width', () => {
  const findings = [{ width: 320, check: 'hscroll', element: 'html', detail: 'd' }, { width: 320, check: 'bidi-field', element: 'input#p', detail: 'd2' }];
  const records = responsiveRecords(state, [320, 1024], { findings, md: '/o/r/report.md' });
  assert.deepEqual(records.map((r) => [r.width, r.status, r.findings.length, r.evidence]), [[320, 'fail', 2, '/o/r/report.md'], [1024, 'pass', 0, '/o/r/report.md']]);
  assert.deepEqual(records[0].findings[0], { check: 'hscroll', element: 'html', detail: 'd' });
});

test('errorRecords: the error message is the finding, one record per planned slot, evidence is the state directory', () => {
  const records = errorRecords(state, [null, 320], new UsageError('step 1 (click): boom'), '/o/login');
  assert.deepEqual(records.map((r) => [r.width, r.status, r.evidence]), [[null, 'fail', '/o/login'], [320, 'fail', '/o/login']]);
  assert.match(records[0].findings[0].detail, /boom/);
});

test('writeBatchResults writes results.json (record fields unchanged) and summary.md (one row per record); exit code follows the records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-out-'));
  const records = [
    ...responsiveRecords(state, [320, 1024], { findings: [{ width: 320, check: 'hscroll', element: 'html', detail: 'd' }], md: '/o/report.md' }),
    ...compareRecords(state, { pass: true, md: '/o/c.md', pixels: { pass: true }, elementRows: [] }, { root: 'body', maxDiff: 0 }),
  ];
  writeBatchResults(dir, records);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  assert.deepEqual(written, records);
  assert.deepEqual(Object.keys(written[0]), ['surface', 'state', 'locale', 'width', 'status', 'evidence', 'findings']);
  const rows = fs.readFileSync(path.join(dir, 'summary.md'), 'utf8').split('\n').filter((line) => line.startsWith('| login'));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /\| login \| rtl-dropdown \| fa-IR \| 320 \| fail \| 1 \|/);
  assert.match(rows[2], /\| - \| pass \| 0 \|/);
  assert.equal(exitCodeFor(records), 1);
  assert.equal(exitCodeFor(records.filter((r) => r.status === 'pass')), 0);
  assert.match(summaryMarkdown(records), /^# ui-check batch: FAIL/);
});

const quiet = () => mock.method(console, 'error', () => {});
const noBrowser = { contexts: () => [], close: async () => {} };

test('an error record\'s evidence folder exists, holds the stack, and the throwing part does not stop the run', async () => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-out-'));
  const missingCache = { ...parseStates(good(), BASE)[1], figma: { cache: path.join(outRoot, 'no-such-cache'), map: null, root: 'body' }, widths: null };
  const records = await runState(noBrowser, missingCache, outRoot);
  assert.equal(records[0].status, 'fail');
  assert.ok(fs.existsSync(records[0].evidence), 'evidence path exists');
  assert.match(fs.readFileSync(path.join(records[0].evidence, 'compare.error.txt'), 'utf8'), /UsageError[\s\S]*at /);
});

test('a context.close() that throws is recorded as a failure and does not abort the run', async () => {
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-out-'));
  const browser = { contexts: () => [{ close: async () => { throw new Error('browser crashed'); } }] };
  const passing = async () => responsiveRecords(state, [320], { findings: [], md: '/o/r.md' });
  const records = await guarded(browser, { state, dir: path.join(outRoot, 's'), part: 'responsive', slots: [320], job: passing });
  assert.equal(records[0].status, 'fail');
  assert.match(records[0].findings.at(-1).detail, /browser crashed/);
  assert.ok(fs.existsSync(path.join(outRoot, 's', 'responsive.error.txt')), 'the close failure is kept next to the reports');
});

test('hint findings do not fail a record but stay in its findings', () => {
  const hint = { width: 320, check: 'bidi-field?', element: 'input#p', detail: 'maybe' };
  const [record] = responsiveRecords(state, [320], { findings: [hint], md: '/o/r.md' });
  assert.deepEqual([record.status, record.findings.length, isHint(record.findings[0])], ['pass', 1, true]);
  assert.equal(exitCodeFor([record]), 0);
});

test('zero states: exit 1, a clear message, results.json is [] and a stale one is gone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-zero-'));
  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'results.json'), '[{"status":"pass"}]');
  fs.writeFileSync(path.join(out, 'summary.md'), '# ui-check batch: PASS');
  const file = path.join(dir, 'states.json');
  const errors = quiet();
  try {
    fs.writeFileSync(file, JSON.stringify({ states: [] }));
    assert.equal(await runBatch(['--states', file, '--out', out]), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')), []);
    assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /FAIL[\s\S]*no states ran/);
    assert.match(errors.mock.calls[0].arguments[0], /no states to run/);
    fs.writeFileSync(file, JSON.stringify(good()));
    fs.writeFileSync(path.join(out, 'results.json'), '[{"status":"pass"}]');
    assert.equal(await runBatch(['--states', file, '--only', 'nope', '--out', out]), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')), []);
    assert.match(errors.mock.calls.at(-1).arguments[0], /--only nope.*home.*login|--only nope.*login.*home/);
  } finally {
    errors.mock.restore();
  }
});

test('a setup error also removes a stale results.json and summary.md from --out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-stale-'));
  fs.writeFileSync(path.join(dir, 'results.json'), '[{"status":"pass"}]');
  fs.writeFileSync(path.join(dir, 'summary.md'), 'old');
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{nope');
  await assert.rejects(runBatch(['--states', file, '--out', dir]), usage(/--states/));
  assert.equal(fs.existsSync(path.join(dir, 'results.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'summary.md')), false);
});
