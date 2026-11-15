// Tests for the third security audit (LOW findings R3-1, R3-2, R3-3): a backslash before a quote makes an env file irregular,
// env and scanned files are read through one opened descriptor (no symlink, no FIFO hang, no swap between check and read),
// and the deploy YAML reader prints nothing from a quoted key's value, a value on the next line or a multi-line flow map.
// Marker words start with "zqx" (made up, any case); no real env file is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { link, readFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDeploy } from '../home/tools/env-names/lib/deploy-names.mjs';
import { isRegularEnvText, readEnvFile } from '../home/tools/env-names/lib/env-file-names.mjs';
import { readRegularFile } from '../home/tools/env-names/lib/read-regular-file.mjs';
import { everythingPrinted, makeProject } from './env-names-fixtures.mjs';

const lines = (...parts) => `${parts.join('\n')}\n`;
const names = (kind, text) => scanDeploy(kind, text).mentions.map((mention) => mention.name);
const compose = (...entries) => `services:\n  a:\n    environment:\n${entries.map((entry) => `      ${entry}`).join('\n')}\n`;
const onlyPosix = { skip: process.platform === 'win32' ? 'no FIFO, symlink flags or mkfifo on Windows' : false };
const MAX_BYTES = 1024;
const FLIP_MILLISECONDS = 1500;
const READ_TIMEOUT_MILLISECONDS = 15000;

// R3-1: dotenv reads `\"` as an escaped quote, so a value such as "C:\\logs\\" is unclosed for it and later lines are value text.
const WINDOWS_PATH_THEN_QUOTE = lines('LOG_DIR="C:\\\\logs\\\\"', 'zqxinsidevalue=1', 'ZQXALSOINSIDE=2', 'zqxclosing=say \\"hi"');

test('R3-1: a backslash directly before a quote makes the file irregular, for each quote character', () => {
  for (const quote of ['"', "'", '`']) {
    assert.equal(isRegularEnvText(`A=${quote}C:\\\\logs\\\\${quote}\nB=1\n`), false, quote);
    assert.equal(isRegularEnvText(`A=say \\${quote}hi\n`), false, quote);
  }
  assert.equal(isRegularEnvText('A="C:\\logs"\nB=a\\b\n'), true, 'a backslash that is not before a quote keeps the file regular');
});

test('R3-1: no word from inside the dotenv value is printed in any mode (text, --json, snapshot, diff)', async () => {
  const { text } = await everythingPrinted({ '.env': WINDOWS_PATH_THEN_QUOTE });
  assert.doesNotMatch(text, /zqx/i);
  assert.match(text, /irregular/);
});

// R3-2: one descriptor opened with O_NOFOLLOW | O_NONBLOCK, then fstat and read from that descriptor.
test('R3-2: readRegularFile returns the bytes of a regular file and says why it did not read the others', onlyPosix, async () => {
  const dir = await makeProject({ 'plain.txt': 'abc', 'big.txt': 'x'.repeat(MAX_BYTES + 1) });
  await symlink(join(dir, 'plain.txt'), join(dir, 'link.txt'));
  assert.equal(readRegularFile(join(dir, 'plain.txt'), MAX_BYTES).bytes.toString(), 'abc');
  assert.deepEqual(readRegularFile(join(dir, 'link.txt'), MAX_BYTES), { skipped: 'link' });
  assert.deepEqual(readRegularFile(dir, MAX_BYTES), { skipped: 'not a regular file' });
  assert.deepEqual(readRegularFile(join(dir, 'big.txt'), MAX_BYTES), { skipped: 'too large' });
});

const READER_URL = new URL('../home/tools/env-names/lib/env-file-names.mjs', import.meta.url).href;

