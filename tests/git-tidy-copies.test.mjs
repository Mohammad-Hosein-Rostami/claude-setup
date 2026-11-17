// Tests for the copy finder of git-tidy: branches that repeat the work of a newer branch (superseded-copy) and the leftover
// branch of a workflow agent (agent-leftover), in `check` (findings) and in `prune --apply` (removal).
// Each test builds a repo in a temp folder (git-tidy-helpers.mjs) and runs the real CLI; the shapes are the real ones that
// piled up in bill&gin (a lane X, X-2, X-3 and three worktree-agent branches) and in mission-control (five identical tips).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { addWorktree, backdate, CLEAN_ENV, commit, git, makeRepo, tidy } from './git-tidy-helpers.mjs';
import { runCheck } from '../home/tools/git-tidy/lib/check.mjs';
import { copyCandidates, isStillCopy } from '../home/tools/git-tidy/lib/copies.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';

const checkJson = (dir) => {
  const result = tidy(['check', dir, '--json'], { cwd: dir });
  return { status: result.status, ...JSON.parse(result.stdout) };
};
const kinds = (report, kind) => report.findings.filter((entry) => entry.kind === kind).map((entry) => entry.subject).sort();
const branchNames = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();

/** Lane X (a.txt), X-2 = X + b.txt, X-3 = rebased copies of both + c.txt, with main moved on between (so X-3 shares no commit hash). */
function billAndGinShape() {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/x');
  commit(dir, 'a.txt');
  git(dir, 'checkout', '-q', '-b', 'lane/x-2');
  commit(dir, 'b.txt');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'main-moved.txt');
  git(dir, 'checkout', '-q', '-b', 'lane/x-3');
  git(dir, 'cherry-pick', 'lane/x', 'lane/x-2');
  commit(dir, 'c.txt');
  git(dir, 'checkout', '-q', 'main');
  const worktrees = ['lane/x', 'lane/x-2', 'lane/x-3'].map((branch, i) => addWorktree(dir, `wt-${i + 1}`, branch, { create: false }));
  return { dir, worktrees };
}

/** Three leftovers of a workflow agent: at the base tip, at the tip of a lane, and at the tip of another lane. */
function addAgentLeftovers(dir) {
  git(dir, 'branch', 'worktree-agent-aaa', 'main');
  git(dir, 'branch', 'worktree-agent-bbb', 'lane/x-3');
  git(dir, 'branch', 'worktree-agent-ccc', 'lane/x-2');
}

test('check names the older copies and the agent leftovers of a re-done lane; the newest copy is the one kept', () => {
  const { dir } = billAndGinShape();
  addAgentLeftovers(dir);
  const report = checkJson(dir);
  assert.equal(report.status, 1);
  assert.deepEqual(kinds(report, 'superseded-copy'), ['lane/x', 'lane/x-2']);
  assert.deepEqual(kinds(report, 'agent-leftover'), ['worktree-agent-aaa', 'worktree-agent-bbb', 'worktree-agent-ccc']);
  assert.ok(report.findings.find((entry) => entry.subject === 'lane/x').detail.includes('lane/x-3'), 'the detail names the branch that holds the work');
  assert.equal(kinds(report, 'merged-branch').length, 0, 'an agent branch on the base is one finding, not two');
  assert.equal(report.hints.filter((hint) => hint.kind === 'unlanded-lane?').length, 0, 'not yet two hours old');
});

