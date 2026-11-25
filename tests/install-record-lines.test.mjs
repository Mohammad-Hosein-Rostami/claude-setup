// Tests for remember() in scripts/install/record.mjs: a `line` entry is keyed by path and text, so one file holds several of the
// installer's lines (the claude-as line and the rm-waiver lines), and a repeat of an entry is kept once.
// Exports: none (node:test file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { remember } from '../scripts/install/record.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const FIRST_LINE = '# why the first line is here';
const SECOND_LINE = 'export SOME_SETTING=1';
const newRecord = () => ({ made: [], backups: [] });
const rcFile = () => join(makeTempDir('record-lines-'), '.zshenv');

test('two line entries for one path are both kept', () => {
  const record = newRecord();
  const path = rcFile();
  remember(record, { kind: 'line', path, line: FIRST_LINE });
  remember(record, { kind: 'line', path, line: SECOND_LINE });
  assert.deepEqual(
    record.made.map((made) => made.line),
    [FIRST_LINE, SECOND_LINE],
  );
});

test('the same line entry twice is kept once, and the later fields win', () => {
  const record = newRecord();
  const path = rcFile();
  remember(record, { kind: 'line', path, line: FIRST_LINE });
  remember(record, { kind: 'line', path, line: FIRST_LINE, createdFile: true });
  assert.equal(record.made.length, 1);
  assert.equal(record.made[0].createdFile, true);
});

test('the same line text in two files is two entries', () => {
  const record = newRecord();
  remember(record, { kind: 'line', path: rcFile(), line: FIRST_LINE });
  remember(record, { kind: 'line', path: rcFile(), line: FIRST_LINE });
  assert.equal(record.made.length, 2);
});

test('a non-line entry for the same kind and path replaces the earlier one', () => {
  const record = newRecord();
  const path = rcFile();
  remember(record, { kind: 'link', path, target: 'old' });
  remember(record, { kind: 'link', path, target: 'new' });
  assert.deepEqual(record.made, [{ kind: 'link', path, target: 'new' }]);
});
