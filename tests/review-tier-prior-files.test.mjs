// Tests for the reports a fix round names (`review-tier --delta ... --prior <file> --prior-sha256 <hex>`, the pair once per report):
// a landing set writes two (the reviewer's and the security auditor's), and each is pinned by the sha256 the lead recorded when the
// reviewer returned it, so a report edited between the rounds is refused instead of hashed as it now is (lane r7-delta, security S1
// and review N4: a repeated `--prior` silently kept only the last file).
// Fixture: `f-final.sh` iv of the security review (a finding deleted and a quoted mark added keep the count). The counter itself:
// review-tier-prior.test.mjs; the brief of one report: review-tier-delta-brief.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { lane, priorFile, roundFile, sha256Of } from './review-tier-helpers.mjs';

const REVIEW = '| id | severity | what |\n|---|---|---|\n| B1 | blocking | guard missing |\n| S1 | should-fix | cause lost |\n';
const AUDIT = '- [should-fix] S9 src/run.mjs:2 - no timeout - add one\n';

/** A reviewed lane with a fix on top, the two reports of the round before and its JSON; `fixRound(...args)` runs the CLI as given. */
function fixRoundFixture() {
  const { raw, write } = lane();
  const reviewed = write('src/run.mjs', 'const apiKey = "abc";\nspawnSync(cmd);\n');
  write('src/run.mjs', 'const apiKey = "abc";\nspawnSync(cmd, { shell: false });\n');
  const start = ['--delta', reviewed, '--lane-classes', roundFile({ fileClasses: {} })];
  return { fixRound: (...args) => raw(...start, ...args), review: priorFile(REVIEW), audit: priorFile(AUDIT) };
}

const refused = (result, why) => {
  assert.equal(result.status, 2, result.stdout.slice(0, 200));
  assert.equal(result.stdout, '', 'no review set is printed');
  assert.match(result.stderr, why);
};

test('review N4: two reports are both read: each has its hash, count and ids in the JSON, the text output and every brief', () => {
  const { fixRound, review, audit } = fixRoundFixture();
  const pairs = ['--prior', review, '--prior-sha256', sha256Of(review), '--prior', audit, '--prior-sha256', sha256Of(audit)];
  const result = JSON.parse(fixRound(...pairs, '--json').stdout);
  assert.deepEqual(result.prior, {
    files: [{ file: review, sha256: sha256Of(review), blocking: 1, shouldFix: 1, findings: 2, ids: ['B1', 'S1'] }, { file: audit, sha256: sha256Of(audit), blocking: 0, shouldFix: 1, findings: 1, ids: ['S9'] }],
    blocking: 1, shouldFix: 2, findings: 3,
  });
  assert.deepEqual(result.priorFiles, [review, audit]);
  assert.ok(result.reviews.length >= 3);
  for (const { brief } of result.reviews) {
    assert.ok(brief.includes(`Prior findings: ${review} (sha256 ${sha256Of(review)}; 2 blocking or should-fix: B1, S1); ${audit} (sha256 ${sha256Of(audit)}; 1 blocking or should-fix: S9): check the hash`), brief);
    assert.match(brief, /\(n \+ m = 3\)/, 'the count line covers both reports');
  }
  const text = fixRound(...pairs).stdout;
  assert.ok(text.includes(`\nprior: ${review} sha256 ${sha256Of(review)}, 1 blocking, 1 should-fix, ids B1, S1\nprior: ${audit} sha256 ${sha256Of(audit)}, 0 blocking, 1 should-fix, ids S9\nfix round: `), text);
});

test('security S1: a report edited after the review is refused although its count is the same (a finding deleted, a quoted mark added)', () => {
  const { fixRound, review } = fixRoundFixture();
  const recorded = sha256Of(review);
  assert.equal(fixRound('--prior', review, '--prior-sha256', recorded).status, 0, 'the report as the reviewer wrote it');
  writeFileSync(review, '| id | severity | what |\n|---|---|---|\n| S1 | should-fix | cause lost |\n| X1 | blocking | a new row in place of B1 |\n');
  const result = fixRound('--prior', review, '--prior-sha256', recorded, '--json');
  refused(result, /is not the report that was recorded: its sha256 is [0-9a-f]{64}, --prior-sha256 says [0-9a-f]{64}\. The file changed after the review: take the report from its reviewer again, never from the fix's writer/);
  assert.ok(result.stderr.includes(`--prior ${review} `), 'the error names the file');
});

test('security S1: a --prior with no --prior-sha256 is exit 2 naming the file, for one report and for the second of two', () => {
  const { fixRound, review, audit } = fixRoundFixture();
  refused(fixRound('--prior', review), new RegExp(`each --prior needs its own --prior-sha256 <hex> after it, in the same order \\(the sha256 the lead recorded when the reviewer returned that report\\): 1 --prior, 0 --prior-sha256; none for ${review}$`, 'm'));
  refused(fixRound('--prior', review, '--prior-sha256', sha256Of(review), '--prior', audit), new RegExp(`2 --prior, 1 --prior-sha256; none for ${audit}$`, 'm'));
  refused(fixRound('--prior', review, '--prior-sha256', sha256Of(review), '--prior-sha256', sha256Of(audit)), /1 --prior, 2 --prior-sha256/);
});

test('the hashes pair with the reports in order: swapped hashes, a hash that is no sha256 and the same report twice are exit 2', () => {
  const { fixRound, review, audit } = fixRoundFixture();
  refused(fixRound('--prior', review, '--prior-sha256', sha256Of(audit), '--prior', audit, '--prior-sha256', sha256Of(review)), new RegExp(`--prior ${review} is not the report that was recorded`));
  for (const hash of ['abc123', 'z'.repeat(64), `${sha256Of(review)}00`]) refused(fixRound('--prior', review, '--prior-sha256', hash), new RegExp(`--prior-sha256 for ${review} is not a sha256 \\(64 hex digits\\)`));
  refused(fixRound('--prior', review, '--prior-sha256', sha256Of(review), '--prior', review, '--prior-sha256', sha256Of(review)), /the same --prior file is named twice/);
  assert.equal(fixRound('--prior', review, '--prior-sha256', sha256Of(review).toUpperCase()).status, 0, 'upper-case hex is the same hash');
});

test('--prior-sha256 outside a fix round is exit 2', () => {
  const { raw, write } = lane();
  write('src/a.mjs', 'export const a = 1;\n');
  refused(raw('--prior-sha256', 'ab'.repeat(32)), /--prior and --prior-sha256 belong to a --delta round/);
  refused(raw('--prior-sha256'), /--prior-sha256 needs a value/);
});
