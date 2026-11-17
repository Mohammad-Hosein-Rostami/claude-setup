// Two live false positives from an unattended Desap session (each ask stalls up to 2 min), and the probes that must keep asking:
// 1. a BEM modifier / state id glued to a word (`.card--password`, `inv-new-staff--password`) is not a `--password` flag;
// 2. JS code that mentions a token name (`'csrf_token=…').slice(0, 80)`) is not a token value, but a password-kind value keeps the broad rule.
// Every secret-looking value is built at runtime so the repo itself holds no token-shaped string (gitleaks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findLiteralSecret, literalSecretValues, maskSecrets } from '../home/hooks/lib/secrets.mjs';

const R = ['aB3xK9qZ7m', 'P2wL5nR8vT', '4yU6'].join('');
const JWT = [['eyJhbGciOiJIUzI1', 'NiJ9'].join(''), ['eyJzdWIiOiIx', 'In0'].join(''), 'sig'].join('.');
const PASSWORD = ['hunter2', 'xyz'].join('');

const expectSilent = (command) => {
  assert.equal(findLiteralSecret(command), undefined, command);
  assert.deepEqual(literalSecretValues(command), [], command);
  assert.equal(maskSecrets(command), command, command);
};
const expectAsk = (command, secret) => {
  assert.ok(findLiteralSecret(command), command);
  if (secret) assert.ok(!maskSecrets(command).includes(secret), command);
};

test('Desap shapes: a BEM modifier or state id ending in --password, and JS that mentions csrf_token=, are silent', () => {
  for (const command of [
    `python3 - <<'PY'\nimport re\ns = re.sub(".card--password .card__body {", ".card--password .card__body {\\n  gap: 8px;", s)\nPY`,
    'the field inv-new-staff--password (12 px) wraps on a phone',
    "posts.map((p) => (p || '').replace(/csrf_token=[^&]*/, 'csrf_token=…').slice(0, 80))",
    `node -e "console.log(posts.map((p) => (p || '').replace(/csrf_token=[^&]*/, 'csrf_token=…').slice(0, 80)))"`,
  ]) expectSilent(command);
});

test('a flag glued to a word is not a flag; a flag with a punctuation-only value is not a value', () => {
  for (const command of ['grep -n ".card--password {" a.css', 'x.btn--token (a)', 'sel = ".form--api-key .row"', 'tool --password {', 'tool --token (', 'tool --api-key ...']) {
    expectSilent(command);
  }
});

test('real flags still ask, at the start, after whitespace, "(" or a quote', () => {
  for (const command of [`mysql --password ${PASSWORD}`, `cli --token ${R}`, `--api-key=${R}`, `--password=${PASSWORD} x`, `mysql -p'${R}' db`, `tool "--password=${PASSWORD}"`,
    `x $(cli --token ${R})`, `a;cli --token ${R}`, `tool --password '!${PASSWORD}'`, `tool --password {${R}}`]) expectAsk(command);
  for (const command of [`mysql --password ${PASSWORD}`, `cli --token ${R}`, `--api-key=${R}`]) expectAsk(command, command.endsWith(R) ? R : PASSWORD);
});

test('a token or key name whose value is code or text (non-token characters) is not a token', () => {
  for (const command of ["x = 'csrf_token=…'", 'API_KEY=a-b(c)', "'access_token=…').slice(0, 80)", 'TOKEN=…', 'AUTH_TOKEN="ab[0]"', 'const key=…']) expectSilent(command);
});

test('a real token or key still asks, quoted or not, under any token-kind name', () => {
  for (const command of [`API_KEY=${R}`, 'TOKEN="R"'.replace('R', R), `csrf_token=${R}`, `ID_TOKEN=${JWT} x`, `AUTH_TOKEN=${JWT}`, `export API_KEY='${R}'`, `API_KEY=${R}|tee x`, `echo csrf_token=${R};ls`,
    `TOKEN=${R}&x=1`, `API_KEY=/${R}`, `SESSION_KEY=${R}+/=`]) expectAsk(command, R);
  assert.ok(!maskSecrets(`TOKEN=${JWT}`).includes(JWT));
});

