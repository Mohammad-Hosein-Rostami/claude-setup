// Tests for home/hooks/agent-budget.mjs (call counter, Read-size warning, SubagentStop word cap),
// home/hooks/final-reply-cap.mjs (Stop line cap) and home/hooks/lib/reply-cap.mjs (cap parser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALL_CAP, READ_WARN_CHARS, readChars } from '../home/hooks/agent-budget.mjs';
import { tempRoot } from '../home/hooks/lib/edit-log.mjs';
import { measure, overCap, parseCap } from '../home/hooks/lib/reply-cap.mjs';

const BUDGET = fileURLToPath(new URL('../home/hooks/agent-budget.mjs', import.meta.url));
const REPLY_CAP = fileURLToPath(new URL('../home/hooks/final-reply-cap.mjs', import.meta.url));
let counter = 0;
const uid = (prefix) => `${prefix}${process.pid}x${Date.now()}x${counter++}`; // counter files live in the shared temp dir

async function home() {
  const dir = await mkdtemp(join(tmpdir(), 'agent-budget-'));
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

test('a subagent gets "return a status now" at the 100th call and every 10th after, silent before', async () => {
  const dir = await home();
  const input = { hook_event_name: 'PostToolUse', session_id: uid('s'), agent_id: uid('a'), tool_name: 'Bash' };
  const outputs = [];
  for (let i = 1; i <= CALL_CAP + 10; i += 1) outputs.push(run(BUDGET, dir, input).stdout);
  assert.ok(outputs.slice(0, CALL_CAP - 1).every((o) => o === ''), 'silent before the cap');
  const at100 = JSON.parse(outputs[CALL_CAP - 1]).hookSpecificOutput;
  assert.equal(at100.hookEventName, 'PostToolUse');
  assert.match(at100.additionalContext, /100 tool calls.*return your status report/);
  assert.ok(outputs.slice(CALL_CAP, CALL_CAP + 9).every((o) => o === ''), 'silent between reminders');
  assert.match(JSON.parse(outputs[CALL_CAP + 9]).hookSpecificOutput.additionalContext, /110 tool calls/);
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
  assert.equal(out.additionalContext, '15 Bash calls in a row: delegate the rest to runner/implementer');
  assert.ok(outputs.slice(15).every((o) => o === ''), 'one line only');
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
