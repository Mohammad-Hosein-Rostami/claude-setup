// Tests for the wait advice (lib/wait-advice.mjs): a sleep loop (5 s or more) or one long sleep (30 s or more) is denied once with the better
// way to wait, and the identical retry runs. Short sleeps, loops without sleep and text that only mentions sleep stay silent. Command
// strings are only passed to decide() or the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bouncedDir } from '../home/hooks/lib/bounce-once.mjs';
import { commandOf } from '../home/hooks/lib/command-of.mjs';
import { ADVICE_CLASS, reasonClass } from '../home/hooks/lib/reason-classes.mjs';
import { WAIT_ADVICE, waitAdvice } from '../home/hooks/lib/wait-advice.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };

const ADVISED = [
  'for i in 1 2 3; do sleep 10; done',
  'for i in $(seq 1 20); do curl -s localhost:3000 && break; sleep 5; done',
  'while true; do ls out.txt && break; sleep 5; done',
  'until test -f out.txt; do sleep 5s; done',
  'until test -f out.txt\ndo\n  sleep 1m\ndone',
  'sleep 30',
  'sleep 600',
  'while ! test -f done.flag\ndo\n  sleep 15\ndone',
  'sleep 45 && cat out.txt',
  'sleep 1m',
  'sleep 20 10', // several arguments add up
  'timeout 100 sleep 40',
  'sleep infinity',
  'if a; then while b; do sleep 9; done; fi',
  'for ((i=0;i<9;i++)); do sleep 6; done',
];
const SILENT = [
  'sleep 1',
  'sleep 0.5',
  'sleep 5',
  'sleep 4.9',
  'sleep 29',
  'for i in 1 2 3; do sleep 1; done',
  'while true; do sleep 4; done',
  'for i in 1 2 3; do echo $i; done',
  'sleep $n',
  'for i in 1 2; do sleep $((i * 10)); done',
  'for i in 1 2 3; do echo $i; done; sleep 10', // a loop that ended before the sleep
  'echo "for i in 1 2; do sleep 10; done"',
  "git commit -m 'stop the sleep 60 loop'",
  'grep -rn "sleep 30" src',
  'cat <<EOF\nfor i in 1 2; do sleep 10; done\nsleep 60\nEOF',
  'cat out.txt # sleep 60',
  'echo $(sleep 60)',
  'sleeper 60',
  'ls sleep',
  'ls && echo sleeping',
  'while read line; do echo "$line"; done < input.txt',
  'until test -f out.txt; do true; done',
  "echo 'while true; do sleep 60; done'",
  "cat <<'EOF' > notes.txt\nfor i in 1 2 3; do sleep 30; done\nsleep 600\nEOF",
];

test('a sleep loop of 5 s or more and a single sleep of 30 s or more get the wait advice and nothing that asks', () => {
  for (const command of ADVISED) assert.deepEqual(decide(command, ctx), { allow: true, advice: [WAIT_ADVICE] }, command);
});

test('short sleeps, loops without sleep, a sleep it cannot read and text that only mentions sleep get no advice', () => {
  for (const command of SILENT) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('the advice names the better way to wait and is classed as advice', () => {
  assert.match(WAIT_ADVICE, /run_in_background: true/);
  assert.match(WAIT_ADVICE, /watch\.mjs/);
  assert.match(WAIT_ADVICE, /timeout/);
  assert.match(WAIT_ADVICE, /send the same command again and it runs/);
  assert.equal(reasonClass(WAIT_ADVICE), ADVICE_CLASS.sleepWait);
  assert.equal(reasonClass(`x ${WAIT_ADVICE}`), undefined, 'text that only contains the advice is not advice');
});

test('waitAdvice reads the command only: a loop that ends, nested loops and a sleep inside a wrapper count the way they run', () => {
  assert.deepEqual(waitAdvice('for i in 1; do for j in 1; do echo x; done; sleep 6; done'), [WAIT_ADVICE], 'the inner loop ended, the outer still runs');
  assert.deepEqual(waitAdvice('for i in 1; do echo x; done; for j in 1; do sleep 6; done'), [WAIT_ADVICE]);
  assert.deepEqual(waitAdvice('for i in 1; do echo x; done\nsleep 6'), []);
  assert.deepEqual(waitAdvice('done; sleep 6'), []);
  assert.deepEqual(waitAdvice('done; while true; do sleep 6; done'), [WAIT_ADVICE], 'a stray done never takes the count below zero: the loop after it still counts');
  assert.deepEqual(waitAdvice('done; done; for i in 1 2; do sleep 6; done'), [WAIT_ADVICE]);
  assert.deepEqual(waitAdvice('sleep'), []);
});

test('a command word in another case is read the way the platform runs it: SLEEP is sleep on macOS and Windows', () => {
  const runsAsSleep = commandOf(['SLEEP', '40']).cmd === 'sleep'; // file names fold case there, so SLEEP starts sleep
  assert.deepEqual(waitAdvice('SLEEP 40'), runsAsSleep ? [WAIT_ADVICE] : []);
  assert.deepEqual(waitAdvice('for i in 1 2; do Sleep 10; done'), runsAsSleep ? [WAIT_ADVICE] : []);
  assert.deepEqual(waitAdvice('echo SLEEP 40'), []);
});

test('advice never weakens an ask: a push next to a sleep loop still asks, with the advice kept apart', () => {
  const r = decide('git push origin main; for i in 1 2; do sleep 10; done', ctx);
  assert.equal(r.ask, true);
  assert.deepEqual(r.advice, [WAIT_ADVICE]);
  assert.equal(r.reasons.includes(WAIT_ADVICE), false);
});

/** What the hook does with one Bash call: 'allow' (no output) or the deny with its reason. */
function hookRun(env, command, session = 'sess-wait') {
  const input = JSON.stringify({ cwd: PROJECT, session_id: session, tool_input: { command } });
  const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env });
  assert.equal(status, 0, stderr);
  if (stdout === '') return { decision: 'allow' };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(stdout).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

test('the hook denies a sleep loop once with the advice, the identical retry runs, a short sleep never bounces', () => {
  const home = makeTempDir('sleep-home-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT });
  const store = join(bouncedDir({ HOME: home }), 'sess-wait.json');
  const loop = 'for i in 1 2 3; do sleep 10; done';
  assert.equal(existsSync(store), false, 'no record before the first send');
  const first = hookRun(env, loop);
  assert.equal(existsSync(store), true, 'the first send is recorded in the session store, so the retry can run');
  assert.equal(first.decision, 'deny');
  assert.ok(first.reason.includes(WAIT_ADVICE), first.reason);
  assert.deepEqual(hookRun(env, loop), { decision: 'allow' }, 'the identical retry runs');
  assert.deepEqual(hookRun(env, loop), { decision: 'allow' }, 'a third send runs too');
  assert.equal(hookRun(env, 'while true; do ls out; sleep 5; done').decision, 'deny', 'a different loop is bounced on its own');
  assert.equal(hookRun(env, `${loop} `).decision, 'deny', 'a changed command is a first time again');
  assert.deepEqual(hookRun(env, 'for i in 1 2 3; do sleep 1; done'), { decision: 'allow' });
  assert.deepEqual(hookRun(env, 'sleep 2'), { decision: 'allow' });
});
