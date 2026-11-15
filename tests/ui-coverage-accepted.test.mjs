// Tests for the compare gate of ui-coverage (lib/accepted.mjs): a failing Figma compare may be accepted only when an
// `accepted` entry covers every finding and its owner ref is a decision the owner made (ask queue answer, or a line under
// Standing rules / Owner decisions in a notes file). `check` runs in process with an injected readText.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMatrix } from '../home/tools/ui-coverage/lib/check.mjs';
import { formatReport } from '../home/tools/ui-coverage/lib/report.mjs';

const QUEUE = '/m/queue.jsonl';
const NOTES = '/m/STATUS.md';
const SIGN_IN = { node: '12:40', name: 'Sign in', width: 1440, cells: [{ surface: 'signin', state: 'rest', locale: 'en' }] };
const CELL = { surface: 'signin', state: 'rest', locale: 'en' };
const QUESTION = { type: 'q', id: 'q2', question: 'Keep the extra link on the sign in page?', why: 'It is not in Figma', options: [{ label: 'Match Figma', effect: 'remove' }, { label: 'Keep it', effect: 'keep' }], recommended: 'Match Figma', blocks: 'sign in', from: 'visual-qa' };
const KEEP_LINK = 'Keep the extra link';
const answerLine = (extra = {}) => JSON.stringify({ type: 'a', id: 'q2', ts: 't', answer: KEEP_LINK, ...extra });
const queueText = (...lines) => [JSON.stringify(QUESTION), ...lines].join('\n');
const STANDING = '- 12:40 sign in: keep a.extra-link, owner said yes on 2026-11-02';

const elementFinding = (element) => ({ check: 'element', element, detail: 'is different' });
const failRecord = (findings, extra = {}) => ({ ...CELL, width: 1440, status: 'fail', evidence: 'https://x/report', part: 'compare', findings, ...extra });
const accept = (owner, findings = [{ check: 'element', element: 'a.extra-link' }], extra = {}) => ({ node: '12:40', ...CELL, findings, ...(owner === undefined ? {} : { owner }), ...extra });
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
function check(accepted, records, files = {}) {
  const texts = { '/m/frames.json': FRAMES_TEXT, ...files };
  return checkMatrix(matrixWith(accepted), records, { baseDir: '/m', readText: (path) => texts[path] ?? null });
}
const ownerWhy = (result) => result.problems.filter((p) => p.code === 'owner-ref').map((p) => p.message.replace(/^.*has no owner decision: /, '').replace(/; ask the owner or match Figma$/, ''));
const LINK_FAIL = failRecord([elementFinding('a.extra-link')]);

test('T5 owner-ref: no owner, an unanswered q2, a differing answer, a timeout answer with the matching text, and a line under another heading are not owner decisions', () => {
  const refAsk = { ask: `${QUEUE}#q2`, answer: KEEP_LINK };
  const cases = [
    [accept(undefined), {}, 'no owner field'],
    [accept(refAsk), { [QUEUE]: queueText() }, 'q2 unanswered'],
    [accept(refAsk), { [QUEUE]: queueText(answerLine({ answer: 'Match Figma' })) }, 'answer differs'],
    [accept(refAsk), { [QUEUE]: queueText(answerLine({ by: 'timeout' })) }, 'q2 was taken by timeout, not answered by the owner'],
    [accept(refAsk), {}, 'queue missing (copy the decision into STATUS.md Standing rules)'],
    [accept({ status: 'STATUS.md', line: STANDING }), { [NOTES]: `## Taken by default\n${STANDING}\n` }, 'line not under those headings (## Standing rules, ## Owner decisions)'],
    [accept({ status: 'STATUS.md', line: STANDING }), { [NOTES]: `## Standing rules\nnothing here\n## Taken by default\n${STANDING}\n` }, 'line not under those headings (## Standing rules, ## Owner decisions)'],
    [accept({ status: 'STATUS.md', line: '- keep a.extra-link, owner said yes' }), { [NOTES]: '## Standing rules\n- keep a.extra-link, owner said yes\n' }, 'line does not name 12:40'],
  ];
  for (const [entry, files, why] of cases) {
    const result = check([entry], [LINK_FAIL], files);
    assert.deepEqual(ownerWhy(result), [why], why);
    assert.ok(result.problems.some((p) => p.code === 'fail'), `the cell keeps failing: ${why}`);
    assert.equal(result.accepted.length, 0);
  }
});

