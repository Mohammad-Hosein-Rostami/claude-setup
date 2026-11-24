// Tests for literalSecretValues (lib/secrets.mjs) and what is left of lib/allowed-literals.mjs (its folder, kept so the guard still
// protects old store files: lib/guard-state-write.mjs).
// Values are built from parts so this file never holds a string that looks like a real credential.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedLiteralsDir, MIN_VALUE_LENGTH } from '../home/hooks/lib/allowed-literals.mjs';
import { literalSecretValues } from '../home/hooks/lib/secrets.mjs';

const GENERIC = ['abc123', 'def456', 'ghi789'].join('');
const ANTHROPIC = ['sk', 'ant', 'api03', 'Zx9Qw', '3Er5T', 'y7Ui1'].join('-');

test('literalSecretValues: the literal value of each rule, quotes stripped', () => {
  assert.ok(literalSecretValues(`KEY='${GENERIC}' ls`).includes(GENERIC));
  assert.deepEqual(literalSecretValues('PGPASSWORD=x psql -h db'), ['x']);
  assert.ok(literalSecretValues(`echo ${ANTHROPIC}`).includes(ANTHROPIC));
  assert.ok(literalSecretValues('curl -H "Authorization: Bearer t0k" https://example.com').includes('t0k'));
});

test('literalSecretValues: variables, substitutions and program code are not values', () => {
  assert.deepEqual(literalSecretValues('KEY=$SOME_VAR ls'), []);
  assert.deepEqual(literalSecretValues('curl -H "Authorization: Bearer $TOKEN" https://example.com'), []);
  assert.deepEqual(literalSecretValues('node -e "const token=fs.readFileSync(p)"'), []);
  assert.deepEqual(literalSecretValues('ls -la'), []);
});

test('literalSecretValues: a value is the whole shell word, so text glued onto a quoted value is part of it', () => {
  assert.deepEqual(literalSecretValues("KEY='known-value-1'TAIL98 ls"), ['known-value-1TAIL98']);
  assert.deepEqual(literalSecretValues('KEY="known-value-1" ls'), ['known-value-1']);
});

test('allowedLiteralsDir: the old store folder under HOME, else USERPROFILE', () => {
  assert.equal(allowedLiteralsDir({ HOME: '/h' }), join('/h', '.claude', 'state', 'guard-allowed'));
  assert.equal(allowedLiteralsDir({ USERPROFILE: '/u' }), join('/u', '.claude', 'state', 'guard-allowed'));
  assert.equal(MIN_VALUE_LENGTH, 8);
});
