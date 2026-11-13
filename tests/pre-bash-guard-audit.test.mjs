// Regression tests for the security audit of the guard (findings M3, M4, L1-L5): shell escapes, wrapper options, shell -c option
// clusters, rm of a mktemp variable with `..`, exact dry-run flags, every psql/mysql statement checked, and wider secret masking.
// Each case is the exact example from the audit. M1, M2 and L6 (timed ask) are in timed-ask.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { logDecision } from '../home/hooks/lib/guard-log.mjs';
import { isReadOnlySql } from '../home/hooks/lib/remote.mjs';
import { findLiteralSecret, maskSecrets } from '../home/hooks/lib/secrets.mjs';
import { segments } from '../home/hooks/lib/shell-words.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const asks = (commands, pattern) => {
  for (const command of commands) {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, `should ask: ${command}`);
    if (pattern) assert.match(r.reason, pattern, command);
  }
};
const allows = (commands) => {
  for (const command of commands) assert.deepEqual(decide(command, ctx), { allow: true }, `should allow: ${command}`);
};

test('M3: backslash escapes are resolved like a shell before matching', () => {
  assert.deepEqual(segments('git pu\\sh'), [['git', 'push']]);
  assert.deepEqual(segments('rm -rf \\/'), [['rm', '-rf', '/']]);
  assert.deepEqual(segments('r\\m -rf /'), [['rm', '-rf', '/']]);
  asks(['rm -rf \\/', 'r\\m -rf /', '\\rm -rf /', 'rm -r\\f /etc'], /^DESTRUCTIVE: rm -r outside the project/);
  asks(['git pu\\sh origin main', 'g\\it push', 'git push --for\\ce', 'git "pu"\\sh', 'git push\\\n origin main'], /git push|DESTRUCTIVE/);
  allows(['echo a\\ b', "grep 'a\\.b' file", 'git status', 'echo "a \\" b"', 'git commit -m "fix \\$HOME"']);
});

test('M3: an escaped `\\;` inside ssh remote arguments separates the remote commands', () => {
  asks(['ssh prodhost cat x \\; rm y'], /production host/);
  asks(['ssh prodhost "cat x ; rm y"', "ssh prodhost cat x ';' rm y"], /production host/);
  assert.deepEqual(segments('ssh prodhost cat x \\; rm y'), [['ssh', 'prodhost', 'cat', 'x', ';', 'rm', 'y']]);
  allows(['ssh prodhost cat x', 'ssh prodhost ls -la /var/log', 'find . -name x -exec echo {} \\;']);
});

test('L1: wrappers with options that take a value are unwrapped', () => {
  const rmOutside = /^DESTRUCTIVE: rm -r outside the project/;
  asks([
    'sudo --user root rm -rf /x', 'sudo -u root rm -rf /x', 'sudo --user=root rm -rf /x', 'sudo -Eu root rm -rf /x', 'sudo -g wheel -u root rm -rf /x',
    'exec -a x rm -rf /x', 'timeout 5 rm -rf /x', 'timeout -s KILL 5 rm -rf /x', 'timeout --signal KILL 5 rm -rf /x',
    'env -u FOO rm -rf /x', 'env --unset FOO rm -rf /x', 'env -C /tmp rm -rf /x', 'nice -n 5 rm -rf /x', 'nice --adjustment 5 rm -rf /x',
    'xargs -I {} rm -rf /x', 'xargs -n 1 rm -rf /x', 'xargs --max-args 1 rm -rf /x', 'sudo env -u A nice -n 1 timeout 5 rm -rf /x',
  ], rmOutside);
  asks(['sshpass -p X ssh prodhost "rm x"', 'sshpass -p "$PW" ssh prodhost "rm x"', 'sshpass -f pwfile ssh prodhost "rm x"'], /production host|password/);
  asks(['sshpass -p "$PW" ssh prodhost "rm x"', 'sshpass -f pwfile ssh prodhost "rm x"'], /production host/);
  allows(['sudo -u root ls', 'timeout 5 ls', 'exec -a x ls', 'nice -n 5 ls', 'xargs -I {} echo {}', 'sshpass -p "$PW" ssh prodhost "ls"']);
});

