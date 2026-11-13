// Tests for home/hooks/agent-budget.mjs (call counter, Read-size warning, SubagentStop word cap),
// home/hooks/final-reply-cap.mjs (Stop line cap) and home/hooks/lib/reply-cap.mjs (cap parser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALL_CAP, READ_WARN_CHARS, readChars } from '../home/hooks/agent-budget.mjs';
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

test('parseCap reads caps about a reply and ignores caps about files', () => {
  assert.deepEqual(parseCap('Return ≤ 12 lines'), { limit: 12, unit: 'lines' });
  assert.deepEqual(parseCap('Report ≤ 250 words with file:line'), { limit: 250, unit: 'words' });
  assert.deepEqual(parseCap('Final reply max 25 lines, no tables'), { limit: 25, unit: 'lines' });
  assert.deepEqual(parseCap('The final answer has a 25-line cap'), { limit: 25, unit: 'lines' });
  assert.equal(parseCap('Keep files under 300 lines.'), null);
  assert.equal(parseCap('no more than 3 words in the label'), null);
  assert.equal(parseCap(undefined), null);
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

test('SubagentStop blocks a report over 300 words by default, once', async () => {
  const dir = await home();
  const base = { hook_event_name: 'SubagentStop', session_id: uid('s'), agent_id: uid('a'), agent_type: 'implementer' };
  const long = run(BUDGET, dir, { ...base, last_assistant_message: words(301) });
  assert.equal(long.status, 2);
  assert.match(long.stderr, /301 words; the cap is 300 words/);
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: words(300) }).status, 0);
  assert.equal(run(BUDGET, dir, { ...base, last_assistant_message: words(400), stop_hook_active: true }).status, 0, 'never twice');
  assert.equal(run(BUDGET, dir, { ...base, agent_type: 'architect', last_assistant_message: words(400) }).status, 0, 'architect exempt');
  assert.equal(run(BUDGET, dir, { ...base, agent_id: undefined, last_assistant_message: words(400) }).status, 0, 'no agent id');
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
  assert.equal(run(BUDGET, dir, { ...base, agent_transcript_path: join(dir, 'missing.jsonl'), last_assistant_message: words(301) }).status, 2, 'unreadable transcript: default cap');
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
