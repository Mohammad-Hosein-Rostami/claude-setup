// A TypeScript type annotation (`cookie: string`) and a boolean or small-number flag (`passwordReset=1`) are not literal
// secrets (seen live in a PC session: both were bounced). A real value in the same positions still is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralSecret, maskSecrets } from '../home/hooks/lib/secrets.mjs';

const REAL_COOKIE = ['sess', 'ion', '9f8e7d6c'].join('');
const REAL_PASSWORD = ['Tr0ub4dor', 'and', '3'].join('-');

test('a type annotation is not a credential header', () => {
  for (const command of [
    'cookie: string', 'cookie: string;', 'Cookie: number', 'cookie: string | undefined', 'cookie: string | null;', 'interface Req { cookie: string; password: string }',
    'x-api-key: string', 'authorization: string,', 'cookie: string[]', 'cookie: boolean }', 'password: string | null', 'token?: Token',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.equal(maskSecrets(command), command, command);
  }
});

test('a real header value is still a credential', () => {
  for (const command of [`cookie: ${REAL_COOKIE}`, `curl -H "Cookie: ${REAL_COOKIE}" https://x.test`, `cookie: stringy${REAL_COOKIE}`, `x-api-key: string ${REAL_COOKIE}`]) {
    assert.ok(findLiteralSecret(command), command);
    assert.ok(!maskSecrets(command).includes(REAL_COOKIE), command);
  }
});

test('a boolean or small-number flag assigned to a secret-looking name is not a literal secret', () => {
  for (const command of [
    'passwordReset=1', 'password=true', 'password=false', 'PASSWORD_RESET=0 ./run', 'password=null', 'authToken=undefined', 'API_KEY=1 ./run', 'passwordResetCount=12', "password='true'", 'x passwordReset=1; ls',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.equal(maskSecrets(command), command, command);
  }
});

test('a real value after the same names is still a secret', () => {
  for (const command of [`password=${REAL_PASSWORD}`, 'password=123456', 'passwordReset=1abc9xyz', 'password=truest-horse-9', 'API_KEY=12345678 ./run', ['token=nullable', 'secret', '42'].join('-')]) {
    assert.ok(findLiteralSecret(command), command);
  }
});
