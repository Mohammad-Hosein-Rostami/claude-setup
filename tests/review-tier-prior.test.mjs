// Tests for the finding counter of review-tier's `--prior` report (lib/prior.mjs): which lines of a review report are findings, by
// severity, and which id each has. The count is what a fix round's reviewers must add up to, so a missed row is a finding nobody
// has to verify and a phantom one lets a deleted finding pass (lane r7-delta, security S5 and review N3 and N7).
// Fixtures: the row shapes of the round-9 reports (p0-0.1-review2, p0-0.2-review, p0-0.2-security) and the quoted contract of p0-0.3-fix1.
// The file itself (hash, size, kind) and the brief: review-tier-delta-brief.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countFindings } from '../home/tools/review-tier/lib/prior.mjs';

const HEADER = '| id | severity | file:line | what is wrong | fix proposed |\n|---|---|---|---|---|\n';
const count = (text) => { const { blocking, shouldFix, findings } = countFindings(text); return [blocking, shouldFix, findings]; };

test('a severity cell counts by its first word: with text after it, in bold, underscores or backticks, in any letter case', () => {
  const rows = [
    '| R5 | should-fix (not run on Linux) | `tests/project-agents-names.test.mjs:81` | The fixture name is 80 x | shorten |',
    "| S7 | should-fix (outside this lane's files: one follow-up row) | see below | old text | one row |",
    '| B1 | **blocking** | `home/hooks/lib/rm-paths.mjs:165-173` | one new string per glob | cap it |',
    '| S2 | _should-fix_ | a.mjs:1 | x | y |',
    '| S3 | `should-fix` | a.mjs:1 | x | y |',
    '| S4 | Should fix | a.mjs:1 | x | y |',
    '| B2 | BLOCKING, security | a.mjs:1 | x | y |',
  ];
  for (const row of rows) assert.equal(countFindings(`${HEADER}${row}\n`).findings, 1, row);
  const all = countFindings(`${HEADER}${rows.join('\n')}\n`);
  assert.deepEqual([all.blocking, all.shouldFix], [2, 5]);
  assert.deepEqual(all.ids, ['R5', 'S7', 'B1', 'S2', 'S3', 'S4', 'B2']);
});

test('review N7 (mutant R6): 1 blocking and 2 should-fix are counted each under its own severity', () => {
  assert.deepEqual(count(`${HEADER}| B1 | blocking | a:1 | x | y |\n| S1 | should-fix | a:2 | x | y |\n- [should-fix] S2 a.mjs:3: z\n`), [1, 2, 3]);
  assert.deepEqual(count('- [blocking] O1 a.mjs:3: x\n- [should-fix] F1 a.mjs:4: y\n- [should-fix] F2 a.mjs:5: z\n'), [1, 2, 3]);
});

test('a row is read by its severity column alone: the words in another cell, a note row and a status table are no findings', () => {
  const report = [
    HEADER.trimEnd(),
    '| N1 | note | a.mjs:1 | blocking the land loop would be worse | should-fix it later |',
    '| S1 | should-fix | a.mjs:2 | Blocking is what the fix proposed was once marked [blocking] | y |',
    '',
    '| id | status | evidence |',
    '|---|---|---|',
    '| B1 | **open** | blocking, reported again above |',
    '| S3 | fixed | should-fix no more |',
    '',
    '| **sec B1** (blocking): a build agent is sent into the main checkout | fixed | abc1234 |',
  ].join('\n');
  const result = countFindings(report);
  assert.deepEqual([result.blocking, result.shouldFix], [0, 1]);
  assert.deepEqual(result.ids, ['S1']);
});

test('a table without a severity header counts a row by its first cell that starts with the word', () => {
  assert.deepEqual(count('| B1 | blocking | guard missing |\n| S1 | should-fix | cause lost |\n| N1 | note | fix it later |\n'), [1, 1, 2]);
  assert.deepEqual(count('| B1 | blocker | x |\n| S1 | should-fixed | x |\n| S2 | blocking-ish | x |\n'), [0, 0, 0], 'the word, not a longer one');
});

test('security S5: quoted lines, fenced blocks and code spans cite a finding or the contract and are not counted', () => {
  const contract = 'Each finding line in it carries its severity as a tag or a table cell (`[blocking]`, `| should-fix |`); `review-tier` counts those marks.';
  const report = [
    `> - With a blocking or should-fix finding always write the findings file: ${contract}`,
    `- ${contract}`,
    '> | Q1 | blocking | a quoted row |',
    '> - [blocking] Q2 a.mjs:1: a quoted tag',
    '```',
    '| F1 | blocking | a row in a fenced block |',
    '- [should-fix] F2 a.mjs:1: a tag in a fenced block',
    '```',
    '~~~md',
    '- [blocking] F3 a.mjs:1: another fence',
    '~~~',
    'The agent text says `- [blocking] id file:line` and no more.',
    '- [should-fix] S1 a.mjs:2: the one real finding, which cites `[blocking]`',
  ].join('\n');
  const result = countFindings(report);
  assert.deepEqual([result.blocking, result.shouldFix, result.ids], [0, 1, ['S1']]);
});

test('the review workflow\'s own list is counted line by line, whatever the problem text holds', () => {
  const lines = ['- [blocking] O1 a.mjs:3: uses a ` in a string', '- [should-fix] F1 "b c.mjs":4: says [blocking] and | blocking | and > quote', '- [optional] N1 a.mjs:1: a nit'];
  const result = countFindings(`${lines.join('\n')}\n`);
  assert.deepEqual([result.blocking, result.shouldFix, result.ids], [1, 1, ['O1', 'F1']]);
});

test('ids are short plain words; a finding whose line names none is listed by its line number, never by its text', () => {
  const report = ['intro', '- [blocking] src/a.mjs:3 - no id on this line', '| **B3** (again) | blocking | x |', '| <script>alert(1)</script> | should-fix | x |', '- [should-fix] R2-1: fine', `- [blocking] ${'x'.repeat(40)} too long`].join('\n');
  assert.deepEqual(countFindings(report).ids, ['(line 2)', 'B3', '(line 4)', 'R2-1', '(line 6)']);
});

test('an escaped pipe stays inside its cell; a report with no finding counts 0', () => {
  assert.deepEqual(count(`${HEADER}| S1 | should-fix | a.mjs:1 | says a \\| blocking \\| cell | y |\n`), [0, 1, 1]);
  assert.deepEqual(countFindings('No findings.\nA sentence that says blocking and should-fix is no finding.\n'), { blocking: 0, shouldFix: 0, findings: 0, ids: [] });
});
