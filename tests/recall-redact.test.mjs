// Tests for the widened recall redaction (home/tools/recall/lib/redact.mjs): every credential shape must lose its value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../home/tools/recall/lib/redact.mjs';

const V = 'Zq8xTopSecretV4lue';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const CASES = {
  '-pX': `mysql -u root -p${V} db`,
  "-p'X'": `mysql -u root -p'${V}' db`,
  'IDENTIFIED BY': `CREATE USER a IDENTIFIED BY '${V}';`,
  'PASSWORD()': `SET PASSWORD = PASSWORD('${V}');`,
  'SET pass=': `SET pass='${V}';`,
  'short *_KEY=': `STRIPE_KEY=${V}`,
  'short *_SECRET=': `APP_SECRET=${V}`,
  'short *_TOKEN=': `GITLAB_TOKEN=${V}`,
  '*_PASS*=': `export DB_PASSWORD=${V} && export MY_PASS_FILE=${V}`,
  'Authorization Basic': `curl -H "Authorization: Basic ${V}"`,
  'Authorization Token': `Authorization: Token ${V}`,
  'Authorization Bearer': `Authorization: Bearer ${V}`,
  'X-API-Key header': `curl -H "X-API-Key: ${V}" https://x`,
  'bare JWT': `the cookie was ${JWT} ok`,
  'truncated JWT': `saw eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx${V}`,
  'truncated PEM': `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA${V}\nAAAA`,
  'PEM body line': `${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(3)}`,
  'scheme user:pass with @': `postgres://admin:p@${V}@db.local:5432/app`,
  'cookie -b': `curl -b "session=${V}; other=1" https://x`,
  'Cookie header': `Cookie: sid=${V}; theme=dark`,
  'curl -u': `curl -u admin:${V} https://x`,
  SSHPASS: `SSHPASS=${V} sshpass -e ssh host`,
  'redis-cli -a': `redis-cli -h host -a ${V} ping`,
  'docker login -p': `docker login -u me -p ${V} registry.example.com`,
  passphrase: `passphrase=${V}`,
  'password is': `the password is ${V} for root`,
  'the password:': `the password: ${V}`,
  'Persian رمز : X': `رمز دیتابیس : ${V}`,
  'Persian پسورد X': `پسورد ${V} رو عوض کن`,
  'Persian گذرواژه X': `گذرواژه ${V}`,
  'Persian رمز عبور X': `رمز عبور: ${V}`,
  // fix-2 (security R2): space forms, Persian variants, netrc, query strings, htpasswd, sudo -S
  'Persian bare رمز X': `رمز ${V}`,
  'Persian رمز ورود X': `رمز ورود ${V}`,
  'Persian رمز عبور من X است': `رمز عبور من ${V} است`,
  'Persian رمزم X': `رمزم ${V} هست`,
  'Persian پسوردش X': `پسوردش ${V}`,
  'Persian کلمه عبور X': `کلمه عبور ${V}`,
  'Persian رمز ZWNJ عبور': `رمز‌عبور: ${V}`,
  'mysql -p X (space)': `mysql -u root -p ${V} db`,
  'netrc password X': `machine example.com login me password ${V}`,
  'pass X': `use pass ${V}`,
  'pw: X': `my pw: ${V}`,
  'pwd X': `pwd ${V}`,
  'token X (space)': `heroku token ${V}`,
  '?key=': `https://maps.example/api?key=${V}&a=1`,
  '&key=': `https://x.example/api?a=1&key=${V}`,
  'access_token=': `https://x.example/cb?access_token=${V}&a=1`,
  'htpasswd -b file user pass': `htpasswd -b .htpasswd user ${V} trailing words`,
  'htpasswd -nb user pass': `htpasswd -nb user ${V}`,
  'echo X | sudo -S': `echo ${V} | sudo -S apt update`,
  'URL password holding /': `https://u:p/${V}@host/x`,
};

for (const [name, input] of Object.entries(CASES)) {
  test(`redact widened: ${name}`, () => {
    const out = redact(input);
    assert.ok(out.includes('[REDACTED]'), out);
    for (const leaked of [V, 'dozjgNryP4J3', 'b3BlbnNzaC1r', 'QUJDREVG']) assert.ok(!out.includes(leaked), out);
  });
}

test('redact is idempotent and keeps ordinary text', () => {
  for (const input of Object.values(CASES)) assert.equal(redact(redact(input)), redact(input));
  const plain = 'mkdir -p build && git push -u origin main; the author wrote a pass-through proxy';
  assert.equal(redact(plain), plain);
});

test('redact keeps prose that only looks like the weak space forms (low false positives)', () => {
  const prose = [
    'the token usage was high, pass the salt, Token Expired yesterday',
    'we pass through the gate and mysql -p db',
    'cd src && pwd\n/home/user/x',
    'رمز را عوض کن و درباره رمزنگاری مدرن حرف زدیم',
    'login to the password manager; the machine learning password reset flow',
  ];
  for (const text of prose) assert.equal(redact(text), text);
});

test('redact stays fast on a long token-like run', () => {
  const started = Date.now();
  redact('a'.repeat(200000));
  redact(`x-${'b'.repeat(100000)}`);
  assert.ok(Date.now() - started < 2000);
});
