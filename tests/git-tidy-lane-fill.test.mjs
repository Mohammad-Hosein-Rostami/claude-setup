// Tests of the clone fill of a new lane (lib/lane-fill.mjs: cloneSupport, fillFresh): a slot filled from the main checkout is clean, keeps
// ignored local files, skips what must not be cloned, repairs a dirty main, falls back to checkout and refuses folders that are no slot.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_ENV, git } from './git-tidy-helpers.mjs';
import { poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, addEmptySlot, filesOf, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { FILL_ENV, cloneSupport, fillFresh } from '../home/tools/git-tidy/lib/lane-fill.mjs';
import { UsageError } from '../home/tools/git-tidy/lib/git.mjs';
import { openRepo } from '../home/tools/git-tidy/lib/repo.mjs';

// fillFresh runs git in this process: give it the clean environment the spawned CLI tests get (no user git config, no GIT_* state).
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name];
Object.assign(process.env, CLEAN_ENV);

const OLD_TIME = new Date('2001-02-03T04:05:06Z');
const NO_NEWLINE_NAMES = { skip: process.platform === 'win32' && 'a file name cannot hold a newline on Windows' };
const head = (dir) => git(dir, 'rev-parse', 'HEAD');
/** Writes `file` (its folders made) and commits it. */
function track(repo, file, text) {
  writeFile(join(repo, file), text);
  git(repo, 'add', '--', file);
  git(repo, 'commit', '-q', '-m', `add ${file}`);
}
const fill = (repo, folder, target = head(repo)) => fillFresh(openRepo(repo, null), { folder, target });
const statusOf = (folder) => git(folder, 'status', '--porcelain');

test('on macOS the temp folder is on APFS, so the clone tests run and are not skipped', { skip: process.platform !== 'darwin' && 'only macOS promises clones in the temp folder' }, () => {
  assert.equal(NEEDS_CLONE.skip, false);
});

test('fillFresh: a new slot has a clean git status and holds the tracked files of the target', () => {
  const repo = jsRepo();
  track(repo, join('src', 'app.js'), 'export {};\n');
  const target = head(repo);
  const folder = addEmptySlot(repo, 1, target);
  const filled = fill(repo, folder, target);
  assert.equal(statusOf(folder), '', `mode ${filled.mode}`);
  assert.equal(readFileSync(join(folder, 'src', 'app.js'), 'utf8'), 'export {};\n');
  assert.equal(git(folder, 'diff', '--name-only', target), '');
});

test('fillFresh: a nested repo, .claude/worktrees, a venv and a root HANDOFF file are not cloned; .env, node_modules and .husky/_ are; mtimes are kept', NEEDS_CLONE, () => {
  const repo = jsRepo();
  track(repo, join('tools', 'run.sh'), 'echo run\n');
  track(repo, join('src', 'app.js'), 'export {};\n');
  const tracked = join(repo, 'src', 'app.js');
  utimesSync(tracked, OLD_TIME, OLD_TIME);
  writeFile(join(repo, 'personal', 'notes.txt'), 'private');
  git(join(repo, 'personal'), 'init', '-q');
  writeFile(join(repo, '.claude', 'worktrees', 'other', 'file.txt'), 'another lane');
  writeFile(join(repo, '.claude', 'settings.local.json'), '{}');
  writeFile(join(repo, 'venv', 'pyvenv.cfg'), 'home = /usr/bin');
  writeFile(join(repo, 'tools', 'tool-venv', 'pyvenv.cfg'), 'home = /usr/bin');
  writeFile(join(repo, 'HANDOFF-x.md'), 'notes');
  writeFile(join(repo, '.env'), 'SECRET=local');
  writeFile(join(repo, 'node_modules', 'x', 'index.js'), 'module.exports = 1;');
  writeFile(join(repo, '.husky', '_', 'husky.sh'), '#!/bin/sh');
  const target = head(repo);
  const folder = addEmptySlot(repo, 1, target);
  const filled = fill(repo, folder, target);
  for (const absent of ['personal', join('.claude', 'worktrees'), 'venv', join('tools', 'tool-venv'), 'HANDOFF-x.md']) {
    assert.ok(!existsSync(join(folder, absent)), `${absent} must not be cloned`);
  }
  assert.equal(readFileSync(join(folder, '.env'), 'utf8'), 'SECRET=local');
  assert.ok(existsSync(join(folder, 'node_modules', 'x', 'index.js')));
  assert.ok(existsSync(join(folder, '.husky', '_', 'husky.sh')));
  assert.equal(readFileSync(join(folder, '.claude', 'settings.local.json'), 'utf8'), '{}', 'a folder above a skip target is entered, its other files cloned');
  assert.equal(readFileSync(join(folder, 'tools', 'run.sh'), 'utf8'), 'echo run\n', 'a tracked file beside a skipped folder is cloned');
  assert.equal(lstatSync(join(folder, 'src', 'app.js')).mtimeMs, lstatSync(tracked).mtimeMs);
  const skipList = ['personal', join('.claude', 'worktrees'), 'venv', join('tools', 'tool-venv'), 'HANDOFF-x.md'];
  assert.deepEqual(skipList.filter((path) => !filled.skipped.includes(path)), [], `skipped: ${filled.skipped}`);
  assert.equal(statusOf(folder), '');
});

