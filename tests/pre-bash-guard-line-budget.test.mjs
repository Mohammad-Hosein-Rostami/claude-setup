// Tests for the guard's work budget over one whole command line (MAX_LINE_READINGS, lib/rm-paths.mjs). The budget per target bounded one
// word; nothing bounded the line. An unquoted variable that holds 2,000 words, used until the line is 32 KB long, made the guard judge
// about 18 million target readings (100 s and more as a hook, past its timeout), and behind ten more `rm -rf` words each of them eleven
// times. Over the budget the guard now asks "command too complex to check" and reads no more targets on that line.
// No test here measures time (principle P12): the tests read the answer and the work the guard counted.
// Command strings are only passed to decide() or sent to the hook; nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_LINE_EXPANDED_CHARS, MAX_LINE_READINGS, TOO_COMPLEX_REASON, checkRm, newWork } from '../home/hooks/lib/rm-paths.mjs';
import { MAX_COMMAND_CHARS } from '../home/hooks/lib/verdict.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { hookEnv } from './hook-env.mjs';

const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const RM = 'rm'; // kept apart so this file's own text never reads as a command
const ctx = { cwd: PROJECT, project: PROJECT };
const FORCE_PUSH_TAIL = '; git push --force origin main';
const FORCE_PUSH = /force push overwrites remote history/;
const PARSERS = 2; // decide() reads a line with both parsers, and both draw on the one budget

/** `X="a a a ..."; ` with `count` words: every unquoted `$X` after it is `count` words to bash and one word to zsh. */
const manyWords = (count) => `X="${'a '.repeat(count).trim()}"; `;

/** `X=<2,000 words>; <head>$X $X ...; git push --force origin main`, filled to exactly `length` characters. */
function lineOf(head, length) {
  const start = manyWords(2000) + head;
  const room = length - start.length - FORCE_PUSH_TAIL.length;
  return `${start}${'$X '.repeat(Math.floor(room / 3)).trimEnd().padEnd(room)}${FORCE_PUSH_TAIL}`;
}

const REVIEWER_LINE = lineOf(`${RM} -rf `, MAX_COMMAND_CHARS);
const BEHIND_TEN_MORE = lineOf(`nice ${`${RM} -rf `.repeat(11)}`, MAX_COMMAND_CHARS - 1);

/** One Bash call sent to the real hook process (no GUI, private log): its exit status, signal and decision. */
function hookAnswer(command) {
  const input = JSON.stringify({ cwd: PROJECT, session_id: 'sess-line-budget', tool_input: { command } });
  const { status, signal, stdout } = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT }) });
  const output = stdout === '' ? undefined : JSON.parse(stdout).hookSpecificOutput;
  return { status, signal, decision: output?.permissionDecision ?? 'allow', reason: output?.permissionDecisionReason ?? '' };
}

test('the two lines are the reviewer\'s: 32 KB and 32,767 characters, each with thousands of uses of a 2,000-word variable', () => {
  assert.equal(REVIEWER_LINE.length, MAX_COMMAND_CHARS);
  assert.equal(BEHIND_TEN_MORE.length, MAX_COMMAND_CHARS - 1);
  for (const line of [REVIEWER_LINE, BEHIND_TEN_MORE]) assert.ok(line.split('$X').length - 1 > 9000, 'uses of the variable');
});

test('a line whose rm targets expand past the budget asks "command too complex to check", and the counted work stays under the cap', () => {
  for (const command of [REVIEWER_LINE, BEHIND_TEN_MORE]) {
    const work = newWork();
    const answer = decide(command, { ...ctx, work });
    assert.equal(answer.ask, true);
    assert.ok(answer.reasons.includes(TOO_COMPLEX_REASON), answer.reasons.join(' | ').slice(0, 300));
    assert.ok(answer.reasons.some((reason) => FORCE_PUSH.test(reason)), 'the push next to it still asks');
    assert.ok(work.readings <= MAX_LINE_READINGS, `counted ${work.readings} readings`);
    assert.ok(work.expanded <= MAX_LINE_EXPANDED_CHARS + MAX_COMMAND_CHARS, `filled in ${work.expanded} characters`); // the value that tips it over is counted, not filled in
    assert.equal(work.spent, true);
  }
});

