// Tests of what `resume` refuses and what a resumed boss is told (audit Job A6, H14): --abandon, --skip and --retry need a held
// step; a session with no transcript starts fresh instead of `--resume`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../home/tools/long-run/lib/run-store.mjs';
import { cli, createRun, driveRun, makeSandbox, readCalls } from './long-run-helpers.mjs';

const oneStep = (box, name) => ({ name, cwd: box.work('repo'), steps: [{ id: 'one', prompt: 'One.' }] });

test('resume --abandon (and --skip, --retry) on a run stopped at run level exits 1 with the fix and starts no boss', () => {
  const box = makeSandbox();
  const paths = createRun(box, oneStep(box, 'stopped'));
  assert.equal(cli(box, ['stop', paths.runId]).status, 0);
  for (const flag of ['--abandon', '--skip', '--retry']) {
    const refused = cli(box, ['resume', paths.runId, flag, '--foreground']);
    assert.equal(refused.status, 1, flag);
    assert.match(refused.stderr, new RegExp(`run ${paths.runId} holds no step \\(it is stopped\\); ${flag} applies to a held step only`));
  }
  assert.equal(readCalls(box).length, 0, 'no boss started');
  assert.equal(readJson(paths.driver).status, 'stopped');
});

test('resume --abandon on a held run still abandons it without a new boss', async () => {
  const box = makeSandbox();
  box.script({ one: ['blocked'] });
  const paths = createRun(box, oneStep(box, 'heldabandon'));
  assert.equal(await driveRun(box, paths), 'held');
  const abandoned = cli(box, ['resume', paths.runId, '--abandon', '--foreground']);
  assert.equal(abandoned.status, 0, abandoned.stderr);
  assert.equal(readCalls(box).length, 1);
  assert.equal(readJson(paths.driver).status, 'abandoned');
});
