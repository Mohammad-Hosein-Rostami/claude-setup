// Pasted logs and compaction summaries are not the owner's words: skill-router and big-context must not match inside them
// (seen live in 2 PC sessions: skills were injected 6 of 6 times on `<pasted_content>` or the compaction summary).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateLinesForPrompt, skillsForPrompt, weakUiPrompt } from '../home/hooks/skill-router.mjs';
import { bigContextNote } from '../home/hooks/lib/big-context.mjs';

const LOG = 'TypeError: form validation failed at responsive layout, bug in the page, we are done, fix the crash';
const SUMMARY_OPENING = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier part of the conversation.';

test('text inside <pasted_content> routes no skill and no gate', () => {
  for (const prompt of [`<pasted_content>${LOG}</pasted_content>`, `look at this\n<pasted_content name="build.log" size="9">${LOG}</pasted_content>\nthanks`, `<pasted_content>${LOG}`]) {
    assert.deepEqual(skillsForPrompt(prompt), [], prompt);
    assert.deepEqual(gateLinesForPrompt(prompt), [], prompt);
    assert.equal(weakUiPrompt(prompt), false, prompt);
  }
});

test('the owner words around a pasted block still route', () => {
  assert.deepEqual(skillsForPrompt(`make the form responsive\n<pasted_content>${LOG}</pasted_content>`).includes('responsive-ui'), true);
});

test('a compaction summary prompt routes nothing', () => {
  for (const prompt of [`${SUMMARY_OPENING}\n\nSummary: fix the responsive form bug, we are done`, 'Your task is to create a detailed summary of the conversation so far, paying close attention to the form and responsive bug fixes.']) {
    assert.deepEqual(skillsForPrompt(prompt), [], prompt);
    assert.deepEqual(gateLinesForPrompt(prompt), [], prompt);
    assert.equal(weakUiPrompt(prompt), false, prompt);
  }
});

async function bigTranscript() {
  const dir = await mkdtemp(join(tmpdir(), 'bigctx-'));
  const transcript = join(dir, 't.jsonl');
  await writeFile(transcript, `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 90_000, output_tokens: 10 } } })}\n`);
  return { dir, transcript };
}

test('big-context ignores a prompt that is mostly a pasted log or a compaction summary', async () => {
  const { dir, transcript } = await bigTranscript();
  const pasted = `<pasted_content>${LOG.repeat(10)}</pasted_content>`;
  assert.equal(await bigContextNote({ prompt: pasted, transcriptPath: transcript, dir, sessionId: 's1' }), '');
  assert.equal(await bigContextNote({ prompt: `${SUMMARY_OPENING} ${LOG.repeat(10)}`, transcriptPath: transcript, dir, sessionId: 's2' }), '');
});

test('big-context still fires for a long prompt typed by the owner', async () => {
  const { dir, transcript } = await bigTranscript();
  const typed = 'please look into the new feature for the billing export and then rewrite the settings screen so it works with the new API '.repeat(2);
  assert.match(await bigContextNote({ prompt: typed, transcriptPath: transcript, dir, sessionId: 's3' }), /\/clear or start a new session/);
});
