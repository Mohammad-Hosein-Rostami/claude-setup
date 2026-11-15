// Tests for the ASK outcome of home/hooks/pre-bash-guard.mjs: outward actions (push, gh release, gh pr merge, publish)
// and writes to production hosts (ssh/scp/rsync/psql/mysql). Every rule has an ask case and an allow case.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hookEnv } from './hook-env.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { isProdHost, isReadOnlyRemote, isReadOnlySql, readProdHosts } from '../home/hooks/lib/remote.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: ['db1.example.com', '*.corp.example.com', '10.0.0.5'] };

const isAsk = (command, c = ctx) => {
  const r = decide(command, c);
  return r.allow === false && r.ask === true;
};

const ASK = {
  'git push': [
    'git push', 'git push origin main', 'git push -u origin feat', 'git push --force-with-lease', 'git push --follow-tags',
    'git push origin HEAD:main', 'git -C d push', 'bash -c "git push"', "bash -c 'git push origin main'", 'pnpm test && git push',
    'echo "git push --dry-run" && git push', 'cd sub && git push', 'sudo git push',
  ],
  'gh release': ['gh release create v1', 'gh release delete v1', 'gh release upload v1 a.zip', 'gh release edit v1 --draft=false', 'gh -R a/b release create v2'],
  'gh pr merge': ['gh pr merge 12', 'gh pr merge --squash', 'gh -R a/b pr merge 3', 'gh pr merge 3 --auto'],
  'package publish': [
    'npm publish', 'pnpm publish', 'yarn publish', 'pnpm -r publish', 'pnpm --filter pkg publish', 'yarn npm publish', 'npm publish --access public',
    'npx changeset publish', 'lerna publish', 'bun publish',
  ],
  'ssh to a production host': [
    'ssh prodhost "rm -rf /srv/x"', 'ssh me@prod-1 sudo systemctl restart app', 'ssh db1.example.com "UPDATE t SET a=1"',
    'ssh -p 2222 -i key host.corp.example.com "touch /x"', 'ssh prodhost', 'ssh prodhost "cat x > y"', 'ssh prodhost "cat x; rm y"',
    'ssh 10.0.0.5 "docker restart web"', 'ssh prodhost "systemctl restart app"', 'ssh prodhost "psql -c \\"DELETE FROM t\\""',
    'ssh prodhost "sed -i s/a/b/ conf"', 'ssh prodhost "find / -delete"', 'ssh prodhost "echo \\$(rm x)"', 'ssh PROD-Box "tee f"',
    'bash -c \'ssh prodhost "rm -rf x"\'', 'ssh prodhost "git pull"',
  ],
  'scp and rsync to a production host': [
    'scp a.txt prodhost:/srv/a.txt', 'scp -P 22 -r dist me@prod-1:/srv/app', 'rsync -a dist/ prodhost:/srv/app/', 'rsync -avz -e "ssh -p 22" dist db1.example.com:/x',
    'rsync -a --delete dist/ me@prod-1:app', 'rsync -a dist rsync://prodhost/module', 'scp prodhost:/a prodhost2:/b', 'rsync --remove-source-files prodhost:/out/ ./out/',
  ],
  'psql and mysql writes to a production host': [
    'psql -h prod-db -c "UPDATE t SET a=1"', 'psql -h prod-db -c "DELETE FROM t"', 'psql -hprod-db -c "drop table t"', 'psql --host=prod-db -f migration.sql',
    'psql postgres://u@prod-db:5432/app -c "INSERT INTO t VALUES (1)"', 'PGHOST=prod-db psql -c "TRUNCATE t"', 'psql "host=prod-db dbname=app" -c "ALTER TABLE t ADD c int"',
    'mysql -h prod-db -e "UPDATE t SET a=1"', 'mysql -h db1.example.com -e "DROP DATABASE x"', 'mysql --host=prod-db < dump.sql', 'psql -h prod-db',
  ],
};

for (const [group, commands] of Object.entries(ASK)) {
  test(`decide asks: ${group}`, () => {
    for (const command of commands) assert.ok(isAsk(command), command);
  });
}