test('prune --apply removes the copies with their clean worktrees and the leftovers, and keeps the newest copy and its worktree', () => {
  const { dir, worktrees } = billAndGinShape();
  addAgentLeftovers(dir);
  worktrees.forEach(backdate);
  const result = tidy(['prune', dir, '--apply'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(branchNames(dir), ['lane/x-3', 'main']);
  assert.ok(!existsSync(worktrees[0]) && !existsSync(worktrees[1]), 'the worktrees of the copies are gone');
  assert.ok(existsSync(worktrees[2]), 'the worktree of the newest copy stays');
  assert.equal(tidy(['check', dir], { cwd: dir }).status, 0);
});

test('prune keeps a copy whose worktree was used in the last 60 minutes (a live agent), even with --include-recent', () => {
  const { dir, worktrees } = billAndGinShape();
  backdate(worktrees[0]);
  const result = tidy(['prune', dir, '--apply', '--include-recent'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.ok(existsSync(worktrees[1]), 'lane/x-2 was used a moment ago');
  assert.ok(branchNames(dir).includes('lane/x-2'));
  assert.match(result.stdout, /kept copy-worktree \S*wt-2 used \d+ min ago/);
  assert.ok(!branchNames(dir).includes('lane/x'), 'the copy nobody uses goes');
});

test('prune keeps a copy whose worktree has uncommitted files', () => {
  const { dir, worktrees } = billAndGinShape();
  worktrees.forEach(backdate);
  commit(worktrees[0], 'scratch.txt'); // a commit of its own on the copy: it is no longer a copy of X-3 at all
  const result = tidy(['prune', dir, '--apply'], { cwd: dir });
  assert.ok(branchNames(dir).includes('lane/x'), result.stdout);
  assert.ok(existsSync(worktrees[0]));
});

test('five identical tips (mission-control): four are copies, the checked-out one stays', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'work-one');
  commit(dir, 'w.txt');
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) git(dir, 'branch', name);
  git(dir, 'checkout', '-q', 'main');
  const keeper = addWorktree(dir, 'wt-keeper', 'gamma', { create: false });
  backdate(keeper);
  assert.deepEqual(kinds(checkJson(dir), 'superseded-copy'), ['alpha', 'beta', 'delta', 'work-one']);
  assert.equal(tidy(['prune', dir, '--apply'], { cwd: dir }).status, 0);
  assert.deepEqual(branchNames(dir), ['gamma', 'main']);
});

test('the newest committer date wins between copies with the same patches', () => {
  const dir = makeRepo();
  const commitAt = (date, ...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_COMMITTER_DATE: date } });
    assert.equal(result.status, 0, result.stderr);
  };
  git(dir, 'checkout', '-q', '-b', 'topic');
  commit(dir, 't.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'topic-redo');
  commitAt('2036-01-02T10:00:00Z', 'cherry-pick', 'topic');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'topic-2');
  commitAt('2036-01-01T10:00:00Z', 'cherry-pick', 'topic');
  git(dir, 'checkout', '-q', 'main');
  assert.deepEqual(kinds(checkJson(dir), 'superseded-copy'), ['topic', 'topic-2'], 'topic-redo has the newest commit');
});

test('branches that only share a name stem are not copies when their work differs', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'feat');
  commit(dir, 'f.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'feat-2');
  commit(dir, 'g.txt');
  git(dir, 'checkout', '-q', 'main');
  const report = checkJson(dir);
  assert.deepEqual(kinds(report, 'superseded-copy'), []);
  assert.equal(report.status, 0);
});

test('a newer copy that lacks a patch of the older one does not supersede it', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'job');
  commit(dir, 'one.txt');
  commit(dir, 'two.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'job-fix');
  git(dir, 'cherry-pick', 'job~1'); // only the first patch
  commit(dir, 'three.txt');
  git(dir, 'checkout', '-q', 'main');
  assert.deepEqual(kinds(checkJson(dir), 'superseded-copy'), []);
});

test('an agent branch with a commit of its own, or still checked out in a worktree, is not a leftover', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'worktree-agent-own');
  commit(dir, 'own.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', 'worktree-agent-live');
  const live = addWorktree(dir, 'wt-live', 'worktree-agent-live', { create: false });
  backdate(live);
  const report = checkJson(dir);
  assert.deepEqual(kinds(report, 'agent-leftover'), []);
  assert.deepEqual(kinds(report, 'merged-branch'), ['worktree-agent-live'], 'the existing finding for a merged branch is unchanged');
});

test('unlanded-lane? is named for the newest copy only', () => {
  const { dir } = billAndGinShape();
  const later = Date.now() + 3 * 60 * 60 * 1000;
  const { hints } = runCheck(openRepo(dir, null), later);
  assert.deepEqual(hints.filter((hint) => hint.kind === 'unlanded-lane?').map((hint) => hint.subject), ['lane/x-3']);
});

