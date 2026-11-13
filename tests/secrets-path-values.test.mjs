// A secret-named variable that holds a path or a regex is not a literal secret (seen live: STATE_KEY=/state|hover|focus/ asked for 3 minutes),
// but a bare leading "/" is not enough: about 1 in 64 base64 keys starts with one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralSecret, literalSecretValues, maskSecrets } from '../home/hooks/lib/secrets.mjs';

const LITERAL = ['abc123', 'def456', 'ghi789'].join('');
const BASE64ISH = ['/aB3xK9', 'qZ7mP2', 'wL5nR8'].join('');

test('a value that looks like a path or a regex, quoted or not, is not a literal secret', () => {
  for (const command of [
    'STATE_KEY=/state|hover|focus/ ls', 'const STATE_KEY=/state|hover|focus/i;', 'STATE_KEY="/state|hover" ls', 'KEY_PATH=/Users/x/k.pem ./run', "KEY_PATH='/home/x/k.pem' ./run", 'TOKEN_FILE=/tmp/t cat',
    'KEY_PATH=~/x/key.pem ./run', 'TOKEN_FILE=./t cat', 'SECRET_DIR=../s ls', "TOKEN_FILE='./t' cat", 'SECRET_FILE=/etc/s ls', 'KEY_FILE=/Volumes/d/k ls',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.deepEqual(literalSecretValues(command), [], command);
    assert.equal(maskSecrets(command), command, command);
  }
});

test('a literal that merely starts with "/" is still a secret (base64 keys)', () => {
  for (const command of [`API_KEY=${BASE64ISH} ./run`, `JWT_SECRET="${BASE64ISH}" ./run`, `DB_PASSWORD='${BASE64ISH}' ./run`, `export SESSION_SECRET=${BASE64ISH}`, `API_KEY=/${BASE64ISH} ./run`,
    `echo API_KEY=${BASE64ISH}|tee -a .env`, `API_KEY=${BASE64ISH}|cat`]) {
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

// seen live (Playwright test): URL-query rule flagged code and mock placeholders
const RANDOM_TOKEN = ['aB3xK9qZ7m', 'P2wL5nR8vT', '4yU6'].join('');

test('a URL query value that is code or a kebab-case mock word is not a literal secret', () => {
  for (const command of [
    'page.goto(base+"/reset?token="+token)', 'x=`${base}/r?token=`}', 'f("/r?token=")', 'goto("/verify?token=verify-ok")', 'goto("/r?token=reset-ok")',
    'curl "https://x.example/?token=${TOKEN}"', 'curl "https://x.example/?token=$TOKEN"',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
  }
});

test('a URL query value that is a random token or key is still a secret', () => {
  for (const command of [`curl "https://x.example/r?token=${RANDOM_TOKEN}"`, `curl "https://x.example/v1?api_key=sk-${RANDOM_TOKEN}"`,
    'curl "https://x.example/r?token=this-is-a-much-too-long-kebab-word"']) {
    assert.ok(findLiteralSecret(command), command);
  }
});

test('a header-looking format placeholder in program text is not a credential header value', () => {
  for (const command of [
    `cat > a_test.go <<'EOF'\n\tt.Errorf("explicit choice must replace the old cookie: %+v", c)\nEOF`,
    'echo "cookie: %v"', 'echo "Cookie: %s"', "echo 'cookie: %#v'", 'echo "Cookie: %5.2f"', 'echo "Cookie: %q"', 'echo "cookie: %T"',
    'echo "Cookie: %(name)s"', 'echo "Cookie: {}"', 'echo "Cookie: {0}"', 'echo "Cookie: {name}"', 'echo "X-Api-Key: %s"',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.deepEqual(literalSecretValues(command), [], command);
  }
});

test('a real header value, or a placeholder glued to more text, still asks', () => {
  for (const command of [
    `curl -H "Cookie: session=${LITERAL}" x`, `curl -H "Authorization: Bearer ${['eyJhbGci', 'OiJIUzI1'].join('')}.${LITERAL}" x`, `curl -H "X-Api-Key: ${BASE64ISH.slice(1)}" x`,
    'echo "cookie: %s3cr3tvalue"', 'echo "cookie: %vtoken123"', 'echo "Cookie: {}abc123"',
  ]) assert.ok(findLiteralSecret(command), command);
});
