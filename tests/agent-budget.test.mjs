// Tests for home/hooks/agent-budget.mjs (call counter, Read-size warning, SubagentStop word cap),
// home/hooks/final-reply-cap.mjs (Stop line cap) and home/hooks/lib/reply-cap.mjs (cap parser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALL_CAP, EARLY_NOTICE_AT, READ_WARN_CHARS, readChars } from '../home/hooks/agent-budget.mjs';
import { tempRoot } from '../home/hooks/lib/edit-log.mjs';
import { isReadOnlyCommand } from '../home/hooks/lib/read-only-command.mjs';
import { measure, overCap, parseCap } from '../home/hooks/lib/reply-cap.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const BUDGET = fileURLToPath(new URL('../home/hooks/agent-budget.mjs', import.meta.url));
const REPLY_CAP = fileURLToPath(new URL('../home/hooks/final-reply-cap.mjs', import.meta.url));
let counter = 0;
const uid = (prefix) => `${prefix}${process.pid}x${Date.now()}x${counter++}`; // counter files live in the shared temp dir

async function home() {
  const dir = makeTempDir('agent-budget-');
  await mkdir(join(dir, '.claude', 'state', 'modes'), { recursive: true });
  return dir;
}
const run = (script, dir, input, raw) =>
  spawnSync(process.execPath, [script], { input: raw ?? JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_MODE: '' } });
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

test('parseCap reads caps tied to the reply', () => {
  assert.deepEqual(parseCap('Return ≤ 12 lines'), { limit: 12, unit: 'lines' });
  assert.deepEqual(parseCap('Report ≤ 250 words with file:line'), { limit: 250, unit: 'words' });
  assert.deepEqual(parseCap('Final reply max 25 lines, no tables'), { limit: 25, unit: 'lines' });
  assert.deepEqual(parseCap('The final answer has a 25-line cap'), { limit: 25, unit: 'lines' });
  assert.deepEqual(parseCap('Reply in 20 lines.'), { limit: 20, unit: 'lines' });
  assert.deepEqual(parseCap('Send a 25-line report please'), { limit: 25, unit: 'lines' });
  assert.deepEqual(parseCap('Return a report of at most 3 lines.'), { limit: 3, unit: 'lines' });
});

test('parseCap ignores rule quotes and per-file or per-function limits (regression)', () => {
  for (const text of [
    'C4 files <=300 lines', 'Files <=300 lines; C3 one job per function: <=40 lines', 'Keep files under 300 lines.',
    'Return functions of at most 40 lines', 'Report files under 300 lines', 'Keep each report section to 5 lines',
    'no more than 3 words in the label', 'C3 | One job per function: <=40 lines, <=4 params', 'هر فایل حداکثر ۳۰۰ خط باشد', undefined,
  ]) assert.equal(parseCap(text), null, String(text));
});

test('parseCap reads Persian caps, with Persian and Arabic-Indic digits', () => {
  assert.deepEqual(parseCap('حداکثر ۳۰۰ کلمه'), { limit: 300, unit: 'words' });
  assert.deepEqual(parseCap('گزارش حداکثر ۳۰۰ کلمه باشد'), { limit: 300, unit: 'words' });
  assert.deepEqual(parseCap('پاسخ در ۲۰ خط'), { limit: 20, unit: 'lines' });
  assert.deepEqual(parseCap('حداکثر ٢٥ سطر'), { limit: 25, unit: 'lines' });
  assert.deepEqual(parseCap('حداکثر 120 کلمه'), { limit: 120, unit: 'words' });
});

test('measure counts words and non-empty lines; overCap is strict', () => {
  assert.equal(measure('a b\n\nc', 'words'), 3);
  assert.equal(measure('a b\n\nc', 'lines'), 2);
  assert.deepEqual(overCap(words(5), { limit: 5, unit: 'words' }), { over: false, size: 5 });
  assert.equal(overCap(words(6), { limit: 5, unit: 'words' }).over, true);
});

