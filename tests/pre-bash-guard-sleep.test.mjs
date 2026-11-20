// Tests for the sleep/poll-loop bounce of home/hooks/pre-bash-guard.mjs (lane r7-waits): a loop that sleeps 5 s or more, or a lone
// `sleep` of 30 s or more, is denied once with advice (run in the background with a `timeout` of at most 2 h); the identical command sent
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
import { WAIT_ADVICE, WAIT_CALL, WAIT_START_FORM } from '../home/hooks/lib/wait-advice.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command

/** A private HOME; run() sends one Bash call to the guard hook and returns {decision, reason}. */
function guardSession() {
  const home = makeTempDir('sleep-home-');
  const env = hookEnv({ HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: PROJECT });
  return {
    run(command, session = 'sess-1', toolInput = {}) {
      const input = JSON.stringify({ cwd: PROJECT, session_id: session, tool_input: { command, ...toolInput } });
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

/** The sentences of an advice text: cut after each full stop that a blank follows (`watch.mjs` and `2 h)` stay whole). */
const sentencesOf = (text) => text.split(/(?<=\.)\s+/);

test('the deny reason names run_in_background, timeout and the 2-h maximum in one sentence, and the path for a run over 2 h', () => {
  const { reason } = guardSession().run(BOUNCED[0]);
  const background = sentencesOf(reason).filter((sentence) => /run_in_background/.test(sentence));
  assert.equal(background.length, 1, reason);
  assert.match(background[0], /set timeout to its expected run plus a margin, at most 7200000 ms \(2 h\)/);
  assert.match(reason, /Set timeout for every background command/);
  assert.match(reason, /unattended run \(-p, Agent SDK, CI, cloud\)[^.]*30 min \(10 min for a text -p prompt\)/);
  const overTwoHours = sentencesOf(reason).find((sentence) => /over 2 h/.test(sentence)) ?? '';
  assert.match(overTwoHours, /is split, or started in an interactive session, where background commands have no limit/);
});

test('the deny reason names watch.mjs only for waiting on a session or an agent, never as the way to run or bound a command', () => {
  const { reason } = guardSession().run(BOUNCED[0]);
  const naming = sentencesOf(reason).filter((sentence) => /watch\.mjs/.test(sentence));
  assert.equal(naming.length, 1, reason);
  assert.match(naming[0], /waits on a session or an agent only: it never runs or bounds a command/);
  assert.doesNotMatch(reason, /bounded wait/);
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

test('a sleep loop next to a push or a whole-folder rm asks on every send: the once-advice never lets it run', () => {
  const asked = ['while true; do sleep 10; done; git push origin main', `for i in 1 2 3; do sleep 10; done; ${RM} -rf *`, `sleep 60; ${RM} -rf ./**/*`];
  for (const command of asked) {
    const session = guardSession();
    for (const send of ['first', 'second', 'third']) assert.equal(session.run(command).decision, 'ask', `${command}: ${send} send`);
  }
});

const IN_BACKGROUND = { run_in_background: true };

test('a wait the call already sends to the background gets no advice: it runs at the first send', () => {
  for (const command of ['while ! curl -sf localhost:3000; do sleep 5; done', 'sleep 600', ...BOUNCED]) {
    const session = guardSession();
    assert.deepEqual(session.run(command, 'sess-1', IN_BACKGROUND), { decision: 'allow' }, command);
    assert.equal(session.run(command).decision, 'deny', `${command}: the same command in the foreground still gets the advice once`);
  }
});

test('only run_in_background: true counts as a background call', () => {
  for (const toolInput of [{ run_in_background: false }, { run_in_background: 'true' }, { run_in_background: 1 }, { background: true }, {}]) {
    assert.equal(guardSession().run('sleep 600', 'sess-1', toolInput).decision, 'deny', JSON.stringify(toolInput));
  }
});

test('a background sleep loop next to a push or a whole-folder rm still asks on every send, and other advice is still given', () => {
  const asked = ['while true; do sleep 10; done; git push origin main', `for i in 1 2 3; do sleep 10; done; ${RM} -rf *`, `sleep 60; ${RM} -rf ./**/*`];
  for (const command of asked) {
    const session = guardSession();
    for (const send of ['first', 'second', 'third']) {
      const { decision, reason } = session.run(command, 'sess-1', IN_BACKGROUND);
      assert.equal(decision, 'ask', `${command}: ${send} send`);
      assert.doesNotMatch(reason, /wait by sleeping/, 'the dropped advice is not named next to the ask');
    }
  }
  const merge = guardSession().run('for i in 1 2 3; do sleep 10; done; git merge feature', 'sess-1', IN_BACKGROUND);
  assert.equal(merge.decision, 'deny', 'the merge-commit advice is not a wait: it is still given once');
  assert.doesNotMatch(merge.reason, /run_in_background/);
});

const MOVED_AFTER_MS = 180000; // a background subagent's foreground command is moved to the background after 3 min
const MS_PER_SECOND = 1000;
/** A command form of the advice (`<command> > <log> ...`) as an agent would send it. */
const asSent = (form) => form.replaceAll('<log>', '/tmp/suite.log').replace('<command>', 'node --test tests/*.test.mjs');

test('the way to wait that the advice and the agents name runs at the first send: the background start, then the counted foreground wait call', () => {
  const session = guardSession();
  assert.deepEqual(session.run(asSent(WAIT_START_FORM), 'sess-1', IN_BACKGROUND), { decision: 'allow' });
  assert.deepEqual(session.run(asSent(WAIT_CALL)), { decision: 'allow' });
  assert.deepEqual(session.run(asSent(WAIT_CALL)), { decision: 'allow' }, 'sent again while the command still runs');
  assert.ok(WAIT_ADVICE.includes(WAIT_START_FORM), 'the advice names the start form');
  assert.ok(WAIT_ADVICE.includes(WAIT_CALL), 'the advice names the wait call');
});

test('the start form removes an old <log>.exit first, so the wait for a second run never ends at once on the first run\'s exit code; the guard lets it run at the first send, foreground and background', () => {
  assert.ok(WAIT_START_FORM.startsWith('rm -f <log>.exit; '), WAIT_START_FORM);
  assert.deepEqual(guardSession().run(asSent(WAIT_START_FORM)), { decision: 'allow' }, 'foreground');
  assert.deepEqual(guardSession().run(asSent(WAIT_START_FORM), 'sess-1', IN_BACKGROUND), { decision: 'allow' }, 'background');
});

test('the wait call ends by itself before a background subagent\'s foreground command would be moved (3 min), and only its short pause keeps it from the advice', () => {
  const [, rounds, pause] = /seq (\d+)\).*sleep (\d+);/.exec(WAIT_CALL);
  assert.ok(Number(rounds) * Number(pause) * MS_PER_SECOND < MOVED_AFTER_MS, `${rounds} rounds of ${pause} s`);
  assert.equal(guardSession().run(asSent(WAIT_CALL).replace(`sleep ${pause};`, 'sleep 5;')).decision, 'deny', 'the same loop with a 5 s sleep is a poll loop');
});
