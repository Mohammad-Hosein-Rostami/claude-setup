// Tests for the literal-secret ask of home/hooks/pre-bash-guard.mjs (lib/secrets.mjs): a secret typed into a command is
// asked about (a timed dialog in the hook), a variable or a prompt is not, and no reason, output, mask or log line repeats it.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { hookEnv, tempLogPath } from './hook-env.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { findLiteralSecret, maskSecrets } from '../home/hooks/lib/secrets.mjs';

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
  test(`decide asks about a literal secret: ${group}`, () => {
    for (const command of commands) {
      const r = decide(command, ctx);
      assert.equal(r.allow, false, command);
      assert.equal(r.ask, true, command);
      assert.match(r.reason, /contains a literal password\/token/, command);
    }
  });
}

test('decide allows variables, prompts, lookalikes and short strings', () => {
  for (const command of ALLOWED) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('the ask reason names the kind and never repeats the secret', () => {
  for (const [command, secret] of [[`echo ${ANTHROPIC}`, ANTHROPIC], [`PGPASSWORD=${PASSWORD} psql`, PASSWORD], [`sshpass -p ${PASSWORD} ssh h`, PASSWORD], [`echo ${GITHUB}`, GITHUB]]) {
    const r = decide(command, ctx);
    assert.ok(!r.reason.includes(secret), command);
  }
  assert.equal(findLiteralSecret(`echo ${ANTHROPIC}`), 'an Anthropic API key');
  assert.equal(findLiteralSecret(`echo ${GITHUB}`), 'a GitHub token');
  assert.equal(findLiteralSecret(`echo ${AWS}`), 'an AWS access key id');
});

test('a secret and another rule hit share one ask, destructive first', () => {
  const r = decide(`git push && echo ${ANTHROPIC}`, ctx);
  assert.equal(r.ask, true);
  assert.match(r.reason, /literal password\/token.*git push|git push.*literal password\/token/);
  const both = decide(`echo ${ANTHROPIC} && git push -f`, ctx);
  assert.match(both.reason, /^DESTRUCTIVE: force push.*literal password\/token/);
});

test('maskSecrets hides every detected secret, quoted values included, and leaves the rest', () => {
  for (const [command, secret] of [[`echo ${ANTHROPIC}`, ANTHROPIC], [`PGPASSWORD=${PASSWORD} psql -h db`, PASSWORD], [`sshpass -p "${PASSWORD} two" ssh h`, PASSWORD], [`mysql -u r -p${PASSWORD} db`, PASSWORD], [`x --password=${PASSWORD} --y`, PASSWORD]]) {
    const masked = maskSecrets(command);
    assert.ok(!masked.includes(secret), command);
    assert.match(masked, /\[masked\]/);
  }
  assert.equal(maskSecrets('git push && ls -la'), 'git push && ls -la');
});

test('hook contract: a secret asks (no GUI), and stdout, stderr and the log never contain it', () => {
  for (const [command, secret] of [[`PGPASSWORD=${PASSWORD} psql -h db`, PASSWORD], [`echo ${ANTHROPIC}`, ANTHROPIC], [`sshpass -p ${PASSWORD} ssh host`, PASSWORD]]) {
    const logPath = tempLogPath();
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: PROJECT, tool_input: { command } }), encoding: 'utf8', env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_GUARD_LOG: logPath }),
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'ask');
    assert.match(out.permissionDecisionReason, /^the command contains a literal password\/token/);
    assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret));
    const logged = readFileSync(logPath, 'utf8');
    assert.ok(!logged.includes(secret));
    assert.equal(JSON.parse(logged).outcome, 'no-gui');
  }
});

// Round 4 (L2 masking): credential forms that were missed, and linear-time matching.
const R4_PW = ['Hunt', 'er', '2'].join('');
const R4_FORMS = [
  `SSHPASS=${R4_PW} ssh host uptime`,
  `vault login s.${'Ab1Cd2Ef3G'.repeat(2)}`,
  `vault login -method=userpass username=bob password=${R4_PW}`,
  `kubectl create secret generic app --from-literal=db_password=${R4_PW}`,
  `kubectl create secret generic app --from-literal api_token=${R4_PW}`,
  `az login -u bob -p ${R4_PW}`,
  `htpasswd -b .htpasswd bob ${R4_PW}`,
  `htpasswd -bc .htpasswd bob ${R4_PW}`,
  `aws configure set aws_secret_access_key ${R4_PW}`,
  `aws configure set aws_secret_access_key ${R4_PW} --profile dev`,
];
const R4_NOT_SECRETS = [
  'SSHPASS=$SSH_PW ssh host uptime',
  'vault login -method=oidc',
  'vault status',
  'kubectl create secret generic app --from-literal=mode=fast',
  'az group list -o table',
  'htpasswd .htpasswd bob',
  'aws configure set region eu-west-1',
];

