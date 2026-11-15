// Tests for the rule "prune --apply removes only what is provably on the base AND leaves no only-copy behind": whitespace-only
// differences, commits that live in a reflog only, ignored files, the caller's own folder, a branch that moves before the
// delete, an unreadable repository, an ambiguous base and recently used worktrees. Each test builds a repo in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deleteBranch } from '../home/tools/git-tidy/lib/prune.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';
import { addWorktree, backdate, commit, git, lines, makeRepo, tidy } from './git-tidy-helpers.mjs';

const apply = (dir, ...extra) => tidy(['prune', dir, '--apply', ...extra], { cwd: dir });
const applyNow = (dir, ...extra) => apply(dir, '--include-recent', ...extra);
const branches = (dir) => git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort();
const keptLine = (result, kind, subject) => lines(result).find((line) => line.startsWith(`kept ${kind} ${subject} `)) ?? '';

test('whitespace-only difference: a branch whose patch ids equal the base but whose content differs is kept (python indentation)', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'indent');
  commit(dir, 'f.py', 'if x:\n    a()\n    b()\n');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  commit(dir, 'f.py', 'if x:\n    a()\nb()\n');
  const check = tidy(['check', dir], { cwd: dir });
  assert.ok(lines(check).some((line) => line.startsWith('unmerged-branch? indent ')), check.stdout);
  assert.ok(!lines(check).some((line) => line.startsWith('merged-branch indent')), check.stdout);
  assert.equal(applyNow(dir).status, 0);
  assert.ok(branches(dir).includes('indent'));
});

test('whitespace inside a string ("a b" against "ab") is not patch-equal either', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'spaced');
  commit(dir, 's.js', 'const s = "a b";\n');
  git(dir, 'checkout', '-q', 'main');
  commit(dir, 'moved-on.txt');
  commit(dir, 's.js', 'const s = "ab";\n');
  applyNow(dir);
  assert.ok(branches(dir).includes('spaced'));
});

test('reflog-only work: reset --hard in a worktree keeps the worktree and the branch, and the commit stays reachable', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-wip', 'wip');
  const precious = commit(wt, 'precious.txt');
  git(wt, 'reset', '-q', '--hard', 'main');
  const result = applyNow(dir);
  assert.equal(result.status, 1);
  assert.match(keptLine(result, 'merged-worktree', wt), /reflog holds commits that are not on the base \(1\)/);
  assert.ok(existsSync(wt) && branches(dir).includes('wip'));
  assert.ok(git(dir, 'rev-list', '--all', '--reflog').includes(precious));
});

test('reflog-only work: a branch without a worktree whose reflog holds a dropped commit is kept', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'dropped');
  commit(dir, 'gone.txt');
  git(dir, 'reset', '-q', '--hard', 'main');
  git(dir, 'checkout', '-q', 'main');
  const result = applyNow(dir);
  assert.match(keptLine(result, 'merged-branch', 'dropped'), /reflog holds commits that are not on the base \(1\)/);
  assert.ok(branches(dir).includes('dropped'));
});

test('reflog: the pre-rebase copy of a landed commit is not an only-copy, so a rebased and landed lane still goes', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-lane', 'lane');
  commit(wt, 'lane.txt');
  commit(dir, 'moved-on.txt');
  git(wt, 'rebase', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'lane');
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
  assert.deepEqual(branches(dir), ['main']);
});

test('reflog: more than 200 entries are not checked, the branch is kept and the line says so', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'busy');
  const tip = git(dir, 'rev-parse', 'main');
  const entry = `${tip} ${tip} t <t@t> 1700000000 +0000\tbranch: busy`;
  writeFileSync(join(dir, '.git', 'logs', 'refs', 'heads', 'busy'), `${Array(205).fill(entry).join('\n')}\n`);
  const result = applyNow(dir);
  assert.match(keptLine(result, 'merged-branch', 'busy'), /more than 200 entries/);
  assert.ok(branches(dir).includes('busy'));
});

