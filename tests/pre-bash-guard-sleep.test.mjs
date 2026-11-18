// Tests for the sleep/poll-loop bounce of home/hooks/pre-bash-guard.mjs (lane r7-waits): a loop that sleeps 5 s or more, or a lone
// `sleep` of 30 s or more, is denied once with advice (run in the background, or one bounded wait); the identical command sent
// again runs. Short sleeps, loops without sleep and the word "sleep" inside quotes or a heredoc body are never bounced.
// The hook runs with a private HOME (the bounce store) and no GUI; command strings are only sent to the hook, never executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookEnv } from './hook-env.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');

/** A private HOME; run() sends one Bash call to the guard hook and returns {decision, reason}. */
function guardSession() {
  const home = makeTempDir('sleep-home-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT });
  return {
    run(command, session = 'sess-1') {
      const input = JSON.stringify({ cwd: PROJECT, session_id: session, tool_input: { command } });
      const { status, stdout, stderr } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env });
      assert.equal(status, 0, stderr);
      if (stdout === '') return { decision: 'allow' };
      const out = JSON.parse(stdout).hookSpecificOutput;
      return { decision: out.permissionDecision, reason: out.permissionDecisionReason };
    },
  };
}

const BOUNCED = [
  'for i in 1 2 3 4 5; do test -f out.txt && break; sleep 10; done',
  'while true; do ls out; sleep 5; done',
  'until test -f out.txt; do sleep 60; done',
  'for i in $(seq 1 20); do curl -s localhost:3000 && break; sleep 30; done',
  'while ! test -f done.flag\ndo\n  sleep 15\ndone',
  'sleep 30',
  'sleep 600',
  'sleep 45 && cat out.txt',
];

const PASSED = [
  'sleep 1',
  'sleep 0.5',
  'sleep 4',
  'sleep 5',
  'sleep 29',
  'for i in 1 2 3; do echo $i; sleep 1; done',
  'while true; do test -f x && break; sleep 4; done',
  'for i in 1 2 3; do echo $i; done',
  'while read line; do echo "$line"; done < input.txt',
  'until test -f out.txt; do true; done',
  'ls && echo sleeping',
  'echo "for i in 1 2; do sleep 30; done"',
  "echo 'while true; do sleep 60; done'",
  'git commit -m "fix: stop the sleep 30 poll loop"',
  'grep -rn "sleep 60" src',
  "cat <<'EOF' > notes.txt\nfor i in 1 2 3; do sleep 30; done\nsleep 600\nEOF",
];

test('a loop that sleeps 5 s or more, or a lone sleep of 30 s or more, is denied once with the background advice', () => {
  for (const command of BOUNCED) {
    const { decision, reason } = guardSession().run(command);
    assert.equal(decision, 'deny', command);
    assert.match(reason, /run_in_background/, command);
    assert.match(reason, /watch\.mjs/, command);
    assert.match(reason, /timeout/, command);
    assert.match(reason, /same command again/i, command);
  }
});

test('the identical command sent again runs, and a third send runs too', () => {
  for (const command of BOUNCED) {
    const session = guardSession();
    assert.equal(session.run(command).decision, 'deny', command);
    assert.equal(session.run(command).decision, 'allow', `${command}: resend`);
    assert.equal(session.run(command).decision, 'allow', `${command}: third send`);
  }
});

test('a different sleep loop after a bounce is bounced on its own', () => {
  const session = guardSession();
  assert.equal(session.run(BOUNCED[0]).decision, 'deny');
  assert.equal(session.run(BOUNCED[1]).decision, 'deny');
  assert.equal(session.run(BOUNCED[0]).decision, 'allow');
});

test('short sleeps, loops without sleep and the word sleep inside quotes or a heredoc body pass untouched', () => {
  for (const command of PASSED) assert.deepEqual(guardSession().run(command), { decision: 'allow' }, command);
});

test('a sleep loop next to a rule that asks is not allowed by the bounce: the other rule still decides', () => {
  const { decision, reason } = guardSession().run('while true; do sleep 10; done; git push origin main');
  assert.notEqual(decision, 'allow');
  assert.match(reason ?? '', /push|run_in_background/i);
});
