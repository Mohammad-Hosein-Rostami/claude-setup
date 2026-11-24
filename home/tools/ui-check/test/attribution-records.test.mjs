// Purpose: browser-free tests for lib/attribution-records.mjs on a pngjs cache folder and capture in a temp dir: acceptanceContext,
// attributeRecords (which records, the recount gate, the default and strict rules, size mismatch, matrix acceptances, crops),
// formatAttribution, writeAttribution and the `run --strict` hook attributeStrict. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import pngjs from 'pngjs';
import { acceptanceContext, ATTRIBUTION_FILE, attributeRecords, attributeStrict, formatAttribution, writeAttribution } from '../lib/attribution-records.mjs';
import { UsageError } from '../lib/errors.mjs';
import { isolateEach } from './isolated-env.mjs';

const { PNG } = pngjs;
const root = isolateEach('attr-records');
const [W, H] = [8, 4];
const TEXT_PX = [2, 1]; // inside the TEXT box 1,1 3x2: left out by the default rule
const FRAME_PX = [6, 2]; // inside the frame only: "other"
const REASON = 'Card shadow renders softer in Chromium';
const NODES = [{ id: '1:1', name: 'Card', type: 'FRAME', x: 0, y: 0, w: W, h: H }, { id: '1:2', name: 'Title', type: 'TEXT', text: 'Hi', x: 1, y: 1, w: 3, h: 2 }];

function writeImage(file, changed) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([255, 255, 255, 255], i);
  for (const [x, y] of changed) png.data.set([0, 0, 0, 255], (y * W + x) * 4);
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** A cache folder (white baseline) and a capture with `changed` px black; returns the compare record that points at them. */
function compareRecord({ changed, driftPixels, rule = 'default', findings = [{ check: 'pixel', percent: 6.25 }], locale = 'en', capture = true }) {
  const cache = path.join(root(), 'cache', 'KEY', '1-1');
  const state = path.join(root(), 'out', 'card-rest');
  for (const dir of [cache, state]) fs.mkdirSync(dir, { recursive: true });
  writeImage(path.join(cache, 'baseline.png'), []);
  fs.writeFileSync(path.join(cache, 'spec.json'), JSON.stringify({ root: { id: '1:1', name: 'Card', w: W, h: H, render: null }, nodes: NODES }));
  fs.writeFileSync(path.join(cache, 'meta.json'), JSON.stringify({ scale: 1, width: W, height: H }));
  if (capture) writeImage(path.join(state, 'actual.png'), changed);
  else fs.rmSync(path.join(state, 'actual.png'), { force: true });
  const images = { baseline: path.join(cache, 'baseline.png'), actual: path.join(state, 'actual.png'), diff: path.join(state, 'diff.png') };
  return { part: 'compare', surface: 'card', state: 'rest', locale, width: W, status: 'fail', rule, driftPixels, evidence: path.join(state, 'report.md'), findings, images };
}

function matrixFile(own) {
  const file = path.join(root(), 'matrix.json');
  const matrix = { frames: [{ node: '1:1', width: W, cells: [{ surface: 'card', state: 'rest', locale: 'en' }] }], accepted: [{ node: '1:1', surface: 'card', state: 'rest', locale: 'en', reason: REASON, findings: [own] }] };
  fs.writeFileSync(file, JSON.stringify(matrix));
  return file;
}

const DEFAULT = { strict: false, acceptance: null };
const STRICT = { strict: true, acceptance: null };

test('acceptanceContext: no file is null; a file gives its matrix; a missing or broken file is a UsageError naming --accepted', () => {
  assert.equal(acceptanceContext(undefined), null);
  const file = matrixFile({ check: 'pixel', maxPercent: 10 });
  assert.deepEqual(acceptanceContext(file).matrix.accepted[0].reason, REASON);
  const missing = path.join(root(), 'none.json');
  assert.throws(() => acceptanceContext(missing), (error) => error instanceof UsageError && error.message.startsWith(`--accepted ${missing}: `));
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => acceptanceContext(file), UsageError);
});

test('attributeRecords: only compare records with an actual and a baseline image are attributed', () => {
  const good = compareRecord({ changed: [FRAME_PX], driftPixels: 1 });
  const others = [{ ...good, part: 'responsive' }, { ...good, images: undefined }, { ...good, images: { actual: good.images.actual } }];
  const results = attributeRecords([...others, good], DEFAULT);
  assert.equal(results.length, 1);
  assert.equal(results[0].record, good);
  assert.deepEqual(attributeRecords([], DEFAULT), []);
});