test('R4/L2: SSHPASS, vault, --from-literal, az -p, htpasswd -b and aws configure set are detected and masked', () => {
  for (const command of R4_FORMS) {
    assert.ok(findLiteralSecret(command), `should detect: ${command}`);
    const masked = maskSecrets(command);
    assert.equal(masked.includes(R4_PW), false, `masked: ${command}`);
    assert.equal(masked.includes('Ab1Cd2Ef3G'), false, `masked: ${command}`);
    assert.equal(decide(command, ctx).ask, true, `asks: ${command}`);
  }
  for (const command of R4_NOT_SECRETS) assert.equal(findLiteralSecret(command), undefined, `not a secret: ${command}`);
});

test('R4/L1: every secret pattern is linear: hostile inputs at the size limit and at 500 KB take under 500 ms', () => {
  const shapes = ['curl ', 'curl -H "a" ', 'aKEY', 'a-', 'a-b-key', 'x://a:', 'x://a:b', 'mysql ', 'docker ', 'redis-cli ', 'Authorization: ', 'X-a-', 'a+b.c-d',
    'vault login ', 'echo ', 'printf %s a | ', 'echo a | docker login ', '--password-stdin <', 'az ', 'sshpass -', 'htpasswd -', 'aws configure set ', '--from-literal=a-', '--secret ', 'curl "', "curl '", 'wget -u '];
  for (const size of [32 * 1024, 500 * 1000]) {
    for (const shape of shapes) {
      const text = shape.repeat(Math.ceil(size / shape.length)).slice(0, size);
      for (const run of [findLiteralSecret, maskSecrets]) {
        const started = performance.now();
        run(text);
        assert.ok(performance.now() - started < 500, `${run.name}(${JSON.stringify(shape)} x ${size}) took too long`);
      }
    }
  }
});

test('R4/L1: maskSecrets cuts input beyond the scan limit and says so instead of leaving the tail unmasked', () => {
  const masked = maskSecrets(`${'a '.repeat(20_000)} TOKEN=${R4_PW}`);
  assert.equal(masked.includes(R4_PW), false);
  assert.match(masked, /\[\.\.\.cut\]$/);
});

// Round 5 (L3): a literal fed to --with-token / --password-stdin by a here-string or an echo/printf pipe.
const STDIN_PW = ['Fake', 'Stdin', 'Pw', '42'].join('-');
const STDIN_LITERALS = [
  `gh auth login --with-token <<< ${STDIN_PW}`,
  `gh auth login --with-token <<< "${STDIN_PW}"`,
  `docker login --password-stdin <<< '${STDIN_PW}'`,
  `docker login -u me --password-stdin ghcr.io <<< ${STDIN_PW}`,
  `echo ${STDIN_PW} | docker login --password-stdin`,
  `echo -n "${STDIN_PW}" | docker login -u me --password-stdin ghcr.io`,
  `printf %s ${STDIN_PW} | gh auth login --with-token`,
  `printf '%s' '${STDIN_PW}' | gh auth login --with-token`,
  `printf "%s\\n" ${STDIN_PW} | gh auth login --with-token`,
];
const STDIN_NOT_LITERAL = [
  'echo "$GH_TOKEN" | gh auth login --with-token',
  'echo $DOCKER_PASSWORD | docker login --password-stdin',
  'gh auth login --with-token <<< "$GH_TOKEN"',
  'gh auth login --with-token <<< "$(cat ~/.token)"',
  'gh auth login --with-token < token.txt',
  'cat token.txt | docker login --password-stdin',
  'echo hello | grep hello',
];

test('R5/L3: a literal given on stdin to --with-token / --password-stdin is detected, masked, and never logged or shown', () => {
  for (const command of STDIN_LITERALS) {
    assert.ok(findLiteralSecret(command), `detected: ${command}`);
    assert.equal(maskSecrets(command).includes(STDIN_PW), false, `masked: ${command}`);
    const reason = decide(command, ctx);
    assert.equal(reason.ask, true, command);
    assert.equal(reason.reason.includes(STDIN_PW), false);
  }
  for (const command of STDIN_NOT_LITERAL) assert.equal(findLiteralSecret(command), undefined, `not a secret: ${command}`);
});
