// Tests for the guard false asks the real run showed (fixes spec X7, X9 rev 2 = owner G1, X10, X11, and the docker rm advice of rev 2),
// through decide() and through the real hook process (no GUI, so "the owner is asked" shows up as the CLI's own ask; a private HOME holds
// each session's bounce store). Only command strings are passed; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOCKER_RM_ADVICE } from '../home/hooks/lib/docker-advice.mjs';
import { plainLoopValues } from '../home/hooks/lib/loop-values.mjs';
import { RISKY_REASON } from '../home/hooks/lib/raw-risk.mjs';
import { ARITHMETIC_REASON, RUNTIME_VALUE_REASON } from '../home/hooks/lib/runtime-values.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
// built from parts so this file never holds a string that looks like a real credential
const PASSWORD = ['cs', 'test', 'pw', '4711', 'zq'].join('-');
const TOKEN = `ghp_${'Q7wE9rT1yU'.repeat(3)}`;

/** A private HOME and log; run() sends one Bash call to the real hook and returns its decision ('allow' for no output). */
function hookSession() {
  const home = makeTempDir('real-run-home-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT, CLAUDE_GUARD_LOG: join(home, 'guard.jsonl') });
  const run = (command) => {
    const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ cwd: PROJECT, session_id: 'sess-1', tool_input: { command } }), encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    if (r.stdout === '') return { decision: 'allow' };
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
  };
  const logText = () => { try { return readFileSync(env.CLAUDE_GUARD_LOG, 'utf8'); } catch { return ''; } };
  return { run, logText, log: () => logText().trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

const SECRET_COMMANDS = [
  [`PGPASSWORD=${PASSWORD} psql -h localhost -U app`, PASSWORD],
  [`docker run -d --name cs-test-db -e POSTGRES_PASSWORD=${PASSWORD} postgres:16`, PASSWORD],
  [`curl -H "Authorization: Bearer ${TOKEN}" https://api.test/x`, TOKEN],
  [`mysql -u root -p${PASSWORD} app`, PASSWORD],
];

test('G1: a secret value in a command runs with no ask and no bounce, and the log names its kind once, never the value', () => {
  for (const [command, value] of SECRET_COMMANDS) {
    const s = hookSession();
    assert.deepEqual(s.run(command), { decision: 'allow' }, command);
    assert.deepEqual(s.run(command), { decision: 'allow' }, `${command} (again)`);
    assert.deepEqual(s.log().map((line) => [line.outcome, line.class, line.command, typeof line.reason]), Array(2).fill(['secret', 'secret', '', 'string']), command);
    assert.equal(s.logText().includes(value), false, command);
  }
});

test('X7: arithmetic on run-time text and a run-time word are denied once with the rewrite; the identical retry asks the owner', () => {
  for (const [command, reason] of [['echo $(( $(cat n) + 1 ))', ARITHMETIC_REASON], ['read X; git $X', RUNTIME_VALUE_REASON], ['git "$@"', RUNTIME_VALUE_REASON]]) {
    assert.deepEqual(decide(command, ctx).reasons, [reason], command);
    const s = hookSession();
    const first = s.run(command);
    assert.equal(first.decision, 'deny', command);
    assert.match(first.reason, /only known when the command runs/, command);
    assert.equal(s.run(command).decision, 'ask', `${command} (retry)`);
    assert.equal(s.run(command).decision, 'ask', `${command} (and every later send)`);
  }
});

test('X7: a for list of plain literal words is judged per value: harmless values run, a dangerous one asks', () => {
  const s = hookSession();
  for (const command of ['for d in a b c; do rm -rf "$d"; done', 'for d in build dist; do rm -rf $d; done', 'for f in x.ts y.ts; do git add $f; done',
    'for d in a b\ndo\n  git status $d\ndone', 'for a in x y; do for b in p q; do echo $a $b; done; done']) {
    assert.deepEqual(decide(command, ctx), { allow: true }, command);
    assert.deepEqual(s.run(command), { decision: 'allow' }, command);
  }
  assert.match(decide('for b in status push; do git $b; done', ctx).reason, /^git push publishes/);
  assert.match(decide('for d in build /etc; do rm -rf $d; done', ctx).reason, /^DESTRUCTIVE: rm -r outside the project \(\/etc\)/);
});

test('F1: a quoted or expanded for list still bounces or asks, and a plain host value is still judged as a production host', () => {
  assert.deepEqual(decide('for X in "push --force"; do git $X; done', ctx).reasons, [RUNTIME_VALUE_REASON]);
  const s = hookSession();
  assert.equal(s.run('for X in "push --force"; do git $X; done').decision, 'deny');
  assert.equal(s.run('for X in "push --force"; do git $X; done').decision, 'ask');
  for (const command of ['for h in prod-1; do ssh $h rm -rf /; done', 'for h in prod-1; do ssh "$h" rm -rf /; done']) {
    assert.match(decide(command, { ...ctx, prodHosts: ['prod-1'] }).reason, /prod-1, a production host/, command);
  }
});

test('P4: a for list counts as known only when every item is a plain literal word and the name is only read as $NAME or ${NAME}', () => {
  for (const line of ["for b in 'push'; do git $b; done", 'for b in pu*; do git $b; done', 'for b in {push,pull}; do git $b; done',
    "for b in $'push'; do git $b; done", 'for b in pu\\sh; do git $b; done', 'for b in $P; do git $b; done', 'for b in `cat f`; do git $b; done',
    'for b in status; do git $b; b=push; git $b; done', 'for b in status; do read b; git $b; done', 'for b in xpush; do git ${b:1}; done',
    'for b in xpush; do git $b[2,5]; done', 'for b in push; do git $b:u; done', 'for b in a; do :; done; for b in push; do git $b; done']) {
    assert.equal(plainLoopValues(line).has('b'), false, line);
  }
  assert.deepEqual([...plainLoopValues('for b in status log; do git $b "${b}"; done')], [['b', ['status', 'log']]]);
  assert.equal(plainLoopValues(`for b in ${Array.from({ length: 65 }, (_, i) => `v${i}`).join(' ')}; do echo $b; done`).size, 0, 'over MAX_LOOP_READINGS');
});

test('P4: a loop value is filled in only inside its loop body: before it, after its done, or after a ( ) or $( ) loop it is judged as written', () => {
  for (const command of ['rm -rf $d; for d in a; do :; done', 'for d in a; do :; done; rm -rf $d', '(for d in a; do :; done); rm -rf $d',
    'x=$(for d in a; do echo $d; done); rm -rf $d', 'for d in a; do :; done | cat; rm -rf $d']) {
    assert.match(decide(command, ctx).reason ?? '', /^DESTRUCTIVE: rm -r outside the project \(\$d\)/, command);
  }
});

test('F2/X10: docker rm and a redirect target are no rm; rm itself and a raw device redirect are still destructive', () => {
  const quiet = decide('docker rm -f x >/dev/null && echo "$(cat $S/p)"', ctx);
  assert.deepEqual([quiet.allow, quiet.reasons, quiet.advice], [true, undefined, [DOCKER_RM_ADVICE]]);
  for (const command of ['docker container rm -f x 2>&1 && x=$(date)', 'git rm -f old.txt && echo "$(date)"', 'find . -name "*.tmp" -delete 2>/dev/null; x=$(date)']) {
    assert.equal(decide(command, ctx).reasons, undefined, command);
  }
  assert.match(decide('rm -rf / >/dev/null; x=$(date)', ctx).reason, /^DESTRUCTIVE: /);
  for (const command of ['rm -rf ~/x 2>/dev/null; x=$(date)', 'echo x > /dev/disk2; x=$(date)', 'docker $(rm -rf ~/x)', 'sudo rm -rf ~/x; echo "$(date)"']) {
    assert.ok((decide(command, ctx).reasons ?? []).some((reason) => reason.startsWith('DESTRUCTIVE: ')), command);
  }
  assert.ok(decide('docker run --rm img sh -c "rm -rf /tmp/x"; echo "$(date)"', ctx).reasons.includes(`DESTRUCTIVE: ${RISKY_REASON}`), 'an rm after another word still counts');
});

const RM = ['r', 'm -rf'].join('');
const PUSH = ['pu', 'sh'].join('');
const allowedOf = (commands) => commands.filter((command) => decide(command, { cwd: '/w/p', project: '/w/p' }).allow === true);

test('review R1: a quoted or escaped > or < is no redirect, so the rm path after it still asks (inside watch too)', () => {
  assert.deepEqual(allowedOf([`watch -n1 '${RM} ">" ~/x'`, `watch -n1 '${RM} \\> ~/x'`, `watch -n1 '${RM} "<" ~/x'`, `watch -n1 '${RM} \\< ~/x'`,
    `watch -n1 '${RM} '"'"'>'"'"' ~/x'`, `x=$(date); ${RM} ">" ~/x`, `x=$(date); ${RM} \\> ~/x`, `x=$(date); ${RM} \\< ~/x`,
    `x=$(date); find ">" ~/x -delete`, `x=$(date); ${RM} $'>' ~/x`, `x=$(date); ${RM} $'\\x3e' ~/x`]), []);
  assert.equal(decide(`x=$(date); ${RM} build >/dev/null 2>&1`, ctx).allow, true, 'an unquoted redirect target is still no rm path');
});

test('review R2: rm is a tool sub-command only when the tool is the command word, never an option value or assignment value', () => {
  assert.deepEqual(allowedOf([`watch -n1 'sudo -g docker ${RM} ~/x'`, `watch -n1 'sudo -u git ${RM} ~/x'`, `watch -n1 'env -u go ${RM} ~/x'`,
    `watch -n1 'doas -u git ${RM} ~/x'`, `watch -n1 'runuser -u git ${RM} ~/x'`, `watch -n1 'A="x git" ${RM} ~/x'`, `watch -n1 'exec -a go ${RM} ~/x'`,
    `x=$(date); sudo -g docker ${RM} ~/x`, `x=$(date); A="x git" ${RM} ~/x`, `x=$(date); exec -a go ${RM} ~/x`, `x=$(date); env -u go ${RM} ~/x`,
    `x=$(date); exec -a $(true) go ${RM} ~/x`, `x=$(date); exec -a {go ${RM} ~/x`, `x=$(date); exec -a $'x\\ngo' ${RM} ~/x`]), []);
  for (const command of ['x=$(date); docker rm -f x ~/y', 'x=$(date); A=1 git rm -r ~/y', 'x=$(date) && { docker container rm -f ~/y; }']) {
    assert.equal(decide(command, ctx).reasons, undefined, command);
  }
});

test('review R3: a for value zsh would change (=word, ~, globs, extended-glob ^ and #) is not a known value', () => {
  assert.deepEqual(allowedOf([`for c in =git; do $c ${PUSH}; done`]), []);
  for (const word of ['=git', '~/bin/git', 'g?t', 'g*', 'g[i]t', 'g^t', 'g#t', 'g~t', '{git}', 'g<1-2>']) {
    assert.equal(plainLoopValues(`for c in ${word}; do $c ${PUSH}; done`).has('c'), false, word);
  }
  assert.deepEqual([...plainLoopValues(`for c in a=b x:y %1 +x @a; do echo $c; done`)], [['c', ['a=b', 'x:y', '%1', '+x', '@a']]]);
});

test('F7: docker rm without -v gets the advice once, then runs; with -v/--volumes, or docker run --rm, it runs at once', () => {
  const s = hookSession();
  const first = s.run('docker rm -f cs-test-db');
  assert.equal(first.decision, 'deny');
  assert.deepEqual(first.reason.split('\n').slice(1), [`- ${DOCKER_RM_ADVICE}`]);
  assert.deepEqual(s.run('docker rm -f cs-test-db'), { decision: 'allow' }, 'the identical retry runs');
  for (const command of ['docker rm -fv cs-test-db', 'docker rm -f -v cs-test-db', 'podman rm --volumes cs-test-db', 'docker container rm -vf x',
    'docker run --rm -d --name cs-test-db postgres:16', 'docker rmi img']) {
    assert.deepEqual(s.run(command), { decision: 'allow' }, command);
  }
  for (const command of ['docker container rm x', 'podman rm -f x', 'nerdctl rm x']) assert.deepEqual(decide(command, ctx).advice, [DOCKER_RM_ADVICE], command);
});

test('X11/F3: a bounce row holds the masked command and the reason like an ask row; a secret in it never reaches the log', () => {
  const s = hookSession();
  const command = `KEY='${PASSWORD}' $CMD --version`;
  assert.equal(s.run(command).decision, 'deny');
  const bounce = s.log().find((line) => line.outcome === 'bounce');
  assert.equal(bounce.class, 'variable command word');
  assert.match(bounce.command, /^KEY=.*\[masked\].*\$CMD --version$/);
  assert.equal(bounce.reason, decide(command, ctx).reason);
  assert.equal(s.logText().includes(PASSWORD), false);
});
