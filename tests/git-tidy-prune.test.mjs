// Tests for `git-tidy prune`: the plan, what --apply removes, and above all what it must never touch.
// Each test builds its own repo in a temp folder (see git-tidy-helpers.mjs) and runs the real CLI on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addWorktree, commit, git, lines, makeRepo, snapshot, tidy, withOrigin } from './git-tidy-helpers.mjs';

const prune = (dir, ...extra) => tidy(['prune', dir, ...extra], { cwd: dir });
const apply = (dir, ...extra) => prune(dir, '--apply', ...extra);
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');

/** Lands `branch` (one commit) on main as a cherry-pick with a different hash; leaves HEAD on main. */
function landRebased(dir, branch) {
  git(dir, 'checkout', '-q', '-b', branch);
  commit(dir, `${branch.replaceAll('/', '_')}.txt`);
  git(dir, 'checkout', '-q', 'main');
  commit(dir, `moved-${branch.replaceAll('/', '_')}.txt`);
  git(dir, 'cherry-pick', branch);
}

test('the plan lists what would go and what stays, and changes nothing (refs, worktrees, status)', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  const clean = addWorktree(dir, 'wt-clean', 'clean-done');
  const dirty = addWorktree(dir, 'wt-dirty', 'dirty-done');
  writeFileSync(join(dirty, 'scratch.txt'), 'untracked');
  const gone = addWorktree(dir, 'wt-gone', 'gone-branch');
  rmSync(gone, { recursive: true, force: true });
  git(dir, 'checkout', '-q', '-b', 'wip');
  commit(dir, 'wip.txt');
  git(dir, 'checkout', '-q', 'main');
  const before = snapshot(dir, clean, dirty);
  const result = prune(dir);
  assert.equal(result.status, 0);
  assert.equal(snapshot(dir, clean, dirty), before);
  const out = lines(result);
  assert.ok(out.includes(`remove stale-worktree ${gone} folder missing`), out.join('\n'));
  assert.ok(out.includes(`remove merged-worktree ${clean} branch clean-done`), out.join('\n'));
  assert.ok(out.some((line) => line.startsWith('remove merged-branch fresh ')), out.join('\n'));
  assert.ok(out.some((line) => line.startsWith('remove merged-branch clean-done ')), 'its worktree goes first, so the branch goes too');
  assert.ok(out.some((line) => line.startsWith(`keep merged-worktree ${dirty} `) && line.includes('uncommitted or untracked')), out.join('\n'));
  assert.ok(out.some((line) => line.startsWith('keep merged-branch dirty-done ') && line.includes(dirty)), out.join('\n'));
  assert.ok(out.some((line) => line.startsWith('remove merged-branch gone-branch ')), 'the branch of a stale worktree is free once the entry is pruned');
  assert.ok(!out.some((line) => line.includes('wip')), 'a branch with its own work is not mentioned');
  assert.match(out.at(-1), /^git-tidy prune: 5 to remove, 2 kept \(base main\), dry run: add --apply to remove$/);
});

test('--apply deletes ancestor and patch-equal branches, prints the old hash, and a deleted branch can be restored from it', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  landRebased(dir, 'rebased');
  const hashes = { fresh: git(dir, 'rev-parse', 'fresh'), rebased: git(dir, 'rev-parse', 'rebased') };
  const result = apply(dir);
  assert.equal(result.status, 0);
  const out = lines(result);
  assert.ok(out.includes(`deleted fresh (was ${hashes.fresh})`), out.join('\n'));
  assert.ok(out.includes(`deleted rebased (was ${hashes.rebased})`), out.join('\n'));
  assert.deepEqual(branches(dir), ['main']);
  git(dir, 'branch', 'rebased', hashes.rebased);
  assert.equal(git(dir, 'rev-parse', 'rebased'), hashes.rebased);
});

test('--apply never deletes a branch with commits the base lacks, nor the base, even when everything else goes', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'wip');
  commit(dir, 'wip.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'half');
  commit(dir, 'one.txt');
  commit(dir, 'two.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'branch', 'fresh');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', 'half~1');
  const result = apply(dir);
  assert.equal(result.status, 0);
  assert.deepEqual(branches(dir).sort(), ['half', 'main', 'wip']);
});

test('a patch-equal branch that holds a merge commit is kept (the merge may carry changes cherry cannot see)', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'feat');
  commit(dir, 'feat.txt');
  git(dir, 'checkout', '-q', '-b', 'inner');
  commit(dir, 'inner.txt');
  git(dir, 'checkout', '-q', 'feat');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge inner', 'inner');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  git(dir, 'cherry-pick', 'feat~1', 'inner');
  assert.equal(apply(dir).status, 0);
  assert.deepEqual(branches(dir).sort(), ['feat', 'main'], 'inner landed by cherry-pick and goes; feat holds a merge and stays');
});

