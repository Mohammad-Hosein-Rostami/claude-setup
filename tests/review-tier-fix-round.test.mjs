// Tests for the fix-round command review-tier prints (`fix round: ...`, the same text home/CLAUDE.md names, with the round's own
// shas and class names filled in): run as printed, round after round, it loses no lens, rule domain or plan item of the lane's first
// review, also when a fix removes the lines that gave a class; and `--delta` without `--lane-classes` or `--base` is refused (lane
// r7-delta, review B1a: the rule's command had no `--lane-classes`; security B7: a fix round reads no name).
// Fixtures: edge cases E7, E8, E16 and E17 of the second review (`d2b.mjs`), rebuilt in temp repos and driven only by the printed line.
// The set of one fix round: review-tier-delta-set.test.mjs; the base, rewritten lanes and git state have their own files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { git } from './git-tidy-helpers.mjs';
import { FIX_ROUND_COMMAND } from '../home/tools/review-tier/lib/report.mjs';
import { lane, printedFixRound, priorFile, sha256Of } from './review-tier-helpers.mjs';

const words = (text, separator) => text.split(separator).map((word) => word.trim()).filter(Boolean);
const planItems = (plan) => Object.keys(plan).filter((item) => plan[item] !== null);

/** What a later round lacks of an earlier one: a member (agent, model, effort), a class in its lens, a rule domain or a plan item. */
function lost(earlier, later) {
  const gaps = [];
  for (const review of earlier.reviews) {
    const kind = review.lens.split(':')[0];
    const match = later.reviews.find((entry) => entry.agent === review.agent && entry.model === review.model && entry.effort === review.effort && entry.lens.split(':')[0] === kind);
    if (match === undefined) { gaps.push(`${review.agent} ${review.model} ${review.effort} (${review.lens})`); continue; }
    for (const name of words(review.lens.split(':')[1] ?? '', ',')) if (!words(match.lens.split(':')[1] ?? '', ',').includes(name)) gaps.push(`${review.lens}: ${name}`);
    for (const domain of words(review.rules, '+')) if (!words(match.rules, '+').includes(domain)) gaps.push(`${review.lens}: rules ${domain}`);
    for (const item of planItems(review.plan)) if (!planItems(match.plan).includes(item)) gaps.push(`${review.lens}: plan ${item}`);
  }
  return gaps;
}

/** Runs one round exactly as given and returns its text output and its report. */
function round(raw, args) {
  const text = raw(...args);
  assert.equal(text.status, 0, `${args.join(' ')}: ${text.stderr}`);
  return { text: text.stdout, report: JSON.parse(raw(...args, '--json').stdout) };
}

/** The next fix round, run from the `fix round:` line the round before printed: the lead fills in only the report and its hash. */
function nextRound(raw, before) {
  const prior = priorFile();
  return round(raw, printedFixRound(before.text, { 'findings-file': prior, 'its-sha256': sha256Of(prior) }));
}

test('the fix round line is the whole command: delta, base, prior and the classes of the round before', () => {
  assert.equal(FIX_ROUND_COMMAND, 'node ~/.claude/tools/review-tier/review-tier.mjs --delta <reviewed-sha> --base <base-sha> --prior <findings-file> --prior-sha256 <its-sha256> --lane-classes <classes>');
});

test('review B1a: --delta without --lane-classes exits 2 and says what to pass, with every other flag', () => {
  const { dir, raw, write } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('src/a.mjs', 'export const a = 2;\n');
  const prior = priorFile();
  const fixRound = ['--delta', reviewed, '--base', git(dir, 'rev-parse', 'refs/heads/main'), '--prior', prior, '--prior-sha256', sha256Of(prior)];
  for (const flags of [[], ['--landing'], ['--json'], ['--add-class', 'security']]) {
    const result = raw(...fixRound, ...flags);
    assert.equal(result.status, 2, flags.join(' '));
    assert.equal(result.stdout, '', 'no review set is printed');
    assert.match(result.stderr, /--delta needs --lane-classes <names>: the class names of the round before, comma-separated .* When that record is lost, run a whole-range review instead \(no --delta\)/);
  }
  assert.equal(raw(...fixRound, '--lane-classes', 'docs').status, 0, 'with it the round runs');
});

test('security B7, review R5-4: --delta without --base, or with a base that is no ancestor of HEAD, exits 2 and says which commit to pass: the `base` of the round before, with --rebased-onto after a rebase, never a merge-base run in the lane', () => {
  const { dir, raw, write } = lane();
  const reviewed = write('src/a.mjs', 'export const a = 1;\n');
  write('src/a.mjs', 'export const a = 2;\n');
  git(dir, 'checkout', '-q', '-b', 'elsewhere', 'main');
  const elsewhere = write('other.txt', 'a commit HEAD does not hold\n');
  git(dir, 'checkout', '-q', 'lane');
  const prior = priorFile();
  const fixRound = ['--delta', reviewed, '--prior', prior, '--prior-sha256', sha256Of(prior), '--lane-classes', 'logic'];
  const remedy = 'the `base` of the round before \\(its `fix round:` line or its JSON\\)\\. After a rebase onto a base tip you recorded yourself, keep that --base and add --rebased-onto <tip>';
  const texts = [
    [[], new RegExp(`--delta needs --base <base-sha>: the full sha the lane starts from, which is ${remedy}\\. No branch is looked up in a fix round`)],
    [['--base', elsewhere], new RegExp(`--base ${elsewhere} is no ancestor of HEAD: the lane does not start there \\(the record is wrong, or the lane was rebuilt on another start\\)\\. Pass ${remedy}$`, 'm')],
  ];
  for (const [flags, why] of texts) {
    for (const more of [[], ['--landing'], ['--json']]) {
      const result = raw(...fixRound, ...flags, ...more);
      assert.equal(result.status, 2, [...flags, ...more].join(' '));
      assert.equal(result.stdout, '', 'no review set is printed');
      assert.match(result.stderr, why);
      assert.doesNotMatch(result.stderr, /git merge-base|pass the tip it was rebased onto|after a rebase, the tip/, 'no advice to read the lane\'s refs or to pass a rebased-onto tip as --base');
    }
  }
  assert.equal(raw(...fixRound, '--base', git(dir, 'rev-parse', 'refs/heads/main')).status, 0, 'with the lane start the round runs');
});

