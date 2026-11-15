// Tests for `ask.mjs answer --default`: the answer record is marked `by: "timeout"` so a reader can tell a default taken
// when the owner did not answer from the owner's own decision; an answer without the flag carries no `by`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastAnswer, parse } from '../home/tools/ask/lib/queue.mjs';

const CLI = fileURLToPath(new URL('../home/tools/ask/ask.mjs', import.meta.url));
const QUESTION = { question: 'Keep the extra link on the page?', why: 'It is not in Figma', options: [{ label: 'Match Figma', effect: 'remove it' }, { label: 'Keep it', effect: 'keep it' }], recommended: 'Match Figma', blocks: 'sign in', from: 'visual-qa' };

async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'ask-default-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASK_QUEUE: '' };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
  const queue = run(['init']).stdout.trim();
  run(['post', '--queue', queue, '--json', JSON.stringify(QUESTION)]);
  run(['post', '--queue', queue, '--json', JSON.stringify(QUESTION)]);
  return { run, queue };
}
const answers = async (queue) => parse(await readFile(queue, 'utf8')).records.filter((r) => r.type === 'a');

test('answer --default records by: "timeout"; a normal answer has no by field; --default works with --option and with words', async () => {
  const { run, queue } = await sandbox();
  assert.equal(run(['answer', '--queue', queue, 'q1', '--default', '--option', '1']).status, 0);
  assert.equal(run(['answer', '--queue', queue, 'q2', 'Keep it']).status, 0);
  const [byDefault, byOwner] = await answers(queue);
  assert.deepEqual([byDefault.id, byDefault.answer, byDefault.by], ['q1', 'Match Figma', 'timeout']);
  assert.deepEqual([byOwner.id, byOwner.answer, 'by' in byOwner], ['q2', 'Keep it', false]);
  assert.equal(run(['answer', '--queue', queue, 'q1', '--force', '--default', 'Keep it']).status, 0);
  assert.equal((await answers(queue)).at(-1).by, 'timeout');
});

test('lastAnswer returns the newest answer record (with its by), null while the question is open', async () => {
  const { run, queue } = await sandbox();
  run(['answer', '--queue', queue, 'q1', '--default', 'Keep it']);
  run(['answer', '--queue', queue, 'q1', '--force', 'Match Figma']);
  const { records } = parse(await readFile(queue, 'utf8'));
  assert.equal(lastAnswer(records, 'q1').answer, 'Match Figma');
  assert.equal('by' in lastAnswer(records, 'q1'), false);
  assert.equal(lastAnswer(records, 'q2'), null);
});