test('readChars uses file content, a string, or the serialized response', () => {
  assert.equal(readChars({ file: { content: 'abcd' } }), 4);
  assert.equal(readChars('abc'), 3);
  assert.equal(readChars({ x: 1 }), '{"x":1}'.length);
});

const NOTICE_80 = 'Budget: 80 tool calls used. Commit what is green now. If the brief will not be finished by about 120 calls, pick the stopping point and write down the exact next step.';
const limitText = (calls) => `Budget: ${calls} tool calls used (limit 120). Commit what is green, write the hand-over note (the file your brief names, else HANDOFF.md in your worktree, not committed): done, left, next step, don't redo. Then return your report marked "unfinished" with the exact next step; the next agent starts from your commit and that note.`;

// Runs one subagent for `calls` tool calls and returns what the hook printed for each call ('' when silent).
async function budgetOutputs(calls) {
  const dir = await home();
  const input = { hook_event_name: 'PostToolUse', session_id: uid('s'), agent_id: uid('a'), tool_name: 'Bash' };
  return Array.from({ length: calls }, () => run(BUDGET, dir, input).stdout);
}
const contextOf = (output) => JSON.parse(output).hookSpecificOutput.additionalContext;

test('the call limit is 120 and the early notice is at 80', () => {
  assert.equal(CALL_CAP, 120);
  assert.equal(EARLY_NOTICE_AT, 80);
});

test('a subagent is silent up to call 79, gets the commit notice at 80 exactly once, and is silent 81-119', async () => {
  const outputs = await budgetOutputs(CALL_CAP - 1);
  assert.ok(outputs.slice(0, EARLY_NOTICE_AT - 1).every((o) => o === ''), 'silent at 1-79');
  const notice = JSON.parse(outputs[EARLY_NOTICE_AT - 1]).hookSpecificOutput;
  assert.equal(notice.hookEventName, 'PostToolUse');
  assert.equal(notice.additionalContext, NOTICE_80);
  assert.ok(outputs.slice(EARLY_NOTICE_AT, CALL_CAP - 1).every((o) => o === ''), 'silent at 81-119');
});

test('a subagent gets the limit text once at call 120 and no reminder after it (spec-p3 r9-workflows: one nudge after 120)', async () => {
  const outputs = await budgetOutputs(CALL_CAP + 20);
  assert.equal(contextOf(outputs[CALL_CAP - 1]), limitText(120));
  assert.ok(outputs.slice(CALL_CAP, CALL_CAP + 20).every((o) => o === ''), 'no reminder after the one nudge');
});

test('the early notice survives a count that jumps past 80 (parallel calls): one notice, not skipped, not repeated', async () => {
  const dir = await home();
  const ids = { session_id: uid('s'), agent_id: uid('a') };
  const counter = join(tempRoot(), 'budget', `${ids.session_id}--${ids.agent_id}`);
  await mkdir(dirname(counter), { recursive: true });
  await writeFile(counter, '.'.repeat(81)); // calls 80 and 81 were handled by racing processes that both saw 82
  const input = { hook_event_name: 'PostToolUse', ...ids, tool_name: 'Bash' };
  assert.equal(contextOf(run(BUDGET, dir, input).stdout), NOTICE_80, 'the call that sees 82 gives the notice');
  assert.equal(run(BUDGET, dir, input).stdout, '', 'the call that sees 83 gives none');
  assert.equal(run(BUDGET, dir, input).stdout, '');
});

test('the notice marker goes away with the counter when the agent ends', async () => {
  const dir = await home();
  const ids = { session_id: uid('s'), agent_id: uid('a') };
  const counter = join(tempRoot(), 'budget', `${ids.session_id}--${ids.agent_id}`);
  await mkdir(dirname(counter), { recursive: true });
  await writeFile(counter, '.'.repeat(EARLY_NOTICE_AT - 1));
  run(BUDGET, dir, { hook_event_name: 'PostToolUse', ...ids, tool_name: 'Bash' });
  assert.ok(existsSync(`${counter}.notice`), 'marker written with the notice');
  run(BUDGET, dir, { hook_event_name: 'SubagentStop', ...ids, agent_type: 'implementer', last_assistant_message: 'done' });
  assert.ok(!existsSync(counter) && !existsSync(`${counter}.notice`), 'both removed');
});