test('the budget bounds one word as well: a variable repeated inside a single target is not filled in past the cap', () => {
  const glued = `${manyWords(2000)}${RM} -rf ${'$X'.repeat(9000)}${FORCE_PUSH_TAIL}`;
  const work = newWork();
  const answer = decide(glued, { ...ctx, work });
  assert.ok(answer.reasons.includes(TOO_COMPLEX_REASON) && answer.reasons.some((reason) => FORCE_PUSH.test(reason)), answer.reason.slice(0, 300));
  assert.ok(work.expanded <= MAX_LINE_EXPANDED_CHARS + MAX_COMMAND_CHARS, `filled in ${work.expanded} characters`);
});

test('an assigned command word is still read after the budget is spent: the line asks, it is never let through', () => {
  const line = `C=${RM}; ${manyWords(2000)}echo ${'$X '.repeat(200)}; $C -rf /etc/x`;
  const answer = decide(line, ctx);
  assert.equal(answer.ask, true);
  assert.ok(answer.reasons.includes(TOO_COMPLEX_REASON), answer.reason.slice(0, 300));
});

test('the hook answers both lines with an ask that names the push as well', () => {
  for (const command of [REVIEWER_LINE, BEHIND_TEN_MORE]) {
    const answer = hookAnswer(command);
    assert.deepEqual([answer.status, answer.signal, answer.decision], [0, null, 'ask'], 'the hook must answer, not die or time out');
    assert.match(answer.reason, /command too complex to check/);
    assert.match(answer.reason, FORCE_PUSH);
  }
});

test('a line exactly at the budget is judged, one reading more asks', () => {
  const uses = MAX_LINE_READINGS / PARSERS / 2000; // each use is 2,000 readings: the whole value, and its 1,999 words
  const atBudget = `${manyWords(1999)}${RM} -rf ${'$X '.repeat(uses).trim()}`;
  const work = newWork();
  assert.deepEqual(decide(atBudget, { ...ctx, work }), { allow: true });
  assert.deepEqual([work.readings, work.spent], [MAX_LINE_READINGS, false]);
  const over = newWork();
  const { reasons } = decide(`${atBudget} b`, { ...ctx, work: over });
  assert.deepEqual([reasons.length, reasons[0].startsWith(TOO_COMPLEX_REASON)], [1, true], reasons.join(' | ')); // spent in the second parser's pass: the reason carries its mark
  assert.ok(over.readings <= MAX_LINE_READINGS, `counted ${over.readings} readings`);
});

/** `text` as one single-quoted shell word. */
const quoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
/** A script that, after two `cd`s that may each have failed (four possible folders), runs itself `levels` deep and then `innermost`. */
const nestedAfterCds = (levels, innermost) => Array.from({ length: levels }).reduce((script) => `cd a; cd b; sh -c ${quoted(script)}`, innermost);

test('a script nested in scripts, each after cds that leave four folders open, is not judged four times more at every level: it asks', () => {
  const outside = decide(nestedAfterCds(2, `${RM} -rf /etc/x`), ctx);
  assert.ok(outside.reasons?.some((reason) => /rm -r outside the project \(\/etc\/x\)/.test(reason)), 'the nested script is read at every level');
  const shallow = newWork();
  assert.deepEqual(decide(nestedAfterCds(2, `${RM} -rf x`), { ...ctx, work: shallow }), { allow: true });
  assert.equal(shallow.spent, false);
  const deep = nestedAfterCds(7, `${RM} -rf x`);
  assert.ok(deep.length < MAX_COMMAND_CHARS, `${deep.length} characters`);
  const work = newWork();
  const answer = decide(deep, { ...ctx, work });
  assert.equal(answer.ask, true);
  assert.ok(answer.reasons.includes(TOO_COMPLEX_REASON), answer.reason.slice(0, 300));
  assert.ok(work.expanded <= MAX_LINE_EXPANDED_CHARS + 4 * MAX_COMMAND_CHARS, `read ${work.expanded} characters more than once`); // the segment that tips it over is counted, not judged again
});

test('once the budget is spent no later rm on the line is read, and a fresh line starts with a fresh budget', () => {
  const env = { ...ctx, vars: new Map(), work: { readings: MAX_LINE_READINGS, spent: false } };
  assert.equal(checkRm(['-rf', 'dist'], env), TOO_COMPLEX_REASON);
  assert.equal(env.work.spent, true);
  assert.equal(checkRm(['-rf', 'dist'], env), TOO_COMPLEX_REASON);
  assert.equal(checkRm(['-rf', 'dist'], { ...ctx, vars: new Map() }), undefined);
  assert.deepEqual(decide(`${RM} -rf dist`, ctx), { allow: true }, 'an ordinary line is far under the budget');
});