test('review R3-2: the printed base is where the lane left the base branch, also after that branch moved on, and the next round runs with it', () => {
  const { dir, raw, write } = lane();
  const fork = git(dir, 'rev-parse', 'refs/heads/main');
  write('src/a.mjs', 'export const a = 1;\n');
  git(dir, 'checkout', '-q', 'main');
  write('other.txt', 'another lane landed\n');
  git(dir, 'checkout', '-q', 'lane');
  const round0 = round(raw, ['--landing']);
  assert.ok(round0.text.trimEnd().split('\n').at(-1).includes(` --base ${fork} `), 'the merge base, an ancestor of HEAD: never the moved tip of the branch');
  write('src/a.mjs', 'export const a = 2;\n');
  assert.equal(nextRound(raw, round0).report.files, 1);
});

test('E7 through the printed command: a data lane keeps its set after fix 1 removes rmSync and fix 2 only adds a test', () => {
  const { dir, raw, write } = lane();
  const reviewed = write('src/clean.mjs', "import { rmSync } from 'node:fs';\nexport function clean(dir) {\n  rmSync(dir, { recursive: true });\n  return dir;\n}\n");
  const round0 = round(raw, ['--landing']);
  assert.ok(round0.text.trimEnd().split('\n').at(-1).includes(` --delta ${reviewed} --base ${git(dir, 'rev-parse', 'refs/heads/main')} --prior <findings-file> `), 'the line names the commit this round read and the lane start it resolved (review R3-2)');
  assert.ok(['concurrency', 'data'].every((name) => round0.report.classes.includes(name)), `round 0 classes: ${round0.report.classes}`);
  write('src/clean.mjs', 'export function clean(dir) {\n  return dir;\n}\n');
  const round1 = nextRound(raw, round0);
  write('tests/clean.test.mjs', "import test from 'node:test';\ntest('clean', () => {});\n");
  const round2 = nextRound(raw, round1);
  assert.deepEqual(lost(round0.report, round1.report), []);
  assert.equal(round2.report.files, 1, 'each round starts from the commit the round before read');
  assert.deepEqual(lost(round0.report, round2.report), [], 'round 2 reads only a test file, and still has the race plan, the db rules and the mutants');
  assert.ok(['concurrency', 'data'].every((name) => round2.report.classes.includes(name)));
});

test('E8 through the printed command: a security lane keeps three lenses after fix 1 deletes its only code file and fix 2 is docs', () => {
  const { dir, raw, write } = lane();
  write('docs/run.md', '# run\nuse src/run.mjs\n');
  write('src/run.mjs', "import { execSync } from 'node:child_process';\nexport const run = (c) => execSync(c);\n");
  const round0 = round(raw, ['--landing']);
  assert.equal(round0.report.reviews.length, 3);
  git(dir, 'rm', '-q', 'src/run.mjs');
  git(dir, 'commit', '-q', '-m', 'fix: drop the script');
  const round1 = nextRound(raw, round0);
  write('docs/run.md', '# run\nno script any more\n');
  const round2 = nextRound(raw, round1);
  assert.deepEqual(lost(round0.report, round2.report), []);
  assert.equal(round2.report.reviews.length, 3, 'never one Sonnet lens');
  assert.ok(round2.report.classes.includes('security'));
});

test('E16 through the printed command: a race lane keeps concurrency and the race plan when the fix removes the write that made it a race', () => {
  const { raw, write } = lane();
  write('src/store.mjs', "import { existsSync } from 'node:fs';\nimport { writeFileSync } from 'node:fs';\nexport function save(p, t) {\n  if (!existsSync(p)) {\n    writeFileSync(p, t);\n  }\n}\n");
  const round0 = round(raw, ['--landing']);
  assert.ok(round0.report.classes.includes('concurrency'));
  write('src/store.mjs', "import { existsSync } from 'node:fs';\nexport function save(p, t) {\n  if (!existsSync(p)) {\n    return t;\n  }\n}\n");
  const round1 = nextRound(raw, round0);
  assert.deepEqual(lost(round0.report, round1.report), []);
  assert.ok(round1.report.classes.includes('concurrency'));
  assert.deepEqual(round1.report.reviews.find((review) => review.model === 'opus' && review.agent === 'reviewer').plan.race, { runs: 200 });
});

test('E17 through the printed command: a class added by hand in round 0 stays in every later round', () => {
  const { raw, write } = lane();
  write('src/util.mjs', 'export const add = (a, b) => a + b;\n');
  const round0 = round(raw, ['--landing', '--add-class', 'security']);
  assert.match(round0.text.trimEnd().split('\n').at(-1), / --prior-sha256 <its-sha256> --lane-classes security,logic$/, 'a class added by hand is one of the names');
  write('src/util.mjs', 'export const add = (a, b) => a + b + 0;\n');
  const round1 = nextRound(raw, round0);
  write('src/util.mjs', 'export const add = (a, b) => b + a;\n');
  const round2 = nextRound(raw, round1);
  for (const { report } of [round1, round2]) {
    assert.deepEqual(lost(round0.report, report), []);
    assert.ok(report.classes.includes('security'));
  }
});