test('fillFresh: a dirty main checkout is repaired: changed and deleted tracked files match the target, an untracked file is not copied', NEEDS_CLONE, () => {
  const repo = jsRepo();
  track(repo, 'changed.txt', 'committed\n');
  track(repo, 'deleted.txt', 'committed\n');
  const target = head(repo);
  writeFileSync(join(repo, 'changed.txt'), 'edited in main\n');
  rmSync(join(repo, 'deleted.txt'));
  writeFileSync(join(repo, 'untracked.txt'), 'not committed\n');
  const folder = addEmptySlot(repo, 1, target);
  const filled = fill(repo, folder, target);
  assert.equal(statusOf(folder), '');
  assert.equal(filled.repaired, 2);
  assert.equal(readFileSync(join(folder, 'changed.txt'), 'utf8'), 'committed\n');
  assert.equal(readFileSync(join(folder, 'deleted.txt'), 'utf8'), 'committed\n');
  assert.ok(!existsSync(join(folder, 'untracked.txt')));
  assert.equal(readFileSync(join(repo, 'changed.txt'), 'utf8'), 'edited in main\n', 'the main checkout is only read');
});

test('GIT_TIDY_LANE_FILL=checkout: cloneSupport says checkout, and fillFresh still ends clean without cloning ignored files', () => {
  const repo = jsRepo();
  track(repo, 'tracked.txt', 'tracked\n');
  writeFile(join(repo, '.env'), 'SECRET=local');
  const target = head(repo);
  const folder = addEmptySlot(repo, 1, target);
  const support = cloneSupport(repo, join(realpathSync(repo), '.claude', 'worktrees'), { [FILL_ENV]: 'checkout' });
  assert.equal(support.mode, 'checkout');
  assert.match(support.why, new RegExp(FILL_ENV));
  process.env[FILL_ENV] = 'checkout';
  let filled;
  try {
    filled = fill(repo, folder, target);
  } finally {
    delete process.env[FILL_ENV];
  }
  assert.equal(filled.mode, 'checkout');
  assert.equal(filled.entries, 0);
  assert.equal(statusOf(folder), '');
  assert.equal(readFileSync(join(folder, 'tracked.txt'), 'utf8'), 'tracked\n');
  assert.ok(!existsSync(join(folder, '.env')), 'checkout mode clones nothing');
});

test('fillFresh refuses the main checkout and a plain folder, naming why, before any write', () => {
  const repo = jsRepo();
  const target = head(repo);
  const mainFolder = realpathSync(repo);
  const poolFolder = poolPath(repo, 1);
  writeFile(join(poolFolder, 'mine.txt'), 'my own work'); // a lane-<n> folder that is no worktree
  const elsewhere = join(mainFolder, '..', 'plain-folder');
  writeFile(join(elsewhere, 'mine.txt'), 'my own work');
  const refused = [
    ['the main checkout', mainFolder, /is the main checkout, never a lane/],
    ['a plain lane-<n> folder', poolFolder, /is not a worktree of this repository/],
    ['a plain folder', elsewhere, /is not a worktree of this repository/],
  ];
  for (const [name, folder, why] of refused) {
    const before = filesOf(folder);
    assert.throws(() => fill(repo, folder, target), (error) => error instanceof UsageError && why.test(error.message), name);
    assert.deepEqual(filesOf(folder), before, `${name} is unchanged`);
  }
  assert.equal(statusOf(repo), '');
});

test('fillFresh clones tracked files named -rf and with a newline, and the status is clean', NO_NEWLINE_NAMES, () => {
  const repo = jsRepo();
  track(repo, '-rf', 'dash\n');
  track(repo, 'a\nb', 'newline\n');
  const target = head(repo);
  const folder = addEmptySlot(repo, 1, target);
  fill(repo, folder, target);
  assert.equal(statusOf(folder), '');
  assert.equal(readFileSync(join(folder, '-rf'), 'utf8'), 'dash\n');
  assert.equal(readFileSync(join(folder, 'a\nb'), 'utf8'), 'newline\n');
});

test('fillFresh restores tracked files named -rf, :(exclude)x and with a newline that main has edited, and leaves them as committed', { skip: NEEDS_CLONE.skip || NO_NEWLINE_NAMES.skip }, () => {
  const repo = jsRepo();
  track(repo, '-rf', 'dash\n');
  track(repo, 'a\nb', 'newline\n');
  track(repo, ':(exclude)x', 'magic\n');
  const target = head(repo);
  writeFileSync(join(repo, '-rf'), 'edited dash\n');
  writeFileSync(join(repo, 'a\nb'), 'edited newline\n');
  writeFileSync(join(repo, ':(exclude)x'), 'edited magic\n');
  const folder = addEmptySlot(repo, 1, target);
  const filled = fill(repo, folder, target);
  assert.equal(filled.repaired, 3);
  assert.equal(statusOf(folder), '');
  assert.equal(readFileSync(join(folder, '-rf'), 'utf8'), 'dash\n');
  assert.equal(readFileSync(join(folder, 'a\nb'), 'utf8'), 'newline\n');
  assert.equal(readFileSync(join(folder, ':(exclude)x'), 'utf8'), 'magic\n');
});
