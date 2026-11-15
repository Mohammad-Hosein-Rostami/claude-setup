// Purpose: tests for the `part` tag and the pixel `percent` of `batch` records (T9), which `ui-coverage check` reads to tell
// a compare failure from a responsive one and to compare a pixel finding with an accepted maximum. Exports: none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareRecords, responsiveRecords, withPart } from '../lib/batch-records.mjs';
import { UsageError } from '../lib/errors.mjs';
import { guarded } from '../commands/batch.mjs';

const state = { surface: 'login', state: 'rest', locale: 'en', url: 'http://x/' };
const noBrowser = { contexts: () => [] };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'batch-part-'));

test('withPart tags every record and keeps the other fields', () => {
  const records = responsiveRecords(state, [320, 1024], { findings: [], md: '/o/r.md' });
  const tagged = withPart(records, 'responsive');
  assert.deepEqual(tagged.map((r) => r.part), ['responsive', 'responsive']);
  assert.deepEqual({ ...tagged[0], part: undefined }, { ...records[0], part: undefined });
});

test('guarded tags a compare part, a responsive part and the error records of a part that threw', async () => {
  const dir = tempDir();
  const ok = async () => responsiveRecords(state, [320], { findings: [], md: '/o/r.md' });
  const boom = async () => { throw new UsageError('no cache'); };
  const compareOk = await guarded(noBrowser, { state, dir: path.join(dir, 'a'), part: 'compare', slots: [1440], job: ok });
  const responsiveOk = await guarded(noBrowser, { state, dir: path.join(dir, 'b'), part: 'responsive', slots: [320], job: ok });
  const compareError = await guarded(noBrowser, { state, dir: path.join(dir, 'c'), part: 'compare', slots: [null], job: boom });
  assert.deepEqual([compareOk[0].part, responsiveOk[0].part, compareError[0].part], ['compare', 'responsive', 'compare']);
  assert.equal(compareError[0].status, 'fail');
});

test('a pixel finding carries the diff percent as a number; a size mismatch carries none; element findings are unchanged', () => {
  const result = { md: '/o/c.md', elementRows: [{ element: 'Title', prop: 'font-size', is: 16, should: 18, delta: 2 }] };
  const [diff] = compareRecords(state, { ...result, pixels: { pass: false, diffPercent: 0.75, diffCount: 30, sizeMismatch: null } }, { root: '#card', maxDiff: 0.5, width: 1440 });
  const pixel = diff.findings.find((f) => f.check === 'pixel');
  assert.equal(pixel.percent, 0.75);
  assert.equal('percent' in diff.findings.find((f) => f.check === 'element'), false);
  const [size] = compareRecords(state, { ...result, pixels: { pass: false, diffPercent: 0.1, diffCount: 3, sizeMismatch: { baseline: [1440, 900], actual: [1440, 950] } } }, { root: '#card', maxDiff: 0.5, width: 1440 });
  assert.equal('percent' in size.findings.find((f) => f.check === 'pixel'), false);
});