test('reflog: a worktree that once visited another branch is not held back for that branch\'s commits, unless nothing else holds them', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'other-work');
  commit(dir, 'other.txt');
  git(dir, 'checkout', '-q', 'main');
  const wt = addWorktree(dir, 'wt-visitor', 'visitor');
  git(wt, 'checkout', '-q', 'other-work');
  git(wt, 'checkout', '-q', 'visitor');
  backdate(wt);
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
  assert.deepEqual(branches(dir), ['main', 'other-work']);

  const lone = makeRepo();
  git(lone, 'checkout', '-q', '-b', 'gone-soon');
  commit(lone, 'gone.txt');
  git(lone, 'checkout', '-q', 'main');
  const holder = addWorktree(lone, 'wt-holder', 'holder');
  git(holder, 'checkout', '-q', 'gone-soon');
  git(holder, 'checkout', '-q', 'holder');
  git(lone, 'branch', '-D', 'gone-soon');
  const kept = applyNow(lone);
  assert.match(keptLine(kept, 'merged-worktree', holder), /reflog holds commits that are not on the base \(1\)/);
});

function worktreeWithIgnored(names) {
  const dir = makeRepo();
  commit(dir, '.gitignore', '.env\nreports/\nnode_modules/\ndist/\nextra*\n');
  const wt = addWorktree(dir, 'wt-ignored', 'ignored-lane');
  backdate(wt); // a lane with no commit yet is protected while it is recent, even with --include-recent
  for (const name of names) {
    mkdirSync(join(wt, name, '..'), { recursive: true });
    writeFileSync(join(wt, name), 'only here');
  }
  return { dir, wt };
}

test('ignored files that exist only in the worktree keep it and its branch; the paths are printed (up to 5, +N more)', () => {
  const { dir, wt } = worktreeWithIgnored(['.env', 'reports/r.md', 'extra1', 'extra2', 'extra3', 'extra4', 'extra5']);
  const result = applyNow(dir);
  assert.equal(result.status, 1);
  const line = keptLine(result, 'merged-worktree', wt);
  assert.match(line, /ignored files that exist only here \(.*\.env.*, \+2 more\)/, line);
  assert.ok(existsSync(join(wt, '.env')) && branches(dir).includes('ignored-lane'));
  const hint = lines(tidy(['check', dir], { cwd: dir })).find((entry) => entry.startsWith(`ignored-files? ${wt} `));
  assert.ok(hint?.includes('.env'), hint);
});

test('OS clutter (.DS_Store, Thumbs.db, desktop.ini, ._ files) does not keep a worktree and is not listed', () => {
  const clutter = ['.DS_Store', 'sub/.DS_Store', 'Thumbs.db', 'desktop.ini', '._resource'];
  const { dir, wt } = worktreeWithIgnored(clutter);
  git(dir, 'config', 'core.excludesFile', join(dir, '.git', 'clutter-ignore'));
  writeFileSync(join(dir, '.git', 'clutter-ignore'), '.DS_Store\nThumbs.db\ndesktop.ini\n._*\n');
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
});

test('ignored build output (node_modules, dist) alone does not keep a worktree', () => {
  const { dir, wt } = worktreeWithIgnored(['node_modules/pkg/index.js', 'dist/out.js']);
  const result = applyNow(dir);
  assert.equal(result.status, 0, result.stdout);
  assert.ok(!existsSync(wt));
});

test('prune <main> --apply run from inside a merged linked worktree keeps that worktree and its branch', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-mine', 'mine');
  mkdirSync(join(wt, 'sub'));
  const result = tidy(['prune', dir, '--apply', '--include-recent'], { cwd: join(wt, 'sub') });
  assert.equal(result.status, 1);
  assert.match(keptLine(result, 'merged-worktree', wt), /the command runs from this folder/);
  assert.ok(existsSync(wt) && branches(dir).includes('mine'));
});

