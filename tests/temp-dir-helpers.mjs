// Temp folders for tests that remove themselves. Exports: TEST_TEMP_PREFIX, makeTempDir, removeTempDir.
// Why: 82 of 107 test files used to call mkdtemp and never remove the folder, so every test run left thousands of folders in
// os.tmpdir() (1.1 million entries measured). Every test makes its folders here; the process-exit hook below removes whatever
// is left, also when a test throws. The prefix lets home/tools/disk-free/disk-clean.mjs find leftovers of a killed run.
// Invariants: os.tmpdir() is read at call time (so a launcher's TMPDIR counts); only folders this process made are removed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_TEMP_PREFIX = 'cs-test-';

const madeHere = new Set();

/** Removes one folder now (and forgets it). Prints a line to stderr when removing fails: a leftover must be seen, not hidden. */
export function removeTempDir(dir) {
  madeHere.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(`temp-dir-helpers: could not remove ${dir}: ${error.message}`);
  }
}

/**
 * Makes a fresh folder `<tmpdir>/cs-test-<label>XXXXXX` that is removed when this process ends.
 * @param {string} label what the folder is for, usually ending in `-` (like the prefix of an mkdtemp call)
 * @param {string} root where to make it; only a test that needs a short path (a unix socket path holds about 100 bytes) passes '/tmp'
 * @returns {string} the folder path
 */
export function makeTempDir(label = '', root = tmpdir()) {
  const dir = mkdtempSync(join(root, `${TEST_TEMP_PREFIX}${label}`));
  madeHere.add(dir);
  return dir;
}

process.on('exit', () => {
  for (const dir of [...madeHere]) removeTempDir(dir);
});
