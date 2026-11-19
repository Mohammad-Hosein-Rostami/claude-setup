// Tests that the Bash guard never fails open on its own errors: an exception anywhere after the hook input was read ends in an ask, never
// in a crash or a silent exit. A hook that exits non-zero or prints nothing lets the command run (Claude Code treats it as a non-blocking
// error), so a throw inside the rm rule, or in the code that shows the ask, would let every other rule of the line be skipped.
// The failure is injected from outside with tests/break-at.mjs (a preload); the hook runs as Claude Code runs it, with no GUI and a private
// log. Command strings are only sent to the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const BREAK_AT = pathToFileURL(fileURLToPath(new URL('./break-at.mjs', import.meta.url))).href;
const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command

/** One Bash call sent to the hook while every homedir() and JSON.stringify() inside `brokenFile` throws. */
function answerWithBroken(brokenFile, command) {
  const env = hookEnv({ CLAUDE_PROJECT_DIR: PROJECT, BREAK_AT: brokenFile });
  const input = JSON.stringify({ cwd: PROJECT, session_id: 'sess-broken', tool_input: { command } });
  const { status, stdout, stderr } = spawnSync(process.execPath, ['--import', BREAK_AT, GUARD], { input, encoding: 'utf8', env });
  const output = stdout === '' ? undefined : JSON.parse(stdout).hookSpecificOutput;
  const logged = readLog(env.CLAUDE_GUARD_LOG);
  return { status, stderr, decision: output?.permissionDecision ?? 'allow', reason: output?.permissionDecisionReason ?? '', logged };
}

/** The decision log's records, or none when the hook wrote no line. */
function readLog(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

test('the preload breaks only the named file: with no file named the hook answers as usual', () => {
  assert.equal(answerWithBroken('', 'ls').decision, 'allow');
  assert.equal(answerWithBroken('', `${RM} -rf /etc/x`).decision, 'ask');
  assert.equal(answerWithBroken('rm-paths.mjs', 'ls').decision, 'allow', 'a command that never reaches the rm rule is not touched');
});

test('an exception inside the rm rule asks with "guard error": the command is not let through unchecked', () => {
  for (const command of [`${RM} -rf build`, `${RM} -rf /etc/x`, `ls && sudo ${RM} -r node_modules`]) {
    const answer = answerWithBroken('rm-paths.mjs', command);
    assert.deepEqual([answer.status, answer.decision], [0, 'ask'], `${command}: ${answer.stderr}`);
    assert.match(answer.reason, /^guard error: Error$/, command);
  }
});

test('an exception after the rules, in the code that answers the ask, still ends in an ask, with a logged reason and no command text', () => {
  for (const command of ['git push origin main', `${RM} -rf /etc/x`]) {
    const answer = answerWithBroken('timed-ask.mjs', command);
    assert.deepEqual([answer.status, answer.decision], [0, 'ask'], `${command}: ${answer.stderr}`);
    assert.match(answer.reason, /^guard error: Error/, command);
    const record = answer.logged.find((line) => line.outcome === 'guard-error');
    assert.ok(record, `${command}: no guard-error line in the log`);
    assert.deepEqual([record.decision, record.reason, record.command], ['ask', 'guard error: Error', ''], command);
  }
});

test('an exception anywhere below the code that asks still ends in an ask: the hook never exits without an answer', () => {
  const answer = answerWithBroken('remembered-ask.mjs', 'git push origin main');
  assert.deepEqual([answer.status, answer.decision], [0, 'ask'], answer.stderr);
});