test('the limit in the hook matches the budget the implementer agents and the lead rules state', () => {
  for (const file of ['home/CLAUDE.md', 'home/agents/ui-implementer.md']) { // r9-dedupe part 2: the worker budget line lives in CLAUDE.md
    assert.match(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'), new RegExp(`about ${CALL_CAP} tool calls`), file);
  }
  assert.match(readFileSync(fileURLToPath(new URL('../home/modes/_lead.md', import.meta.url)), 'utf8'), new RegExp(`~${CALL_CAP} tool calls`));
});

test('the main thread is never counted; unsafe ids write nothing and stay silent', async () => {
  const dir = await home();
  const main = run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: uid('s'), tool_name: 'Bash' });
  assert.equal(main.status, 0);
  assert.equal(main.stdout, '');
  const unsafe = run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: '../x', agent_id: '../y', tool_name: 'Bash' });
  assert.equal(unsafe.status, 0);
  assert.equal(unsafe.stdout, '');
});

test('a big Read warns the lead only in ultra-high', async () => {
  const dir = await home();
  const sid = uid('s');
  const big = { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Read', tool_response: { file: { content: 'x'.repeat(READ_WARN_CHARS + 1) } } };
  assert.equal(run(BUDGET, dir, big).stdout, '', 'no saved mode and no env: silent');
  await writeFile(join(dir, '.claude', 'state', 'modes', sid), 'high\n');
  assert.equal(run(BUDGET, dir, big).stdout, '');
  await writeFile(join(dir, '.claude', 'state', 'modes', sid), 'ultra-high\n');
  const out = JSON.parse(run(BUDGET, dir, big).stdout).hookSpecificOutput;
  assert.match(out.additionalContext, /about 20k chars.*scout/);
  const small = { ...big, tool_response: { file: { content: 'x'.repeat(READ_WARN_CHARS) } } };
  assert.equal(run(BUDGET, dir, small).stdout, '', 'at the limit is fine');
  assert.equal(run(BUDGET, dir, { ...big, tool_name: 'Grep' }).stdout, '', 'only Read');
  assert.equal(run(BUDGET, dir, { ...big, agent_id: uid('a') }).stdout, '', 'a subagent is counted, not Read-warned');
});

test('SubagentStop with no cap in the spawn prompt never blocks, however long the report', async () => {
  const dir = await home();
  const transcript = join(dir, 'agent.jsonl');
  await writeFile(transcript, `${userLine('Extract the rows and return the data. Keep files under 300 lines.')}\n`);
  const base = { hook_event_name: 'SubagentStop', session_id: uid('s'), agent_id: uid('a'), agent_type: 'general-purpose' };
  assert.equal(run(BUDGET, dir, { ...base, agent_transcript_path: transcript, last_assistant_message: words(5000) }).status, 0);
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: words(5000) }).status, 0, 'no transcript path');
  assert.equal(run(BUDGET, dir, { ...base, agent_transcript_path: join(dir, 'missing.jsonl'), last_assistant_message: words(5000) }).status, 0, 'unreadable transcript');
});

test('SubagentStop blocks once, only for a subagent', async () => {
  const dir = await home();
  const transcript = join(dir, 'agent.jsonl');
  await writeFile(transcript, `${userLine('Report <= 50 words.')}\n`);
  const base = { hook_event_name: 'SubagentStop', session_id: uid('s'), agent_id: uid('a'), agent_type: 'implementer', agent_transcript_path: transcript };
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: words(60), stop_hook_active: true }).status, 0, 'never twice');
  assert.equal(run(BUDGET, dir, { ...base, agent_id: undefined, last_assistant_message: words(60) }).status, 0, 'no agent id');
});

