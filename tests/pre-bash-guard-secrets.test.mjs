// Tests for the literal-secret deny of home/hooks/pre-bash-guard.mjs (lib/secrets.mjs): a secret typed into a command is
// always denied, a variable or a prompt is not, and neither the reason nor stderr ever repeats the secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { findLiteralSecret } from '../home/hooks/lib/secrets.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };

// Built from parts so this file never contains a string that looks like a real credential.
const ANTHROPIC = ['sk', 'ant', 'api03', ['Zx9Qw', '3Er5T', 'y7Ui1', 'Op2As'].join('')].join('-');
const GITHUB = `ghp_${'a1B2c3D4e5'.repeat(3)}`;
const GITHUB_PAT = `github_pat_${'A1b2C3d4E5'.repeat(3)}`;
const AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const PASSWORD = ['Tr0ub4dor', 'and', '3'].join('-').toLowerCase();

const DENIED = {
  'API keys and tokens': [
    `curl -H "x-api-key: ${ANTHROPIC}" https://api.test`, `export ANTHROPIC_API_KEY=${ANTHROPIC}`, `echo ${GITHUB}`, `git clone https://${GITHUB}@github.com/a/b`,
    `GH_TOKEN=${GITHUB_PAT} gh api user`, `aws s3 ls --access-key ${AWS}`, `echo ${AWS} > creds`, `bash -c "echo ${ANTHROPIC}"`, `cat <<EOF\nkey=${ANTHROPIC}\nEOF`,
  ],
  'password flags with a literal value': [
    `psql --password=${PASSWORD} -h x`, `psql --password ${PASSWORD}`, `mysql -u root -p${PASSWORD} db`, `mysqldump -p${PASSWORD} db`, `docker login -u me -p ${PASSWORD}`,
    `sshpass -p ${PASSWORD} ssh host`, `sshpass -p${PASSWORD} ssh host`, `sshpass -p '${PASSWORD}' ssh host "ls"`, `tool --password '${PASSWORD}'`, `tool --passwd=${PASSWORD}`,
  ],
  'secret environment assignments': [
    `PGPASSWORD=${PASSWORD} psql -h x`, `PGPASSWORD='${PASSWORD}' psql`, `export PGPASSWORD=${PASSWORD}`, `MYSQL_PWD=${PASSWORD} mysql`, `AWS_SECRET_ACCESS_KEY=${PASSWORD} aws s3 ls`,
    `ssh host "PGPASSWORD=${PASSWORD} psql"`,
  ],
};

const ALLOWED = [
  'mysql -u root -p db', 'mysql -u root -p', 'mysql -p -e "select 1"', 'psql --password', 'psql --password="$DB_PASSWORD"', 'psql --password $DB_PASSWORD', 'psql --password=$(cat pw.txt)',
  'docker login --password-stdin', 'sshpass -f ~/.pw ssh host', 'sshpass -e ssh host', 'ssh -p 2222 host', 'ssh -p 22 host "ls"', 'scp -P 22 a h:b',
  'PGPASSWORD="$DB_PASSWORD" psql', 'PGPASSWORD=$DB_PASSWORD psql', 'PGPASSWORD= psql', 'export PGPASSWORD="$(cat pw)"', 'echo $ANTHROPIC_API_KEY', 'grep -r "sk-ant" src',
  'echo sk-ant-', 'echo ghp_short', 'curl -H "x-api-key: $KEY" https://api.test', 'git commit -m "rotate the key"', 'echo AKIA', 'pnpm test -- --password-policy',
];

for (const [group, commands] of Object.entries(DENIED)) {
  test(`decide denies a literal secret: ${group}`, () => {
    for (const command of commands) {
      const r = decide(command, ctx);
      assert.equal(r.allow, false, command);
      assert.notEqual(r.ask, true, command);
      assert.match(r.reason, /contains /, command);
    }
  });
}

test('decide allows variables, prompts, lookalikes and short strings', () => {
  for (const command of ALLOWED) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('the deny reason names the kind and never repeats the secret', () => {
  for (const [command, secret] of [[`echo ${ANTHROPIC}`, ANTHROPIC], [`PGPASSWORD=${PASSWORD} psql`, PASSWORD], [`sshpass -p ${PASSWORD} ssh h`, PASSWORD], [`echo ${GITHUB}`, GITHUB]]) {
    const r = decide(command, ctx);
    assert.ok(!r.reason.includes(secret), command);
  }
  assert.equal(findLiteralSecret(`echo ${ANTHROPIC}`), 'an Anthropic API key');
  assert.equal(findLiteralSecret(`echo ${GITHUB}`), 'a GitHub token');
  assert.equal(findLiteralSecret(`echo ${AWS}`), 'an AWS access key id');
});

test('a secret deny wins over an ask and an allow', () => {
  const r = decide(`git push && echo ${ANTHROPIC}`, ctx);
  assert.equal(r.allow, false);
  assert.notEqual(r.ask, true);
});

test('hook contract: a secret exits 2, stderr and stdout never contain it', () => {
  for (const [command, secret] of [[`PGPASSWORD=${PASSWORD} psql -h db`, PASSWORD], [`echo ${ANTHROPIC}`, ANTHROPIC], [`sshpass -p ${PASSWORD} ssh host`, PASSWORD]]) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: PROJECT, tool_input: { command } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^Blocked by pre-bash-guard: the command contains /);
    assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret));
  }
});
