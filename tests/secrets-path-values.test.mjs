// A secret-named variable that holds a path or a regex is not a literal secret (seen live: STATE_KEY=/state|hover|focus/ asked for 3 minutes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralSecret, literalSecretValues, maskSecrets } from '../home/hooks/lib/secrets.mjs';

const LITERAL = ['abc123', 'def456', 'ghi789'].join('');

test('a value that starts like a path, quoted or not, is not a literal secret', () => {
  for (const command of ['STATE_KEY=/state|hover|focus/ ls', 'KEY_PATH=~/x/key.pem ./run', 'TOKEN_FILE=./t cat', 'SECRET_DIR=../s ls', 'STATE_KEY="/state|hover" ls', "TOKEN_FILE='./t' cat"]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.deepEqual(literalSecretValues(command), [], command);
    assert.equal(maskSecrets(command), command, command);
  }
});

test('a quoted or plain literal is still a secret', () => {
  for (const command of [`API_KEY='${LITERAL}' ./run`, `API_KEY=${LITERAL} ./run`, `API_KEY=a/${LITERAL} ./run`]) {
    assert.ok(findLiteralSecret(command), command);
    assert.ok(!maskSecrets(command).includes(LITERAL), command);
  }
});