test('SubagentStop uses the cap named in the spawn prompt (words or lines)', async () => {
  const dir = await home();
  const transcript = join(dir, 'agent.jsonl');
  const base = { hook_event_name: 'SubagentStop', session_id: uid('s'), agent_id: uid('a'), agent_type: 'general-purpose', agent_transcript_path: transcript };
  await writeFile(transcript, `${userLine('Do the work. Report <= 50 words.')}\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x' } })}\n`);
  const over = run(BUDGET, dir, { ...base, last_assistant_message: words(60) });
  assert.equal(over.status, 2);
  assert.match(over.stderr, /60 words; the cap is 50 words/);
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: words(50) }).status, 0);
  await writeFile(transcript, `${userLine('Return a report of at most 3 lines.')}\n`);
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: 'a\nb\nc\nd' }).status, 2);
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: 'a\nb\nc' }).status, 0);
});

const bash = (sid) => ({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Bash' });

test('the lead gets one delegate nudge after 15 Bash calls, silent before and after', async () => {
  const dir = await home();
  const sid = uid('s');
  const outputs = [];
  for (let i = 1; i <= 20; i += 1) outputs.push(run(BUDGET, dir, bash(sid)).stdout);
  assert.ok(outputs.slice(0, 14).every((o) => o === ''));
  const out = JSON.parse(outputs[14]).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  assert.equal(out.additionalContext, '15 Bash calls in a row (context size unknown): delegate the rest to runner/implementer (a fresh agent keeps the lead turns and context small).');
  assert.ok(outputs.slice(15).every((o) => o === ''), 'one line only until the 30th');
});

const CONTEXT_TOKENS = 212_345;
const SMALL_CONTEXT_TOKENS = 149_000;
/** A main-session transcript whose last assistant message was sent with `tokens` of context. */
async function transcriptAt(dir, tokens) {
  const path = join(dir, `t-${uid('c')}.jsonl`);
  const usage = { input_tokens: 1000, cache_read_input_tokens: tokens - 1500, cache_creation_input_tokens: 500 };
  await writeFile(path, `${userLine('go')}\n${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage } })}\n`);
  return path;
}
const leadBash = (sid, transcript) => ({ ...bash(sid), transcript_path: transcript });
const preBash = (sid, transcript, command, extra = {}) => ({
  hook_event_name: 'PreToolUse', session_id: sid, tool_name: 'Bash', tool_input: { command }, cwd: '/work', transcript_path: transcript, ...extra,
});
/** The PreToolUse decision for one lead Bash command: the deny reason, or null when the hook is silent. */
function preDecision(dir, input) {
  const r = spawnSync(process.execPath, [BUDGET], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_MODE: '', CLAUDE_GUARD_LOG: join(dir, 'guard.jsonl') },
  });
  assert.equal(r.status, 0, r.stderr);
  if (r.stdout === '') return null;
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  return out.permissionDecisionReason;
}

test('the nudge states the context size and comes again every 15 Bash calls of the same run', async () => {
  const dir = await home();
  const sid = uid('s');
  const transcript = await transcriptAt(dir, CONTEXT_TOKENS);
  const outputs = [];
  for (let i = 1; i <= 30; i += 1) outputs.push(run(BUDGET, dir, leadBash(sid, transcript)).stdout);
  assert.equal(JSON.parse(outputs[14]).hookSpecificOutput.additionalContext,
    '15 Bash calls in a row at ~212k context: delegate the rest to runner/implementer (a fresh agent keeps the lead turns and context small).');
  assert.match(JSON.parse(outputs[29]).hookSpecificOutput.additionalContext, /^30 Bash calls in a row at ~212k context: .* 1 nudge ignored so far; .*denied once/);
  assert.equal(outputs.filter((o) => o !== '').length, 2);
});

