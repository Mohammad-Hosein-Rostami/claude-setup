// Tests for home/tools/env-names/lib/env-file-names.mjs: the only code that sees env file content. It must return names
// and a count of other lines, and never a value. Plants marker values in every place a value can sit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { namesFromEnvText, readEnvFile } from '../home/tools/env-names/lib/env-file-names.mjs';
import { leaked, makeProject } from './env-names-fixtures.mjs';

test('names are sorted and unique; comments and blank lines are skipped', () => {
  const result = namesFromEnvText('B=1\n# C=MARKER_COMMENT\n\nA=2\nB=3\n');
  assert.deepEqual(result, { names: ['A', 'B'], otherLines: 0 });
});

test('export prefix, spaces around the equals sign and empty values give the name only', () => {
  const result = namesFromEnvText('export A=MARKER_VALUE\nB = MARKER_VALUE\nexport  C   =\nD=\n');
  assert.deepEqual(result.names, ['A', 'B', 'C', 'D']);
  assert.deepEqual(leaked(JSON.stringify(result)), []);
});

test('a value containing = and a comment after a value never leak', () => {
  const result = namesFromEnvText('URL=https://x/?a=MARKER_VALUE&b=2 # MARKER_COMMENT\nPASS_WORD=MARKER_VALUE==\n');
  assert.deepEqual(result, { names: ['PASS_WORD', 'URL'], otherLines: 0 });
});

test('a quoted multi-line value creates no fake name; its lines are counted, not parsed', () => {
  const text = 'KEY="-----BEGIN MARKER_PART-----\nMARKERVALUE+abc/def==\nFAKE_NAME=MARKER_PART\n-----END-----"\nAFTER=1\n';
  const result = namesFromEnvText(text);
  assert.deepEqual(result.names, ['AFTER', 'KEY']);
  assert.equal(result.otherLines, 3);
});

test('a single-quoted multi-line value and an escaped quote inside double quotes', () => {
  const text = "A='line one MARKER_QUOTED\nSHORT==\n'\nB=\"has \\\" MARKER_QUOTED\nC=x\n\"\nD=1\n";
  const result = namesFromEnvText(text);
  assert.deepEqual(result.names, ['A', 'B', 'D']);
  assert.equal(result.otherLines, 4);
});

test('a closed quote on the same line does not open a block', () => {
  assert.deepEqual(namesFromEnvText('A="MARKER_QUOTED" # MARKER_COMMENT\nB=\'x\'\nC=1\n').names, ['A', 'B', 'C']);
});

test('lines that are not NAME=value are counted, never kept', () => {
  const text = 'just MARKER_PART words\n1ABC=1\nA-B=1\nhas space=1\nhttps://MARKER_PART/?q=1\nexport ONLY\nOK=1\n';
  const result = namesFromEnvText(text);
  assert.deepEqual(result, { names: ['OK'], otherLines: 6 });
});

test('CRLF line ends and a UTF-8 BOM before the first name', () => {
  assert.deepEqual(namesFromEnvText('﻿A=MARKER_VALUE\r\nB=2\r\n').names, ['A', 'B']);
});

test('an empty file has no names and no other lines', () => {
  assert.deepEqual(namesFromEnvText(''), { names: [], otherLines: 0 });
});

test('readEnvFile: a normal file gives names', async () => {
  const dir = await makeProject({ '.env': 'A=MARKER_VALUE\n' });
  assert.deepEqual(readEnvFile(join(dir, '.env')), { names: ['A'], otherLines: 0 });
});

test('readEnvFile: a symlink is listed as link, not read, and its target is not opened', async () => {
  const dir = await makeProject({ 'outside/real.env': 'LEAK=MARKER_VALUE\n', 'app/.keep': '' });
  await symlink(join(dir, 'outside/real.env'), join(dir, 'app/.env'));
  assert.deepEqual(readEnvFile(join(dir, 'app/.env')), { names: [], otherLines: 0, status: 'link, not read' });
});

test('readEnvFile: a binary file named .env is not read and its bytes never appear', async () => {
  const dir = await makeProject({ '.env': Buffer.from([0x41, 0x3d, 0x00, 0xff, 0x4d, 0x41, 0x52, 0x4b, 0x45, 0x52, 0x0a]) });
  assert.deepEqual(readEnvFile(join(dir, '.env')), { names: [], otherLines: 0, status: 'binary, not read' });
});

test('readEnvFile: a 5 MB file is read fully and quickly', async () => {
  const filler = `BIG_VALUE=${'x'.repeat(1000)}\n`.repeat(5000);
  const dir = await makeProject({ '.env': `FIRST=1\n${filler}LAST=MARKER_VALUE\n` });
  const started = Date.now();
  const result = readEnvFile(join(dir, '.env'));
  assert.deepEqual(result.names, ['BIG_VALUE', 'FIRST', 'LAST']);
  assert.ok(Date.now() - started < 3000);
});

test('readEnvFile: a missing file or a folder gives a status with the error code only', async () => {
  const dir = await makeProject({});
  assert.deepEqual(readEnvFile(join(dir, '.env')), { names: [], otherLines: 0, status: 'unreadable (ENOENT), not read' });
  await mkdir(join(dir, 'd.env'));
  assert.deepEqual(readEnvFile(join(dir, 'd.env')), { names: [], otherLines: 0, status: 'unreadable (EISDIR), not read' });
});