const ALLOWED = [
  // git
  'git push --dry-run', 'git push -n origin main', 'git push origin main --dry-run', 'git status', 'git pull --rebase', 'git fetch', 'git log --oneline',
  'git commit -m "git push later"', 'echo git push', 'grep "git push" notes.md', 'git remote -v',
  // gh
  'gh release list', 'gh release view v1', 'gh release download v1', 'gh pr view 12', 'gh pr list', 'gh pr create --fill', 'gh pr checks', 'gh issue list', 'gh -R a/b release list',
  // publish
  'npm publish --dry-run', 'pnpm publish --dry-run', 'npm run publish-docs', 'pnpm run publish', 'npm install', 'npm pack', 'pnpm test', 'yarn install', 'echo npm publish',
  // ssh reads
  'ssh prodhost "cat /var/log/app.log"', 'ssh prodhost "ls -la /srv"', 'ssh prodhost "tail -n 100 /var/log/app.log"', 'ssh prodhost tail -f /var/log/app.log',
  'ssh prodhost "grep ERROR /var/log/app.log | head"', 'ssh prodhost "systemctl status app"', 'ssh prodhost "docker ps"', 'ssh prodhost "docker logs web --tail 50"',
  'ssh prodhost "docker compose ps"', 'ssh prodhost "journalctl -u app -n 50"', 'ssh prodhost "psql -c \\"SELECT count(*) FROM t\\""',
  'ssh prodhost "mysql -e \\"SELECT 1\\""', 'ssh prodhost "df -h && uptime"', 'ssh prodhost "cat x 2>/dev/null"', 'ssh prodhost "cat a 2>&1"',
  'ssh -p 2222 -i key prodhost "ls"', 'ssh db1.example.com "cat /etc/hostname"', 'ssh prodhost "find /srv -name *.log"', 'ssh prodhost "git log -3"',
  // ssh to a host that is not production
  'ssh staging "rm -rf /tmp/x"', 'ssh me@dev-box "systemctl restart app"', 'ssh localhost "touch x"', 'ssh -p 22 host2 "UPDATE x"',
  // copies and databases
  'scp prodhost:/var/log/app.log .', 'scp me@prod-1:/a/b ./b', 'rsync -a prodhost:/srv/app/ ./backup/', 'scp a.txt staging:/srv/a.txt', 'rsync -a dist/ staging:/srv/app/',
  'scp ./c:/weird local.txt', 'rsync -a src/ dist/',
  'psql -h prod-db -c "SELECT * FROM t"', 'psql -h prod-db -c "select now()"', 'psql -h prod-db -c "SELECT * FROM updates"', 'mysql -h prod-db -e "SELECT 1"',
  'mysql -h prod-db -e "SHOW TABLES"', 'psql -h localhost -c "DELETE FROM t"', 'psql -c "UPDATE t SET a=1"', 'mysql -e "DROP TABLE t"', 'psql -h staging-db -c "UPDATE t SET a=1"',
  'psql postgres://u@dev-db/app -c "DELETE FROM t"', 'PGHOST=dev-db psql -c "DELETE FROM t"', 'mysqldump -h prod-db app > dump.sql',
];

test('decide allows reads, rehearsals and non-production hosts', () => {
  for (const command of ALLOWED) assert.deepEqual(decide(command, ctx), { allow: true }, command);
  assert.deepEqual(Object.keys(decide('git pull', ctx)), ['allow', 'advice'], 'a plain pull never asks: it gets the C37 advice (lib/merge-commit.mjs)');
});

test('nothing hard-denies: a destructive hit anywhere in the line leads one combined ask', () => {
  for (const command of ['git push && git push --force', 'ssh prodhost "rm x" && rm -rf ~/x', 'npm publish && git push -f']) {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, command);
    assert.match(r.reason, /^DESTRUCTIVE: /, command);
  }
  const plain = decide('git push; git commit --no-verify', ctx);
  assert.equal(plain.ask, true);
  assert.match(plain.reason, /git push.*--no-verify/);
});

