// A secret-named variable that holds a path or a regex is not a literal secret (seen live: STATE_KEY=/state|hover|focus/ asked for 3 minutes),
// but a bare leading "/" is not enough: about 1 in 64 base64 keys starts with one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralSecret, literalSecretValues, maskSecrets } from '../home/hooks/lib/secrets.mjs';

const LITERAL = ['abc123', 'def456', 'ghi789'].join('');
const BASE64ISH = ['/aB3xK9', 'qZ7mP2', 'wL5nR8'].join('');

test('a value that looks like a path or a regex, quoted or not, is not a literal secret', () => {
  for (const command of [
    'STATE_KEY=/state|hover|focus/ ls', 'STATE_KEY="/state|hover" ls', 'KEY_PATH=/Users/x/k.pem ./run', "KEY_PATH='/home/x/k.pem' ./run", 'TOKEN_FILE=/tmp/t cat',
    'KEY_PATH=~/x/key.pem ./run', 'TOKEN_FILE=./t cat', 'SECRET_DIR=../s ls', "TOKEN_FILE='./t' cat", 'SECRET_FILE=/etc/s ls', 'KEY_FILE=/Volumes/d/k ls',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.deepEqual(literalSecretValues(command), [], command);
    assert.equal(maskSecrets(command), command, command);
  }
});

test('a literal that merely starts with "/" is still a secret (base64 keys)', () => {
  for (const command of [`API_KEY=${BASE64ISH} ./run`, `JWT_SECRET="${BASE64ISH}" ./run`, `DB_PASSWORD='${BASE64ISH}' ./run`, `export SESSION_SECRET=${BASE64ISH}`, `API_KEY=/${BASE64ISH} ./run`]) {
    assert.ok(findLiteralSecret(command), command);
    assert.ok(!maskSecrets(command).includes(BASE64ISH), command);
  }
});

test('a quoted or plain literal is still a secret', () => {
  for (const command of [`API_KEY='${LITERAL}' ./run`, `API_KEY=${LITERAL} ./run`, `API_KEY=a/${LITERAL} ./run`]) {
    assert.ok(findLiteralSecret(command), command);
    assert.ok(!maskSecrets(command).includes(LITERAL), command);
  }
});