test('L2: shell -c is found anywhere in the option cluster, for bash sh zsh ksh dash, also with escaped names', () => {
  const script = "'rm -rf /x'";
  asks([
    `bash -e -c ${script}`, `bash -ec ${script}`, `bash -c -- ${script}`, `ksh -c ${script}`, `zsh -ec ${script}`, `dash -c ${script}`, `sh -ec ${script}`,
    `bash -o pipefail -c ${script}`, `bash -eo pipefail -c ${script}`, `b\\ash -c ${script}`, `/bin/b\\ash -e -c ${script}`, `sudo bash -e -c ${script}`,
    `bash -c "bash -ec 'rm -rf /x'"`,
  ], /^DESTRUCTIVE: rm -r outside the project/);
  allows(["bash -e -c 'ls'", "bash -ec 'echo hi'", 'bash -e script.sh', 'bash script.sh -c', "bash -c -- 'ls'"]);
});

test('L3: rm of a mktemp variable with `..` is outside the temp dir; the mktemp directory itself is fine', () => {
  asks([
    'D=$(mktemp -d) && rm -rf "$D/.."', 'rm -rf $(mktemp -d)/..', 'rm -rf "$(mktemp -d)/.."', 'D=$(mktemp -d) && rm -rf "$D/../other"',
    'D=$(mktemp -d); rm -rf $D/sub/../..', 'D=`mktemp -d`; rm -rf "$D/.."',
  ], /^DESTRUCTIVE: rm -r outside the project/);
  allows(['D=$(mktemp -d) && rm -rf "$D"', 'D=$(mktemp -d) && rm -rf "$D/a" "$D/b"', 'D=$(mktemp -d) && rm -rf "$D/sub/../x"', 'D=$(mktemp -d) && rm -rf "${D}/out"']);
});

test('L4: only an exact --dry-run or -n makes git push a rehearsal; -on is a real push', () => {
  asks(['git push -on', 'git push -on origin main', 'git push -fn', 'git push -nv'], /git push|DESTRUCTIVE/);
  allows(['git push -n', 'git push --dry-run', 'git push -n origin main', 'git push --dry-run origin main']);
});

// How a prod -c statement is reached: directly, or inside the quoted remote command of an ssh call.
const PROD_CALLS = [(sql) => `psql -h prodhost -c "${sql}"`, (sql) => `ssh prodhost "psql -d app -c '${sql}'"`];
test('L5: on a prod host every -c statement must be read-only; INTO, setval, nextval, \\!, COPY PROGRAM and DO are writes', () => {
  const asksProd = (command) => {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, `should ask: ${command}`);
    assert.match(r.reason, /production host/, command);
  };
  asksProd('psql -h prodhost -c "select 1" -c "drop table x"');
  asksProd('psql -h prodhost -c "drop table x" -c "select 1"');
  asksProd('psql -h prodhost --command="select 1" --command="update t set a=1"');
  asksProd('mysql -h prodhost -e "select 1" -e "drop table x"');
  asksProd(`ssh prodhost "psql -c 'select 1' -c 'drop table x'"`);
  asksProd('psql -h prodhost -c "select 1" -f fix.sql');
  for (const sql of ['select * into backup from t', 'select setval(s, 1)', 'select nextval(s)', '\\! rm x', 'select 1; \\!ls', 'copy (select 1) to program sh',
    'copy t from program curl', 'do $$ begin delete from t; end $$', 'select 1 into outfile /tmp/x']) {
    for (const call of PROD_CALLS) asksProd(call(sql));
    assert.equal(isReadOnlySql(sql), false, sql);
  }
  assert.equal(isReadOnlySql(['select 1', 'select 2']), true);
  assert.equal(isReadOnlySql(['select 1', 'drop table x']), false);
  assert.equal(isReadOnlySql([]), false);
  allows(['psql -h prodhost -c "select 1" -c "select count(*) from t"', 'psql -h prodhost -c "select * from users where id = 1"', 'mysql -h prodhost -e "select 1" -e "show tables"']);
});