test('an ask reason says what is asked and never leaks more than the host', () => {
  assert.match(decide('git push', ctx).reason, /git push.*confirm with the owner/);
  assert.match(decide('ssh prodhost "rm x"', ctx).reason, /prodhost.*production host/);
  assert.match(decide('gh pr merge 1', ctx).reason, /gh pr merge/);
  assert.match(decide('npm publish', ctx).reason, /npm publish/);
});

test('with no list, only hosts named *prod* ask', () => {
  const noList = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
  assert.ok(isAsk('ssh prodhost "rm x"', noList));
  assert.ok(isAsk('ssh me@my-PROD-box "rm x"', noList));
  assert.deepEqual(decide('ssh db1.example.com "rm x"', noList), { allow: true });
  assert.deepEqual(decide('ssh staging "rm x"', noList), { allow: true });
});

test('isProdHost: name rule, exact and glob entries, case, brackets', () => {
  assert.equal(isProdHost('PRODUCTION-1', []), true);
  assert.equal(isProdHost('db1.example.com', ['db1.example.com']), true);
  assert.equal(isProdHost('a.corp.example.com', ['*.corp.example.com']), true);
  assert.equal(isProdHost('corp.example.com', ['*.corp.example.com']), false);
  assert.equal(isProdHost('db10.example.com', ['db1.example.com']), false);
  assert.equal(isProdHost('[::1]', []), false);
});

test('isReadOnlySql and isReadOnlyRemote', () => {
  assert.ok(isReadOnlySql('SELECT 1'));
  assert.ok(isReadOnlySql('\\dt'));
  for (const sql of ['UPDATE t SET a=1', 'delete from t', 'SELECT 1; DROP TABLE t', '', null, '   ']) assert.equal(isReadOnlySql(sql), false, String(sql));
  assert.ok(isReadOnlyRemote('cat /etc/hostname | head -1'));
  for (const text of ['', 'rm x', 'cat x > y', 'cat x >> y', 'ls; rm y', 'ls && touch y', 'sed -i s/a/b/ f', 'find . -exec rm {} +', 'systemctl restart app', 'docker run x', 'sort -o out in']) {
    assert.equal(isReadOnlyRemote(text), false, text);
  }
});

test('readProdHosts reads lines, skips comments and blanks, lowercases; a missing file gives []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prod-hosts-'));
  const file = join(dir, 'prod-hosts');
  writeFileSync(file, '# my hosts\nDB1.Example.com   # primary\n\n*.corp.example.com\n');
  assert.deepEqual(readProdHosts(file), ['db1.example.com', '*.corp.example.com']);
  assert.deepEqual(readProdHosts(join(dir, 'missing')), []);
});

const runHook = (command, env = {}) =>
  spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: PROJECT, session_id: 'outward-test', tool_input: { command } }),
    encoding: 'utf8',
    env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT, ...env }),
  });

test('hook contract: an ask prints a PreToolUse permissionDecision "ask" JSON and exits 0', () => {
  const r = runHook('git push origin main');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /git push/);
});

test('hook contract: the private list file is read from CLAUDE_PROD_HOSTS_FILE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prod-hosts-'));
  const file = join(dir, 'prod-hosts');
  writeFileSync(file, 'db1.example.com\n');
  assert.equal(JSON.parse(runHook('ssh db1.example.com "rm x"', { CLAUDE_PROD_HOSTS_FILE: file }).stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(runHook('ssh db1.example.com "rm x"', { CLAUDE_PROD_HOSTS_FILE: join(dir, 'none') }).stdout, '');
  assert.equal(runHook('ssh db1.example.com "cat x"', { CLAUDE_PROD_HOSTS_FILE: file }).stdout, '');
});

test('hook contract: a destructive hit asks, never exits 2, and an allow is silent', () => {
  const hit = runHook('git push --force');
  assert.equal(hit.status, 0);
  assert.match(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecisionReason, /^DESTRUCTIVE: force push/);
  const allowed = runHook('git push --dry-run');
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout + allowed.stderr, '');
});
