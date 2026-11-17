// Tests for home/tools/disk-free: the free-space verdict from injected `df -Pk` output, the thresholds and their env overrides,
// and the naming of the biggest rebuildable caches. No real df or large folder is touched: df text comes in through DISK_FREE_DF_OUTPUT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableGb, judgeFreeSpace } from '../home/tools/disk-free/disk-free.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/disk-free.mjs', import.meta.url));
const KB_PER_GB = 1024 * 1024;
const dfWithFreeGb = (gb) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 976490576 900000000 ${Math.round(gb * KB_PER_GB)} 99% /System/Volumes/Data\n`;

test('availableGb reads the Available column of df -Pk, also when the filesystem name has spaces', () => {
  assert.equal(availableGb(dfWithFreeGb(4)), 4);
  assert.equal(availableGb('Filesystem 1024-blocks Used Available Capacity Mounted on\nmy disk 100 50 2097152 50% /Volumes/My Disk\n'), 2);
});

test('availableGb throws on text that is not df output', () => {
  assert.throws(() => availableGb('nonsense'), /df output/);
  assert.throws(() => availableGb(''), /df output/);
});

test('below 5 GB is FAIL, 5 to 15 GB is WARN, 15 GB and above is ok', () => {
  assert.equal(judgeFreeSpace(4.9, {}).level, 'FAIL');
  assert.equal(judgeFreeSpace(5, {}).level, 'WARN');
  assert.equal(judgeFreeSpace(14.9, {}).level, 'WARN');
  assert.equal(judgeFreeSpace(15, {}).level, 'ok');
});

test('the thresholds come from DISK_FAIL_FREE_GB and DISK_WARN_FREE_GB', () => {
  const env = { DISK_FAIL_FREE_GB: '20', DISK_WARN_FREE_GB: '50' };
  assert.equal(judgeFreeSpace(19, env).level, 'FAIL');
  assert.equal(judgeFreeSpace(30, env).level, 'WARN');
  assert.equal(judgeFreeSpace(50, env).level, 'ok');
});

test('a threshold that is not a positive number is refused, not ignored', () => {
  assert.throws(() => judgeFreeSpace(10, { DISK_FAIL_FREE_GB: 'abc' }), /DISK_FAIL_FREE_GB/);
  assert.throws(() => judgeFreeSpace(10, { DISK_WARN_FREE_GB: '-1' }), /DISK_WARN_FREE_GB/);
  assert.throws(() => judgeFreeSpace(10, { DISK_FAIL_FREE_GB: '20', DISK_WARN_FREE_GB: '10' }), /warn.*fail|fail.*warn/);
});

async function fakeHome(sizesKb) {
  const home = await mkdtemp(join(tmpdir(), 'disk-free-home-'));
  const folders = {
    derivedData: 'Library/Developer/Xcode/DerivedData',
    simulators: 'Library/Developer/CoreSimulator',
    caches: 'Library/Caches',
    npm: '.npm',
    pnpm: 'Library/pnpm/store',
  };
  for (const [key, kb] of Object.entries(sizesKb)) {
    await mkdir(join(home, folders[key]), { recursive: true });
    await writeFile(join(home, folders[key], 'blob'), Buffer.alloc(kb * 1024));
  }
  return home;
}

function check(home, freeGb, extraEnv = {}, extraArgs = []) {
  return spawnSync('node', [TOOL, 'check', ...extraArgs], {
    env: { ...process.env, HOME: home, DISK_FREE_DF_OUTPUT: dfWithFreeGb(freeGb), DISK_FREE_CLAUDE_TMP: join(home, 'no-such-claude-tmp'), ...extraEnv },
    encoding: 'utf8',
  });
}

test('check prints ok and exits 0 with plenty of space, and measures no folder', async () => {
  const result = check(await fakeHome({ caches: 64 }), 100);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ok\s+disk free 100\.0 GB/);
  assert.doesNotMatch(result.stdout, /Caches/);
});

test('check below the fail threshold prints FAIL, exits 1 and names the biggest caches first', async () => {
  const home = await fakeHome({ derivedData: 4096, simulators: 8192, caches: 1024, npm: 16 });
  const result = check(home, 3);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s+disk free 3\.0 GB is below 5 GB/);
  const named = result.stdout.indexOf('CoreSimulator') < result.stdout.indexOf('DerivedData');
  assert.ok(named, `the larger CoreSimulator is named before DerivedData: ${result.stdout}`);
  assert.match(result.stdout, /Xcode DerivedData/);
  assert.match(result.stdout, /docker builder prune/);
});

test('check between the thresholds prints WARN, exits 0 and names caches', async () => {
  const result = check(await fakeHome({ caches: 2048 }), 10);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^WARN\s+disk free 10\.0 GB is below 15 GB/);
  assert.match(result.stdout, /~\/Library\/Caches/);
});

test('check counts old claude session folders under DISK_FREE_CLAUDE_TMP', async () => {
  const home = await fakeHome({});
  const sessions = join(home, 'claude-tmp');
  await mkdir(join(sessions, 'old-session'), { recursive: true });
  await writeFile(join(sessions, 'old-session', 'blob'), Buffer.alloc(3 * 1024 * 1024));
  const result = check(home, 3, { DISK_FREE_CLAUDE_TMP: sessions });
  assert.match(result.stdout, /claude session folders/);
});

test('a folder too big to measure in time is still named, without a size', async () => {
  const result = check(await fakeHome({ caches: 2048 }), 3, { DISK_FREE_DU_TIMEOUT_MS: '1' });
  assert.match(result.stdout, /~\/Library\/Caches \(size not measured in time/);
});

test('the time limit covers all folders together, so many slow folders cannot pass the runner timeout', async () => {
  const slowBin = await mkdtemp(join(tmpdir(), 'disk-free-slow-du-'));
  await writeFile(join(slowBin, 'du'), '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
  const home = await fakeHome({ derivedData: 1, simulators: 1, caches: 1, npm: 1 });
  const startedAt = Date.now();
  const result = check(home, 3, { PATH: `${slowBin}:${process.env.PATH}`, DISK_FREE_DU_TIMEOUT_MS: '1000' });
  const elapsedMs = Date.now() - startedAt;
  assert.equal((result.stdout.match(/size not measured in time/g) ?? []).length, 4, 'every folder is still named');
  assert.ok(elapsedMs < 2500, `4 folders with a 1000 ms total limit took ${elapsedMs} ms`);
});

test('check honours the env override of the fail threshold', async () => {
  const result = check(await fakeHome({}), 8, { DISK_FAIL_FREE_GB: '10', DISK_WARN_FREE_GB: '20' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s+disk free 8\.0 GB is below 10 GB/);
});

test('check output is one line, so a workflow runner reports it whole', async () => {
  const result = check(await fakeHome({ caches: 2048, npm: 64 }), 2);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1);
});

test('check exits 2 with a usage message for a bad threshold, df text or command', async () => {
  const home = await fakeHome({});
  assert.equal(check(home, 50, { DISK_FAIL_FREE_GB: 'x' }).status, 2);
  assert.equal(check(home, 50, { DISK_FREE_DF_OUTPUT: 'garbage' }).status, 2);
  assert.equal(spawnSync('node', [TOOL, 'bogus'], { encoding: 'utf8' }).status, 2);
});
