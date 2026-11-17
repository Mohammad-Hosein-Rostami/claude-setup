// Tests for home/tools/disk-free/with-run-tmp.mjs: the command runs with TMPDIR (also in the children it spawns) pointing at a
// fresh folder, the folder is removed when the command passes, fails or is signalled, and the exit code goes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './temp-dir-helpers.mjs';

const TOOL = fileURLToPath(new URL('../home/tools/disk-free/with-run-tmp.mjs', import.meta.url));
const PRINT_TMPDIR = 'console.log(require("node:os").tmpdir())';

function wrapper(args, parentTmp) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: parentTmp } });
}

test('the command sees a fresh TMPDIR inside the parent temp folder, and the folder is gone afterwards', () => {
  const parent = makeTempDir('wrt-parent-');
  const run = wrapper(['--', process.execPath, '-e', PRINT_TMPDIR], parent);
  const seen = run.stdout.trim();
  assert.equal(run.status, 0, run.stderr);
  assert.ok(seen.startsWith(join(parent, 'cs-run-')), `TMPDIR seen by the command: ${seen}`);
  assert.deepEqual(readdirSync(parent), []);
});

test('a grandchild process inherits the same TMPDIR', () => {
  const parent = makeTempDir('wrt-parent-');
  const inner = `require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(PRINT_TMPDIR)}], { stdio: "inherit" })`;
  const run = wrapper(['--', process.execPath, '-e', inner], parent);
  assert.match(run.stdout.trim(), /cs-run-/);
});

test('a failing command keeps its exit code and its folder is removed too', () => {
  const parent = makeTempDir('wrt-parent-');
  const run = wrapper(['--', process.execPath, '-e', 'require("node:fs").writeFileSync(process.env.TMPDIR + "/x", "1"); process.exit(3)'], parent);
  assert.equal(run.status, 3);
  assert.deepEqual(readdirSync(parent), []);
});

test('--shell runs the words through the shell with the same TMPDIR', () => {
  const parent = makeTempDir('wrt-parent-');
  const run = wrapper(['--shell', '--', 'echo "$TMPDIR" && exit 4'], parent);
  assert.equal(run.status, 4);
  assert.match(run.stdout, /cs-run-/);
  assert.deepEqual(readdirSync(parent), []);
});

test('a command that does not exist exits 2 and leaves no folder', () => {
  const parent = makeTempDir('wrt-parent-');
  const run = wrapper(['--', 'no-such-command-for-with-run-tmp'], parent);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /could not run/);
  assert.deepEqual(readdirSync(parent), []);
});

test('no command is a usage error', () => {
  assert.equal(wrapper([], makeTempDir('wrt-parent-')).status, 2);
  assert.equal(wrapper(['--'], makeTempDir('wrt-parent-')).status, 2);
});

test('SIGTERM to the wrapper reaches the command and the folder is still removed', async () => {
  const parent = makeTempDir('wrt-parent-');
  const marker = join(parent, 'started');
  const sleeper = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); setTimeout(() => {}, 60000)`;
  const child = spawn(process.execPath, [TOOL, '--', process.execPath, '-e', sleeper], { env: { ...process.env, TMPDIR: parent }, stdio: 'ignore' });
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(marker), 'the command never started');
  child.kill('SIGTERM');
  const { code } = await closed;
  assert.equal(code, 128 + 15);
  assert.deepEqual(readdirSync(parent), ['started']);
});
