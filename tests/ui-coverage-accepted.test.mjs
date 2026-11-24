// Tests for the compare gate of ui-coverage (lib/accepted.mjs): a failing Figma compare may be accepted only when an
// `accepted` entry covers every finding and has a written reason; no owner approval is read (owner, 2026-11-24: the owner
// checks the accepted differences after the work). `check` runs in process with an injected readText.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';
import { formatReport } from '../home/tools/ui-coverage/lib/report.mjs';

const SIGN_IN = { node: '12:40', name: 'Sign in', width: 1440, cells: [{ surface: 'signin', state: 'rest', locale: 'en' }] };
const CELL = { surface: 'signin', state: 'rest', locale: 'en' };
const REASON = 'the extra link on sign in is kept on purpose';

const elementFinding = (element) => ({ check: 'element', element, detail: 'is different' });
const failRecord = (findings, extra = {}) => ({ ...CELL, width: 1440, status: 'fail', evidence: 'https://x/report', part: 'compare', findings, ...extra });
const accept = (findings = [{ check: 'element', element: 'a.extra-link' }], extra = {}) => ({ node: '12:40', ...CELL, findings, reason: REASON, ...extra });
const matrixWith = (accepted) => ({
  locales: [{ tag: 'en', dir: 'ltr' }],
  widths: [1440],
  searched: { backend: ['rg -il mjml api/ -> 0 hits'], siblings: [] },
  deliverable: { reviewUrl: 'http://localhost:4099/review', mockExcluded: 'grep -c authmock dist -> 0' },
  surfaces: [{ id: 'signin', kind: 'screen', source: 'src/signin.tsx', controls: 'none: text only, no controls here' }],
  figma: { file: 'KEY', framesFile: 'frames.json' },
  frames: [SIGN_IN],
  accepted,
  cells: [{ ...CELL, width: 1440, status: 'todo', evidence: '', reason: '' }],
});
const FRAMES_TEXT = JSON.stringify({ file: 'KEY', frames: [{ node: '12:40', name: 'Sign in', width: 1440 }] });
function check(accepted, records) {
  return checkMatrix(matrixWith(accepted), records, { baseDir: '/m', readText: (path) => ({ '/m/frames.json': FRAMES_TEXT })[path] ?? null });
}
const reasonProblems = (result) => result.problems.filter((p) => p.code === 'accepted-reason');
const LINK_FAIL = failRecord([elementFinding('a.extra-link')]);

test('T5 accepted-reason: a covering entry with no reason, a blank one or one under 15 characters keeps the cell failing', () => {
  for (const reason of [undefined, '   ', 'too short']) {
    const result = check([accept(undefined, { reason })], [LINK_FAIL]);
    assert.deepEqual(reasonProblems(result).map((p) => p.message), ['accepted difference on signin rest en @1440 (frame 12:40) has no reason (write why the difference is accepted, 15+ characters); add the reason or match Figma'], String(reason));
    assert.ok(result.problems.some((p) => p.code === 'fail'), `the cell keeps failing: ${reason}`);
    assert.equal(result.accepted.length, 0);
  }
});

test('T5 an entry with a reason accepts the cell with no owner approval (an owner field of an older matrix is not read): counts and a listing', () => {
  const entries = [accept(), accept(undefined, { owner: { ask: '/q/queue.jsonl#q2', answer: 'Keep the extra link' } }), accept(undefined, { owner: { status: 'STATUS.md', line: 'not in any file' } })];
  for (const entry of entries) {
    const result = check([entry], [LINK_FAIL]);
    assert.deepEqual(result.problems, []);
    assert.deepEqual([result.counts.fail, result.counts.accepted, result.accepted.length], [0, 1, 1]);
  }
  const lines = formatReport(check([accept()], [LINK_FAIL])).split('\n');
  assert.equal(lines[0], 'result: PASS');
  assert.match(lines[1], /\| pass 0 \| fail 0 \| accepted 1 \| na 0 /);
  assert.equal(lines[2], 'frames: 0/1 compared and passing, 1 accepted, 0 not built');
  assert.equal(lines[3], 'accepted differences (1):');
  assert.equal(lines[4], `  signin rest en @1440 (frame 12:40) - ${REASON}`);
});

test('T5 an uncovered element, a percent above maxPercent, or a pixel finding with no number keeps the cell failing; a percent equal to maxPercent is covered', () => {
  const pixel = (percent) => ({ check: 'pixel', element: 'body', detail: 'differs', ...(percent === undefined ? {} : { percent }) });
  const maxPixel = [{ check: 'pixel', maxPercent: 0.8 }];
  assert.ok(check([accept()], [failRecord([elementFinding('a.extra-link'), elementFinding('button.other')])]).problems.some((p) => p.code === 'fail'));
  assert.ok(check([accept(maxPixel)], [failRecord([pixel(0.81)])]).problems.some((p) => p.code === 'fail'));
  assert.ok(check([accept(maxPixel)], [failRecord([pixel()])]).problems.some((p) => p.code === 'fail'));
  assert.deepEqual(check([accept(maxPixel)], [failRecord([pixel(0.8)])]).problems, []);
  assert.deepEqual(check([accept([...maxPixel, { check: 'element', element: 'a.extra-link' }])], [failRecord([pixel(0.2), elementFinding('a.extra-link')])]).problems, []);
  assert.ok(check([accept([{ check: 'element', element: 'a.extra-link' }])], [failRecord([{ check: 'error', element: 'http://x', detail: 'boom' }])]).problems.some((p) => p.code === 'fail'), 'an error finding cannot be accepted');
});

test('a cell that also fails in a responsive record, or was set to fail by hand, is not accepted and raises no accepted-reason', () => {
  const responsive = failRecord([elementFinding('a.extra-link')], { part: 'responsive' });
  const both = check([accept()], [LINK_FAIL, responsive]);
  assert.ok(both.problems.some((p) => p.code === 'fail'));
  assert.equal(both.accepted.length, 0);
  assert.deepEqual(reasonProblems(check([accept(undefined, { reason: undefined })], [LINK_FAIL, responsive])), []);
  const noPart = check([accept()], [failRecord([elementFinding('a.extra-link')], { part: undefined })]);
  assert.ok(noPart.problems.some((p) => p.code === 'fail'), 'a record without part is not a compare record');
  const handSet = { ...matrixWith([accept()]), cells: [{ ...CELL, width: 1440, status: 'fail', evidence: '', reason: 'by eye: the link is wrong' }] };
  const result = checkMatrix(handSet, [LINK_FAIL], { baseDir: '/m', readText: (path) => ({ '/m/frames.json': FRAMES_TEXT })[path] ?? null });
  assert.ok(result.problems.some((p) => p.code === 'fail'));
  assert.equal(result.accepted.length, 0);
});

test('an accepted entry naming a node or a cell that frames do not map is an accepted-node problem; a bad entry is a shape problem', () => {
  const elsewhere = check([accept(undefined, { node: '99:9' }), accept(undefined, { state: 'rest:other' })], [LINK_FAIL]);
  assert.deepEqual(elsewhere.problems.filter((p) => p.code === 'accepted-node').length, 2);
  assert.ok(elsewhere.problems.some((p) => p.code === 'fail'));
  const bad = check([accept([])], [LINK_FAIL]);
  assert.deepEqual(bad.problems.map((p) => p.code), ['shape']);
});
