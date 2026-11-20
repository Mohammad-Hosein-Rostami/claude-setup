// Tests of review-tier's own temp folder (lib/temp-repository.mjs) against a process of the same user that swaps an entry at the moment
// the tool removes it (lane r7-delta, fix round 7, K4). Each case runs in a child process with `fs` patched
// (syncBuiltinESMExports) so that the swap lands in the exact window, and a changed working directory stays out of the test runner.
// POSIX only (symlinks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'a symlink needs a privilege on Windows' };
const CHILD_TIMEOUT_MS = 60_000; // a child that blocks is killed: the case fails instead of blocking the test runner
const TEMP_REPOSITORY = new URL('../home/tools/review-tier/lib/temp-repository.mjs', import.meta.url).href;

/**
 * Runs `code` (an ES module) in a child process with `env` added; a child still running after CHILD_TIMEOUT_MS is killed (`error`
 * ETIMEDOUT).
 */
const inChild = (code, env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: CHILD_TIMEOUT_MS });

/**
 * How a same-user process swaps things during the removal of the run's own folder, as code the K4 child runs: `onLstat(path)` after
 * the removal's lstat of `path`, `onReaddir(path)` before a read of the folder `path`, `before()` before the removal starts. `objects`,
 * `made` (makeTempFolder's result) and `victim` (a folder outside) are in scope.
 */
const FOLDER_SWAPS = {
  // a folder in it swapped for a link: right after the removal looked at it by its bare name (this module), or right before a read of
  // it by its path (Node 22's rmSync, which reads a folder again by its path after rmdir found it not empty)
  'a folder in it swapped for a link': {
    onLstat: "if (String(path) === 'objects') swapOnce(() => { fs.renameSync(objects, made.path + '/aside'); fs.symlinkSync(victim, objects); });",
    onReaddir: 'if (String(path) === objects) swapOnce(() => { fs.renameSync(objects, made.path + \'/aside\'); fs.symlinkSync(victim, objects); });',
  },
  // the folder being emptied moved into another folder: leaving it with `..` would land in that other folder
  'a folder in it moved out while it is emptied': {
    onLstat: "if (String(path) === 'pack') swapOnce(() => fs.renameSync(objects, victim + '/objects'));",
  },
  'the folder itself swapped for a link before the removal': {
    before: "swapOnce(() => { fs.renameSync(made.path, made.path + '-aside'); fs.symlinkSync(victim, made.path); });",
  },
};

test('fix 7 K4: the run\'s own folder is removed from inside: a link or a move swapped in during the removal stops it, nothing outside the folder is removed, and the working directory is put back', POSIX_ONLY, async (t) => {
  for (const [label, { onLstat = '', onReaddir = '', before = '' }] of Object.entries(FOLDER_SWAPS)) {
    await t.test(label, () => {
      const victim = realpathSync(makeTempDir('review-tier-victim-'));
      mkdirSync(join(victim, 'inner'));
      for (const file of ['keep.txt', 'inner/keep.txt', 'HEAD', 'refs']) writeFileSync(join(victim, file), 'keep\n');
      const code = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const victim = process.env.CASE;
const { makeTempFolder, removeTempFolder } = await import(${JSON.stringify(TEMP_REPOSITORY)});
const made = makeTempFolder();
fs.mkdirSync(made.path + '/objects/pack', { recursive: true });
fs.mkdirSync(made.path + '/refs');
for (const file of ['HEAD', 'objects/pack/pack-x.pack']) fs.writeFileSync(made.path + '/' + file, 'x');
const objects = made.path + '/objects';
let swapped = false;
const swapOnce = (swap) => { if (!swapped) { swapped = true; swap(); } };
const [lstat, readdir] = [fs.lstatSync, fs.readdirSync];
fs.lstatSync = (path, ...rest) => { const info = lstat(path, ...rest); ${onLstat} return info; };
fs.readdirSync = (path, ...rest) => { ${onReaddir} return readdir(path, ...rest); };
syncBuiltinESMExports();
${before}
const cwd = process.cwd();
const problem = removeTempFolder(made);
console.log(JSON.stringify({ problem, swapped, back: process.cwd() === cwd }));`;
      const result = inChild(code, { TMPDIR: realpathSync(makeTempDir('review-tier-tmpdir-')), CASE: victim });
      assert.equal(result.status, 0, result.stderr);
      const { problem, swapped, back } = JSON.parse(result.stdout);
      assert.ok(swapped, 'the swap was made during the removal');
      const kept = ['keep.txt', 'inner/keep.txt', 'HEAD', 'refs'].map((file) => readFileSync(join(victim, file), 'utf8'));
      assert.deepEqual(kept, Array(kept.length).fill('keep\n'), 'nothing outside the folder was removed');
      if (label.includes('moved out')) assert.ok(existsSync(join(victim, 'objects')), 'the folder moved out is not removed from where it went');
      assert.match(problem ?? '', /^the temp folder .*review-tier-git-.* was not removed in full, the rest is left there: a folder in it was replaced while it was being removed$/);
      assert.ok(back, 'the working directory is put back');
    });
  }
});