test('a password- or secret-kind name keeps the broad rule: punctuation, parentheses and spaces in the value still ask', () => {
  for (const command of ["PASSWORD='p(a)ss w0rd!'", 'DB_PASS="p(a)ss"', 'PASSWD=a-b(c)1234', 'MY_SECRET=a-b(c)d…', 'JWT_SECRET=x,y+z', 'pwd=…abc', 'API_KEY_PASSWORD=a-b(c)', 'TOKEN_SECRET=a-b(c)', 'ADMINPASSWORD=a)b']) {
    expectAsk(command);
  }
  expectAsk("PASSWORD='p(a)ss w0rd!'", 'p(a)ss');
});

test('a template brace is not a non-token character: a glued literal after a template still asks under a token name', () => {
  for (const command of [`token={{${R}}}`, `API_KEY="{{.x}}"${R}`, `API_KEY={{.x}}${R}`]) expectAsk(command);
});

// Audit 533e1bf T1/T2: only CODE shapes (token characters then `(` or `[`, or a `…`) skip the token rule; one stray character after a real token does not.
test('T1: a real token with a stray character glued on still asks, masked in the log', () => {
  for (const command of [`(export API_KEY=${R})`, `bash -c "export GITHUB_TOKEN=${R})"`, `API_KEY="${R})"`, `API_KEY=${R},`, `API_KEY=${R}#c`, `API_KEY=${R}>out`, `API_KEY='${R}!'`,
    `API_KEY=${R}\\\nx`, `API_KEY=!${R}`, `API_KEY=${R}ä`, `TOKEN=${R}?x`, `x_token=${R}$y`]) expectAsk(command, R);
});

test('T1: code shapes stay silent: a call or index after token characters, or an ellipsis', () => {
  for (const command of ['API_KEY=get_key(x)', 'TOKEN=cfg.tokens[0]', "TOKEN='read(f)'", 'x=csrf_token=…', "'csrf_token=…').slice(0, 80))"]) expectSilent(command);
});

test('T2: an escaped, comma- or brace-separated flag still asks; BEM modifiers stay silent', () => {
  for (const command of [`cmd \\--token ${R}`, `cmd {,--token} ${R}`, `cmd {--token ${R}}`, `cmd x,--password ${PASSWORD}`]) expectAsk(command);
  for (const command of ['.card--password {', 'inv-new-staff--password (12 px)', 'a,b--token (x)']) expectSilent(command);
});

// Final audit F1, F2, N1h: an exemption must not cover shell glue, and a flag's all-punctuation value is only a code opener or an ellipsis.
test('F1: a list comma ends a query value only inside a real bracketed list', () => {
  for (const command of [`curl "https://x/?token=verify-ok","/${R}",x`, `curl "https://x/?password="},"/${R}",x`, `curl "https://x/?token=ab-cd","/${R}",x`]) expectAsk(command);
  for (const command of ["const p=['/a?token=verify-ok','/b'];", `x = ["/r?token=reset-ok","/s", "/t"]`, `{"/r?token=reset-ok","/s"}`, "f(['/a?token=verify-ok',\n  '/b'])"]) expectSilent(command);
});

test('F2: only a code opener or an ellipsis is a non-value for a flag; other punctuation is a password', () => {
  for (const command of ['cmd --password %+=:,.~@#', 'cmd --token @#$', 'cmd --api-key =', 'cmd --password ~~~']) expectAsk(command);
  for (const command of ['cmd --password {', 'cmd --password (', 'cmd --token [', 'cmd --token …', '.card--password .card__body {', 'inv-new-staff--password (12 px)']) expectSilent(command);
});

test('N1h: shell glue "+R" after a mock word asks; JS concatenation after a mock word stays silent', () => {
  for (const command of [`curl "https://x/r?token=abc-def"+${R}`, `curl 'https://x/r?token=abc-def'+${R}`, `x="https://x/r?token=abc-def"+${R}`]) expectAsk(command);
  for (const command of ['goto("/r?token=reset-ok"+suffix)', 'page.goto(base+"/r?token=reset-ok"+tok)', 'const u = "/r?token=reset-ok" + tok;', 'page.goto(base+"/reset?token="+tok)']) expectSilent(command);
});
