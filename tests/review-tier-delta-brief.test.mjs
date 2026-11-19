// Tests for the delta brief of review-tier: `--delta <sha>` puts one ready "Delta review" line into every member's brief and
// `--prior <findings file>` names the earlier findings file in it. Plain-agent re-reviews depend on this line (round 7, rank 1).
// Class and set cases: review-tier.test.mjs; delta required reading: review-tier-cli.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const CLI = fileURLToPath(new URL('../home/tools/review-tier/review-tier.mjs', import.meta.url));
const README = fileURLToPath(new URL('../home/tools/review-tier/README.md', import.meta.url));

/** A lane branch with a reviewed commit and a fix commit on top; `tier(args)` runs the CLI there. */
function laneWithFix() {
  const dir = makeRepo();
  const log = join(dir, '..', 'review-tier.jsonl');
  const tier = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, REVIEW_TIER_LOG: log } });
  const json = (...args) => JSON.parse(tier(...args, '--json').stdout);
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    git(dir, 'add', '--', path);
    git(dir, 'commit', '-q', '-m', `edit ${path}`);
    return git(dir, 'rev-parse', 'HEAD');
  };
  git(dir, 'checkout', '-q', '-b', 'lane');
  const reviewed = write('src/run.mjs', 'const apiKey = "abc";\nspawnSync(cmd);\n');
  write('src/run.mjs', 'const apiKey = "abc";\nspawnSync(cmd, { shell: false });\n');
  return { dir, tier, json, reviewed };
}

/** A findings file from the previous round, in its own temp folder. */
function priorFile() {
  const path = join(makeTempDir('review-tier-prior-'), 'findings-round1.md');
  writeFileSync(path, '1. src/run.mjs:2 spawn without shell option (should-fix)\n');
  return path;
}

const memberLines = (stdout) => stdout.split('\n').filter((line) => line.startsWith('- '));

test('delta: every member of a landing set gets the ready delta line naming <reviewed>..HEAD', () => {
  const { json, reviewed } = laneWithFix();
  const result = json('--delta', reviewed, '--landing');
  assert.ok(result.reviews.length >= 2, 'a landing of a security change runs several members');
  for (const review of result.reviews) {
    assert.ok(review.brief.includes(`Delta review: ${reviewed}..HEAD only`), review.brief);
    assert.match(review.brief, /plus callers of changed lines/);
    assert.match(review.brief, /do not re-review unchanged lines/);
    assert.match(review.brief, /do not re-run the full suite \(PASS record covers it\)/);
  }
});

test('delta: the ready line names what to read outside the range: callers, and the readers of shared state, config and data the changed lines write', () => {
  const { json, reviewed } = laneWithFix();
  for (const review of json('--delta', reviewed, '--landing').reviews) {
    assert.match(review.brief, /plus callers of changed lines and the code that reads the shared state, config or data those lines write;/, review.brief);
  }
});

test('delta: the text output carries the delta line on every "run together" member line', () => {
  const { tier, reviewed } = laneWithFix();
  const result = tier('--delta', reviewed, '--landing');
  assert.equal(result.status, 0, result.stderr);
  const members = memberLines(result.stdout);
  assert.ok(members.length >= 2);
  for (const line of members) assert.ok(line.includes(`Delta review: ${reviewed}..HEAD only`), line);
});

test('delta: without --delta no brief mentions a delta review', () => {
  const { json, tier } = laneWithFix();
  for (const review of json('--landing').reviews) assert.doesNotMatch(review.brief, /Delta review/);
  assert.doesNotMatch(tier().stdout, /Delta review/);
});

test('delta with --prior: every brief names the findings file and asks to mark each finding closed or open', () => {
  const { json, reviewed } = laneWithFix();
  const prior = priorFile();
  for (const review of json('--delta', reviewed, '--prior', prior, '--landing').reviews) {
    assert.ok(review.brief.includes(`prior findings file: ${prior}`), review.brief);
    assert.match(review.brief, /mark each closed\/open/);
  }
});

test('delta with --prior: the text output names the findings file on every member line', () => {
  const { tier, reviewed } = laneWithFix();
  const prior = priorFile();
  const result = tier('--delta', reviewed, '--prior', prior);
  assert.equal(result.status, 0, result.stderr);
  const members = memberLines(result.stdout);
  assert.ok(members.length >= 1);
  for (const line of members) assert.ok(line.includes(prior), line);
});

test('delta without --prior: no brief names a findings file', () => {
  const { json, reviewed } = laneWithFix();
  for (const review of json('--delta', reviewed).reviews) assert.doesNotMatch(review.brief, /findings-round1/);
});

test('--prior with a file that does not exist exits 2 and prints nothing to stdout', () => {
  const { tier, reviewed } = laneWithFix();
  const result = tier('--delta', reviewed, '--prior', join(makeTempDir('review-tier-none-'), 'missing.md'));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /missing\.md/, 'the error names the file, not an unknown flag');
});

test('--prior without a value exits 2', () => {
  const { tier, reviewed } = laneWithFix();
  const result = tier('--delta', reviewed, '--prior');
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /unknown|unrecognized|bogus/i, 'the flag is known; only its value is missing');
});

test('the delta line does not lower the set: the same members run with and without --prior', () => {
  const { json, reviewed } = laneWithFix();
  const plain = json('--delta', reviewed, '--landing');
  const withPrior = json('--delta', reviewed, '--prior', priorFile(), '--landing');
  const shape = (report) => report.reviews.map(({ agent, model, effort, lens }) => ({ agent, model, effort, lens }));
  assert.deepEqual(shape(withPrior), shape(plain));
});

test('the review-tier README names --prior', () => {
  assert.match(readFileSync(README, 'utf8'), /--prior <[^>]*>/);
});
