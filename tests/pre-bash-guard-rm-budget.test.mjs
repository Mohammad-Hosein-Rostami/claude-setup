// Tests that a hostile `rm -r` target cannot make the guard crash or work without bound. A hook that dies answers nothing, and Claude Code
// then runs the command (a crashed hook is a non-blocking error), so every other rule of the same line would be skipped.
// The whole-folder check reads a target once from its end (lib/bare-glob.mjs); a target longer than the work budget is not read at all:
// it asks. No test here measures time (principle P12): the budget is what bounds the work, and the tests pin the budget.
// Command strings are only passed to decide() or sent to the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_TARGET_CHARS } from '../home/hooks/lib/rm-paths.mjs';
import { MAX_COMMAND_CHARS } from '../home/hooks/lib/verdict.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const ctx = { cwd: PROJECT, project: PROJECT };
const TOO_LONG = /^DESTRUCTIVE: rm -r with a target too long to check \(/;
const WHOLE_FOLDER = /^DESTRUCTIVE: rm -r that empties a whole folder \(/;
const FORCE_PUSH_TAIL = '; git push --force origin main';

/** One Bash call sent to the real hook process (no GUI, private log): its exit status, signal and decision. */
function hookAnswer(command) {
  const input = JSON.stringify({ cwd: PROJECT, session_id: 'sess-budget', tool_input: { command } });
  const { status, signal, stdout } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT }) });
  const output = stdout === '' ? undefined : JSON.parse(stdout).hookSpecificOutput;
  return { status, signal, decision: output?.permissionDecision ?? 'allow', reason: output?.permissionDecisionReason ?? '' };
}

test('a command of exactly MAX_COMMAND_CHARS whose rm target is one long run of glob parts asks, and the push next to it asks too', () => {
  const head = `${RM} -rf src/`;
  const parts = (MAX_COMMAND_CHARS - head.length - 1 - FORCE_PUSH_TAIL.length) / 2;
  const command = `${head}${'*/'.repeat(parts)}*${FORCE_PUSH_TAIL}`;
  assert.equal(command.length, MAX_COMMAND_CHARS, 'the longest command the guard still parses');
  const answer = hookAnswer(command);
  assert.deepEqual([answer.status, answer.signal, answer.decision], [0, null, 'ask'], 'the hook must answer, not die');
  assert.match(answer.reason, /force push overwrites remote history/);
  assert.match(answer.reason, /rm -r with a target too long to check/);
});

test('a target of exactly the budget is read, one character more asks unread', () => {
  const atBudget = `${'*/'.repeat(MAX_TARGET_CHARS / 2 - 1)}**`;
  assert.equal(atBudget.length, MAX_TARGET_CHARS);
  assert.match(decide(`${RM} -rf ${atBudget}`, ctx).reasons[0], WHOLE_FOLDER, 'read: every part is a bare glob of the working directory');
  const over = decide(`${RM} -rf ${atBudget}*`, ctx);
  assert.equal(over.ask, true);
  assert.match(over.reasons[0], TOO_LONG);
  assert.match(decide(`${RM} -rf src ${'a'.repeat(MAX_TARGET_CHARS + 1)}`, ctx).reasons[0], TOO_LONG, 'a long name asks as well: it is not read');
  assert.deepEqual(decide(`${RM} -f ${'a'.repeat(MAX_TARGET_CHARS + 1)}`, ctx), { allow: true }, 'only a recursive rm is judged');
});

test('targets at the budget that were slow to read are judged like short ones', () => {
  const fill = (text, tail = '') => text.repeat(Math.floor((MAX_TARGET_CHARS - tail.length) / text.length)) + tail;
  const SILENT_AT_BUDGET = [fill('*', 'x'), `a${fill('/', 'b').slice(1)}`, fill('['), fill('[:'), `src/${fill('*/').slice(4)}`];
  for (const target of SILENT_AT_BUDGET) assert.deepEqual(decide(`${RM} -rf ${target}`, ctx), { allow: true }, `${target.slice(0, 12)}... (${target.length})`);
  const ASK_AT_BUDGET = [fill('*'), fill('?*'), fill('[a]'), `.${fill('/', '*').slice(1)}`];
  for (const target of ASK_AT_BUDGET) assert.match(decide(`${RM} -rf ${target}`, ctx).reasons?.[0] ?? 'allowed', WHOLE_FOLDER, `${target.slice(0, 12)}... (${target.length})`);
});