test('T5 a matching ask answer, or a line under Standing rules or Owner decisions (also with CRLF), accepts the cell: exit 0 shape, counts and a listing', () => {
  const owners = [
    [accept({ ask: `${QUEUE}#q2`, answer: KEEP_LINK }), { [QUEUE]: queueText(answerLine()) }],
    [accept({ ask: `${QUEUE}#q2`, answer: KEEP_LINK }), { [QUEUE]: queueText(answerLine({ answer: 'old' }), answerLine()) }],
    [accept({ status: 'STATUS.md', line: STANDING }), { [NOTES]: `# Task\n## Standing rules\n${STANDING}\n## Other\n` }],
    [accept({ status: 'STATUS.md', line: STANDING }), { [NOTES]: `## Owner decisions\r\n${STANDING}\r\n` }],
  ];
  for (const [entry, files] of owners) {
    const result = check([entry], [LINK_FAIL], files);
    assert.deepEqual(result.problems, []);
    assert.deepEqual([result.counts.fail, result.counts.accepted, result.accepted.length], [0, 1, 1]);
  }
  const text = formatReport(check([owners[0][0]], [LINK_FAIL], owners[0][1]));
  const lines = text.split('\n');
  assert.equal(lines[0], 'result: PASS');
  assert.match(lines[1], /\| pass 0 \| fail 0 \| accepted 1 \| na 0 /);
  assert.equal(lines[2], 'frames: 0/1 compared and passing, 1 accepted by the owner, 0 not built');
  assert.equal(lines[3], 'accepted by the owner (1):');
  assert.equal(lines[4], `  signin rest en @1440 (frame 12:40) - ask ${QUEUE}#q2`);
});

test('T5 an uncovered element, a percent above maxPercent, or a pixel finding with no number keeps the cell failing; a percent equal to maxPercent is covered', () => {
  const owner = { status: 'STATUS.md', line: STANDING };
  const files = { [NOTES]: `## Standing rules\n${STANDING}\n` };
  const pixel = (percent) => ({ check: 'pixel', element: 'body', detail: 'differs', ...(percent === undefined ? {} : { percent }) });
  const maxPixel = [{ check: 'pixel', maxPercent: 0.8 }];
  assert.ok(check([accept(owner)], [failRecord([elementFinding('a.extra-link'), elementFinding('button.other')])], files).problems.some((p) => p.code === 'fail'));
  assert.ok(check([accept(owner, maxPixel)], [failRecord([pixel(0.81)])], files).problems.some((p) => p.code === 'fail'));
  assert.ok(check([accept(owner, maxPixel)], [failRecord([pixel()])], files).problems.some((p) => p.code === 'fail'));
  assert.deepEqual(check([accept(owner, maxPixel)], [failRecord([pixel(0.8)])], files).problems, []);
  assert.deepEqual(check([accept(owner, [...maxPixel, { check: 'element', element: 'a.extra-link' }])], [failRecord([pixel(0.2), elementFinding('a.extra-link')])], files).problems, []);
  assert.ok(check([accept(owner, [{ check: 'element', element: 'a.extra-link' }])], [failRecord([{ check: 'error', element: 'http://x', detail: 'boom' }])], files).problems.some((p) => p.code === 'fail'), 'an error finding cannot be accepted');
});

test('a cell that also fails in a responsive record, or was set to fail by hand, is not accepted and raises no owner-ref', () => {
  const owner = { status: 'STATUS.md', line: STANDING };
  const files = { [NOTES]: `## Standing rules\n${STANDING}\n` };
  const responsive = failRecord([elementFinding('a.extra-link')], { part: 'responsive' });
  const both = check([accept(owner)], [LINK_FAIL, responsive], files);
  assert.ok(both.problems.some((p) => p.code === 'fail'));
  assert.equal(both.accepted.length, 0);
  const noPart = check([accept(owner)], [failRecord([elementFinding('a.extra-link')], { part: undefined })], files);
  assert.ok(noPart.problems.some((p) => p.code === 'fail'), 'a record without part is not a compare record');
  const handSet = { ...matrixWith([accept(owner)]), cells: [{ ...CELL, width: 1440, status: 'fail', evidence: '', reason: 'by eye: the link is wrong' }] };
  const result = checkMatrix(handSet, [LINK_FAIL], { baseDir: '/m', readText: (path) => ({ '/m/frames.json': FRAMES_TEXT, ...files })[path] ?? null });
  assert.ok(result.problems.some((p) => p.code === 'fail'));
  assert.equal(result.accepted.length, 0);
});

test('an accepted entry naming a node or a cell that frames do not map is an accepted-node problem; a bad entry is a shape problem; a queue that is not JSON lines is unanswered', () => {
  const owner = { status: 'STATUS.md', line: STANDING };
  const elsewhere = check([accept(owner, undefined, { node: '99:9' }), accept(owner, undefined, { state: 'rest:other' })], [LINK_FAIL], { [NOTES]: `## Standing rules\n${STANDING}\n` });
  assert.deepEqual(elsewhere.problems.filter((p) => p.code === 'accepted-node').length, 2);
  assert.ok(elsewhere.problems.some((p) => p.code === 'fail'));
  const bad = check([accept(owner, [])], [LINK_FAIL]);
  assert.deepEqual(bad.problems.map((p) => p.code), ['shape']);
  const garbage = check([accept({ ask: `${QUEUE}#q2`, answer: KEEP_LINK })], [LINK_FAIL], { [QUEUE]: 'not json\n{"half"\n\u0000\u0000' });
  assert.deepEqual(ownerWhy(garbage), ['q2 unanswered']);
  assert.deepEqual(ownerWhy(check([accept({ ask: 'no-hash-here', answer: 'x' })], [LINK_FAIL])), ['owner.ask must look like <queue path>#q2']);
});
