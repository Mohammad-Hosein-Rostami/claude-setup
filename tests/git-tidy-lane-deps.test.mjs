// Tests of the deps cache of the lane pool (lib/lane-deps.mjs, lane-prep.mjs): a first claim saves node_modules under its key, a second lane gets
// it as a clone without any package manager, and the key and the pruning follow the rules of the design.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEAN_ENV, commit, git } from './git-tidy-helpers.mjs';
import { claim, deadPid, installLog, lane, laneEnv, poolPath, writeFile } from './git-tidy-lane-pool-helpers.mjs';
import { NEEDS_CLONE, jsRepo } from './git-tidy-lane-fill-helpers.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';
import { depsKey, pruneCache } from '../home/tools/git-tidy/lib/lane-deps.mjs';
import { PREP_MARKER } from '../home/tools/git-tidy/lib/lane-prep.mjs';

const LOCKFILE = 'package-lock.json';
const LOCKFILE_TEXT = '{"lockfileVersion":3}';
const LOCKFILE_INSTALL = { dir: '.', lockfile: LOCKFILE, sha256: createHash('sha256').update(LOCKFILE_TEXT).digest('hex') };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const POSIX_ONLY = { skip: process.platform === 'win32' && 'the stripped PATH is made of symlinks' };

const head = (dir) => git(dir, 'rev-parse', 'HEAD');
const commonDirOf = (repo) => git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const cacheOf = (repo) => join(commonDirOf(repo), 'cs-lane-deps');

/** A PATH folder holding only git and cp, so a test can claim with no npm anywhere on PATH (the system's own folders may hold one). */
function pathWithoutPackageManagers() {
  const bin = makeTempDir('lane-deps-bin-');
  for (const program of ['git', 'cp']) {
    const found = CLEAN_ENV.PATH.split(delimiter).map((folder) => join(folder, program)).find((file) => existsSync(file));
    symlinkSync(found, join(bin, program));
  }
  return bin;
}

test('the first claim for a lockfile installs and saves node_modules with its marker in <common>/cs-lane-deps/<key>', NEEDS_CLONE, () => {
  const repo = jsRepo();
  commit(repo, LOCKFILE, LOCKFILE_TEXT);
  const env = laneEnv();
  const result = claim(repo, 'a', head(repo), env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(installLog(env).map(({ program, args }) => [program, ...args]), [['npm', 'ci']]);
  const key = depsKey(LOCKFILE_INSTALL);
  assert.deepEqual(readdirSync(cacheOf(repo)), [key], 'one whole entry, no temp left');
  const saved = join(cacheOf(repo), key, 'node_modules');
  assert.deepEqual(JSON.parse(readFileSync(join(saved, PREP_MARKER), 'utf8')), { lockfile: LOCKFILE, sha256: LOCKFILE_INSTALL.sha256 });
  assert.ok(existsSync(join(saved, 'installed.txt')), 'the install result is in the entry');
});

test('a second lane for the same lockfile is ready with no package manager on PATH: its node_modules is cloned from the cache', { skip: NEEDS_CLONE.skip || POSIX_ONLY.skip }, () => {
  const repo = jsRepo();
  commit(repo, LOCKFILE, LOCKFILE_TEXT);
  const first = laneEnv();
  assert.equal(claim(repo, 'a', head(repo), first).status, 0);
  const noInstaller = { ...first, PATH: pathWithoutPackageManagers() };
  const second = lane(['claim', '--repo', repo, '--branch', 'b', '--base', head(repo), '--json'], noInstaller);
  assert.equal(second.status, 0, second.stderr);
  const result = JSON.parse(second.stdout);
  assert.equal(result.folder, poolPath(repo, 2), 'a new slot, so nothing was kept');
  assert.equal(result.ready, true);
  assert.equal(result.installs[0].outcome, 'cloned');
  assert.equal(installLog(first).length, 1, 'no second install ran');
  const cloned = join(result.folder, 'node_modules');
  assert.equal(readFileSync(join(cloned, 'installed.txt'), 'utf8'), 'npm');
  assert.equal(JSON.parse(readFileSync(join(cloned, PREP_MARKER), 'utf8')).sha256, LOCKFILE_INSTALL.sha256);
  assert.equal(git(result.folder, 'status', '--porcelain'), '');
});

test('depsKey differs for another Node ABI, another lockfile hash and another lockfile folder, and is the same for the same input', () => {
  const abi = Object.getOwnPropertyDescriptor(process.versions, 'modules');
  const key = depsKey(LOCKFILE_INSTALL);
  let otherAbi;
  try {
    Object.defineProperty(process.versions, 'modules', { ...abi, value: `${abi.value}-other` });
    otherAbi = depsKey(LOCKFILE_INSTALL);
  } finally {
    Object.defineProperty(process.versions, 'modules', abi);
  }
  assert.equal(depsKey(LOCKFILE_INSTALL), key, 'the same input gives the same key');
  assert.notEqual(otherAbi, key);
  assert.notEqual(depsKey({ ...LOCKFILE_INSTALL, sha256: 'f'.repeat(64) }), key);
  assert.notEqual(depsKey({ ...LOCKFILE_INSTALL, dir: 'packages/web' }), key);
  assert.match(key, /^[0-9a-f]{64}$/, 'one plain folder name');
});

/** Makes `<cache>/<name>/` (an entry with a node_modules and a readers folder) and sets the readers folder's age. */
function makeEntry(cache, name, { ageMs = 0, readers = [] } = {}) {
  writeFile(join(cache, name, 'node_modules', 'index.js'), 'module.exports = 1;');
  mkdirSync(join(cache, name, 'readers'), { recursive: true });
  for (const reader of readers) writeFileSync(join(cache, name, 'readers', String(reader)), '');
  const then = new Date(Date.now() - ageMs);
  utimesSync(join(cache, name, 'readers'), then, then);
  utimesSync(join(cache, name), then, then);
}

test('pruneCache removes a temp older than an hour and an unused entry with no live reader, and keeps a live-reader entry, a young temp and a young entry', () => {
  const commonDir = makeTempDir('lane-deps-common-');
  const cache = join(commonDir, 'cs-lane-deps');
  makeEntry(cache, `${'a'.repeat(64)}.tmp-1234-abcd`, { ageMs: 2 * HOUR_MS });
  makeEntry(cache, `${'b'.repeat(64)}.tmp-1234-abcd`, { ageMs: HOUR_MS / 2 });
  makeEntry(cache, 'c'.repeat(64), { ageMs: 8 * DAY_MS, readers: [process.pid] });
  makeEntry(cache, 'd'.repeat(64), { ageMs: 8 * DAY_MS, readers: [deadPid()] });
  makeEntry(cache, 'e'.repeat(64), { ageMs: 8 * DAY_MS });
  makeEntry(cache, 'f'.repeat(64), { ageMs: DAY_MS });
  const result = pruneCache(commonDir);
  assert.deepEqual(result, { removed: 3 });
  assert.deepEqual(readdirSync(cache).sort(), [`${'b'.repeat(64)}.tmp-1234-abcd`, 'c'.repeat(64), 'f'.repeat(64)]);
  assert.ok(existsSync(join(cache, 'c'.repeat(64), 'node_modules', 'index.js')), 'the live reader\'s entry is whole');
});