test('attributeRecords: the default rule leaves TEXT boxes out, fails on "other" and writes baseline | actual | diff crops', () => {
  const record = compareRecord({ changed: [TEXT_PX, FRAME_PX], driftPixels: 1 });
  const [result] = attributeRecords([record], DEFAULT);
  assert.deepEqual([result.label, result.rule, result.total, result.pass, result.why], ['card / rest / en @8', 'default', 1, false, 'other']);
  assert.deepEqual([result.classes['text-aa'].px, result.classes.other.px], [0, 1]);
  const dir = path.join(path.dirname(record.images.actual), 'attribution');
  assert.deepEqual(result.crops, [{ class: 'other', files: ['baseline', 'actual', 'diff'].map((panel) => path.join(dir, `1-other-${panel}.png`)) }]);
  const diff = PNG.sync.read(fs.readFileSync(result.crops[0].files[2]));
  assert.deepEqual([diff.width, diff.height], [W, H], 'the 8 px margin is clipped to the 8x4 image');
  assert.deepEqual([...diff.data.subarray((FRAME_PX[1] * W + FRAME_PX[0]) * 4, (FRAME_PX[1] * W + FRAME_PX[0]) * 4 + 4)], [255, 0, 0, 255]);
});

test('attributeRecords: no pixel finding under the default rule fails nothing; no locale reads "default" in the label', () => {
  const [result] = attributeRecords([compareRecord({ changed: [FRAME_PX], driftPixels: 1, findings: [], locale: null })], DEFAULT);
  assert.deepEqual([result.label, result.pass, result.why, [...result.failing]], ['card / rest / default @8', true, '', []]);
});

test('attributeRecords: strict counts every px; text anti-aliasing passes, "other" fails', () => {
  const [textOnly] = attributeRecords([compareRecord({ changed: [TEXT_PX], driftPixels: 0 })], STRICT);
  assert.deepEqual([textOnly.rule, textOnly.total, textOnly.classes['text-aa'].px, textOnly.pass], ['strict', 1, 1, true]);
  const [both] = attributeRecords([compareRecord({ changed: [TEXT_PX, FRAME_PX], driftPixels: 2, rule: 'strict' })], DEFAULT);
  assert.deepEqual([both.rule, both.pass, both.why], ['strict', false, 'other']);
});

test('attributeRecords: a recount other than driftPixels and a missing capture are UsageErrors (exit 2), never a pass', () => {
  const record = compareRecord({ changed: [FRAME_PX], driftPixels: 3 });
  assert.throws(() => attributeRecords([record], DEFAULT), { name: 'UsageError', message: `card / rest / en @8: recounted 1 colour-metric px, the record says 3 (${record.evidence})` });
  const absent = compareRecord({ changed: [], driftPixels: 0, capture: false });
  assert.throws(() => attributeRecords([absent], DEFAULT), { name: 'UsageError', message: `capture not found: ${absent.images.actual}` });
});

test('attributeRecords: a pixel finding without a percent (size mismatch) never passes, even with no leftover px', () => {
  const [result] = attributeRecords([compareRecord({ changed: [], driftPixels: 0, findings: [{ check: 'pixel' }] })], STRICT);
  assert.deepEqual([result.total, result.pass, result.why], [0, false, 'size mismatch (never accepted)']);
});

test('attributeRecords: a matrix entry with a reason accepts the px up to its maxPercent; an unknown node is a UsageError', () => {
  const record = () => compareRecord({ changed: [TEXT_PX, FRAME_PX], driftPixels: 2, rule: 'strict' });
  const accepted = (own) => attributeRecords([record()], { strict: true, acceptance: acceptanceContext(matrixFile(own)) })[0];
  const whole = accepted({ check: 'pixel', maxPercent: 10 });
  assert.deepEqual([whole.classes.accepted, whole.pass], [{ px: 2, nodes: [{ label: REASON, px: 2 }] }, true]);
  assert.equal(accepted({ check: 'pixel', maxPercent: 10, nodes: ['1:1'] }).classes.accepted.px, 2);
  assert.equal(accepted({ check: 'pixel', maxPercent: 5 }).pass, false, '6.25 % is above maxPercent 5');
  assert.throws(() => accepted({ check: 'pixel', maxPercent: 10, nodes: ['1:9'] }), { name: 'UsageError', message: `accepted entry "${REASON}" names node 1:9, which is not in the Figma spec` });
});