test('R3-2: a symlinked env file is skipped and a FIFO in place of an env file does not hang the scan', onlyPosix, async () => {
  const dir = await makeProject({ 'target.txt': 'ZQXOUTSIDENAME=1\n' });
  await symlink(join(dir, 'target.txt'), join(dir, '.env'));
  assert.deepEqual(readEnvFile(join(dir, '.env')), { names: [], otherLines: 0, status: 'link, not read' });
  spawnSync('mkfifo', [join(dir, 'fifo.env')]);
  // A child process with a timeout: if the open blocks, the test fails instead of hanging the suite.
  const scan = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readEnvFile } from ${JSON.stringify(READER_URL)};
    console.log(JSON.stringify(readEnvFile(process.argv[1])));
  `, join(dir, 'fifo.env')], { encoding: 'utf8', timeout: READ_TIMEOUT_MILLISECONDS });
  assert.equal(scan.error, undefined, 'the read must not block');
  assert.deepEqual(JSON.parse(scan.stdout), { names: [], otherLines: 0, status: 'not a regular file, not read' });
});

/** A child that swaps `.env` between a regular file, a hard link to a FIFO and a symlink to a file outside the tree, as fast as it can. */
function startFlipper(dir) {
  const source = `
    const { linkSync, renameSync, symlinkSync, unlinkSync } = require('node:fs');
    const { join } = require('node:path');
    const dir = process.argv[1];
    const targets = [() => linkSync(join(dir, 'real.env'), join(dir, 'swap')), () => linkSync(join(dir, 'fifo'), join(dir, 'swap')), () => symlinkSync(join(dir, 'outside.txt'), join(dir, 'swap'))];
    for (let i = 0; ; i += 1) { try { targets[i % targets.length](); renameSync(join(dir, 'swap'), join(dir, '.env')); } catch { try { unlinkSync(join(dir, 'swap')); } catch {} } }
  `;
  return spawn(process.execPath, ['-e', source, dir], { stdio: 'ignore' });
}

test('R3-2: a file swapped for a FIFO or a symlink while the scan runs neither hangs it nor shows a name from outside', onlyPosix, async () => {
  const dir = await makeProject({ 'real.env': 'ZQXREALNAME=1\n', 'outside.txt': 'ZQXOUTSIDENAME=1\n' });
  spawnSync('mkfifo', [join(dir, 'fifo')]);
  await link(join(dir, 'real.env'), join(dir, '.env')).catch(() => rename(join(dir, 'real.env'), join(dir, '.env')));
  const flipper = startFlipper(dir);
  const reader = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { readEnvFile } from ${JSON.stringify(READER_URL)};
    const seen = new Set();
    for (const end = Date.now() + ${FLIP_MILLISECONDS}; Date.now() < end;) for (const name of readEnvFile(process.argv[1]).names) seen.add(name);
    console.log(JSON.stringify([...seen]));
  `, join(dir, '.env')], { encoding: 'utf8', timeout: READ_TIMEOUT_MILLISECONDS });
  flipper.kill('SIGKILL');
  assert.equal(reader.error, undefined, 'the read hung or failed');
  assert.ok(!JSON.parse(reader.stdout).includes('ZQXOUTSIDENAME'), 'a name from outside the tree was read');
});

test('R3-2: the scanned-file reader in collect.mjs goes through readRegularFile', async () => {
  const collect = await readFile(fileURLToPath(new URL('../home/tools/env-names/lib/collect.mjs', import.meta.url)), 'utf8');
  assert.match(collect, /readRegularFile\(/);
  assert.doesNotMatch(collect, /statSync|readFileSync/);
});

// R3-3: a value is not a key position: a quoted key's value, a value on the next line and a flow map that goes on over lines.
test('R3-3: a quoted key with a multi-line value gives its own name and none from the value', () => {
  assert.deepEqual(names('compose', compose('"QUOTED_KEY": "line one', 'zqxquotedkey: v', 'end"', 'AFTER: 1')), ['QUOTED_KEY', 'AFTER']);
  assert.deepEqual(names('compose', compose("'SINGLE_KEY': 'line one", 'zqxsinglekey: v', "end'", 'AFTER: 1')), ['SINGLE_KEY', 'AFTER']);
  assert.deepEqual(names('gitlab', 'variables:\n  "QK": "start\n  zqxglquoted: v\n  end"\n  AFTER: 1\n'), ['QK', 'AFTER']);
});

test('R3-3: a quoted value that starts on the line after its key is skipped to its closing quote', () => {
  assert.deepEqual(names('compose', compose('KEY:', '  "multi', 'zqxnextline: v', '  end"', 'AFTER: 1')), ['KEY', 'AFTER']);
  assert.deepEqual(names('workflow', 'on: push\njobs:\n  a:\n    env:\n      KEY:\n        \'multi\n      zqxwfnext: v\n        end\'\n      AFTER: 1\n'), ['KEY', 'AFTER']);
});

test('R3-3: a flow map or list that goes on over lines gives no name from the lines inside it', () => {
  assert.deepEqual(names('compose', compose('KEY: {a: 1,', 'zqxflowkey: 2}', 'AFTER: 1')), ['KEY', 'AFTER']);
  assert.deepEqual(names('compose', compose('KEY: [a,', 'zqxflowseq: 2]', 'AFTER: 1')), ['KEY', 'AFTER']);
  assert.deepEqual(names('compose', compose('KEY: {a: {b: 1,', 'zqxnested: 2},', 'zqxsecond: 3}', 'AFTER: 1')), ['KEY', 'AFTER']);
  assert.deepEqual(names('compose', compose('KEY: {a: "x,', 'zqxinquote: y",', 'b: 1}', 'AFTER: 1')), ['KEY', 'AFTER']);
});

test('R3-3: values that close on their own line, or are plain text, still let the next key through', () => {
  assert.deepEqual(names('compose', compose('A: {x: 1}', 'B: [1, 2]', 'C: "done"', "D: 'it''s'", 'E: it\'s plain', 'F: 1')), ['A', 'B', 'C', 'D', 'E', 'F']);
});