test('a clean worktree of a merged branch is removed together with its branch', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt done', 'done');
  const result = apply(dir);
  assert.equal(result.status, 0);
  assert.ok(lines(result).includes(`removed merged-worktree ${wt} branch done`), result.stdout);
  assert.ok(!existsSync(wt));
  assert.deepEqual(branches(dir), ['main']);
  assert.ok(!git(dir, 'worktree', 'list').includes('wt done'));
});

test('a worktree with an untracked file is kept with its branch, the reason is printed, exit 1', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-dirty', 'done');
  writeFileSync(join(wt, 'precious.txt'), 'not committed');
  const result = apply(dir);
  assert.equal(result.status, 1);
  assert.ok(lines(result).some((line) => line.startsWith(`kept merged-worktree ${wt} `) && line.includes('uncommitted or untracked')), result.stdout);
  assert.ok(existsSync(join(wt, 'precious.txt')));
  assert.ok(branches(dir).includes('done'));
});

test('a modified tracked file also keeps the worktree, and `status.showUntrackedFiles=no` cannot hide an untracked one', () => {
  const dir = makeRepo();
  const edited = addWorktree(dir, 'wt-edit', 'edit-done');
  writeFileSync(join(edited, 'base.txt'), 'changed');
  const hidden = addWorktree(dir, 'wt-hidden', 'hidden-done');
  writeFileSync(join(hidden, 'precious.txt'), 'not committed');
  git(dir, 'config', 'status.showUntrackedFiles', 'no');
  git(dir, 'config', 'core.excludesFile', join(dir, 'nothing'));
  const result = apply(dir);
  assert.equal(result.status, 1);
  assert.ok(existsSync(edited) && existsSync(hidden), result.stdout);
  assert.ok(branches(dir).includes('edit-done') && branches(dir).includes('hidden-done'));
});

test('two worktrees on merged branches, one dirty: only the clean one and its branch go', () => {
  const dir = makeRepo();
  const clean = addWorktree(dir, 'wt-clean', 'clean-done');
  const dirty = addWorktree(dir, 'wt-dirty', 'dirty-done');
  writeFileSync(join(dirty, 'x.txt'), 'x');
  const result = apply(dir);
  assert.equal(result.status, 1);
  assert.ok(!existsSync(clean) && existsSync(dirty));
  assert.deepEqual(branches(dir).sort(), ['dirty-done', 'main']);
});

test('a stale worktree is pruned; a locked stale one is kept with the reason', () => {
  const dir = makeRepo();
  const stale = addWorktree(dir, 'wt-stale', 'stale-branch');
  rmSync(stale, { recursive: true, force: true });
  const ok = apply(dir);
  assert.equal(ok.status, 0);
  assert.ok(lines(ok).includes(`removed stale-worktree ${stale} folder missing`), ok.stdout);
  assert.ok(!git(dir, 'worktree', 'list').includes('wt-stale'));

  const locked = addWorktree(dir, 'wt-locked', 'locked-branch');
  git(dir, 'worktree', 'lock', locked);
  rmSync(locked, { recursive: true, force: true });
  const kept = apply(dir);
  assert.equal(kept.status, 1);
  assert.ok(lines(kept).some((line) => line.startsWith(`kept stale-worktree ${locked} `) && line.includes('locked')), kept.stdout);
  assert.ok(git(dir, 'worktree', 'list').includes('wt-locked'));
});

test('run from inside a linked worktree (or a subfolder of it): that worktree and its branch stay, exit 1 with the reason', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-here', 'here-done');
  mkdirSync(join(wt, 'sub'));
  for (const cwd of [wt, join(wt, 'sub')]) {
    const result = tidy(['prune', '--apply'], { cwd });
    assert.equal(result.status, 1, cwd);
    assert.ok(lines(result).some((line) => line.startsWith(`kept merged-worktree ${wt} `) && line.includes('runs from')), result.stdout);
    assert.ok(existsSync(wt) && branches(dir).includes('here-done'), cwd);
  }
});

test('the branch checked out in the main worktree, a detached worktree and a locked worktree are never touched', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'on-main-checkout');
  const detached = addWorktree(dir, 'wt-detached', 'HEAD', { create: false });
  assert.ok(existsSync(detached));
  const locked = addWorktree(dir, 'wt-locked', 'locked-done');
  git(dir, 'worktree', 'lock', locked);
  git(dir, 'checkout', '-q', 'on-main-checkout');
  const result = apply(dir);
  assert.equal(result.status, 1);
  assert.ok(lines(result).some((line) => line.startsWith(`kept merged-worktree ${locked} `) && line.includes('locked')), result.stdout);
  assert.ok(lines(result).some((line) => line.startsWith(`kept detached-worktree ${detached} `)), result.stdout);
  assert.ok(existsSync(detached) && existsSync(locked));
  assert.deepEqual(branches(dir).sort(), ['locked-done', 'main', 'on-main-checkout']);
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'on-main-checkout');
});

