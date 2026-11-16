// Tests for home/tools/status/status-file.mjs readStatusFile: the read handle is opened with O_NOFOLLOW and O_NONBLOCK and checked
// with fstat (a regular file of at most MAX_STATUS_BYTES), so a link, FIFO or device is refused even when it is swapped in after
// status.mjs's lstat. The audit's mutation run removed these flags and checks and the status tests still passed; these fail then.
// FIFO and swap cases run in a child process with a timeout, so a read that blocks fails the test instead of hanging the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_STATUS_BYTES, readStatusFile } from '../home/tools/status/status-file.mjs';

const posix = { skip: process.platform === 'win32' ? 'no O_NOFOLLOW, FIFO or /dev/null on Windows' : false };
const STATUS_FILE_URL = new URL('../home/tools/status/status-file.mjs', import.meta.url).href;
const STATUS_URL = new URL('../home/tools/status/status.mjs', import.meta.url).href;
const CHILD_TIMEOUT_MS = 5000; // a refused read takes a few ms; a read blocked on a FIFO never returns
const TEXT = '## Work items\n\n| id | item | size | started | done | evidence |\n| -- | -- | -- | -- | -- | -- |\n';

/** Runs module code in a child node with args; returns its parsed JSON line, or fails on a timeout or crash. */
function inChild(code, args) {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS });
  assert.equal(run.error?.code, undefined, `the child did not finish in ${CHILD_TIMEOUT_MS} ms (a read blocked)`);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const READ_IN_CHILD = `
const { readStatusFile } = await import(process.argv[1]);
console.log(JSON.stringify(readStatusFile(process.argv[2])));`;

// After status.mjs's first lstat of the file, the spare (a link or FIFO) is renamed over it: only the fd checks can catch it.
// The folder comes first: status.mjs's own CLI check realpaths process.argv[1], so it must be a real path.
const SWAP_AFTER_LSTAT = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [dir, spare, statusUrl] = process.argv.slice(1);
const file = dir + '/STATUS.md';
const realLstat = fs.lstatSync;
let swapped = false;
fs.lstatSync = (path, options) => {
  const stats = realLstat(path, options);
  if (path === file && !swapped) {
    swapped = true;
    fs.renameSync(spare, file);
  }
  return stats;
};
syncBuiltinESMExports();
const { runStatus } = await import(statusUrl);
const outcome = runStatus(['rule', 'swapped'], { cwd: dir, now: new Date('2026-11-16T12:00Z'), sessionId: 'swap-test', stateDir: dir + '/.state' });
console.log(JSON.stringify({ swapped, ...outcome }));`;

// status.mjs works on the real path (/private/var on macOS), and the swap matches the path it lstats
const tempDir = async () => realpathSync(await mkdtemp(join(tmpdir(), 'status-file-')));

test('readStatusFile reads a regular file under the cap', async () => {
  const file = join(await tempDir(), 'STATUS.md');
  writeFileSync(file, TEXT);
  assert.deepEqual(readStatusFile(file), { text: TEXT });
});

test('readStatusFile never follows a link: ELOOP, and the target is not read', posix, async () => {
  const dir = await tempDir();
  writeFileSync(join(dir, 'target.md'), TEXT);
  symlinkSync(join(dir, 'target.md'), join(dir, 'STATUS.md'));
  assert.throws(() => readStatusFile(join(dir, 'STATUS.md')), { code: 'ELOOP' });
});

test('readStatusFile refuses a FIFO and a device at once, without waiting on them', posix, async () => {
  const fifo = join(await tempDir(), 'STATUS.md');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo made the FIFO');
  for (const path of [fifo, '/dev/null']) {
    assert.deepEqual(inChild(READ_IN_CHILD, [STATUS_FILE_URL, path]), { refused: 'is not a regular file (a link or special file)' }, path);
  }
});

test('readStatusFile refuses a file over MAX_STATUS_BYTES by its fstat size', async () => {
  const file = join(await tempDir(), 'STATUS.md');
  writeFileSync(file, TEXT);
  truncateSync(file, MAX_STATUS_BYTES + 1); // sparse: no 4 MiB written
  assert.deepEqual(readStatusFile(file), { refused: `is over ${MAX_STATUS_BYTES} bytes` });
});

test('a link or FIFO swapped in after status.mjs\'s lstat is refused by the read handle, and nothing is written', posix, async () => {
  const linkDir = await tempDir();
  writeFileSync(join(linkDir, 'STATUS.md'), TEXT);
  writeFileSync(join(linkDir, 'target.md'), 'secret target\n');
  symlinkSync(join(linkDir, 'target.md'), join(linkDir, 'spare'));
  const viaLink = inChild(SWAP_AFTER_LSTAT, [linkDir, join(linkDir, 'spare'), STATUS_URL]);
  assert.deepEqual([viaLink.swapped, viaLink.code], [true, 1], viaLink.message);
  assert.match(viaLink.message, /ELOOP/);
  assert.equal(readFileSync(join(linkDir, 'target.md'), 'utf8'), 'secret target\n');
  assert.ok(lstatSync(join(linkDir, 'STATUS.md')).isSymbolicLink(), 'the link was not replaced by a written file');

  const fifoDir = await tempDir();
  writeFileSync(join(fifoDir, 'STATUS.md'), TEXT);
  assert.equal(spawnSync('mkfifo', [join(fifoDir, 'spare')]).status, 0, 'mkfifo made the FIFO');
  const viaFifo = inChild(SWAP_AFTER_LSTAT, [fifoDir, join(fifoDir, 'spare'), STATUS_URL]);
  assert.deepEqual([viaFifo.swapped, viaFifo.code], [true, 1], viaFifo.message);
  assert.match(viaFifo.message, /not a regular file/);
});
