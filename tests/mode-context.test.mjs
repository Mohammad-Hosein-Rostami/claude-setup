// Tests for the transcript-driven parts of the mode hook: status file re-read after compaction, the big-context
// warning, and the handoff skill being model-invocable (node:test, no dependencies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextTokens, findStatusPath } from '../home/hooks/lib/transcript.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/mode.mjs', import.meta.url));
const BIG_PROMPT = 'Please implement the whole new feature across the hooks, tests and docs. '.repeat(4);

function runHook(home, mode, input) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MODE: mode }, encoding: 'utf8' });
}

const usageLine = (tokens, extra = {}) => JSON.stringify({ type: 'assistant', isSidechain: false, message: { usage: { input_tokens: 2, cache_read_input_tokens: tokens - 12, cache_creation_input_tokens: 10, output_tokens: 5 } }, ...extra });
const writeLine = (file_path, name = 'Write') => JSON.stringify({ type: 'assistant', isSidechain: false, message: { content: [{ type: 'tool_use', name, input: { file_path } }] } });

async function transcript(lines) {
  const file = join(await mkdtemp(join(tmpdir(), 'mode-tr-')), 't.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

test('contextTokens sums input, cache read and cache creation of the last main-thread assistant line', async () => {
  const file = await transcript([usageLine(10_000), usageLine(90_000), usageLine(500_000, { isSidechain: true }), '{"type":"user"}', 'not json']);
  assert.equal(await contextTokens(file), 90_000);
});

test('contextTokens is undefined for no usage, a missing file or no path', async () => {
  assert.equal(await contextTokens(await transcript(['{"type":"user"}'])), undefined);
  assert.equal(await contextTokens(join(tmpdir(), 'no-such-transcript.jsonl')), undefined);
  assert.equal(await contextTokens(undefined), undefined);
});

test('findStatusPath returns the last STATUS*.md written or edited, and ignores other files and subagents', async () => {
  const file = await transcript([
    writeLine('/p/STATUS.md'),
    writeLine('/p/notes.md'),
    writeLine('/p/docs/STATUS-lane-a.md', 'Edit'),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/p/STATUS-sub.md' } }] } }),
    writeLine('/p/status-report.txt'),
  ]);
  assert.equal(await findStatusPath(file), '/p/docs/STATUS-lane-a.md');
  assert.equal(await findStatusPath(await transcript([writeLine('/p/a.md')])), undefined);
});

test('compact prints "Re-read <status file> (first 60 lines)" only when a status path was written', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const withStatus = await transcript([writeLine('/proj/STATUS.md')]);
  const without = await transcript([writeLine('/proj/a.md')]);
  const compact = (transcript_path) => runHook(home, 'high', { hook_event_name: 'SessionStart', session_id: 'st1', source: 'compact', transcript_path }).stdout;
  assert.match(compact(withStatus), /Re-read \/proj\/STATUS\.md \(first 60 lines\)/);
  assert.doesNotMatch(compact(without), /first 60 lines/);
  assert.doesNotMatch(compact(undefined), /first 60 lines/);
});

test('compact tells the lead to reload Monitor, SendMessage and TaskStop in one ToolSearch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const out = runHook(home, 'high', { hook_event_name: 'SessionStart', session_id: 'ts1', source: 'compact' }).stdout;
  assert.match(out, /Monitor, SendMessage and TaskStop in ONE ToolSearch call/);
});

test('the first big prompt on a context over 60k in every mode says "/clear or start a new session first", once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const big = await transcript([usageLine(70_000)]);
  const submit = (mode, id, prompt = BIG_PROMPT, transcript_path = big) => runHook(home, mode, { hook_event_name: 'UserPromptSubmit', session_id: id, prompt, transcript_path }).stdout;
  const first = submit('high', 'b1');
  assert.match(first, /~70k tokens.*"\/clear or start a new session first"/);
  assert.doesNotMatch(submit('high', 'b1'), /new session first/); // once per session
  for (const [index, mode] of ['normal', 'medium', 'extra-high', 'ultra-high'].entries()) assert.match(submit(mode, `b-${index}`), /new session first/, mode);
});

test('no big-context note for a small context, a short prompt, a slash command or no transcript', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mode-home-'));
  const big = await transcript([usageLine(70_000)]);
  const small = await transcript([usageLine(50_000)]);
  const submit = (mode, id, prompt, transcript_path) => runHook(home, mode, { hook_event_name: 'UserPromptSubmit', session_id: id, prompt, transcript_path }).stdout;
  assert.doesNotMatch(submit('high', 'n3', BIG_PROMPT, small), /new session first/);
  assert.doesNotMatch(submit('high', 'n4', 'continue', big), /new session first/);
  assert.doesNotMatch(submit('high', 'n5', `/foo ${BIG_PROMPT}`, big), /new session first/);
  assert.doesNotMatch(submit('high', 'n6', BIG_PROMPT, undefined), /new session first/);
  // a skipped prompt does not use up the once-per-session warning
  assert.match(submit('high', 'n4', BIG_PROMPT, big), /new session first/);
});

test('the handoff skill can be invoked by the model (no disable-model-invocation)', async () => {
  const text = await readFile(fileURLToPath(new URL('../home/skills/handoff/SKILL.md', import.meta.url)), 'utf8');
  assert.doesNotMatch(text.split('---')[1], /disable-model-invocation/);
});
