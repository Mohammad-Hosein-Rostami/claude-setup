// Round 4 replay of the secret dialogs and bounces (kinds and value classes only, never values): two value classes were not secrets at all.
//  1. "bearer" written in lowercase prose followed by a short lowercase word ("a bearer token is ...", "bearer but ...", seen 15 times in
//     heredoc text of docs and commit notes). An HTTP header is still caught by its own rule, and a real token has digits, capitals or length.
//  2. A kebab-case mock word in a URL query inside a JS template literal, closed by a backtick or followed by `${...}`
//     (`/reset?token=verify-ok`, `?token=verify-${id}`): the same mock word that is already exempt between quotes.
// Each exemption has a twin that is still a secret. Values here are built from pieces so no test line is itself a token.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralSecret } from '../home/hooks/lib/secrets.mjs';

const BEARER = ['bear', 'er'].join(''); // keeps this file clear of the guard's own scan
const RANDOM_TOKEN = ['aB3xK9qZ7m', 'P2wL5nR8vT', '4yU6'].join('');

test('lowercase "bearer" followed by a short lowercase word is prose, not a token', () => {
  for (const command of [
    `cat > notes.md <<EOF\nthe ${BEARER} is sent in a header\nEOF`,
    `echo "a ${BEARER} but not a cookie"`,
    `printf '%s' "${BEARER} and basic auth"`,
    `git commit -m "${BEARER} on every request"`,
  ]) assert.equal(findLiteralSecret(command), undefined, command);
});

test('twin: a real bearer value, a header, a capitalised scheme or a longer word is still a secret', () => {
  for (const command of [
    `curl -H "Authorization: ${BEARER} is" https://x.test`, // the header rule has its own kind
    `echo "Bearer ${RANDOM_TOKEN}"`,
    `echo "${BEARER} ${RANDOM_TOKEN}"`,
    `echo "${BEARER} abc123"`, // digits: not a plain word
    `echo "${BEARER} abcdefghijklmnop"`, // 16 letters: longer than a prose word
    `echo "${BEARER} Token"`, // a capital: not a plain word
    `echo "Bearer is"`, // the capitalised scheme is what a header uses
    `echo "${BEARER} a-b"`,
  ]) assert.ok(findLiteralSecret(command), command);
});

test('twin: a short lowercase head glued to the rest of a token by / + . ~ : is still a secret', () => {
  const doppler = ['dp', 'st', 'prd', 'Zq8Lw2Nf7Kp3Xr5Tb9Mh4Vc6Jd1Gs0Ya2Ue8'].join('.');
  const mapbox = ['sk', 'eyJ1IjoiYWJjZGVmIiwiYSI6ImNsMTIzNDU2Nzg5MCJ9', 'Xr5Tb9Mh4Vc6Jd1Gs0Ya2U'].join('.');
  for (const glue of ['/', '+', '~', ':']) {
    assert.ok(findLiteralSecret(`echo "${BEARER} abcdef${glue}${RANDOM_TOKEN}"`), `glued by ${glue}`);
  }
  for (const value of [doppler, mapbox]) {
    assert.ok(findLiteralSecret(`AUTH="${BEARER} ${value}" ./client.sh`), 'a variable outside an Authorization header');
  }
});

test('a kebab-case mock word closed by a backtick or followed by ${...} is not a literal secret', () => {
  for (const command of [
    'cat > t.js <<EOF\nawait page.goto(`/reset?token=verify-ok`);\nEOF',
    'cat > t.js <<EOF\nconst u = `/reset?token=verify-ok`.replace(a, b);\nEOF',
    'cat > t.js <<EOF\nawait goto(`/reset?token=verify-ok`, { x: 1 });\nEOF',
    'cat > t.js <<EOF\nawait page.goto(`/verify?token=mock-token-${id}`);\nEOF',
  ]) assert.equal(findLiteralSecret(command), undefined, command);
});

test('twin: the same shapes with a real-looking token, a capital or no hyphen are still secrets', () => {
  for (const command of [
    `cat > t.js <<EOF\nawait page.goto(\`/reset?token=${RANDOM_TOKEN}\`);\nEOF`,
    'cat > t.js <<EOF\nawait page.goto(`/reset?token=Verify-ok`);\nEOF',
    'cat > t.js <<EOF\nawait page.goto(`/reset?token=verifyokverifyok`);\nEOF',
    `cat > t.js <<EOF\nawait page.goto(\`/reset?token=verify-ok-${RANDOM_TOKEN}\`);\nEOF`,
    `cat > t.js <<EOF\nawait page.goto(\`/reset?token=verify-ok${RANDOM_TOKEN}\`);\nEOF`, // a token glued to the mock word
    `cat > t.js <<EOF\nawait goto(\`/r?token=verify-ok-\${id}${RANDOM_TOKEN}\`);\nEOF`, // a token glued after the ${...}
    `cat > t.js <<EOF\nawait goto(\`/r?token=verify-ok\`.${RANDOM_TOKEN});\nEOF`, // a token after the closing backtick, not a method call
  ]) assert.ok(findLiteralSecret(command), command);
});