// Built from parts so this file never contains a string that looks like a real credential.
const PASSWORD = ['hunter', '2', 'pass'].join('');
const TOKEN_BODY = ['Zx9Qw3', 'Er5Ty7', 'Ui1Op2As'].join('');
const SLACK_BODY = ['1234567890', 'abcdefghij'].join('-');
const SECRETS = {
  '-u user:pass': [`curl -u bob:${PASSWORD} https://api.test`, `curl -u bob:${PASSWORD}`],
  '--user user:pass': [`curl --user bob:${PASSWORD} https://api.test`, `curl --user=bob:${PASSWORD} https://api.test`],
  'url credentials': [`git clone https://bob:${PASSWORD}@host.test/r.git`, `curl postgres://app:${PASSWORD}@db.test/app`],
  'Authorization: Bearer': [`curl -H "Authorization: Bearer ${PASSWORD}" https://api.test`, `curl -H 'authorization: bearer ${PASSWORD}' x`],
  'Bearer x': [`echo Bearer ${PASSWORD}`, `curl -H "Bearer ${PASSWORD}" x`],
  'sk-proj-': [`export OPENAI=${['sk', 'proj', TOKEN_BODY].join('-')}`],
  'glpat-': [`curl -H "PRIVATE-TOKEN: ${['glpat', TOKEN_BODY].join('-')}" x`],
  'xoxb- / xoxp-': [`curl -d token=${['xoxb', '1234567890', 'abcdefghij'].join('-')} x`, `echo ${['xoxp', '1234567890', 'abcdefghij'].join('-')}`],
  '*_KEY=': [`FOO_KEY=${PASSWORD} run`, `export STRIPE_API_KEY=${PASSWORD}`],
  '*_TOKEN=': [`FOO_TOKEN=${PASSWORD} run`, `NPM_TOKEN='${PASSWORD}' npm ci`],
  '*_SECRET=': [`FOO_SECRET=${PASSWORD} run`, `export CLIENT_SECRET=${PASSWORD}`],
  '*PASSWORD=': [`FOOPASSWORD=${PASSWORD} run`, `DB_PASSWORD="${PASSWORD}" run`],
};

test('M4: every audited secret form is detected, masked in text, reasons and the log, and a variable is not a secret', () => {
  const logPath = join(mkdtempSync(join(tmpdir(), 'audit-log-')), 'guard.jsonl');
  for (const [label, commands] of Object.entries(SECRETS)) {
    for (const command of commands) {
      assert.ok(findLiteralSecret(command), `${label}: ${command}`);
      const masked = maskSecrets(command);
      assert.ok(masked.includes('[masked]'), `${label}: ${masked}`);
      for (const value of [PASSWORD, TOKEN_BODY, SLACK_BODY]) assert.ok(!masked.includes(value), `${label}: ${masked}`);
      const r = decide(command, ctx);
      assert.equal(r.ask, true, command);
      assert.ok(!r.reason.includes(PASSWORD) && !r.reason.includes(TOKEN_BODY.slice(0, 6)), `${label}: ${r.reason}`);
      logDecision({ hook: 'h', tool: 'Bash', decision: 'ask', outcome: 'no-gui', reason: r.reason, command }, { CLAUDE_GUARD_LOG: logPath });
    }
  }
  const log = readFileSync(logPath, 'utf8');
  for (const value of [PASSWORD, TOKEN_BODY, SLACK_BODY]) assert.ok(!log.includes(value), 'the log holds no secret');
  for (const command of ['curl -u bob:$PW https://x', 'curl -u root https://x', 'date -u +%H:%M', 'git clone https://host.test/r.git', 'FOO_KEY=$KEY run', 'FOO_TOKEN="$TOKEN" run', 'curl -H "Authorization: Bearer $TOKEN" x', 'echo Bearer']) {
    assert.equal(findLiteralSecret(command), undefined, command);
  }
});
