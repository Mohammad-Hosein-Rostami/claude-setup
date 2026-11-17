// Tests for home/hooks/lib/copy-branch-brief.mjs (git-root-cause proposal 2): a writer brief that creates `<lane>-2` while `<lane>` exists,
// or says "new branch off <existing>", is advised once; the lane's own name, a brief with no branch and a read-only agent are not.
// The git repos are real temp repos (tests/git-tidy-helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { branchNames, copyBranchBriefAdvice, copyBranchStem } from '../home/hooks/lib/copy-branch-brief.mjs';
import { git, makeRepo } from './git-tidy-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const EMPTY_HOME = makeTempDir('copy-brief-home-');
const ENV = { HOME: EMPTY_HOME, USERPROFILE: EMPTY_HOME };
const input = (repo, prompt, type = 'implementer') => ({ cwd: repo, tool_input: { subagent_type: type, prompt } });

function repoWithLane(lane = 'lane/r4-w1') {
  const repo = makeRepo();
  git(repo, 'branch', lane);
  return repo;
}

test('a brief that creates `<lane>-2` while `<lane>` exists is advised, for every creating phrase', () => {
  const repo = repoWithLane();
  for (const phrase of ['git checkout -b lane/r4-w1-2', 'git checkout -B lane/r4-w1-fix', 'git switch -c lane/r4-w1-v2', 'git switch -C lane/r4-w1-redo',
    'git branch lane/r4-w1-3', 'git worktree add ../wt -b lane/r4-w1-fixes', 'Create a new branch lane/r4-w1-2 and continue there', 'make a new branch called `lane/r4-w1-redo`.']) {
    const advice = copyBranchBriefAdvice(input(repo, `Fix the findings.\n${phrase}\nThen test.`), ENV);
    assert.equal(advice.deny, true, phrase);
    assert.match(advice.reason, /same branch/);
    assert.match(advice.reason, /git switch <lane> && git rebase <base>/);
  }
});

test('"new branch off <existing branch>" is advised; a new branch off a branch that does not exist is not', () => {
  const repo = repoWithLane();
  assert.equal(copyBranchBriefAdvice(input(repo, 'Make a new branch off lane/r4-w1 for the fixes.'), ENV).deny, true);
  assert.equal(copyBranchBriefAdvice(input(repo, 'Make a new branch off lane/nothing-here for the fixes.'), ENV).deny, false);
});

test('the lane branch itself, a brief with no branch, a rename and a stem that does not exist pass', () => {
  const repo = repoWithLane();
  for (const prompt of ['git checkout -b lane/r4-w1', 'git switch lane/r4-w1 && git rebase main', 'Fix the bug in a.mjs.', 'git branch -m lane/r4-w1',
    'git branch -d worktree-agent-x', 'git checkout -b lane/other-2', 'git checkout -b feature-3']) {
    assert.equal(copyBranchBriefAdvice(input(repo, prompt), ENV).deny, false, prompt);
  }
});

test('read-only agents and non-repositories pass; odd input never throws', () => {
  const repo = repoWithLane();
  assert.equal(copyBranchBriefAdvice(input(repo, 'git checkout -b lane/r4-w1-2', 'reviewer'), ENV).deny, false);
  assert.equal(copyBranchBriefAdvice(input(makeTempDir('not-a-repo-'), 'git checkout -b lane/r4-w1-2'), ENV).deny, false);
  for (const bad of [undefined, null, 4, {}, { tool_input: { prompt: 5 } }, { cwd: 'relative', tool_input: { subagent_type: 'implementer', prompt: 'git checkout -b a-2' } }]) {
    assert.equal(typeof copyBranchBriefAdvice(bad, ENV).deny, 'boolean');
  }
});

test('copyBranchStem names the existing stem and nothing else; a name that looks like an option is never looked up', () => {
  const repo = repoWithLane('feature');
  for (const suffix of ['-2', '-12', '-fix', '-fixes', '-v3', '-redo']) assert.equal(copyBranchStem(`feature${suffix}`, repo), 'feature', suffix);
  assert.equal(copyBranchStem('feature-final', repo), null);
  assert.equal(copyBranchStem('feature', repo), null);
  assert.equal(copyBranchStem('--help-2', repo), null);
  assert.equal(copyBranchStem('feature-2', 'relative/dir'), null);
});

test('branchNames reads names out of a brief and ignores prose and options', () => {
  const { created, offOf } = branchNames('Run `git checkout -b a-1`, then git branch b-2. Also: new branch off main, and git branch -d old.');
  assert.deepEqual(created, ['a-1', 'b-2']);
  assert.deepEqual(offOf, ['main']);
});

// The hook has a 5 s timeout and a killed hook skips the later gates, so a long brief (pasted text is untrusted) must scan in linear time.
test('branchNames reads a 260 KB hostile brief in well under a second (quadratic regexes took 7 s)', () => {
  const hostile = ['worktree add '.repeat(20000), `checkout -b ${')'.repeat(120000)}x`, 'git branch '.repeat(20000), 'new branch '.repeat(20000)];
  for (const text of hostile) {
    const start = performance.now();
    branchNames(text);
    assert.ok(performance.now() - start < 500, `${text.slice(0, 20)}: ${Math.round(performance.now() - start)} ms`);
  }
});

test('branchNames still finds `-b <name>` a few words after `worktree add`, across spaces but not across lines, and only in the first 32 KB', () => {
  assert.deepEqual(branchNames('git worktree add --detach ../wt -b lane/x-2').created, ['lane/x-2']);
  assert.deepEqual(branchNames('git worktree add ../wt\n-b lane/x-2').created, []);
  assert.deepEqual(branchNames(`${'x'.repeat(40 * 1024)}\ngit checkout -b lane/x-2`).created, [], 'text past the scan limit is not read');
  assert.deepEqual(branchNames('git checkout -b (`lane/x-2`),').created, ['lane/x-2']);
});
