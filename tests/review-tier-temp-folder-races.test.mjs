// Tests of review-tier's own temp folder (lib/temp-repository.mjs) against a process of the same user that swaps an entry at the moment
// the tool reads or removes it (lane r7-delta, fix round 7: K5, security N37; K4). Each case runs in a child process with `fs` patched
// (syncBuiltinESMExports) so that the swap lands in the exact window, and a read that blocks or a changed working directory stays out of
// the test runner. POSIX only (FIFOs, symlinks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './temp-dir-helpers.mjs';

const POSIX_ONLY = { skip: process.platform === 'win32' && 'FIFOs and symlinks in a folder are POSIX here' };
const CHILD_TIMEOUT_MS = 60_000; // a child that blocks is killed: the case fails instead of blocking the test runner
const TEMP_REPOSITORY = new URL('../home/tools/review-tier/lib/temp-repository.mjs', import.meta.url).href;
const GIT_TIDY = new URL('../home/tools/git-tidy/lib/git.mjs', import.meta.url).href;

/**
 * Runs `code` (an ES module) in a child process with `env` added; a child still running after CHILD_TIMEOUT_MS is killed (`error`
 * ETIMEDOUT).
 */
const inChild = (code, env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: CHILD_TIMEOUT_MS });

/** What a same-user process puts in place of the `.pack` at `path` in the K5 cases: a FIFO, or a copy of its bytes (another inode). */
const PACK_SWAPS = {
  fifo: "fs.unlinkSync(path); spawnSync('mkfifo', [path]);",
  copy: "fs.copyFileSync(path, path + '.copy'); fs.renameSync(path + '.copy', path);",
};

test('fix 7 K5, security N37: a .pack swapped for a FIFO, or for a copy of its bytes, right after the last check looked at it is exit 2 at the hash, not a read that blocks or that hashes the other file', POSIX_ONLY, async (t) => {
  for (const [kind, swap] of Object.entries(PACK_SWAPS)) {
    await t.test(kind, () => {
      const folder = realpathSync(makeTempDir('review-tier-packs-'));
      mkdirSync(join(folder, 'objects', 'pack'), { recursive: true });
      const name = `pack-${'d'.repeat(40)}`;
      const bytes = Buffer.from('PACK bytes the tool wrote');
      for (const ext of ['pack', 'idx', 'rev']) writeFileSync(join(folder, 'objects', 'pack', `${name}.${ext}`), ext === 'pack' ? bytes : 'x');
      const written = { trailer: 'd'.repeat(40), sha256: createHash('sha256').update(bytes).digest('hex') };
      const pack = join(folder, 'objects', 'pack', `${name}.pack`);
      const code = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
const { folder, name, written, pack } = JSON.parse(process.env.CASE);
const real = fs.lstatSync;
let looks = 0;
// the second look at the .pack is the last check's: right after it, another file takes its place
fs.lstatSync = (path, ...rest) => { const info = real(path, ...rest); if (path === pack && (looks += 1) === 2) { ${swap} } return info; };
syncBuiltinESMExports();
const { checkPackFiles, notePackFiles } = await import(${JSON.stringify(TEMP_REPOSITORY)});
const { UsageError } = await import(${JSON.stringify(GIT_TIDY)});
try {
  checkPackFiles(folder, new Map([[name, notePackFiles(folder, name, written)]]), { last: true });
} catch (error) {
  console.error(error.message);
  process.exit(error instanceof UsageError ? 2 : 1); // 2: the CLI's exit code for a UsageError
}`;
      const result = inChild(code, { CASE: JSON.stringify({ folder, name, written, pack }) });
      assert.equal(result.error?.code, undefined, `the check ended by itself: ${result.error?.message}`);
      assert.equal(lstatSync(pack).isFIFO(), kind === 'fifo', `the ${kind} was swapped in: ${result.stderr}`);
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /the tool's own temp repository changed during the run: .*\.pack is gone or is not the file git index-pack wrote/);
    });
  }
});

test('fix 7 K5: HEAD swapped for a FIFO right after the tool opened and checked it is not read again by name: the snapshot reads the descriptor it checked and does not block', POSIX_ONLY, () => {
  const folder = realpathSync(makeTempDir('review-tier-snapshot-'));
  for (const [file, text] of [['HEAD', 'ref: refs/heads/main\n'], ['config', '[core]\n']]) writeFileSync(join(folder, file), text);
  const code = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
const folder = process.env.CASE;
const real = fs.fstatSync;
let swapped = false;
// the first fstat is the one of HEAD's descriptor: right after it, a FIFO takes HEAD's name
fs.fstatSync = (...args) => { const info = real(...args); if (!swapped) { swapped = true; fs.unlinkSync(folder + '/HEAD'); spawnSync('mkfifo', [folder + '/HEAD']); } return info; };
syncBuiltinESMExports();
const { snapshotOf } = await import(${JSON.stringify(TEMP_REPOSITORY)});
console.log(snapshotOf(folder).get('HEAD').toString().trim());`;
  const result = inChild(code, { CASE: folder });
  assert.equal(result.error?.code, undefined, `the snapshot ended by itself: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lstatSync(join(folder, 'HEAD')).isFIFO(), 'the FIFO was swapped in');
  assert.equal(result.stdout.trim(), 'ref: refs/heads/main', 'the bytes of the file that was checked');
});

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