test('a newer copy that differs from the older one only in whitespace does not supersede it (patch ids alone ignore whitespace)', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'lane/x');
  commit(dir, 'Makefile', 'all:\n\tcc main.c\n');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'lane/x-2');
  commit(dir, 'Makefile', 'all:\n    cc main.c\n');
  git(dir, 'checkout', '-q', 'main');
  assert.deepEqual(kinds(checkJson(dir), 'superseded-copy'), []);
  assert.equal(git(dir, 'rev-parse', 'lane/x-2:Makefile') === git(dir, 'rev-parse', 'lane/x:Makefile'), false, 'sanity: the two files differ');
});

test('a copy with a merge commit is never proven by patch ids: the newer linear branch is the copy of it, not the other way round', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'job');
  commit(dir, 'one.txt');
  git(dir, 'checkout', '-q', '-b', 'side', 'main');
  commit(dir, 'two.txt');
  git(dir, 'checkout', '-q', 'job');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side');
  git(dir, 'branch', '-D', 'side');
  git(dir, 'checkout', '-q', '-b', 'job-2', 'main');
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const picked = spawnSync('git', ['cherry-pick', 'job~1', 'job^2'], { cwd: dir, encoding: 'utf8', env: { ...CLEAN_ENV, GIT_COMMITTER_DATE: tomorrow } });
  assert.equal(picked.status, 0, picked.stderr);
  git(dir, 'checkout', '-q', 'main');
  assert.deepEqual(kinds(checkJson(dir), 'superseded-copy'), ['job-2'], 'job has a merge commit, so job-2 (newest, linear) cannot supersede it');
});

test('a workflow agent branch (worktree-wf_<run>-<n>) is a leftover like a worktree-agent branch, and is never an unlanded lane', () => {
  const { dir } = billAndGinShape();
  git(dir, 'branch', 'worktree-wf_run1-1', 'main');
  git(dir, 'branch', 'worktree-wf_run1-2', 'lane/x-3');
  const report = checkJson(dir);
  assert.deepEqual(kinds(report, 'agent-leftover'), ['worktree-wf_run1-1', 'worktree-wf_run1-2']);
  const later = Date.now() + 3 * 60 * 60 * 1000;
  const { hints } = runCheck(openRepo(dir, null), later);
  assert.deepEqual(hints.filter((hint) => hint.kind === 'unlanded-lane?').map((hint) => hint.subject), ['lane/x-3']);
});

// isStillCopy is what prune asks again right before each removal, so a branch that changed after the plan is kept.
const candidateNamed = (dir, name) => copyCandidates(openRepo(dir, null)).find((candidate) => candidate.name === name);

test('isStillCopy: true while nothing changed; false once the copy got a commit of its own, the holder lost the work, or the leftover got a worktree', () => {
  const { dir, worktrees } = billAndGinShape();
  git(dir, 'branch', 'worktree-agent-aaa', 'main');
  const [copy, leftover] = [candidateNamed(dir, 'lane/x'), candidateNamed(dir, 'worktree-agent-aaa')];
  assert.equal(isStillCopy(openRepo(dir, null), copy), true);
  assert.equal(isStillCopy(openRepo(dir, null), leftover), true);

  addWorktree(dir, 'wt-leftover', 'worktree-agent-aaa', { create: false });
  assert.equal(isStillCopy(openRepo(dir, null), leftover), false, 'a worktree now uses the leftover');

  commit(worktrees[0], 'own.txt');
  assert.equal(isStillCopy(openRepo(dir, null), copy), false, 'the copy moved since the plan');

  const afresh = candidateNamed(dir, 'lane/x-2');
  git(dir, 'update-ref', 'refs/heads/lane/x-3', 'main'); // the holder no longer has the work of lane/x-2
  assert.equal(isStillCopy(openRepo(dir, null), afresh), false, 'the holder moved away from the work');
});