test('after 2 ignored nudges at 150k+ context the next lead Bash call that is not git or read-only is denied once, then the count starts over', async () => {
  const dir = await home();
  const sid = uid('s');
  const transcript = await transcriptAt(dir, CONTEXT_TOKENS);
  for (let i = 0; i < 31; i += 1) run(BUDGET, dir, leadBash(sid, transcript)); // nudges at 15 and 30, both followed by more Bash
  for (const command of ['git status && git log --oneline -3', 'ls -la | head -5', 'rg TODO src; sed -n 1,20p a.txt', 'cat a.txt | wc -l']) {
    assert.equal(preDecision(dir, preBash(sid, transcript, command)), null, command);
  }
  assert.equal(preDecision(dir, preBash(sid, transcript, 'npm test', { agent_id: uid('a') })), null, 'a subagent is never blocked');
  const reason = preDecision(dir, preBash(sid, transcript, 'npm test'));
  assert.match(reason, /delegate to runner\/implementer \(a fresh agent keeps the lead turns and context small\)/);
  assert.match(reason, /~212k context/);
  assert.equal(preDecision(dir, preBash(sid, transcript, 'npm test')), null, 'the identical retry runs');
  assert.equal(preDecision(dir, preBash(sid, transcript, 'npm run build')), null, 'one deny per escalation: no loop');
  assert.equal(preDecision(dir, preBash(sid, transcript, 'sed -i s/a/b/ a.txt')), null);
});

// Audit of db40977 (S2): both hooks run on the same Bash call. The budget's deny-once shared the guard's bounce store, so after the budget
// denied a command with a literal secret the guard found that command "already bounced" and asked instead: the rewrite advice and the
// "tell the owner, rotate it" line were never given.
const GUARD = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
test('the budget deny keeps its own store: the guard still bounces the same command with its secret advice', async () => {
  const dir = await home();
  const sid = uid('s');
  const transcript = await transcriptAt(dir, CONTEXT_TOKENS);
  for (let i = 0; i < 31; i += 1) run(BUDGET, dir, leadBash(sid, transcript));
  const command = `DB_${['PASS', 'WORD'].join('')}=${['Xk9pQ2vL', 'm3Nq8Rt5'].join('')} ./migrate.sh`;
  assert.match(preDecision(dir, preBash(sid, transcript, command)), /delegate to runner\/implementer/);
  const guard = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd: '/work', tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8', env: { ...process.env, HOME: dir, USERPROFILE: dir, SSH_CONNECTION: 'test', CLAUDE_PROJECT_DIR: '/work', CLAUDE_GUARD_LOG: join(dir, 'guard.jsonl') },
  });
  const out = JSON.parse(guard.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny', guard.stdout);
  assert.match(out.permissionDecisionReason, /may want to rotate it/);
});

test('isReadOnlyCommand: git and reading commands only, with no writing option and no output sent to a file', () => {
  for (const command of ['git commit -m x && git log', 'ls 2>/dev/null', 'git log 2>&1 | head -3', '/bin/cat a | sort | uniq', 'sed -n 1,5p a',
    'find . -name "*.mjs"', 'cd /tmp && pwd', 'FOO=1 rg x']) assert.equal(isReadOnlyCommand(command), true, command);
  for (const command of ['npm test', 'echo hi > f', 'cat a >>b', 'ls &>out', 'sed -i "" s/a/b/ f', 'sed -ni p f', 'sed --in-place s/a/b/ f',
    'find . -delete', 'find . -exec rm {} ;', 'echo $(rm -rf x)', 'git status; node x.mjs', '', 'cat <<EOF > f\nx\nEOF']) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
});

test('no deny below 150k context, after one ignored nudge, or when the nudges were followed by a delegation', async () => {
  const dir = await home();
  const small = await transcriptAt(dir, SMALL_CONTEXT_TOKENS);
  const big = await transcriptAt(dir, CONTEXT_TOKENS);
  const lowSid = uid('s');
  for (let i = 0; i < 31; i += 1) run(BUDGET, dir, leadBash(lowSid, small));
  assert.equal(preDecision(dir, preBash(lowSid, small, 'npm test')), null, 'below 150k');
  const oneSid = uid('s');
  for (let i = 0; i < 16; i += 1) run(BUDGET, dir, leadBash(oneSid, big));
  assert.equal(preDecision(dir, preBash(oneSid, big, 'npm test')), null, 'one ignored nudge');
  const heedSid = uid('s');
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 15; i += 1) run(BUDGET, dir, leadBash(heedSid, big));
    run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: heedSid, tool_name: 'Agent' });
  }
  assert.equal(preDecision(dir, preBash(heedSid, big, 'npm test')), null, 'each nudge was followed by an Agent call');
  assert.equal(preDecision(dir, preBash(heedSid, undefined, 'npm test')), null, 'no transcript: context unknown, no deny');
});

