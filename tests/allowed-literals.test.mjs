// Tests for the per-session allow memory: literalSecretValues (lib/secrets.mjs) and lib/allowed-literals.mjs.
// Values are built from parts so this file never holds a string that looks like a real credential.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedLiteralsDir, isRemembered, remember } from '../home/hooks/lib/allowed-literals.mjs';
import { literalSecretValues } from '../home/hooks/lib/secrets.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

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

test('store: values shorter than 8 characters are never stored and never count as remembered', () => {
  const env = homeEnv();
  remember('sess-1', ['short'], env);
  assert.equal(existsSync(allowedLiteralsDir(env)), false);
  remember('sess-1', ['long-enough-value'], env);
  assert.equal(isRemembered('sess-1', ['long-enough-value', 'short'], env), false);
  assert.equal(isRemembered('sess-1', ['long-enough-value'], env), true);
});

const homeEnv =() => ({ HOME: makeTempDir('allowed-home-') });
const fileOf = (env, session) => join(allowedLiteralsDir(env), `${session}.json`);

test('store: remember then isRemembered; an unseen second value, another session or no values is not remembered', () => {
  const env = homeEnv();
  remember('sess-1', ['alpha-value'], env);
  assert.equal(isRemembered('sess-1', ['alpha-value'], env), true);
  assert.equal(isRemembered('sess-1', ['alpha-value', 'beta-value'], env), false);
  assert.equal(isRemembered('sess-2', ['alpha-value'], env), false);
  assert.equal(isRemembered('sess-1', [], env), false);
  remember('sess-1', ['beta-value'], env);
  assert.equal(isRemembered('sess-1', ['alpha-value', 'beta-value'], env), true, 'values accumulate');
});

test('store: a bad session id has no store and makes no file', () => {
  const env = homeEnv();
  for (const bad of [undefined, '', '../evil', 'a/b', 'a b', 'x'.repeat(101), 42]) {
    remember(bad, ['alpha-value'], env);
    assert.equal(isRemembered(bad, ['alpha-value'], env), false, String(bad));
  }
  assert.equal(existsSync(allowedLiteralsDir(env)), false);
});

test('store: file mode 0600, directory 0700, and the file holds the digest, never the raw value', () => {
  const env = homeEnv();
  const value = 'raw-secret-value-12345';
  remember('sess-1', [value], env);
  const path = fileOf(env, 'sess-1');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(allowedLiteralsDir(env)).mode & 0o777, 0o700);
  assert.ok(!readFileSync(path, 'utf8').includes(value));
  assert.deepEqual(readdirSync(allowedLiteralsDir(env)), ['sess-1.json'], 'no temp file is left behind');
});

test('store: a damaged file is not remembered and is replaced by the next write; I/O errors never throw', () => {
  const env = homeEnv();
  remember('sess-1', ['alpha-value'], env);
  writeFileSync(fileOf(env, 'sess-1'), '{not json');
  assert.equal(isRemembered('sess-1', ['alpha-value'], env), false);
  remember('sess-1', ['alpha-value'], env);
  assert.equal(isRemembered('sess-1', ['alpha-value'], env), true);
  const blocked = join(makeTempDir('allowed-file-'), 'a-file');
  writeFileSync(blocked, '');
  assert.doesNotThrow(() => remember('sess-1', ['x'], { HOME: blocked }));
  assert.equal(isRemembered('sess-1', ['x'], { HOME: blocked }), false);
});

test('store: a write prunes session files older than 7 days', () => {
  const env = homeEnv();
  remember('old-session', ['alpha-value'], env);
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(fileOf(env, 'old-session'), eightDaysAgo, eightDaysAgo);
  remember('new-session', ['alpha-value'], env);
  assert.equal(existsSync(fileOf(env, 'old-session')), false);
  assert.equal(existsSync(fileOf(env, 'new-session')), true);
});