test('formatAttribution: a header per record, one row per class with px, then the crop paths', () => {
  const results = attributeRecords([compareRecord({ changed: [FRAME_PX], driftPixels: 1 })], DEFAULT);
  const files = results[0].crops[0].files.join(' | ');
  assert.deepEqual(formatAttribution(results), [
    'attribute card / rest / en @8 (rule default): 1 px, recount matches -> FAIL (other)',
    '  | other | 1 px | FAIL | Card (1:1) 1 px |',
    `    crop other: ${files}`,
  ]);
  const [pass] = attributeRecords([compareRecord({ changed: [TEXT_PX], driftPixels: 0 })], STRICT);
  assert.deepEqual(formatAttribution([pass]).slice(0, 2), ['attribute card / rest / en @8 (rule strict): 1 px, recount matches -> PASS', '  | text anti-aliasing | 1 px | pass | Title (1:2) 1 px |']);
});

test('writeAttribution: writes attribution.json into the folder: no record, its evidence, failing as a list', () => {
  const record = compareRecord({ changed: [FRAME_PX], driftPixels: 1, rule: 'strict' });
  const file = writeAttribution(root(), attributeRecords([record], DEFAULT));
  assert.equal(file, path.join(root(), ATTRIBUTION_FILE));
  assert.equal(ATTRIBUTION_FILE, 'attribution.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('}\n]\n'));
  const [row] = JSON.parse(text);
  assert.equal(row.record, undefined);
  assert.deepEqual([row.evidence, row.failing, row.pass, row.label], [record.evidence, ['text-flagged', 'graphic', 'other'], false, 'card / rest / en @8']);
});

test('attributeStrict: a strict compare failing only on text anti-aliasing passes; results, summary, ledger and attribution are rewritten', () => {
  const outDir = path.join(root(), 'out');
  const strict = compareRecord({ changed: [TEXT_PX], driftPixels: 1, rule: 'strict', findings: [{ check: 'pixel', percent: 3.1 }, { check: 'bidi-field?' }] });
  const other = { part: 'responsive', surface: 'card', state: 'rest', locale: 'en', width: 320, status: 'pass', evidence: 'r.md', findings: [] };
  const ledger = { states: [{ surface: 'card', state: 'rest', locale: 'en', width: W, status: 'fail' }, { surface: 'card', state: 'rest', locale: 'en', width: 320, status: 'pass' }] };
  const out = attributeStrict({ records: [strict, other], outDir, ledger }, undefined);
  assert.equal(out.code, 0);
  assert.deepEqual([out.records[0].status, out.records[0].findings, out.records[0].attribution], ['pass', [{ check: 'bidi-field?' }], { accepted: 0, 'text-aa': 1, 'text-flagged': 0, graphic: 0, other: 0 }]);
  assert.equal(out.records[1], other);
  assert.deepEqual(out.ledger.states.map((row) => row.status), ['pass', 'pass']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')), out.records);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'ledger.json'), 'utf8')), out.ledger);
  assert.match(fs.readFileSync(path.join(outDir, 'summary.md'), 'utf8'), /^# ui-check batch: PASS/);
  assert.ok(fs.existsSync(path.join(outDir, ATTRIBUTION_FILE)));
  assert.equal(out.lines[0], 'attribution (strict rule):');
});

test('attributeStrict: with no strict pixel-only failure nothing is written; a failing attribution writes only attribution.json', () => {
  const outDir = path.join(root(), 'out');
  const element = compareRecord({ changed: [FRAME_PX], driftPixels: 1, rule: 'strict', findings: [{ check: 'pixel', percent: 3 }, { check: 'element' }] });
  const records = [element, { ...element, rule: 'default', findings: [{ check: 'pixel', percent: 3 }] }];
  const none = attributeStrict({ records, outDir, ledger: null }, undefined);
  assert.deepEqual([none.records === records, none.lines, none.code, fs.readdirSync(outDir).sort()], [true, [], 1, ['card-rest']]);
  const failing = compareRecord({ changed: [FRAME_PX], driftPixels: 1, rule: 'strict', findings: [{ check: 'pixel', percent: 3 }] });
  const ledger = { states: [] };
  const out = attributeStrict({ records: [failing], outDir, ledger }, undefined);
  assert.deepEqual([out.records[0], out.ledger, out.code], [failing, ledger, 1]);
  assert.deepEqual(fs.readdirSync(outDir).sort(), [ATTRIBUTION_FILE, 'card-rest']);
});
