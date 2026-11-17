// Tests for the doctor check check_disk_free (scripts/doctor.sh, DOCTOR_ONLY mode): FAIL below the fail threshold, WARN below the warn
// threshold, ok above, with df text injected through DISK_FREE_DF_OUTPUT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.sh', import.meta.url));
const KB_PER_GB = 1024 * 1024;
const dfWithFreeGb = (gb) => `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 976490576 900000000 ${gb * KB_PER_GB} 99% /\n`;

async function doctorDisk(freeGb, env = {}) {
  const home = makeTempDir('doctor-disk-');
  return spawnSync('bash', [DOCTOR], {
    env: { ...process.env, HOME: home, DOCTOR_ONLY: 'check_disk_free', DISK_FREE_DF_OUTPUT: dfWithFreeGb(freeGb), DISK_FREE_CLAUDE_TMP: join(home, 'none'), ...env },
    encoding: 'utf8',
  });
}

test('check_disk_free FAILs below 5 GB, exits 1 and names the caches to clear', async () => {
  const result = await doctorDisk(3);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s+disk free 3\.0 GB is below 5 GB/m);
  assert.match(result.stdout, /docker builder prune/);
});

test('check_disk_free WARNs from 5 GB up to 15 GB and still exits 0', async () => {
  const result = await doctorDisk(10);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^WARN\s+disk free 10\.0 GB is below 15 GB/m);
});

test('check_disk_free is ok at 15 GB and above', async () => {
  const result = await doctorDisk(15);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^ok\s+disk free 15\.0 GB/m);
});

test('check_disk_free uses the env thresholds: 8 GB free fails with DISK_FAIL_FREE_GB=10', async () => {
  const result = await doctorDisk(8, { DISK_FAIL_FREE_GB: '10', DISK_WARN_FREE_GB: '20' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s+disk free 8\.0 GB is below 10 GB/m);
});

test('check_disk_free FAILs, not passes, when the tool cannot read the disk', async () => {
  const result = await doctorDisk(50, { DISK_FREE_DF_OUTPUT: 'garbage' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL\s+disk free check could not run/m);
});

function doctorDiskClean(fakeBytes, env = {}) {
  const home = makeTempDir('doctor-clean-');
  const tmp = join(home, 'tmp');
  mkdirSync(join(tmp, 'cs-test-old-AbCdEf'), { recursive: true });
  writeFileSync(join(tmp, 'cs-test-old-AbCdEf', 'big.bin'), 'x'.repeat(fakeBytes));
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  utimesSync(join(tmp, 'cs-test-old-AbCdEf'), old, old);
  const roots = `--claude-tmp ${join(home, 'none')} --projects ${join(home, 'projects')} --tmp ${tmp}`;
  return spawnSync('bash', [DOCTOR], { env: { ...process.env, HOME: home, DOCTOR_ONLY: 'check_disk_clean', DOCTOR_DISK_CLEAN_ARGS: roots, ...env }, encoding: 'utf8' });
}

test('check_disk_clean prints an INFO line with the dry-run total and exits 0', () => {
  const result = doctorDiskClean(10_000);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^INFO\s+disk-clean could remove 1 items, 0\.00 GB: run node .*disk-clean\.mjs --apply/m);
});

test('check_disk_clean WARNs above the limit (2 GB; a test hook lowers it) and still exits 0', () => {
  const result = doctorDiskClean(50_000, { DOCTOR_DISK_CLEAN_WARN_BYTES: '20000' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^WARN\s+disk-clean could remove 1 items, 0\.00 GB/m);
});