test('a detached worktree alone is reported as kept and does not change the exit code', () => {
  const dir = makeRepo();
  const detached = addWorktree(dir, 'wt-detached', 'HEAD', { create: false });
  const result = apply(dir);
  assert.equal(result.status, 0);
  assert.ok(lines(result).some((line) => line.startsWith(`kept detached-worktree ${detached} `)), result.stdout);
});

test('tags and remote branches are never deleted, also when they point at a merged branch', () => {
  const dir = makeRepo();
  withOrigin(dir);
  git(dir, 'branch', 'done');
  git(dir, 'tag', 'v1', 'done');
  git(dir, 'push', '-q', 'origin', 'done');
  assert.equal(apply(dir).status, 0);
  assert.deepEqual(branches(dir), ['main']);
  assert.equal(git(dir, 'tag'), 'v1');
  assert.ok(git(dir, 'for-each-ref', 'refs/remotes').includes('refs/remotes/origin/done'));
  assert.ok(git(dir, 'ls-remote', '--heads', 'origin').includes('refs/heads/done'));
});

test('odd branch names are deleted through `--`, and a tag with the same name as a merged branch survives', () => {
  const dir = makeRepo();
  for (const name of ['feat/a-b_c.d', 'feat/--x', 'dup']) git(dir, 'branch', name);
  git(dir, 'checkout', '-q', '-b', 'tagged-work');
  const unmerged = commit(dir, 'tagged.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'tag', 'dup', unmerged);
  const result = apply(dir);
  assert.equal(result.status, 0);
  assert.deepEqual(branches(dir).sort(), ['main', 'tagged-work']);
  assert.equal(git(dir, 'rev-parse', 'refs/tags/dup'), unmerged);
});

test('a landed branch named like a tag that points at unmerged work is still judged by the branch, not the tag', () => {
  const dir = makeRepo();
  landRebased(dir, 'twin');
  git(dir, 'checkout', '-q', '-b', 'other-work');
  const otherWork = commit(dir, 'other.txt');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'tag', 'twin', otherWork);
  assert.equal(apply(dir).status, 0);
  assert.deepEqual(branches(dir).sort(), ['main', 'other-work']);
});

test('a worktree folder with a space in its path is removed', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'my worktree', 'spaced');
  assert.equal(apply(dir).status, 0);
  assert.ok(!existsSync(wt));
});

test('--json: the plan and the applied result are { base, apply, items } with action, kind, subject, detail', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  const plan = JSON.parse(prune(dir, '--json').stdout);
  assert.deepEqual(Object.keys(plan), ['base', 'apply', 'items']);
  assert.equal(plan.apply, false);
  assert.deepEqual(plan.items.map(({ action, kind, subject }) => [action, kind, subject]), [['remove', 'merged-branch', 'fresh']]);
  const done = JSON.parse(apply(dir, '--json').stdout);
  assert.equal(done.apply, true);
  assert.deepEqual(done.items.map(({ action, subject }) => [action, subject]), [['deleted', 'fresh']]);
  assert.match(done.items[0].detail, /^was [0-9a-f]{40}$/);
});

test('nothing to do is exit 0; --apply is not a flag of check; prune takes the same base rules', () => {
  const dir = makeRepo();
  const empty = apply(dir);
  assert.equal(empty.status, 0);
  assert.match(lines(empty).at(-1), /^git-tidy prune: 0 removed, 0 kept, 0 failed \(base main\)$/);
  assert.equal(tidy(['check', dir, '--apply'], { cwd: dir }).status, 2);
  git(dir, 'branch', 'develop');
  git(dir, 'checkout', '-q', 'develop');
  commit(dir, 'd.txt');
  git(dir, 'branch', 'other');
  const onDevelop = apply(dir, '--base', 'develop');
  assert.equal(onDevelop.status, 0);
  assert.deepEqual(branches(dir), ['develop']);
});

test('the dry run predicts exactly what --apply then does', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'fresh');
  landRebased(dir, 'rebased');
  addWorktree(dir, 'wt-clean', 'clean-done');
  const dirty = addWorktree(dir, 'wt-dirty', 'dirty-done');
  writeFileSync(join(dirty, 'x.txt'), 'x');
  const gone = addWorktree(dir, 'wt-gone', 'gone-branch');
  rmSync(gone, { recursive: true, force: true });
  const planned = JSON.parse(prune(dir, '--json').stdout).items;
  const applied = JSON.parse(apply(dir, '--json').stdout).items;
  const names = (items, ...actions) => items.filter((entry) => actions.includes(entry.action)).map((entry) => `${entry.kind} ${entry.subject}`).sort();
  assert.deepEqual(names(applied, 'removed', 'deleted'), names(planned, 'remove'));
  assert.deepEqual(names(applied, 'kept'), names(planned, 'keep'));
});
