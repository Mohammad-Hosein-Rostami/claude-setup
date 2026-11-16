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

// Audit of db40977: the flag and type exemptions matched a PREFIX of the value (`12 ...`, `12,R`, `undefined=...; session=R`), so these
// secrets, all caught before the exemptions existed, ran without a word and were left unmasked in dialogs and the guard log.
const AUDIT_R = ['Xk9pQ2vL', 'm3Nq8Rt5'].join('');
const PW = ['PASS', 'WORD'].join('');
const PREFIX_SHAPES = [
  `export DB_${PW}="12 correct horse ${AUDIT_R}"`, `export DB_${PW}='42 ${AUDIT_R}'`, `DB_${PW}="true story ${AUDIT_R}" ./run`,
  `DB_${PW}=12,${AUDIT_R} ./run`, `DB_${PW}=true,${AUDIT_R} ./run`, `DB_${PW}=null]${AUDIT_R} ./run`, `DB_${PW}=1}${AUDIT_R} ./run`,
  `DB_${PW}="12",${AUDIT_R} ./run`, `docker run -e DB_${PW}=12,${AUDIT_R} img`, `curl -d "${PW.toLowerCase()}=12 ${AUDIT_R}" https://x.test/login`,
  `API_TOKEN=12,${AUDIT_R} ./run`, `API_KEY="99 ${AUDIT_R}" ./run`,
  `curl -H "Cookie: undefined=undefined; session=${AUDIT_R}" https://x.test`, `curl -H "Cookie: null; sid=${AUDIT_R}" https://x.test`,
  `curl -H "X-Api-Key: string,${AUDIT_R}" https://x.test`, `curl -H 'Authorization: any"${AUDIT_R}' https://x.test`,
];
// two shapes the base did not mask either (the value is cut at the quote or the blank): detection is what the guard acts on
const NOT_MASKED_BY_BASE = new Set([PREFIX_SHAPES[7], PREFIX_SHAPES[9], PREFIX_SHAPES[15]]);

test('a value that only starts with a flag or type word is still a secret, and is masked', () => {
  for (const command of PREFIX_SHAPES) {
    assert.ok(findLiteralSecret(command), command);
    if (!NOT_MASKED_BY_BASE.has(command)) assert.ok(!maskSecrets(command).includes(AUDIT_R), command);
  }
});

test('the whole-value exemptions and the controls hold after the prefix fix', () => {
  for (const command of [`DB_${PW}=1`, `DB_${PW}=true ./run`, '  cookie: string | null;']) assert.equal(findLiteralSecret(command), undefined, command);
  for (const command of [`DB_${PW}=1234`, `key=99abcd${AUDIT_R}`, `DB_${PW}="12"${AUDIT_R}`, `DB_${PW}=trueblue${AUDIT_R}`, `curl -H "X-Api-Key: ${AUDIT_R}" https://x.test`]) {
    assert.ok(findLiteralSecret(command), command);
  }
});