test('an Agent or Task call resets the lead Bash count; other tools neither count nor reset', async () => {
  const dir = await home();
  for (const delegate of ['Agent', 'Task']) {
    const sid = uid('s');
    for (let i = 0; i < 14; i += 1) run(BUDGET, dir, bash(sid));
    run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Edit' });
    assert.equal(run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: sid, tool_name: delegate }).stdout, '');
    for (let i = 1; i < 15; i += 1) assert.equal(run(BUDGET, dir, bash(sid)).stdout, '', `${delegate} call ${i} after reset`);
    assert.match(run(BUDGET, dir, bash(sid)).stdout, /15 Bash calls in a row/, `${delegate}: 15th after reset`);
  }
  const sid = uid('s');
  for (let i = 0; i < 14; i += 1) run(BUDGET, dir, bash(sid));
  run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Edit' });
  assert.match(run(BUDGET, dir, bash(sid)).stdout, /15 Bash calls/, 'Edit does not reset');
});

test('a Workflow call resets the lead Bash count like Agent and Task: a lead running workflows is not nudged to delegate', async () => {
  const dir = await home();
  const sid = uid('s');
  for (let i = 0; i < 14; i += 1) run(BUDGET, dir, bash(sid));
  assert.equal(run(BUDGET, dir, { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Workflow' }).stdout, '');
  for (let i = 1; i < 15; i += 1) assert.equal(run(BUDGET, dir, bash(sid)).stdout, '', `call ${i} after the Workflow call`);
  assert.match(run(BUDGET, dir, bash(sid)).stdout, /15 Bash calls in a row/, 'the 15th after the reset nudges again');
});

test('subagent Bash calls never trigger the lead nudge and unsafe session ids are silent', async () => {
  const dir = await home();
  const sid = uid('s');
  const agent = uid('a');
  for (let i = 0; i < 20; i += 1) assert.equal(run(BUDGET, dir, { ...bash(sid), agent_id: agent }).stdout, '');
  for (let i = 0; i < 20; i += 1) assert.equal(run(BUDGET, dir, bash('../x')).stdout, '');
});

test('both hooks fail open on bad input', async () => {
  const dir = await home();
  for (const script of [BUDGET, REPLY_CAP]) {
    for (const raw of ['not json', '', 'null', '[]']) {
      const r = run(script, dir, null, raw);
      assert.equal(r.status, 0, `${script} ${raw}`);
      assert.equal(r.stdout, '');
    }
  }
});

test('Stop blocks a final reply over the line cap named in the last prompt, once', async () => {
  const dir = await home();
  const transcript = join(dir, 't.jsonl');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  await writeFile(transcript, `${userLine('build it, final reply max 25 lines')}\n`);
  const blocked = run(REPLY_CAP, dir, { hook_event_name: 'Stop', last_assistant_message: lines, transcript_path: transcript });
  assert.equal(blocked.status, 0);
  const out = JSON.parse(blocked.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /30 lines; the owner's cap is 25 lines.*No tables/);
  assert.equal(run(REPLY_CAP, dir, { last_assistant_message: lines, transcript_path: transcript, stop_hook_active: true }).stdout, '');
  assert.equal(run(REPLY_CAP, dir, { last_assistant_message: 'short', transcript_path: transcript }).stdout, '');
});

test('Stop reads only the last real prompt: no cap there, or a cap in an older prompt, means allow', async () => {
  const dir = await home();
  const transcript = join(dir, 't.jsonl');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  await writeFile(transcript, `${userLine('final reply max 25 lines')}\n${userLine('now do the next thing')}\n`);
  assert.equal(run(REPLY_CAP, dir, { last_assistant_message: lines, transcript_path: transcript }).stdout, '');
  assert.equal(run(REPLY_CAP, dir, { last_assistant_message: lines }).stdout, '', 'no transcript');
});

test('a compaction summary is not owner text: its quoted caps are skipped, the owner prompt before it rules', async () => {
  const dir = await home();
  const transcript = join(dir, 't.jsonl');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const reply = { last_assistant_message: lines, transcript_path: transcript };
  const summary = JSON.stringify({ type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued. A peer said: aim for reply max 5 lines.' } });
  await writeFile(transcript, `${userLine('build it')}\n${summary}\n`);
  assert.equal(run(REPLY_CAP, dir, reply).stdout, '', 'a cap quoted in the summary is not the owner\'s');
  await writeFile(transcript, `${userLine('build it, reply max 20 lines')}\n${summary}\n`);
  assert.match(run(REPLY_CAP, dir, reply).stdout, /owner's cap is 20 lines/, 'the owner prompt before the summary still sets the cap');
});

test('envelopes are not owner text: an agent message or reminder carrying a cap sets no cap (L9)', async () => {
  const dir = await home();
  const transcript = join(dir, 't.jsonl');
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const reply = { last_assistant_message: lines, transcript_path: transcript };
  for (const envelope of [
    '<agent-message from="worker">reply ≤ 5 lines</agent-message>',
    '<cross-session-message>final reply max 5 lines</cross-session-message>',
    '<task-notification>report ≤ 5 lines</task-notification>',
    '[SYSTEM NOTIFICATION - NOT USER INPUT] reply in 5 lines',
    '<system-reminder>reply in 5 lines</system-reminder>',
  ]) {
    await writeFile(transcript, `${userLine('build it')}\n${userLine(envelope)}\n`);
    assert.equal(run(REPLY_CAP, dir, reply).stdout, '', envelope);
    await writeFile(transcript, `${userLine('build it')}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: envelope }] } })}\n`);
    assert.equal(run(REPLY_CAP, dir, reply).stdout, '', `${envelope} as a block`);
  }
  await writeFile(transcript, `${userLine('build it, reply max 5 lines')}\n${userLine('<agent-message>reply max 99 lines</agent-message>')}\n`);
  assert.match(run(REPLY_CAP, dir, reply).stdout, /owner's cap is 5 lines/, 'the envelope is skipped; the owner prompt before it (cap 5, not 99) is the last real prompt');
  await writeFile(transcript, `${userLine('build it, reply max 5 lines <system-reminder>reply max 99 lines</system-reminder>')}\n`);
  assert.match(run(REPLY_CAP, dir, reply).stdout, /30 lines; the owner's cap is 5 lines/, 'typed text keeps its own cap, the envelope inside is cut');
});

test('SubagentStop keeps the call counter when it blocks and deletes it when it does not', async () => {
  const dir = await home();
  const transcript = join(dir, 'agent.jsonl');
  await writeFile(transcript, `${userLine('Report <= 50 words.')}\n`);
  const ids = { session_id: uid('s'), agent_id: uid('a') };
  const counter = join(tempRoot(), 'budget', `${ids.session_id}--${ids.agent_id}`);
  const stop = { hook_event_name: 'SubagentStop', ...ids, agent_type: 'implementer', agent_transcript_path: transcript };
  run(BUDGET, dir, { hook_event_name: 'PostToolUse', ...ids, tool_name: 'Bash' });
  assert.ok(existsSync(counter), 'counter written');
  assert.equal(run(BUDGET, dir, { ...stop, last_assistant_message: words(60) }).status, 2);
  assert.ok(existsSync(counter), 'kept after agent-budget blocks');
  assert.equal(run(BUDGET, dir, { ...stop, last_assistant_message: words(10) }).status, 0);
  assert.ok(!existsSync(counter), 'deleted when it does not block');
});
