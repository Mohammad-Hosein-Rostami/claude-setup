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

// Audit 5ec0929 / 1f4125e: the query and header exemptions must not let a real token through (probes built at runtime).
const url = (query) => `curl "https://x.example/r?${query}"`;

test('a kebab mock word must end the query value: punctuation or glued quotes after it still ask (Q1)', () => {
  const glue = ['.', '/', '+', '%2B', ':', '=', '~', '@', ',', '\\', '!', '*'];
  for (const command of [...glue.map((sep) => url(`token=abc-def${sep}${RANDOM_TOKEN}`)), url(`token=live-key.${RANDOM_TOKEN}`),
    `page.goto("/r?token=a-b'${RANDOM_TOKEN}'")`]) assert.ok(findLiteralSecret(command), command);
});

test('a capitalised kebab value is not a mock word (Q2)', () => {
  for (const command of [url('token=Xk-Qp-Zr-Wm-Lt-Vn-Ha-Ub'), url('secret=Correct-Horse-Battery'), url('api_key=Verify-Ok')]) assert.ok(findLiteralSecret(command), command);
});

test('password and secret query keys get no mock-word exemption (Q3)', () => {
  for (const command of [url('password=purple-monkey-dishwasher'), url('passwd=verify-ok'), url('secret=reset-ok'), url('client_secret=reset-ok'), url('pwd=verify-ok')]) {
    assert.ok(findLiteralSecret(command), command);
  }
});

test('a quoted literal after the "+" of a concatenation is a literal value (Q4)', () => {
  for (const command of [`page.goto(base+"/reset?token="+"${RANDOM_TOKEN}")`, `fetch(base+"/r?token="+'${RANDOM_TOKEN}')`]) assert.ok(findLiteralSecret(command), command);
});

test('a literal default inside a ${...} expansion is a literal value (P1)', () => {
  for (const command of [url(`token=\${T:-${RANDOM_TOKEN}}`), url(`token=\${T:=${RANDOM_TOKEN}}`), url(`token=\${T-${RANDOM_TOKEN}}`)]) assert.ok(findLiteralSecret(command), command);
});

test('lowercase mock words, code and references in a token query stay silent', () => {
  for (const command of [url('token=verify-ok'), url('TOKEN=verify-ok'), url('access_token=reset-ok&x=1'), "goto('/r?token=reset-ok')", url('token=${T}'), url('token=${T:-}'),
    url('token=$(cat f)'), 'page.goto(base+"/reset?token="+token)', 'page.goto(`${base}/reset?token=`+token)', 'x=`${base}/r?token=${token}`']) {
    assert.equal(findLiteralSecret(command), undefined, command);
  }
});

test('braces or %(...)s around a real token are not a placeholder (H1)', () => {
  const spec = RANDOM_TOKEN.slice(0, 20);
  for (const command of [`curl -H "Authorization: {${RANDOM_TOKEN}}" x`, `curl -H "X-Api-Key: {${RANDOM_TOKEN}}" x`, `curl -H 'Cookie: {${RANDOM_TOKEN}}' x`,
    `curl -H "X-Api-Key: %(${RANDOM_TOKEN})s" x`, `curl x -H X-Api-Key:{${RANDOM_TOKEN}}`, `curl -H "X-Api-Key: {${RANDOM_TOKEN}:x}" x`,
    `curl -H "X-Api-Key: {k:${spec}}" x`]) assert.ok(findLiteralSecret(command), command);
});

test('a placeholder ends only at the closing quote of the header string (H2)', () => {
  for (const command of [`curl -H "X-Api-Key: %s'${RANDOM_TOKEN}'" x`, `curl -H "X-Api-Key: %s' ${RANDOM_TOKEN}'" x`, `curl -H 'X-Api-Key: {}"${RANDOM_TOKEN}"' x`]) {
    assert.ok(findLiteralSecret(command), command);
  }
});

test('short lowercase placeholders and format specs stay silent', () => {
  for (const command of ['echo "Cookie: {user_id}"', 'echo "Cookie: {:08.3f}"', 'echo "Cookie: {n:>10}"', 'echo "X-Api-Key: %(key)s"', 'curl -H "X-Api-Key: %s" x', 'echo "Cookie: %5.2f"']) {
    assert.equal(findLiteralSecret(command), undefined, command);
  }
});

// Re-audit a968721: an exemption ends only at a real word boundary, never where text is glued on.
test('text glued after a mock word, its closing quote or a ")" is still a value (N1, N2, N3)', () => {
  const R = RANDOM_TOKEN;
  for (const command of [...['.', '-', '/', ','].map((glue) => `curl "https://x/r?token=abc-def"${glue}${R}`), `curl "https://x/r?token=abc-def)${R}"`,
    `curl "https://x/r?token="}${R}`, `curl "https://x/r?token=")${R}`]) assert.ok(findLiteralSecret(command), command);
});

test('a placeholder glued to quotes after an unrelated quoted header still asks (N4)', () => {
  assert.ok(findLiteralSecret(`curl -H 'A: b' -H X-Api-Key:%s'${RANDOM_TOKEN}'`));
});

test('mock words and code closed by a real boundary stay silent', () => {
  for (const command of ['goto("/r?token=reset-ok", x)', 'f(g("/r?token=verify-ok"))', 'f("/r?token=verify-ok");', 'goto("/r?token=reset-ok" )', 'x=`${base}/r?token=`})',
    'goto("/r?token=reset-ok"+suffix)', 'h(base+"/r?token=")', 'echo "X-Api-Key: %s"', "curl -H 'A: b' -H 'X-Api-Key: %s' x"]) {
    assert.equal(findLiteralSecret(command), undefined, command);
  }
});

// Desap Go test table: 1-2 char query values (`token=t`, `ticket=t1`) are fixtures, not secrets; the minimum is the allow-list's own.
test('a URL query value shorter than the minimum is not a literal secret, one of that length still asks', () => {
  for (const command of ['{path: "/verify-email?token=t", want: 200},', 'appLogoutQuery + "&ticket=t1"', url('token=abcdefg'), url('password=t1'), '{path: "/r?api_key=k1", x}']) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.deepEqual(literalSecretValues(command), [], command);
  }
  for (const command of [url('token=aB3xK9qZ'), url('password=aB3xK9qZ')]) assert.ok(findLiteralSecret(command), command);
});

// Desap: a Go html/template attribute in a python heredoc fired the key=value rule (`data-title-password=\"{{t .L \"...\"}}\"`).
test('a template expression that reads a value is not a literal secret', () => {
  for (const command of [
    'data-title-password=\\"{{t .L \\"register.password.heading\\"}}\\"', 'data-msg-short=\\"{{t .L \\"register.validation.password_short\\"}}\\"',
    'password="{{ .Password }}"', 'password={{.Form.Password}}', 'api_token="{{ user.password }}"', 'secret={{ pw | e }}', 'token={%- .Token %}',
    "password='{{ .Password }}' ./run", 'DB_PASS=<%= ENV.pass %>',
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.deepEqual(literalSecretValues(command), [], command);
  }
});

test('a token inside template braces is still a secret', () => {
  const R = RANDOM_TOKEN;
  for (const command of [`password=\\"{{${R}}}\\"`, `token={{${R}}}`, `password="{{ \\"${R}\\" }}"`, `password={{ ${R} }}`, `token={{ .x }}${R}`, `API_KEY={{${R}.x`]) {
    assert.ok(findLiteralSecret(command), command);
  }
});
