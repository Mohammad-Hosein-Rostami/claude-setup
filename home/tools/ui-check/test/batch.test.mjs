// Purpose: browser-free tests for `batch`: states-file schema validation (errors name the state index and field), --only selection,
// the result records (field names are consumed by `ui-coverage check --results`), and the results.json / summary.md writer. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from '../lib/args.mjs';
import { compareRecords, errorRecords, exitCodeFor, responsiveRecords, summaryMarkdown, writeBatchResults } from '../lib/batch-records.mjs';
import { UsageError } from '../lib/errors.mjs';
import { loadStatesFile, parseStates, selectSurfaces } from '../lib/states.mjs';
import { options as batchOptions } from '../commands/batch.mjs';

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
  assert.throws(() => parseStates({ states: [] }, BASE), usage(/states.*non-empty/));
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

test('--only keeps the listed surfaces and rejects an unknown one', () => {
  const states = parseStates(good(), BASE);
  assert.deepEqual(selectSurfaces(states, 'home').map((s) => s.surface), ['home']);
  assert.equal(selectSurfaces(states, 'home,login').length, 2);
  assert.equal(selectSurfaces(states, undefined).length, 2);
  assert.throws(() => selectSurfaces(states, 'nope'), usage(/--only.*nope/));
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