test('compare-and-delete: a branch that moved after the check is kept and says so; the old tip is deleted only when still current', () => {
  const dir = makeRepo();
  git(dir, 'checkout', '-q', '-b', 'moving');
  git(dir, 'config', 'branch.moving.remote', 'origin');
  git(dir, 'checkout', '-q', 'main');
  const repo = openRepo(dir, null);
  const checkedTip = git(dir, 'rev-parse', 'moving');
  git(dir, 'checkout', '-q', 'moving');
  const newer = commit(dir, 'late.txt');
  git(dir, 'checkout', '-q', 'main');
  const moved = deleteBranch(repo, 'moving', checkedTip);
  assert.equal(moved.action, 'keep');
  assert.match(moved.detail, new RegExp(`moved since the check \\(was ${checkedTip}, now ${newer}\\)`));
  assert.ok(branches(dir).includes('moving'));
  const deleted = deleteBranch(repo, 'moving', newer);
  assert.equal(deleted.action, 'deleted');
  assert.equal(deleted.detail, `was ${newer}`);
  assert.ok(!branches(dir).includes('moving'));
  assert.ok(!git(dir, 'config', '--local', '--list').includes('branch.moving.'), 'the branch config section is removed with the branch');
});

test('a repository git cannot read is exit 2 with the command and git first message line, never a clean check', () => {
  const dir = makeRepo();
  const parent = git(dir, 'rev-parse', 'HEAD');
  commit(dir, 'second.txt');
  rmSync(join(dir, '.git', 'objects', parent.slice(0, 2), parent.slice(2)));
  const result = tidy(['check', dir], { cwd: dir });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^git-tidy: unexpected git failure: git \S+ \S+ failed: \S/);
});

test('base not given and main, master and develop all exist: --apply exits 2 naming them and deletes nothing; a plan and --base work', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'develop');
  git(dir, 'branch', 'master');
  git(dir, 'branch', 'fresh');
  const refused = apply(dir, '--include-recent');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /main, master, develop/);
  assert.match(refused.stderr, /--base/);
  assert.ok(branches(dir).includes('fresh'));
  const plan = tidy(['prune', dir], { cwd: dir });
  assert.equal(plan.status, 0);
  assert.equal(lines(plan)[0], 'base: main (fallback)');
  assert.equal(applyNow(dir, '--base', 'main').status, 0);
  assert.deepEqual(branches(dir), ['main']);
});

test('recently used: a worktree touched in the last hour is kept with its branch, with the minutes and the flag to lift it', () => {
  const dir = makeRepo();
  const wt = addWorktree(dir, 'wt-fresh', 'fresh-lane');
  commit(wt, 'lane.txt');
  git(dir, 'merge', '-q', '--ff-only', 'fresh-lane');
  const result = apply(dir);
  assert.equal(result.status, 1);
  assert.match(keptLine(result, 'merged-worktree', wt), /used \d+ min ago \(add --include-recent if you landed this lane yourself\)/);
  assert.ok(existsSync(wt) && branches(dir).includes('fresh-lane'));
  assert.equal(applyNow(dir).status, 0);
  assert.ok(!existsSync(wt));
});

test('recently used: old files remove, but one tracked file touched now keeps it; a branch with no worktree is not held back', () => {
  const dir = makeRepo();
  git(dir, 'branch', 'no-worktree');
  const old = addWorktree(dir, 'wt-old', 'old-lane');
  const touched = addWorktree(dir, 'wt-touched', 'touched-lane');
  backdate(old);
  backdate(touched);
  const now = new Date();
  utimesSync(join(touched, 'base.txt'), now, now);
  const result = apply(dir);
  assert.equal(result.status, 1);
  assert.ok(!existsSync(old) && existsSync(touched));
  assert.deepEqual(branches(dir), ['main', 'touched-lane']);
});
